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
