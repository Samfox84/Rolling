'use strict';
// Downloads the programs the app carries for "Host it on this computer" into desk/vendor/tools. Runs on GitHub's
// build machines (see .github/workflows/desk.yml):
//   ffmpeg + ffprobe  static builds from github.com/eugeneware/ffmpeg-static (release b6.0)
//   cloudflared       the guest link, from github.com/cloudflare/cloudflared (latest release)
// The transcript engine (whisper.cpp) and its speech model are built/downloaded by the workflow itself.
// Usage: node scripts/fetch-tools.js <darwin|linux|win32> <x64|arm64>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const [platform = process.platform, arch = process.arch] = process.argv.slice(2);
const dir = path.join(__dirname, '..', 'vendor', 'tools'), exe = platform === 'win32' ? '.exe' : '';
const FF = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0';
const CF = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
const cfName = { 'darwin-x64': 'cloudflared-darwin-amd64.tgz', 'darwin-arm64': 'cloudflared-darwin-arm64.tgz', 'linux-x64': 'cloudflared-linux-amd64', 'win32-x64': 'cloudflared-windows-amd64.exe' }[`${platform}-${arch}`];
if (!cfName) throw new Error(`no tools for ${platform}-${arch}`);

async function get(url) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i >= 3) throw new Error(`download failed: ${url} (${e.message})`);
      console.warn(`retrying ${url}: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
}
const save = (name, buf) => { const p = path.join(dir, name); fs.writeFileSync(p, buf); fs.chmodSync(p, 0o755); console.log(`${name}: ${(buf.length / 1048576).toFixed(1)} MB`); return p; };

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of ['ffmpeg', 'ffprobe']) save(t + exe, zlib.gunzipSync(await get(`${FF}/${t}-${platform}-${arch}.gz`)));
  const cf = await get(`${CF}/${cfName}`);
  if (cfName.endsWith('.tgz')) {
    const tgz = save('cloudflared.tgz', cf);
    execFileSync('tar', ['xzf', tgz, '-C', dir]); fs.rmSync(tgz); fs.chmodSync(path.join(dir, 'cloudflared'), 0o755);
  } else save('cloudflared' + exe, cf);
  // each one must actually run (the build machine is the same kind of computer as the app it builds)
  if (platform === process.platform && arch === process.arch) {
    for (const [t, args] of [['ffmpeg', ['-version']], ['ffprobe', ['-version']], ['cloudflared', ['--version']]]) {
      console.log(String(execFileSync(path.join(dir, t + exe), args)).split('\n')[0]);
    }
  }
})().catch(e => { console.error(e.message); process.exit(1); });
