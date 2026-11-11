import type { ClipHistoryItem } from '../types';

export const CLIP_HISTORY_MAX: number;
export const CLIP_HISTORY_FILE: string;

export interface ClipHistory {
  remember(text: string): void;
  forget(): void;
  wipe(): void;
  repersist(pwOverride?: string): void;
  load(): ClipHistoryItem[];
  list(): ClipHistoryItem[];
  file: string;
}

export interface ClipHistoryOptions {
  dir: string;
  encrypt: (plain: string, pw: string) => string;
  decrypt: (cipher: string, pw: string) => string | null;
  writeFileAtomic: (file: string, content: string) => void;
  getPassword: () => string | null;
  isEnabled: () => boolean;
}

export function createClipHistory(opts: ClipHistoryOptions): ClipHistory;
