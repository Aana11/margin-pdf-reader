import type { EmbeddingProvider, RagChunk, RagMatch, StoredIndexEntry } from './types';

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export class MemoryVectorIndex {
  private entries: StoredIndexEntry[] = [];

  get size() { return this.entries.length; }
  clear() { this.entries = []; }

  snapshot(): StoredIndexEntry[] {
    return this.entries.map((entry) => ({ ...entry, vector: [...entry.vector] }));
  }

  restore(entries: StoredIndexEntry[], expectedDimensions: number | null): void {
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.id !== 'string' || !Number.isInteger(entry.page) || typeof entry.text !== 'string' || !Array.isArray(entry.vector) || entry.vector.some((value) => !Number.isFinite(value)))) {
      throw new Error('Stored vector index is invalid');
    }
    if (expectedDimensions && entries.some((entry) => entry.vector.length !== expectedDimensions)) throw new Error('Stored vector dimensions do not match provider');
    this.entries = entries.map((entry) => ({ ...entry, vector: [...entry.vector] }));
  }

  async add(chunks: RagChunk[], provider: EmbeddingProvider): Promise<void> {
    if (chunks.length === 0) return;
    const vectors = await provider.embed(chunks.map((chunk) => chunk.text), 'document');
    if (vectors.length !== chunks.length) throw new Error('Embedding provider returned an unexpected vector count');
    this.entries.push(...chunks.map((chunk, index) => ({ ...chunk, vector: vectors[index] })));
  }

  async search(query: string, provider: EmbeddingProvider, limit = 5): Promise<RagMatch[]> {
    if (this.entries.length === 0) return [];
    const [queryVector] = await provider.embed([query], 'query');
    return this.entries
      .map(({ vector, ...chunk }) => ({ ...chunk, score: cosineSimilarity(queryVector, vector) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
