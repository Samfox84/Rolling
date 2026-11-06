(() => {
'use strict';
const { $, esc, toast, quiet, LS, fmtMB, api } = window.Rolling;
const roomId = location.pathname.split('/').filter(Boolean)[1] || '';
const hostKey = new URLSearchParams(location.search).get('k') || '';
function rand(n) { const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (const x of crypto.getRandomValues(new Uint8Array(n))) s += c[x % c.length]; return s; }
let clientId = LS.get('ps_client');
if (!clientId || !/^[a-zA-Z0-9]{4,24}$/.test(clientId)) { clientId = rand(12); LS.set('ps_client', clientId); }

// ---------- state ----------
let stream = null, ctx = null, recNode = null, micSource = null;
let ws = null, myId = null, isHost = false, iceServers = [], joined = false, left = false, inWaiting = false;
let micOn = true, camOn = true;
const peers = new Map();
window.__studio = { peers }; // for troubleshooting from the browser console
const pendingSignals = new Map();   // signals that arrive before we know the sender
let recording = null;               // the take this browser is currently recording
let audioTarget = null;             // which take the audio thread is writing into
let recStartedAt = null;            // server time the take started
let lastTakeSaved = false;
let roomTone = null, roomToneSeconds = 20;
let screenStream = null;
let net = null;                     // connection test result
let videoBps = 4000000;
let serverDisk = null, gbPerPersonHour = 4;
let controlMode = false;            // host running the show with no camera/mic (not recorded)
let myLoud = null;                  // my own loudness (EBU R128) from the audio engine
let nextEpisode = 1;
let build = null;                   // progress of the take being built (host)
let uploadPeak = 0;                 // for the upload progress bar
const markers = [];
// producer desk (host): per person { db (null = fader off), mute, solo } — mute/solo are for the host's ears only
const desk = new Map();
let monVol = 0.5;
let chanMemory = {};                // the Console settings saved for each person's name (from the server)
let mixBus = null;                  // control room: { program, monitor, out, meter } Web Audio buses
let progLoud = null, progPeak = 0;  // the master meter
let sounds = [];                    // soundboard pads for this show (hosts)
let board = null;                   // control room: { bus, beds, dest } — played to everyone + metered + heard
const padBuffers = new Map();       // pad id → decoded audio
const playingPads = new Map();      // instance → { inst, pad, src, gain, started, dur }
let coughing = false;               // my cough button is held: my live sound is muted (recording untouched)
let talking = null;                 // host: peer id I'm doing talkback to
let talkMic = null;                 // host in the control room: a mic just for talkback
const talkStream = new MediaStream(); // host: the private talkback channel to each person
let rundown = [], segment = null;   // show clock
let fps = 25;                       // timecode frame rate (same as the video files)
const loudHist = new Map();         // id -> last 5 minutes of short-term loudness (one value a second)
let clockOffset = Date.now() - performance.now();
const syncSamples = [];
const serverNow = () => performance.now() + clockOffset;
const dbg = (...a) => { if (window.__debug) console.log('[rtc]', ...a); };

// ---------- small UI helpers ----------
function show(id) { for (const v of ['lobby', 'studio', 'message']) $('#' + v).classList.toggle('hidden', v !== id); }
function ask(title, html, yes = 'OK', no = 'Cancel', alt = null) {
  return new Promise(resolve => {
    $('#modalTitle').textContent = title; $('#modalText').innerHTML = html;
    $('#modalYes').textContent = yes; $('#modalNo').textContent = no;
    $('#modalNo').classList.toggle('hidden', !no);
    $('#modalAlt').classList.toggle('hidden', !alt); if (alt) $('#modalAlt').textContent = alt;
    $('#modal').classList.remove('hidden');
    const done = v => { $('#modal').classList.add('hidden'); $('#modalYes').onclick = $('#modalNo').onclick = $('#modalAlt').onclick = null; resolve(v); };
    $('#modalYes').onclick = () => done('yes'); $('#modalNo').onclick = () => done(false); $('#modalAlt').onclick = () => done('alt');
  });
}
function message(title, html, rejoin = false) { show('message'); $('#msgTitle').textContent = title; $('#msgText').innerHTML = html; $('#rejoinBtn').classList.toggle('hidden', !rejoin); }
const initials = n => (n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const fmtTime = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };
function chime() { try { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5); o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.55); } catch (e) { quiet('knock chime')(e); } }

// =====================================================================
// 1. Crash-proof storage: every recorded piece is saved to this computer's
//    disk (IndexedDB) BEFORE it is uploaded, and deleted only once the
//    server confirms it. Reopening the link after a crash resumes uploading.
// =====================================================================
const store = (() => {
  let db = null, ok = false; const mem = new Map(); let memId = 1;
  const ready = new Promise(res => {
    try {
      const r = indexedDB.open('podcast-studio', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
      r.onsuccess = () => { db = r.result; ok = true; res(); };
      r.onerror = r.onblocked = () => res();
    } catch { res(); }
    setTimeout(res, 4000);
  });
  const req = (mode, fn) => new Promise((res, rej) => { const t = db.transaction('chunks', mode); let out; const q = fn(t.objectStore('chunks')); if (q) q.onsuccess = () => { out = q.result; }; t.oncomplete = () => res(out); t.onerror = t.onabort = () => rej(t.error); });
  return {
    ready, get durable() { return ok; },
    async put(rec) {
      await ready;
      if (ok) { try { return await req('readwrite', s => s.add(rec)); } catch (e) { console.warn('disk save failed', e); setWarn('storage', true); } }
      const id = 'm' + (memId++); mem.set(id, rec); return id;
    },
    async get(id) { if (typeof id === 'string') return mem.get(id); return req('readonly', s => s.get(id)); },
    async del(id) { if (typeof id === 'string') { mem.delete(id); return; } try { await req('readwrite', s => s.delete(id)); } catch (e) { quiet('remove uploaded piece from disk (it may be sent twice — harmless)')(e); } },
    async list() {
      await ready; if (!ok) return [];
      return new Promise(res => { const out = []; const q = db.transaction('chunks').objectStore('chunks').openCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return res(out); const v = c.value; out.push({ id: c.key, url: v.url, size: v.size, pri: v.pri, seg: v.seg, kind: v.kind }); c.continue(); };
        q.onerror = () => res(out); });
    },
  };
})();
try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(quiet('ask for persistent storage')); } catch (e) { quiet('ask for persistent storage')(e); }

// uploader: audio first (it matters most), then video, then "finished" markers; 2 at a time; retries forever
const up = { items: new Map(), inflight: new Set(), pending: 0, pendingAudio: 0, fails: 0, seq: 0, segPuts: {}, recovered: 0 };
function track(it) { it.seq = ++up.seq; up.items.set(it.id, it); up.pending += it.size; if (it.kind === 'audio') up.pendingAudio += it.size; }
async function enqueue(url, body, meta) {
  const blob = body ? (body instanceof Blob ? body : new Blob([body])) : null;
  const rec = { url, body: blob, size: blob ? blob.size : 0, pri: meta.pri, seg: meta.seg, kind: meta.kind, ts: Date.now() };
  up.segPuts[meta.seg] = (up.segPuts[meta.seg] || 0) + 1;
  try { const id = await store.put(rec); track({ id, url, size: rec.size, pri: rec.pri, seg: rec.seg, kind: rec.kind, onDone: meta.onDone }); }
  finally { up.segPuts[meta.seg]--; }
  pump();
}
function pickNext() {
  const now = Date.now(); let best = null;
  for (const it of up.items.values()) {
    if (up.inflight.has(it.id) || (it.retryAt && it.retryAt > now)) continue;
    if (it.kind === 'done') { // only after everything else from that recording is safely on the server
      if (up.segPuts[it.seg] > 0) continue;
      let blocked = false; for (const o of up.items.values()) if (o.seg === it.seg && o.kind !== 'done') { blocked = true; break; }
      if (blocked) continue;
    }
    if (!best || it.pri < best.pri || (it.pri === best.pri && it.seq < best.seq)) best = it;
  }
  return best;
}
function pump() { while (up.inflight.size < 2) { const it = pickNext(); if (!it) break; sendItem(it); } }
async function sendItem(it) {
  up.inflight.add(it.id);
  try {
    const rec = await store.get(it.id);
    if (rec) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), it.kind === 'video' ? 180000 : 45000);
      let res;
      try { res = await fetch(it.url, { method: 'POST', body: rec.body || '', headers: { 'Content-Type': 'application/octet-stream' }, signal: ctl.signal }); }
      finally { clearTimeout(timer); }
      if (res.status >= 500 || res.status === 0) throw new Error('HTTP ' + res.status);
      if (!res.ok) quiet('server refused an uploaded piece (' + res.status + ')')(it.url);
    }
    await store.del(it.id);
    up.items.delete(it.id); up.pending -= it.size; if (it.kind === 'audio') up.pendingAudio -= it.size;
    up.fails = 0;
    if (it.onDone) it.onDone();
  } catch (e) {
    quiet('upload will retry')(e);
    up.fails++;
    const wait = Math.min(15000, 1000 * up.fails);
    it.retryAt = Date.now() + wait;
    setTimeout(pump, wait + 50);
  } finally {
    up.inflight.delete(it.id);
    pump(); updateUploadUI();
  }
}
// anything left over from last time (crash, closed tab, power cut)?
store.ready.then(async () => {
  if (!store.durable) setWarn('storage', true);
  const left = await store.list();
  if (!left.length) return;
  left.sort((a, b) => a.id - b.id).forEach(track);
  up.recovered = left.reduce((a, x) => a + x.size, 0);
  pump(); updateUploadUI();
});
function updateUploadUI() {
  const bar = $('#recoverBar');
  if (up.recovered) {
    bar.classList.remove('hidden');
    if (up.items.size && !recording) bar.innerHTML = `⏳ Uploading ${fmtMB(up.pending)} of recording saved from earlier — <b>please keep this page open</b>.`;
    else if (!up.items.size) { bar.innerHTML = '✓ Your earlier recording has finished uploading.'; up.recovered = 0; setTimeout(() => bar.classList.add('hidden'), 6000); }
  }
}

// =====================================================================
// 2. Lobby: camera, mic, connection test
// =====================================================================
$('#nameInput').value = LS.get('ps_name') || '';
$('#headphones').checked = LS.get('ps_headphones') === '1';
if (LS.get('ps_reccam') === '0') $('#recordCam').checked = false;
if (hostKey) { $('#roleBadge').textContent = 'Host'; $('#roleBadge').classList.add('ok'); document.querySelector('.hostonly-lobby').classList.remove('hidden'); }
document.addEventListener('rolling-info', e => { document.title = e.detail.name; });
if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && !/Mobi|Android/i.test(navigator.userAgent)) $('#screenBtn').classList.remove('hidden');

function canJoin() {
  const ok = !!stream && $('#nameInput').value.trim().length > 0;
  $('#joinBtn').disabled = !ok;
  $('#lobbyHint').textContent = !stream ? 'Turn on your camera & mic first.' : !ok ? 'Type your name to join.' : 'All set — join when ready.';
}
$('#nameInput').addEventListener('input', canJoin);
$('#recordCam').onchange = () => LS.set('ps_reccam', $('#recordCam').checked ? '1' : '0');

function audioConstraints(exact) {
  const a = { echoCancellation: !$('#headphones').checked, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48000 };
  const micId = $('#micSelect').value;
  if (micId && micId !== '—') a.deviceId = exact ? { exact: micId } : { ideal: micId };
  return a;
}
function videoConstraints(exact) {
  const camId = $('#camSelect').value;
  if (camId === 'off') return false;
  const v = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (camId && camId !== '—') v.deviceId = exact ? { exact: camId } : { ideal: camId };
  return v;
}
async function getMedia() {
  const audio = audioConstraints(true), video = videoConstraints(true);
  try { return await navigator.mediaDevices.getUserMedia({ audio, video }); }
  catch (e) {
    if (video) { try { const s = await navigator.mediaDevices.getUserMedia({ audio, video: false }); toast('Camera not available — joining with audio only', 4000); return s; } catch (e2) { quiet('audio-only fallback')(e2); } }
    throw e;
  }
}
async function ensureAudioGraph() {
  if (ctx) return;
  try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); } catch { ctx = new AudioContext(); }
  await ctx.audioWorklet.addModule('/recorder-worklet.js');
  recNode = new AudioWorkletNode(ctx, 'studio-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const silent = ctx.createGain(); silent.gain.value = 0;
  recNode.connect(silent).connect(ctx.destination);
  recNode.port.onmessage = onWorklet;
  setInterval(() => { if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(quiet('resume audio')); }, 1000);
}
function connectMic() {
  if (micSource) try { micSource.disconnect(); } catch (e) { quiet('disconnect old mic')(e); }
  micSource = null;
  const at = stream && stream.getAudioTracks()[0];
  if (at) { micSource = ctx.createMediaStreamSource(new MediaStream([at])); micSource.connect(recNode); watchTrack(at); }
  const vt = stream && stream.getVideoTracks()[0];
  if (vt) watchTrack(vt);
}
async function fillDevices() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  const at = stream.getAudioTracks()[0], vt = stream.getVideoTracks()[0];
  const curMic = at && at.getSettings().deviceId, curCam = vt && vt.getSettings().deviceId;
  const fill = (sel, kind, cur, allowOff) => {
    sel.innerHTML = '';
    devs.filter(d => d.kind === kind).forEach((d, i) => { const o = new Option(d.label || `${kind === 'audioinput' ? 'Microphone' : 'Camera'} ${i + 1}`, d.deviceId); if (d.deviceId === cur) o.selected = true; sel.add(o); });
    if (allowOff) { const o = new Option('No camera (audio only)', 'off'); if (!cur) o.selected = true; sel.add(o); }
    sel.disabled = false;
  };
  fill($('#micSelect'), 'audioinput', curMic, false);
  fill($('#camSelect'), 'videoinput', curCam, true);
}
async function startMedia() {
  $('#enableBtn').disabled = true;
  try {
    await ensureAudioGraph();
    if (ctx.state === 'suspended') await ctx.resume();
    const s = await getMedia();
    if (stream) stream.getTracks().forEach(t => { t.onended = null; t.stop(); });
    stream = s;
    $('#preview').srcObject = stream;
    $('#previewPlaceholder').classList.toggle('hidden', !!stream.getVideoTracks().length);
    if (!stream.getVideoTracks().length) $('#previewPlaceholder').innerHTML = '<div>Audio only — no camera</div>';
    connectMic();
    await fillDevices();
    canJoin();
    $('#soundBtn').disabled = false;
    if (!net) netTest();
  } catch (e) {
    console.error(e);
    $('#enableBtn').disabled = false;
    $('#previewPlaceholder').classList.remove('hidden');
    $('#lobbyHint').innerHTML = '<span style="color:var(--rec)">Couldn\'t use your camera/mic.</span> Click the camera icon in the address bar, choose <b>Allow</b>, then try again.';
  }
}
$('#enableBtn').onclick = startMedia;
$('#micSelect').onchange = $('#camSelect').onchange = startMedia;
$('#headphones').onchange = () => { LS.set('ps_headphones', $('#headphones').checked ? '1' : '0'); if (stream) startMedia(); };

