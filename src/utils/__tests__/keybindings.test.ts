import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_KEYBINDINGS, normalizeCombo, findConflicts } from '../keybindings';
import type { KeybindingId } from '../../types';

describe('normalizeCombo', () => {
  it('大小写与空格归一', () => {
    expect(normalizeCombo('Ctrl + Shift + L')).toBe('ctrl+shift+l');
    expect(normalizeCombo('ctrl+shift+l')).toBe('ctrl+shift+l');
  });

  it('修饰键顺序归一（Alt+Ctrl+L 与 Ctrl+Alt+L 相等）', () => {
    expect(normalizeCombo('Alt+Ctrl+L')).toBe(normalizeCombo('Ctrl+Alt+L'));
  });

  it('Control 与 Ctrl 等价、Cmd 视作 Meta', () => {
    expect(normalizeCombo('Control+N')).toBe('ctrl+n');
    expect(normalizeCombo('Cmd+N')).toBe('meta+n');
  });

  it('空串给出空串', () => {
    expect(normalizeCombo('')).toBe('');
    expect(normalizeCombo('   ')).toBe('');
  });
});

describe('findConflicts', () => {
  it('认出厂值互不冲突', () => {
    expect(findConflicts(DEFAULT_KEYBINDINGS)).toEqual({});
  });

  it('两个动作绑同一个键时被列出', () => {
    const map: Record<KeybindingId, string> = { ...DEFAULT_KEYBINDINGS, lock: 'Ctrl+N' };
    const c = findConflicts(map);
    expect(c['ctrl+n']?.sort()).toEqual(['lock', 'newEntry']);
  });

  it('写法不同但等价也算冲突', () => {
    const map: Record<KeybindingId, string> = { ...DEFAULT_KEYBINDINGS, trash: 'ctrl + shift + i' };
    expect(Object.keys(findConflicts(map))).toContain('ctrl+shift+i');
  });

  it('空值不参与冲突判定', () => {
    const map: Record<KeybindingId, string> = { ...DEFAULT_KEYBINDINGS, trash: '', import: '' };
    expect(findConflicts(map)).toEqual({});
  });
});

describe('与主进程的出厂值保持一致', () => {
  it('main.js 里的 keybindings 与 DEFAULT_KEYBINDINGS 相同', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'electron', 'main.js'), 'utf8');
    const block = /keybindings:\s*\{([\s\S]*?)\}/.exec(src);
    expect(block).toBeTruthy();
    const pairs: Record<string, string> = {};
    const re = /(\w+):\s*'([^']*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block![1])) !== null) pairs[m[1]] = m[2];
    expect(pairs).toEqual(DEFAULT_KEYBINDINGS);
  });
});
