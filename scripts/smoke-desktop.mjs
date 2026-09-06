import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureSmokePdf } from './smoke-fixture.mjs';

const pdfPath = path.resolve(process.argv[2] || 'tmp/pdfs/margin-reader-smoke.pdf');
await ensureSmokePdf(pdfPath);
const testEmbedding = process.argv.includes('--embedding');
const executable = process.env.MARGIN_PACKAGED_APP || path.resolve('release', 'win-unpacked', 'Margin.exe');
const port = Number(process.env.MARGIN_CDP_PORT || 9333);
const libraryRoot = path.resolve('tmp', `smoke-library-${Date.now()}`);
const dataRoot = testEmbedding ? (process.env.MARGIN_DATA_ROOT || path.join(process.env.APPDATA || libraryRoot, 'Margin')) : path.join(libraryRoot, 'data');
const attachToRunningApp = process.env.MARGIN_CDP_ATTACH === '1';
const child = attachToRunningApp ? null : spawn(executable, ['--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(libraryRoot, 'profile')}`], { stdio: 'ignore', env: { ...process.env, MARGIN_DATA_ROOT: dataRoot, MARGIN_LIBRARY_ROOT: path.join(libraryRoot, 'library') } });

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(operation, attempts = 60, interval = 500) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) { lastError = error; await delay(interval); }
  }
  throw lastError;
}

const target = await retry(async () => {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
  const payload = await response.json();
  const ready = Array.isArray(payload) ? payload.find((candidate) => candidate.url?.startsWith('margin://')) : null;
  if (!ready) throw new Error('Margin renderer is not ready');
  return ready;
});
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

