'use strict';
/*
 * Rolling — "treatment" made after each take, next to the untouched recordings (which are never changed):
 *   • a cleaned copy of each voice (declip, rumble + mains hum, noise reduction set from the room tone's measured noise level,
 *     optional gate, de-ess, gentle compression), normalised to −16 LUFS
 *   • the Producer mix: everyone mixed with the host's live fader moves and each person's cough-button
 *     presses applied, exactly as they happened during the show
 *   • long pauses, found in the Producer mix, for quick tightening in the edit
 */
const fs = require('fs');
const fsp = fs.promises;

const DEFAULTS = { auto: true, declip: true, rumble: true, mains: 50, noise: 'medium', gate: false, deess: true, compress: true, pauses: 3 };
const NOISE_DB = { light: 6, medium: 12, strong: 20 };
const RIDE_RAMP = 0.03;  // seconds — fader moves glide, never click
const COUGH_RAMP = 0.015;

/** settings with defaults filled in and every value checked */
function cfg(s) {
  const c = Object.assign({}, DEFAULTS, s || {});
  return {
    auto: c.auto !== false, declip: !!c.declip, rumble: !!c.rumble, mains: Number(c.mains) === 60 ? 60 : 50,
    noise: ['off', 'light', 'medium', 'strong'].includes(c.noise) ? c.noise : 'medium',
    gate: !!c.gate, deess: !!c.deess, compress: !!c.compress,
    pauses: Math.max(0, Math.min(30, Number(c.pauses) || 0)),
  };
}

/** the ffmpeg filter chain for one voice; noiseDb = the measured level of this person's room tone (dBFS), or null */
function cleanFilter(c, noiseDb) {
  const f = [];
  if (c.declip) f.push('adeclip');
  if (c.rumble) {
    f.push('highpass=f=80');
    for (let k = 1; k <= 3; k++) f.push(`bandreject=f=${c.mains * k}:width_type=q:w=30`);
  }
  if (c.noise !== 'off') {
    const nr = NOISE_DB[c.noise];
    // the room tone tells us exactly how loud this person's background noise is; without one, follow the noise as it goes
    if (Number.isFinite(noiseDb)) f.push(`afftdn=nr=${nr}:nf=${Math.max(-80, Math.min(-20, noiseDb)).toFixed(1)}`);
    else f.push(`afftdn=nr=${nr}:nf=-50:tn=1`);
  }
  if (c.gate) f.push('agate=threshold=0.02:ratio=4:range=0.0625:attack=5:release=250');
  if (c.deess) f.push('deesser=i=0.4');
  if (c.compress) f.push('acompressor=threshold=-24dB:ratio=3:attack=10:release=200:knee=4');
  return f.length ? f.join(',') : 'anull';
}

/**
 * gain(t) for one person in the Producer mix.
 *   rides:  [{ at: ms from take start, db: number | null (fader off) }] — the host's fader moves
 *   coughs: [{ from: ms, to: ms }] — times this person held the cough button
 *   baseDb: fixed gain (e.g. to bring a cleaned −16 LUFS copy back to how loud it was live)
 * Returns { at(seconds) → linear gain } that must be called with increasing times (it walks forwards).
 */
function envelope(rides, coughs, baseDb = 0) {
  const pts = (rides || []).filter(r => Number.isFinite(r.at)).map(r => ({ t: r.at / 1000, g: r.db === null || r.db === undefined || !Number.isFinite(r.db) ? 0 : 10 ** (r.db / 20) })).sort((a, b) => a.t - b.t);
  const cs = (coughs || []).filter(c => Number.isFinite(c.from) && Number.isFinite(c.to) && c.to > c.from).map(c => ({ a: c.from / 1000, b: c.to / 1000 })).sort((x, y) => x.a - y.a);
  const base = 10 ** (baseDb / 20);
  let i = -1, j = 0;
  return {
    at(t) {
      while (i + 1 < pts.length && pts[i + 1].t <= t) i++;
      let g = 1;
      if (i >= 0) {
        const p = pts[i], prev = i > 0 ? pts[i - 1].g : 1;
        g = t - p.t < RIDE_RAMP ? prev + (p.g - prev) * ((t - p.t) / RIDE_RAMP) : p.g;
      }
      while (j < cs.length && cs[j].b + COUGH_RAMP <= t) j++;
      let c = 1;
      for (let k = j; k < cs.length && cs[k].a - COUGH_RAMP <= t; k++) {
        const x = cs[k];
        const f = t < x.a ? (x.a - t) / COUGH_RAMP : t > x.b ? (t - x.b) / COUGH_RAMP : 0;
        c = Math.min(c, Math.max(0, Math.min(1, f)));
      }
      return g * c * base;
    },
  };
}

