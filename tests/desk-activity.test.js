'use strict';
// Rolling Desk's diary: steps and errors are written down, a crash file shows what led up to it, and a problem
// report is safe to share (nothing private in it).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Activity, scrub } = require('../desk/activity');
const { tmpDir } = require('./helpers');

test('scrub removes everything private and keeps the useful part', () => {
  const home = os.homedir();
  const out = scrub(`opened https://podcast.example.com/r/abc?k=SuperSecretHostKey1 from ${home}/Rolling Studio, mail sam@example.com, TUNNEL_TOKEN=eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQabcdefghij password: hunter2 /Users/simon/x C:\\Users\\Simon\\y`);
  for (const secret of ['SuperSecretHostKey1', 'sam@example.com', 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwifQabcdefghij', 'hunter2', '/Users/simon', 'Users\\Simon', home]) assert.ok(!out.includes(secret), `${secret} left in: ${out}`);
  assert.match(out, /podcast\.example\.com\/r\/abc\?k=<hidden>/);
  assert.match(out, /~\/Rolling Studio/);
});

test('crash file: the error and the steps just before it; old crash files are tidied away', () => {
  const dir = tmpDir('activity'), a = new Activity({ dir, version: '9.9.9' });
  a.step('start screen'); a.step('hosting on this computer'); a.step('pressed "Start recording" (#recBtn)');
  const file = a.crash('the studio window', new Error('the page stopped (crashed)'));
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /Rolling Desk 9\.9\.9 — something went wrong/);
  assert.match(text, /Where: the studio window/);
  assert.match(text, /the page stopped \(crashed\)/);
  assert.ok(text.indexOf('start screen') < text.indexOf('pressed "Start recording"'), 'steps in order');
  assert.match(fs.readFileSync(path.join(dir, 'activity.log'), 'utf8'), /ERROR  the studio window: the page stopped/);
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `crash-2026-01-01-00-00-${String(i).padStart(2, '0')}.txt`), 'old');
  a.crash('again', new Error('x'));
  assert.equal(fs.readdirSync(dir).filter(f => f.startsWith('crash-')).length, 10, 'only the latest 10 kept');
});

test('problem report: versions, recent crashes, last steps and the studio log — nothing private', () => {
  const dir = tmpDir('activity-report'), a = new Activity({ dir, version: '9.9.9' });
  a.step(`connecting with https://studio.example.com/r/room1?k=HostKey123456 from ${os.homedir()}`);
  a.crash('the app', new Error('boom'));
  const studioLog = path.join(dir, 'studio.log');
  fs.writeFileSync(studioLog, '[info] [rec] take 1 started\n[error] [treat] ffmpeg failed: TUNNEL_TOKEN=abcdefabcdefabcdefabcdefabcdefabcdefabcdef\n');
  const rep = a.report({ mode: 'hosting on this computer', studioLog });
  assert.match(rep, /Version:  9\.9\.9/); assert.match(rep, /RECENT CRASHES \(1\)/); assert.match(rep, /boom/);
  assert.match(rep, /LAST STEPS/); assert.match(rep, /ffmpeg failed/);
  for (const secret of ['HostKey123456', 'abcdefabcdefabcdefabcdefabcdefabcdefabcdef', os.homedir()]) assert.ok(!rep.includes(secret), `${secret} in the report`);
});

test('the log stays a sensible size (old part kept in activity.old.log)', () => {
  const dir = tmpDir('activity-rotate'), a = new Activity({ dir, version: '1' });
  fs.writeFileSync(a.file, 'x'.repeat(2 * 1024 * 1024 + 10));
  a.step('next');
  assert.ok(fs.existsSync(path.join(dir, 'activity.old.log')));
  assert.ok(fs.statSync(a.file).size < 1000);
});
