const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const WORKSPACE_VERSION = 3;
const WORKSPACE_FILE = 'workspace.sqlite';
const NOTE_KINDS = new Set(['highlight', 'note', 'summary', 'glossary']);
const RESEARCH_KINDS = new Set(['question', 'evidence', 'outline']);

function cleanText(value, maximum, field) {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${field} is too long`);
  return text;
}

function validateBookId(bookId) {
  if (typeof bookId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(bookId))
    throw new Error('Invalid book id');
  return bookId;
}

function openWorkspace(root) {
  mkdirSync(root, { recursive: true });
  const database = new DatabaseSync(path.join(root, WORKSPACE_FILE), {
    timeout: 5_000,
  });
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      book_name TEXT NOT NULL,
      position INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      page INTEGER NOT NULL,
      citation_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS messages_book_position ON messages(book_id, position);
    CREATE INDEX IF NOT EXISTS messages_history ON messages(role, created_at DESC);
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL,
      book_name TEXT NOT NULL,
      page INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('highlight', 'note', 'summary', 'glossary')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      color TEXT NOT NULL,
      region_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_book_updated ON notes(book_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS notes_kind_updated ON notes(kind, updated_at DESC);
    CREATE TABLE IF NOT EXISTS knowledge_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS knowledge_pack_books (
      pack_id TEXT NOT NULL REFERENCES knowledge_packs(id) ON DELETE CASCADE,
      book_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (pack_id, book_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS knowledge_pack_books_book ON knowledge_pack_books(book_id);
    CREATE TABLE IF NOT EXISTS research_items (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL,
      context_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('question', 'evidence', 'outline')),
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      sources_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS research_items_context_updated ON research_items(context_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS research_items_kind_updated ON research_items(kind, updated_at DESC);
    INSERT OR REPLACE INTO metadata(key, value) VALUES ('version', '${WORKSPACE_VERSION}');
  `);
  const messageColumns = new Set(
    database
      .prepare('PRAGMA table_info(messages)')
      .all()
      .map((row) => row.name),
  );
  if (!messageColumns.has('sources_json'))
    database.exec('ALTER TABLE messages ADD COLUMN sources_json TEXT');
  if (!messageColumns.has('reasoning_text'))
    database.exec('ALTER TABLE messages ADD COLUMN reasoning_text TEXT');
  return database;
}

function validatePackId(packId) {
  if (typeof packId !== 'string' || !/^[0-9a-f-]{36}$/.test(packId))
    throw new Error('Invalid knowledge pack id');
  return packId;
}

