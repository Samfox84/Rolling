'use strict';
// post.js — transcript, chapters, level report, session files. Pure functions: real inputs, real outputs.
const test = require('node:test');
const assert = require('node:assert/strict');
const post = require('../post');
const { xmlWellFormed } = require('./helpers');

const take = () => ({
  markers: [{ at: 65000, label: 'Topic two' }, { at: 12000, label: 'Topic one' }],
  segs: {
    a: { _person: 'Steve', tx: { parts: [{ from: 1, to: 3, text: 'Hello.' }, { from: 3.5, to: 5, text: 'Welcome.' }] } },
    b: { _person: 'Guest', tx: { parts: [{ from: 6, to: 8, text: 'Hi Steve.' }] } },
  },
  levels: { Steve: { I: -18, TP: -2, LRA: 6 }, Guest: { I: -31, TP: -0.5, LRA: 9 }, Silent: { I: -Infinity, TP: -Infinity, LRA: 0 } },
});

test('transcript txt groups one speaker\'s consecutive lines and labels speakers', () => {
  const txt = post.transcriptTxt(take(), 'Show', 0);
  assert.match(txt, /\[00:00:01\] Steve: Hello\. Welcome\./);
  assert.match(txt, /\[00:00:06\] Guest: Hi Steve\./);
});
test('transcript notes the intro offset when there is an intro', () => {
  assert.match(post.transcriptTxt(take(), 'Show', 12.5), /add 12\.5 s/);
});
test('transcript is null when nobody was transcribed (no empty file)', () => {
  assert.equal(post.transcriptTxt({ segs: {} }, 'Show', 0), null);
  assert.equal(post.transcriptSrt({ segs: {} }), null);
  assert.equal(post.transcriptVtt({ segs: {} }), null);
});
test('SRT has numbered cues with comma milliseconds; VTT has a header and voice tags', () => {
  const srt = post.transcriptSrt(take());
  assert.match(srt, /^1\r\n00:00:01,000 --> 00:00:03,000\r\nSteve: Hello\./);
  const vtt = post.transcriptVtt(take());
  assert.match(vtt, /^WEBVTT\n\n00:00:01\.000 --> 00:00:03\.000\n<v Steve>Hello\./);
});
test('a very short subtitle still lasts at least half a second', () => {
  const t = { segs: { a: { _person: 'A', tx: { parts: [{ from: 2, to: 2, text: 'Oh' }] } } } };
  assert.match(post.transcriptSrt(t), /00:00:02,000 --> 00:00:02,500/);
});
test('chapters are sorted, start at 0, and shift by the intro length', () => {
  const ch = post.chapters(take(), 10);
  const j = JSON.parse(ch.json);
  assert.deepEqual(j.chapters.map(c => c.title), ['Intro', 'Start', 'Topic one', 'Topic two']);
  assert.deepEqual(j.chapters.map(c => c.startTime), [0, 10, 22, 75]);
  assert.match(ch.youtube, /^00:00 Intro\r\n00:10 Start\r\n00:22 Topic one\r\n01:15 Topic two/);
});
test('no markers → no chapters file', () => {
  assert.equal(post.chapters({ markers: [] }, 0), null);
});
test('verdict: good / quiet+hot / clipping / float mix / silence', () => {
  assert.deepEqual(post.verdict({ I: -18, TP: -2 }), { level: 'good', text: 'good' });
  assert.equal(post.verdict({ I: -31, TP: -0.5 }).level, 'warn');
  assert.match(post.verdict({ I: -31, TP: -0.5 }).text, /hot peaks.*quiet/);
  assert.equal(post.verdict({ I: -16, TP: 0 }).level, 'bad');
  assert.equal(post.verdict({ I: -16, TP: 1, float: true }).level, 'warn');
  assert.equal(post.verdict({ I: -Infinity, TP: -Infinity }).level, 'none');
  assert.equal(post.verdict(null).level, 'none');
});
test('level report lists every person with the shared verdict text and skips missing readings', () => {
  const t = take(); t.levels.Broken = null;
  const r = post.levelReport(t, 'Show');
  assert.match(r, /Steve\s+-18\.0\s+-2\.0\s+6\.0\s+good/);
  assert.match(r, /Guest .*quiet/);
  assert.doesNotMatch(r, /Broken/);
});
test('Audition .sesx is well-formed, places clips in samples, maps mono to both channels', () => {
  const x = post.sesx('Ep 1 <test> & "quotes"', [
    { name: 'Intro', file: 'Intro.wav', start: 0, dur: 3, channels: 2 },
    { name: 'Steve', file: 'Steve.wav', start: 3, dur: 60, channels: 1 },
  ], [{ label: 'Topic', at: 10 }]);
  assert.ok(xmlWellFormed(x), 'sesx must be well-formed XML');
  assert.match(x, /startPoint="144000"/);
  assert.match(x, /sourceOutPoint="2880000"/);
  assert.match(x, /<channel index="1" sourceIndex="0"\/>/);
  assert.match(x, /relativePath="Steve.wav"/);
  assert.match(x, /Ep 1 &lt;test&gt; &amp; &quot;quotes&quot;/);
});
test('FCP XML is well-formed and offsets clips by their start', () => {
  const x = post.fcpXml('Show', [{ kind: 'video', file: 'a.mp4', start: 3, dur: 10, w: 1280, h: 720 }, { kind: 'audio', file: 'A b.wav', start: 3, dur: 10, channels: 1 }], [{ label: 'M', at: 5 }], 30);
  assert.match(x, /<timebase>30<\/timebase>/);
  assert.match(post.fcpXml('Show', [{ kind: 'audio', file: 'a.wav', start: 2, dur: 2, channels: 1 }], []), /<timebase>25<\/timebase>[\s\S]*<start>50<\/start>/, 'UK 25 fps by default');
  assert.ok(xmlWellFormed(x));
  assert.match(x, /<start>90<\/start><end>390<\/end>/);
  assert.match(x, /file:\/\/localhost\/A%20b\.wav/);
  assert.match(x, /<marker><name>M<\/name><comment><\/comment><in>150<\/in>/);
});
test('Audition markers CSV uses tab columns and decimal time', () => {
  const csv = post.auditionMarkersCsv([{ label: 'One\tTab', at: 75.5 }, { label: 'Two', at: 3725 }]);
  assert.match(csv, /^Name\tStart\tDuration\tTime Format\tType\tDescription\r\n/);
  assert.match(csv, /One Tab\t1:15\.500\t/);
  assert.match(csv, /Two\t1:02:05\.000\t/);
});
test('the XML checker itself rejects broken XML (so the checks above mean something)', () => {
  assert.equal(xmlWellFormed('<a><b></a></b>'), false);
  assert.equal(xmlWellFormed('<a>x < y</a>'), false);
});

