'use strict';
/*
 * "Host it on this computer": runs a whole Rolling studio inside Rolling Desk — no server needed.
 *
 *   the studio      the same server.js as on a server, started with Electron's own Node (ELECTRON_RUN_AS_NODE),
 *                   listening on this computer only (127.0.0.1, a free port)
 *   the guest link  a Cloudflare quick tunnel (cloudflared, bundled): a free https://…trycloudflare.com address
 *                   that reaches this computer. It's new each time, and the studio is told it over IPC, so
 *                   every page shows the right guest link even if the tunnel has to restart
 *   the tools       ffmpeg, ffprobe, whisper (transcripts) and its speech model are bundled with the app
 *
 * Recordings, rooms and settings live in the folder the person picks (default ~/Rolling Studio).
 */
const { spawn } = require('child_process');
const crypto = require('crypto');
const EventEmitter = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

const EXE = process.platform === 'win32' ? '.exe' : '';
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// what's bundled with this copy of the app (each one optional: the studio says what's missing)
function toolPaths(dir) {
  const p = n => path.join(dir, n + EXE);
  return { ffmpeg: p('ffmpeg'), ffprobe: p('ffprobe'), cloudflared: p('cloudflared'), whisper: p('whisper-cli'), models: path.join(dir, 'models') };
}

