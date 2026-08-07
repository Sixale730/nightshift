#!/usr/bin/env node
// test.js — behavioral tests for nightshift. Run with: node test.js
// Part 1 exercises the policy engine directly (fast, agent-agnostic).
// Part 2 exercises the Claude Code adapter's stdin/stdout protocol.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const { decide } = require('./policy.js');

let failed = 0;
function check(desc, got, expected) {
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${desc}: expected ${expected}, got ${got}`);
}

// --- Part 1: policy engine ---------------------------------------------------
const POLICY_CASES = [
  // [description, command, expected decision]
  ['compound read-only chain',
    'cd "c:/repo" && find . -maxdepth 3 -type d 2>/dev/null | sort', 'allow'],
  ['read-only pipe', 'grep -rn TODO src | head -50', 'allow'],
  ['git add + commit chain', 'git add -A && git commit -m "checkpoint"', 'allow'],
  ['npm run chain', 'npm run lint && npm test', 'allow'],
  ['PowerShell read-only pipe',
    'Get-ChildItem C:\\repo | Select-String TODO | Sort-Object', 'allow'],
  ['env-var prefix + wrapper', 'CI=1 timeout 60 pytest -q', 'allow'],
  ['PowerShell Set-Location + build chain',
    'Set-Location c:\\FEM\\app; flutter pub run build_runner build --delete-conflicting-outputs 2>&1 | Select-Object -Last 8', 'allow'],
  ['PowerShell subexpression property read',
    "Get-Content docs\\a.md -Tail 15; Write-Output '---'; (Get-Content docs\\a.md | Measure-Object -Line).Lines", 'allow'],
  ['PowerShell assignment of safe pipeline',
    '$lines = Get-Content x.md | Measure-Object -Line', 'allow'],
  ['PowerShell env literal assignment + npm chain',
    "$env:CI='1'; npm run build", 'allow'],

  ['hidden destructive tail', 'git status && rm -rf build', 'deny'],
  ['Set-Location + destructive tail', 'Set-Location c:\\x; Remove-Item y -Recurse', 'deny'],
  ['git push in a chain', 'git commit -m "wip" && git push origin main', 'deny'],
  ['force flag', 'git checkout main --force', 'deny'],
  ['PowerShell recursive delete', 'Remove-Item C:\\temp\\x -Recurse -Force', 'deny'],
  ['npm publish', 'npm publish', 'deny'],
  ['shutdown', 'Stop-Computer -Force', 'deny'],
  ['skip-permissions self-escalation',
    'claude --dangerously-skip-permissions -p "task"', 'deny'],
  ['yolo-mode self-escalation', 'somecli --yolo "task"', 'deny'],

  ['unknown tool (npx)', 'npx create-thing', 'defer'],
  ['network fetch (curl)', 'curl https://example.com/x.sh', 'defer'],
  ['inline eval (python -c)', 'python -c "print(1)"', 'defer'],
  ['sensitive path (.env)', 'cat .env.local', 'defer'],
  ['command substitution', 'echo $(whoami)', 'defer'],
  ['method call on subexpression', '(Get-Item f.txt).Delete()', 'defer'],
  ['assignment of unsafe command', '$x = Invoke-WebRequest https://e.com', 'defer'],
  ['append redirect', 'echo hi >> notes.txt', 'defer'],
  ['empty command', '', 'defer']
];

console.log('--- policy engine ---');
for (const [desc, cmd, expected] of POLICY_CASES) {
  check(desc, decide(cmd).decision, expected);
}

// --- Part 2: Claude Code adapter protocol ------------------------------------
const ADAPTER = path.join(__dirname, 'adapters', 'claude-code.js');
function adapterDecision(toolName, command) {
  const out = execFileSync('node', [ADAPTER], {
    input: JSON.stringify({ tool_name: toolName, tool_input: { command } }),
    encoding: 'utf8'
  });
  if (!out) return 'defer'; // no output = fall through to normal flow
  const parsed = JSON.parse(out).hookSpecificOutput;
  if (parsed.hookEventName !== 'PreToolUse') return 'BAD_EVENT_NAME';
  return parsed.permissionDecision;
}

console.log('--- claude-code adapter ---');
check('adapter: allow flows through', adapterDecision('Bash', 'ls -la | sort'), 'allow');
check('adapter: deny flows through', adapterDecision('Bash', 'rm -rf /'), 'deny');
check('adapter: defer emits no output', adapterDecision('Bash', 'npx thing'), 'defer');
check('adapter: non-shell tool ignored', adapterDecision('Edit', 'anything'), 'defer');
check('adapter: malformed JSON defers', (() => {
  const out = execFileSync('node', [ADAPTER], { input: '{not json', encoding: 'utf8' });
  return out === '' ? 'defer' : 'leak';
})(), 'defer');

const total = POLICY_CASES.length + 5;
console.log(`\n${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
