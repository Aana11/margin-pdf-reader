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
      quote: '线性空间是满足八条公理的集合。',
      page: 12,
      createdAt: '2026-09-08T10:00:00.000Z',
    },
    {
      role: 'assistant',
      content: '线性空间是满足八条公理的集合。',
      reasoning: '先根据教材定义核对公理。',
      page: 12,
      createdAt: '2026-09-08T10:00:01.000Z',
    },
  ]);
  assert.equal(workspaceStore.loadChat(root, bookId).length, 2);
  assert.equal(
    workspaceStore.loadChat(root, bookId)[0].quote,
    '线性空间是满足八条公理的集合。',
  );
  assert.equal(
    workspaceStore.loadChat(root, bookId)[1].reasoning,
    '先根据教材定义核对公理。',
  );
  assert.equal(workspaceStore.searchHistory(root, '线性', 20, 0).total, 1);
  const sourceChatId = 'pack_029';
  workspaceStore.replaceChat(root, sourceChatId, '知识包：代数', [
    {
      role: 'assistant',
      content: '跨书回答',
      page: 1,
      sources: [
        {
          bookId,
          bookName: '高等代数.pdf',
          page: 12,
          score: 0.91,
          excerpt: '线性空间',
        },
      ],
    },
  ]);
  assert.deepEqual(workspaceStore.loadChat(root, sourceChatId)[0].sources, [
    {
      bookId,
      bookName: '高等代数.pdf',
      page: 12,
      score: 0.91,
      excerpt: '线性空间',
    },
  ]);
  const researchQuestion = workspaceStore.saveResearchItem(
    root,
    sourceChatId,
    '知识包：代数',
    {
      kind: 'question',
      title: '比较线性空间定义',
      content: '不同教材怎样定义线性空间？',
    },
  );
  const researchEvidence = workspaceStore.saveResearchItem(
    root,
    sourceChatId,
    '知识包：代数',
    {
      kind: 'evidence',
      title: '八条公理',
      content: '教材列出了八条公理。',
      sources: [
        {
          bookId,
          bookName: '高等代数.pdf',
          page: 12,
          score: 0.91,
          excerpt: '线性空间',
        },
      ],
    },
  );
  assert.equal(
    workspaceStore.listResearchItems(root, {
      contextId: sourceChatId,
      query: '线性',
    }).total,
    1,
  );
  assert.equal(
    workspaceStore.listResearchItems(root, { kind: 'evidence' }).items[0]
      .sources[0].page,
    12,
  );
  assert.equal(
    workspaceStore.removeResearchItem(root, researchQuestion.id).removed,
    true,
  );
  assert.ok(researchEvidence.id);

  const studyCards = workspaceStore.saveStudyCards(
    root,
    bookId,
    '高等代数.pdf',
    [
      {
        kind: 'concept',
        front: '什么是线性空间？',
        back: '满足线性运算公理的集合。',
        sourceExcerpt: '线性空间定义',
        sources: [
          {
            bookId,
            bookName: '高等代数.pdf',
            page: 12,
            score: 1,
            excerpt: '线性空间',
          },
        ],
      },
      {
        kind: 'formula',
        front: '写出分配律',
        back: '$a(x+y)=ax+ay$',
      },
      {
        kind: 'qa',
        front: '零向量是否唯一？',
        back: '唯一。',
      },
    ],
  );
  assert.equal(studyCards.length, 3);
  assert.equal(
    workspaceStore.listStudyCards(root, { contextId: bookId, dueOnly: true })
      .total,
    3,
  );
  const forgotten = workspaceStore.reviewStudyCard(
    root,
    studyCards[0].id,
    'again',
  );
  assert.equal(forgotten.lapses, 1);
  assert.equal(forgotten.state, 'learning');
  const learned = workspaceStore.reviewStudyCard(
    root,
    studyCards[1].id,
    'good',
  );
  assert.equal(learned.intervalDays, 1);
  assert.equal(learned.state, 'review');
  assert.equal(
    workspaceStore.listStudyCards(root, { kind: 'formula' }).total,
    1,
  );
  assert.equal(
    workspaceStore.removeStudyCard(root, studyCards[2].id).removed,
    true,
  );

  const pack = workspaceStore.createKnowledgePack(root, {
    name: '代数核心',
    description: '只组合指定教材',
  });
  const updatedPack = workspaceStore.updateKnowledgePack(root, pack.id, {
    bookIds: [bookId, 'book_030'],
  });
  assert.deepEqual(updatedPack.bookIds, [bookId, 'book_030']);
  assert.equal(workspaceStore.listKnowledgePacks(root).length, 1);

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
    /AI|线性空间|提问历史|学习卡片/,
  );
  assert.equal(workspaceStore.removeNote(root, highlight.id).removed, true);
  workspaceStore.removeBookData(root, bookId);
  assert.equal(workspaceStore.loadChat(root, bookId).length, 0);
  assert.equal(workspaceStore.listNotes(root, { bookId }).total, 0);
  assert.equal(
    workspaceStore.listStudyCards(root, { contextId: bookId }).total,
    0,
  );
  assert.deepEqual(workspaceStore.getKnowledgePack(root, pack.id).bookIds, [
    'book_030',
  ]);
  assert.equal(workspaceStore.removeKnowledgePack(root, pack.id).removed, true);
  console.log(
    'Workspace SQLite persistence, search, pagination, export, and cleanup passed.',
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
