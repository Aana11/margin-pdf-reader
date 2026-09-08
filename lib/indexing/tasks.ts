import type { LibraryEntry } from '@/types/electron';

export const INDEX_TASKS_KEY = 'margin-index-tasks-v1';

export type IndexTaskStatus = 'queued' | 'running' | 'pausing' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type IndexTaskStage = 'queued' | 'preparing' | 'extracting' | 'ocr' | 'chunking' | 'embedding' | 'writing' | 'complete';

export type IndexStageTimings = Partial<Record<Exclude<IndexTaskStage, 'queued' | 'complete'>, number>>;

export type IndexTask = {
  id: string;
  bookId: string;
  bookName: string;
  status: IndexTaskStatus;
  stage: IndexTaskStage;
  progress: number;
  message: string;
  pageCount: number;
  completedPages: number;
  chunks: number;
  completedChunks: number;
  ocrPages: number;
  skippedPages: number;
  failedPages: number[];
  backend?: 'cpu' | 'vulkan';
  lanes?: { text: number; ocr: number; embedding: number };
  timings: IndexStageTimings;
  createdAt: string;
  updatedAt: string;
};

const validStatuses = new Set<IndexTaskStatus>(['queued', 'running', 'pausing', 'paused', 'completed', 'failed', 'cancelled']);
const validStages = new Set<IndexTaskStage>(['queued', 'preparing', 'extracting', 'ocr', 'chunking', 'embedding', 'writing', 'complete']);

export function normalizeIndexTasks(value: unknown): IndexTask[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): IndexTask[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const task = candidate as Partial<IndexTask>;
    if (typeof task.id !== 'string' || typeof task.bookId !== 'string' || typeof task.bookName !== 'string') return [];
    const interrupted = task.status === 'running' || task.status === 'pausing';
    const status = interrupted ? 'paused' : validStatuses.has(task.status as IndexTaskStatus) ? task.status as IndexTaskStatus : 'paused';
    const stage = validStages.has(task.stage as IndexTaskStage) ? task.stage as IndexTaskStage : 'queued';
    return [{
      id: task.id,
      bookId: task.bookId,
      bookName: task.bookName,
      status,
      stage,
      progress: Math.max(0, Math.min(100, Number(task.progress) || 0)),
      message: interrupted ? '应用上次退出时任务中断，可从 SQLite 检查点继续' : String(task.message || ''),
      pageCount: Math.max(0, Math.floor(Number(task.pageCount) || 0)),
      completedPages: Math.max(0, Math.floor(Number(task.completedPages) || 0)),
      chunks: Math.max(0, Math.floor(Number(task.chunks) || 0)),
      completedChunks: Math.max(0, Math.floor(Number(task.completedChunks) || 0)),
      ocrPages: Math.max(0, Math.floor(Number(task.ocrPages) || 0)),
      skippedPages: Math.max(0, Math.floor(Number(task.skippedPages) || 0)),
      failedPages: Array.isArray(task.failedPages) ? task.failedPages.filter((page) => Number.isInteger(page) && page > 0).slice(0, 10_000) : [],
      backend: task.backend === 'vulkan' ? 'vulkan' : task.backend === 'cpu' ? 'cpu' : undefined,
      lanes: task.lanes,
      timings: task.timings && typeof task.timings === 'object' ? task.timings : {},
      createdAt: typeof task.createdAt === 'string' ? task.createdAt : new Date().toISOString(),
      updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : new Date().toISOString(),
    }];
  }).slice(0, 100);
}

export function queueBooks(current: IndexTask[], books: LibraryEntry[]): IndexTask[] {
  const now = new Date().toISOString();
  const queued = [...current];
  for (const book of books) {
    const existingIndex = queued.findIndex((task) => task.bookId === book.id);
    const resumable = existingIndex >= 0 && ['paused', 'failed'].includes(queued[existingIndex].status);
    const task: IndexTask = {
      id: existingIndex >= 0 ? queued[existingIndex].id : `${book.id}:${Date.now()}:${Math.random().toString(16).slice(2)}`,
      bookId: book.id,
      bookName: book.name,
      status: 'queued',
      stage: 'queued',
      progress: resumable ? queued[existingIndex].progress : 0,
      message: resumable ? '已加入队列，将从检查点继续' : '已加入后台索引队列',
      pageCount: book.pageCount || queued[existingIndex]?.pageCount || 0,
      completedPages: resumable ? queued[existingIndex].completedPages : 0,
      chunks: resumable ? queued[existingIndex].chunks : 0,
      completedChunks: resumable ? queued[existingIndex].completedChunks : 0,
      ocrPages: resumable ? queued[existingIndex].ocrPages : 0,
      skippedPages: resumable ? queued[existingIndex].skippedPages : 0,
      failedPages: resumable ? queued[existingIndex].failedPages : [],
      backend: existingIndex >= 0 ? queued[existingIndex].backend : undefined,
      lanes: existingIndex >= 0 ? queued[existingIndex].lanes : undefined,
      timings: resumable ? queued[existingIndex].timings : {},
      createdAt: existingIndex >= 0 ? queued[existingIndex].createdAt : now,
      updatedAt: now,
    };
    if (existingIndex >= 0) queued[existingIndex] = task;
    else queued.push(task);
  }
  return queued;
}

export function shouldInspectWithOcr(text: string) {
  const compact = text.replace(/\s+/g, '');
  if (compact.length === 0) return true;
  const meaningful = compact.replace(/[\d\p{P}\p{S}]/gu, '');
  return compact.length < 32 || meaningful.length < 12;
}

export function estimateInkRatio(pixels: Uint8ClampedArray, width: number, height: number) {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return 0;
  const stride = Math.max(1, Math.floor(Math.max(width, height) / 500));
  let ink = 0;
  let sampled = 0;
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const offset = (y * width + x) * 4;
      const luminance = pixels[offset] * 0.2126 + pixels[offset + 1] * 0.7152 + pixels[offset + 2] * 0.0722;
      if (luminance < 235) ink += 1;
      sampled += 1;
    }
  }
  return sampled > 0 ? ink / sampled : 0;
}

export function isProbablyBlankPage(inkRatio: number) {
  return inkRatio < 0.0015;
}

export function formatElapsed(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return '0 秒';
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes} 分 ${rest} 秒`;
}
