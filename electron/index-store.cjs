const { DatabaseSync } = require('node:sqlite');
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } = require('node:fs');
const path = require('node:path');

const INDEX_VERSION = 2;
const SQLITE_FILE = 'index.sqlite';
const LEGACY_FILE = 'index.json';

function validateProviderId(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0 || providerId.length > 500) throw new Error('Invalid vector provider id');
}

function validateDimensions(dimensions) {
  if (!Number.isInteger(dimensions) || dimensions <= 0 || dimensions > 65_536) throw new Error('Invalid vector dimensions');
}

function vectorValues(vector) {
  if (vector instanceof Float32Array) return vector;
  if (Array.isArray(vector) && vector.every(Number.isFinite)) return Float32Array.from(vector);
  if (ArrayBuffer.isView(vector) && vector.BYTES_PER_ELEMENT === 4) return new Float32Array(vector.buffer, vector.byteOffset, vector.byteLength / 4);
  throw new Error('Invalid vector values');
}

function vectorBlob(vector, dimensions) {
  const values = vectorValues(vector);
  if (values.length !== dimensions) throw new Error('Stored vector dimensions do not match provider');
  return Buffer.from(values.buffer, values.byteOffset, values.byteLength);
}

function blobVector(blob, dimensions) {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== dimensions * 4) throw new Error('Invalid vector BLOB');
  if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, dimensions);
  const copy = Uint8Array.from(blob);
  return new Float32Array(copy.buffer, 0, dimensions);
}

function vectorNorm(vector) {
  let sum = 0;
  for (let index = 0; index < vector.length; index += 1) sum += vector[index] * vector[index];
  return Math.sqrt(sum) || 1;
}

function writeMetadata(database, values) {
  const statement = database.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(values)) statement.run(key, String(value));
}

function readMetadata(database) {
  return Object.fromEntries(database.prepare('SELECT key, value FROM metadata').all().map((row) => [row.key, row.value]));
}

function startIndexBuild(directory, providerId, dimensions) {
  validateProviderId(providerId);
  validateDimensions(dimensions);
  mkdirSync(directory, { recursive: true });
  const temporaryFile = path.join(directory, `${SQLITE_FILE}.building`);
  rmSync(temporaryFile, { force: true });
  const database = new DatabaseSync(temporaryFile, { timeout: 5_000 });
  database.exec(`
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE chunks (
      ordinal INTEGER PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      page INTEGER NOT NULL,
      text TEXT NOT NULL,
      vector BLOB NOT NULL,
      norm REAL NOT NULL
    );
    CREATE INDEX chunks_page ON chunks(page);
  `);
  writeMetadata(database, { version: INDEX_VERSION, providerId, dimensions, createdAt: new Date().toISOString(), complete: 0, chunks: 0 });
  return { database, directory, temporaryFile, providerId, dimensions, count: 0, closed: false };
}

function appendIndexBatch(build, entries) {
  if (!build || build.closed || !Array.isArray(entries) || entries.length === 0 || entries.length > 64) throw new Error('Invalid vector index batch');
  const insert = build.database.prepare('INSERT INTO chunks (ordinal, id, page, text, vector, norm) VALUES (?, ?, ?, ?, ?, ?)');
  build.database.exec('BEGIN IMMEDIATE');
  try {
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !Number.isInteger(entry.page) || entry.page <= 0 || typeof entry.text !== 'string' || entry.text.length > 50_000) throw new Error('Invalid vector index entry');
      const vector = vectorValues(entry.vector);
      insert.run(build.count, entry.id, entry.page, entry.text, vectorBlob(vector, build.dimensions), vectorNorm(vector));
      build.count += 1;
    }
    build.database.exec('COMMIT');
  } catch (error) {
    build.database.exec('ROLLBACK');
    throw error;
  }
  return build.count;
}