// connection test: delay, download and upload speed to the studio server
async function netTest() {
  $('#netBtn').disabled = true;
  const res = $('#netResult');
  res.className = 'small-text muted'; res.textContent = 'Testing your connection…';
  const tfetch = (url, opt = {}, ms = 30000) => { const c = new AbortController(), t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t)); };
  try {
    const rtts = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); await tfetch('/api/ping?' + Math.random(), { cache: 'no-store' }, 10000); rtts.push(performance.now() - t0); }
    rtts.sort((a, b) => a - b); const rtt = rtts[2];
    let t0 = performance.now();
    const dl = await (await tfetch('/api/speedtest?bytes=4194304&' + Math.random(), { cache: 'no-store' })).arrayBuffer();
    const down = dl.byteLength * 8 / ((performance.now() - t0) / 1000) / 1e6;
    const payload = n => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
    let size = 524288, upMbps;
    for (;;) {
      const body = payload(size); t0 = performance.now();
      await tfetch('/api/speedtest', { method: 'POST', body, cache: 'no-store' }, 60000);
      const secs = (performance.now() - t0) / 1000; upMbps = size * 8 / secs / 1e6;
      if (secs > 1.5 || size >= 8388608) break;
      size *= 4;
    }
    net = { up: +upMbps.toFixed(1), down: +down.toFixed(1), rtt: Math.round(rtt) };
    videoBps = net.up >= 10 ? 4000000 : net.up >= 5 ? 2500000 : net.up >= 2.5 ? 1200000 : 800000;
    let cls = 'good', head = '✓ Great connection', advice = 'Everything will run smoothly.';
    if (net.up < 3 || net.rtt > 400) {
      cls = 'bad'; head = '⚠ Slow connection';
      advice = 'Your voice will still be recorded perfectly. For the best result use a cable or move closer to your Wi-Fi, and close other apps that use the internet.';
      if (net.up < 1.5 && $('#recordCam').checked) { $('#recordCam').checked = false; advice += ' We\'ve unticked "Record my camera" to keep things smooth — tick it again if you like.'; }
    } else if (net.up < 8 || net.rtt > 200) {
      cls = 'ok'; head = '● OK connection';
      advice = 'Fine for recording. Your camera recording may take a little while to finish uploading after the show — keep the tab open.';
    }
    if (net.rtt > 250) advice += ' The delay is high, so the conversation may feel a bit laggy.';
    res.className = 'small-text nettest-' + cls;
    res.innerHTML = `<b>${head}</b> — upload ${net.up} Mbps · download ${net.down} Mbps · delay ${net.rtt} ms<br><span class="muted">${advice}</span>`;
    sendState(true);
  } catch (e) {
    quiet('connection test')(e);
    res.className = 'small-text nettest-bad'; res.innerHTML = '<b>⚠ Couldn\'t reach the studio server.</b> Check your internet, then press Test again.';
  }
  $('#netBtn').disabled = false;
}
$('#netBtn').onclick = netTest;
// sound check: record 5 seconds, then play it back
$('#soundBtn').onclick = async () => {
  if (!stream || !stream.getAudioTracks().length) return toast('Turn on your mic first');
  const btn = $('#soundBtn'); btn.disabled = true;
  try {
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(new MediaStream(stream.getAudioTracks()), mime ? { mimeType: mime } : {});
    const parts = []; rec.ondataavailable = e => parts.push(e.data);
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start();
    for (let i = 5; i > 0; i--) { btn.textContent = `🔴 Recording… speak now (${i})`; await new Promise(r => setTimeout(r, 1000)); }
    rec.stop(); await stopped;
    btn.textContent = '🔊 Playing back…';
    const audio = new Audio(URL.createObjectURL(new Blob(parts, { type: rec.mimeType })));
    await audio.play(); await new Promise(r => { audio.onended = r; setTimeout(r, 7000); });
  } catch (e) { toast('Sound check didn\'t work in this browser'); }
  btn.textContent = '🎧 Sound check (5 s)'; btn.disabled = false;
};

// =====================================================================
// 3. Levels + problem detection (mic silent / unplugged / distorting / glitches / connection)
// =====================================================================
const WARN_TEXT = {
  'mic-silent': ['No sound from your microphone — check it\'s plugged in, unmuted on the device, and the right one is selected.', 'mic is silent'],
  'mic-lost': ['Your microphone disconnected — trying to reconnect it…', 'mic disconnected'],
  'cam-lost': ['Your camera disconnected. Your voice is still recording.', 'camera disconnected'],
  'clipping': ['Your mic is too loud and distorting — move back a little or turn the input down.', 'mic distorting (too loud)'],
  'glitch': ['Your computer is struggling to keep up — close other apps and plug in to power.', 'computer struggling — audio glitches'],
  'behind': ['Your upload is falling behind. It will catch up — keep this tab open after the show.', 'upload falling behind'],
  'offline': ['Lost connection to the studio — still recording safely on your computer, reconnecting…', 'disconnected — reconnecting'],
  'storage': ['This browser won\'t let us save to disk (private window?) — keep this tab open until it says Saved.', 'can\'t save to disk (private window?)'],
  'net': ['Your connection to the others is poor — the live call may stutter, but your recording is unaffected.', 'poor connection (live call only)'],
  'disk': ['The studio server is nearly out of space.', 'server nearly full'],
};
const warns = new Set();
function setWarn(code, on) {
  if (on === warns.has(code)) return;
  on ? warns.add(code) : warns.delete(code);
  renderWarnBar(); sendState(true);
}
function renderWarnBar() {
  const bar = $('#warnBar');
  bar.classList.toggle('hidden', !warns.size);
  bar.innerHTML = [...warns].map(c => `<div>⚠ ${esc(WARN_TEXT[c] ? WARN_TEXT[c][0] : c)}</div>`).join('');
  layout();
}
let localPeak = 0, lastSoundAt = performance.now();
const clipTimes = [], glitchTimes = [];
let glitches = 0;
function onWorklet(e) {
  const m = e.data;
  if (m.type === 'loud') { myLoud = m; showLobbyLoud(); return; }
  if (m.type === 'level') {
    localPeak = Math.max(localPeak * 0.6, m.peak);
    if (m.peak > 0.0003) lastSoundAt = performance.now();
    if (m.clips > 2 && micOn) clipTimes.push(performance.now());
    return;
  }
  if (m.type === 'glitch') { glitches++; glitchTimes.push(performance.now()); return; }
  if (m.type === 'pcm') return onPcm(m);
  if (m.type === 'stopped') { const r = audioTarget; audioTarget = null; if (r) { r.audioStopped = true; maybeFinish(r); } }
}
setInterval(() => {
  const now = performance.now();
  while (clipTimes.length && now - clipTimes[0] > 15000) clipTimes.shift();
  while (glitchTimes.length && now - glitchTimes[0] > 30000) glitchTimes.shift();
  const at = stream && stream.getAudioTracks()[0];
  setWarn('mic-silent', !!(joined && micOn && at && at.readyState === 'live' && now - lastSoundAt > 15000));
  setWarn('clipping', clipTimes.length >= 3);
  setWarn('glitch', glitchTimes.length >= 2);
  setWarn('behind', up.pendingAudio > 3 * 1048576 || up.pending > 150 * 1048576);
  setWarn('offline', joined && !left && (!ws || ws.readyState !== 1));
  if (ctx && ctx.state !== 'running' && recording) ctx.resume().catch(quiet('resume audio while recording'));
}, 1000);

// a device unplugged mid-show: reconnect automatically and keep recording
function watchTrack(track) {
  track.onended = () => (track.kind === 'audio' ? recoverMic() : onCamLost());
}
let recoveringMic = false;
async function recoverMic() {
  if (recoveringMic || !stream) return;
  recoveringMic = true; setWarn('mic-lost', true);
  for (let attempt = 0; attempt < 200 && !left; attempt++) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(false) });
      const nt = s.getAudioTracks()[0];
      for (const old of stream.getAudioTracks()) { old.onended = null; stream.removeTrack(old); old.stop(); }
      nt.enabled = micOn; stream.addTrack(nt);
      connectMic();
      updateAudioSenders();
      setWarn('mic-lost', false); toast('🎙 Microphone reconnected'); fillDevices().catch(quiet('refresh device list'));
      break;
    } catch { await new Promise(r => setTimeout(r, 3000)); }
  }
  recoveringMic = false;
}
function onCamLost() { setWarn('cam-lost', true); document.getElementById('tile-me') && document.getElementById('tile-me').classList.add('camoff'); }
if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', async () => {
  if (!stream) return;
  const at = stream.getAudioTracks()[0];
  if (!at || at.readyState === 'ended') return recoverMic();
  if (!joined) fillDevices().catch(quiet('refresh device list'));
});

// live-call quality (packet loss) from the browser's own stats
setInterval(async () => {
  if (!joined) return;
  let loss = 0, relay = false;
  for (const p of peers.values()) {
    try {
      const stats = await p.pc.getStats();
      stats.forEach(s => {
        if (s.type === 'remote-inbound-rtp' && typeof s.fractionLost === 'number') loss = Math.max(loss, s.fractionLost);
        if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') { const lc = stats.get(s.localCandidateId); if (lc && lc.candidateType === 'relay') relay = true; }
      });
    } catch (e) { quiet('read call stats')(e); }
  }
  myNet.loss = loss; myNet.relay = relay;
  myNet.badCount = loss > 0.08 ? (myNet.badCount || 0) + 1 : 0;
  setWarn('net', myNet.badCount >= 2);
}, 3000);
const myNet = { loss: 0, relay: false };

const fmtL = v => (Number.isFinite(v) ? v.toFixed(1) : '—');
function loudClass(S) { return !Number.isFinite(S) || S < -40 ? '' : S < -30 ? 'warnc' : S > -10 ? 'bad' : 'goodc'; }
function showLobbyLoud() {
  const el = $('#lobbyLoud'); if (!el || !myLoud) return;
  el.innerHTML = `Loudness <b class="${loudClass(myLoud.S)}">${fmtL(myLoud.S)} LUFS</b> · peak <b class="${myLoud.TP > -1 ? 'bad' : ''}">${fmtL(myLoud.TP)} dBTP</b> <span class="muted">— aim for about −20 LUFS while talking</span>`;
}
// send my meters to the host ~5 times a second (only while in the studio)
setInterval(() => { if (joined && myLoud && !controlMode) wsSend({ t: 'meter', m: { M: r1(myLoud.M), S: r1(myLoud.S), I: r1(myLoud.I), TP: r1(myLoud.TP), TPmax: r1(myLoud.TPmax) } }); }, 200);
function r1(v) { return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; }
function levelLoop() {
  const pct = Math.min(100, Math.sqrt(localPeak) * 110);
  $('#lobbyMeter').style.width = pct + '%';
  const meTile = document.getElementById('tile-me');
  if (meTile) meTile.classList.toggle('speaking', micOn && localPeak > 0.04);
  for (const p of peers.values()) {
    if (!p.analyser) continue;
    p.analyser.getFloatTimeDomainData(p.buf);
    let pk = 0; for (const v of p.buf) pk = Math.max(pk, Math.abs(v));
    p.level = Math.max((p.level || 0) * 0.85, pk);
    if (p.tile) p.tile.classList.toggle('speaking', pk > 0.04);
    drawVu(p.tile, p.state && p.state.mic === false ? 0 : p.level);
  }
  drawVu(meTile, micOn ? localPeak : 0);
  if (drawerTab === 'desk') for (const el of document.querySelectorAll('#deskStrips .strip')) {
    const id = el.dataset.id, p = peers.get(id), pk = id === myId ? (micOn ? localPeak : 0) : p ? p.level || 0 : 0;
    const db = 20 * Math.log10(Math.max(pk, 1e-6)), pos = Math.max(0, Math.min(1, (db + 60) / 60));
    el.querySelector('.smeter span').style.width = ((1 - pos) * 100).toFixed(1) + '%';
  }
  localPeak *= 0.85;
  requestAnimationFrame(levelLoop);
}
requestAnimationFrame(levelLoop);
// live level bar on a tile: −60 to 0 dBFS, green → amber (−12) → red (−3), peak hold 1.5 s, CLIP light for 3 s
const VU_FLOOR = -60;
function drawVu(tile, peak) {
  const vu = tile && tile.querySelector('.vu'); if (!vu) return;
  const now = performance.now(), db = 20 * Math.log10(Math.max(peak, 1e-6));
  const pos = Math.max(0, Math.min(1, (db - VU_FLOOR) / -VU_FLOOR));
  const st = vu._st || (vu._st = { hold: 0, holdAt: 0, clipAt: -1e9 });
  if (pos >= st.hold || now - st.holdAt > 1500) { st.hold = pos >= st.hold ? pos : Math.max(pos, st.hold - 0.01); if (pos >= st.hold) st.holdAt = now; }
  if (peak >= 0.989) st.clipAt = now; // about −0.1 dBFS
  vu.children[0].style.height = ((1 - pos) * 100).toFixed(1) + '%'; // covers the unlit part of the green→amber→red scale
  vu.children[1].style.bottom = (st.hold * 100).toFixed(1) + '%';
  vu.classList.toggle('clip', now - st.clipAt < 3000);
}

// =====================================================================
// 4. Joining + messages from the server
// =====================================================================
$('#controlBtn').onclick = async () => {
  const name = $('#nameInput').value.trim() || 'Host';
  $('#nameInput').value = name; LS.set('ps_name', name);
  controlMode = true;
  try { await ensureAudioGraph(); await ctx.resume(); } catch (e) { quiet('control room audio')(e); toast('Meters may not work in this browser — everything else will', 5000); }
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = new MediaStream();
  micOn = false; camOn = false;
  connect();
};
$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  if (!name || !stream) return;
  LS.set('ps_name', name);
  ctx.resume().catch(quiet('resume audio'));
  connect();
};
$('#rejoinBtn').onclick = () => location.reload();

function wsSend(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  left = false;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    lastPong = Date.now();
    wsSend({ t: 'join', room: roomId, key: hostKey, name: $('#nameInput').value.trim(), clientId, recSeg: recording ? recording.seg : null, camId: stream.id, control: controlMode });
    for (let i = 0; i < 8; i++) setTimeout(() => wsSend({ t: 'ping', c: performance.now() }), i * 250);
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { quiet('unreadable message from server')(err); return; } onMsg(m); };
  ws.onclose = () => {
    for (const p of [...peers.values()]) removePeer(p.id);
    pendingSignals.clear();
    if (left) return;
    if (joined || inWaiting) { $('#uploadLine').textContent = 'Reconnecting…'; setTimeout(connect, 2000); }
  };
}
let lastPong = Date.now();
setInterval(() => {
  wsSend({ t: 'ping', c: performance.now() });
  if (ws && ws.readyState === 1 && Date.now() - lastPong > 15000) { quiet('no answer from the server for 15 s — reconnecting')(''); lastPong = Date.now(); ws.close(); }
}, 5000);

