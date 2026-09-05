import type { EmbeddingProvider, RagChunk, RagMatch } from './types';

type IndexedChunk = RagChunk & { vector: number[] };

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
  private entries: IndexedChunk[] = [];

  get size() { return this.entries.length; }
  clear() { this.entries = []; }

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
