'use strict';
/*
 * Rolling Desk's own diary: what it did (the steps) and any errors, so a problem can be explained afterwards.
 *
 *   activity.log           every step and error, newest at the bottom (kept to about 2 MB, plus one older file)
 *   crash-<when>.txt       written the moment something goes badly wrong: the error, and the steps just before it
 *   problem report         Help › Save a problem report… — one file to send: versions, recent crashes, the last
 *                          steps, and the end of the studio's own log
 *
 * Everything written is tidied first (scrub): no host keys, tunnel tokens, passwords, email addresses or your
 * computer's user name — so a report is safe to share on Discord or email.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_LOG = 2 * 1024 * 1024, KEEP_STEPS = 300, KEEP_CRASHES = 10;

/** Removes anything private from a line of text before it's written or shared. */
function scrub(text) {
  const home = os.homedir();
  let s = String(text == null ? '' : text);
  if (home && home.length > 2) s = s.split(home).join('~');
  return s
    .replace(/([?&](k|key|token|password|pass|secret)=)[^&\s#"']+/gi, '$1<hidden>')            // links with keys
    .replace(/\b(TUNNEL_TOKEN|ADMIN_PASSWORD|SECRET|token|password)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2<hidden>')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}={0,2}/g, '<token>')                                        // Cloudflare tokens and similar
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '<long code>')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>')
    .replace(/(\/Users\/|\/home\/|[A-Z]:\\Users\\)[^/\\\s]+/g, '$1<user>');
}

class Activity {
  /** @param {{ dir: string, version: string }} o  dir = the app's settings folder */
  constructor({ dir, version }) {
    this.dir = dir; this.version = version; this.steps = [];
    this.file = path.join(dir, 'activity.log');
    fs.mkdirSync(dir, { recursive: true });
  }
  stamp() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

  /** One thing the app did (or noticed). level: step | warn | error */
  step(text, level = 'step') {
    const line = `${this.stamp()}  ${level === 'step' ? '     ' : level.toUpperCase().padEnd(5)}  ${scrub(text).replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 600)}`;
    this.steps.push(line);
    if (this.steps.length > KEEP_STEPS) this.steps.shift();
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_LOG) fs.renameSync(this.file, path.join(this.dir, 'activity.old.log'));
      fs.appendFileSync(this.file, line + '\n');
    } catch (e) { process.stderr.write(`[warn] activity log: ${e.message}\n`); } // the diary must never be the thing that breaks the app
  }

  /** Something went badly wrong: write a crash file with the error and the steps that led to it. Returns its path. */
  crash(where, err) {
    const e = err instanceof Error ? err : new Error(String(err));
    this.step(`${where}: ${e.message}`, 'error');
    const name = `crash-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.txt`, file = path.join(this.dir, name);
    const text = [
      `Rolling Desk ${this.version} — something went wrong`, `When:  ${this.stamp()}`, `Where: ${where}`, `Computer: ${this.system()}`, '',
      'ERROR', scrub(e.stack || e.message), '',
      `WHAT HAPPENED JUST BEFORE (last ${Math.min(60, this.steps.length)} steps)`, ...this.steps.slice(-60), '',
    ].join('\n');
    try {
      fs.writeFileSync(file, text);
      const old = fs.readdirSync(this.dir).filter(f => /^crash-.*\.txt$/.test(f)).sort();
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_CRASHES))) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch (we) { process.stderr.write(`[warn] crash file: ${we.message}\n`); return null; }
    return file;
  }

  system() { return `${process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux'} ${os.release()} (${process.arch}), ${Math.round(os.totalmem() / 1024 ** 3)} GB memory`; }

  /** Everything useful in one shareable file. extra: { mode, studioLog } */
  report({ mode = '', studioLog = '' } = {}) {
    const crashes = fs.readdirSync(this.dir).filter(f => /^crash-.*\.txt$/.test(f)).sort().slice(-3);
    const tail = (file, n) => { try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-n).map(scrub); } catch { return []; } };
    return [
      'ROLLING DESK — PROBLEM REPORT',
      'Safe to share: keys, tokens, passwords, email addresses and your user name have been removed.', '',
      `Version:  ${this.version}`, `Computer: ${this.system()}`, `Using:    ${mode || 'start screen'}`, `Saved:    ${this.stamp()}`, '',
      `RECENT CRASHES (${crashes.length})`, ...(crashes.length ? crashes.flatMap(f => ['', `----- ${f} -----`, ...tail(path.join(this.dir, f), 200)]) : ['none']), '',
      'LAST STEPS', ...tail(this.file, 200), '',
      ...(studioLog ? ['END OF THE STUDIO\'S LOG (hosting on this computer)', ...tail(studioLog, 120), ''] : []),
    ].join('\n');
  }
}

module.exports = { Activity, scrub };
