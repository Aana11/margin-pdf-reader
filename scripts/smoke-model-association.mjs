import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';

const executable =
  process.env.MARGIN_PACKAGED_APP ||
  path.resolve('release', 'win-unpacked', 'Margin.exe');
const expectedVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const root = path.resolve('tmp', `model-association-smoke-${Date.now()}`);
const dataRoot = path.join(root, 'data');
const runtimeRoot = path.join(dataRoot, 'runtime', 'llama');
const glmRoot = path.join(dataRoot, 'models', 'GLM-OCR');
const qwenRoot = path.join(
  dataRoot,
  'models',
  'Qwen',
  'Qwen3-Embedding-4B-GGUF',
);
await Promise.all([
  mkdir(runtimeRoot, { recursive: true }),
  mkdir(glmRoot, { recursive: true }),
  mkdir(qwenRoot, { recursive: true }),
]);
await writeFile(path.join(runtimeRoot, 'llama-server.exe'), 'fixture');
await writeFile(
  path.join(runtimeRoot, '.margin-runtime-version'),
  'cpu:b10516',
);
await writeFile(
  path.join(qwenRoot, 'Qwen3-Embedding-4B-Q4_K_M.gguf'),
  'fixture',
);
await writeFile(path.join(glmRoot, 'GLM-OCR-Q8_0.gguf'), '');
await writeFile(path.join(glmRoot, 'mmproj-GLM-OCR-Q8_0.gguf'), '');
await truncate(path.join(glmRoot, 'GLM-OCR-Q8_0.gguf'), 950433408);
await truncate(path.join(glmRoot, 'mmproj-GLM-OCR-Q8_0.gguf'), 484403648);

const cdpPort = 9347;
const child = spawn(
  executable,
  [
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${path.join(root, 'profile')}`,
  ],
  {
    stdio: 'ignore',
    env: {
      ...process.env,
      MARGIN_DATA_ROOT: dataRoot,
      MARGIN_LIBRARY_ROOT: path.join(root, 'library'),
      MARGIN_RUNTIME_BACKEND: 'cpu',
    },
  },
);
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function retry(operation, attempts = 120, interval = 250) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(interval);
    }
  }
  throw lastError;
}

let socket;
try {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const values = await response.json();
    const ready = values.find((candidate) =>
      candidate.url?.startsWith('margin://'),
    );
    if (!ready) throw new Error('Margin renderer is not ready');
    return ready;
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let messageId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  });
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      messageId += 1;
      pending.set(messageId, { resolve, reject });
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await command('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.text || 'Renderer evaluation failed',
      );
    return result.result?.value;
  };
  await command('Runtime.enable');
  const associated = await retry(() =>
    evaluate(
      `(async () => {
    const settings = JSON.parse(localStorage.getItem('margin-ai-settings') || '{}');
    const embedding = await window.marginDesktop.modelStatus();
    const glm = await window.marginDesktop.glmOcrStatus({ provider: 'managed', endpoint: '', model: 'ggml-org/GLM-OCR-GGUF', apiKey: '', autoStart: true });
    const app = await window.marginDesktop.appInfo();
    return { settings, schema: localStorage.getItem('margin-settings-schema'), embedding, glm, app };
  })()`,
      true,
    ).then((state) => {
      if (state.settings.glmOcrMode !== 'auto')
        throw new Error('Managed GLM-OCR has not been auto-associated yet');
      return state;
    }),
  );
  assert.equal(associated.settings.embeddingKind, 'local-qwen3-embedding-4b');
  assert.equal(associated.settings.glmOcrProvider, 'managed');
  assert.equal(associated.settings.glmOcrAutoStart, true);
  assert.equal(associated.schema, '3');
  assert.equal(associated.embedding.installed, true);
  assert.equal(associated.glm.modelInstalled, true);
  assert.equal(associated.app.version, expectedVersion);
  assert.equal(associated.app.dataRoot, dataRoot);

  await evaluate(
    `(() => { const settings = JSON.parse(localStorage.getItem('margin-ai-settings')); settings.glmOcrMode = 'off'; localStorage.setItem('margin-ai-settings', JSON.stringify(settings)); window.location.reload(); })()`,
  );
  const preserved = await retry(() =>
    evaluate(
      `document.readyState === 'complete' ? JSON.parse(localStorage.getItem('margin-ai-settings') || '{}').glmOcrMode : ''`,
    ).then((mode) => {
      if (!mode) throw new Error('Reload pending');
      return mode;
    }),
  );
  assert.equal(preserved, 'off');
  console.log(
    JSON.stringify({
      schema: associated.schema,
      embedding: associated.embedding.installed,
      glm: associated.glm.modelInstalled,
      autoMode: associated.settings.glmOcrMode,
      explicitOff: preserved,
    }),
  );
} finally {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000),
  ]);
  await rm(root, { recursive: true, force: true });
}
