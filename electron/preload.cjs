const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('marginDesktop', {
  platform: process.platform,
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke('app:info'),
  embed: (texts) => ipcRenderer.invoke('embedding:embed', texts),
  modelStatus: () => ipcRenderer.invoke('embedding:status'),
  modelPrepare: () => ipcRenderer.invoke('model:prepare'),
  modelInstall: () => ipcRenderer.invoke('model:install'),
  modelPause: () => ipcRenderer.invoke('model:pause'),
  modelOpenFolder: () => ipcRenderer.invoke('model:open-folder'),
  modelUnload: () => ipcRenderer.invoke('model:unload'),
  modelRemove: () => ipcRenderer.invoke('model:remove'),
  onModelProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on('model:progress', handler);
    return () => ipcRenderer.removeListener('model:progress', handler);
  },
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryImport: (name, data) => ipcRenderer.invoke('library:import', { name, data }),
  libraryRead: (id) => ipcRenderer.invoke('library:read', id),
  libraryRemove: (id) => ipcRenderer.invoke('library:remove', id),
  libraryUpdate: (id, changes) => ipcRenderer.invoke('library:update', id, changes),
  libraryIndexSave: (id, providerId, entries) => ipcRenderer.invoke('library:index-save', id, providerId, entries),
  libraryIndexLoad: (id, providerId) => ipcRenderer.invoke('library:index-load', id, providerId),
});
