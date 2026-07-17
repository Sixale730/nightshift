#!/usr/bin/env node
// adapters/claude-code.js — Claude Code adapter for the nightshift policy engine.
//
// Claude Code invokes this as a PreToolUse hook: it receives a JSON payload on
// stdin and expects a permissionDecision JSON on stdout (or no output to fall
// through to the normal permission flow). This file only translates that
// protocol; all decisions live in policy.js.
//
// Writing an adapter for another agent = mapping its interception mechanism
// to policy.decide(command) the same way.

'use strict';

// Works both in the repo layout (../policy) and installed flat (./policy).
var policy;
try { policy = require('./policy.js'); }
catch (e) { policy = require('../policy.js'); }

var raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', function (c) { raw += c; });
process.stdin.on('end', function () {
  try { main(raw); } catch (e) { process.exit(0); } // fail safe: defer
});

function main(input) {
  var data;
  try { data = JSON.parse(input); } catch (e) { return process.exit(0); }

  // Only shell tools are in scope; everything else falls through.
  var tool = data.tool_name || '';
  if (tool !== 'Bash' && tool !== 'PowerShell') return process.exit(0);

  var command = ((data.tool_input || {}).command || '');
  var result = policy.decide(command);

  // 'defer' -> no output: Claude Code applies its normal permission flow,
  // so the user's existing allow-rules keep working.
  if (result.decision === 'defer') return process.exit(0);

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.decision, // "allow" | "deny"
      permissionDecisionReason: result.reason
    }
  }));
  process.exit(0);
}
