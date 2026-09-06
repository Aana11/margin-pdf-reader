import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { appendIndexBatch, finishIndexBuild, openIndex, searchIndex, startIndexBuild } = require('../electron/index-store.cjs');
const chunks = Number(process.argv[2] || 2000);
const dimensions = Number(process.argv[3] || 2560);
if (!Number.isInteger(chunks) || chunks <= 0 || !Number.isInteger(dimensions) || dimensions <= 0) throw new Error('Usage: node scripts/benchmark-index-store.mjs [chunks] [dimensions]');

const root = await mkdtemp(path.join(os.tmpdir(), 'margin-index-benchmark-'));
const legacyDirectory = path.join(root, 'legacy');
const sqliteDirectory = path.join(root, 'sqlite');
const providerId = 'benchmark:qwen3-embedding-4b';

function entryAt(index) {
  const vector = Array.from({ length: dimensions }, (_, dimension) => ((index * 31 + dimension * 17) % 997) / 997);
  return { id: `p${Math.floor(index / 2) + 1}-c${index % 2}`, page: Math.floor(index / 2) + 1, text: `Synthetic large-book chunk ${index}. ` + '索引性能测试文本。'.repeat(8), vector };
}

try {
  await writeFile(path.join(root, '.keep'), '');
  const entries = Array.from({ length: chunks }, (_, index) => entryAt(index));
  await Promise.all([mkdir(legacyDirectory), mkdir(sqliteDirectory)]);

  const jsonStarted = performance.now();
  await writeFile(path.join(legacyDirectory, 'index.json'), JSON.stringify({ version: 1, providerId, createdAt: new Date().toISOString(), entries }));
  const jsonMs = performance.now() - jsonStarted;
  const jsonBytes = (await stat(path.join(legacyDirectory, 'index.json'))).size;

  const migrationStarted = performance.now();
  const migrated = openIndex(legacyDirectory, providerId);
  const migrationMs = performance.now() - migrationStarted;

  const sqliteStarted = performance.now();
  const build = startIndexBuild(sqliteDirectory, providerId, dimensions);
  for (let start = 0; start < entries.length; start += 16) appendIndexBatch(build, entries.slice(start, start + 16));
  const sqlite = finishIndexBuild(build);
  const sqliteMs = performance.now() - sqliteStarted;

  const query = Float32Array.from(entries[Math.floor(entries.length / 2)].vector);
  const searchStarted = performance.now();
  const matches = searchIndex(sqliteDirectory, providerId, query, 5);
  const searchMs = performance.now() - searchStarted;
  if (matches.length !== 5) throw new Error('SQLite search returned an unexpected result count');

  const report = {
    environment: { node: process.version, platform: `${process.platform}-${process.arch}`, cpu: os.cpus()[0]?.model || 'unknown' },
    chunks,
    estimatedPages: Math.ceil(chunks / 2),
    dimensions,
    json: { bytes: jsonBytes, writeMs: Math.round(jsonMs) },
    sqlite: { bytes: sqlite.bytes, writeMs: Math.round(sqliteMs), searchMs: Math.round(searchMs) },
    migration: { bytes: migrated.bytes, elapsedMs: Math.round(migrationMs) },
    sizeReductionPercent: Number(((1 - sqlite.bytes / jsonBytes) * 100).toFixed(1)),
    topScore: Number(matches[0].score.toFixed(6)),
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
