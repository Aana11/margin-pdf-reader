import assert from 'node:assert/strict';
import { estimateInkRatio, isProbablyBlankPage, normalizeIndexTasks, queueBooks, shouldInspectWithOcr } from '../lib/indexing/tasks.ts';

const interrupted = normalizeIndexTasks([{
  id: 'task-1', bookId: '11111111-1111-1111-1111-111111111111', bookName: '高等代数.pdf',
  status: 'running', stage: 'ocr', progress: 37, message: 'running', pageCount: 421,
  completedPages: 150, chunks: 0, completedChunks: 0, ocrPages: 140, skippedPages: 3,
  failedPages: [8], timings: { extracting: 1200 }, createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:01:00.000Z',
}]);
assert.equal(interrupted[0].status, 'paused');
assert.match(interrupted[0].message, /检查点/);

const resumed = queueBooks(interrupted, [{
  id: interrupted[0].bookId, name: interrupted[0].bookName, pageCount: 421, lastPage: 1,
  addedAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z', indexProviderId: null,
}]);
assert.equal(resumed[0].status, 'queued');
assert.equal(resumed[0].progress, 37);
assert.equal(resumed[0].ocrPages, 140);

assert.equal(shouldInspectWithOcr(''), true);
assert.equal(shouldInspectWithOcr('12'), true);
assert.equal(shouldInspectWithOcr('这是一段可以直接从 PDF 中提取的、具有足够长度的正常正文，因此无需再做 OCR。'), false);

const white = new Uint8ClampedArray(100 * 100 * 4).fill(255);
assert.equal(isProbablyBlankPage(estimateInkRatio(white, 100, 100)), true);
const printed = new Uint8ClampedArray(100 * 100 * 4).fill(255);
for (let y = 20; y < 80; y += 1) for (let x = 20; x < 80; x += 1) {
  const offset = (y * 100 + x) * 4;
  printed[offset] = 0; printed[offset + 1] = 0; printed[offset + 2] = 0;
}
assert.equal(isProbablyBlankPage(estimateInkRatio(printed, 100, 100)), false);

console.log(JSON.stringify({ interrupted: interrupted[0].status, resumed: resumed[0].progress, classifier: 'passed' }));
