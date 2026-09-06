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

export type StoredIndexEntry = { id: string; page: number; text: string; vector: number[] | Float32Array };
export type IndexInfo = { format: 'sqlite-f32'; chunks: number; dimensions: number; bytes: number; migrated?: boolean };
export type ModelInstallStatus = { installed: boolean; loaded: boolean; missing?: string[]; model: string; root: string; backend: 'cpu' | 'vulkan'; state: string; progress: number; message: string };

declare global {
  interface Window {
    marginDesktop?: {
      platform: string;
      isDesktop: boolean;
      appInfo?: () => Promise<{ version: string; packaged: boolean; logPath: string }>;
      openLogs?: () => Promise<{ opened: boolean; path: string }>;
      logEvent?: (event: string, details?: Record<string, unknown>, level?: 'info' | 'error') => void;
      embed?: (texts: string[]) => Promise<number[][]>;
      modelStatus?: () => Promise<ModelInstallStatus>;
      modelPrepare?: () => Promise<ModelInstallStatus>;
      modelInstall?: () => Promise<{ installed: boolean; paused?: boolean }>;
      modelPause?: () => Promise<{ paused: boolean }>;
      modelOpenFolder?: () => Promise<{ opened: boolean }>;
      modelUnload?: () => Promise<ModelInstallStatus>;
      modelRemove?: () => Promise<ModelInstallStatus>;
      onModelProgress?: (listener: (progress: Omit<ModelInstallStatus, 'installed' | 'model' | 'root'>) => void) => () => void;
      ocrRecognize?: (image: Uint8Array, language: 'eng' | 'chi_sim+eng' | 'chi_tra+eng', page?: number) => Promise<{ text: string; confidence: number }>;
      onOcrProgress?: (listener: (progress: { page: number; status: string; progress: number }) => void) => () => void;
      libraryList?: () => Promise<LibraryEntry[]>;
      libraryImport?: (name: string, data: ArrayBuffer) => Promise<LibraryEntry>;
      libraryImportFile?: (file: File) => Promise<LibraryEntry>;
      libraryRead?: (id: string) => Promise<Uint8Array>;
      libraryRemove?: (id: string) => Promise<{ removed: string }>;
      libraryUpdate?: (id: string, changes: { pageCount?: number; lastPage?: number }) => Promise<LibraryEntry>;
      libraryIndexOpen?: (id: string, providerId: string) => Promise<IndexInfo | null>;
      libraryIndexStart?: (id: string, providerId: string, dimensions: number) => Promise<{ started: boolean; format: string; dimensions: number }>;
      libraryIndexAppend?: (id: string, entries: StoredIndexEntry[]) => Promise<{ chunks: number }>;
      libraryIndexFinish?: (id: string) => Promise<IndexInfo>;
      libraryIndexCancel?: (id: string) => Promise<{ cancelled: boolean }>;
      libraryIndexSearch?: (id: string, providerId: string, vector: number[] | Float32Array, limit: number) => Promise<Array<{ id: string; page: number; text: string; score: number }>>;
    };
  }
}
