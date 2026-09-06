'use client';

import { SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Bot, FileText, HardDrive, History, Library, MessageSquareText, PanelLeftClose, PanelLeftOpen, Plus, Send, Settings2, Sparkles, Trash2, Upload } from 'lucide-react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
// oxlint-disable-next-line import/default -- Vite's ?url loader provides this synthetic default export.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { chunkPage } from '@/lib/rag/chunk';
import { recognizeWithGlmOcr, selectDeepReadCandidates } from '@/lib/rag/deep-reading';
import type { DeepReadMode } from '@/lib/rag/deep-reading';
import { MemoryVectorIndex } from '@/lib/rag/memory-index';
import { createEmbeddingProvider } from '@/lib/rag/providers';
import type { EmbeddingProvider, EmbeddingProviderKind, RagChunk, RagMatch } from '@/lib/rag/types';
import type { LibraryEntry, ModelInstallStatus } from '@/types/electron';

type Message = { role: 'user' | 'assistant'; content: string; page: number; createdAt?: string };
type ChatHistoryRecord = { bookId: string; bookName: string; messages: Message[]; updatedAt: string };
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
  glmOcrEndpoint: string;
  glmOcrModel: string;
  glmOcrApiKey: string;
};
const DEFAULT_SETTINGS: ModelSettings = {
  endpoint: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: '',
  systemPrompt: '你是一位严谨的中文阅读助手。优先依据当前页原文回答；原文不足时明确说明，不要捏造。回答简洁、有条理。',
  embeddingKind: 'local-qwen3-embedding-4b', embeddingEndpoint: 'https://api-inference.modelscope.cn/v1',
  embeddingModel: 'text-embedding-3-small', embeddingApiKey: '',
  ocrMode: 'auto', ocrLanguage: 'chi_sim+eng',
  glmOcrMode: 'off', glmOcrEndpoint: 'http://127.0.0.1:11434/v1', glmOcrModel: 'glm-ocr:latest', glmOcrApiKey: '',
};
const quickPrompts = ['总结本页', '解释核心概念', '精读本页公式/代码'];
const CHAT_HISTORY_KEY = 'margin-chat-history-v1';

function readSavedSettings(): ModelSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('margin-ai-settings') ?? '{}') }; }
  catch { return DEFAULT_SETTINGS; }
}

function readChatHistory(): ChatHistoryRecord[] {
  if (typeof window === 'undefined') return [];
  try {
    const value = JSON.parse(localStorage.getItem(CHAT_HISTORY_KEY) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function readShelfCollapsed() {
  return typeof window !== 'undefined' && localStorage.getItem('margin-bookshelf-collapsed') === 'true';
}

async function renderPageImage(pdfPage: PDFPageProxy, format: 'png' | 'jpeg' = 'png'): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const scale = Math.max(1.5, Math.min(2.5, 2000 / Math.max(baseViewport.width, baseViewport.height)));
  const viewport = pdfPage.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法创建 OCR 页面画布');
  await pdfPage.render({ canvas, canvasContext: context, viewport, background: '#ffffff' }).promise;
  const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('无法编码识别页面')), mimeType, format === 'jpeg' ? 0.92 : undefined));
  canvas.width = 1;
  canvas.height = 1;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mimeType };
}

type PdfPageCanvasProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  activePage: number;
  onText: (pageNumber: number, text: string) => void;
  onError: (message: string) => void;
};

