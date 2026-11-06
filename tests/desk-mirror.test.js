'use strict';
// Rolling Desk — saving on this computer, against a real server: live copy while recording (only audio that's
// complete with no gaps), then every finished file downloaded and checked, changed files re-fetched, live copy tidied.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { startServer, login, waitFor, pcm24, talky, tmpDir } = require('./helpers');
const { Mirror, parseHostLink } = require('../desk/mirror');

const hasWS = typeof WebSocket === 'function';
let srv, room;
test.before(async () => {
  srv = await startServer();
  const { cookie } = await login(srv.url);
  room = await (await fetch(srv.url + '/api/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'AOL Underground' }) })).json();
  await fetch(`${srv.url}/api/rooms/${room.id}/settings?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ waitingRoom: false }) });
});
test.after(async () => { if (srv) await srv.stop(); });

test('host links are understood, anything else is explained', () => {
  assert.deepEqual(parseHostLink('https://podcast.example.com/r/AbC123?k=xyz'), { base: 'https://podcast.example.com', roomId: 'AbC123', key: 'xyz' });
  assert.throws(() => parseHostLink('https://podcast.example.com/r/AbC123'), /not a host link/);
  assert.throws(() => parseHostLink('hello'), /isn't a web link/);
});

test('live copy while recording, finished files when ready, re-sync after changes', { skip: !hasWS && 'needs Node 22+' }, async () => {
  const folder = tmpDir('desk');
  const logs = [];
  const m = new Mirror({ link: `${srv.url}/r/${room.id}?k=${room.hostKey}`, folder, log: (l, msg) => logs.push(`${l} ${msg}`) });
  await m.loadState(); await fs.promises.mkdir(folder, { recursive: true });
  assert.equal((await m.pollOnce()).busy, false, 'nothing to do yet');

  // a host records; audio arrives in half-second pieces
  const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws'), msgs = [];
  ws.onmessage = e => msgs.push(JSON.parse(e.data));
  await new Promise(r => { ws.onopen = r; });
  ws.send(JSON.stringify({ t: 'join', room: room.id, key: room.hostKey, name: 'Steve', clientId: 'CSteveDesk1', camId: 'cam-steve' }));
  await waitFor(() => msgs.find(x => x.t === 'welcome'), 10000, 50);
  ws.send(JSON.stringify({ t: 'record', on: true, episode: { n: '14', title: 'Desk test' } }));
  const s = await waitFor(() => msgs.find(x => x.t === 'record-start'), 10000, 50);
  const pcm = pcm24(20, talky(3)), piece = 24000 * 3;
  const send = async off => {
    const sample = off / 3;
    const r = await fetch(`${srv.url}/up/${room.id}/${s.take}/${s.seg}/audio?tok=${s.tok}&s=${sample}&t=${(s.started + 50 + sample / 48).toFixed(1)}&rate=48000`, { method: 'POST', body: pcm.subarray(off, off + piece) });
    assert.equal(r.status, 200);
  };
  // first 5 s in order, then 6-10 s — but 5-6 s goes missing for now (a gap)
  for (let off = 0; off < 5 * 48000 * 3; off += piece) await send(off);
  for (let off = 6 * 48000 * 3; off < 10 * 48000 * 3; off += piece) await send(off);
  // a few camera pieces
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${srv.url}/up/${room.id}/${s.take}/${s.seg}/video?tok=${s.tok}&i=${i}&mime=video/webm${i === 0 ? '&st=' + s.started : ''}`, { method: 'POST', body: Buffer.from(`piece${i};`) })).status, 200);

  let st = await m.pollOnce();
  assert.equal(st.recording, true); assert.equal(st.busy, true); assert.match(st.detail, /live copy/);
  const takeDir = path.join(folder, 'AOL Underground', fs.readdirSync(path.join(folder, 'AOL Underground'))[0]);
  assert.match(path.basename(takeDir), /^Ep 14 - Desk test \(/);
  const liveWav = path.join(takeDir, 'Live copy', 'Steve.wav');
  const wavSecs = f => parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout);
  assert.ok(Math.abs(wavSecs(liveWav) - 5) < 0.01, `only the 5 s with no gap is copied: ${wavSecs(liveWav)}`);
  assert.deepEqual(fs.readFileSync(liveWav).subarray(44), pcm.subarray(0, 5 * 48000 * 3), 'exactly the samples the browser recorded');
  assert.equal(fs.readFileSync(path.join(takeDir, 'Live copy', 'Steve - camera.webm'), 'utf8'), 'piece0;piece1;piece2;');

  // the missing second arrives, then the rest: the live copy catches up, still playable at every step
  await send(5 * 48000 * 3);
  assert.ok(Math.abs((await m.pollOnce(), wavSecs(liveWav)) - 5.5) < 0.01, 'half the gap filled: the copy stops at the next gap');
  await send(5.5 * 48000 * 3);
  for (let off = 10 * 48000 * 3; off < pcm.length; off += piece) await send(off);
  await m.pollOnce();
  const liveInfo = await (await fetch(`${srv.url}/api/rooms/${room.id}/takes/${s.take}/live?k=${room.hostKey}`)).json();
  assert.ok(Math.abs(wavSecs(liveWav) - 20) < 0.01, `caught up to 20 s: ${wavSecs(liveWav)} (server says ${JSON.stringify(liveInfo.segs[0].audio)}; ${m.status.error})`);
  assert.deepEqual(fs.readFileSync(liveWav).subarray(44), pcm, 'whole recording, sample for sample');

  // stop: the studio builds the take; the app downloads every finished file and checks each one
  assert.equal((await fetch(`${srv.url}/up/${room.id}/${s.take}/${s.seg}/done?tok=${s.tok}`, { method: 'POST' })).status, 200);
  ws.send(JSON.stringify({ t: 'record', on: false }));
  const take = await waitFor(async () => { const r = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json(); return r.takes[0].status === 'ready' && r.takes[0]; }, 120000);
  st = await m.pollOnce();
  assert.equal(st.busy, false); assert.match(st.detail, /safe to close/);
  for (const o of take.outputs) assert.equal(fs.statSync(path.join(takeDir, o.file)).size, o.size, o.file);
  assert.equal(fs.existsSync(path.join(takeDir, 'Live copy')), false, 'live copy tidied away once the finished files are saved');
  assert.equal(fs.readdirSync(takeDir).filter(f => f.endsWith('.downloading')).length, 0);

  // the take changes on the studio (marker added + docs rebuilt): only the changed files come down again
  const steveWav = path.join(takeDir, 'Steve.wav'), wavTime = fs.statSync(steveWav).mtimeMs;
  await fetch(`${srv.url}/api/rooms/${room.id}/takes/${take.id}/markers?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markers: [{ at: 3000, label: 'Added later' }] }) });
  await waitFor(async () => { const r = await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json(); return r.takes[0].status === 'ready' && r.takes[0].outputs.some(o => o.file === 'Markers.txt') && r.takes[0]; }, 60000);
  await m.pollOnce();
  assert.match(fs.readFileSync(path.join(takeDir, 'Markers.txt'), 'utf8'), /Added later/);
  assert.equal(fs.statSync(steveWav).mtimeMs, wavTime, 'unchanged files are left alone');

  // the app remembers what it saved (state file) — a fresh start doesn't download everything again
  const m2 = new Mirror({ link: `${srv.url}/r/${room.id}?k=${room.hostKey}`, folder });
  await m2.loadState();
  assert.equal((await m2.pollOnce()).busy, false);
  assert.equal(fs.statSync(steveWav).mtimeMs, wavTime);
  ws.close();
});

test('a wrong host key is reported in plain words, not a crash', async () => {
  const m = new Mirror({ link: `${srv.url}/r/${room.id}?k=wrong`, folder: tmpDir('desk-bad') });
  await assert.rejects(m.pollOnce(), /refused this host link/);
});
