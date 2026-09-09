const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('marginDesktop', {
  platform: process.platform,
  isDesktop: true,
  appInfo: () => ipcRenderer.invoke('app:info'),
  openLogs: () => ipcRenderer.invoke('logs:open'),
  logEvent: (event, details = {}, level = 'info') =>
    ipcRenderer.send('log:renderer', { event, details, level }),
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
  ocrRecognize: (image, language, page, pixelWidth, pixelHeight) =>
    ipcRenderer.invoke('ocr:recognize', {
      image,
      language,
      page,
      pixelWidth,
      pixelHeight,
    }),
  onOcrProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on('ocr:progress', handler);
    return () => ipcRenderer.removeListener('ocr:progress', handler);
  },
  glmOcrStatus: (config) => ipcRenderer.invoke('glm:status', config),
  glmOcrPrepare: (config) => ipcRenderer.invoke('glm:prepare', config),
  glmOcrRecognize: (payload) => ipcRenderer.invoke('glm:recognize', payload),
  glmOcrUnload: (config) => ipcRenderer.invoke('glm:unload', config),
  glmOcrPause: () => ipcRenderer.invoke('glm:pause'),
  glmOcrOpenFolder: () => ipcRenderer.invoke('glm:open-folder'),
  glmOcrRemove: (config) => ipcRenderer.invoke('glm:remove', config),
  glmOcrOpenInstall: () => ipcRenderer.invoke('glm:open-install'),
  onGlmOcrProgress: (listener) => {
    const handler = (_event, progress) => listener(progress);
    ipcRenderer.on('glm:progress', handler);
    return () => ipcRenderer.removeListener('glm:progress', handler);
  },
  libraryList: () => ipcRenderer.invoke('library:list'),
  knowledgeList: () => ipcRenderer.invoke('knowledge:list'),
  knowledgeCreate: (input) => ipcRenderer.invoke('knowledge:create', input),
  knowledgeUpdate: (id, changes) =>
    ipcRenderer.invoke('knowledge:update', id, changes),
  knowledgeRemove: (id) => ipcRenderer.invoke('knowledge:remove', id),
  knowledgeExport: (id) => ipcRenderer.invoke('knowledge:export', id),
  knowledgeImport: () => ipcRenderer.invoke('knowledge:import'),
  knowledgeSearch: (id, providerId, vector, limit, filters) =>
    ipcRenderer.invoke(
      'knowledge:search',
      id,
      providerId,
      vector,
      limit,
      filters,
    ),
  libraryImport: (name, data) =>
    ipcRenderer.invoke('library:import', { name, data }),
  libraryImportFile: async (file) => {
    const filePath = webUtils.getPathForFile(file);
    if (filePath)
      return ipcRenderer.invoke('library:import-file', {
        name: file.name,
        filePath,
      });
    return ipcRenderer.invoke('library:import', {
      name: file.name,
      data: await file.arrayBuffer(),
    });
  },
  libraryRead: (id) => ipcRenderer.invoke('library:read', id),
  libraryRemove: (id) => ipcRenderer.invoke('library:remove', id),
  libraryUpdate: (id, changes) =>
    ipcRenderer.invoke('library:update', id, changes),
  libraryIndexOpen: (id, providerId) =>
    ipcRenderer.invoke('library:index-open', id, providerId),
  libraryIndexStart: (id, providerId, dimensions, buildKey) =>
    ipcRenderer.invoke(
      'library:index-start',
      id,
      providerId,
      dimensions,
      buildKey,
    ),
  libraryIndexSavePages: (id, entries) =>
    ipcRenderer.invoke('library:index-save-pages', id, entries),
  libraryIndexAppend: (id, entries) =>
    ipcRenderer.invoke('library:index-append', id, entries),
  libraryIndexFinish: (id) => ipcRenderer.invoke('library:index-finish', id),
  libraryIndexCancel: (id) => ipcRenderer.invoke('library:index-cancel', id),
  libraryIndexDiscard: (id) => ipcRenderer.invoke('library:index-discard', id),
  libraryIndexSearch: (id, providerId, vector, limit) =>
    ipcRenderer.invoke('library:index-search', id, providerId, vector, limit),
  libraryExportSearchablePdf: (id, range) =>
    ipcRenderer.invoke('library:export-searchable-pdf', id, range),
  workspaceChatLoad: (bookId, limit) =>
    ipcRenderer.invoke('workspace:chat-load', bookId, limit),
  workspaceChatReplace: (bookId, bookName, messages) =>
    ipcRenderer.invoke('workspace:chat-replace', bookId, bookName, messages),
  workspaceHistorySearch: (query, limit, offset) =>
    ipcRenderer.invoke('workspace:history-search', query, limit, offset),
  workspaceNotesList: (options) =>
    ipcRenderer.invoke('workspace:notes-list', options),
  workspaceNoteSave: (bookId, bookName, note) =>
    ipcRenderer.invoke('workspace:note-save', bookId, bookName, note),
  workspaceNoteRemove: (id) => ipcRenderer.invoke('workspace:note-remove', id),
  workspaceExportMarkdown: (options) =>
    ipcRenderer.invoke('workspace:export-markdown', options),
});

window.addEventListener('error', (event) => {
  ipcRenderer.send('log:renderer', {
    event: 'window-error',
    level: 'error',
    details: {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    },
  });
});
window.addEventListener('unhandledrejection', (event) => {
  ipcRenderer.send('log:renderer', {
    event: 'unhandled-rejection',
    level: 'error',
    details: {
      message:
        event.reason instanceof Error
          ? event.reason.message
          : String(event.reason),
    },
  });
});
