'use client';

import { SyntheticEvent, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, FileText, LoaderCircle, MessageSquareText, Plus, Send, Settings2, Sparkles, Upload } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
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

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
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
        setPage(target as number);
        return { page: target, pageCount, status: 'navigated' };
      },
    }, { signal: lifecycle.signal })).catch(() => undefined);
    return () => lifecycle.abort();
  }, [pdf, pageCount]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: { cancel: () => void } | undefined;
    async function renderPage() {
      const pdfPage = await pdf!.getPage(page);
      if (cancelled || !canvasRef.current) return;
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      const containerWidth = canvasRef.current.parentElement?.clientWidth ?? 760;
      const scale = Math.min(2, Math.max(0.7, (containerWidth - 48) / baseViewport.width));
      const viewport = pdfPage.getViewport({ scale });
      const canvas = canvasRef.current;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      const task = pdfPage.render({ canvas, canvasContext: context, viewport, transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0] });
      renderTask = task;
      await task.promise;
      const text = await pdfPage.getTextContent();
      if (!cancelled) setPageText(text.items.map((item) => ('str' in item ? item.str : '')).join(' ').replace(/\s+/g, ' ').trim());
    }
    renderPage().catch((reason) => { if (reason?.name !== 'RenderingCancelledException') setError('这一页渲染失败，请尝试切换页码。'); });
    return () => { cancelled = true; renderTask?.cancel(); };
  }, [pdf, page]);

  async function openPdf(file?: File) {
    if (!file) return;
    setLoadingPdf(true); setError(''); setMessages([]);
    try {
      const pdfJs = await import('pdfjs-dist');
      pdfJs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      const document = await pdfJs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      vectorIndexRef.current.clear(); embeddingProviderRef.current = null;
      setIndexStatus('idle'); setIndexProgress(0);
      setPdf(document); setFileName(file.name); setPageCount(document.numPages); setPage(1);
    } catch { setError('无法打开这个 PDF，请确认文件未加密且没有损坏。'); }
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
                  <NativeSelectOption value="local-qwen3-embedding-4b">本地 Qwen3-Embedding-4B（Q8 模型包）</NativeSelectOption>
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
                <Button variant="ghost" size="icon" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))} aria-label="上一页"><ArrowLeft /></Button>
                <label className="page-jump">第 <input type="number" min={1} max={pageCount} value={page} onChange={(event) => setPage(Math.min(pageCount, Math.max(1, Number(event.target.value))))} /> 页</label>
                <Button variant="ghost" size="icon" disabled={page >= pageCount} onClick={() => setPage((value) => Math.min(pageCount, value + 1))} aria-label="下一页"><ArrowRight /></Button>
              </div>
            </div>
            <div className="canvas-wrap"><canvas ref={canvasRef} /></div>
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
            <div><strong>{indexStatus === 'ready' ? '全文索引已就绪' : indexStatus === 'indexing' ? `正在建立索引 ${indexProgress}%` : '尚未建立全文索引'}</strong><span>{settings.embeddingKind === 'local-qwen3-embedding-4b' ? '本地 Qwen3-Embedding-4B · Q8' : settings.embeddingModel}</span></div>
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
