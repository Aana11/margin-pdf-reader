import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const pdfPath = path.resolve(process.argv[2] || 'tmp/pdfs/margin-reader-smoke.pdf');
const testEmbedding = process.argv.includes('--embedding');
const executable = path.resolve('release', 'win-unpacked', 'Margin.exe');
const port = 9333;
const libraryRoot = path.resolve('tmp', `smoke-library-${Date.now()}`);
const child = spawn(executable, [`--remote-debugging-port=${port}`], { stdio: 'ignore', env: { ...process.env, MARGIN_LIBRARY_ROOT: libraryRoot } });

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
      canvasCount: document.querySelectorAll('.pdf-page canvas').length,
      scrollHeight: document.querySelector('.canvas-wrap')?.scrollHeight || 0,
      clientHeight: document.querySelector('.canvas-wrap')?.clientHeight || 0,
      shelf: document.querySelector('.book-item strong')?.textContent || '',
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (!state.page.includes('1 / 2') || state.canvasWidth <= 0 || state.canvasCount !== 2 || state.scrollHeight <= state.clientHeight || !state.shelf.includes('margin-reader-smoke')) throw new Error(`Page 1, scroll region, or bookshelf has not rendered yet: ${JSON.stringify(state)}`);
    return state;
  }, 120, 500);
  for (let index = 0; index < 4; index += 1) {
    await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 650, y: 600, deltaX: 0, deltaY: 700 });
    await delay(150);
  }
  const pageTwo = await retry(async () => {
    const state = await evaluate(`({
      page: document.querySelector('.page-label')?.textContent || '',
      synced: document.querySelector('.ai-heading p')?.textContent || '',
      canvasWidth: document.querySelector('.pdf-page[data-page="2"] canvas')?.width || 0
    })`);
    if (!state.page.includes('2 / 2') || !state.synced.includes('2') || state.canvasWidth <= 0) throw new Error('Page 2 has not rendered yet');
    return state;
  }, 120, 500);
  await retry(async () => {
    const entries = await evaluate(`window.marginDesktop.libraryList()`, true);
    if (entries?.[0]?.lastPage !== 2) throw new Error('Reading progress has not persisted yet');
    return entries[0];
  }, 30, 500);

  const modelStatus = await evaluate(`window.marginDesktop.modelStatus()`, true);
  let embeddingDimensions = null;
  let indexStatus = null;
  let modelLoaded = null;
  let modelReleased = null;
  let persisted = null;
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
    modelLoaded = await evaluate(`window.marginDesktop.modelStatus()`, true);
    if (!modelLoaded?.loaded) throw new Error('Local model process is not reported as loaded');
  }
  await evaluate(`window.location.reload()`);
  persisted = await retry(async () => {
    const shelf = await evaluate(`({
      name: document.querySelector('.book-item strong')?.textContent || '',
      indexed: Boolean(document.querySelector('.book-index'))
    })`);
    if (!shelf.name.includes('margin-reader-smoke') || (testEmbedding && !shelf.indexed)) throw new Error('Bookshelf state has not persisted yet');
    return shelf;
  }, 120, 500);
  await evaluate(`document.querySelector('.book-item')?.click()`);
  const reopened = await retry(async () => {
    const state = await evaluate(`({
      page: document.querySelector('.page-label')?.textContent || '',
      canvasWidth: document.querySelector('.pdf-page[data-page="2"] canvas')?.width || 0,
      index: document.querySelector('.index-strip strong')?.textContent || '',
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (!state.page.includes('2 / 2') || state.canvasWidth <= 0 || (testEmbedding && !state.index.includes('全文索引已就绪'))) throw new Error(`Persisted book or index has not reopened yet: ${JSON.stringify(state)}`);
    return state;
  }, 240, 500);
  if (testEmbedding) {
    modelReleased = await evaluate(`window.marginDesktop.modelUnload()`, true);
    if (modelReleased?.loaded) throw new Error('Local model process did not release memory');
  }
  await evaluate(`(() => { window.confirm = () => true; document.querySelector('.book-remove')?.click(); })()`);
  const removed = await retry(async () => {
    const state = await evaluate(`({ books: document.querySelectorAll('.book-item').length, hasPdf: Boolean(document.querySelector('.pdf-pages')) })`);
    if (state.books !== 0 || state.hasPdf) throw new Error('Book removal has not completed yet');
    return true;
  }, 60, 500);
  console.log(JSON.stringify({ pageOne, pageTwo, modelStatus, embeddingDimensions, indexStatus, modelLoaded, modelReleased, persisted, reopened, removed }));
} finally {
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
  socket.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
}