function packRow(database, packId) {
  const row = database
    .prepare('SELECT * FROM knowledge_packs WHERE id = ?')
    .get(validatePackId(packId));
  if (!row) throw new Error('Knowledge pack not found');
  const books = database
    .prepare(
      'SELECT book_id FROM knowledge_pack_books WHERE pack_id = ? ORDER BY position',
    )
    .all(packId)
    .map((item) => item.book_id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    bookIds: books,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listKnowledgePacks(root) {
  const database = openWorkspace(root);
  try {
    return database
      .prepare('SELECT id FROM knowledge_packs ORDER BY updated_at DESC, name')
      .all()
      .map((row) => packRow(database, row.id));
  } finally {
    database.close();
  }
}

function createKnowledgePack(root, input = {}) {
  const name = cleanText(input.name || '', 100, 'knowledge pack name');
  if (!name) throw new Error('Knowledge pack name is required');
  const description = cleanText(
    input.description || '',
    500,
    'knowledge pack description',
  );
  const id = randomUUID();
  const now = new Date().toISOString();
  const database = openWorkspace(root);
  try {
    database
      .prepare(
        'INSERT INTO knowledge_packs (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, name, description, now, now);
    return packRow(database, id);
  } finally {
    database.close();
  }
}

function updateKnowledgePack(root, packId, changes = {}) {
  validatePackId(packId);
  const database = openWorkspace(root);
  try {
    const existing = packRow(database, packId);
    const name =
      changes.name === undefined
        ? existing.name
        : cleanText(changes.name, 100, 'knowledge pack name');
    if (!name) throw new Error('Knowledge pack name is required');
    const description =
      changes.description === undefined
        ? existing.description
        : cleanText(changes.description, 500, 'knowledge pack description');
    const bookIds =
      changes.bookIds === undefined ? existing.bookIds : changes.bookIds;
    if (
      !Array.isArray(bookIds) ||
      bookIds.length > 200 ||
      new Set(bookIds).size !== bookIds.length
    )
      throw new Error('Invalid knowledge pack books');
    bookIds.forEach(validateBookId);
    const updatedAt = new Date().toISOString();
    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        'UPDATE knowledge_packs SET name = ?, description = ?, updated_at = ? WHERE id = ?',
      )
      .run(name, description, updatedAt, packId);
    database
      .prepare('DELETE FROM knowledge_pack_books WHERE pack_id = ?')
      .run(packId);
    const addBook = database.prepare(
      'INSERT INTO knowledge_pack_books (pack_id, book_id, position) VALUES (?, ?, ?)',
    );
    bookIds.forEach((bookId, position) =>
      addBook.run(packId, bookId, position),
    );
    database.exec('COMMIT');
    return packRow(database, packId);
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* No active transaction. */
    }
    throw error;
  } finally {
    database.close();
  }
}

function removeKnowledgePack(root, packId) {
  const database = openWorkspace(root);
  try {
    return {
      removed:
        database
          .prepare('DELETE FROM knowledge_packs WHERE id = ?')
          .run(validatePackId(packId)).changes > 0,
    };
  } finally {
    database.close();
  }
}

function getKnowledgePack(root, packId) {
  const database = openWorkspace(root);
  try {
    return packRow(database, packId);
  } finally {
    database.close();
  }
}

function exportKnowledgePack(root, packId, catalog = []) {
  const pack = getKnowledgePack(root, packId);
  const booksById = new Map(catalog.map((book) => [book.id, book]));
  return {
    format: 'margin-knowledge-pack',
    version: 1,
    exportedAt: new Date().toISOString(),
    pack: {
      name: pack.name,
      description: pack.description,
      books: pack.bookIds.map((bookId) => {
        const book = booksById.get(bookId);
        return {
          id: bookId,
          name: book?.name || '',
        };
      }),
    },
  };
}

function importKnowledgePack(root, manifest, catalog = []) {
  if (
    !manifest ||
    manifest.format !== 'margin-knowledge-pack' ||
    manifest.version !== 1 ||
    !manifest.pack ||
    !Array.isArray(manifest.pack.books) ||
    manifest.pack.books.length > 200
  )
    throw new Error('Invalid Margin knowledge pack file');
  const byId = new Map(catalog.map((book) => [book.id, book]));
  const byName = new Map();
  for (const book of catalog) {
    const key = String(book.name || '')
      .trim()
      .toLocaleLowerCase();
    if (!key) continue;
    const values = byName.get(key) || [];
    values.push(book);
    byName.set(key, values);
  }
  const matchedIds = [];
  const unmatchedBooks = [];
  for (const source of manifest.pack.books) {
    if (
      !source ||
      typeof source.id !== 'string' ||
      typeof source.name !== 'string'
    )
      throw new Error('Invalid knowledge pack book entry');
    const exact = byId.get(source.id);
    const named = byName.get(source.name.trim().toLocaleLowerCase()) || [];
    const match = exact || (named.length === 1 ? named[0] : undefined);
    if (match && !matchedIds.includes(match.id)) matchedIds.push(match.id);
    else unmatchedBooks.push(source.name || source.id);
  }
  const created = createKnowledgePack(root, {
    name: cleanText(manifest.pack.name || '', 100, 'knowledge pack name'),
    description: cleanText(
      manifest.pack.description || '',
      500,
      'knowledge pack description',
    ),
  });
  const pack = updateKnowledgePack(root, created.id, { bookIds: matchedIds });
  return { pack, matchedBooks: matchedIds.length, unmatchedBooks };
}

function serializeCitation(value) {
  if (!value) return null;
  const page = Number(value.page);
  const region = value.region;
  if (
    !Number.isInteger(page) ||
    page <= 0 ||
    !region ||
    !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(region[key]))
  )
    throw new Error('Invalid citation');
  return JSON.stringify({
    page,
    region: {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    },
  });
}

function parseJson(value) {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function serializeSources(value) {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 20)
    throw new Error('Invalid message sources');
  return JSON.stringify(
    value.map((source) => {
      validateBookId(source?.bookId);
      if (!Number.isInteger(source.page) || source.page <= 0)
        throw new Error('Invalid message source page');
      return {
        bookId: source.bookId,
        bookName: cleanText(source.bookName || '', 300, 'source book name'),
        page: source.page,
        score: Math.max(-1, Math.min(1, Number(source.score) || 0)),
        excerpt: cleanText(source.excerpt || '', 2_000, 'source excerpt'),
      };
    }),
  );
}

