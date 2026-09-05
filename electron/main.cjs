const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { access, mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
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
let catalogQueue = Promise.resolve();

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

function libraryRoot() {
  return process.env.MARGIN_LIBRARY_ROOT || path.join(dataRoot(), 'library');
}

function catalogFile() {
  return path.join(libraryRoot(), 'catalog.json');
}

function assertBookId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid library book id');
  return id;
}

function bookDirectory(id) {
  return path.join(libraryRoot(), assertBookId(id));
}

async function readCatalog() {
  try {
    const payload = JSON.parse(await readFile(catalogFile(), 'utf8'));
    return Array.isArray(payload) ? payload : [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value));
  await rm(file, { force: true });
  await rename(temporary, file);
}

function updateCatalog(mutator) {
  const operation = catalogQueue.then(async () => {
    const catalog = await readCatalog();
    const result = await mutator(catalog);
    await writeJsonAtomic(catalogFile(), catalog);
    return result;
  });
  catalogQueue = operation.catch(() => undefined);
  return operation;
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

ipcMain.handle('library:list', async () => (await readCatalog()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));

ipcMain.handle('library:import', async (_event, payload) => {
  if (!payload || typeof payload.name !== 'string' || payload.name.length > 300) throw new Error('Invalid PDF import');
  const bytes = Buffer.from(payload.data);
  if (bytes.length < 5 || bytes.length > 1024 * 1024 * 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid or oversized PDF');
  const now = new Date().toISOString();
  const entry = { id: randomUUID(), name: path.basename(payload.name), pageCount: 0, lastPage: 1, addedAt: now, updatedAt: now, indexProviderId: null };
  const directory = bookDirectory(entry.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'document.pdf'), bytes);
  await updateCatalog((catalog) => { catalog.unshift(entry); });
  return entry;
});

ipcMain.handle('library:read', async (_event, id) => new Uint8Array(await readFile(path.join(bookDirectory(id), 'document.pdf'))));

ipcMain.handle('library:update', async (_event, id, changes) => updateCatalog((catalog) => {
  const entry = catalog.find((candidate) => candidate.id === assertBookId(id));
  if (!entry) throw new Error('Book not found');
  if (Number.isInteger(changes?.pageCount) && changes.pageCount > 0) entry.pageCount = changes.pageCount;
  if (Number.isInteger(changes?.lastPage) && changes.lastPage > 0) entry.lastPage = Math.min(changes.lastPage, entry.pageCount || changes.lastPage);
  entry.updatedAt = new Date().toISOString();
  return entry;
}));

ipcMain.handle('library:index-save', async (_event, id, providerId, entries) => {
  if (typeof providerId !== 'string' || providerId.length > 500 || !Array.isArray(entries)) throw new Error('Invalid vector index');
  const directory = bookDirectory(id);
  await writeJsonAtomic(path.join(directory, 'index.json'), { version: 1, providerId, createdAt: new Date().toISOString(), entries });
  return updateCatalog((catalog) => {
    const entry = catalog.find((candidate) => candidate.id === id);
    if (!entry) throw new Error('Book not found');
    entry.indexProviderId = providerId;
    entry.updatedAt = new Date().toISOString();
    return { saved: true, chunks: entries.length };
  });
});

ipcMain.handle('library:index-load', async (_event, id, providerId) => {
  try {
    const payload = JSON.parse(await readFile(path.join(bookDirectory(id), 'index.json'), 'utf8'));
    if (payload?.version !== 1 || payload.providerId !== providerId || !Array.isArray(payload.entries)) return null;
    return payload.entries;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 1120,
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