test('edit list: tags, segments, coughs, talkback and long pauses, grouped and in time order', () => {
  const t = { coughs: { C1: [{ from: 61000, to: 63500 }, { from: 90000, to: null }], C2: [{ from: 70000, to: 72000, kind: 'talk' }] }, pauses: [{ at: 100, dur: 4.2 }] };
  const markers = [{ at: 30000, label: 'Cut this 1', tag: 'cut', by: 'Sam' }, { at: 10000, label: 'Interview', tag: 'segment' }, { at: 50000, label: 'Marker 1' }];
  const items = post.editItems(t, markers, { C1: 'Steve', C2: 'Sam' });
  assert.deepEqual(items.map(i => i.group), ['Segment', 'Cut this', 'Marker', 'Cough', 'Talkback', 'Long pause'], 'unfinished cough skipped; sorted by time');
  assert.equal(items[3].label, 'Cough — Steve'); assert.equal(items[3].dur, 2.5);
  const txt = post.editList(items, 'Show');
  assert.match(txt, /CUT THIS \(1\)\r\n  00:00:30 {15}Cut this 1  \(Sam\)/);
  assert.match(txt, /COUGH \(1\)\r\n  00:01:01  to 00:01:03  Cough — Steve/);
  assert.ok(txt.indexOf('CUT THIS') < txt.indexOf('GREAT BIT') || !txt.includes('GREAT BIT'));
  const csv = post.auditionMarkersCsv(items);
  assert.match(csv, /Cough — Steve\t1:01\.000\t0:02\.500\tdecimal\tCue\tCough/);
});

test('chapters skip edit notes (cut / retake / great bit) but keep segments, ad breaks and plain markers', () => {
  const ch = post.chapters({ markers: [{ at: 5000, label: 'Interview', tag: 'segment' }, { at: 9000, label: 'Cut this 1', tag: 'cut' }, { at: 12000, label: 'Ad break 1', tag: 'ad' }, { at: 15000, label: 'Great bit 1', tag: 'great' }] }, 0);
  const titles = JSON.parse(ch.json).chapters.map(c => c.title);
  assert.deepEqual(titles, ['Start', 'Interview', 'Ad break 1']);
});
