'use strict';
// transcribe.js — chunking at quiet points, skipping silence, filtering hallucinations, timing, progress.
// Uses the whisper.cpp stand-in (tests/fixtures/fake-whisper.js); everything else is the real code + real ffmpeg.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const createTranscriber = require('../transcribe');
const { FAKE_WHISPER, tmpDir, pcm24, talky } = require('./helpers');

function setup(secs, shape) {
  fs.chmodSync(FAKE_WHISPER, 0o755);
  const models = tmpDir('models'); fs.writeFileSync(path.join(models, 'ggml-base.en.bin'), 'x');
  process.env.WHISPER_BIN = FAKE_WHISPER; process.env.WHISPER_MODELS = models;
  const root = tmpDir('tx');
  const segDir = path.join(root, 'R1', 'T1', 'segs', 'S1'); fs.mkdirSync(segDir, { recursive: true });
  fs.writeFileSync(path.join(segDir, 'audio.pcm'), pcm24(secs, shape));
  const started = 1_000_000;
  const t = { id: 'T1', room: 'R1', started, segs: { S1: { id: 'S1', name: 'Steve', _person: 'Steve', audio: { rate: 48000, end: Math.round(secs * 48000), first: { s: 0, t: started + 2000 }, last: { s: 0, t: started + 2000 } } } } };
  const saves = [];
  const tr = createTranscriber({ settings: { transcribe: { enabled: true, model: 'base.en' } }, FFMPEG: 'ffmpeg', takeDir: () => path.join(root, 'R1', 'T1'), saveTake: x => saves.push(x) });
  return { t, tr, saves };
}

test('is "available" only when the engine and the model both exist', () => {
  const { tr } = setup(1, () => 0);
  assert.equal(tr.available(), true);
  const tr2 = createTranscriber({ settings: { transcribe: { model: 'missing.en' } }, FFMPEG: 'ffmpeg', takeDir: () => '/x', saveTake: () => {} });
  assert.equal(tr2.available(), false);
  assert.equal(tr2.enabled(), false);
});
test('live catch-up transcribes ~30 s chunks and leaves the newest 5 s for later', async () => {
  const { t, tr } = setup(70, talky(3));
  await tr.catchUp(t, t.segs.S1, false);
  const s = t.segs.S1;
  assert.ok(s.tx.done >= 48000 * 50 && s.tx.done <= 48000 * 65, `done=${s.tx.done / 48000}s`);
  assert.ok(s.tx.parts.length > 0);
});
test('final catch-up finishes everything; times are on the take timeline (seg started 2 s in)', async () => {
  const { t, tr } = setup(40, talky(5));
  await tr.catchUp(t, t.segs.S1, true);
  const s = t.segs.S1;
  assert.equal(s.tx.done, s.audio.end);
  assert.equal(s.tx.parts[0].from, 2);
  assert.match(s.tx.parts[0].text, /^Sentence at 0 seconds\.$/);
});
test('whisper hallucinations ("Thank you.") are dropped', async () => {
  const { t, tr } = setup(20, talky(7));
  await tr.catchUp(t, t.segs.S1, true);
  assert.ok(t.segs.S1.tx.parts.every(p => !/thank you/i.test(p.text)));
});
test('silent stretches are skipped (no invented words in silence)', async () => {
  const { t, tr } = setup(70, talky(9, x => x < 35));
  await tr.catchUp(t, t.segs.S1, true);
  const parts = t.segs.S1.tx.parts;
  assert.ok(parts.length > 0, 'the talking half is transcribed');
  assert.ok(parts.every(p => p.from >= 2 + 20), `first part at ${parts[0].from}s — nothing from the silent first half`);
});
test('chunks are cut at the quietest moment between 25 and 35 s', async () => {
  // loud everywhere except a short gap at 31 s → the first cut lands in that gap
  const { t, tr } = setup(40, x => (Math.abs(x - 31) < 0.15 ? 0 : 0.3 * Math.sin(x * 900)));
  await tr.catchUp(t, t.segs.S1, false);
  const cut = t.segs.S1.tx.done / 48000;
  assert.ok(Math.abs(cut - 31) < 0.2, `cut at ${cut}s`);
});
test('finishTake reports progress up to 100% and progress() agrees', async () => {
  const { t, tr } = setup(30, talky(11));
  const seen = [];
  await tr.finishTake(t, f => seen.push(f));
  assert.equal(seen[seen.length - 1], 1);
  assert.equal(tr.progress(t), 100);
});
test('an engine failure is recorded on the person, not swallowed, and the transcript moves on', async () => {
  const { t } = setup(12, talky(13));
  const tdir = tmpDir('tx2'); fs.mkdirSync(path.join(tdir, 'segs', 'S1'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 'segs', 'S1', 'audio.pcm'), pcm24(12, talky(13)));
  process.env.WHISPER_BIN = process.execPath; // node given whisper's arguments → exits with an error
  try {
    const broken = createTranscriber({ settings: { transcribe: { enabled: true, model: 'base.en' } }, FFMPEG: 'ffmpeg', takeDir: () => tdir, saveTake: () => {} });
    await broken.catchUp(t, t.segs.S1, true);
  } finally { process.env.WHISPER_BIN = FAKE_WHISPER; }
  assert.ok(t.segs.S1.tx.error, 'the error is kept on the person');
  assert.equal(t.segs.S1.tx.done, t.segs.S1.audio.end, 'and it does not retry forever');
});

test('self-test runs the engine for real and reports how long it took', async () => {
  const { tr } = setup(1, () => 0);
  const r = await tr.selfTest();
  assert.equal(r.model, 'base.en'); assert.ok(r.seconds >= 0);
});
test('self-test explains a missing model or a broken engine in plain words', async () => {
  const { tr } = setup(1, () => 0);
  const tr2 = createTranscriber({ settings: { transcribe: { model: 'small.en' } }, FFMPEG: 'ffmpeg', takeDir: () => '/x', saveTake: () => {} });
  await assert.rejects(tr2.selfTest(), /rolling-get-model small\.en/);
  const flag = path.join(tmpDir('flag'), 'fail'); fs.writeFileSync(flag, '');
  process.env.FAKE_WHISPER_FAIL_FLAG = flag;
  try { await assert.rejects(tr.selfTest(), /failed to load model/); } finally { delete process.env.FAKE_WHISPER_FAIL_FLAG; }
});
