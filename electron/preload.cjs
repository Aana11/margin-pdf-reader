const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marginDesktop', {
  platform: process.platform,
  isDesktop: true,
  embed: (texts) => ipcRenderer.invoke('embedding:embed', texts),
  modelStatus: () => ipcRenderer.invoke('embedding:status'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryImport: (name, data) => ipcRenderer.invoke('library:import', { name, data }),
  libraryRead: (id) => ipcRenderer.invoke('library:read', id),
  libraryUpdate: (id, changes) => ipcRenderer.invoke('library:update', id, changes),
  libraryIndexSave: (id, providerId, entries) => ipcRenderer.invoke('library:index-save', id, providerId, entries),
  libraryIndexLoad: (id, providerId) => ipcRenderer.invoke('library:index-load', id, providerId),
});
