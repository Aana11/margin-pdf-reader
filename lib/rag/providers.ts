import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingPurpose } from './types';

const QWEN_MODEL = 'Qwen/Qwen3-Embedding-4B';
const QUERY_INSTRUCTION = 'Given a user question about a PDF, retrieve passages that answer the question';

class LocalQwenEmbeddingProvider implements EmbeddingProvider {
  readonly id = `local:${QWEN_MODEL}:q8`;
  readonly dimensions = 2560;

  async embed(texts: string[], purpose: EmbeddingPurpose = 'document'): Promise<number[][]> {
    const prepared = purpose === 'query'
      ? texts.map((text) => `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${text}`)
      : texts;
    if (!window.marginDesktop?.embed) throw new Error('本地向量模型仅在 Margin 桌面应用中可用');
    return window.marginDesktop.embed(prepared);
  }
}

class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions = null;
  constructor(private readonly config: Required<Pick<EmbeddingProviderConfig, 'endpoint' | 'model' | 'apiKey'>>) {
    this.id = `remote:${config.endpoint}:${config.model}`;
  }

  async embed(texts: string[], purpose: EmbeddingPurpose = 'document'): Promise<number[][]> {
    const input = purpose === 'query'
      ? texts.map((text) => `Instruct: ${QUERY_INSTRUCTION}\nQuery: ${text}`)
      : texts;
    const response = await fetch(`${this.config.endpoint.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({ model: this.config.model, input, encoding_format: 'float' }),
    });
    if (!response.ok) throw new Error((await response.text()) || `Embedding request failed (${response.status})`);
    const payload = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
    if (!payload.data) throw new Error('Embedding provider returned no data');
    return payload.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
  }
}

export function createEmbeddingProvider(config: EmbeddingProviderConfig): EmbeddingProvider {
  if (config.kind === 'local-qwen3-embedding-4b') return new LocalQwenEmbeddingProvider();
  if (!config.endpoint || !config.model || !config.apiKey) throw new Error('自定义向量提供商配置不完整');
  return new OpenAiCompatibleEmbeddingProvider({ endpoint: config.endpoint, model: config.model, apiKey: config.apiKey });
}
