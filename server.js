'use strict';
/*
 * Podcast Studio — self-hosted remote recording.
 * Live call = WebRTC (peer to peer). Recording = each browser records its own
 * mic as lossless 24-bit PCM and its own camera (and screen shares), saves every
 * piece to its own disk first, then uploads in the background. The server lines
 * everything up and builds the files.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const archiver = require('archiver');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* email optional */ }

const VERSION = '1.1.0';

// ---------- settings (from .env next to this file) ----------
(function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const PORT = parseInt(process.env.PORT || '8790', 10);
const BIND = process.env.BIND || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'recordings'));
const STUDIO_NAME = process.env.STUDIO_NAME || 'Podcast Studio';
const MAX_PEOPLE = parseInt(process.env.MAX_PEOPLE || '5', 10);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const VIDEO_PRESET = process.env.VIDEO_PRESET || 'veryfast';
const ROOM_TONE_SECONDS = parseInt(process.env.ROOM_TONE_SECONDS || '20', 10);
const GB_PER_PERSON_HOUR = 4;
const MIN_FREE_GB = parseFloat(process.env.MIN_FREE_GB || '2');
const LATE_REBUILD_SECONDS = parseInt(process.env.LATE_REBUILD_SECONDS || '90', 10);
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let SECRET = process.env.SECRET || '';
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); console.warn('[warn] SECRET not set in .env — logins reset on restart'); }
if (!ADMIN_PASSWORD) { ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex'); console.warn('[warn] ADMIN_PASSWORD not set — temporary password: ' + ADMIN_PASSWORD); }

const STUN = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478').split(',').map(s => s.trim()).filter(Boolean);
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const TURN_SECRET = process.env.TURN_SECRET || '';

// ---------- helpers ----------
const ROOMS_DIR = path.join(DATA_DIR, 'rooms');
fs.mkdirSync(ROOMS_DIR, { recursive: true });

const rid = (n = 10) => crypto.randomBytes(16).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, n).padEnd(n, 'x');
const hmac = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const safeEq = (a, b) => { a = Buffer.from(String(a)); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const validId = s => typeof s === 'string' && /^[a-zA-Z0-9]{4,24}$/.test(s);
const validStreamId = s => (typeof s === 'string' && /^[\w{}-]{1,80}$/.test(s) ? s : null);
const cleanName = s => String(s || '').replace(/[\u0000-\u001f<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Guest';
const cleanText = (s, n) => String(s || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, n);
const fileSafe = s => cleanName(s).replace(/[^a-zA-Z0-9 _().-]/g, '').trim() || 'Guest';
const hms = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };

const roomDir = id => path.join(ROOMS_DIR, id);
const takeDir = (room, take) => path.join(roomDir(room), 'takes', take);

function readJSON(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJSON(p, obj) { const tmp = p + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj, (k, v) => (k.startsWith('_') ? undefined : v), 2)); fs.renameSync(tmp, p); }

function loadRoom(id) { return validId(id) ? readJSON(path.join(roomDir(id), 'room.json')) : null; }
function saveRoom(r) { fs.mkdirSync(roomDir(r.id), { recursive: true }); writeJSON(path.join(roomDir(r.id), 'room.json'), r); }

// studio-wide settings editable from the dashboard (email, relay, backups)
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const settings = (() => {
  const s = readJSON(SETTINGS_FILE, {}) || {};
  return {
    smtp: Object.assign({ host: '', port: 587, user: '', pass: '', from: '' }, s.smtp),
    turn: Object.assign({ keyId: process.env.CF_TURN_KEY_ID || '', token: process.env.CF_TURN_API_TOKEN || '' }, s.turn),
    backupDir: s.backupDir !== undefined ? s.backupDir : (process.env.BACKUP_DIR || ''),
    publicUrl: s.publicUrl || process.env.PUBLIC_URL || '',
  };
})();
function saveSettings() { writeJSON(SETTINGS_FILE, settings); try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch {} }

// takes are cached in memory while in use; written to disk (debounced)
const takeCache = new Map();
function loadTake(room, take) {
  const k = room + '/' + take;
  if (takeCache.has(k)) return takeCache.get(k);
  if (!validId(room) || !validId(take)) return null;
  const t = readJSON(path.join(takeDir(room, take), 'take.json'));
  if (t) takeCache.set(k, t);
  return t;
}
const saveTimers = new Map();
function saveTake(t, now = false) {
  const k = t.room + '/' + t.id;
  takeCache.set(k, t);
  const write = () => { saveTimers.delete(k); try { fs.mkdirSync(takeDir(t.room, t.id), { recursive: true }); writeJSON(path.join(takeDir(t.room, t.id), 'take.json'), t); } catch (e) { console.error('save take', e); } };
  if (now) { clearTimeout(saveTimers.get(k)); write(); return; }
  if (!saveTimers.has(k)) saveTimers.set(k, setTimeout(write, 1000));
}
function listTakes(room) {
  const d = path.join(roomDir(room), 'takes');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map(id => loadTake(room, id)).filter(Boolean).sort((a, b) => b.started - a.started);
}
async function diskInfo() { try { const s = await fsp.statfs(DATA_DIR); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; } }

// ---------- relay (TURN) for guests on strict networks ----------
let cfIce = { at: 0, list: null, error: '' };
async function cloudflareIce(force) {
  const { keyId, token } = settings.turn;
  if (!keyId || !token) return null;
  if (!force && cfIce.list && Date.now() - cfIce.at < 3600e3) return cfIce.list;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`Cloudflare said ${r.status}${r.status === 401 || r.status === 403 ? ' (check the Key ID and API token)' : ''}`);
    const j = await r.json();
    let s = j.iceServers; if (!Array.isArray(s)) s = [s];
    const list = s.filter(Boolean).map(x => ({ ...x, urls: (Array.isArray(x.urls) ? x.urls : [x.urls]).filter(u => u && !/:53(\?|$)/.test(u)) })).filter(x => x.urls.length);
    cfIce = { at: Date.now(), list, error: '' };
  } catch (e) { cfIce.error = e.message; console.warn('[turn]', e.message); if (force) throw e; }
  return cfIce.list;
}
async function iceServers() {
  const list = [{ urls: STUN }];
  if (TURN_URLS.length && TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:studio`;
    list.push({ urls: TURN_URLS, username, credential: crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64') });
  }
  const cf = await cloudflareIce(false).catch(() => null);
  if (cf) list.push(...cf.filter(x => x.username));
  return list;
}

// ---------- auth ----------
function adminCookie() { const exp = Date.now() + 30 * 864e5; return `${exp}.${hmac('admin.' + exp)}`; }
function isAdmin(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ps_admin=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  return +exp > Date.now() && safeEq(sig || '', hmac('admin.' + exp));
}
function hostKeyOk(room, k) { return room && k && safeEq(k, room.hostKey); }
function canManage(req, room) { return room && (isAdmin(req) || hostKeyOk(room, req.query.k || req.headers['x-host-key'])); }
const segToken = (room, take, seg) => hmac(`seg.${room}.${take}.${seg}`);

// ---------- live rooms (in memory) ----------
const live = new Map(); // roomId -> { peers, waiting, admitted, take, roomTone, chat }
function liveRoom(id) {
  if (!live.has(id)) {
    const saved = readJSON(path.join(roomDir(id), 'admitted.json'), {}) || {};
    const admitted = new Set(Object.keys(saved).filter(c => Date.now() - saved[c] < 12 * 3600e3));
    live.set(id, { peers: new Map(), waiting: new Map(), admitted, take: null, roomTone: null, chat: [] });
  }
  return live.get(id);
}
// remember who the host let in (12 h) so a reconnect or server restart doesn't bounce them back to the waiting room
function admit(roomId, lr, clientId) {
  if (lr.admitted.has(clientId)) return;
  lr.admitted.add(clientId);
  try { const f = path.join(roomDir(roomId), 'admitted.json'); const saved = readJSON(f, {}) || {}; saved[clientId] = Date.now(); writeJSON(f, saved); } catch {}
}
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(lr, msg, exceptId) { for (const p of lr.peers.values()) if (p.id !== exceptId) send(p.ws, msg); }
function toHosts(lr, msg) { for (const p of lr.peers.values()) if (p.isHost) send(p.ws, msg); }
const peerInfo = p => ({ id: p.id, name: p.name, isHost: p.isHost, state: p.state || {}, camId: p.camId, screenId: p.screenId || null });

function newSeg(t, peer) {
  const segId = rid(10);
  t.segs[segId] = { id: segId, clientId: peer.clientId, name: peer.name, created: Date.now(), done: false, audio: null, video: null, screens: {} };
  fs.mkdirSync(path.join(takeDir(t.room, t.id), 'segs', segId, 'video'), { recursive: true });
  saveTake(t, true);
  return segId;
}
function startMsg(t, segId) { return { t: 'record-start', take: t.id, started: t.started, seg: segId, tok: segToken(t.room, t.id, segId) }; }

function startRecording(roomId, lr, roomTone) {
  const room = loadRoom(roomId);
  const n = listTakes(roomId).reduce((a, t) => Math.max(a, t.n), 0) + 1;
  const t = { id: rid(10), room: roomId, n, started: Date.now(), stopped: null, status: 'recording', progress: '', error: '',
    segs: {}, outputs: [], roomTones: [], markers: [], chat: [], backup: null };
  fs.mkdirSync(path.join(takeDir(roomId, t.id), 'segs'), { recursive: true });
  saveTake(t, true);
  lr.take = t.id;
  for (const p of lr.peers.values()) { const seg = newSeg(t, p); p.seg = seg; send(p.ws, startMsg(t, seg)); }
  broadcast(lr, { t: 'recording', on: true, take: t.id, started: t.started, n });
  if (roomTone) beginRoomTone(t, lr, 1500);
  console.log(`[rec] ${room && room.name} take ${n} started`);
}
// room tone: everyone stays silent for a short time so editors get a clean noise print
function beginRoomTone(t, lr, delay = 1000) {
  const start = Date.now() + delay;
  const rt = { start, end: start + ROOM_TONE_SECONDS * 1000 };
  t.roomTones = t.roomTones || [];
  t.roomTones.push(rt);
  saveTake(t, true);
  lr.roomTone = rt;
  broadcast(lr, { t: 'roomtone', start: rt.start, end: rt.end, n: t.roomTones.length });
}
function stopRecording(roomId, lr) {
  if (!lr.take) return;
  const t = loadTake(roomId, lr.take);
  lr.take = null;
  lr.roomTone = null;
  if (!t) return;
  t.stopped = Date.now();
  t.status = 'waiting';
  saveTake(t, true);
  broadcast(lr, { t: 'record-stop', take: t.id });
  broadcast(lr, { t: 'recording', on: false });
  for (const p of lr.peers.values()) p.seg = null;
  fallbackTimers.set(t.id, setTimeout(() => queueProcess(roomId, t.id), 20 * 60 * 1000));
  checkTakeReady(roomId, t.id);
}
const fallbackTimers = new Map();
// a take is ready to build once every person still connected says their uploads are finished
function checkTakeReady(roomId, takeId) {
  const t = loadTake(roomId, takeId);
  if (!t || t.status !== 'waiting') return;
  const lr = live.get(roomId);
  const connected = new Set(lr ? [...lr.peers.values()].map(p => p.clientId) : []);
  const pending = Object.values(t.segs).filter(s => !s.done && connected.has(s.clientId));
  if (pending.length === 0) { clearTimeout(fallbackTimers.get(takeId)); fallbackTimers.delete(takeId); queueProcess(roomId, takeId); }
}
// pieces that arrive after a take was built (e.g. someone reopened a crashed tab) trigger a rebuild
const rebuildTimers = new Map();
function lateUpload(roomId, t) {
  if (!['ready', 'error', 'processing', 'queued'].includes(t.status)) return;
  clearTimeout(rebuildTimers.get(t.id));
  rebuildTimers.set(t.id, setTimeout(() => { rebuildTimers.delete(t.id); queueProcess(roomId, t.id); }, LATE_REBUILD_SECONDS * 1000));
}

// ---------- processing (ffmpeg) ----------
let queue = Promise.resolve();
const queued = new Set(), again = new Set();
function queueProcess(room, take) {
  const k = room + '/' + take;
  if (queued.has(k)) { again.add(k); return; }
  queued.add(k);
  const t = loadTake(room, take);
  if (t && t.status !== 'processing') { t.status = 'queued'; t.progress = 'Waiting to start'; saveTake(t, true); }
  queue = queue.then(() => processTake(room, take)).catch(e => console.error(e)).finally(() => {
    queued.delete(k);
    if (again.delete(k)) queueProcess(room, take);
  });
}
function ff(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 8000) err = err.slice(-8000); });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(err.trim() || 'ffmpeg exit ' + code))));
  });
}
function probe(file, entries, stream) {
  return new Promise(res => {
    const p = spawn(FFPROBE, ['-v', 'error', ...(stream ? ['-select_streams', stream] : []), '-show_entries', entries, '-of', 'csv=p=0', file]);
    let o = ''; p.stdout.on('data', d => { o += d; }); p.on('error', () => res('')); p.on('close', () => res(o.trim()));
  });
}
// decode some audio to a 500 Hz loudness envelope (for lining video up against the lossless audio)
function envelope(args) {
  return new Promise(resolve => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    const bufs = []; p.stdout.on('data', d => bufs.push(d)); p.on('error', () => resolve(null));
    p.on('close', () => {
      const b = Buffer.concat(bufs), n = Math.floor(b.length / 32), env = new Float32Array(n);
      for (let i = 0; i < n; i++) { let a = 0; for (let j = 0; j < 16; j++) a += Math.abs(b.readInt16LE((i * 16 + j) * 2)); env[i] = a / 16; }
      resolve(env);
    });
  });
}
// find where the camera file's own (compressed) sound best matches the lossless WAV; null if unsure
async function alignVideo(videoFile, wavFile, estimate) {
  const from = Math.max(0, estimate - 1.5), K = 1500; // search ±1.5 s around the clock estimate
  const v = await envelope(['-i', videoFile, '-t', '150']);
  const w = await envelope(['-ss', from.toFixed(3), '-t', '160', '-i', wavFile]);
  if (!v || !w || v.length < 2500 || w.length < 2500) return null;
  const N = Math.min(v.length, w.length - K);
  if (N < 2500) return null;
  const mean = (a, o, n) => { let s = 0; for (let i = 0; i < n; i++) s += a[o + i]; return s / n; };
  const vm = mean(v, 0, N); let vn = 0; for (let i = 0; i < N; i++) vn += (v[i] - vm) ** 2;
  const scores = new Float32Array(K + 1);
  for (let k = 0; k <= K; k++) {
    const wm = mean(w, k, N); let dot = 0, wn = 0;
    for (let i = 0; i < N; i++) { const a = v[i] - vm, b = w[i + k] - wm; dot += a * b; wn += b * b; }
    scores[k] = dot / Math.sqrt(vn * wn || 1);
  }
  let best = 0; for (let k = 1; k <= K; k++) if (scores[k] > scores[best]) best = k;
  let second = -1; for (let k = 0; k <= K; k++) if (Math.abs(k - best) > 50 && scores[k] > second) second = scores[k];
  if (scores[best] < 0.4 || scores[best] < second * 1.1) return null;
  return from + best / 500;
}
async function joinParts(dir, prefix, dest) {
  if (!fs.existsSync(dir)) return;
  const parts = (await fsp.readdir(dir)).filter(f => f.endsWith('.part') && f.startsWith(prefix)).sort();
  if (!parts.length) return;
  const ws = fs.createWriteStream(dest, { flags: fs.existsSync(dest) ? 'a' : 'w' });
  for (const p of parts) await new Promise((res, rej) => { const r = fs.createReadStream(path.join(dir, p)); r.on('error', rej); r.on('end', res); r.pipe(ws, { end: false }); });
  await new Promise(r => ws.end(r));
  for (const p of parts) await fsp.rm(path.join(dir, p), { force: true });
}
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
function auditionTime(ms) { const s = ms / 1000, h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60).toFixed(3).padStart(6, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`; }

async function processTake(roomId, takeId) {
  const t = loadTake(roomId, takeId);
  const room = loadRoom(roomId);
  if (!t || !room) return;
  const dir = takeDir(roomId, takeId);
  const out = path.join(dir, 'out');
  await fsp.rm(out, { recursive: true, force: true });
  await fsp.mkdir(out, { recursive: true });
  t.status = 'processing'; t.error = ''; t.outputs = [];
  const set = p => { t.progress = p; saveTake(t, true); };
  const segs = Object.values(t.segs).sort((a, b) => a.created - b.created);

  // one name per person (clientId); repeated joins become "part 2", etc.
  const people = new Map();
  const usedNames = new Set(['mix - all voices', 'chat', 'markers']);
  for (const s of segs) {
    if (!people.has(s.clientId)) {
      let base = fileSafe(s.name), name = base, i = 2;
      while (usedNames.has(name.toLowerCase())) name = `${base} ${i++}`;
      usedNames.add(name.toLowerCase());
      people.set(s.clientId, { name, parts: 0 });
    }
    const p = people.get(s.clientId);
    s._person = p.name;
    s._label = p.name + (p.parts++ ? ` (part ${p.parts})` : '');
  }
  const errors = [];
  const add = (file, kind, person) => { const st = fs.statSync(path.join(out, file)); t.outputs.push({ file, kind, person, size: st.size }); };

  // --- audio: lossless 24-bit WAV per person, lined up to the start of the take ---
  const audioSegs = segs.filter(s => s.audio && s.audio.end > 0);
  const byPerson = new Map(); // person name -> [{ file, from, to }]
  for (let i = 0; i < audioSegs.length; i++) {
    const s = audioSegs[i], a = s.audio;
    set(`Audio ${i + 1} of ${audioSegs.length}`);
    const nominal = a.rate || 48000;
    let rate = nominal;
    if (a.last && a.first && a.last.s - a.first.s > nominal * 300) {
      const measured = (a.last.s - a.first.s) / ((a.last.t - a.first.t) / 1000);
      if (Math.abs(measured / nominal - 1) < 0.002) rate = Math.round(measured); // corrects clock drift over long takes
    }
    const t0 = a.first.t - (a.first.s / nominal) * 1000;
    const pad = Math.max(0, Math.round(((t0 - t.started) / 1000) * 48000));
    const tmp = `_seg_${s.id}.wav`;
    try {
      await ff(['-f', 's24le', '-ar', String(rate), '-ac', '1', '-i', path.join(dir, 'segs', s.id, 'audio.pcm'),
        '-af', `aresample=48000${pad ? `,adelay=${pad}S:all=1` : ''}`, '-ar', '48000', '-c:a', 'pcm_s24le', path.join(out, tmp)]);
      if (!byPerson.has(s._person)) byPerson.set(s._person, []);
      byPerson.get(s._person).push({ file: tmp, from: pad / 48000, to: pad / 48000 + a.end / nominal });
    } catch (e) { errors.push(`${s._label}: ${e.message}`); }
  }
  // someone who dropped out and came back gets their parts joined into one file
  const wavs = [];
  for (const [person, parts] of byPerson) {
    const file = `${person}.wav`;
    try {
      if (parts.length === 1) await fsp.rename(path.join(out, parts[0].file), path.join(out, file));
      else {
        set(`Joining ${person}'s parts`);
        const ins = parts.flatMap(p => ['-i', path.join(out, p.file)]);
        await ff([...ins, '-filter_complex', `amix=inputs=${parts.length}:duration=longest:normalize=0`, '-c:a', 'pcm_s24le', path.join(out, file)])
          .catch(() => ff([...ins, '-filter_complex', `amix=inputs=${parts.length}:duration=longest,volume=${parts.length}`, '-c:a', 'pcm_s24le', path.join(out, file)]));
        for (const p of parts) await fsp.rm(path.join(out, p.file), { force: true });
      }
      add(file, 'audio', person); wavs.push(file);
    } catch (e) { errors.push(`${file}: ${e.message}`); }
  }
  // separate room-tone (noise print) file per person, cut from their lined-up track
  const tones = t.roomTones || [];
  for (let r = 0; r < tones.length; r++) {
    const rt = tones[r];
    const from = Math.max(0, (rt.start - t.started) / 1000), dur = (rt.end - rt.start) / 1000;
    for (const [person, parts] of byPerson) {
      if (!parts.some(p => p.from <= from + dur * 0.1 && p.to >= from + dur * 0.9)) continue; // only if they were there for it
      const file = `${person} - room tone${tones.length > 1 ? ' ' + (r + 1) : ''}.wav`;
      set('Room tone files');
      try { await ff(['-ss', from.toFixed(3), '-t', dur.toFixed(3), '-i', path.join(out, `${person}.wav`), '-c:a', 'pcm_s24le', path.join(out, file)]); add(file, 'roomtone', person); }
      catch (e) { errors.push(`${file}: ${e.message}`); }
    }
  }
  if (wavs.length > 1) {
    set('Mixing all voices');
    const file = 'Mix - all voices.wav';
    const ins = wavs.flatMap(w => ['-i', path.join(out, w)]);
    try { await ff([...ins, '-filter_complex', `amix=inputs=${wavs.length}:duration=longest:normalize=0`, '-c:a', 'pcm_s24le', path.join(out, file)]); }
    catch {
      try { await ff([...ins, '-filter_complex', `amix=inputs=${wavs.length}:duration=longest,volume=${wavs.length}`, '-c:a', 'pcm_s24le', path.join(out, file)]); }
      catch (e) { errors.push(`${file}: ${e.message}`); }
    }
    if (fs.existsSync(path.join(out, file))) add(file, 'mix', 'Everyone');
  }

  // --- camera video: original file + an editor-friendly H.264 MP4 lined up to the take ---
  const videoSegs = segs.filter(s => s.video && s.video.chunks > 0);
  for (let i = 0; i < videoSegs.length; i++) {
    const s = videoSegs[i], v = s.video;
    const ext = /mp4/.test(v.mime || '') ? 'mp4' : 'webm';
    const camFile = path.join(dir, 'segs', s.id, 'camera.' + ext);
    set(`Video ${i + 1} of ${videoSegs.length} (joining)`);
    await joinParts(path.join(dir, 'segs', s.id, 'video'), '', camFile);
    if (!fs.existsSync(camFile)) continue;
    const orig = `${s._label} - camera original.${ext}`;
    try { await fsp.link(camFile, path.join(out, orig)); } catch { await fsp.copyFile(camFile, path.join(out, orig)); }
    add(orig, 'video-original', s._label);
    let padS = Math.max(0, ((v.st || t.started) - t.started) / 1000);
    const wav = path.join(out, `${s._person}.wav`);
    if (fs.existsSync(wav)) {
      set(`Video ${i + 1} of ${videoSegs.length} (lining up with audio)`);
      const exact = await alignVideo(path.join(out, orig), wav, padS).catch(() => null);
      if (exact !== null) padS = exact;
      console.log(`[rec] ${s._label} video offset ${padS.toFixed(3)}s (${exact !== null ? 'matched to audio' : 'from clock'})`);
    }
    set(`Video ${i + 1} of ${videoSegs.length} (converting to MP4 — this can take a while)`);
    const file = `${s._label} - video.mp4`;
    try {
      await ff(['-fflags', '+genpts', '-i', path.join(out, orig),
        '-vf', `fps=30,${padS > 0.01 ? `tpad=start_duration=${padS.toFixed(3)}:color=black,` : ''}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
        '-af', padS > 0.01 ? `adelay=${Math.round(padS * 1000)}:all=1` : 'anull',
        '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.join(out, file)]);
      add(file, 'video', s._label);
    } catch (e) { errors.push(`${file}: ${e.message.slice(0, 300)}`); }
  }

  // --- screen shares: one MP4 per share, lined up to the take ---
  const shares = [];
  for (const s of segs) for (const [r, sc] of Object.entries(s.screens || {})) if (sc.chunks > 0) shares.push({ s, r, sc });
  for (let i = 0; i < shares.length; i++) {
    const { s, r, sc } = shares[i];
    const ext = /mp4/.test(sc.mime || '') ? 'mp4' : 'webm';
    const src = path.join(dir, 'segs', s.id, `screen-${r}.${ext}`);
    set(`Screen share ${i + 1} of ${shares.length}`);
    await joinParts(path.join(dir, 'segs', s.id, 'screen'), String(r).padStart(3, '0') + '-', src);
    if (!fs.existsSync(src)) continue;
    const n = shares.filter((x, j) => j <= i && x.s._person === s._person).length;
    const file = `${s._person} - screen share ${n}.mp4`;
    const padS = Math.max(0, ((sc.st || t.started) - t.started) / 1000);
    try {
      await ff(['-fflags', '+genpts', '-i', src, '-an',
        '-vf', `fps=30,${padS > 0.01 ? `tpad=start_duration=${padS.toFixed(3)}:color=black,` : ''}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
        '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', '20', '-movflags', '+faststart', path.join(out, file)]);
      add(file, 'screen', s._person);
    } catch (e) {
      errors.push(`${file}: ${e.message.slice(0, 300)}`);
      const o = `${s._person} - screen share ${n} original.${ext}`;
      try { await fsp.link(src, path.join(out, o)); add(o, 'screen', s._person); } catch {}
    }
  }

  // --- markers, chat log, and a session file for Audition / Premiere / Resolve ---
  const markers = (t.markers || []).slice().sort((a, b) => a.at - b.at);
  if (markers.length) {
    await fsp.writeFile(path.join(out, 'Markers.txt'), markers.map((m, i) => `${hms(m.at)}  ${m.label || 'Marker ' + (i + 1)}${m.by ? '  (' + m.by + ')' : ''}`).join('\r\n') + '\r\n');
    add('Markers.txt', 'markers', 'Everyone');
    await fsp.writeFile(path.join(out, 'Markers (Audition).csv'), 'Name\tStart\tDuration\tTime Format\tType\tDescription\r\n' +
      markers.map((m, i) => `${(m.label || 'Marker ' + (i + 1)).replace(/\t/g, ' ')}\t${auditionTime(m.at)}\t0:00.000\tdecimal\tCue\t`).join('\r\n') + '\r\n');
    add('Markers (Audition).csv', 'markers', 'Everyone');
  }
  if ((t.chat || []).length) {
    await fsp.writeFile(path.join(out, 'Chat.txt'), t.chat.map(c => `[${hms(c.at)}] ${c.from}: ${c.text}`).join('\r\n') + '\r\n');
    add('Chat.txt', 'chat', 'Everyone');
  }
  try {
    set('Making the session file');
    const xml = await sessionXml(t, room, out);
    if (xml) { await fsp.writeFile(path.join(out, 'Session - open in Audition or Premiere.xml'), xml); add('Session - open in Audition or Premiere.xml', 'session', 'Everyone'); }
  } catch (e) { errors.push('Session file: ' + e.message); }

  t.status = errors.length && !t.outputs.length ? 'error' : 'ready';
  t.error = errors.join('\n');
  t.progress = '';
  saveTake(t, true);
  console.log(`[rec] take ${t.n} in ${roomId} built: ${t.outputs.length} files${errors.length ? ', errors: ' + errors.length : ''}`);
  if (t.outputs.length) {
    set('Backing up'); await backupTake(room, t, out); t.progress = ''; saveTake(t, true);
    await notifyReady(room, t).catch(e => console.warn('[mail]', e.message));
  }
}

// FCP7-style XML: Audition (File > Open), Premiere and Resolve all import it as a multitrack session
async function sessionXml(t, room, out) {
  const fps = 30, fr = s => Math.max(1, Math.round(s * fps));
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const url = f => 'file://localhost/' + encodeURIComponent(f);
  const audios = t.outputs.filter(o => o.kind === 'audio');
  const videos = t.outputs.filter(o => o.kind === 'video' || (o.kind === 'screen' && o.file.endsWith('.mp4')));
  if (!audios.length && !videos.length) return null;
  let max = 0, n = 0;
  const info = new Map();
  for (const o of [...videos, ...audios]) {
    const d = parseFloat(await probe(path.join(out, o.file), 'format=duration')) || 0;
    const wh = o.kind === 'audio' ? null : (await probe(path.join(out, o.file), 'stream=width,height', 'v:0')).split(',').map(Number);
    info.set(o.file, { d, wh: wh && wh[0] ? wh : [1280, 720] });
    max = Math.max(max, d);
  }
  const clip = (o, media, extra = '') => {
    const { d } = info.get(o.file); const f = fr(d); n++;
    return `<clipitem id="clip-${n}"><name>${xmlEsc(o.file)}</name><enabled>TRUE</enabled><duration>${f}</duration>${rate}<start>0</start><end>${f}</end><in>0</in><out>${f}</out>` +
      `<file id="file-${n}"><name>${xmlEsc(o.file)}</name><pathurl>${xmlEsc(url(o.file))}</pathurl>${rate}<duration>${f}</duration><media>${media}</media></file>${extra}</clipitem>`;
  };
  const aChars = '<samplecharacteristics><depth>24</depth><samplerate>48000</samplerate></samplecharacteristics>';
  const vtracks = videos.map(o => { const [w, h] = info.get(o.file).wh; return `<track>${clip(o, `<video><samplecharacteristics>${rate}<width>${w}</width><height>${h}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>`)}</track>`; }).join('\n');
  const atracks = audios.map(o => `<track>${clip(o, `<audio>${aChars}<channelcount>1</channelcount></audio>`, '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>')}</track>`).join('\n');
  const marks = (t.markers || []).map((m, i) => `<marker><name>${xmlEsc(m.label || 'Marker ' + (i + 1))}</name><comment></comment><in>${fr(m.at / 1000)}</in><out>-1</out></marker>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">\n<sequence id="sequence-1"><name>${xmlEsc(`${room.name} - Take ${t.n}`)}</name><duration>${fr(max)}</duration>${rate}\n` +
    `<media>\n<video><format><samplecharacteristics>${rate}<width>1280</width><height>720</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>\n${vtracks}\n</video>\n` +
    `<audio><numOutputChannels>2</numOutputChannels><format>${aChars}</format>\n${atracks}\n</audio>\n</media>\n${marks}\n</sequence>\n</xmeml>\n`;
}

// copy finished files to a second disk (e.g. a USB drive) — refuses to "back up" onto the same disk
async function backupTake(room, t, out) {
  const dir = settings.backupDir;
  if (!dir) { t.backup = null; return; }
  try {
    let probeDir = dir; while (!fs.existsSync(probeDir)) probeDir = path.dirname(probeDir);
    if (fs.statSync(probeDir).dev === fs.statSync(DATA_DIR).dev) throw new Error('Backup folder is on the same disk as the recordings — is the backup drive plugged in?');
    const stamp = new Date(t.started).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const dest = path.join(dir, fileSafe(room.name), `Take ${t.n} - ${stamp}`);
    await fsp.mkdir(dest, { recursive: true });
    for (const o of t.outputs) await fsp.copyFile(path.join(out, o.file), path.join(dest, o.file));
    t.backup = { ok: true, at: Date.now(), path: dest };
  } catch (e) { t.backup = { ok: false, at: Date.now(), error: e.message }; console.warn('[backup]', e.message); }
}

function mailer() {
  const s = settings.smtp;
  if (!nodemailer || !s.host) return null;
  const local = /^(localhost|127\.|::1)/.test(s.host);
  return nodemailer.createTransport({ host: s.host, port: +s.port || 587, secure: +s.port === 465, auth: s.user ? { user: s.user, pass: s.pass } : undefined, tls: local ? { rejectUnauthorized: false } : undefined, connectionTimeout: 15000 });
}
async function notifyReady(room, t) {
  const to = String(room.notifyEmail || '').split(/[,;\s]+/).filter(x => /@/.test(x));
  const tr = mailer();
  if (!to.length || !tr) return;
  const link = settings.publicUrl ? `${settings.publicUrl}/m/${room.id}?k=${room.hostKey}` : '';
  const size = t.outputs.reduce((a, o) => a + o.size, 0);
  const people = [...new Set(Object.values(t.segs).map(s => s.name))].join(', ');
  const lines = [`Take ${t.n} of "${room.name}" is ready to download.`, '',
    `Who: ${people}`, `Length: ${hms((t.stopped || t.started) - t.started)}`, `Files: ${t.outputs.length} (${(size / 1073741824).toFixed(2)} GB)`,
    (t.markers || []).length ? `Markers: ${t.markers.length}` : '', t.backup ? (t.backup.ok ? 'Backup: copied ✓' : `Backup: FAILED — ${t.backup.error}`) : '',
    t.error ? `\nSome files had problems:\n${t.error}` : '', '', link ? `Download: ${link}` : ''].filter(l => l !== null).join('\n');
  await tr.sendMail({ from: settings.smtp.from || settings.smtp.user, to: to.join(', '), subject: t.notified ? `🔄 ${room.name} — Take ${t.n} updated (late uploads arrived)` : `✅ ${room.name} — Take ${t.n} is ready`, text: lines });
  t.notified = true; saveTake(t, true);
  console.log(`[mail] sent take ${t.n} ready to ${to.join(', ')}`);
}

// ---------- web server ----------
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use((req, res, next) => {
  // remember the public address (for links in emails) the first time someone visits over HTTPS
  if (!settings.publicUrl && req.headers['x-forwarded-proto'] === 'https' && req.headers.host && !/^(localhost|127\.)/.test(req.headers.host)) {
    settings.publicUrl = 'https://' + req.headers.host; saveSettings();
  }
  next();
});
// never let Cloudflare or the browser keep stale copies of pages, room lists or downloads
const NO_STORE = { 'Cache-Control': 'no-store, max-age=0', 'CDN-Cache-Control': 'no-store', 'Cloudflare-CDN-Cache-Control': 'no-store' };
app.use((req, res, next) => { res.set(NO_STORE); next(); });
const pub = path.join(__dirname, 'public');
app.use(express.static(pub, { index: false, etag: false, lastModified: false, cacheControl: false }));
// pages get the version stamped onto their script/style links so an update always loads fresh
const page = f => (req, res) => res.type('html').send(fs.readFileSync(path.join(pub, f), 'utf8').replace(/(\.(?:js|css))(["'])/g, `$1?v=${VERSION}$2`));
app.get('/', page('index.html'));
app.get('/r/:id', page('room.html'));
app.get('/m/:id', page('manage.html'));
app.get('/api/info', (req, res) => res.json({ name: STUDIO_NAME, admin: isAdmin(req), maxPeople: MAX_PEOPLE, version: VERSION }));

// connection test (used by the lobby)
const SPEED_BUF = crypto.randomBytes(4 * 1024 * 1024);
app.get('/api/ping', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ s: Date.now() }); });
app.get('/api/speedtest', (req, res) => {
  res.set('Cache-Control', 'no-store'); res.type('application/octet-stream');
  res.end(SPEED_BUF.subarray(0, Math.min(SPEED_BUF.length, Math.max(1024, +req.query.bytes || SPEED_BUF.length))));
});
app.post('/api/speedtest', express.raw({ type: () => true, limit: '16mb' }), (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ bytes: req.body ? req.body.length : 0 }); });

app.post('/api/login', express.json(), (req, res) => {
  if (!safeEq(String((req.body || {}).password || ''), ADMIN_PASSWORD)) return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 800);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `ps_admin=${encodeURIComponent(adminCookie())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});
app.post('/api/logout', (req, res) => { res.setHeader('Set-Cookie', 'ps_admin=; Path=/; Max-Age=0'); res.json({ ok: true }); });

const needAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Please log in' }));

// studio settings (admin)
const MASK = '••••••••';
async function backupStatus() {
  const dir = settings.backupDir;
  if (!dir) return { set: false };
  let p = dir; while (!fs.existsSync(p)) p = path.dirname(p);
  const same = fs.statSync(p).dev === fs.statSync(DATA_DIR).dev;
  let free = null; try { const s = await fsp.statfs(p); free = s.bavail * s.bsize; } catch {}
  return { set: true, ok: !same, free, msg: same ? 'That folder is on the same disk as the recordings — is the backup drive plugged in / mounted?' : '' };
}
app.get('/api/settings', needAdmin, async (req, res) => {
  res.json({ smtp: { ...settings.smtp, pass: settings.smtp.pass ? MASK : '' }, turn: { keyId: settings.turn.keyId, token: settings.turn.token ? MASK : '' },
    backupDir: settings.backupDir, publicUrl: settings.publicUrl, backup: await backupStatus(), emailAvailable: !!nodemailer, turnError: cfIce.error });
});
app.post('/api/settings', needAdmin, express.json(), async (req, res) => {
  const b = req.body || {};
  if (b.smtp) for (const k of ['host', 'port', 'user', 'pass', 'from']) if (k in b.smtp && !(k === 'pass' && b.smtp.pass === MASK)) settings.smtp[k] = k === 'port' ? (parseInt(b.smtp.port, 10) || 587) : cleanText(b.smtp[k], 200);
  if (b.turn) { if ('keyId' in b.turn) settings.turn.keyId = cleanText(b.turn.keyId, 200); if ('token' in b.turn && b.turn.token !== MASK) settings.turn.token = cleanText(b.turn.token, 400); cfIce = { at: 0, list: null, error: '' }; }
  if ('backupDir' in b) settings.backupDir = cleanText(b.backupDir, 300);
  if ('publicUrl' in b) settings.publicUrl = cleanText(b.publicUrl, 200).replace(/\/+$/, '');
  if (settings.backupDir) { try { fs.mkdirSync(settings.backupDir, { recursive: true }); } catch (e) { return res.status(400).json({ error: `Can't use that backup folder: ${e.message}` }); } }
  saveSettings();
  res.json({ ok: true, backup: await backupStatus() });
});
app.post('/api/settings/test-email', needAdmin, express.json(), async (req, res) => {
  const tr = mailer();
  if (!tr) return res.status(400).json({ error: nodemailer ? 'Fill in the email server first.' : 'Email module missing — re-run the installer.' });
  try { await tr.sendMail({ from: settings.smtp.from || settings.smtp.user, to: cleanText((req.body || {}).to, 200), subject: `${STUDIO_NAME}: test email`, text: 'Email from your Podcast Studio works ✓' }); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/settings/test-turn', needAdmin, async (req, res) => {
  if (!settings.turn.keyId || !settings.turn.token) return res.status(400).json({ error: 'Fill in the Key ID and API token first.' });
  try { const l = await cloudflareIce(true); res.json({ ok: true, servers: (l || []).reduce((a, x) => a + x.urls.length, 0) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

function takeSummary(t) {
  return { id: t.id, n: t.n, started: t.started, stopped: t.stopped, status: t.status, progress: t.progress, error: t.error,
    people: [...new Set(Object.values(t.segs).map(s => s.name))], outputs: t.outputs || [], markers: t.markers || [], backup: t.backup || null,
    totalSize: (t.outputs || []).reduce((a, o) => a + o.size, 0) };
}
function roomSummary(r) {
  const lr = live.get(r.id);
  return { id: r.id, name: r.name, created: r.created, hostKey: r.hostKey, waitingRoom: r.waitingRoom !== false, notifyEmail: r.notifyEmail || '',
    online: lr ? [...lr.peers.values()].map(p => p.name) : [], recording: !!(lr && lr.take), takes: listTakes(r.id).map(takeSummary) };
}

app.get('/api/rooms', needAdmin, async (req, res) => {
  const rooms = fs.readdirSync(ROOMS_DIR).map(loadRoom).filter(Boolean).sort((a, b) => b.created - a.created).map(roomSummary);
  res.json({ rooms, disk: await diskInfo(), version: VERSION });
});
app.post('/api/rooms', needAdmin, express.json(), (req, res) => {
  const r = { id: rid(10), name: cleanName((req.body || {}).name || 'My show'), created: Date.now(), hostKey: rid(16), waitingRoom: true, notifyEmail: '' };
  saveRoom(r);
  res.json(roomSummary(r));
});
app.delete('/api/rooms/:id', needAdmin, async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  const lr = live.get(r.id);
  if (lr && lr.peers.size) return res.status(409).json({ error: 'People are in this room right now' });
  for (const k of takeCache.keys()) if (k.startsWith(r.id + '/')) takeCache.delete(k);
  await fsp.rm(roomDir(r.id), { recursive: true, force: true });
  res.json({ ok: true });
});
app.get('/api/rooms/:id', async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'This link is not valid' });
  res.json({ ...roomSummary(r), disk: await diskInfo(), emailReady: !!(nodemailer && settings.smtp.host) });
});
app.post('/api/rooms/:id/settings', express.json(), (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const b = req.body || {};
  if ('waitingRoom' in b) r.waitingRoom = !!b.waitingRoom;
  if ('notifyEmail' in b) r.notifyEmail = cleanText(b.notifyEmail, 300);
  if ('name' in b && b.name) r.name = cleanName(b.name);
  saveRoom(r);
  res.json(roomSummary(r));
});
app.post('/api/rooms/:id/takes/:take/rebuild', (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status === 'recording') return res.status(409).json({ error: 'Still recording' });
  queueProcess(r.id, t.id);
  res.json({ ok: true });
});
app.delete('/api/rooms/:id/takes/:take', async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (['recording', 'processing', 'queued'].includes(t.status)) return res.status(409).json({ error: 'Busy — try again in a moment' });
  takeCache.delete(r.id + '/' + t.id);
  await fsp.rm(takeDir(r.id, t.id), { recursive: true, force: true });
  res.json({ ok: true });
});

