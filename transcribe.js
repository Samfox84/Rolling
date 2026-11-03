'use strict';
/*
 * Rolling — transcription with whisper.cpp, running on this server (free, private).
 *
 * Everyone is recorded separately, so each person's audio is transcribed on its own and the
 * transcript knows exactly who said what. While a take is recording, new audio is transcribed
 * in ~30-second chunks in the background (cut at quiet moments), so when the host presses
 * Stop the transcript is nearly finished.
 */
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const log = require('./log');
const { run } = require('./proc');

const HALLUCINATION = /^\s*(\[.*\]|\(.*\)|♪+|thank you\.?|thanks for watching!?|you\.?|bye\.?|\.+)\s*$/i;

module.exports = function createTranscriber({ settings, FFMPEG, takeDir, saveTake }) {
  const BIN = process.env.WHISPER_BIN || '/opt/rolling-whisper/whisper.cpp/build/bin/whisper-cli';
  const MODELS = process.env.WHISPER_MODELS || '/opt/rolling-whisper/models';
  const threads = Math.max(1, Math.min(8, os.cpus().length - 1));
  const tmpDir = path.join(os.tmpdir(), 'rolling-transcribe');
  fs.mkdirSync(tmpDir, { recursive: true });

  const cfg = () => Object.assign({ enabled: true, model: 'base.en', language: 'auto' }, settings.transcribe);
  const modelPath = m => path.join(MODELS, `ggml-${m || cfg().model}.bin`);
  const installedModels = () => { try { return fs.readdirSync(MODELS).filter(f => /^ggml-.*\.bin$/.test(f)).map(f => f.slice(5, -4)); } catch { return []; } };
  const available = () => fs.existsSync(BIN) && fs.existsSync(modelPath());
  const enabled = () => cfg().enabled !== false && available();

  // one whisper job at a time, so live recording always has CPU to spare
  let chain = Promise.resolve();
  const queueJob = fn => (chain = chain.then(fn, fn));
  const scheduled = new Set();

  const pcmFile = (t, s) => path.join(takeDir(t.room, t.id), 'segs', s.id, 'audio.pcm');
  async function readSamples(file, from, to) {
    const fh = await fsp.open(file, 'r');
    try {
      const len = Math.max(0, (to - from) * 3), buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, from * 3);
      const n = Math.floor(bytesRead / 3), out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readIntLE(i * 3, 3) / 8388608;
      return out;
    } finally { await fh.close(); }
  }
  // the quietest 100 ms between two points — a good place to cut so words aren't split
  async function quietPoint(file, from, to, rate) {
    const x = await readSamples(file, from, to), win = Math.round(rate / 10);
    let best = from + Math.floor((to - from) / 2), bestE = Infinity;
    for (let i = 0; i + win <= x.length; i += win) { let e = 0; for (let j = i; j < i + win; j++) e += x[j] * x[j]; if (e < bestE) { bestE = e; best = from + i + (win >> 1); } }
    return best;
  }
  function whisper(wav, prefix) {
    const m = cfg().model, lang = /\.en$/.test(m) ? 'en' : (cfg().language || 'auto');
    const args = ['-m', modelPath(m), '-f', wav, '-oj', '-of', prefix, '-t', String(threads), '-l', lang, '-np', '-nth', '0.6'];
    return run(BIN, args, { stdout: 'ignore', timeoutMs: 20 * 60 * 1000, nice: fs.existsSync('/usr/bin/nice') });
  }
  function ffExtract(file, rate, from, to, wav) {
    return run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 's24le', '-ar', String(rate), '-ac', '1',
      '-ss', (from / rate).toFixed(4), '-t', ((to - from) / rate).toFixed(4), '-i', file, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav], { stdout: 'ignore', timeoutMs: 120000 });
  }

  // transcribe whatever new audio this person has (all of it if final)
  async function catchUp(t, s, final) {
    const a = s.audio; if (!a || !a.end || !a.first) return;
    const rate = a.rate || 48000, file = pcmFile(t, s);
    if (!fs.existsSync(file)) return;
    s.tx = s.tx || { done: 0, parts: [] };
    const segOffset = ((a.first.t - (a.first.s / rate) * 1000) - t.started) / 1000;
    const limit = final ? a.end : a.end - 5 * rate;
    while (limit - s.tx.done >= (final ? rate : 30 * rate)) {
      const start = s.tx.done;
      const end = final && limit - start <= 40 * rate ? limit : await quietPoint(file, start + 25 * rate, Math.min(start + 35 * rate, limit), rate);
      const x = await readSamples(file, start, end);
      let e = 0; for (let i = 0; i < x.length; i++) e += x[i] * x[i];
      const rms = Math.sqrt(e / Math.max(1, x.length));
      if (rms > 0.0018) { // about -55 dBFS: skip chunks with nobody talking (whisper invents words in silence)
        const id = `${t.id}-${s.id}-${start}`, wav = path.join(tmpDir, id + '.wav'), prefix = path.join(tmpDir, id);
        try {
          await ffExtract(file, rate, start, end, wav);
          await whisper(wav, prefix);
          const j = JSON.parse(await fsp.readFile(prefix + '.json', 'utf8'));
          for (const seg of j.transcription || []) {
            const text = String(seg.text || '').trim();
            if (!text || HALLUCINATION.test(text)) continue;
            s.tx.parts.push({ from: +(segOffset + start / rate + seg.offsets.from / 1000).toFixed(2), to: +(segOffset + start / rate + seg.offsets.to / 1000).toFixed(2), text });
          }
        } catch (err) { s.tx.error = String(err.message).slice(0, 300); log.warn('transcribe', `${s.name}: ${s.tx.error}`); }
        finally { fsp.rm(wav, { force: true }).catch(log.ignore('transcribe', 'remove temp wav')); fsp.rm(prefix + '.json', { force: true }).catch(log.ignore('transcribe', 'remove temp json')); }
      }
      s.tx.done = end;
      saveTake(t);
    }
  }

  // called every 20 s for takes that are recording
  function tickLive(takes) {
    if (!enabled()) return;
    for (const t of takes) for (const s of Object.values(t.segs)) {
      const k = t.id + '/' + s.id;
      if (scheduled.has(k) || !s.audio) continue;
      scheduled.add(k);
      queueJob(() => catchUp(t, s, false)).catch(e => log.warn('transcribe', `live chunk for ${s.name} failed`, e)).finally(() => scheduled.delete(k));
    }
  }
  // after Stop: finish everyone's transcript (onProgress gets 0..1)
  async function finishTake(t, onProgress) {
    if (!enabled()) return false;
    const segs = Object.values(t.segs).filter(s => s.audio && s.audio.end);
    const total = segs.reduce((n, s) => n + s.audio.end - ((s.tx && s.tx.done) || 0), 0) || 1;
    let did = 0;
    for (const s of segs) {
      const before = (s.tx && s.tx.done) || 0;
      const timer = setInterval(() => onProgress && onProgress(Math.min(1, (did + ((s.tx && s.tx.done) || 0) - before) / total)), 1000);
      try { await queueJob(() => catchUp(t, s, true)); } finally { clearInterval(timer); }
      did += s.audio.end - before;
      if (onProgress) onProgress(Math.min(1, did / total));
    }
    return true;
  }
  // how far through the transcript we are (for progress bars)
  function progress(t) {
    let done = 0, total = 0;
    for (const s of Object.values(t.segs)) if (s.audio && s.audio.end) { total += s.audio.end; done += Math.min(s.audio.end, (s.tx && s.tx.done) || 0); }
    return total ? Math.round((100 * done) / total) : 0;
  }
  return { available, enabled, installedModels, tickLive, finishTake: log.trace('transcribe', finishTake), progress, catchUp };
};
