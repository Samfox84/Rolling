'use strict';
// treat.js — cleaned voices, the Producer mix envelope (fader moves + coughs), mixing, long pauses.
// The clean-up filters are run through real ffmpeg and judged by measuring the result.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const treat = require('../treat');
const { tmpDir } = require('./helpers');

const ffmpeg = (...a) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...a], { stdio: ['ignore', 'ignore', 'pipe'] });
/** RMS level in dBFS of a stretch of a WAV, measured by ffmpeg (not by our code) */
function rms(file, from, dur) {
  const r = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-ss', String(from), '-t', String(dur), '-i', file, '-af', 'astats', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = r.stderr.match(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/);
  return m ? (m[1] === '-inf' ? -Infinity : parseFloat(m[1])) : NaN;
}

test('settings: defaults filled in and bad values made safe', () => {
  const c = treat.cfg({ noise: 'nuclear', mains: 55, pauses: 999, gate: 1 });
  assert.equal(c.noise, 'medium'); assert.equal(c.mains, 50); assert.equal(c.pauses, 30); assert.equal(c.gate, true);
  assert.equal(c.auto, true); assert.equal(treat.cfg({ auto: false }).auto, false);
  assert.equal(treat.cfg({ mains: 60 }).mains, 60);
});

test('filter chain follows the settings; noise level comes from the room tone when there is one', () => {
  const all = treat.cfg({ gate: true });
  const f = treat.cleanFilter(all, -44.4);
  assert.match(f, /^adeclip,highpass=f=80,bandreject=f=50:.*bandreject=f=100:.*bandreject=f=150:/);
  assert.match(f, /afftdn=nr=12:nf=-44\.4,/);
  assert.match(treat.cleanFilter(all, -95), /nf=-80\.0/, 'kept inside the range ffmpeg accepts');
  assert.match(f, /agate=.*deesser=.*acompressor=/);
  assert.match(treat.cleanFilter(all, null), /afftdn=nr=12:nf=-50:tn=1/, 'no room tone: follow the noise instead');
  assert.match(treat.cleanFilter(treat.cfg({ mains: 60 }), null), /bandreject=f=60:.*f=120:.*f=180:/);
  const off = treat.cfg({ declip: false, rumble: false, noise: 'off', deess: false, compress: false, gate: false });
  assert.equal(treat.cleanFilter(off, null), 'anull');
});

test('clean-up really removes hiss and hum (measured by ffmpeg) and keeps the voice', () => {
  const dir = tmpDir('clean');
  const src = path.join(dir, 'voice.wav'), out = path.join(dir, 'clean.wav');
  // 0-6 s room tone (hiss + 50 Hz hum only), then 6-14 s "voice" (a 300 Hz tone) over the same noise
  ffmpeg('-f', 'lavfi', '-i', 'anoisesrc=d=14:c=white:a=0.01:seed=7', '-f', 'lavfi', '-i', 'sine=f=50:d=14', '-f', 'lavfi', '-i', 'sine=f=300:d=8',
    '-filter_complex', '[1]volume=0.02[h];[2]volume=0.3,adelay=6000:all=1[v];[0][h][v]amix=inputs=3:normalize=0:duration=longest', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', src);
  const tone = path.join(dir, 'tone.wav'); ffmpeg('-i', src, '-t', '6', '-c:a', 'pcm_s24le', tone);
  const r = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', tone, '-af', 'astats=measure_perchannel=none', '-f', 'null', '-'], { encoding: 'utf8' });
  const noiseDb = treat.parseRms(r.stderr);
  assert.ok(noiseDb < -40 && noiseDb > -48, `room tone measured: ${noiseDb}`);
  ffmpeg('-i', src, '-af', treat.cleanFilter(treat.cfg({ compress: false, deess: false }), noiseDb), '-c:a', 'pcm_f32le', out);
  const noiseBefore = rms(src, 1, 4);
  const noiseAfter = rms(out, 1, 4);
  assert.ok(noiseAfter < noiseBefore - 10, `background noise should drop a lot: ${noiseBefore.toFixed(1)} → ${noiseAfter.toFixed(1)} dB`);
  const voiceBefore = rms(src, 8, 4), voiceAfter = rms(out, 8, 4);
  assert.ok(Math.abs(voiceAfter - voiceBefore) < 2, `voice level kept: ${voiceBefore.toFixed(1)} → ${voiceAfter.toFixed(1)} dB`);
});

test('Producer mix envelope: fader moves glide in 30 ms, "off" is silent, coughs are muted with short fades', () => {
  const e = treat.envelope([{ at: 1000, db: -6 }, { at: 3000, db: null }, { at: 5000, db: 0 }], [{ from: 7000, to: 8000 }], 0);
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-3, `${a} vs ${b}`);
  near(e.at(0.5), 1);                    // before any move: as recorded
  near(e.at(1.015), 1 + (0.501 - 1) * 0.5); // halfway through the glide to -6 dB
  near(e.at(2), 10 ** (-6 / 20));
  near(e.at(4), 0);                       // fader off
  near(e.at(6), 1);
  near(e.at(7.5), 0);                     // cough
  near(e.at(7 - 0.0075), 0.5);            // fading out into the cough
  near(e.at(8.5), 1);
  const b = treat.envelope([], [], -6); near(b.at(1), 10 ** (-6 / 20)); // base gain (cleaned copy back to its live level)
});