// downloads
app.get('/dl/:room/:take/:file', (req, res) => {
  const r = loadRoom(req.params.room);
  if (!canManage(req, r)) return res.status(403).send('Not allowed');
  const t = loadTake(r.id, req.params.take);
  const name = path.basename(req.params.file);
  if (!t || !(t.outputs || []).some(o => o.file === name)) return res.status(404).send('Not found');
  res.download(path.join(takeDir(r.id, t.id), 'out', name), `${fileSafe(r.name)} - Take ${t.n} - ${name}`);
});
app.get('/zip/:room/:take', (req, res) => {
  const r = loadRoom(req.params.room);
  if (!canManage(req, r)) return res.status(403).send('Not allowed');
  const t = loadTake(r.id, req.params.take);
  if (!t || !t.outputs.length) return res.status(404).send('Nothing to download yet');
  const base = `${fileSafe(r.name)} - Take ${t.n}`;
  res.attachment(base + '.zip');
  const z = archiver('zip', { store: true });
  z.on('error', e => { console.error(e); res.destroy(); });
  z.pipe(res);
  for (const o of t.outputs) z.file(path.join(takeDir(r.id, t.id), 'out', o.file), { name: `${base}/${o.file}` });
  z.finalize();
});

// uploads from browsers while recording
const fileLocks = new Map();
function withLock(key, fn) { const prev = fileLocks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); fileLocks.set(key, next.catch(() => {})); return next; }
function segFromReq(req, res) {
  const { room, take, seg } = req.params;
  if (!validId(room) || !validId(take) || !validId(seg) || !safeEq(String(req.query.tok || ''), segToken(room, take, seg))) { res.status(403).json({ error: 'bad token' }); return null; }
  const t = loadTake(room, take);
  const s = t && t.segs[seg];
  if (!s) { res.status(404).json({ error: 'unknown' }); return null; }
  return { t, s, dir: path.join(takeDir(room, take), 'segs', seg) };
}
const raw = express.raw({ type: () => true, limit: '64mb' });

