'use strict';
// Copies the Rolling studio (the same server that runs on a server) into desk/build/studio, with its packages, so
// the app can carry it for "Host it on this computer". Run before electron-builder: `node scripts/prepare-studio.js`
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..', '..'), out = path.join(__dirname, '..', 'build', 'studio');
const FILES = ['server.js', 'log.js', 'proc.js', 'post.js', 'treat.js', 'transcribe.js', 'package.json', 'LICENSE', 'public'];
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of FILES) fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: out, stdio: 'inherit' });
// every server file it needs must have been copied: check what server.js requires from its own folder
const needs = [...fs.readFileSync(path.join(out, 'server.js'), 'utf8').matchAll(/require\('\.\/([\w.-]+)'\)/g)].map(m => m[1].replace(/\.js$/, '') + '.js');
const missing = needs.filter(f => !fs.existsSync(path.join(out, f)));
if (missing.length) throw new Error(`the studio needs ${missing.join(', ')} — add them to FILES in prepare-studio.js`);
console.log('studio ready in', out);