function finishIndexBuild(build) {
  if (!build || build.closed || build.count === 0) throw new Error('Cannot finish an empty vector index');
  writeMetadata(build.database, { complete: 1, chunks: build.count });
  build.database.exec('PRAGMA optimize');
  build.database.close();
  build.closed = true;
  const finalFile = path.join(build.directory, SQLITE_FILE);
  // Node's rename replaces the destination on Windows and leaves it untouched if
  // the operation fails, so a completed index is never deleted before the swap.
  renameSync(build.temporaryFile, finalFile);
  return { format: 'sqlite-f32', chunks: build.count, dimensions: build.dimensions, bytes: statSync(finalFile).size };
}

function cancelIndexBuild(build) {
  if (!build) return;
  if (!build.closed) build.database.close();
  build.closed = true;
  rmSync(build.temporaryFile, { force: true });
}

function inspectIndex(directory, providerId) {
  validateProviderId(providerId);
  const file = path.join(directory, SQLITE_FILE);
  if (!existsSync(file)) return null;
  const database = new DatabaseSync(file, { readOnly: true, timeout: 5_000 });
  try {
    const metadata = readMetadata(database);
    if (Number(metadata.version) !== INDEX_VERSION || metadata.complete !== '1' || metadata.providerId !== providerId) return null;
    const dimensions = Number(metadata.dimensions);
    const chunks = Number(metadata.chunks);
    validateDimensions(dimensions);
    if (!Number.isInteger(chunks) || chunks <= 0) return null;
    return { format: 'sqlite-f32', chunks, dimensions, bytes: statSync(file).size, migrated: false };
  } finally {
    database.close();
  }
}

function migrateLegacyIndex(directory, providerId) {
  const legacyFile = path.join(directory, LEGACY_FILE);
  if (!existsSync(legacyFile)) return null;
  const payload = JSON.parse(readFileSync(legacyFile, 'utf8'));
  if (payload?.version !== 1 || payload.providerId !== providerId || !Array.isArray(payload.entries) || payload.entries.length === 0) return null;
  const dimensions = vectorValues(payload.entries[0].vector).length;
  const build = startIndexBuild(directory, providerId, dimensions);
  try {
    for (let start = 0; start < payload.entries.length; start += 32) appendIndexBatch(build, payload.entries.slice(start, start + 32));
    const result = finishIndexBuild(build);
    rmSync(legacyFile, { force: true });
    return { ...result, migrated: true };
  } catch (error) {
    cancelIndexBuild(build);
    throw error;
  }
}

function openIndex(directory, providerId) {
  return inspectIndex(directory, providerId) || migrateLegacyIndex(directory, providerId);
}

function searchIndex(directory, providerId, queryVector, limit = 5) {
  const info = inspectIndex(directory, providerId);
  if (!info) return [];
  const query = vectorValues(queryVector);
  if (query.length !== info.dimensions) throw new Error('Query vector dimensions do not match index');
  const queryNorm = vectorNorm(query);
  const database = new DatabaseSync(path.join(directory, SQLITE_FILE), { readOnly: true, timeout: 5_000 });
  const best = [];
  try {
    for (const row of database.prepare('SELECT id, page, text, vector, norm FROM chunks ORDER BY ordinal').iterate()) {
      const vector = blobVector(row.vector, info.dimensions);
      let dot = 0;
      for (let index = 0; index < vector.length; index += 1) dot += query[index] * vector[index];
      const match = { id: row.id, page: row.page, text: row.text, score: dot / (queryNorm * row.norm || 1) };
      const position = best.findIndex((candidate) => match.score > candidate.score);
      if (position >= 0) best.splice(position, 0, match);
      else if (best.length < limit) best.push(match);
      if (best.length > limit) best.pop();
    }
    return best;
  } finally {
    database.close();
  }
}

module.exports = {
  appendIndexBatch,
  cancelIndexBuild,
  finishIndexBuild,
  inspectIndex,
  migrateLegacyIndex,
  openIndex,
  searchIndex,
  startIndexBuild,
};