app.post('/up/:room/:take/:seg/audio', raw, async (req, res) => {
  const x = segFromReq(req, res); if (!x) return;
  const s0 = Number(req.query.s), tt = Number(req.query.t), rate = Number(req.query.rate) || 48000;
  const body = req.body;
  if (!Number.isInteger(s0) || s0 < 0 || s0 > rate * 3600 * 16 || !Number.isFinite(tt) || !Buffer.isBuffer(body) || body.length % 3) return res.status(400).json({ error: 'bad chunk' });
  const file = path.join(x.dir, 'audio.pcm');
  try {
    await withLock(file, async () => {
      const fh = await fsp.open(file, fs.existsSync(file) ? 'r+' : 'w+');
      try { await fh.write(body, 0, body.length, s0 * 3); } finally { await fh.close(); }
    });
    const a = x.s.audio || (x.s.audio = { rate, first: null, last: null, end: 0 });
    if (!a.first || s0 < a.first.s) a.first = { s: s0, t: tt };
    if (!a.last || s0 > a.last.s) a.last = { s: s0, t: tt };
    a.end = Math.max(a.end, s0 + body.length / 3);
    saveTake(x.t);
    lateUpload(req.params.room, x.t);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'write failed' }); }
});
app.post('/up/:room/:take/:seg/video', raw, async (req, res) => {
  const x = segFromReq(req, res); if (!x) return;
  const i = Number(req.query.i), r = Number(req.query.r || 0), screen = req.query.src === 'screen';
  if (!Number.isInteger(i) || i < 0 || i > 999999 || !Number.isInteger(r) || r < 0 || r > 999 || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: 'bad chunk' });
  try {
    const sub = path.join(x.dir, screen ? 'screen' : 'video');
    await fsp.mkdir(sub, { recursive: true });
    await fsp.writeFile(path.join(sub, (screen ? String(r).padStart(3, '0') + '-' : '') + String(i).padStart(6, '0') + '.part'), req.body);
    const mime = String(req.query.mime || 'video/webm').slice(0, 80);
    let v;
    if (screen) { x.s.screens = x.s.screens || {}; v = x.s.screens[r] || (x.s.screens[r] = { mime, st: null, chunks: 0 }); }
    else v = x.s.video || (x.s.video = { mime, st: null, chunks: 0 });
    if (req.query.st && !v.st) v.st = Number(req.query.st);
    v.chunks = Math.max(v.chunks, i + 1);
    saveTake(x.t);
    lateUpload(req.params.room, x.t);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'write failed' }); }
});
app.post('/up/:room/:take/:seg/done', (req, res) => {
  const x = segFromReq(req, res); if (!x) return;
  x.s.done = true;
  saveTake(x.t, true);
  res.json({ ok: true });
  checkTakeReady(req.params.room, req.params.take);
});

