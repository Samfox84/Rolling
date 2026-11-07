'use strict';
// After electron-builder: starts the studio from inside the packaged app, exactly as "Host it on this computer"
// does, and checks it answers — and that the bundled tools are there. A build that fails this is never published.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
const find = () => {
  for (const d of fs.readdirSync(dist)) {
    const p = path.join(dist, d);
    if (d.startsWith('mac')) return { bin: path.join(p, 'Rolling Desk.app', 'Contents', 'MacOS', 'Rolling Desk'), res: path.join(p, 'Rolling Desk.app', 'Contents', 'Resources') };
    if (d === 'win-unpacked') return { bin: path.join(p, 'Rolling Desk.exe'), res: path.join(p, 'resources') };
    if (d === 'linux-unpacked') return { bin: path.join(p, 'rolling-desk'), res: path.join(p, 'resources') };
  }
  throw new Error(`no packaged app in ${dist}`);
};

(async () => {
  const { bin, res } = find(), exe = process.platform === 'win32' ? '.exe' : '';
  for (const t of ['ffmpeg', 'ffprobe', 'cloudflared', 'whisper-cli']) if (!fs.existsSync(path.join(res, 'tools', t + exe))) throw new Error(`the app is missing ${t}`);
  if (!(fs.statSync(path.join(res, 'tools', 'models', 'ggml-base.en.bin')).size > 1e8)) throw new Error('the app is missing the speech model');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'rolling-check-')), port = 18000 + Math.floor(Math.random() * 1000);
  const p = spawn(bin, [path.join(res, 'app', 'studio', 'server.js')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), BIND: '127.0.0.1', DATA_DIR: data, ADMIN_PASSWORD: 'check', SECRET: 'check', NO_EXTERNAL_CALLS: '1', FFMPEG: path.join(res, 'tools', 'ffmpeg' + exe), FFPROBE: path.join(res, 'tools', 'ffprobe' + exe) } });
  let log = ''; p.stdout.on('data', d => { log += d; }); p.stderr.on('data', d => { log += d; });
  const until = Date.now() + 30000;
  try {
    for (;;) {
      if (p.exitCode !== null) throw new Error(`the studio stopped (${p.exitCode}):\n${log}`);
      try { const r = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(2000) }); if (r.ok) { console.log('studio inside the app answers:', await r.text()); break; } }
      catch (e) { if (Date.now() > until) throw new Error(`the studio inside the app didn't answer (${e.message}):\n${log}`); }
      await new Promise(r => setTimeout(r, 500));
    }
  } finally { p.kill(); }
})().catch(e => { console.error(e.message); process.exit(1); });
