'use strict';
// Real browsers (Chromium with fake camera/mic) against a real server.
// Needs Playwright:  npm i -g playwright && npx playwright install chromium   — skipped automatically if missing.
//   npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { startServer, login, waitFor } = require('../helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed → tests are skipped below */ }
const skip = !chromium && 'Playwright not installed';
const SPEECH = process.env.E2E_SPEECH_WAV; // optional 16-bit 48 kHz mono WAV for the fake mic (better level readings)

let srv, room;
test.before(async () => {
  if (skip) return;
  srv = await startServer();
  const { cookie } = await login(srv.url);
  room = await (await fetch(srv.url + '/api/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'E2E Show' }) })).json();
});
const browsers = []; // closed at the end even if a test fails, so a failure never hangs the run
test.after(async () => { for (const b of browsers) await b.close().catch(() => {}); if (srv) await srv.stop(); });

async function person(name, host, { control = false } = {}) {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(SPEECH ? [`--use-file-for-fake-audio-capture=${SPEECH}`] : [])];
  const b = await chromium.launch({ args });
  browsers.push(b);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 }, permissions: control ? [] : ['camera', 'microphone'] });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  await p.goto(`${srv.url}/r/${room.id}${host ? '?k=' + room.hostKey : ''}`);
  await p.fill('#nameInput', name);
  if (control) await p.click('#controlBtn');
  else { await p.click('#enableBtn'); await p.waitForSelector('#joinBtn:not([disabled])'); await p.click('#joinBtn'); }
  return { b, p, errors };
}

test('guest waits in the waiting room until the host lets them in', { skip }, async () => {
  const host = await person('Host', true);
  const guest = await person('Guest', false);
  await guest.p.waitForSelector('#message:not(.hidden)');
  assert.match(await guest.p.textContent('#msgTitle'), /Waiting for the host/);
  await host.p.click('.knock button.primary');
  await guest.p.waitForSelector('#studio:not(.hidden)');
  assert.deepEqual([...host.errors, ...guest.errors], []);
  await host.b.close(); await guest.b.close();
});

test('host sees live loudness (LUFS) on every tile and in the Health panel; guest sees their own', { skip }, async () => {
  const host = await person('Host', true);
  const guest = await person('Guest', false); // already admitted in the test above (same browser id is not reused, so admit again)
  await host.p.waitForSelector('.knock button.primary', { timeout: 5000 }).then(b => b.click()).catch(e => assert.ok(/Timeout/.test(e.message)));
  await guest.p.waitForSelector('#studio:not(.hidden)');
  await waitFor(async () => (await host.p.$$eval('.tile:not(.hidden) .tloud', els => els.filter(e => /LUFS/.test(e.textContent)).length)) >= 2, 20000);
  assert.match(await guest.p.textContent('#tile-me .tloud'), /LUFS/);
  assert.equal(await guest.p.$$eval('.tile:not(#tile-me) .tloud', els => els.filter(e => e.textContent).length), 0, 'guests only see their own reading');
  // live level bars: everyone sees a moving bar on every person's tile (their own and everyone else's)
  for (const who of [host, guest]) {
    await waitFor(async () => (await who.p.$$eval('.tile:not(.hidden):not(.screen) .vu .cover', els => els.filter(e => e.style.height && parseFloat(e.style.height) < 95).length)) >= 2, 15000);
  }
  await host.p.click('#healthBtn');
  await waitFor(async () => (await host.p.$$eval('.lnums', els => els.length)) >= 2, 10000);
  assert.deepEqual([...host.errors, ...guest.errors], []);
  await host.b.close(); await guest.b.close();
});

test('control room: host runs the show without camera/mic and is not recorded', { skip }, async () => {
  const host = await person('Producer', true, { control: true });
  const guest = await person('Guest2', false);
  await host.p.waitForSelector('.knock button.primary').then(b => b.click());
  await guest.p.waitForSelector('#studio:not(.hidden)');
  await host.p.click('#recBtn'); await host.p.click('#modalAlt');
  await new Promise(r => setTimeout(r, 6000));
  await host.p.click('#recBtn'); await host.p.click('#modalYes');
  const take = await waitFor(async () => { const r = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json(); return r.takes[0] && r.takes[0].status === 'ready' && r.takes[0]; }, 120000);
  assert.deepEqual(take.people, ['Guest2']);
  assert.deepEqual([...host.errors, ...guest.errors], []);
  await host.b.close(); await guest.b.close();
});

