const { app, BrowserWindow, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isDevelopment = !app.isPackaged;

protocol.registerSchemesAsPrivileged([{ scheme: 'margin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function createWindow() {
  const window = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#eef1f4',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const current = window.webContents.getURL();
    if (current && new URL(url).origin !== new URL(current).origin) event.preventDefault();
  });

  if (isDevelopment) {
    void window.loadURL(process.env.MARGIN_DEV_URL || 'http://localhost:3000');
  } else {
    void window.loadURL('margin://app/');
  }
}

app.whenReady().then(() => {
  const rendererRoot = path.resolve(__dirname, '..', 'dist', 'client');
  protocol.handle('margin', (request) => {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const requested = path.resolve(rendererRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (requested !== rendererRoot && !requested.startsWith(`${rendererRoot}${path.sep}`)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(requested).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
