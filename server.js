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
const log = require('./log');
const { run } = require('./proc');
const express = require('express');
const { WebSocketServer } = require('ws');
const { ZipArchive } = require('archiver');
const post = require('./post');
const treat = require('./treat');
const createTranscriber = require('./transcribe');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* email optional */ }

const VERSION = '0.9.1';

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
const STUDIO_NAME = process.env.STUDIO_NAME || 'Rolling';
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
if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); log.warn('config', 'SECRET not set in .env — logins reset on restart'); }
if (!ADMIN_PASSWORD) { ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex'); log.warn('config', 'ADMIN_PASSWORD not set — temporary password: ' + ADMIN_PASSWORD); }

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

const roomDir = id => path.join(ROOMS_DIR, id);
const takeDir = (room, take) => path.join(roomDir(room), 'takes', take);

function readJSON(p, fallback = null) {
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') log.warn('files', `can't read ${p}:`, e); return fallback; }
  try { return JSON.parse(text); } catch (e) {
    const bad = `${p}.corrupt-${Date.now()}`;
    log.error('files', `${p} is damaged (${e.message}) — keeping a copy at ${bad}`);
    try { fs.copyFileSync(p, bad); } catch (e2) { log.warn('files', 'could not keep a copy of the damaged file', e2); }
    return fallback;
  }
}
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
    cloud: Object.assign({ remote: '' }, s.cloud), // rclone remote + folder, e.g. "gdrive:Rolling" (see docs/cloud-backup.md)
    publicUrl: s.publicUrl || process.env.PUBLIC_URL || '',
    transcribe: Object.assign({ enabled: true, model: process.env.WHISPER_MODEL || 'base.en', language: 'auto' }, s.transcribe),
    autoCompact: !!s.autoCompact,
    clean: treat.cfg(s.clean),
    fps: s.fps === 30 ? 30 : 25,     // frame rate for the on-screen timecode, the MP4s and the editor XML (25 = UK/Europe)        // clean-up files made after each take (the untouched recordings are always kept)
    adminHash: s.adminHash || '',   // set once the password is changed from the dashboard (scrypt, never stored in plain text)
    sessionGen: s.sessionGen || 0,  // bumped on password change so old logins stop working
  };
})();
// Rolling Desk "host it on this computer": the app tells the studio its public internet address (a Cloudflare
// tunnel) — it can change while running, so links on every page come from here, not from the address bar
let linkBase = (process.env.ROLLING_PUBLIC_URL || '').replace(/\/+$/, '');
const validLink = u => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(u);
if (linkBase && !validLink(linkBase)) { log.warn('config', `ROLLING_PUBLIC_URL ${linkBase} isn't an https address — ignored`); linkBase = ''; }
if (linkBase) settings.publicUrl = linkBase;
if (process.send) process.on('disconnect', () => { log.warn('config', 'Rolling Desk closed — stopping the studio'); process.exit(0); }); // never left running on its own
if (process.send) process.on('message', m => {
  if (!m || typeof m.publicUrl !== 'string') return;
  const u = m.publicUrl.replace(/\/+$/, '');
  if (!validLink(u)) return log.warn('config', `ignored a public address that isn't https: ${u}`);
  linkBase = u; settings.publicUrl = u; log.info('config', `guests reach this studio at ${u}`);
});
function saveSettings() { writeJSON(SETTINGS_FILE, settings); try { fs.chmodSync(SETTINGS_FILE, 0o600); } catch (e) { log.warn('settings', 'could not make settings.json private', e); } }

const transcriber = createTranscriber({ settings, FFMPEG, workDir: path.join(DATA_DIR, '.work', 'transcribe'), takeDir: (r, t) => takeDir(r, t), saveTake: (t, now) => saveTake(t, now) });

// ---------- admin password ----------
function hashPassword(pw) { const salt = crypto.randomBytes(16); return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`; }
function checkPassword(pw) {
  pw = String(pw || '');
  if (!settings.adminHash) return safeEq(pw, ADMIN_PASSWORD);
  const [, salt, hash] = settings.adminHash.split(':');
  return crypto.timingSafeEqual(crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
}
function setPassword(pw) { settings.adminHash = hashPassword(pw); settings.sessionGen++; saveSettings(); }
// forgot it?  run:  node server.js --reset-password   (the installer adds: sudo podcast-studio-reset-password)
if (process.argv.includes('--reset-password')) {
  const pw = crypto.randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);
  setPassword(pw);
  process.stdout.write(`New admin password: ${pw}\n(Restart the studio so it takes effect: sudo systemctl restart podcast-studio)\n`);
  process.exit(0);
}

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
  const write = () => { saveTimers.delete(k); try { fs.mkdirSync(takeDir(t.room, t.id), { recursive: true }); writeJSON(path.join(takeDir(t.room, t.id), 'take.json'), t); } catch (e) { log.error('takes', `could not save take ${t.id}`, e); } };
  if (now) { clearTimeout(saveTimers.get(k)); write(); return; }
  if (!saveTimers.has(k)) saveTimers.set(k, setTimeout(write, 1000));
}
function listTakes(room) {
  const d = path.join(roomDir(room), 'takes');
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).map(id => loadTake(room, id)).filter(Boolean).sort((a, b) => b.started - a.started);
}
// what the Health panel shows about the studio itself, in one go
async function studioStatus() {
  return {
    version: VERSION, disk: await diskInfo(), making: queued.size, // takes waiting for or having their files made
    transcripts: transcriber.available() ? (transcriber.enabled() ? 'on' : 'off') : 'missing',
    backup: settings.backupDir || '', cloud: settings.cloud.remote || '', email: !!(nodemailer && settings.smtp.host),
    relay: !!(settings.turn.keyId && settings.turn.token) || !!process.env.TURN_URLS,
  };
}
async function diskInfo() { try { const s = await fsp.statfs(DATA_DIR); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; } }

// ---------- relay (TURN) for guests on strict networks ----------
let cfIce = { at: 0, list: null, error: '' };
async function cloudflareIce(force) {
  const { keyId, token } = settings.turn;
  if (!keyId || !token) return null;
  if (!force && cfIce.list && Date.now() - cfIce.at < 3600e3) return cfIce.list;
  try {
    if (process.env.NO_EXTERNAL_CALLS) throw new Error('External calls blocked by NO_EXTERNAL_CALLS');
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error(`Cloudflare said ${r.status}${r.status === 401 || r.status === 403 ? ' (check the Key ID and API token)' : ''}`);
    const j = await r.json();
    let s = j.iceServers; if (!Array.isArray(s)) s = [s];
    const list = s.filter(Boolean).map(x => ({ ...x, urls: (Array.isArray(x.urls) ? x.urls : [x.urls]).filter(u => u && !/:53(\?|$)/.test(u)) })).filter(x => x.urls.length);
    cfIce = { at: Date.now(), list, error: '' };
  } catch (e) { cfIce.error = e.message; log.warn('turn', e.message); if (force) throw e; }
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
function adminCookie() { const exp = Date.now() + 30 * 864e5; return `${exp}.${hmac(`admin.${settings.sessionGen}.${exp}`)}`; }
function isAdmin(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)ps_admin=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = decodeURIComponent(m[1]).split('.');
  return +exp > Date.now() && safeEq(sig || '', hmac(`admin.${settings.sessionGen}.${exp}`));
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
    live.set(id, { id, green: new Set(), peers: new Map(), waiting: new Map(), admitted, take: null, roomTone: null, chat: [] });
  }
  return live.get(id);
}
// remember who the host let in (12 h) so a reconnect or server restart doesn't bounce them back to the waiting room
function admit(roomId, lr, clientId) {
  if (lr.admitted.has(clientId)) return;
  lr.admitted.add(clientId);
  try { const f = path.join(roomDir(roomId), 'admitted.json'); const saved = readJSON(f, {}) || {}; saved[clientId] = Date.now(); writeJSON(f, saved); } catch (e) { log.warn('rooms', 'could not remember an admitted guest', e); }
}
function send(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(lr, msg, exceptId) { for (const p of lr.peers.values()) if (p.id !== exceptId) send(p.ws, msg); }
function toHosts(lr, msg) { for (const p of lr.peers.values()) if (p.isHost) send(p.ws, msg); }
const peerInfo = p => ({ id: p.id, name: p.name, isHost: p.isHost, control: !!p.control, state: p.state || {}, camId: p.camId, screenId: p.screenId || null, green: !!p.green, devices: p.devices || null });
// green room: a guest there only sees and hears the hosts (and the hosts them) — nobody else, and they aren't recorded
const SCENE_SLOTS = ['A', 'B', 'C'], SCRIPT_MAX = 60000;
const scriptFor = (room, p) => (room.script && room.script.text && (p.isHost || room.script.share === 'all') ? room.script : null);
const canSee = (a, b) => a === b || a.isHost || b.isHost || (!a.green && !b.green);

function newSeg(t, peer) {
  const segId = rid(10);
  t.segs[segId] = { id: segId, clientId: peer.clientId, name: peer.name, created: Date.now(), done: false, audio: null, video: null, screens: {} };
  fs.mkdirSync(path.join(takeDir(t.room, t.id), 'segs', segId, 'video'), { recursive: true });
  saveTake(t, true);
  return segId;
}
function startMsg(t, segId) { return { t: 'record-start', take: t.id, started: t.started, seg: segId, tok: segToken(t.room, t.id, segId) }; }

function startRecording(roomId, lr, roomTone, episode) {
  const room = loadRoom(roomId);
  const n = listTakes(roomId).reduce((a, t) => Math.max(a, t.n), 0) + 1;
  const t = { id: rid(10), room: roomId, n, started: Date.now(), stopped: null, status: 'recording', progress: '', error: '',
    segs: {}, outputs: [], roomTones: [], markers: [], chat: [], backup: null, levels: {}, episode: null, rides: {}, coughs: {} };
  if (episode && (episode.n || episode.title)) {
    t.episode = { n: cleanText(episode.n, 12), title: cleanText(episode.title, 80) };
    const num = parseInt(t.episode.n, 10);
    if (room && Number.isFinite(num) && num > (room.lastEpisode || 0)) { room.lastEpisode = num; saveRoom(room); }
  }
  fs.mkdirSync(path.join(takeDir(roomId, t.id), 'segs'), { recursive: true });
  saveTake(t, true);
  lr.take = t.id;
  for (const p of lr.peers.values()) { if (p.control || p.green) continue; const seg = newSeg(t, p); p.seg = seg; send(p.ws, startMsg(t, seg)); } // the green room isn't recorded
  broadcast(lr, { t: 'recording', on: true, take: t.id, started: t.started, n, roomTone: !!roomTone, nextEpisode: ((room && room.lastEpisode) || 0) + 1 });
  if (roomTone) beginRoomTone(t, lr, 1500);
  log.info('rec', `${room && room.name} take ${n} started`);
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
  // anyone still holding the cough button: close it at the end of the take
  for (const list of Object.values(t.coughs || {})) for (const c of list) if (c.to == null) c.to = t.stopped - t.started;
  for (const ev of t.board || []) if (ev.to == null) ev.to = ev.mode === 'bed' ? t.stopped - t.started : Math.min(t.stopped - t.started, ev.from + ev.dur * 1000);
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
const queued = new Map(), again = new Map();
function queueProcess(room, take, opts = {}) {
  const k = room + '/' + take;
  const merge = (a, b) => ({ docsOnly: !!(a && a.docsOnly && b.docsOnly), transcribe: !!((a && a.transcribe) || b.transcribe), clean: !!((a && a.clean) || b.clean) });
  if (queued.has(k)) { again.set(k, again.has(k) ? merge(again.get(k), opts) : opts); return; }
  queued.set(k, opts);
  const t = loadTake(room, take);
  if (t && t.status !== 'processing') { t.status = 'queued'; t.progress = 'Waiting to start'; t.pct = 0; saveTake(t, true); announce(room, t); }
  queue = queue.then(() => processTake(room, take, opts)).catch(e => log.error('build', `take ${take} failed:`, e)).finally(() => {
    queued.delete(k);
    if (again.has(k)) { const o = again.get(k); again.delete(k); queueProcess(room, take, o); }
  });
}
function ff(args, onProgress, durationSecs) {
  const prog = onProgress && durationSecs ? ['-progress', 'pipe:1', '-nostats'] : [];
  return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...prog, ...args], {
    stdout: 'ignore',
    onStdout: prog.length ? d => { const m = String(d).match(/out_time_us=(\d+)/g); if (m) onProgress(parseInt(m[m.length - 1].split('=')[1], 10) / 1e6 / durationSecs); } : undefined,
  });
}
async function probe(file, entries, stream) {
  try {
    const r = await run(FFPROBE, ['-v', 'error', ...(stream ? ['-select_streams', stream] : []), '-show_entries', entries, '-of', 'csv=p=0', file], { timeoutMs: 60000 });
    return r.stdout.trim();
  } catch (e) { log.warn('probe', `could not read ${path.basename(file)}`, e); return ''; }
}
// decode some audio to a 500 Hz loudness envelope (for lining video up against the lossless audio)
async function envelope(args) {
  let b;
  try { b = (await run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { stdout: 'buffer', timeoutMs: 600000 })).stdout; }
  catch (e) { log.warn('align', 'could not decode audio for lining up video', e); return null; }
  const n = Math.floor(b.length / 32), env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let a = 0; for (let j = 0; j < 16; j++) a += Math.abs(b.readInt16LE((i * 16 + j) * 2)); env[i] = a / 16; }
  return env;
}
// find where the camera file's own (compressed) sound best matches the lossless WAV; null if unsure
async function alignVideoUntraced(videoFile, wavFile, estimate) {
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

// tell hosts in the studio how the build is going
function announce(roomId, t) { const lr = live.get(roomId); if (lr) toHosts(lr, { t: 'build', take: t.id, n: t.n, status: t.status, pct: t.pct || 0, step: t.progress }); }
// the name used for downloads: "AOL Underground - Ep 42 - Title" or "AOL Underground - Take 3"
function takeLabel(room, t) {
  const e = t.episode || {};
  return e.n ? `${fileSafe(room.name)} - Ep ${fileSafe(String(e.n))}${e.title ? ' - ' + fileSafe(e.title) : ''}` : `${fileSafe(room.name)} - Take ${t.n}`;
}
function roomAssets(room) {
  const a = {};
  for (const k of ['intro', 'outro']) {
    const f = path.join(roomDir(room.id), 'assets', k + '.wav');
    if (room.assets && room.assets[k] && fs.existsSync(f)) a[k] = { ...room.assets[k], path: f };
  }
  return a;
}
// measure loudness (EBU R128 / BS.1770) with ffmpeg's ebur128 meter: integrated, range, true peak
async function measureLoudnessUntraced(file) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostats', '-nostdin', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { stdout: 'ignore', timeoutMs: 3 * 3600 * 1000 });
  const sum = r.stderr.slice(r.stderr.lastIndexOf('Summary'));
  const num = re => { const m = sum.match(re); return m ? (/inf/.test(m[1]) ? -Infinity : parseFloat(m[1])) : NaN; };
  const L = { I: num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/), LRA: num(/LRA:\s+(-?[\d.]+)\s+LU/), TP: num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/) };
  if (Number.isNaN(L.I)) throw new Error('loudness meter gave no reading');
  return L;
}
// turn a recording up/down to a loudness target with a plain gain change; a gentle peak limiter
// only steps in if the gain would push peaks above -1 dBTP
function normaliseFilter(L, target) {
  const gain = target - L.I;
  const limit = Number.isFinite(L.TP) && L.TP + gain > -1;
  return `volume=${gain.toFixed(2)}dB${limit ? ',alimiter=limit=0.85:level=false:attack=5:release=50' : ''}`;
}
const DOC_KINDS = new Set(['markers', 'chat', 'session', 'chapters', 'transcript', 'report', 'editlist']);
// clientId -> person name (the same names used for the files)
function takePeople(t) { const m = {}; for (const s of Object.values(t.segs)) if (s._person && !m[s.clientId]) m[s.clientId] = s._person; return m; }

async function processTakeUntraced(roomId, takeId, opts = {}) {
  const t = loadTake(roomId, takeId);
  const room = loadRoom(roomId);
  if (!t || !room) return;
  const dir = takeDir(roomId, takeId);
  const docsOnly = (opts.docsOnly || t.compacted) && (t.outputs || []).length > 0;
  // a full build happens in a separate folder and is swapped in at the end, so the previous files stay
  // downloadable (and a download already running never breaks) while a take is rebuilt
  const finalOut = path.join(dir, 'out');
  const out = docsOnly ? finalOut : path.join(dir, 'out.new');
  if (!docsOnly && (t.outputs || []).length && fs.existsSync(finalOut)) t.serving = t.serving || t.outputs;
  t.status = 'processing'; t.error = ''; t.pct = 0;

  // ---- progress: every step has a weight; the bar shows the share done ----
  let total = 0, done = 0, curW = 0, lastSave = 0;
  const report = f => {
    t.pct = Math.min(99, Math.round((100 * (done + Math.max(0, Math.min(1, f)) * curW)) / Math.max(1, total)));
    const now = Date.now();
    if (now - lastSave > 700 || f === 0) { lastSave = now; saveTake(t, true); announce(roomId, t); }
  };
  const begin = (label, w) => { curW = w; t.progress = label; report(0); };
  const finish = () => { done += curW; curW = 0; };
  const takeSecs = Math.max(1, ((t.stopped || Date.now()) - t.started) / 1000);

  if (!docsOnly) {
    await fsp.rm(out, { recursive: true, force: true });
    await fsp.mkdir(out, { recursive: true });
    t.outputs = []; t.levels = {};
  }
  // documents are rewritten in place (write-then-rename), so a download never finds them missing;
  // any document that isn't made again (e.g. all markers deleted) is removed afterwards
  const oldDocs = (t.outputs || []).filter(o => DOC_KINDS.has(o.kind)).map(o => o.file);
  if (docsOnly) t.outputs = t.outputs.filter(o => !DOC_KINDS.has(o.kind));
  const segs = Object.values(t.segs).sort((a, b) => a.created - b.created);

  // one name per person (clientId); repeated joins become "part 2", etc.
  const people = new Map();
  const usedNames = new Set(['mix - all voices', 'chat', 'markers', 'intro', 'outro', 'transcript']);
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
  const add = (file, kind, person) => { const st = fs.statSync(path.join(out, file)); t.outputs = t.outputs.filter(o => o.file !== file); t.outputs.push({ file, kind, person, size: st.size }); };
  const assets = roomAssets(room);

  const audioSegs = segs.filter(s => s.audio && s.audio.end > 0);
  const videoSegs = segs.filter(s => s.video && s.video.chunks > 0);
  const shares = [];
  for (const s of segs) for (const [r, sc] of Object.entries(s.screens || {})) if (sc.chunks > 0) shares.push({ s, r, sc });
  const nPeople = new Set(audioSegs.map(s => s.clientId)).size;
  const wantTranscript = transcriber.enabled() && !t.compacted && (!docsOnly || !!opts.transcribe);
  const previousTx = new Map(); // "Make transcript" starts again from the beginning, but never throws away a good transcript if the new run fails
  if (opts.transcribe && wantTranscript) for (const s of audioSegs) { previousTx.set(s, s.tx); s.tx = { done: 0, parts: [] }; }
  if (!docsOnly) total += audioSegs.length + nPeople * 4 + 2 + videoSegs.length * 8 + shares.length * 4;
  if (wantTranscript) total += 4;
  const wantTreat = !docsOnly || !!opts.clean;
  if (wantTreat) total += nPeople * 4 + 3;
  total += 1;

  if (!docsOnly) {
    // --- audio: lossless 24-bit WAV per person, lined up to the start of the take ---
    const byPerson = new Map(); // person name -> [{ file, from, to }]
    for (let i = 0; i < audioSegs.length; i++) {
      const s = audioSegs[i], a = s.audio;
      begin(`Audio ${i + 1} of ${audioSegs.length}`, 1);
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
          '-af', `aresample=48000${pad ? `,adelay=${pad}S:all=1` : ''}`, '-ar', '48000', '-c:a', 'pcm_s24le', path.join(out, tmp)], report, a.end / nominal);
        if (!byPerson.has(s._person)) byPerson.set(s._person, []);
        byPerson.get(s._person).push({ file: tmp, from: pad / 48000, to: pad / 48000 + a.end / nominal });
      } catch (e) { errors.push(`${s._label}: ${e.message}`); }
      finish();
    }
    // someone who dropped out and came back gets their parts joined into one file
    const wavs = [];
    for (const [person, parts] of byPerson) {
      const file = `${person}.wav`;
      try {
        if (parts.length === 1) await fsp.rename(path.join(out, parts[0].file), path.join(out, file));
        else {
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
        try { await ff(['-ss', from.toFixed(3), '-t', dur.toFixed(3), '-i', path.join(out, `${person}.wav`), '-c:a', 'pcm_s24le', path.join(out, file)]); add(file, 'roomtone', person); }
        catch (e) { errors.push(`${file}: ${e.message}`); }
      }
    }
    // --- level check (EBU R128) + normalised copies at -16 and -23 LUFS; originals untouched ---
    for (const person of byPerson.keys()) {
      const src = path.join(out, `${person}.wav`);
      if (!fs.existsSync(src)) { done += 4; continue; }
      begin(`Checking levels — ${person}`, 2);
      let L = null;
      try { L = await measureLoudness(src); L.verdict = post.verdict(L); } catch (e) { errors.push(`Level check ${person}: ${e.message}`); }
      t.levels[person] = L;
      finish();
      if (!L || !Number.isFinite(L.I)) { done += 2; continue; }
      for (const target of [-16, -23]) {
        begin(`Normalising ${person} to ${target} LUFS`, 1);
        const file = `${person} - normalised ${target} LUFS.wav`;
        try {
          await ff(['-i', src, '-af', normaliseFilter(L, target), '-ar', '48000', '-c:a', 'pcm_s24le', path.join(out, file)], report, takeSecs);
          add(file, 'normalised', person);
        } catch (e) { errors.push(`${file}: ${e.message}`); }
        finish();
      }
    }
    // --- mix of everyone + a rough mix with intro/outro, normalised to -16 LUFS ---
    begin('Mixing all voices', 1);
    if (wavs.length > 1) {
      const file = 'Mix - all voices.wav';
      const ins = wavs.flatMap(w => ['-i', path.join(out, w)]);
      try { await ff([...ins, '-filter_complex', `amix=inputs=${wavs.length}:duration=longest:normalize=0`, '-c:a', 'pcm_f32le', path.join(out, file)], report, takeSecs); }
      catch {
        try { await ff([...ins, '-filter_complex', `amix=inputs=${wavs.length}:duration=longest,volume=${wavs.length}`, '-c:a', 'pcm_f32le', path.join(out, file)]); }
        catch (e) { errors.push(`${file}: ${e.message}`); }
      }
      if (fs.existsSync(path.join(out, file))) {
        add(file, 'mix', 'Everyone');
        try { const L = await measureLoudness(path.join(out, file)); L.float = true; L.verdict = post.verdict(L); t.levels['Mix - all voices'] = L; } catch (e) { errors.push(`Level check (mix): ${e.message}`); }
      }
    }
    finish();
    for (const k of ['intro', 'outro']) if (assets[k]) { const f = k === 'intro' ? 'Intro.wav' : 'Outro.wav'; try { await fsp.copyFile(assets[k].path, path.join(out, f)); add(f, k, 'Everyone'); } catch (e) { errors.push(`${f}: ${e.message}`); } }

    // --- camera video: original file + an editor-friendly H.264 MP4 lined up to the take ---
    for (let i = 0; i < videoSegs.length; i++) {
      const s = videoSegs[i], v = s.video;
      const ext = /mp4/.test(v.mime || '') ? 'mp4' : 'webm';
      const camFile = path.join(dir, 'segs', s.id, 'camera.' + ext);
      begin(`Video ${i + 1} of ${videoSegs.length} — joining`, 1);
      await joinParts(path.join(dir, 'segs', s.id, 'video'), '', camFile);
      finish();
      if (!fs.existsSync(camFile)) { done += 7; continue; }
      const orig = `${s._label} - camera original.${ext}`;
      try { await fsp.link(camFile, path.join(out, orig)); } catch { await fsp.copyFile(camFile, path.join(out, orig)); }
      add(orig, 'video-original', s._label);
      let padS = Math.max(0, ((v.st || t.started) - t.started) / 1000);
      const wav = path.join(out, `${s._person}.wav`);
      begin(`Video ${i + 1} of ${videoSegs.length} — lining up with audio`, 1);
      if (fs.existsSync(wav)) {
        const exact = await alignVideo(path.join(out, orig), wav, padS).catch(() => null);
        if (exact !== null) padS = exact;
        log.info('rec', `${s._label} video offset ${padS.toFixed(3)}s (${exact !== null ? 'matched to audio' : 'from clock'})`);
      }
      finish();
      begin(`Video ${i + 1} of ${videoSegs.length} — converting to MP4`, 6);
      const file = `${s._label} - video.mp4`;
      try {
        await ff(['-fflags', '+genpts', '-i', path.join(out, orig),
          '-vf', `fps=${settings.fps},${padS > 0.01 ? `tpad=start_duration=${padS.toFixed(3)}:color=black,` : ''}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
          '-af', padS > 0.01 ? `adelay=${Math.round(padS * 1000)}:all=1` : 'anull',
          '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', path.join(out, file)], report, takeSecs);
        add(file, 'video', s._label);
      } catch (e) { errors.push(`${file}: ${e.message.slice(0, 300)}`); }
      finish();
    }

    // --- screen shares: one MP4 per share, lined up to the take ---
    for (let i = 0; i < shares.length; i++) {
      const { s, r, sc } = shares[i];
      const ext = /mp4/.test(sc.mime || '') ? 'mp4' : 'webm';
      const src = path.join(dir, 'segs', s.id, `screen-${r}.${ext}`);
      begin(`Screen share ${i + 1} of ${shares.length}`, 4);
      await joinParts(path.join(dir, 'segs', s.id, 'screen'), String(r).padStart(3, '0') + '-', src);
      if (fs.existsSync(src)) {
        const n = shares.filter((x, j) => j <= i && x.s._person === s._person).length;
        const file = `${s._person} - screen share ${n}.mp4`;
        const padS = Math.max(0, ((sc.st || t.started) - t.started) / 1000);
        try {
          await ff(['-fflags', '+genpts', '-i', src, '-an',
            '-vf', `fps=${settings.fps},${padS > 0.01 ? `tpad=start_duration=${padS.toFixed(3)}:color=black,` : ''}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`,
            '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', '20', '-movflags', '+faststart', path.join(out, file)], report, takeSecs);
          add(file, 'screen', s._person);
        } catch (e) {
          errors.push(`${file}: ${e.message.slice(0, 300)}`);
          const o = `${s._person} - screen share ${n} original.${ext}`;
          try { await fsp.link(src, path.join(out, o)); add(o, 'screen', s._person); } catch (e2) { log.warn('build', 'could not keep the original screen recording', e2); }
        }
      }
      finish();
    }

  }

  // --- treatment: cleaned voices, the Producer mix (live fader moves + coughs), long pauses ---
  if (wantTreat) await treatTake(t, segs, out, add, assets, errors, { begin, finish, report, takeSecs });

  // --- finish the transcript (most of it was done live while recording) ---
  if (wantTranscript) {
    begin(opts.transcribe ? 'Making the transcript' : 'Finishing the transcript', 4);
    try { await transcriber.finishTake(t, report); } catch (e) { errors.push('Transcript: ' + e.message); }
    finish();
    for (const s of audioSegs) {
      const prev = previousTx.get(s);
      if (s.tx && s.tx.error && prev && prev.parts && prev.parts.length) s.tx = { ...prev, error: s.tx.error + ' (kept the previous transcript)' };
    }
    // a transcript that failed must say so — never just "no file"
    const failed = audioSegs.filter(s => s.tx && s.tx.error);
    const lines = audioSegs.reduce((n, s) => n + ((s.tx && s.tx.parts.length) || 0), 0);
    if (failed.length) errors.push(`Transcript ${lines ? 'partly failed' : 'failed'} — ${failed.map(s => `${s._person}: ${s.tx.error}`).join('; ')}`);
  }

  // --- documents: transcript, chapters, markers, level report, chat, session files ---
  begin('Making the transcript, chapters and session files', 1);
  try { await buildDocs(t, room, out, add, assets); } catch (e) { errors.push('Documents: ' + e.message); log.error('docs', 'could not make documents', e); }
  for (const f of oldDocs) if (!t.outputs.some(o => o.file === f)) await fsp.rm(path.join(out, f), { force: true }).catch(e => log.warn('docs', `could not remove old ${f}`, e));
  finish();

  if (!docsOnly) { // swap the new files in
    const old = finalOut + '.old';
    await fsp.rm(old, { recursive: true, force: true });
    if (fs.existsSync(finalOut)) await fsp.rename(finalOut, old);
    await fsp.rename(out, finalOut);
    delete t.serving;
    fsp.rm(old, { recursive: true, force: true }).catch(e => log.warn('build', 'could not remove the previous files', e)); // open downloads keep reading them
  }
  t.status = errors.length && !t.outputs.length ? 'error' : 'ready';
  t.error = errors.join('\n');
  t.progress = ''; t.pct = 100;
  saveTake(t, true); announce(roomId, t);
  log.info('rec', `take ${t.n} in ${roomId} ${docsOnly ? 'documents updated' : 'built'}: ${t.outputs.length} files${errors.length ? ', errors: ' + errors.length : ''}`);
  if (t.outputs.length) {
    t.progress = 'Backing up'; saveTake(t, true); announce(roomId, t);
    await backupTake(room, t, finalOut);
    if (!docsOnly && settings.autoCompact && t.backup && t.backup.ok) await compactTake(roomId, t, 'rebuild-data').catch(e => log.warn('tidy', 'automatic tidy-up failed', e));
    t.progress = ''; saveTake(t, true); announce(roomId, t);
    if (!docsOnly) await notifyReady(room, t).catch(e => log.warn('mail', 'could not send the ready email', e));
    queueCloud(roomId, t.id); // in the background — a big upload never holds up the next take
  }
}

