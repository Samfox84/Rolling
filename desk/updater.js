'use strict';
/*
 * Rolling Desk — keeps itself up to date from the project's GitHub Releases (the latest "desk-vX.Y.Z" release).
 *
 *  • Mac: downloads the new app (.zip) itself, checks its fingerprint against the release's SHA256SUMS.txt,
 *    and swaps it in when you choose "Restart". Because the app downloads it (not a browser), macOS doesn't
 *    quarantine it, so this works without paying Apple for signing.
 *  • Linux AppImage: the same, replacing the AppImage file.
 *  • Anything else (the .deb, or an app it can't write over): tells you a new version is out and opens the page.
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
    api = 'https://api.github.com', repo = REPO, log = () => {} }) {
    super();
    Object.assign(this, { current, workDir, platform, arch, execPath, appImage, api, repo, log });
    this.ready = null; // { version, path, page } once downloaded and checked
  }
  /** 'mac' | 'appimage' | 'manual' */
  kind() {
    if (this.platform === 'darwin' && /\.app\/Contents\/MacOS\//.test(this.execPath)) return 'mac';
    if (this.platform === 'linux' && this.appImage) return 'appimage';
    return 'manual';
  }
  target() { return this.kind() === 'mac' ? this.execPath.replace(/(\.app)\/Contents\/MacOS\/.*$/, '$1') : this.appImage; }
  canReplace() { try { fs.accessSync(path.dirname(this.target()), fs.constants.W_OK); return true; } catch { return false; } }

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
    const want = this.kind() === 'mac' ? new RegExp(`-mac-${this.arch}\\.zip$`) : this.kind() === 'appimage' ? /\.AppImage$/ : null;
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
    for await (const chunk of res.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise(r => out.once('drain', r)); }
    await new Promise((r, j) => out.end(e => (e ? j(e) : r())));
    const got = hash.digest('hex');
    if (got !== expected) { await fsp.rm(dir, { recursive: true, force: true }); throw new Error('The download was damaged (fingerprint didn\'t match) — it will try again later'); }
    let ready = file;
    if (this.kind() === 'mac') {
      await new Promise((r, j) => execFile('/usr/bin/ditto', ['-x', '-k', file, path.join(dir, 'app')], e => (e ? j(e) : r())));
      const app = (await fsp.readdir(path.join(dir, 'app'))).find(f => f.endsWith('.app'));
      if (!app) throw new Error('The downloaded update had no app inside');
      ready = path.join(dir, 'app', app);
    } else await fsp.chmod(file, 0o755);
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
  /** start the swap; the caller then quits the app */
  apply(pid = process.pid) {
    if (!this.ready) throw new Error('No update downloaded');
    const s = path.join(this.workDir, 'apply-update.sh');
    fs.writeFileSync(s, this.script(pid), { mode: 0o755 });
    spawn('/bin/sh', [s], { detached: true, stdio: 'ignore' }).unref();
  }
}
module.exports = { Updater };
