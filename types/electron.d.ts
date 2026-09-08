export {};

export type LibraryEntry = {
  id: string;
  name: string;
  pageCount: number;
  lastPage: number;
  addedAt: string;
  updatedAt: string;
  indexProviderId: string | null;
};

export type StoredIndexEntry = {
  id: string;
  page: number;
  text: string;
  vector: number[] | Float32Array;
};
export type IndexInfo = {
  format: 'sqlite-f32';
  chunks: number;
  dimensions: number;
  bytes: number;
  migrated?: boolean;
};
export type IndexCheckpoint = {
  started: boolean;
  format: 'sqlite-f32';
  resumed: boolean;
  dimensions: number;
  chunks: number;
  pages: Array<{ page: number; text: string; source: 'pdf' | 'ocr' }>;
  completedChunkIds: string[];
};
export type ModelInstallStatus = {
  installed: boolean;
  loaded: boolean;
  missing?: string[];
  model: string;
  root: string;
  backend: 'cpu' | 'vulkan';
  state: string;
  progress: number;
  message: string;
};
export type GlmOcrProvider = 'managed' | 'ollama' | 'openai-compatible';
export type GlmOcrStatus = {
  provider: GlmOcrProvider;
  runtimeInstalled: boolean;
  serviceRunning: boolean | null;
  modelInstalled: boolean | null;
  modelLoaded: boolean | null;
  state: string;
  progress: number;
  message: string;
  error?: string;
};
export type GlmOcrConfig = {
  provider: GlmOcrProvider;
  endpoint: string;
  model: string;
  apiKey: string;
  autoStart: boolean;
};
export type WorkspaceCitation = {
  page: number;
  region: { x: number; y: number; width: number; height: number };
};
export type WorkspaceMessage = {
  role: 'user' | 'assistant';
  content: string;
  page: number;
  createdAt?: string;
  citation?: WorkspaceCitation;
};
export type WorkspaceHistoryItem = {
  id: string;
  bookId: string;
  bookName: string;
  content: string;
  page: number;
  citation?: WorkspaceCitation;
  createdAt: string;
};
export type WorkspaceNoteKind = 'highlight' | 'note' | 'summary' | 'glossary';
export type WorkspaceNote = {
  id: string;
  bookId: string;
  bookName: string;
  page: number;
  kind: WorkspaceNoteKind;
  title: string;
  content: string;
  excerpt: string;
  color: string;
  region?: WorkspaceCitation['region'];
  createdAt: string;
  updatedAt: string;
};

