import { spawn } from 'node:child_process';
import path from 'node:path';

const requestedName = process.argv.slice(2).join(' ').trim();
const executable = path.resolve('release', 'win-unpacked', 'Margin.exe');
const port = 9444;
const child = spawn(executable, [`--remote-debugging-port=${port}`], { stdio: 'ignore', env: process.env });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(operation, attempts = 120, interval = 500) {
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

try {
  await command('Runtime.enable');
  const books = await retry(async () => {
    const entries = await evaluate('window.marginDesktop.libraryList()', true);
    if (!entries?.length) throw new Error('The local bookshelf is empty');
    return entries;
  });
  const book = requestedName ? books.find((entry) => entry.name.includes(requestedName)) : books[0];
  if (!book) throw new Error(`No bookshelf entry matches: ${requestedName}`);
  console.log(JSON.stringify({ event: 'book-selected', book }));

  const prepared = await evaluate('window.marginDesktop.modelPrepare()', true);
  console.log(JSON.stringify({ event: 'model-prepared', prepared }));

  await evaluate(`(() => {
    const name = ${JSON.stringify(book.name)};
    const row = [...document.querySelectorAll('.book-row')].find((candidate) => candidate.querySelector('.book-item strong')?.textContent === name);
    row?.querySelector('.book-item')?.click();
  })()`);
  await retry(async () => {
    const state = await evaluate(`({ page: document.querySelector('.page-label')?.textContent || '', error: document.querySelector('.error-message')?.textContent || '' })`);
    if (state.error) throw new Error(state.error);
    if (!state.page.includes(`/ ${book.pageCount}`)) throw new Error(`PDF has not opened: ${state.page}`);
    return state;
  }, 240, 500);
  console.log(JSON.stringify({ event: 'pdf-opened', name: book.name, pages: book.pageCount }));

  await evaluate(`[...document.querySelectorAll('.index-strip button')].find((button) => /建立索引|重新索引|重试/.test(button.textContent || ''))?.click()`);
  let previousMessage = '';
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    const state = await evaluate(`({
      label: document.querySelector('.index-strip strong')?.textContent || '',
      message: document.querySelector('.index-strip span')?.textContent || '',
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.message !== previousMessage) {
      previousMessage = state.message;
      console.log(JSON.stringify({ event: 'index-progress', ...state }));
    }
    if (state.error || /索引失败/.test(state.label)) throw new Error(state.error || state.message || state.label);
    if (/全文索引已就绪/.test(state.label)) {
      const status = await evaluate('window.marginDesktop.modelStatus()', true);
      console.log(JSON.stringify({ event: 'index-complete', state, status }));
      break;
    }
    if (attempt === 3599) throw new Error(`Index timeout: ${JSON.stringify(state)}`);
    await delay(1000);
  }
  await evaluate('window.marginDesktop.modelUnload()', true);
} finally {
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
  socket.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
}
