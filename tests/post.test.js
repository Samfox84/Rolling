'use strict';
// post.js — transcript, chapters, level report, session files. Pure functions: real inputs, real outputs.
const test = require('node:test');
const assert = require('node:assert/strict');
const post = require('../post');
const { xmlWellFormed, alteredProblems } = require('./helpers');

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
test('session markers: points and ranges, each named with its kind', () => {
  const x = post.sesx('Show', [{ name: 'Steve', file: 'Steve.wav', start: 0, dur: 60, channels: 1 }],
    [{ label: 'Great bit 1', at: 10 }, { label: 'Filler words: um — Steve: “Um, so”', at: 20, dur: 2.5 }]);
  assert.ok(xmlWellFormed(x));
  assert.match(x, /<marker duration="0" id="0" name="Great bit 1" startPoint="480000" type="cue"\/>/);
  assert.match(x, /<marker duration="120000" id="1" name="Filler words: um — Steve: “Um, so”" startPoint="960000" type="cue"\/>/);
  assert.equal(post.markerName({ group: 'Great bit', label: 'Great bit 1' }), 'Great bit 1');
  assert.equal(post.markerName({ group: 'Cough', label: 'Cough — Guest' }), 'Cough — Guest');
  assert.equal(post.markerName({ group: 'Filler words', label: 'um — Steve' }), 'Filler words: um — Steve');
  assert.equal(post.markerName({ group: 'Segment', label: 'Interview' }), 'Segment: Interview');
  assert.equal(post.markerName({ group: 'Marker', label: 'Marker 3' }), 'Marker 3');
  assert.equal(post.markerName({ group: 'Long pause', label: 'Pause 3.2 s' }), 'Long pause: Pause 3.2 s');
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

test('guest invite: link, checklist, time in the host\'s time zone, and a calendar entry', () => {
  const inv = post.guestInvite({ show: 'AOL Underground', guest: 'Leo', host: 'Sam', link: 'https://studio.example.com/r/abc', when: new Date('2026-07-01T18:30:00Z'), minutes: 90, tz: 'Europe/London', note: 'Bring a story; or two, please' });
  assert.match(inv.subject, /AOL Underground — Wednesday 1 July at 19:30 BST/);
  assert.match(inv.text, /Hi Leo,/); assert.match(inv.text, /https:\/\/studio\.example\.com\/r\/abc/); assert.match(inv.text, /headphones/); assert.match(inv.text, /Saved ✓/);
  assert.match(inv.ics, /DTSTART:20260701T183000Z\r\nDTEND:20260701T200000Z/);
  assert.match(inv.ics, /SUMMARY:Recording: AOL Underground/);
  assert.equal(post.guestInvite({ show: 'S', link: 'x', when: null }).ics, null, 'no time, no calendar entry');
  assert.match(post.guestInvite({ show: 'S', link: 'x', when: new Date('2026-07-01T18:30:00Z'), tz: 'Not/AZone' }).subject, /18:30 UTC/, 'an unknown time zone shows UTC');
});

// ---------- Altered Audio Editor ----------
const altPlan = () => ({
  title: 'AOL Underground - Ep 12 - The Keyword Era', show: 'AOL Underground', episode: { n: '12', title: 'The Keyword Era' },
  tracks: [
    { name: 'Intro', file: 'Intro.wav', start: 0, sr: 44100, channels: 2, samples: 441000 },
    { name: 'Steve', file: 'Steve.wav', start: 10, sr: 48000, channels: 1, samples: 48000 * 60, color: '#3f73b8' },
    { name: 'Steve (cleaned)', file: 'Steve - cleaned -16 LUFS.wav', start: 10, sr: 48000, channels: 1, samples: 48000 * 60, muted: true, hidden: true },
    { name: 'Guest', file: 'Guest.wav', start: 10, sr: 48000, channels: 1, samples: 48000 * 59 },
  ],
  markers: [
    { label: 'Interview', at: 10, dur: 0, group: 'Segment' },
    { label: 'Ad break: Sponsor', at: 30, dur: 0, group: 'Ad break' },
    { label: 'Producer note: Use as trailer', at: 40, dur: 0, group: 'Producer note', by: 'Sam' },
    { label: 'Filler words: um — Steve: “Um, so…”', at: 41.5, dur: 0.4, group: 'Filler words' },
  ],
});

test('Altered session (.altaudio): passes Altered\'s own schema and opening checks', () => {
  const doc = JSON.parse(post.altaudio(altPlan()));
  assert.deepEqual(alteredProblems(doc), []);
  assert.equal(doc.format, 'altaudio.session'); assert.equal(doc.schema_version, 1);
  // the checker itself catches a broken session, so passing means something
  const broken = JSON.parse(JSON.stringify(doc)); delete broken.view; broken.tracks[0].clips[0].media_id = broken.id; broken.markers[0].contracted_duration = 5;
  const found = alteredProblems(broken).join(' | ');
  assert.match(found, /view/); assert.match(found, /missing media/); assert.match(found, /contracted length/);
});

test('Altered session: every file on its own track, lined up in samples, each file\'s own rate and length kept', () => {
  const doc = JSON.parse(post.altaudio(altPlan()));
  assert.deepEqual(doc.tracks.map(t => t.name), ['Intro', 'Steve', 'Steve (cleaned)', 'Guest']);
  const steve = doc.tracks[1].clips[0], intro = doc.tracks[0].clips[0];
  assert.equal(steve.start, 480000, 'starts after the 10 s intro, counted at the session\'s 48 kHz');
  assert.equal(steve.source_out, 48000 * 60);
  assert.equal(intro.source_out, 441000, 'the intro plays all of its 44.1 kHz file');
  const introMedia = doc.media.find(m => m.id === intro.media_id);
  assert.deepEqual([introMedia.sample_rate, introMedia.channels, introMedia.relative_path], [44100, 2, 'Intro.wav']);
  assert.equal(doc.tracks[0].channels, 'stereo'); assert.equal(doc.tracks[1].channels, 'mono');
  // the cleaned version is there to switch to, but silent and out of the way
  assert.deepEqual([doc.tracks[2].muted, doc.tracks[2].hidden], [true, true]);
  assert.equal(doc.tracks[1].hidden, undefined, 'the real recordings are not hidden');
  // the episode details and Podcast mode
  assert.deepEqual([doc.metadata.show, doc.metadata.title, doc.metadata.episode_number], ['AOL Underground', 'The Keyword Era', 12]);
  assert.equal(doc.modes.podcast, true);
  assert.equal(JSON.parse(post.altaudio({ ...altPlan(), episode: { n: '12b' } })).metadata.episode_number, null, 'an episode "number" that isn\'t one is left out');
});

test('Altered markers: segments are chapters, ad breaks are ad slots, notes and ranges are coloured cues', () => {
  const m = JSON.parse(post.altaudio(altPlan())).markers;
  assert.deepEqual(m.map(x => x.kind), ['chapter', 'ad_slot', 'cue', 'cue']);
  assert.deepEqual(m.map(x => x.position), [480000, 1440000, 1920000, 1992000]);
  assert.equal(m[3].duration, 19200, 'a filler word is a range');
  assert.equal(m[0].duration, 0);
  assert.equal(m[2].description, 'Producer note — by Sam');
  assert.ok(m.every(x => /^#[0-9a-f]{6}$/.test(x.color)));
  assert.notEqual(m[2].color, m[3].color, 'different kinds look different');
});

test('Altered download: files sorted into folders, the session pointing at them; other editors\' sessions left out', () => {
  const place = o => post.alteredPlace(o);
  assert.equal(place({ kind: 'audio', file: 'Steve.wav' }), 'Audio/Steve.wav');
  assert.equal(place({ kind: 'cleaned', file: 'Steve - cleaned -16 LUFS.wav' }), 'Audio/Cleaned/Steve - cleaned -16 LUFS.wav');
  assert.equal(place({ kind: 'intro', file: 'Intro.wav' }), 'Audio/Intro.wav');
  assert.equal(place({ kind: 'roomtone', file: 'Steve - room tone.wav' }), 'Audio/Room tone/Steve - room tone.wav');
  assert.equal(place({ kind: 'producermix', file: 'Producer mix -16 LUFS.wav' }), 'Mixes/Producer mix -16 LUFS.wav');
  assert.equal(place({ kind: 'transcript', file: 'Transcript.srt' }), 'Notes/Transcript.srt');
  assert.equal(place({ kind: 'session', file: 'Show (Audition).sesx' }), null);
  assert.equal(place({ kind: 'markers', file: 'Markers (Audition).csv' }), null);
  const files = [{ kind: 'audio', file: 'Steve.wav' }, { kind: 'cleaned', file: 'Steve - cleaned -16 LUFS.wav' }];
  const doc = JSON.parse(post.relocateAltaudio(post.altaudio(altPlan()), name => { const o = files.find(f => f.file === name); return o ? place(o) : name; }));
  const steve = doc.media.find(m => m.relative_path.endsWith('Steve.wav'));
  assert.deepEqual([steve.relative_path, steve.path], ['Audio/Steve.wav', 'Audio/Steve.wav']);
  assert.ok(doc.media.some(m => m.relative_path === 'Audio/Cleaned/Steve - cleaned -16 LUFS.wav'));
  assert.deepEqual(alteredProblems(doc), []);
});