// ---------- websocket: signalling, clock sync, recording control, chat ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', ws => {
  let peer = null, waiting = null, lr = null, roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  async function doJoin(room, info) {
    // same browser reconnecting: drop its old connection
    for (const p of lr.peers.values()) if (p.clientId === info.clientId) { lr.peers.delete(p.id); broadcast(lr, { t: 'peer-left', id: p.id }); try { p.ws.close(); } catch {} }
    if (lr.peers.size >= MAX_PEOPLE) { send(ws, { t: 'error', code: 'full', msg: `This studio is full (max ${MAX_PEOPLE} people).` }); return; }
    peer = { id: rid(8), ws, ...info, state: {}, screenId: null };
    lr.peers.set(peer.id, peer);
    admit(roomId, lr, info.clientId);
    broadcast(lr, { t: 'peer-joined', peer: peerInfo(peer) }, peer.id);
    const ice = await iceServers();
    if (ws.readyState !== 1) return;
    const t = lr.take ? loadTake(roomId, lr.take) : null;
    send(ws, { t: 'welcome', id: peer.id, isHost: peer.isHost, roomName: room.name, studio: STUDIO_NAME, ice, maxPeople: MAX_PEOPLE, version: VERSION,
      peers: [...lr.peers.values()].filter(p => p !== peer).map(peerInfo),
      recording: t ? { take: t.id, started: t.started, n: t.n, markers: (t.markers || []).length } : null,
      roomToneSeconds: ROOM_TONE_SECONDS, roomTone: lr.roomTone && lr.roomTone.end > Date.now() ? lr.roomTone : null,
      chat: lr.chat.slice(-100), waiting: peer.isHost ? [...lr.waiting.values()].map(w => ({ id: w.id, name: w.name })) : [],
      disk: peer.isHost ? await diskInfo() : null, gbPerPersonHour: GB_PER_PERSON_HOUR, minFreeGB: MIN_FREE_GB });
    if (t) {
      const existing = info.recSeg && t.segs[info.recSeg] && t.segs[info.recSeg].clientId === info.clientId ? info.recSeg : null;
      // a fresh page for the same person: their earlier part can't send any more, so stop waiting on it
      if (!existing) for (const sg of Object.values(t.segs)) if (sg.clientId === info.clientId && !sg.done) sg.done = true;
      peer.seg = existing || newSeg(t, peer);
      if (!existing) send(ws, startMsg(t, peer.seg));
    }
    console.log(`[room] ${peer.name}${peer.isHost ? ' (host)' : ''} joined "${room.name}" (${lr.peers.size} in room)`);
  }

  ws.on('message', async buf => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (m.t === 'join' && !peer && !waiting) {
      const room = loadRoom(m.room);
      if (!room) return send(ws, { t: 'error', code: 'noroom', msg: 'This studio link is not valid.' });
      roomId = room.id; lr = liveRoom(roomId);
      const info = { clientId: validId(m.clientId) ? m.clientId : rid(12), name: cleanName(m.name), isHost: !!hostKeyOk(room, m.key), camId: validStreamId(m.camId), recSeg: m.recSeg };
      // people already in the current take (e.g. after a server restart) never get stuck in the waiting room
      const curTake = lr.take && loadTake(roomId, lr.take);
      if (curTake && Object.values(curTake.segs).some(sg => sg.clientId === info.clientId)) admit(roomId, lr, info.clientId);
      if (!info.isHost && room.waitingRoom !== false && !lr.admitted.has(info.clientId)) {
        waiting = { id: rid(8), ws, name: info.name, go: () => { waiting = null; doJoin(room, info); } };
        lr.waiting.set(waiting.id, waiting);
        send(ws, { t: 'waiting', hostHere: [...lr.peers.values()].some(p => p.isHost) });
        toHosts(lr, { t: 'knock', id: waiting.id, name: waiting.name });
        return;
      }
      return doJoin(room, info);
    }
    if (!peer) return;
    switch (m.t) {
      case 'signal': { const to = lr.peers.get(m.to); if (to) send(to.ws, { t: 'signal', from: peer.id, data: m.data }); return; }
      case 'state': peer.state = m.state || {}; broadcast(lr, { t: 'peer-state', id: peer.id, state: peer.state }, peer.id); return;
      case 'screen': peer.screenId = m.on ? validStreamId(m.streamId) : null; broadcast(lr, { t: 'screen', id: peer.id, on: !!m.on, streamId: peer.screenId }, peer.id); return;
      case 'chat': {
        const text = cleanText(m.text, 500); if (!text) return;
        const msg = { t: 'chat', id: rid(6), from: peer.name, pid: peer.id, text, ts: Date.now() };
        lr.chat.push(msg); if (lr.chat.length > 200) lr.chat.shift();
        broadcast(lr, msg);
        const tk = lr.take && loadTake(roomId, lr.take);
        if (tk) { tk.chat = tk.chat || []; tk.chat.push({ at: msg.ts - tk.started, from: msg.from, text }); saveTake(tk); }
        return;
      }
    }
    if (!peer.isHost) return;
    switch (m.t) {
      case 'record':
        if (m.on && !lr.take) {
          const d = await diskInfo();
          if (d && d.free < MIN_FREE_GB * 1073741824) return send(ws, { t: 'notice', level: 'error', text: `Can't start: the studio server only has ${(d.free / 1073741824).toFixed(1)} GB free. Delete old takes first.` });
          startRecording(roomId, lr, !!m.roomTone);
        } else if (!m.on && lr.take) stopRecording(roomId, lr);
        return;
      case 'roomtone': if (lr.take && !(lr.roomTone && lr.roomTone.end > Date.now())) { const t = loadTake(roomId, lr.take); if (t) beginRoomTone(t, lr); } return;
      case 'marker': {
        const t = lr.take && loadTake(roomId, lr.take); if (!t) return;
        t.markers = t.markers || [];
        const mk = { at: Date.now() - t.started, label: cleanText(m.label, 80) || `Marker ${t.markers.length + 1}`, by: peer.name };
        t.markers.push(mk); saveTake(t, true);
        toHosts(lr, { t: 'marker', n: t.markers.length, ...mk });
        return;
      }
      case 'admit': {
        const w = lr.waiting.get(m.id); if (!w) return;
        lr.waiting.delete(m.id);
        toHosts(lr, { t: 'knock-gone', id: m.id });
        if (m.allow) w.go();
        else { send(w.ws, { t: 'error', code: 'denied', msg: 'The host didn\'t let you in this time.' }); try { w.ws.close(); } catch {} }
        return;
      }
      case 'kick': { const p = lr.peers.get(m.id); if (p && p !== peer) { lr.admitted.delete(p.clientId); try { const f = path.join(roomDir(roomId), 'admitted.json'); const sv = readJSON(f, {}) || {}; delete sv[p.clientId]; writeJSON(f, sv); } catch {} send(p.ws, { t: 'error', code: 'kicked', msg: 'The host removed you from the studio.' }); p.ws.close(); } return; }
    }
  });
  ws.on('close', () => {
    if (waiting && lr) { lr.waiting.delete(waiting.id); toHosts(lr, { t: 'knock-gone', id: waiting.id }); }
    if (!peer || !lr) return;
    if (lr.peers.get(peer.id) === peer) {
      lr.peers.delete(peer.id);
      broadcast(lr, { t: 'peer-left', id: peer.id });
      console.log(`[room] ${peer.name} left (${lr.peers.size} in room)`);
    }
    for (const t of listTakes(roomId)) if (t.status === 'waiting') setTimeout(() => checkTakeReady(roomId, t.id), 60 * 1000);
    if (lr.peers.size === 0 && lr.take) scheduleEmptyStop(roomId, lr, 5);
  });
});
function scheduleEmptyStop(roomId, lr, minutes) {
  const take = lr.take;
  setTimeout(() => { if (lr.peers.size === 0 && lr.take === take) { console.log('[rec] nobody came back — stopping take'); stopRecording(roomId, lr); } }, minutes * 60 * 1000);
}
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch {} } }, 20000);
// hosts get server health every 30 s
setInterval(async () => { const d = await diskInfo(); for (const lr of live.values()) if (lr.peers.size) toHosts(lr, { t: 'server', disk: d }); }, 30000);

// ---------- start-up: carry on after a restart / power cut ----------
for (const id of fs.readdirSync(ROOMS_DIR)) {
  if (!loadRoom(id)) continue;
  for (const t of listTakes(id)) {
    if (t.status === 'recording') {
      // the take was still running: keep it open so everyone's browser reconnects and carries on
      const lr = liveRoom(id);
      if (!lr.take) { lr.take = t.id; console.log(`[rec] resuming take ${t.n} in "${id}" after restart`); scheduleEmptyStop(id, lr, 10); }
      else { t.status = 'waiting'; t.stopped = t.stopped || Date.now(); saveTake(t, true); queueProcess(id, t.id); }
    } else if (['waiting', 'queued', 'processing'].includes(t.status)) queueProcess(id, t.id);
  }
}

server.listen(PORT, BIND, () => console.log(`${STUDIO_NAME} v${VERSION} running on http://${BIND}:${PORT}  (recordings in ${DATA_DIR})`));