function replaceChat(root, bookId, bookName, messages) {
  validateBookId(bookId);
  const safeName = cleanText(bookName, 300, 'book name');
  if (!Array.isArray(messages) || messages.length > 200)
    throw new Error('Invalid chat messages');
  const database = openWorkspace(root);
  try {
    const insert = database.prepare(
      'INSERT INTO messages (id, book_id, book_name, position, role, content, reasoning_text, page, citation_json, sources_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    database.exec('BEGIN IMMEDIATE');
    database.prepare('DELETE FROM messages WHERE book_id = ?').run(bookId);
    messages.forEach((message, position) => {
      if (
        !message ||
        !['user', 'assistant'].includes(message.role) ||
        !Number.isInteger(message.page) ||
        message.page <= 0
      )
        throw new Error('Invalid chat message');
      insert.run(
        randomUUID(),
        bookId,
        safeName,
        position,
        message.role,
        cleanText(message.content, 100_000, 'message'),
        cleanText(message.reasoning || '', 100_000, 'message reasoning'),
        message.page,
        serializeCitation(message.citation),
        serializeSources(message.sources),
        cleanText(
          message.createdAt || new Date().toISOString(),
          50,
          'created at',
        ),
      );
    });
    database.exec('COMMIT');
    return { messages: messages.length };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* No active transaction. */
    }
    throw error;
  } finally {
    database.close();
  }
}

function loadChat(root, bookId, limit = 100) {
  validateBookId(bookId);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 100));
  const database = openWorkspace(root);
  try {
    const rows = database
      .prepare(
        'SELECT role, content, reasoning_text, page, citation_json, sources_json, created_at FROM messages WHERE book_id = ? ORDER BY position DESC LIMIT ?',
      )
      .all(bookId, safeLimit)
      .reverse();
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      reasoning: row.reasoning_text || undefined,
      page: row.page,
      createdAt: row.created_at,
      citation: parseJson(row.citation_json),
      sources: parseJson(row.sources_json),
    }));
  } finally {
    database.close();
  }
}

function normalizeResearchItem(item, existing) {
  if (!item || !RESEARCH_KINDS.has(item.kind))
    throw new Error('Invalid research item');
  const now = new Date().toISOString();
  return {
    id: typeof item.id === 'string' && item.id ? item.id : randomUUID(),
    kind: item.kind,
    title: cleanText(item.title || '', 300, 'research title'),
    content: cleanText(item.content || '', 100_000, 'research content'),
    sources: serializeSources(item.sources),
    createdAt: existing?.created_at || now,
    updatedAt: now,
  };
}

function saveResearchItem(root, contextId, contextName, item) {
  validateBookId(contextId);
  const safeName = cleanText(contextName, 300, 'research context name');
  const database = openWorkspace(root);
  try {
    const existing =
      typeof item?.id === 'string'
        ? database
            .prepare(
              'SELECT created_at FROM research_items WHERE id = ? AND context_id = ?',
            )
            .get(item.id, contextId)
        : undefined;
    const value = normalizeResearchItem(item, existing);
    database
      .prepare(`INSERT OR REPLACE INTO research_items
        (id, context_id, context_name, kind, title, content, sources_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        value.id,
        contextId,
        safeName,
        value.kind,
        value.title,
        value.content,
        value.sources,
        value.createdAt,
        value.updatedAt,
      );
    return {
      ...value,
      contextId,
      contextName: safeName,
      sources: parseJson(value.sources),
    };
  } finally {
    database.close();
  }
}

function listResearchItems(root, options = {}) {
  const contextId = options.contextId ? validateBookId(options.contextId) : '';
  const kind =
    options.kind && RESEARCH_KINDS.has(options.kind) ? options.kind : '';
  const query = cleanText(options.query || '', 200, 'research query');
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 100));
  const offset = Math.max(0, Number(options.offset) || 0);
  const clauses = [];
  const params = [];
  if (contextId) {
    clauses.push('context_id = ?');
    params.push(contextId);
  }
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  if (query) {
    clauses.push(
      "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR context_name LIKE ? ESCAPE '\\')",
    );
    const escaped = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(escaped, escaped, escaped);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const database = openWorkspace(root);
  try {
    const total = Number(
      database
        .prepare(`SELECT COUNT(*) AS count FROM research_items ${where}`)
        .get(...params).count,
    );
    const rows = database
      .prepare(
        `SELECT * FROM research_items ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        contextId: row.context_id,
        contextName: row.context_name,
        kind: row.kind,
        title: row.title,
        content: row.content,
        sources: parseJson(row.sources_json),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  } finally {
    database.close();
  }
}

function removeResearchItem(root, id) {
  if (typeof id !== 'string' || !id)
    throw new Error('Invalid research item id');
  const database = openWorkspace(root);
  try {
    return {
      removed:
        database.prepare('DELETE FROM research_items WHERE id = ?').run(id)
          .changes > 0,
    };
  } finally {
    database.close();
  }
}

function searchHistory(root, query = '', limit = 50, offset = 0) {
  const term = cleanText(query, 200, 'history query');
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const database = openWorkspace(root);
  try {
    const where = term
      ? "role = 'user' AND (content LIKE ? ESCAPE '\\' OR book_name LIKE ? ESCAPE '\\')"
      : "role = 'user'";
    const escaped = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    const params = term ? [escaped, escaped] : [];
    const total = Number(
      database
        .prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${where}`)
        .get(...params).count,
    );
    const rows = database
      .prepare(
        `SELECT id, book_id, book_name, content, page, citation_json, created_at FROM messages WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, safeLimit, safeOffset);
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        bookId: row.book_id,
        bookName: row.book_name,
        content: row.content,
        page: row.page,
        citation: parseJson(row.citation_json),
        createdAt: row.created_at,
      })),
    };
  } finally {
    database.close();
  }
}

