'use strict';
/*
 * Rolling — the one way to run an external program (ffmpeg, ffprobe, whisper.cpp).
 * Every call has a timeout, collects stderr for error messages, and rejects with a clear error.
 */
const { spawn } = require('child_process');
const log = require('./log');

/**
 * run(bin, args, opts) → Promise<{ code, stdout, stderr }>
 *   opts.stdout     'text' (default) | 'buffer' | 'ignore'
 *   opts.onStdout   callback(chunk: Buffer) for streaming progress
 *   opts.timeoutMs  kill the program if it runs longer (default 6 h — long video encodes)
 *   opts.allowFail  resolve instead of reject on a non-zero exit code
 *   opts.nice       run at low CPU priority (Linux `nice -n 10`)
 */
function run(bin, args, opts = {}) {
  const { stdout = 'text', onStdout, timeoutMs = 6 * 3600 * 1000, allowFail = false, nice = false } = opts;
  return new Promise((resolve, reject) => {
    const cmd = nice ? '/usr/bin/nice' : bin, argv = nice ? ['-n', '10', bin, ...args] : args;
    let p;
    try { p = spawn(cmd, argv, { stdio: ['ignore', stdout === 'ignore' && !onStdout ? 'ignore' : 'pipe', 'pipe'] }); }
    catch (e) { reject(new Error(`could not start ${bin}: ${e.message}`)); return; }
    const out = [];
    let err = '', done = false;
    const timer = setTimeout(() => { if (!done) { log.warn('proc', `${bin} timed out after ${Math.round(timeoutMs / 1000)}s — stopping it`); p.kill('SIGKILL'); } }, timeoutMs);
    if (p.stdout) p.stdout.on('data', d => { if (onStdout) onStdout(d); if (stdout !== 'ignore') out.push(d); });
    p.stderr.on('data', d => { err += d; if (err.length > 16000) err = err.slice(-16000); });
    p.on('error', e => { done = true; clearTimeout(timer); reject(new Error(`could not run ${bin}: ${e.message}`)); });
    p.on('close', (code, signal) => {
      if (done) return;
      done = true; clearTimeout(timer);
      const buf = Buffer.concat(out);
      const res = { code, stdout: stdout === 'buffer' ? buf : buf.toString('utf8'), stderr: err };
      if (code === 0 || allowFail) resolve(res);
      else reject(new Error((err.trim().split('\n').slice(-6).join('\n')) || `${bin} exited with ${signal || code}`));
    });
  });
}
module.exports = { run };
