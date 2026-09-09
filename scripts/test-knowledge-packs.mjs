import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import indexStore from '../electron/index-store.cjs';
import knowledgeSearch from '../electron/knowledge-search-worker.cjs';
import workspaceStore from '../electron/workspace-store.cjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'margin-knowledge-pack-'));
const providerId = 'test-provider:model-a';

function makeBook(id, name, entries, indexProviderId = providerId) {
  const directory = path.join(root, id);
  mkdirSync(directory, { recursive: true });
  const build = indexStore.startIndexBuild(directory, indexProviderId, 3);
  indexStore.appendIndexBatch(
    build,
    entries.map((entry, ordinal) => ({
      id: `${id}-${ordinal}`,
      page: entry.page,
      text: entry.text,
      vector: entry.vector,
    })),
  );
  indexStore.finishIndexBuild(build);
  return { id, name, directory, indexProviderId };
}

try {
  const algebra = makeBook('algebra', '高等代数.pdf', [
    { page: 12, text: '线性空间与基', vector: [1, 0, 0] },
  ]);
  const geometry = makeBook('geometry', '解析几何.pdf', [
    { page: 8, text: '向量与坐标系', vector: [0.8, 0.2, 0] },
  ]);
  const excluded = makeBook('history', '数学史.pdf', [
    { page: 3, text: '这个最相似结果不应被搜索', vector: [1, 0, 0] },
  ]);
  const incompatible = makeBook(
    'calculus',
    '微积分.pdf',
    [{ page: 20, text: '极限', vector: [0, 1, 0] }],
    'test-provider:model-b',
  );

  const result = knowledgeSearch.searchKnowledgeBooks({
    books: [algebra, geometry, incompatible],
    providerId,
    vector: [1, 0, 0],
    limit: 5,
  });
  assert.equal(result.searchedBooks, 2);
  assert.equal(result.skippedBooks.length, 1);
  assert.equal(result.skippedBooks[0].reason, 'provider-mismatch');
  assert.equal(result.matches[0].bookId, 'algebra');
  assert.ok(result.matches.some((match) => match.bookId === 'geometry'));
  assert.ok(!result.matches.some((match) => match.bookId === excluded.id));
  assert.ok(
    result.matches.every((match) =>
      ['algebra', 'geometry'].includes(match.bookId),
    ),
  );
  const pageFiltered = knowledgeSearch.searchKnowledgeBooks({
    books: [algebra, geometry],
    providerId,
    vector: [1, 0, 0],
    limit: 5,
    pageFrom: 10,
    pageTo: 20,
  });
  assert.deepEqual(
    pageFiltered.matches.map((match) => match.bookId),
    ['algebra'],
    'page filters must be applied before vector scanning',
  );

  const firstBook = { id: randomUUID(), name: '高等代数.pdf' };
  const secondBook = { id: randomUUID(), name: '解析几何.pdf' };
  const originalPack = workspaceStore.createKnowledgePack(root, {
    name: '代数专题',
    description: '公式与向量空间',
  });
  workspaceStore.updateKnowledgePack(root, originalPack.id, {
    bookIds: [firstBook.id, secondBook.id],
  });
  const manifest = workspaceStore.exportKnowledgePack(root, originalPack.id, [
    firstBook,
    secondBook,
  ]);
  assert.equal(manifest.format, 'margin-knowledge-pack');
  const relocatedFirst = { id: randomUUID(), name: firstBook.name };
  const imported = workspaceStore.importKnowledgePack(root, manifest, [
    relocatedFirst,
  ]);
  assert.equal(imported.matchedBooks, 1);
  assert.deepEqual(imported.pack.bookIds, [relocatedFirst.id]);
  assert.deepEqual(imported.unmatchedBooks, [secondBook.name]);
  console.log(
    `Knowledge pack isolation, filters, import/export, cross-book ranking, and source metadata passed in ${result.elapsedMs} ms.`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
