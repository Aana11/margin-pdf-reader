import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const executable =
  process.env.MARGIN_PACKAGED_APP ||
  path.resolve('release', 'win-unpacked', 'Margin.exe');
const pdfPath = path.resolve('tmp', 'pdfs', 'margin-reader-smoke.pdf');
const outputDirectory = path.resolve('docs', 'images');
const captureRoot = path.resolve('tmp', `readme-capture-${Date.now()}`);
const port = 9555;
const child = spawn(
  executable,
  [
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(captureRoot, 'profile')}`,
  ],
  {
    stdio: 'ignore',
    env: {
      ...process.env,
      MARGIN_DATA_ROOT: path.join(captureRoot, 'data'),
      MARGIN_LIBRARY_ROOT: path.join(captureRoot, 'library'),
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

const target = await retry(async () => {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) throw new Error(`CDP discovery failed: ${response.status}`);
  const payload = await response.json();
  const ready = Array.isArray(payload)
    ? payload.find((candidate) => candidate.url?.startsWith('margin://'))
    : null;
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
}

async function capture(fileName) {
  const result = await command('Page.captureScreenshot', {
    format: 'jpeg',
    quality: 88,
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(
    path.join(outputDirectory, fileName),
    Buffer.from(result.data, 'base64'),
  );
}

try {
  await mkdir(outputDirectory, { recursive: true });
  await command('Runtime.enable');
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
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
    const state = await evaluate(
      `(async () => ({
      page: document.querySelector('.page-scroll-indicator')?.textContent || '',
      entries: await window.marginDesktop.libraryList()
    }))()`,
      true,
    );
    if (
      !state.entries.some((entry) =>
        entry.name.includes('Margin-Reader-Demo'),
      ) ||
      !state.page.includes('1 / 2')
    )
      throw new Error('Demo PDF has not opened');
    return state.entries[0];
  });
  const demoLibrary = await evaluate(
    `(async () => {
    const bytes = Uint8Array.from(atob('${pdfBase64}'), character => character.charCodeAt(0));
    const calculus = await window.marginDesktop.libraryImport('微积分公式手册.pdf', bytes.buffer);
    const geometry = await window.marginDesktop.libraryImport('解析几何讲义.pdf', bytes.buffer);
    const core = await window.marginDesktop.knowledgeCreate({ name: '高等数学核心', description: '代数、微积分与公式推导的跨书问答' });
    await window.marginDesktop.knowledgeUpdate(core.id, { bookIds: [${JSON.stringify(book.id)}, calculus.id] });
    const review = await window.marginDesktop.knowledgeCreate({ name: '期末复习资料', description: '只检索本次复习范围' });
    await window.marginDesktop.knowledgeUpdate(review.id, { bookIds: [calculus.id, geometry.id] });
    return { calculus: calculus.id, geometry: geometry.id, core: core.id, review: review.id };
  })()`,
    true,
  );
  await evaluate(
    `(async () => {
    const now = new Date().toISOString();
    await window.marginDesktop.workspaceChatReplace(${JSON.stringify(book.id)}, 'Margin-Reader-Demo.pdf', [
      { role: 'user', content: '请概括当前页的核心内容。', page: 1, createdAt: now },
      { role: 'assistant', content: '当前页展示了一个简洁的本地 PDF 阅读示例。阅读区与页码保持同步，左侧书架保存文档进度，右侧助手可结合当前页和全文索引回答问题。', page: 1, createdAt: now }
    ]);
    await window.marginDesktop.workspaceNoteSave(${JSON.stringify(book.id)}, 'Margin-Reader-Demo.pdf', { kind: 'highlight', page: 1, title: '本地优先阅读流程', content: '', excerpt: 'PDF 在本机解析，只有主动提问时才发送必要文本。', color: '#f4cf65', region: { x: .1, y: .05, width: .78, height: .19 } });
    await window.marginDesktop.workspaceNoteSave(${JSON.stringify(book.id)}, 'Margin-Reader-Demo.pdf', { kind: 'note', page: 1, title: '阅读与 AI 同屏', content: '适合记录需要回看的页面布局与交互方式。', excerpt: '阅读区与助手保持页码同步。', color: '#f2a56f', region: { x: .12, y: .36, width: .55, height: .12 } });
    await window.marginDesktop.workspaceNoteSave(${JSON.stringify(book.id)}, 'Margin-Reader-Demo.pdf', { kind: 'summary', page: 1, title: 'Margin 核心能力', content: '本地书架、连续阅读、全文检索、GLM-OCR 精读与可追溯的阅读资料。', excerpt: '', color: '#8cc8ef' });
    await window.marginDesktop.workspaceNoteSave(${JSON.stringify(book.id)}, 'Margin-Reader-Demo.pdf', { kind: 'glossary', page: 1, title: 'RAG', content: '先检索相关原文，再让对话模型基于证据回答。', excerpt: '全文向量检索', color: '#79d8cc', region: { x: .18, y: .62, width: .32, height: .08 } });
    localStorage.setItem('margin-settings-schema', '3');
    localStorage.setItem('margin-ai-settings', JSON.stringify({
      glmOcrMode: 'auto',
      glmOcrProvider: 'managed',
      glmOcrEndpoint: '',
      glmOcrModel: 'ggml-org/GLM-OCR-GGUF',
      glmOcrApiKey: '',
      glmOcrAutoStart: true
    }));
    return true;
  })()`,
    true,
  );
  await evaluate(`window.location.reload()`);
  await retry(async () => {
    const ready = await evaluate(
      `Boolean(document.querySelector('[aria-label="本地书架"]'))`,
    );
    if (!ready) throw new Error('Sidebar has not restored');
    return ready;
  });
  await evaluate(`document.querySelector('[aria-label="本地书架"]')?.click()`);
  await evaluate(
    `[...document.querySelectorAll('.book-item')].find((item) => item.textContent?.includes('Margin-Reader-Demo'))?.click()`,
  );
  await retry(async () => {
    const state = await evaluate(
      `({ page: document.querySelector('.page-scroll-indicator')?.textContent || '', messages: document.querySelectorAll('.message').length })`,
    );
    if (!state.page.includes('1 / 2') || state.messages !== 2)
      throw new Error('Demo reader has not restored');
    return state;
  });
  await capture('reader-overview.jpg');

  await evaluate(
    `document.querySelector('[aria-label="跨书知识包"]')?.click()`,
  );
  await retry(async () => {
    const state = await evaluate(
      `({ dialog: Boolean(document.querySelector('.knowledge-dialog')), nodes: document.querySelectorAll('.knowledge-pack-node').length, members: document.querySelectorAll('.knowledge-tree-books button').length })`,
    );
    if (!state.dialog || state.nodes !== 2 || state.members !== 4)
      throw new Error(
        `Knowledge pack demo has not opened: ${JSON.stringify(state)}`,
      );
    return state;
  });
  await delay(800);
  await capture('knowledge-packs.jpg');
  await evaluate(
    `document.querySelector('[role="dialog"][data-open] [data-slot="dialog-close"]')?.click()`,
  );
  await retry(async () => {
    const open = await evaluate(
      `Boolean(document.querySelector('[role="dialog"][data-open]'))`,
    );
    if (open) throw new Error('Knowledge pack dialog is still closing');
    return true;
  });
  await delay(600);

  const canvas = await retry(async () => {
    const bounds = await evaluate(
      `(() => { const canvas = document.querySelector('.pdf-page[data-page="1"] canvas'); if (!canvas || canvas.clientWidth < 400) return null; const rect = canvas.getBoundingClientRect(); return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }; })()`,
    );
    if (!bounds)
      throw new Error('Demo page canvas is not ready for region capture');
    return bounds;
  });
  await evaluate(`document.querySelector('.region-select-toggle')?.click()`);
  await retry(async () => {
    const active = await evaluate(
      `document.querySelector('.region-select-toggle')?.classList.contains('active')`,
    );
    if (!active) throw new Error('Region selection mode has not activated');
    return active;
  });
  const regionStart = {
    x: canvas.left + canvas.width * 0.1,
    y: canvas.top + canvas.height * 0.05,
  };
  const regionEnd = {
    x: canvas.left + canvas.width * 0.88,
    y: canvas.top + canvas.height * 0.24,
  };
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: regionStart.x,
    y: regionStart.y,
    button: 'left',
    clickCount: 1,
  });
  await command('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: regionEnd.x,
    y: regionEnd.y,
    button: 'left',
  });
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: regionEnd.x,
    y: regionEnd.y,
    button: 'left',
    clickCount: 1,
  });
  await retry(async () => {
    const ready = await evaluate(
      `Boolean(document.querySelector('.region-action-popover'))`,
    );
    if (!ready) throw new Error('Region action popover has not appeared');
    return ready;
  });
  await capture('region-reading.jpg');

  await evaluate(`document.querySelector('.region-action-close')?.click()`);
  await evaluate(`document.querySelector('[aria-label="阅读资料"]')?.click()`);
  await retry(async () => {
    const text = await evaluate(
      `document.querySelector('.workspace-dialog')?.textContent || ''`,
    );
    if (!text.includes('Margin 核心能力') || !text.includes('RAG'))
      throw new Error('Reading workspace has not opened');
    return text;
  });
  await capture('reading-workspace.jpg');
  await evaluate(
    `document.querySelector('[role="dialog"][data-open] [data-slot="dialog-close"]')?.click()`,
  );

  await evaluate(`(() => {
    const now = new Date().toISOString();
    localStorage.setItem('margin-index-tasks-v1', JSON.stringify([{
      id: 'demo-index-task', bookId: ${JSON.stringify(book.id)}, bookName: 'Margin-Reader-Demo.pdf', status: 'paused', stage: 'embedding', progress: 63,
      message: '索引已暂停在 63%，可从 SQLite 检查点继续', pageCount: 186, completedPages: 186, chunks: 428, completedChunks: 271,
      ocrPages: 38, skippedPages: 6, failedPages: [117], backend: 'vulkan', lanes: { text: 8, ocr: 4, embedding: 8 },
      timings: { preparing: 1320, extracting: 6840, ocr: 92400, chunking: 380, embedding: 48100 }, createdAt: now, updatedAt: now
    }]));
    window.location.reload();
  })()`);
  await retry(async () => {
    const ready = await evaluate(
      `Boolean(document.querySelector('[aria-label="索引任务"]'))`,
    );
    if (!ready) throw new Error('Task center trigger has not restored');
    return ready;
  });
  await delay(500);
  await evaluate(`document.querySelector('[aria-label="索引任务"]')?.click()`);
  await retry(async () => {
    const visible = await evaluate(
      `Boolean(document.querySelector('.index-task-card'))`,
    );
    if (!visible) throw new Error('Task center has not opened');
    return visible;
  });
  await capture('index-task-center.jpg');
  await evaluate(`window.location.reload()`);
  await retry(async () => {
    const ready = await evaluate(
      `Boolean(document.querySelector('[aria-label="模型设置"]'))`,
    );
    if (!ready) throw new Error('Settings trigger has not restored');
    return ready;
  });
  await delay(500);
  await evaluate(`document.querySelector('[aria-label="模型设置"]')?.click()`);
  await retry(async () => {
    const visible = await evaluate(
      `Boolean(document.querySelector('#system-prompt'))`,
    );
    if (!visible) throw new Error('Settings dialog has not opened');
    return visible;
  });
  await evaluate(
    `document.querySelector('#glm-ocr-mode')?.scrollIntoView({ block: 'center' })`,
  );
  await delay(200);
  await capture('model-settings.jpg');
  console.log(
    `Captured README screenshots in ${outputDirectory}; knowledge demo ${JSON.stringify(demoLibrary)}`,
  );
} finally {
  await Promise.race([
    command('Browser.close').catch(() => undefined),
    delay(2_000),
  ]);
  socket.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000),
  ]);
}