class LocalStudio extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.studioDir   where the server code is (server.js, public/…)
   * @param {string} o.toolsDir    where ffmpeg, cloudflared, whisper-cli and models/ are
   * @param {string} o.dataDir     where recordings and rooms are saved
   * @param {string} o.secretsFile where this studio's admin password and secret are kept (in the app's own settings)
   * @param {string} o.nodePath    the program that runs server.js (Electron itself)
   * @param {function} o.log       (level, message, error?)
   */
  constructor(o) {
    super();
    Object.assign(this, o);
    this.server = null; this.tunnel = null; this.port = 0; this.publicUrl = ''; this.stopping = false; this.tunnelTries = 0;
  }

  secrets() {
    let s = {};
    try { s = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') this.log('warn', 'studio secrets file unreadable — making new ones (old logins stop working)', e); }
    if (!s.password || !s.secret) {
      s = { password: crypto.randomBytes(9).toString('base64url'), secret: crypto.randomBytes(32).toString('hex') };
      fs.mkdirSync(path.dirname(this.secretsFile), { recursive: true });
      fs.writeFileSync(this.secretsFile, JSON.stringify(s), { mode: 0o600 });
    }
    return s;
  }

  get localUrl() { return `http://127.0.0.1:${this.port}`; }

  /** Starts the studio, then the tunnel. Resolves once the studio answers on this computer. */
  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.accessSync(this.dataDir, fs.constants.W_OK);
    const { password, secret } = this.secrets(), tools = toolPaths(this.toolsDir);
    this.password = password;
    this.port = await freePort();
    const env = {
      ...process.env, ELECTRON_RUN_AS_NODE: '1',
      PORT: String(this.port), BIND: '127.0.0.1', DATA_DIR: this.dataDir, STUDIO_NAME: 'Rolling', ADMIN_PASSWORD: password, SECRET: secret,
      FFMPEG: fs.existsSync(tools.ffmpeg) ? tools.ffmpeg : 'ffmpeg', FFPROBE: fs.existsSync(tools.ffprobe) ? tools.ffprobe : 'ffprobe',
      WHISPER_BIN: tools.whisper, WHISPER_MODELS: tools.models,
    };
    this.server = spawn(this.nodePath, [path.join(this.studioDir, 'server.js')], { cwd: this.studioDir, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
    const out = d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => this.log('info', '[studio] ' + l));
    this.server.stdout.on('data', out); this.server.stderr.on('data', out);
    this.server.on('exit', (code, sig) => { this.server = null; if (!this.stopping) { this.log('error', `the studio stopped unexpectedly (${code ?? sig})`); this.emit('crashed', code ?? sig); } });
    await this.waitUntilUp(30000);
    this.startTunnel();
    return this.localUrl;
  }

  async waitUntilUp(ms) {
    const until = Date.now() + ms;
    for (;;) {
      if (!this.server) throw new Error('The studio couldn\'t start — see the log (View › Toggle Developer Tools)');
      try { const r = await fetch(this.localUrl + '/api/info', { signal: AbortSignal.timeout(2000) }); if (r.ok) return; }
      catch (e) { if (Date.now() > until) throw new Error(`The studio didn't start within ${ms / 1000} s (${e.message})`); }
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // ---------- the guest link ----------
  startTunnel() {
    const bin = toolPaths(this.toolsDir).cloudflared;
    if (!fs.existsSync(bin)) { this.emit('tunnel', { error: 'This copy of Rolling Desk has no tunnel program (cloudflared), so guests can\'t reach you' }); return; }
    // an empty config, so a cloudflared set up for something else on this computer can't get in the way
    const cfg = path.join(path.dirname(this.secretsFile), 'cloudflared-empty.yml');
    fs.writeFileSync(cfg, '# Rolling Desk quick tunnel — deliberately empty\n{}\n');
    const t = spawn(bin, ['tunnel', '--no-autoupdate', '--config', cfg, '--url', this.localUrl], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.tunnel = t;
    let found = false;
    const scan = d => {
      const text = String(d), m = !found && text.match(TUNNEL_URL);
      if (m) { found = true; this.tunnelTries = 0; this.setPublicUrl(m[0]); }
      if (/ERR|error/i.test(text)) text.split(/\r?\n/).filter(l => /ERR|error/i.test(l)).forEach(l => this.log('warn', '[tunnel] ' + l));
    };
    t.stdout.on('data', scan); t.stderr.on('data', scan);
    t.on('error', e => this.log('error', 'tunnel program failed to start', e));
    t.on('exit', code => {
      if (this.tunnel === t) this.tunnel = null;
      if (this.stopping) return;
      // try again (a new address), slowing down if it keeps failing
      const wait = Math.min(60, 2 ** this.tunnelTries++) * 1000;
      this.log('warn', `the guest link (tunnel) stopped (${code}) — trying again in ${wait / 1000} s`);
      this.emit('tunnel', { error: 'The guest link dropped — getting a new one…' });
      setTimeout(() => { if (!this.stopping && this.server) this.startTunnel(); }, wait);
    });
  }

  setPublicUrl(url) {
    const changed = this.publicUrl && this.publicUrl !== url;
    this.publicUrl = url;
    if (this.server && this.server.connected) this.server.send({ publicUrl: url });
    this.emit('tunnel', { url, changed });
    this.reachable(url).then(ok => this.emit('tunnel', { url, ready: ok, changed: false })).catch(e => this.log('warn', 'tunnel check', e));
  }

  // a new quick-tunnel address takes a few seconds to work everywhere
  async reachable(url, ms = 60000) {
    const until = Date.now() + ms;
    let why = '';
    while (Date.now() < until && this.publicUrl === url) {
      try { const r = await fetch(url + '/api/info', { signal: AbortSignal.timeout(5000) }); if (r.ok) return true; why = `answered ${r.status}`; }
      catch (e) { why = e.message; }
      await new Promise(r => setTimeout(r, 2000));
    }
    if (this.publicUrl === url) this.log('warn', `the guest link ${url} isn't reachable from here yet (${why}) — it usually starts working within a minute`);
    return false;
  }

  // ---------- while running ----------
  /** Is anyone recording, or are files still being made? (so closing the app doesn't cut a show off) */
  async busy() {
    if (!this.server) return null;
    try {
      const login = await fetch(this.localUrl + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: this.password }), signal: AbortSignal.timeout(5000) });
      const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
      const r = await fetch(this.localUrl + '/api/rooms', { headers: { cookie }, signal: AbortSignal.timeout(5000) });
      if (!r.ok) throw new Error(`studio answered ${r.status}`);
      const { rooms } = await r.json();
      const rec = rooms.filter(x => x.recording).map(x => x.name);
      const making = rooms.flatMap(x => x.takes.filter(t => ['waiting', 'queued', 'processing'].includes(t.status)).map(() => x.name)); // still uploading or being made
      const online = rooms.reduce((n, x) => n + ((x.online && x.online.length) || 0), 0);
      return { recording: rec, processing: making, online };
    } catch (e) { this.log('warn', 'could not ask the studio whether it is busy', e); return { unknown: true }; }
  }

  stop() {
    this.stopping = true;
    for (const p of [this.tunnel, this.server]) if (p) try { p.kill(); } catch (e) { this.log('warn', 'stopping', e); }
    this.tunnel = null; this.server = null;
  }
}

module.exports = { LocalStudio, toolPaths, TUNNEL_URL };
