'use strict';
// Shared test helpers. Tests never call the internet: NO_EXTERNAL_CALLS=1 and a stand-in for whisper.cpp.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FAKE_WHISPER = path.join(__dirname, 'fixtures', 'fake-whisper.js');
const FAKE_RCLONE = path.join(__dirname, 'fixtures', 'fake-rclone.js');

function tmpDir(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `rolling-${name}-`)); }

/** 24-bit little-endian mono PCM. shape(t) returns the sample value (-1..1) at time t seconds. */
function pcm24(seconds, shape, rate = 48000) {
  const n = Math.round(seconds * rate), b = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    let x = Math.round(Math.max(-1, Math.min(1, shape(i / rate))) * 8388607);
    if (x < 0) x += 16777216;
    b[i * 3] = x & 255; b[i * 3 + 1] = (x >> 8) & 255; b[i * 3 + 2] = (x >> 16) & 255;
  }
  return b;
}
/** speech-like test signal: noise bursts that come and go (not periodic), silent where quiet(t) is true */
function talky(seed = 1, quiet = () => false) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 - 0.5; };
  return t => (quiet(t) ? 0 : (Math.sin(t * 2.7 + seed) > -0.2 ? 0.35 : 0.02) * rnd() * 2);
}
/** integrated loudness + true peak of a file, measured by ffmpeg (the reference meter) */
function ffMeasure(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8' });
  const sum = r.stderr.slice(r.stderr.lastIndexOf('Summary'));
  const g = re => { const m = sum.match(re); return m ? parseFloat(m[1]) : NaN; };
  return { I: g(/I:\s+(-?[\d.]+)\s+LUFS/), TP: g(/Peak:\s+(-?[\d.]+)\s+dBFS/) };
}
function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return parseFloat(r.stdout);
}
/** tiny XML well-formedness check (balanced tags, quoted attributes) — no dependency needed */
function xmlWellFormed(xml) {
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack = [];
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g)) {
    const [, close, name, , self] = m;
    if (self) continue;
    if (close) { if (stack.pop() !== name) return false; } else stack.push(name);
  }
  const stray = body.replace(/<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/?)>/g, '');
  return stack.length === 0 && !/[<>]/.test(stray);
}

/** Start a real server on a free port with its own data folder (pass DATA_DIR + PORT to restart the same studio). */
async function startServer(extraEnv = {}) {
  const dataDir = extraEnv.DATA_DIR || tmpDir('data');
  fs.chmodSync(FAKE_WHISPER, 0o755);
  fs.chmodSync(FAKE_RCLONE, 0o755);
  const models = tmpDir('models'); fs.writeFileSync(path.join(models, 'ggml-base.en.bin'), 'test');
  const port = Number(extraEnv.PORT) || 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), BIND: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: 'testpass', SECRET: 'testsecret',
    ROOM_TONE_SECONDS: '3', LATE_REBUILD_SECONDS: '2', LIVE_TX_SECONDS: '1', FAKE_WHISPER_FAIL_FLAG: path.join(dataDir, 'whisper-fail'), NO_EXTERNAL_CALLS: '1', WHISPER_BIN: FAKE_WHISPER, WHISPER_MODELS: models, RCLONE: FAKE_RCLONE, FAKE_RCLONE_ROOT: path.join(dataDir, 'pretend-cloud'), CLOUD_RETRY_MS: '1500', LOG_LEVEL: 'warn', ...extraEnv };
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: os.tmpdir() });
  let logs = '';
  proc.stdout.on('data', d => { logs += d; });
  proc.stderr.on('data', d => { logs += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(url + '/api/info'); if (r.ok) break; } catch (e) { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
    if (i === 99) throw new Error('server did not start:\n' + logs);
  }
  const end = sig => new Promise(r => { if (proc.exitCode !== null || proc.signalCode) return r(); proc.once('exit', r); proc.kill(sig); });
  return { url, port, dataDir, proc, logs: () => logs, stop: () => end('SIGTERM'), crash: () => end('SIGKILL') }; // crash = like pulling the power
}
async function login(url, password = 'testpass') {
  const r = await fetch(url + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function waitFor(fn, ms = 120000, every = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, every));
  }
}

// An Altered Audio Editor session (.altaudio): checked against Altered's own published schema (tests/fixtures/altered),
// plus the rules Altered checks when it opens one (its validate.rs): unique ids, clips point at real media and play
// something, chapter data only on chapters, a contracted length only on ad slots, bit depth 16/24/32.
// Returns a list of problems (empty = Altered will open it).
let alteredSchema = null;
function alteredProblems(doc) {
  if (!alteredSchema) {
    const Ajv = require('ajv/dist/2020');
    const ajv = new Ajv({ strict: false, allErrors: true });
    const schema = require('./fixtures/altered/session.schema.json');
    const formats = new Set(); JSON.stringify(schema, (k, v) => { if (k === 'format' && typeof v === 'string') formats.add(v); return v; });
    const uint = bits => n => Number.isInteger(n) && n >= 0 && n < 2 ** bits;
    const known = { uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'date-time': /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/,
      uint8: { type: 'number', validate: uint(8) }, uint16: { type: 'number', validate: uint(16) }, uint32: { type: 'number', validate: uint(32) },
      uint64: { type: 'number', validate: n => Number.isSafeInteger(n) && n >= 0 }, double: { type: 'number', validate: Number.isFinite }, float: { type: 'number', validate: Number.isFinite } };
    for (const f of formats) ajv.addFormat(f, known[f] || true);
    alteredSchema = ajv.compile(schema);
  }
  const problems = alteredSchema(doc) ? [] : alteredSchema.errors.map(e => `${e.instancePath || '/'} ${e.message}`);
  if (![16, 24, 32].includes(doc.bit_depth)) problems.push('bit depth must be 16, 24 or 32');
  const ids = [doc.id, ...doc.media.map(m => m.id), ...doc.tracks.flatMap(t => [t.id, ...t.clips.map(c => c.id)]), ...doc.buses.map(b => b.id), ...doc.markers.map(m => m.id)];
  if (new Set(ids).size !== ids.length) problems.push('duplicate ids');
  const media = new Set(doc.media.map(m => m.id));
  doc.tracks.forEach((t, i) => t.clips.forEach((c, j) => {
    if (!media.has(c.media_id)) problems.push(`tracks[${i}].clips[${j}] uses missing media`);
    if (!(c.source_out > c.source_in)) problems.push(`tracks[${i}].clips[${j}] plays nothing`);
  }));
  doc.markers.forEach((m, i) => {
    if (m.chapter && m.kind !== 'chapter') problems.push(`markers[${i}] has chapter data but is not a chapter`);
    if (m.contracted_duration != null && m.kind !== 'ad_slot') problems.push(`markers[${i}] has a contracted length but is not an ad slot`);
  });
  return problems;
}

module.exports = { alteredProblems, ROOT, FAKE_WHISPER, tmpDir, pcm24, talky, ffMeasure, duration, xmlWellFormed, startServer, login, waitFor };
