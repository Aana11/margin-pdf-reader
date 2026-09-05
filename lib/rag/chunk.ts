import type { RagChunk } from './types';

const DEFAULT_CHUNK_SIZE = 900;
const DEFAULT_OVERLAP = 150;

export function chunkPage(
  text: string,
  page: number,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): RagChunk[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (chunkSize <= overlap || overlap < 0) throw new Error('Invalid chunk settings');

  const chunks: RagChunk[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + chunkSize, clean.length);
    if (end < clean.length) {
      const boundary = clean.lastIndexOf('。', end);
      if (boundary > start + chunkSize * 0.6) end = boundary + 1;
    }
    chunks.push({ id: `p${page}-c${chunks.length}`, page, text: clean.slice(start, end) });
    if (end >= clean.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