declare global {
  interface Window {
    marginDesktop?: {
      platform: string;
      isDesktop: boolean;
      appInfo?: () => Promise<{
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
      }>;
      openLogs?: () => Promise<{ opened: boolean; path: string }>;
      logEvent?: (
        event: string,
        details?: Record<string, unknown>,
        level?: 'info' | 'error',
      ) => void;
      embed?: (texts: string[]) => Promise<number[][]>;
      modelStatus?: () => Promise<ModelInstallStatus>;
      modelPrepare?: () => Promise<ModelInstallStatus>;
      modelInstall?: () => Promise<{ installed: boolean; paused?: boolean }>;
      modelPause?: () => Promise<{ paused: boolean }>;
      modelOpenFolder?: () => Promise<{ opened: boolean }>;
      modelUnload?: () => Promise<ModelInstallStatus>;
      modelRemove?: () => Promise<ModelInstallStatus>;
      onModelProgress?: (
        listener: (
          progress: Omit<ModelInstallStatus, 'installed' | 'model' | 'root'>,
        ) => void,
      ) => () => void;
      ocrRecognize?: (
        image: Uint8Array,
        language: 'eng' | 'chi_sim+eng' | 'chi_tra+eng',
        page?: number,
      ) => Promise<{ text: string; confidence: number }>;
      onOcrProgress?: (
        listener: (progress: {
          page: number;
          status: string;
          progress: number;
        }) => void,
      ) => () => void;
      glmOcrStatus?: (config: GlmOcrConfig) => Promise<GlmOcrStatus>;
      glmOcrPrepare?: (config: GlmOcrConfig) => Promise<GlmOcrStatus>;
      glmOcrRecognize?: (
        payload: GlmOcrConfig & {
          image: Uint8Array;
          mimeType: string;
          task: 'text' | 'formula' | 'table';
        },
      ) => Promise<{ text: string; task: 'text' | 'formula' | 'table' }>;
      glmOcrUnload?: (config: GlmOcrConfig) => Promise<GlmOcrStatus>;
      glmOcrPause?: () => Promise<{ paused: boolean }>;
      glmOcrOpenFolder?: () => Promise<{ opened: boolean }>;
      glmOcrRemove?: (config: GlmOcrConfig) => Promise<GlmOcrStatus>;
      glmOcrOpenInstall?: () => Promise<{ opened: boolean }>;
      onGlmOcrProgress?: (
        listener: (progress: Partial<GlmOcrStatus>) => void,
      ) => () => void;
      libraryList?: () => Promise<LibraryEntry[]>;
      libraryImport?: (
        name: string,
        data: ArrayBuffer,
      ) => Promise<LibraryEntry>;
      libraryImportFile?: (file: File) => Promise<LibraryEntry>;
      libraryRead?: (id: string) => Promise<Uint8Array>;
      libraryRemove?: (id: string) => Promise<{ removed: string }>;
      libraryUpdate?: (
        id: string,
        changes: { pageCount?: number; lastPage?: number },
      ) => Promise<LibraryEntry>;
      libraryIndexOpen?: (
        id: string,
        providerId: string,
      ) => Promise<IndexInfo | null>;
      libraryIndexStart?: (
        id: string,
        providerId: string,
        dimensions?: number,
        buildKey?: string,
      ) => Promise<IndexCheckpoint>;
      libraryIndexSavePages?: (
        id: string,
        entries: Array<{ page: number; text: string; source: 'pdf' | 'ocr' }>,
      ) => Promise<{ pages: number }>;
      libraryIndexAppend?: (
        id: string,
        entries: StoredIndexEntry[],
      ) => Promise<{ chunks: number }>;
      libraryIndexFinish?: (id: string) => Promise<IndexInfo>;
      libraryIndexCancel?: (
        id: string,
      ) => Promise<{ cancelled: boolean; resumable?: boolean }>;
      libraryIndexDiscard?: (id: string) => Promise<{ discarded: boolean }>;
      libraryIndexSearch?: (
        id: string,
        providerId: string,
        vector: number[] | Float32Array,
        limit: number,
      ) => Promise<
        Array<{ id: string; page: number; text: string; score: number }>
      >;
      workspaceChatLoad?: (
        bookId: string,
        limit?: number,
      ) => Promise<WorkspaceMessage[]>;
      workspaceChatReplace?: (
        bookId: string,
        bookName: string,
        messages: WorkspaceMessage[],
      ) => Promise<{ messages: number }>;
      workspaceHistorySearch?: (
        query: string,
        limit?: number,
        offset?: number,
      ) => Promise<{ total: number; items: WorkspaceHistoryItem[] }>;
      workspaceNotesList?: (options?: {
        bookId?: string;
        kind?: WorkspaceNoteKind;
        query?: string;
        limit?: number;
        offset?: number;
      }) => Promise<{ total: number; items: WorkspaceNote[] }>;
      workspaceNoteSave?: (
        bookId: string,
        bookName: string,
        note: Omit<
          WorkspaceNote,
          'id' | 'bookId' | 'bookName' | 'createdAt' | 'updatedAt'
        > & { id?: string },
      ) => Promise<WorkspaceNote>;
      workspaceNoteRemove?: (id: string) => Promise<{ removed: boolean }>;
      workspaceExportMarkdown?: (options?: {
        bookId?: string;
      }) => Promise<{ exported: boolean; path?: string }>;
    };
  }
}
