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
    const seen = [];
    u.on('progress', p => seen.push(['progress', p])); u.on('checking', c => seen.push(['checking', c]));
    const ready = await u.download(info);
    // the progress bar: starts at nothing, ends with the whole file, then "checking"
    assert.deepEqual(seen[0], ['progress', { version: '0.2.0', done: 0, total: newApp.length }]);
    assert.deepEqual(seen.at(-2), ['progress', { version: '0.2.0', done: newApp.length, total: newApp.length }]);
    assert.deepEqual(seen.at(-1), ['checking', { version: '0.2.0' }]);
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

test('a copy run from somewhere else (e.g. while developing) only points to the download page', () => {
  assert.equal(new Updater({ current: '0.1.0', workDir: '/tmp', platform: 'linux', appImage: undefined, execPath: '/home/sam/Rolling/desk/node_modules/electron/dist/electron' }).kind(), 'manual');
});

test('Windows: downloads and checks the new installer, then runs it silently after the app quits and reopens the app', async () => {
  const dir = tmpDir('upd-win'), exe = path.join(dir, 'Programs', 'Rolling Desk', 'Rolling Desk.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'old');
  const installer = 'pretend NSIS installer', sum = crypto.createHash('sha256').update(installer).digest('hex');
  const name = 'Rolling-Desk-0.3.0-win-x64.exe';
  const gh = await fakeGitHub({ [name]: installer, 'SHA256SUMS.txt': `${sum}  ${name}\n` }, () => ({
    tag_name: 'desk-v0.3.0', html_url: 'https://github.com/Samfox84/Rolling/releases/tag/desk-v0.3.0',
    assets: [name, 'Rolling-Desk-0.3.0-linux-x86_64.AppImage', 'SHA256SUMS.txt'].map(n => ({ name: n, browser_download_url: `${gh.url}/${n}` })),
  }));
  try {
    const u = new Updater({ current: '0.2.2', workDir: dir, platform: 'win32', arch: 'x64', execPath: exe, api: gh.url });
    assert.equal(u.kind(), 'windows');
    assert.equal(new Updater({ current: '0', workDir: dir, platform: 'win32', execPath: 'C:\\dev\\node_modules\\electron\\dist\\electron.exe' }).kind(), 'manual', 'not while developing');
    const info = await u.check();
    assert.equal(info.asset.name, name, 'the Windows installer, not another computer\'s download');
    const ready = await u.download(info);
    assert.equal(fs.readFileSync(ready.path, 'utf8'), installer);
    const cmd = u.windowsScript(4242);
    assert.match(cmd, /tasklist \/FI "PID eq 4242"/, 'waits for the app to quit');
    assert.ok(cmd.includes(`"${ready.path}" /S --force-run`), 'silent install, then opens the new version');
    assert.ok(cmd.includes('\r\n'), 'Windows line endings');
  } finally { gh.srv.close(); }
});

test('Linux .deb: downloads and checks the new .deb, installs it with the password box (pkexec), and says when it was cancelled', async () => {
  const dir = tmpDir('upd-deb'), log = path.join(dir, 'pkexec.log');
  // a stand-in for pkexec: records what it was asked to run; exits 126 (cancelled) when told to
  const fake = path.join(dir, 'pkexec');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> '${log}'\n[ -f '${dir}/cancel' ] && exit 126\nexit 0\n`, { mode: 0o755 });
  const deb = 'pretend .deb', sum = crypto.createHash('sha256').update(deb).digest('hex'), name = 'Rolling-Desk-0.3.1-linux-amd64.deb';
  const gh = await fakeGitHub({ [name]: deb, 'SHA256SUMS.txt': `${sum}  ${name}\n` }, () => ({
    tag_name: 'desk-v0.3.1', html_url: 'https://github.com/Samfox84/Rolling/releases/tag/desk-v0.3.1',
    assets: [name, 'Rolling-Desk-0.3.1-linux-x86_64.AppImage', 'SHA256SUMS.txt'].map(n => ({ name: n, browser_download_url: `${gh.url}/${n}` })),
  }));
  try {
    const u = new Updater({ current: '0.3.0', workDir: dir, platform: 'linux', arch: 'x64', execPath: '/opt/Rolling Desk/rolling-desk', appImage: undefined, api: gh.url, pkexec: fake });
    assert.equal(u.kind(), 'deb'); assert.equal(u.canReplace(), true);
    const info = await u.check();
    assert.equal(info.asset.name, name, 'the .deb, not the AppImage');
    const ready = await u.download(info);
    await u.installDeb();
    assert.equal(fs.readFileSync(log, 'utf8').trim(), `apt-get install -y --allow-downgrades ${ready.path}`);
    fs.writeFileSync(path.join(dir, 'cancel'), '');
    await assert.rejects(u.installDeb(), /Cancelled/);
    const missing = new Updater({ current: '0.3.0', workDir: dir, platform: 'linux', arch: 'x64', execPath: '/opt/Rolling Desk/rolling-desk', api: gh.url, pkexec: path.join(dir, 'no-such-program') });
    missing.ready = u.ready;
    await assert.rejects(missing.installDeb(), /sudo apt install/);
  } finally { gh.srv.close(); }
});

test('the "Updating Rolling Desk" window: a filling bar with the percentage while downloading, a moving bar while it checks and installs', async () => {
  const { chromium } = require('playwright');
  const b = await chromium.launch();
  try {
    const p = await b.newPage();
    await p.goto('file://' + path.join(__dirname, '..', 'desk', 'update.html'));
    await p.evaluate(() => show({ title: 'Downloading Rolling Desk 0.3.3', text: '45% — 63 of 140 MB', detail: 'You can keep using Rolling Desk while it downloads.', fraction: 0.45 }));
    assert.equal(await p.textContent('#title'), 'Downloading Rolling Desk 0.3.3');
    assert.equal(await p.textContent('#text'), '45% — 63 of 140 MB');
    assert.equal(await p.getAttribute('#bar', 'aria-valuenow'), '45');
    assert.equal(await p.$eval('#bar', e => e.classList.contains('busy')), false);
    assert.equal(await p.$eval('#fill', e => e.style.width), '45%');
    await p.evaluate(() => show({ title: 'Installing Rolling Desk 0.3.3', text: 'Rolling Desk will close now and open again by itself in a few seconds.', fraction: null }));
    assert.equal(await p.$eval('#bar', e => e.classList.contains('busy')), true, 'no fake percentage while installing');
    assert.equal(await p.getAttribute('#bar', 'aria-valuenow'), null);
    assert.equal(await p.textContent('#detail'), '');
    assert.equal(await p.title(), 'Installing Rolling Desk 0.3.3');
  } finally { await b.close(); }
});
