const { app, BrowserWindow, ipcMain, net, protocol, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { access, appendFile, copyFile, mkdir, open, readFile, rename, rm, stat, statfs, writeFile } = require('node:fs/promises');
const nodeNet = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { appendIndexBatch, cancelIndexBuild, finishIndexBuild, openIndex, searchIndex, startIndexBuild } = require('./index-store.cjs');

const isDevelopment = !app.isPackaged;
const embeddingModel = 'Qwen/Qwen3-Embedding-4B';
const modelDirectory = 'Qwen3-Embedding-4B-GGUF';
const modelName = 'Qwen3-Embedding-4B-Q4_K_M.gguf';
const modelRevision = 'f4602530db1d980e16da9d7d3a70294cf5c190be';
const runtimeVersion = 'b10516';
const gpuRuntimeVersion = 'b9637';
const forcedRuntimeBackend = process.env.MARGIN_RUNTIME_BACKEND;
const runtimeBackend = ['cpu', 'vulkan'].includes(forcedRuntimeBackend)
  ? forcedRuntimeBackend
  : (spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], { windowsHide: true, encoding: 'utf8', timeout: 3_000 }).status === 0 ? 'vulkan' : 'cpu');
let sidecarPromise;
let sidecarProcess;
let sidecarIdleTimer;
let catalogQueue = Promise.resolve();
let modelInstallPromise;
let modelDownloadController;
let modelInstallState = { state: 'idle', progress: 0, message: '' };
let runtimeRepairPromise;
let logQueue = Promise.resolve();
let ocrWorkerPromise;
let ocrWorkerLanguage;
let ocrQueue = Promise.resolve();
const indexBuilds = new Map();

app.setName('Margin');