async function openDialog(triggerLabel, expectedText) {
  return retry(async () => {
    const state = await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (dialog) return { open: true, text: dialog.textContent || '' };
      document.querySelector('[aria-label="${triggerLabel}"]')?.click();
      return { open: false, text: '' };
    })()`);
    if (!state.open || !state.text.includes(expectedText)) throw new Error(`${expectedText} dialog is not open yet`);
    return state;
  }, 120, 500);
}

try {
  await command('Runtime.enable');
  await command('DOM.enable');
  const documentNode = await command('DOM.getDocument');
  const fileInput = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type="file"]' });
  await command('DOM.setFileInputFiles', { files: [pdfPath], nodeId: fileInput.nodeId });
  const pageOne = await retry(async () => {
    const state = await evaluate(`({
      page: document.querySelector('.page-label')?.textContent || '',
      canvasWidth: document.querySelector('canvas')?.width || 0,
      canvasCount: document.querySelectorAll('.pdf-page canvas').length,
      scrollHeight: document.querySelector('.canvas-wrap')?.scrollHeight || 0,
      clientHeight: document.querySelector('.canvas-wrap')?.clientHeight || 0,
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (!state.page.includes('1 / 2') || state.canvasWidth <= 1 || state.canvasCount !== 2 || state.scrollHeight <= state.clientHeight) throw new Error(`Page 1 or scroll region has not rendered yet: ${JSON.stringify(state)}`);
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
    if (!state.page.includes('2 / 2') || !state.synced.includes('2') || state.canvasWidth <= 1) throw new Error('Page 2 has not rendered yet');
    return state;
  }, 120, 500);
  const ocrImageBase64 = (await readFile(path.resolve('docs', 'images', 'reader-overview.png'))).toString('base64');
  const ocrResult = await evaluate(`(() => {
    const image = Uint8Array.from(atob('${ocrImageBase64}'), character => character.charCodeAt(0));
    return window.marginDesktop.ocrRecognize(image, 'chi_sim+eng');
  })()`, true);
  if (!/Margin/i.test(ocrResult?.text || '') || !/PDF/i.test(ocrResult?.text || '')) throw new Error(`Packaged OCR failed: ${ocrResult?.text?.slice(0, 200) || 'no text'}`);
  await retry(async () => {
    const entries = await evaluate(`window.marginDesktop.libraryList()`, true);
    if (entries?.[0]?.lastPage !== 2) throw new Error('Reading progress has not persisted yet');
    return entries[0];
  }, 30, 500);

  await evaluate(`document.querySelector('[aria-label="模型设置"]')?.click()`);
  const settingsControls = await retry(async () => {
    const state = await evaluate(`({
      hasSystemPrompt: Boolean(document.querySelector('#system-prompt')),
      promptValue: document.querySelector('#system-prompt')?.value || ''
    })`);
    if (!state.hasSystemPrompt || !state.promptValue.includes('阅读助手')) throw new Error('Custom system prompt control is unavailable');
    return state;
  });
  await evaluate(`(() => {
    const input = document.querySelector('#system-prompt');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '自定义冒烟测试提示词');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await delay(100);
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('保存配置'))?.click()`);
  const savedPrompt = await evaluate(`JSON.parse(localStorage.getItem('margin-ai-settings') || '{}').systemPrompt || ''`);
  if (savedPrompt !== '自定义冒烟测试提示词') throw new Error('Custom system prompt did not persist');
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });

  const modelStatus = await evaluate(`window.marginDesktop.modelStatus()`, true);
  let embeddingDimensions = null;
  let indexStatus = null;
  let modelLoaded = null;
  let modelReleased = null;
  let persisted = null;
  if (testEmbedding) {
    const vectors = await evaluate(`window.marginDesktop.embed([
      'A short PDF retrieval passage.',
      'A second passage for the local batch.',
      '第三个用于批量向量测试的中文片段。',
      'Fourth local embedding test passage.',
      'Fifth passage validates wider Vulkan batches.',
      '第六个片段验证八路并发向量槽。',
      'Seventh local embedding test passage.',
      'Eighth local embedding test passage.'
    ])`, true);
    embeddingDimensions = vectors?.[0]?.length ?? 0;
    if (vectors?.length !== 8 || vectors.some((vector) => vector.length !== 2560)) throw new Error(`Unexpected batched embeddings: ${vectors?.length} x ${embeddingDimensions}`);
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
  const historySeed = await evaluate(`(async () => {
    const book = (await window.marginDesktop.libraryList())[0];
    localStorage.setItem('margin-chat-history-v1', JSON.stringify([{ bookId: book.id, bookName: book.name, updatedAt: new Date().toISOString(), messages: [
      { role: 'user', content: '冒烟测试提问', page: 2, createdAt: new Date().toISOString() },
      { role: 'assistant', content: '冒烟测试回答', page: 2, createdAt: new Date().toISOString() }
    ] }]));
    return { bookId: book.id };
  })()`, true);
  await evaluate(`window.location.reload()`);
  const persistedUi = await retry(async () => {
    const state = await evaluate(`({
      hasSidebar: Boolean(document.querySelector('.app-sidebar')),
      hasLibrary: Boolean(document.querySelector('[aria-label="本地书架"]')),
      settingsAtBottom: Boolean(document.querySelector('.sidebar-bottom [aria-label="模型设置"]'))
    })`);
    if (!state.hasSidebar || !state.hasLibrary || !state.settingsAtBottom) throw new Error('Application sidebar did not persist');
    return state;
  });
  await openDialog('本地书架', '集中管理保存在本机的 PDF');
  persisted = await retry(async () => {
    const shelf = await evaluate(`({
      name: document.querySelector('.book-item strong')?.textContent || '',
      indexed: Boolean(document.querySelector('.book-index'))
    })`);
    if (!shelf.name.includes('margin-reader-smoke') || (testEmbedding && !shelf.indexed)) throw new Error('Bookshelf state has not persisted yet');
    return shelf;
  }, 120, 500);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await openDialog('提问历史', '问答按书籍保存在本机');
  const persistedHistory = await retry(async () => {
    const text = await evaluate(`document.querySelector('.history-item')?.textContent || ''`);
    if (!text.includes('冒烟测试提问') || !text.includes('第 2 页')) throw new Error('Question history did not persist');
    return text;
  });
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
  await openDialog('本地书架', '集中管理保存在本机的 PDF');
  await evaluate(`document.querySelector('.book-item')?.click()`);
  const reopened = await retry(async () => {
    const state = await evaluate(`({
      page: document.querySelector('.page-label')?.textContent || '',
      canvasWidth: document.querySelector('.pdf-page[data-page="2"] canvas')?.width || 0,
      index: document.querySelector('.index-strip strong')?.textContent || '',
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (!state.page.includes('2 / 2') || state.canvasWidth <= 1 || (testEmbedding && !state.index.includes('全文索引已就绪'))) throw new Error(`Persisted book or index has not reopened yet: ${JSON.stringify(state)}`);
    return state;
  }, 240, 500);
  if (testEmbedding) {
    modelReleased = await evaluate(`window.marginDesktop.modelUnload()`, true);
    if (modelReleased?.loaded) throw new Error('Local model process did not release memory');
  }
  await openDialog('本地书架', '集中管理保存在本机的 PDF');
  await evaluate(`(() => { window.confirm = () => true; document.querySelector('.book-remove')?.click(); })()`);
  const removed = await retry(async () => {
    const state = await evaluate(`({ books: document.querySelectorAll('.book-item').length, hasPdf: Boolean(document.querySelector('.pdf-pages')), history: JSON.parse(localStorage.getItem('margin-chat-history-v1') || '[]').length })`);
    if (state.books !== 0 || state.hasPdf || state.history !== 0) throw new Error('Book removal or history cleanup has not completed yet');
    return true;
  }, 60, 500);
  console.log(JSON.stringify({ pageOne, pageTwo, ocrResult: { confidence: ocrResult.confidence, characters: ocrResult.text.length }, settingsControls, savedPrompt, modelStatus, embeddingDimensions, indexStatus, modelLoaded, modelReleased, historySeed, persistedUi, persisted, persistedHistory, reopened, removed }));
} finally {
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
  socket.close();
  if (child?.exitCode === null) child.kill();
  if (child) await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
}
