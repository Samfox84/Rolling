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
test.after(async () => { if (srv) await srv.stop(); });

async function person(name, host, { control = false } = {}) {
  const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(SPEECH ? [`--use-file-for-fake-audio-capture=${SPEECH}`] : [])];
  const b = await chromium.launch({ args });
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