function onMsg(m) {
  switch (m.t) {
    case 'pong': {
      lastPong = Date.now();
      const now = performance.now(), rtt = now - m.c;
      syncSamples.push({ rtt, off: m.s + rtt / 2 - now });
      if (syncSamples.length > 20) syncSamples.shift();
      clockOffset = syncSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).off;
      myNet.serverRtt = Math.round(syncSamples.slice(-5).reduce((a, b) => a + b.rtt, 0) / Math.min(5, syncSamples.length));
      break;
    }
    case 'waiting':
      inWaiting = true;
      message('Waiting for the host…', `The host will let you in shortly.${m.hostHere ? '' : ' <br>They haven\'t arrived yet — you\'ll get in as soon as they do.'}<br><br><span class="small-text">Keep this page open.</span>`);
      break;
    case 'welcome': {
      inWaiting = false;
      myId = m.id; isHost = m.isHost; iceServers = m.ice || []; roomToneSeconds = m.roomToneSeconds || 20; gbPerPersonHour = m.gbPerPersonHour || 4;
      if (m.disk) serverDisk = m.disk;
      $('#roomTitle').textContent = m.roomName; document.title = m.roomName + ' — ' + m.studio;
      document.querySelectorAll('.hostonly').forEach(e => e.classList.toggle('hidden', !isHost));
      $('#recordingsLink').href = `/m/${roomId}?k=${encodeURIComponent(hostKey)}`;
      if (m.nextEpisode) nextEpisode = m.nextEpisode;
      if (!joined) { joined = true; show('studio'); if (controlMode) enterControlMode(); else addMyTile(); if (screenStream) showScreenTile('me', screenStream, 'Your screen'); (m.chat || []).forEach(c => addChat(c, true)); }
      $('#uploadLine').textContent = '';
      for (const p of m.peers) addPeer(p, true);
      for (const w of m.waiting || []) showKnock(w);
      if (!m.recording) { recStartedAt = null; if (recording) stopLocal(recording); }
      else { recStartedAt = m.recording.started; if (recording && recording.take !== m.recording.take) stopLocal(recording); }
      if (m.roomTone) startToneOverlay(m.roomTone);
      if (screenStream) wsSend({ t: 'screen', on: true, streamId: screenStream.id });
      rundown = m.rundown || []; segment = m.segment || null; renderRundown(); if (m.fps) fps = m.fps;
      chanMemory = m.channels || {};
      if (m.sounds) { sounds = m.sounds; renderPads(); }
      $('#greenIn').classList.toggle('hidden', !m.green);
      if (!isHost && !controlMode) sendDevices();
      $('#consoleBtn').classList.toggle('hidden', !(isHost && controlMode));
      if (window.rollingDesk && isHost && controlMode && !openConsole.opened) { openConsole.opened = true; openConsole(); } // the desktop app goes straight to the Console
      for (const id of m.coughing || []) { const p = peers.get(id); if (p) { p.coughing = true; p.tile.classList.add('coughing'); } }
      renderDesk();
      updateRecUI(); sendState(true); layout();
      break;
    }
    case 'error':
      left = true; inWaiting = false;
      try { ws.close(); } catch (e) { quiet('close connection')(e); }
      message(m.code === 'full' ? 'Studio is full' : m.code === 'kicked' ? 'Removed from studio' : m.code === 'denied' ? 'Not let in' : 'Can\'t join', esc(m.msg), m.code === 'full' || m.code === 'denied');
      if (up.items.size) finishScreen();
      break;
    case 'notice': ask(m.level === 'error' ? 'Problem' : 'Note', esc(m.text), 'OK', null); break;
    case 'peer-joined': addPeer(m.peer, false); layout(); toast(`${m.peer.name} joined`); renderDesk(); break;
    case 'peer-left': { const p = peers.get(m.id); if (p) toast(`${p.name} left`); if (talking === m.id) stopTalk(); removePeer(m.id); pendingSignals.delete(m.id); layout(); renderDesk(); break; }
    case 'peer-state': { const p = peers.get(m.id); if (p) { const before = new Set((p.state && p.state.warnings) || []); p.state = m.state; renderStatus(p); if (isHost) for (const w of p.state.warnings || []) if (!before.has(w)) { toast(`⚠ ${p.name}: ${WARN_TEXT[w] ? WARN_TEXT[w][1] : w}`, 5000); } } break; }
    case 'screen': { const p = peers.get(m.id); if (p) { p.screenId = m.on ? m.streamId : null; if (!m.on) removeScreenTile(p.id); else attachScreenIfReady(p); } break; }
    case 'signal': onSignal(m.from, m.data); break;
    case 'recording': recStartedAt = m.on ? m.started : null; updateRecUI(); if (m.on) { toast(`Recording started (take ${m.n})`); markers.length = 0; build = null; sendAllRides(); for (const x of playingPads.values()) if (x.pad.mode === 'bed') sendBoard('start', x); if (m.nextEpisode) nextEpisode = m.nextEpisode; if (!m.roomTone) countdown(); recNode.port.postMessage({ cmd: 'resetLoud' }); } else { toast('Recording stopped — finishing uploads…', 3500); uploadPeak = 0; } break;
    case 'record-start': startLocal(m); break;
    case 'record-stop': if (recording && recording.take === m.take) stopLocal(recording); stopToneOverlay(true); break;
    case 'roomtone': startToneOverlay(m); break;
    case 'chat': addChat(m); break;
    case 'marker': markers.push(m); toast(`📍 ${m.label} at ${fmtTime(m.at)}`); break;
    case 'knock': showKnock(m); chime(); break;
    case 'knock-gone': { const k = document.getElementById('knock-' + m.id); if (k) k.remove(); break; }
    case 'server': serverDisk = m.disk; break;
    case 'meter': { const p = peers.get(m.id); if (p) p.loud = m.m; break; }
    case 'build': build = m; renderBuild(); break;
    case 'tx': txLive = m; break;
    case 'cough': { const p = peers.get(m.id); if (p) { p.coughing = m.on; if (p.tile) p.tile.classList.toggle('coughing', m.on); } break; }
    case 'cue': showCue(m.text, m.from); break;
    case 'talk': { const p = peers.get(m.from); $('#talkName').textContent = m.name || (p && p.name) || 'The host'; $('#talkIn').classList.toggle('hidden', !m.on); if (m.on && p && p.extraAudio) for (const el of Object.values(p.extraAudio)) el.play().catch(quiet('play talkback')); break; }
    case 'segment': segment = m.segment; renderRundown(); break;
    case 'rundown': rundown = m.rundown || []; renderRundown(); break;
    case 'sounds': sounds = m.sounds || []; renderPads(); break;
    case 'onair': {
      if (m.peers) { // me: out of the green room — meet everyone (I'm the newcomer, so I call them)
        $('#greenIn').classList.add('hidden'); toast('🎙 You\'re on air!');
        for (const info of m.peers) if (!peers.has(info.id)) addPeer(info, true);
        layout();
      } else { const p = peers.get(m.id); if (p) { p.green = false; renderGreen(p); renderConsole(true); } }
      break;
    }
    case 'devices': { const p = peers.get(m.id); if (p) { p.devices = m.devices; renderConsole(); } break; }
    case 'control': onControl(m); break;
  }
}

// =====================================================================
// 5. WebRTC: everyone connects to everyone ("perfect negotiation" so screen share can be added any time)
// =====================================================================
// the newcomer makes the first offer; after that either side can renegotiate (e.g. screen share)
function addPeer(info, initiator) {
  if (peers.has(info.id)) removePeer(info.id);
  const pc = new RTCPeerConnection({ iceServers });
  const p = { id: info.id, name: info.name, isHost: info.isHost, state: info.state || {}, camId: info.camId, screenId: info.screenId, pc,
    polite: myId > info.id, canOffer: !!initiator, makingOffer: false, ignoreOffer: false, chain: Promise.resolve(), streams: new Map(), tile: null };
  peers.set(p.id, p);
  p.control = !!info.control;
  p.tile = makeTile(p.id, p.name, false);
  if (p.control) p.tile.classList.add('hidden'); // the control room isn't on camera
  if (isHost) {
    const k = document.createElement('button'); k.className = 'small ghost kick'; k.textContent = 'Remove';
    k.onclick = async () => { if (await ask(`Remove ${esc(p.name)}?`, 'They will be taken out of the studio. Their recording so far is kept.', 'Remove')) wsSend({ t: 'kick', id: p.id }); };
    p.tile.appendChild(k);
  }
  renderStatus(p);
  for (const tr of stream.getTracks()) { const snd = pc.addTrack(tr, stream); if (tr.kind === 'audio') p.mainAudio = snd; }
  if (!stream.getAudioTracks().length) p.mainAudio = pc.addTransceiver('audio', { direction: 'recvonly' }).sender;
  p.green = !!info.green; p.devices = info.devices || null; renderGreen(p);
  if (isHost) p.talkTr = pc.addTransceiver('audio', { direction: 'sendonly', streams: [talkStream] }); // private talkback channel (silent until used)
  if (isHost && controlMode && ensureBoard()) p.boardTr = pc.addTransceiver(board.dest.stream.getAudioTracks()[0], { direction: 'sendonly', streams: [board.dest.stream] }); // the soundboard, heard by everyone
  if (!stream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
  if (screenStream) p.screenSender = pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
  pc.ontrack = e => {
    const st = e.streams[0] || new MediaStream([e.track]);
    p.streams.set(st.id, st);
    const isScreen = (p.screenId && st.id === p.screenId) || (e.track.kind === 'video' && p.camId && st.id !== p.camId);
    if (isScreen) { if (!p.screenId) p.screenId = st.id; showScreenTile(p.id, st, `${p.name}'s screen`); return; }
    if (e.track.kind === 'audio' && p.camId && st.id !== p.camId) { // a host's talkback channel or soundboard — heard, never recorded
      p.extraAudio = p.extraAudio || {};
      const el = p.extraAudio[st.id] || (p.extraAudio[st.id] = Object.assign(new Audio(), { autoplay: true }));
      el.srcObject = st; el.play().catch(quiet('talkback / soundboard autoplay'));
      return;
    }
    const v = p.tile.querySelector('video');
    if (v.srcObject !== st) v.srcObject = st;
    v.muted = controlMode; // in the control room everyone is heard through the Console instead
    playOrAsk(v);
    if (e.track.kind === 'audio' && !p.analyser) {
      // taken from the stream the video element plays: Chrome only delivers call audio to Web Audio that way
      try { const src = ctx.createMediaStreamSource(st); p.analyser = ctx.createAnalyser(); p.analyser.fftSize = 512; p.buf = new Float32Array(512); src.connect(p.analyser); } catch (e) { quiet('level meter for ' + p.name)(e); }
      if (controlMode) buildChannel(p, st);
    }
  };
  pc.onnegotiationneeded = async () => {
    if (!p.canOffer) { dbg('waiting for first offer from', p.name); return; }
    try { p.makingOffer = true; dbg('negotiationneeded', p.name, pc.signalingState); await pc.setLocalDescription(); if (pc.signalingState !== 'have-local-offer') return; dbg('sent', pc.localDescription.type, 'to', p.name); wsSend({ t: 'signal', to: p.id, data: { sdp: pc.localDescription } }); }
    catch (e) { console.warn('offer', e); } finally { p.makingOffer = false; }
  };
  pc.onicecandidate = e => { if (e.candidate) wsSend({ t: 'signal', to: p.id, data: { candidate: e.candidate } }); };
  pc.oniceconnectionstatechange = () => { if (pc.iceConnectionState === 'failed') pc.restartIce(); };
  pc.onconnectionstatechange = () => {
    const st = pc.connectionState, conn = p.tile && p.tile.querySelector('.conn');
    if (conn) { conn.classList.toggle('hidden', st === 'connected'); conn.textContent = st === 'failed' ? 'Connection problem — retrying…' : 'Connecting…'; }
    if (st === 'connected') tuneSenders();
  };
  for (const d of pendingSignals.get(p.id) || []) onSignal(p.id, d);
  pendingSignals.delete(p.id);
}
function onSignal(from, data) {
  const p = peers.get(from);
  if (!p) { dbg('buffer signal from', from, data.sdp ? data.sdp.type : 'cand'); if (!pendingSignals.has(from)) pendingSignals.set(from, []); pendingSignals.get(from).push(data); return; }
  p.chain = p.chain.then(async () => {
    const pc = p.pc;
    try {
      if (data.sdp) {
        const desc = data.sdp;
        const collision = desc.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
        p.ignoreOffer = !p.polite && collision;
        dbg('got', desc.type, 'from', p.name, 'state', pc.signalingState, 'collision', collision, 'ignore', p.ignoreOffer);
        if (p.ignoreOffer) return;
        await pc.setRemoteDescription(desc);
        if (desc.type === 'offer') { await pc.setLocalDescription(); wsSend({ t: 'signal', to: p.id, data: { sdp: pc.localDescription } }); p.canOffer = true; }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) console.warn('ice', e); }
      }
    } catch (e) { console.warn('signal', e); }
  });
}
function removePeer(id) {
  const p = peers.get(id); if (!p) return;
  peers.delete(id);
  try { p.pc.close(); } catch (e) { quiet('close connection to ' + p.name)(e); }
  if (p.tile) p.tile.remove();
  removeScreenTile(id);
  if (p.chan) for (const n of Object.values(p.chan)) try { n.disconnect(); } catch (e) { quiet('disconnect console channel')(e); }
  tuneSenders();
}
// lower the live call's quality as more people join (the recordings are always full quality)
function tuneSenders() {
  const n = peers.size, cam = stream && stream.getVideoTracks()[0];
  const br = n <= 1 ? 1500000 : n === 2 ? 900000 : 550000, scale = n <= 1 ? 1 : n === 2 ? 1.5 : 2;
  for (const p of peers.values()) for (const s of p.pc.getSenders()) {
    if (!s.track || s.track.kind !== 'video') continue;
    const params = s.getParameters();
    if (!params.encodings || !params.encodings.length) continue;
    if (s.track === cam) { params.encodings[0].maxBitrate = br; params.encodings[0].scaleResolutionDownBy = scale; }
    else { params.encodings[0].maxBitrate = 1500000; params.encodings[0].scaleResolutionDownBy = 1; }
    s.setParameters(params).catch(quiet('adjust video quality'));
  }
}

// browsers can block sound until the page is clicked — never fail silently: show a button
function playOrAsk(v) {
  v.play().catch(e => {
    quiet('autoplay blocked')(e);
    if (document.getElementById('soundGate')) return;
    const b = document.createElement('button'); b.id = 'soundGate'; b.className = 'primary sound-gate'; b.textContent = '🔊 Click to hear everyone';
    b.onclick = () => { document.querySelectorAll('video').forEach(x => x.play().catch(quiet('play after click'))); if (ctx) ctx.resume().catch(quiet('resume audio')); b.remove(); };
    document.body.appendChild(b);
  });
}
// =====================================================================
// 6. Tiles + layout
// =====================================================================
function makeTile(id, name, isMe) {
  const el = document.createElement('div');
  el.className = 'tile' + (isMe ? ' me' : ''); el.id = 'tile-' + id;
  el.innerHTML = `<video autoplay playsinline ${isMe ? 'muted' : ''}></video><div class="avatar"></div>
    <div class="label"><span class="micicon"></span><span class="name"></span></div><div class="status"></div>
    <div class="vu" title="Live level (peak, dBFS). Green is good, amber is loud, red at the top = too loud"><span class="cover"></span><span class="hold"></span></div>
    ${isMe ? '' : '<div class="conn">Connecting…</div>'}`;
  el.querySelector('.name').textContent = name + (isMe ? ' (you)' : '');
  el.querySelector('.avatar').textContent = initials(name);
  $('#grid').appendChild(el);
  return el;
}
function enterControlMode() {
  document.body.classList.add('control-mode');
  ['#micBtn', '#camBtn', '#screenBtn'].forEach(q => $(q).classList.add('hidden'));
  $('#roomTitle').textContent += ' — control room';
  openDrawer('health');
}
function addMyTile() {
  const el = makeTile('me', $('#nameInput').value.trim(), true);
  el.querySelector('video').srcObject = stream;
  el.classList.toggle('camoff', !stream.getVideoTracks().length);
  layout();
}
function showScreenTile(id, st, label) {
  let el = document.getElementById('screen-' + id);
  if (!el) {
    el = document.createElement('div'); el.className = 'tile screen'; el.id = 'screen-' + id;
    el.innerHTML = `<video autoplay playsinline muted></video><div class="label"><span class="name"></span></div>`;
    el.querySelector('.name').textContent = '🖥 ' + label;
    $('#grid').prepend(el);
  }
  el.querySelector('video').srcObject = st; playOrAsk(el.querySelector('video'));
  layout();
}
function attachScreenIfReady(p) { const st = p.screenId && p.streams.get(p.screenId); if (st) showScreenTile(p.id, st, `${p.name}'s screen`); }
function removeScreenTile(id) { const el = document.getElementById('screen-' + id); if (el) { el.remove(); layout(); } }
function layout() {
  const grid = $('#grid'), tiles = grid.querySelectorAll('.tile:not(.hidden)').length;
  if (!tiles) return;
  const W = grid.clientWidth - 24, H = grid.clientHeight - 24, gap = 10;
  let best = 0, bestCols = 1;
  for (let cols = 1; cols <= tiles; cols++) {
    const rows = Math.ceil(tiles / cols);
    const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * 16 / 9);
    if (w > best) { best = w; bestCols = cols; }
  }
  grid.style.gridTemplateColumns = `repeat(${bestCols}, ${Math.max(120, Math.floor(best))}px)`;
}
addEventListener('resize', layout);

