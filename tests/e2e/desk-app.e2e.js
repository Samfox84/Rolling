'use strict';
// The real Rolling Desk app (Electron) against a real studio: connect screen → studio → Console opens by itself →
// a guest joins → record → the take is saved on "this computer" (live copy, then every finished file) → safe to close.
// Needs Playwright + the app's Electron (cd desk && npm install) and a display (run under xvfb-run on a server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, login, waitFor, tmpDir, FAKE_WHISPER } = require('../helpers');

let pw = null, electronBin = null;
try { pw = require('playwright'); electronBin = require('../../desk/node_modules/electron'); } catch (e) { /* skipped below */ }
const skip = (!pw || !electronBin) ? 'needs Playwright and the desk app installed (cd desk && npm install)' : (!process.env.DISPLAY && process.platform === 'linux') ? 'needs a display (xvfb-run)' : false;

test('Rolling Desk app: connect, Console, record, everything saved on this computer', { skip, timeout: 600000 }, async () => {
  const srv = await startServer();
  const home = tmpDir('desk-home'), folder = path.join(tmpDir('desk-saves'), 'Rolling Recordings');
  let app, guestBrowser;
  try {
    const { cookie } = await login(srv.url);
    const room = await (await fetch(srv.url + '/api/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'AOL Underground' }) })).json();
    await fetch(`${srv.url}/api/rooms/${room.id}/settings?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ waitingRoom: false }) });
    const hostLink = `${srv.url}/r/${room.id}?k=${room.hostKey}`;

    app = await pw._electron.launch({ executablePath: electronBin, args: ['--no-sandbox', path.join(__dirname, '../../desk')], env: { ...process.env, ROLLING_DESK_HOME: home } });
    const logs = []; app.process().stderr.on('data', d => logs.push(String(d)));
    // ---- first run: the connect screen; a bad link is explained ----
    const connect = await app.firstWindow();
    await connect.waitForSelector('#link');
    await connect.waitForFunction(() => document.querySelector('h1.title img')?.naturalWidth > 0); // the Rolling icon shows
    await connect.fill('#link', `${srv.url}/r/${room.id}`);
    await connect.click('#go');
    await waitFor(async () => /not a host link/.test(await connect.textContent('#err')), 5000);
    await connect.fill('#link', hostLink);
    await connect.evaluate(f => { document.getElementById('folder').value = f; }, folder);
    const [studio] = await Promise.all([app.waitForEvent('window'), connect.click('#go')]);
    const errors = []; studio.on('pageerror', e => errors.push(e.message));
    await studio.waitForSelector('#nameInput');
    assert.ok(await studio.evaluate(() => !!window.rollingDesk), 'the app talks to the studio page');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).link, hostLink, 'remembered for next time');

    // ---- producer in the control room: the Console opens by itself, with the saving status ----
    await studio.fill('#nameInput', 'Sam');
    await studio.click('#controlBtn');
    await studio.waitForSelector('#console:not(.hidden)');
    await waitFor(async () => /new takes are saved here/.test(await studio.textContent('#console .deskSave')), 15000);

    // ---- a guest joins from a normal browser; the producer records a few seconds ----
    guestBrowser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const gp = await (await guestBrowser.newContext({ permissions: ['camera', 'microphone'] })).newPage();
    await gp.goto(`${srv.url}/r/${room.id}`); await gp.fill('#nameInput', 'Steve'); await gp.click('#enableBtn');
    await gp.waitForSelector('#joinBtn:not([disabled])'); await gp.click('#joinBtn');
    await gp.waitForSelector('#studio:not(.hidden)');
    await studio.waitForSelector('#conStrips .cstrip');
    await studio.click('#conRec'); await studio.click('#modalAlt');
    await waitFor(async () => /live copy/.test(await studio.textContent('#console .deskSave')), 20000); // saving on this computer while recording
    const liveDir = () => { const show = path.join(folder, 'AOL Underground'); const t = fs.existsSync(show) && fs.readdirSync(show)[0]; return t && path.join(show, t, 'Live copy'); };
    await waitFor(() => liveDir() && fs.existsSync(path.join(liveDir(), 'Steve.wav')) && fs.statSync(path.join(liveDir(), 'Steve.wav')).size > 48000 * 3, 20000);
    await new Promise(r => setTimeout(r, 4000));
    await studio.click('#conRec'); await studio.click('#modalYes');

    // ---- the take is built; the app downloads every finished file and says it's safe to close ----
    const take = await waitFor(async () => { const r = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json(); return r.takes[0] && r.takes[0].status === 'ready' && r.takes[0]; }, 180000);
    await waitFor(async () => /safe to close/.test(await studio.textContent('#console .deskSave')), 60000);
    const takeDir = path.dirname(liveDir());
    for (const o of take.outputs) assert.equal(fs.statSync(path.join(takeDir, o.file)).size, o.size, `${o.file} saved on this computer`);
    assert.equal(fs.existsSync(path.join(takeDir, 'Live copy')), false, 'live copy tidied away');

    assert.deepEqual(errors, [], 'no errors in the studio page');
    assert.equal(logs.join('').match(/\[error\]/g), null, `app log: ${logs.join('')}`);
  } finally {
    if (guestBrowser) await guestBrowser.close().catch(() => {});
    if (app) await app.close().catch(() => {});
    await srv.stop();
  }
});

test('Rolling Desk app: host the whole studio on this computer (no server) — guest link, recording, transcript, safe close', { skip, timeout: 600000 }, async () => {
  const home = tmpDir('desk-host-home'), studioFolder = path.join(tmpDir('desk-host'), 'Rolling Studio');
  // the bundled tools, stood in for: real ffmpeg, the test transcript engine, and a pretend Cloudflare tunnel
  const tools = tmpDir('desk-tools'), tunnelLog = path.join(tools, 'tunnel.log'), which = n => require('child_process').execFileSync('which', [n]).toString().trim();
  fs.symlinkSync(which('ffmpeg'), path.join(tools, 'ffmpeg')); fs.symlinkSync(which('ffprobe'), path.join(tools, 'ffprobe'));
  const fakeTunnel = path.join(__dirname, '..', 'fixtures', 'fake-cloudflared.js'); fs.chmodSync(fakeTunnel, 0o755); fs.chmodSync(FAKE_WHISPER, 0o755);
  fs.symlinkSync(fakeTunnel, path.join(tools, 'cloudflared')); fs.symlinkSync(FAKE_WHISPER, path.join(tools, 'whisper-cli'));
  fs.mkdirSync(path.join(tools, 'models')); fs.writeFileSync(path.join(tools, 'models', 'ggml-base.en.bin'), 'test');
  const GUEST_LINK = 'https://rolling-test.trycloudflare.com';
  let app, guestBrowser;
  try {
    app = await pw._electron.launch({ executablePath: electronBin, args: ['--no-sandbox', path.join(__dirname, '../../desk')],
      env: { ...process.env, ROLLING_DESK_HOME: home, ROLLING_DESK_TOOLS: tools, FAKE_TUNNEL_LOG: tunnelLog, NO_EXTERNAL_CALLS: '1', ROOM_TONE_SECONDS: '3', LATE_REBUILD_SECONDS: '2', LIVE_TX_SECONDS: '1' } });
    const logs = []; app.process().stderr.on('data', d => logs.push(String(d))); app.process().stdout.on('data', d => logs.push(String(d)));
    // ---- the start screen: "Host it on this computer" ----
    const start = await app.firstWindow();
    await start.waitForSelector('#tHost');
    assert.equal(await start.isChecked('#remember'), false, 'asks every time unless you choose otherwise');
    await start.click('#tHost');
    await start.evaluate(f => { document.getElementById('sfolder').value = f; }, studioFolder);
    const [desk] = await Promise.all([app.waitForEvent('window'), start.click('#hgo')]);
    const errors = []; desk.on('pageerror', e => errors.push(e.message));
    // ---- signed in to its own dashboard by itself, and the dashboard shows the guest link ----
    await desk.waitForSelector('#dash:not(.hidden)', { timeout: 60000 });
    const tunnel = JSON.parse(fs.readFileSync(tunnelLog, 'utf8').trim().split('\n')[0]);
    const local = tunnel.args[tunnel.args.indexOf('--url') + 1];
    assert.match(local, /^http:\/\/127\.0\.0\.1:\d+$/, 'the tunnel points at the studio on this computer');
    await waitFor(async () => (await (await fetch(local + '/api/info')).json()).link === GUEST_LINK, 10000, 200); // the studio is told its guest link
    assert.match(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), /hosting on this computer · guests: https:\/\/rolling-test\.trycloudflare\.com/);
    await desk.fill('#newName', 'AOL Underground'); await desk.press('#newName', 'Enter');
    await waitFor(async () => (await desk.$$eval('.linkbox input', els => els.map(e => e.value))).some(v => v.startsWith(GUEST_LINK + '/r/')), 15000);
    // "Open studio as host" goes to the guest-link address — the app opens it on this computer instead
    await desk.click('text=Open studio as host');
    await desk.waitForURL(u => u.href.startsWith(local + '/r/'), { timeout: 15000 });
    await desk.waitForSelector('#nameInput');
    await desk.fill('#nameInput', 'Sam'); await desk.click('#controlBtn');
    await desk.waitForSelector('#console:not(.hidden)');
    // the room's "copy guest link" gives the internet address, not this computer's
    assert.equal(await desk.evaluate(() => Rolling.linkBase()), GUEST_LINK);

    // ---- a guest joins (here straight to this computer, standing in for the tunnel) and we record ----
    const roomId = new URL(desk.url()).pathname.split('/').pop();
    guestBrowser = await pw.chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const gp = await (await guestBrowser.newContext({ permissions: ['camera', 'microphone'] })).newPage();
    await gp.goto(`${local}/r/${roomId}`); await gp.fill('#nameInput', 'Steve'); await gp.click('#enableBtn');
    await gp.waitForSelector('#joinBtn:not([disabled])'); await gp.click('#joinBtn');
    await desk.waitForSelector('.knock button.primary', { timeout: 20000 }).then(b => b.click());
    await gp.waitForSelector('#studio:not(.hidden)');
    await desk.waitForSelector('#conStrips .cstrip');
    await desk.click('#conRec'); await desk.click('#modalAlt');
    await desk.waitForSelector('#conRec.live');
    await new Promise(r => setTimeout(r, 6000));
    // closing now asks first, and says why — and "keep running" keeps it running
    await app.evaluate(({ dialog }) => { global.__asked = []; dialog.showMessageBoxSync = (w, o) => { global.__asked.push((o || w).message); return 0; }; });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitFor(() => app.evaluate(() => global.__asked.length), 10000);
    assert.match((await app.evaluate(() => global.__asked))[0], /recording in AOL Underground/);
    assert.equal((await fetch(local + '/api/info')).ok, true, 'still running');
    await desk.click('#conRec'); await desk.click('#modalYes');

    // ---- the take is made on this computer: files and transcript in the studio folder ----
    const roomDir = path.join(studioFolder, 'rooms', roomId);
    const takeJson = await waitFor(() => {
      const takes = path.join(roomDir, 'takes'); if (!fs.existsSync(takes)) return null;
      const t = fs.readdirSync(takes)[0], f = t && path.join(takes, t, 'take.json');
      const j = f && fs.existsSync(f) && JSON.parse(fs.readFileSync(f, 'utf8'));
      return j && j.status === 'ready' && j;
    }, 240000, 1000);
    const out = path.join(roomDir, 'takes', takeJson.id, 'out');
    const files = fs.readdirSync(out);
    for (const want of [/Steve.*\.wav$/, /Producer mix/, /Transcript/]) assert.ok(files.some(f => want.test(f)), `${want} in ${files.join(', ')}`);

    // ---- File › "Stop hosting / connect to a studio instead…": asks, stops the studio and the tunnel, shows the start screen ----
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); });
    const [startAgain] = await Promise.all([app.waitForEvent('window'), app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items.find(i => i.label === 'File').submenu.items.find(i => /Stop hosting/.test(i.label));
      item.click();
    })]);
    await startAgain.waitForSelector('#tHost');
    await waitFor(async () => { try { await fetch(local + '/api/info', { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }, 10000);
    await waitFor(() => { try { process.kill(tunnel.pid, 0); return false; } catch { return true; } }, 10000);
    await waitFor(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1), 5000); // the old window is gone, the app is still open
    // …and then close the app
    const exited = new Promise(r => app.process().once('exit', r));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await exited; app = null;
    assert.deepEqual(errors, [], 'no errors in the studio page');
    assert.equal(logs.join('').match(/\[error\]/g), null, `app log: ${logs.join('')}`);
  } finally {
    if (guestBrowser) await guestBrowser.close().catch(() => {});
    if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {}); await app.close().catch(() => {}); } // a failed test mustn't hang on "stop the studio?"
  }
});

test('Rolling Desk app: host with your own address (named tunnel), free space shown, and a crash leaves nothing running', { skip, timeout: 300000 }, async () => {
  const home = tmpDir('desk-own-home'), studioFolder = path.join(tmpDir('desk-own'), 'Rolling Studio');
  const tools = tmpDir('desk-own-tools'), tunnelLog = path.join(tools, 'tunnel.log'), which = n => require('child_process').execFileSync('which', [n]).toString().trim();
  fs.symlinkSync(which('ffmpeg'), path.join(tools, 'ffmpeg')); fs.symlinkSync(which('ffprobe'), path.join(tools, 'ffprobe'));
  const fakeTunnel = path.join(__dirname, '..', 'fixtures', 'fake-cloudflared.js'); fs.chmodSync(fakeTunnel, 0o755);
  fs.symlinkSync(fakeTunnel, path.join(tools, 'cloudflared'));
  const TOKEN = 'eyJhIjoiZmFrZS1hY2NvdW50IiwidCI6ImZha2UtdHVubmVsIiwicyI6ImZha2Utc2VjcmV0In0abcdefgh';
  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, ROLLING_DESK_HOME: home, ROLLING_DESK_TOOLS: tools, FAKE_TUNNEL_LOG: tunnelLog, NO_EXTERNAL_CALLS: '1' };
  const launch = () => pw._electron.launch({ executablePath: electronBin, args: ['--no-sandbox', path.join(__dirname, '../../desk')], env });
  let app = await launch();
  try {
    const start = await app.firstWindow();
    await start.waitForSelector('#tHost'); await start.click('#tHost');
    await start.evaluate(f => { document.getElementById('sfolder').value = f; }, studioFolder);
    // free space is shown for the chosen folder
    await waitFor(async () => /GB free/.test(await start.textContent('#sspace')), 5000);
    // your own address: the steps and sign-up links appear; a bad address or token is refused with a clear reason
    await start.check('input[name=gl][value=own]');
    await start.waitForSelector('#own:not([hidden])');
    assert.ok(await start.$('a[href="https://dash.cloudflare.com/sign-up"]'), 'sign-up link');
    await start.fill('#addr', 'not an address'); await start.fill('#token', TOKEN);
    await start.click('#hgo');
    await waitFor(async () => /your own address/i.test(await start.textContent('#herr')), 5000);
    await start.fill('#addr', 'https://Podcast.Example.com/'); await start.fill('#token', 'short');
    await start.click('#hgo');
    await waitFor(async () => /tunnel token/i.test(await start.textContent('#herr')), 5000);
    await start.click('summary'); await start.fill('#port', String(port));
    // pasting Cloudflare's whole install command works: the token is the long code at its end
    await start.fill('#token', `sudo cloudflared service install ${TOKEN}`);
    await start.check('#remember'); // go straight to hosting next time
    const [desk] = await Promise.all([app.waitForEvent('window'), start.click('#hgo')]);
    await desk.waitForSelector('#dash:not(.hidden)', { timeout: 60000 });
    const local = `http://127.0.0.1:${port}`;
    await waitFor(async () => (await (await fetch(local + '/api/info')).json()).link === 'https://podcast.example.com', 10000, 200);
    const tunnel = JSON.parse(fs.readFileSync(tunnelLog, 'utf8').trim().split('\n')[0]);
    assert.ok(tunnel.args.includes('run'), 'a named tunnel'); assert.equal(tunnel.token, TOKEN, 'token given to cloudflared');
    assert.ok(!tunnel.args.join(' ').includes(TOKEN), 'the token is never on the command line');
    assert.ok(!fs.readFileSync(path.join(home, 'config.json'), 'utf8').includes(TOKEN), 'the token is not in the settings file');
    await waitFor(async () => /guests: https:\/\/podcast\.example\.com · \d+ GB free/.test(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())), 10000, 200);
    // ---- the diary: a page error is written down with the steps before it; Help › Save a problem report is safe to share ----
    await desk.click('text=Recordings').catch(() => {}); // a step to find in the report
    await desk.evaluate(() => setTimeout(() => { throw new Error('pretend page problem'); }, 0));
    await waitFor(() => fs.readdirSync(home).some(f => /^crash-.*\.txt$/.test(f)), 10000, 200);
    const crashFile = fs.readdirSync(home).find(f => /^crash-.*\.txt$/.test(f));
    assert.match(fs.readFileSync(path.join(home, crashFile), 'utf8'), /Where: the studio page[\s\S]*pretend page problem[\s\S]*hosting on this computer/);
    const reportPath = path.join(home, 'report.txt');
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, reportPath);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(i => i.label === 'Help').submenu.items.find(i => /problem report/.test(i.label)).click());
    await waitFor(() => fs.existsSync(reportPath), 10000, 200);
    const report = fs.readFileSync(reportPath, 'utf8');
    assert.match(report, /ROLLING DESK — PROBLEM REPORT/); assert.match(report, /pretend page problem/); assert.match(report, /studio started on this computer/);
    assert.match(report, /END OF THE STUDIO'S LOG/);
    assert.ok(!report.includes(TOKEN) && !report.includes(require('os').homedir()), 'nothing private in the report');
    // ---- the app crashes: the studio stops by itself; the guest-link program is stopped next time ----
    app.process().kill('SIGKILL'); app = null;
    await waitFor(async () => { try { await fetch(local + '/api/info', { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }, 15000);
    process.kill(tunnel.pid, 0); // still running (nothing could stop it)
    app = await launch(); // "Remember my choice" was ticked: opens straight back into hosting
    await waitFor(() => { try { process.kill(tunnel.pid, 0); return false; } catch { return true; } }, 30000);
    await waitFor(async () => { try { return (await fetch(local + '/api/info')).ok; } catch { return false; } }, 60000, 500);
  } finally {
    if (app) { await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; }).catch(() => {}); await app.close().catch(() => {}); }
    for (const l of (fs.existsSync(tunnelLog) ? fs.readFileSync(tunnelLog, 'utf8').trim().split('\n') : [])) try { process.kill(JSON.parse(l).pid); } catch { /* already stopped */ }
  }
});

test('Rolling Desk app: updating — asks first, shows the download filling up, says it will close and reopen, then the new version starts', { skip, timeout: 180000 }, async () => {
  const http = require('http'), crypto = require('crypto');
  const home = tmpDir('desk-upd-home'), dir = tmpDir('desk-upd'), marker = path.join(dir, 'new-version-started');
  // pretend this copy is an AppImage, and GitHub has a new one (2 MB, sent slowly so the progress can be seen)
  const appImage = path.join(dir, 'Rolling-Desk.AppImage');
  fs.writeFileSync(appImage, '#!/bin/sh\necho old\n', { mode: 0o755 });
  const newApp = Buffer.concat([Buffer.from(`#!/bin/sh\necho started > '${marker}'\nexit 0\n`), Buffer.alloc(2e6, 0x23)]);
  const name = 'Rolling-Desk-9.9.9-linux-x86_64.AppImage', sum = crypto.createHash('sha256').update(newApp).digest('hex');
  const gh = http.createServer(async (req, res) => {
    if (req.url === '/repos/Samfox84/Rolling/releases/latest') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ tag_name: 'desk-v9.9.9', html_url: 'https://github.com/Samfox84/Rolling/releases', assets: [name, 'SHA256SUMS.txt'].map(n => ({ name: n, size: n === name ? newApp.length : 80, browser_download_url: `http://127.0.0.1:${gh.address().port}/${n}` })) }));
    }
    if (req.url === '/SHA256SUMS.txt') return res.end(`${sum}  ${name}\n`);
    if (req.url !== '/' + name) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Length', newApp.length);
    for (let i = 0; i < newApp.length; i += 100000) { res.write(newApp.subarray(i, i + 100000)); await new Promise(r => setTimeout(r, 150)); }
    res.end();
  });
  await new Promise(r => gh.listen(0, '127.0.0.1', r));
  let app, proc;
  try {
    app = await pw._electron.launch({ executablePath: electronBin, args: ['--no-sandbox', path.join(__dirname, '../../desk')],
      env: { ...process.env, ROLLING_DESK_HOME: home, APPIMAGE: appImage, ROLLING_DESK_UPDATE_API: `http://127.0.0.1:${gh.address().port}` } });
    proc = app.process();
    await (await app.firstWindow()).waitForSelector('#tConnect');
    // answer "Update now" when asked, and keep what was asked
    await app.evaluate(({ dialog }) => { global.asked = []; dialog.showMessageBox = async (...a) => { global.asked.push(a.at(-1)); return { response: 0 }; }; });
    // watch the "Updating Rolling Desk" window until the app closes itself
    const seen = new Set(); let asked = [], gone = false;
    proc.once('exit', () => { gone = true; });
    while (!gone) {
      const now = await app.evaluate(async ({ BrowserWindow }) => ({ asked: global.asked.map(o => o.message),
        shown: await Promise.all(BrowserWindow.getAllWindows().filter(w => w.getTitle() !== 'Rolling Desk').map(w => w.webContents.executeJavaScript("document.getElementById('title').textContent + ' | ' + document.getElementById('text').textContent").catch(() => ''))) })).catch(() => null);
      if (now) { asked = now.asked; now.shown.forEach(x => x && seen.add(x)); }
      await new Promise(r => setTimeout(r, 100));
    }
    const shown = [...seen];
    assert.deepEqual(asked, ['Rolling Desk 9.9.9 is out'], 'asks before downloading anything');
    assert.ok(shown.some(x => /^Downloading Rolling Desk 9\.9\.9 \| [1-9]\d?% — \d+ MB of 2 MB$/.test(x)), `the download fills up: ${shown.join(' / ')}`);
    assert.ok(shown.includes('Installing Rolling Desk 9.9.9 | Rolling Desk will close now and open again by itself in a few seconds.'), `says what happens next: ${shown.join(' / ')}`);
    await waitFor(() => fs.existsSync(marker), 20000, 200);
    assert.equal(fs.readFileSync(appImage).length, newApp.length, 'new version in place');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).updatingTo, { from: require('../../desk/package.json').version, to: '9.9.9' }, 'the new version will say it worked');
    // next start: it says how the update went, once
    app = await pw._electron.launch({ executablePath: electronBin, args: ['--no-sandbox', path.join(__dirname, '../../desk')], env: { ...process.env, ROLLING_DESK_HOME: home } });
    proc = app.process();
    await (await app.firstWindow()).waitForSelector('#tConnect');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')).updatingTo, undefined, 'told once, then forgotten');
  } finally {
    gh.close();
    if (proc && proc.exitCode === null) await app.close().catch(() => {});
  }
});
