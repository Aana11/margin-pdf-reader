const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const { spawn } = require('node:child_process');
const { access } = require('node:fs/promises');
const nodeNet = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const isDevelopment = !app.isPackaged;
const embeddingModel = 'Qwen/Qwen3-Embedding-4B';
const modelDirectory = 'Qwen3-Embedding-4B-GGUF';
const modelName = 'Qwen3-Embedding-4B-Q4_K_M.gguf';
let sidecarPromise;
let sidecarProcess;

app.setName('Margin');

protocol.registerSchemesAsPrivileged([{ scheme: 'margin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function dataRoot() {
  return process.env.MARGIN_DATA_ROOT || app.getPath('userData');
}

function modelFile() {
  return path.join(dataRoot(), 'models', 'Qwen', modelDirectory, modelName);
}

function runtimeFile() {
  return path.join(dataRoot(), 'runtime', 'llama', 'llama-server.exe');
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = nodeNet.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function startSidecar() {
  await Promise.all([access(modelFile()), access(runtimeFile())]);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = '';
  sidecarProcess = spawn(runtimeFile(), [
    '--model', modelFile(),
    '--embedding',
    '--pooling', 'last',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', '8192',
    '--ubatch-size', '2048',
    '--threads', String(Math.max(1, os.cpus().length - 1)),
    '--no-webui',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk) => { logs = `${logs}${chunk}`.slice(-6_000); };
  sidecarProcess.stdout.on('data', collect);
  sidecarProcess.stderr.on('data', collect);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (sidecarProcess.exitCode !== null) throw new Error(`本地向量服务退出 (${sidecarProcess.exitCode})：${logs.slice(-1000)}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return baseUrl;
    } catch { /* Model is still loading. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  sidecarProcess.kill();
  throw new Error(`本地向量模型加载超时：${logs.slice(-1000)}`);
}

async function getSidecarUrl() {
  if (!sidecarPromise) sidecarPromise = startSidecar().catch((error) => { sidecarPromise = undefined; throw error; });
  return sidecarPromise;
}

ipcMain.handle('embedding:status', async () => {
  try {
    await access(modelFile());
    await access(runtimeFile());
    return { installed: true, model: embeddingModel, root: dataRoot() };
  } catch {
    return { installed: false, model: embeddingModel, root: dataRoot() };
  }
});

ipcMain.handle('embedding:embed', async (_event, texts) => {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 16 || texts.some((text) => typeof text !== 'string' || text.length > 20_000)) {
    throw new Error('Invalid embedding input');
  }
  try {
    await Promise.all([access(modelFile()), access(runtimeFile())]);
  } catch {
    throw new Error(`本地模型或 llama.cpp 运行时尚未安装。请运行 npm run model:bundle，目标目录：${dataRoot()}`);
  }
  const baseUrl = await getSidecarUrl();
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: embeddingModel, input: texts, encoding_format: 'float' }),
  });
  if (!response.ok) throw new Error((await response.text()) || `本地向量请求失败 (${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload.data)) throw new Error('本地向量服务返回格式无效');
  return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
});

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
app.on('before-quit', () => { if (sidecarProcess && sidecarProcess.exitCode === null) sidecarProcess.kill(); });
