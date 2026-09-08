import type { DeepReadTask } from './deep-reading';

export type NormalizedRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RegionAction = 'formula' | 'table' | 'code' | 'translate';

export const REGION_ACTIONS: Record<RegionAction, { label: string; task: DeepReadTask; prompt: string }> = {
  formula: {
    label: '解释公式',
    task: 'formula',
    prompt: '解释框选区域中的公式：先准确写出公式，再说明每个符号、推导关系、适用条件和直观含义。保留 LaTeX 格式。',
  },
  table: {
    label: '识别表格',
    task: 'table',
    prompt: '准确识别框选区域中的表格并整理为 Markdown 表格；保留表头、单位、空值和层级关系，不要补造看不清的数据。随后用两三句话概括关键信息。',
  },
  code: {
    label: '分析代码',
    task: 'text',
    prompt: '分析框选区域中的代码：先用代码块准确还原，再解释用途、关键步骤、输入输出和潜在问题。不要擅自改写原代码。',
  },
  translate: {
    label: '翻译',
    task: 'text',
    prompt: '把框选区域准确翻译成简体中文。术语首次出现时保留原文，公式、代码、变量名和引用编号不要翻译；如果原文已经是中文，则翻译成英文。',
  },
};

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function normalizeRegion(startX: number, startY: number, endX: number, endY: number): NormalizedRegion {
  const x1 = clamp(Math.min(startX, endX));
  const y1 = clamp(Math.min(startY, endY));
  const x2 = clamp(Math.max(startX, endX));
  const y2 = clamp(Math.max(startY, endY));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function isUsableRegion(region: NormalizedRegion, canvasWidth: number, canvasHeight: number) {
  return region.width * canvasWidth >= 12 && region.height * canvasHeight >= 12;
}

export function regionPixels(region: NormalizedRegion, canvasWidth: number, canvasHeight: number) {
  const x = Math.max(0, Math.min(canvasWidth - 1, Math.floor(region.x * canvasWidth)));
  const y = Math.max(0, Math.min(canvasHeight - 1, Math.floor(region.y * canvasHeight)));
  const width = Math.max(1, Math.min(canvasWidth - x, Math.ceil(region.width * canvasWidth)));
  const height = Math.max(1, Math.min(canvasHeight - y, Math.ceil(region.height * canvasHeight)));
  return { x, y, width, height };
}

export function outputSize(width: number, height: number, maxEdge = 1800) {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function cropCanvasRegion(canvas: HTMLCanvasElement, region: NormalizedRegion) {
  const source = regionPixels(region, canvas.width, canvas.height);
  const output = outputSize(source.width, source.height);
  const cropped = document.createElement('canvas');
  cropped.width = output.width;
  cropped.height = output.height;
  const context = cropped.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法创建框选画布');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, output.width, output.height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(canvas, source.x, source.y, source.width, source.height, 0, 0, output.width, output.height);
  const mimeType = 'image/jpeg';
  const blob = await new Promise<Blob>((resolve, reject) => cropped.toBlob((value) => value ? resolve(value) : reject(new Error('无法编码框选区域')), mimeType, 0.94));
  cropped.width = 1;
  cropped.height = 1;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType, pixelWidth: output.width, pixelHeight: output.height };
}

export async function hashRegionImage(bytes: Uint8Array) {
  if (globalThis.crypto?.subtle) {
    const source = new Uint8Array(bytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', source.buffer);
    return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const value of bytes) hash = Math.imul(hash ^ value, 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
