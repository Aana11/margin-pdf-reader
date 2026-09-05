const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('marginDesktop', {
  platform: process.platform,
  isDesktop: true,
});
