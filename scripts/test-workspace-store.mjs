import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import workspaceStore from '../electron/workspace-store.cjs';

const root = mkdtempSync(path.join(os.tmpdir(), 'margin-workspace-'));
try {
  const bookId = 'book_029';
  workspaceStore.replaceChat(root, bookId, '高等代数.pdf', [
    {
      role: 'user',
      content: '什么是线性空间？',
      page: 12,
      createdAt: '2026-09-08T10:00:00.000Z',
    },
    {
      role: 'assistant',
      content: '线性空间是满足八条公理的集合。',
      page: 12,
      createdAt: '2026-09-08T10:00:01.000Z',
    },
  ]);
  assert.equal(workspaceStore.loadChat(root, bookId).length, 2);
  assert.equal(workspaceStore.searchHistory(root, '线性', 20, 0).total, 1);

  const highlight = workspaceStore.saveNote(root, bookId, '高等代数.pdf', {
    kind: 'highlight',
    page: 12,
    title: '重要定义',
    excerpt: '线性空间',
    region: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
    color: '#f4cf65',
  });
  workspaceStore.saveNote(root, bookId, '高等代数.pdf', {
    kind: 'glossary',
    page: 12,
    title: '线性空间',
    content: '满足加法与数乘封闭的集合。',
  });
  assert.equal(workspaceStore.listNotes(root, { bookId, limit: 20 }).total, 2);
  assert.equal(
    workspaceStore.listNotes(root, {
      kind: 'glossary',
      query: '数乘',
      limit: 20,
    }).total,
    1,
  );
  assert.match(
    workspaceStore.markdownExport(root, { bookId, bookName: '高等代数.pdf' }),
    /AI|线性空间|提问历史/,
  );
  assert.equal(workspaceStore.removeNote(root, highlight.id).removed, true);
  workspaceStore.removeBookData(root, bookId);
  assert.equal(workspaceStore.loadChat(root, bookId).length, 0);
  assert.equal(workspaceStore.listNotes(root, { bookId }).total, 0);
  console.log(
    'Workspace SQLite persistence, search, pagination, export, and cleanup passed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
