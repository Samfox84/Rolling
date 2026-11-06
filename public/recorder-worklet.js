// Runs on the audio thread:
//  * copies raw mic samples (no compression) for the lossless recording
//  * measures loudness the broadcast way (EBU R128 / ITU-R BS.1770): momentary, short-term,
//    integrated LUFS and true peak (dBTP, 4x oversampled)
//  * spots glitches (moments the computer was too busy to process audio)

// K-weighting filter coefficients for any sample rate (BS.1770 / libebur128 method)
function kWeighting(fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hpf = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  return [shelf, hpf];
}
// 4x oversampling filter for true peak (windowed sinc, 48 taps → 4 phases x 12)
function truePeakFilter() {
  const N = 48, h = new Float32Array(N); let sum = 0;
  for (let n = 0; n < N; n++) {
    const x = (n - (N - 1) / 2) / 4;
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (n + 0.5) / N);
    h[n] = sinc * w; sum += h[n];
  }
  for (let n = 0; n < N; n++) h[n] *= 4 / sum;
  return h;
}
const lufs = p => (p > 0 ? -0.691 + 10 * Math.log10(p) : -Infinity);

// One processor, two uses:
//  * each person's mic: records + meters (mono)
//  * the producer's Console master bus: meters only, stereo (processorOptions: { meterOnly: true })
class StudioRecorder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.meterOnly = !!(options && options.processorOptions && options.processorOptions.meterOnly);
    this.on = false;
    this.size = 24000; // ~0.5 s per chunk at 48 kHz
    this.buf = new Float32Array(this.size + 256);
    this.n = 0; this.peak = 0; this.clips = 0; this.blocks = 0; this.lastFrame = -1;
    // loudness state
    [this.k1, this.k2] = kWeighting(sampleRate);
    this.z = [new Float64Array(8), new Float64Array(8)]; // filter state per channel (left/mono, right)
    this.hop = Math.round(sampleRate / 10); // 100 ms
    this.hopN = 0; this.hopSum = 0;
    this.hops = new Float64Array(30); this.hopIdx = 0; this.hopCount = 0; // last 3 s
    this.hist = new Float64Array(800); this.histN = new Float64Array(800); // integrated gating histogram (0.1 LU bins from -70)
    this.tpH = truePeakFilter(); this.tpX = [new Float32Array(12), new Float32Array(12)]; this.tp = 0; this.tpMax = 0;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.cmd === 'start') { this.on = true; this.n = 0; this.resetLoud(); }
      else if (m.cmd === 'stop') { this.flush(); this.on = false; this.port.postMessage({ type: 'stopped' }); }
      else if (m.cmd === 'resetLoud') this.resetLoud();
    };
  }
  resetLoud() { this.hist.fill(0); this.histN.fill(0); this.tpMax = 0; }
  flush() {
    if (!this.n) return;
    const data = this.buf.slice(0, this.n);
    this.port.postMessage({ type: 'pcm', data, time: this.chunkTime }, [data.buffer]);
    this.n = 0;
  }
  push(src, len, frame) {
    if (this.n === 0) this.chunkTime = frame / sampleRate; // audio-clock time of this chunk's first sample
    if (src) this.buf.set(src, this.n); else this.buf.fill(0, this.n, this.n + len);
    this.n += len;
    if (this.n >= this.size) this.flush();
  }
  // chs: [mono] or [left, right]. BS.1770: the K-weighted energy of each channel is added together.
  measure(chs, len) {
    const [b0, b1, b2, a1, a2] = this.k1, [c0, c1, c2, d1, d2] = this.k2, h = this.tpH;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < chs.length; c++) {
        const ch = chs[c], z = this.z[c], X = this.tpX[c];
        const x = ch ? ch[i] : 0;
        // K-weighting (two biquads, direct form I)
        const y1 = b0 * x + b1 * z[0] + b2 * z[1] - a1 * z[2] - a2 * z[3];
        z[1] = z[0]; z[0] = x; z[3] = z[2]; z[2] = y1;
        const y2 = c0 * y1 + c1 * z[4] + c2 * z[5] - d1 * z[6] - d2 * z[7];
        z[5] = z[4]; z[4] = y1; z[7] = z[6]; z[6] = y2;
        this.hopSum += y2 * y2;
        // true peak: 4 interpolated points per sample
        X.copyWithin(1, 0); X[0] = x;
        for (let p = 0; p < 4; p++) { let s = 0; for (let k = 0; k < 12; k++) s += h[k * 4 + p] * X[k]; const a = s < 0 ? -s : s; if (a > this.tp) this.tp = a; }
      }
      if (++this.hopN >= this.hop) this.endHop();
    }
  }
  endHop() {
    const p = this.hopSum / this.hopN;
    this.hops[this.hopIdx] = p; this.hopIdx = (this.hopIdx + 1) % 30; this.hopCount = Math.min(30, this.hopCount + 1);
    this.hopSum = 0; this.hopN = 0;
    let m = 0, s = 0;
    for (let i = 1; i <= 30 && i <= this.hopCount; i++) { const v = this.hops[(this.hopIdx - i + 30) % 30]; if (i <= 4) m += v; s += v; }
    const M = m / Math.min(4, this.hopCount), S = s / this.hopCount;
    const Ml = lufs(M);
    if ((this.on || this.meterOnly) && this.hopCount >= 4 && Ml > -70) { const b = Math.min(799, Math.floor((Ml + 70) * 10)); this.hist[b] += M; this.histN[b]++; }
    // integrated loudness with the two BS.1770 gates (absolute -70, relative -10 LU)
    let tot = 0, cnt = 0;
    for (let b = 0; b < 800; b++) { tot += this.hist[b]; cnt += this.histN[b]; }
    let I = -Infinity;
    if (cnt) {
      const gate = lufs(tot / cnt) - 10, gb = Math.max(0, Math.ceil((gate + 70) * 10));
      let t2 = 0, c2 = 0; for (let b = gb; b < 800; b++) { t2 += this.hist[b]; c2 += this.histN[b]; }
      if (c2) I = lufs(t2 / c2);
    }
    if (this.tp > this.tpMax) this.tpMax = this.tp;
    const db = v => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    this.port.postMessage({ type: 'loud', M: Ml, S: lufs(S), I, TP: db(this.tp), TPmax: db(this.tpMax) });
    this.tp = 0;
  }
  process(inputs) {
    const chs = (inputs[0] && inputs[0].length ? inputs[0] : [undefined]).slice(0, 2), ch = chs[0];
    const len = ch ? ch.length : 128;
    // glitch check: the audio clock jumped, so some sound was never delivered to us
    if (this.lastFrame >= 0 && currentFrame !== this.lastFrame + len) {
      const missing = currentFrame - this.lastFrame - len;
      if (missing > 0) {
        this.port.postMessage({ type: 'glitch', frames: missing });
        // keep the recording's timeline correct by filling the gap with silence
        if (this.on) { let f = this.lastFrame + len; const end = f + Math.min(missing, sampleRate * 2); while (f < end) { const k = Math.min(128, end - f); this.push(null, k, f); f += k; } }
      }
    }
    this.lastFrame = currentFrame;
    if (ch) for (let i = 0; i < len; i++) { const v = Math.abs(ch[i]); if (v > this.peak) this.peak = v; if (v >= 0.985) this.clips++; }
    if (++this.blocks >= 8) { this.port.postMessage({ type: 'level', peak: this.peak, clips: this.clips }); this.peak = 0; this.clips = 0; this.blocks = 0; }
    this.measure(chs, len);
    if (this.on && !this.meterOnly) this.push(ch, len, currentFrame);
    return true;
  }
}
registerProcessor('studio-recorder', StudioRecorder);