protocol.registerSchemesAsPrivileged([{ scheme: 'margin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);

function dataRoot() {
  return process.env.MARGIN_DATA_ROOT || app.getPath('userData');
}

function logFile() {
  return path.join(dataRoot(), 'logs', 'main.log');
}

function ocrRoot() {
  return path.join(dataRoot(), 'ocr');
}

const ocrLanguages = {
  'eng': ['eng'],
  'chi_sim+eng': ['chi_sim', 'eng'],
  'chi_tra+eng': ['chi_tra', 'eng'],
};

async function ensureOcrLanguageData(language) {
  const codes = ocrLanguages[language];
  if (!codes) throw new Error('Unsupported OCR language');
  if (app.isPackaged) {
    const destination = path.join(process.resourcesPath, 'ocr', 'tessdata');
    for (const code of codes) await access(path.join(destination, `${code}.traineddata.gz`));
    return { codes, destination };
  }
  const destination = path.join(ocrRoot(), 'tessdata');
  await mkdir(destination, { recursive: true });
  const packages = {
    eng: require('@tesseract.js-data/eng'),
    chi_sim: require('@tesseract.js-data/chi_sim'),
    chi_tra: require('@tesseract.js-data/chi_tra'),
  };
  for (const code of codes) {
    const target = path.join(destination, `${code}.traineddata.gz`);
    if (!await exists(target)) await copyFile(path.join(packages[code].langPath, `${code}.traineddata.gz`), target);
  }
  return { codes, destination };
}

async function getOcrWorker(language, sender) {
  if (ocrWorkerLanguage !== language) {
    if (ocrWorkerPromise) await ocrWorkerPromise.then((worker) => worker.terminate()).catch(() => undefined);
    ocrWorkerPromise = undefined;
    ocrWorkerLanguage = language;
  }
  if (!ocrWorkerPromise) {
    const { codes, destination } = await ensureOcrLanguageData(language);
    const { createWorker, OEM } = require('tesseract.js');
    ocrWorkerPromise = createWorker(codes, OEM.LSTM_ONLY, {
      langPath: destination,
      cachePath: path.join(ocrRoot(), 'cache'),
      gzip: true,
      logger(message) {
        if (sender && !sender.isDestroyed()) sender.send('ocr:progress', { status: message.status, progress: Math.round((message.progress || 0) * 100) });
      },
    }).catch((error) => {
      ocrWorkerPromise = undefined;
      ocrWorkerLanguage = undefined;
      throw error;
    });
  }
  return ocrWorkerPromise;
}

function stopOcrWorker() {
  const current = ocrWorkerPromise;
  ocrWorkerPromise = undefined;
  ocrWorkerLanguage = undefined;
  if (current) void current.then((worker) => worker.terminate()).catch(() => undefined);
}

function describeError(error) {
  if (!error) return null;
  return {
    name: error.name,
    message: error.message || String(error),
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
    stack: typeof error.stack === 'string' ? error.stack.split('\n').slice(0, 8).join('\n') : undefined,
  };
}

function logEvent(level, event, details = {}) {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...details })}\n`;
  logQueue = logQueue.then(async () => {
    const file = logFile();
    await mkdir(path.dirname(file), { recursive: true });
    const size = await stat(file).then((value) => value.size).catch(() => 0);
    if (size > 5 * 1024 * 1024) {
      await rm(`${file}.previous`, { force: true });
      await rename(file, `${file}.previous`);
    }
    await appendFile(file, line, 'utf8');
  }).catch((error) => console.error('[margin-log]', error));
  return logQueue;
}

function modelFile() {
  return path.join(dataRoot(), 'models', 'Qwen', modelDirectory, modelName);
}

function runtimeFile() {
  return path.join(dataRoot(), 'runtime', 'llama', 'llama-server.exe');
}

function runtimeArchive() {
  return path.join(dataRoot(), 'downloads', runtimeBackend === 'vulkan' ? `llama-${gpuRuntimeVersion}-bin-win-vulkan-x64.zip` : `llama-${runtimeVersion}-win-cpu-x64.zip`);
}

function runtimeMarker() {
  return runtimeBackend === 'vulkan' ? path.join(path.dirname(runtimeFile()), 'ggml-vulkan.dll') : runtimeFile();
}

function modelResources() {
  return [
    {
      name: 'Qwen3-Embedding-4B Q4_K_M',
      output: modelFile(),
      size: 2496703776,
      sha256: '2b0cf8f17b4c723c27303015383c27ec4bf2d8314bb677d05e920dd70bb0f16b',
      urls: [
        `https://huggingface.co/Qwen/Qwen3-Embedding-4B-GGUF/resolve/${modelRevision}/${modelName}`,
        `https://www.modelscope.cn/models/Qwen/Qwen3-Embedding-4B-GGUF/resolve/master/${modelName}`,
        `https://hf-mirror.com/Qwen/Qwen3-Embedding-4B-GGUF/resolve/${modelRevision}/${modelName}`,
      ],
    },
    runtimeBackend === 'vulkan' ? {
      name: `llama.cpp ${gpuRuntimeVersion} Vulkan GPU`,
      output: runtimeArchive(),
      size: 38556528,
      sha256: 'a353945604cffdac3d0d6da6392de78ca565a531a6f2ff3521f44b9b7c6e553f',
      urls: [
        `https://github.com/ggml-org/llama.cpp/releases/download/${gpuRuntimeVersion}/llama-${gpuRuntimeVersion}-bin-win-vulkan-x64.zip`,
        `https://hf-mirror.com/limnmn/llama.cpp-${gpuRuntimeVersion}-Windows-Runtime/resolve/main/llama-${gpuRuntimeVersion}-bin-win-vulkan-x64.zip`,
      ],
    } : {
      name: `llama.cpp ${runtimeVersion} CPU`,
      output: runtimeArchive(),
      size: 18506923,
      sha256: 'fbbbc55e0eb2e1b07f9dcb9488616c98ed47d9003b90e15e7c8c7812c4307cd3',
      urls: [`https://github.com/ggml-org/llama.cpp/releases/download/${runtimeVersion}/llama-${runtimeVersion}-bin-win-cpu-x64.zip`],
    },
  ];
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function publishModelState(sender, changes) {
  modelInstallState = { ...modelInstallState, ...changes };
  if (sender && !sender.isDestroyed()) sender.send('model:progress', modelInstallState);
}

