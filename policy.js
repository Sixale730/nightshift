#!/usr/bin/env node
// policy.js — nightshift's agent-agnostic guardrail engine.
// Pure logic, zero dependencies, no I/O: adapters feed it a shell command
// string and get back a decision. Usable from any coding agent's hook or
// interception mechanism.
//
//   decide(command) -> { decision: 'allow' | 'deny' | 'defer', reason: string }
//
//   allow  = provably harmless: EVERY segment of the (possibly compound)
//            command is read-only/safe. Run it without asking.
//   deny   = matches a destructive/exfiltration/escalation pattern. Block it.
//   defer  = nightshift can't prove it safe. Fall back to the agent's normal
//            permission flow (existing allow-rules, or a human prompt).
//
// Fail-safe by construction: anything unparseable or ambiguous defers.

'use strict';

// --- First-token allowlist: read-only / harmless commands -------------------
var SAFE_READONLY = new Set([
  // POSIX read-only
  'ls', 'dir', 'cat', 'type', 'find', 'grep', 'rg', 'head', 'tail', 'wc',
  'sort', 'uniq', 'echo', 'pwd', 'cd', 'pushd', 'popd', 'tree', 'which',
  'where', 'stat',
  'file', 'diff', 'awk', 'sed', 'cut', 'tr', 'basename', 'dirname',
  'realpath', 'readlink', 'env', 'printf', 'date', 'whoami', 'hostname',
  'du', 'df', 'less', 'more', 'column', 'jq', 'xxd', 'md5sum', 'sha256sum',
  // PowerShell read-only cmdlets (lowercased)
  'get-childitem', 'gci', 'get-content', 'gc', 'get-location', 'gl',
  'set-location', 'sl', 'chdir', 'push-location', 'pop-location',
  'select-string', 'sls', 'measure-object', 'select-object', 'where-object',
  'sort-object', 'format-list', 'format-table', 'out-string', 'out-null',
  'test-path',
  'resolve-path', 'get-item', 'get-itemproperty', 'get-date', 'get-process',
  'get-service', 'get-command', 'write-output', 'write-host',
  // dev tools safe to invoke (inline eval like -c/-e is filtered below)
  'node', 'python', 'python3', 'py', 'pytest', 'tsc', 'flutter', 'dart', 'dotnet'
]);

// --- Commands whose safety depends on the sub-verb (2nd token) --------------
var SUBCOMMAND_SAFE = {
  git: new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse',
                'describe', 'ls-files', 'shortlog', 'blame', 'grep',
                'add', 'commit']), // local-only writes; push is DENIED below
  npm: new Set(['run', 'test', 'ci', 'install', 'i', 'ls', 'list', 'audit',
                'view', 'outdated', 'why', 'prefix', 'root']),
  pnpm: new Set(['run', 'test', 'install', 'i', 'ls', 'list', 'lint', 'build']),
  yarn: new Set(['run', 'test', 'install', 'list']),
  pip: new Set(['install', 'list', 'show', 'freeze', 'check']),
  pip3: new Set(['install', 'list', 'show', 'freeze', 'check']),
  poetry: new Set(['run', 'install', 'show']),
  cargo: new Set(['build', 'check', 'test', 'clippy', 'fmt', 'tree']),
  go: new Set(['build', 'test', 'vet', 'version', 'env', 'list']),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'api']), // release is DENIED below
  npx: new Set([]),   // never blanket-approve npx    -> defer
  docker: new Set([]) // never blanket-approve docker -> defer
};