// cleaned copy of each voice + Producer mix + long pauses. Works from the finished WAVs, so it can be re-run
// any time (even after "free up space") from the Recordings page with new clean-up settings.
// how loud someone's background noise is, from their room tone (skipping the first and last half second)
async function roomToneLevel(file) {
  const r = await run(FFMPEG, ['-hide_banner', '-nostdin', '-ss', '0.5', '-i', file, '-af', 'atrim=end=19,astats=measure_perchannel=none', '-f', 'null', '-'], { stdout: 'ignore', timeoutMs: 120000 });
  const db = treat.parseRms(r.stderr);
  if (db === null) log.warn('treat', `room tone ${path.basename(file)} is digital silence — noise reduction will follow the noise instead`);
  return db;
}
async function treatTakeUntraced(t, segs, out, add, assets, errors, { begin, finish, report, takeSecs }) {
  const c = settings.clean;
  for (const o of t.outputs.filter(o => ['cleaned', 'producermix', 'roughmix', 'soundboard'].includes(o.kind))) await fsp.rm(path.join(out, o.file), { force: true }).catch(e => log.warn('treat', `could not remove old ${o.file}`, e));
  t.outputs = t.outputs.filter(o => !['cleaned', 'producermix', 'roughmix', 'soundboard'].includes(o.kind));
  t.pauses = [];
  const voices = t.outputs.filter(o => o.kind === 'audio' && fs.existsSync(path.join(out, o.file)));
  const sources = [], temps = [];
  for (const o of voices) {
    const person = o.person;
    let file = o.file, baseDb = 0;
    if (c.auto) {
      begin(`Cleaning up ${person}`, 3);
      const tmp = path.join(out, `.${person} - cleaning.wav`), name = `${person} - cleaned -16 LUFS.wav`;
      try {
        const tone = t.outputs.find(x => x.kind === 'roomtone' && x.person === person);
        const noiseDb = tone ? await roomToneLevel(path.join(out, tone.file)) : null;
        await ff(['-i', path.join(out, o.file), '-af', treat.cleanFilter(c, noiseDb), '-c:a', 'pcm_f32le', tmp], report, takeSecs);
        const L = await measureLoudness(tmp);
        if (!Number.isFinite(L.I)) throw new Error('no speech found to clean');
        await ff(['-i', tmp, '-af', normaliseFilter(L, -16), '-ar', '48000', '-c:a', 'pcm_s24le', path.join(out, name)]);
        add(name, 'cleaned', person);
        file = name;
        const raw = t.levels && t.levels[person];
        baseDb = raw && Number.isFinite(raw.I) ? raw.I + 16 : 0; // the Producer mix keeps everyone as loud as they were live
      } catch (e) { errors.push(`Clean-up ${person}: ${e.message.slice(0, 300)}`); }
      finally { await fsp.rm(tmp, { force: true }).catch(log.ignore('treat', 'remove temp clean-up file')); }
      finish();
    }
    // everyone this person was (one person can have several browser ids if they rejoined from another device)
    const ids = new Set(segs.filter(sg => sg._person === person).map(sg => sg.clientId));
    const rides = [], coughs = [];
    let chan = null;
    for (const id of ids) { rides.push(...((t.rides || {})[id] || [])); coughs.push(...((t.coughs || {})[id] || [])); chan = (t.channels || {})[id] || chan; }
    // the Console's EQ / compressor for this person, as set at the end of the take
    let src = path.join(out, file);
    const cf = chan && treat.channelFilter(chan);
    if (cf) {
      const tmp = path.join(out, `.${person} - console.wav`);
      try { await ff(['-i', src, '-af', cf, '-c:a', 'pcm_f32le', tmp], null, takeSecs); src = tmp; temps.push(tmp); }
      catch (e) { errors.push(`Console EQ for ${person}: ${e.message.slice(0, 200)} — mixed without it`); }
    }
    sources.push({ file: src, gain: treat.envelope(rides, coughs, baseDb), pan: chan ? chan.pan : 0 });
  }
  if (!sources.length) { for (const f of temps) await fsp.rm(f, { force: true }).catch(log.ignore('treat', 'remove temp console file')); return; }
  begin('Making the Producer mix', 2);
  const rawMix = path.join(out, '.producer-mix.wav'), pausesTxt = path.join(out, '.pauses.txt');
  try {
    await treat.mixWithEnvelopes(sources, rawMix, f => report(f * 0.5));
    if (c.pauses > 0) {
      await ff(['-i', rawMix, '-af', treat.pauseFilter(c.pauses, pausesTxt), '-f', 'null', '-']);
      t.pauses = treat.parsePauses(await fsp.readFile(pausesTxt, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }));
    }
    // the soundboard as its own track (exactly what was played, beds dipped under the voices), then into the mix
    let show = rawMix;
    const board = (t.board || []).filter(e => e.to != null && fs.existsSync(path.join(takeDir(t.room, t.id), 'board', e.sid + '.wav')));
    if (board.length) {
      const boardFile = 'Soundboard.wav';
      await ff(treat.boardArgs(board, e => path.join(takeDir(t.room, t.id), 'board', e.sid + '.wav'), rawMix, takeSecs, path.join(out, boardFile)), null, takeSecs);
      add(boardFile, 'soundboard', 'Soundboard');
      show = path.join(out, '.show-with-board.wav');
      await ff(['-i', rawMix, '-i', path.join(out, boardFile), '-filter_complex', '[0:a]aformat=channel_layouts=stereo[v];[v][1:a]amix=inputs=2:normalize=0:duration=first[m]', '-map', '[m]', '-c:a', 'pcm_f32le', show], null, takeSecs);
    }
    const parts = [assets.intro && assets.intro.path, show, assets.outro && assets.outro.path].filter(Boolean);
    const file = `Producer mix${assets.intro || assets.outro ? ' (intro + show + outro)' : ''} -16 LUFS.wav`;
    const fc = parts.map((_, i) => `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`).join(';') + ';' +
      parts.map((_, i) => `[a${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1,loudnorm=I=-16:TP=-1:LRA=11,aresample=48000[out]`;
    await ff([...parts.flatMap(p => ['-i', p]), '-filter_complex', fc, '-map', '[out]', '-ar', '48000', '-c:a', 'pcm_s24le', path.join(out, file)], f => report(0.5 + f * 0.5), takeSecs + (assets.intro ? assets.intro.dur : 0) + (assets.outro ? assets.outro.dur : 0));
    if (show !== rawMix) await fsp.rm(show, { force: true }).catch(log.ignore('treat', 'remove temp show mix'));
    add(file, 'producermix', 'Everyone');
  } catch (e) { errors.push(`Producer mix: ${e.message.slice(0, 300)}`); }
  finally {
    await fsp.rm(rawMix, { force: true }).catch(log.ignore('treat', 'remove temp mix'));
    await fsp.rm(pausesTxt, { force: true }).catch(log.ignore('treat', 'remove temp pauses list'));
    for (const f of temps) await fsp.rm(f, { force: true }).catch(log.ignore('treat', 'remove temp console file'));
  }
  finish();
}