function PdfPageCanvas({ pdf, pageNumber, activePage, onText, onError }: PdfPageCanvasProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(760);
  const [pageRatio, setPageRatio] = useState(1 / 1.414);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const root = shell.closest('.canvas-wrap');
    const observer = new IntersectionObserver((entries) => {
      setNearViewport(entries.some((entry) => entry.isIntersecting));
    }, { root, rootMargin: '800px 0px' });
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
      const scale = Math.min(2, Math.max(0.5, (availableWidth - 32) / baseViewport.width));
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      await renderTask.promise;
      const content = await pdfPage.getTextContent();
      if (!cancelled) onText(pageNumber, content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim());
    }
    renderPage().catch((reason) => {
      if (reason?.name !== 'RenderingCancelledException') onError(`第 ${pageNumber} 页渲染失败。`);
    });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [availableWidth, onError, onText, pageNumber, pdf, shouldRender]);

  return <div ref={shellRef} className="pdf-page" style={{ aspectRatio: pageRatio }} data-page={pageNumber} aria-label={`PDF 第 ${pageNumber} 页`}>
    <canvas ref={canvasRef} />
    <span className="pdf-page-number">{pageNumber}</span>
  </div>;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readerScrollRef = useRef<HTMLDivElement>(null);
  const pageTextsRef = useRef(new Map<number, string>());
  const visiblePagesRef = useRef(new Map<number, number>());
  const vectorIndexRef = useRef(new MemoryVectorIndex());
  const embeddingProviderRef = useRef<EmbeddingProvider | null>(null);
  const chatAreaRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const indexAbortRef = useRef(false);
  const deepReadCacheRef = useRef(new Map<string, string>());
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
  const [indexStatus, setIndexStatus] = useState<'idle' | 'indexing' | 'ready' | 'error'>('idle');
  const [indexProgress, setIndexProgress] = useState(0);
  const [indexMessage, setIndexMessage] = useState('');
  const [settings, setSettings] = useState<ModelSettings>(readSavedSettings);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [activeBookId, setActiveBookId] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<ModelInstallStatus | null>(null);
  const [scanWarning, setScanWarning] = useState('');
  const [deepReadStatus, setDeepReadStatus] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [chatModelList, setChatModelList] = useState<string[]>([]);
  const [chatModelListLoading, setChatModelListLoading] = useState(false);
  const [chatModelListError, setChatModelListError] = useState('');
  const [bookshelfCollapsed, setBookshelfCollapsed] = useState(readShelfCollapsed);
  const [chatHistory, setChatHistory] = useState<ChatHistoryRecord[]>(readChatHistory);

  const saveChatHistory = useCallback((bookId: string, bookName: string, nextMessages: Message[]) => {
    if (!bookId || nextMessages.length === 0) return;
    setChatHistory((current) => {
      const record = { bookId, bookName, messages: nextMessages.slice(-100), updatedAt: new Date().toISOString() };
      const next = [record, ...current.filter((entry) => entry.bookId !== bookId)].slice(0, 50);
      localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const toggleBookshelf = () => {
    setBookshelfCollapsed((current) => {
      localStorage.setItem('margin-bookshelf-collapsed', String(!current));
      return !current;
    });
  };

  const scrollToPage = useCallback((target: number, behavior: ScrollBehavior = 'smooth') => {
    const container = readerScrollRef.current;
    const pageElement = container?.querySelector<HTMLElement>(`.pdf-page[data-page="${target}"]`);
    if (!container || !pageElement) return;
    container.scrollTo({ top: Math.max(0, pageElement.offsetTop - 18), behavior });
    setPage(target);
  }, []);

  const handlePageText = useCallback((pageNumber: number, text: string) => {
    pageTextsRef.current.set(pageNumber, text);
  }, []);

  const handleRenderError = useCallback((message: string) => setError(message), []);

  const refreshLibrary = useCallback(async () => {
    if (!window.marginDesktop?.libraryList) return;
    setLibrary(await window.marginDesktop.libraryList());
  }, []);

  useEffect(() => {
    window.queueMicrotask(() => void refreshLibrary());
  }, [refreshLibrary]);

  useEffect(() => {
    const bridge = window.marginDesktop;
    if (!bridge?.modelStatus) return;
    window.queueMicrotask(() => void bridge.modelStatus?.().then(setModelStatus));
    window.queueMicrotask(() => void bridge.appInfo?.().then((info) => setAppVersion(info.version)));
    return bridge.onModelProgress?.((progress) => {
      setModelStatus((current) => current ? { ...current, ...progress } : current);
    });
  }, []);

  useEffect(() => {
    const el = chatAreaRef.current;
    if (el && autoScrollRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleChatScroll = () => {
    const el = chatAreaRef.current;
    if (!el) return;
    autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  useEffect(() => {
    if (!activeBookId || !page || !window.marginDesktop?.libraryUpdate) return;
    const timeout = window.setTimeout(() => {
      void window.marginDesktop?.libraryUpdate?.(activeBookId, { lastPage: page }).then((entry) => {
        setLibrary((current) => current.map((book) => book.id === entry.id ? entry : book));
      });
    }, 600);
    return () => window.clearTimeout(timeout);
  }, [activeBookId, page]);

  useEffect(() => {
    const modelContext = (document as Document & {
      modelContext?: {
        registerTool: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void>;
      };
    }).modelContext;
    if (!modelContext?.registerTool || !pdf) return;
    const lifecycle = new AbortController();
    void Promise.resolve(modelContext.registerTool({
      name: 'navigate_to_pdf_page',
      title: '跳转到 PDF 页码',
      description: '在当前已打开的 PDF 中跳转到指定页，并同步阅读助手的当前页上下文。',
      inputSchema: {
        type: 'object',
        properties: { page: { type: 'integer', minimum: 1, maximum: pageCount } },
        required: ['page'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        const target = (input as { page?: unknown })?.page;
        if (!Number.isInteger(target) || (target as number) < 1 || (target as number) > pageCount) throw new Error(`页码必须在 1 到 ${pageCount} 之间。`);
        scrollToPage(target as number);
        return { page: target, pageCount, status: 'navigated' };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [pdf, pageCount, scrollToPage]);

  useEffect(() => {
    const root = readerScrollRef.current;
    if (!pdf || !root) return;
    visiblePagesRef.current.clear();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) visiblePagesRef.current.set(Number((entry.target as HTMLElement).dataset.page), entry.intersectionRatio);
      let nextPage = 1;
      let bestRatio = 0;
      for (const [pageNumber, ratio] of visiblePagesRef.current) {
        if (ratio > bestRatio) { nextPage = pageNumber; bestRatio = ratio; }
      }
      if (bestRatio > 0) setPage((current) => current === nextPage ? current : nextPage);
    }, { root, threshold: [0, 0.15, 0.35, 0.55, 0.75] });
    for (const element of root.querySelectorAll('.pdf-page')) observer.observe(element);
    return () => observer.disconnect();
  }, [pdf, pageCount]);

  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    async function updatePageText() {
      const cached = pageTextsRef.current.get(page);
      if (cached !== undefined) { setPageText(cached); return; }
      const pdfPage = await pdf!.getPage(page);
      const text = await pdfPage.getTextContent();
      const normalized = text.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim();
      pageTextsRef.current.set(page, normalized);
      if (!cancelled) setPageText(normalized);
    }
    updatePageText().catch(() => { if (!cancelled) setPageText(''); });
    return () => { cancelled = true; };
  }, [pdf, page]);

  function createConfiguredProvider() {
    return createEmbeddingProvider({
      kind: settings.embeddingKind,
      endpoint: settings.embeddingEndpoint,
      model: settings.embeddingModel,
      apiKey: settings.embeddingApiKey,
    });
  }

  async function loadPdf(data: ArrayBuffer | Uint8Array | string, name: string, book?: LibraryEntry) {
    setLoadingPdf(true); setError('');
    try {
      const pdfJs = await import('pdfjs-dist');
      pdfJs.GlobalWorkerOptions.workerSrc = new URL(pdfWorkerUrl, window.location.href).toString();
      const source = typeof data === 'string' ? { url: data } : { data: data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data) };
      const document = await pdfJs.getDocument(source).promise;
      vectorIndexRef.current.clear(); embeddingProviderRef.current = null;
      pageTextsRef.current.clear();
      deepReadCacheRef.current.clear();
      setDeepReadStatus(settings.glmOcrMode === 'auto' ? 'GLM-OCR 已待命，将按需精读公式、代码与表格页' : '');
      setScanWarning('');
      setIndexStatus('idle'); setIndexProgress(0); setIndexMessage('');
      const initialPage = Math.min(document.numPages, Math.max(1, book?.lastPage || 1));
      setPdf(document); setFileName(name); setPageCount(document.numPages); setPage(initialPage); setActiveBookId(book?.id || null);
      setMessages(book ? chatHistory.find((entry) => entry.bookId === book.id)?.messages ?? [] : []);
      if (book && window.marginDesktop?.libraryUpdate) {
        const updated = await window.marginDesktop.libraryUpdate(book.id, { pageCount: document.numPages, lastPage: initialPage });
        setLibrary((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      }
      if (book && window.marginDesktop?.libraryIndexOpen) {
        try {
          const provider = createConfiguredProvider();
          const stored = await window.marginDesktop.libraryIndexOpen(book.id, provider.id);
          if (stored) {
            embeddingProviderRef.current = provider;
            const size = `${(stored.bytes / 1024 / 1024).toFixed(1)} MB`;
            setIndexStatus('ready'); setIndexProgress(100); setIndexMessage(`${stored.migrated ? '旧 JSON 已迁移 · ' : ''}SQLite Float32 · ${stored.chunks} 个片段 · ${size}`);
          }
        } catch { /* A changed or incomplete provider simply requires rebuilding the index. */ }
      }
      window.setTimeout(() => scrollToPage(initialPage, 'auto'), 0);
    } catch (reason) {
      console.error('Failed to open PDF', reason);
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`无法打开这个 PDF：${detail.slice(0, 160)}`);
    }
    finally { setLoadingPdf(false); }
  }

  async function openPdf(file?: File) {
    if (!file) return;
    try {
      if (window.marginDesktop?.libraryImportFile) {
        const entry = await window.marginDesktop.libraryImportFile(file);
        setLibrary((current) => [entry, ...current]);
        await loadPdf(`margin://app/library/${entry.id}/document.pdf`, entry.name, entry);
      } else {
        await loadPdf(await file.arrayBuffer(), file.name);
      }
    } catch (reason) {
      setError(`导入书架失败：${reason instanceof Error ? reason.message.slice(0, 160) : '未知错误'}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }

  async function openLibraryBook(book: LibraryEntry) {
    if (!window.marginDesktop || loadingPdf) return;
    try {
      await loadPdf(`margin://app/library/${book.id}/document.pdf`, book.name, book);
    } catch (reason) {
      setError(`无法从书架打开：${reason instanceof Error ? reason.message.slice(0, 160) : '未知错误'}`);
    }
  }

  async function openHistoryRecord(record: ChatHistoryRecord, message: Message) {
    const book = library.find((entry) => entry.id === record.bookId);
    if (book && book.id !== activeBookId) {
      await openLibraryBook(book);
      window.setTimeout(() => scrollToPage(message.page), 0);
      return;
    }
    if (record.bookId === activeBookId || record.bookId === fileName) {
      setMessages(record.messages);
      scrollToPage(message.page);
    }
  }

  async function removeLibraryBook(book: LibraryEntry) {
    if (!window.marginDesktop?.libraryRemove || !window.confirm(`从本地书架移除《${book.name}》？PDF 副本与已保存索引会从 Margin 数据目录删除。`)) return;
    try {
      await window.marginDesktop.libraryRemove(book.id);
      setLibrary((current) => current.filter((entry) => entry.id !== book.id));
      setChatHistory((current) => {
        const next = current.filter((entry) => entry.bookId !== book.id);
        localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
        return next;
      });
      if (activeBookId === book.id) {
        await pdf?.destroy();
        vectorIndexRef.current.clear(); embeddingProviderRef.current = null; pageTextsRef.current.clear(); deepReadCacheRef.current.clear();
        setPdf(null); setFileName(''); setPage(1); setPageCount(0); setPageText(''); setActiveBookId(null); setMessages([]); setIndexStatus('idle'); setIndexProgress(0); setIndexMessage(''); setScanWarning(''); setDeepReadStatus('');
      }
    } catch (reason) {
      setError(`移除失败：${reason instanceof Error ? reason.message.slice(0, 160) : '未知错误'}`);
    }
  }

  function saveSettings() {
    const previous = readSavedSettings();
    // Only the vector/embedding configuration changes which vectors are produced,
    // so only those changes invalidate an already-built index. Chat-only or even
    // a no-op save should never discard the current index.
    const vectorConfigChanged = previous.embeddingKind !== settings.embeddingKind
      || previous.embeddingEndpoint !== settings.embeddingEndpoint
      || previous.embeddingModel !== settings.embeddingModel;
    const deepReadConfigChanged = previous.glmOcrMode !== settings.glmOcrMode
      || previous.glmOcrEndpoint !== settings.glmOcrEndpoint
      || previous.glmOcrModel !== settings.glmOcrModel;
    localStorage.setItem('margin-ai-settings', JSON.stringify(settings));
    if (vectorConfigChanged) {
      vectorIndexRef.current.clear(); embeddingProviderRef.current = null;
      setIndexStatus('idle'); setIndexProgress(0); setIndexMessage('向量模型配置已变化，请重新建立索引');
    }
    if (deepReadConfigChanged) deepReadCacheRef.current.clear();
    setDeepReadStatus(settings.glmOcrMode === 'auto' ? 'GLM-OCR 已待命，将按需精读公式、代码与表格页' : '');
  }

  async function fetchChatModelList() {
    const endpoint = settings.endpoint.trim().replace(/\/+$/, '');
    const apiKey = settings.apiKey.trim();
    if (!endpoint || !apiKey) {
      setChatModelList([]); setChatModelListError('请先填写端点地址与 API Key。');
      return;
    }
    setChatModelListLoading(true); setChatModelListError(''); setChatModelList([]);
    try {
      const response = await fetch(`${endpoint}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const payload = await response.json() as { data?: Array<{ id: string }>; models?: Array<{ id: string }> };
      const ids = Array.isArray(payload.data) ? payload.data.map((item) => item.id) : Array.isArray(payload.models) ? payload.models.map((item) => item.id) : [];
      if (ids.length === 0) throw new Error('端点未返回可用模型');
      setChatModelList(ids);
    } catch (reason) {
      setChatModelListError(`获取模型列表失败：${reason instanceof Error ? reason.message.slice(0, 140) : '请检查端点与密钥'}`);
    } finally {
      setChatModelListLoading(false);
    }
  }

  async function installLocalModel() {
    if (!window.marginDesktop?.modelInstall) return;
    setError('');
    try {
      await window.marginDesktop.modelInstall();
      setModelStatus(await window.marginDesktop.modelStatus?.() ?? null);
    } catch (reason) {
      setError(`模型安装失败：${reason instanceof Error ? reason.message.slice(0, 180) : '未知错误'}`);
    }
  }

  async function removeLocalModel() {
    if (!window.marginDesktop?.modelRemove || !window.confirm('确认卸载本地向量模型？已保存的索引仍会保留，但无法检索，直到重新安装模型。')) return;
    setModelStatus(await window.marginDesktop.modelRemove());
    vectorIndexRef.current.clear(); embeddingProviderRef.current = null; setIndexStatus('idle'); setIndexMessage('本地模型已卸载');
  }

  async function releaseModelMemory() {
    if (!window.marginDesktop?.modelUnload) return;
    setModelStatus(await window.marginDesktop.modelUnload());
  }

  async function buildIndex() {
    if (!pdf || indexStatus === 'indexing') return;
    indexAbortRef.current = false;
    setError(''); setIndexStatus('indexing'); setIndexProgress(0); setIndexMessage('正在提取 PDF 文本');
    let phase = 'starting';
    let persistentBuildStarted = false;
    window.marginDesktop?.logEvent?.('index-started', {
      bookId: activeBookId,
      fileName,
      pageCount: pdf.numPages,
      embeddingKind: settings.embeddingKind,
    });
    try {
      if (settings.embeddingKind === 'local-qwen3-embedding-4b' && window.marginDesktop?.modelPrepare) {
        phase = 'model-prepare';
        setIndexMessage('正在检查本地模型与运行时');
        const unsubscribe = window.marginDesktop.onModelProgress?.((progress) => {
          if (progress.state === 'downloading') setIndexMessage(`正在下载本地向量模型：${progress.progress}%`);
          else if (progress.state === 'installing') setIndexMessage('正在安装 llama.cpp 运行时');
          else if (progress.state === 'checking') setIndexMessage('正在校验本地文件');
        });
        try {
          setModelStatus(await window.marginDesktop.modelPrepare());
        } finally {
          unsubscribe?.();
        }
      }
      phase = 'text-extraction';
      const provider = createConfiguredProvider();
      embeddingProviderRef.current = provider;
      vectorIndexRef.current.clear();
      const allChunks: RagChunk[] = [];
      let emptyPages = 0;
      let ocrPages = 0;
      let ocrFailures = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        if (indexAbortRef.current) throw new DOMException('索引已由用户停止', 'AbortError');
        const pdfPage = await pdf.getPage(pageNumber);
        const content = await pdfPage.getTextContent();
        let text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim();
        if (!text && settings.ocrMode === 'auto' && window.marginDesktop?.ocrRecognize) {
          phase = 'ocr';
          setIndexMessage(`正在 OCR：第 ${pageNumber} / ${pdf.numPages} 页`);
          const unsubscribe = window.marginDesktop.onOcrProgress?.((progress) => setIndexMessage(`正在 OCR：第 ${pageNumber} / ${pdf.numPages} 页 · ${progress.progress}%`));
          try {
            const image = await renderPageImage(pdfPage);
            const result = await window.marginDesktop.ocrRecognize(image.bytes, settings.ocrLanguage);
            text = result.text;
            if (text) {
              ocrPages += 1;
              pageTextsRef.current.set(pageNumber, text);
              if (pageNumber === page) setPageText(text);
            } else ocrFailures += 1;
          } catch (reason) {
            ocrFailures += 1;
            window.marginDesktop?.logEvent?.('ocr-page-failed', { bookId: activeBookId, page: pageNumber, message: reason instanceof Error ? reason.message : String(reason) }, 'error');
          } finally {
            unsubscribe?.();
          }
        }
        if (!text) emptyPages += 1;
        allChunks.push(...chunkPage(text, pageNumber));
        setIndexProgress(Math.round((pageNumber / pdf.numPages) * 35));
        setIndexMessage(`正在提取文本：第 ${pageNumber} / ${pdf.numPages} 页${ocrPages ? ` · OCR ${ocrPages} 页` : ''}`);
      }
      if (allChunks.length === 0) throw new Error(settings.ocrMode === 'off' ? '这个 PDF 没有可提取文本；请在模型设置中启用 OCR。' : 'OCR 完成，但没有识别出可索引文本。请尝试切换 OCR 语言或使用更清晰的扫描件。');
      window.marginDesktop?.logEvent?.('index-text-extracted', { bookId: activeBookId, chunks: allChunks.length, emptyPages, ocrPages, ocrFailures });
      phase = 'embedding';
      // llama.cpp exposes four embedding slots; feeding all four together keeps the
      // model busy without increasing the resident model footprint.
      const batchSize = settings.embeddingKind === 'local-qwen3-embedding-4b' ? 4 : 16;
      for (let start = 0; start < allChunks.length; start += batchSize) {
        if (indexAbortRef.current) throw new DOMException('索引已由用户停止', 'AbortError');
        const chunks = allChunks.slice(start, start + batchSize);
        const vectors = await provider.embed(chunks.map((chunk) => chunk.text), 'document');
        if (vectors.length !== chunks.length || !vectors[0]?.length) throw new Error('向量模型返回了无效批次');
        if (activeBookId && window.marginDesktop?.libraryIndexStart && window.marginDesktop.libraryIndexAppend && window.marginDesktop.libraryIndexFinish) {
          if (!persistentBuildStarted) {
            await window.marginDesktop.libraryIndexStart(activeBookId, provider.id, vectors[0].length);
            persistentBuildStarted = true;
          }
          await window.marginDesktop.libraryIndexAppend(activeBookId, chunks.map((chunk, index) => ({ ...chunk, vector: Float32Array.from(vectors[index]) })));
        } else {
          vectorIndexRef.current.addVectors(chunks, vectors);
        }
        setIndexProgress(35 + Math.round((Math.min(start + batchSize, allChunks.length) / Math.max(allChunks.length, 1)) * 65));
        setIndexMessage(`正在生成向量：${Math.min(start + batchSize, allChunks.length)} / ${allChunks.length} 个片段`);
      }
      setScanWarning(emptyPages > 0 ? `${ocrPages > 0 ? `OCR 已识别 ${ocrPages} 页；` : ''}仍有 ${emptyPages} 页没有可提取文本。${ocrFailures ? ` ${ocrFailures} 页识别失败。` : ''}` : ocrPages > 0 ? `OCR 已识别并索引 ${ocrPages} 个扫描页。` : '');
      let persistedInfo;
      if (persistentBuildStarted && activeBookId && window.marginDesktop?.libraryIndexFinish) {
        phase = 'persistence';
        setIndexMessage('正在完成 SQLite 索引');
        persistedInfo = await window.marginDesktop.libraryIndexFinish(activeBookId);
        persistentBuildStarted = false;
        await refreshLibrary();
      }
      const storageLabel = persistedInfo ? ` · SQLite ${(persistedInfo.bytes / 1024 / 1024).toFixed(1)} MB` : '';
      setIndexStatus('ready'); setIndexProgress(100); setIndexMessage(`索引完成：${allChunks.length} 个片段${storageLabel}${ocrPages ? ` · OCR ${ocrPages} 页` : ''}`);
      window.marginDesktop?.logEvent?.('index-succeeded', {
        bookId: activeBookId,
        providerId: provider.id,
        chunks: allChunks.length,
        persisted: Boolean(activeBookId),
      });
      if (settings.embeddingKind === 'local-qwen3-embedding-4b') setModelStatus(await window.marginDesktop?.modelStatus?.() ?? modelStatus);
    } catch (reason) {
      if (persistentBuildStarted && activeBookId) await window.marginDesktop?.libraryIndexCancel?.(activeBookId).catch(() => undefined);
      const message = reason instanceof Error ? reason.message.slice(0, 180) : '未知错误';
      window.marginDesktop?.logEvent?.('index-failed', { bookId: activeBookId, phase, message }, 'error');
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        setIndexStatus('idle'); setIndexProgress(0); setIndexMessage('索引已停止，原有索引未被覆盖');
      } else {
        setIndexStatus('error'); setIndexMessage(message);
        setError(`建立索引失败：${message}`);
      }
    }
  }

  function stopIndexing() {
    indexAbortRef.current = true;
    setIndexMessage('正在安全停止，当前步骤完成后退出…');
  }

  async function createDeepReadContext(matches: RagMatch[], prompt: string) {
    if (!pdf || settings.glmOcrMode === 'off') return '';
    const candidates = selectDeepReadCandidates(page, pageText, matches, prompt, 2);
    if (candidates.length === 0) {
      setDeepReadStatus('GLM-OCR 待命 · 本次未检测到复杂页面');
      return '';
    }
    setDeepReadStatus(`GLM-OCR 正在精读第 ${candidates.map((candidate) => candidate.page).join('、')} 页…`);
    const results: string[] = [];
    for (const candidate of candidates) {
      const cacheKey = `${activeBookId ?? fileName}:${candidate.page}:${candidate.task}:${settings.glmOcrEndpoint}:${settings.glmOcrModel}`;
      let recognized = deepReadCacheRef.current.get(cacheKey);
      if (!recognized) {
        const pdfPage = await pdf.getPage(candidate.page);
        const image = await renderPageImage(pdfPage, 'jpeg');
        const result = await recognizeWithGlmOcr({ endpoint: settings.glmOcrEndpoint, model: settings.glmOcrModel, apiKey: settings.glmOcrApiKey }, image.bytes, image.mimeType, candidate.task);
        recognized = result.text;
        deepReadCacheRef.current.set(cacheKey, recognized);
      }
      results.push(`[GLM-OCR 精读第 ${candidate.page} 页 · ${candidate.reasons.join('、')}]\n${recognized.slice(0, 12000)}`);
    }
    setDeepReadStatus(`GLM-OCR 已精读 ${candidates.length} 页 · 结果已加入回答上下文`);
    window.marginDesktop?.logEvent?.('glm-ocr-deep-read-succeeded', { bookId: activeBookId, pages: candidates.map((candidate) => candidate.page), tasks: candidates.map((candidate) => candidate.task) });
    return results.join('\n\n');
  }

  async function askAi(event?: SyntheticEvent<HTMLFormElement>, preset?: string) {
    event?.preventDefault();
    const prompt = (preset ?? question).trim();
    if (!prompt || !pdf || asking) return;
    if (!settings.apiKey.trim()) { setError('请先在模型设置中填入 API Key。'); return; }
    const askedAt = new Date().toISOString();
    const userMessage: Message = { role: 'user', content: prompt, page, createdAt: askedAt };
    const assistantMessage: Message = { role: 'assistant', content: '', page, createdAt: askedAt };
    const previousMessages = messages;
    setQuestion(''); setError(''); setAsking(true);
    // Reserve a placeholder assistant bubble immediately so the user sees a
    // thinking indicator and the scroll area keeps the composer visible.
    setMessages((current) => [...current, userMessage, assistantMessage]);
    try {
      let matches: RagMatch[] = [];
      if (indexStatus === 'ready' && embeddingProviderRef.current) {
        if (activeBookId && window.marginDesktop?.libraryIndexSearch) {
          const [queryVector] = await embeddingProviderRef.current.embed([prompt], 'query');
          matches = await window.marginDesktop.libraryIndexSearch(activeBookId, embeddingProviderRef.current.id, Float32Array.from(queryVector), 5);
        } else matches = await vectorIndexRef.current.search(prompt, embeddingProviderRef.current, 5);
      }
      let deepReadContext = '';
      if (settings.glmOcrMode === 'auto') {
        try {
          deepReadContext = await createDeepReadContext(matches, prompt);
        } catch (reason) {
          const message = reason instanceof Error ? reason.message.slice(0, 160) : '未知错误';
          setDeepReadStatus(`GLM-OCR 精读失败，已回退普通检索：${message}`);
          window.marginDesktop?.logEvent?.('glm-ocr-deep-read-failed', { bookId: activeBookId, message }, 'error');
        }
      }
      const ragContext = matches.length
        ? matches.map((match) => `[第 ${match.page} 页，相似度 ${match.score.toFixed(2)}]\n${match.text}`).join('\n\n')
        : '（尚未建立全文向量索引）';
      const response = await fetch(`${settings.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: settings.model, temperature: 0.3, stream: true,
          messages: [
            { role: 'system', content: settings.systemPrompt.trim() || DEFAULT_SETTINGS.systemPrompt },
            ...messages.slice(-6).map(({ role, content }) => ({ role, content })),
            { role: 'user', content: `我正在阅读第 ${page} 页。\n\n当前页原文：\n${pageText.slice(0, 12000) || '（此页未提取到可选文本，可能是扫描件）'}\n\n全文检索片段：\n${ragContext.slice(0, 12000)}\n\nGLM-OCR 视觉精读结果：\n${deepReadContext.slice(0, 16000) || '（本次未调用精读模型）'}\n\n请优先保留精读结果中的 LaTeX 公式、代码缩进与表格结构。\n\n我的问题：${prompt}` },
          ],
        }),
      });
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const contentType = response.headers.get('content-type') ?? '';
      let answerText = '';
      const emitChunk = (chunk: string) => {
        if (!chunk) return;
        answerText += chunk;
        const text = (existing: string) => `${existing}${chunk}`;
        setMessages((current) => {
          const next = [...current];
          const last = next[next.length - 1];
          if (last?.role === 'assistant') next[next.length - 1] = { ...last, content: text(last.content) };
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
              const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
              emitChunk(parsed.choices?.[0]?.delta?.content ?? '');
            } catch { /* ignore malformed keep-alive or partial line */ }
          }
        }
      } else {
        // Some providers ignore `stream: true` and return the whole JSON.
        const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        emitChunk(result.choices?.[0]?.message?.content ?? '');
      }
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && !last.content) next[next.length - 1] = { ...last, content: '（模型未返回文本）' };
        return next;
      });
      const savedAnswer = answerText || '（模型未返回文本）';
      saveChatHistory(activeBookId ?? fileName, fileName, [...previousMessages, userMessage, { ...assistantMessage, content: savedAnswer }]);
    } catch (reason) {
      setError(`AI 请求失败：${reason instanceof Error ? reason.message.slice(0, 160) : '请检查端点与密钥'}`);
      // Drop the empty assistant placeholder on failure; keep partial text if any.
      setMessages((current) => {
        const next = [...current];
        const last = next[next.length - 1];
        if (last?.role === 'assistant' && !last.content) next.pop();
        return next;
      });
    } finally { setAsking(false); }
  }

  const historyQuestions = chatHistory
    .flatMap((record) => record.messages.map((message, index) => ({ record, message, index })).filter(({ message }) => message.role === 'user'))
    .sort((a, b) => (b.message.createdAt ?? b.record.updatedAt).localeCompare(a.message.createdAt ?? a.record.updatedAt));

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><FileText /></span><span>页间 <em>Margin{appVersion ? ` v${appVersion}` : ''}</em></span></div>
        <div className="document-title"><span className={pdf ? 'status-dot online' : 'status-dot'} /><span>{fileName || '尚未打开文档'}</span></div>
        <div className="top-actions">
          <Dialog>
            <DialogTrigger render={<Button variant="ghost" size="icon-lg" aria-label="模型设置" />}><Settings2 /></DialogTrigger>
            <DialogContent className="settings-dialog">
              <DialogHeader><DialogTitle>模型设置</DialogTitle><DialogDescription>支持 OpenAI 兼容的 <code>/chat/completions</code> 端点。配置仅保存在本机浏览器。</DialogDescription></DialogHeader>
              <div className="settings-fields">
                <Label htmlFor="endpoint">端点地址</Label><Input id="endpoint" value={settings.endpoint} onChange={(e) => { setSettings({ ...settings, endpoint: e.target.value }); setChatModelList([]); setChatModelListError(''); }} placeholder="https://api.openai.com/v1" />
                <Label htmlFor="model">模型名称</Label>
                <div className="model-field">
                  <div className="model-field-row">
                    <Input className="flex-1 min-w-0" id="model" value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="gpt-5-mini" />
                    <Button size="sm" variant="outline" onClick={() => void fetchChatModelList()} disabled={!settings.endpoint.trim() || !settings.apiKey.trim() || chatModelListLoading}>{chatModelListLoading ? '获取中…' : '自动获取模型列表'}</Button>
                  </div>
                  {chatModelListError && <p className="field-error">{chatModelListError}</p>}
                  {chatModelList.length > 0 && (
                    <NativeSelect id="chat-model-list" className="w-full" value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })}>
                      <NativeSelectOption value="">从列表选择模型…</NativeSelectOption>
                      {chatModelList.map((id) => <NativeSelectOption key={id} value={id}>{id}</NativeSelectOption>)}
                    </NativeSelect>
                  )}
                </div>
                <Label htmlFor="api-key">API Key</Label><Input id="api-key" type="password" value={settings.apiKey} onChange={(e) => { setSettings({ ...settings, apiKey: e.target.value }); setChatModelList([]); setChatModelListError(''); }} placeholder="sk-..." />
                <Label htmlFor="system-prompt">系统提示词</Label><Textarea id="system-prompt" className="system-prompt-input" value={settings.systemPrompt} onChange={(e) => setSettings({ ...settings, systemPrompt: e.target.value })} rows={5} placeholder={DEFAULT_SETTINGS.systemPrompt} />
                <div className="settings-divider"><span>文档识别</span></div>
                <Label htmlFor="ocr-mode">扫描页 OCR</Label>
                <NativeSelect id="ocr-mode" className="w-full" value={settings.ocrMode} onChange={(e) => setSettings({ ...settings, ocrMode: e.target.value as ModelSettings['ocrMode'] })}>
                  <NativeSelectOption value="auto">自动识别无文本页面</NativeSelectOption>
                  <NativeSelectOption value="off">关闭 OCR</NativeSelectOption>
                </NativeSelect>
                {settings.ocrMode === 'auto' && <><Label htmlFor="ocr-language">OCR 语言</Label><NativeSelect id="ocr-language" className="w-full" value={settings.ocrLanguage} onChange={(e) => setSettings({ ...settings, ocrLanguage: e.target.value as ModelSettings['ocrLanguage'] })}><NativeSelectOption value="chi_sim+eng">简体中文 + English</NativeSelectOption><NativeSelectOption value="chi_tra+eng">繁体中文 + English</NativeSelectOption><NativeSelectOption value="eng">English</NativeSelectOption></NativeSelect><p className="settings-note">OCR 完全在本机运行，仅处理 PDF.js 无法提取文本的页面。首次使用会初始化随应用安装的 Tesseract 字库。</p></>}
                <div className="settings-divider"><span>公式、代码与表格精读</span></div>
                <Label htmlFor="glm-ocr-mode">精读模型</Label>
                <NativeSelect id="glm-ocr-mode" className="w-full" value={settings.glmOcrMode} onChange={(e) => setSettings({ ...settings, glmOcrMode: e.target.value as DeepReadMode })}>
                  <NativeSelectOption value="off">关闭（默认）</NativeSelectOption>
                  <NativeSelectOption value="auto">GLM-OCR · 向量命中后按需精读</NativeSelectOption>
                </NativeSelect>
                {settings.glmOcrMode === 'auto' && <>
                  <Label htmlFor="glm-ocr-endpoint">GLM-OCR 端点</Label><Input id="glm-ocr-endpoint" value={settings.glmOcrEndpoint} onChange={(e) => setSettings({ ...settings, glmOcrEndpoint: e.target.value })} placeholder="http://127.0.0.1:11434/v1" />
                  <Label htmlFor="glm-ocr-model">模型名称</Label><Input id="glm-ocr-model" value={settings.glmOcrModel} onChange={(e) => setSettings({ ...settings, glmOcrModel: e.target.value })} placeholder="glm-ocr:latest" />
                  <Label htmlFor="glm-ocr-key">API Key（本机可留空）</Label><Input id="glm-ocr-key" type="password" value={settings.glmOcrApiKey} onChange={(e) => setSettings({ ...settings, glmOcrApiKey: e.target.value })} placeholder="自托管服务通常可留空" />
                  <p className="settings-note">支持 GLM-OCR 的 OpenAI-compatible 服务（Ollama、vLLM 或 SGLang）。系统最多把 2 个向量命中页作为图片送去精读；远程端点会接收这些页面。<a href="https://github.com/zai-org/GLM-OCR" target="_blank" rel="noreferrer">查看官方部署说明</a></p>
                </>}
                <div className="settings-divider"><span>向量检索</span></div>
                <Label htmlFor="embedding-kind">向量模型</Label>
                <NativeSelect id="embedding-kind" className="w-full" value={settings.embeddingKind} onChange={(e) => setSettings({ ...settings, embeddingKind: e.target.value as EmbeddingProviderKind })}>
                  <NativeSelectOption value="local-qwen3-embedding-4b">本地 Qwen3-Embedding-4B（Q4_K_M）</NativeSelectOption>
                  <NativeSelectOption value="openai-compatible">OpenAI 兼容提供商</NativeSelectOption>
                </NativeSelect>
                {settings.embeddingKind === 'local-qwen3-embedding-4b' && <div className="model-manager">
                  <div className="model-manager-status"><span className={modelStatus?.installed ? 'status-dot online' : 'status-dot'} /><div><strong>{modelStatus?.loaded ? '模型已载入内存' : modelStatus?.installed ? '本地模型已就绪' : modelStatus?.state === 'paused' ? '下载已暂停' : '尚未安装本地模型'}</strong><small>{modelStatus?.message || (modelStatus?.missing?.length ? `缺少：${modelStatus.missing.join('、')}` : modelStatus?.loaded ? `${modelStatus.backend === 'vulkan' ? 'Vulkan GPU 加速' : 'CPU 模式'} · 空闲 2 分钟后自动释放内存` : `Qwen3-Embedding-4B · Q4_K_M · ${modelStatus?.backend === 'vulkan' ? 'Vulkan GPU 加速' : 'CPU 模式'}`)}</small></div></div>
                  {modelStatus && ['checking', 'downloading', 'installing'].includes(modelStatus.state) && <div className="model-progress"><i style={{ width: `${modelStatus.progress}%` }} /></div>}
                  <div className="model-manager-actions">
                    {!modelStatus?.installed && modelStatus?.state !== 'downloading' && <Button size="sm" variant="outline" onClick={() => void installLocalModel()}>{modelStatus?.state === 'paused' ? '继续下载' : '下载并安装'}</Button>}
                    {modelStatus?.state === 'downloading' && <Button size="sm" variant="outline" onClick={() => void window.marginDesktop?.modelPause?.()}>暂停</Button>}
                    {modelStatus?.installed && <>{modelStatus.loaded && <Button size="sm" variant="outline" onClick={() => void releaseModelMemory()}>释放内存</Button>}<Button size="sm" variant="outline" onClick={() => void window.marginDesktop?.modelOpenFolder?.()}>打开目录</Button><Button size="sm" variant="ghost" onClick={() => void removeLocalModel()}>卸载</Button></>}
                    <Button size="sm" variant="ghost" onClick={() => void window.marginDesktop?.openLogs?.()}>打开日志</Button>
                  </div>
                </div>}
                {settings.embeddingKind === 'openai-compatible' && <>
                  <Label htmlFor="embedding-endpoint">向量端点</Label><Input id="embedding-endpoint" value={settings.embeddingEndpoint} onChange={(e) => setSettings({ ...settings, embeddingEndpoint: e.target.value })} placeholder="https://api.openai.com/v1" />
                  <Label htmlFor="embedding-model">向量模型名</Label><Input id="embedding-model" value={settings.embeddingModel} onChange={(e) => setSettings({ ...settings, embeddingModel: e.target.value })} placeholder="text-embedding-3-small" />
                  <Label htmlFor="embedding-key">向量 API Key</Label><Input id="embedding-key" type="password" value={settings.embeddingApiKey} onChange={(e) => setSettings({ ...settings, embeddingApiKey: e.target.value })} placeholder="sk-..." />
                </>}
              </div>
              <DialogFooter><Button onClick={saveSettings}>保存配置</Button></DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <input ref={fileInputRef} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => void openPdf(event.target.files?.[0])} />
      </header>

      <div className={bookshelfCollapsed ? 'workspace shelf-collapsed' : 'workspace'}>
        <aside className={bookshelfCollapsed ? 'bookshelf-panel collapsed' : 'bookshelf-panel'} aria-label="本地书架">
          {bookshelfCollapsed ? <div className="bookshelf-rail"><Button variant="ghost" size="icon" onClick={toggleBookshelf} aria-label="展开本地书架" title="展开本地书架"><PanelLeftOpen /></Button><Button variant="ghost" size="icon" onClick={() => fileInputRef.current?.click()} aria-label="添加到本地书架" title="添加 PDF"><Plus /></Button></div> : <div className="bookshelf-heading"><div><Library /><span>本地书架</span><strong>{library.length}</strong></div><span className="bookshelf-actions"><Button variant="ghost" size="icon" onClick={() => fileInputRef.current?.click()} aria-label="添加到本地书架" title="添加 PDF"><Plus /></Button><Button variant="ghost" size="icon" onClick={toggleBookshelf} aria-label="收起本地书架" title="收起本地书架"><PanelLeftClose /></Button></span></div>}
          <div className="book-list">
            {library.length === 0 ? <div className="bookshelf-empty"><BookOpen /><p>导入的 PDF 会保存在本机，并记住阅读进度与向量索引。</p></div> : library.map((book) =>
              <div className="book-row" key={book.id}><button className={book.id === activeBookId ? 'book-item active' : 'book-item'} onClick={() => void openLibraryBook(book)}>
                <span className="book-icon"><FileText /></span><span className="book-copy"><strong>{book.name}</strong><small>{book.pageCount ? `${book.lastPage} / ${book.pageCount} 页` : '等待首次打开'}</small></span>
                {book.indexProviderId && <span className="book-index" title="已保存向量索引"><HardDrive /></span>}
              </button><button className="book-remove" onClick={() => void removeLibraryBook(book)} aria-label={`从书架移除 ${book.name}`}><Trash2 /></button></div>)}
          </div>
        </aside>
        <section className="reader-panel" aria-label="PDF 阅读区">
          {pdf ? <>
            <div className="reader-toolbar">
              <span className="page-label">正在阅读 <strong>{page}</strong> / {pageCount}</span>
              <div className="page-controls">
                <Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => scrollToPage(Math.max(1, page - 1))} aria-label="上一页"><ArrowUp /></Button>
                <label className="page-jump">第 <input type="number" min={1} max={pageCount} value={page} onChange={(event) => scrollToPage(Math.min(pageCount, Math.max(1, Number(event.target.value))))} /> 页</label>
                <Button variant="ghost" size="icon" disabled={page >= pageCount} onClick={() => scrollToPage(Math.min(pageCount, page + 1))} aria-label="下一页"><ArrowDown /></Button>
              </div>
            </div>
            <div ref={readerScrollRef} className="canvas-wrap"><div className="pdf-pages">
              {Array.from({ length: pageCount }, (_, index) => <PdfPageCanvas key={index + 1} pdf={pdf} pageNumber={index + 1} activePage={page} onText={handlePageText} onError={handleRenderError} />)}
            </div></div>
          </> : <div className="empty-state">
            <div className="empty-icon"><Upload /></div><p className="eyebrow">私密 · 本地阅读</p>
            <h1>打开一本 PDF，<br />开始深度阅读。</h1>
            <p>文档仅在你的浏览器中解析。AI 会自动携带当前页内容，无需反复截图或复制。</p>
            <span className="file-note">点击“本地书架”旁的 ＋ 导入 PDF · 文件不会上传</span>
          </div>}
        </section>

        <aside className="ai-panel" aria-label="AI 阅读助手">
          <div className="ai-heading"><div className="ai-avatar"><Sparkles /></div><div><h2>阅读助手</h2><p>{pdf ? `已同步第 ${page} 页` : '等待打开文档'}</p></div><div className="ai-heading-actions">
            <Dialog>
              <DialogTrigger render={<Button variant="ghost" size="icon" aria-label="提问历史" title="提问历史" />}><History /></DialogTrigger>
              <DialogContent className="history-dialog">
                <DialogHeader><DialogTitle>提问历史</DialogTitle><DialogDescription>问答按书籍保存在本机；点击记录可恢复对话并跳到提问页。</DialogDescription></DialogHeader>
                <div className="history-list">{historyQuestions.length === 0 ? <p className="history-empty">还没有提问记录。</p> : historyQuestions.map(({ record, message, index }) => <button className="history-item" key={`${record.bookId}-${index}`} onClick={() => void openHistoryRecord(record, message)}><span><strong>{record.bookName}</strong><small>第 {message.page} 页 · {message.createdAt ? new Date(message.createdAt).toLocaleString('zh-CN') : '历史记录'}</small></span><p>{message.content}</p></button>)}</div>
                {chatHistory.length > 0 && <DialogFooter><Button variant="ghost" onClick={() => { if (!window.confirm('清空全部本地提问历史？')) return; localStorage.removeItem(CHAT_HISTORY_KEY); setChatHistory([]); setMessages([]); }}>清空历史</Button></DialogFooter>}
              </DialogContent>
            </Dialog>
            <span className={pdf ? 'sync-badge active' : 'sync-badge'}>{pdf ? '已定位' : '未连接'}</span>
          </div></div>
          {pdf && <div className={`index-strip ${indexStatus}`}>
            <div><strong>{indexStatus === 'ready' ? '全文索引已就绪' : indexStatus === 'indexing' ? `正在建立索引 ${indexProgress}%` : indexStatus === 'error' ? '索引建立失败' : '尚未建立全文索引'}</strong><span title={indexMessage}>{indexMessage || (settings.embeddingKind === 'local-qwen3-embedding-4b' ? '本地 Qwen3-Embedding-4B · Q4_K_M' : settings.embeddingModel)}</span>{indexStatus === 'indexing' && <span className="index-progress"><i style={{ width: `${indexProgress}%` }} /></span>}</div>
            <Button variant={indexStatus === 'ready' ? 'ghost' : 'outline'} size="sm" onClick={() => indexStatus === 'indexing' ? stopIndexing() : void buildIndex()}>{indexStatus === 'ready' ? '重新索引' : indexStatus === 'indexing' ? '停止' : indexStatus === 'error' ? '重试' : '建立索引'}</Button>
          </div>}
          {scanWarning && <p className="scan-warning">{scanWarning}</p>}
          {pdf && settings.glmOcrMode === 'auto' && <p className={deepReadStatus.includes('失败') ? 'deep-read-status error' : 'deep-read-status'}><Sparkles />{deepReadStatus || 'GLM-OCR 已待命 · 复杂页面将自动精读'}</p>}
          <div className="chat-area" ref={chatAreaRef} onScroll={handleChatScroll}>
            {messages.length === 0 ? <div className="chat-welcome"><MessageSquareText /><h3>我会跟着你的页码</h3><p>{pdf ? '直接提问，我会优先根据当前页原文解释。' : '打开 PDF 后，这里会自动获取你当前阅读的页面。'}</p></div> :
              <div className="messages" aria-live="polite">{messages.map((message, index) => {
                const thinking = message.role === 'assistant' && !message.content && asking && index === messages.length - 1;
                return <div className={`message ${message.role}`} key={`${message.page}-${index}`}><span>{message.role === 'assistant' ? <Bot /> : `P.${message.page}`}</span>{thinking ? <p className="thinking"><i /><i /><i /></p> : <p>{message.content}</p>}</div>;
              })}</div>}
          </div>
          <div className="composer-wrap">
            {error && <p className="error-message">{error}</p>}
            <div className="quick-prompts">{quickPrompts.map((prompt) => <button key={prompt} onClick={() => void askAi(undefined, prompt)} disabled={!pdf || asking}>{prompt}</button>)}</div>
            <form className="composer" onSubmit={(event) => void askAi(event)}><Textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void askAi(); } }} disabled={!pdf || asking} placeholder={pdf ? `针对第 ${page} 页提问…` : '请先打开 PDF'} aria-label="输入问题" /><Button type="submit" size="icon-lg" disabled={!pdf || !question.trim() || asking} aria-label="发送"><Send /></Button></form>
            <p className="privacy-note">当前页文本仅在提问时发送；启用远程 GLM-OCR 后，最多 2 个命中页图片也会发送。</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
