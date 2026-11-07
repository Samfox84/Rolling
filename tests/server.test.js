'use strict';
// End-to-end through the real server: a host joins over WebSocket, records a take while uploading lossless
// audio exactly like the browser does, then the server builds every file. Plus the things that must fail safely.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, login, waitFor, pcm24, talky, ffMeasure, duration, xmlWellFormed } = require('./helpers');

const hasWS = typeof WebSocket === 'function'; // Node 22+
let srv, cookie, room;

test.before(async () => {
  srv = await startServer();
  cookie = (await login(srv.url)).cookie;
  room = await (await fetch(srv.url + '/api/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test Show' }) })).json();
  await fetch(`${srv.url}/api/rooms/${room.id}/settings?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ waitingRoom: false, rundown: [{ name: 'Interview', mins: 25 }, { name: '', mins: 'x' }] }) });
});
test.after(async () => { if (srv) await srv.stop(); });

/** connect like a browser and collect messages */
function client(name, key, r = room) {
  const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws');
  const msgs = [];
  ws.onmessage = e => msgs.push(JSON.parse(e.data));
  const opened = new Promise(r => { ws.onopen = r; });
  return {
    ws, msgs,
    async knock(clientId) { await opened; ws.send(JSON.stringify({ t: 'join', room: r.id, key, name, clientId: clientId || 'C' + name.replace(/\W/g, '') + 'xxxx', camId: 'cam-' + name })); },
    async join() { await this.knock(); return waitFor(() => msgs.find(m => m.t === 'welcome'), 10000, 50); },
    send(m) { ws.send(JSON.stringify(m)); },
    next(t, after = 0) { return waitFor(() => msgs.slice(after).find(m => m.t === t), 20000, 50); },
  };
}

test('wrong admin password is refused', async () => {
  assert.equal((await login(srv.url, 'nope')).status, 401);
});
test('a room page with the wrong host key is refused', async () => {
  assert.equal((await fetch(`${srv.url}/api/rooms/${room.id}?k=wrong`)).status, 403);
});
test('pages are never cached by Cloudflare or the browser', async () => {
  const r = await fetch(srv.url + '/api/info');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.match(r.headers.get('cloudflare-cdn-cache-control'), /no-store/);
});

test('full take: record, upload lossless audio, build every file', { skip: !hasWS && 'needs Node 22+ (built-in WebSocket)' }, async () => {
  const host = client('Steve', room.hostKey);
  const guest = client('Guest', '');
  assert.equal((await host.join()).isHost, true);
  assert.equal((await guest.join()).isHost, false);

  // a guest can't start recording — only the host
  guest.send({ t: 'record', on: true });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(guest.msgs.filter(m => m.t === 'record-start').length, 0);

  host.send({ t: 'record', on: true, roomTone: true, episode: { n: '7', title: 'Testing' } });
  const start = await host.next('record-start');
  const gstart = await guest.next('record-start');
  assert.ok(start.tok && start.seg && gstart.seg !== start.seg);

  // ---- producer desk ----
  const guestId = host.msgs.find(m => m.t === 'peer-joined' && m.peer.name === 'Guest').peer.id;
  const hostId = host.msgs.find(m => m.t === 'welcome').id;
  host.send({ t: 'ride', id: hostId, db: null });            // Steve's fader right down: the Producer mix should be the guest only
  host.send({ t: 'ride', id: guestId, db: 99 });             // out of range: ignored
  host.send({ t: 'chan', id: guestId, s: { pan: -1, hpf: true, pres: 3, db: 0 } }); // Console: guest hard left, low cut, presence
  guest.send({ t: 'chan', id: guestId, s: { pan: 1 } });     // guests can't touch the Console
  guest.send({ t: 'ride', id: guestId, db: -10 });           // guests can't ride faders
  host.send({ t: 'segment', idx: 0 });                       // rundown clock (everyone sees it) + a chapter marker
  assert.equal((await guest.next('segment')).segment.name, 'Interview');
  host.send({ t: 'marker', tag: 'great' });
  assert.equal((await host.next('marker', host.msgs.findIndex(m => m.t === 'marker' && m.tag === 'segment') + 1)).label, 'Great bit 1');
  host.send({ t: 'cue', to: guestId, text: 'Wrap up' });     // cue card to one person
  assert.equal((await guest.next('cue')).text, 'Wrap up');
  guest.send({ t: 'cue', to: 'all', text: 'not allowed' });
  host.send({ t: 'talk', to: guestId, on: true });           // talkback
  assert.equal((await guest.next('talk')).on, true);
  guest.send({ t: 'cough', on: true });                      // cough button: everyone is told
  assert.equal((await host.next('cough')).on, true);
  await new Promise(r => setTimeout(r, 300));
  guest.send({ t: 'cough', on: false });
  host.send({ t: 'talk', to: guestId, on: false });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(host.msgs.filter(m => m.t === 'cue').length, 0, 'guests can\'t send cue cards');

  // upload 40 s of audio in half-second pieces, out of order, exactly as browsers send it (24-bit PCM)
  const up = async (who, s, shape) => {
    const pcm = pcm24(40, shape), piece = 24000 * 3;
    const order = [];
    for (let off = 0; off < pcm.length; off += piece) order.push(off);
    order.reverse();
    for (const off of order) {
      const sample = off / 3, t = s.started + 50 + (sample / 48000) * 1000;
      const r = await fetch(`${srv.url}/up/${room.id}/${s.take}/${s.seg}/audio?tok=${s.tok}&s=${sample}&t=${t.toFixed(1)}&rate=48000`, { method: 'POST', body: pcm.subarray(off, off + piece) });
      assert.equal(r.status, 200);
    }
  };
  await up('Steve', start, talky(1));
  await up('Guest', gstart, talky(2, x => x < 10));
  // markers are stamped with the moment the button was pressed (synced clock), not when the message arrived;
  // a silly time (clock wildly off) falls back to the arrival time
  host.send({ t: 'marker', tag: 'ad', at: Date.now() - 1500 });
  host.send({ t: 'marker', tag: 'retake', at: Date.now() - 3600e3 });
  const adMk = await waitFor(() => host.msgs.find(m => m.t === 'marker' && m.tag === 'ad'), 5000, 20);
  const rtMk = await waitFor(() => host.msgs.find(m => m.t === 'marker' && m.tag === 'retake'), 5000, 20);
  assert.ok(rtMk.at - adMk.at > 1200 && rtMk.at - adMk.at < 2500, `pressed-at time used: ${rtMk.at - adMk.at} ms apart`);
  host.send({ t: 'marker' });
  const mk = await waitFor(() => host.msgs.find(m => m.t === 'marker' && !m.tag), 10000, 50);
  assert.equal(mk.label, 'Marker 1');
  // a producer note: a longer label, timed from when they started typing
  const note = 'Great story about the AOL disks — use it as the trailer, and ask for a photo of the box for the show notes';
  host.send({ t: 'marker', tag: 'note', label: note, at: Date.now() - 2000 });
  assert.equal((await waitFor(() => host.msgs.find(m => m.t === 'marker' && m.tag === 'note'), 5000, 20)).label, note);

  // things that must be refused
  assert.equal((await fetch(`${srv.url}/up/${room.id}/${start.take}/${start.seg}/audio?tok=bad&s=0&t=1`, { method: 'POST', body: Buffer.alloc(3) })).status, 403);
  assert.equal((await fetch(`${srv.url}/up/${room.id}/${start.take}/${start.seg}/audio?tok=${start.tok}&s=0&t=1`, { method: 'POST', body: Buffer.alloc(4) })).status, 400);

  for (const s of [start, gstart]) assert.equal((await fetch(`${srv.url}/up/${room.id}/${s.take}/${s.seg}/done?tok=${s.tok}`, { method: 'POST' })).status, 200);
  // while recording, the host is told how far the live transcript has got
  const tx = await waitFor(() => host.msgs.find(m => m.t === 'tx'), 10000, 50);
  assert.equal(tx.engine, true); assert.equal(tx.on, true); assert.ok(tx.pct >= 0 && tx.pct <= 100);
  // the Console's live transcript: the latest lines, with who said them
  const txLines = await waitFor(() => host.msgs.find(m => m.t === 'tx' && m.recent && m.recent.length), 20000, 50);
  assert.ok(txLines.recent.every(l => ['Steve', 'Guest'].includes(l.who) && typeof l.text === 'string' && Number.isFinite(l.at)));
  assert.ok(txLines.recent.length <= 8);
  assert.equal(guest.msgs.filter(m => m.t === 'tx').length, 0, 'only hosts get transcript progress');
  const before = host.msgs.length;
  host.send({ t: 'record', on: false });
  await host.next('record-stop', before);

  // the host sees build progress, then "ready"
  const ready = await waitFor(() => host.msgs.find(m => m.t === 'build' && m.status === 'ready'), 180000, 200);
  assert.equal(ready.pct, 100);
  assert.ok(host.msgs.some(m => m.t === 'build' && m.status === 'processing' && m.pct > 0 && m.pct < 100), 'progress was reported along the way');

  const info = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json();
  const take = info.takes[0];
  assert.equal(take.status, 'ready', take.error);
  assert.equal(take.error, '');
  assert.deepEqual(take.episode, { n: '7', title: 'Testing' });
  const out = path.join(srv.dataDir, 'rooms', room.id, 'takes', take.id, 'out');
  const files = take.outputs.map(o => o.file);
  for (const f of ['Steve.wav', 'Guest.wav', 'Steve - room tone.wav', 'Steve - normalised -16 LUFS.wav', 'Steve - normalised -23 LUFS.wav',
    'Mix - all voices.wav', 'Steve - cleaned -16 LUFS.wav', 'Guest - cleaned -16 LUFS.wav', 'Producer mix -16 LUFS.wav', 'Edit list.txt', 'Transcript.txt', 'Transcript.srt', 'Transcript.vtt', 'Level report.txt', 'Markers.txt', 'Chapters.json',
    'Test Show - Ep 7 - Testing (Audition).sesx', 'Test Show - Ep 7 - Testing (Premiere, Resolve, Audition).xml']) assert.ok(files.includes(f), `missing ${f}`);

  // "Download everything": one zip with every file, readable by an ordinary unzip program
  const zipRes = await fetch(`${srv.url}/zip/${room.id}/${take.id}?k=${room.hostKey}`);
  assert.equal(zipRes.status, 200);
  const zipFile = path.join(srv.dataDir, 'everything.zip');
  fs.writeFileSync(zipFile, Buffer.from(await zipRes.arrayBuffer()));
  const listing = require('child_process').execFileSync('unzip', ['-l', zipFile]).toString();
  for (const f of files) assert.ok(listing.includes(f), `${f} missing from the zip`);
  assert.equal((await fetch(`${srv.url}/zip/${room.id}/${take.id}?k=wrong`)).status, 403);

  // lossless audio, lined up: 40 s of audio that started 50 ms into the take
  assert.ok(Math.abs(duration(path.join(out, 'Steve.wav')) - 40.05) < 0.03);
  // normalised copies really hit their targets (measured by ffmpeg, not by our own code)
  assert.ok(Math.abs(ffMeasure(path.join(out, 'Steve - normalised -16 LUFS.wav')).I - -16) < 0.5);
  assert.ok(Math.abs(ffMeasure(path.join(out, 'Steve - normalised -23 LUFS.wav')).I - -23) < 0.5);
  // cleaned copies are their own files at -16 LUFS; the untouched recordings are still exactly as recorded
  assert.ok(Math.abs(ffMeasure(path.join(out, 'Steve - cleaned -16 LUFS.wav')).I - -16) < 0.7);
  // the Producer mix follows the desk: Steve's fader was down, and the guest doesn't talk for the first 10 s
  const pm = path.join(out, 'Producer mix -16 LUFS.wav');
  const quietStart = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-ss', '1', '-t', '7', '-i', pm, '-af', 'astats=measure_perchannel=none', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/RMS level dB:\s*(-?[\d.]+|-inf)/)[1];
  assert.ok(quietStart === '-inf' || parseFloat(quietStart) < -60, `Steve should be faded out of the Producer mix: ${quietStart}`);
  assert.ok(Math.abs(ffMeasure(pm).I - -16) < 1);
  // the Console's settings are baked in: the Producer mix is stereo and the guest (panned hard left) is only on the left
  const chans = [...spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-ss', '15', '-t', '20', '-i', pm, '-af', 'astats', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
    .matchAll(/Channel: \d[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/g)].map(x => (x[1] === '-inf' ? -200 : parseFloat(x[1])));
  assert.equal(chans.length, 2, 'stereo');
  assert.ok(chans[0] > -40 && chans[1] < chans[0] - 40, `guest panned left: L ${chans[0]} R ${chans[1]}`);
  // and remembered for next time, by name
  const savedRoom = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'rooms', room.id, 'room.json'), 'utf8'));
  assert.deepEqual(savedRoom.channels.Guest, { db: 0, mute: false, pan: -1, hpf: true, low: 0, pres: 3, high: 0, comp: false, gate: false });
  // edit list: tags, segment, the guest's cough, the host's talkback
  const edl = fs.readFileSync(path.join(out, 'Edit list.txt'), 'utf8');
  for (const want of [/Great bit 1/, /Interview/, /Cough — Guest/, /Talkback — Steve/]) assert.match(edl, want);
  // producer notes and filler words ("um", "uh" — kept by the transcript engine's prompt) are in the edit list…
  assert.match(edl, /PRODUCER NOTE \(1\)\s+[\d:.]+\s+Great story about the AOL disks/);
  assert.match(edl, /FILLER WORDS \(\d+\)\s+[\d:.]+\s+to [\d:.]+\s+um, uh — (Steve|Guest)/);
  // …but neither becomes a chapter
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'Chapters.json'), 'utf8')).chapters.some(c => /AOL disks|um,/.test(c.title)), false);
  assert.match(fs.readFileSync(path.join(out, 'Markers (Audition).csv'), 'utf8'), /Cough — Guest\t[\d:.]+\t0:00\.[2-9]/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'Chapters.json'), 'utf8')).chapters.some(c => /Great bit/.test(c.title)), false, 'edit notes are not chapters');
  // the level verdict travels with the levels (one rule, used by report and page)
  assert.ok(take.levels.Steve.verdict && take.levels.Steve.verdict.text);
  // room tone is the right length
  assert.ok(Math.abs(duration(path.join(out, 'Steve - room tone.wav')) - 3) < 0.05);
  // transcript: speaker names, nothing from the guest's silent first 10 s, no hallucinations
  const txt = fs.readFileSync(path.join(out, 'Transcript.txt'), 'utf8');
  assert.match(txt, /Steve: Sentence at 0 seconds\./);
  assert.match(txt, /Guest: /);
  assert.doesNotMatch(txt, /Thank you/);
  // the Recordings page is told the transcript is there, and how big it is
  assert.equal(take.transcript.hasFile, true); assert.equal(take.transcript.pct, 100); assert.ok(take.transcript.lines > 5); assert.deepEqual(take.transcript.failed, []);
  assert.equal(take.transcript.canMake, true);
  // session files are valid XML and reference the people
  const sesx = fs.readFileSync(path.join(out, 'Test Show - Ep 7 - Testing (Audition).sesx'), 'utf8');
  assert.ok(xmlWellFormed(sesx)); assert.match(sesx, /relativePath="Steve.wav"/);
  // every edit point is in the session for the editor: markers, notes, and ranges (coughs, filler words) with a length
  assert.match(sesx, /name="Producer note: Great story about the AOL disks/);
  assert.match(sesx, /<marker duration="[1-9]\d*" id="\d+" name="Filler words: um, uh — /);
  assert.match(sesx, /<marker duration="[1-9]\d*" id="\d+" name="Cough — Guest"/);
  assert.ok(xmlWellFormed(fs.readFileSync(path.join(out, 'Test Show - Ep 7 - Testing (Premiere, Resolve, Audition).xml'), 'utf8')));
  // downloads are named after the episode
  const dl = await fetch(`${srv.url}/dl/${room.id}/${take.id}/Steve.wav?k=${room.hostKey}`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /Test Show - Ep 7 - Testing - Steve\.wav/);
  const zip = await fetch(`${srv.url}/zip/${room.id}/${take.id}?k=${room.hostKey}`);
  assert.equal(zip.status, 200); assert.ok((await zip.arrayBuffer()).byteLength > 1000000);

  // renaming a marker updates the documents only (the audio is not rebuilt)
  let wavTime = fs.statSync(path.join(out, 'Steve.wav')).mtimeMs;
  const r = await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/markers?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markers: [{ at: take.markers[0].at, label: 'The big question' }] }) });
  assert.equal(r.status, 200);
  // the chapters file must exist at every moment while it is being updated
  await waitFor(() => /The big question/.test(fs.readFileSync(path.join(out, 'Chapters.json'), 'utf8')), 30000, 20);
  assert.equal(fs.statSync(path.join(out, 'Steve.wav')).mtimeMs, wavTime);

  // a full rebuild (e.g. late pieces arriving) never makes files vanish: the old ones stay downloadable until the new ones are swapped in
  await waitFor(async () => (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0].status === 'ready', 30000);
  const size = fs.statSync(path.join(out, 'Steve.wav')).size;
  const slow = await fetch(`${srv.url}/dl/${room.id}/${take.id}/Steve.wav?k=${room.hostKey}`);   // a download already running…
  await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/rebuild?k=${room.hostKey}`, { method: 'POST' });
  await waitFor(async () => (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0].status === 'processing', 10000, 20);
  const during = await fetch(`${srv.url}/dl/${room.id}/${take.id}/Steve.wav?k=${room.hostKey}`);  // …and one started mid-rebuild
  assert.equal(during.status, 200, 'still downloadable while rebuilding');
  assert.equal((await during.arrayBuffer()).byteLength, size);
  assert.equal((await slow.arrayBuffer()).byteLength, size, 'a running download finishes');
  const rebuilt = await waitFor(async () => { const x = (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0]; return x.status === 'ready' && x; }, 120000);
  assert.equal(rebuilt.error, ''); assert.ok(fs.existsSync(path.join(out, 'Steve.wav'))); assert.equal(fs.existsSync(out + '.new'), false);
  wavTime = fs.statSync(path.join(out, 'Steve.wav')).mtimeMs; // a full rebuild remakes the WAVs; from here on they must not change

  // "Clean again" with new settings: cleaning switched off → no cleaned files, the Producer mix is still made
  await waitFor(async () => (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0].status === 'ready', 30000);
  assert.equal((await fetch(`${srv.url}/api/settings`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ clean: { auto: false } }) })).status, 200);
  assert.equal((await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/clean?k=${room.hostKey}`, { method: 'POST' })).status, 200);
  const recleaned = await waitFor(async () => { const x = (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0]; return x.status === 'ready' && !x.outputs.some(o => o.kind === 'cleaned') && x; }, 60000);
  assert.ok(recleaned.outputs.some(o => o.file === 'Producer mix -16 LUFS.wav'));
  assert.equal(fs.existsSync(path.join(out, 'Steve - cleaned -16 LUFS.wav')), false, 'old cleaned files removed');
  assert.equal(fs.statSync(path.join(out, 'Steve.wav')).mtimeMs, wavTime, 'cleaning never touches the untouched recordings');
  await fetch(`${srv.url}/api/settings`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ clean: { auto: true } }) });

  // "Make transcript" with a broken engine: the take says so plainly, and the good transcript is kept
  const ready2 = async () => waitFor(async () => { const x = (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0]; return x.status === 'ready' && x; }, 60000);
  await ready2();
  fs.writeFileSync(path.join(srv.dataDir, 'whisper-fail'), '');
  assert.equal((await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/transcribe?k=${room.hostKey}`, { method: 'POST' })).status, 200);
  await waitFor(async () => (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0].status !== 'ready', 5000, 20).catch(() => {});
  const broken = await ready2();
  assert.match(broken.error, /Transcript (partly )?failed — .*failed to load model/);
  assert.equal(broken.transcript.failed.length, 2);
  assert.equal(broken.transcript.hasFile, true, 'previous transcript kept');
  assert.match(fs.readFileSync(path.join(out, 'Transcript.txt'), 'utf8'), /Steve: Sentence at 0 seconds\./);
  // engine fixed → make it again: error gone, transcript rebuilt from scratch
  fs.rmSync(path.join(srv.dataDir, 'whisper-fail'));
  await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/transcribe?k=${room.hostKey}`, { method: 'POST' });
  await waitFor(async () => { const x = (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0]; return x.status === 'ready' && !x.error && x; }, 60000);
  assert.equal(fs.statSync(path.join(out, 'Steve.wav')).mtimeMs, wavTime, 'making a transcript does not rebuild the audio');
  // only the host may ask
  assert.equal((await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/transcribe?k=wrong`, { method: 'POST' })).status, 403);

  // freeing space removes the raw data; a later rebuild only refreshes documents and keeps every file
  await waitFor(async () => (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0].status === 'ready', 30000);
  const c = await (await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/compact?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ what: 'rebuild-data' }) })).json();
  assert.ok(c.freed > 1000000);
  assert.equal(fs.existsSync(path.join(srv.dataDir, 'rooms', room.id, 'takes', take.id, 'segs', start.seg, 'audio.pcm')), false);
  await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/rebuild?k=${room.hostKey}`, { method: 'POST' });
  await waitFor(async () => (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0].status === 'ready', 30000);
  assert.ok(fs.existsSync(path.join(out, 'Steve.wav')), 'finished audio survives');
  // once the raw audio is gone a transcript can't be made, and the page is told why
  const gone = await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/transcribe?k=${room.hostKey}`, { method: 'POST' });
  assert.equal(gone.status, 409); assert.match((await gone.json()).error, /deleted to save space/);

  host.ws.close(); guest.ws.close();
});

