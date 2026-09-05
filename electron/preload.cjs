const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marginDesktop', {
  platform: process.platform,
  isDesktop: true,
  embed: (texts) => ipcRenderer.invoke('embedding:embed', texts),
  modelStatus: () => ipcRenderer.invoke('embedding:status'),
});