// ---------- WAV in / out (mono 24-bit PCM or 32-bit float, as ffmpeg writes them) ----------
async function openWav(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(65536);
    const { bytesRead } = await fh.read(head, 0, head.length, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV file`);
    let p = 12, fmt = null;
    while (p + 8 <= bytesRead) {
      const id = head.toString('ascii', p, p + 4), size = head.readUInt32LE(p + 4);
      if (id === 'fmt ') fmt = { tag: head.readUInt16LE(p + 8), ch: head.readUInt16LE(p + 10), rate: head.readUInt32LE(p + 12), bits: head.readUInt16LE(p + 22) };
      if (id === 'data') {
        if (!fmt) throw new Error(`${file}: no format chunk`);
        const tag = fmt.tag === 0xfffe ? (fmt.bits === 32 ? 3 : 1) : fmt.tag;
        if (fmt.ch !== 1 || !((tag === 1 && fmt.bits === 24) || (tag === 3 && fmt.bits === 32))) throw new Error(`${file}: expected mono 24-bit or 32-bit float audio`);
        const bps = fmt.bits / 8, st = await fh.stat();
        const bytes = Math.min(size, st.size - (p + 8));
        return { fh, rate: fmt.rate, float: tag === 3, bps, offset: p + 8, frames: Math.floor(bytes / bps) };
      }
      p += 8 + size + (size & 1);
    }
    throw new Error(`${file}: no audio data found`);
  } catch (e) { await fh.close(); throw e; }
}
function wavHeader(frames, rate) {
  const h = Buffer.alloc(44), bytes = frames * 4;
  h.write('RIFF', 0); h.writeUInt32LE(36 + bytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34);
  h.write('data', 36); h.writeUInt32LE(bytes, 40);
  return h;
}

/**
 * Mix mono WAVs, each with its own gain envelope, into one 32-bit float WAV (can't clip).
 * inputs: [{ file, gain: envelope(...) }]  → resolves to the length in seconds
 */
async function mixWithEnvelopes(inputs, outFile, onProgress) {
  const srcs = [];
  try {
    for (const i of inputs) srcs.push({ ...(await openWav(i.file)), gain: i.gain });
    if (!srcs.length) throw new Error('nothing to mix');
    const rate = srcs[0].rate;
    if (srcs.some(s => s.rate !== rate)) throw new Error('the voices have different sample rates');
    const frames = Math.max(...srcs.map(s => s.frames)), BLOCK = rate;
    const out = await fsp.open(outFile, 'w');
    try {
      await out.write(wavHeader(frames, rate), 0, 44, 0);
      const acc = new Float32Array(BLOCK), raw = Buffer.alloc(BLOCK * 4);
      for (let pos = 0; pos < frames; pos += BLOCK) {
        const n = Math.min(BLOCK, frames - pos);
        acc.fill(0, 0, n);
        for (const s of srcs) {
          const m = Math.min(n, s.frames - pos); if (m <= 0) continue;
          const { bytesRead } = await s.fh.read(raw, 0, m * s.bps, s.offset + pos * s.bps);
          const got = Math.floor(bytesRead / s.bps);
          if (s.float) { const f = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + got * 4)); for (let k = 0; k < got; k++) acc[k] += f[k] * s.gain.at((pos + k) / rate); }
          else for (let k = 0, b = 0; k < got; k++, b += 3) acc[k] += ((((raw[b] | (raw[b + 1] << 8) | (raw[b + 2] << 16)) << 8) >> 8) / 8388608) * s.gain.at((pos + k) / rate);
        }
        const ob = Buffer.from(acc.buffer, 0, n * 4);
        await out.write(ob, 0, n * 4, 44 + pos * 4);
        if (onProgress) onProgress((pos + n) / frames);
      }
    } finally { await out.close(); }
    return frames / rate;
  } finally { for (const s of srcs) await s.fh.close(); }
}

/** the overall RMS level (dBFS) from ffmpeg's astats output — used to measure room tone */
function parseRms(stderr) {
  const m = String(stderr).match(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/);
  return m && m[1] !== '-inf' ? parseFloat(m[1]) : null;
}
/** read ffmpeg's silencedetect results (written by ametadata) → [{ at: seconds, dur: seconds }] */
function parsePauses(text) {
  const out = []; let start = null;
  for (const line of String(text).split(/\r?\n/)) {
    const a = line.match(/lavfi\.silence_start=([\d.]+)/); if (a) { start = parseFloat(a[1]); continue; }
    const b = line.match(/lavfi\.silence_end=([\d.]+)/);
    if (b && start !== null) { const end = parseFloat(b[1]); if (end > start) out.push({ at: +start.toFixed(2), dur: +(end - start).toFixed(2) }); start = null; }
  }
  return out;
}
function pauseFilter(seconds, file) { return `silencedetect=n=-45dB:d=${seconds},ametadata=mode=print:file='${file.replace(/\\/g, '/').replace(/'/g, '')}'`; }

module.exports = { cfg, cleanFilter, envelope, mixWithEnvelopes, parseRms, parsePauses, pauseFilter };
