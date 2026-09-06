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

export type StoredIndexEntry = { id: string; page: number; text: string; vector: number[] };
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
      libraryList?: () => Promise<LibraryEntry[]>;
      libraryImport?: (name: string, data: ArrayBuffer) => Promise<LibraryEntry>;
      libraryRead?: (id: string) => Promise<Uint8Array>;
      libraryRemove?: (id: string) => Promise<{ removed: string }>;
      libraryUpdate?: (id: string, changes: { pageCount?: number; lastPage?: number }) => Promise<LibraryEntry>;
      libraryIndexSave?: (id: string, providerId: string, entries: StoredIndexEntry[]) => Promise<{ saved: boolean; chunks: number }>;
      libraryIndexLoad?: (id: string, providerId: string) => Promise<StoredIndexEntry[] | null>;
    };
  }
}
