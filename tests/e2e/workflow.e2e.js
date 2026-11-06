'use strict';
// Whole-workflow tests, the way people actually use Rolling — real browsers (fake camera + speech-like mic),
// a real server, real ffmpeg. Every file that comes out is opened and checked.
//   1. Basic user: dashboard → room → host + guest → room tone → record → marker → stop → Recordings → downloads
//   2. Advanced producer: control room, rundown segments, show clock, timecode vs markers, quick tags, desk,
//      cue cards, talkback, cough, a guest dropping out and rejoining, the server crashing mid-show,
//      then Clean again / Make transcript / free space / delete.
// Needs Playwright (skipped if missing):  npm run test:e2e
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { startServer, login, waitFor, tmpDir } = require('../helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed → skipped */ }
const skip = !chromium && 'Playwright not installed';

const browsers = [];
const servers = [];
let voices = {};
test.before(() => {
  if (skip) return;
  // speech-like test voices: bursts of filtered noise with gaps, a different rhythm for each person
  const dir = tmpDir('voices');
  const make = (name, period, on, level) => {
    const f = path.join(dir, name + '.wav');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
      `anoisesrc=c=pink:r=48000:a=${level}:d=60:seed=${period * 100 | 0},volume='if(lt(mod(t\\,${period})\\,${on})\\,1\\,0.03)':eval=frame,highpass=f=120,lowpass=f=4000`,
      '-ac', '1', '-c:a', 'pcm_s16le', f]);
    return f;
  };
  voices = { steve: make('steve', 2.6, 1.7, 0.25), guest: make('guest', 3.4, 2.1, 0.2), sam: make('sam', 3.0, 1.5, 0.22) };
});
// each test closes its own browsers and servers when it ends, so the next test has the whole machine
const logs = [];
test.afterEach(async () => {
  for (const sv of servers) logs.push(sv.logs());
  for (const b of browsers.splice(0)) await b.close().catch(() => {});
  for (const sv of servers.splice(0)) await sv.stop().catch(() => {});
});
test.after(() => { // keep the server logs for anyone looking into a failure
  fs.writeFileSync(path.join(require('os').tmpdir(), 'rolling-workflow-server.log'), logs.map((l, i) => `===== server ${i + 1} =====\n${l}`).join('\n'));
});

