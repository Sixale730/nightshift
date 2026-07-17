#!/usr/bin/env node
// install.js — installs nightshift's Claude Code adapter on Windows/macOS/Linux.
//
//   1. Copies policy.js + adapters/claude-code.js -> ~/.claude/hooks/nightshift/
//   2. Merges into ~/.claude/settings.json (backing it up first):
//        - permissions.defaultMode = "acceptEdits"
//        - permissions.deny        = union with the safety deny-floor below
//        - hooks.PreToolUse        = wires the adapter for Bash|PowerShell
//   Idempotent: safe to re-run; replaces any previous nightshift wiring.
//   Never removes your existing allow rules.
//
// Usage:  node install.js

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const DEST_DIR = path.join(CLAUDE_DIR, 'hooks', 'nightshift');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const ADAPTER = path.join(DEST_DIR, 'claude-code.js');
// forward slashes: works in the hook command on Windows and avoids escaping
const HOOK_CMD = 'node ' + ADAPTER.replace(/\\/g, '/');

const DENY_FLOOR = [
  'Bash(rm -rf:*)', 'Bash(rm -fr:*)', 'Bash(dd:*)', 'Bash(mkfs:*)',
  'Bash(shutdown:*)', 'Bash(sudo:*)',
  'Bash(git push:*)', 'Bash(git reset --hard:*)', 'Bash(git clean -f:*)',
  'Bash(git branch -D:*)',
  'Bash(npm publish:*)', 'Bash(yarn publish:*)', 'Bash(pnpm publish:*)',
  'Bash(cargo publish:*)', 'Bash(twine upload:*)', 'Bash(gh release:*)',
  'PowerShell(git push*)', 'PowerShell(Format-Volume*)', 'PowerShell(Clear-Disk*)',
  'PowerShell(diskpart*)', 'PowerShell(bcdedit*)', 'PowerShell(Invoke-Expression*)',
  'PowerShell(reg add*)', 'PowerShell(reg delete*)', 'PowerShell(regedit*)',
  'PowerShell(schtasks*)', 'PowerShell(Register-ScheduledTask*)',
  'PowerShell(New-Service*)', 'PowerShell(Set-Service*)',
  'PowerShell(net user*)', 'PowerShell(net localgroup*)',
  'PowerShell(New-LocalUser*)', 'PowerShell(Add-LocalGroupMember*)',
  'PowerShell(runas*)', 'PowerShell(shutdown*)', 'PowerShell(Stop-Computer*)',
  'PowerShell(Restart-Computer*)', 'PowerShell(cmdkey*)',
  'Read(**/.ssh/**)', 'Read(**/id_rsa*)', 'Read(**/*.pem)',
  'Read(**/.aws/**)', 'Read(**/.git-credentials)'
];

// Self-protection rules use this machine's real paths (double slash = absolute,
// POSIX-normalized, e.g. //c/Users/<user>/.claude/...)
const posixHome = /^[A-Za-z]:/.test(HOME)
  ? '//' + HOME[0].toLowerCase() + HOME.slice(2).replace(/\\/g, '/')
  : HOME;
DENY_FLOOR.push(
  'Edit(' + posixHome + '/.claude/settings.json)',
  'Write(' + posixHome + '/.claude/settings.json)',
  'Edit(' + posixHome + '/.claude/hooks/**)',
  'Write(' + posixHome + '/.claude/hooks/**)'
);

// --- 1. copy the engine + adapter ---------------------------------------------
fs.mkdirSync(DEST_DIR, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'policy.js'), path.join(DEST_DIR, 'policy.js'));
fs.copyFileSync(path.join(__dirname, 'adapters', 'claude-code.js'), ADAPTER);
console.log('[ok] engine + adapter installed at ' + DEST_DIR);

// --- 2. merge settings.json ----------------------------------------------------
let s = {};
if (fs.existsSync(SETTINGS)) {
  const backup = SETTINGS + '.bak-' + new Date().toISOString().slice(0, 10);
  fs.copyFileSync(SETTINGS, backup);
  console.log('[ok] backup written to ' + backup);
  s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
}

s.permissions = s.permissions || {};
if (s.permissions.defaultMode !== 'acceptEdits') {
  s.permissions.defaultMode = 'acceptEdits';
  console.log('[ok] defaultMode set to acceptEdits');
}

const deny = new Set(s.permissions.deny || []);
let added = 0;
for (const rule of DENY_FLOOR) if (!deny.has(rule)) { deny.add(rule); added++; }
s.permissions.deny = Array.from(deny);
console.log('[ok] deny floor merged (+' + added + ' rules, total ' + deny.size + ')');

// drop a conflicting old allow rule if present (deny wins anyway, but keep it clean)
if (Array.isArray(s.permissions.allow)) {
  s.permissions.allow = s.permissions.allow.filter(r => r !== 'Bash(git push *)');
}

s.hooks = s.hooks || {};
s.hooks.PreToolUse = s.hooks.PreToolUse || [];
// replace any previous nightshift wiring (including the legacy single-file name)
s.hooks.PreToolUse = s.hooks.PreToolUse.filter(e => {
  const str = JSON.stringify(e);
  return !str.includes('nightshift') && !str.includes('auto-approve.js');
});
s.hooks.PreToolUse.push({
  matcher: 'Bash|PowerShell',
  hooks: [{ type: 'command', command: HOOK_CMD, timeout: 10 }]
});
console.log('[ok] PreToolUse hook wired: ' + HOOK_CMD);

fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n', 'utf8');
JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); // sanity re-parse
console.log('[ok] settings.json updated and valid');

// --- 3. smoke-test the installed adapter ----------------------------------------
const { execFileSync } = require('child_process');
function probe(cmd) {
  const out = execFileSync('node', [ADAPTER], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }),
    encoding: 'utf8'
  });
  if (!out) return 'defer';
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}
const t1 = probe('cd src && grep -rn TODO . | sort');   // expect allow
const t2 = probe('git status && rm -rf build');          // expect deny
const t3 = probe('npx create-thing');                    // expect defer
console.log('[test] compound read-only -> ' + t1 + (t1 === 'allow' ? ' OK' : ' FAIL'));
console.log('[test] rm -rf tail        -> ' + t2 + (t2 === 'deny' ? ' OK' : ' FAIL'));
console.log('[test] npx (unknown)      -> ' + t3 + (t3 === 'defer' ? ' OK' : ' FAIL'));

console.log('\nDone. Restart your agent session and check with /hooks');
