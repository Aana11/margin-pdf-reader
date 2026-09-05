'use client';

import { SyntheticEvent, useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bot, FileText, LoaderCircle, MessageSquareText, Plus, Send, Settings2, Sparkles, Upload } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
// oxlint-disable-next-line import/default -- Vite's ?url loader provides this synthetic default export.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { chunkPage } from '@/lib/rag/chunk';
import { MemoryVectorIndex } from '@/lib/rag/memory-index';
import { createEmbeddingProvider } from '@/lib/rag/providers';
import type { EmbeddingProvider, EmbeddingProviderKind, RagChunk } from '@/lib/rag/types';

type Message = { role: 'user' | 'assistant'; content: string; page: number };
type ModelSettings = {
  endpoint: string;
  model: string;
  apiKey: string;
  embeddingKind: EmbeddingProviderKind;
  embeddingEndpoint: string;
  embeddingModel: string;
  embeddingApiKey: string;
};
const DEFAULT_SETTINGS: ModelSettings = {
  endpoint: 'https://api.openai.com/v1', model: 'gpt-5-mini', apiKey: '',
  embeddingKind: 'local-qwen3-embedding-4b', embeddingEndpoint: 'https://api-inference.modelscope.cn/v1',
  embeddingModel: 'text-embedding-3-small', embeddingApiKey: '',
};
const quickPrompts = ['总结本页', '解释核心概念', '列出关键结论'];

function readSavedSettings(): ModelSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem('margin-ai-settings') ?? '{}') }; }
  catch { return DEFAULT_SETTINGS; }
}

type PdfPageCanvasProps = {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  onText: (pageNumber: number, text: string) => void;
  onError: (message: string) => void;
};