async function downloadResource(resource, sender, resourceIndex, signal) {
  const temporary = `${resource.output}.download`;
  await mkdir(path.dirname(resource.output), { recursive: true });
  for (const url of resource.urls) {
    try {
      const existing = await stat(temporary).then((value) => value.size).catch(() => 0);
      const response = await fetch(url, { redirect: 'follow', headers: existing ? { Range: `bytes=${existing}-` } : {}, signal });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      const resumed = existing > 0 && response.status === 206;
      let received = resumed ? existing : 0;
      let lastPercent = -1;
      const progress = new Transform({
        transform(chunk, _encoding, done) {
          received += chunk.length;
          const resourceProgress = Math.min(1, received / resource.size);
          const percent = Math.round(((resourceIndex + resourceProgress) / 2) * 95);
          if (percent !== lastPercent) {
            lastPercent = percent;
            publishModelState(sender, { state: 'downloading', progress: percent, message: `正在下载 ${resource.name}` });
          }
          done(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary, { flags: resumed ? 'a' : 'w' }));
      if (await hashFile(temporary) !== resource.sha256) {
        await rm(temporary, { force: true });
        throw new Error('checksum mismatch');
      }
      await rm(resource.output, { force: true });
      await rename(temporary, resource.output);
      return;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  throw new Error(`无法下载 ${resource.name}`);
}

async function extractRuntime() {
  const temporary = `${path.dirname(runtimeFile())}.extracting`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  await new Promise((resolve, reject) => {
    const process = spawn('tar.exe', ['-xf', runtimeArchive(), '-C', temporary], { windowsHide: true, stdio: 'ignore' });
    process.once('error', reject);
    process.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`运行时解压失败 (${code})`)));
  });
  const destination = path.dirname(runtimeFile());
  await rm(destination, { recursive: true, force: true });
  await rename(temporary, destination);
  await access(runtimeFile());
  await access(runtimeMarker());
  await logEvent('info', 'runtime.repaired', { runtimePath: runtimeFile(), archivePath: runtimeArchive(), backend: runtimeBackend });
}

async function exists(file) {
  return access(file).then(() => true).catch(() => false);
}

async function ensureEmbeddingFiles() {
  let modelStats;
  try {
    modelStats = await stat(modelFile());
    await logEvent('info', 'model.path-check', { component: 'model', path: modelFile(), size: modelStats.size, isFile: modelStats.isFile() });
  } catch (error) {
    await logEvent('error', 'model.path-check-failed', { component: 'model', path: modelFile(), error: describeError(error) });
    const reason = error?.code === 'ENOENT' ? '文件不存在' : `访问失败 (${error?.code || 'UNKNOWN'}: ${error?.message || error})`;
    throw new Error(`本地 GGUF 模型不可用：${modelFile()}；${reason}。请在模型设置中检查安装或打开日志。`);
  }
  if (!modelStats.isFile() || modelStats.size !== modelResources()[0].size) {
    await logEvent('error', 'model.file-invalid', { path: modelFile(), size: modelStats.size, expectedSize: modelResources()[0].size });
    throw new Error(`本地 GGUF 模型大小异常：${modelFile()}；实际 ${modelStats.size} 字节，应为 ${modelResources()[0].size} 字节。`);
  }
  try {
    const runtimeStats = await stat(runtimeFile());
    await access(runtimeMarker());
    await logEvent('info', 'model.path-check', { component: 'runtime', path: runtimeFile(), markerPath: runtimeMarker(), size: runtimeStats.size, isFile: runtimeStats.isFile(), backend: runtimeBackend });
    if (!runtimeStats.isFile()) throw new Error('runtime path is not a file');
  } catch (runtimeError) {
    await logEvent('warn', 'runtime.path-check-failed', { path: runtimeFile(), error: describeError(runtimeError) });
    if (await exists(runtimeArchive()) && await hashFile(runtimeArchive()) === modelResources()[1].sha256) {
      await logEvent('info', 'runtime.repair-started', { archivePath: runtimeArchive(), runtimePath: runtimeFile(), backend: runtimeBackend });
      if (!runtimeRepairPromise) runtimeRepairPromise = extractRuntime().finally(() => { runtimeRepairPromise = undefined; });
      await runtimeRepairPromise;
    } else {
      throw new Error(`llama.cpp ${runtimeBackend} 运行时不可用：${runtimeFile()}；${runtimeError?.code || runtimeError?.message || '未知访问错误'}。请在模型设置中点击“下载并安装”或打开日志。`);
    }
  }
}

async function installModel(sender) {
  if (modelInstallPromise) return modelInstallPromise;
  modelDownloadController = new AbortController();
  const signal = modelDownloadController.signal;
  modelInstallPromise = (async () => {
    await mkdir(dataRoot(), { recursive: true });
    const disk = await statfs(dataRoot());
    const available = Number(disk.bavail) * Number(disk.bsize);
    const required = modelResources().reduce((sum, resource) => sum + resource.size, 0) + 600 * 1024 * 1024;
    if (available < required) throw new Error(`磁盘空间不足，需要至少 ${(required / 1024 / 1024 / 1024).toFixed(1)} GB 可用空间`);
    publishModelState(sender, { state: 'checking', progress: 0, message: '正在校验本地文件' });
    const resources = modelResources();
    for (const [index, resource] of resources.entries()) {
      const valid = await access(resource.output).then(() => hashFile(resource.output)).then((digest) => digest === resource.sha256).catch(() => false);
      if (!valid) await downloadResource(resource, sender, index, signal);
    }
    publishModelState(sender, { state: 'installing', progress: 96, message: '正在安装 llama.cpp 运行时' });
    await Promise.all([access(runtimeFile()), access(runtimeMarker())]).catch(() => extractRuntime());
    publishModelState(sender, { state: 'ready', progress: 100, message: '本地向量模型已就绪' });
    return { installed: true };
  })().catch((error) => {
    if (signal.aborted) {
      publishModelState(sender, { state: 'paused', message: '下载已暂停，可继续下载' });
      return { installed: false, paused: true };
    }
    publishModelState(sender, { state: 'error', message: error instanceof Error ? error.message : String(error) });
    throw error;
  }).finally(() => {
    modelInstallPromise = undefined;
    modelDownloadController = undefined;
  });
  return modelInstallPromise;
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
  await Promise.all([access(modelFile()), access(runtimeFile()), access(runtimeMarker())]);
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = '';
  const startedAt = Date.now();
  await logEvent('info', 'sidecar.starting', { runtimePath: runtimeFile(), modelPath: modelFile(), backend: runtimeBackend, port, contextSize: 2048, batchSize: 512 });
  sidecarProcess = spawn(runtimeFile(), [
    '--model', modelFile(),
    '--embedding',
    '--pooling', 'last',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--ctx-size', '2048',
    '--batch-size', '512',
    '--ubatch-size', '512',
    '--threads', String(Math.max(1, Math.min(8, Math.ceil(os.cpus().length / 2)))),
    ...(runtimeBackend === 'vulkan' ? ['--n-gpu-layers', '99'] : []),
    '--no-webui',
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const launchedProcess = sidecarProcess;
  launchedProcess.once('exit', (code, signal) => {
    void logEvent(code === 0 || signal === 'SIGTERM' ? 'info' : 'error', 'sidecar.exited', { pid: launchedProcess.pid, code, signal, logTail: logs.slice(-2000) });
    if (sidecarProcess === launchedProcess) {
      sidecarProcess = undefined;
      sidecarPromise = undefined;
    }
  });
  const collect = (chunk) => { logs = `${logs}${chunk}`.slice(-6_000); };
  sidecarProcess.stdout.on('data', collect);
  sidecarProcess.stderr.on('data', collect);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (sidecarProcess.exitCode !== null) throw new Error(`本地向量服务退出 (${sidecarProcess.exitCode})：${logs.slice(-1000)}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        await logEvent('info', 'sidecar.ready', { pid: sidecarProcess.pid, port, elapsedMs: Date.now() - startedAt });
        return baseUrl;
      }
    } catch { /* Model is still loading. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  sidecarProcess.kill();
  throw new Error(`本地向量模型加载超时：${logs.slice(-1000)}`);
}

function stopSidecar() {
  if (sidecarIdleTimer) clearTimeout(sidecarIdleTimer);
  sidecarIdleTimer = undefined;
  if (sidecarProcess && sidecarProcess.exitCode === null) {
    void logEvent('info', 'sidecar.stop-requested', { pid: sidecarProcess.pid });
    sidecarProcess.kill();
  }
  sidecarProcess = undefined;
  sidecarPromise = undefined;
}

function scheduleSidecarIdleStop() {
  if (sidecarIdleTimer) clearTimeout(sidecarIdleTimer);
  sidecarIdleTimer = setTimeout(stopSidecar, 120_000);
  sidecarIdleTimer.unref();
}

async function getSidecarUrl() {
  if (!sidecarPromise) sidecarPromise = startSidecar().catch((error) => { sidecarPromise = undefined; throw error; });
  return sidecarPromise;
}

async function getModelStatus() {
  const missing = [];
  if (!await exists(modelFile())) missing.push('model');
  if (!await exists(runtimeFile()) || !await exists(runtimeMarker())) missing.push('runtime');
  if (missing.length === 0) {
    return { installed: true, loaded: Boolean(sidecarProcess && sidecarProcess.exitCode === null), model: embeddingModel, root: dataRoot(), backend: runtimeBackend, ...modelInstallState, state: modelInstallState.state === 'idle' ? 'ready' : modelInstallState.state };
  }
  return { installed: false, loaded: false, missing, model: embeddingModel, root: dataRoot(), backend: runtimeBackend, ...modelInstallState };
}

ipcMain.handle('embedding:status', getModelStatus);
ipcMain.handle('app:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, logPath: logFile() }));
ipcMain.handle('model:prepare', async (event) => {
  await logEvent('info', 'model.prepare-started', { modelPath: modelFile(), runtimePath: runtimeFile(), runtimeMarker: runtimeMarker(), backend: runtimeBackend, executablePath: process.execPath });
  try {
    // If a download/install is already under way (e.g. started from the model
    // manager), wait for it to finish instead of failing with a "model file
    // missing" error while the final GGUF is still being written.
    if (modelInstallPromise) await modelInstallPromise;
    // If the GGUF or runtime is not installed yet — including a stale partial
    // `.gguf.download` left by an interrupted download — automatically resume
    // the install so building an index works in a single step.
    if (!(await getModelStatus()).installed) await installModel(event.sender);
    await ensureEmbeddingFiles();
    await logEvent('info', 'model.prepare-succeeded');
    return getModelStatus();
  } catch (error) {
    await logEvent('error', 'model.prepare-failed', { error: describeError(error) });
    throw error;
  }
});
ipcMain.handle('model:install', (event) => installModel(event.sender));
ipcMain.handle('model:pause', () => {
  modelDownloadController?.abort();
  return { paused: Boolean(modelDownloadController) };
});
ipcMain.handle('model:open-folder', async () => {
  await mkdir(dataRoot(), { recursive: true });
  const result = await shell.openPath(dataRoot());
  if (result) throw new Error(result);
  return { opened: true };
});
ipcMain.handle('logs:open', async () => {
  await mkdir(path.dirname(logFile()), { recursive: true });
  await access(logFile()).catch(() => appendFile(logFile(), '', 'utf8'));
  const result = await shell.showItemInFolder(logFile());
  return { opened: result !== false, path: logFile() };
});
ipcMain.handle('model:unload', async () => {
  stopSidecar();
  return getModelStatus();
});
ipcMain.handle('model:remove', async () => {
  modelDownloadController?.abort();
  stopSidecar();
  await rm(path.dirname(modelFile()), { recursive: true, force: true });
  await rm(path.dirname(runtimeFile()), { recursive: true, force: true });
  await rm(runtimeArchive(), { force: true });
  modelInstallState = { state: 'idle', progress: 0, message: '' };
  return getModelStatus();
});

ipcMain.handle('embedding:embed', async (_event, texts) => {
  if (!Array.isArray(texts) || texts.length === 0 || texts.length > 16 || texts.some((text) => typeof text !== 'string' || text.length > 20_000)) {
    throw new Error('Invalid embedding input');
  }
  const startedAt = Date.now();
  await logEvent('info', 'embedding.request-started', { textCount: texts.length, characterCount: texts.reduce((sum, text) => sum + text.length, 0) });
  try {
    await ensureEmbeddingFiles();
    const baseUrl = await getSidecarUrl();
    const response = await fetch(`${baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embeddingModel, input: texts, encoding_format: 'float' }),
    });
    if (!response.ok) throw new Error((await response.text()) || `本地向量请求失败 (${response.status})`);
    const payload = await response.json();
    if (!Array.isArray(payload.data)) throw new Error('本地向量服务返回格式无效');
    scheduleSidecarIdleStop();
    await logEvent('info', 'embedding.request-succeeded', { textCount: texts.length, vectorCount: payload.data.length, dimensions: payload.data[0]?.embedding?.length, elapsedMs: Date.now() - startedAt });
    return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  } catch (error) {
    await logEvent('error', 'embedding.request-failed', { elapsedMs: Date.now() - startedAt, error: describeError(error) });
    throw error;
  }
});