function renderStatus(p) {
  const s = p.state || {}, el = p.tile; if (!el) return;
  el.classList.toggle('rec', s.rec === 'recording'); // tally on the person's tile
  el.classList.toggle('camoff', s.cam === false);
  el.querySelector('.micicon').textContent = s.mic === false ? '🔇' : '';
  el.querySelector('.status').innerHTML = statusPills(s);
}
function statusPills(s) {
  let h = '';
  if (s.rec === 'recording') h += `<span class="pill rec">● REC</span>`;
  else if (s.rec === 'uploading') h += `<span class="pill warn">↑ ${fmtMB(s.pending || 0)}</span>`;
  else if (s.rec === 'saved') h += `<span class="pill ok">✓ Saved</span>`;
  if ((s.warnings || []).length) h += `<span class="pill warn">⚠ ${s.warnings.length}</span>`;
  return h;
}

// =====================================================================
// 7. Buttons: mic, camera, screen share, record, marker, room tone, chat, health
// =====================================================================
function toggleMic() {
  micOn = !micOn;
  stream.getAudioTracks().forEach(t => t.enabled = micOn);
  $('#micBtn').textContent = micOn ? '🎙 Mic on' : '🔇 Mic off'; $('#micBtn').classList.toggle('off', !micOn);
  const mi = document.querySelector('#tile-me .micicon'); if (mi) mi.textContent = micOn ? '' : '🔇';
  lastSoundAt = performance.now();
  sendState(true);
}
function toggleCam() {
  if (!stream.getVideoTracks().length) return toast('No camera connected');
  camOn = !camOn;
  stream.getVideoTracks().forEach(t => t.enabled = camOn);
  $('#camBtn').textContent = camOn ? '📷 Camera on' : '🚫 Camera off'; $('#camBtn').classList.toggle('off', !camOn);
  document.getElementById('tile-me').classList.toggle('camoff', !camOn);
  sendState(true);
}
$('#micBtn').onclick = toggleMic;
$('#camBtn').onclick = toggleCam;

async function startScreen() {
  try { screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false }); }
  catch { return; }
  const tr = screenStream.getVideoTracks()[0];
  try { tr.contentHint = 'detail'; } catch (e) { quiet('screen share sharpness hint')(e); }
  tr.onended = stopScreen;
  wsSend({ t: 'screen', on: true, streamId: screenStream.id });
  for (const p of peers.values()) p.screenSender = p.pc.addTrack(tr, screenStream);
  showScreenTile('me', screenStream, 'Your screen');
  if (recording) startScreenRecorder(recording);
  $('#screenBtn').textContent = '🛑 Stop sharing'; $('#screenBtn').classList.add('off');
}
function stopScreen() {
  if (!screenStream) return;
  for (const p of peers.values()) if (p.screenSender) { try { p.pc.removeTrack(p.screenSender); } catch (e) { quiet('stop sending screen')(e); } p.screenSender = null; }
  screenStream.getTracks().forEach(t => { t.onended = null; t.stop(); });
  if (recording && recording.screenRec) recording.screenRec.stop();
  screenStream = null;
  wsSend({ t: 'screen', on: false });
  removeScreenTile('me');
  $('#screenBtn').textContent = '🖥 Share screen'; $('#screenBtn').classList.remove('off');
}
$('#screenBtn').onclick = () => (screenStream ? stopScreen() : startScreen());

$('#recBtn').onclick = async () => {
  if (!recStartedAt) {
    let disk = '';
    if (serverDisk) {
      const gb = serverDisk.free / 1073741824, people = peers.size + 1, hrs = gb / (people * gbPerPersonHour);
      disk = `<p class="small-text" style="margin-top:12px">Studio server: <b>${gb.toFixed(0)} GB free</b> — room for about <b>${hrs >= 10 ? Math.floor(hrs) : hrs.toFixed(1)} hours</b> with ${people} ${people === 1 ? 'person' : 'people'}.</p>`;
    }
    const a = await ask('Start recording',
      `<div class="grid2" style="margin-bottom:10px"><div><label style="margin-top:0">Episode number</label><input type="text" id="epNum" value="${nextEpisode}"></div>` +
      `<div><label style="margin-top:0">Episode title (optional)</label><input type="text" id="epTitle" maxlength="80" placeholder="e.g. The Keyword Era"></div></div>` +
      `Record <b>${roomToneSeconds} seconds of room tone</b> first? Everyone gets a "Quiet please" countdown, then a 3-2-1 and you're live. ` +
      `It's saved as a separate noise-print file for each person (and is also at the start of their main track).${disk}`,
      'Room tone, then record', 'Cancel', 'Record without room tone');
    if (!a) return;
    const episode = { n: ($('#epNum') && $('#epNum').value.trim()) || '', title: ($('#epTitle') && $('#epTitle').value.trim()) || '' };
    wsSend({ t: 'record', on: true, roomTone: a === 'yes', episode });
  } else {
    if (await ask('Stop recording?', 'Everyone\'s files will finish uploading, then they\'ll be ready on the Recordings page.', 'Stop recording')) wsSend({ t: 'record', on: false });
  }
};
$('#toneBtn').onclick = async () => {
  if (!recStartedAt) return toast('Start recording first');
  if (roomTone) return;
  if (await ask('Record room tone now?', `Everyone will be asked to stay silent for ${roomToneSeconds} seconds.`, 'Start room tone')) wsSend({ t: 'roomtone' });
};
function dropMarker(tag) { if (!isHost) return; if (!recStartedAt) return toast('Markers work while recording'); wsSend({ t: 'marker', at: serverNow(), ...(tag ? { tag } : {}) }); }
$('#markerBtn').onclick = () => dropMarker();
document.querySelectorAll('[data-tag]').forEach(b => { b.onclick = () => dropMarker(b.dataset.tag || null); });
const TAG_KEYS = { 1: 'great', 2: 'cut', 3: 'retake', 4: 'ad' };
const typing = e => !!(e.target.closest && e.target.closest('input,textarea,select')) || e.metaKey || e.ctrlKey || e.altKey;
addEventListener('keydown', e => {
  if (!joined || typing(e)) return;
  const k = e.key.toLowerCase();
  if (k === 'm') dropMarker();
  else if (TAG_KEYS[k] && isHost) dropMarker(TAG_KEYS[k]);
  else if (k === 'c' && !e.repeat && !controlMode) setCough(true);
  else if (k === 't' && !e.repeat && isHost && $('#console').classList.contains('hidden')) startTalk();
});
addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k === 'c') setCough(false);
  if (k === 't') stopTalk();
});
addEventListener('blur', () => { setCough(false); stopTalk(); }); // never leave someone stuck muted

// ---------- one place that decides what audio goes to each person ----------
// my mic goes to everyone unless I'm holding the cough button or doing talkback; talkback goes only to its target
function updateAudioSenders() {
  const mic = (stream && stream.getAudioTracks()[0]) || null;
  const talkTrack = talking ? (mic || (talkMic && talkMic.getAudioTracks()[0]) || null) : null;
  for (const p of peers.values()) {
    const main = coughing || talking ? null : mic;
    if (p.mainAudio && p.mainAudio.track !== main) p.mainAudio.replaceTrack(main).catch(e => { quiet('send my mic')(e); toast('⚠ Others may not hear you — if so, press Leave and rejoin', 6000); });
    const tb = p.talkTr && (talking === p.id ? talkTrack : null);
    if (p.talkTr && p.talkTr.sender.track !== tb) p.talkTr.sender.replaceTrack(tb || null).catch(quiet('talkback channel'));
  }
}

// ---------- cough button: hold to mute your live sound ----------
function setCough(on) {
  if (on === coughing || controlMode) return;
  coughing = on;
  updateAudioSenders();
  wsSend({ t: 'cough', on, at: serverNow() });
  $('#coughBtn').classList.toggle('held', on);
  const me = document.getElementById('tile-me'); if (me) me.classList.toggle('coughing', on);
}
const hold = (el, down, up) => {
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); down(); });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) el.addEventListener(ev, up);
};
hold($('#coughBtn'), () => setCough(true), () => setCough(false));

