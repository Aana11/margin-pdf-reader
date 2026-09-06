import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureSmokePdf } from './smoke-fixture.mjs';

const executable = process.env.MARGIN_PACKAGED_APP || path.resolve('release', 'win-unpacked', 'Margin.exe');
const pdfPath = path.resolve(process.argv[2] || 'tmp/pdfs/margin-reader-smoke.pdf');
await ensureSmokePdf(pdfPath);
const root = path.resolve('tmp', `deep-reading-smoke-${Date.now()}`);
const cdpPort = 9338;
const requests = { glm: [], chat: [], embedding: 0 };

const api = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/embeddings') {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      requests.embedding += inputs.length;
      response.end(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0, 0, 0, 0, 0, 0] })) }));
      return;
    }
    if (request.url === '/v1/chat/completions' && body.model === 'glm-ocr') {
      requests.glm.push(body);
      response.end(JSON.stringify({ choices: [{ message: { content: '\\int_0^1 x^2\\,dx = \\frac{1}{3}' } }] }));
      return;
    }
    if (request.url === '/v1/chat/completions' && body.model === 'chat-test') {
      requests.chat.push(body);
      response.end(JSON.stringify({ choices: [{ message: { content: '已结合 GLM-OCR 精读结果回答。' } }] }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const apiAddress = api.address();
assert.equal(typeof apiAddress, 'object');
const endpoint = `http://127.0.0.1:${apiAddress.port}/v1`;
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
  await evaluate(`localStorage.setItem('margin-ai-settings', JSON.stringify({ endpoint: '${endpoint}', model: 'chat-test', apiKey: 'chat-key', systemPrompt: 'Use supplied context.', embeddingKind: 'openai-compatible', embeddingEndpoint: '${endpoint}', embeddingModel: 'embed-test', embeddingApiKey: 'embed-key', ocrMode: 'auto', ocrLanguage: 'eng', glmOcrMode: 'auto', glmOcrEndpoint: '${endpoint}', glmOcrModel: 'glm-ocr', glmOcrApiKey: '' })); window.location.reload()`);
  await retry(() => evaluate(`document.readyState === 'complete' && Boolean(document.querySelector('input[type="file"]'))`).then((ready) => { if (!ready) throw new Error('App not ready'); return ready; }));
  await command('DOM.enable');
  const documentNode = await command('DOM.getDocument');
  const fileInput = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: 'input[type="file"]' });
  await command('DOM.setFileInputFiles', { files: [pdfPath], nodeId: fileInput.nodeId });
  await retry(() => evaluate(`document.querySelector('.page-label')?.textContent || ''`).then((text) => { if (!text.includes('1 / 2')) throw new Error('PDF not open'); return text; }));
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent?.includes('建立索引'))?.click()`);
  await retry(() => evaluate(`({ status: document.querySelector('.index-strip strong')?.textContent || '', error: document.querySelector('.error-message')?.textContent || '' })`).then((state) => {
    if (state.error) throw new Error(state.error);
    if (!state.status.includes('全文索引已就绪')) throw new Error('Index not ready');
    return state;
  }), 180);
  await evaluate(`(() => { const input = document.querySelector('[aria-label="输入问题"]'); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(input, '请精读向量命中页中的公式并解释'); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await evaluate(`document.querySelector('[aria-label="发送"]')?.click()`);
  const ui = await retry(() => evaluate(`({ answer: [...document.querySelectorAll('.message.assistant p')].at(-1)?.textContent || '', status: document.querySelector('.deep-read-status')?.textContent || '', error: document.querySelector('.error-message')?.textContent || '' })`).then((state) => {
    if (state.error) throw new Error(state.error);
    if (!state.answer.includes('GLM-OCR')) throw new Error('Answer not ready');
    return state;
  }), 180);
  assert.ok(requests.embedding > 0);
  assert.equal(requests.glm.length, 2);
  assert.equal(requests.chat.length, 1);
  assert.match(requests.glm[0].messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.match(requests.chat[0].messages.at(-1).content, /\\int_0\^1/);
  assert.match(ui.status, /已精读 2 页/);
  console.log(JSON.stringify({ embeddingInputs: requests.embedding, glmRequests: requests.glm.length, chatRequests: requests.chat.length, status: ui.status, answer: ui.answer }));
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  await new Promise((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
}
