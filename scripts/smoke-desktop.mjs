import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const pdfPath = path.resolve(process.argv[2] || 'tmp/pdfs/margin-reader-smoke.pdf');
const testEmbedding = process.argv.includes('--embedding');
const executable = path.resolve('release', 'win-unpacked', 'Margin.exe');
const port = 9333;
const child = spawn(executable, [`--remote-debugging-port=${port}`], { stdio: 'ignore' });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(operation, attempts = 60, interval = 500) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) { lastError = error; await delay(interval); }
  }
  throw lastError;
}

const targets = await retry(async () => {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload) || payload.length === 0) throw new Error('No Electron page target');
  return payload;
});
const target = targets.find((candidate) => candidate.url?.startsWith('margin://')) || targets[0];
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let messageId = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  messageId += 1;
  const id = messageId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression, awaitPromise = false) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

try {
  await command('Runtime.enable');
  const pdfBase64 = (await readFile(pdfPath)).toString('base64');
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob('${pdfBase64}'), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'margin-reader-smoke.pdf', { type: 'application/pdf' }));
    const input = document.querySelector('input[type="file"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const pageOne = await retry(async () => {
    const state = await evaluate(`({
      page: document.querySelector('.page-label')?.textContent || '',
      canvasWidth: document.querySelector('canvas')?.width || 0,
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (!state.page.includes('1 / 2') || state.canvasWidth <= 0) throw new Error('Page 1 has not rendered yet');
    return state;
  }, 120, 500);
  await evaluate(`document.querySelector('[aria-label="下一页"]')?.click()`);
  const pageTwo = await retry(async () => {
    const state = await evaluate(`({
      page: document.querySelector('.page-label')?.textContent || '',
      synced: document.querySelector('.ai-heading p')?.textContent || '',
      canvasWidth: document.querySelector('canvas')?.width || 0
    })`);
    if (!state.page.includes('2 / 2') || !state.synced.includes('2') || state.canvasWidth <= 0) throw new Error('Page 2 has not rendered yet');
    return state;
  }, 120, 500);

  const modelStatus = await evaluate(`window.marginDesktop.modelStatus()`, true);
  let embeddingDimensions = null;
  let indexStatus = null;
  if (testEmbedding) {
    const vectors = await evaluate(`window.marginDesktop.embed(['A short PDF retrieval passage.'])`, true);
    embeddingDimensions = vectors?.[0]?.length ?? 0;
    if (embeddingDimensions !== 2560) throw new Error(`Unexpected embedding dimensions: ${embeddingDimensions}`);
    await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('建立索引'))?.click()`);
    indexStatus = await retry(async () => {
      const state = await evaluate(`({
        label: [...document.querySelectorAll('.index-strip strong')][0]?.textContent || '',
        error: document.querySelector('.error-message')?.textContent || ''
      })`);
      if (state.error) throw new Error(state.error);
      if (!state.label.includes('全文索引已就绪')) throw new Error(`Index is not ready: ${state.label}`);
      return state.label;
    }, 360, 500);
  }
  console.log(JSON.stringify({ pageOne, pageTwo, modelStatus, embeddingDimensions, indexStatus }));
} finally {
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
  socket.close();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  if (!child.killed) child.kill();
}
