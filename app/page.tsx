'use client';

import {
  PointerEvent as ReactPointerEvent,
  SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { CSSProperties } from 'react';
import {
  BookMarked,
  BookOpen,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Code2,
  Download,
  FileText,
  Folder,
  FolderPlus,
  Gauge,
  HardDrive,
  Highlighter,
  History,
  Languages,
  Library,
  ListTodo,
  MessageSquareText,
  NotebookPen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  ScanSearch,
  Search,
  Send,
  Settings2,
  Sigma,
  Sparkles,
  Square,
  Table2,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
// oxlint-disable-next-line import/default -- Vite's ?url loader provides this synthetic default export.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { chunkPage } from '@/lib/rag/chunk';
import {
  estimateInkRatio,
  formatElapsed,
  INDEX_TASKS_KEY,
  isProbablyBlankPage,
  normalizeIndexTasks,
  queueBooks,
  shouldInspectWithOcr,
} from '@/lib/indexing/tasks';
import type { IndexTask, IndexTaskStage } from '@/lib/indexing/tasks';
import {
  classifyRichContent,
  recognizeWithGlmOcr,
  selectDeepReadCandidates,
} from '@/lib/rag/deep-reading';
import type { DeepReadMode } from '@/lib/rag/deep-reading';
import {
  cropCanvasRegion,
  hashRegionImage,
  isUsableRegion,
  normalizeRegion,
  REGION_ACTIONS,
} from '@/lib/rag/region-reading';
import type { NormalizedRegion, RegionAction } from '@/lib/rag/region-reading';
import { MemoryVectorIndex } from '@/lib/rag/memory-index';
import { createEmbeddingProvider } from '@/lib/rag/providers';
import type {
  EmbeddingProvider,
  EmbeddingProviderKind,
  RagChunk,
  RagMatch,
} from '@/lib/rag/types';
import type {
  GlmOcrConfig,
  GlmOcrProvider,
  GlmOcrStatus,
  KnowledgeMatch,
  KnowledgePack,
  KnowledgeSource,
  LibraryEntry,
  ModelInstallStatus,
  WorkspaceHistoryItem,
  WorkspaceNote,
  WorkspaceNoteKind,
} from '@/types/electron';

type RegionCitation = { page: number; region: NormalizedRegion };
type Message = {
  role: 'user' | 'assistant';
  content: string;
  page: number;
  createdAt?: string;
  citation?: RegionCitation;
  sources?: KnowledgeSource[];
};
type ChatHistoryRecord = {
  bookId: string;
  bookName: string;
  messages: Message[];
  updatedAt: string;
};
type SelectedRegion = RegionCitation & {
  image?: Uint8Array;
  mimeType?: string;
  imageHash?: string;
  pixelWidth?: number;
  pixelHeight?: number;
};
type RegionAiContext = {
  recognized: string;
  action: RegionAction;
  citation: RegionCitation;
};
type ModelSettings = {
  endpoint: string;
  model: string;
  apiKey: string;
  systemPrompt: string;
  embeddingKind: EmbeddingProviderKind;
  embeddingEndpoint: string;
  embeddingModel: string;
  embeddingApiKey: string;
  ocrMode: 'auto' | 'off';
  ocrLanguage: 'eng' | 'chi_sim+eng' | 'chi_tra+eng';
  glmOcrMode: DeepReadMode;
  glmOcrProvider: GlmOcrProvider;
  glmOcrEndpoint: string;
  glmOcrModel: string;
  glmOcrApiKey: string;
  glmOcrAutoStart: boolean;
};
const DEFAULT_SETTINGS: ModelSettings = {
  endpoint: 'https://api.openai.com/v1',
  model: 'gpt-5-mini',
  apiKey: '',
  systemPrompt:
    '你是一位严谨的中文阅读助手。优先依据当前页原文回答；原文不足时明确说明，不要捏造。回答简洁、有条理。',
  embeddingKind: 'local-qwen3-embedding-4b',
  embeddingEndpoint: 'https://api-inference.modelscope.cn/v1',
  embeddingModel: 'text-embedding-3-small',
  embeddingApiKey: '',
  ocrMode: 'auto',
  ocrLanguage: 'chi_sim+eng',
  glmOcrMode: 'off',
  glmOcrProvider: 'managed',
  glmOcrEndpoint: '',
  glmOcrModel: 'ggml-org/GLM-OCR-GGUF',
  glmOcrApiKey: '',
  glmOcrAutoStart: true,
};
const quickPrompts = ['总结本页', '解释核心概念', '精读本页公式/代码'];
const CHAT_HISTORY_KEY = 'margin-chat-history-v1';
const WORKSPACE_MIGRATION_KEY = 'margin-workspace-sqlite-v1';
const NOTE_KIND_LABELS: Record<WorkspaceNoteKind, string> = {
  highlight: '高亮',
  note: '批注',
  summary: 'AI 摘要',
  glossary: '概念',
};

type AppInfo = {
  version: string;
  packaged: boolean;
  logPath: string;
  dataRoot: string;
  cpuThreads: number;
  totalMemory: number;
  freeMemory: number;
  runtimeBackend: 'cpu' | 'vulkan';
  ocrWorkers: number;
  embeddingSlots: number;
};

function readSavedSettings(): ModelSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const saved = JSON.parse(
      localStorage.getItem('margin-ai-settings') ?? '{}',
    );
    const schema = Number(localStorage.getItem('margin-settings-schema') || 0);
    const migrated =
      schema >= 2
        ? saved
        : {
            ...saved,
            glmOcrProvider: 'managed',
            glmOcrEndpoint: '',
            glmOcrModel: 'ggml-org/GLM-OCR-GGUF',
          };
    return { ...DEFAULT_SETTINGS, ...migrated };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function readChatHistory(): ChatHistoryRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function readIndexTasks(): IndexTask[] {
  if (typeof window === 'undefined') return [];
  try {
    return normalizeIndexTasks(
      JSON.parse(localStorage.getItem(INDEX_TASKS_KEY) ?? '[]'),
    );
  } catch {
    return [];
  }
}

function formatRemaining(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `约 ${Math.max(1, Math.ceil(seconds))} 秒`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `约 ${minutes} 分钟`;
  return `约 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

async function mapWithConcurrency<T>(
  count: number,
  concurrency: number,
  task: (pageNumber: number) => Promise<T>,
): Promise<T[]> {
  const results = Array.from<T>({ length: count });
  let cursor = 0;
  let firstError: unknown;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (cursor < count && !firstError) {
        const index = cursor;
        cursor += 1;
        try {
          results[index] = await task(index + 1);
        } catch (reason) {
          firstError ||= reason;
        }
      }
    }),
  );
  if (firstError) throw firstError;
  return results;
}

function getIndexConcurrency(
  appInfo?: AppInfo | null,
  backend?: 'cpu' | 'vulkan',
) {
  const threads =
    appInfo?.cpuThreads ||
    (typeof navigator === 'undefined'
      ? 8
      : Math.max(1, navigator.hardwareConcurrency || 8));
  const memoryGb = appInfo ? appInfo.totalMemory / 1024 / 1024 / 1024 : 16;
  return {
    text: Math.max(2, Math.min(8, Math.ceil(threads / 2))),
    ocr: Math.max(
      1,
      Math.min(
        appInfo?.ocrWorkers || 4,
        memoryGb < 8 ? 1 : memoryGb < 16 ? 2 : Math.floor(threads / 4),
      ),
    ),
    embedding:
      backend === 'vulkan'
        ? 8
        : Math.max(
            1,
            Math.min(appInfo?.embeddingSlots || 4, Math.floor(threads / 4)),
          ),
  };
}

const INDEX_STAGE_LABELS: Record<IndexTaskStage, string> = {
  queued: '排队',
  preparing: '准备',
  extracting: '文本提取',
  ocr: 'OCR',
  chunking: '整理文本',
  embedding: '向量生成',
  writing: '写入 SQLite',
  complete: '完成',
};

function indexTaskStatusLabel(task: IndexTask) {
  if (task.status === 'queued') return '等待中';
  if (task.status === 'running') return INDEX_STAGE_LABELS[task.stage];
  if (task.status === 'pausing') return '正在暂停';
  if (task.status === 'paused') return '已暂停';
  if (task.status === 'completed') return '已完成';
  if (task.status === 'cancelled') return '已取消';
  return '需要处理';
}

function MarkdownMessage({ content }: { content: string }) {
  const normalized = content
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, formula: string) => `$$${formula}$$`)
    .replace(/\\\((.+?)\\\)/g, (_, formula: string) => `$${formula}$`);
  return (
    <div className="message-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

async function renderPageImage(
  pdfPage: PDFPageProxy,
  format: 'png' | 'jpeg' = 'png',
  inspectBlank = false,
): Promise<{ bytes: Uint8Array; mimeType: string; inkRatio?: number }> {
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const scale = Math.max(
    1.5,
    Math.min(2.5, 2000 / Math.max(baseViewport.width, baseViewport.height)),
  );
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法创建 OCR 页面画布');
  await pdfPage.render({
    canvas,
    canvasContext: context,
    viewport,
    background: '#ffffff',
    intent: 'print',
  }).promise;
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  let inkRatio: number | undefined;
  if (inspectBlank) {
    const sampleScale = Math.min(
      1,
      320 / Math.max(canvas.width, canvas.height),
    );
    const sample = document.createElement('canvas');
    sample.width = Math.max(1, Math.round(canvas.width * sampleScale));
    sample.height = Math.max(1, Math.round(canvas.height * sampleScale));
    const sampleContext = sample.getContext('2d', { alpha: false });
    if (sampleContext) {
      sampleContext.drawImage(canvas, 0, 0, sample.width, sample.height);
      inkRatio = estimateInkRatio(
        sampleContext.getImageData(0, 0, sample.width, sample.height).data,
        sample.width,
        sample.height,
      );
    }
    sample.width = 1;
    sample.height = 1;
  }
  if (inspectBlank && isProbablyBlankPage(inkRatio || 0)) {
    canvas.width = 1;
    canvas.height = 1;
    return { bytes: new Uint8Array(), mimeType, inkRatio };
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) =>
        value ? resolve(value) : reject(new Error('无法编码识别页面')),
      mimeType,
      format === 'jpeg' ? 0.92 : undefined,
    ),
  );
  canvas.width = 1;
  canvas.height = 1;
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    mimeType,
    inkRatio,
  };
}

type PdfPageCanvasProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  activePage: number;
  onText: (pageNumber: number, text: string) => void;
  onError: (message: string) => void;
  selectionEnabled: boolean;
  selectedRegion?: SelectedRegion;
  annotations: WorkspaceNote[];
  regionActionBusy: RegionAction | null;
  onSelectionStart: () => void;
  onRegionSelected: (selection: SelectedRegion) => void;
  onRegionAction: (action: RegionAction) => void;
  onSaveRegion: (kind: 'highlight' | 'note' | 'glossary') => void;
  onAnnotationOpen: (note: WorkspaceNote) => void;
  onRegionClear: () => void;
};

function PdfPageCanvas({
  pdf,
  pageNumber,
  activePage,
  onText,
  onError,
  selectionEnabled,
  selectedRegion,
  annotations,
  regionActionBusy,
  onSelectionStart,
  onRegionSelected,
  onRegionAction,
  onSaveRegion,
  onAnnotationOpen,
  onRegionClear,
}: PdfPageCanvasProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(760);
  const [pageRatio, setPageRatio] = useState(1 / 1.414);
  const [draftRegion, setDraftRegion] = useState<NormalizedRegion | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const root = shell.closest('.canvas-wrap');
    const observer = new IntersectionObserver(
      (entries) => {
        setNearViewport(entries.some((entry) => entry.isIntersecting));
      },
      { root, rootMargin: '800px 0px' },
    );
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  const shouldRender = nearViewport || Math.abs(pageNumber - activePage) <= 1;

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const updateWidth = () => setAvailableWidth(shell.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldRender || !canvasRef.current) {
      if (canvasRef.current) {
        canvasRef.current.width = 1;
        canvasRef.current.height = 1;
        canvasRef.current.style.width = '';
        canvasRef.current.style.height = '';
      }
      return;
    }
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | undefined;
    async function renderPage() {
      const pdfPage = await pdf.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      setPageRatio(baseViewport.width / baseViewport.height);
      const scale = Math.min(
        2,
        Math.max(0.5, (availableWidth - 32) / baseViewport.width),
      );
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      renderTask = pdfPage.render({
        canvas,
        canvasContext: context,
        viewport,
        transform:
          pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await renderTask.promise;
      const content = await pdfPage.getTextContent();
      if (!cancelled)
        onText(
          pageNumber,
          content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim(),
        );
    }
    renderPage().catch((reason) => {
      if (reason?.name !== 'RenderingCancelledException')
        onError(`第 ${pageNumber} 页渲染失败。`);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [availableWidth, onError, onText, pageNumber, pdf, shouldRender]);

  const pointerPosition = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      !selectionEnabled ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest('button')
    )
      return;
    const point = pointerPosition(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = point;
    setDraftRegion({ x: point.x, y: point.y, width: 0, height: 0 });
    onSelectionStart();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    if (!start) return;
    const point = pointerPosition(event);
    if (point)
      setDraftRegion(normalizeRegion(start.x, start.y, point.x, point.y));
  };

  const handlePointerEnd = async (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    const point = pointerPosition(event);
    const canvas = canvasRef.current;
    if (!point || !canvas) {
      setDraftRegion(null);
      return;
    }
    const region = normalizeRegion(start.x, start.y, point.x, point.y);
    if (!isUsableRegion(region, canvas.clientWidth, canvas.clientHeight)) {
      setDraftRegion(null);
      return;
    }
    setDraftRegion(region);
    try {
      const cropped = await cropCanvasRegion(canvas, region);
      const imageHash = await hashRegionImage(cropped.bytes);
      onRegionSelected({
        page: pageNumber,
        region,
        image: cropped.bytes,
        mimeType: cropped.mimeType,
        pixelWidth: cropped.pixelWidth,
        pixelHeight: cropped.pixelHeight,
        imageHash,
      });
      setDraftRegion(null);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '无法裁剪框选区域');
      setDraftRegion(null);
    }
  };

  const visibleRegion = draftRegion ?? selectedRegion?.region;
  const toolbarAbove = Boolean(
    visibleRegion && visibleRegion.y + visibleRegion.height > 0.82,
  );
  return (
    <div
      ref={shellRef}
      className="pdf-page"
      style={{ aspectRatio: pageRatio }}
      data-page={pageNumber}
      aria-label={`PDF 第 ${pageNumber} 页`}
    >
      <div
        ref={stageRef}
        className={
          selectionEnabled ? 'pdf-canvas-stage selecting' : 'pdf-canvas-stage'
        }
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => void handlePointerEnd(event)}
        onPointerCancel={() => {
          dragStartRef.current = null;
          setDraftRegion(null);
        }}
      >
        <canvas ref={canvasRef} />
        {annotations
          .filter((note) => note.region)
          .map((note) => (
            <button
              key={note.id}
              className={`saved-annotation ${note.kind}`}
              style={
                {
                  left: `${note.region!.x * 100}%`,
                  top: `${note.region!.y * 100}%`,
                  width: `${note.region!.width * 100}%`,
                  height: `${note.region!.height * 100}%`,
                  '--annotation-color': note.color,
                } as CSSProperties
              }
              onClick={() => onAnnotationOpen(note)}
              aria-label={`打开${NOTE_KIND_LABELS[note.kind]}：${note.title || `第 ${note.page} 页`}`}
              title={note.title || NOTE_KIND_LABELS[note.kind]}
            />
          ))}
        {visibleRegion && (
          <div
            className={
              selectedRegion ? 'region-selection committed' : 'region-selection'
            }
            style={{
              left: `${visibleRegion.x * 100}%`,
              top: `${visibleRegion.y * 100}%`,
              width: `${visibleRegion.width * 100}%`,
              height: `${visibleRegion.height * 100}%`,
            }}
          />
        )}
        {selectedRegion && (
          <div
            className={
              toolbarAbove
                ? 'region-action-popover above'
                : 'region-action-popover'
            }
            style={{
              top: `${(selectedRegion.region.y + selectedRegion.region.height) * 100}%`,
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {selectedRegion.image ? (
              <>
                <button
                  onClick={() => onRegionAction('formula')}
                  disabled={Boolean(regionActionBusy)}
                  title="调用 GLM-OCR 识别并解释公式"
                >
                  <Sigma />
                  解释公式
                </button>
                <button
                  onClick={() => onRegionAction('table')}
                  disabled={Boolean(regionActionBusy)}
                  title="调用 GLM-OCR 还原表格"
                >
                  <Table2 />
                  识别表格
                </button>
                <button
                  onClick={() => onRegionAction('code')}
                  disabled={Boolean(regionActionBusy)}
                  title="识别并分析代码"
                >
                  <Code2 />
                  分析代码
                </button>
                <button
                  onClick={() => onRegionAction('translate')}
                  disabled={Boolean(regionActionBusy)}
                  title="识别并翻译文字"
                >
                  <Languages />
                  翻译
                </button>
                <span className="region-action-divider" />
                <button
                  onClick={() => onSaveRegion('highlight')}
                  disabled={Boolean(regionActionBusy)}
                  title="保存页面高亮"
                >
                  <Highlighter />
                  高亮
                </button>
                <button
                  onClick={() => onSaveRegion('note')}
                  disabled={Boolean(regionActionBusy)}
                  title="为选区添加批注"
                >
                  <NotebookPen />
                  批注
                </button>
                <button
                  onClick={() => onSaveRegion('glossary')}
                  disabled={Boolean(regionActionBusy)}
                  title="加入概念词典"
                >
                  <BookMarked />
                  概念
                </button>
              </>
            ) : (
              <span>AI 引用区域</span>
            )}
            {regionActionBusy && (
              <span className="region-action-busy">识别中…</span>
            )}
            <button
              className="region-action-close"
              onClick={onRegionClear}
              aria-label="关闭框选区域"
            >
              <X />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readerScrollRef = useRef<HTMLDivElement>(null);
  const pageTextsRef = useRef(new Map<number, string>());
  const vectorIndexRef = useRef(new MemoryVectorIndex());
  const embeddingProviderRef = useRef<EmbeddingProvider | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const indexTasksRef = useRef<IndexTask[]>([]);
  const indexTaskRunnerRef = useRef(false);
  const processIndexQueueRef = useRef<() => Promise<void>>(
    async () => undefined,
  );
  const indexTaskControlRef = useRef(new Map<string, 'pause' | 'cancel'>());
  const pageIndicatorTimerRef = useRef<number | null>(null);
  const readerScrollTimerRef = useRef<number | null>(null);
  const deepReadCacheRef = useRef(new Map<string, string>());
  const activeBookIdRef = useRef<string | null>(null);
  const selectedKnowledgePackIdRef = useRef<string | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [fileName, setFileName] = useState('');
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pageText, setPageText] = useState('');
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState('');
  const [indexStatus, setIndexStatus] = useState<
    'idle' | 'indexing' | 'ready' | 'error'
  >('idle');
  const [indexProgress, setIndexProgress] = useState(0);
  const [indexMessage, setIndexMessage] = useState('');
  const [hasIndexCheckpoint, setHasIndexCheckpoint] = useState(false);
  const [settings, setSettings] = useState<ModelSettings>(readSavedSettings);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [libraryLoaded, setLibraryLoaded] = useState(false);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelInstallStatus | null>(
    null,
  );
  const [glmOcrStatus, setGlmOcrStatus] = useState<GlmOcrStatus | null>(null);
  const [scanWarning, setScanWarning] = useState('');
  const [deepReadStatus, setDeepReadStatus] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [chatModelList, setChatModelList] = useState<string[]>([]);
  const [chatModelListLoading, setChatModelListLoading] = useState(false);
  const [chatModelListError, setChatModelListError] = useState('');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledgePacks, setKnowledgePacks] = useState<KnowledgePack[]>([]);
  const [selectedKnowledgePackId, setSelectedKnowledgePackId] = useState<
    string | null
  >(null);
  const [activeKnowledgePackId, setActiveKnowledgePackId] = useState<
    string | null
  >(null);
  const [newKnowledgePackName, setNewKnowledgePackName] = useState('');
  const [knowledgePackName, setKnowledgePackName] = useState('');
  const [knowledgePackDescription, setKnowledgePackDescription] = useState('');
  const [knowledgeSearchStatus, setKnowledgeSearchStatus] = useState('');
  const [knowledgeExcludedBookIds, setKnowledgeExcludedBookIds] = useState<
    string[]
  >([]);
  const [knowledgePageFrom, setKnowledgePageFrom] = useState('');
  const [knowledgePageTo, setKnowledgePageTo] = useState('');
  const [knowledgeNotice, setKnowledgeNotice] = useState('');
  const [taskCenterOpen, setTaskCenterOpen] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [workspaceKind, setWorkspaceKind] = useState<'all' | WorkspaceNoteKind>(
    'all',
  );
  const [workspaceNotes, setWorkspaceNotes] = useState<WorkspaceNote[]>([]);
  const [workspaceNotesTotal, setWorkspaceNotesTotal] = useState(0);
  const [activeNotes, setActiveNotes] = useState<WorkspaceNote[]>([]);
  const [workspaceNotice, setWorkspaceNotice] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyItems, setHistoryItems] = useState<WorkspaceHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [indexTasks, setIndexTasks] = useState<IndexTask[]>(readIndexTasks);
  const [showPageIndicator, setShowPageIndicator] = useState(false);
  const [regionSelectMode, setRegionSelectMode] = useState(false);
  const [selectedRegion, setSelectedRegion] = useState<SelectedRegion | null>(
    null,
  );
  const [regionActionBusy, setRegionActionBusy] = useState<RegionAction | null>(
    null,
  );

  useEffect(() => {
    indexTasksRef.current = indexTasks;
  }, [indexTasks]);

  const glmConfig = useCallback(
    (): GlmOcrConfig => ({
      provider: settings.glmOcrProvider,
      endpoint: settings.glmOcrEndpoint,
      model: settings.glmOcrModel,
      apiKey: settings.glmOcrApiKey,
      autoStart: settings.glmOcrAutoStart,
    }),
    [
      settings.glmOcrApiKey,
      settings.glmOcrAutoStart,
      settings.glmOcrEndpoint,
      settings.glmOcrModel,
      settings.glmOcrProvider,
    ],
  );

  const revealPageIndicator = useCallback(() => {
    setShowPageIndicator(true);
    if (pageIndicatorTimerRef.current !== null)
      window.clearTimeout(pageIndicatorTimerRef.current);
    pageIndicatorTimerRef.current = window.setTimeout(
      () => setShowPageIndicator(false),
      900,
    );
  }, []);

  const saveChatHistory = useCallback(
    (bookId: string, bookName: string, nextMessages: Message[]) => {
      if (!bookId || nextMessages.length === 0) return;
      if (window.marginDesktop?.workspaceChatReplace) {
        void window.marginDesktop
          .workspaceChatReplace(bookId, bookName, nextMessages.slice(-100))
          .catch((reason) =>
            window.marginDesktop?.logEvent?.(
              'workspace-chat-save-failed',
              {
                bookId,
                message:
                  reason instanceof Error ? reason.message : String(reason),
              },
              'error',
            ),
          );
        return;
      }
      const current = readChatHistory();
      const record = {
        bookId,
        bookName,
        messages: nextMessages.slice(-100),
        updatedAt: new Date().toISOString(),
      };
      localStorage.setItem(
        CHAT_HISTORY_KEY,
        JSON.stringify(
          [record, ...current.filter((entry) => entry.bookId !== bookId)].slice(
            0,
            50,
          ),
        ),
      );
    },
    [],
  );

  const scrollToPage = useCallback(
    (target: number, behavior: ScrollBehavior = 'smooth') => {
      const container = readerScrollRef.current;
      const pageElement = container?.querySelector<HTMLElement>(
        `.pdf-page[data-page="${target}"]`,
      );
      if (!container || !pageElement) return;
      container.scrollTo({
        top: Math.max(0, pageElement.offsetTop - 18),
        behavior,
      });
      setPage(target);
      revealPageIndicator();
    },
    [revealPageIndicator],
  );

  const revealCitation = useCallback(
    (citation: RegionCitation) => {
      setRegionSelectMode(false);
      setSelectedRegion({ ...citation });
      scrollToPage(citation.page);
    },
    [scrollToPage],
  );

  const handlePageText = useCallback((pageNumber: number, text: string) => {
    pageTextsRef.current.set(pageNumber, text);
  }, []);

  const handleRenderError = useCallback(
    (message: string) => setError(message),
    [],
  );

  const refreshLibrary = useCallback(async () => {
    if (!window.marginDesktop?.libraryList) {
      setLibraryLoaded(true);
      return;
    }
    try {
      setLibrary(await window.marginDesktop.libraryList());
    } finally {
      setLibraryLoaded(true);
    }
  }, []);

  const refreshKnowledgePacks = useCallback(async () => {
    if (!window.marginDesktop?.knowledgeList) return;
    const packs = await window.marginDesktop.knowledgeList();
    setKnowledgePacks(packs);
    const selected =
      packs.find((pack) => pack.id === selectedKnowledgePackIdRef.current) ||
      packs[0];
    selectedKnowledgePackIdRef.current = selected?.id || null;
    setSelectedKnowledgePackId(selected?.id || null);
    setKnowledgePackName(selected?.name || '');
    setKnowledgePackDescription(selected?.description || '');
    setActiveKnowledgePackId((current) =>
      current && packs.some((pack) => pack.id === current) ? current : null,
    );
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => {
      void refreshLibrary();
      void refreshKnowledgePacks();
    });
  }, [refreshKnowledgePacks, refreshLibrary]);

  useEffect(() => {
    if (
      !libraryLoaded ||
      !window.marginDesktop?.workspaceChatReplace ||
      localStorage.getItem(WORKSPACE_MIGRATION_KEY) === '1'
    )
      return;
    const legacy = readChatHistory();
    if (legacy.length === 0) {
      localStorage.setItem(WORKSPACE_MIGRATION_KEY, '1');
      return;
    }
    const knownBooks = new Map(library.map((book) => [book.id, book]));
    if (library.length === 0) return;
    window.queueMicrotask(
      () =>
        void Promise.all(
          legacy.map((record) => {
            const book = knownBooks.get(record.bookId);
            return book
              ? window.marginDesktop!.workspaceChatReplace!(
                  book.id,
                  book.name,
                  record.messages.slice(-100),
                )
              : Promise.resolve({ messages: 0 });
          }),
        )
          .then(() => {
            localStorage.removeItem(CHAT_HISTORY_KEY);
            localStorage.setItem(WORKSPACE_MIGRATION_KEY, '1');
            window.marginDesktop?.logEvent?.('workspace-chat-migrated', {
              records: legacy.length,
            });
          })
          .catch((reason) =>
            window.marginDesktop?.logEvent?.(
              'workspace-chat-migration-failed',
              {
                message:
                  reason instanceof Error ? reason.message : String(reason),
              },
              'error',
            ),
          ),
    );
  }, [library, libraryLoaded]);

  const refreshActiveNotes = useCallback(async (bookId: string | null) => {
    if (!bookId || !window.marginDesktop?.workspaceNotesList) {
      setActiveNotes([]);
      return;
    }
    const result = await window.marginDesktop.workspaceNotesList({
      bookId,
      limit: 100,
    });
    setActiveNotes(result.items);
  }, []);

  useEffect(() => {
    if (!historyOpen || !window.marginDesktop?.workspaceHistorySearch) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void window.marginDesktop!.workspaceHistorySearch!(historyQuery, 50, 0)
        .then((result) => {
          if (!cancelled) {
            setHistoryItems(result.items);
            setHistoryTotal(result.total);
          }
        })
        .catch((reason) => {
          if (!cancelled)
            setError(
              `读取提问历史失败：${reason instanceof Error ? reason.message : String(reason)}`,
            );
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [historyOpen, historyQuery]);

  useEffect(() => {
    if (!workspaceOpen || !window.marginDesktop?.workspaceNotesList) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void window.marginDesktop!.workspaceNotesList!({
        kind: workspaceKind === 'all' ? undefined : workspaceKind,
        query: workspaceQuery,
        limit: 50,
        offset: 0,
      })
        .then((result) => {
          if (!cancelled) {
            setWorkspaceNotes(result.items);
            setWorkspaceNotesTotal(result.total);
          }
        })
        .catch((reason) => {
          if (!cancelled)
            setError(
              `读取阅读资料失败：${reason instanceof Error ? reason.message : String(reason)}`,
            );
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [workspaceKind, workspaceOpen, workspaceQuery]);

  useEffect(() => {
    const bridge = window.marginDesktop;
    if (!bridge?.modelStatus) return;
    window.queueMicrotask(
      () => void bridge.modelStatus?.().then(setModelStatus),
    );
    window.queueMicrotask(
      () =>
        void bridge.appInfo?.().then((info) => {
          setAppVersion(info.version);
          setAppInfo(info);
        }),
    );
    return bridge.onModelProgress?.((progress) => {
      setModelStatus((current) =>
        current ? { ...current, ...progress } : current,
      );
    });
  }, []);

  const mutateIndexTasks = useCallback(
    (updater: (current: IndexTask[]) => IndexTask[]) => {
      const next = updater(indexTasksRef.current);
      indexTasksRef.current = next;
      localStorage.setItem(INDEX_TASKS_KEY, JSON.stringify(next));
      setIndexTasks(next);
      return next;
    },
    [],
  );

  const patchIndexTask = useCallback(
    (taskId: string, changes: Partial<IndexTask>) =>
      mutateIndexTasks((current) =>
        current.map((task) =>
          task.id === taskId
            ? { ...task, ...changes, updatedAt: new Date().toISOString() }
            : task,
        ),
      ),
    [mutateIndexTasks],
  );

  useEffect(() => {
    const bridge = window.marginDesktop;
    if (!bridge?.modelStatus || !bridge.glmOcrStatus) return;
    let cancelled = false;
    const managedConfig: GlmOcrConfig = {
      provider: 'managed',
      endpoint: '',
      model: 'ggml-org/GLM-OCR-GGUF',
      apiKey: '',
      autoStart: true,
    };
    window.queueMicrotask(
      () =>
        void Promise.all([
          bridge.modelStatus!(),
          bridge.glmOcrStatus!(managedConfig),
        ])
          .then(([embedding, glm]) => {
            if (cancelled) return;
            setModelStatus(embedding);
            let raw: Partial<ModelSettings> = {};
            try {
              raw = JSON.parse(
                localStorage.getItem('margin-ai-settings') ?? '{}',
              );
            } catch {
              /* Use safe defaults. */
            }
            const discovered: Partial<ModelSettings> = {};
            if (
              embedding.installed &&
              !Object.prototype.hasOwnProperty.call(raw, 'embeddingKind')
            )
              discovered.embeddingKind = 'local-qwen3-embedding-4b';
            if (
              glm.modelInstalled &&
              !Object.prototype.hasOwnProperty.call(raw, 'glmOcrMode')
            ) {
              discovered.glmOcrMode = 'auto';
              discovered.glmOcrProvider = 'managed';
              discovered.glmOcrEndpoint = '';
              discovered.glmOcrModel = 'ggml-org/GLM-OCR-GGUF';
              discovered.glmOcrAutoStart = true;
            }
            const next = { ...DEFAULT_SETTINGS, ...raw, ...discovered };
            localStorage.setItem('margin-ai-settings', JSON.stringify(next));
            localStorage.setItem('margin-settings-schema', '3');
            if (Object.keys(discovered).length > 0) {
              setSettings(next);
              window.marginDesktop?.logEvent?.('models-auto-associated', {
                embeddingInstalled: embedding.installed,
                glmInstalled: glm.modelInstalled,
                dataRoot: embedding.root,
              });
            }
          })
          .catch((reason) =>
            window.marginDesktop?.logEvent?.(
              'models-auto-association-failed',
              {
                message:
                  reason instanceof Error ? reason.message : String(reason),
              },
              'error',
            ),
          ),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const bridge = window.marginDesktop;
    if (settings.glmOcrMode !== 'auto' || !bridge?.glmOcrStatus) {
      window.queueMicrotask(() => setGlmOcrStatus(null));
      return;
    }
    let cancelled = false;
    window.queueMicrotask(
      () =>
        void bridge
          .glmOcrStatus?.(glmConfig())
          .then((status) => {
            if (!cancelled) setGlmOcrStatus(status);
          })
          .catch((reason) => {
            if (!cancelled)
              setGlmOcrStatus({
                provider: settings.glmOcrProvider,
                runtimeInstalled: false,
                serviceRunning: false,
                modelInstalled: false,
                modelLoaded: false,
                state: 'error',
                progress: 0,
                message:
                  reason instanceof Error ? reason.message : '无法检测 GLM-OCR',
              });
          }),
    );
    const unsubscribe = bridge.onGlmOcrProgress?.((progress) =>
      setGlmOcrStatus((current) => ({
        provider: settings.glmOcrProvider,
        runtimeInstalled: current?.runtimeInstalled ?? false,
        serviceRunning: current?.serviceRunning ?? false,
        modelInstalled: current?.modelInstalled ?? false,
        modelLoaded: current?.modelLoaded ?? false,
        state: current?.state ?? 'idle',
        progress: current?.progress ?? 0,
        message: current?.message ?? '',
        ...progress,
      })),
    );
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [glmConfig, settings.glmOcrMode, settings.glmOcrProvider]);

  useEffect(
    () => () => {
      if (pageIndicatorTimerRef.current !== null)
        window.clearTimeout(pageIndicatorTimerRef.current);
      if (readerScrollTimerRef.current !== null)
        window.clearTimeout(readerScrollTimerRef.current);
    },
    [],
  );

  const handleReaderScroll = useCallback(() => {
    revealPageIndicator();
    if (readerScrollTimerRef.current !== null) return;
    readerScrollTimerRef.current = window.setTimeout(() => {
      readerScrollTimerRef.current = null;
      const container = readerScrollRef.current;
      if (!container) return;
      const pages = container.querySelectorAll<HTMLElement>('.pdf-page');
      if (pages.length === 0) return;
      const focus = container.scrollTop + container.clientHeight / 2;
      let low = 0;
      let high = pages.length - 1;
      let selected = 0;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (pages[middle].offsetTop <= focus) {
          selected = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
      const bestPage = Number(pages[selected].dataset.page) || 1;
      setPage((current) => (current === bestPage ? current : bestPage));
    }, 0);
  }, [revealPageIndicator]);

  useEffect(() => {
    if (!regionSelectMode) return;
    const cancelSelection = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setRegionSelectMode(false);
      setSelectedRegion(null);
    };
    window.addEventListener('keydown', cancelSelection);
    return () => window.removeEventListener('keydown', cancelSelection);
  }, [regionSelectMode]);

  useEffect(() => {
    const el = chatAreaRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleChatScroll = () => {
    const el = chatAreaRef.current;
    if (!el) return;
    autoScrollRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    if (!activeBookId || !page || !window.marginDesktop?.libraryUpdate) return;
    const timeout = window.setTimeout(() => {
      void window.marginDesktop
        ?.libraryUpdate?.(activeBookId, { lastPage: page })
        .then((entry) => {
          setLibrary((current) =>
            current.map((book) => (book.id === entry.id ? entry : book)),
          );
        });
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [activeBookId, page]);

  useEffect(() => {
    const modelContext = (
      document as Document & {
        modelContext?: {
          registerTool: (
            tool: unknown,
            options?: { signal?: AbortSignal },
          ) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!modelContext?.registerTool || !pdf) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      modelContext.registerTool(
        {
          name: 'navigate_to_pdf_page',
          title: '跳转到 PDF 页码',
          description:
            '在当前已打开的 PDF 中跳转到指定页，并同步阅读助手的当前页上下文。',
          inputSchema: {
            type: 'object',
            properties: {
              page: { type: 'integer', minimum: 1, maximum: pageCount },
            },
            required: ['page'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          execute(input: unknown) {
            const target = (input as { page?: unknown })?.page;
            if (
              !Number.isInteger(target) ||
              (target as number) < 1 ||
              (target as number) > pageCount
            )
              throw new Error(`页码必须在 1 到 ${pageCount} 之间。`);
            scrollToPage(target as number);
            return { page: target, pageCount, status: 'navigated' };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [pdf, pageCount, scrollToPage]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    async function updatePageText() {
      const cached = pageTextsRef.current.get(page);
      if (cached !== undefined) {
        setPageText(cached);
        return;
      }
      const pdfPage = await pdf!.getPage(page);
      const text = await pdfPage.getTextContent();
      const normalized = text.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pageTextsRef.current.set(page, normalized);
      if (!cancelled) setPageText(normalized);
    }
    updatePageText().catch(() => {
      if (!cancelled) setPageText('');
    });
    return () => {
      cancelled = true;
    };
  }, [pdf, page]);

  function createConfiguredProvider() {
    return createEmbeddingProvider({
      kind: settings.embeddingKind,
      endpoint: settings.embeddingEndpoint,
      model: settings.embeddingModel,
      apiKey: settings.embeddingApiKey,
    });
  }

  async function loadPdf(
    data: ArrayBuffer | Uint8Array | string,
    name: string,
    book?: LibraryEntry,
  ) {
    setLoadingPdf(true);
    setError('');
    try {
      const pdfJs = await import('pdfjs-dist');
      pdfJs.GlobalWorkerOptions.workerSrc = new URL(
        pdfWorkerUrl,
        window.location.href,
      ).toString();
      const source =
        typeof data === 'string'
          ? { url: data }
          : {
              data:
                data instanceof Uint8Array
                  ? new Uint8Array(data)
                  : new Uint8Array(data),
            };
      const document = await pdfJs.getDocument(source).promise;
      vectorIndexRef.current.clear();
      embeddingProviderRef.current = null;
      pageTextsRef.current.clear();
      deepReadCacheRef.current.clear();
      setRegionSelectMode(false);
      setSelectedRegion(null);
      setRegionActionBusy(null);
      setDeepReadStatus(
        settings.glmOcrMode === 'auto'
          ? 'GLM-OCR 已待命，将按需精读公式、代码与表格页'
          : '',
      );
      setScanWarning('');
      setIndexStatus('idle');
      setIndexProgress(0);
      setIndexMessage('');
      setHasIndexCheckpoint(false);
      const initialPage = Math.min(
        document.numPages,
        Math.max(1, book?.lastPage || 1),
      );
      activeBookIdRef.current = book?.id || null;
      setPdf(document);
      setFileName(name);
      setPageCount(document.numPages);
      setPage(initialPage);
      setActiveBookId(activeBookIdRef.current);
      let restoredMessages: Message[] = [];
      if (book && window.marginDesktop?.workspaceChatLoad) {
        try {
          restoredMessages = await window.marginDesktop.workspaceChatLoad(
            book.id,
            100,
          );
        } catch {
          restoredMessages =
            readChatHistory().find((entry) => entry.bookId === book.id)
              ?.messages ?? [];
        }
      } else if (book)
        restoredMessages =
          readChatHistory().find((entry) => entry.bookId === book.id)
            ?.messages ?? [];
      setMessages(restoredMessages);
      await refreshActiveNotes(book?.id || null);
      if (book && window.marginDesktop?.libraryUpdate) {
        const updated = await window.marginDesktop.libraryUpdate(book.id, {
          pageCount: document.numPages,
          lastPage: initialPage,
        });
        setLibrary((current) =>
          current.map((entry) => (entry.id === updated.id ? updated : entry)),
        );
      }
      if (book && window.marginDesktop?.libraryIndexOpen) {
        try {
          const provider = createConfiguredProvider();
          const stored = await window.marginDesktop.libraryIndexOpen(
            book.id,
            provider.id,
          );
          if (stored) {
            embeddingProviderRef.current = provider;
            const size = `${(stored.bytes / 1024 / 1024).toFixed(1)} MB`;
            setIndexStatus('ready');
            setIndexProgress(100);
            setIndexMessage(
              `${stored.migrated ? '旧 JSON 已迁移 · ' : ''}SQLite Float32 · ${stored.chunks} 个片段 · ${size}`,
            );
          }
        } catch {
          /* A changed or incomplete provider simply requires rebuilding the index. */
        }
      }
      if (book) {
        const task = indexTasksRef.current.find(
          (candidate) => candidate.bookId === book.id,
        );
        if (
          task &&
          ['queued', 'running', 'pausing', 'paused', 'failed'].includes(
            task.status,
          )
        ) {
          setIndexProgress(task.progress);
          setIndexMessage(task.message);
          setHasIndexCheckpoint(task.status === 'paused');
          setIndexStatus(
            task.status === 'running' ||
              task.status === 'pausing' ||
              task.status === 'queued'
              ? 'indexing'
              : task.status === 'failed'
                ? 'error'
                : 'idle',
          );
        }
      }
      window.setTimeout(() => scrollToPage(initialPage, 'auto'), 0);
    } catch (reason) {
      console.error('Failed to open PDF', reason);
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`无法打开这个 PDF：${detail.slice(0, 160)}`);
    } finally {
      setLoadingPdf(false);
    }
  }

  async function openPdf(file?: File) {
    if (!file) return;
    try {
      if (window.marginDesktop?.libraryImportFile) {
        const entry = await window.marginDesktop.libraryImportFile(file);
        setLibrary((current) => [entry, ...current]);
        await loadPdf(
          `margin://app/library/${entry.id}/document.pdf`,
          entry.name,
          entry,
        );
        setLibraryOpen(false);
      } else {
        await loadPdf(await file.arrayBuffer(), file.name);
      }
    } catch (reason) {
      setError(
        `导入书架失败：${reason instanceof Error ? reason.message.slice(0, 160) : '未知错误'}`,
      );
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function openLibraryBook(book: LibraryEntry) {
    if (!window.marginDesktop || loadingPdf) return;
    try {
      await loadPdf(
        `margin://app/library/${book.id}/document.pdf`,
        book.name,
        book,
      );
      setLibraryOpen(false);
    } catch (reason) {
      setError(
        `无法从书架打开：${reason instanceof Error ? reason.message.slice(0, 160) : '未知错误'}`,
      );
    }
  }

  async function openHistoryRecord(message: WorkspaceHistoryItem) {
    if (message.bookId.startsWith('pack_')) {
      const pack = knowledgePacks.find(
        (candidate) => `pack_${candidate.id}` === message.bookId,
      );
      if (pack) await activateKnowledgePack(pack);
      else setError('这个提问所属的知识包已被删除。');
      setHistoryOpen(false);
      return;
    }
    const book = library.find((entry) => entry.id === message.bookId);
    if (book && book.id !== activeBookId) {
      await openLibraryBook(book);
      setHistoryOpen(false);
      window.setTimeout(() => scrollToPage(message.page), 0);
      return;
    }
    if (message.bookId === activeBookId) {
      const restored = await window.marginDesktop?.workspaceChatLoad?.(
        message.bookId,
        100,
      );
      if (restored) setMessages(restored);
      setHistoryOpen(false);
      scrollToPage(message.page);
    }
  }

  async function openWorkspaceNote(note: WorkspaceNote) {
    const book = library.find((entry) => entry.id === note.bookId);
    if (book && book.id !== activeBookId) await openLibraryBook(book);
    setWorkspaceOpen(false);
    window.setTimeout(
      () => {
        if (note.region)
          setSelectedRegion({ page: note.page, region: note.region });
        scrollToPage(note.page);
      },
      book && book.id !== activeBookId ? 80 : 0,
    );
  }

  async function createKnowledgePackFromInput() {
    const name = newKnowledgePackName.trim();
    if (!name || !window.marginDesktop?.knowledgeCreate) return;
    try {
      const created = await window.marginDesktop.knowledgeCreate({ name });
      setKnowledgePacks((current) => [created, ...current]);
      selectedKnowledgePackIdRef.current = created.id;
      setSelectedKnowledgePackId(created.id);
      setKnowledgePackName(created.name);
      setKnowledgePackDescription(created.description);
      setNewKnowledgePackName('');
      setKnowledgeNotice(`知识包“${created.name}”已创建`);
    } catch (reason) {
      setError(
        `创建知识包失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  function selectKnowledgePack(pack: KnowledgePack) {
    selectedKnowledgePackIdRef.current = pack.id;
    setSelectedKnowledgePackId(pack.id);
    setKnowledgePackName(pack.name);
    setKnowledgePackDescription(pack.description);
  }

  async function saveKnowledgePackDetails() {
    if (!selectedKnowledgePackId || !window.marginDesktop?.knowledgeUpdate)
      return;
    try {
      const updated = await window.marginDesktop.knowledgeUpdate(
        selectedKnowledgePackId,
        {
          name: knowledgePackName,
          description: knowledgePackDescription,
        },
      );
      setKnowledgePacks((current) =>
        current.map((pack) => (pack.id === updated.id ? updated : pack)),
      );
      setKnowledgeNotice(`知识包“${updated.name}”已保存`);
    } catch (reason) {
      setError(
        `保存知识包失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  async function toggleKnowledgePackBook(pack: KnowledgePack, bookId: string) {
    if (!window.marginDesktop?.knowledgeUpdate) return;
    const bookIds = pack.bookIds.includes(bookId)
      ? pack.bookIds.filter((id) => id !== bookId)
      : [...pack.bookIds, bookId];
    try {
      const updated = await window.marginDesktop.knowledgeUpdate(pack.id, {
        bookIds,
      });
      setKnowledgePacks((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setKnowledgeExcludedBookIds((current) =>
        current.filter((id) => updated.bookIds.includes(id)),
      );
    } catch (reason) {
      setError(
        `更新知识包成员失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  async function exportSelectedKnowledgePack(pack: KnowledgePack) {
    if (!window.marginDesktop?.knowledgeExport) return;
    try {
      const result = await window.marginDesktop.knowledgeExport(pack.id);
      if (result.exported)
        setKnowledgeNotice(`知识包清单已导出：${result.path}`);
    } catch (reason) {
      setError(
        `导出知识包失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  async function importKnowledgePackFile() {
    if (!window.marginDesktop?.knowledgeImport) return;
    try {
      const result = await window.marginDesktop.knowledgeImport();
      if (!result.imported || !result.pack) return;
      await refreshKnowledgePacks();
      selectKnowledgePack(result.pack);
      const missing = result.unmatchedBooks?.length || 0;
      setKnowledgeNotice(
        `已导入“${result.pack.name}”并关联 ${result.matchedBooks || 0} 本书${missing ? `；${missing} 本未在当前书架找到` : ''}`,
      );
    } catch (reason) {
      setError(
        `导入知识包失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  async function removeKnowledgePack(pack: KnowledgePack) {
    if (
      !window.marginDesktop?.knowledgeRemove ||
      !window.confirm(
        `删除知识包“${pack.name}”？只会删除组合关系，不会删除其中的 PDF、索引或阅读资料。`,
      )
    )
      return;
    try {
      await window.marginDesktop.knowledgeRemove(pack.id);
      const remaining = knowledgePacks.filter((item) => item.id !== pack.id);
      setKnowledgePacks(remaining);
      selectedKnowledgePackIdRef.current = remaining[0]?.id || null;
      setSelectedKnowledgePackId(remaining[0]?.id || null);
      setKnowledgePackName(remaining[0]?.name || '');
      setKnowledgePackDescription(remaining[0]?.description || '');
      if (activeKnowledgePackId === pack.id) {
        setActiveKnowledgePackId(null);
        setKnowledgeSearchStatus('');
      }
    } catch (reason) {
      setError(
        `删除知识包失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  async function activateKnowledgePack(pack: KnowledgePack | null) {
    setActiveKnowledgePackId(pack?.id || null);
    setKnowledgeSearchStatus('');
    setKnowledgeExcludedBookIds([]);
    setKnowledgePageFrom('');
    setKnowledgePageTo('');
    if (pack) {
      const restored = await window.marginDesktop?.workspaceChatLoad?.(
        `pack_${pack.id}`,
        100,
      );
      setMessages(restored || []);
      setKnowledgeOpen(false);
      return;
    }
    if (activeBookId) {
      const restored = await window.marginDesktop?.workspaceChatLoad?.(
        activeBookId,
        100,
      );
      setMessages(restored || []);
    } else setMessages([]);
  }

  async function openKnowledgeSource(source: KnowledgeSource) {
    const book = library.find((entry) => entry.id === source.bookId);
    if (!book) {
      setError('来源书籍已不在本地书架中。');
      return;
    }
    const packMessages = activeKnowledgePackId ? messages : null;
    if (book.id !== activeBookId) await openLibraryBook(book);
    if (packMessages) setMessages(packMessages);
    window.setTimeout(
      () => scrollToPage(source.page),
      book.id !== activeBookId ? 80 : 0,
    );
  }

  async function saveRegionAnnotation(kind: 'highlight' | 'note' | 'glossary') {
    const selection = selectedRegion;
    const book = library.find((entry) => entry.id === activeBookIdRef.current);
    if (!selection || !book || !window.marginDesktop?.workspaceNoteSave) {
      setError('请先打开书架中的 PDF 并框选页面区域。');
      return;
    }
    let title = `第 ${selection.page} 页高亮`;
    let content = '';
    if (kind === 'note') {
      const value = window.prompt('输入这处批注：');
      if (value === null) return;
      content = value.trim();
      if (!content) return;
      title = content.slice(0, 36);
    } else if (kind === 'glossary') {
      const term = window.prompt('输入概念名称：');
      if (term === null || !term.trim()) return;
      const definition =
        window.prompt('输入释义（可留空，稍后补充）：', '') ?? '';
      title = term.trim();
      content = definition.trim();
    }
    try {
      const saved = await window.marginDesktop.workspaceNoteSave(
        book.id,
        book.name,
        {
          kind,
          page: selection.page,
          title,
          content,
          excerpt: `第 ${selection.page} 页框选区域`,
          color:
            kind === 'highlight'
              ? '#f4cf65'
              : kind === 'glossary'
                ? '#79d8cc'
                : '#f2a56f',
          region: selection.region,
        },
      );
      setActiveNotes((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setWorkspaceNotes((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setWorkspaceNotice(`${NOTE_KIND_LABELS[kind]}已保存到阅读资料`);
      setSelectedRegion(null);
    } catch (reason) {
      setError(
        `保存阅读资料失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  async function saveSummaryCard(message: Message) {
    const book = library.find((entry) => entry.id === activeBookIdRef.current);
    if (!book || !message.content || !window.marginDesktop?.workspaceNoteSave)
      return;
    try {
      const firstLine =
        message.content
          .replace(/[#*_`]/g, '')
          .split('\n')
          .find(Boolean)
          ?.trim() || 'AI 摘要';
      const saved = await window.marginDesktop.workspaceNoteSave(
        book.id,
        book.name,
        {
          kind: 'summary',
          page: message.page,
          title: firstLine.slice(0, 48),
          content: message.content,
          excerpt: '',
          color: '#8cc8ef',
          region: message.citation?.region,
        },
      );
      setActiveNotes((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setWorkspaceNotes((current) => [
        saved,
        ...current.filter((item) => item.id !== saved.id),
      ]);
      setWorkspaceNotice('AI 回答已保存为摘要卡片');
    } catch (reason) {
      setError(
        `保存摘要卡片失败：${reason instanceof Error ? reason.message : String(reason)}`,
      );
    }
  }

  async function removeWorkspaceNote(note: WorkspaceNote) {
    if (
      !window.marginDesktop?.workspaceNoteRemove ||
      !window.confirm(`删除“${note.title || NOTE_KIND_LABELS[note.kind]}”？`)
    )
      return;
    await window.marginDesktop.workspaceNoteRemove(note.id);
    setWorkspaceNotes((current) =>
      current.filter((item) => item.id !== note.id),
    );
    setActiveNotes((current) => current.filter((item) => item.id !== note.id));
    setWorkspaceNotesTotal((current) => Math.max(0, current - 1));
  }

  async function loadMoreWorkspaceNotes() {
    if (
      !window.marginDesktop?.workspaceNotesList ||
      workspaceNotes.length >= workspaceNotesTotal
    )
      return;
    const result = await window.marginDesktop.workspaceNotesList({
      kind: workspaceKind === 'all' ? undefined : workspaceKind,
      query: workspaceQuery,
      limit: 50,
      offset: workspaceNotes.length,
    });
    setWorkspaceNotes((current) => [...current, ...result.items]);
    setWorkspaceNotesTotal(result.total);
  }

  async function loadMoreHistory() {
    if (
      !window.marginDesktop?.workspaceHistorySearch ||
      historyItems.length >= historyTotal
    )
      return;
    const result = await window.marginDesktop.workspaceHistorySearch(
      historyQuery,
      50,
      historyItems.length,
    );
    setHistoryItems((current) => [...current, ...result.items]);
    setHistoryTotal(result.total);
  }

  async function exportWorkspace(bookOnly = false) {
    const result = await window.marginDesktop?.workspaceExportMarkdown?.({
      bookId: bookOnly ? activeBookId || undefined : undefined,
    });
    if (result?.exported) setWorkspaceNotice(`已导出 Markdown：${result.path}`);
  }

  async function removeLibraryBook(book: LibraryEntry) {
    if (
      indexTasksRef.current.some(
        (task) =>
          task.bookId === book.id &&
          ['queued', 'running', 'pausing'].includes(task.status),
      )
    ) {
      setError('这本书正在索引队列中，请先在“任务”里取消后再移除。');
      setLibraryOpen(false);
      setTaskCenterOpen(true);
      return;
    }
    if (
      !window.marginDesktop?.libraryRemove ||
      !window.confirm(
        `从本地书架移除《${book.name}》？PDF 副本与已保存索引会从 Margin 数据目录删除。`,
      )
    )
      return;
    try {
      await window.marginDesktop.libraryRemove(book.id);
      setLibrary((current) => current.filter((entry) => entry.id !== book.id));
      void refreshKnowledgePacks();
      mutateIndexTasks((current) =>
        current.filter((task) => task.bookId !== book.id),
      );
      window.marginDesktop?.logEvent?.('library-remove-ui', {
        bookId: book.id,
        activeBookId,
        activeBookIdRef: activeBookIdRef.current,
        fileName,
        bookName: book.name,
      });
      if (
        activeBookIdRef.current === book.id ||
        activeBookId === book.id ||
        fileName === book.name
      ) {
        vectorIndexRef.current.clear();
        embeddingProviderRef.current = null;
        pageTextsRef.current.clear();
        deepReadCacheRef.current.clear();
        activeBookIdRef.current = null;
        setPdf(null);
        setFileName('');
        setPage(1);
        setPageCount(0);
        setPageText('');
        setActiveBookId(null);
        setMessages([]);
        setActiveNotes([]);
        setIndexStatus('idle');
        setIndexProgress(0);
        setIndexMessage('');
        setScanWarning('');
        setDeepReadStatus('');
        setRegionSelectMode(false);
        setSelectedRegion(null);
        setRegionActionBusy(null);
        void pdf?.destroy().catch(() => undefined);
      }
    } catch (reason) {
      setError(
        `移除失败：${reason instanceof Error ? reason.message.slice(0, 160) : '未知错误'}`,
      );
    }
  }

  function saveSettings() {
    const previous = readSavedSettings();
    // Only the vector/embedding configuration changes which vectors are produced,
    // so only those changes invalidate an already-built index. Chat-only or even
    // a no-op save should never discard the current index.
    const vectorConfigChanged =
      previous.embeddingKind !== settings.embeddingKind ||
      previous.embeddingEndpoint !== settings.embeddingEndpoint ||
      previous.embeddingModel !== settings.embeddingModel;
    const deepReadConfigChanged =
      previous.glmOcrMode !== settings.glmOcrMode ||
      previous.glmOcrProvider !== settings.glmOcrProvider ||
      previous.glmOcrEndpoint !== settings.glmOcrEndpoint ||
      previous.glmOcrModel !== settings.glmOcrModel;
    localStorage.setItem('margin-ai-settings', JSON.stringify(settings));
    localStorage.setItem('margin-settings-schema', '3');
    if (vectorConfigChanged) {
      vectorIndexRef.current.clear();
      embeddingProviderRef.current = null;
      setIndexStatus('idle');
      setIndexProgress(0);
      setIndexMessage('向量模型配置已变化，请重新建立索引');
    }
    if (deepReadConfigChanged) deepReadCacheRef.current.clear();
    setDeepReadStatus(
      settings.glmOcrMode === 'auto'
        ? 'GLM-OCR 已待命，将按需精读公式、代码与表格页'
        : '',
    );
  }

  async function fetchChatModelList() {
    const endpoint = settings.endpoint.trim().replace(/\/+$/, '');
    const apiKey = settings.apiKey.trim();
    if (!endpoint || !apiKey) {
      setChatModelList([]);
      setChatModelListError('请先填写端点地址与 API Key。');
      return;
    }
    setChatModelListLoading(true);
    setChatModelListError('');
    setChatModelList([]);
    try {
      const response = await fetch(`${endpoint}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok)
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      const payload = (await response.json()) as {
        data?: Array<{ id: string }>;
        models?: Array<{ id: string }>;
      };
      const ids = Array.isArray(payload.data)
        ? payload.data.map((item) => item.id)
        : Array.isArray(payload.models)
          ? payload.models.map((item) => item.id)
          : [];
      if (ids.length === 0) throw new Error('端点未返回可用模型');
      setChatModelList(ids);
    } catch (reason) {
      setChatModelListError(
        `获取模型列表失败：${reason instanceof Error ? reason.message.slice(0, 140) : '请检查端点与密钥'}`,
      );
    } finally {
      setChatModelListLoading(false);
    }
  }

  async function installLocalModel() {
    if (!window.marginDesktop?.modelInstall) return;
    setError('');
    try {
      await window.marginDesktop.modelInstall();
      setModelStatus((await window.marginDesktop.modelStatus?.()) ?? null);
    } catch (reason) {
      setError(
        `模型安装失败：${reason instanceof Error ? reason.message.slice(0, 180) : '未知错误'}`,
      );
    }
  }

  async function removeLocalModel() {
    if (
      !window.marginDesktop?.modelRemove ||
      !window.confirm(
        '确认卸载本地向量模型？已保存的索引仍会保留，但无法检索，直到重新安装模型。',
      )
    )
      return;
    setModelStatus(await window.marginDesktop.modelRemove());
    vectorIndexRef.current.clear();
    embeddingProviderRef.current = null;
    setIndexStatus('idle');
    setIndexMessage('本地模型已卸载');
  }

  async function releaseModelMemory() {
    if (!window.marginDesktop?.modelUnload) return;
    setModelStatus(await window.marginDesktop.modelUnload());
  }

  async function prepareGlmModel() {
    if (!window.marginDesktop?.glmOcrPrepare) return;
    setError('');
    try {
      setGlmOcrStatus(await window.marginDesktop.glmOcrPrepare(glmConfig()));
    } catch (reason) {
      const detail =
        reason instanceof Error ? reason.message : '无法准备 GLM-OCR';
      setError(`GLM-OCR 准备失败：${detail.slice(0, 180)}`);
      if (glmOcrStatus)
        setGlmOcrStatus({ ...glmOcrStatus, state: 'error', message: detail });
    }
  }

  async function releaseGlmModel() {
    if (!window.marginDesktop?.glmOcrUnload) return;
    try {
      setGlmOcrStatus(await window.marginDesktop.glmOcrUnload(glmConfig()));
    } catch (reason) {
      setError(
        `释放 GLM-OCR 失败：${reason instanceof Error ? reason.message.slice(0, 160) : '未知错误'}`,
      );
    }
  }

  async function removeGlmModel() {
    if (
      !window.marginDesktop?.glmOcrRemove ||
      !window.confirm('确认卸载本地 GLM-OCR？向量索引和阅读记录不会被删除。')
    )
      return;
    setGlmOcrStatus(await window.marginDesktop.glmOcrRemove(glmConfig()));
    deepReadCacheRef.current.clear();
  }

  async function runIndexTask(task: IndexTask) {
    const targetBookId = task.bookId;
    const targetName = task.bookName;
    let targetPdf: PDFDocumentProxy | null = null;
    let ownsDocument = false;
    let persistentBuildStarted = false;
    let runtimeBackend = modelStatus?.backend || appInfo?.runtimeBackend;
    let taskProgress = task.progress;
    let currentStage: Exclude<IndexTaskStage, 'queued' | 'complete'> =
      'preparing';
    let stageStartedAt = Date.now();
    const timings = { ...task.timings };
    const startedAt = Date.now();
    let extractionElapsedMs = 0;
    let ocrElapsedMs = 0;
    let embeddingElapsedMs = 0;
    let persistenceElapsedMs = 0;
    const failedPages: number[] = [];
    let skippedPages = 0;
    let ocrPages = 0;
    const allChunks: RagChunk[] = [];
    let completedChunks = 0;

    const isActiveBook = () => activeBookIdRef.current === targetBookId;
    const report = (changes: Partial<IndexTask>) => {
      if (typeof changes.progress === 'number') {
        taskProgress = Math.max(
          taskProgress,
          Math.min(100, Math.round(changes.progress)),
        );
        changes.progress = taskProgress;
      }
      patchIndexTask(task.id, changes);
      if (isActiveBook()) {
        if (typeof changes.progress === 'number')
          setIndexProgress(changes.progress);
        if (changes.message !== undefined) setIndexMessage(changes.message);
        if (changes.status === 'running' || changes.status === 'pausing')
          setIndexStatus('indexing');
        else if (changes.status === 'completed') setIndexStatus('ready');
        else if (changes.status === 'failed') setIndexStatus('error');
        else if (changes.status === 'paused' || changes.status === 'cancelled')
          setIndexStatus('idle');
      }
    };
    const enterStage = (
      stage: typeof currentStage,
      message: string,
      progress: number,
    ) => {
      const now = Date.now();
      timings[currentStage] =
        (timings[currentStage] || 0) + now - stageStartedAt;
      currentStage = stage;
      stageStartedAt = now;
      report({ stage, message, progress, timings: { ...timings } });
    };
    const assertContinue = () => {
      const action = indexTaskControlRef.current.get(task.id);
      if (action)
        throw new DOMException(
          action === 'cancel' ? '索引已取消' : '索引已暂停',
          'AbortError',
        );
    };

    const preliminaryLanes = getIndexConcurrency(appInfo, runtimeBackend);
    report({
      status: 'running',
      stage: 'preparing',
      message: '正在后台打开 PDF 并检查模型',
      progress: Math.max(1, taskProgress),
      lanes: preliminaryLanes,
      backend: runtimeBackend,
    });
    window.marginDesktop?.logEvent?.('index-task-started', {
      bookId: targetBookId,
      fileName: targetName,
      embeddingKind: settings.embeddingKind,
      background: !isActiveBook(),
    });

    try {
      if (isActiveBook() && pdf) targetPdf = pdf;
      else {
        const pdfJs = await import('pdfjs-dist');
        pdfJs.GlobalWorkerOptions.workerSrc = new URL(
          pdfWorkerUrl,
          window.location.href,
        ).toString();
        targetPdf = await pdfJs.getDocument({
          url: `margin://app/library/${targetBookId}/document.pdf`,
        }).promise;
        ownsDocument = true;
      }
      assertContinue();
      const pageCountForTask = targetPdf.numPages;
      report({ pageCount: pageCountForTask });
      const book = library.find((entry) => entry.id === targetBookId);
      if (book && book.pageCount !== pageCountForTask) {
        const updated = await window.marginDesktop?.libraryUpdate?.(
          targetBookId,
          { pageCount: pageCountForTask },
        );
        if (updated)
          setLibrary((current) =>
            current.map((entry) => (entry.id === updated.id ? updated : entry)),
          );
      }

      if (
        settings.embeddingKind === 'local-qwen3-embedding-4b' &&
        window.marginDesktop?.modelPrepare
      ) {
        const unsubscribe = window.marginDesktop.onModelProgress?.(
          (progress) => {
            const message =
              progress.state === 'downloading'
                ? `正在下载本地向量模型：${progress.progress}%`
                : progress.state === 'installing'
                  ? '正在安装 llama.cpp 运行时'
                  : '正在校验本地模型文件';
            report({ message });
          },
        );
        try {
          const prepared = await window.marginDesktop.modelPrepare();
          runtimeBackend = prepared.backend;
          setModelStatus(prepared);
        } finally {
          unsubscribe?.();
        }
      }
      assertContinue();
      const concurrency = getIndexConcurrency(appInfo, runtimeBackend);
      report({ backend: runtimeBackend, lanes: concurrency });

      enterStage('extracting', '正在并发提取 PDF 文本', 2);
      const provider = createConfiguredProvider();
      if (isActiveBook()) {
        embeddingProviderRef.current = provider;
        vectorIndexRef.current.clear();
      }
      const buildKey = `ocr:${settings.ocrMode}:${settings.ocrLanguage}|classifier:2|chunks:1200:180`;
      let cachedPages = new Map<
        number,
        { pageNumber: number; text: string; source: 'pdf' | 'ocr' }
      >();
      let completedChunkIds = new Set<string>();
      let resumedChunks = 0;
      if (
        window.marginDesktop?.libraryIndexStart &&
        window.marginDesktop.libraryIndexAppend &&
        window.marginDesktop.libraryIndexFinish
      ) {
        const checkpoint = await window.marginDesktop.libraryIndexStart(
          targetBookId,
          provider.id,
          0,
          buildKey,
        );
        persistentBuildStarted = true;
        cachedPages = new Map(
          checkpoint.pages.map((entry) => [
            entry.page,
            { pageNumber: entry.page, text: entry.text, source: entry.source },
          ]),
        );
        completedChunkIds = new Set(checkpoint.completedChunkIds);
        resumedChunks = checkpoint.chunks;
        if (
          checkpoint.resumed &&
          (checkpoint.pages.length > 0 || checkpoint.chunks > 0)
        )
          report({
            message: `已恢复检查点：${checkpoint.pages.length} 页文本 · ${checkpoint.chunks} 个向量`,
          });
        if (isActiveBook())
          setHasIndexCheckpoint(
            checkpoint.resumed &&
              (checkpoint.pages.length > 0 || checkpoint.chunks > 0),
          );
      }

      const extractionStartedAt = Date.now();
      let extractedPages = cachedPages.size;
      const extracted = await mapWithConcurrency(
        targetPdf.numPages,
        concurrency.text,
        async (pageNumber) => {
          assertContinue();
          const cached = cachedPages.get(pageNumber);
          if (cached) return cached;
          const pdfPage = await targetPdf!.getPage(pageNumber);
          const content = await pdfPage.getTextContent();
          const text = content.items
            .map((item) => ('str' in item ? item.str : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          extractedPages += 1;
          const message = `${concurrency.text} 路文本提取：${extractedPages} / ${targetPdf!.numPages} 页`;
          report({
            completedPages: extractedPages,
            progress: 2 + (extractedPages / targetPdf!.numPages) * 13,
            message,
          });
          if (text)
            await window.marginDesktop?.libraryIndexSavePages?.(targetBookId, [
              { page: pageNumber, text, source: 'pdf' },
            ]);
          return { pageNumber, text, source: 'pdf' as const };
        },
      );
      extractionElapsedMs = Date.now() - extractionStartedAt;

      const ocrCandidates = extracted.filter((entry) =>
        shouldInspectWithOcr(entry.text),
      );
      if (
        ocrCandidates.length > 0 &&
        settings.ocrMode === 'auto' &&
        window.marginDesktop?.ocrRecognize
      ) {
        enterStage('ocr', `正在分析 ${ocrCandidates.length} 个疑似扫描页`, 15);
        const ocrStartedAt = Date.now();
        let ocrCompleted = 0;
        const updateOcrMessage = (detail = '') => {
          const elapsedSeconds = Math.max(
            (Date.now() - ocrStartedAt) / 1000,
            0.001,
          );
          const pagesPerMinute = (ocrCompleted / elapsedSeconds) * 60;
          const remaining =
            ocrCompleted > 0
              ? formatRemaining(
                  ((ocrCandidates.length - ocrCompleted) /
                    Math.max(pagesPerMinute, 0.01)) *
                    60,
                )
              : '';
          report({
            progress: 15 + (ocrCompleted / ocrCandidates.length) * 30,
            message: `${concurrency.ocr} 路 OCR：${ocrCompleted} / ${ocrCandidates.length} 页${pagesPerMinute > 0 ? ` · ${pagesPerMinute.toFixed(1)} 页/分钟` : ''}${remaining ? ` · ${remaining}` : ''}${detail}`,
            ocrPages,
            skippedPages,
            failedPages: [...failedPages],
          });
        };
        updateOcrMessage(' · 正在判断页面密度');
        const unsubscribe = window.marginDesktop.onOcrProgress?.(() =>
          updateOcrMessage(' · 页面并行识别中'),
        );
        try {
          await mapWithConcurrency(
            ocrCandidates.length,
            concurrency.ocr,
            async (candidateNumber) => {
              assertContinue();
              const candidate = ocrCandidates[candidateNumber - 1];
              const pageNumber = candidate.pageNumber;
              let lastFailure: unknown;
              try {
                const pdfPage = await targetPdf!.getPage(pageNumber);
                const image = await renderPageImage(pdfPage, 'png', true);
                if (image.bytes.length === 0) {
                  skippedPages += 1;
                  window.marginDesktop?.logEvent?.('ocr-page-skipped-blank', {
                    bookId: targetBookId,
                    page: pageNumber,
                    inkRatio: image.inkRatio,
                  });
                } else {
                  for (let attempt = 1; attempt <= 2; attempt += 1) {
                    assertContinue();
                    try {
                      const result = await window.marginDesktop!.ocrRecognize!(
                        image.bytes,
                        settings.ocrLanguage,
                        pageNumber,
                      );
                      if (!result.text && !candidate.text)
                        throw new Error('OCR 未识别出文本');
                      if (
                        result.text &&
                        (result.text.length > candidate.text.length ||
                          !candidate.text)
                      ) {
                        candidate.text = result.text;
                        candidate.source = 'ocr';
                        ocrPages += 1;
                        if (isActiveBook()) {
                          pageTextsRef.current.set(pageNumber, result.text);
                          if (pageNumber === page) setPageText(result.text);
                        }
                        await window.marginDesktop?.libraryIndexSavePages?.(
                          targetBookId,
                          [
                            {
                              page: pageNumber,
                              text: result.text,
                              source: 'ocr',
                            },
                          ],
                        );
                      }
                      lastFailure = undefined;
                      break;
                    } catch (reason) {
                      lastFailure = reason;
                      window.marginDesktop?.logEvent?.(
                        attempt === 1 ? 'ocr-page-retrying' : 'ocr-page-failed',
                        {
                          bookId: targetBookId,
                          page: pageNumber,
                          attempt,
                          message:
                            reason instanceof Error
                              ? reason.message
                              : String(reason),
                        },
                        attempt === 1 ? 'info' : 'error',
                      );
                    }
                  }
                }
              } catch (reason) {
                lastFailure = reason;
              }
              if (lastFailure && !candidate.text) failedPages.push(pageNumber);
              ocrCompleted += 1;
              updateOcrMessage();
              return candidate;
            },
          );
        } finally {
          unsubscribe?.();
        }
        ocrElapsedMs = Date.now() - ocrStartedAt;
      }

      enterStage('chunking', '正在整理文本片段', 45);
      let emptyPages = 0;
      for (const extractedPage of extracted) {
        assertContinue();
        if (!extractedPage.text) emptyPages += 1;
        allChunks.push(
          ...chunkPage(extractedPage.text, extractedPage.pageNumber),
        );
      }
      if (allChunks.length === 0)
        throw new Error(
          settings.ocrMode === 'off'
            ? '这个 PDF 没有可提取文本；请在模型设置中启用 OCR。'
            : 'OCR 完成，但没有识别出可索引文本。请尝试切换 OCR 语言或使用更清晰的扫描件。',
        );
      report({
        chunks: allChunks.length,
        message: `已整理 ${allChunks.length} 个文本片段`,
      });
      window.marginDesktop?.logEvent?.('index-text-extracted', {
        bookId: targetBookId,
        chunks: allChunks.length,
        emptyPages,
        ocrPages,
        ocrFailures: failedPages.length,
        skippedBlankPages: skippedPages,
        elapsedMs: extractionElapsedMs,
        ocrElapsedMs,
        textConcurrency: concurrency.text,
        ocrConcurrency: concurrency.ocr,
      });

      enterStage('embedding', '正在生成向量', 46);
      const batchSize =
        settings.embeddingKind === 'local-qwen3-embedding-4b'
          ? concurrency.embedding
          : 16;
      const embeddingStartedAt = Date.now();
      const pendingEntries: Array<RagChunk & { vector: Float32Array }> = [];
      const chunksToEmbed = allChunks.filter(
        (chunk) => !completedChunkIds.has(chunk.id),
      );
      const alreadyCompleted = allChunks.length - chunksToEmbed.length;
      completedChunks = alreadyCompleted;
      if (alreadyCompleted > 0)
        report({
          progress: 46 + (alreadyCompleted / allChunks.length) * 52,
          completedChunks,
          message: `从检查点继续：已完成 ${alreadyCompleted} / ${allChunks.length} 个向量`,
        });
      for (let start = 0; start < chunksToEmbed.length; start += batchSize) {
        assertContinue();
        const chunks = chunksToEmbed.slice(start, start + batchSize);
        let vectors: number[][] | undefined;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            vectors = await provider.embed(
              chunks.map((chunk) => chunk.text),
              'document',
            );
            break;
          } catch (reason) {
            if (attempt === 2) throw reason;
            report({ message: '向量服务切换后正在自动恢复当前批次…' });
          }
        }
        if (!vectors || vectors.length !== chunks.length || !vectors[0]?.length)
          throw new Error('向量模型返回了无效批次');
        if (
          persistentBuildStarted &&
          window.marginDesktop?.libraryIndexAppend
        ) {
          pendingEntries.push(
            ...chunks.map((chunk, index) => ({
              ...chunk,
              vector: Float32Array.from(vectors![index]),
            })),
          );
          if (
            pendingEntries.length >= 64 ||
            start + batchSize >= chunksToEmbed.length
          )
            await window.marginDesktop.libraryIndexAppend(
              targetBookId,
              pendingEntries.splice(0, pendingEntries.length),
            );
        } else if (isActiveBook())
          vectorIndexRef.current.addVectors(chunks, vectors);
        const completedNow = Math.min(start + batchSize, chunksToEmbed.length);
        completedChunks = alreadyCompleted + completedNow;
        const elapsedSeconds = Math.max(
          (Date.now() - embeddingStartedAt) / 1000,
          0.001,
        );
        const chunksPerSecond = completedNow / elapsedSeconds;
        const remaining = formatRemaining(
          (chunksToEmbed.length - completedNow) /
            Math.max(chunksPerSecond, 0.01),
        );
        report({
          progress: 46 + (completedChunks / allChunks.length) * 52,
          completedChunks,
          message: `${runtimeBackend === 'vulkan' ? 'Vulkan' : 'CPU'} ${batchSize} 路向量：${completedChunks} / ${allChunks.length} · ${chunksPerSecond.toFixed(1)} 片段/秒${remaining ? ` · ${remaining}` : ''}`,
        });
      }
      embeddingElapsedMs = Date.now() - embeddingStartedAt;

      enterStage('writing', '正在完成 SQLite 索引', 99);
      let persistedInfo;
      if (persistentBuildStarted && window.marginDesktop?.libraryIndexFinish) {
        const persistenceStartedAt = Date.now();
        persistedInfo =
          await window.marginDesktop.libraryIndexFinish(targetBookId);
        persistenceElapsedMs = Date.now() - persistenceStartedAt;
        persistentBuildStarted = false;
        await refreshLibrary();
      }
      timings[currentStage] =
        (timings[currentStage] || 0) + Date.now() - stageStartedAt;
      const storageLabel = persistedInfo
        ? ` · SQLite ${(persistedInfo.bytes / 1024 / 1024).toFixed(1)} MB`
        : '';
      const completionMessage = `索引完成：${allChunks.length} 个片段${storageLabel}${ocrPages ? ` · OCR ${ocrPages} 页` : ''}${skippedPages ? ` · 跳过空白 ${skippedPages} 页` : ''}`;
      report({
        status: 'completed',
        stage: 'complete',
        progress: 100,
        message: completionMessage,
        chunks: allChunks.length,
        completedChunks: allChunks.length,
        ocrPages,
        skippedPages,
        failedPages,
        timings: { ...timings },
      });
      if (isActiveBook()) {
        setHasIndexCheckpoint(false);
        setScanWarning(
          emptyPages > 0
            ? `${ocrPages > 0 ? `OCR 已识别 ${ocrPages} 页；` : ''}仍有 ${emptyPages} 页没有可提取文本。${failedPages.length ? ` ${failedPages.length} 页重试后仍失败。` : ''}`
            : ocrPages > 0
              ? `OCR 已识别并索引 ${ocrPages} 个扫描页。`
              : '',
        );
      }
      window.marginDesktop?.logEvent?.('index-task-succeeded', {
        bookId: targetBookId,
        providerId: provider.id,
        chunks: allChunks.length,
        resumedChunks,
        batchSize,
        runtimeBackend,
        extractionElapsedMs,
        ocrElapsedMs,
        embeddingElapsedMs,
        persistenceElapsedMs,
        totalElapsedMs: Date.now() - startedAt,
        skippedBlankPages: skippedPages,
        failedPages,
      });
      if (settings.embeddingKind === 'local-qwen3-embedding-4b')
        setModelStatus(
          (await window.marginDesktop?.modelStatus?.()) ?? modelStatus,
        );
    } catch (reason) {
      const control = indexTaskControlRef.current.get(task.id);
      if (persistentBuildStarted) {
        if (control === 'cancel')
          await window.marginDesktop
            ?.libraryIndexDiscard?.(targetBookId)
            .catch(() => undefined);
        else
          await window.marginDesktop
            ?.libraryIndexCancel?.(targetBookId)
            .catch(() => undefined);
      }
      timings[currentStage] =
        (timings[currentStage] || 0) + Date.now() - stageStartedAt;
      const message =
        reason instanceof Error ? reason.message.slice(0, 180) : '未知错误';
      window.marginDesktop?.logEvent?.(
        'index-task-failed',
        { bookId: targetBookId, stage: currentStage, control, message },
        control ? 'info' : 'error',
      );
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        const cancelled = control === 'cancel';
        report({
          status: cancelled ? 'cancelled' : 'paused',
          message: cancelled
            ? '索引已取消，未完成检查点已清除'
            : `索引已暂停在 ${taskProgress}%，可从 SQLite 检查点继续`,
          timings: { ...timings },
          failedPages,
          skippedPages,
          ocrPages,
        });
        if (isActiveBook()) setHasIndexCheckpoint(!cancelled);
      } else {
        report({
          status: 'failed',
          message,
          timings: { ...timings },
          failedPages,
          skippedPages,
          ocrPages,
        });
        if (isActiveBook()) setError(`建立索引失败：${message}`);
      }
    } finally {
      indexTaskControlRef.current.delete(task.id);
      if (ownsDocument && targetPdf)
        await targetPdf.destroy().catch(() => undefined);
    }
  }

  async function processIndexQueue() {
    if (indexTaskRunnerRef.current) return;
    indexTaskRunnerRef.current = true;
    try {
      while (true) {
        const next = indexTasksRef.current.find(
          (task) => task.status === 'queued',
        );
        if (!next) break;
        await runIndexTask(next);
      }
    } finally {
      indexTaskRunnerRef.current = false;
    }
  }

  function enqueueIndexBooks(books: LibraryEntry[], revealTaskCenter = true) {
    const eligible = books.filter(
      (book) =>
        !indexTasksRef.current.some(
          (task) =>
            task.bookId === book.id &&
            ['queued', 'running', 'pausing'].includes(task.status),
        ),
    );
    if (eligible.length === 0) return;
    mutateIndexTasks((current) => queueBooks(current, eligible));
    if (revealTaskCenter) {
      setLibraryOpen(false);
      setTaskCenterOpen(true);
    }
    window.queueMicrotask(() => void processIndexQueue());
  }

  function buildIndex() {
    const book = library.find((entry) => entry.id === activeBookIdRef.current);
    if (!book) {
      setError('请先把 PDF 导入本地书架，再建立可恢复的后台索引。');
      return;
    }
    enqueueIndexBooks([book], false);
  }

  function pauseIndexTask(task: IndexTask) {
    if (task.status !== 'running' && task.status !== 'pausing') return;
    indexTaskControlRef.current.set(task.id, 'pause');
    if (
      task.stage === 'preparing' &&
      settings.embeddingKind === 'local-qwen3-embedding-4b'
    )
      void window.marginDesktop?.modelPause?.();
    patchIndexTask(task.id, {
      status: 'pausing',
      message: '正在安全暂停，当前批次完成后写入检查点…',
    });
    if (task.bookId === activeBookIdRef.current)
      setIndexMessage('正在安全暂停，当前批次完成后写入检查点…');
  }

  async function cancelIndexTask(task: IndexTask) {
    if (task.status === 'running' || task.status === 'pausing') {
      indexTaskControlRef.current.set(task.id, 'cancel');
      if (
        task.stage === 'preparing' &&
        settings.embeddingKind === 'local-qwen3-embedding-4b'
      )
        void window.marginDesktop?.modelPause?.();
      patchIndexTask(task.id, {
        status: 'pausing',
        message: '正在取消并清除未完成检查点…',
      });
      return;
    }
    patchIndexTask(task.id, {
      status: 'cancelled',
      stage: 'queued',
      progress: 0,
      message: '索引已取消，未完成检查点已清除',
      completedPages: 0,
      completedChunks: 0,
      chunks: 0,
      timings: {},
    });
    await window.marginDesktop?.libraryIndexDiscard?.(task.bookId);
  }

  function resumeIndexTask(task: IndexTask) {
    const book = library.find((entry) => entry.id === task.bookId);
    if (book) enqueueIndexBooks([book]);
  }

  function stopIndexing() {
    const task = indexTasksRef.current.find(
      (candidate) =>
        candidate.bookId === activeBookIdRef.current &&
        ['queued', 'running', 'pausing'].includes(candidate.status),
    );
    if (!task) return;
    if (task.status === 'queued') {
      patchIndexTask(task.id, {
        status: 'paused',
        message: '任务已在队列中暂停，可随时继续',
      });
      setIndexStatus('idle');
      setIndexMessage('任务已在队列中暂停，可随时继续');
      return;
    }
    pauseIndexTask(task);
  }

  useEffect(() => {
    processIndexQueueRef.current = processIndexQueue;
  });

  useEffect(() => {
    if (!indexTasks.some((task) => task.status === 'queued')) return;
    window.queueMicrotask(() => void processIndexQueueRef.current());
  }, [indexTasks]);

  async function createDeepReadContext(matches: RagMatch[], prompt: string) {
    if (!pdf || settings.glmOcrMode === 'off') return '';
    const candidates = selectDeepReadCandidates(
      page,
      pageText,
      matches,
      prompt,
      2,
    );
    if (candidates.length === 0) {
      setDeepReadStatus('GLM-OCR 待命 · 本次未检测到复杂页面');
      return '';
    }
    setDeepReadStatus(
      `GLM-OCR 正在精读第 ${candidates.map((candidate) => candidate.page).join('、')} 页…`,
    );
    const results: string[] = [];
    for (const candidate of candidates) {
      const cacheKey = `${activeBookId ?? fileName}:${candidate.page}:${candidate.task}:${settings.glmOcrProvider}:${settings.glmOcrEndpoint}:${settings.glmOcrModel}`;
      let recognized = deepReadCacheRef.current.get(cacheKey);
      if (!recognized) {
        const pdfPage = await pdf.getPage(candidate.page);
        const image = await renderPageImage(pdfPage, 'jpeg');
        const result = window.marginDesktop?.glmOcrRecognize
          ? await window.marginDesktop.glmOcrRecognize({
              ...glmConfig(),
              image: image.bytes,
              mimeType: image.mimeType,
              task: candidate.task,
            })
          : await recognizeWithGlmOcr(
              {
                endpoint: settings.glmOcrEndpoint,
                model: settings.glmOcrModel,
                apiKey: settings.glmOcrApiKey,
              },
              image.bytes,
              image.mimeType,
              candidate.task,
            );
        recognized = result.text;
        deepReadCacheRef.current.set(cacheKey, recognized);
      }
      results.push(
        `[GLM-OCR 精读第 ${candidate.page} 页 · ${candidate.reasons.join('、')}]\n${recognized.slice(0, 12000)}`,
      );
    }
    setDeepReadStatus(
      `GLM-OCR 已精读 ${candidates.length} 页 · 结果已加入回答上下文`,
    );
    window.marginDesktop?.logEvent?.('glm-ocr-deep-read-succeeded', {
      bookId: activeBookId,
      pages: candidates.map((candidate) => candidate.page),
      tasks: candidates.map((candidate) => candidate.task),
    });
    return results.join('\n\n');
  }

  async function createKnowledgeDeepReadContext(
    matches: KnowledgeMatch[],
    prompt: string,
  ) {
    if (settings.glmOcrMode === 'off' || matches.length === 0) return '';
    const candidates = matches
      .map((match) => ({
        match,
        classification: classifyRichContent(match.text, prompt),
      }))
      .filter(({ classification }) => classification.rich)
      .filter(
        ({ match }, index, values) =>
          values.findIndex(
            (candidate) =>
              candidate.match.bookId === match.bookId &&
              candidate.match.page === match.page,
          ) === index,
      )
      .slice(0, 2);
    if (candidates.length === 0) {
      setDeepReadStatus('GLM-OCR 待命 · 跨书来源不需要视觉精读');
      return '';
    }
    setDeepReadStatus(
      `GLM-OCR 正在精读 ${candidates.map(({ match }) => `《${match.bookName}》第 ${match.page} 页`).join('、')}…`,
    );
    const pdfJs = await import('pdfjs-dist');
    pdfJs.GlobalWorkerOptions.workerSrc = new URL(
      pdfWorkerUrl,
      window.location.href,
    ).toString();
    const documents = new Map<string, PDFDocumentProxy>();
    const results: string[] = [];
    try {
      for (const { match, classification } of candidates) {
        let targetPdf = documents.get(match.bookId);
        if (!targetPdf) {
          targetPdf = await pdfJs.getDocument({
            url: `margin://app/library/${match.bookId}/document.pdf`,
          }).promise;
          documents.set(match.bookId, targetPdf);
        }
        const cacheKey = `pack:${match.bookId}:${match.page}:${classification.task}:${settings.glmOcrProvider}:${settings.glmOcrEndpoint}:${settings.glmOcrModel}`;
        let recognized = deepReadCacheRef.current.get(cacheKey);
        if (!recognized) {
          const pdfPage = await targetPdf.getPage(match.page);
          const image = await renderPageImage(pdfPage, 'jpeg');
          const result = window.marginDesktop?.glmOcrRecognize
            ? await window.marginDesktop.glmOcrRecognize({
                ...glmConfig(),
                image: image.bytes,
                mimeType: image.mimeType,
                task: classification.task,
              })
            : await recognizeWithGlmOcr(
                {
                  endpoint: settings.glmOcrEndpoint,
                  model: settings.glmOcrModel,
                  apiKey: settings.glmOcrApiKey,
                },
                image.bytes,
                image.mimeType,
                classification.task,
              );
          recognized = result.text;
          deepReadCacheRef.current.set(cacheKey, recognized);
        }
        results.push(
          `[GLM-OCR 精读《${match.bookName}》· 第 ${match.page} 页 · ${classification.reasons.join('、')}]\n${recognized.slice(0, 12000)}`,
        );
      }
    } finally {
      await Promise.all(
        [...documents.values()].map((document) => document.destroy()),
      );
    }
    setDeepReadStatus(
      `GLM-OCR 已精读 ${candidates.length} 条跨书来源 · 结果已加入回答上下文`,
    );
    window.marginDesktop?.logEvent?.('glm-ocr-knowledge-deep-read-succeeded', {
      packId: activeKnowledgePackId,
      sources: candidates.map(({ match, classification }) => ({
        bookId: match.bookId,
        page: match.page,
        task: classification.task,
      })),
    });
    return results.join('\n\n');
  }

  async function runRegionAction(action: RegionAction) {
    const selection = selectedRegion;
    if (
      !selection?.image ||
      !selection.mimeType ||
      !selection.imageHash ||
      asking ||
      regionActionBusy
    )
      return;
    if (!settings.apiKey.trim()) {
      setError(
        '请先在模型设置中填入聊天模型 API Key，识别结果需要由聊天模型继续解释或整理。',
      );
      return;
    }
    const actionSpec = REGION_ACTIONS[action];
    const cacheKey = `region:${selection.imageHash}:${actionSpec.task}:${settings.glmOcrProvider}:${settings.glmOcrEndpoint}:${settings.glmOcrModel}`;
    setError('');
    setRegionActionBusy(action);
    try {
      let recognized = deepReadCacheRef.current.get(cacheKey);
      const cacheHit = Boolean(recognized);
      setDeepReadStatus(
        cacheHit
          ? `已命中框选识别缓存 · 正在${actionSpec.label}`
          : `GLM-OCR 正在识别第 ${selection.page} 页框选区域…`,
      );
      if (!recognized) {
        const result = window.marginDesktop?.glmOcrRecognize
          ? await window.marginDesktop.glmOcrRecognize({
              ...glmConfig(),
              image: selection.image,
              mimeType: selection.mimeType,
              task: actionSpec.task,
            })
          : await recognizeWithGlmOcr(
              {
                endpoint: settings.glmOcrEndpoint,
                model: settings.glmOcrModel,
                apiKey: settings.glmOcrApiKey,
              },
              selection.image,
              selection.mimeType,
              actionSpec.task,
            );
        recognized = result.text;
        deepReadCacheRef.current.set(cacheKey, recognized);
      }
      setDeepReadStatus(
        `第 ${selection.page} 页框选区域已识别 · 正在由聊天模型${actionSpec.label}`,
      );
      window.marginDesktop?.logEvent?.('glm-ocr-region-read-succeeded', {
        bookId: activeBookId,
        page: selection.page,
        action,
        task: actionSpec.task,
        cacheHit,
        imageBytes: selection.image.byteLength,
        pixelWidth: selection.pixelWidth,
        pixelHeight: selection.pixelHeight,
      });
      const answered = await askAi(undefined, actionSpec.prompt, {
        recognized,
        action,
        citation: { page: selection.page, region: selection.region },
      });
      setDeepReadStatus(
        answered
          ? `框选${actionSpec.label}完成 · 点击回答下方引用可返回原区域`
          : `框选区域已识别，但聊天模型未能完成${actionSpec.label}`,
      );
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message.slice(0, 180) : '未知错误';
      setError(`框选${actionSpec.label}失败：${message}`);
      setDeepReadStatus(`GLM-OCR 框选精读失败：${message}`);
      window.marginDesktop?.logEvent?.(
        'glm-ocr-region-read-failed',
        { bookId: activeBookId, page: selection.page, action, message },
        'error',
      );
    } finally {
      setRegionActionBusy(null);
    }
  }

  async function askAi(
    event?: SyntheticEvent<HTMLFormElement>,
    preset?: string,
    regionContext?: RegionAiContext,
  ) {
    event?.preventDefault();
    const prompt = (preset ?? question).trim();
    const knowledgePack = knowledgePacks.find(
      (pack) => pack.id === activeKnowledgePackId,
    );
    if (!prompt || (!pdf && !knowledgePack) || asking) return false;
    if (!settings.apiKey.trim()) {
      setError('请先在模型设置中填入 API Key。');
      return false;
    }
    const askedAt = new Date().toISOString();
    const targetPage = regionContext?.citation.page ?? (pdf ? page : 1);
    const citation = regionContext?.citation;
    const userMessage: Message = {
      role: 'user',
      content: regionContext
        ? REGION_ACTIONS[regionContext.action].label
        : prompt,
      page: targetPage,
      createdAt: askedAt,
      citation,
    };
    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      page: targetPage,
      createdAt: askedAt,
      citation,
    };
    const previousMessages = messages;
    setQuestion('');
    setError('');
    setAsking(true);
    // Reserve a placeholder assistant bubble immediately so the user sees a
    // thinking indicator and the scroll area keeps the composer visible.
    setMessages((current) => [...current, userMessage, assistantMessage]);
    try {
      let matches: Array<RagMatch | KnowledgeMatch> = [];
      let knowledgeFiltersApplied = false;
      if (!regionContext && knowledgePack) {
        if (knowledgePack.bookIds.length === 0)
          throw new Error('当前知识包还没有加入书籍');
        const filteredBookIds = knowledgePack.bookIds.filter(
          (id) => !knowledgeExcludedBookIds.includes(id),
        );
        if (filteredBookIds.length === 0)
          throw new Error('检索筛选至少需要保留一本书');
        const pageFrom = knowledgePageFrom
          ? Number(knowledgePageFrom)
          : undefined;
        const pageTo = knowledgePageTo ? Number(knowledgePageTo) : undefined;
        knowledgeFiltersApplied =
          filteredBookIds.length !== knowledgePack.bookIds.length ||
          pageFrom !== undefined ||
          pageTo !== undefined;
        if (
          (pageFrom !== undefined &&
            (!Number.isInteger(pageFrom) || pageFrom <= 0)) ||
          (pageTo !== undefined &&
            (!Number.isInteger(pageTo) || pageTo <= 0)) ||
          (pageFrom !== undefined && pageTo !== undefined && pageTo < pageFrom)
        )
          throw new Error('页码范围无效，请检查起止页');
        const provider = createConfiguredProvider();
        if (
          settings.embeddingKind === 'local-qwen3-embedding-4b' &&
          window.marginDesktop?.modelPrepare
        )
          setModelStatus(await window.marginDesktop.modelPrepare());
        setKnowledgeSearchStatus(
          `正在检索“${knowledgePack.name}”中的 ${filteredBookIds.length} 本书…`,
        );
        const [queryVector] = await provider.embed([prompt], 'query');
        const result = await window.marginDesktop?.knowledgeSearch?.(
          knowledgePack.id,
          provider.id,
          Float32Array.from(queryVector),
          8,
          { bookIds: filteredBookIds, pageFrom, pageTo },
        );
        if (!result) throw new Error('当前环境不支持跨书知识包检索');
        matches = result.matches;
        const skipped = result.skippedBooks.length;
        setKnowledgeSearchStatus(
          `已检索 ${result.searchedBooks} / ${result.filteredBooks} 本筛选书籍 · ${result.matches.length} 条来源 · ${result.elapsedMs} ms · ${result.workerCount} 路并行${skipped ? ` · 跳过 ${skipped} 本未索引或模型不匹配书籍` : ''}`,
        );
        if (result.searchedBooks === 0)
          throw new Error('知识包内没有使用当前向量模型完成索引的书籍');
      } else if (
        !regionContext &&
        indexStatus === 'ready' &&
        embeddingProviderRef.current
      ) {
        if (activeBookId && window.marginDesktop?.libraryIndexSearch) {
          const [queryVector] = await embeddingProviderRef.current.embed(
            [prompt],
            'query',
          );
          matches = await window.marginDesktop.libraryIndexSearch(
            activeBookId,
            embeddingProviderRef.current.id,
            Float32Array.from(queryVector),
            5,
          );
        } else
          matches = await vectorIndexRef.current.search(
            prompt,
            embeddingProviderRef.current,
            5,
          );
      }
      let deepReadContext = '';
      if (!regionContext && settings.glmOcrMode === 'auto') {
        try {
          deepReadContext = knowledgePack
            ? await createKnowledgeDeepReadContext(
                matches as KnowledgeMatch[],
                prompt,
              )
            : await createDeepReadContext(matches, prompt);
        } catch (reason) {
          const message =
            reason instanceof Error ? reason.message.slice(0, 160) : '未知错误';
          setDeepReadStatus(`GLM-OCR 精读失败，已回退普通检索：${message}`);
          window.marginDesktop?.logEvent?.(
            'glm-ocr-deep-read-failed',
            { bookId: activeBookId, packId: knowledgePack?.id, message },
            'error',
          );
        }
      }
      const ragContext = matches.length
        ? matches
            .map(
              (match) =>
                `${'bookName' in match ? `[《${match.bookName}》· 第 ${match.page} 页，相似度 ${match.score.toFixed(2)}]` : `[第 ${match.page} 页，相似度 ${match.score.toFixed(2)}]`}\n${match.text}`,
            )
            .join('\n\n')
        : regionContext
          ? '（框选精读仅使用选区，不发送整页或全文片段）'
          : '（尚未建立全文向量索引）';
      const requestContent = regionContext
        ? `我框选了第 ${targetPage} 页的一处区域。\n\nGLM-OCR 对该区域的识别结果：\n${regionContext.recognized.slice(0, 16000)}\n\n任务：${prompt}\n\n回答必须以识别结果为依据，不要补造看不清的内容。行内公式使用 $...$，独立公式使用 $$...$$；代码使用带语言标记的代码块；表格使用 Markdown。`
        : knowledgePack
          ? `你正在回答跨书知识包“${knowledgePack.name}”中的问题。只依据下列由用户明确加入知识包且符合当前筛选的书籍片段作答，不要引用书架中的其他书。每个关键结论都要在句末标注来源，格式为【《书名》· 第 N 页】；若证据不足，明确说明。\n\n跨书检索片段：\n${ragContext.slice(0, 20000)}\n\nGLM-OCR 跨书视觉精读结果：\n${deepReadContext.slice(0, 16000) || '（本次来源不需要视觉精读）'}\n\n精读结果优先用于还原公式、表格和代码结构。行内公式使用 $...$，独立公式使用 $$...$$；代码使用带语言标记的代码块；表格使用 Markdown。\n\n我的问题：${prompt}`
          : `我正在阅读第 ${page} 页。\n\n当前页原文：\n${pageText.slice(0, 12000) || '（此页未提取到可选文本，可能是扫描件）'}\n\n全文检索片段：\n${ragContext.slice(0, 12000)}\n\nGLM-OCR 视觉精读结果：\n${deepReadContext.slice(0, 16000) || '（本次未调用精读模型）'}\n\n请优先保留精读结果中的 LaTeX 公式、代码缩进与表格结构。行内公式使用 $...$，独立公式使用 $$...$$，以便阅读器渲染。\n\n我的问题：${prompt}`;
      const response = await fetch(
        `${settings.endpoint.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify({
            model: settings.model,
            temperature: 0.3,
            stream: true,
            messages: [
              {
                role: 'system',
                content:
                  settings.systemPrompt.trim() || DEFAULT_SETTINGS.systemPrompt,
              },
              ...(knowledgePack && knowledgeFiltersApplied
                ? []
                : messages
                    .slice(-6)
                    .map(({ role, content }) => ({ role, content }))),
              { role: 'user', content: requestContent },
            ],
          }),
        },
      );
      if (!response.ok)
        throw new Error((await response.text()) || `HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      let answerText = '';
      const emitChunk = (chunk: string) => {
        if (!chunk) return;
        answerText += chunk;
        const text = (existing: string) => `${existing}${chunk}`;
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'assistant')
            next[next.length - 1] = { ...last, content: text(last.content) };
          return next;
        });
      };
      if (contentType.includes('text/event-stream') && response.body) {
        // Streamed OpenAI-compatible SSE: each `data:` line carries a delta.
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let done = false;
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          done = streamDone;
          buffer += decoder.decode(value, { stream: !streamDone });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              emitChunk(parsed.choices?.[0]?.delta?.content ?? '');
            } catch {
              /* ignore malformed keep-alive or partial line */
            }
          }
        }
      } else {
        // Some providers ignore `stream: true` and return the whole JSON.
        const result = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        emitChunk(result.choices?.[0]?.message?.content ?? '');
      }
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === 'assistant')
          next[next.length - 1] = {
            ...last,
            content: last.content || '（模型未返回文本）',
            sources: knowledgePack
              ? matches.slice(0, 8).map((match) => ({
                  bookId: (match as KnowledgeMatch).bookId,
                  bookName: (match as KnowledgeMatch).bookName,
                  page: match.page,
                  score: match.score,
                  excerpt: match.text.slice(0, 320),
                }))
              : undefined,
          };
        return next;
      });
      const savedAnswer = answerText || '（模型未返回文本）';
      const sources = knowledgePack
        ? matches.slice(0, 8).map((match) => ({
            bookId: (match as KnowledgeMatch).bookId,
            bookName: (match as KnowledgeMatch).bookName,
            page: match.page,
            score: match.score,
            excerpt: match.text.slice(0, 320),
          }))
        : undefined;
      saveChatHistory(
        knowledgePack ? `pack_${knowledgePack.id}` : (activeBookId ?? fileName),
        knowledgePack ? `知识包：${knowledgePack.name}` : fileName,
        [
          ...previousMessages,
          userMessage,
          { ...assistantMessage, content: savedAnswer, sources },
        ],
      );
      return true;
    } catch (reason) {
      setError(
        `AI 请求失败：${reason instanceof Error ? reason.message.slice(0, 160) : '请检查端点与密钥'}`,
      );
      // Drop the empty assistant placeholder on failure; keep partial text if any.
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && !last.content) next.pop();
        return next;
      });
      return false;
    } finally {
      setAsking(false);
    }
  }

  const pendingIndexTaskCount = indexTasks.filter((task) =>
    ['queued', 'running', 'pausing', 'paused', 'failed'].includes(task.status),
  ).length;
  const activeBookTask = indexTasks.find(
    (task) =>
      task.bookId === activeBookId &&
      ['queued', 'running', 'pausing', 'paused', 'failed'].includes(
        task.status,
      ),
  );
  const selectedKnowledgePack = knowledgePacks.find(
    (pack) => pack.id === selectedKnowledgePackId,
  );
  const activeKnowledgePack = knowledgePacks.find(
    (pack) => pack.id === activeKnowledgePackId,
  );
  const currentEmbeddingProviderId = createConfiguredProvider().id;

  return (
    <main className="app-shell">
      <aside className="app-sidebar" aria-label="应用功能">
        <div
          className="sidebar-brand"
          title={`Margin${appVersion ? ` v${appVersion}` : ''}`}
        >
          <FileText />
          <span className="sr-only">
            Margin{appVersion ? ` v${appVersion}` : ''}
          </span>
        </div>
        <nav className="sidebar-modules" aria-label="功能模块">
          <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
            <DialogTrigger
              render={
                <button
                  className="sidebar-module-button"
                  aria-label="本地书架"
                  title="本地书架"
                />
              }
            >
              <Library />
              <span>书架</span>
              {library.length > 0 && <strong>{library.length}</strong>}
            </DialogTrigger>
            <DialogContent className="library-dialog">
              <DialogHeader>
                <DialogTitle>本地书架</DialogTitle>
                <DialogDescription>
                  集中管理保存在本机的 PDF、阅读进度与全文向量索引。
                </DialogDescription>
              </DialogHeader>
              <div className="library-dialog-actions">
                <div>
                  <Button onClick={() => fileInputRef.current?.click()}>
                    <Plus />
                    导入 PDF
                  </Button>
                  {library.some((book) => !book.indexProviderId) && (
                    <Button
                      variant="outline"
                      onClick={() =>
                        enqueueIndexBooks(
                          library.filter((book) => !book.indexProviderId),
                        )
                      }
                    >
                      <ListTodo />
                      索引未处理书籍
                    </Button>
                  )}
                </div>
                <span>{library.length} 本书 · 数据仅保存在本机</span>
              </div>
              <div className="book-list">
                {library.length === 0 ? (
                  <div className="bookshelf-empty">
                    <BookOpen />
                    <p>
                      还没有书籍。导入的 PDF
                      会保存在本机，并记住阅读进度与向量索引。
                    </p>
                  </div>
                ) : (
                  library.map((book) => (
                    <div className="book-row" key={book.id}>
                      <button
                        className={
                          book.id === activeBookId
                            ? 'book-item active'
                            : 'book-item'
                        }
                        onClick={() => void openLibraryBook(book)}
                      >
                        <span className="book-icon">
                          <FileText />
                        </span>
                        <span className="book-copy">
                          <strong>{book.name}</strong>
                          <small>
                            {book.pageCount
                              ? `${book.lastPage} / ${book.pageCount} 页`
                              : '等待首次打开'}
                          </small>
                        </span>
                        {book.indexProviderId && (
                          <span className="book-index" title="已保存向量索引">
                            <HardDrive />
                          </span>
                        )}
                      </button>
                      <button
                        className="book-action"
                        onClick={() => enqueueIndexBooks([book])}
                        aria-label={`后台索引 ${book.name}`}
                        title="加入后台索引队列"
                      >
                        <ListTodo />
                      </button>
                      <button
                        className="book-remove"
                        onClick={() => void removeLibraryBook(book)}
                        aria-label={`从书架移除 ${book.name}`}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={knowledgeOpen} onOpenChange={setKnowledgeOpen}>
            <DialogTrigger
              render={
                <button
                  className="sidebar-module-button"
                  aria-label="跨书知识包"
                  title="跨书知识包"
                />
              }
            >
              <Folder />
              <span>知识包</span>
              {knowledgePacks.length > 0 && (
                <strong>{knowledgePacks.length}</strong>
              )}
            </DialogTrigger>
            <DialogContent className="knowledge-dialog">
              <DialogHeader>
                <DialogTitle>跨书知识包</DialogTitle>
                <DialogDescription>
                  像文件夹一样自由组合书籍。AI
                  只检索当前选中的知识包，不会扫描整个书架。
                </DialogDescription>
              </DialogHeader>
              <div className="knowledge-toolbar">
                <Button
                  variant="outline"
                  onClick={() => void importKnowledgePackFile()}
                >
                  <Upload />
                  导入清单
                </Button>
                <Button
                  variant="outline"
                  disabled={!selectedKnowledgePack}
                  onClick={() =>
                    selectedKnowledgePack &&
                    void exportSelectedKnowledgePack(selectedKnowledgePack)
                  }
                >
                  <Download />
                  导出当前知识包
                </Button>
                <span>只导出组合清单，不复制 PDF、索引或模型。</span>
              </div>
              {knowledgeNotice && (
                <p className="knowledge-notice">{knowledgeNotice}</p>
              )}
              <div className="knowledge-create">
                <FolderPlus />
                <Input
                  value={newKnowledgePackName}
                  onChange={(event) =>
                    setNewKnowledgePackName(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void createKnowledgePackFromInput();
                    }
                  }}
                  placeholder="新知识包名称，例如：高等代数专题"
                  aria-label="新知识包名称"
                />
                <Button
                  onClick={() => void createKnowledgePackFromInput()}
                  disabled={!newKnowledgePackName.trim()}
                >
                  创建
                </Button>
              </div>
              <div className="knowledge-layout">
                <div className="knowledge-tree" aria-label="知识包包含关系">
                  {knowledgePacks.length === 0 ? (
                    <div className="knowledge-empty">
                      <Folder />
                      <p>创建第一个知识包，再从右侧书架勾选要一起检索的书。</p>
                    </div>
                  ) : (
                    knowledgePacks.map((pack) => {
                      const memberBooks = pack.bookIds
                        .map((id) => library.find((book) => book.id === id))
                        .filter(Boolean) as LibraryEntry[];
                      const selected = pack.id === selectedKnowledgePackId;
                      return (
                        <div
                          className={`knowledge-tree-node${selected ? ' selected' : ''}`}
                          key={pack.id}
                        >
                          <button
                            className="knowledge-pack-node"
                            onClick={() => selectKnowledgePack(pack)}
                          >
                            <ChevronDown />
                            <Folder />
                            <span>
                              <strong>{pack.name}</strong>
                              <small>{memberBooks.length} 本书</small>
                            </span>
                            {pack.id === activeKnowledgePackId && <i>使用中</i>}
                          </button>
                          <div className="knowledge-tree-books">
                            {memberBooks.length === 0 ? (
                              <span>空文件包</span>
                            ) : (
                              memberBooks.map((book) => (
                                <button
                                  key={book.id}
                                  onClick={() => {
                                    setKnowledgeOpen(false);
                                    void openLibraryBook(book);
                                  }}
                                  title={`打开《${book.name}》`}
                                >
                                  <FileText />
                                  <span>{book.name}</span>
                                  {book.indexProviderId ===
                                  currentEmbeddingProviderId ? (
                                    <CheckCircle2 />
                                  ) : (
                                    <Clock3 />
                                  )}
                                </button>
                              ))
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                <div className="knowledge-editor">
                  {selectedKnowledgePack ? (
                    <>
                      <div className="knowledge-editor-heading">
                        <div>
                          <Label htmlFor="knowledge-pack-name">
                            知识包名称
                          </Label>
                          <Input
                            id="knowledge-pack-name"
                            value={knowledgePackName}
                            onChange={(event) =>
                              setKnowledgePackName(event.target.value)
                            }
                          />
                        </div>
                        <div>
                          <Label htmlFor="knowledge-pack-description">
                            用途说明
                          </Label>
                          <Input
                            id="knowledge-pack-description"
                            value={knowledgePackDescription}
                            onChange={(event) =>
                              setKnowledgePackDescription(event.target.value)
                            }
                            placeholder="这个知识包要解决什么问题？"
                          />
                        </div>
                        <Button
                          variant="outline"
                          onClick={() => void saveKnowledgePackDetails()}
                        >
                          保存
                        </Button>
                      </div>
                      <div className="knowledge-members-heading">
                        <div>
                          <strong>从本地书架选择成员</strong>
                          <span>
                            已选 {selectedKnowledgePack.bookIds.length} /{' '}
                            {library.length} 本
                          </span>
                        </div>
                        <span>勾选变化会立即保存</span>
                      </div>
                      <div className="knowledge-members">
                        {library.length === 0 ? (
                          <p>书架还没有 PDF，请先从“书架”导入。</p>
                        ) : (
                          library.map((book) => {
                            const checked =
                              selectedKnowledgePack.bookIds.includes(book.id);
                            const compatible =
                              book.indexProviderId ===
                              currentEmbeddingProviderId;
                            return (
                              <label
                                className={`knowledge-member${checked ? ' checked' : ''}`}
                                key={book.id}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() =>
                                    void toggleKnowledgePackBook(
                                      selectedKnowledgePack,
                                      book.id,
                                    )
                                  }
                                />
                                <span className="book-icon">
                                  <FileText />
                                </span>
                                <span>
                                  <strong>{book.name}</strong>
                                  <small>
                                    {compatible
                                      ? `索引可用 · ${book.pageCount || '?'} 页`
                                      : book.indexProviderId
                                        ? '索引模型不匹配，需重新索引'
                                        : '尚未建立索引'}
                                  </small>
                                </span>
                                {compatible ? <CheckCircle2 /> : <Clock3 />}
                              </label>
                            );
                          })
                        )}
                      </div>
                      <div className="knowledge-editor-actions">
                        <Button
                          variant="destructive"
                          onClick={() =>
                            void removeKnowledgePack(selectedKnowledgePack)
                          }
                        >
                          <Trash2 />
                          删除组合
                        </Button>
                        <Button
                          onClick={() =>
                            void activateKnowledgePack(selectedKnowledgePack)
                          }
                          disabled={selectedKnowledgePack.bookIds.length === 0}
                        >
                          <Sparkles />
                          用此知识包提问
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="knowledge-editor-empty">
                      <Folder />
                      <p>在左侧选择或新建知识包。</p>
                    </div>
                  )}
                </div>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={taskCenterOpen} onOpenChange={setTaskCenterOpen}>
            <DialogTrigger
              render={
                <button
                  className="sidebar-module-button"
                  aria-label="索引任务"
                  title="索引任务"
                />
              }
            >
              <ListTodo />
              <span>任务</span>
              {pendingIndexTaskCount > 0 && (
                <strong>{pendingIndexTaskCount}</strong>
              )}
            </DialogTrigger>
            <DialogContent className="task-center-dialog">
              <DialogHeader>
                <DialogTitle>后台索引任务</DialogTitle>
                <DialogDescription>
                  书籍按队列逐本处理；关闭弹窗或切换阅读书籍都不会打断当前任务。
                </DialogDescription>
              </DialogHeader>
              <div className="task-center-summary">
                <span>
                  <Gauge />
                  {appInfo?.runtimeBackend === 'vulkan'
                    ? 'Vulkan GPU'
                    : 'CPU'}{' '}
                  ·{' '}
                  {appInfo?.cpuThreads ||
                    (typeof navigator === 'undefined'
                      ? 1
                      : navigator.hardwareConcurrency) ||
                    1}{' '}
                  线程
                </span>
                <span>
                  {appInfo
                    ? `${(appInfo.freeMemory / 1024 / 1024 / 1024).toFixed(1)} / ${(appInfo.totalMemory / 1024 / 1024 / 1024).toFixed(1)} GB 可用`
                    : '正在读取设备信息'}
                </span>
                <div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      enqueueIndexBooks(
                        library.filter((book) => !book.indexProviderId),
                      )
                    }
                    disabled={!library.some((book) => !book.indexProviderId)}
                  >
                    索引未处理书籍
                  </Button>
                  {indexTasks.some((task) =>
                    ['completed', 'cancelled'].includes(task.status),
                  ) && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        mutateIndexTasks((current) =>
                          current.filter(
                            (task) =>
                              !['completed', 'cancelled'].includes(task.status),
                          ),
                        )
                      }
                    >
                      清理已结束
                    </Button>
                  )}
                </div>
              </div>
              <div className="task-list">
                {indexTasks.length === 0 ? (
                  <div className="task-empty">
                    <ListTodo />
                    <p>
                      暂无索引任务。可从书架为单本书排队，或一次索引全部未处理书籍。
                    </p>
                  </div>
                ) : (
                  [...indexTasks].reverse().map((task) => (
                    <article
                      className={`index-task-card ${task.status}`}
                      key={task.id}
                    >
                      <div className="index-task-heading">
                        <span className="task-state-icon">
                          {task.status === 'completed' ? (
                            <CheckCircle2 />
                          ) : task.status === 'running' ||
                            task.status === 'pausing' ? (
                            <Gauge />
                          ) : (
                            <Clock3 />
                          )}
                        </span>
                        <div>
                          <strong title={task.bookName}>{task.bookName}</strong>
                          <small>
                            {indexTaskStatusLabel(task)} · {task.progress}%
                          </small>
                        </div>
                        <div className="task-actions">
                          {task.status === 'running' && (
                            <Button
                              size="icon-sm"
                              variant="outline"
                              onClick={() => pauseIndexTask(task)}
                              aria-label="暂停任务"
                              title="暂停"
                            >
                              <Pause />
                            </Button>
                          )}
                          {['paused', 'failed', 'cancelled'].includes(
                            task.status,
                          ) && (
                            <Button
                              size="icon-sm"
                              variant="outline"
                              onClick={() => resumeIndexTask(task)}
                              aria-label="继续任务"
                              title={
                                task.failedPages.length
                                  ? '重试失败页并继续'
                                  : '继续'
                              }
                            >
                              {task.status === 'failed' ? (
                                <RotateCcw />
                              ) : (
                                <Play />
                              )}
                            </Button>
                          )}
                          {[
                            'queued',
                            'running',
                            'pausing',
                            'paused',
                            'failed',
                          ].includes(task.status) && (
                            <Button
                              size="icon-sm"
                              variant="ghost"
                              onClick={() => void cancelIndexTask(task)}
                              aria-label="取消任务"
                              title="取消并清除检查点"
                            >
                              <Square />
                            </Button>
                          )}
                        </div>
                      </div>
                      <div className="task-progress">
                        <i style={{ width: `${task.progress}%` }} />
                      </div>
                      <p>{task.message}</p>
                      <div className="task-metrics">
                        <span>
                          {task.completedPages} / {task.pageCount || '?'} 页
                        </span>
                        <span>
                          {task.completedChunks} / {task.chunks || '?'} 片段
                        </span>
                        {task.ocrPages > 0 && (
                          <span>OCR {task.ocrPages} 页</span>
                        )}
                        {task.skippedPages > 0 && (
                          <span>跳过空白 {task.skippedPages} 页</span>
                        )}
                        {task.failedPages.length > 0 && (
                          <span className="failed">
                            失败页 {task.failedPages.join('、')}
                          </span>
                        )}
                      </div>
                      {Object.keys(task.timings).length > 0 && (
                        <div className="task-timings">
                          {Object.entries(task.timings).map(
                            ([stage, elapsed]) => (
                              <span key={stage}>
                                {INDEX_STAGE_LABELS[stage as IndexTaskStage]}{' '}
                                {formatElapsed(elapsed || 0)}
                              </span>
                            ),
                          )}
                        </div>
                      )}
                      {task.lanes && (
                        <small className="task-runtime">
                          {task.backend === 'vulkan' ? 'Vulkan' : 'CPU'} · 文本{' '}
                          {task.lanes.text} 路 / OCR {task.lanes.ocr} 路 / 向量{' '}
                          {task.lanes.embedding} 路
                        </small>
                      )}
                    </article>
                  ))
                )}
              </div>
            </DialogContent>
          </Dialog>
          <Dialog open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
            <DialogTrigger
              render={
                <button
                  className="sidebar-module-button"
                  aria-label="阅读资料"
                  title="高亮、批注、摘要与概念词典"
                />
              }
            >
              <NotebookPen />
              <span>资料</span>
              {activeNotes.length > 0 && <strong>{activeNotes.length}</strong>}
            </DialogTrigger>
            <DialogContent className="workspace-dialog">
              <DialogHeader>
                <DialogTitle>阅读资料</DialogTitle>
                <DialogDescription>
                  高亮、批注、AI 摘要卡片和概念词典统一保存在本机 SQLite 中。
                </DialogDescription>
              </DialogHeader>
              <div className="workspace-toolbar">
                <div className="workspace-search">
                  <Search />
                  <Input
                    value={workspaceQuery}
                    onChange={(event) => setWorkspaceQuery(event.target.value)}
                    placeholder="搜索书名、标题或内容"
                    aria-label="搜索阅读资料"
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={() => void exportWorkspace(Boolean(activeBookId))}
                >
                  <Download />
                  {activeBookId ? '导出本书' : '全部导出'}
                </Button>
              </div>
              <div className="workspace-filters">
                {(
                  ['all', 'highlight', 'note', 'summary', 'glossary'] as const
                ).map((kind) => (
                  <button
                    key={kind}
                    className={workspaceKind === kind ? 'active' : ''}
                    onClick={() => setWorkspaceKind(kind)}
                  >
                    {kind === 'all' ? '全部' : NOTE_KIND_LABELS[kind]}
                  </button>
                ))}
              </div>
              <div className="workspace-list">
                {workspaceNotes.length === 0 ? (
                  <p className="history-empty">
                    还没有匹配的阅读资料。框选页面即可添加高亮、批注或概念。
                  </p>
                ) : (
                  workspaceNotes.map((note) => (
                    <article
                      className={`workspace-note ${note.kind}`}
                      key={note.id}
                    >
                      <button
                        className="workspace-note-main"
                        onClick={() => void openWorkspaceNote(note)}
                      >
                        <span>
                          <i style={{ background: note.color }} />
                          {NOTE_KIND_LABELS[note.kind]} · 第 {note.page} 页
                        </span>
                        <strong>
                          {note.title || NOTE_KIND_LABELS[note.kind]}
                        </strong>
                        <small>{note.bookName}</small>
                        {note.excerpt && <p>{note.excerpt}</p>}
                        {note.content && (
                          <div className="workspace-note-preview">
                            {note.content}
                          </div>
                        )}
                      </button>
                      <button
                        className="workspace-note-remove"
                        onClick={() => void removeWorkspaceNote(note)}
                        aria-label={`删除 ${note.title}`}
                      >
                        <Trash2 />
                      </button>
                    </article>
                  ))
                )}
              </div>
              <DialogFooter>
                <span className="workspace-count">
                  已显示 {workspaceNotes.length} / {workspaceNotesTotal} 条
                </span>
                {workspaceNotes.length < workspaceNotesTotal && (
                  <Button
                    variant="outline"
                    onClick={() => void loadMoreWorkspaceNotes()}
                  >
                    加载更多
                  </Button>
                )}
              </DialogFooter>
            </DialogContent>
          </Dialog>
          <div className="sidebar-future-slots" aria-hidden="true">
            <span />
          </div>
        </nav>
        <div className="sidebar-bottom">
          <Dialog>
            <DialogTrigger
              render={
                <button
                  className="sidebar-module-button"
                  aria-label="模型设置"
                  title="模型设置"
                />
              }
            >
              <Settings2 />
              <span>设置</span>
            </DialogTrigger>
            <DialogContent className="settings-dialog">
              <DialogHeader>
                <DialogTitle>模型设置</DialogTitle>
                <DialogDescription>
                  支持 OpenAI 兼容的 <code>/chat/completions</code>{' '}
                  端点。配置仅保存在本机浏览器。
                </DialogDescription>
              </DialogHeader>
              <div className="settings-fields">
                <Label htmlFor="endpoint">端点地址</Label>
                <Input
                  id="endpoint"
                  value={settings.endpoint}
                  onChange={(e) => {
                    setSettings({ ...settings, endpoint: e.target.value });
                    setChatModelList([]);
                    setChatModelListError('');
                  }}
                  placeholder="https://api.openai.com/v1"
                />
                <Label htmlFor="model">模型名称</Label>
                <div className="model-field">
                  <div className="model-field-row">
                    <Input
                      className="flex-1 min-w-0"
                      id="model"
                      value={settings.model}
                      onChange={(e) =>
                        setSettings({ ...settings, model: e.target.value })
                      }
                      placeholder="gpt-5-mini"
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void fetchChatModelList()}
                      disabled={
                        !settings.endpoint.trim() ||
                        !settings.apiKey.trim() ||
                        chatModelListLoading
                      }
                    >
                      {chatModelListLoading ? '获取中…' : '自动获取模型列表'}
                    </Button>
                  </div>
                  {chatModelListError && (
                    <p className="field-error">{chatModelListError}</p>
                  )}
                  {chatModelList.length > 0 && (
                    <NativeSelect
                      id="chat-model-list"
                      className="w-full"
                      value={settings.model}
                      onChange={(e) =>
                        setSettings({ ...settings, model: e.target.value })
                      }
                    >
                      <NativeSelectOption value="">
                        从列表选择模型…
                      </NativeSelectOption>
                      {chatModelList.map((id) => (
                        <NativeSelectOption key={id} value={id}>
                          {id}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </div>
                <Label htmlFor="api-key">API Key</Label>
                <Input
                  id="api-key"
                  type="password"
                  value={settings.apiKey}
                  onChange={(e) => {
                    setSettings({ ...settings, apiKey: e.target.value });
                    setChatModelList([]);
                    setChatModelListError('');
                  }}
                  placeholder="sk-..."
                />
                <Label htmlFor="system-prompt">系统提示词</Label>
                <Textarea
                  id="system-prompt"
                  className="system-prompt-input"
                  value={settings.systemPrompt}
                  onChange={(e) =>
                    setSettings({ ...settings, systemPrompt: e.target.value })
                  }
                  rows={5}
                  placeholder={DEFAULT_SETTINGS.systemPrompt}
                />
                <div className="settings-divider">
                  <span>文档识别</span>
                </div>
                <Label htmlFor="ocr-mode">扫描页 OCR</Label>
                <NativeSelect
                  id="ocr-mode"
                  className="w-full"
                  value={settings.ocrMode}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      ocrMode: e.target.value as ModelSettings['ocrMode'],
                    })
                  }
                >
                  <NativeSelectOption value="auto">
                    自动识别无文本页面
                  </NativeSelectOption>
                  <NativeSelectOption value="off">关闭 OCR</NativeSelectOption>
                </NativeSelect>
                {settings.ocrMode === 'auto' && (
                  <>
                    <Label htmlFor="ocr-language">OCR 语言</Label>
                    <NativeSelect
                      id="ocr-language"
                      className="w-full"
                      value={settings.ocrLanguage}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          ocrLanguage: e.target
                            .value as ModelSettings['ocrLanguage'],
                        })
                      }
                    >
                      <NativeSelectOption value="chi_sim+eng">
                        简体中文 + English
                      </NativeSelectOption>
                      <NativeSelectOption value="chi_tra+eng">
                        繁体中文 + English
                      </NativeSelectOption>
                      <NativeSelectOption value="eng">
                        English
                      </NativeSelectOption>
                    </NativeSelect>
                    <p className="settings-note">
                      OCR 完全在本机运行，仅处理 PDF.js
                      无法提取文本的页面。首次使用会初始化随应用安装的 Tesseract
                      字库。
                    </p>
                  </>
                )}
                <div className="settings-divider">
                  <span>公式、代码与表格精读</span>
                </div>
                <Label htmlFor="glm-ocr-mode">精读模型</Label>
                <NativeSelect
                  id="glm-ocr-mode"
                  className="w-full"
                  value={settings.glmOcrMode}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      glmOcrMode: e.target.value as DeepReadMode,
                    })
                  }
                >
                  <NativeSelectOption value="off">
                    关闭（默认）
                  </NativeSelectOption>
                  <NativeSelectOption value="auto">
                    GLM-OCR · 向量命中后按需精读
                  </NativeSelectOption>
                </NativeSelect>
                {settings.glmOcrMode === 'auto' && (
                  <>
                    <Label htmlFor="glm-ocr-provider">运行方式</Label>
                    <NativeSelect
                      id="glm-ocr-provider"
                      className="w-full"
                      value={settings.glmOcrProvider}
                      onChange={(e) => {
                        const provider = e.target.value as GlmOcrProvider;
                        setSettings({
                          ...settings,
                          glmOcrProvider: provider,
                          glmOcrEndpoint:
                            provider === 'managed'
                              ? ''
                              : provider === 'ollama'
                                ? 'http://127.0.0.1:11434'
                                : settings.glmOcrEndpoint,
                          glmOcrModel:
                            provider === 'managed'
                              ? 'ggml-org/GLM-OCR-GGUF'
                              : provider === 'ollama'
                                ? 'glm-ocr:latest'
                                : settings.glmOcrModel,
                        });
                      }}
                    >
                      <NativeSelectOption value="managed">
                        应用托管本地模型（推荐）
                      </NativeSelectOption>
                      <NativeSelectOption value="openai-compatible">
                        vLLM / SGLang / 远程兼容端点
                      </NativeSelectOption>
                      <NativeSelectOption value="ollama">
                        已有 Ollama 服务（高级）
                      </NativeSelectOption>
                    </NativeSelect>
                    {settings.glmOcrProvider !== 'managed' && (
                      <>
                        <Label htmlFor="glm-ocr-endpoint">GLM-OCR 端点</Label>
                        <Input
                          id="glm-ocr-endpoint"
                          value={settings.glmOcrEndpoint}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              glmOcrEndpoint: e.target.value,
                            })
                          }
                          placeholder={
                            settings.glmOcrProvider === 'ollama'
                              ? 'http://127.0.0.1:11434'
                              : 'http://127.0.0.1:8080/v1'
                          }
                        />
                        <Label htmlFor="glm-ocr-model">模型名称</Label>
                        <Input
                          id="glm-ocr-model"
                          value={settings.glmOcrModel}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              glmOcrModel: e.target.value,
                            })
                          }
                          placeholder="glm-ocr:latest"
                        />
                      </>
                    )}
                    {settings.glmOcrProvider === 'openai-compatible' && (
                      <>
                        <Label htmlFor="glm-ocr-key">
                          API Key（本机可留空）
                        </Label>
                        <Input
                          id="glm-ocr-key"
                          type="password"
                          value={settings.glmOcrApiKey}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              glmOcrApiKey: e.target.value,
                            })
                          }
                          placeholder="自托管服务通常可留空"
                        />
                      </>
                    )}
                    {settings.glmOcrProvider !== 'openai-compatible' && (
                      <>
                        <Label htmlFor="glm-auto-start">自动开启</Label>
                        <label className="checkbox-field">
                          <input
                            id="glm-auto-start"
                            type="checkbox"
                            checked={settings.glmOcrAutoStart}
                            onChange={(event) =>
                              setSettings({
                                ...settings,
                                glmOcrAutoStart: event.target.checked,
                              })
                            }
                          />
                          提问需要精读时自动载入模型
                        </label>
                      </>
                    )}
                    <p className="settings-note">
                      推荐模式使用与向量模型一致的应用托管 llama.cpp
                      运行时，无需安装 Ollama 或 Python；模型约 1.4
                      GB，按需下载。系统最多精读 2 个候选页。
                      <a
                        href="https://github.com/zai-org/GLM-OCR"
                        target="_blank"
                        rel="noreferrer"
                      >
                        查看 GLM-OCR
                      </a>
                    </p>
                    {settings.glmOcrProvider !== 'openai-compatible' && (
                      <div className="model-manager glm-manager">
                        <div className="model-manager-status">
                          <span
                            className={
                              glmOcrStatus?.modelLoaded
                                ? 'status-dot online'
                                : 'status-dot'
                            }
                          />
                          <div>
                            <strong>
                              {glmOcrStatus?.modelLoaded
                                ? 'GLM-OCR 已载入内存'
                                : glmOcrStatus?.modelInstalled
                                  ? 'GLM-OCR 已准备好'
                                  : glmOcrStatus?.state === 'paused'
                                    ? '下载已暂停'
                                    : settings.glmOcrProvider === 'managed'
                                      ? '尚未安装本地 GLM-OCR'
                                      : glmOcrStatus?.runtimeInstalled
                                        ? 'Ollama 已安装，模型未准备'
                                        : '系统未检测到 Ollama'}
                            </strong>
                            <small>
                              {glmOcrStatus?.message ||
                                (settings.glmOcrProvider === 'managed'
                                  ? 'Margin 自动管理 GGUF 模型、多模态投影器和运行时'
                                  : '仅供已经配置 Ollama 的高级用户使用')}
                            </small>
                          </div>
                        </div>
                        {glmOcrStatus &&
                          [
                            'checking',
                            'starting',
                            'downloading',
                            'installing',
                            'loading',
                          ].includes(glmOcrStatus.state) && (
                            <div className="model-progress">
                              <i
                                style={{ width: `${glmOcrStatus.progress}%` }}
                              />
                            </div>
                          )}
                        <div className="model-manager-actions">
                          {settings.glmOcrProvider === 'ollama' &&
                            !glmOcrStatus?.runtimeInstalled && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void window.marginDesktop?.glmOcrOpenInstall?.()
                                }
                              >
                                Ollama 下载页
                              </Button>
                            )}
                          {settings.glmOcrProvider === 'managed' &&
                            glmOcrStatus?.state === 'downloading' && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  void window.marginDesktop?.glmOcrPause?.()
                                }
                              >
                                暂停
                              </Button>
                            )}
                          {glmOcrStatus?.state !== 'downloading' && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void prepareGlmModel()}
                              disabled={[
                                'starting',
                                'loading',
                                'installing',
                                'checking',
                              ].includes(glmOcrStatus?.state || '')}
                            >
                              {glmOcrStatus?.modelInstalled
                                ? '启动并载入'
                                : glmOcrStatus?.state === 'paused'
                                  ? '继续下载'
                                  : '下载并安装'}
                            </Button>
                          )}
                          {glmOcrStatus?.modelLoaded && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => void releaseGlmModel()}
                            >
                              释放显存
                            </Button>
                          )}
                          {settings.glmOcrProvider === 'managed' &&
                            glmOcrStatus?.modelInstalled && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    void window.marginDesktop?.glmOcrOpenFolder?.()
                                  }
                                >
                                  打开目录
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void removeGlmModel()}
                                >
                                  卸载
                                </Button>
                              </>
                            )}
                        </div>
                      </div>
                    )}
                  </>
                )}
                <div className="settings-divider">
                  <span>向量检索</span>
                </div>
                <Label htmlFor="embedding-kind">向量模型</Label>
                <NativeSelect
                  id="embedding-kind"
                  className="w-full"
                  value={settings.embeddingKind}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      embeddingKind: e.target.value as EmbeddingProviderKind,
                    })
                  }
                >
                  <NativeSelectOption value="local-qwen3-embedding-4b">
                    本地 Qwen3-Embedding-4B（Q4_K_M）
                  </NativeSelectOption>
                  <NativeSelectOption value="openai-compatible">
                    OpenAI 兼容提供商
                  </NativeSelectOption>
                </NativeSelect>
                {settings.embeddingKind === 'local-qwen3-embedding-4b' && (
                  <div className="model-manager">
                    <div className="model-manager-status">
                      <span
                        className={
                          modelStatus?.installed
                            ? 'status-dot online'
                            : 'status-dot'
                        }
                      />
                      <div>
                        <strong>
                          {modelStatus?.loaded
                            ? '模型已载入内存'
                            : modelStatus?.installed
                              ? '本地模型已就绪'
                              : modelStatus?.state === 'paused'
                                ? '下载已暂停'
                                : '尚未安装本地模型'}
                        </strong>
                        <small>
                          {modelStatus?.message ||
                            (modelStatus?.missing?.length
                              ? `缺少：${modelStatus.missing.join('、')}`
                              : modelStatus?.loaded
                                ? `${modelStatus.backend === 'vulkan' ? 'Vulkan GPU 加速' : 'CPU 模式'} · 空闲 2 分钟后自动释放内存`
                                : `Qwen3-Embedding-4B · Q4_K_M · ${modelStatus?.backend === 'vulkan' ? 'Vulkan GPU 加速' : 'CPU 模式'}`)}
                        </small>
                      </div>
                    </div>
                    {modelStatus &&
                      ['checking', 'downloading', 'installing'].includes(
                        modelStatus.state,
                      ) && (
                        <div className="model-progress">
                          <i style={{ width: `${modelStatus.progress}%` }} />
                        </div>
                      )}
                    <div className="model-manager-actions">
                      {!modelStatus?.installed &&
                        modelStatus?.state !== 'downloading' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void installLocalModel()}
                          >
                            {modelStatus?.state === 'paused'
                              ? '继续下载'
                              : '下载并安装'}
                          </Button>
                        )}
                      {modelStatus?.state === 'downloading' && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void window.marginDesktop?.modelPause?.()
                          }
                        >
                          暂停
                        </Button>
                      )}
                      {modelStatus?.installed && (
                        <>
                          {modelStatus.loaded && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void releaseModelMemory()}
                            >
                              释放内存
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void window.marginDesktop?.modelOpenFolder?.()
                            }
                          >
                            打开目录
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void removeLocalModel()}
                          >
                            卸载
                          </Button>
                        </>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void window.marginDesktop?.openLogs?.()}
                      >
                        打开日志
                      </Button>
                    </div>
                  </div>
                )}
                {settings.embeddingKind === 'openai-compatible' && (
                  <>
                    <Label htmlFor="embedding-endpoint">向量端点</Label>
                    <Input
                      id="embedding-endpoint"
                      value={settings.embeddingEndpoint}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          embeddingEndpoint: e.target.value,
                        })
                      }
                      placeholder="https://api.openai.com/v1"
                    />
                    <Label htmlFor="embedding-model">向量模型名</Label>
                    <Input
                      id="embedding-model"
                      value={settings.embeddingModel}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          embeddingModel: e.target.value,
                        })
                      }
                      placeholder="text-embedding-3-small"
                    />
                    <Label htmlFor="embedding-key">向量 API Key</Label>
                    <Input
                      id="embedding-key"
                      type="password"
                      value={settings.embeddingApiKey}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          embeddingApiKey: e.target.value,
                        })
                      }
                      placeholder="sk-..."
                    />
                  </>
                )}
              </div>
              <DialogFooter>
                <Button onClick={saveSettings}>保存配置</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept="application/pdf,.pdf"
          onChange={(event) => void openPdf(event.target.files?.[0])}
        />
      </aside>

      <div className="workspace">
        <section className="reader-panel" aria-label="PDF 阅读区">
          {pdf ? (
            <>
              <button
                className={
                  regionSelectMode
                    ? 'region-select-toggle active'
                    : 'region-select-toggle'
                }
                onClick={() => {
                  setRegionSelectMode((current) => !current);
                  setSelectedRegion(null);
                  setError('');
                }}
                disabled={asking || Boolean(regionActionBusy)}
                aria-pressed={regionSelectMode}
                title="拖动框选 PDF 页面中的公式、表格、代码或文字"
              >
                <ScanSearch />
                <span>{regionSelectMode ? '拖动框选区域' : '框选精读'}</span>
                {regionSelectMode && <kbd>Esc</kbd>}
              </button>
              <div
                ref={readerScrollRef}
                className="canvas-wrap"
                onScroll={handleReaderScroll}
              >
                <div className="pdf-pages">
                  {Array.from({ length: pageCount }, (_, index) => {
                    const pageNumber = index + 1;
                    return (
                      <PdfPageCanvas
                        key={pageNumber}
                        pdf={pdf}
                        pageNumber={pageNumber}
                        activePage={page}
                        onText={handlePageText}
                        onError={handleRenderError}
                        selectionEnabled={regionSelectMode}
                        selectedRegion={
                          selectedRegion?.page === pageNumber
                            ? selectedRegion
                            : undefined
                        }
                        annotations={activeNotes.filter(
                          (note) =>
                            note.page === pageNumber && Boolean(note.region),
                        )}
                        regionActionBusy={
                          selectedRegion?.page === pageNumber
                            ? regionActionBusy
                            : null
                        }
                        onSelectionStart={() => setSelectedRegion(null)}
                        onRegionSelected={(selection) => {
                          setSelectedRegion(selection);
                          setRegionSelectMode(false);
                          revealPageIndicator();
                        }}
                        onRegionAction={(action) =>
                          void runRegionAction(action)
                        }
                        onSaveRegion={(kind) => void saveRegionAnnotation(kind)}
                        onAnnotationOpen={(note) => {
                          setWorkspaceKind(note.kind);
                          setWorkspaceQuery(note.title);
                          setWorkspaceOpen(true);
                        }}
                        onRegionClear={() => setSelectedRegion(null)}
                      />
                    );
                  })}
                </div>
              </div>
              <div
                className={
                  showPageIndicator
                    ? 'page-scroll-indicator visible'
                    : 'page-scroll-indicator'
                }
                aria-live="polite"
              >
                {page} / {pageCount}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                <Upload />
              </div>
              <p className="eyebrow">私密 · 本地阅读</p>
              <h1>
                打开一本 PDF，
                <br />
                开始深度阅读。
              </h1>
              <p>
                文档仅在你的浏览器中解析。AI
                会自动携带当前页内容，无需反复截图或复制。
              </p>
              <span className="file-note">
                点击左侧“书架”管理或导入 PDF · 文件不会上传
              </span>
            </div>
          )}
        </section>

        <aside className="ai-panel" aria-label="AI 阅读助手">
          <div className="ai-heading">
            <div className="ai-avatar">
              <Sparkles />
            </div>
            <div>
              <h2>阅读助手</h2>
              <p>{pdf ? `已同步第 ${page} 页` : '等待打开文档'}</p>
            </div>
            <div className="ai-heading-actions">
              <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
                <DialogTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="提问历史"
                      title="提问历史"
                    />
                  }
                >
                  <History />
                </DialogTrigger>
                <DialogContent className="history-dialog">
                  <DialogHeader>
                    <DialogTitle>提问历史</DialogTitle>
                    <DialogDescription>
                      历史已迁移到本机 SQLite；按需读取最近 50
                      条，支持跨书搜索和页码跳转。
                    </DialogDescription>
                  </DialogHeader>
                  <div className="workspace-search">
                    <Search />
                    <Input
                      value={historyQuery}
                      onChange={(event) => setHistoryQuery(event.target.value)}
                      placeholder="搜索问题或书名"
                      aria-label="搜索提问历史"
                    />
                  </div>
                  <div className="history-list">
                    {historyItems.length === 0 ? (
                      <p className="history-empty">还没有匹配的提问记录。</p>
                    ) : (
                      historyItems.map((message) => (
                        <button
                          className="history-item"
                          key={message.id}
                          onClick={() => void openHistoryRecord(message)}
                        >
                          <span>
                            <strong>{message.bookName}</strong>
                            <small>
                              第 {message.page} 页 ·{' '}
                              {new Date(message.createdAt).toLocaleString(
                                'zh-CN',
                              )}
                            </small>
                          </span>
                          <p>{message.content}</p>
                        </button>
                      ))
                    )}
                  </div>
                  <DialogFooter>
                    <span className="workspace-count">
                      显示 {historyItems.length} / {historyTotal} 条
                    </span>
                    {historyItems.length < historyTotal && (
                      <Button
                        variant="outline"
                        onClick={() => void loadMoreHistory()}
                      >
                        加载更多
                      </Button>
                    )}
                    {historyTotal > 0 && (
                      <Button
                        variant="outline"
                        onClick={() => void exportWorkspace(false)}
                      >
                        <Download />
                        导出全部 Markdown
                      </Button>
                    )}
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              <span className={pdf ? 'sync-badge active' : 'sync-badge'}>
                {pdf ? '已定位' : '未连接'}
              </span>
            </div>
          </div>
          <div className={activeKnowledgePack ? 'ai-scope pack' : 'ai-scope'}>
            <span>
              {activeKnowledgePack ? <Folder /> : <BookOpen />}
              <span>
                <small>当前问答范围</small>
                <strong>
                  {activeKnowledgePack
                    ? `${activeKnowledgePack.name} · ${activeKnowledgePack.bookIds.length} 本书`
                    : pdf
                      ? `当前书籍 · ${fileName}`
                      : '尚未选择书籍或知识包'}
                </strong>
              </span>
            </span>
            {activeKnowledgePack ? (
              <button onClick={() => void activateKnowledgePack(null)}>
                切回当前书籍
              </button>
            ) : (
              <button onClick={() => setKnowledgeOpen(true)}>选择知识包</button>
            )}
          </div>
          {activeKnowledgePack && (
            <details className="knowledge-filters">
              <summary>
                <span>
                  <Search />
                  检索筛选
                </span>
                <small>
                  {activeKnowledgePack.bookIds.length -
                    knowledgeExcludedBookIds.length}{' '}
                  本书
                  {knowledgePageFrom || knowledgePageTo
                    ? ` · 第 ${knowledgePageFrom || 1}–${knowledgePageTo || '末'} 页`
                    : ' · 全部页码'}
                </small>
              </summary>
              <div className="knowledge-filter-content">
                <div className="knowledge-filter-pages">
                  <Label htmlFor="knowledge-page-from">页码范围</Label>
                  <Input
                    id="knowledge-page-from"
                    type="number"
                    min="1"
                    value={knowledgePageFrom}
                    onChange={(event) =>
                      setKnowledgePageFrom(event.target.value)
                    }
                    placeholder="起始"
                  />
                  <span>至</span>
                  <Input
                    type="number"
                    min="1"
                    value={knowledgePageTo}
                    onChange={(event) => setKnowledgePageTo(event.target.value)}
                    placeholder="结束"
                    aria-label="检索结束页"
                  />
                  <button
                    onClick={() => {
                      setKnowledgePageFrom('');
                      setKnowledgePageTo('');
                      setKnowledgeExcludedBookIds([]);
                    }}
                  >
                    重置
                  </button>
                </div>
                <div className="knowledge-filter-books">
                  {activeKnowledgePack.bookIds.map((bookId) => {
                    const book = library.find((item) => item.id === bookId);
                    if (!book) return null;
                    const checked = !knowledgeExcludedBookIds.includes(bookId);
                    return (
                      <label key={bookId}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setKnowledgeExcludedBookIds((current) =>
                              checked
                                ? [...current, bookId]
                                : current.filter((id) => id !== bookId),
                            )
                          }
                        />
                        <span>{book.name}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </details>
          )}
          {activeKnowledgePack && knowledgeSearchStatus && (
            <p className="knowledge-search-status">
              <Search />
              {knowledgeSearchStatus}
            </p>
          )}
          {!activeKnowledgePack && pdf && (
            <div className={`index-strip ${indexStatus}`}>
              <div>
                <strong>
                  {indexStatus === 'ready'
                    ? '全文索引已就绪'
                    : indexStatus === 'indexing'
                      ? `后台索引 ${indexProgress}%`
                      : indexStatus === 'error'
                        ? '索引建立失败'
                        : activeBookTask?.status === 'paused'
                          ? '索引已暂停'
                          : '尚未建立全文索引'}
                </strong>
                <span title={indexMessage}>
                  {indexMessage ||
                    (settings.embeddingKind === 'local-qwen3-embedding-4b'
                      ? '本地 Qwen3-Embedding-4B · Q4_K_M'
                      : settings.embeddingModel)}
                </span>
                {indexStatus === 'indexing' && (
                  <span className="index-progress">
                    <i style={{ width: `${indexProgress}%` }} />
                  </span>
                )}
              </div>
              <Button
                variant={indexStatus === 'ready' ? 'ghost' : 'outline'}
                size="sm"
                onClick={() =>
                  indexStatus === 'indexing' ? stopIndexing() : buildIndex()
                }
              >
                {indexStatus === 'ready'
                  ? '重新索引'
                  : indexStatus === 'indexing'
                    ? '暂停'
                    : indexStatus === 'error'
                      ? '重试'
                      : hasIndexCheckpoint ||
                          activeBookTask?.status === 'paused'
                        ? '继续索引'
                        : '建立索引'}
              </Button>
            </div>
          )}
          {scanWarning && <p className="scan-warning">{scanWarning}</p>}
          {(pdf || activeKnowledgePack) &&
            (settings.glmOcrMode === 'auto' || deepReadStatus) && (
              <p
                className={
                  deepReadStatus.includes('失败')
                    ? 'deep-read-status error'
                    : 'deep-read-status'
                }
              >
                <Sparkles />
                {deepReadStatus || 'GLM-OCR 已待命 · 复杂页面将自动精读'}
              </p>
            )}
          <div
            className="chat-area"
            ref={chatAreaRef}
            onScroll={handleChatScroll}
          >
            {messages.length === 0 ? (
              <div className="chat-welcome">
                <MessageSquareText />
                <h3>
                  {activeKnowledgePack ? '跨书问答已就绪' : '我会跟着你的页码'}
                </h3>
                <p>
                  {activeKnowledgePack
                    ? `只会检索“${activeKnowledgePack.name}”中由你选定的 ${activeKnowledgePack.bookIds.length} 本书。`
                    : pdf
                      ? '直接提问，我会优先根据当前页原文解释。'
                      : '打开 PDF 后，这里会自动获取你当前阅读的页面。'}
                </p>
              </div>
            ) : (
              <div className="messages" aria-live="polite">
                {messages.map((message, index) => {
                  const thinking =
                    message.role === 'assistant' &&
                    !message.content &&
                    asking &&
                    index === messages.length - 1;
                  return (
                    <div
                      className={`message ${message.role}`}
                      key={`${message.page}-${index}`}
                    >
                      <span>
                        {message.role === 'assistant' ? (
                          <Bot />
                        ) : (
                          `P.${message.page}`
                        )}
                      </span>
                      <div className="message-body">
                        {thinking ? (
                          <p className="thinking">
                            <i />
                            <i />
                            <i />
                          </p>
                        ) : message.role === 'assistant' ? (
                          <MarkdownMessage content={message.content} />
                        ) : (
                          <p>{message.content}</p>
                        )}
                        {message.role === 'assistant' &&
                          message.sources &&
                          message.sources.length > 0 && (
                            <div className="message-sources">
                              <strong>检索来源</strong>
                              <div>
                                {message.sources.map((source, sourceIndex) => (
                                  <button
                                    key={`${source.bookId}-${source.page}-${sourceIndex}`}
                                    onClick={() =>
                                      void openKnowledgeSource(source)
                                    }
                                    title={source.excerpt}
                                  >
                                    <FileText />
                                    <span>
                                      《{source.bookName}》· 第 {source.page} 页
                                    </span>
                                    <small>{source.score.toFixed(2)}</small>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        <div className="message-meta-actions">
                          {message.citation && (
                            <button
                              className="message-citation"
                              onClick={() => revealCitation(message.citation!)}
                            >
                              <ScanSearch />第 {message.citation.page} 页 ·
                              查看框选来源
                            </button>
                          )}
                          {message.role === 'assistant' &&
                            message.content &&
                            !message.sources?.length && (
                              <button
                                className="message-save-card"
                                onClick={() => void saveSummaryCard(message)}
                              >
                                <BookMarked />
                                存为摘要卡片
                              </button>
                            )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="composer-wrap">
            {error && <p className="error-message">{error}</p>}
            {workspaceNotice && (
              <button
                className="workspace-notice"
                onClick={() => setWorkspaceNotice('')}
              >
                {workspaceNotice}
              </button>
            )}
            <div className="quick-prompts">
              {quickPrompts.map((prompt) => (
                <button
                  key={prompt}
                  onClick={() => void askAi(undefined, prompt)}
                  disabled={(!pdf && !activeKnowledgePack) || asking}
                >
                  {prompt}
                </button>
              ))}
            </div>
            <form className="composer" onSubmit={(event) => void askAi(event)}>
              <Textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void askAi();
                  }
                }}
                disabled={(!pdf && !activeKnowledgePack) || asking}
                placeholder={
                  activeKnowledgePack
                    ? `向“${activeKnowledgePack.name}”中的 ${activeKnowledgePack.bookIds.length} 本书提问…`
                    : pdf
                      ? `针对第 ${page} 页提问…`
                      : '请先打开 PDF 或选择知识包'
                }
                aria-label="输入问题"
              />
              <Button
                type="submit"
                size="icon-lg"
                disabled={
                  (!pdf && !activeKnowledgePack) || !question.trim() || asking
                }
                aria-label="发送"
              >
                <Send />
              </Button>
            </form>
            <p className="privacy-note">
              {activeKnowledgePack
                ? '知识包只检索你勾选的书；来源可点击回到原书页。'
                : '普通提问仅发送文本；框选精读只把裁剪区域交给 GLM-OCR，不发送整页图片。'}
            </p>
          </div>
        </aside>
      </div>
    </main>
  );
}
