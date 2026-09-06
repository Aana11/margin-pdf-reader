import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createWorker, OEM } = require('tesseract.js');
const languagePackages = [require('@tesseract.js-data/chi_sim'), require('@tesseract.js-data/eng')];
const root = await mkdtemp(path.join(os.tmpdir(), 'margin-ocr-'));
const tessdata = path.join(root, 'tessdata');
await mkdir(tessdata, { recursive: true });
for (const language of languagePackages) {
  await copyFile(path.join(language.langPath, `${language.code}.traineddata.gz`), path.join(tessdata, `${language.code}.traineddata.gz`));
}

let worker;
try {
  const startedAt = performance.now();
  worker = await createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, { langPath: tessdata, cachePath: path.join(root, 'cache'), gzip: true });
  const result = await worker.recognize(path.resolve('docs', 'images', 'reader-overview.png'), { rotateAuto: true });
  const text = String(result.data.text || '').replace(/\s+/g, ' ').trim();
  if (!/Margin/i.test(text) || !/PDF/i.test(text)) throw new Error(`OCR output did not contain expected words: ${text.slice(0, 300)}`);
  console.log(JSON.stringify({ languages: ['chi_sim', 'eng'], confidence: result.data.confidence, characters: text.length, elapsedMs: Math.round(performance.now() - startedAt), sample: text.slice(0, 180) }));
} finally {
  await worker?.terminate();
  await rm(root, { recursive: true, force: true });
}
