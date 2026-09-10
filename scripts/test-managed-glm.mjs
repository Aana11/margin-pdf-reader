import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';

const executable =
  process.env.MARGIN_PACKAGED_APP ||
  path.resolve('release', 'win-unpacked', 'Margin.exe');
const dataRoot =
  process.env.MARGIN_MANAGED_GLM_ROOT ||
  path.join(process.env.APPDATA, 'Margin');
const profileRoot = path.resolve('tmp', 'managed-glm-profile');
const cdpPort = Number(process.env.MARGIN_GLM_CDP_PORT || 9341);
const child = spawn(
  executable,
  [
    '--disable-gpu',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileRoot}`,
  ],
  {
    stdio: 'ignore',
    env: {
      ...process.env,
      MARGIN_DATA_ROOT: dataRoot,
      MARGIN_LIBRARY_ROOT: path.resolve('tmp', 'managed-glm-library'),
    },
  },
);
const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
async function retry(operation, attempts = 120, interval = 500) {
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
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          'Renderer evaluation failed',
      );
    return result.result?.value;
  };
  await command('Runtime.enable');
  const config = `{ provider: 'managed', endpoint: '', model: 'ggml-org/GLM-OCR-GGUF', apiKey: '', autoStart: true }`;
  console.log(JSON.stringify({ stage: 'prepare', dataRoot }));
  const prepared = await evaluate(
    `window.marginDesktop.glmOcrPrepare(${config})`,
    true,
  );
  assert.equal(prepared?.provider, 'managed');
  assert.equal(prepared?.modelInstalled, true);
  assert.equal(prepared?.modelLoaded, true);
  console.log(JSON.stringify({ stage: 'recognize', status: prepared.message }));
  const result = await evaluate(
    `(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 2000;
    const context = canvas.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'black'; context.font = '72px Cambria Math, serif'; context.fillText('∫₀¹ x² dx = 1/3', 120, 230);
    context.font = '36px Microsoft YaHei, serif';
    for (let row = 0; row < 14; row += 1) context.fillText('高等代数公式识别  AᵀA x = λx', 120, 380 + row * 95);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const image = new Uint8Array(await blob.arrayBuffer());
    return window.marginDesktop.glmOcrRecognize({ ...${config}, image, mimeType: 'image/png', task: 'formula' });
  })()`,
    true,
  );
  assert.ok(result?.text?.trim(), 'Managed GLM-OCR returned no text');
  assert.match(result.text, /x|frac|int|1\/3/i);
  const unloaded = await evaluate(
    `window.marginDesktop.glmOcrUnload(${config})`,
    true,
  );
  assert.equal(unloaded?.modelLoaded, false);
  console.log(
    JSON.stringify({
      stage: 'complete',
      recognized: result.text.slice(0, 500),
      unloaded: !unloaded.modelLoaded,
    }),
  );
  await Promise.race([
    command('Browser.close').catch(() => undefined),
    delay(2_000),
  ]);
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000),
  ]);
}
