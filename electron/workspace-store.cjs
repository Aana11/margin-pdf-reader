const { DatabaseSync } = require('node:sqlite');
const { mkdirSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const WORKSPACE_VERSION = 1;
const WORKSPACE_FILE = 'workspace.sqlite';
const NOTE_KINDS = new Set(['highlight', 'note', 'summary', 'glossary']);

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
    INSERT OR REPLACE INTO metadata(key, value) VALUES ('version', '${WORKSPACE_VERSION}');
  `);
  return database;
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

function replaceChat(root, bookId, bookName, messages) {
  validateBookId(bookId);
  const safeName = cleanText(bookName, 300, 'book name');
  if (!Array.isArray(messages) || messages.length > 200)
    throw new Error('Invalid chat messages');
  const database = openWorkspace(root);
  try {
    const insert = database.prepare(
      'INSERT INTO messages (id, book_id, book_name, position, role, content, page, citation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
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
        message.page,
        serializeCitation(message.citation),
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
        'SELECT role, content, page, citation_json, created_at FROM messages WHERE book_id = ? ORDER BY position DESC LIMIT ?',
      )
      .all(bookId, safeLimit)
      .reverse();
    return rows.map((row) => ({
      role: row.role,
      content: row.content,
      page: row.page,
      createdAt: row.created_at,
      citation: parseJson(row.citation_json),
    }));
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
    if (!notes.length && !messages.length)
      output.push('暂无可导出的阅读资料。', '');
    return output.join('\n');
  } finally {
    database.close();
  }
}

module.exports = {
  listNotes,
  loadChat,
  markdownExport,
  removeBookData,
  removeNote,
  replaceChat,
  saveNote,
  searchHistory,
};
