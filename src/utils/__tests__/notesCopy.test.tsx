// @vitest-environment jsdom
// 笔记页「复制」入口（docs/agents/sql-copy-vars-next.md §3.D）的回归。
//
// 本文件**只放笔记页渲染用例**（队长裁定 §8 / t5 契约）：
//   - 行内「复制」入口存在，点开的是同一个 CopyVarsModal；
//   - 有变量 → 出输入框与预览；无变量 → 提示「可以直接复制」；
//   - 「复制原文」与「替换并复制」两条路径互不影响；
//   - `kind === 'sql'` 的条目仍不出现在笔记页（因此也没有复制入口）；
//   - 目录模式：卡片行内同样有入口，正文来自 `.md` 文件；没缓存时现读一次。
//
// 弹窗自身的组件行为在 sqlSnippets.test.tsx 里已被 43 条用例覆盖，这里不重复。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import type { Note } from '../../types';
import { NotesBody } from '../../pages/Notes';

type SavedCall = { key: string; data: Note[] };
let saved: SavedCall[] = [];
let copied: string[] = [];

/**
 * 打桩 `window.electronAPI`：
 * 只实现本页真正用到的通道，其余落到 failIpc（页面必须能容忍拿不到数据也别炸）。
 */
function stubElectronApi(notes: unknown[], overrides: Record<string, unknown> = {}) {
  const failIpc = () => Promise.resolve({ success: false, error: 'stub' });
  const unsubscribe = () => () => {};
  const base: Record<string, unknown> = {
    wsGet: (key: string) => Promise.resolve(key === 'notes' ? { success: true, data: notes } : { success: false }),
    wsSet: (key: string, data: Note[]) => { saved.push({ key, data }); return Promise.resolve({ success: true }); },
    ...overrides,
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(base, {
    get(obj, prop: string) {
      if (prop in obj) return (obj as Record<string, unknown>)[prop];
      if (/^(on|off|once|remove|unsubscribe|subscribe)/i.test(prop)) return unsubscribe;
      return failIpc;
    },
  });
}

const CARDS = (root: ParentNode) => [...root.querySelectorAll('.card2')] as HTMLElement[];
const cardOf = (root: ParentNode, title: string) => (
  CARDS(root).find(c => (c.querySelector('.card2-title')?.textContent || '') === title) as HTMLElement
);
const copyBtnOf = (card: HTMLElement) => card.querySelector('.card2-actions button[title*="复制"]') as HTMLElement;
const dialogOf = () => document.querySelector('[role="dialog"]') as HTMLElement;

beforeAll(() => {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  });
  class RO { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: (t: string) => { copied.push(String(t)); return Promise.resolve(); } },
    configurable: true,
  });
});

beforeEach(() => {
  localStorage.clear();
  saved = [];
  copied = [];
});

afterEach(() => cleanup());