// ---------- helpers ----------
async function browser(voice, { mic = true } = {}) {
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', ...(voice ? [`--use-file-for-fake-audio-capture=${voice}`] : []), '--autoplay-policy=no-user-gesture-required'] });
  browsers.push(b);
  const ctx = await b.newContext({ viewport: { width: 1280, height: 760 }, permissions: mic ? ['camera', 'microphone'] : [], acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  return { b, ctx, p, errors };
}
async function joinStudio(who, url, name, { control = false } = {}) {
  await who.p.goto(url);
  await who.p.fill('#nameInput', name);
  if (control) await who.p.click('#controlBtn');
  else { await who.p.click('#enableBtn'); await who.p.waitForSelector('#joinBtn:not([disabled])'); await who.p.click('#joinBtn'); }
}
const tcText = (who, k = 'rec') => who.p.textContent(`#tcBar [data-tc="${k}"]`);
/** the synced record clock at the exact moment of the last click or key press (read inside the page) */
async function watchClock(who) {
  await who.p.evaluate(() => {
    const grab = () => { window.__tcAt = window.__studio.recClock() / 1000; };
    document.addEventListener('pointerdown', grab, true); document.addEventListener('keydown', grab, true);
  });
}
/** where a page's record clock is, compared with this computer's own clock (all test browsers share it) */
async function clockPos(who) {
  const [rec, now] = await who.p.evaluate(() => [window.__studio.recClock(), Date.now()]);
  return (rec - now) / 1000;
}
const tcAtAction = who => who.p.evaluate(() => window.__tcAt);
const tcSecs = s => { const [h, m, sec, f] = s.split(':').map(Number); return h * 3600 + m * 60 + sec + f / 25; };
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,sample_rate,r_frame_rate,width,height', '-of', 'json', file], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe can't read ${path.basename(file)}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
function decodes(file, cutEndOk = false) { // play the whole file through ffmpeg: any damage shows up as an error
  const r = spawnSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  // Chrome's own recorder sometimes repeats a timestamp when the computer is busy; that's the browser's untouched
  // original file (the MP4 made from it is clean) and isn't damage, so only real decoding errors count
  const errs = r.stderr.split('\n').filter(l => l.trim() && !/non monotonically increasing dts to muxer/.test(l) && !(cutEndOk && /File ended prematurely/.test(l)));
  return r.status === 0 && !errs.length ? '' : errs.join('\n').slice(0, 300) || `exit ${r.status}`;
}
async function apiTake(srv, room, pick = t => t) { const r = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json(); return pick(r.takes); }
/** download every file of a take over HTTP and check it really is what it says */
async function checkAllFiles(srv, room, take, dir, { fps = 25 } = {}) {
  const takeSecs = (take.stopped - take.started) / 1000;
  const problems = [];
  for (const o of take.outputs) {
    let res;
    try { res = await fetch(`${srv.url}/dl/${room.id}/${take.id}/${encodeURIComponent(o.file)}?k=${room.hostKey}`); }
    catch (e) { problems.push(`${o.file}: download failed (${(e.cause && (e.cause.code || e.cause.message)) || e.message}; server ${srv.proc.exitCode === null && !srv.proc.signalCode ? 'still running' : 'stopped: ' + (srv.proc.exitCode ?? srv.proc.signalCode)})`); continue; }
    if (res.status !== 200) { problems.push(`${o.file}: download ${res.status}`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length !== o.size || !buf.length) { problems.push(`${o.file}: ${buf.length} bytes, listed as ${o.size}`); continue; }
    const f = path.join(dir, o.file); fs.writeFileSync(f, buf);
    if (/\.(wav|mp4|webm)$/i.test(o.file)) {
      // a camera part that ended because the person dropped out stops where the browser was cut off — expected
      const base = n => n.replace(/ \(part \d+\)$/, ''), samePerson = take.outputs.filter(x => x.kind === o.kind && base(x.person) === base(o.person));
      const droppedOut = o.kind === 'video-original' && samePerson.length > 1 && samePerson[samePerson.length - 1] !== o;
      const bad = decodes(f, droppedOut); if (bad) { problems.push(`${o.file}: won't play — ${bad}`); continue; }
      const info = probe(f), dur = parseFloat(info.format.duration);
      const a = info.streams.find(s => s.codec_type === 'audio'), v = info.streams.find(s => s.codec_type === 'video');
      if (/\.wav$/i.test(o.file) && (!a || a.sample_rate !== '48000')) problems.push(`${o.file}: not 48 kHz audio`);
      if (['audio', 'cleaned', 'normalised', 'mix', 'producermix'].includes(o.kind) && Math.abs(dur - takeSecs) > 2.5) problems.push(`${o.file}: ${dur.toFixed(1)} s long, take was ${takeSecs.toFixed(1)} s`);
      if (o.kind === 'audio' && a.codec_name !== 'pcm_s24le') problems.push(`${o.file}: ${a.codec_name}, expected untouched 24-bit`);
      if (o.kind === 'video') {
        if (!v || v.r_frame_rate !== `${fps}/1`) problems.push(`${o.file}: frame rate ${v && v.r_frame_rate}, expected ${fps}`);
        // someone who dropped out has one video per part: each is lined up to the take, so it can't be longer than the take
        const parts = take.outputs.filter(x => x.kind === 'video' && x.person.replace(/ \(part \d+\)$/, '') === o.person.replace(/ \(part \d+\)$/, '')).length;
        if (parts === 1 ? Math.abs(dur - takeSecs) > 2.5 : dur > takeSecs + 2.5) problems.push(`${o.file}: ${dur.toFixed(1)} s long, take was ${takeSecs.toFixed(1)} s`);
      }
    } else if (/\.(txt|csv|srt|vtt|json|sesx|xml)$/i.test(o.file)) {
      const text = buf.toString('utf8');
      if (!text.trim()) problems.push(`${o.file}: empty`);
      if (/\.json$/.test(o.file)) { try { JSON.parse(text); } catch (e) { problems.push(`${o.file}: bad JSON`); } }
      if (/\.(sesx|xml)$/.test(o.file) && !/^<\?xml/.test(text)) problems.push(`${o.file}: not XML`);
      if (/undefined|NaN|\[object Object\]/.test(text)) problems.push(`${o.file}: contains "${text.match(/undefined|NaN|\[object Object\]/)[0]}"`);
    }
  }
  // the zip has every file
  const z = await fetch(`${srv.url}/zip/${room.id}/${take.id}?k=${room.hostKey}`);
  const zf = path.join(dir, 'all.zip'); fs.writeFileSync(zf, Buffer.from(await z.arrayBuffer()));
  const listed = spawnSync('unzip', ['-Z1', zf], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  if (listed.length !== take.outputs.length) problems.push(`zip has ${listed.length} files, take has ${take.outputs.length}`);
  return problems;
}
const serverProblems = srv => srv.logs().split('\n').filter(l => /^\[error\]/.test(l));

// =====================================================================================
test('basic user: make a room, record a take with a guest, download everything', { skip, timeout: 300000 }, async () => {
  const srv = await startServer(); servers.push(srv);
  const out = tmpDir('basic-files');

  // ---- dashboard: wrong password is refused, right one works, make a room ----
  const admin = await browser(null);
  await admin.p.goto(srv.url);
  await admin.p.fill('#pw', 'nope'); await admin.p.press('#pw', 'Enter');
  await waitFor(async () => /./.test(await admin.p.textContent('#loginErr')), 5000);
  await admin.p.fill('#pw', 'testpass'); await admin.p.press('#pw', 'Enter');
  await admin.p.waitForSelector('#newName');
  await admin.p.fill('#newName', 'AOL Underground'); await admin.p.press('#newName', 'Enter');
  await admin.p.waitForSelector('text=Open studio as host');
  const [hostUrl, guestUrl] = await admin.p.$$eval('.linkbox input', els => els.map(e => e.value));
  assert.match(hostUrl, /\/r\/\w+\?k=/); assert.match(guestUrl, /\/r\/\w+$/);
  const room = { id: guestUrl.split('/r/')[1], hostKey: hostUrl.split('k=')[1] };

  // ---- host + guest; guest waits until let in; chat works ----
  const host = await browser(voices.steve), guest = await browser(voices.guest);
  await joinStudio(host, hostUrl, 'Steve');
  await host.p.waitForSelector('#studio:not(.hidden)');
  await joinStudio(guest, guestUrl, 'Sam');
  await guest.p.waitForSelector('#message:not(.hidden)');
  await host.p.click('.knock button.primary');
  await guest.p.waitForSelector('#studio:not(.hidden)');
  await guest.p.click('#chatBtn'); await guest.p.fill('#chatInput', 'Can you hear me?'); await guest.p.press('#chatInput', 'Enter');
  await waitFor(async () => (await host.p.textContent('#chatLog')).includes('Can you hear me?'), 5000);
  assert.equal(await tcText(guest, 'tallytext'), 'STANDBY');

  // ---- record with room tone + episode name ----
  await host.p.click('#recBtn');
  await host.p.fill('#epNum', '12'); await host.p.fill('#epTitle', 'The Keyword Era');
  await host.p.click('#modalYes');
  await waitFor(async () => (await tcText(guest, 'tallytext')) === 'ROOM TONE', 5000);
  assert.ok(await guest.p.evaluate(() => document.body.classList.contains('tally-tone')));
  await waitFor(async () => (await tcText(guest, 'tallytext')) === 'REC', 15000);
  await guest.p.fill('#chatInput', 'Rolling now'); await guest.p.press('#chatInput', 'Enter');
  await new Promise(r => setTimeout(r, 8000));
  await watchClock(host);
  await host.p.keyboard.press('m');
  const tcAtMarker = await tcAtAction(host);
  await new Promise(r => setTimeout(r, 8000));
  // both clocks agree (synced to the server)
  const [a, b] = [await clockPos(host), await clockPos(guest)];
  assert.ok(Math.abs(a - b) < 0.15, `host and guest clocks ${(a - b).toFixed(3)} s apart`);
  await host.p.click('#recBtn'); await host.p.click('#modalYes');
  await waitFor(async () => (await tcText(guest, 'tallytext')) === 'STANDBY', 5000);

  // ---- both browsers finish uploading; the take is built ----
  await guest.p.waitForSelector('#tile-me .pill.ok', { timeout: 60000 });
  const take = await waitFor(async () => apiTake(srv, room, ts => ts[0] && ts[0].status === 'ready' && ts[0]), 180000);
  assert.equal(take.error, '', take.error);
  assert.deepEqual(take.people.sort(), ['Sam', 'Steve']);
  assert.deepEqual(take.episode, { n: '12', title: 'The Keyword Era' });
  // the marker sits where the clock said
  assert.ok(Math.abs(take.markers[0].at / 1000 - tcAtMarker) < 0.4, `marker at ${take.markers[0].at / 1000}, clock said ${tcAtMarker}`);
  const want = ['Steve.wav', 'Sam.wav', 'Steve - room tone.wav', 'Sam - room tone.wav', 'Steve - cleaned -16 LUFS.wav', 'Sam - cleaned -16 LUFS.wav',
    'Steve - normalised -16 LUFS.wav', 'Steve - normalised -23 LUFS.wav', 'Mix - all voices.wav', 'Producer mix -16 LUFS.wav', 'Steve - video.mp4', 'Sam - video.mp4',
    'Edit list.txt', 'Markers.txt', 'Chapters.json', 'Transcript.txt', 'Level report.txt', 'Chat.txt',
    'AOL Underground - Ep 12 - The Keyword Era (Audition).sesx', 'AOL Underground - Ep 12 - The Keyword Era (Premiere, Resolve, Audition).xml'];
  const files = take.outputs.map(o => o.file);
  for (const f of want) assert.ok(files.includes(f), `missing ${f} (have: ${files.join(', ')})`);

  // ---- every file downloads, opens and is the right length / format ----
  assert.deepEqual(await checkAllFiles(srv, room, take, out), []);

  // chat during the take is kept (with take times); chat from before it isn't
  const chat = fs.readFileSync(path.join(out, 'Chat.txt'), 'utf8');
  assert.match(chat, /^\[00:00:\d\d\] Sam: Rolling now/m); assert.doesNotMatch(chat, /Can you hear me/);

  // ---- the Recordings page shows it all with no errors ----
  const rec = await host.ctx.newPage(); const recErrors = []; rec.on('pageerror', e => recErrors.push(e.message));
  await rec.goto(`${srv.url}/m/${room.id}?k=${room.hostKey}`);
  await rec.waitForSelector('.take .pill.ok');
  assert.match(await rec.textContent('.take'), /Episode 12/);
  assert.match(await rec.textContent('.take'), /Transcript ready/);
  assert.equal(await rec.$$eval('.take table.files tr', r => r.length), take.outputs.length);
  const [dl] = await Promise.all([rec.waitForEvent('download'), rec.click('text=Download everything')]);
  assert.match(dl.suggestedFilename(), /AOL Underground - Ep 12 - The Keyword Era\.zip/);

  assert.deepEqual([...admin.errors, ...host.errors, ...guest.errors, ...recErrors], [], 'no errors in any page');
  assert.deepEqual(serverProblems(srv), [], 'no errors in the server log');
});

// =====================================================================================
test('advanced producer: rundown + clock, desk, dropout, server crash mid-show, post tools', { skip, timeout: 1200000 }, async () => {
  let srv = await startServer(); servers.push(srv);
  const out = tmpDir('adv-files');
  const { cookie } = await login(srv.url);
  const room = await (await fetch(srv.url + '/api/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'AOL Underground' }) })).json();
  const hostUrl = `${srv.url}/r/${room.id}?k=${room.hostKey}`, guestUrl = `${srv.url}/r/${room.id}`;

  // ---- producer in the control room; presenter + guest ----
  const prod = await browser(voices.sam), steve = await browser(voices.steve), guest = await browser(voices.guest);
  await joinStudio(prod, hostUrl, 'Sam', { control: true });
  await prod.p.waitForSelector('#studio:not(.hidden)');
  await joinStudio(steve, guestUrl, 'Steve');
  await prod.p.click('.knock button.primary');
  await joinStudio(guest, guestUrl, 'Guest');
  await prod.p.waitForSelector('.knock button.primary'); await prod.p.click('.knock button.primary');
  await steve.p.waitForSelector('#studio:not(.hidden)'); await guest.p.waitForSelector('#studio:not(.hidden)');

  // ---- rundown: three segments typed in the studio and saved ----
  await prod.p.click('.drawer-tabs [data-tab="rundown"]');
  for (const [name, mins] of [['Intro', '0.5'], ['Interview', '1'], ['Wrap up', '0.5']]) {
    await prod.p.click('#rdAdd');
    const rows = await prod.p.$$('#rundownList .rdrow');
    const last = rows[rows.length - 1];
    await (await last.$('input[type=text]')).fill(name);
    await (await last.$('input[type=number]')).fill(mins);
  }
  assert.match(await prod.p.textContent('#rdTotal'), /2 min planned/);
  await prod.p.click('#rdSave');
  await waitFor(async () => (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).rundown.length === 3, 5000);

  // ---- record (room tone first) ----
  await prod.p.click('#recBtn'); await prod.p.fill('#epNum', '13'); await prod.p.click('#modalYes');
  await waitFor(async () => (await tcText(steve, 'tallytext')) === 'REC', 20000);
  await waitFor(() => steve.p.evaluate(() => document.getElementById('tile-me').classList.contains('rec')), 10000);
  assert.equal(await prod.p.$('#tile-me'), null, 'the control room has no tile and is not recorded');

  // segment 1: Intro (30 s) — everyone's clock shows it, counting down, then "over"
  await watchClock(prod);
  const segTc = [];
  await prod.p.click('#rdNext'); segTc.push(await tcAtAction(prod));
  await waitFor(async () => (await tcText(steve, 'segname')) === 'INTRO', 5000)
    .catch(async () => { throw new Error(`after Next: producer sees "${await prod.p.textContent('#tcBar')}" / toasts "${await prod.p.evaluate(() => [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '))}" / rundown ${await prod.p.evaluate(() => document.querySelectorAll('#rundownList .rdrow').length)} rows; Steve sees "${await steve.p.textContent('#tcBar')}"`); });
  await waitFor(async () => /^0:[0-3]\d left$/.test(await tcText(guest, 'left')), 5000) // counting down on the guest's screen too
    .catch(async e => { throw new Error(`guest's clock shows "${await guest.p.textContent('#tcBar')}"`); });
  await new Promise(r => setTimeout(r, 2000));
  await prod.p.keyboard.press('1'); const tagTc = await tcAtAction(prod);  // quick tag: Great bit
  await waitFor(() => guest.p.evaluate(() => document.querySelector('#tcBar [data-tc="segblock"]').classList.contains('over')), 45000);
  assert.match(await tcText(guest, 'left'), /^\+0:0\d over$/);

  // segment 2: Interview — the segment clock starts again from zero
  await prod.p.click('#rdNext'); segTc.push(await tcAtAction(prod));
  await waitFor(async () => (await tcText(guest, 'segname')) === 'INTERVIEW', 5000);
  const segNow = tcSecs(await tcText(guest, 'seg')), recNow = tcSecs(await tcText(guest));
  assert.ok(segNow < 4 && segNow < recNow - 20, `segment timecode restarts (segment ${segNow} s, record ${recNow} s)`);
  assert.ok(!(await guest.p.evaluate(() => document.querySelector('#tcBar [data-tc="segblock"]').classList.contains('over'))));

  // the audio Console during the interview: keyboard fader ride, EQ, cue card, talkback, cough
  await prod.p.click('#consoleBtn');
  await prod.p.waitForSelector('#conStrips .cstrip:nth-child(2)');
  await prod.p.click('#conStrips .cstrip:first-child .cs-name');
  for (let i = 0; i < 6; i++) await prod.p.keyboard.press('ArrowDown');            // Steve's fader −6 dB
  assert.equal(await prod.p.textContent('#conStrips .cstrip:first-child .cs-db'), '-6.0 dB');
  await prod.p.keyboard.press('q');                                                 // low cut on
  await prod.p.selectOption('#cueTo', { label: 'Steve' });
  await prod.p.click('#cuePresets button:has-text("2 minutes")');
  await steve.p.waitForSelector('#cue:not(.hidden)');
  assert.equal(await guest.p.$eval('#cue', e => e.classList.contains('hidden')), true, 'the cue only went to Steve');
  await prod.p.selectOption('#talkTo', { label: 'Guest' });
  await prod.p.hover('#talkBtn'); await prod.p.mouse.down();
  await guest.p.waitForSelector('#talkIn:not(.hidden)');
  await new Promise(r => setTimeout(r, 800)); await prod.p.mouse.up();
  await steve.p.keyboard.down('c'); await new Promise(r => setTimeout(r, 1500)); await steve.p.keyboard.up('c');
  await prod.p.keyboard.press('2'); const cutTc = await tcAtAction(prod);   // quick tag: Cut this
  await prod.p.keyboard.press('Escape');                                           // back to the studio
  await prod.p.waitForSelector('#console.hidden', { state: 'attached' });

  // ---- the guest's laptop drops out (page reloads) and they come back: recording carries on as "part 2" ----
  await guest.p.reload();
  await joinStudio(guest, guestUrl, 'Guest');
  await guest.p.waitForSelector('#studio:not(.hidden)');
  await waitFor(async () => (await tcText(guest, 'tallytext')) === 'REC', 10000);

  // ---- the server crashes (like pulling the power) and comes back 4 s later ----
  const { port, dataDir } = srv;
  await srv.crash();
  await new Promise(r => setTimeout(r, 4000));
  srv = await startServer({ PORT: String(port), DATA_DIR: dataDir }); servers.push(srv);
  // everyone reconnects by themselves; the take, the clock and the segment carry on
  await waitFor(async () => (await prod.p.textContent('#uploadLine')) === '' && (await tcText(steve, 'tallytext')) === 'REC', 20000);
  await waitFor(async () => (await tcText(steve, 'segname')) === 'INTERVIEW', 10000);
  const [c1, c2] = [await clockPos(steve), await clockPos(prod)];
  assert.ok(Math.abs(c1 - c2) < 0.15, `clocks still agree after the restart (${(c1 - c2).toFixed(3)} s apart)`);

  // segment 3, then "Next" at the end says so, then stop the clock
  await new Promise(r => setTimeout(r, 3000));
  await prod.p.click('.drawer-tabs [data-tab="rundown"]'); await prod.p.click('#rdNext'); segTc.push(await tcAtAction(prod));
  await waitFor(async () => (await tcText(steve, 'segname')) === 'WRAP UP', 5000);
  await prod.p.click('#rdNext');
  await waitFor(async () => /last segment/.test(await prod.p.textContent('body')), 3000);
  await new Promise(r => setTimeout(r, 4000));
  await prod.p.click('#rdStop');
  await waitFor(async () => (await tcText(steve, 'segname')) === 'SEGMENT', 5000);

  // ---- stop; everyone's uploads finish; the take builds ----
  await prod.p.click('#recBtn'); await prod.p.click('#modalYes');
  const take = await waitFor(async () => apiTake(srv, room, ts => ts[0] && ts[0].status === 'ready' && ts[0]), 480000)
    .catch(async () => { // say exactly where it got to
      const t = await apiTake(srv, room, ts => ts[0]);
      const raw = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'rooms', room.id, 'takes', t.id, 'take.json'), 'utf8'));
      throw new Error(`take not ready: status=${t.status} step="${t.progress}" ${t.pct}% · parts: ${Object.values(raw.segs).map(g => `${g.name} done=${g.done} audio=${g.audio ? g.audio.end : 0}`).join(', ')}`);
    });
  assert.equal(take.error, '', take.error);
  assert.deepEqual([...new Set(take.people)].sort(), ['Guest', 'Steve'], 'the control room is not in the recording');

  // the Console's fader ride and low cut for Steve went into the take
  const raw = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'rooms', room.id, 'takes', take.id, 'take.json'), 'utf8'));
  assert.ok(Object.values(raw.rides).flat().some(r => r.db === -6), 'fader ride saved');
  assert.ok(Object.values(raw.channels).some(c => c.hpf && c.db === -6), 'Console settings saved');
  // markers: tags and segments are where the clock said
  const m = take.markers;
  const segs = m.filter(x => x.tag === 'segment');
  assert.deepEqual(segs.map(x => x.label), ['Intro', 'Interview', 'Wrap up']);
  segs.forEach((x, i) => assert.ok(Math.abs(x.at / 1000 - segTc[i]) < 0.4, `${x.label} marker at ${x.at / 1000}, clock said ${segTc[i]}`));
  for (const [tag, at] of [['great', tagTc], ['cut', cutTc]]) { const x = m.find(y => y.tag === tag); assert.ok(Math.abs(x.at / 1000 - at) < 0.4, `${x.label} at ${x.at / 1000}, clock said ${at}`); }

  // every file is real and right (25 fps video, lengths, formats); the guest's two parts both exist
  const files = take.outputs.map(o => o.file);
  for (const f of ['Steve.wav', 'Guest.wav', 'Producer mix -16 LUFS.wav', 'Edit list.txt', 'Chapters.json', 'Markers (Audition).csv']) assert.ok(files.includes(f), `missing ${f}`);
  assert.ok(files.filter(f => /^Guest.*video\.mp4$/.test(f)).length >= 2, `guest's camera before and after the dropout: ${files.filter(f => /^Guest/.test(f)).join(', ')}`);
  assert.deepEqual(await checkAllFiles(srv, room, take, out), []);

  // the documents agree with each other and with the clock
  const edl = fs.readFileSync(path.join(out, 'Edit list.txt'), 'utf8');
  for (const want of [/SEGMENT \(3\)/, /GREAT BIT \(1\)/, /CUT THIS \(1\)/, /Cough — Steve/]) assert.match(edl, want);
  assert.doesNotMatch(edl, /Talkback/, 'talkback from the control room is never on a recording, so there is nothing to mark');
  const ch = JSON.parse(fs.readFileSync(path.join(out, 'Chapters.json'), 'utf8')).chapters;
  assert.deepEqual(ch.map(c => c.title), ['Start', 'Intro', 'Interview', 'Wrap up'], 'chapters = segments (edit notes left out)');
  ch.slice(1).forEach((c, i) => assert.ok(Math.abs(c.startTime - segTc[i]) < 0.4));
  const xml = fs.readFileSync(path.join(out, files.find(f => f.endsWith('.xml'))), 'utf8');
  assert.match(xml, /<timebase>25<\/timebase>/);

  // ---- post tools: Clean again, Make transcript, free space, delete — every one finishes cleanly ----
  const ready = () => waitFor(async () => apiTake(srv, room, ts => ts[0].status === 'ready' && ts[0]), 120000);
  for (const action of ['clean', 'transcribe']) {
    const r = await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/${action}?k=${room.hostKey}`, { method: 'POST' });
    assert.equal(r.status, 200, `${action}: ${await r.text()}`);
    await waitFor(async () => apiTake(srv, room, ts => ts[0].status !== 'ready'), 5000, 20).catch(() => {});
    const t2 = await ready(); assert.equal(t2.error, '', `${action}: ${t2.error}`);
  }
  for (const what of ['camera-originals', 'rebuild-data']) {
    const r = await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/compact?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what }) });
    assert.equal(r.status, 200, what);
  }
  const after = await ready();
  assert.deepEqual(await checkAllFiles(srv, room, after, tmpDir('adv-after')), [], 'everything still downloads after freeing space');
  assert.equal((await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}?k=${room.hostKey}`, { method: 'DELETE' })).status, 200);
  assert.equal((await apiTake(srv, room)).length, 0);

  assert.deepEqual([...prod.errors, ...steve.errors, ...guest.errors], [], 'no errors in any page');
  assert.deepEqual(servers.flatMap(serverProblems), [], 'no errors in the server log');
});
