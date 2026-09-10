import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureSmokePdf } from './smoke-fixture.mjs';

const executable = process.env.MARGIN_PACKAGED_APP || path.resolve('release', 'win-unpacked', 'Margin.exe');
const pdfPath = path.resolve(process.argv[2] || 'tmp/pdfs/margin-reader-smoke.pdf');
await ensureSmokePdf(pdfPath);
const root = path.resolve('tmp', `region-reading-smoke-${Date.now()}`);
const cdpPort = 9341;
const requests = { glm: [], chat: [] };

const api = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/tags') { response.end(JSON.stringify({ models: [{ name: 'glm-ocr:latest' }] })); return; }
    if (request.url === '/api/ps') { response.end(JSON.stringify({ models: [] })); return; }
    if (request.url === '/api/generate' && body.model === 'glm-ocr:latest') {
      requests.glm.push(body);
      response.end(JSON.stringify({ response: '\\int_0^1 x^2\\,dx = \\frac{1}{3}', done: true }));
      return;
    }
    if (request.url === '/v1/chat/completions' && body.model === 'chat-test') {
      requests.chat.push(body);
      response.end(JSON.stringify({ choices: [{ message: { content: '框选公式的结果是：\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$' } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const address = api.address();
assert.equal(typeof address, 'object');
const baseEndpoint = `http://127.0.0.1:${address.port}`;
const endpoint = `${baseEndpoint}/v1`;
const child = spawn(executable, ['--disable-gpu', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${path.join(root, 'profile')}`], {
  stdio: 'ignore',
  env: { ...process.env, MARGIN_DATA_ROOT: path.join(root, 'data'), MARGIN_LIBRARY_ROOT: path.join(root, 'library') },
});
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function retry(operation, attempts = 120, interval = 500) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); } catch (error) { lastError = error; await delay(interval); }
  }
  throw lastError;
}

let socket;
try {
  const target = await retry(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    const values = await response.json();
    const ready = values.find((candidate) => candidate.url?.startsWith('margin://'));
    if (!ready) throw new Error('Margin renderer is not ready');
    return ready;
  });
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let messageId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id); pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message)); else handlers.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    messageId += 1; pending.set(messageId, { resolve, reject }); socket.send(JSON.stringify({ id: messageId, method, params }));
  });
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Renderer evaluation failed');
    return result.result?.value;
  };
  await command('Runtime.enable');
  await evaluate(`(async () => { const settings = { endpoint: '${endpoint}', model: 'chat-test', apiKey: 'chat-key', systemPrompt: 'Use only supplied content.', glmOcrMode: 'auto', glmOcrProvider: 'ollama', glmOcrEndpoint: '${baseEndpoint}', glmOcrModel: 'glm-ocr:latest', glmOcrApiKey: '', glmOcrAutoStart: true }; localStorage.setItem('margin-settings-schema', '4'); localStorage.setItem('margin-ai-settings', JSON.stringify(settings)); await window.marginDesktop.settingsSave(settings); window.location.reload(); })()`, true);
  await retry(() => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('input[type="file"]'))`).then((ready) => { if (!ready) throw new Error('App not ready'); return ready; }));
  await command('DOM.enable');
  const documentNode = await command('DOM.getDocument');
  const fileInput = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type="file"]' });
  await command('DOM.setFileInputFiles', { files: [pdfPath], nodeId: fileInput.nodeId });
  const canvas = await retry(() => evaluate(`(() => { const canvas = document.querySelector('.pdf-page[data-page="1"] canvas'); if (!canvas || canvas.clientWidth < 400) return null; const rect = canvas.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; })()`).then((value) => { if (!value) throw new Error('PDF canvas not ready'); return value; }));

  const selectRegion = async () => {
    await evaluate(`document.querySelector('.region-select-toggle')?.click()`);
    await retry(() => evaluate(`document.querySelector('.region-select-toggle')?.classList.contains('active')`).then((active) => { if (!active) throw new Error('Region selection mode not active'); return active; }));
    const start = { x: canvas.left + canvas.width * 0.2, y: canvas.top + canvas.height * 0.25 };
    const end = { x: canvas.left + canvas.width * 0.72, y: canvas.top + canvas.height * 0.55 };
    await command('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 });
    await command('Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y, button: 'left' });
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1 });
    await retry(() => evaluate(`({ popover: document.querySelector('.region-action-popover')?.textContent || '', error: document.querySelector('.error-message')?.textContent || '', selection: Boolean(document.querySelector('.region-selection')), selecting: document.querySelector('.pdf-canvas-stage')?.classList.contains('selecting') })`).then((state) => { if (!state.popover.includes('解释公式')) throw new Error(`Region action popover not ready: ${JSON.stringify(state)}`); return state.popover; }), 12);
  };

  await selectRegion();
  await evaluate(`[...document.querySelectorAll('.region-action-popover button')].find((button) => button.textContent?.includes('解释公式'))?.click()`);
  const first = await retry(() => evaluate(`({ answer: document.querySelector('.message.assistant .message-content')?.textContent || '', citation: document.querySelector('.message.assistant .message-citation')?.textContent || '', katex: Boolean(document.querySelector('.message.assistant .katex')), error: document.querySelector('.error-message')?.textContent || '' })`).then((state) => {
    if (state.error) throw new Error(state.error);
    if (!state.answer.includes('框选公式')) throw new Error('Region answer not ready');
    return state;
  }), 180);
  assert.equal(requests.glm.length, 1);
  assert.equal(requests.chat.length, 1);
  assert.equal(requests.glm[0].prompt, 'Formula Recognition:');
  assert.ok(requests.glm[0].images[0].length > 1_000);
  assert.match(requests.chat[0].messages.at(-1).content, /框选了第 1 页/);
  assert.match(first.citation, /第 1 页/);
  assert.equal(first.katex, true);

  await evaluate(`document.querySelector('.message.assistant .message-citation')?.click()`);
  await retry(() => evaluate(`document.querySelector('.region-action-popover')?.textContent || ''`).then((text) => { if (!text.includes('AI 引用区域')) throw new Error('Citation region not revealed'); return text; }));
  await selectRegion();
  await evaluate(`[...document.querySelectorAll('.region-action-popover button')].find((button) => button.textContent?.includes('解释公式'))?.click()`);
  await retry(() => { if (requests.chat.length < 2) throw new Error('Second chat call not ready'); return requests.chat.length; }, 180);
  assert.equal(requests.glm.length, 1, 'identical crop should use the SHA-256 recognition cache');
  console.log(JSON.stringify({ glmRequests: requests.glm.length, chatRequests: requests.chat.length, cropBase64Bytes: requests.glm[0].images[0].length, citation: first.citation, formulaRendered: first.katex }));
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
}