function normalizeNote(note, existing) {
  if (
    !note ||
    !NOTE_KINDS.has(note.kind) ||
    !Number.isInteger(note.page) ||
    note.page <= 0
  )
    throw new Error('Invalid note');
  const now = new Date().toISOString();
  const region = note.region
    ? serializeCitation({ page: note.page, region: note.region })
    : null;
  return {
    id: typeof note.id === 'string' && note.id ? note.id : randomUUID(),
    kind: note.kind,
    page: note.page,
    title: cleanText(note.title || '', 300, 'note title'),
    content: cleanText(note.content || '', 100_000, 'note content'),
    excerpt: cleanText(note.excerpt || '', 10_000, 'note excerpt'),
    color: cleanText(note.color || '#f4cf65', 20, 'note color'),
    region,
    createdAt: existing?.created_at || now,
    updatedAt: now,
  };
}

function saveNote(root, bookId, bookName, note) {
  validateBookId(bookId);
  const safeName = cleanText(bookName, 300, 'book name');
  const database = openWorkspace(root);
  try {
    const existing =
      typeof note?.id === 'string'
        ? database
            .prepare(
              'SELECT created_at FROM notes WHERE id = ? AND book_id = ?',
            )
            .get(note.id, bookId)
        : undefined;
    const value = normalizeNote(note, existing);
    database
      .prepare(`INSERT OR REPLACE INTO notes (id, book_id, book_name, page, kind, title, content, excerpt, color, region_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        value.id,
        bookId,
        safeName,
        value.page,
        value.kind,
        value.title,
        value.content,
        value.excerpt,
        value.color,
        value.region,
        value.createdAt,
        value.updatedAt,
      );
    return {
      ...value,
      bookId,
      bookName: safeName,
      region: parseJson(value.region)?.region,
    };
  } finally {
    database.close();
  }
}

function listNotes(root, options = {}) {
  const bookId = options.bookId ? validateBookId(options.bookId) : '';
  const kind = options.kind && NOTE_KINDS.has(options.kind) ? options.kind : '';
  const query = cleanText(options.query || '', 200, 'note query');
  const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
  const offset = Math.max(0, Number(options.offset) || 0);
  const clauses = [];
  const params = [];
  if (bookId) {
    clauses.push('book_id = ?');
    params.push(bookId);
  }
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  if (query) {
    clauses.push(
      "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR excerpt LIKE ? ESCAPE '\\' OR book_name LIKE ? ESCAPE '\\')",
    );
    const escaped = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(escaped, escaped, escaped, escaped);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const database = openWorkspace(root);
  try {
    const total = Number(
      database
        .prepare(`SELECT COUNT(*) AS count FROM notes ${where}`)
        .get(...params).count,
    );
    const rows = database
      .prepare(
        `SELECT * FROM notes ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        bookId: row.book_id,
        bookName: row.book_name,
        page: row.page,
        kind: row.kind,
        title: row.title,
        content: row.content,
        excerpt: row.excerpt,
        color: row.color,
        region: parseJson(row.region_json)?.region,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    };
  } finally {
    database.close();
  }
}