// ---------- talkback (host): hold to talk privately to one person ----------
let talkWanted = false;
async function startTalk() {
  talkWanted = true;
  if (talking || !isHost) return;
  const to = $('#talkTo').value; if (!to || !peers.has(to)) return toast('Nobody to talk to yet');
  if (!stream.getAudioTracks().length && !talkMic) {
    try { talkMic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { quiet('talkback mic')(e); return toast('⚠ Talkback needs your microphone — allow it in the address bar', 6000); }
    if (!talkWanted) return; // let go while the browser was asking for the mic
  }
  talking = to;
  updateAudioSenders();
  wsSend({ t: 'talk', to, on: true, at: serverNow() });
  $('#talkBtn').classList.add('held'); $('#talkBtn').firstChild.textContent = `🗣 Talking to ${peers.get(to).name}… `;
}
function stopTalk() {
  talkWanted = false;
  if (!talking) return;
  const to = talking; talking = null;
  updateAudioSenders();
  wsSend({ t: 'talk', to, on: false, at: serverNow() });
  $('#talkBtn').classList.remove('held'); $('#talkBtn').firstChild.textContent = '🗣 Hold to talk ';
}
hold($('#talkBtn'), startTalk, stopTalk);

// ---------- cue cards ----------
let cueTimer = null;
function showCue(text, from) {
  $('#cueMsg').textContent = text; $('#cueFrom').textContent = from ? `from ${from}` : '';
  $('#cue').classList.remove('hidden'); chime();
  clearTimeout(cueTimer); cueTimer = setTimeout(() => $('#cue').classList.add('hidden'), 10000);
}
$('#cue').onclick = () => { $('#cue').classList.add('hidden'); clearTimeout(cueTimer); };
function sendCue(text) {
  text = String(text || '').trim(); if (!text) return;
  const to = $('#cueTo').value;
  wsSend({ t: 'cue', to, text });
  toast(`Cue sent to ${to === 'all' ? 'everyone' : (peers.get(to) || {}).name || '?'}: ${text}`);
}
document.querySelectorAll('#cuePresets button').forEach(b => { b.onclick = () => sendCue(b.textContent); });
$('#cueForm').onsubmit = e => { e.preventDefault(); sendCue($('#cueText').value); $('#cueText').value = ''; };

// ---------- producer desk: faders (what I hear + the Producer mix), mute/solo for my ears ----------
const FADER_MIN = -40; // bottom of the fader = off
// per person: db (null = fader off) · mute/solo = your ears only · cut = Console MUTE (out of the mix) · pan · hpf · low/pres/high (dB) · comp
const deskOf = id => {
  if (!desk.has(id)) {
    const p = peers.get(id), saved = (p && chanMemory[p.name]) || {};
    desk.set(id, { db: saved.db === undefined ? 0 : saved.db, mute: false, solo: false, cut: !!saved.mute, pan: saved.pan || 0, hpf: !!saved.hpf, low: saved.low || 0, pres: saved.pres || 0, high: saved.high || 0, comp: !!saved.comp });
  }
  return desk.get(id);
};
const mixDb = d => (d.cut ? null : d.db); // what goes into the Producer mix
const dbText = db => (db === null ? 'off' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`);
function applyMonitor() {
  if (!isHost) return;
  if (controlMode) return applyConsole();
  const anySolo = [...desk.values()].some(d => d.solo);
  for (const p of peers.values()) {
    const v = p.tile && p.tile.querySelector('video'); if (!v) continue;
    const d = deskOf(p.id), g = d.db === null ? 0 : 10 ** (d.db / 20);
    v.volume = d.mute || (anySolo && !d.solo) ? 0 : Math.max(0, Math.min(1, monVol * g));
  }
}
const rideTimers = new Map();
function sendRide(id) { // at most ~12 a second per fader; the last position always goes
  if (rideTimers.has(id)) { rideTimers.get(id).again = true; return; }
  const go = () => wsSend({ t: 'ride', id, db: mixDb(deskOf(id)), at: serverNow() });
  go();
  const st = { again: false };
  st.timer = setTimeout(function next() { if (st.again) { st.again = false; go(); st.timer = setTimeout(next, 80); } else rideTimers.delete(id); }, 80);
  rideTimers.set(id, st);
}
function sendAllRides() { // a take starts from where the faders (and the Console) are now
  if (!isHost) return;
  for (const id of [myId, ...peers.keys()]) if (id && desk.has(id)) { wsSend({ t: 'ride', id, db: mixDb(desk.get(id)), at: serverNow() }); if (controlMode) sendChan(id); }
}
function renderDesk() {
  // who can be talked to / cued
  const people = [...peers.values()].filter(p => !p.control);
  const opts = people.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const keep = (sel, extra) => { const v = sel.value; sel.innerHTML = extra + opts; if ([...sel.options].some(o => o.value === v)) sel.value = v; };
  keep($('#cueTo'), '<option value="all">Everyone</option>'); keep($('#talkTo'), '');
  if (!isHost) return;
  if (controlMode) { // the full Console replaces the small faders in the control room
    if (!$('#deskStrips').querySelector('#deskToConsole')) $('#deskStrips').innerHTML = '<button class="primary" id="deskToConsole" style="margin-top:6px">🎛 Open the Console</button>';
    $('#deskToConsole').onclick = openConsole;
    renderConsole();
    return;
  }
  const list = [{ id: myId, name: $('#nameInput').value.trim() + ' (you)' }, ...people.map(p => ({ id: p.id, name: p.name }))];
  const box = $('#deskStrips');
  const have = [...box.children].map(c => c.dataset.id).join(','), want = list.map(x => x.id).join(',');
  if (have === want) return applyMonitor(); // don't rebuild while someone may be dragging a fader
  box.innerHTML = '';
  for (const x of list) {
    const d = deskOf(x.id), el = document.createElement('div');
    el.className = 'strip'; el.dataset.id = x.id;
    el.innerHTML = `<div class="sname"></div><div class="sdb"></div><input class="sfader" type="range" min="${FADER_MIN}" max="10" step="0.5"><div class="smeter"><span></span></div>
      <div class="sbtns">${x.id === myId ? '<span class="small-text muted">your own mic</span>' : '<button class="small ghost smute" title="Mute in your headphones only">🎧 M</button><button class="small ghost ssolo" title="Hear only this person (your headphones only)">S</button>'}<button class="small ghost scough hidden" disabled>🤧</button></div>`;
    el.querySelector('.sname').textContent = x.name;
    const f = el.querySelector('.sfader'), out = el.querySelector('.sdb');
    const show = () => { f.value = d.db === null ? FADER_MIN : d.db; out.textContent = dbText(d.db); };
    f.oninput = () => { const v = Number(f.value); d.db = v <= FADER_MIN ? null : v; out.textContent = dbText(d.db); applyMonitor(); if (recStartedAt) sendRide(x.id); };
    f.ondblclick = () => { d.db = 0; show(); applyMonitor(); if (recStartedAt) sendRide(x.id); };
    const mb = el.querySelector('.smute'), sb = el.querySelector('.ssolo');
    if (mb) mb.onclick = () => { d.mute = !d.mute; mb.classList.toggle('on', d.mute); applyMonitor(); };
    if (sb) sb.onclick = () => { d.solo = !d.solo; sb.classList.toggle('on', d.solo); applyMonitor(); };
    if (mb) mb.classList.toggle('on', d.mute); if (sb) sb.classList.toggle('on', d.solo);
    show(); box.appendChild(el);
  }
  applyMonitor();
}
$('#monVol').oninput = () => { monVol = Number($('#monVol').value) / 100; $('#conVol').value = $('#monVol').value; LS.set('ps_monvol', String($('#monVol').value)); applyMonitor(); };
if (LS.get('ps_monvol')) { $('#monVol').value = $('#conVol').value = LS.get('ps_monvol'); monVol = Number(LS.get('ps_monvol')) / 100; }
setInterval(() => { // show who is coughing on the desk
  for (const el of document.querySelectorAll('#deskStrips .strip')) { const p = peers.get(el.dataset.id), c = el.dataset.id === myId ? coughing : !!(p && p.coughing); el.querySelector('.scough').classList.toggle('hidden', !c); }
}, 300);

// ---------- the Console (control room): a full audio desk through Web Audio ----------
// Each person: low cut → low shelf → presence → high shelf → compressor → fader → pan → programme bus (metered, = the
// Producer mix) and → solo → your headphones. Fader + mute moves are baked exactly; EQ/compressor/pan as set at the end.
const EQ_BANDS = [['high', 'HIGH', 8000], ['pres', 'PRES', 2500], ['low', 'LOW', 120]];
function ensureMixBus() {
  if (mixBus || !ctx) return mixBus;
  const program = ctx.createGain(), monitor = ctx.createGain(), out = ctx.createGain();
  monitor.connect(out).connect(ctx.destination);
  let meter = null;
  try {
    meter = new AudioWorkletNode(ctx, 'studio-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: 'explicit', processorOptions: { meterOnly: true } });
    const silent = ctx.createGain(); silent.gain.value = 0;
    program.connect(meter).connect(silent).connect(ctx.destination);
    meter.port.onmessage = e => { if (e.data.type === 'loud') progLoud = e.data; else if (e.data.type === 'level') progPeak = Math.max(progPeak * 0.6, e.data.peak); };
  } catch (e) { quiet('master meter')(e); toast('⚠ The master meter could not start in this browser — mixing still works', 6000); }
  mixBus = { program, monitor, out, meter };
  return mixBus;
}
function buildChannel(p, st) {
  if (p.chan || !ensureMixBus()) return;
  try {
    const n = { src: ctx.createMediaStreamSource(st), hpf: ctx.createBiquadFilter(), low: ctx.createBiquadFilter(), pres: ctx.createBiquadFilter(), high: ctx.createBiquadFilter(),
      comp: ctx.createDynamicsCompressor(), fader: ctx.createGain(), pan: ctx.createStereoPanner(), solo: ctx.createGain() };
    n.hpf.type = 'highpass'; n.hpf.Q.value = 0.7071;
    n.low.type = 'lowshelf'; n.low.frequency.value = 120;
    n.pres.type = 'peaking'; n.pres.frequency.value = 2500; n.pres.Q.value = 1;
    n.high.type = 'highshelf'; n.high.frequency.value = 8000;
    n.comp.knee.value = 6; n.comp.attack.value = 0.01; n.comp.release.value = 0.2;
    n.src.connect(n.hpf).connect(n.low).connect(n.pres).connect(n.high).connect(n.comp).connect(n.fader).connect(n.pan);
    n.pan.connect(mixBus.program); n.pan.connect(n.solo).connect(mixBus.monitor);
    p.chan = n;
    applyConsole();
  } catch (e) { quiet('console channel for ' + p.name)(e); toast(`⚠ Couldn't add ${p.name} to the Console — you'll still record them`, 6000); }
}
function applyConsole() {
  if (!mixBus) return;
  const anySolo = [...peers.values()].some(p => !p.control && deskOf(p.id).solo);
  const set = (param, v) => param.setTargetAtTime(v, ctx.currentTime, 0.01); // smooth, no clicks
  for (const p of peers.values()) {
    if (!p.chan) continue;
    const d = deskOf(p.id), n = p.chan, db = mixDb(d);
    set(n.hpf.frequency, d.hpf ? 80 : 10);
    set(n.low.gain, d.low); set(n.pres.gain, d.pres); set(n.high.gain, d.high);
    set(n.comp.threshold, d.comp ? -24 : 0); set(n.comp.ratio, d.comp ? 3 : 1);
    set(n.fader.gain, db === null ? 0 : 10 ** (db / 20));
    set(n.pan.pan, d.pan);
    set(n.solo.gain, anySolo && !d.solo ? 0 : 1);
  }
  set(mixBus.out.gain, monVol * 2); // 50 % = as recorded
}
const chanTimers = new Map();
function sendChan(id) { // remembered for next time + baked into the Producer mix (at most ~4 a second)
  clearTimeout(chanTimers.get(id));
  chanTimers.set(id, setTimeout(() => {
    const d = deskOf(id), st = { db: d.db, mute: d.cut, pan: d.pan, hpf: d.hpf, low: d.low, pres: d.pres, high: d.high, comp: d.comp }, p = peers.get(id);
    if (p) chanMemory[p.name] = st; // so if they drop out and rejoin, their channel comes back as you left it
    wsSend({ t: 'chan', id, s: st });
  }, 250));
}
const sideSecs = () => [...document.querySelectorAll('#tab-desk .desk-sec, #conSide .desk-sec')].filter(e => !e.querySelector('#deskStrips'));
function openConsole() {
  ensureMixBus();
  if (ctx) ctx.resume().catch(quiet('resume console audio'));
  for (const sec of sideSecs()) $('#conSide').appendChild(sec); // the same quick tags / cue cards / talkback, moved in
  $('#console').classList.remove('hidden'); document.body.classList.add('console-open');
  renderConsole(true);
}
function closeConsole() {
  const faders = $('#deskStrips').closest('.desk-sec');
  for (const sec of sideSecs()) $('#tab-desk').insertBefore(sec, faders);
  $('#console').classList.add('hidden'); document.body.classList.remove('console-open');
}
$('#consoleBtn').onclick = openConsole;
$('#conClose').onclick = closeConsole;
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#console').classList.contains('hidden') && $('#bigClock').classList.contains('hidden')) closeConsole(); });
$('#conRec').onclick = () => $('#recBtn').click();
$('#conTone').onclick = () => $('#toneBtn').click();
$('#conNext').onclick = () => $('#rdNext').click();
$('#conClock').innerHTML = clockMarkup();
$('#conVol').oninput = () => { $('#monVol').value = $('#conVol').value; $('#monVol').oninput(); };
$('#pmReset').onclick = () => { if (mixBus && mixBus.meter) mixBus.meter.port.postMessage({ cmd: 'resetLoud' }); };
$('#pmTargetSel').onchange = () => LS.set('ps_target', $('#pmTargetSel').value);
if (LS.get('ps_target')) $('#pmTargetSel').value = LS.get('ps_target');
function renderConsole(force) {
  if (!controlMode || !isHost) return;
  const people = [...peers.values()].filter(p => !p.control);
  const box = $('#conStrips');
  if (!force && [...box.children].map(c => c.dataset.id + c.dataset.green).join(',') === people.map(p => p.id + !!p.green).join(',')) return applyConsole();
  box.innerHTML = ''; $('#conThumbs').innerHTML = '';
  if (!people.length) box.innerHTML = '<p class="muted" style="padding:20px">Nobody here yet — their channel appears as soon as they join.</p>';
  for (const p of people) {
    const d = deskOf(p.id), el = document.createElement('div');
    el.className = 'cstrip'; el.dataset.id = p.id; el.dataset.green = String(!!p.green);
    el.innerHTML = `<div class="cs-name"><span></span><span class="cs-cough hidden" title="Holding their cough button">🤧</span></div>
      <div class="cs-loud" title="Their short-term loudness (LUFS)">–</div>
      <button class="small cs-hpf" title="Low cut: removes rumble below 80 Hz">LOW CUT</button>
      ${EQ_BANDS.map(([k, label, hz]) => `<div class="cs-eq"><span class="cs-lbl" title="${hz >= 1000 ? hz / 1000 + ' kHz' : hz + ' Hz'}">${label}</span><input type="range" class="cs-${k}" min="-12" max="12" step="0.5" title="Double-click for 0"><span class="cs-val" data-v="${k}"></span></div>`).join('')}
      <div class="cs-comprow"><button class="small cs-comp" title="Compressor: evens out loud and quiet moments">COMP</button><div class="cs-gr" title="Gain reduction"><span></span></div></div>
      <div class="cs-eq"><span class="cs-lbl">PAN</span><input type="range" class="cs-pan" min="-1" max="1" step="0.05" title="Double-click for centre"><span class="cs-val" data-v="pan"></span></div>
      <div class="cs-faderwrap"><div class="cs-meter" title="Their live level (peak)"><span></span></div><input type="range" class="cs-fader" min="${FADER_MIN}" max="10" step="0.5" title="Double-click for 0 dB"></div>
      <div class="cs-db"></div>
      <div class="cs-btns"><button class="small cs-mute" title="Take them out of the mix (baked into the Producer mix)">MUTE</button><button class="small cs-solo" title="Hear only them — your headphones only">SOLO</button></div>
      <div class="cs-btns"><button class="small ghost cs-talk" title="Hold to talk to them privately">TALK</button><button class="small ghost cs-cue" title="Send them a cue card">CUE</button></div>
      <div class="cs-help"><button class="small ghost cs-helpbtn" style="width:100%" title="Switch their microphone, headphones mode, mute">⚙ HELP</button></div>
      ${p.green ? '<div class="cs-green">🟢 GREEN ROOM<button class="small primary cs-onair">Bring on air</button></div>' : ''}`;
    el.querySelector('.cs-name span').textContent = p.name;
    const q = c => el.querySelector(c);
    const show = () => {
      q('.cs-fader').value = d.db === null ? FADER_MIN : d.db; q('.cs-db').textContent = d.cut ? 'MUTED' : dbText(d.db);
      for (const [k] of EQ_BANDS) { q('.cs-' + k).value = d[k]; q(`[data-v="${k}"]`).textContent = (d[k] > 0 ? '+' : '') + d[k]; }
      q('.cs-pan').value = d.pan; q('[data-v="pan"]').textContent = Math.abs(d.pan) < 0.03 ? 'C' : (d.pan < 0 ? 'L' : 'R') + Math.round(Math.abs(d.pan) * 100);
      q('.cs-hpf').classList.toggle('on', d.hpf); q('.cs-comp').classList.toggle('on', d.comp);
      q('.cs-mute').classList.toggle('on', d.cut); q('.cs-solo').classList.toggle('on', d.solo); el.classList.toggle('cut', d.cut);
    };
    const changed = (ride) => { show(); applyConsole(); sendChan(p.id); if (ride && recStartedAt) sendRide(p.id); };
    q('.cs-fader').oninput = () => { const v = Number(q('.cs-fader').value); d.db = v <= FADER_MIN ? null : v; changed(true); };
    q('.cs-fader').ondblclick = () => { d.db = 0; changed(true); };
    for (const [k] of EQ_BANDS) { q('.cs-' + k).oninput = () => { d[k] = Number(q('.cs-' + k).value); changed(); }; q('.cs-' + k).ondblclick = () => { d[k] = 0; changed(); }; }
    q('.cs-pan').oninput = () => { d.pan = Number(q('.cs-pan').value); changed(); };
    q('.cs-pan').ondblclick = () => { d.pan = 0; changed(); };
    q('.cs-hpf').onclick = () => { d.hpf = !d.hpf; changed(); };
    q('.cs-comp').onclick = () => { d.comp = !d.comp; changed(); };
    q('.cs-mute').onclick = () => { d.cut = !d.cut; changed(true); };
    q('.cs-solo').onclick = () => { d.solo = !d.solo; show(); applyConsole(); };
    hold(q('.cs-talk'), () => { $('#talkTo').value = p.id; startTalk(); }, stopTalk);
    q('.cs-helpbtn').onclick = () => helpBox(p, q('.cs-help'));
    if (q('.cs-onair')) q('.cs-onair').onclick = () => wsSend({ t: 'onair', id: p.id });
    q('.cs-cue').onclick = () => { $('#cueTo').value = p.id; $('#cueText').focus(); toast(`Cue card for ${p.name}: tap one on the right, or type your own`); };
    el.addEventListener('pointerdown', () => selectStrip(p.id));
    q('.cs-fader').addEventListener('wheel', e => { e.preventDefault(); nudge(p.id, e.deltaY < 0 ? 0.5 : -0.5); }, { passive: false });
    show(); el._show = show; box.appendChild(el);
    // small picture so you can see who's talking
    const v = document.createElement('video'); v.muted = true; v.autoplay = true; v.playsInline = true;
    const src = p.tile && p.tile.querySelector('video'); if (src && src.srcObject) v.srcObject = src.srcObject;
    const th = document.createElement('div'); th.className = 'con-thumb'; th.dataset.id = p.id; th.appendChild(v);
    const nm = document.createElement('span'); nm.textContent = p.name; th.appendChild(nm);
    $('#conThumbs').appendChild(th); v.play().catch(quiet('console thumbnail'));
  }
  if (!people.some(p => p.id === selected)) selected = people[0] ? people[0].id : null;
  selectStrip(selected);
  applyConsole();
}
// ---------- soundboard (control room): pads → board bus → everyone (call), your headphones, the master meter ----------
const dbGain = db => 10 ** (db / 20);
function ensureBoard() {
  if (board || !ensureMixBus()) return board;
  const bus = ctx.createGain(), beds = ctx.createGain(), dest = ctx.createMediaStreamDestination();
  beds.connect(bus); bus.connect(dest); bus.connect(mixBus.program); bus.connect(mixBus.monitor);
  bus.gain.value = dbGain(Number($('#boardVol').value));
  board = { bus, beds, dest };
  return board;
}
async function padBuffer(pad) {
  const key = pad.id + '/' + pad.dur;
  if (!padBuffers.has(key)) padBuffers.set(key, (async () => {
    const r = await fetch(`/api/rooms/${roomId}/sounds/${pad.id}?k=${encodeURIComponent(hostKey)}`, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`couldn't load "${pad.name}" (${r.status})`);
    return ctx.decodeAudioData(await r.arrayBuffer());
  })().catch(e => { padBuffers.delete(key); throw e; }));
  return padBuffers.get(key);
}
function sendBoard(ev, x) { wsSend({ t: 'board', ev, inst: x.inst, sid: x.pad.id, vol: x.pad.vol + Number($('#boardVol').value), duck: $('#duckOn').checked, at: serverNow() }); }
async function togglePad(pad, el) {
  if (!ensureBoard()) return toast('The soundboard needs the Console\'s audio — open the Console first');
  const cur = [...playingPads.values()].find(x => x.pad.id === pad.id);
  if (cur && pad.mode !== 'effect') return stopPad(cur.inst);       // jingles and beds: press again to stop
  if (el) el.classList.add('loading');
  let buf;
  try { buf = await padBuffer(pad); } catch (e) { quiet('load pad')(e); return toast('⚠ ' + e.message, 5000); } finally { if (el) el.classList.remove('loading'); }
  if (ctx.state !== 'running') await ctx.resume().catch(quiet('resume audio for soundboard'));
  const src = ctx.createBufferSource(), gain = ctx.createGain();
  src.buffer = buf; src.loop = pad.mode === 'bed';
  gain.gain.value = dbGain(pad.vol);
  src.connect(gain).connect(pad.mode === 'bed' && $('#duckOn').checked ? board.beds : board.bus);
  const x = { inst: Math.random().toString(36).slice(2, 10), pad, src, gain, started: ctx.currentTime, dur: buf.duration };
  playingPads.set(x.inst, x);
  src.onended = () => { if (playingPads.delete(x.inst)) { sendBoard('stop', x); renderPadState(); } };
  src.start();
  sendBoard('start', x);
  renderPadState();
}
function stopPad(inst) {
  const x = playingPads.get(inst); if (!x) return;
  playingPads.delete(inst);
  x.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08); // short fade, no click
  try { x.src.stop(ctx.currentTime + 0.35); } catch (e) { quiet('stop pad')(e); }
  sendBoard('stop', x);
  renderPadState();
}
function renderPads() {
  const box = $('#pads'); if (!box) return;
  box.innerHTML = sounds.length ? '' : '<p class="small-text muted" style="grid-column:1/-1;margin:4px 0">No sounds yet — press ✎ Edit pads to add jingles, ads and music beds.</p>';
  sounds.forEach((pad, i) => {
    const b = document.createElement('button');
    b.className = 'pad'; b.dataset.id = pad.id; b.style.setProperty('--c', pad.color);
    b.innerHTML = `<span class="pk">${i < 12 ? 'F' + (i + 1) : ''}</span><span class="pn"></span><span class="pm">${pad.mode === 'bed' ? '🎵 bed' : pad.mode === 'effect' ? '💥 effect' : '🔔 jingle'} · ${mmss(pad.dur * 1000)}</span><span class="pp"></span>`;
    b.querySelector('.pn').textContent = pad.name;
    b.onclick = () => togglePad(pad, b);
    box.appendChild(b);
  });
  renderPadEditor(); renderPadState();
}
function renderPadState() {
  for (const b of document.querySelectorAll('#pads .pad')) b.classList.toggle('playing', [...playingPads.values()].some(x => x.pad.id === b.dataset.id));
}
function renderPadEditor() {
  const box = $('#padRows'); if (!box || box.contains(document.activeElement)) return;
  box.innerHTML = '';
  for (const pad of sounds) {
    const row = document.createElement('div'); row.className = 'padrow';
    row.innerHTML = `<input type="color" title="Colour"><input type="text" maxlength="40" title="Name"><select title="How it plays"><option value="jingle">Jingle</option><option value="bed">Bed</option><option value="effect">Effect</option></select><input type="range" min="-30" max="6" step="0.5" title="Volume"><button class="small ghost" title="Delete">✕</button>`;
    const [col, name, mode, vol, del] = row.children;
    col.value = pad.color; name.value = pad.name; mode.value = pad.mode; vol.value = pad.vol; vol.title = `Volume ${pad.vol} dB`;
    const save = async () => {
      const r = await api(`/api/rooms/${roomId}/sounds/${pad.id}?k=${encodeURIComponent(hostKey)}`, { json: { name: name.value, mode: mode.value, vol: Number(vol.value), color: col.value } });
      if (!r.ok) toast('Couldn\'t save: ' + r.error);
    };
    for (const el of [col, name, mode, vol]) el.onchange = save;
    del.onclick = async () => { const r = await api(`/api/rooms/${roomId}/sounds/${pad.id}?k=${encodeURIComponent(hostKey)}`, { method: 'DELETE' }); if (!r.ok) toast('Couldn\'t delete: ' + r.error); };
    box.appendChild(row);
  }
}
$('#padEdit').onclick = () => { $('#padEditor').classList.toggle('hidden'); renderPadEditor(); };
$('#padFiles').onchange = async e => {
  for (const f of e.target.files) {
    toast(`Adding "${f.name}"…`);
    try {
      const r = await fetch(`/api/rooms/${roomId}/sounds?k=${encodeURIComponent(hostKey)}`, { method: 'POST', body: f, headers: { 'X-Filename': encodeURIComponent(f.name) }, signal: AbortSignal.timeout(5 * 60000) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status);
    } catch (er) { quiet('add pad')(er); toast(`⚠ Couldn't add "${f.name}": ${er.message}`, 6000); }
  }
  e.target.value = '';
};
$('#padStopAll').onclick = () => { for (const inst of [...playingPads.keys()]) stopPad(inst); };
$('#boardVol').oninput = () => { $('#boardVolTxt').textContent = `${$('#boardVol').value} dB`; if (board) board.bus.gain.setTargetAtTime(dbGain(Number($('#boardVol').value)), ctx.currentTime, 0.02); };
setInterval(() => { // progress bars + music beds dipping under the voices (the Soundboard track does the same afterwards)
  if (!board) return;
  for (const b of document.querySelectorAll('#pads .pad')) {
    const x = [...playingPads.values()].find(y => y.pad.id === b.dataset.id);
    b.querySelector('.pp').style.width = x ? `${x.pad.mode === 'bed' ? 100 : Math.min(100, ((ctx.currentTime - x.started) / x.dur) * 100)}%` : '0';
  }
  const talking = [...peers.values()].some(p => !p.control && (p.level || 0) > 0.04);
  board.beds.gain.setTargetAtTime($('#duckOn').checked && talking ? 0.25 : 1, ctx.currentTime, talking ? 0.02 : 0.4);
}, 50);

// ---------- Console from the keyboard (no hardware needed) ----------
// ← → pick a channel · ↑ ↓ fader 1 dB (Shift: 0.25 dB) · 0 = 0 dB · X mute · S solo · Q low cut · W compressor · T hold to talk
let selected = null;
function selectStrip(id) {
  selected = id;
  for (const el of document.querySelectorAll('#conStrips .cstrip')) el.classList.toggle('sel', el.dataset.id === id);
}
function stripChanged(id, ride) {
  const el = document.querySelector(`#conStrips .cstrip[data-id="${id}"]`); if (el && el._show) el._show();
  applyConsole(); sendChan(id); if (ride && recStartedAt) sendRide(id);
}
function nudge(id, step) {
  const d = deskOf(id), from = d.db === null ? FADER_MIN : d.db;
  const v = Math.max(FADER_MIN, Math.min(10, Math.round((from + step) * 4) / 4));
  d.db = v <= FADER_MIN ? null : v;
  stripChanged(id, true);
}
addEventListener('keydown', e => {
  if ($('#console').classList.contains('hidden') || typing(e)) return;
  const k = e.key, handled = () => e.preventDefault();
  const fk = /^F([1-9]|1[0-2])$/.exec(k);
  if (fk && !e.repeat) { handled(); const pad = sounds[Number(fk[1]) - 1]; if (pad) togglePad(pad, document.querySelector(`#pads .pad[data-id="${pad.id}"]`)); return; }
  if (!selected) return;
  const ids = [...document.querySelectorAll('#conStrips .cstrip')].map(el => el.dataset.id), i = ids.indexOf(selected), d = deskOf(selected);
  if (k === 'ArrowRight' || k === 'ArrowLeft') { handled(); selectStrip(ids[(i + (k === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length]); }
  else if (k === 'ArrowUp' || k === 'ArrowDown') { handled(); nudge(selected, (k === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 0.25 : 1)); }
  else if (k === '0') { handled(); d.db = 0; stripChanged(selected, true); }
  else if (k === 'x' || k === 'X') { handled(); d.cut = !d.cut; stripChanged(selected, true); }
  else if (k === 's' || k === 'S') { handled(); d.solo = !d.solo; stripChanged(selected); }
  else if (k === 'q' || k === 'Q') { handled(); d.hpf = !d.hpf; stripChanged(selected); }
  else if (k === 'w' || k === 'W') { handled(); d.comp = !d.comp; stripChanged(selected); }
  else if ((k === 't' || k === 'T') && !e.repeat) { handled(); $('#talkTo').value = selected; startTalk(); }
});
// Console meters: input peak, gain reduction, their loudness, master loudness — redrawn ~20 times a second
const lufsText = v => (Number.isFinite(v) ? v.toFixed(1) : '–');
setInterval(() => {
  if ($('#console').classList.contains('hidden')) return;
  renderClock($('#conClock'));
  $('#conRec').textContent = recStartedAt ? '■ Stop recording' : '● Record';
  for (const el of document.querySelectorAll('#conStrips .cstrip')) {
    const p = peers.get(el.dataset.id); if (!p) continue;
    const pk = p.level || 0, db = 20 * Math.log10(Math.max(pk, 1e-6));
    el.querySelector('.cs-meter span').style.height = ((1 - Math.max(0, Math.min(1, (db + 60) / 60))) * 100).toFixed(1) + '%';
    const gr = p.chan ? -p.chan.comp.reduction : 0; // dB of gain reduction (positive)
    el.querySelector('.cs-gr span').style.width = Math.min(100, gr / 20 * 100).toFixed(0) + '%';
    el.querySelector('.cs-loud').textContent = p.loud && Number.isFinite(p.loud.S) ? `${p.loud.S.toFixed(1)} LUFS` : '–';
    el.querySelector('.cs-cough').classList.toggle('hidden', !p.coughing);
    document.querySelector(`.con-thumb[data-id="${p.id}"]`)?.classList.toggle('speaking', pk > 0.04);
  }
  const L = progLoud || {}, target = Number($('#pmTargetSel').value);
  const pos = v => Math.max(0, Math.min(1, (v + 40) / 40)) * 100;
  $('#pmFill').style.height = (Number.isFinite(L.S) ? pos(L.S) : 0).toFixed(1) + '%';
  $('#pmFill').className = 'pm-fill ' + (!Number.isFinite(L.S) ? '' : L.S > target + 3 ? 'hot' : L.S < target - 6 ? 'low' : 'ok');
  $('#pmTarget').style.bottom = pos(target) + '%';
  $('#pmM').textContent = lufsText(L.M); $('#pmS').textContent = lufsText(L.S); $('#pmI').textContent = lufsText(L.I);
  $('#pmTP').textContent = Number.isFinite(L.TPmax) ? L.TPmax.toFixed(1) + ' dBTP' : '–';
  $('#pmTP').classList.toggle('rec-text', Number.isFinite(L.TPmax) && L.TPmax > -1);
}, 50);

// ---------- Rolling Desk (the desktop app): recordings saved on this computer too ----------
if (window.rollingDesk) {
  $('#controlBtn').classList.add('primary'); // producers usually run the show from the control room
  const icon = s => (s.lowDisk ? '⚠' : s.error ? '⚠' : s.busy ? '💾' : '✅');
  window.rollingDesk.onStatus(s => {
    for (const b of document.querySelectorAll('.deskSave')) {
      b.classList.remove('hidden');
      b.textContent = `${icon(s)} ${s.lowDisk ? 'Disk nearly full! ' : ''}${s.error ? 'Saving problem — ' + s.error : s.detail}`;
      b.classList.toggle('warnc', !!(s.lowDisk || s.error));
    }
  });
  document.addEventListener('click', e => { if (e.target.closest('.deskSave')) window.rollingDesk.openFolder(); });
}

// ---------- rundown + show clock ----------
const mmss = ms => { const s = Math.round(Math.abs(ms) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function renderRundown() {
  const box = $('#rundownList');
  if (box && !box.contains(document.activeElement)) {
    box.innerHTML = '';
    rundown.forEach((r, i) => {
      const el = document.createElement('div'); el.className = 'rdrow' + (segment && segment.idx === i ? ' current' : '');
      el.innerHTML = `<button class="small ghost" title="Start this segment">▶</button><input type="text" maxlength="60" placeholder="Segment name"><input type="number" min="0" max="600" step="0.5" title="Minutes"><button class="small ghost" title="Remove">✕</button>`;
      const [go, name, mins, del] = el.children;
      name.value = r.name; mins.value = r.mins || '';
      name.oninput = () => { r.name = name.value; }; mins.oninput = () => { r.mins = Number(mins.value) || 0; showTotal(); };
      go.onclick = () => startSegment(i);
      del.onclick = () => { rundown.splice(i, 1); renderRundown(); };
      box.appendChild(el);
    });
    if (!rundown.length) box.innerHTML = '<p class="small-text muted">No segments yet — add your running order (e.g. Intro 2, Interview 25, Listener mail 8, Outro 2).</p>';
  }
  showTotal();
}
function showTotal() { const total = rundown.reduce((a, r) => a + (Number(r.mins) || 0), 0); $('#rdTotal').textContent = total ? `${Math.floor(total / 60) ? Math.floor(total / 60) + ' h ' : ''}${Math.round(total % 60)} min planned` : ''; }
function startSegment(i) { if (!rundown[i]) return toast('Save the rundown first'); wsSend({ t: 'segment', idx: i, at: serverNow() }); }
$('#rdAdd').onclick = () => { rundown.push({ name: '', mins: 5 }); renderRundown(); const ins = $('#rundownList').querySelectorAll('input[type=text]'); if (ins.length) ins[ins.length - 1].focus(); };
$('#rdSave').onclick = async () => {
  const res = await api(`/api/rooms/${roomId}/settings?k=${encodeURIComponent(hostKey)}`, { json: { rundown } });
  if (!res.ok) return toast('Couldn\'t save: ' + res.error);
  rundown = res.data.rundown || []; renderRundown(); toast('Rundown saved ✓');
};
$('#rdNext').onclick = () => { const next = segment ? segment.idx + 1 : 0; if (next >= rundown.length) return toast(rundown.length ? 'That was the last segment' : 'Add and save some segments first'); startSegment(next); };
$('#rdStop').onclick = () => wsSend({ t: 'segment', idx: -1 });

// ---------- timecode clock + tally (everyone): record TC, segment TC, time of day ----------
// Record TC starts at 00:00:00:00 when recording starts — the same timeline as every file in the take.
const tc = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000), f = Math.floor((ms % 1000) / (1000 / fps)); return [s / 3600, (s % 3600) / 60, s % 60, f].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };
function clockMarkup() {
  return `<div class="tally" data-tc="tally"><span class="lamp"></span><span data-tc="tallytext">STANDBY</span></div>
    <div class="tcblock"><div class="tclabel">REC</div><div class="tc" data-tc="rec">00:00:00:00</div></div>
    <div class="tcblock" data-tc="segblock"><div class="tclabel" data-tc="segname">SEGMENT</div><div class="tc" data-tc="seg">--:--:--:--</div><div class="tcleft" data-tc="left"></div></div>
    <div class="tcblock tod"><div class="tclabel">TIME OF DAY</div><div class="tc" data-tc="tod">--:--:--:--</div></div>`;
}
$('#tcBar').innerHTML = clockMarkup() + '<div class="tcbtns"><button class="small ghost deskSave hidden" title="Rolling Desk: recordings saved on this computer — click to open the folder"></button><button class="small ghost" id="clockFull" title="Full-screen clock">⛶ Clock</button><button class="small ghost" id="clockPop" title="Open the clock in its own window — drag it to a second screen">↗ Pop out</button></div>';
$('#bigClock').innerHTML = clockMarkup();
let pop = null;
function renderClock(root) {
  const q = k => root.querySelector(`[data-tc="${k}"]`);
  const state = roomTone ? 'tone' : recStartedAt ? 'rec' : 'stby';
  q('tally').className = 'tally ' + state;
  q('tallytext').textContent = state === 'rec' ? 'REC' : state === 'tone' ? 'ROOM TONE' : 'STANDBY';
  q('rec').textContent = recStartedAt ? tc(serverNow() - recStartedAt) : '00:00:00:00';
  q('rec').classList.toggle('dim', !recStartedAt);
  const sb = q('segblock');
  if (segment) {
    const used = serverNow() - segment.at, left = segment.mins * 60000 - used;
    q('segname').textContent = segment.name.toUpperCase();
    q('seg').textContent = tc(used);
    q('left').textContent = !segment.mins ? '' : left >= 0 ? `${mmss(left)} left` : `+${mmss(left)} over`;
    sb.classList.toggle('over', !!segment.mins && left < 0); sb.classList.toggle('soon', !!segment.mins && left >= 0 && left < 60000);
  } else { q('segname').textContent = 'SEGMENT'; q('seg').textContent = '--:--:--:--'; q('left').textContent = ''; sb.classList.remove('over', 'soon'); }
  const d = new Date(serverNow());
  q('tod').textContent = tc((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) * 1000 + d.getMilliseconds());
}
function renderClocks() {
  if (!joined) return;
  renderClock($('#tcBar'));
  if (!$('#bigClock').classList.contains('hidden')) renderClock($('#bigClock'));
  if (pop && !pop.closed) { try { renderClock(pop.document.body); } catch (e) { quiet('clock window')(e); pop = null; } }
  const state = roomTone ? 'tone' : recStartedAt ? 'rec' : '';
  document.body.classList.toggle('tally-rec', state === 'rec'); document.body.classList.toggle('tally-tone', state === 'tone');
}
setInterval(renderClocks, 20);
window.__studio.recClock = () => (recStartedAt ? serverNow() - recStartedAt : null); // for troubleshooting: the synced record clock in ms
function closeBigClock() { $('#bigClock').classList.add('hidden'); if (document.fullscreenElement) document.exitFullscreen().catch(quiet('leave full screen')); }
$('#clockFull').onclick = () => { $('#bigClock').classList.remove('hidden'); renderClock($('#bigClock')); $('#bigClock').requestFullscreen().catch(quiet('full-screen clock')); };
$('#bigClock').onclick = closeBigClock;
addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#bigClock').classList.contains('hidden')) closeBigClock(); });
document.addEventListener('fullscreenchange', () => {
  const hidden = $('#bigClock').classList.contains('hidden');
  if (!document.fullscreenElement && !hidden) $('#bigClock').classList.add('hidden');            // left full screen with the browser's own Esc
  if (document.fullscreenElement === $('#bigClock') && hidden) document.exitFullscreen().catch(quiet('leave full screen')); // closed while full screen was still opening
});
$('#clockPop').onclick = () => {
  pop = window.open('', 'rolling-clock', 'width=1000,height=380');
  if (!pop) return toast('Your browser blocked the clock window — allow pop-ups for this site and try again', 6000);
  const css = [...document.styleSheets].map(sh => { try { return [...sh.cssRules].map(r => r.cssText).join('\n'); } catch (e) { quiet('copy styles to clock window')(e); return ''; } }).join('\n');
  pop.document.title = `${document.title} — clock`;
  pop.document.head.innerHTML = `<meta name="viewport" content="width=device-width"><style>${css}</style>`;
  pop.document.body.className = 'clockwin';
  pop.document.body.innerHTML = `<div class="bigclock">${clockMarkup()}</div><p class="clockhint">Double-click for full screen · drag this window to another screen</p>`;
  pop.document.body.ondblclick = () => pop.document.documentElement.requestFullscreen().catch(quiet('clock window full screen'));
  renderClock(pop.document.body); pop.focus();
};
$('#copyGuestBtn').onclick = () => {
  const link = location.origin + '/r/' + roomId;
  navigator.clipboard.writeText(link).then(() => toast('Guest link copied')).catch(() => ask('Guest link', `<input type="text" value="${link}" readonly onclick="this.select()">`, 'Done', null));
};
function updateRecUI() {
  $('#recBtn').textContent = recStartedAt ? '■ Stop recording' : '● Start recording';
  $('#recBtn').classList.toggle('danger', !!recStartedAt); $('#recBtn').classList.toggle('primary', !recStartedAt);
  $('#toneBtn').disabled = $('#markerBtn').disabled = !recStartedAt;
}


// drawer: chat + health
let drawerTab = null, unread = 0;
function openDrawer(tab) {
  if (drawerTab === tab) return closeDrawer();
  drawerTab = tab;
  $('#drawer').classList.remove('hidden');
  document.querySelectorAll('.drawer-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  for (const k of ['chat', 'health', 'desk', 'rundown']) $('#tab-' + k).classList.toggle('hidden', tab !== k);
  if (tab === 'desk') renderDesk();
  if (tab === 'rundown') renderRundown();
  if (tab === 'chat') { unread = 0; $('#chatBadge').classList.add('hidden'); setTimeout(() => $('#chatInput').focus(), 50); }
  if (tab === 'health') renderHealth();
  layout();
}
function closeDrawer() { drawerTab = null; $('#drawer').classList.add('hidden'); layout(); }
$('#chatBtn').onclick = () => openDrawer('chat');
$('#healthBtn').onclick = () => openDrawer('health');
$('#deskBtn').onclick = () => openDrawer('desk');
$('#drawerClose').onclick = closeDrawer;
document.querySelectorAll('.drawer-tabs .tab').forEach(b => { b.onclick = () => openDrawer(b.dataset.tab); });
function addChat(m, quiet) {
  const el = document.createElement('div');
  el.className = 'chatmsg' + (m.pid === myId ? ' mine' : '');
  el.innerHTML = `<div class="who">${esc(m.from)} <span class="muted">${new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span></div><div>${esc(m.text)}</div>`;
  $('#chatLog').appendChild(el); $('#chatLog').scrollTop = 1e9;
  if (!quiet && drawerTab !== 'chat' && m.pid !== myId) { unread++; $('#chatBadge').textContent = unread; $('#chatBadge').classList.remove('hidden'); toast(`💬 ${m.from}: ${m.text.slice(0, 60)}`); }
}
$('#chatForm').onsubmit = e => { e.preventDefault(); const t = $('#chatInput').value.trim(); if (!t) return; wsSend({ t: 'chat', text: t }); $('#chatInput').value = ''; };

// ---------- green room (hosts see who's waiting there, and bring them on air) ----------
function renderGreen(p) {
  if (!p.tile) return;
  p.tile.classList.toggle('green', !!p.green);
  let tag = p.tile.querySelector('.greentag');
  if (p.green && isHost && !tag) {
    tag = document.createElement('div'); tag.className = 'greentag';
    tag.innerHTML = '🟢 Green room <button class="primary">Bring on air</button>';
    tag.querySelector('button').onclick = () => wsSend({ t: 'onair', id: p.id });
    p.tile.appendChild(tag);
  }
  if (!p.green && tag) tag.remove();
}

// ---------- remote help (producer → guest): switch their mic, headphones mode, mute ----------
async function sendDevices() {
  if (!stream || !joined || isHost) return;
  try {
    const devs = await navigator.mediaDevices.enumerateDevices(), at = stream.getAudioTracks()[0];
    wsSend({ t: 'devices', mics: devs.filter(d => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })),
      mic: at ? at.getSettings().deviceId : '', headphones: $('#headphones').checked, micOn });
  } catch (e) { quiet('list devices for the producer')(e); }
}
async function switchMic(deviceId) { // swap the microphone without leaving the call (the recording carries on)
  if (deviceId) { if (![...$('#micSelect').options].some(o => o.value === deviceId)) await fillDevices(); $('#micSelect').value = deviceId; }
  const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(true) });
  const nt = s.getAudioTracks()[0];
  for (const old of stream.getAudioTracks()) { old.onended = null; stream.removeTrack(old); old.stop(); }
  nt.enabled = micOn; stream.addTrack(nt);
  connectMic(); updateAudioSenders(); sendDevices();
}
async function onControl(m) {
  try {
    if (m.action === 'mic') { await switchMic(m.value); toast(`🎙 ${m.from} switched your microphone to ${$('#micSelect').selectedOptions[0] ? $('#micSelect').selectedOptions[0].textContent : 'another one'}`, 6000); }
    else if (m.action === 'headphones') { $('#headphones').checked = !!m.value; LS.set('ps_headphones', m.value ? '1' : '0'); await switchMic(null); toast(m.value ? `🎧 ${m.from} set you to headphones mode (echo cancelling off — please wear headphones)` : `🔈 ${m.from} turned echo cancelling back on`, 7000); }
    else if (m.action === 'mute') { if (micOn) toggleMic(); toast(`🔇 ${m.from} muted your microphone — press the mic button to unmute`, 6000); }
    else if (m.action === 'unmute') toast(`🎙 ${m.from} asks you to unmute — press the mic button when you're ready`, 8000); // only you can turn your mic on
    sendDevices();
  } catch (e) { quiet('producer control')(e); toast(`⚠ Couldn't do that: ${e.message}`, 6000); }
}
function helpBox(p, anchor) { // the producer's little panel for one guest
  document.querySelectorAll('.helpbox').forEach(b => b.remove());
  const d = p.devices || {}, box = document.createElement('div'); box.className = 'helpbox';
  box.innerHTML = `<b>Help ${esc(p.name)}</b><div class="small-text muted" style="margin-top:6px">Microphone</div><select></select>
    <label class="check small-text"><input type="checkbox"> <span>Headphones mode (echo cancelling off)</span></label>
    <div class="row" style="margin-top:8px"><button class="small ghost">🔇 Mute them</button><button class="small ghost">Ask to unmute</button><button class="small ghost">✕</button></div>`;
  const sel = box.querySelector('select'), hp = box.querySelector('input'), [mute, unmute, close] = box.querySelectorAll('button');
  for (const m of d.mics || []) sel.add(new Option(m.label, m.id, false, m.id === d.mic));
  if (!(d.mics || []).length) sel.add(new Option('(their browser hasn\'t shared its list yet)', ''));
  hp.checked = !!d.headphones;
  sel.onchange = () => { if (sel.value) { wsSend({ t: 'control', to: p.id, action: 'mic', value: sel.value }); toast(`Switching ${p.name}'s microphone…`); } };
  hp.onchange = () => wsSend({ t: 'control', to: p.id, action: 'headphones', value: hp.checked });
  mute.onclick = () => wsSend({ t: 'control', to: p.id, action: 'mute' });
  unmute.onclick = () => wsSend({ t: 'control', to: p.id, action: 'unmute' });
  close.onclick = () => box.remove();
  anchor.appendChild(box);
}

