import type { RagMatch } from './types';

export type DeepReadMode = 'off' | 'auto';
export type DeepReadTask = 'text' | 'formula' | 'table';

export type GlmOcrConfig = {
  endpoint: string;
  model: string;
  apiKey: string;
};

export type DeepReadCandidate = {
  page: number;
  text: string;
  task: DeepReadTask;
  reasons: string[];
};

export type GlmOcrResult = {
  text: string;
  task: DeepReadTask;
};

const TASK_PROMPTS: Record<DeepReadTask, string> = {
  text: 'Text Recognition:',
  formula: 'Formula Recognition:',
  table: 'Table Recognition:',
};

function countMatches(text: string, pattern: RegExp) {
  return text.match(pattern)?.length ?? 0;
}

export function classifyRichContent(text: string, question = ''): { task: DeepReadTask; reasons: string[]; rich: boolean } {
  const formulaScore = countMatches(text, /[∑∫√∞≈≠≤≥±×÷∂∇∏]/g)
    + countMatches(text, /\\(?:frac|sum|int|sqrt|begin|end|alpha|beta|gamma|theta|lambda|mathrm|mathbf)\b/g) * 2
    + countMatches(text, /\b[A-Za-z][_^]\{?[^\s]{1,20}/g)
    + countMatches(text, /[A-Za-z0-9)\]}]\s*=\s*[A-Za-z0-9([{]/g);
  const codeScore = countMatches(text, /\b(?:const|let|var|function|class|interface|def|import|return|async|await|SELECT|FROM|WHERE|INSERT|UPDATE)\b/g)
    + countMatches(text, /(?:=>|::|===|!=|&&|\|\||```|<\/?[a-z][^>]*>|[{};]{2,})/gi);
  const tableScore = countMatches(text, /(?:\|[^|\n]+){3,}\|/g)
    + countMatches(text, /\b(?:table|row|column|表格|行列|数据表)\b/gi);
  const questionFormula = /公式|方程|推导|证明|latex|equation|formula|theorem|定理/i.test(question);
  const questionCode = /代码|程序|函数|算法|接口|code|function|algorithm|api/i.test(question);
  const questionTable = /表格|数据表|第.{0,5}[行列]|table|column|row/i.test(question);
  const reasons: string[] = [];
  if (formulaScore >= 2 || questionFormula) reasons.push('公式');
  if (codeScore >= 2 || questionCode) reasons.push('代码');
  if (tableScore >= 2 || questionTable) reasons.push('表格');
  if (text.trim().length < 24) reasons.push('低文本页');
  const task: DeepReadTask = reasons.includes('公式') ? 'formula' : reasons.includes('表格') ? 'table' : 'text';
  return { task, reasons, rich: reasons.length > 0 };
}

export function selectDeepReadCandidates(
  currentPage: number,
  currentText: string,
  matches: RagMatch[],
  question: string,
  limit = 2,
): DeepReadCandidate[] {
  const requested = /精读|公式|方程|推导|证明|latex|代码|程序|算法|表格|equation|formula|code|table/i.test(question);
  const sources = matches.length
    ? [...matches.map(({ page, text }) => ({ page, text })), { page: currentPage, text: currentText }]
    : [{ page: currentPage, text: currentText }];
  const seen = new Set<number>();
  const candidates: DeepReadCandidate[] = [];
  for (const source of sources) {
    if (seen.has(source.page)) continue;
    seen.add(source.page);
    const classification = classifyRichContent(source.text, question);
    if (!classification.rich && !requested) continue;
    candidates.push({ page: source.page, text: source.text, task: classification.task, reasons: classification.reasons.length ? classification.reasons : ['用户指定'] });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string) {
  let binary = '';
  const size = 0x8000;
  for (let start = 0; start < bytes.length; start += size) binary += String.fromCharCode(...bytes.subarray(start, start + size));
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function completionEndpoint(endpoint: string) {
  const clean = endpoint.trim().replace(/\/+$/, '');
  if (!clean) throw new Error('GLM-OCR 端点不能为空');
  const url = new URL(clean.endsWith('/chat/completions') ? clean : `${clean}/chat/completions`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('GLM-OCR 端点必须使用 HTTP 或 HTTPS');
  return url.toString();
}

export async function recognizeWithGlmOcr(
  config: GlmOcrConfig,
  image: Uint8Array,
  mimeType: string,
  task: DeepReadTask,
): Promise<GlmOcrResult> {
  if (!config.model.trim()) throw new Error('GLM-OCR 模型名称不能为空');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  const response = await fetch(completionEndpoint(config.endpoint), {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: config.model.trim(),
      temperature: 0,
      max_tokens: 4096,
      stream: false,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: bytesToDataUrl(image, mimeType) } },
          { type: 'text', text: TASK_PROMPTS[task] },
        ],
      }],
    }),
  });
  if (!response.ok) throw new Error((await response.text()) || `GLM-OCR 请求失败 (${response.status})`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
  const content = payload.choices?.[0]?.message?.content;
  const text = (typeof content === 'string' ? content : content?.map((item) => item.text ?? '').join('\n') ?? '').trim();
  if (!text) throw new Error('GLM-OCR 未返回识别结果');
  return { text, task };
}
