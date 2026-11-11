import { BrowserWindow, ipcMain, screen } from 'electron';
import path from 'node:path';

export const DEFAULT_WIDTH: number;
export const DEFAULT_HEIGHT: number;

export interface PinManagerDeps {
  BrowserWindow: typeof BrowserWindow;
  ipcMain: typeof ipcMain;
  path: typeof path;
  screen: typeof screen;
  isDev: boolean;
  preloadPath: string;
  distDir: string;
  isContentProtection?: () => boolean;
  onLog?: (message: string) => void;
}

export interface PinManager {
  register(): void;
  closeAll(): void;
  createFor(id: string): BrowserWindow;
  count(): number;
}

export function createPinManager(deps: PinManagerDeps): PinManager;
