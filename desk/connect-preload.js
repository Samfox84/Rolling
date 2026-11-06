'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desk', {
  connect: (link, folder) => ipcRenderer.invoke('desk:connect', { link, folder }),
  pickFolder: () => ipcRenderer.invoke('desk:pick-folder'),
});
