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
  assert.ok(await guest.p.evaluate(() => [...window.__studio.peers.values()].some(p => p.extraAudio && Object.values(p.extraAudio).some(el => el.srcObject && el.srcObject.getAudioTracks().length))));
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

test('Console extras: green room, soundboard, gate, auto mix, auto level, scenes, ON AIR, notes, live script', { skip, timeout: 180000 }, async () => {
  // a 3-second jingle for pad F1
  const wav = path.join(require('os').tmpdir(), `rolling-e2e-jingle-${process.pid}.wav`);
  require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', wav]);
  const up = await fetch(`${srv.url}/api/rooms/${room.id}/sounds?k=${room.hostKey}`, { method: 'POST', headers: { 'X-Filename': 'Station ident.wav' }, body: require('fs').readFileSync(wav) });
  assert.equal(up.status, 200, await up.text());
  const host = await person('Producer', true, { control: true });
  const steve = await person('Steve', false);
  await host.p.waitForSelector('.knock button.primary').then(x => x.click());
  await steve.p.waitForSelector('#studio:not(.hidden)');
  const guest = await person('Visitor', false);
  await host.p.waitForSelector('.knock .green-btn').then(x => x.click());       // 🟢 Green room
  await guest.p.waitForSelector('#greenIn:not(.hidden)');
  await host.p.click('#consoleBtn');
  await host.p.waitForSelector('#conStrips .cstrip:nth-child(2)');
  await host.p.waitForSelector('#conStrips .cs-green');
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(await steve.p.evaluate(() => [...window.__studio.peers.values()].some(p => p.name === 'Visitor')), false, 'Steve can\'t see the green room');

  // soundboard: F1 plays the pad to everyone
  await host.p.waitForSelector('#pads .pad');
  await host.p.keyboard.press('F1');
  await waitFor(() => steve.p.evaluate(() => [...window.__studio.peers.values()].some(p => p.extraAudio && Object.values(p.extraAudio).some(a => a.srcObject && a.srcObject.getAudioTracks().some(t => t.readyState === 'live')))), 10000);

  const steveStrip = await host.p.evaluateHandle(() => [...document.querySelectorAll('#conStrips .cstrip')].find(el => el.querySelector('.cs-name span').textContent === 'Steve'));
  // gate: the live worklet is switched on, and the peak-hold number reads
  await (await steveStrip.asElement().$('.cs-gate')).click();
  await waitFor(() => host.p.evaluate(() => [...window.__studio.peers.values()].find(p => p.name === 'Steve').chan.gateOn === true), 3000);
  await waitFor(async () => /^pk -?\d/.test(await (await steveStrip.asElement().$('.cs-peak')).textContent()), 10000);
  // auto mix on: with only one person on air (the green room doesn't count) there's nothing to share
  await host.p.click('#autoMix');
  assert.match(await host.p.textContent('#autoMix'), /on/);
  await new Promise(r => setTimeout(r, 800));
  assert.equal(await host.p.evaluate(() => [...window.__studio.peers.values()].filter(p => p.autoDb).length), 0);
  // auto level: faders set from measured loudness
  await host.p.click('#autoLevel');
  await waitFor(async () => /Auto level/.test(await host.p.evaluate(() => document.body.innerText)), 5000);
  // scenes: store A, move the fader, recall A
  await host.p.$eval('#conStrips .cstrip:first-child .cs-fader', el => { el.value = '-6'; el.dispatchEvent(new Event('input')); });
  await host.p.click('#sceneStore'); await host.p.click('#scenes [data-s="A"]');
  await waitFor(() => { const r = JSON.parse(require('fs').readFileSync(path.join(srv.dataDir, 'rooms', room.id, 'room.json'), 'utf8')); return r.scenes && r.scenes.A; }, 5000);
  await host.p.waitForSelector('#scenes [data-s="A"].has');
  await host.p.$eval('#conStrips .cstrip:first-child .cs-fader', el => { el.value = '4'; el.dispatchEvent(new Event('input')); });
  await host.p.click('#scenes [data-s="A"]');
  assert.equal(await host.p.textContent('#conStrips .cstrip:first-child .cs-db'), '-6.0 dB');

  // ON AIR key starts the recording; a producer note lands in the list
  await host.p.click('#conRec'); await host.p.click('#modalAlt');
  await host.p.waitForSelector('#conRec.live');
  await host.p.fill('#noteText', 'Lovely story — trailer');
  await host.p.press('#noteText', 'Enter');
  await host.p.waitForSelector('#noteList div');
  // the script, shared with everyone, reaches Steve
  await host.p.click('#conScript'); await host.p.click('#prEdit');
  await host.p.fill('#prArea', 'INTRO\nWelcome to AOL Underground');
  await host.p.selectOption('#prShare', 'all'); await host.p.click('#prSave');
  await steve.p.waitForSelector('#scriptBtn:not(.hidden)');
  await steve.p.click('#scriptBtn');
  assert.match(await steve.p.textContent('#prText'), /Welcome to AOL Underground/);
  await steve.p.click('#prPlay'); await new Promise(r => setTimeout(r, 400)); await steve.p.click('#prPlay');
  assert.ok(await steve.p.$eval('#prText', el => el.scrollTop > 0), 'the teleprompter scrolls');
  await host.p.click('#prClose');
  // bring the visitor on air: now everyone meets
  await host.p.click('#conStrips .cs-onair');
  await guest.p.waitForSelector('#greenIn.hidden', { state: 'attached' });
  await waitFor(() => steve.p.evaluate(() => [...window.__studio.peers.values()].some(p => p.name === 'Visitor')), 10000);
  // …and auto mix now shares the gain between the two of them (the quieter one dips, never more than 12 dB)
  await waitFor(() => host.p.evaluate(() => { const c = [...window.__studio.peers.values()].filter(p => p.chan); return c.length === 2 && c.every(p => Number.isFinite(p.autoDb) && p.autoDb <= 0 && p.autoDb >= -12) && c.some(p => p.autoDb < -0.5); }), 10000);
  await host.p.click('#autoMix');
  assert.equal(await host.p.evaluate(() => [...window.__studio.peers.values()].filter(p => p.autoDb).length), 0, 'switching off puts everyone back');
  await host.p.click('#conRec'); await host.p.click('#modalYes');
  await host.p.waitForSelector('#conRec:not(.live)');
  assert.deepEqual([...host.errors, ...steve.errors, ...guest.errors], []);
  await host.b.close(); await steve.b.close(); await guest.b.close();
  require('fs').rmSync(wav, { force: true });
});