function PdfPageCanvas({ pdf, pageNumber, onText, onError }: PdfPageCanvasProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [shouldRender, setShouldRender] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(760);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const root = shell.closest('.canvas-wrap');
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShouldRender(true);
    }, { root, rootMargin: '1200px 0px' });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

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
    if (!shouldRender || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<void> } | undefined;
    async function renderPage() {
      const pdfPage = await pdf.getPage(pageNumber);
      if (cancelled || !canvasRef.current) return;
      const baseViewport = pdfPage.getViewport({ scale: 1 });
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

  return <div ref={shellRef} className="pdf-page" data-page={pageNumber} aria-label={`PDF 第 ${pageNumber} 页`}>
    <canvas ref={canvasRef} />
    <span className="pdf-page-number">{pageNumber}</span>
  </div>;
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readerScrollRef = useRef<HTMLDivElement>(null);
  const pageTextsRef = useRef(new Map<number, string>());
  const vectorIndexRef = useRef(new MemoryVectorIndex());
  const embeddingProviderRef = useRef<EmbeddingProvider | null>(null);
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
  const [indexStatus, setIndexStatus] = useState<'idle' | 'indexing' | 'ready'>('idle');
  const [indexProgress, setIndexProgress] = useState(0);
  const [settings, setSettings] = useState<ModelSettings>(readSavedSettings);

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

  function syncPageFromScroll() {
    const container = readerScrollRef.current;
    if (!container) return;
    const viewport = container.getBoundingClientRect();
    const focusLine = viewport.top + Math.min(180, viewport.height * 0.35);
    let closestPage = page;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const element of container.querySelectorAll<HTMLElement>('.pdf-page')) {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.top - focusLine);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = Number(element.dataset.page);
      }
    }
    if (closestPage !== page) setPage(closestPage);
  }

  async function openPdf(file?: File) {
    if (!file) return;
    setLoadingPdf(true); setError(''); setMessages([]);
    try {
      const pdfJs = await import('pdfjs-dist');
      pdfJs.GlobalWorkerOptions.workerSrc = new URL(pdfWorkerUrl, window.location.href).toString();
      const document = await pdfJs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      vectorIndexRef.current.clear(); embeddingProviderRef.current = null;
      pageTextsRef.current.clear();
      setIndexStatus('idle'); setIndexProgress(0);
      setPdf(document); setFileName(file.name); setPageCount(document.numPages); setPage(1);
    } catch (reason) {
      console.error('Failed to open PDF', reason);
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`无法打开这个 PDF：${detail.slice(0, 160)}`);
    }
    finally { setLoadingPdf(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  }

  function saveSettings() {
    localStorage.setItem('margin-ai-settings', JSON.stringify(settings));
    vectorIndexRef.current.clear(); embeddingProviderRef.current = null;
    setIndexStatus('idle'); setIndexProgress(0);
  }

  async function buildIndex() {
    if (!pdf || indexStatus === 'indexing') return;
    setError(''); setIndexStatus('indexing'); setIndexProgress(0);
    try {
      const provider = createEmbeddingProvider({
        kind: settings.embeddingKind,
        endpoint: settings.embeddingEndpoint,
        model: settings.embeddingModel,
        apiKey: settings.embeddingApiKey,
      });
      embeddingProviderRef.current = provider;
      vectorIndexRef.current.clear();
      const allChunks: RagChunk[] = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const pdfPage = await pdf.getPage(pageNumber);
        const content = await pdfPage.getTextContent();
        const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
        allChunks.push(...chunkPage(text, pageNumber));
        setIndexProgress(Math.round((pageNumber / pdf.numPages) * 35));
      }
      const batchSize = settings.embeddingKind === 'local-qwen3-embedding-4b' ? 1 : 16;
      for (let start = 0; start < allChunks.length; start += batchSize) {
        await vectorIndexRef.current.add(allChunks.slice(start, start + batchSize), provider);
        setIndexProgress(35 + Math.round((Math.min(start + batchSize, allChunks.length) / Math.max(allChunks.length, 1)) * 65));
      }
      setIndexStatus('ready'); setIndexProgress(100);
    } catch (reason) {
      setIndexStatus('idle');
      setError(`建立索引失败：${reason instanceof Error ? reason.message.slice(0, 180) : '未知错误'}`);
    }
  }

  async function askAi(event?: SyntheticEvent<HTMLFormElement>, preset?: string) {
    event?.preventDefault();
    const prompt = (preset ?? question).trim();
    if (!prompt || !pdf || asking) return;
    if (!settings.apiKey.trim()) { setError('请先在模型设置中填入 API Key。'); return; }
    setQuestion(''); setError(''); setAsking(true);
    setMessages((current) => [...current, { role: 'user', content: prompt, page }]);
    try {
      const matches = indexStatus === 'ready' && embeddingProviderRef.current
        ? await vectorIndexRef.current.search(prompt, embeddingProviderRef.current, 5)
        : [];
      const ragContext = matches.length
        ? matches.map((match) => `[第 ${match.page} 页，相似度 ${match.score.toFixed(2)}]\n${match.text}`).join('\n\n')
        : '（尚未建立全文向量索引）';
      const response = await fetch(`${settings.endpoint.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: settings.model, temperature: 0.3,
          messages: [
            { role: 'system', content: '你是一位严谨的中文阅读助手。优先依据当前页原文回答；原文不足时明确说明，不要捏造。回答简洁、有条理。' },
            ...messages.slice(-6).map(({ role, content }) => ({ role, content })),
            { role: 'user', content: `我正在阅读第 ${page} 页。\n\n当前页原文：\n${pageText.slice(0, 12000) || '（此页未提取到可选文本，可能是扫描件）'}\n\n全文检索片段：\n${ragContext.slice(0, 12000)}\n\n我的问题：${prompt}` },
          ],
        }),
      });
      if (!response.ok) throw new Error((await response.text()) || `HTTP ${response.status}`);
      const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const answer = result.choices?.[0]?.message?.content;
      if (!answer) throw new Error('模型未返回文本');
      setMessages((current) => [...current, { role: 'assistant', content: answer, page }]);
    } catch (reason) {
      setError(`AI 请求失败：${reason instanceof Error ? reason.message.slice(0, 160) : '请检查端点与密钥'}`);
    } finally { setAsking(false); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark"><FileText /></span><span>页间 <em>Margin</em></span></div>
        <div className="document-title"><span className={pdf ? 'status-dot online' : 'status-dot'} /><span>{fileName || '尚未打开文档'}</span></div>
        <div className="top-actions">
          <Dialog>
            <DialogTrigger render={<Button variant="ghost" size="icon-lg" aria-label="模型设置" />}><Settings2 /></DialogTrigger>
            <DialogContent className="settings-dialog">
              <DialogHeader><DialogTitle>模型设置</DialogTitle><DialogDescription>支持 OpenAI 兼容的 <code>/chat/completions</code> 端点。配置仅保存在本机浏览器。</DialogDescription></DialogHeader>
              <div className="settings-fields">
                <Label htmlFor="endpoint">端点地址</Label><Input id="endpoint" value={settings.endpoint} onChange={(e) => setSettings({ ...settings, endpoint: e.target.value })} placeholder="https://api.openai.com/v1" />
                <Label htmlFor="model">模型名称</Label><Input id="model" value={settings.model} onChange={(e) => setSettings({ ...settings, model: e.target.value })} placeholder="gpt-5-mini" />
                <Label htmlFor="api-key">API Key</Label><Input id="api-key" type="password" value={settings.apiKey} onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })} placeholder="sk-..." />
                <div className="settings-divider"><span>向量检索</span></div>
                <Label htmlFor="embedding-kind">向量模型</Label>
                <NativeSelect id="embedding-kind" className="w-full" value={settings.embeddingKind} onChange={(e) => setSettings({ ...settings, embeddingKind: e.target.value as EmbeddingProviderKind })}>
                  <NativeSelectOption value="local-qwen3-embedding-4b">本地 Qwen3-Embedding-4B（Q4_K_M）</NativeSelectOption>
                  <NativeSelectOption value="openai-compatible">OpenAI 兼容提供商</NativeSelectOption>
                </NativeSelect>
                {settings.embeddingKind === 'openai-compatible' && <>
                  <Label htmlFor="embedding-endpoint">向量端点</Label><Input id="embedding-endpoint" value={settings.embeddingEndpoint} onChange={(e) => setSettings({ ...settings, embeddingEndpoint: e.target.value })} placeholder="https://api.openai.com/v1" />
                  <Label htmlFor="embedding-model">向量模型名</Label><Input id="embedding-model" value={settings.embeddingModel} onChange={(e) => setSettings({ ...settings, embeddingModel: e.target.value })} placeholder="text-embedding-3-small" />
                  <Label htmlFor="embedding-key">向量 API Key</Label><Input id="embedding-key" type="password" value={settings.embeddingApiKey} onChange={(e) => setSettings({ ...settings, embeddingApiKey: e.target.value })} placeholder="sk-..." />
                </>}
              </div>
              <DialogFooter><Button onClick={saveSettings}>保存配置</Button></DialogFooter>
            </DialogContent>
          </Dialog>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()}><Plus /> 打开 PDF</Button>
        </div>
        <input ref={fileInputRef} className="sr-only" type="file" accept="application/pdf,.pdf" onChange={(event) => void openPdf(event.target.files?.[0])} />
      </header>

      <div className="workspace">
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
            <div ref={readerScrollRef} className="canvas-wrap" onScroll={syncPageFromScroll}><div className="pdf-pages">
              {Array.from({ length: pageCount }, (_, index) => <PdfPageCanvas key={index + 1} pdf={pdf} pageNumber={index + 1} onText={handlePageText} onError={handleRenderError} />)}
            </div></div>
          </> : <div className="empty-state">
            <div className="empty-icon"><Upload /></div><p className="eyebrow">私密 · 本地阅读</p>
            <h1>打开一本 PDF，<br />开始深度阅读。</h1>
            <p>文档仅在你的浏览器中解析。AI 会自动携带当前页内容，无需反复截图或复制。</p>
            <Button size="lg" onClick={() => fileInputRef.current?.click()} disabled={loadingPdf}>{loadingPdf ? <LoaderCircle className="spin" /> : <Upload />} 选择 PDF 文件</Button>
            <span className="file-note">支持本地 PDF · 文件不会上传</span>
          </div>}
        </section>

        <aside className="ai-panel" aria-label="AI 阅读助手">
          <div className="ai-heading"><div className="ai-avatar"><Sparkles /></div><div><h2>阅读助手</h2><p>{pdf ? `已同步第 ${page} 页` : '等待打开文档'}</p></div><span className={pdf ? 'sync-badge active' : 'sync-badge'}>{pdf ? '已定位' : '未连接'}</span></div>
          {pdf && <div className="index-strip">
            <div><strong>{indexStatus === 'ready' ? '全文索引已就绪' : indexStatus === 'indexing' ? `正在建立索引 ${indexProgress}%` : '尚未建立全文索引'}</strong><span>{settings.embeddingKind === 'local-qwen3-embedding-4b' ? '本地 Qwen3-Embedding-4B · Q4_K_M' : settings.embeddingModel}</span></div>
            <Button variant={indexStatus === 'ready' ? 'ghost' : 'outline'} size="sm" disabled={indexStatus === 'indexing'} onClick={() => void buildIndex()}>{indexStatus === 'ready' ? '重新索引' : indexStatus === 'indexing' ? <LoaderCircle className="spin" /> : '建立索引'}</Button>
          </div>}
          <div className="chat-area">
            {messages.length === 0 ? <div className="chat-welcome"><MessageSquareText /><h3>我会跟着你的页码</h3><p>{pdf ? '直接提问，我会优先根据当前页原文解释。' : '打开 PDF 后，这里会自动获取你当前阅读的页面。'}</p></div> :
              <div className="messages" aria-live="polite">{messages.map((message, index) => <div className={`message ${message.role}`} key={`${message.page}-${index}`}><span>{message.role === 'assistant' ? <Bot /> : `P.${message.page}`}</span><p>{message.content}</p></div>)}{asking && <div className="message assistant"><span><Bot /></span><p className="thinking"><i /><i /><i /></p></div>}</div>}
          </div>
          <div className="composer-wrap">
            {error && <p className="error-message">{error}</p>}
            <div className="quick-prompts">{quickPrompts.map((prompt) => <button key={prompt} onClick={() => void askAi(undefined, prompt)} disabled={!pdf || asking}>{prompt}</button>)}</div>
            <form className="composer" onSubmit={(event) => void askAi(event)}><Textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void askAi(); } }} disabled={!pdf || asking} placeholder={pdf ? `针对第 ${page} 页提问…` : '请先打开 PDF'} aria-label="输入问题" /><Button type="submit" size="icon-lg" disabled={!pdf || !question.trim() || asking} aria-label="发送"><Send /></Button></form>
            <p className="privacy-note">当前页文本仅在你提问时发送给已配置的模型。</p>
          </div>
        </aside>
      </div>
    </main>
  );
}