async function buildDocsUntraced(t, room, out, add, assets) {
  const title = takeLabel(room, t);
  const introLen = assets.intro ? assets.intro.dur : 0;
  const markers = (t.markers || []).slice().sort((a, b) => a.at - b.at).map((m, i) => ({ ...m, label: m.label || `Marker ${i + 1}` }));
  const write = async (file, text, kind, person = 'Everyone') => {
    if (!text) return;
    const tmp = path.join(out, `.${file}.tmp`);
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, path.join(out, file));
    add(file, kind, person);
  };
  // markers (times in the take) + Audition markers lined up with the session (after the intro)
  const edits = post.editItems(t, markers, takePeople(t));
  if (markers.length) await write('Markers.txt', markers.map(m => `${post.hms(m.at / 1000)}  ${m.label}${m.by ? '  (' + m.by + ')' : ''}`).join('\r\n') + '\r\n', 'markers');
  if (edits.length) {
    await write('Edit list.txt', post.editList(edits, title), 'editlist');
    await write('Markers (Audition).csv', post.auditionMarkersCsv(edits.map(m => ({ ...m, at: introLen + m.at }))), 'markers');
  }
  if (markers.length) {
    const ch = post.chapters(t, introLen);
    if (ch) { await write('Chapters.json', ch.json, 'chapters'); await write('Chapters (YouTube).txt', ch.youtube, 'chapters'); }
  }
  if ((t.chat || []).length) await write('Chat.txt', t.chat.map(c => `[${post.hms(c.at / 1000)}] ${c.from}: ${c.text}`).join('\r\n') + '\r\n', 'chat');
  await write('Transcript.txt', post.transcriptTxt(t, title, introLen), 'transcript');
  await write('Transcript.srt', post.transcriptSrt(t), 'transcript');
  await write('Transcript.vtt', post.transcriptVtt(t), 'transcript');
  await write('Level report.txt', post.levelReport(t, title), 'report');
  // session files: intro, everyone (untouched recordings), outro, video — all lined up
  const dur = async f => parseFloat(await probe(path.join(out, f), 'format=duration')) || 0;
  const people = t.outputs.filter(o => o.kind === 'audio');
  const audio = [];
  let show = 0;
  for (const o of people) { const d = await dur(o.file); show = Math.max(show, d); audio.push({ kind: 'audio', name: o.person, file: o.file, start: introLen, dur: d, channels: 1 }); }
  const tracks = [];
  if (assets.intro) tracks.push({ kind: 'audio', name: 'Intro', file: 'Intro.wav', start: 0, dur: assets.intro.dur, channels: 2 });
  tracks.push(...audio);
  const sb = t.outputs.find(o => o.kind === 'soundboard');
  if (sb) tracks.push({ kind: 'audio', name: 'Soundboard', file: sb.file, start: introLen, dur: await dur(sb.file), channels: 2 });
  if (assets.outro) tracks.push({ kind: 'audio', name: 'Outro', file: 'Outro.wav', start: introLen + show, dur: assets.outro.dur, channels: 2 });
  if (!audio.length) return;
  // every edit point goes in the session: markers, plus coughs, filler words, pauses and soundboard as ranges — each
  // named with its kind first ("Filler words: um — Steve: …"), so any editor can sort them without guessing
  const sessMarkers = edits.map(i => ({ label: post.markerName(i), at: introLen + i.at, dur: i.dur || 0, group: i.group }));
  await write(`${title} (Audition).sesx`, post.sesx(title, tracks, sessMarkers), 'session');
  const videos = [];
  for (const o of t.outputs.filter(o => o.kind === 'video' || (o.kind === 'screen' && o.file.endsWith('.mp4')))) {
    const wh = (await probe(path.join(out, o.file), 'stream=width,height', 'v:0')).split(',').map(Number);
    videos.push({ kind: 'video', file: o.file, start: introLen, dur: await dur(o.file), w: wh[0] || 1280, h: wh[1] || 720 });
  }
  await write(`${title} (Premiere, Resolve, Audition).xml`, post.fcpXml(title, [...videos, ...tracks], sessMarkers, settings.fps), 'session');
}

