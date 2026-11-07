#!/usr/bin/env node
'use strict';
// Stands in for rclone in tests: one pretend cloud account "gdrive:" kept in a folder ($FAKE_RCLONE_ROOT).
// Supports what Rolling uses: listremotes, mkdir, lsf, copy <folder> <remote:path> (skipping hidden files).
// Create $FAKE_RCLONE_ROOT/fail to make uploads fail (like a dropped connection).
const fs = require('fs');
const path = require('path');
const [cmd, ...rest] = process.argv.slice(2), root = process.env.FAKE_RCLONE_ROOT;
const local = r => { const m = /^gdrive:(.*)$/.exec(r); if (!m) { process.stderr.write(`Failed to create file system for "${r}": didn't find section in config file\n`); process.exit(1); } return path.join(root, 'gdrive', m[1]); };
if (cmd === 'listremotes') { console.log('gdrive:'); process.exit(0); }
if (cmd === 'mkdir') { fs.mkdirSync(local(rest[0]), { recursive: true }); process.exit(0); }
if (cmd === 'lsf') { for (const f of fs.readdirSync(local(rest[rest.length - 1]))) console.log(f); process.exit(0); }
if (cmd === 'copy') {
  if (fs.existsSync(path.join(root, 'fail'))) { process.stderr.write('ERROR : Attempt 5/5 failed with 1 errors and: dial tcp: no such host\n'); process.exit(1); }
  const [src, dest] = rest, to = local(dest);
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(src)) if (!f.startsWith('.') && fs.statSync(path.join(src, f)).isFile()) fs.copyFileSync(path.join(src, f), path.join(to, f));
  process.exit(0);
}
process.stderr.write(`fake rclone: unknown command ${cmd}\n`); process.exit(2);
