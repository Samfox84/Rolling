'use strict';
/*
 * Rolling Desk — saving everything on this computer as well as on the studio server.
 *
 *  • While a take records: a live copy of everyone's full-quality audio (24-bit WAV, the exact samples their
 *    browser recorded) and camera, pulled from the server a few seconds behind. Only audio that has arrived
 *    complete with no gaps is copied, so nothing already saved ever changes.
 *  • When the take is ready: every finished file (WAVs, cleaned voices, Producer mix, video, edit list,
 *    transcript, session files…) is downloaded and checked. If the take is rebuilt later (Clean again,
 *    marker edits…), the changed files are fetched again.
 *  • Once the finished files are safely saved, the live copy can be removed (it's the same audio).
 *
 * Plain Node (no Electron) so it can be tested against a real server.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');

const LOW_DISK = 2 * 1024 ** 3;           // warn below 2 GB free
const TIMEOUT = { api: 15000, chunk: 60000, file: 30 * 60 * 1000 };

/** "https://studio/r/ROOM?k=KEY" → { base, roomId, key } (throws a plain-English error if it isn't a host link) */
function parseHostLink(link) {
  let u;
  try { u = new URL(String(link).trim()); } catch { throw new Error('That isn\'t a web link — paste the host link from your Rolling dashboard'); }
  const m = u.pathname.match(/^\/r\/([A-Za-z0-9_-]+)\/?$/), key = u.searchParams.get('k');
  if (!m || !key) throw new Error('That\'s not a host link — use "Open studio as host" from your dashboard (it ends in ?k=…)');
  return { base: u.origin, roomId: m[1], key };
}
const safeName = s => String(s).replace(/[\/\\:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
function takeFolderName(t) {
  const ep = t.episode && t.episode.n ? `Ep ${t.episode.n}${t.episode.title ? ' - ' + t.episode.title : ''}` : '';
  return safeName(`${ep || 'Take ' + t.n} (${new Date(t.started).toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')})`);
}
function wavHeader(dataBytes, rate) { // mono 24-bit PCM
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 3, 28); h.writeUInt16LE(3, 32); h.writeUInt16LE(24, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

class Mirror extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.link      the room's host link
   * @param {string} o.folder    where recordings are saved on this computer
   * @param {boolean} [o.removeLive=true] delete the live copy once the finished files are saved
   * @param {number} [o.pollMs=2000]
   * @param {(level:string, msg:string, err?:Error)=>void} [o.log]
   */
  constructor({ link, folder, removeLive = true, pollMs = 2000, log = () => {} }) {
    super();
    Object.assign(this, parseHostLink(link));
    this.folder = folder; this.removeLive = removeLive; this.pollMs = pollMs; this.log = log;
    this.stateFile = path.join(folder, '.rolling-desk.json');
    this.state = { rooms: {} };
    this.status = { phase: 'starting', busy: false, recording: false, detail: 'Connecting…', saved: 0, lowDisk: false, error: '', folder };
    this.running = false;
  }
  // ---------- small helpers ----------
  url(p, extra = '') { return `${this.base}${p}${p.includes('?') ? '&' : '?'}k=${encodeURIComponent(this.key)}${extra}`; }
  async get(p, { timeout = TIMEOUT.api, headers } = {}) {
    const res = await fetch(this.url(p), { headers, signal: AbortSignal.timeout(timeout) });
    if (res.status === 403) throw new Error('The studio refused this host link (it may have been changed) — connect again with the current link');
    return res;
  }
  async json(p) { const r = await this.get(p); if (!r.ok) throw new Error(`${p} → ${r.status}`); return r.json(); }
  async loadState() {
    try { this.state = JSON.parse(await fsp.readFile(this.stateFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') this.log('warn', 'the local saving notes were unreadable — starting fresh (files on disk are kept)', e); }
    this.state.rooms = this.state.rooms || {};
  }
  async saveState() { const tmp = this.stateFile + '.tmp'; await fsp.writeFile(tmp, JSON.stringify(this.state, null, 1)); await fsp.rename(tmp, this.stateFile); }
  setStatus(s) { Object.assign(this.status, s); this.emit('status', { ...this.status }); }

  // ---------- the loop ----------
  async start() {
    if (this.running) return;
    this.running = true;
    await fsp.mkdir(this.folder, { recursive: true });
    await this.loadState();
    const loop = async () => {
      if (!this.running) return;
      try { await this.pollOnce(); }
      catch (e) { this.log('warn', 'local saving: ' + e.message, e); this.setStatus({ error: e.message }); }
      if (this.running) this.timer = setTimeout(loop, this.pollMs);
    };
    loop();
  }
  stop() { this.running = false; clearTimeout(this.timer); }

  /** one pass: copy whatever is new; returns the status */
  async pollOnce() {
    const room = await this.json(`/api/rooms/${this.roomId}`);
    const rs = this.state.rooms[this.roomId] || (this.state.rooms[this.roomId] = { since: Date.now() - 60000, takes: {} });
    const roomDir = path.join(this.folder, safeName(room.name));
    let recording = false, busy = false, detail = 'Ready — new takes are saved here automatically', error = '';
    for (const t of room.takes) {
      const known = rs.takes[t.id];
      if (!known && t.started < rs.since) continue;                       // takes from before this computer was connected
      const ts = known || (rs.takes[t.id] = { dir: path.join(roomDir, takeFolderName(t)), live: {}, files: {}, complete: false });
      try {
        if (['recording', 'queued', 'processing', 'waiting'].includes(t.status)) {
          if (t.status === 'recording') recording = true;
          busy = true;
          const got = ts.complete ? 0 : await this.syncLive(t, ts); // a take being rebuilt after it was saved: just wait for the new files
          detail = t.status === 'recording' ? `Saving a live copy · ${fmtBytes(got)}` : 'The studio is finishing the take…';
        } else if (t.outputs && t.outputs.length) {
          const left = await this.syncFinished(t, ts);
          if (left) { busy = true; detail = `Downloading the finished files · ${left} to go`; }
        }
      } catch (e) { busy = busy || !ts.complete; error = `${takeFolderName(t)}: ${e.message}`; this.log('warn', 'local saving: ' + error, e); }
    }
    await this.saveState();
    let lowDisk = false;
    try { const st = await fsp.statfs(this.folder); lowDisk = st.bavail * st.bsize < LOW_DISK; } catch (e) { this.log('debug', 'could not check free space', e); }
    if (!busy && !error) detail = Object.values(rs.takes).some(x => x.complete) ? 'All saved on this computer — safe to close' : detail;
    this.setStatus({ phase: busy ? (recording ? 'live' : 'downloading') : 'idle', busy, recording, detail, lowDisk, error });
    return { ...this.status };
  }

  // ---------- while recording: live copy ----------
  async syncLive(t, ts) {
    const live = await this.json(`/api/rooms/${this.roomId}/takes/${t.id}/live`);
    if (!live.raw) return 0;
    const dir = path.join(ts.dir, 'Live copy');
    await fsp.mkdir(dir, { recursive: true });
    let total = 0;
    for (const s of live.segs) {
      const st = ts.live[s.id] || (ts.live[s.id] = { audio: 0, video: 0 });
      if (s.audio && s.audio.solid * 3 > st.audio) {                       // new complete audio: fetch just that stretch
        const file = path.join(dir, `${safeName(s.person)}.wav`), want = s.audio.solid * 3;
        const r = await this.get(`/api/rooms/${this.roomId}/takes/${t.id}/live/${s.id}/audio`, { timeout: TIMEOUT.chunk, headers: { Range: `bytes=${st.audio}-${want - 1}` } });
        if (r.status !== 206 && r.status !== 200) throw new Error(`live audio for ${s.person} → ${r.status}`);
        let buf = Buffer.from(await r.arrayBuffer());
        if (r.status === 200) buf = buf.subarray(st.audio, want);          // server ignored the range: take our part
        buf = buf.subarray(0, buf.length - (buf.length % 3));
        const fh = await fsp.open(file, fs.existsSync(file) ? 'r+' : 'w+');
        try {
          await fh.write(buf, 0, buf.length, 44 + st.audio);
          st.audio += buf.length;
          await fh.write(wavHeader(st.audio, s.audio.rate), 0, 44, 0);    // keep the WAV playable as it grows
        } finally { await fh.close(); }
      }
      if (s.video && s.video.ready > st.video) {                           // camera pieces, in order
        const ext = /mp4/.test(s.video.mime) ? 'mp4' : 'webm', file = path.join(dir, `${safeName(s.person)} - camera.${ext}`);
        for (let i = st.video; i < s.video.ready; i++) {
          const r = await this.get(`/api/rooms/${this.roomId}/takes/${t.id}/live/${s.id}/video/${i}`, { timeout: TIMEOUT.chunk });
          if (!r.ok) throw new Error(`live camera for ${s.person} → ${r.status}`);
          const piece = Buffer.from(await r.arrayBuffer());
          await fsp.appendFile(file, piece);
          st.video = i + 1; st.videoBytes = (st.videoBytes || 0) + piece.length;
        }
      }
      total += st.audio + (st.videoBytes || 0);
    }
    return total;
  }

  // ---------- when ready: the finished files ----------
  /** downloads missing or changed files; returns how many are still to fetch (0 = all saved) */
  async syncFinished(t, ts) {
    await fsp.mkdir(ts.dir, { recursive: true });
    const todo = t.outputs.filter(o => ts.files[o.file] !== o.size || !fs.existsSync(path.join(ts.dir, o.file)));
    for (const o of todo) {
      const dest = path.join(ts.dir, o.file), part = dest + '.downloading';
      const r = await this.get(`/dl/${this.roomId}/${t.id}/${encodeURIComponent(o.file)}`, { timeout: TIMEOUT.file });
      if (!r.ok) throw new Error(`${o.file} → ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(part));
      const size = (await fsp.stat(part)).size;
      if (size !== o.size) { await fsp.rm(part, { force: true }); throw new Error(`${o.file} arrived incomplete (${size} of ${o.size} bytes) — will try again`); }
      await fsp.rename(part, dest);
      ts.files[o.file] = o.size;
      this.status.saved += size;
      this.setStatus({ detail: `Downloading the finished files · ${o.file}` });
    }
    // files the studio no longer has (renamed documents etc.) are tidied away
    for (const f of Object.keys(ts.files)) if (!t.outputs.some(o => o.file === f)) { await fsp.rm(path.join(ts.dir, f), { force: true }); delete ts.files[f]; }
    ts.complete = true;
    if (this.removeLive && fs.existsSync(path.join(ts.dir, 'Live copy'))) {
      await fsp.rm(path.join(ts.dir, 'Live copy'), { recursive: true, force: true });
      this.log('info', `${takeFolderName(t)}: finished files saved, live copy removed`);
    }
    return 0;
  }
}
function fmtBytes(n) { return n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(0) + ' MB' : Math.round(n / 1e3) + ' KB'; }

module.exports = { Mirror, parseHostLink, takeFolderName, safeName };
