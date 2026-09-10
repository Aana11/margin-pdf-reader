import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ensureSmokePdf } from './smoke-fixture.mjs';

const pdfPath = path.resolve('tmp/pdfs/margin-reader-smoke.pdf');
await ensureSmokePdf(pdfPath);
const executable =
  process.env.MARGIN_PACKAGED_APP ||
  path.resolve('release', 'win-unpacked', 'Margin.exe');
const root = path.resolve('tmp', `knowledge-pack-smoke-${Date.now()}`);
const cdpPort = Number(process.env.MARGIN_CDP_PORT || 9342);
const requests = { embedding: [], chat: [] };

const api = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization',
  );
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
      requests.embedding.push(body);
      response.end(
        JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }),
      );
      return;
    }
    if (request.url === '/v1/chat/completions') {
      requests.chat.push(body);
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '线性空间和坐标方法可以联合理解。【《高等代数.pdf》· 第 1 页】【《解析几何.pdf》· 第 2 页】',
              },
            },
          ],
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not found' }));
  });
});
await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
const address = api.address();
assert.equal(typeof address, 'object');
const endpoint = `http://127.0.0.1:${address.port}/v1`;
const providerId = `remote:${endpoint}:embed-test`;

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
      MARGIN_DATA_ROOT: path.join(root, 'data'),
      MARGIN_LIBRARY_ROOT: path.join(root, 'library'),
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
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
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
  const pdfBase64 = (await readFile(pdfPath)).toString('base64');
  const seeded = await evaluate(
    `(async () => {
    const settings = {
      endpoint: ${JSON.stringify(endpoint)}, model: 'chat-test', apiKey: 'chat-key', systemPrompt: 'Use only supplied sources.',
      embeddingKind: 'openai-compatible', embeddingEndpoint: ${JSON.stringify(endpoint)}, embeddingModel: 'embed-test', embeddingApiKey: 'embed-key',
      ocrMode: 'off', ocrLanguage: 'eng', glmOcrMode: 'off', glmOcrProvider: 'managed', glmOcrEndpoint: '', glmOcrModel: 'ggml-org/GLM-OCR-GGUF', glmOcrApiKey: '', glmOcrAutoStart: true
    };
    localStorage.setItem('margin-settings-schema', '4');
    localStorage.setItem('margin-ai-settings', JSON.stringify(settings));
    await window.marginDesktop.settingsSave(settings);
    const bytes = Uint8Array.from(atob('${pdfBase64}'), character => character.charCodeAt(0));
    const algebra = await window.marginDesktop.libraryImport('高等代数.pdf', bytes.buffer);
    const geometry = await window.marginDesktop.libraryImport('解析几何.pdf', bytes.buffer);
    const excluded = await window.marginDesktop.libraryImport('未纳入但更相似.pdf', bytes.buffer);
    const index = async (book, page, text, vector) => {
      await window.marginDesktop.libraryIndexStart(book.id, ${JSON.stringify(providerId)}, 3, 'knowledge-smoke');
      await window.marginDesktop.libraryIndexAppend(book.id, [{ id: book.id + '-chunk', page, text, vector }]);
      await window.marginDesktop.libraryIndexFinish(book.id);
    };
    await index(algebra, 1, '线性空间的定义、基和维数。', [0.95, 0.05, 0]);
    await index(geometry, 2, '向量坐标与线性变换的几何解释。', [0.85, 0.15, 0]);
    await index(excluded, 3, '线性空间最相似但不允许进入知识包。', [1, 0, 0]);
    const pack = await window.marginDesktop.knowledgeCreate({ name: '代数联合知识库', description: '两本指定教材' });
    await window.marginDesktop.knowledgeUpdate(pack.id, { bookIds: [algebra.id, geometry.id] });
    return { algebra, geometry, excluded, pack };
  })()`,
    true,
  );
  await evaluate('window.location.reload()');
  await retry(async () => {
    const ready = await evaluate(
      `Boolean(document.querySelector('[aria-label="跨书知识包"]'))`,
    );
    if (!ready) throw new Error('Knowledge pack UI is not ready');
    return true;
  });
  await evaluate(
    `document.querySelector('[aria-label="跨书知识包"]')?.click()`,
  );
  await retry(async () => {
    const state = await evaluate(`({
      dialog: Boolean(document.querySelector('.knowledge-dialog')),
      pack: document.querySelector('.knowledge-pack-node')?.textContent || '',
      nested: [...document.querySelectorAll('.knowledge-tree-books button')].map((item) => item.textContent),
      checked: document.querySelectorAll('.knowledge-member input:checked').length
    })`);
    if (!state.dialog) {
      await evaluate(
        `document.querySelector('[aria-label="跨书知识包"]')?.click()`,
      );
      throw new Error('Knowledge pack dialog is not open');
    }
    if (
      !state.pack.includes('代数联合知识库') ||
      state.nested.length !== 2 ||
      state.nested.some((name) => name.includes('未纳入')) ||
      state.checked !== 2
    )
      throw new Error(`Visible containment failed: ${JSON.stringify(state)}`);
    return state;
  });
  await evaluate(
    `[...document.querySelectorAll('.knowledge-editor-actions button')].find((button) => button.textContent?.includes('用此知识包提问'))?.click()`,
  );
  await retry(async () => {
    const scope = await evaluate(
      `document.querySelector('.ai-scope')?.textContent || ''`,
    );
    if (!scope.includes('代数联合知识库') || !scope.includes('2 本书'))
      throw new Error('Knowledge pack scope is not active');
    return scope;
  });
  await evaluate(`(() => {
    const input = document.querySelector('[aria-label="输入问题"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '线性空间与坐标方法有什么联系？');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(`document.querySelector('[aria-label="发送"]')?.click()`);
  const ui = await retry(async () => {
    const state = await evaluate(`({
      answer: [...document.querySelectorAll('.message.assistant .message-content')].at(-1)?.textContent || '',
      sources: [...document.querySelectorAll('.message.assistant .message-sources button')].map((item) => item.textContent),
      status: document.querySelector('.knowledge-search-status')?.textContent || '',
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (!state.answer.includes('线性空间') || state.sources.length !== 2)
      throw new Error(
        `Knowledge answer is not ready: ${JSON.stringify(state)}`,
      );
    return state;
  });
  assert.equal(
    requests.embedding.length,
    1,
    'query embedding must be computed once',
  );
  assert.equal(requests.chat.length, 1);
  const context = JSON.stringify(requests.chat[0]);
  assert.match(context, /高等代数\.pdf/);
  assert.match(context, /解析几何\.pdf/);
  assert.doesNotMatch(context, /未纳入但更相似/);
  assert.ok(ui.sources.every((source) => !source.includes('未纳入')));

  await evaluate(
    `document.querySelector('.knowledge-filters summary')?.click()`,
  );
  await evaluate(`(() => {
    const label = [...document.querySelectorAll('.knowledge-filter-books label')].find((item) => item.textContent?.includes('解析几何.pdf'));
    label?.querySelector('input')?.click();
    const input = document.querySelector('[aria-label="输入问题"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '只从高等代数中说明线性空间。');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(`document.querySelector('[aria-label="发送"]')?.click()`);
  const filteredUi = await retry(async () => {
    const state = await evaluate(`({
      sources: [...document.querySelectorAll('.message.assistant')].at(-1)?.querySelectorAll('.message-sources button').length || 0,
      status: document.querySelector('.knowledge-search-status')?.textContent || '',
      error: document.querySelector('.error-message')?.textContent || ''
    })`);
    if (state.error) throw new Error(state.error);
    if (state.sources !== 1 || !state.status.includes('1 / 1'))
      throw new Error(
        `Filtered knowledge answer is not ready: ${JSON.stringify(state)}`,
      );
    return state;
  });
  assert.equal(requests.embedding.length, 2);
  assert.equal(requests.chat.length, 2);
  const filteredContext = JSON.stringify(requests.chat[1]);
  assert.match(filteredContext, /高等代数\.pdf/);
  assert.doesNotMatch(filteredContext, /解析几何\.pdf/);

  const storedMessages = await evaluate(
    `window.marginDesktop.workspaceChatLoad(${JSON.stringify(`pack_${seeded.pack.id}`)}, 100)`,
    true,
  );
  assert.equal(storedMessages.length, 4);
  assert.equal(storedMessages[1].sources.length, 2);
  assert.equal(storedMessages[3].sources.length, 1);
  await evaluate('window.location.reload()');
  await retry(async () => {
    const ready = await evaluate(
      `Boolean(document.querySelector('[aria-label="跨书知识包"]'))`,
    );
    if (!ready) throw new Error('Knowledge UI did not restore');
    return true;
  });
  await retry(async () => {
    const open = await evaluate(
      `Boolean(document.querySelector('.knowledge-dialog'))`,
    );
    if (!open) {
      await evaluate(
        `document.querySelector('[aria-label="跨书知识包"]')?.click()`,
      );
      throw new Error('Knowledge dialog is not open');
    }
    return true;
  });
  await evaluate(
    `[...document.querySelectorAll('.knowledge-editor-actions button')].find((button) => button.textContent?.includes('用此知识包提问'))?.click()`,
  );
  await retry(async () => {
    const sourceCount = await evaluate(
      `document.querySelectorAll('.message.assistant .message-sources button').length`,
    );
    if (sourceCount !== 3)
      throw new Error('Persisted source cards did not restore');
    return sourceCount;
  });

  await evaluate(
    `document.querySelector('.message.assistant .message-sources button')?.click()`,
  );
  const navigation = await retry(async () => {
    const state = await evaluate(`({
      file: document.querySelector('.ai-scope strong')?.textContent || '',
      page: document.querySelector('.page-scroll-indicator')?.textContent || '',
      sources: document.querySelectorAll('.message.assistant .message-sources button').length
    })`);
    if (!state.page.includes('1 / 2') || state.sources !== 3)
      throw new Error(`Source navigation failed: ${JSON.stringify(state)}`);
    return state;
  });
  console.log(
    JSON.stringify({
      seeded: {
        included: [seeded.algebra.name, seeded.geometry.name],
        excluded: seeded.excluded.name,
      },
      embeddingRequests: requests.embedding.length,
      chatRequests: requests.chat.length,
      persistedSources: storedMessages[1].sources.length,
      ui,
      filteredUi,
      navigation,
    }),
  );
} finally {
  if (socket) {
    await Promise.race([
      new Promise((resolve) => {
        const id = 999999;
        socket.send(JSON.stringify({ id, method: 'Browser.close' }));
        setTimeout(resolve, 1_000);
      }),
      delay(1_500),
    ]);
    socket.close();
  }
  if (child.exitCode === null) child.kill();
  api.close();
}