test('mixing applies each person\'s envelope and can\'t clip (32-bit float)', async () => {
  const dir = tmpDir('mix');
  const a = path.join(dir, 'a.wav'), b = path.join(dir, 'b.wav'), out = path.join(dir, 'mix.wav');
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=200:d=4,volume=0.9', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', a);
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=200:d=2,volume=0.9', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', b);
  const len = await treat.mixWithEnvelopes([{ file: a, gain: treat.envelope([{ at: 2000, db: null }], []) }, { file: b, gain: treat.envelope([], []) }], out);
  assert.ok(Math.abs(len - 4) < 0.01);
  const first = rms(out, 0.2, 1.5), muted = rms(out, 2.5, 1.2);
  // two equal voices (+6 dB) panned centre (−3 dB each side, the browser's equal-power law) = +3 dB, unclipped
  assert.ok(Math.abs(first - (rms(a, 0.2, 1.5) + 3)) < 0.3, `both voices together, centre: ${first} vs one alone ${rms(a, 0.2, 1.5)}`);
  assert.ok(muted < -90 || muted === -Infinity, `fader off + other person finished = silence: ${muted}`);
  // float WAV that ffmpeg reads back at the right length
  const d = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  assert.ok(Math.abs(d - 4) < 0.01);
});

test('long pauses are found from ffmpeg\'s silence detector', () => {
  const dir = tmpDir('pause');
  const src = path.join(dir, 's.wav'), list = path.join(dir, 'p.txt');
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=300:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=4', '-f', 'lavfi', '-i', 'sine=f=300:d=2',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_f32le', src);
  ffmpeg('-i', src, '-af', treat.pauseFilter(3, list), '-f', 'null', '-');
  const p = treat.parsePauses(fs.readFileSync(list, 'utf8'));
  assert.equal(p.length, 1);
  assert.ok(Math.abs(p[0].at - 2) < 0.1 && Math.abs(p[0].dur - 4) < 0.1, JSON.stringify(p));
  assert.deepEqual(treat.parsePauses('lavfi.silence_start=5\n'), [], 'an unfinished pause at the very end is ignored');
});

test('Console pan is baked into the stereo Producer mix (and EQ/compressor become the same ffmpeg filters)', async () => {
  const dir = tmpDir('pan');
  const a = path.join(dir, 'a.wav'), out = path.join(dir, 'mix.wav');
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=300:d=2', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s24le', a);
  await treat.mixWithEnvelopes([{ file: a, gain: treat.envelope([], []), pan: -1 }], out);
  const r = require('child_process').spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', out, '-af', 'astats', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  const [left, right] = [...r.matchAll(/Channel: \d[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/g)].map(m => (m[1] === '-inf' ? -Infinity : parseFloat(m[1])));
  assert.ok(left > -30 && (right === -Infinity || right < left - 60), `hard left: L ${left} R ${right}`);
  assert.equal(treat.channelFilter({}), '', 'a flat channel adds no processing');
  assert.equal(treat.channelFilter({ hpf: true, low: -3, pres: 4, high: 2, comp: true }),
    'highpass=f=80,lowshelf=f=120:g=-3,equalizer=f=2500:t=q:w=1:g=4,highshelf=f=8000:g=2,acompressor=threshold=-24dB:ratio=3:attack=10:release=200');
  assert.deepEqual(treat.cleanChannel({ db: 99, pan: -7, low: 50, mute: 1 }), { db: 10, mute: true, pan: -1, hpf: false, low: 12, pres: 0, high: 0, comp: false });
  ffmpeg('-i', a, '-af', treat.channelFilter({ hpf: true, low: -3, pres: 4, high: 2, comp: true }), '-f', 'null', '-'); // ffmpeg accepts the chain
});

test('Soundboard track: pads at the right time and volume, beds looped and cut where stopped, dipped under the voices', () => {
  const dir = tmpDir('board');
  const bed = path.join(dir, 'bed.wav'), sting = path.join(dir, 'sting.wav'), voices = path.join(dir, 'voices.wav'), out = path.join(dir, 'board.wav');
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=220:d=2,volume=2.4', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', bed);       // a 2 s loop (sine starts at 1/8 level)
  ffmpeg('-f', 'lavfi', '-i', 'sine=f=880:d=1,volume=2.4', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', sting);     // a 1 s jingle
  // voices: silent 0-6 s, talking 6-9 s, silent after
  ffmpeg('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=6', '-f', 'lavfi', '-i', 'sine=f=300:d=3,volume=4', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono:d=3',
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1', '-c:a', 'pcm_f32le', voices);
  const events = [{ sid: 'bed', mode: 'bed', from: 1000, to: 11000, vol: 0, dur: 2 }, { sid: 'sting', mode: 'jingle', from: 4000, to: 5000, vol: -6, dur: 1 }];
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...treat.boardArgs(events, e => (e.sid === 'bed' ? bed : sting), voices, 12, out)]);
  const d = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out]).toString());
  assert.ok(Math.abs(d - 12) < 0.05, `as long as the take: ${d}`);
  assert.ok(rms(out, 0.1, 0.8) < -80, 'silent before the first pad');
  const bedAlone = rms(out, 2.2, 1.2), bedUnderVoice = rms(out, 6.8, 1.8), bedAfter = rms(out, 9.8, 0.8);
  assert.ok(bedAlone > -20, `bed plays (looped past its 2 s): ${bedAlone}`);
  assert.ok(bedUnderVoice < bedAlone - 6, `bed dips under the voices: ${bedAlone} → ${bedUnderVoice}`);
  assert.ok(bedAfter > bedUnderVoice + 4, `and comes back up: ${bedAfter}`);
  assert.ok(rms(out, 11.3, 0.6) < -80, 'stopped at 11 s');
  assert.ok(rms(out, 4.2, 0.6) > bedAlone, 'the jingle plays on top at 4 s');
});
