(() => {
'use strict';
const $ = s => document.querySelector(s);
const roomId = location.pathname.split('/').filter(Boolean)[1] || '';
const hostKey = new URLSearchParams(location.search).get('k') || '';
const LS = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };
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
const markers = [];
let clockOffset = Date.now() - performance.now();
const syncSamples = [];
const serverNow = () => performance.now() + clockOffset;
const dbg = (...a) => { if (window.__debug) console.log('[rtc]', ...a); };

// ---------- small UI helpers ----------
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function show(id) { for (const v of ['lobby', 'studio', 'message']) $('#' + v).classList.toggle('hidden', v !== id); }
function toast(text, ms = 3000) { let box = document.getElementById('toasts'); if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); } const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; box.appendChild(t); setTimeout(() => t.remove(), ms); }
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
const fmtMB = b => (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB';
const initials = n => (n || '?').split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
const fmtTime = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };
function chime() { try { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 880; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5); o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.55); } catch {} }

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
    async del(id) { if (typeof id === 'string') { mem.delete(id); return; } try { await req('readwrite', s => s.delete(id)); } catch {} },
    async list() {
      await ready; if (!ok) return [];
      return new Promise(res => { const out = []; const q = db.transaction('chunks').objectStore('chunks').openCursor();
        q.onsuccess = () => { const c = q.result; if (!c) return res(out); const v = c.value; out.push({ id: c.key, url: v.url, size: v.size, pri: v.pri, seg: v.seg, kind: v.kind }); c.continue(); };
        q.onerror = () => res(out); });
    },
  };
})();
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch {}

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
      const res = await fetch(it.url, { method: 'POST', body: rec.body || '', headers: { 'Content-Type': 'application/octet-stream' } });
      if (res.status >= 500 || res.status === 0) throw new Error('HTTP ' + res.status);
      if (!res.ok) console.warn('upload refused', res.status, it.url);
    }
    await store.del(it.id);
    up.items.delete(it.id); up.pending -= it.size; if (it.kind === 'audio') up.pendingAudio -= it.size;
    up.fails = 0;
    if (it.onDone) it.onDone();
  } catch (e) {
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
if (hostKey) { $('#roleBadge').textContent = 'Host'; $('#roleBadge').classList.add('ok'); }
fetch('/api/info').then(r => r.json()).then(i => { document.querySelectorAll('.studio-name').forEach(e => e.textContent = i.name); document.title = i.name; }).catch(() => {});
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
    if (video) { try { const s = await navigator.mediaDevices.getUserMedia({ audio, video: false }); toast('Camera not available — joining with audio only', 4000); return s; } catch {} }
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
  setInterval(() => { if (ctx.state === 'suspended' || ctx.state === 'interrupted') ctx.resume().catch(() => {}); }, 1000);
}
function connectMic() {
  if (micSource) try { micSource.disconnect(); } catch {}
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
  try {
    const rtts = [];
    for (let i = 0; i < 5; i++) { const t0 = performance.now(); await fetch('/api/ping?' + Math.random(), { cache: 'no-store' }); rtts.push(performance.now() - t0); }
    rtts.sort((a, b) => a - b); const rtt = rtts[2];
    let t0 = performance.now();
    const dl = await (await fetch('/api/speedtest?bytes=4194304&' + Math.random(), { cache: 'no-store' })).arrayBuffer();
    const down = dl.byteLength * 8 / ((performance.now() - t0) / 1000) / 1e6;
    const payload = n => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
    let size = 524288, upMbps;
    for (;;) {
      const body = payload(size); t0 = performance.now();
      await fetch('/api/speedtest', { method: 'POST', body, cache: 'no-store' });
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
    res.className = 'small-text nettest-bad'; res.innerHTML = '<b>⚠ Couldn\'t reach the studio server.</b> Check your internet, then press Test again.';
  }
  $('#netBtn').disabled = false;
}
$('#netBtn').onclick = netTest;

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
  if (ctx && ctx.state !== 'running' && recording) ctx.resume().catch(() => {});
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
      for (const p of peers.values()) for (const snd of p.pc.getSenders()) if (snd.track && snd.track.kind === 'audio') snd.replaceTrack(nt).catch(() => {});
      for (const p of peers.values()) { const tr = p.pc.getTransceivers().find(t => t.receiver.track.kind === 'audio' && !t.sender.track); if (tr) tr.sender.replaceTrack(nt).catch(() => {}); }
      setWarn('mic-lost', false); toast('🎙 Microphone reconnected'); fillDevices().catch(() => {});
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
  if (!joined) fillDevices().catch(() => {});
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
    } catch {}
  }
  myNet.loss = loss; myNet.relay = relay;
  myNet.badCount = loss > 0.08 ? (myNet.badCount || 0) + 1 : 0;
  setWarn('net', myNet.badCount >= 2);
}, 3000);
const myNet = { loss: 0, relay: false };

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
  }
  localPeak *= 0.85;
  requestAnimationFrame(levelLoop);
}
requestAnimationFrame(levelLoop);

