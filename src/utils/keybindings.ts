import type { KeybindingId } from '../types';

/**
 * 应用内快捷键的出厂值。
 *
 * 必须和 `electron/main.js` 里 `DEFAULT_SETTINGS.keybindings` 保持一致 ——
 * renderer 不能 require 主进程那个 60 KB 的文件（会连带执行一堆 side effect），
 * 所以这里存一份。两边都改了才算改，`src/utils/__tests__/keybindings.test.ts`
 * 里有一条用例直接读 main.js 的源文本比对，防止漂移。
 */
export const DEFAULT_KEYBINDINGS: Record<KeybindingId, string> = {
  newEntry: 'Ctrl+N',
  search: 'Ctrl+F',
  settings: 'Ctrl+,',
  lock: 'Ctrl+Shift+L',
  trash: 'Ctrl+Shift+T',
  import: 'Ctrl+Shift+I',
  export: 'Ctrl+Shift+E',
};

/** 把 "Ctrl+Shift+L" / "ctrl + shift + l" 归一成同一个比较用字符串 */
export function normalizeCombo(combo: string): string {
  const parts = String(combo || '')
    .split('+')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const mods = new Set(parts.filter((p) => ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd'].includes(p)).map((p) => (p === 'control' ? 'ctrl' : p === 'cmd' ? 'meta' : p)));
  const key = parts.filter((p) => !['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd'].includes(p)).join('+');
  return [...['ctrl', 'alt', 'shift', 'meta'].filter((m) => mods.has(m)), key].join('+');
}

/**
 * 找出被绑到多个动作上的组合键。
 * 返回 `{ 组合键 → 抢它的动作列表 }`，只列真正冲突的（≥2 个）。
 */
export function findConflicts(map: Record<KeybindingId, string>): Record<string, KeybindingId[]> {
  const seen: Record<string, KeybindingId[]> = {};
  (Object.keys(map) as KeybindingId[]).forEach((id) => {
    const norm = normalizeCombo(map[id]);
    if (!norm) return;
    (seen[norm] = seen[norm] || []).push(id);
  });
  const out: Record<string, KeybindingId[]> = {};
  Object.entries(seen).forEach(([norm, ids]) => {
    if (ids.length > 1) out[norm] = ids;
  });
  return out;
}