// --- If ANY of these match anywhere -> DENY outright ------------------------
var DANGER = [
  // destructive filesystem / disk
  /\brm\s+-\w*r/i, /\brm\s+-\w*f/i, /\bremove-item\b[^\n]*(-recurse|-force)/i,
  /\brd\s+\/s/i, /\bdel\s+\/[fsq]/i, /\bdd\s+if=/i, /\bmkfs/i,
  /\bformat-volume\b/i, /\bclear-disk\b/i, /\bdiskpart\b/i, /\bbcdedit\b/i,
  // git: remote writes & history destruction (pushes are never auto-run;
  // see README "Opinionated defaults" to change this)
  /\bgit\s+push\b/i, /--force\b/, /\bgit\s+reset\s+--hard/i,
  /\bgit\s+clean\s+-\w*f/i, /\bgit\s+branch\s+-D\b/,
  /\bgit\s+config\b.*credential/i,
  // publishing / releases
  /\bnpm\s+publish\b/i, /\byarn\s+publish\b/i, /\bpnpm\s+publish\b/i,
  /\bcargo\s+publish\b/i, /\btwine\s+upload\b/i, /\bgh\s+release\b/i,
  /\bnuget\s+push\b/i,
  // system / accounts / services / registry
  /\bshutdown\b/i, /\bstop-computer\b/i, /\brestart-computer\b/i, /\blogoff\b/i,
  /\breg\s+(add|delete)\b/i, /\bregedit\b/i, /\bschtasks\b/i,
  /\bregister-scheduledtask\b/i, /\bnew-service\b/i, /\bset-service\b/i,
  /\bsc\.exe\b/i, /\bnetsh\b/i, /\bnet\s+user\b/i, /\bnet\s+localgroup\b/i,
  /\bnew-localuser\b/i, /\badd-localgroupmember\b/i, /\brunas\b/i, /\bsudo\b/i,
  // download-and-execute / credential helpers
  /\binvoke-expression\b/i, /(^|[\s|;(])iex\b/i, /\bcertutil\b.*urlcache/i,
  /\bbitsadmin\b/i, /\bcmdkey\b/i, /\bconvertfrom-securestring\b/i,
  // secret material
  /\bid_rsa\b/i, /\.pem\b/i, /\.git-credentials\b/i,
  // agent self-escalation (works across agents: match the flags, not the tool)
  /dangerously-skip-permissions/i, /bypasspermissions/i,
  /--yolo\b/i, /--full-auto\b/i, /--approval-mode\s+never/i,
  /\bchmod\s+(-\w+\s+)*777\b/
];

// --- Touching these paths is never auto-approved (defer to normal flow) -----
var SENSITIVE = [/\.env\b/i, /\.ssh\b/i, /\.aws\b/i, /\.npmrc\b/i];

// --- Shell constructs the splitter can't reason about -> defer --------------
var COMPLEX = /\$\(|`|<\(|>\(|<<|>>/;

function decide(command) {
  command = (command || '').trim();
  if (!command) return { decision: 'defer', reason: 'empty command' };

  for (var i = 0; i < DANGER.length; i++) {
    if (DANGER[i].test(command)) {
      return { decision: 'deny',
               reason: 'nightshift: blocked dangerous pattern ' + DANGER[i] };
    }
  }

  for (var s = 0; s < SENSITIVE.length; s++) {
    if (SENSITIVE[s].test(command)) {
      return { decision: 'defer', reason: 'touches a sensitive path' };
    }
  }
  if (COMPLEX.test(command)) {
    return { decision: 'defer', reason: 'substitution/heredoc/append-redirect' };
  }

  var segments = command
    .split(/&&|\|\||\|&|;|\||\r?\n|\s&\s|\s&$/)
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
  if (segments.length === 0) return { decision: 'defer', reason: 'no segments' };

  for (var j = 0; j < segments.length; j++) {
    if (!segmentSafe(segments[j])) {
      return { decision: 'defer',
               reason: 'segment not provably safe: ' + segments[j] };
    }
  }
  return { decision: 'allow',
           reason: 'nightshift: all ' + segments.length +
                   ' segment(s) are read-only/safe' };
}

function segmentSafe(seg) {
  // strip leading VAR=val assignments and benign wrappers
  var s = seg.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '');
  s = s.replace(/^(?:timeout\s+\S+|nice(?:\s+-n\s+\S+)?|stdbuf\s+\S+|command|exec)\s+/, '');

  // PowerShell: strip a leading `$var =` / `$env:VAR =` assignment and judge
  // what actually executes on the right-hand side.
  var assign = s.match(/^\$(?:env:)?[A-Za-z_]\w*\s*=\s*(.*)$/);
  if (assign) {
    s = assign[1].trim();
    // assigning a bare literal executes nothing
    if (/^(?:"[^"]*"|'[^']*'|[\w.,\\/:@#-]+)$/.test(s)) return true;
  }

  // PowerShell: subexpression `(...)` — strip leading parens so the inner
  // command is judged, but NEVER auto-approve a method call on the result:
  // `(Get-Content x).Lines` is a read; `(Get-Item x).Delete()` is not.
  if (s.charAt(0) === '(') {
    if (/\.\w+\s*\(/.test(s)) return false;
    s = s.replace(/^[(\s]+/, '');
  }

  var tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;

  // normalize "C:\\...\\node.exe" / ./script -> bare program name, drop quotes
  var cmd = tokens[0].toLowerCase()
    .replace(/^["']|["']$/g, '')
    .replace(/\.exe$/, '')
    .replace(/^.*[\\/]/, '');

  // block inline eval for interpreters (python -c, node -e, ...)
  if (['node', 'python', 'python3', 'py'].indexOf(cmd) !== -1) {
    var flag = (tokens[1] || '').toLowerCase();
    if (flag === '-c' || flag === '-e' || flag === '--eval' || flag === '-p') return false;
  }

  if (SAFE_READONLY.has(cmd)) return true;

  if (Object.prototype.hasOwnProperty.call(SUBCOMMAND_SAFE, cmd)) {
    var sub = (tokens[1] || '').toLowerCase();
    return SUBCOMMAND_SAFE[cmd].has(sub);
  }
  return false;
}

module.exports = { decide, SAFE_READONLY, SUBCOMMAND_SAFE, DANGER, SENSITIVE, COMPLEX };
