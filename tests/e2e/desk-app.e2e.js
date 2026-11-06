'use strict';
// The real Rolling Desk app (Electron) against a real studio: connect screen → studio → Console opens by itself →
// a guest joins → record → the take is saved on "this computer" (live copy, then every finished file) → safe to close.
// Needs Playwright + the app's Electron (cd desk && npm install) and a display (run under xvfb-run on a server).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startServer, login, waitFor, tmpDir } = require('../helpers');

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
