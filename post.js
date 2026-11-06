'use strict';
/*
 * Rolling — the "paperwork" made for each take: transcript (TXT/SRT/VTT), chapters,
 * level report, and multitrack session files for Audition (.sesx) and Premiere/Resolve (XML).
 */
const xmlEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const pad = (n, w = 2) => String(Math.floor(n)).padStart(w, '0');
const hms = sec => { sec = Math.max(0, sec); return `${pad(sec / 3600)}:${pad((sec % 3600) / 60)}:${pad(sec % 60)}`; };
const srtTime = sec => { sec = Math.max(0, sec); return `${hms(sec)},${pad(Math.round((sec % 1) * 1000) % 1000, 3)}`; };
const vttTime = sec => srtTime(sec).replace(',', '.');
const ytTime = sec => (sec >= 3600 ? `${Math.floor(sec / 3600)}:${pad((sec % 3600) / 60)}:${pad(sec % 60)}` : `${pad(sec / 60)}:${pad(sec % 60)}`);

// ---------- transcript ----------
function transcriptParts(t) {
  const parts = [];
  for (const s of Object.values(t.segs)) for (const p of (s.tx && s.tx.parts) || []) parts.push({ ...p, who: s._person || s.name });
  return parts.sort((a, b) => a.from - b.from || a.to - b.to);
}
function transcriptTxt(t, title, introLen) {
  const parts = transcriptParts(t);
  if (!parts.length) return null;
  const lines = [`${title} — transcript`, `Made automatically on your own server (whisper.cpp). Times match the individual recordings${introLen ? ` — add ${introLen.toFixed(1)} s for the version with the intro` : ''}.`, ''];
  let cur = null;
  for (const p of parts) {
    if (cur && cur.who === p.who && p.from - cur.to < 4) { cur.text += ' ' + p.text; cur.to = p.to; continue; }
    if (cur) lines.push(`[${hms(cur.from)}] ${cur.who}: ${cur.text}`, '');
    cur = { ...p };
  }
  if (cur) lines.push(`[${hms(cur.from)}] ${cur.who}: ${cur.text}`, '');
  return lines.join('\r\n');
}
function transcriptSrt(t) {
  const parts = transcriptParts(t);
  if (!parts.length) return null;
  return parts.map((p, i) => `${i + 1}\r\n${srtTime(p.from)} --> ${srtTime(Math.max(p.to, p.from + 0.5))}\r\n${p.who}: ${p.text}\r\n`).join('\r\n');
}
function transcriptVtt(t) {
  const parts = transcriptParts(t);
  if (!parts.length) return null;
  return 'WEBVTT\n\n' + parts.map(p => `${vttTime(p.from)} --> ${vttTime(Math.max(p.to, p.from + 0.5))}\n<v ${p.who}>${p.text}\n`).join('\n');
}

// ---------- quick tags (producer desk) ----------
const TAGS = { great: 'Great bit', cut: 'Cut this', retake: 'Retake', ad: 'Ad break', segment: 'Segment' };
// tags that are edit notes, not places a listener would jump to
const NOT_CHAPTERS = new Set(['great', 'cut', 'retake']);

// ---------- chapters (from markers: plain markers, rundown segments, ad breaks) ----------
function chapters(t, introLen) {
  const marks = (t.markers || []).filter(m => !NOT_CHAPTERS.has(m.tag)).sort((a, b) => a.at - b.at);
  if (!marks.length) return null;
  const list = [];
  if (introLen) list.push({ startTime: 0, title: 'Intro' });
  if (!marks.length || marks[0].at / 1000 + introLen > 1) list.push({ startTime: introLen, title: 'Start' });
  for (const m of marks) list.push({ startTime: +(introLen + m.at / 1000).toFixed(2), title: m.label });
  return {
    json: JSON.stringify({ version: '1.2.0', chapters: list }, null, 2),
    youtube: list.map(c => `${ytTime(c.startTime)} ${c.title}`).join('\r\n') + '\r\n',
  };
}

// ---------- edit list: everything worth knowing in the edit, in time order ----------
/**
 * markers (labelled), coughs per person and long pauses → [{ at (s), dur (s), label, group }]
 * people: clientId → person name
 */
