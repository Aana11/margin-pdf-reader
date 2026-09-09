import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('pdf-lib');
const { exportSearchablePdfFile } = require('../electron/searchable-pdf.cjs');
const root = path.resolve('tmp', `searchable-pdf-${Date.now()}`);
await mkdir(root, { recursive: true });

try {
  const sourceFile = path.join(root, 'source.pdf');
  const outputFile = path.join(root, 'searchable.pdf');
  const fallbackOutputFile = path.join(root, 'searchable-ascii-fallback.pdf');
  const source = await PDFDocument.create();
  source.addPage([600, 800]);
  await writeFile(sourceFile, await source.save());
  const result = await exportSearchablePdfFile({
    sourceFile,
    outputFile,
    producer: 'Margin test',
    pages: [
      {
        page: 1,
        text: '高等代数 OCR searchable text',
        layout: {
          width: 1200,
          height: 1600,
          regions: [
            {
              kind: 'text',
              text: '高等代数 OCR searchable text',
              confidence: 98,
              bbox: { x0: 120, y0: 160, x1: 850, y1: 220 },
            },
          ],
        },
      },
    ],
  });
  assert.equal(result.pages, 1);
  const output = await readFile(outputFile);
  const loaded = await getDocument({ data: new Uint8Array(output) }).promise;
  const text = await (await loaded.getPage(1)).getTextContent();
  const content = text.items
    .map((item) => ('str' in item ? item.str : ''))
    .join(' ');
  if (!result.limitedCharset) assert.match(content, /高等代数/);
  assert.match(content, /searchable text/);
  await loaded.destroy();
  const fallbackResult = await exportSearchablePdfFile({
    sourceFile,
    outputFile: fallbackOutputFile,
    producer: 'Margin fallback test',
    fontPath: null,
    pages: [
      {
        page: 1,
        text: '高等代数 OCR searchable text',
        layout: {
          width: 1200,
          height: 1600,
          regions: [
            {
              kind: 'text',
              text: '高等代数 OCR searchable text',
              confidence: 98,
              bbox: { x0: 120, y0: 160, x1: 850, y1: 220 },
            },
          ],
        },
      },
    ],
  });
  assert.equal(fallbackResult.limitedCharset, true);
  const fallback = await getDocument({
    data: new Uint8Array(await readFile(fallbackOutputFile)),
  }).promise;
  const fallbackText = await (await fallback.getPage(1)).getTextContent();
  assert.match(
    fallbackText.items.map((item) => ('str' in item ? item.str : '')).join(' '),
    /searchable text/,
  );
  await fallback.destroy();
  console.log(
    JSON.stringify({
      pages: result.pages,
      limitedCharset: result.limitedCharset,
      characters: content.length,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
