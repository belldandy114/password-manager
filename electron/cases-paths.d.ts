export const MAX_NAME: number;
export const CASE_EXTS: string[];
export function safeName(input: unknown): { name?: string; error?: string };
export function resolveInside(root: string, rel?: string): { base?: string; target?: string; error?: string };
export function uniqueName(existing: string[], name: string): string;
export const MAX_FOLDER_DEPTH: number;
export function canMoveInto(isDir: boolean, targetRel: string): { ok: boolean; error?: string };
export function formatSize(bytes: number): string;

