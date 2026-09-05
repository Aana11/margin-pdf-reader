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
export type ModelInstallStatus = { installed: boolean; model: string; root: string; state: string; progress: number; message: string };

declare global {
  interface Window {
    marginDesktop?: {
      platform: string;
      isDesktop: boolean;
      embed?: (texts: string[]) => Promise<number[][]>;
      modelStatus?: () => Promise<ModelInstallStatus>;
      modelInstall?: () => Promise<{ installed: boolean; paused?: boolean }>;
      modelPause?: () => Promise<{ paused: boolean }>;
      modelOpenFolder?: () => Promise<{ opened: boolean }>;
      modelRemove?: () => Promise<ModelInstallStatus>;
      onModelProgress?: (listener: (progress: Omit<ModelInstallStatus, 'installed' | 'model' | 'root'>) => void) => () => void;
      libraryList?: () => Promise<LibraryEntry[]>;
      libraryImport?: (name: string, data: ArrayBuffer) => Promise<LibraryEntry>;
      libraryRead?: (id: string) => Promise<Uint8Array>;
      libraryUpdate?: (id: string, changes: { pageCount?: number; lastPage?: number }) => Promise<LibraryEntry>;
      libraryIndexSave?: (id: string, providerId: string, entries: StoredIndexEntry[]) => Promise<{ saved: boolean; chunks: number }>;
      libraryIndexLoad?: (id: string, providerId: string) => Promise<StoredIndexEntry[] | null>;
    };
  }
}
