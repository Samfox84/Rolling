'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  connect: (link, folder) => ipcRenderer.invoke('desk:connect', { link, folder }),
  host: (folder, link) => ipcRenderer.invoke('desk:host', { folder, link }),
  space: folder => ipcRenderer.invoke('desk:space', folder),
  openLink: url => ipcRenderer.invoke('desk:open-link', url),
  pickFolder: title => ipcRenderer.invoke('desk:pick-folder', title),
});