test('green room, remote guest help, scenes and the shared script', { skip: !hasWS && 'needs Node 22+ (built-in WebSocket)' }, async () => {
  const r2 = await (await fetch(srv.url + '/api/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Green Room Show' }) })).json();
  const host = client('Sam', r2.hostKey, r2), steve = client('Steve', '', r2), guest = client('Visitor', '', r2);
  await host.join();
  // Steve is let in normally
  await steve.knock('CSteve2xxxx');
  let knock = await host.next('knock');
  host.send({ t: 'admit', id: knock.id, allow: true });
  const sw = await steve.next('welcome');
  assert.equal(sw.green, false);
  // the visitor goes to the green room: they see only the host, Steve doesn't see them at all
  await guest.knock();
  knock = await host.next('knock', host.msgs.indexOf(knock) + 1);
  host.send({ t: 'admit', id: knock.id, allow: true, green: true });
  const gw = await guest.next('welcome');
  assert.equal(gw.green, true);
  assert.deepEqual(gw.peers.map(p => p.name), ['Sam'], 'the green room only sees the hosts');
  const joinedForHost = await waitFor(() => host.msgs.find(m => m.t === 'peer-joined' && m.peer.name === 'Visitor'), 5000, 20);
  assert.equal(joinedForHost.peer.green, true);
  const visitorId = joinedForHost.peer.id, steveId = host.msgs.find(m => m.t === 'peer-joined' && m.peer.name === 'Steve').peer.id;
  // signals between the green room and other guests are dropped
  guest.send({ t: 'signal', to: steveId, data: { x: 1 } });
  // recording: Steve is recorded, the green room isn't
  host.send({ t: 'record', on: true });
  await steve.next('record-start');
  await new Promise(r => setTimeout(r, 400));
  assert.equal(guest.msgs.filter(m => m.t === 'record-start').length, 0, 'not recorded in the green room');
  assert.equal(steve.msgs.some(m => m.t === 'peer-joined' && m.peer.name === 'Visitor'), false);
  assert.equal(steve.msgs.some(m => m.t === 'signal'), false);
  // the guest tells the producer their microphones; the producer can switch, set headphones mode, mute
  guest.send({ t: 'devices', mics: [{ id: 'mic-a', label: 'Built-in' }, { id: 'mic-b', label: 'USB mic' }], mic: 'mic-a', headphones: false, micOn: true });
  const dev = await host.next('devices');
  assert.equal(dev.id, visitorId); assert.deepEqual(dev.devices.mics.map(m => m.label), ['Built-in', 'USB mic']);
  host.send({ t: 'control', to: visitorId, action: 'mic', value: 'mic-b' });
  assert.deepEqual(await guest.next('control'), { t: 'control', action: 'mic', value: 'mic-b', from: 'Sam' });
  host.send({ t: 'control', to: visitorId, action: 'rm -rf' });         // unknown actions are dropped
  steve.send({ t: 'control', to: visitorId, action: 'mute' });          // only hosts can help
  await new Promise(r => setTimeout(r, 300));
  assert.equal(guest.msgs.filter(m => m.t === 'control').length, 1);
  // bring them on air: everyone meets, and they join the running recording
  steve.send({ t: 'onair', id: visitorId });                            // guests can't
  await new Promise(r => setTimeout(r, 200));
  assert.equal(guest.msgs.some(m => m.t === 'onair'), false);
  host.send({ t: 'onair', id: visitorId });
  const oa = await guest.next('onair');
  assert.deepEqual(oa.peers.map(p => p.name), ['Steve']);
  assert.equal((await steve.next('peer-joined')).peer.name, 'Visitor');
  assert.ok((await guest.next('record-start')).seg, 'recorded from the moment they are on air');
  host.send({ t: 'record', on: false });
  await host.next('record-stop');

  // scenes: stored for the show, by name, cleaned up, and sent to hosts only
  host.send({ t: 'scene', slot: 'B', data: { Steve: { db: -3, gate: true, pan: 9 }, Visitor: { db: 2 } } });
  const sc = await host.next('scenes');
  assert.deepEqual(sc.scenes.B.data.Steve, { db: -3, mute: false, pan: 1, hpf: false, low: 0, pres: 0, high: 0, comp: false, gate: true });
  steve.send({ t: 'scene', slot: 'A', data: { Steve: { db: 10 } } });
  host.send({ t: 'scene', slot: 'Z', data: {} });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(steve.msgs.some(m => m.t === 'scenes'), false);
  let saved = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'rooms', r2.id, 'room.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.scenes), ['B']);

  // script: hosts-only first (guests get nothing), then shared with everyone
  host.send({ t: 'script', text: 'INTRO\r\nWelcome to the show', share: 'hosts' });
  assert.equal((await host.next('script')).script.text, 'INTRO\nWelcome to the show');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(steve.msgs.filter(m => m.t === 'script').pop().script, null, 'hosts only');
  steve.send({ t: 'script', text: 'hacked', share: 'all' });
  host.send({ t: 'script', text: 'INTRO\nWelcome to the show', share: 'all' });
  await waitFor(() => steve.msgs.filter(m => m.t === 'script').pop().script, 5000, 20);
  assert.equal(steve.msgs.filter(m => m.t === 'script').pop().script.text, 'INTRO\nWelcome to the show');
  // …and it's there for anyone joining later
  const late = client('Sam', r2.hostKey, r2);
  assert.equal((await late.join()).script.text, 'INTRO\nWelcome to the show');
  saved = JSON.parse(fs.readFileSync(path.join(srv.dataDir, 'rooms', r2.id, 'room.json'), 'utf8'));
  assert.equal(saved.script.share, 'all');
  for (const c of [host, steve, guest, late]) c.ws.close();
});

