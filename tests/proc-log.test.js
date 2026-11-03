'use strict';
// proc.js (the one program runner) and log.js (the one logger).
const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../proc');
const log = require('../log');

test('run returns stdout text on success', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdout.write("hello")']);
  assert.equal(r.code, 0); assert.equal(r.stdout, 'hello');
});
test('run rejects with the program\'s own error message on failure', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("disk full"); process.exit(3)']), /disk full/);
});
test('run with allowFail resolves and reports the exit code', async () => {
  const r = await run(process.execPath, ['-e', 'process.exit(4)'], { allowFail: true });
  assert.equal(r.code, 4);
});
test('run kills a program that runs past its timeout (no hang)', async () => {
  const t0 = Date.now();
  await assert.rejects(run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 }));
  assert.ok(Date.now() - t0 < 5000);
});
test('run rejects clearly when the program does not exist', async () => {
  await assert.rejects(run('/no/such/program', []), /could not (run|start)/);
});
test('run streams stdout to onStdout (used for ffmpeg progress)', async () => {
  const seen = [];
  await run(process.execPath, ['-e', 'process.stdout.write("a"); process.stdout.write("b")'], { stdout: 'ignore', onStdout: d => seen.push(String(d)) });
  assert.equal(seen.join(''), 'ab');
});
test('run returns a Buffer when asked (binary audio)', async () => {
  const r = await run(process.execPath, ['-e', 'process.stdout.write(Buffer.from([1,2,3]))'], { stdout: 'buffer' });
  assert.deepEqual([...r.stdout], [1, 2, 3]);
});
test('log.trace passes results through and rethrows errors (never swallows)', async () => {
  const ok = log.trace('test', async x => x * 2);
  assert.equal(await ok(21), 42);
  const bad = log.trace('test', async () => { throw new Error('boom'); });
  await assert.rejects(bad(), /boom/);
});
test('log.ignore returns a handler that does not throw', () => {
  assert.doesNotThrow(() => log.ignore('test', 'something')(new Error('x')));
});
