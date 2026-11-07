'use strict';
// Copies the Rolling studio (the same server that runs on a server) into desk/studio, so the app can carry it for
// "Host it on this computer". Its packages (express, ws…) are the app's own dependencies — this checks they match.
// Run before electron-builder: `node scripts/prepare-studio.js`
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..'), out = path.join(__dirname, '..', 'studio');
const FILES = ['server.js', 'log.js', 'proc.js', 'post.js', 'treat.js', 'transcribe.js', 'LICENSE', 'public'];
// the studio's packages must be the app's packages, at the same versions (electron-builder only bundles the app's own)
const want = require(path.join(root, 'package.json')).dependencies, have = require(path.join(__dirname, '..', 'package.json')).dependencies || {};
const differ = Object.keys(want).filter(k => have[k] !== want[k]);
if (differ.length) throw new Error(`desk/package.json dependencies must match the studio's: ${differ.map(k => `${k} ${want[k]}`).join(', ')}`);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of FILES) fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
// every server file it needs must have been copied: check what server.js requires from its own folder
const needs = [...fs.readFileSync(path.join(out, 'server.js'), 'utf8').matchAll(/require\('\.\/([\w.-]+)'\)/g)].map(m => m[1].replace(/\.js$/, '') + '.js');
const missing = needs.filter(f => !fs.existsSync(path.join(out, f)));
if (missing.length) throw new Error(`the studio needs ${missing.join(', ')} — add them to FILES in prepare-studio.js`);
console.log('studio ready in', out);