// free up disk space on a finished take
async function compactTakeUntraced(roomId, t, what) {
  const dir = takeDir(roomId, t.id);
  let freed = 0;
  const rm = async f => { try { const st = await fsp.stat(f); await fsp.rm(f, { force: true }); if (st.nlink <= 1) freed += st.size; } catch (e) { if (e.code !== 'ENOENT') log.warn('tidy', `could not delete ${f}`, e); } };
  if (what === 'camera-originals') {
    for (const o of t.outputs.filter(o => o.kind === 'video-original')) await rm(path.join(dir, 'out', o.file));
    t.outputs = t.outputs.filter(o => o.kind !== 'video-original');
    for (const s of Object.values(t.segs)) for (const f of await fsp.readdir(path.join(dir, 'segs', s.id)).catch(() => [])) if (/^camera\./.test(f)) await rm(path.join(dir, 'segs', s.id, f));
  } else {
    for (const s of Object.values(t.segs)) {
      const sd = path.join(dir, 'segs', s.id);
      for (const f of await fsp.readdir(sd).catch(() => [])) if (/^(audio\.pcm|camera\.|screen-)/.test(f)) await rm(path.join(sd, f));
      await fsp.rm(path.join(sd, 'video'), { recursive: true, force: true }); await fsp.rm(path.join(sd, 'screen'), { recursive: true, force: true });
    }
    t.compacted = true;
  }
  saveTake(t, true);
  return freed;
}

// ---------- cloud backup (rclone: Google Drive, Dropbox, OneDrive, S3… set up once with `rclone config`) ----------
const RCLONE = process.env.RCLONE || 'rclone';
const validRemote = r => /^[A-Za-z0-9_. -]{1,60}:[^\0\r\n"'`$\\]{0,200}$/.test(r) && !/(^|\/)\.\.(\/|$)/.test(r);
const cloudQueue = []; let cloudBusy = false;
function queueCloud(roomId, takeId, retry = 0) {
  if (!settings.cloud.remote) return;
  cloudQueue.push({ roomId, takeId, retry });
  if (!cloudBusy) cloudNext().catch(e => log.warn('cloud', 'cloud backup queue', e));
}
async function cloudNext() {
  cloudBusy = true;
  try {
    while (cloudQueue.length) {
      const job = cloudQueue.shift(), room = loadRoom(job.roomId), t = room && loadTake(job.roomId, job.takeId);
      if (!t || t.status !== 'ready' || !settings.cloud.remote) continue;
      await cloudBackup(room, t);
      // one automatic retry 10 minutes later (a wobbly connection); after that, "Upload again" on the Recordings page
      if (t.cloud && !t.cloud.ok && job.retry < 1) setTimeout(() => queueCloud(job.roomId, job.takeId, job.retry + 1), process.env.CLOUD_RETRY_MS ? +process.env.CLOUD_RETRY_MS : 600000).unref();
    }
  } finally { cloudBusy = false; }
}
async function cloudBackupUntraced(room, t) {
  const remote = settings.cloud.remote, stamp = new Date(t.started).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
  const dest = `${remote.replace(/\/+$/, '')}${remote.endsWith(':') ? '' : '/'}${fileSafe(room.name)}/Take ${t.n} - ${stamp}`;
  t.cloud = { ok: false, busy: true, at: Date.now(), dest }; saveTake(t, true); announce(room.id, t);
  try {
    await run(RCLONE, ['copy', path.join(takeDir(room.id, t.id), 'out'), dest, '--exclude', '.*', '--transfers', '2', '--retries', '5', '--low-level-retries', '10', '--stats', '0'], { timeoutMs: 12 * 3600 * 1000 });
    t.cloud = { ok: true, at: Date.now(), dest };
    log.info('cloud', `take ${t.n} of ${room.name} copied to ${dest}`);
  } catch (e) {
    t.cloud = { ok: false, at: Date.now(), dest, error: /ENOENT|could not (start|run)/.test(e.message) ? 'rclone isn\'t installed — re-run the installer' : e.message.slice(0, 300) };
    log.warn('cloud', `take ${t.n} of ${room.name}: ${t.cloud.error}`);
  }
  saveTake(t, true); announce(room.id, t);
}
const cloudBackup = log.trace('cloud', cloudBackupUntraced);

// copy finished files to a second disk (e.g. a USB drive) — refuses to "back up" onto the same disk
async function backupTakeUntraced(room, t, out) {
  const dir = settings.backupDir;
  if (!dir) { t.backup = null; return; }
  try {
    let probeDir = dir; while (!fs.existsSync(probeDir)) probeDir = path.dirname(probeDir);
    if (fs.statSync(probeDir).dev === fs.statSync(DATA_DIR).dev) throw new Error('Backup folder is on the same disk as the recordings — is the backup drive plugged in?');
    const stamp = new Date(t.started).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-');
    const dest = path.join(dir, fileSafe(room.name), `Take ${t.n} - ${stamp}`);
    await fsp.mkdir(dest, { recursive: true });
    for (const o of t.outputs) {
      const to = path.join(dest, o.file);
      const same = await fsp.stat(to).then(st => st.size === o.size && !DOC_KINDS.has(o.kind), () => false);
      if (!same) await fsp.copyFile(path.join(out, o.file), to);
    }
    t.backup = { ok: true, at: Date.now(), path: dest };
  } catch (e) { t.backup = { ok: false, at: Date.now(), error: e.message }; log.warn('backup', e.message); }
}

function mailer() {
  const s = settings.smtp;
  if (!nodemailer || !s.host) return null;
  const local = /^(localhost|127\.|::1)/.test(s.host);
  if (process.env.NO_EXTERNAL_CALLS && !local) return { sendMail: async () => { throw new Error('External calls blocked by NO_EXTERNAL_CALLS'); } };
  return nodemailer.createTransport({ host: s.host, port: +s.port || 587, secure: +s.port === 465, auth: s.user ? { user: s.user, pass: s.pass } : undefined, tls: local ? { rejectUnauthorized: false } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 60000 });
}
async function notifyReadyUntraced(room, t) {
  const to = String(room.notifyEmail || '').split(/[,;\s]+/).filter(x => /@/.test(x));
  const tr = mailer();
  if (!to.length || !tr) return;
  const link = settings.publicUrl ? `${settings.publicUrl}/m/${room.id}?k=${room.hostKey}` : '';
  const size = t.outputs.reduce((a, o) => a + o.size, 0);
  const people = [...new Set(Object.values(t.segs).map(s => s.name))].join(', ');
  const lines = [`Take ${t.n} of "${room.name}" is ready to download.`, '',
    `Who: ${people}`, `Length: ${post.hms(((t.stopped || t.started) - t.started) / 1000)}`, `Files: ${t.outputs.length} (${(size / 1073741824).toFixed(2)} GB)`,
    (t.markers || []).length ? `Markers: ${t.markers.length}` : '', t.backup ? (t.backup.ok ? 'Backup: copied ✓' : `Backup: FAILED — ${t.backup.error}`) : '',
    t.error ? `\nSome files had problems:\n${t.error}` : '', '', link ? `Download: ${link}` : ''].filter(l => l !== null).join('\n');
  await tr.sendMail({ from: settings.smtp.from || settings.smtp.user, to: to.join(', '), subject: t.notified ? `🔄 ${takeLabel(room, t)} updated (late uploads arrived)` : `✅ ${takeLabel(room, t)} is ready`, text: lines });
  t.notified = true; saveTake(t, true);
  log.info('mail', `sent take ${t.n} ready to ${to.join(', ')}`);
}

// every pipeline step logs ENTER / EXIT (with time taken) / EXCEPTION  (LOG_LEVEL=debug to see them)
const processTake = log.trace('build', processTakeUntraced);
const treatTake = log.trace('treat', treatTakeUntraced);
const buildDocs = log.trace('docs', buildDocsUntraced);
const backupTake = log.trace('backup', backupTakeUntraced);
const compactTake = log.trace('tidy', compactTakeUntraced);
const notifyReady = log.trace('mail', notifyReadyUntraced);
const alignVideo = log.trace('align', alignVideoUntraced);
const measureLoudness = log.trace('levels', measureLoudnessUntraced);

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
app.get('/api/info', (req, res) => res.json({ name: STUDIO_NAME, admin: isAdmin(req), maxPeople: MAX_PEOPLE, version: VERSION, link: linkBase }));

// connection test (used by the lobby)
const SPEED_BUF = crypto.randomBytes(4 * 1024 * 1024);
app.get('/api/ping', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ s: Date.now() }); });
app.get('/api/speedtest', (req, res) => {
  res.set('Cache-Control', 'no-store'); res.type('application/octet-stream');
  res.end(SPEED_BUF.subarray(0, Math.min(SPEED_BUF.length, Math.max(1024, +req.query.bytes || SPEED_BUF.length))));
});
app.post('/api/speedtest', express.raw({ type: () => true, limit: '16mb' }), (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ bytes: req.body ? req.body.length : 0 }); });