// =====================================================================
// 4. Joining + messages from the server
// =====================================================================
$('#joinBtn').onclick = () => {
  const name = $('#nameInput').value.trim();
  if (!name || !stream) return;
  LS.set('ps_name', name);
  ctx.resume().catch(() => {});
  connect();
};
$('#rejoinBtn').onclick = () => location.reload();

function wsSend(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function connect() {
  left = false;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => {
    wsSend({ t: 'join', room: roomId, key: hostKey, name: $('#nameInput').value.trim(), clientId, recSeg: recording ? recording.seg : null, camId: stream.id });
    for (let i = 0; i < 8; i++) setTimeout(() => wsSend({ t: 'ping', c: performance.now() }), i * 250);
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch { return; } onMsg(m); };
  ws.onclose = () => {
    for (const p of [...peers.values()]) removePeer(p.id);
    pendingSignals.clear();
    if (left) return;
    if (joined || inWaiting) { $('#uploadLine').textContent = 'Reconnecting…'; setTimeout(connect, 2000); }
  };
}
setInterval(() => wsSend({ t: 'ping', c: performance.now() }), 5000);

function onMsg(m) {
  switch (m.t) {
    case 'pong': {
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
      if (!joined) { joined = true; show('studio'); addMyTile(); if (screenStream) showScreenTile('me', screenStream, 'Your screen'); (m.chat || []).forEach(c => addChat(c, true)); }
      $('#uploadLine').textContent = '';
      for (const p of m.peers) addPeer(p, true);
      for (const w of m.waiting || []) showKnock(w);
      if (!m.recording) { recStartedAt = null; if (recording) stopLocal(recording); }
      else { recStartedAt = m.recording.started; if (recording && recording.take !== m.recording.take) stopLocal(recording); }
      if (m.roomTone) startToneOverlay(m.roomTone);
      if (screenStream) wsSend({ t: 'screen', on: true, streamId: screenStream.id });
      updateRecUI(); sendState(true); layout();
      break;
    }
    case 'error':
      left = true; inWaiting = false;
      try { ws.close(); } catch {}
      message(m.code === 'full' ? 'Studio is full' : m.code === 'kicked' ? 'Removed from studio' : m.code === 'denied' ? 'Not let in' : 'Can\'t join', esc(m.msg), m.code === 'full' || m.code === 'denied');
      if (up.items.size) finishScreen();
      break;
    case 'notice': ask(m.level === 'error' ? 'Problem' : 'Note', esc(m.text), 'OK', null); break;
    case 'peer-joined': addPeer(m.peer, false); layout(); toast(`${m.peer.name} joined`); break;
    case 'peer-left': { const p = peers.get(m.id); if (p) toast(`${p.name} left`); removePeer(m.id); pendingSignals.delete(m.id); layout(); break; }
    case 'peer-state': { const p = peers.get(m.id); if (p) { const before = new Set((p.state && p.state.warnings) || []); p.state = m.state; renderStatus(p); if (isHost) for (const w of p.state.warnings || []) if (!before.has(w)) { toast(`⚠ ${p.name}: ${WARN_TEXT[w] ? WARN_TEXT[w][1] : w}`, 5000); } } break; }
    case 'screen': { const p = peers.get(m.id); if (p) { p.screenId = m.on ? m.streamId : null; if (!m.on) removeScreenTile(p.id); else attachScreenIfReady(p); } break; }
    case 'signal': onSignal(m.from, m.data); break;
    case 'recording': recStartedAt = m.on ? m.started : null; updateRecUI(); if (m.on) { toast(`Recording started (take ${m.n})`); markers.length = 0; } else toast('Recording stopped — finishing uploads…', 3500); break;
    case 'record-start': startLocal(m); break;
    case 'record-stop': if (recording && recording.take === m.take) stopLocal(recording); stopToneOverlay(true); break;
    case 'roomtone': startToneOverlay(m); break;
    case 'chat': addChat(m); break;
    case 'marker': markers.push(m); toast(`📍 ${m.label} at ${fmtTime(m.at)}`); break;
    case 'knock': showKnock(m); chime(); break;
    case 'knock-gone': { const k = document.getElementById('knock-' + m.id); if (k) k.remove(); break; }
    case 'server': serverDisk = m.disk; break;
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
  p.tile = makeTile(p.id, p.name, false);
  if (isHost) {
    const k = document.createElement('button'); k.className = 'small ghost kick'; k.textContent = 'Remove';
    k.onclick = async () => { if (await ask(`Remove ${esc(p.name)}?`, 'They will be taken out of the studio. Their recording so far is kept.', 'Remove')) wsSend({ t: 'kick', id: p.id }); };
    p.tile.appendChild(k);
  }
  renderStatus(p);
  for (const tr of stream.getTracks()) pc.addTrack(tr, stream);
  if (!stream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
  if (screenStream) p.screenSender = pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
  pc.ontrack = e => {
    const st = e.streams[0] || new MediaStream([e.track]);
    p.streams.set(st.id, st);
    const isScreen = (p.screenId && st.id === p.screenId) || (e.track.kind === 'video' && p.camId && st.id !== p.camId);
    if (isScreen) { if (!p.screenId) p.screenId = st.id; showScreenTile(p.id, st, `${p.name}'s screen`); return; }
    const v = p.tile.querySelector('video');
    if (v.srcObject !== st) v.srcObject = st;
    v.play().catch(() => {});
    if (e.track.kind === 'audio' && !p.analyser) {
      try { const src = ctx.createMediaStreamSource(new MediaStream([e.track])); p.analyser = ctx.createAnalyser(); p.analyser.fftSize = 512; p.buf = new Float32Array(512); src.connect(p.analyser); } catch {}
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
  try { p.pc.close(); } catch {}
  if (p.tile) p.tile.remove();
  removeScreenTile(id);
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
    s.setParameters(params).catch(() => {});
  }
}

// =====================================================================
// 6. Tiles + layout
// =====================================================================
function makeTile(id, name, isMe) {
  const el = document.createElement('div');
  el.className = 'tile' + (isMe ? ' me' : ''); el.id = 'tile-' + id;
  el.innerHTML = `<video autoplay playsinline ${isMe ? 'muted' : ''}></video><div class="avatar"></div>
    <div class="label"><span class="micicon"></span><span class="name"></span></div><div class="status"></div>
    ${isMe ? '' : '<div class="conn">Connecting…</div>'}`;
  el.querySelector('.name').textContent = name + (isMe ? ' (you)' : '');
  el.querySelector('.avatar').textContent = initials(name);
  $('#grid').appendChild(el);
  return el;
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
  el.querySelector('video').srcObject = st; el.querySelector('video').play().catch(() => {});
  layout();
}
function attachScreenIfReady(p) { const st = p.screenId && p.streams.get(p.screenId); if (st) showScreenTile(p.id, st, `${p.name}'s screen`); }
function removeScreenTile(id) { const el = document.getElementById('screen-' + id); if (el) { el.remove(); layout(); } }
function layout() {
  const grid = $('#grid'), tiles = grid.children.length;
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
  try { tr.contentHint = 'detail'; } catch {}
  tr.onended = stopScreen;
  wsSend({ t: 'screen', on: true, streamId: screenStream.id });
  for (const p of peers.values()) p.screenSender = p.pc.addTrack(tr, screenStream);
  showScreenTile('me', screenStream, 'Your screen');
  if (recording) startScreenRecorder(recording);
  $('#screenBtn').textContent = '🛑 Stop sharing'; $('#screenBtn').classList.add('off');
}
function stopScreen() {
  if (!screenStream) return;
  for (const p of peers.values()) if (p.screenSender) { try { p.pc.removeTrack(p.screenSender); } catch {} p.screenSender = null; }
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
      `Record <b>${roomToneSeconds} seconds of room tone</b> first? Everyone gets a "Quiet please" countdown, then you're live. ` +
      `It's saved as a separate noise-print file for each person (and is also at the start of their main track).${disk}`,
      'Room tone, then record', 'Cancel', 'Record without room tone');
    if (!a) return;
    wsSend({ t: 'record', on: true, roomTone: a === 'yes' });
  } else {
    if (await ask('Stop recording?', 'Everyone\'s files will finish uploading, then they\'ll be ready on the Recordings page.', 'Stop recording')) wsSend({ t: 'record', on: false });
  }
};
$('#toneBtn').onclick = async () => {
  if (!recStartedAt) return toast('Start recording first');
  if (roomTone) return;
  if (await ask('Record room tone now?', `Everyone will be asked to stay silent for ${roomToneSeconds} seconds.`, 'Start room tone')) wsSend({ t: 'roomtone' });
};
function dropMarker() { if (!isHost) return; if (!recStartedAt) return toast('Markers work while recording'); wsSend({ t: 'marker' }); }
$('#markerBtn').onclick = dropMarker;
addEventListener('keydown', e => { if ((e.key === 'm' || e.key === 'M') && joined && !e.target.closest('input,textarea,select') && !e.metaKey && !e.ctrlKey) dropMarker(); });
$('#copyGuestBtn').onclick = () => {
  const link = location.origin + '/r/' + roomId;
  navigator.clipboard.writeText(link).then(() => toast('Guest link copied')).catch(() => ask('Guest link', `<input type="text" value="${link}" readonly onclick="this.select()">`, 'Done', null));
};
function updateRecUI() {
  $('#recBadge').classList.toggle('on', !!recStartedAt);
  $('#recBtn').textContent = recStartedAt ? '■ Stop recording' : '● Start recording';
  $('#recBtn').classList.toggle('danger', !!recStartedAt); $('#recBtn').classList.toggle('primary', !recStartedAt);
  $('#toneBtn').disabled = $('#markerBtn').disabled = !recStartedAt;
}
setInterval(() => { if (recStartedAt) $('#recTime').textContent = fmtTime(serverNow() - recStartedAt); }, 250);

// drawer: chat + health
let drawerTab = null, unread = 0;
function openDrawer(tab) {
  if (drawerTab === tab) return closeDrawer();
  drawerTab = tab;
  $('#drawer').classList.remove('hidden');
  document.querySelectorAll('.drawer-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-chat').classList.toggle('hidden', tab !== 'chat'); $('#tab-health').classList.toggle('hidden', tab !== 'health');
  if (tab === 'chat') { unread = 0; $('#chatBadge').classList.add('hidden'); setTimeout(() => $('#chatInput').focus(), 50); }
  if (tab === 'health') renderHealth();
  layout();
}
function closeDrawer() { drawerTab = null; $('#drawer').classList.add('hidden'); layout(); }
$('#chatBtn').onclick = () => openDrawer('chat');
$('#healthBtn').onclick = () => openDrawer('health');
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

// waiting room knocks (host)
function showKnock(k) {
  if (document.getElementById('knock-' + k.id)) return;
  const el = document.createElement('div'); el.className = 'knock card'; el.id = 'knock-' + k.id;
  el.innerHTML = `<div><b>${esc(k.name)}</b> wants to join</div><div class="row" style="margin-top:8px"><button class="primary small">Let in</button><button class="ghost small">Deny</button></div>`;
  const [yes, no] = el.querySelectorAll('button');
  yes.onclick = () => { wsSend({ t: 'admit', id: k.id, allow: true }); el.remove(); };
  no.onclick = () => { wsSend({ t: 'admit', id: k.id, allow: false }); el.remove(); };
  $('#knocks').appendChild(el);
}

// health panel (host): everyone's mic, connection, uploads and problems at a glance
function renderHealth() {
  let totalWarn = warns.size;
  for (const p of peers.values()) totalWarn += ((p.state && p.state.warnings) || []).length;
  $('#healthBadge').textContent = totalWarn; $('#healthBadge').classList.toggle('hidden', !totalWarn);
  if (drawerTab !== 'health') return;
  const rows = [{ name: $('#nameInput').value.trim() + ' (you)', s: myState(), level: localPeak }];
  for (const p of peers.values()) rows.push({ name: p.name, s: p.state || {}, level: p.level || 0, conn: p.pc.connectionState });
  const people = rows.length;
  if (serverDisk) {
    const gb = serverDisk.free / 1073741824, hrs = gb / (people * gbPerPersonHour);
    $('#healthServer').innerHTML = `<div class="hrow"><b>Studio server</b><div class="${hrs < 1 ? 'bad' : hrs < 3 ? 'warnc' : 'goodc'}">${gb.toFixed(0)} GB free · about ${hrs >= 10 ? Math.floor(hrs) : hrs.toFixed(1)} h of recording left</div></div>`;
    setWarn('disk', isHost && !!recStartedAt && hrs < 0.5);
  }
  $('#healthRows').innerHTML = rows.map(r => {
    const s = r.s, ws = s.warnings || [];
    const lvl = Math.min(100, Math.sqrt(r.level) * 110);
    const n = s.net || {};
    const rec = s.rec === 'recording' ? '<span class="pill rec">● REC</span>' : s.rec === 'uploading' ? `<span class="pill warn">↑ uploading ${fmtMB(s.pending || 0)}</span>` : s.rec === 'saved' ? '<span class="pill ok">✓ saved</span>' : '<span class="pill">idle</span>';
    const behind = s.pendingAudio > 1048576 ? ` · audio ${fmtMB(s.pendingAudio)} behind` : '';
    return `<div class="hrow ${ws.length ? 'has-warn' : ''}">
      <div class="row spread"><b>${esc(r.name)}</b>${rec}</div>
      <div class="meter small"><div style="width:${s.mic === false ? 0 : lvl}%"></div></div>
      <div class="small-text muted">${s.mic === false ? '🔇 muted · ' : ''}${n.up ? `up ${n.up} Mbps · ` : ''}${s.rtt ? `ping ${s.rtt} ms · ` : ''}loss ${Math.round((s.loss || 0) * 100)}%${s.relay ? ' · via relay' : ''}${s.glitches ? ` · ${s.glitches} glitch${s.glitches > 1 ? 'es' : ''}` : ''}${behind}${s.durable === false ? ' · ⚠ not saving to disk' : ''}</div>
      ${ws.map(w => `<div class="hwarn">⚠ ${esc(WARN_TEXT[w] ? WARN_TEXT[w][1] : w)}</div>`).join('')}
    </div>`;
  }).join('');
  $('#healthMarkers').innerHTML = markers.length ? '<b>Markers this take</b><br>' + markers.map(m => `📍 ${fmtTime(m.at)} — ${esc(m.label)}`).join('<br>') : (recStartedAt ? 'Press <b>M</b> or 📍 to drop a marker for editing.' : '');
}
setInterval(renderHealth, 1000);

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
  try { const ts = ctx.getOutputTimestamp(); perf = ts.performanceTime > 0 ? ts.performanceTime + (m.time - ts.contextTime) * 1000 : null; } catch {}
  if (!perf) perf = performance.now() - (ctx.currentTime - m.time) * 1000;
  const t = perf + clockOffset;
  enqueue(`/up/${roomId}/${r.take}/${r.seg}/audio?tok=${r.tok}&s=${r.samples}&t=${t.toFixed(1)}&rate=${ctx.sampleRate}`, b, { pri: 0, seg: r.seg, kind: 'audio' });
  r.samples += f.length;
}

// what this person's browser reports to everyone (the host sees it in the Health panel)
let lastState = '';
function myState() {
  return { mic: micOn, cam: camOn && !!stream && !!stream.getVideoTracks().length,
    rec: recording ? 'recording' : up.items.size ? 'uploading' : lastTakeSaved ? 'saved' : '',
    pending: up.pending, pendingAudio: up.pendingAudio, warnings: [...warns], glitches, net, loss: myNet.loss, relay: myNet.relay, rtt: myNet.serverRtt, durable: store.durable };
}
function sendState(force) {
  updateUploadUI();
  if (!joined) return;
  const s = myState(), key = JSON.stringify({ ...s, pending: Math.round(s.pending / 524288), pendingAudio: Math.round(s.pendingAudio / 262144), loss: Math.round(s.loss * 50), rtt: Math.round((s.rtt || 0) / 25) });
  const meTile = document.getElementById('tile-me');
  if (meTile) meTile.querySelector('.status').innerHTML = statusPills(s);
  $('#uploadLine').textContent = s.rec === 'uploading' ? `Uploading your recording… ${fmtMB(s.pending)} left — keep this tab open` : s.rec === 'saved' ? 'Your recording is saved ✓' : '';
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
  setTimeout(() => { if (!roomTone) $('#tone').classList.add('hidden'); }, 2500);
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
  try { ws.close(); } catch {}
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
