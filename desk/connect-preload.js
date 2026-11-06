'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  connect: (link, folder) => ipcRenderer.invoke('desk:connect', { link, folder }),
  host: folder => ipcRenderer.invoke('desk:host', { folder }),
  pickFolder: title => ipcRenderer.invoke('desk:pick-folder', title),
});