function setAdminCookie(req, res) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `ps_admin=${encodeURIComponent(adminCookie())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
}
// wrong admin passwords: each one is slowed down, and whoever keeps guessing is paused for 15 minutes
const LOGIN_WINDOW = 15 * 60 * 1000, LOGIN_TRIES = 8, loginFails = new Map();
function whoIsAsking(req) { // behind the tunnel / web server on this machine, the real address is in its header
  const local = /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress || '');
  return (local && (req.get('cf-connecting-ip') || String(req.get('x-forwarded-for') || '').split(',')[0].trim())) || req.socket.remoteAddress || 'unknown';
}
app.post('/api/login', express.json(), (req, res) => {
  const who = whoIsAsking(req), now = Date.now();
  for (const [k, v] of loginFails) { const keep = v.filter(x => now - x < LOGIN_WINDOW); if (keep.length) loginFails.set(k, keep); else loginFails.delete(k); }
  if ((loginFails.get(who) || []).length >= LOGIN_TRIES) return res.status(429).json({ error: 'Too many wrong passwords — try again in 15 minutes' });
  if (!checkPassword((req.body || {}).password)) {
    loginFails.set(who, [...(loginFails.get(who) || []), now]);
    if (loginFails.get(who).length === LOGIN_TRIES) log.warn('login', `${LOGIN_TRIES} wrong admin passwords in a row from ${who} — paused for 15 minutes`);
    return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 800);
  }
  loginFails.delete(who);
  setAdminCookie(req, res);
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
  let free = null; try { const s = await fsp.statfs(p); free = s.bavail * s.bsize; } catch (e) { log.warn('backup', `could not check free space on ${p}`, e); }
  return { set: true, ok: !same, free, msg: same ? 'That folder is on the same disk as the recordings — is the backup drive plugged in / mounted?' : '' };
}
app.post('/api/settings/password', needAdmin, express.json(), (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPassword(current)) return setTimeout(() => res.status(400).json({ error: 'Your current password is not right.' }), 800);
  if (String(next || '').length < 8) return res.status(400).json({ error: 'The new password needs at least 8 characters.' });
  setPassword(String(next));
  setAdminCookie(req, res); // keep this browser logged in; every other login is signed out
  res.json({ ok: true });
});
app.get('/api/settings', needAdmin, async (req, res) => {
  res.json({ smtp: { ...settings.smtp, pass: settings.smtp.pass ? MASK : '' }, turn: { keyId: settings.turn.keyId, token: settings.turn.token ? MASK : '' },
    backupDir: settings.backupDir, cloud: settings.cloud, publicUrl: settings.publicUrl, backup: await backupStatus(), emailAvailable: !!nodemailer, turnError: cfIce.error, passwordChanged: !!settings.adminHash,
    transcribe: { ...settings.transcribe, installed: transcriber.available(), models: transcriber.installedModels() }, autoCompact: settings.autoCompact, clean: settings.clean, fps: settings.fps });
});
app.post('/api/settings', needAdmin, express.json(), async (req, res) => {
  const b = req.body || {};
  if (b.smtp) for (const k of ['host', 'port', 'user', 'pass', 'from']) if (k in b.smtp && !(k === 'pass' && b.smtp.pass === MASK)) settings.smtp[k] = k === 'port' ? (parseInt(b.smtp.port, 10) || 587) : cleanText(b.smtp[k], 200);
  if (b.turn) { if ('keyId' in b.turn) settings.turn.keyId = cleanText(b.turn.keyId, 200); if ('token' in b.turn && b.turn.token !== MASK) settings.turn.token = cleanText(b.turn.token, 400); cfIce = { at: 0, list: null, error: '' }; }
  if ('backupDir' in b) settings.backupDir = cleanText(b.backupDir, 300);
  if (b.cloud && 'remote' in b.cloud) {
    const rem = cleanText(b.cloud.remote, 260);
    if (rem && !validRemote(rem)) return res.status(400).json({ error: 'Cloud backup: type the rclone remote and folder, like gdrive:Rolling' });
    settings.cloud.remote = rem;
  }
  if ('publicUrl' in b) settings.publicUrl = cleanText(b.publicUrl, 200).replace(/\/+$/, '');
  if (b.transcribe) { settings.transcribe.enabled = !!b.transcribe.enabled; if (/^[a-z0-9.-]{2,40}$/.test(b.transcribe.model || '')) settings.transcribe.model = b.transcribe.model; if (/^[a-z]{2}$|^auto$/.test(b.transcribe.language || '')) settings.transcribe.language = b.transcribe.language; }
  if ('autoCompact' in b) settings.autoCompact = !!b.autoCompact;
  if ('fps' in b) settings.fps = Number(b.fps) === 30 ? 30 : 25;
  if (b.clean && typeof b.clean === 'object') settings.clean = treat.cfg({ ...settings.clean, ...b.clean });
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
app.post('/api/settings/test-transcribe', needAdmin, async (req, res) => {
  try { res.json({ ok: true, ...(await transcriber.selfTest()) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/settings/test-turn', needAdmin, async (req, res) => {
  if (!settings.turn.keyId || !settings.turn.token) return res.status(400).json({ error: 'Fill in the Key ID and API token first.' });
  try { const l = await cloudflareIce(true); res.json({ ok: true, servers: (l || []).reduce((a, x) => a + x.urls.length, 0) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

function transcriptStatus(t) {
  const segs = Object.values(t.segs).filter(s => s.audio && s.audio.end);
  const lines = segs.reduce((n, s) => n + ((s.tx && s.tx.parts.length) || 0), 0);
  return {
    engine: transcriber.available(), on: transcriber.enabled(),
    pct: transcriber.progress(t), lines,
    recent: segs.flatMap(s => ((s.tx && s.tx.parts) || []).slice(-8).map(p => ({ who: s.name, at: p.from, text: p.text }))).sort((a, b) => a.at - b.at).slice(-8),
    failed: segs.filter(s => s.tx && s.tx.error).map(s => ({ who: s.name, error: s.tx.error })),
    hasFile: (t.outputs || []).some(o => o.kind === 'transcript'),
    canMake: transcriber.enabled() && !t.compacted && segs.length > 0,
  };
}
function takeSummary(t) {
  return { id: t.id, n: t.n, started: t.started, stopped: t.stopped, status: t.status, progress: t.progress, error: t.error,
    people: [...new Set(Object.values(t.segs).map(s => s.name))], outputs: t.serving || t.outputs || [], markers: t.markers || [], backup: t.backup || null, cloud: t.cloud || null,
    pct: t.pct || 0, levels: t.levels || {}, episode: t.episode || null, compacted: !!t.compacted,
    transcript: transcriptStatus(t),
    totalSize: (t.serving || t.outputs || []).reduce((a, o) => a + o.size, 0) };
}
// show rundown: [{ name, mins }] — up to 40 segments
function cleanRundown(list) { return list.slice(0, 40).map(x => ({ name: cleanText(x && x.name, 60) || 'Segment', mins: Math.max(0, Math.min(600, Math.round((Number(x && x.mins) || 0) * 10) / 10)) })); }
function roomSummary(r) {
  const lr = live.get(r.id);
  return { id: r.id, name: r.name, created: r.created, hostKey: r.hostKey, waitingRoom: r.waitingRoom !== false, notifyEmail: r.notifyEmail || '', assets: r.assets || {}, lastEpisode: r.lastEpisode || 0, rundown: r.rundown || [], sounds: r.sounds || [],
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
  if (Array.isArray(b.rundown)) r.rundown = cleanRundown(b.rundown);
  saveRoom(r);
  const lr = live.get(r.id);
  if (lr && Array.isArray(b.rundown)) broadcast(lr, { t: 'rundown', rundown: r.rundown || [] });
  res.json(roomSummary(r));
});
// invite a guest: an email with their link, a short setup checklist and a calendar entry — or the same text to copy
const inviteCount = new Map(); // room → recent sends (a host link can't be used to spam)
app.post('/api/rooms/:id/invite', express.json(), async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const b = req.body || {}, email = cleanText(b.email, 200);
  const when = b.when ? new Date(String(b.when)) : null;
  if (when && Number.isNaN(+when)) return res.status(400).json({ error: 'That date and time isn\'t valid' });
  const base = linkBase || settings.publicUrl || `${req.protocol}://${req.get('host')}`;
  const inv = post.guestInvite({ studio: STUDIO_NAME, show: r.name, guest: cleanText(b.name, 80), host: cleanText(b.host, 80), link: `${base}/r/${r.id}`,
    when, minutes: Math.max(10, Math.min(600, parseInt(b.minutes, 10) || 60)), tz: cleanText(b.tz, 60), note: cleanText(b.note, 1000) });
  if (!b.send) return res.json({ subject: inv.subject, text: inv.text });
  if (!/^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/.test(email)) return res.status(400).json({ error: 'Type one email address' });
  const tr = mailer();
  if (!tr) return res.status(400).json({ error: 'Email isn\'t set up on this studio — use "Copy invite" instead, or set up email in Studio settings' });
  const now = Date.now(), recent = (inviteCount.get(r.id) || []).filter(x => now - x < 3600e3);
  if (recent.length >= 20) return res.status(429).json({ error: 'That\'s a lot of invites — try again in an hour' });
  inviteCount.set(r.id, [...recent, now]);
  try {
    await tr.sendMail({ from: settings.smtp.from || settings.smtp.user, to: email, subject: inv.subject, text: inv.text,
      ...(inv.ics ? { icalEvent: { method: 'PUBLISH', filename: 'invite.ics', content: inv.ics } } : {}) });
    log.info('invite', `invited ${email} to ${r.name}`);
    res.json({ ok: true, subject: inv.subject, text: inv.text });
  } catch (e) { log.warn('invite', `couldn't send to ${email}: ${e.message}`); res.status(502).json({ error: `The email couldn't be sent: ${e.message}` }); }
});
app.post('/api/rooms/:id/takes/:take/rebuild', (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (t.status === 'recording') return res.status(409).json({ error: 'Still recording' });
  queueProcess(r.id, t.id, { docsOnly: !!t.compacted });
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

// intro / outro audio for a show (converted to 48 kHz 24-bit stereo WAV)
app.post('/api/rooms/:id/asset/:kind', express.raw({ type: () => true, limit: '500mb' }), async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const kind = req.params.kind; if (!['intro', 'outro'].includes(kind) || !Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file' });
  const adir = path.join(roomDir(r.id), 'assets'); await fsp.mkdir(adir, { recursive: true });
  const tmp = path.join(adir, kind + '.upload'), dest = path.join(adir, kind + '.wav');
  try {
    await fsp.writeFile(tmp, req.body);
    await ff(['-i', tmp, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', dest]);
    const dur = parseFloat(await probe(dest, 'format=duration')) || 0;
    r.assets = r.assets || {}; r.assets[kind] = { name: cleanText(decodeURIComponent(req.headers['x-filename'] || kind), 120), dur };
    saveRoom(r); res.json(roomSummary(r));
  } catch (e) { res.status(400).json({ error: 'That file could not be read as audio.' }); }
  finally { fsp.rm(tmp, { force: true }).catch(log.ignore('assets', 'remove upload temp file')); }
});
app.delete('/api/rooms/:id/asset/:kind', async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  if (!['intro', 'outro'].includes(req.params.kind)) return res.status(400).json({ error: 'Unknown file' });
  if (r.assets) delete r.assets[req.params.kind];
  await fsp.rm(path.join(roomDir(r.id), 'assets', path.basename(req.params.kind) + '.wav'), { force: true });
  saveRoom(r); res.json(roomSummary(r));
});
// ---------- soundboard pads (per show): jingles, beds, effects — played live from the Console ----------
const PAD_MODES = ['jingle', 'bed', 'effect'];
const padFile = (roomId, sid) => path.join(roomDir(roomId), 'assets', 'sounds', path.basename(sid) + '.wav');
function cleanPad(p, old = {}) {
  const mode = PAD_MODES.includes(p.mode) ? p.mode : old.mode || 'jingle';
  const vol = Number.isFinite(+p.vol) ? Math.max(-30, Math.min(6, Math.round(+p.vol * 2) / 2)) : old.vol || 0;
  const color = /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : old.color || '#3b82f6';
  return { ...old, name: cleanText(p.name, 40) || old.name || 'Sound', mode, vol, color };
}
app.post('/api/rooms/:id/sounds', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No file' });
  r.sounds = r.sounds || [];
  if (r.sounds.length >= 24) return res.status(400).json({ error: 'The soundboard is full (24 pads) — delete one first' });
  const sid = rid(8), dest = padFile(r.id, sid), tmp = dest + '.upload';
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.writeFile(tmp, req.body);
    await ff(['-i', tmp, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', dest]);
    const dur = parseFloat(await probe(dest, 'format=duration')) || 0;
    if (!dur) throw new Error('empty');
    const name = cleanText(decodeURIComponent(req.headers['x-filename'] || 'Sound'), 80).replace(/\.[a-z0-9]{2,4}$/i, '');
    const pad = { id: sid, dur: +dur.toFixed(2), ...cleanPad({ name, mode: dur > 45 ? 'bed' : 'jingle' }) };
    r.sounds.push(pad); saveRoom(r);
    const lr = live.get(r.id); if (lr) toHosts(lr, { t: 'sounds', sounds: r.sounds });
    res.json(pad);
  } catch (e) { await fsp.rm(dest, { force: true }); res.status(400).json({ error: 'That file could not be read as audio.' }); }
  finally { fsp.rm(tmp, { force: true }).catch(log.ignore('sounds', 'remove upload temp file')); }
});
app.post('/api/rooms/:id/sounds/:sid', express.json(), (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const i = (r.sounds || []).findIndex(p => p.id === req.params.sid);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  r.sounds[i] = cleanPad(req.body || {}, r.sounds[i]); saveRoom(r);
  const lr = live.get(r.id); if (lr) toHosts(lr, { t: 'sounds', sounds: r.sounds });
  res.json(r.sounds[i]);
});
app.delete('/api/rooms/:id/sounds/:sid', async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  r.sounds = (r.sounds || []).filter(p => p.id !== req.params.sid); saveRoom(r);
  await fsp.rm(padFile(r.id, req.params.sid), { force: true });
  const lr = live.get(r.id); if (lr) toHosts(lr, { t: 'sounds', sounds: r.sounds });
  res.json({ ok: true });
});
app.get('/api/rooms/:id/sounds/:sid', (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  if (!(r.sounds || []).some(p => p.id === req.params.sid)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(padFile(r.id, req.params.sid));
});

// rename / delete markers, then rebuild only the documents (fast)
app.post('/api/rooms/:id/takes/:take/markers', express.json(), (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t) return res.status(404).json({ error: 'Not found' });
  const list = Array.isArray((req.body || {}).markers) ? req.body.markers : [];
  t.markers = list.filter(m => Number.isFinite(+m.at)).map(m => ({ at: +m.at, label: cleanText(m.label, 80) || 'Marker', by: cleanText(m.by, 40) })).sort((a, b) => a.at - b.at);
  saveTake(t, true);
  if (t.status !== 'recording') queueProcess(r.id, t.id, { docsOnly: true });
  res.json({ ok: true });
});
app.post('/api/rooms/:id/takes/:take/transcribe', (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!transcriber.enabled()) return res.status(409).json({ error: transcriber.available() ? 'Transcripts are switched off in Studio settings' : 'The transcription engine is not installed — re-run the installer' });
  if (t.compacted) return res.status(409).json({ error: 'This take\'s raw audio was deleted to save space, so it can\'t be transcribed now' });
  if (['recording', 'processing', 'queued'].includes(t.status)) return res.status(409).json({ error: 'Busy — try again when the take is ready' });
  queueProcess(r.id, t.id, { docsOnly: true, transcribe: true });
  res.json({ ok: true });
});
app.post('/api/rooms/:id/takes/:take/cloud', (req, res) => { // "Upload again"
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!settings.cloud.remote) return res.status(400).json({ error: 'Cloud backup isn\'t set up — Studio settings on the main page' });
  if (t.status !== 'ready') return res.status(409).json({ error: 'Busy — try again when the take is ready' });
  queueCloud(r.id, t.id); // gets its one automatic retry too
  res.json({ ok: true });
});
// check the cloud backup works: lists your remotes, then looks inside the one you typed
app.post('/api/settings/cloud-test', needAdmin, express.json(), async (req, res) => {
  const remote = cleanText((req.body || {}).remote, 260) || settings.cloud.remote;
  if (!validRemote(remote)) return res.status(400).json({ error: 'Type the rclone remote and folder, like gdrive:Rolling' });
  let remotes;
  try { remotes = (await run(RCLONE, ['listremotes'], { timeoutMs: 15000 })).stdout.split(/\r?\n/).filter(Boolean); }
  catch (e) { return res.status(400).json({ error: /could not (start|run)/.test(e.message) ? 'rclone isn\'t installed on this server — re-run the installer' : e.message.slice(0, 300) }); }
  const name = remote.slice(0, remote.indexOf(':') + 1);
  if (!remotes.includes(name)) return res.status(400).json({ error: remotes.length ? `There's no rclone remote called "${name}" — you have: ${remotes.join(', ')}` : 'No cloud accounts are set up in rclone yet — see the guide (rclone config)' });
  try { await run(RCLONE, ['mkdir', remote], { timeoutMs: 30000 }); await run(RCLONE, ['lsf', '--max-depth', '1', remote], { timeoutMs: 30000 }); res.json({ ok: true, remotes }); }
  catch (e) { res.status(400).json({ error: `Couldn't reach ${remote}: ${e.message.slice(0, 300)}` }); }
});
app.post('/api/rooms/:id/takes/:take/clean', (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t) return res.status(404).json({ error: 'Not found' });
  if (!['ready', 'error'].includes(t.status)) return res.status(409).json({ error: 'Busy — try again when the take is ready' });
  if (!t.outputs.some(o => o.kind === 'audio')) return res.status(409).json({ error: 'This take has no recordings to clean' });
  queueProcess(r.id, t.id, { docsOnly: true, clean: true });
  res.json({ ok: true });
});
app.post('/api/rooms/:id/takes/:take/compact', express.json(), async (req, res) => {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) return res.status(403).json({ error: 'Not allowed' });
  const t = loadTake(r.id, req.params.take);
  if (!t || t.status !== 'ready') return res.status(409).json({ error: 'Only finished takes can be tidied up' });
  const what = (req.body || {}).what === 'camera-originals' ? 'camera-originals' : 'rebuild-data';
  const freed = await compactTake(r.id, t, what);
  res.json({ ok: true, freed });
});

