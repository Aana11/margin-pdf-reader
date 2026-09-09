import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  appendIndexBatch,
  cancelIndexBuild,
  finishIndexBuild,
  getIndexCheckpoint,
  pauseIndexBuild,
  readIndexPages,
  saveIndexPages,
  startIndexBuild,
} = require('../electron/index-store.cjs');
const root = path.resolve('tmp', `index-resume-${Date.now()}`);
await mkdir(root, { recursive: true });

try {
  let build = startIndexBuild(
    root,
    'provider-a',
    0,
    'ocr:auto:eng|chunks:test',
  );
  const layout = {
    width: 1000,
    height: 1400,
    regions: [
      {
        kind: 'text',
        text: 'cached OCR page one',
        confidence: 96,
        bbox: { x0: 50, y0: 80, x1: 420, y1: 118 },
      },
    ],
  };
  saveIndexPages(build, [
    { page: 1, text: 'cached OCR page one', source: 'ocr', layout },
  ]);
  appendIndexBatch(build, [
    {
      id: 'p1-c0',
      page: 1,
      text: 'cached OCR page one',
      vector: Float32Array.from([1, 0, 0]),
    },
  ]);
  pauseIndexBuild(build);

  build = startIndexBuild(root, 'provider-a', 0, 'ocr:auto:eng|chunks:test');
  const resumed = getIndexCheckpoint(build);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.dimensions, 3);
  assert.equal(resumed.pages[0].text, 'cached OCR page one');
  assert.deepEqual(resumed.pages[0].layout, layout);
  assert.deepEqual(resumed.completedChunkIds, ['p1-c0']);
  appendIndexBatch(build, [
    {
      id: 'p2-c0',
      page: 2,
      text: 'page two',
      vector: Float32Array.from([0, 1, 0]),
    },
  ]);
  const complete = finishIndexBuild(build);
  assert.equal(complete.chunks, 2);
  assert.deepEqual(readIndexPages(root)[0].layout, layout);

  const replacement = startIndexBuild(
    root,
    'provider-a',
    0,
    'ocr:auto:eng|chunks:test',
  );
  const replacementCheckpoint = getIndexCheckpoint(replacement);
  assert.equal(replacementCheckpoint.pages.length, 1);
  appendIndexBatch(replacement, [
    {
      id: 'p1-c0',
      page: 1,
      text: 'cached OCR page one',
      vector: Float32Array.from([1, 0, 0]),
    },
  ]);
  const replaced = finishIndexBuild(replacement);
  assert.equal(replaced.chunks, 1);

  const rebuilt = startIndexBuild(
    root,
    'provider-b',
    0,
    'ocr:auto:eng|chunks:test',
  );
  const reusedText = getIndexCheckpoint(rebuilt);
  assert.equal(reusedText.resumed, true);
  assert.equal(reusedText.pages.length, 1);
  assert.equal(reusedText.chunks, 0);
  cancelIndexBuild(rebuilt);

  console.log(
    JSON.stringify({
      resumedChunks: resumed.chunks,
      cachedPages: resumed.pages.length,
      rebuiltCachedPages: reusedText.pages.length,
      initialChunks: complete.chunks,
      replacementChunks: replaced.chunks,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
