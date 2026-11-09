const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopStore', {
  get: (key) => ipcRenderer.invoke('store:get', key),
  set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  remove: (key) => ipcRenderer.invoke('store:remove', key),
});
