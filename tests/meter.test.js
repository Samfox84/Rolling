'use strict';
// The in-browser loudness meter (public/recorder-worklet.js), run here exactly as the browser runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/** Load the worklet with the globals an AudioWorklet provides, feed it samples, return its messages. */
function loadWorklet(rate, msgs) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'recorder-worklet.js'), 'utf8');
  const procs = {};
  const G = { sampleRate: rate, currentFrame: 0, currentTime: 0, registerProcessor: (n, c) => { procs[n] = c; },
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => msgs.push(m), onmessage: null }; } } };
  new Function('G', 'with (G) {' + src + '}')(new Proxy(G, { has: () => true, get: (t, k) => (k in t ? t[k] : globalThis[k]), set: (t, k, v) => { t[k] = v; return true; } }));
  return { procs, G };
}
function runWorklet(samples, rate = 48000, startRecording = true) {
  const msgs = [], { procs, G } = loadWorklet(rate, msgs);
  const p = new procs['studio-recorder']();
  if (startRecording) p.port.onmessage({ data: { cmd: 'start' } });
  for (let i = 0; i + 128 <= samples.length; i += 128) { G.currentFrame = i; G.currentTime = i / rate; p.process([[samples.subarray(i, i + 128)]]); }
  return { msgs, proc: p, G };
}
const sine = (amp, f, secs, rate = 48000, ph = 0) => { const a = new Float32Array(rate * secs); for (let i = 0; i < a.length; i++) a[i] = amp * Math.sin(2 * Math.PI * f * i / rate + ph); return a; };
const lastLoud = msgs => msgs.filter(m => m.type === 'loud').pop();

test('EBU R128 reference: 1 kHz sine at -20 dBFS reads -23.0 LUFS (short-term and integrated)', () => {
  const L = lastLoud(runWorklet(sine(0.1, 1000, 10)).msgs);
  assert.ok(Math.abs(L.I - -23.01) < 0.05, `I was ${L.I}`);
  assert.ok(Math.abs(L.S - -23.01) < 0.05, `S was ${L.S}`);
  assert.ok(Math.abs(L.TPmax - -20) < 0.05, `TP was ${L.TPmax}`);
});
test('works at 44.1 kHz too (filter coefficients are computed, not hard-coded)', () => {
  const L = lastLoud(runWorklet(sine(0.1, 1000, 8, 44100), 44100).msgs);
  assert.ok(Math.abs(L.I - -23.01) < 0.1, `I was ${L.I}`);
});
test('true peak catches inter-sample peaks that sample peak misses', () => {
  const L = lastLoud(runWorklet(sine(1, 12000, 3, 48000, Math.PI / 4)).msgs);
  assert.ok(L.TPmax > -0.3, `true peak was ${L.TPmax}`);
});
test('silence reads -Infinity, not a made-up number', () => {
  const L = lastLoud(runWorklet(new Float32Array(48000 * 3)).msgs);
  assert.equal(L.I, -Infinity); assert.equal(L.M, -Infinity);
});
test('integrated loudness ignores silence (gating) — a talker with pauses reads like the talker', () => {
  const a = sine(0.1, 1000, 12); for (let i = 48000 * 4; i < 48000 * 8; i++) a[i] = 0; // 4 s pause
  const L = lastLoud(runWorklet(a).msgs);
  assert.ok(Math.abs(L.I - -23.01) < 0.2, `I was ${L.I}`);
});
test('recording copies every sample in order (lossless) and stop flushes the remainder', () => {
  const a = sine(0.3, 440, 1.3);
  const { msgs, proc } = runWorklet(a);
  proc.port.onmessage({ data: { cmd: 'stop' } });
  const pcm = msgs.filter(m => m.type === 'pcm');
  const total = pcm.reduce((n, m) => n + m.data.length, 0);
  assert.equal(total, Math.floor(a.length / 128) * 128);
  assert.equal(pcm[0].data[1000], a[1000]);
  assert.ok(msgs.some(m => m.type === 'stopped'));
});
test('a glitch (audio clock jump) is reported and filled with silence to keep the timeline', () => {
  const msgs = [], { procs, G } = loadWorklet(48000, msgs);
  const p = new procs['studio-recorder'](); p.port.onmessage({ data: { cmd: 'start' } });
  const block = new Float32Array(128).fill(0.5);
  G.currentFrame = 0; p.process([[block]]);
  G.currentFrame = 128 + 1024; p.process([[block]]); // 1024 frames went missing
  p.port.onmessage({ data: { cmd: 'stop' } });
  assert.deepEqual(msgs.find(m => m.type === 'glitch'), { type: 'glitch', frames: 1024 });
  const total = msgs.filter(m => m.type === 'pcm').reduce((n, m) => n + m.data.length, 0);
  assert.equal(total, 128 + 1024 + 128);
});

test('stereo (the Console master bus): both channels count — the same -20 dBFS tone in L and R reads -20.0 LUFS', () => {
  const msgs = [], { procs, G } = loadWorklet(48000, msgs);
  const p = new procs['studio-recorder']({ processorOptions: { meterOnly: true } }); // meters without "recording" — never sends audio
  const a = sine(0.1, 1000, 6);
  for (let i = 0; i + 128 <= a.length; i += 128) { G.currentFrame = i; p.process([[a.subarray(i, i + 128), a.subarray(i, i + 128)]]); }
  const L = lastLoud(msgs);
  assert.ok(Math.abs(L.I - -20.0) < 0.05, `stereo I was ${L.I}`);
  assert.equal(msgs.filter(m => m.type === 'pcm').length, 0, 'meter-only never records');
});

test('Console noise gate: open while talking, 20 dB down in the gaps, untouched when switched off', () => {
  const msgs = [], { procs } = loadWorklet(48000, msgs);
  const run = on => {
    const g = new procs['rolling-gate'](); g.port.onmessage({ data: { on } });
    // 1 s of voice-level tone, then 2 s of quiet hiss (−60 dBFS)
    const x = new Float32Array(144000); x.set(sine(0.1, 300, 1)); for (let i = 48000; i < 144000; i++) x[i] = 0.001 * Math.sin(i * 1.7);
    const y = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) { const out = [new Float32Array(128)]; g.process([[x.subarray(i, i + 128)]], [out]); y.set(out[0], i); }
    const rms = (a, from, to) => { let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i]; return Math.sqrt(e / (to - from)); };
    return { voice: rms(y, 24000, 48000) / rms(x, 24000, 48000), gap: rms(y, 120000, 144000) / rms(x, 120000, 144000) };
  };
  const on = run(true), off = run(false);
  assert.ok(Math.abs(on.voice - 1) < 0.01, `voice passes: ${on.voice}`);
  assert.ok(Math.abs(20 * Math.log10(on.gap) - -20) < 0.5, `gap turned down 20 dB: ${20 * Math.log10(on.gap)}`);
  assert.ok(Math.abs(off.gap - 1) < 0.001, 'switched off = no change');
  assert.ok(msgs.some(m => m.closed === true), 'tells the Console when it is closed');
});
