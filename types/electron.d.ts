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

declare global {
  interface Window {
    marginDesktop?: {
      platform: string;
      isDesktop: boolean;
      embed?: (texts: string[]) => Promise<number[][]>;
      modelStatus?: () => Promise<{ installed: boolean; model: string; root: string }>;
      libraryList?: () => Promise<LibraryEntry[]>;
      libraryImport?: (name: string, data: ArrayBuffer) => Promise<LibraryEntry>;
      libraryRead?: (id: string) => Promise<Uint8Array>;
      libraryUpdate?: (id: string, changes: { pageCount?: number; lastPage?: number }) => Promise<LibraryEntry>;
      libraryIndexSave?: (id: string, providerId: string, entries: StoredIndexEntry[]) => Promise<{ saved: boolean; chunks: number }>;
      libraryIndexLoad?: (id: string, providerId: string) => Promise<StoredIndexEntry[] | null>;
    };
  }
}
