#!/usr/bin/env node
'use strict';
// Stands in for cloudflared in tests: says it made a quick tunnel (like the real one does, on stderr), records how it
// was started, and keeps running until it's stopped.
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('cloudflared version 0000.0.0 (fake for tests)'); process.exit(0); }
if (process.env.FAKE_TUNNEL_LOG) fs.appendFileSync(process.env.FAKE_TUNNEL_LOG, JSON.stringify({ pid: process.pid, args }) + '\n');
process.stderr.write('2026-11-06T20:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...\n');
setTimeout(() => {
  process.stderr.write('2026-11-06T20:00:01Z INF +--------------------------------------------------------------------------------------------+\n');
  process.stderr.write(`2026-11-06T20:00:01Z INF |  https://${process.env.FAKE_TUNNEL_NAME || 'rolling-test'}.trycloudflare.com                                          |\n`);
  process.stderr.write('2026-11-06T20:00:01Z INF +--------------------------------------------------------------------------------------------+\n');
}, 300);
setInterval(() => {}, 1 << 30);