function editItems(t, markers, people) {
  const items = [];
  for (const m of markers) items.push({ at: m.at / 1000, dur: 0, label: m.label, group: m.tag ? TAGS[m.tag] || 'Marker' : 'Marker', by: m.by });
  for (const [id, list] of Object.entries(t.coughs || {})) for (const c of list) {
    if (c.to == null) continue;
    const g = c.kind === 'talk' ? 'Talkback' : 'Cough';
    items.push({ at: c.from / 1000, dur: (c.to - c.from) / 1000, label: `${g} — ${people[id] || 'someone'}`, group: g });
  }
  for (const p of t.pauses || []) items.push({ at: p.at, dur: p.dur, label: `Pause ${p.dur.toFixed(1)} s`, group: 'Long pause' });
  for (const e of t.board || []) if (e.to != null) items.push({ at: e.from / 1000, dur: (e.to - e.from) / 1000, label: `${e.mode === 'bed' ? 'Music bed' : e.mode === 'effect' ? 'Effect' : 'Jingle'}: ${e.name}`, group: 'Soundboard' });
  return items.sort((a, b) => a.at - b.at);
}
function editList(items, title) {
  const groups = ['Cut this', 'Retake', 'Great bit', 'Ad break', 'Segment', 'Marker', 'Soundboard', 'Cough', 'Talkback', 'Long pause'];
  const lines = [`${title} — edit list`, 'Times are from the start of the recordings (the untouched and cleaned files). Coughs and talkback are already muted in the Producer mix.', ''];
  for (const g of groups) {
    const list = items.filter(i => i.group === g); if (!list.length) continue;
    lines.push(`${g.toUpperCase()} (${list.length})`);
    for (const i of list) lines.push(`  ${hms(i.at)}${i.dur ? `  to ${hms(i.at + i.dur)}` : ' '.repeat(13)}  ${i.label}${i.by ? `  (${i.by})` : ''}`);
    lines.push('');
  }
  lines.push('EVERYTHING IN ORDER');
  for (const i of items) lines.push(`  ${hms(i.at)}  [${i.group}] ${i.label}${i.dur && i.group !== 'Long pause' ? ` (${i.dur.toFixed(1)} s)` : ''}`);
  return lines.join('\r\n') + '\r\n';
}

// ---------- level report ----------
/** One verdict for a loudness measurement — used by the level report AND shown on the Recordings page. */
function verdict(l) {
  if (!l || !Number.isFinite(l.I)) return { level: 'none', text: 'no speech measured' };
  const notes = []; let level = 'good';
  if (l.TP >= -0.1 && !l.float) { notes.push('CLIPPING — the recording hit full scale'); level = 'bad'; }
  else if (l.TP >= -0.1) { notes.push('peaks over 0 dBTP (fine in this 32-bit float file — turn it down when mastering)'); level = 'warn'; }
  else if (l.TP > -1) { notes.push('very hot peaks (above -1 dBTP)'); level = 'warn'; }
  if (l.I < -35) { notes.push('very quiet'); if (level === 'good') level = 'warn'; }
  else if (l.I < -28) { notes.push('quiet'); if (level === 'good') level = 'warn'; }
  else if (l.I > -12) { notes.push('very loud'); if (level === 'good') level = 'warn'; }
  return { level, text: notes.length ? notes.join('; ') : 'good' };
}
function levelReport(t, title) {
  const rows = Object.entries(t.levels || {}).filter(([, l]) => l);
  if (!rows.length) return null;
  const f = v => (Number.isFinite(v) ? v.toFixed(1).padStart(6) : '     —');
  return [`${title} — level report (EBU R128 / ITU-R BS.1770)`, '',
    'Person                     Loudness   True peak   Range   Verdict',
    '                           (LUFS)     (dBTP)      (LU)', '',
    ...rows.map(([who, l]) => `${who.padEnd(26).slice(0, 26)} ${f(l.I)}     ${f(l.TP)}      ${f(l.LRA)}   ${verdict(l).text}`), '',
    'Targets: podcasts usually -16 LUFS (Apple, Spotify); broadcast EBU R128 is -23 LUFS; keep true peak below -1 dBTP.',
    'The "normalised" files are these same recordings turned up or down to each target. The originals are untouched.', ''].join('\r\n');
}

