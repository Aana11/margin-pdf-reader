import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const executable = process.env.MARGIN_PACKAGED_APP || path.resolve('release', 'win-unpacked', 'Margin.exe');
const port = 9666;
const root = path.resolve('tmp', `smoke-ocr-${Date.now()}`);
const child = spawn(executable, ['--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, 'profile')}`], {
  stdio: 'ignore',
  env: { ...process.env, MARGIN_DATA_ROOT: path.join(root, 'data'), MARGIN_LIBRARY_ROOT: path.join(root, 'library') },
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function retry(operation, attempts = 180, interval = 500) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) { lastError = error; await delay(interval); }
  }
  throw lastError;
}

function scannedPdf(jpeg, width, height) {
  const parts = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets = [0];
  const object = (number, body) => {
    offsets[number] = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(Buffer.from(`${number} 0 obj\n`, 'ascii'), body, Buffer.from('\nendobj\n', 'ascii'));
  };
  object(1, Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'ascii'));
  object(2, Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>', 'ascii'));
  object(3, Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Image0 5 0 R >> >> /Contents 4 0 R >>', 'ascii'));
  const content = Buffer.from('q 612 0 0 792 0 0 cm /Image0 Do Q', 'ascii');
  object(4, Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`, 'ascii'), content, Buffer.from('\nendstream', 'ascii')]));
  object(5, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`, 'ascii'), jpeg, Buffer.from('\nendstream', 'ascii')]));
  const xrefOffset = parts.reduce((sum, part) => sum + part.length, 0);
  const xref = [`xref\n0 6\n`, '0000000000 65535 f \n'];
  for (let index = 1; index <= 5; index += 1) xref.push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  parts.push(Buffer.from(`${xref.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'ascii'));
  return Buffer.concat(parts);
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
  await command('Page.enable');
  await command('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1600, deviceScaleFactor: 1, mobile: false });
  await evaluate(`document.body.innerHTML = '<main style="padding:140px;background:white;color:black;font-family:Arial"><h1 style="font-size:92px">ORCHID ALPHA</h1><p style="font-size:52px;line-height:1.5">Scanned PDF OCR verification page 2026</p></main>'`);
  const screenshot = await command('Page.captureScreenshot', { format: 'jpeg', quality: 95, captureBeyondViewport: false, fromSurface: true });
  const pdf = scannedPdf(Buffer.from(screenshot.data, 'base64'), 1200, 1600);

  await command('Page.reload');
  await retry(async () => {
    if (!await evaluate(`Boolean(document.querySelector('[aria-label="模型设置"]'))`)) throw new Error('Margin did not reload');
    return true;
  });
  await evaluate(`(() => {
    localStorage.setItem('margin-ai-settings', JSON.stringify({
      embeddingKind: 'openai-compatible',
      embeddingEndpoint: 'https://fixture.local/v1',
      embeddingModel: 'fixture-embedding',
      embeddingApiKey: 'fixture',
      ocrMode: 'auto',
      ocrLanguage: 'eng'
    }));
    window.location.reload();
  })()`);
  await retry(async () => {
    if (!await evaluate(`Boolean(document.querySelector('input[type="file"]'))`)) throw new Error('Margin settings did not reload');
    return true;
  });
  await evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).startsWith('https://fixture.local/v1/embeddings')) {
        const body = JSON.parse(init.body);
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Promise.resolve(new Response(JSON.stringify({ data: inputs.map((_, index) => ({ index, embedding: [1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125] })) }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return originalFetch(input, init);
    };
  })()`);
  const pdfBase64 = pdf.toString('base64');
  await evaluate(`(() => {
    const bytes = Uint8Array.from(atob('${pdfBase64}'), character => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'scanned-ocr-fixture.pdf', { type: 'application/pdf' }));
    const input = document.querySelector('input[type="file"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await retry(async () => {
    const state = await evaluate(`({ page: document.querySelector('.page-label')?.textContent || '', error: document.querySelector('.error-message')?.textContent || '' })`);
    if (state.error) throw new Error(state.error);
    if (!state.page.includes('1 / 1')) throw new Error('Scanned PDF has not opened');
    return state;
  });
  await evaluate(`[...document.querySelectorAll('.index-strip button')].find((button) => button.textContent?.includes('建立索引'))?.click()`);
  const indexed = await retry(async () => {
    const state = await evaluate(`({ label: document.querySelector('.index-strip strong')?.textContent || '', message: document.querySelector('.index-strip span')?.textContent || '', warning: document.querySelector('.scan-warning')?.textContent || '', error: document.querySelector('.error-message')?.textContent || '' })`);
    if (state.error) throw new Error(state.error);
    if (!state.label.includes('全文索引已就绪') || !state.warning.includes('OCR 已识别')) throw new Error(`OCR index is not ready: ${JSON.stringify(state)}`);
    return state;
  }, 360, 500);
  const result = await evaluate(`(async () => {
    const book = (await window.marginDesktop.libraryList())[0];
    const providerId = 'remote:https://fixture.local/v1:fixture-embedding';
    const info = await window.marginDesktop.libraryIndexOpen(book.id, providerId);
    const matches = await window.marginDesktop.libraryIndexSearch(book.id, providerId, new Float32Array([1, 0.5, 0.25, 0.125, 0.0625, 0.03125, 0.015625, 0.0078125]), 1);
    return { info, match: matches[0] };
  })()`, true);
  if (result.info?.format !== 'sqlite-f32' || !/ORCHID/i.test(result.match?.text || '')) throw new Error(`OCR text was not stored in SQLite: ${JSON.stringify(result)}`);
  console.log(JSON.stringify({ indexed, info: result.info, match: { page: result.match.page, text: result.match.text.slice(0, 120) } }));
} finally {
  await Promise.race([command('Browser.close').catch(() => undefined), delay(2_000)]);
  socket.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(5_000)]);
  await rm(root, { recursive: true, force: true });
}