test('audio Console (control room): channels, keyboard faders, mute/solo, EQ, live master loudness', { skip }, async () => {
  const host = await person('Producer', true, { control: true });
  const a = await person('Steve', false), b = await person('Guest', false);
  for (let i = 0; i < 2; i++) await host.p.waitForSelector('.knock button.primary', { timeout: 8000 }).then(x => x.click()).catch(e => assert.ok(/Timeout/.test(e.message)));
  await a.p.waitForSelector('#studio:not(.hidden)'); await b.p.waitForSelector('#studio:not(.hidden)');
  await host.p.waitForSelector('#consoleBtn:not(.hidden)');
  await host.p.click('#consoleBtn');
  await host.p.waitForSelector('#conStrips .cstrip:nth-child(2)');
  // sound reaches the Console: everyone's call audio goes through it (the video players are muted) and the master meter reads it
  assert.ok(await host.p.evaluate(() => [...document.querySelectorAll('.tile:not(.me) video')].every(v => v.muted)));
  await waitFor(async () => /^-\d+\.\d$/.test(await host.p.textContent('#pmS')), 15000);
  await waitFor(async () => (await host.p.$$eval('#conStrips .cs-meter span', els => els.filter(e => parseFloat(e.style.height) < 90).length)) === 2, 10000);
  // keyboard: → picks the 2nd channel, ↑ ×3 = +3 dB, Shift+↓ = −0.25, X mutes, S solos, Q low cut, 0 back to 0 dB
  await host.p.click('#conStrips .cstrip:first-child .cs-name');
  await host.p.keyboard.press('ArrowRight');
  const second = '#conStrips .cstrip:nth-child(2)';
  assert.ok(await host.p.$eval(second, el => el.classList.contains('sel')));
  for (let i = 0; i < 3; i++) await host.p.keyboard.press('ArrowUp');
  await host.p.keyboard.press('Shift+ArrowDown');
  assert.equal(await host.p.textContent(`${second} .cs-db`), '+2.8 dB');
  await host.p.keyboard.press('x'); assert.equal(await host.p.textContent(`${second} .cs-db`), 'MUTED');
  assert.ok(await host.p.$eval(second, el => el.classList.contains('cut')));
  await host.p.keyboard.press('x');
  await host.p.keyboard.press('s'); assert.ok(await host.p.$eval(`${second} .cs-solo`, el => el.classList.contains('on')));
  await host.p.keyboard.press('s');
  await host.p.keyboard.press('q'); assert.ok(await host.p.$eval(`${second} .cs-hpf`, el => el.classList.contains('on')));
  await host.p.keyboard.press('0'); assert.equal(await host.p.textContent(`${second} .cs-db`), '0.0 dB');
  // the Web Audio channel really follows the controls
  const name = await host.p.$eval(`${second} .cs-name span`, el => el.textContent);
  await host.p.$eval(`${second} .cs-pres`, el => { el.value = '4'; el.dispatchEvent(new Event('input')); });
  await new Promise(r => setTimeout(r, 300));
  const n = await host.p.evaluate(nm => { const p = [...window.__studio.peers.values()].find(x => x.name === nm); return { hpf: p.chan.hpf.frequency.value, pres: p.chan.pres.gain.value, fader: p.chan.fader.gain.value }; }, name);
  assert.ok(Math.abs(n.hpf - 80) < 1 && Math.abs(n.pres - 4) < 0.1 && Math.abs(n.fader - 1) < 0.01, JSON.stringify(n));
  // remembered on the server by name, for next time
  await waitFor(async () => { const r = JSON.parse(require('fs').readFileSync(require('path').join(srv.dataDir, 'rooms', room.id, 'room.json'), 'utf8')); return r.channels && r.channels[name] && r.channels[name].pres === 4 && r.channels[name].hpf; }, 5000);
  // quick tags / cue cards / talkback moved into the Console; Esc goes back to the studio and puts them back
  assert.ok(await host.p.$('#conSide #cueForm'));
  await host.p.keyboard.press('Escape');
  await host.p.waitForSelector('#console.hidden', { state: 'attached' });
  assert.ok(await host.p.$('#tab-desk #cueForm'));
  assert.deepEqual([...host.errors, ...a.errors, ...b.errors], []);
  await host.b.close(); await a.b.close(); await b.b.close();
});
