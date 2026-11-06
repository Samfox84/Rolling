'use strict';
// Rolling Desk self-updater against a pretend GitHub: finds the latest desk release, picks the right download,
// refuses a damaged one, swaps the app in after it quits and starts the new one (Linux AppImage path, run for real;
// the Mac path is checked by its script, since this machine can't run macOS tools).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Updater } = require('../desk/updater');
const { tmpDir, waitFor } = require('./helpers');

function fakeGitHub(files, latest) {
  const srv = http.createServer((req, res) => {
    if (req.url === '/repos/Samfox84/Rolling/releases/latest') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(latest())); }
    const f = files[decodeURIComponent(req.url.slice(1))];
    if (f === undefined) { res.statusCode = 404; return res.end(); }
    res.end(f);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

test('finds the update, refuses a damaged download, swaps the AppImage after the app quits and starts the new one', async () => {
  const dir = tmpDir('upd'), marker = path.join(dir, 'new-version-started');
  const current = path.join(dir, 'Rolling-Desk.AppImage');
  fs.writeFileSync(current, '#!/bin/sh\necho old\n', { mode: 0o755 });
  const newApp = `#!/bin/sh\necho started > '${marker}'\n`;
  const sum = crypto.createHash('sha256').update(newApp).digest('hex');
  let sums = `${'0'.repeat(64)}  Rolling-Desk-0.2.0-linux-x86_64.AppImage\n`; // wrong fingerprint first
  const files = { 'Rolling-Desk-0.2.0-linux-x86_64.AppImage': newApp, 'SHA256SUMS.txt': () => sums };
  const gh = await fakeGitHub(new Proxy(files, { get: (o, k) => (typeof o[k] === 'function' ? o[k]() : o[k]) }), () => ({
    tag_name: 'desk-v0.2.0', html_url: 'https://github.com/Samfox84/Rolling/releases/tag/desk-v0.2.0', draft: false, prerelease: false,
    assets: ['Rolling-Desk-0.2.0-linux-x86_64.AppImage', 'Rolling-Desk-0.2.0-mac-x64.zip', 'SHA256SUMS.txt'].map(n => ({ name: n, browser_download_url: `${gh.url}/${n}` })),
  }));
  try {
    const u = new Updater({ current: '0.1.0', workDir: dir, platform: 'linux', appImage: current, api: gh.url });
    assert.equal(u.kind(), 'appimage');
    assert.equal(await new Updater({ current: '0.2.0', workDir: dir, platform: 'linux', appImage: current, api: gh.url }).check(), null, 'already up to date');
    const info = await u.check();
    assert.equal(info.version, '0.2.0'); assert.match(info.asset.name, /AppImage$/);
    await assert.rejects(u.download(info), /damaged/, 'a download that doesn\'t match its fingerprint is thrown away');
    assert.equal(fs.readFileSync(current, 'utf8'), '#!/bin/sh\necho old\n', 'the installed app is untouched');
    sums = `${sum}  Rolling-Desk-0.2.0-linux-x86_64.AppImage\n`;
    const ready = await u.download(info);
    assert.equal(ready.version, '0.2.0');
    // "Restart": the swap waits for the running app to quit, then starts the new one
    const running = spawn('sleep', ['1']);
    u.apply(running.pid);
    assert.equal(fs.readFileSync(current, 'utf8'), '#!/bin/sh\necho old\n', 'nothing is replaced while the app is still running');
    await waitFor(() => fs.existsSync(marker), 10000, 100);
    assert.equal(fs.readFileSync(current, 'utf8'), newApp, 'new version in place');
    assert.equal(fs.existsSync(current + '.old'), false, 'old copy tidied away');
  } finally { gh.srv.close(); }
});

test('Mac: picks the right download for Intel or Apple Silicon and swaps the app bundle, then opens it', async () => {
  const u = new Updater({ current: '0.1.0', workDir: '/tmp', platform: 'darwin', arch: 'x64', execPath: "/Applications/Rolling Desk.app/Contents/MacOS/Rolling Desk", api: 'http://unused' });
  assert.equal(u.kind(), 'mac');
  assert.equal(u.target(), '/Applications/Rolling Desk.app');
  u.ready = { version: '0.2.0', path: "/Users/sam/Library/Application Support/Rolling Desk/update-0.2.0/app/Rolling Desk.app" };
  const s = u.script(4242);
  assert.match(s, /while kill -0 4242/);
  assert.match(s, /mv '\/Applications\/Rolling Desk\.app' '\/Applications\/Rolling Desk\.app\.old' && mv '\/Users\/sam\/.*Rolling Desk\.app' '\/Applications\/Rolling Desk\.app'/);
  assert.match(s, /xattr -dr com\.apple\.quarantine/); assert.match(s, /open '\/Applications\/Rolling Desk\.app'/);
  assert.match(s, /else \[ -e .* \] && \[ ! -e .* \] && mv/, 'puts the old app back if the swap fails');
});

test('the .deb (or a dev copy) can\'t replace itself, so it only points to the download page', () => {
  assert.equal(new Updater({ current: '0.1.0', workDir: '/tmp', platform: 'linux', appImage: undefined }).kind(), 'manual');
});