test('cloud backup: checks the account, uploads finished takes, retries by itself after a failure', async () => {
  const set = remote => fetch(srv.url + '/api/settings', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ cloud: { remote } }) });
  const testCloud = async remote => (await fetch(srv.url + '/api/settings/cloud-test', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ remote }) })).json();
  assert.equal((await set('no colon here')).status, 400, 'not a remote');
  assert.equal((await set('gdrive:../../etc')).status, 400, 'no climbing out of the folder');
  assert.match((await testCloud('dropbox:Rolling')).error, /no rclone remote called "dropbox:" — you have: gdrive:/);
  assert.equal((await testCloud('gdrive:Rolling')).ok, true);
  assert.equal((await set('gdrive:Rolling')).status, 200);
  const cloudRoot = path.join(srv.dataDir, 'pretend-cloud');
  try {
    const info = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json();
    const take = info.takes.find(t => t.status === 'ready');
    assert.ok(take, 'a finished take from the earlier test');
    // the connection is down: the upload fails, says why, and tries again by itself
    fs.mkdirSync(cloudRoot, { recursive: true }); fs.writeFileSync(path.join(cloudRoot, 'fail'), '');
    assert.equal((await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/cloud?k=${room.hostKey}`, { method: 'POST' })).status, 200);
    const failed = await waitFor(async () => { const t = (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes.find(x => x.id === take.id); return t.cloud && !t.cloud.busy && !t.cloud.ok && t.cloud; }, 20000, 100);
    assert.match(failed.error, /no such host/);
    fs.rmSync(path.join(cloudRoot, 'fail'));
    const ok = await waitFor(async () => { const t = (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes.find(x => x.id === take.id); return t.cloud && t.cloud.ok && t.cloud; }, 20000, 100);
    const showDir = path.join(cloudRoot, 'gdrive', 'Rolling');
    const takeDirs = fs.readdirSync(path.join(showDir, fs.readdirSync(showDir)[0]));
    assert.match(takeDirs[0], /^Take \d+ - \d{4}-\d\d-\d\d \d\d-\d\d$/);
    const uploaded = fs.readdirSync(path.join(showDir, fs.readdirSync(showDir)[0], takeDirs[0]));
    assert.ok(uploaded.some(f => /Steve.*\.wav$/.test(f)) && uploaded.some(f => /\.sesx$/.test(f)), `uploaded: ${uploaded.join(', ')}`);
    assert.ok(!uploaded.some(f => f.startsWith('.')), 'no hidden working files');
    assert.ok(ok.dest.startsWith('gdrive:Rolling/'));
  } finally { await set(''); }
});

test('admin password: wrong guesses are paused after 8, per person (the real address behind the tunnel)', async () => {
  const tryLogin = (password, ip) => fetch(srv.url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ password }) });
  const guesses = await Promise.all(Array.from({ length: 8 }, () => tryLogin('nope', '203.0.113.9')));
  assert.ok(guesses.every(r => r.status === 401));
  assert.equal((await tryLogin('nope', '203.0.113.9')).status, 429, 'paused');
  assert.equal((await tryLogin('testpass', '203.0.113.9')).status, 429, 'even with the right password, until the pause is over');
  assert.equal((await tryLogin('testpass', '198.51.100.7')).status, 200, 'someone else can still log in');
});

test('invite a guest: copy the text, or email it with a calendar entry', async () => {
  // a tiny pretend email server on this machine
  const got = [];
  const smtp = require('net').createServer(sock => {
    let data = false, buf = '';
    sock.write('220 test ESMTP\r\n');
    sock.on('data', d => {
      buf += d;
      if (data) { if (buf.includes('\r\n.\r\n')) { got.push(buf); buf = ''; data = false; sock.write('250 OK\r\n'); } return; }
      for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (/^(EHLO|HELO)/i.test(line)) sock.write('250 test\r\n');
        else if (/^DATA/i.test(line)) { data = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.end('221 bye\r\n'); }
        else sock.write('250 OK\r\n');
      }
    });
  });
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  try {
    const url = `${srv.url}/api/rooms/${room.id}/invite?k=${room.hostKey}`, post_ = body => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    // copy: the text, with this studio's guest link
    const copy = await (await post_({ name: 'Leo', host: 'Sam', when: '2026-12-01T19:00:00Z', tz: 'Europe/London' })).json();
    assert.match(copy.subject, /You're invited to record .* — Tuesday 1 December at 19:00 GMT/);
    assert.ok(copy.text.includes(`/r/${room.id}`) && !copy.text.includes(room.hostKey), 'the guest link — never the host key');
    // send: refused until email is set up, then sent with a calendar entry
    assert.equal((await post_({ email: 'leo@example.com', send: true })).status, 400);
    const set = await fetch(srv.url + '/api/settings', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ smtp: { host: '127.0.0.1', port: smtp.address().port, from: 'studio@example.com' } }) });
    assert.equal(set.status, 200);
    assert.equal((await post_({ email: 'not an email', send: true })).status, 400);
    assert.equal((await fetch(url.replace(room.hostKey, 'wrong'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const sent = await post_({ name: 'Leo', email: 'leo@example.com', when: '2026-12-01T19:00:00Z', tz: 'Europe/London', send: true });
    assert.equal(sent.status, 200, await sent.clone().text());
    await waitFor(() => got.length === 1, 5000, 50);
    assert.match(got[0], /To: leo@example\.com/); assert.match(got[0], /BEGIN:VCALENDAR/); assert.match(got[0], /DTSTART:20261201T190000Z/);
  } finally {
    smtp.close();
    await fetch(srv.url + '/api/settings', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ smtp: { host: '' } }) });
  }
});

test('a damaged take file is reported and kept, and the server carries on', async () => {
  const d = path.join(srv.dataDir, 'rooms', room.id, 'takes', 'Broken12');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'take.json'), '{ this is not json');
  const r = await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`);
  assert.equal(r.status, 200);
  assert.ok(fs.readdirSync(d).some(f => f.startsWith('take.json.corrupt-')), 'a copy of the damaged file is kept');
  assert.match(srv.logs(), /damaged/);
});
test('only real intro/outro names can be removed', async () => {
  assert.equal((await fetch(`${srv.url}/api/rooms/${room.id}/asset/..%2Froom?k=${room.hostKey}`, { method: 'DELETE' })).status, 400);
});
test('an audio file that is not audio is refused clearly', async () => {
  const r = await fetch(`${srv.url}/api/rooms/${room.id}/asset/intro?k=${room.hostKey}`, { method: 'POST', body: Buffer.from('not audio at all') });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /could not be read as audio/);
});
