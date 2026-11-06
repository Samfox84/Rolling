'use strict';
// What the studio page can ask of the app: local-saving status and "open the folder". Nothing else.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rollingDesk', {
  onStatus(cb) { ipcRenderer.on('desk-status', (e, s) => cb(s)); ipcRenderer.invoke('desk:status').then(s => s && cb(s)); },
  openFolder() { return ipcRenderer.invoke('desk:open-folder'); },
});
