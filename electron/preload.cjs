const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('marginDesktop', {
  platform: process.platform,
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke('app:info'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  logEvent: (event, details = {}, level = 'info') => ipcRenderer.send('log:renderer', { event, details, level }),
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
  ocrRecognize: (image, language) => ipcRenderer.invoke('ocr:recognize', { image, language }),
  onOcrProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on('ocr:progress', handler);
    return () => ipcRenderer.removeListener('ocr:progress', handler);
  },
  libraryList: () => ipcRenderer.invoke('library:list'),
  libraryImport: (name, data) => ipcRenderer.invoke('library:import', { name, data }),
  libraryImportFile: async (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (filePath) return ipcRenderer.invoke('library:import-file', { name: file.name, filePath });
    return ipcRenderer.invoke('library:import', { name: file.name, data: await file.arrayBuffer() });
  },
  libraryRead: (id) => ipcRenderer.invoke('library:read', id),
  libraryRemove: (id) => ipcRenderer.invoke('library:remove', id),
  libraryUpdate: (id, changes) => ipcRenderer.invoke('library:update', id, changes),
  libraryIndexOpen: (id, providerId) => ipcRenderer.invoke('library:index-open', id, providerId),
  libraryIndexStart: (id, providerId, dimensions) => ipcRenderer.invoke('library:index-start', id, providerId, dimensions),
  libraryIndexAppend: (id, entries) => ipcRenderer.invoke('library:index-append', id, entries),
  libraryIndexFinish: (id) => ipcRenderer.invoke('library:index-finish', id),
  libraryIndexCancel: (id) => ipcRenderer.invoke('library:index-cancel', id),
  libraryIndexSearch: (id, providerId, vector, limit) => ipcRenderer.invoke('library:index-search', id, providerId, vector, limit),
});

window.addEventListener('error', (event) => {
  ipcRenderer.send('log:renderer', { event: 'window-error', level: 'error', details: { message: event.message, filename: event.filename, line: event.lineno, column: event.colno } });
});
window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.send('log:renderer', { event: 'unhandled-rejection', level: 'error', details: { message: event.reason instanceof Error ? event.reason.message : String(event.reason) } });
});