test('producer desk: faders, listening mute, cue card, talkback, cough button, quick tags, show clock, loudness history', { skip }, async () => {
  const host = await person('Sam', true);
  const guest = await person('Steve', false);
  await host.p.waitForSelector('.knock button.primary', { timeout: 5000 }).then(b => b.click()).catch(e => assert.ok(/Timeout/.test(e.message)));
  await guest.p.waitForSelector('#studio:not(.hidden)');
  await waitFor(async () => (await host.p.$$eval('.tile:not(.me) video', vs => vs.filter(v => v.srcObject).length)) >= 1, 15000);

  // desk: one strip per person; the fader and 🎧 mute change only what the host hears
  await host.p.click('#deskBtn');
  await host.p.waitForSelector('#deskStrips .strip:nth-child(2)');
  const vol = () => host.p.$eval('.tile:not(.me):not(.hidden) video', v => v.volume);
  assert.equal(await vol(), 0.5, 'unity fader at the default listening volume');
  await host.p.$eval('#deskStrips .strip:nth-child(2) .sfader', f => { f.value = '6'; f.dispatchEvent(new Event('input')); });
  assert.ok(Math.abs((await vol()) - 0.5 * 10 ** (6 / 20)) < 0.01);
  assert.match(await host.p.textContent('#deskStrips .strip:nth-child(2) .sdb'), /\+6\.0 dB/);
  await host.p.click('#deskStrips .strip:nth-child(2) .smute');
  assert.equal(await vol(), 0);
  await host.p.click('#deskStrips .strip:nth-child(2) .smute');
  assert.equal(await guest.p.$eval('.tile:not(.me):not(.hidden) video', v => v.volume), 1, 'guests hear everyone normally');

  // cue card to Steve only
  await host.p.selectOption('#cueTo', { label: 'Steve' });
  await host.p.click('#cuePresets button:has-text("Wrap up")');
  await guest.p.waitForSelector('#cue:not(.hidden)');
  assert.equal(await guest.p.textContent('#cueMsg'), 'Wrap up');
  await guest.p.click('#cue');

  // talkback: Steve sees the banner and has the private channel playing
  await host.p.selectOption('#talkTo', { label: 'Steve' });
  await host.p.hover('#talkBtn'); await host.p.mouse.down();
  await guest.p.waitForSelector('#talkIn:not(.hidden)');
  assert.ok(await guest.p.evaluate(() => [...window.__studio.peers.values()].some(p => p.talkEl && p.talkEl.srcObject && p.talkEl.srcObject.getAudioTracks().length)));
  await waitFor(() => host.p.evaluate(() => [...window.__studio.peers.values()].every(p => p.mainAudio.track === null && p.talkTr.sender.track)), 5000);
  await host.p.mouse.up();
  await guest.p.waitForSelector('#talkIn.hidden', { state: 'attached' });
  await waitFor(() => host.p.evaluate(() => [...window.__studio.peers.values()].every(p => p.mainAudio.track && !p.talkTr.sender.track)), 5000);

  // cough button (hold C): Steve's live sound stops, the host sees 🤧 on his tile
  await guest.p.keyboard.down('c');
  await host.p.waitForSelector('.tile.coughing');
  await waitFor(() => guest.p.evaluate(() => [...window.__studio.peers.values()].every(p => p.mainAudio.track === null)), 5000);
  await guest.p.keyboard.up('c');
  await host.p.waitForSelector('.tile.coughing', { state: 'detached' });
  await waitFor(() => guest.p.evaluate(() => [...window.__studio.peers.values()].every(p => p.mainAudio.track)), 5000);

  // rundown: save, start a segment — everyone sees the show clock
  await host.p.click('.drawer-tabs [data-tab="rundown"]');
  await host.p.click('#rdAdd'); await host.p.fill('#rundownList .rdrow input[type=text]', 'Interview');
  await host.p.click('#rdSave');
  await waitFor(async () => /Interview/.test(JSON.stringify(await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json())), 5000);
  await host.p.click('#rdNext');
  await waitFor(async () => (await guest.p.textContent('#tcBar [data-tc="segname"]')) === 'INTERVIEW', 5000);
  assert.match(await guest.p.textContent('#tcBar [data-tc="left"]'), /^[45]:\d\d left$/);
  assert.match(await guest.p.textContent('#tcBar [data-tc="seg"]'), /^00:00:0\d:\d\d$/);
  assert.match(await guest.p.textContent('#tcBar [data-tc="tallytext"]'), /STANDBY/);

  // record a few seconds with a quick tag, check the loudness history line
  await host.p.click('#recBtn'); await host.p.click('#modalAlt');
  await new Promise(r => setTimeout(r, 4000));
  // tally + record timecode: everyone sees REC, a red frame, and the same running timecode (25 fps frames)
  assert.equal(await guest.p.textContent('#tcBar [data-tc="tallytext"]'), 'REC');
  assert.ok(await guest.p.evaluate(() => document.body.classList.contains('tally-rec')));
  const tcs = [await host.p.textContent('#tcBar [data-tc="rec"]'), await guest.p.textContent('#tcBar [data-tc="rec"]')];
  for (const x of tcs) assert.match(x, /^00:00:0[3-9]:([01]\d|2[0-4])$/);
  await waitFor(() => guest.p.evaluate(() => document.getElementById('tile-me').classList.contains('rec')), 5000);
  await host.p.click('#clockFull');
  assert.match(await host.p.textContent('#bigClock [data-tc="rec"]'), /^00:00:0\d:\d\d$/);
  await host.p.keyboard.press('Escape');
  await host.p.waitForSelector('#bigClock.hidden', { state: 'attached' });
  await waitFor(() => host.p.evaluate(() => !document.fullscreenElement), 5000); // let full screen finish closing first
  const [popup] = await Promise.all([host.p.waitForEvent('popup'), host.p.click('#clockPop')]);
  await waitFor(async () => /^00:00:\d\d:\d\d$/.test(await popup.textContent('[data-tc="rec"]')), 5000);
  assert.equal(await popup.textContent('[data-tc="tallytext"]'), 'REC');
  await host.p.keyboard.press('1');
  await host.p.click('#healthBtn');
  await waitFor(async () => (await host.p.$$eval('.lhist polyline', els => els.length)) >= 2, 10000);
  await host.p.click('#recBtn'); await host.p.click('#modalYes');
  const take = await waitFor(async () => { const r = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json(); const t = r.takes.find(x => x.status === 'ready' && x.people.includes('Steve')); return t; }, 120000);
  assert.ok(take.markers.some(m => m.label === 'Great bit 1'));
  assert.ok(take.outputs.some(o => o.kind === 'producermix'));
  assert.deepEqual([...host.errors, ...guest.errors], []);
  await host.b.close(); await guest.b.close();
});
