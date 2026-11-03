// Runs on the audio thread: copies raw mic samples (no compression), reports levels,
// and spots glitches (moments the computer was too busy to process audio).
class StudioRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.size = 24000; // ~0.5 s per chunk at 48 kHz
    this.buf = new Float32Array(this.size + 256);
    this.n = 0;
    this.peak = 0;
    this.clips = 0;
    this.blocks = 0;
    this.lastFrame = -1;
    this.port.onmessage = e => {
      const m = e.data;
      if (m.cmd === 'start') { this.on = true; this.n = 0; }
      else if (m.cmd === 'stop') { this.flush(); this.on = false; this.port.postMessage({ type: 'stopped' }); }
    };
  }
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
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
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
    if (this.on) this.push(ch, len, currentFrame);
    return true;
  }
}
registerProcessor('studio-recorder', StudioRecorder);