ipcMain.on('log:renderer', (_event, payload) => {
  if (!payload || typeof payload.event !== 'string') return;
  void logEvent(payload.level === 'error' ? 'error' : 'info', `renderer.${payload.event.slice(0, 80)}`, typeof payload.details === 'object' && payload.details ? payload.details : {});
});

ipcMain.handle('ocr:recognize', (event, payload) => {
  const operation = ocrQueue.then(async () => {
    const image = payload?.image;
    const language = payload?.language || 'chi_sim+eng';
    if (!(image instanceof Uint8Array) || image.byteLength < 16 || image.byteLength > 24 * 1024 * 1024 || !ocrLanguages[language]) throw new Error('Invalid OCR request');
    const startedAt = Date.now();
    await logEvent('info', 'ocr.started', { language, bytes: image.byteLength });
    try {
      const worker = await getOcrWorker(language, event.sender);
      const result = await worker.recognize(Buffer.from(image.buffer, image.byteOffset, image.byteLength), { rotateAuto: true });
      const text = String(result?.data?.text || '').replace(/\s+/g, ' ').trim();
      await logEvent('info', 'ocr.succeeded', { language, characters: text.length, confidence: result?.data?.confidence, elapsedMs: Date.now() - startedAt });
      return { text, confidence: Number(result?.data?.confidence || 0) };
    } catch (error) {
      await logEvent('error', 'ocr.failed', { language, elapsedMs: Date.now() - startedAt, error: describeError(error) });
      throw error;
    }
  });
  ocrQueue = operation.catch(() => undefined);
  return operation;
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

ipcMain.handle('library:import-file', async (_event, payload) => {
  if (!payload || typeof payload.name !== 'string' || payload.name.length > 300 || typeof payload.filePath !== 'string' || !path.isAbsolute(payload.filePath)) throw new Error('Invalid PDF import path');
  const source = path.resolve(payload.filePath);
  const sourceStats = await stat(source);
  if (!sourceStats.isFile() || sourceStats.size < 5 || sourceStats.size > 1024 * 1024 * 1024) throw new Error('Invalid or oversized PDF');
  const handle = await open(source, 'r');
  try {
    const signature = Buffer.alloc(5);
    await handle.read(signature, 0, signature.length, 0);
    if (signature.toString() !== '%PDF-') throw new Error('Invalid PDF signature');
  } finally {
    await handle.close();
  }
  const now = new Date().toISOString();
  const entry = { id: randomUUID(), name: path.basename(payload.name), pageCount: 0, lastPage: 1, addedAt: now, updatedAt: now, indexProviderId: null };
  const directory = bookDirectory(entry.id);
  await mkdir(directory, { recursive: true });
  await copyFile(source, path.join(directory, 'document.pdf'));
  await updateCatalog((catalog) => { catalog.unshift(entry); });
  return entry;
});

ipcMain.handle('library:read', async (_event, id) => new Uint8Array(await readFile(path.join(bookDirectory(id), 'document.pdf'))));

ipcMain.handle('library:remove', async (_event, id) => {
  const bookId = assertBookId(id);
  await rm(bookDirectory(bookId), { recursive: true, force: true });
  return updateCatalog((catalog) => {
    const index = catalog.findIndex((candidate) => candidate.id === bookId);
    if (index >= 0) catalog.splice(index, 1);
    return { removed: bookId };
  });
});

ipcMain.handle('library:update', async (_event, id, changes) => updateCatalog((catalog) => {
  const entry = catalog.find((candidate) => candidate.id === assertBookId(id));
  if (!entry) throw new Error('Book not found');
  if (Number.isInteger(changes?.pageCount) && changes.pageCount > 0) entry.pageCount = changes.pageCount;
  if (Number.isInteger(changes?.lastPage) && changes.lastPage > 0) entry.lastPage = Math.min(changes.lastPage, entry.pageCount || changes.lastPage);
  entry.updatedAt = new Date().toISOString();
  return entry;
}));

ipcMain.handle('library:index-open', async (_event, id, providerId) => {
  const startedAt = Date.now();
  const result = openIndex(bookDirectory(id), providerId);
  if (result) await logEvent('info', result.migrated ? 'index.migrated' : 'index.opened', { bookId: id, ...result, elapsedMs: Date.now() - startedAt });
  return result;
});

ipcMain.handle('library:index-start', (_event, id, providerId, dimensions) => {
  const bookId = assertBookId(id);
  const existing = indexBuilds.get(bookId);
  if (existing) cancelIndexBuild(existing);
  const build = startIndexBuild(bookDirectory(bookId), providerId, dimensions);
  indexBuilds.set(bookId, build);
  return { started: true, format: 'sqlite-f32', dimensions };
});

ipcMain.handle('library:index-append', (_event, id, entries) => {
  const bookId = assertBookId(id);
  const build = indexBuilds.get(bookId);
  if (!build) throw new Error('Vector index build has not started');
  return { chunks: appendIndexBatch(build, entries) };
});

ipcMain.handle('library:index-finish', async (_event, id) => {
  const bookId = assertBookId(id);
  const build = indexBuilds.get(bookId);
  if (!build) throw new Error('Vector index build has not started');
  try {
    const result = finishIndexBuild(build);
    await updateCatalog((catalog) => {
      const entry = catalog.find((candidate) => candidate.id === bookId);
      if (!entry) throw new Error('Book not found');
      entry.indexProviderId = build.providerId;
      entry.updatedAt = new Date().toISOString();
    });
    await logEvent('info', 'index.sqlite-finished', { bookId, providerId: build.providerId, ...result });
    return result;
  } finally {
    indexBuilds.delete(bookId);
  }
});

ipcMain.handle('library:index-cancel', (_event, id) => {
  const bookId = assertBookId(id);
  const build = indexBuilds.get(bookId);
  if (build) cancelIndexBuild(build);
  indexBuilds.delete(bookId);
  return { cancelled: Boolean(build) };
});

ipcMain.handle('library:index-search', (_event, id, providerId, vector, limit) => {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 20) throw new Error('Invalid search limit');
  return searchIndex(bookDirectory(id), providerId, vector, limit);
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
  void logEvent('info', 'app.ready', { version: app.getVersion(), packaged: app.isPackaged, executablePath: process.execPath, dataRoot: dataRoot(), modelPath: modelFile(), runtimePath: runtimeFile(), runtimeMarker: runtimeMarker(), backend: runtimeBackend });
  const rendererRoot = path.resolve(__dirname, '..', 'dist', 'client');
  protocol.handle('margin', (request) => {
    const url = new URL(request.url);
    const pathname = decodeURIComponent(url.pathname);
    const libraryMatch = pathname.match(/^\/library\/([0-9a-f-]{36})\/document\.pdf$/);
    if (url.host === 'app' && libraryMatch) {
      const file = path.join(bookDirectory(libraryMatch[1]), 'document.pdf');
      return net.fetch(pathToFileURL(file).toString(), { headers: request.headers });
    }
    if (url.host !== 'app') return new Response('Not found', { status: 404 });
    const requested = path.resolve(rendererRoot, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (requested !== rendererRoot && !requested.startsWith(`${rendererRoot}${path.sep}`)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(requested).toString());
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  stopSidecar();
  stopOcrWorker();
  for (const build of indexBuilds.values()) cancelIndexBuild(build);
  indexBuilds.clear();
});
process.on('uncaughtException', (error) => { void logEvent('error', 'process.uncaught-exception', { error: describeError(error) }); });
process.on('unhandledRejection', (error) => { void logEvent('error', 'process.unhandled-rejection', { error: describeError(error) }); });
