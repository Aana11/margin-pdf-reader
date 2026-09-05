export type EmbeddingProviderKind = 'local-qwen3-embedding-4b' | 'openai-compatible';
export type EmbeddingPurpose = 'document' | 'query';

export type EmbeddingProviderConfig = {
  kind: EmbeddingProviderKind;
  endpoint?: string;
  model?: string;
  apiKey?: string;
};

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number | null;
  embed(texts: string[], purpose?: EmbeddingPurpose): Promise<number[][]>;
}

export type RagChunk = {
  id: string;
  page: number;
  text: string;
};

export type RagMatch = RagChunk & { score: number };
