const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHub', {
  isApp: true,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
