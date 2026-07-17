#!/usr/bin/env node
// uninstall.js — removes nightshift's Claude Code adapter and its wiring.
// The deny floor and defaultMode are left in place on purpose (they are your
// safety net); remove them manually from settings.json if you want them gone.
//
// Usage:  node uninstall.js
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.USERPROFILE || os.homedir();
const HOOKS_DIR = path.join(HOME, '.claude', 'hooks');
const DEST_DIR = path.join(HOOKS_DIR, 'nightshift');
const LEGACY = path.join(HOOKS_DIR, 'auto-approve.js');
const SETTINGS = path.join(HOME, '.claude', 'settings.json');

if (fs.existsSync(DEST_DIR)) {
  fs.rmSync(DEST_DIR, { recursive: true });
  console.log('[ok] removed ' + DEST_DIR);
}
if (fs.existsSync(LEGACY)) {
  fs.unlinkSync(LEGACY);
  console.log('[ok] removed legacy ' + LEGACY);
}

if (fs.existsSync(SETTINGS)) {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  if (s.hooks && Array.isArray(s.hooks.PreToolUse)) {
    const before = s.hooks.PreToolUse.length;
    s.hooks.PreToolUse = s.hooks.PreToolUse.filter(e => {
      const str = JSON.stringify(e);
      return !str.includes('nightshift') && !str.includes('auto-approve.js');
    });
    const removed = before - s.hooks.PreToolUse.length;
    if (s.hooks.PreToolUse.length === 0) delete s.hooks.PreToolUse;
    if (Object.keys(s.hooks).length === 0) delete s.hooks;
    fs.writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n', 'utf8');
    console.log('[ok] unwired ' + removed + ' hook entry(ies) from settings.json');
  } else {
    console.log('[ok] no PreToolUse wiring found');
  }
}

console.log('\nDone. Restart your agent session. Deny rules + acceptEdits were kept;');
console.log('edit ' + SETTINGS + ' manually if you also want those removed.');