// downloads
app.get('/dl/:room/:take/:file', (req, res) => {
  const r = loadRoom(req.params.room);
  if (!canManage(req, r)) return res.status(403).send('Not allowed');
  const t = loadTake(r.id, req.params.take);
  const name = path.basename(req.params.file);
  if (!t || !(t.serving || t.outputs || []).some(o => o.file === name)) return res.status(404).send('Not found');
  res.download(path.join(takeDir(r.id, t.id), 'out', name), name.startsWith(takeLabel(r, t)) ? name : `${takeLabel(r, t)} - ${name}`);
});
app.get('/zip/:room/:take', (req, res) => {
  const r = loadRoom(req.params.room);
  if (!canManage(req, r)) return res.status(403).send('Not allowed');
  const t = loadTake(r.id, req.params.take);
  if (!t || !t.outputs.length) return res.status(404).send('Nothing to download yet');
  const base = takeLabel(r, t);
  res.attachment(base + '.zip');
  const z = new ZipArchive({ store: true });
  z.on('error', e => { log.error('zip', 'zip download failed', e); res.destroy(); });
  z.pipe(res);
  for (const o of t.serving || t.outputs) z.file(path.join(takeDir(r.id, t.id), 'out', o.file), { name: `${base}/${o.file}` });
  z.finalize();
});

