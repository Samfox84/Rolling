'use strict';
/*
 * Rolling Desk — keeps itself up to date from the project's GitHub Releases (the latest "desk-vX.Y.Z" release).
 *
 *  • Mac: downloads the new app (.zip) itself, checks its fingerprint against the release's SHA256SUMS.txt,
 *    and swaps it in when you choose "Restart". Because the app downloads it (not a browser), macOS doesn't
 *    quarantine it, so this works without paying Apple for signing.
 *  • Linux AppImage: the same, replacing the AppImage file.
 *  • Windows: downloads and checks the new installer, then runs it silently once the app has quit, and it opens the
 *    new version (the installer keeps your settings and installs to the same place).
 *  • Linux .deb (installed in /opt): downloads and checks the new .deb, then installs it with your password (the
 *    usual Ubuntu password box, via pkexec) and reopens the app.
 *  • Anything else (an app it can't write over): tells you a new version is out and opens the page.
 * Never restarts on its own: main.js only offers it when nothing is recording or saving.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');

const REPO = 'Samfox84/Rolling';
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`; // safe inside a shell script

class Updater extends EventEmitter {
  constructor({ current, workDir, platform = process.platform, arch = process.arch, execPath = process.execPath, appImage = process.env.APPIMAGE,
    api = 'https://api.github.com', repo = REPO, log = () => {}, pkexec = 'pkexec' }) {
    super();
    Object.assign(this, { current, workDir, platform, arch, execPath, appImage, api, repo, log, pkexec });
    this.ready = null; // { version, path, page } once downloaded and checked
  }
  /** 'mac' | 'appimage' | 'windows' | 'deb' | 'manual' */
  kind() {
    if (this.platform === 'darwin' && /\.app\/Contents\/MacOS\//.test(this.execPath)) return 'mac';
    if (this.platform === 'linux' && this.appImage) return 'appimage';
    if (this.platform === 'win32' && /\.exe$/i.test(this.execPath) && !/electron\.exe$/i.test(this.execPath)) return 'windows';
    if (this.platform === 'linux' && this.execPath.startsWith('/opt/')) return 'deb'; // where the .deb installs it
    return 'manual';
  }
  target() { return this.kind() === 'mac' ? this.execPath.replace(/(\.app)\/Contents\/MacOS\/.*$/, '$1') : this.kind() === 'windows' ? this.execPath : this.appImage; }
  canReplace() {
    if (this.kind() === 'deb') return true; // installed with your password, not by writing over the files
    try { fs.accessSync(path.dirname(this.target()), fs.constants.W_OK); return true; } catch { return false; }
  }

  /** newest desk release, or null if this is the newest */
  async check() {
    // GitHub's "latest release" = the most recently published one, so renumbering (e.g. 1.0 → 0.1) can't trap anyone on an old number
    const res = await fetch(`${this.api}/repos/${this.repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Rolling-Desk' }, signal: AbortSignal.timeout(20000) });
    if (res.status === 404) throw new Error('Updates need the Rolling project on GitHub to be public');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const r = await res.json();
    if (!/^desk-v\d+\.\d+\.\d+$/.test(r.tag_name || '')) return null;
    r.version = r.tag_name.slice(6);
    if (r.version === this.current) return null;
    const want = { mac: new RegExp(`-mac-${this.arch}\\.zip$`), appimage: /\.AppImage$/, windows: new RegExp(`-win-${this.arch}\\.exe$`), deb: new RegExp(`-${this.arch === 'arm64' ? 'arm64' : 'amd64'}\\.deb$`) }[this.kind()] || null;
    return { version: r.version, page: r.html_url, notes: r.body || '', asset: want && r.assets.find(a => want.test(a.name)), sums: r.assets.find(a => a.name === 'SHA256SUMS.txt') };
  }

  /** download + check the new version (Mac / AppImage). Resolves to this.ready */
  async download(info) {
    if (!info.asset || !info.sums) throw new Error('This release has no download for this computer');
    if (!this.canReplace()) throw new Error(`Can't write to ${path.dirname(this.target())}`);
    const dir = path.join(this.workDir, 'update-' + info.version);
    await fsp.rm(dir, { recursive: true, force: true }); await fsp.mkdir(dir, { recursive: true });
    const sums = await (await this.fetchOk(info.sums.browser_download_url, 30000)).text();
    const line = sums.split('\n').find(l => l.trim().endsWith(' ' + info.asset.name) || l.trim().endsWith('*' + info.asset.name));
    if (!line) throw new Error(`${info.asset.name} isn't in the release's checksum list`);
    const expected = line.trim().split(/\s+/)[0].toLowerCase();
    const file = path.join(dir, info.asset.name), hash = crypto.createHash('sha256');
    const res = await this.fetchOk(info.asset.browser_download_url, 30 * 60 * 1000);
    const out = fs.createWriteStream(file);
    // 'progress' {version, done, total} for the progress bar: a few times a second, and once at the end
    const total = Number(res.headers.get('content-length')) || info.asset.size || 0;
    let done = 0, last = 0;
    const progress = () => this.emit('progress', { version: info.version, done, total });
    progress();
    for await (const chunk of res.body) {
      hash.update(chunk); done += chunk.length;
      if (Date.now() - last > 200) { last = Date.now(); progress(); }
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
    }
    await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
    progress();
    this.emit('checking', { version: info.version });
    const got = hash.digest('hex');
    if (got !== expected) { await fsp.rm(dir, { recursive: true, force: true }); throw new Error('The download was damaged (fingerprint didn\'t match) — it will try again later'); }
    let ready = file;
    if (this.kind() === 'mac') {
      await new Promise((r, j) => execFile('/usr/bin/ditto', ['-x', '-k', file, path.join(dir, 'app')], e => (e ? j(e) : r())));
      const app = (await fsp.readdir(path.join(dir, 'app'))).find(f => f.endsWith('.app'));
      if (!app) throw new Error('The downloaded update had no app inside');
      ready = path.join(dir, 'app', app);
    } else if (this.kind() !== 'windows' && this.kind() !== 'deb') await fsp.chmod(file, 0o755);
    this.ready = { version: info.version, path: ready, page: info.page };
    this.emit('ready', this.ready);
    return this.ready;
  }
  async fetchOk(url, ms) { const r = await fetch(url, { headers: { 'User-Agent': 'Rolling-Desk' }, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`download ${r.status}`); return r; }

  /** the script that swaps the app in once this one has quit, then opens the new one (rolls back if the swap fails) */
  script(pid = process.pid) {
    const oldP = this.target(), newP = this.ready.path, bak = oldP + '.old';
    return ['#!/bin/sh',
      `while kill -0 ${pid} 2>/dev/null; do sleep 0.3; done`,
      `rm -rf ${q(bak)}`,
      `if mv ${q(oldP)} ${q(bak)} && mv ${q(newP)} ${q(oldP)}; then rm -rf ${q(bak)}; else [ -e ${q(bak)} ] && [ ! -e ${q(oldP)} ] && mv ${q(bak)} ${q(oldP)}; fi`,
      ...(this.kind() === 'mac' ? [`xattr -dr com.apple.quarantine ${q(oldP)} 2>/dev/null`, `open ${q(oldP)}`] : [`chmod 755 ${q(oldP)}`, `nohup ${q(oldP)} >/dev/null 2>&1 &`]),
      ''].join('\n');
  }
  /** Windows: wait for the app to quit, run the new installer silently, and open the new version (--force-run) */
  windowsScript(pid = process.pid) {
    const exe = this.ready.path;
    if (/["%^&|<>]/.test(exe)) throw new Error(`Can't run the installer from ${exe}`);
    return ['@echo off',
      ':wait',
      `tasklist /FI "PID eq ${Number(pid)}" /NH | find "${Number(pid)}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      `"${exe}" /S --force-run`,
      ''].join('\r\n');
  }
  /** .deb: install the downloaded package with the usual password box (pkexec). Resolves when installed. */
  installDeb() {
    if (!this.ready || this.kind() !== 'deb') return Promise.reject(new Error('No .deb update downloaded'));
    return new Promise((resolve, reject) => {
      const p = spawn(this.pkexec, ['apt-get', 'install', '-y', '--allow-downgrades', this.ready.path], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; });
      p.on('error', e => reject(new Error(e.code === 'ENOENT' ? `This computer can't ask for your password here. Install it in a terminal instead: sudo apt install ${this.ready.path}` : e.message)));
      p.on('exit', code => {
        if (code === 0) return resolve();
        if (code === 126 || code === 127) return reject(new Error('Cancelled — the update wasn\'t installed'));
        reject(new Error(`The install didn't finish (${code}): ${out.trim().split('\n').slice(-2).join(' ')}`));
      });
    });
  }
  /** start the swap; the caller then quits the app */
  apply(pid = process.pid) {
    if (!this.ready) throw new Error('No update downloaded');
    if (this.kind() === 'windows') {
      const w = path.join(this.workDir, 'apply-update.cmd');
      fs.writeFileSync(w, this.windowsScript(pid));
      spawn('cmd.exe', ['/d', '/c', w], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return;
    }
    const s = path.join(this.workDir, 'apply-update.sh');
    fs.writeFileSync(s, this.script(pid), { mode: 0o755 });
    spawn('/bin/sh', [s], { detached: true, stdio: 'ignore' }).unref();
  }
}
module.exports = { Updater };
