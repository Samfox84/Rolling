'use strict';
/*
 * Rolling — the one logger. Every module logs through here (no bare console calls), so the
 * journal (journalctl -u podcast-studio) always shows what happened, when, and how long it took.
 *
 *   LOG_LEVEL=debug|info|warn|error   (default info)
 *
 * trace(scope, fn) wraps a pipeline function with ENTER / EXIT (with elapsed time) / EXCEPTION lines.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

function fmt(v) {
  if (v instanceof Error) return v.message;
  if (typeof v === 'object' && v !== null) { try { return JSON.stringify(v); } catch (e) { return String(v); } }
  return String(v);
}
function write(level, scope, msg, extra) {
  if (LEVELS[level] < threshold) return;
  const line = `[${level}] [${scope}] ${msg}${extra === undefined ? '' : ' ' + fmt(extra)}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
const log = {
  debug: (scope, msg, extra) => write('debug', scope, msg, extra),
  info: (scope, msg, extra) => write('info', scope, msg, extra),
  warn: (scope, msg, extra) => write('warn', scope, msg, extra),
  error: (scope, msg, extra) => write('error', scope, msg, extra),
  /** Wrap an async function so every call logs ENTER, EXIT (elapsed) or EXCEPTION, then rethrows. */
  trace(scope, fn) {
    return async function traced(...args) {
      const t0 = Date.now();
      write('debug', scope, 'ENTER');
      try {
        const r = await fn.apply(this, args);
        write('debug', scope, `EXIT ${((Date.now() - t0) / 1000).toFixed(2)}s`);
        return r;
      } catch (e) {
        write('error', scope, `EXCEPTION after ${((Date.now() - t0) / 1000).toFixed(2)}s:`, e);
        throw e;
      }
    };
  },
  /** For failures that are expected and harmless (e.g. closing an already-closed socket): logged at debug, never silent. */
  ignore: (scope, what) => e => write('debug', scope, `ignored (${what}):`, e),
};
module.exports = log;
