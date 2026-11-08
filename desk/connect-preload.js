'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  connect: (link, folder, remember) => ipcRenderer.invoke('desk:connect', { link, folder, remember }),
  host: (folder, link, remember) => ipcRenderer.invoke('desk:host', { folder, link, remember }),
  space: folder => ipcRenderer.invoke('desk:space', folder),
  openLink: url => ipcRenderer.invoke('desk:open-link', url),
  pickFolder: title => ipcRenderer.invoke('desk:pick-folder', title),
});
