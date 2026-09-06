import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const executable = process.env.MARGIN_PACKAGED_APP || path.resolve('release', 'win-unpacked', 'Margin.exe');
const pdfPath = path.resolve('tmp', 'pdfs', 'margin-reader-smoke.pdf');
const outputDirectory = path.resolve('docs', 'images');
const captureRoot = path.resolve('tmp', `readme-capture-${Date.now()}`);
const port = 9555;
const child = spawn(executable, [
  '--disable-gpu',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${path.join(captureRoot, 'profile')}`,
], {
  stdio: 'ignore',
  env: { ...process.env, MARGIN_LIBRARY_ROOT: path.join(captureRoot, 'library') },
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(operation, attempts = 120, interval = 500) {
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
  const waiter = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message));
  else waiter.resolve(message.result);
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Renderer evaluation failed');
  return result.result?.value;
}

async function capture(fileName) {
  const result = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true });
  await writeFile(path.join(outputDirectory, fileName), Buffer.from(result.data, 'base64'));
}

try {
  await mkdir(outputDirectory, { recursive: true });
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  const pdfBase64 = (await readFile(pdfPath)).toString('base64');
  await evaluate(`(() => {
    localStorage.clear();
    const bytes = Uint8Array.from(atob('${pdfBase64}'), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'Margin-Reader-Demo.pdf', { type: 'application/pdf' }));
    const input = document.querySelector('input[type="file"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const book = await retry(async () => {
    const state = await evaluate(`(async () => ({
      page: document.querySelector('.page-label')?.textContent || '',
      entries: await window.marginDesktop.libraryList()
    }))()`, true);
    if (!state.entries.some((entry) => entry.name.includes('Margin-Reader-Demo')) || !state.page.includes('1 / 2')) throw new Error('Demo PDF has not opened');
    return state.entries[0];
  });
  await evaluate(`(() => {
    const now = new Date().toISOString();
    localStorage.setItem('margin-chat-history-v1', JSON.stringify([{
      bookId: ${JSON.stringify(book.id)},
      bookName: 'Margin-Reader-Demo.pdf',
      updatedAt: now,
      messages: [
        { role: 'user', content: '请概括当前页的核心内容。', page: 1, createdAt: now },
        { role: 'assistant', content: '当前页展示了一个简洁的本地 PDF 阅读示例。阅读区与页码保持同步，左侧书架保存文档进度，右侧助手可结合当前页和全文索引回答问题。', page: 1, createdAt: now }
      ]
    }]));
    localStorage.setItem('margin-ai-settings', JSON.stringify({
      glmOcrMode: 'auto',
      glmOcrEndpoint: 'http://127.0.0.1:11434/v1',
      glmOcrModel: 'glm-ocr:latest',
      glmOcrApiKey: ''
    }));
    window.location.reload();
  })()`);
  await retry(async () => {
    const ready = await evaluate(`Boolean(document.querySelector('[aria-label="本地书架"]'))`);
    if (!ready) throw new Error('Sidebar has not restored');
    return ready;
  });
  await evaluate(`document.querySelector('[aria-label="本地书架"]')?.click()`);
  await evaluate(`document.querySelector('.book-item')?.click()`);
  await retry(async () => {
    const state = await evaluate(`({ page: document.querySelector('.page-label')?.textContent || '', messages: document.querySelectorAll('.message').length })`);
    if (!state.page.includes('1 / 2') || state.messages !== 2) throw new Error('Demo reader has not restored');
    return state;
  });
  await capture('reader-overview.png');

  await evaluate(`document.querySelector('[aria-label="模型设置"]')?.click()`);
  await retry(async () => {
    const visible = await evaluate(`Boolean(document.querySelector('#system-prompt'))`);
    if (!visible) throw new Error('Settings dialog has not opened');
    return visible;
  });
  await evaluate(`document.querySelector('#glm-ocr-mode')?.scrollIntoView({ block: 'center' })`);
  await delay(200);
  await capture('model-settings.png');
  console.log(`Captured README screenshots in ${outputDirectory}`);
} finally {
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
  socket.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
}