// uploads from browsers while recording
const fileLocks = new Map();
function withLock(key, fn) { const prev = fileLocks.get(key) || Promise.resolve(); const next = prev.then(fn, fn); fileLocks.set(key, next.catch(log.ignore('files', 'lock chain (the caller sees the real error)'))); return next; }
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
    a.got = addRange(a.got || [], s0, s0 + body.length / 3); // which stretches have arrived, so "complete so far" is known
    saveTake(x.t);
    lateUpload(req.params.room, x.t);
    res.json({ ok: true });
  } catch (e) { log.error('upload', 'could not save an uploaded piece', e); res.status(500).json({ error: 'write failed' }); }
});
// ---------- live copy for the desktop app (read-only, host key): audio that's complete with no gaps, video pieces in order ----------
// merge [s, e) into a sorted list of non-overlapping stretches
function addRange(list, s, e) {
  const out = []; let placed = false;
  for (const [a, b] of list) {
    if (b < s) out.push([a, b]);
    else if (a > e) { if (!placed) { out.push([s, e]); placed = true; } out.push([a, b]); }
    else { s = Math.min(s, a); e = Math.max(e, b); }
  }
  if (!placed) out.push([s, e]);
  return out.slice(0, 2000);
}
const solidSamples = a => (a && a.got && a.got.length && a.got[0][0] === 0 ? a.got[0][1] : 0); // audio complete from the start
const videoInOrder = new Map(); // take/seg → how many video pieces in a row are on disk (remembered, so each check is quick)
function videoReady(t, s) {
  const key = t.id + '/' + s.id, dir = path.join(takeDir(t.room, t.id), 'segs', s.id, 'video');
  let n = videoInOrder.get(key) || 0;
  while (n < ((s.video && s.video.chunks) || 0) && fs.existsSync(path.join(dir, String(n).padStart(6, '0') + '.part'))) n++;
  videoInOrder.set(key, n);
  return n;
}
function liveTake(req, res) {
  const r = loadRoom(req.params.id);
  if (!canManage(req, r)) { res.status(403).json({ error: 'Not allowed' }); return null; }
  const t = loadTake(r.id, req.params.take);
  if (!t) { res.status(404).json({ error: 'Not found' }); return null; }
  return { r, t };
}
app.get('/api/rooms/:id/takes/:take/live', (req, res) => {
  const x = liveTake(req, res); if (!x) return;
  const { t } = x, parts = {};
  const segs = Object.values(t.segs).sort((a, b) => a.created - b.created).map(s => {
    parts[s.clientId] = (parts[s.clientId] || 0) + 1;
    return {
      id: s.id, person: s.name + (parts[s.clientId] > 1 ? ` (part ${parts[s.clientId]})` : ''), done: !!s.done,
      audio: s.audio ? { rate: s.audio.rate, solid: solidSamples(s.audio), end: s.audio.end } : null,
      video: s.video ? { mime: s.video.mime, ready: videoReady(t, s) } : null,
    };
  });
  res.json({ status: t.status, started: t.started, segs, raw: !t.compacted });
});
app.get('/api/rooms/:id/takes/:take/live/:seg/audio', (req, res) => { // supports Range, so the app fetches only what's new
  const x = liveTake(req, res); if (!x) return;
  if (!x.t.segs[req.params.seg]) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(takeDir(x.r.id, x.t.id), 'segs', req.params.seg, 'audio.pcm'), { headers: { 'Content-Type': 'application/octet-stream' } }, e => { if (e && !res.headersSent) res.status(404).json({ error: 'Not there (yet)' }); });
});
app.get('/api/rooms/:id/takes/:take/live/:seg/video/:i', (req, res) => {
  const x = liveTake(req, res); if (!x) return;
  const i = Number(req.params.i);
  if (!x.t.segs[req.params.seg] || !Number.isInteger(i) || i < 0 || i > 999999) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(takeDir(x.r.id, x.t.id), 'segs', req.params.seg, 'video', String(i).padStart(6, '0') + '.part'), e => { if (e && !res.headersSent) res.status(404).json({ error: 'Not there (yet)' }); });
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
  } catch (e) { log.error('upload', 'could not save an uploaded piece', e); res.status(500).json({ error: 'write failed' }); }
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
// keep idle connections open longer than Cloudflare's tunnel does (90 s): otherwise a reused connection can be
// closed by us at the same moment a download starts on it, and the download fails (or Cloudflare shows a 502)
server.keepAliveTimeout = 95 * 1000;
server.headersTimeout = 100 * 1000;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', ws => {
  let peer = null, waiting = null, lr = null, roomId = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  async function doJoin(room, info) {
    // same browser reconnecting: drop its old connection
    for (const p of lr.peers.values()) if (p.clientId === info.clientId) { lr.peers.delete(p.id); broadcast(lr, { t: 'peer-left', id: p.id }); try { p.ws.close(); } catch (e) { log.ignore('ws', 'close old connection')(e); } }
    if (!info.control && [...lr.peers.values()].filter(p => !p.control).length >= MAX_PEOPLE) { send(ws, { t: 'error', code: 'full', msg: `This studio is full (max ${MAX_PEOPLE} people).` }); return; }
    peer = { id: rid(8), ws, ...info, state: {}, screenId: null, green: !info.isHost && (!!info.green || lr.green.has(info.clientId)) };
    if (peer.green) lr.green.add(info.clientId);
    lr.peers.set(peer.id, peer);
    admit(roomId, lr, info.clientId);
    for (const p of lr.peers.values()) if (p !== peer && canSee(p, peer)) send(p.ws, { t: 'peer-joined', peer: peerInfo(peer) });
    const ice = await iceServers();
    if (ws.readyState !== 1) return;
    const t = lr.take ? loadTake(roomId, lr.take) : null;
    send(ws, { t: 'welcome', id: peer.id, isHost: peer.isHost, roomName: room.name, studio: STUDIO_NAME, ice, maxPeople: MAX_PEOPLE, version: VERSION,
      peers: [...lr.peers.values()].filter(p => p !== peer && canSee(peer, p)).map(peerInfo), green: peer.green,
      recording: t ? { take: t.id, started: t.started, n: t.n, markers: (t.markers || []).length } : null, nextEpisode: (room.lastEpisode || 0) + 1,
      roomToneSeconds: ROOM_TONE_SECONDS, roomTone: lr.roomTone && lr.roomTone.end > Date.now() ? lr.roomTone : null,
      rundown: room.rundown || [], segment: lr.segment || null, fps: settings.fps, channels: peer.isHost ? room.channels || {} : undefined, sounds: peer.isHost ? room.sounds || [] : undefined, scenes: peer.isHost ? room.scenes || {} : undefined, script: scriptFor(room, peer), coughing: [...lr.peers.values()].filter(p => p.coughing).map(p => p.id),
      chat: lr.chat.slice(-100), waiting: peer.isHost ? [...lr.waiting.values()].map(w => ({ id: w.id, name: w.name })) : [],
      disk: peer.isHost ? await diskInfo() : null, studio: peer.isHost ? await studioStatus() : null, gbPerPersonHour: GB_PER_PERSON_HOUR, minFreeGB: MIN_FREE_GB });
    if (t && !peer.control && !peer.green) {
      const existing = info.recSeg && t.segs[info.recSeg] && t.segs[info.recSeg].clientId === info.clientId ? info.recSeg : null;
      // a fresh page for the same person: their earlier part can't send any more, so stop waiting on it
      if (!existing) for (const sg of Object.values(t.segs)) if (sg.clientId === info.clientId && !sg.done) sg.done = true;
      peer.seg = existing || newSeg(t, peer);
      if (!existing) send(ws, startMsg(t, peer.seg));
    }
    if (peer.isHost) { const last = listTakes(roomId)[0]; if (last && ['waiting', 'queued', 'processing'].includes(last.status)) send(ws, { t: 'build', take: last.id, n: last.n, status: last.status, pct: last.pct || 0, step: last.progress }); }
    log.info('room', `${peer.name}${peer.isHost ? ' (host)' : ''} joined "${room.name}" (${lr.peers.size} in room)`);
  }

  ws.on('message', async buf => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === 'ping') return send(ws, { t: 'pong', c: m.c, s: Date.now() });
    if (m.t === 'join' && !peer && !waiting) {
      const room = loadRoom(m.room);
      if (!room) return send(ws, { t: 'error', code: 'noroom', msg: 'This studio link is not valid.' });
      roomId = room.id; lr = liveRoom(roomId);
      const info = { clientId: validId(m.clientId) ? m.clientId : rid(12), name: cleanName(m.name), isHost: !!hostKeyOk(room, m.key), camId: validStreamId(m.camId), recSeg: m.recSeg };
      info.control = !!(m.control && info.isHost);
      // people already in the current take (e.g. after a server restart) never get stuck in the waiting room
      const curTake = lr.take && loadTake(roomId, lr.take);
      if (curTake && Object.values(curTake.segs).some(sg => sg.clientId === info.clientId)) admit(roomId, lr, info.clientId);
      if (!info.isHost && room.waitingRoom !== false && !lr.admitted.has(info.clientId)) {
        waiting = { id: rid(8), ws, name: info.name, go: green => { waiting = null; doJoin(room, { ...info, green: !!green }); } };
        lr.waiting.set(waiting.id, waiting);
        send(ws, { t: 'waiting', hostHere: [...lr.peers.values()].some(p => p.isHost) });
        toHosts(lr, { t: 'knock', id: waiting.id, name: waiting.name });
        return;
      }
      return doJoin(room, info);
    }
    if (!peer) return;
    switch (m.t) {
      case 'signal': { const to = lr.peers.get(m.to); if (to && canSee(peer, to)) send(to.ws, { t: 'signal', from: peer.id, data: m.data }); return; }
      case 'devices': { // a guest's microphones/cameras, so the producer can help from the desk
        const list = a => (Array.isArray(a) ? a.slice(0, 12).map(d => ({ id: String(d.id || '').slice(0, 200), label: cleanText(d.label, 80) || 'Device' })) : []);
        peer.devices = { mics: list(m.mics), mic: String(m.mic || '').slice(0, 200), headphones: !!m.headphones, micOn: m.micOn !== false };
        toHosts(lr, { t: 'devices', id: peer.id, devices: peer.devices });
        return;
      }
      case 'state': peer.state = m.state || {}; broadcast(lr, { t: 'peer-state', id: peer.id, state: peer.state }, peer.id); return;
      case 'screen': peer.screenId = m.on ? validStreamId(m.streamId) : null; broadcast(lr, { t: 'screen', id: peer.id, on: !!m.on, streamId: peer.screenId }, peer.id); return;
      case 'meter': if (m.m && typeof m.m === 'object') toHosts(lr, { t: 'meter', id: peer.id, m: m.m }); return;
      case 'cough': { // held cough button: live sound muted for everyone; marked for the edit (the recording is untouched)
        const on = !!m.on; if (on === !!peer.coughing) return;
        peer.coughing = on;
        broadcast(lr, { t: 'cough', id: peer.id, on });
        markRange(lr, peer, on, 'cough', m.at);
        return;
      }
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
          startRecording(roomId, lr, !!m.roomTone, m.episode);
        } else if (!m.on && lr.take) stopRecording(roomId, lr);
        return;
      case 'roomtone': if (lr.take && !(lr.roomTone && lr.roomTone.end > Date.now())) { const t = loadTake(roomId, lr.take); if (t) beginRoomTone(t, lr); } return;
      case 'marker': {
        const t = lr.take && loadTake(roomId, lr.take); if (!t) return;
        t.markers = t.markers || [];
        const tag = post.TAGS[m.tag] ? m.tag : null;
        const same = t.markers.filter(x => (x.tag || null) === tag).length + 1;
        const mk = { at: Math.max(0, pressedAt(m.at) - t.started), label: cleanText(m.label, tag === 'note' ? 300 : 80) || (tag ? `${post.TAGS[tag]} ${same}` : `Marker ${same}`), by: peer.name, ...(tag ? { tag } : {}) };
        t.markers.push(mk); saveTake(t, true);
        toHosts(lr, { t: 'marker', n: t.markers.length, ...mk });
        return;
      }
      case 'chan': { // the producer's Console settings for one person — remembered for next time, baked into the Producer mix
        const target = lr.peers.get(m.id); if (!target || target.control) return;
        const st = treat.cleanChannel(m.s);
        const room = loadRoom(roomId);
        if (room) { room.channels = room.channels || {}; room.channels[target.name] = st; saveRoom(room); }
        const t = lr.take && loadTake(roomId, lr.take);
        if (t) { t.channels = t.channels || {}; t.channels[target.clientId] = st; saveTake(t); }
        return;
      }
      case 'scene': { // store a Console scene (A/B/C) for this show: everyone's channel settings, by name
        if (!SCENE_SLOTS.includes(m.slot)) return;
        const room = loadRoom(roomId); if (!room) return;
        room.scenes = room.scenes || {};
        if (m.data === null) delete room.scenes[m.slot];
        else {
          const data = {};
          for (const [name, st] of Object.entries(m.data || {}).slice(0, 12)) { const n = cleanText(name, 60); if (n) data[n] = treat.cleanChannel(st); }
          room.scenes[m.slot] = { at: Date.now(), data };
        }
        saveRoom(room);
        toHosts(lr, { t: 'scenes', scenes: room.scenes });
        return;
      }
      case 'script': { // the show script / notes for the teleprompter — for the hosts only, or for everyone
        const room = loadRoom(roomId); if (!room) return;
        room.script = { text: String(m.text || '').replace(/\r\n?/g, '\n').slice(0, SCRIPT_MAX), share: m.share === 'all' ? 'all' : 'hosts', by: peer.name, at: Date.now() };
        saveRoom(room);
        for (const p of lr.peers.values()) send(p.ws, { t: 'script', script: scriptFor(room, p) });
        return;
      }
      case 'board': { // the producer played / stopped a soundboard pad — recorded so the Soundboard track matches what was heard
        const t = lr.take && loadTake(roomId, lr.take); if (!t) return;
        const room = loadRoom(roomId);
        t.board = t.board || [];
        const at = Math.max(0, pressedAt(m.at) - t.started), inst = String(m.inst || '').slice(0, 20);
        if (m.ev === 'start') {
          const pad = (room.sounds || []).find(p => p.id === m.sid); if (!pad || !inst) return;
          // keep a copy with the take, so editing or deleting the pad later never changes this recording
          const copy = path.join(takeDir(roomId, t.id), 'board', pad.id + '.wav');
          if (!fs.existsSync(copy)) { fs.mkdirSync(path.dirname(copy), { recursive: true }); fs.copyFileSync(padFile(roomId, pad.id), copy); }
          t.board.push({ inst, sid: pad.id, name: pad.name, mode: pad.mode, vol: Number.isFinite(+m.vol) ? Math.max(-60, Math.min(12, +m.vol)) : pad.vol, from: at, to: null, dur: pad.dur, duck: m.duck !== false });
        } else if (m.ev === 'stop') {
          const ev = t.board.find(e => e.inst === inst && e.to == null); if (ev) ev.to = Math.max(ev.from + 50, at);
        } else return;
        saveTake(t);
        return;
      }
      case 'ride': { // the host moved a fader on the producer desk — baked into the Producer mix
        const target = lr.peers.get(m.id); if (!target) return;
        const db = m.db === null ? null : Number(m.db);
        if (db !== null && !(Number.isFinite(db) && db >= -60 && db <= 12)) return;
        const t = lr.take && loadTake(roomId, lr.take); if (!t) return;
        t.rides = t.rides || {}; const list = t.rides[target.clientId] || (t.rides[target.clientId] = []);
        list.push({ at: Math.max(0, pressedAt(m.at) - t.started), db });
        if (list.length > 20000) list.splice(0, list.length - 20000);
        saveTake(t);
        return;
      }
      case 'cue': { // big on-screen message for one person (or everyone)
        const text = cleanText(m.text, 120); if (!text) return;
        const msg = { t: 'cue', text, from: peer.name };
        if (m.to === 'all') broadcast(lr, msg, peer.id);
        else { const to = lr.peers.get(m.to); if (to) send(to.ws, msg); }
        return;
      }
      case 'talk': { // talkback: the host speaks privately to one person — muted in the Producer mix, marked in the edit list
        const to = lr.peers.get(m.to); if (!to || to === peer) return;
        const on = !!m.on;
        send(to.ws, { t: 'talk', from: peer.id, on, name: peer.name });
        if (on !== !!peer.talking) { peer.talking = on; if (!peer.control) markRange(lr, peer, on, 'talk', m.at); }
        return;
      }
      case 'segment': { // rundown: start a segment (or stop the clock with idx = -1)
        const room = loadRoom(roomId); const list = (room && room.rundown) || [];
        const idx = Number(m.idx);
        const cur = lr.take && loadTake(roomId, lr.take);
        if (idx === -1) { lr.segment = null; if (cur) { cur.segment = null; saveTake(cur, true); } broadcast(lr, { t: 'segment', segment: null }); return; }
        if (!Number.isInteger(idx) || !list[idx]) return;
        lr.segment = { idx, name: list[idx].name, mins: list[idx].mins, at: pressedAt(m.at) };
        broadcast(lr, { t: 'segment', segment: lr.segment });
        const t = cur;
        if (t) { t.segment = lr.segment; t.markers = t.markers || []; const mk = { at: Math.max(0, lr.segment.at - t.started), label: list[idx].name, by: peer.name, tag: 'segment' }; t.markers.push(mk); saveTake(t, true); toHosts(lr, { t: 'marker', n: t.markers.length, ...mk }); }
        return;
      }
      case 'admit': {
        const w = lr.waiting.get(m.id); if (!w) return;
        lr.waiting.delete(m.id);
        toHosts(lr, { t: 'knock-gone', id: m.id });
        if (m.allow) w.go(m.green);
        else { send(w.ws, { t: 'error', code: 'denied', msg: 'The host didn\'t let you in this time.' }); try { w.ws.close(); } catch (e) { log.ignore('ws', 'close denied guest')(e); } }
        return;
      }
      case 'onair': { // bring a guest out of the green room: they meet everyone, and join the recording if it's running
        const g = lr.peers.get(m.id); if (!g || !g.green) return;
        g.green = false; lr.green.delete(g.clientId);
        const others = [...lr.peers.values()].filter(p => p !== g && !p.isHost && !p.green);
        send(g.ws, { t: 'onair', peers: others.map(peerInfo) });
        for (const p of others) send(p.ws, { t: 'peer-joined', peer: peerInfo(g) });
        toHosts(lr, { t: 'onair', id: g.id });
        const t = lr.take && loadTake(roomId, lr.take);
        if (t && !g.control) { g.seg = newSeg(t, g); send(g.ws, startMsg(t, g.seg)); }
        return;
      }
      case 'control': { // the producer helps a guest from the desk: switch their mic, headphones mode, mute
        const to = lr.peers.get(m.to); if (!to || to.isHost) return;
        if (!['mic', 'headphones', 'mute', 'unmute'].includes(m.action)) return;
        send(to.ws, { t: 'control', action: m.action, value: typeof m.value === 'string' ? m.value.slice(0, 200) : !!m.value, from: peer.name });
        return;
      }
      case 'kick': { const p = lr.peers.get(m.id); if (p && p !== peer) { lr.admitted.delete(p.clientId); try { const f = path.join(roomDir(roomId), 'admitted.json'); const sv = readJSON(f, {}) || {}; delete sv[p.clientId]; writeJSON(f, sv); } catch (e) { log.warn('rooms', 'could not forget a removed guest', e); } send(p.ws, { t: 'error', code: 'kicked', msg: 'The host removed you from the studio.' }); p.ws.close(); } return; }
    }
  });
  ws.on('close', () => {
    if (waiting && lr) { lr.waiting.delete(waiting.id); toHosts(lr, { t: 'knock-gone', id: waiting.id }); }
    if (!peer || !lr) return;
    if (peer.coughing) { peer.coughing = false; broadcast(lr, { t: 'cough', id: peer.id, on: false }); markRange(lr, peer, false, 'cough'); } // left mid-cough
    if (peer.talking) { peer.talking = false; markRange(lr, peer, false, 'talk'); }
    if (lr.peers.get(peer.id) === peer) {
      lr.peers.delete(peer.id);
      broadcast(lr, { t: 'peer-left', id: peer.id });
      log.info('room', `${peer.name} left (${lr.peers.size} in room)`);
    }
    for (const t of listTakes(roomId)) if (t.status === 'waiting') setTimeout(() => checkTakeReady(roomId, t.id), 60 * 1000);
    if (lr.peers.size === 0 && lr.take) scheduleEmptyStop(roomId, lr, 5);
  });
});
// a stretch of a person's recording that's muted in the Producer mix and listed in the edit list (cough button, talkback)
function markRange(lr, peer, on, kind, when) {
  const tk = lr.take && loadTake(lr.id, lr.take); if (!tk) return;
  tk.coughs = tk.coughs || {};
  const list = tk.coughs[peer.clientId] || (tk.coughs[peer.clientId] = []);
  const at = Math.max(0, pressedAt(when) - tk.started);
  if (on) list.push({ from: at, to: null, ...(kind === 'talk' ? { kind } : {}) });
  else { const open = list.slice().reverse().find(c => c.to == null && (c.kind || 'cough') === kind); if (open) open.to = Math.max(open.from + 50, at); }
  saveTake(tk);
}
// when something happened: the moment the button was pressed (the browser's clock is synced to ours), so markers
// land exactly where the person pressed even on a slow connection; anything odd falls back to the time it arrived
function pressedAt(v) { return Number.isFinite(v) && Math.abs(v - Date.now()) < 5000 ? v : Date.now(); }
function scheduleEmptyStop(roomId, lr, minutes) {
  const take = lr.take;
  setTimeout(() => { if (lr.peers.size === 0 && lr.take === take) { log.info('rec', 'nobody came back — stopping take'); stopRecording(roomId, lr); } }, minutes * 60 * 1000);
}
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) { log.ignore('ws', 'ping')(e); } } }, 20000);
// live transcription: every 10 s, transcribe new audio from takes that are recording and tell hosts how far it has got
setInterval(() => {
  const takes = [];
  for (const [id, lr] of live) if (lr.take) {
    const t = loadTake(id, lr.take); if (!t) continue;
    takes.push(t);
    toHosts(lr, { t: 'tx', take: t.id, ...transcriptStatus(t) });
  }
  transcriber.tickLive(takes);
}, (Number(process.env.LIVE_TX_SECONDS) || 10) * 1000);
// hosts get server health every 30 s
setInterval(async () => { const st = await studioStatus(); for (const lr of live.values()) if (lr.peers.size) toHosts(lr, { t: 'server', disk: st.disk, studio: st }); }, 15000);