/** 两条普通笔记（一条带变量、一条不带）+ 一条 SQL 片段（本页应过滤掉） */
const FIXTURE: Note[] = [
  {
    id: 'n1', title: '踩坑记录', content: '普通笔记正文', tags: ['a'], kind: 'note',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 'n2', title: '带变量的笔记', content: "select * from t where dt='{{today}}'", tags: [], kind: 'note',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 's1', title: '一条 SQL 片段', content: 'select 1', tags: [], kind: 'sql',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
];

describe('笔记页：行内「复制」入口（第三批 D）', () => {
  it('无变量的笔记：入口存在，弹窗提示可直接复制，点「替换并复制」拿到原文', async () => {
    stubElectronApi([FIXTURE[0]]);
    const { container } = render(<NotesBody />);
    await waitFor(() => expect(CARDS(container).length).toBe(1));

    const btn = copyBtnOf(cardOf(container, '踩坑记录'));
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('title')).toContain('复制');

    fireEvent.click(btn);
    const dlg = await waitFor(dialogOf);
    expect(dlg.textContent).toContain('这段内容里没有');
    expect(dlg.querySelectorAll('input[aria-label^="变量 "]').length).toBe(0);

    fireEvent.click(within(dlg).getByRole('button', { name: /替换并复制/ }));
    await waitFor(() => expect(copied).toEqual(['普通笔记正文']));
    await waitFor(() => expect(container.textContent).toContain('已复制'));
  });

  it('有 {{变量}} 的笔记：出输入框与预览；「复制原文」与「替换并复制」互不影响', async () => {
    stubElectronApi([FIXTURE[1]]);
    const { container } = render(<NotesBody />);
    await waitFor(() => expect(CARDS(container).length).toBe(1));
    const btn = copyBtnOf(cardOf(container, '带变量的笔记'));

    // 路径一：复制原文（不做任何替换）
    fireEvent.click(btn);
    const dlg = await waitFor(dialogOf);
    expect(dlg.querySelector('input[aria-label="变量 today"]')).toBeTruthy();
    fireEvent.click(within(dlg).getByRole('button', { name: /复制原文/ }));
    await waitFor(() => expect(copied).toEqual(["select * from t where dt='{{today}}'"]));

    // 路径二：填值后替换并复制（预览与剪贴板同源）
    fireEvent.click(btn);
    const dlg2 = await waitFor(dialogOf);
    const input = dlg2.querySelector('input[aria-label="变量 today"]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2026-03-01' } });
    expect(dlg2.querySelector('.sql-var-preview')?.textContent).toContain("dt='2026-03-01'");
    fireEvent.click(within(dlg2).getByRole('button', { name: /替换并复制/ }));
    await waitFor(() => expect(copied.length).toBe(2));
    expect(copied[1]).toBe("select * from t where dt='2026-03-01'");
  });

  it('kind==="sql" 的条目仍不出现在笔记页（因此也没有复制入口）', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<NotesBody />);
    await waitFor(() => expect(CARDS(container).length).toBe(2));

    expect(container.textContent).not.toContain('一条 SQL 片段');
    expect(CARDS(container).some(c => (c.textContent || '').includes('一条 SQL 片段'))).toBe(false);
  });
});

describe('笔记页：目录模式的复制入口（第三批 D）', () => {
  it('目录卡片行内有入口，点开弹窗正文来自 .md 文件', async () => {
    localStorage.setItem('pm.notes.dir', 'fixtures/notes');
    const reads: string[] = [];
    stubElectronApi([], {
      notesList: () => Promise.resolve({
        success: true,
        data: [{ name: 'a.md', mtime: '2026-01-01T00:00:00.000Z', size: 12 }],
      }),
      notesRead: (_dir: string, name: string) => {
        reads.push(name);
        return Promise.resolve({
          success: true,
          data: { content: "目录笔记 '{{today}}'", mtime: '2026-01-01T00:00:00.000Z' },
        });
      },
    });

    const { container } = render(<NotesBody />);
    await waitFor(() => expect(CARDS(container).length).toBe(1));
    await waitFor(() => expect(reads).toContain('a.md'));

    fireEvent.click(copyBtnOf(cardOf(container, 'a')));
    const dlg = await waitFor(dialogOf);
    expect(dlg.querySelector('input[aria-label="变量 today"]')).toBeTruthy();
    expect(dlg.querySelector('.sql-var-preview')?.textContent).toContain("目录笔记 '{{today}}'");
  });

  it('正文没缓存时点复制会现读一次（分类最多只读前 20 个）', async () => {
    localStorage.setItem('pm.notes.dir', 'fixtures/notes');
    const files = Array.from({ length: 21 }, (_, i) => ({
      name: `n${String(i + 1).padStart(2, '0')}.md`,
      mtime: '2026-01-01T00:00:00.000Z',
      size: 10,
    }));
    const reads: string[] = [];
    stubElectronApi([], {
      notesList: () => Promise.resolve({ success: true, data: files }),
      notesRead: (_dir: string, name: string) => {
        reads.push(name);
        return Promise.resolve({
          success: true,
          data: { content: `正文 ${name} '{{today}}'`, mtime: '2026-01-01T00:00:00.000Z' },
        });
      },
    });

    const { container } = render(<NotesBody />);
    await waitFor(() => expect(CARDS(container).length).toBe(21));
    await waitFor(() => expect(reads.length).toBe(20)); // 分类阶段只读前 20 个
    expect(reads).not.toContain('n21.md');

    fireEvent.click(copyBtnOf(cardOf(container, 'n21')));
    await waitFor(() => expect(reads).toContain('n21.md')); // 复制入口自己补读了一次
    const dlg = await waitFor(dialogOf);
    expect(dlg.querySelector('.sql-var-preview')?.textContent).toContain("正文 n21.md '{{today}}'");
  });
});

