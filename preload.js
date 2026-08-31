const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ddasAPI', {
  openImage: () => ipcRenderer.invoke('dialog:openImage'),
  openCsv: () => ipcRenderer.invoke('dialog:openCsv'),
  openTle: () => ipcRenderer.invoke('dialog:openTle'),
  saveLog: (content) => ipcRenderer.invoke('fs:saveLog', content),
  getInfo: () => ipcRenderer.invoke('app:getInfo'),
  getTexturePaths: () => ipcRenderer.invoke('app:getTexturePaths')
});