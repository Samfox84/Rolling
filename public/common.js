// Rolling — helpers shared by every page (one copy only: dashboard, recordings page and studio all use these).
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // small notifications that stack instead of overlapping
  function toast(text, ms = 3000) {
    let box = document.getElementById('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = text; box.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // for failures that are expected and harmless — still written to the browser console, never silent
  const quiet = what => e => console.warn('[rolling]', what, e && e.message ? e.message : e);

  /**
   * The one way pages talk to the server. Every request has a timeout.
   * api(url, { method, json, body, headers, timeout }) → { ok, status, data, error }
   * Never throws: network problems come back as { ok: false, status: 0, error }.
   */
  async function api(url, opts = {}) {
    const { method = opts.json || opts.body ? 'POST' : 'GET', json, body, headers = {}, timeout = 20000 } = opts;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method, signal: ctl.signal, cache: 'no-store',
        headers: json ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: json ? JSON.stringify(json) : body,
      });
      const type = res.headers.get('content-type') || '';
      const data = type.includes('application/json') ? await res.json().catch(() => ({ error: 'Bad reply from the server' })) : null;
      if (!res.ok) console.warn('[rolling]', method, url, res.status, data && data.error);
      return { ok: res.ok, status: res.status, data: data || {}, error: (data && data.error) || (res.ok ? '' : `Server said ${res.status}`) };
    } catch (e) {
      const error = e.name === 'AbortError' ? 'The server took too long to answer' : 'Can\'t reach the studio server';
      console.warn('[rolling]', method, url, error, e.message);
      return { ok: false, status: 0, data: {}, error };
    } finally { clearTimeout(timer); }
  }

  const fmtMB = b => (b > 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : b > 1048576 ? (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const hms = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map(x => String(Math.floor(x)).padStart(2, '0')).join(':'); };
  // browser storage can be switched off (private windows) — remembered settings are a convenience only
  const LS = { get(k) { try { return localStorage.getItem(k); } catch (e) { quiet('read saved setting')(e); return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { quiet('save setting')(e); } } };

  window.Rolling = { $, esc, toast, quiet, api, fmtMB, hms, LS };
  // the studio name on every page
  api('/api/info').then(r => { if (r.ok) { document.querySelectorAll('.studio-name').forEach(e => { e.textContent = r.data.name; }); window.Rolling.info = r.data; document.dispatchEvent(new CustomEvent('rolling-info', { detail: r.data })); } });
})();
