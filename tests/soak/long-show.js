'use strict';
/*
 * Long-show test: a pretend show with several people recording for a long time, through the real server, to check
 * nothing grows out of control (memory), uploads keep up, and every file comes out the right length.
 *
 *   node tests/soak/long-show.js [people=5] [minutes=30]
 *
 * Audio is uploaded faster than real time (as fast as the server takes it), in 2-second pieces like the browsers
 * send, from everyone at once. Needs roughly 0.2 GB of disk per person per minute recorded for all the files.
 */
const fs = require('fs');
const path = require('path');
const { startServer, login, waitFor, pcm24, talky, duration } = require('../helpers');

const PEOPLE = Number(process.argv[2]) || 5, MINUTES = Number(process.argv[3]) || 30, PIECE = 2; // seconds
const rss = pid => { try { return Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) / 1024; } catch { return NaN; } };
const du = dir => { let n = 0; const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else n += fs.statSync(p).size; } }; walk(dir); return n; };
const gb = b => (b / 1024 ** 3).toFixed(2) + ' GB';

(async () => {
  const srv = await startServer({ LOG_LEVEL: 'warn' });
  const { cookie } = await login(srv.url);
  const room = await (await fetch(srv.url + '/api/rooms', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Long Show' }) })).json();
  await fetch(`${srv.url}/api/rooms/${room.id}/settings?k=${room.hostKey}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ waitingRoom: false }) });
  const mem = { start: rss(srv.proc.pid), peak: 0 };
  const memTimer = setInterval(() => { mem.peak = Math.max(mem.peak, rss(srv.proc.pid)); }, 1000);

  const people = [];
  for (let i = 0; i < PEOPLE; i++) {
    const ws = new WebSocket(srv.url.replace('http', 'ws') + '/ws'), msgs = [];
    ws.onmessage = e => msgs.push(JSON.parse(e.data));
    await new Promise(r => { ws.onopen = r; });
    ws.send(JSON.stringify({ t: 'join', room: room.id, key: i === 0 ? room.hostKey : '', name: `Person ${i + 1}`, clientId: `Cperson${i}xxxx`, camId: 'cam' + i }));
    await waitFor(() => msgs.find(m => m.t === 'welcome'), 10000, 50);
    people.push({ ws, msgs });
  }
  people[0].ws.send(JSON.stringify({ t: 'record', on: true }));
  const starts = await Promise.all(people.map(p => waitFor(() => p.msgs.find(m => m.t === 'record-start'), 20000, 50)));
  const t0 = Date.now();
  console.log(`${PEOPLE} people, ${MINUTES} minutes each — uploading…`);
  const pieces = MINUTES * 60 / PIECE;
  await Promise.all(starts.map(async (s, i) => {
    const audio = pcm24(PIECE, talky(i + 1)); // the same 2 seconds over and over is fine for this test
    for (let k = 0; k < pieces; k++) {
      const sample = k * PIECE * 48000, t = s.started + 50 + k * PIECE * 1000;
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(`${srv.url}/up/${room.id}/${s.take}/${s.seg}/audio?tok=${s.tok}&s=${sample}&t=${t}&rate=48000`, { method: 'POST', body: audio }).catch(e => ({ status: 0, e }));
        if (r.status === 200) break;
        if (attempt > 5) throw new Error(`upload kept failing: ${r.status} ${r.e || ''}`);
        await new Promise(res => setTimeout(res, 500 * attempt));
      }
      if (i === 0 && k % 150 === 0) console.log(`  ${Math.round(k * PIECE / 60)} min uploaded · server memory ${rss(srv.proc.pid).toFixed(0)} MB`);
    }
    await fetch(`${srv.url}/up/${room.id}/${s.take}/${s.seg}/done?tok=${s.tok}`, { method: 'POST' });
  }));
  const upSecs = (Date.now() - t0) / 1000, upBytes = PEOPLE * MINUTES * 60 * 48000 * 3;
  console.log(`uploaded ${gb(upBytes)} in ${upSecs.toFixed(0)} s (${(upBytes / upSecs / 1e6).toFixed(1)} MB/s) · server memory peak so far ${mem.peak.toFixed(0)} MB`);
  people[0].ws.send(JSON.stringify({ t: 'record', on: false }));
  const t1 = Date.now();
  let take;
  await waitFor(async () => { take = (await (await fetch(`${srv.url}/api/rooms/${room.id}?k=${room.hostKey}`)).json()).takes[0]; return take && ['ready', 'error'].includes(take.status); }, 6 * 3600 * 1000, 5000);
  clearInterval(memTimer);
  const out = path.join(srv.dataDir, 'rooms', room.id, 'takes', take.id, 'out');
  console.log(`files made in ${((Date.now() - t1) / 60000).toFixed(1)} min · status ${take.status}${take.error ? ' · ERROR ' + take.error : ''}`);
  console.log(`server memory: ${mem.start.toFixed(0)} MB at start, ${mem.peak.toFixed(0)} MB at most`);
  console.log(`disk: ${gb(du(path.join(srv.dataDir, 'rooms')))} for the take (${take.outputs.length} files)`);
  const want = MINUTES * 60 + 0.05, bad = [];
  for (const o of take.outputs.filter(x => /\.wav$/.test(x.file) && !/room tone/.test(x.file))) {
    const d = duration(path.join(out, o.file));
    if (Math.abs(d - want) > 1) bad.push(`${o.file}: ${d.toFixed(2)} s (expected ${want.toFixed(2)})`);
  }
  console.log(bad.length ? `WRONG LENGTHS:\n  ${bad.join('\n  ')}` : `every recording is ${want.toFixed(2)} s long ✓`);
  for (const p of people) p.ws.close();
  await srv.stop();
  process.exit(take.status === 'ready' && !bad.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
