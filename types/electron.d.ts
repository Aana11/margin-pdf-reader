export {};

declare global {
  interface Window {
    marginDesktop?: {
      platform: string;
      isDesktop: boolean;
      embed?: (texts: string[]) => Promise<number[][]>;
      modelStatus?: () => Promise<{ installed: boolean; model: string; root: string }>;
    };
  }
}