// waiting room knocks (host)
function showKnock(k) {
  if (document.getElementById('knock-' + k.id)) return;
  const el = document.createElement('div'); el.className = 'knock card'; el.id = 'knock-' + k.id;
  el.innerHTML = `<div><b>${esc(k.name)}</b> wants to join</div><div class="row" style="margin-top:8px"><button class="primary small">Let in</button><button class="small green-btn" title="Talk to them first, privately: only hosts see and hear them, and they aren't recorded">🟢 Green room</button><button class="ghost small">Deny</button></div>`;
  const [yes, green, no] = el.querySelectorAll('button');
  yes.onclick = () => { wsSend({ t: 'admit', id: k.id, allow: true }); el.remove(); };
  green.onclick = () => { wsSend({ t: 'admit', id: k.id, allow: true, green: true }); el.remove(); };
  no.onclick = () => { wsSend({ t: 'admit', id: k.id, allow: false }); el.remove(); };
  $('#knocks').appendChild(el);
}

// health panel (host): everyone's mic, connection, uploads and problems at a glance
// EBU R128 meter: bar shows short-term loudness on a -50…0 LUFS scale with -23 and -16 marks
function loudMeter(L, muted) {
  if (!L) return '<div class="small-text muted">No meter yet</div>';
  const pos = v => Math.max(0, Math.min(100, ((v + 50) / 50) * 100));
  const S = muted ? -Infinity : L.S;
  const tpBad = L.TPmax != null && L.TPmax > -1;
  return `<div class="lmeter"><div class="lbar ${loudClass(S)}" style="width:${Number.isFinite(S) && S !== null ? pos(S) : 0}%"></div>
      <div class="lmark" style="left:${pos(-23)}%" title="-23 LUFS (EBU R128)"></div><div class="lmark" style="left:${pos(-16)}%" title="-16 LUFS (podcast)"></div></div>
    <div class="lnums">M <b>${fmtL(L.M)}</b> · S <b class="${loudClass(L.S)}">${fmtL(L.S)}</b> · I <b>${fmtL(L.I)}</b> LUFS · TP <b class="${tpBad ? 'bad' : ''}">${fmtL(L.TPmax)}</b> dBTP${tpBad ? ' ⚠ too hot' : ''}</div>`;
}
// live transcript progress (hosts get it from the server every 10 s while recording)
let txLive = null;
function txHtml() {
  const x = txLive; if (!x || !recStartedAt) return '';
  if (!x.engine) return '<div class="hrow"><b>📝 Transcript</b><div class="warnc">Engine not installed — re-run the installer</div></div>';
  if (!x.on) return '<div class="hrow"><b>📝 Transcript</b><div class="muted">Switched off in Studio settings</div></div>';
  const fail = x.failed.length ? `<div class="hwarn">⚠ ${x.failed.map(f => esc(f.who) + ': ' + esc(f.error)).join(' · ')}</div>` : '';
  return `<div class="hrow ${fail ? 'has-warn' : ''}"><b>📝 Live transcript</b><div class="small-text muted">${x.pct}% of the audio so far · ${x.lines} line${x.lines === 1 ? '' : 's'} (runs ~30 s behind)</div><div class="pbar"><span style="width:${x.pct}%"></span></div>${fail}</div>`;
}
function renderHealth() {
  let totalWarn = warns.size;
  for (const p of peers.values()) totalWarn += ((p.state && p.state.warnings) || []).length;
  $('#healthBadge').textContent = totalWarn; $('#healthBadge').classList.toggle('hidden', !totalWarn);
  if (drawerTab !== 'health') return;
  const rows = controlMode ? [] : [{ id: myId, name: $('#nameInput').value.trim() + ' (you)', s: myState(), level: localPeak, loud: myLoud }];
  for (const p of peers.values()) if (!p.control) rows.push({ id: p.id, name: p.name, s: p.state || {}, level: p.level || 0, conn: p.pc.connectionState, loud: p.loud });
  const people = rows.length;
  if (serverDisk) {
    const gb = serverDisk.free / 1073741824, hrs = gb / (people * gbPerPersonHour);
    $('#healthServer').innerHTML = `<div class="hrow"><b>Studio server</b><div class="${hrs < 1 ? 'bad' : hrs < 3 ? 'warnc' : 'goodc'}">${gb.toFixed(0)} GB free · about ${hrs >= 10 ? Math.floor(hrs) : hrs.toFixed(1)} h of recording left</div></div>`;
    setWarn('disk', isHost && !!recStartedAt && hrs < 0.5);
  }
  $('#healthTx').innerHTML = txHtml();
  $('#healthRows').innerHTML = rows.map(r => {
    const s = r.s, ws = s.warnings || [];
    const n = s.net || {};
    const rec = s.rec === 'recording' ? '<span class="pill rec">● REC</span>' : s.rec === 'uploading' ? `<span class="pill warn">↑ uploading ${fmtMB(s.pending || 0)}</span>` : s.rec === 'saved' ? '<span class="pill ok">✓ saved</span>' : '<span class="pill">idle</span>';
    const behind = s.pendingAudio > 1048576 ? ` · audio ${fmtMB(s.pendingAudio)} behind` : '';
    return `<div class="hrow ${ws.length ? 'has-warn' : ''}">
      <div class="row spread"><b>${esc(r.name)}</b>${rec}</div>
      ${loudMeter(r.loud, s.mic === false)}
      ${histSvg(loudHist.get(r.id))}
      <div class="small-text muted">${s.mic === false ? '🔇 muted · ' : ''}${n.up ? `up ${n.up} Mbps · ` : ''}${s.rtt ? `ping ${s.rtt} ms · ` : ''}loss ${Math.round((s.loss || 0) * 100)}%${s.relay ? ' · via relay' : ''}${s.glitches ? ` · ${s.glitches} glitch${s.glitches > 1 ? 'es' : ''}` : ''}${behind}${s.durable === false ? ' · ⚠ not saving to disk' : ''}</div>
      ${ws.map(w => `<div class="hwarn">⚠ ${esc(WARN_TEXT[w] ? WARN_TEXT[w][1] : w)}</div>`).join('')}
    </div>`;
  }).join('');
  $('#healthMarkers').innerHTML = markers.length ? '<b>Markers this take</b><br>' + markers.map(m => `📍 ${fmtTime(m.at)} — ${esc(m.label)}`).join('<br>') : (recStartedAt ? 'Press <b>M</b> or 📍 to drop a marker for editing.' : '');
}
setInterval(renderHealth, 250);
// loudness history: short-term LUFS once a second, last 5 minutes, per person
setInterval(() => {
  if (!joined || !isHost) return;
  const add = (id, L, muted) => { if (!id) return; const h = loudHist.get(id) || []; h.push(!muted && L && Number.isFinite(L.S) ? L.S : null); if (h.length > 300) h.shift(); loudHist.set(id, h); };
  if (!controlMode) add(myId, myLoud, !micOn);
  for (const p of peers.values()) if (!p.control) add(p.id, p.loud, p.state && p.state.mic === false);
  for (const id of [...loudHist.keys()]) if (id !== myId && !peers.has(id)) loudHist.delete(id);
}, 1000);
function histSvg(h) {
  if (!h || h.length < 2) return '';
  const y = v => (Math.max(-50, Math.min(0, v)) / -50 * 100).toFixed(1); // -50…0 LUFS, top = loud
  const segs = []; let cur = [];
  h.forEach((v, i) => { if (v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push(`${(i * 300 / 299).toFixed(1)},${y(v)}`); });
  if (cur.length) segs.push(cur);
  return `<svg class="lhist" viewBox="0 0 300 100" preserveAspectRatio="none" aria-label="Loudness, last 5 minutes"><title>Short-term loudness, last 5 minutes (dashed: −16 and −23 LUFS)</title>
    <line x1="0" x2="300" y1="${y(-16)}" y2="${y(-16)}"/><line x1="0" x2="300" y1="${y(-23)}" y2="${y(-23)}"/>${segs.map(s => `<polyline points="${s.join(' ')}"/>`).join('')}</svg>`;
}
function tileLoud(el, L, muted) {
  if (!el) return;
  let b = el.querySelector('.tloud');
  if (!b) { b = document.createElement('div'); b.className = 'tloud'; el.appendChild(b); }
  if (!L || muted || !Number.isFinite(L.S)) { b.textContent = ''; b.className = 'tloud'; return; }
  b.className = 'tloud ' + loudClass(L.S);
  b.textContent = `${L.S.toFixed(0)} LUFS${L.TPmax != null && L.TPmax > -1 ? ' · PEAK' : ''}`;
}
setInterval(() => {
  if (!joined) return;
  if (!controlMode) tileLoud(document.getElementById('tile-me'), myLoud, !micOn);
  if (isHost) for (const p of peers.values()) tileLoud(p.tile, p.loud, p.state && p.state.mic === false);
}, 250);

// =====================================================================
// 8. Local recording: lossless audio + camera + screen, saved to disk then uploaded
// =====================================================================
function pickMime(withAudio) {
  const list = withAudio ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
    : ['video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}
function startLocal(m) {
  if (recording && recording.seg === m.seg) return;
  if (recording) stopLocal(recording);
  const r = { take: m.take, seg: m.seg, tok: m.tok, samples: 0, vi: 0, vst: null, audioStopped: false, videoStopped: false, finishing: false, mime: '', screenActive: 0, screenIdx: 0, screenRec: null };
  recording = r; lastTakeSaved = false;
  recStartedAt = m.started; updateRecUI();
  audioTarget = r;
  recNode.port.postMessage({ cmd: 'start' });
  const vt = stream.getVideoTracks()[0], at = stream.getAudioTracks()[0];
  const mime = vt && $('#recordCam').checked ? pickMime(true) : '';
  if (mime) {
    try {
      r.mime = mime;
      const rec = new MediaRecorder(new MediaStream(at ? [vt, at] : [vt]), { mimeType: mime, videoBitsPerSecond: videoBps, audioBitsPerSecond: 96000 });
      r.recorder = rec;
      rec.ondataavailable = e => {
        if (!e.data || !e.data.size) return;
        const i = r.vi++;
        enqueue(`/up/${roomId}/${r.take}/${r.seg}/video?tok=${r.tok}&i=${i}&mime=${encodeURIComponent(r.mime)}&st=${r.vst.toFixed(1)}`, e.data, { pri: 1, seg: r.seg, kind: 'video' });
      };
      rec.onstop = () => { r.videoStopped = true; maybeFinish(r); };
      rec.onerror = () => { setWarn('cam-lost', true); };
      r.vst = serverNow(); // capture starts when start() is called
      rec.start(2000);
    } catch (e) { console.error('video recorder', e); r.videoStopped = true; }
  } else r.videoStopped = true;
  if (screenStream) startScreenRecorder(r);
  sendState(true);
}
function startScreenRecorder(r) {
  const mime = pickMime(false); if (!mime || !screenStream) return;
  try {
    const idx = r.screenIdx++, st = serverNow();
    const rec = new MediaRecorder(screenStream, { mimeType: mime, videoBitsPerSecond: Math.min(videoBps, 2500000) });
    let i = 0;
    r.screenActive++; r.screenRec = rec;
    rec.ondataavailable = e => { if (e.data && e.data.size) enqueue(`/up/${roomId}/${r.take}/${r.seg}/video?tok=${r.tok}&src=screen&r=${idx}&i=${i++}&mime=${encodeURIComponent(mime)}&st=${st.toFixed(1)}`, e.data, { pri: 1, seg: r.seg, kind: 'video' }); };
    rec.onstop = () => { r.screenActive--; if (r.screenRec === rec) r.screenRec = null; maybeFinish(r); };
    rec.start(2000);
  } catch (e) { console.error('screen recorder', e); }
}
function stopLocal(r) {
  if (r.finishing) return;
  r.finishing = true;
  if (recording === r) recording = null;
  if (audioTarget === r) recNode.port.postMessage({ cmd: 'stop' }); else r.audioStopped = true;
  if (r.recorder && r.recorder.state !== 'inactive') r.recorder.stop(); else r.videoStopped = true;
  if (r.screenRec && r.screenRec.state !== 'inactive') r.screenRec.stop();
  maybeFinish(r);
  sendState(true);
}
function maybeFinish(r) {
  if (!r.finishing || !r.audioStopped || !r.videoStopped || r.screenActive > 0 || r.doneQueued) return;
  r.doneQueued = true;
  enqueue(`/up/${roomId}/${r.take}/${r.seg}/done?tok=${r.tok}`, null, { pri: 2, seg: r.seg, kind: 'done', onDone: () => { lastTakeSaved = true; sendState(true); } });
}
function onPcm(m) {
  const r = audioTarget; if (!r) return;
  const f = m.data, b = new Uint8Array(f.length * 3);
  for (let i = 0, j = 0; i < f.length; i++, j += 3) {
    const v = f[i] > 1 ? 1 : f[i] < -1 ? -1 : f[i];
    let x = v < 0 ? Math.round(v * 8388608) : Math.round(v * 8388607);
    if (x < 0) x += 16777216;
    b[j] = x & 255; b[j + 1] = (x >> 8) & 255; b[j + 2] = (x >> 16) & 255;
  }
  // when was the first sample of this chunk captured, in server time?
  let perf;
  try { const ts = ctx.getOutputTimestamp(); perf = ts.performanceTime > 0 ? ts.performanceTime + (m.time - ts.contextTime) * 1000 : null; } catch (e) { if (!onPcm.warned) { onPcm.warned = true; quiet('precise audio clock (using the fallback)')(e); } }
  if (!perf) perf = performance.now() - (ctx.currentTime - m.time) * 1000;
  const t = perf + clockOffset;
  enqueue(`/up/${roomId}/${r.take}/${r.seg}/audio?tok=${r.tok}&s=${r.samples}&t=${t.toFixed(1)}&rate=${ctx.sampleRate}`, b, { pri: 0, seg: r.seg, kind: 'audio' });
  r.samples += f.length;
}

// host: progress of the take being built on the server
function renderBuild() {
  if (!isHost || !build) return;
  const done = build.status === 'ready' || build.status === 'error';
  $('#uploadLine').innerHTML = done
    ? (build.status === 'ready' ? `✓ Take ${build.n} is ready — <a href="/m/${roomId}?k=${encodeURIComponent(hostKey)}" target="_blank">open Recordings</a>` : `⚠ Take ${build.n} had a problem — see Recordings`)
    : `Building take ${build.n}: ${esc(build.step || build.status)} <span class="pbar"><span style="width:${build.pct || 0}%"></span></span> ${build.pct || 0}%`;
}
// what this person's browser reports to everyone (the host sees it in the Health panel)
let lastState = '';
function myState() {
  return { control: controlMode, mic: micOn && !controlMode, cam: camOn && !controlMode && !!stream && !!stream.getVideoTracks().length,
    rec: recording ? 'recording' : up.items.size ? 'uploading' : lastTakeSaved ? 'saved' : '',
    pending: up.pending, pendingAudio: up.pendingAudio, warnings: [...warns], glitches, net, loss: myNet.loss, relay: myNet.relay, rtt: myNet.serverRtt, durable: store.durable };
}
function sendState(force) {
  updateUploadUI();
  if (!joined) return;
  const s = myState(), key = JSON.stringify({ ...s, pending: Math.round(s.pending / 524288), pendingAudio: Math.round(s.pendingAudio / 262144), loss: Math.round(s.loss * 50), rtt: Math.round((s.rtt || 0) / 25) });
  const meTile = document.getElementById('tile-me');
  if (meTile) { meTile.querySelector('.status').innerHTML = statusPills(s); meTile.classList.toggle('rec', s.rec === 'recording'); }
  if (s.rec === 'uploading') {
    uploadPeak = Math.max(uploadPeak, s.pending);
    const pct = uploadPeak ? Math.round(100 * (1 - s.pending / uploadPeak)) : 0;
    $('#uploadLine').innerHTML = `Uploading your recording… ${fmtMB(s.pending)} left <span class="pbar"><span style="width:${pct}%"></span></span>`;
  } else if (build && isHost) renderBuild();
  else $('#uploadLine').textContent = s.rec === 'saved' ? 'Your recording is saved ✓' : '';
  if (key !== lastState || force) { lastState = key; wsSend({ t: 'state', state: s }); }
}
setInterval(() => sendState(), 1000);
setInterval(() => sendState(true), 10000);

// =====================================================================
// 9. Room tone overlay
// =====================================================================
let toneTimer = null;
function startToneOverlay(rt) {
  roomTone = rt;
  $('#tone').classList.remove('hidden', 'live');
  $('#toneHostTips').classList.toggle('hidden', !isHost);
  $('#toneText').textContent = isHost
    ? 'You started room tone. Everyone stays silent and still until the countdown ends.'
    : 'The host is recording room tone. Please stay silent and still — don\'t type, move or touch your mic.';
  clearInterval(toneTimer);
  const tick = () => {
    const now = serverNow();
    $('#toneMuted').classList.toggle('hidden', micOn);
    if (now < roomTone.start) { $('#toneTitle').textContent = 'Get ready to be quiet…'; $('#toneCount').textContent = Math.ceil((roomTone.end - roomTone.start) / 1000); return; }
    if (now < roomTone.end) { $('#toneTitle').textContent = 'Quiet please'; $('#toneCount').textContent = Math.ceil((roomTone.end - now) / 1000); return; }
    stopToneOverlay(false);
  };
  tick(); toneTimer = setInterval(tick, 200);
}
// 3-2-1 "you're live" cue for everyone
function countdown() {
  const el = $('#countdown'); let n = 3;
  el.classList.remove('hidden'); el.textContent = n;
  const t = setInterval(() => {
    n--;
    if (n > 0) el.textContent = n;
    else if (n === 0) { el.textContent = '🔴 You\'re live'; el.classList.add('live'); }
    else { clearInterval(t); el.classList.add('hidden'); el.classList.remove('live'); }
  }, 900);
}
function stopToneOverlay(silent) {
  clearInterval(toneTimer); toneTimer = null;
  if (!roomTone) return;
  roomTone = null;
  if (silent) { $('#tone').classList.add('hidden'); return; }
  $('#tone').classList.add('live');
  $('#toneTitle').textContent = 'Room tone done';
  $('#toneCount').textContent = '✓';
  $('#toneText').textContent = isHost ? 'You\'re live — start the show whenever you\'re ready.' : 'Thanks! The show is about to start.';
  $('#toneHostTips').classList.add('hidden'); $('#toneMuted').classList.add('hidden');
  setTimeout(() => { if (!roomTone) { $('#tone').classList.add('hidden'); countdown(); } }, 1500);
}
$('#toneUnmute').onclick = () => { if (!micOn) toggleMic(); };

// =====================================================================
// 10. Leaving
// =====================================================================
$('#leaveBtn').onclick = async () => {
  if (recording && !(await ask('Leave while recording?', 'Your recording so far is kept, but you won\'t be recorded after you leave.', 'Leave'))) return;
  if (recording) stopLocal(recording);
  if (screenStream) stopScreen();
  left = true; joined = false;
  try { ws.close(); } catch (e) { quiet('close connection')(e); }
  for (const p of [...peers.values()]) removePeer(p.id);
  stream.getVideoTracks().forEach(t => t.stop());
  finishScreen();
};
function finishScreen() {
  const tick = () => {
    if (up.items.size) {
      message('Finishing your upload…', `<b>Please keep this tab open.</b> ${fmtMB(up.pending)} left to send.<br><span class="small-text">If you have to close it, open the same link later and it will carry on.</span>`);
      setTimeout(tick, 500);
    } else {
      message('You\'ve left the studio', lastTakeSaved ? 'Your recording is safely saved ✓ — you can close this tab.' : 'You can close this tab.', true);
    }
  };
  tick();
}
addEventListener('beforeunload', e => { if (recording || up.items.size) { e.preventDefault(); e.returnValue = ''; } });
})();
