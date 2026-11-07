'use strict';
// What the studio page can ask of the app: local-saving status and "open the folder". Nothing else.
// It also tells the app's diary (activity.js) which buttons were pressed, so a problem report shows what
// happened just before.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rollingDesk', {
  onStatus(cb) { ipcRenderer.on('desk-status', (e, s) => cb(s)); ipcRenderer.invoke('desk:status').then(s => s && cb(s)); },
  openFolder() { return ipcRenderer.invoke('desk:open-folder'); },
});

// the diary: buttons pressed (their label only, never anything typed). Page errors are caught by main.js.
const label = el => (el.getAttribute('aria-label') || el.title || el.textContent || el.id || '').replace(/\s+/g, ' ').trim().slice(0, 40);
window.addEventListener('click', e => {
  const b = e.target && e.target.closest && e.target.closest('button, [role=button], summary, a');
  if (b) ipcRenderer.send('desk:step', `pressed "${label(b)}"${b.id ? ` (#${b.id})` : ''}`);
}, true);
window.addEventListener('keydown', e => { if (/^F\d+$/.test(e.key) || ((e.ctrlKey || e.metaKey) && e.key.length === 1)) ipcRenderer.send('desk:step', `key ${e.ctrlKey || e.metaKey ? 'Ctrl/Cmd+' : ''}${e.key}`); }, true);