function removeNote(root, id) {
  if (typeof id !== 'string' || !id) throw new Error('Invalid note id');
  const database = openWorkspace(root);
  try {
    return {
      removed:
        database.prepare('DELETE FROM notes WHERE id = ?').run(id).changes > 0,
    };
  } finally {
    database.close();
  }
}

function removeBookData(root, bookId) {
  validateBookId(bookId);
  const database = openWorkspace(root);
  try {
    database.exec('BEGIN IMMEDIATE');
    database.prepare('DELETE FROM messages WHERE book_id = ?').run(bookId);
    database.prepare('DELETE FROM notes WHERE book_id = ?').run(bookId);
    database
      .prepare('DELETE FROM research_items WHERE context_id = ?')
      .run(bookId);
    database
      .prepare('DELETE FROM knowledge_pack_books WHERE book_id = ?')
      .run(bookId);
    database.exec('COMMIT');
    return { removed: bookId };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      /* No active transaction. */
    }
    throw error;
  } finally {
    database.close();
  }
}

function markdownExport(root, options = {}) {
  const notes = [];
  let noteOffset = 0;
  while (true) {
    const batch = listNotes(root, {
      bookId: options.bookId,
      limit: 100,
      offset: noteOffset,
    });
    notes.push(...batch.items);
    noteOffset += batch.items.length;
    if (noteOffset >= batch.total || batch.items.length === 0) break;
  }
  const research = [];
  let researchOffset = 0;
  while (true) {
    const batch = listResearchItems(root, {
      contextId: options.bookId,
      limit: 100,
      offset: researchOffset,
    });
    research.push(...batch.items);
    researchOffset += batch.items.length;
    if (researchOffset >= batch.total || batch.items.length === 0) break;
  }
  const database = openWorkspace(root);
  try {
    const params = options.bookId ? [validateBookId(options.bookId)] : [];
    const where = options.bookId ? 'WHERE book_id = ?' : '';
    const messages = database
      .prepare(
        `SELECT book_id, book_name, role, content, page, created_at FROM messages ${where} ORDER BY book_name, position`,
      )
      .all(...params);
    const title = options.bookName
      ? `《${options.bookName}》阅读资料`
      : 'Margin 阅读资料';
    const output = [
      `# ${title}`,
      '',
      `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
    ];
    const kindLabels = {
      highlight: '高亮',
      note: '批注',
      summary: 'AI 摘要卡片',
      glossary: '概念词典',
    };
    if (notes.length) {
      output.push('## 阅读资料', '');
      for (const note of notes.slice().reverse()) {
        output.push(
          `### ${note.title || kindLabels[note.kind]}（第 ${note.page} 页）`,
          '',
          `- 类型：${kindLabels[note.kind]}`,
          `- 书籍：${note.bookName}`,
          '',
        );
        if (note.excerpt)
          output.push(`> ${note.excerpt.replace(/\n/g, '\n> ')}`, '');
        if (note.content) output.push(note.content, '');
      }
    }
    if (research.length) {
      const researchLabels = {
        question: '研究问题',
        evidence: '证据',
        outline: '引用大纲',
      };
      output.push('## 研究工作台', '');
      for (const item of research.slice().reverse()) {
        output.push(
          `### ${item.title || researchLabels[item.kind]}`,
          '',
          `- 类型：${researchLabels[item.kind]}`,
          `- 范围：${item.contextName}`,
          '',
          item.content,
          '',
        );
        if (item.sources?.length) {
          output.push(
            '- 来源：',
            ...item.sources.map(
              (source) => `  - 《${source.bookName}》第 ${source.page} 页`,
            ),
            '',
          );
        }
      }
    }
    if (messages.length) {
      output.push('## 提问历史', '');
      for (const message of messages)
        output.push(
          `### ${message.role === 'user' ? '提问' : '回答'} · 第 ${message.page} 页`,
          '',
          message.content,
          '',
        );
    }
    if (!notes.length && !research.length && !messages.length)
      output.push('暂无可导出的阅读资料。', '');
    return output.join('\n');
  } finally {
    database.close();
  }
}

module.exports = {
  createKnowledgePack,
  exportKnowledgePack,
  getKnowledgePack,
  importKnowledgePack,
  listNotes,
  listResearchItems,
  listKnowledgePacks,
  loadChat,
  markdownExport,
  removeBookData,
  removeKnowledgePack,
  removeNote,
  removeResearchItem,
  replaceChat,
  saveNote,
  saveResearchItem,
  searchHistory,
  updateKnowledgePack,
};