// ---------- Adobe Audition native session (.sesx) ----------
// tracks: [{ name, file, start (s), dur (s), channels }] — files sit next to the session, so relative paths work
function sesx(title, tracks, markers) {
  const SR = 48000, S = sec => Math.round(sec * SR);
  const total = Math.max(1, ...tracks.map(k => S(k.start + k.dur)));
  const files = [], fileId = new Map();
  for (const k of tracks) if (!fileId.has(k.file)) { fileId.set(k.file, files.length); files.push(k.file); }
  const fader = (guid, id) => `<component componentGuid="${guid}" componentID="Audition.Fader" id="${id}" name="volume" powered="true"><parameter index="0" name="volume" parameterValue="1"/><parameter index="1" name="static gain" parameterValue="1"/></component>`;
  const mute = (guid, id) => `<component componentGuid="${guid}" componentID="Audition.Mute" id="${id}" name="Mute" powered="true"><parameter index="0" parameterValue="0"/><parameter index="1" name="mute" parameterValue="0"/></component>`;
  const pan = (guid, id) => `<component componentGuid="${guid}" componentID="Audition.StereoPanner" id="${id}" name="StereoPanner" powered="true"><parameter index="0" name="Pan" parameterValue="0"/></component>`;
  const trackXml = tracks.map((k, i) => {
    const len = S(k.dur), start = S(k.start);
    const chmap = k.channels >= 2 ? '<channel index="0" sourceIndex="0"/><channel index="1" sourceIndex="1"/>' : '<channel index="0" sourceIndex="0"/><channel index="1" sourceIndex="0"/>';
    return `
      <audioTrack automationLaneOpenState="false" id="${10001 + i}" index="${i + 1}" select="false" visible="true">
        <trackParameters trackHeight="134" trackHue="-1" trackMinimized="false"><name>${xmlEsc(k.name)}</name></trackParameters>
        <trackAudioParameters audioChannelType="stereo" automationMode="1" monitoring="false" recordArmed="false" solo="false" soloSafe="false">
          <trackOutput outputID="10000" type="trackID"/>
          <trackInput inputID="-1"/>
          ${fader('d0c1f553-e815-4e98-8a7c-6d91c8e9d382', 'trackFader')}
          ${mute('0d548125-b7bd-416f-8e66-b5315a70f410', 'trackMute')}
          ${pan('28c7c560-a819-4027-9d3f-b2f395946ee7', 'trackPan')}
        </trackAudioParameters>
        <audioClip clipAutoCrossfade="true" crossFadeHeadClipID="-1" crossFadeTailClipID="-1" endPoint="${start + len}" fileID="${fileId.get(k.file)}" hue="-1" id="0" lockedInTime="false" looped="false" name="${xmlEsc(k.name)}" offline="false" select="false" sourceInPoint="0" sourceOutPoint="${len}" startPoint="${start}" zOrder="0">
          ${fader('24a3075b-5de4-4c10-9b7e-8e14a5310fb4', 'clipGain')}
          ${mute('f78212d4-80cb-4c6f-89b3-50a2f1039c90', 'clipMute')}
          ${pan('1663b198-c7ae-4ff2-8317-e7a2e4d142b8', 'clipPan')}
          <fadeIn crossFadeLinkType="linkedAsymmetric" endPoint="0" shape="0" startPoint="0" type="cosine"/>
          <fadeOut crossFadeLinkType="linkedAsymmetric" endPoint="${len}" shape="0" startPoint="${len}" type="cosine"/>
          <channelMap>${chmap}</channelMap>
        </audioClip>
      </audioTrack>`;
  }).join('');
  const mk = (markers || []).map((m, i) => `<marker duration="0" id="${i}" name="${xmlEsc(m.label)}" startPoint="${S(m.at)}" type="cue"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<!DOCTYPE sesx>
<sesx version="1.4">
  <session appBuild="10.1.1.11" appVersion="10.1" audioChannelType="stereo" bitDepth="32" duration="${total}" sampleRate="${SR}">
    <name>${xmlEsc(title)}.sesx</name>
    <tracks>${trackXml}
      <masterTrack automationLaneOpenState="false" id="10000" index="${tracks.length + 1}" select="false" visible="true">
        <trackParameters trackHeight="134" trackHue="-1" trackMinimized="false"><name>Main</name></trackParameters>
        <trackAudioParameters audioChannelType="stereo" automationMode="1" monitoring="false" recordArmed="false" solo="false" soloSafe="true">
          <trackOutput outputID="1" type="hardwareOutput"/>
          <trackInput inputID="-1"/>
          ${fader('ee72223e-7d04-496c-8c48-3bef41023893', 'trackFader')}
          ${mute('8ecd696e-c54c-461e-84e8-adaa2f22c0c7', 'trackMute')}
        </trackAudioParameters>
      </masterTrack>
    </tracks>
    ${mk ? `<markers>${mk}</markers>` : ''}
    <sessionState ctiPosition="0" smpteStart="0">
      <selectionState selectionDuration="0" selectionStart="0"/>
      <viewState horizontalViewDuration="${total}" horizontalViewStart="0" trackControlsWidth="224" verticalScrollOffset="0"/>
    </sessionState>
  </session>
  <files>
${files.map((f, i) => `    <file absolutePath="${xmlEsc(f)}" id="${i}" mediaHandler="AmioWav" relativePath="${xmlEsc(f)}"/>`).join('\n')}
  </files>
</sesx>
`;
}

// ---------- FCP7 XML (Audition File > Open, Premiere, Resolve) ----------
// items: [{ file, kind: 'audio'|'video', start (s), dur (s), channels, w, h, hasAudio }]
function fcpXml(title, items, markers, fps = 25) {
  const fr = s => Math.max(0, Math.round(s * fps));
  const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
  const url = f => 'file://localhost/' + encodeURIComponent(f);
  let n = 0, max = 0;
  for (const i of items) max = Math.max(max, i.start + i.dur);
  const clip = (i, media, extra = '') => {
    n++; const d = fr(i.dur), s = fr(i.start);
    return `<clipitem id="clip-${n}"><name>${xmlEsc(i.file)}</name><enabled>TRUE</enabled><duration>${d}</duration>${rate}<start>${s}</start><end>${s + d}</end><in>0</in><out>${d}</out>` +
      `<file id="file-${n}"><name>${xmlEsc(i.file)}</name><pathurl>${xmlEsc(url(i.file))}</pathurl>${rate}<duration>${d}</duration><media>${media}</media></file>${extra}</clipitem>`;
  };
  const aChars = '<samplecharacteristics><depth>24</depth><samplerate>48000</samplerate></samplecharacteristics>';
  const vtracks = items.filter(i => i.kind === 'video').map(i => `<track>${clip(i, `<video><samplecharacteristics>${rate}<width>${i.w || 1280}</width><height>${i.h || 720}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>`)}</track>`).join('\n');
  const atracks = items.filter(i => i.kind === 'audio').map(i => `<track>${clip(i, `<audio>${aChars}<channelcount>${i.channels || 1}</channelcount></audio>`, '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>')}</track>`).join('\n');
  const marks = (markers || []).map(m => `<marker><name>${xmlEsc(m.label)}</name><comment></comment><in>${fr(m.at)}</in><out>-1</out></marker>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5">\n<sequence id="sequence-1"><name>${xmlEsc(title)}</name><duration>${fr(max)}</duration>${rate}\n` +
    `<media>\n<video><format><samplecharacteristics>${rate}<width>1280</width><height>720</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>\n${vtracks}\n</video>\n` +
    `<audio><numOutputChannels>2</numOutputChannels><format>${aChars}</format>\n${atracks}\n</audio>\n</media>\n${marks}\n</sequence>\n</xmeml>\n`;
}

function auditionMarkersCsv(markers) {
  const t = sec => { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = (sec % 60).toFixed(3).padStart(6, '0'); return h ? `${h}:${pad(m)}:${s}` : `${m}:${s}`; };
  return 'Name\tStart\tDuration\tTime Format\tType\tDescription\r\n' + markers.map(m => `${m.label.replace(/\t/g, ' ')}\t${t(m.at)}\t${t(m.dur || 0)}\tdecimal\tCue\t${(m.group || '').replace(/\t/g, ' ')}`).join('\r\n') + '\r\n';
}

module.exports = { TAGS, editItems, editList, hms, transcriptTxt, transcriptSrt, transcriptVtt, chapters, levelReport, verdict, sesx, fcpXml, auditionMarkersCsv };