// ---------- start-up: carry on after a restart / power cut ----------
for (const id of fs.readdirSync(ROOMS_DIR)) {
  if (!loadRoom(id)) continue;
  for (const t of listTakes(id)) {
    if (t.status === 'recording') {
      // the take was still running: keep it open so everyone's browser reconnects and carries on
      const lr = liveRoom(id);
      if (!lr.take) { lr.take = t.id; lr.segment = t.segment || null; log.info('rec', `resuming take ${t.n} in "${id}" after restart`); scheduleEmptyStop(id, lr, 10); }
      else { t.status = 'waiting'; t.stopped = t.stopped || Date.now(); saveTake(t, true); queueProcess(id, t.id); }
    } else if (['waiting', 'queued', 'processing'].includes(t.status)) queueProcess(id, t.id);
    else if (t.status === 'ready' && t.cloud && t.cloud.busy) { // a cloud upload cut off by the restart: start it again
      t.cloud = { ...t.cloud, busy: false, error: 'interrupted by a restart — uploading again' }; saveTake(t, true); queueCloud(id, t.id);
    }
  }
}

server.listen(PORT, BIND, () => log.info('server', `${STUDIO_NAME} v${VERSION} running on http://${BIND}:${PORT}  (recordings in ${DATA_DIR})`));
