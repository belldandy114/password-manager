// @vitest-environment jsdom
// 笔记页「去 SQL 化」回归（1.31，用户验收第二轮要求：笔记页删除 SQL 相关的，测试笔记还是要的）。
//
// 这份文件原来是「类型边界回归」（守 SQL 徽标 / 类型图标 / 两个新建入口），
// 1.31 起用户要求笔记页彻底没有类型 UI，于是断言反向重写，现在守的是：
//   1. 本地库模式：只渲染笔记（`kind==='sql'` / `'weekly'` 仍被过滤），页头只剩「新建笔记」；
//   2. 目录模式：`.sql.md` 由 SQL 片段页接管，**不出现在笔记列表**；
//   3. 两种模式：没有 `.notes-kind-bar`、页面文本里搜不到「SQL」；
//   4. 笔记自己的新建 / 搜索 / 分页没被这次减法改坏。
//
// 注意：本文件的修改超出 t2 任务书列出的 inScope（只写了 `src/pages/Notes.tsx`），
// 已获队长消息授权（改的是守旧行为的那几条断言，不修改任何产品逻辑）。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import { NotesBody } from '../Notes';
import { JsonTool } from '../../components/toolbox/JsonTool';
import { useStore } from '../../store/useStore';

const NOTES = [
  {
    id: 'n1', title: '登录偶发 500 排查', content: '## 现象\n点击登录偶发 500', kind: 'note',
    tags: [], updatedAt: '2026-11-20T10:00:00.000Z',
  },
  {
    id: 's1', title: '查启用账号', content: 'select * from t_user where status = 1', kind: 'sql',
    tags: [], updatedAt: '2026-11-20T09:00:00.000Z',
  },
  {
    id: 'w1', title: '周报句式片段', content: '本周完成 x 项', kind: 'weekly',
    tags: [], updatedAt: '2026-11-20T08:00:00.000Z',
  },
];

function stubElectronApi(overrides: Record<string, unknown> = {}) {
  const failIpc = () => Promise.resolve({ success: false, error: 'stub' });
  // onXxx / offXxx 这类订阅式接口不是 Promise，返回值会被当成退订函数调用
  const unsubscribe = () => () => {};
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(overrides, {
    get(obj, prop: string) {
      if (prop in obj) return obj[prop];
      if (/^(on|off|once|remove|unsubscribe|subscribe)/i.test(prop)) return unsubscribe;
      return failIpc;
    },
  });
}

beforeAll(() => {
  // jsdom 没有这几个观察器 / 媒体查询，页面里用到会直接抛
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // 目录是 store 单例上的设置：上一个用例设过会漏到下一个
  useStore.setState({ settings: { ...useStore.getState().settings, notesDir: '' } });
});

afterEach(() => cleanup());

/* ==================== 1. 本地库模式：只有笔记，没有任何类型 UI ==================== */

describe('本地库模式：只显示笔记，页头只剩「新建笔记」', () => {
  it('插入 1 条 note + 1 条 sql + 1 条 weekly，只渲染 note；无筛选条 / 无 SQL 文案', async () => {
    stubElectronApi({
      wsGet: (key: string) => Promise.resolve(key === 'notes' ? { success: true, data: NOTES } : { success: false }),
    });
    const { container } = render(<NotesBody />);
    await waitFor(() => expect(container.querySelectorAll('.card2').length).toBe(1));

    expect(container.textContent).toContain('登录偶发 500 排查');
    expect(container.textContent).not.toContain('查启用账号');
    expect(container.textContent).not.toContain('周报句式片段');

    // 类型筛选条、类型图标、SQL 徽标：全都没有
    expect(container.querySelector('.notes-kind-bar')).toBeNull();
    expect(container.querySelector('.pill.pill-info')).toBeNull();
    expect(container.querySelector('[role="img"][aria-label*="片段"]')).toBeNull();

    // 页头只有一个主按钮，且没有 SQL 入口
    const head = container.querySelector('.pg-tools') as HTMLElement;
    expect(within(head).getByRole('button', { name: /新建笔记/ }).className).toContain('btn-primary');
    expect(within(head).queryByRole('button', { name: /新建 SQL 片段/ })).toBeNull();

    // 用户可见文案里不该再出现「SQL」两个字
    expect(container.textContent).not.toContain('SQL');
  });

  it('新建笔记弹窗里也没有类型选择器（本地库模式写不出 SQL 片段）', async () => {
    stubElectronApi({
      wsGet: (key: string) => Promise.resolve(key === 'notes' ? { success: true, data: [] } : { success: false }),
    });
    const { container } = render(<NotesBody />);
    const head = container.querySelector('.pg-tools') as HTMLElement;
    fireEvent.click(await waitFor(() => within(head).getByRole('button', { name: /新建笔记/ })));

    // 弹窗标题就是「新建笔记」，没有「新建 SQL 片段」
    await waitFor(() => expect(document.querySelector('.modal, [role="dialog"]')).toBeTruthy());
    expect(document.body.textContent).toContain('新建笔记');
    expect(document.body.textContent).not.toContain('SQL');
    expect(document.body.querySelector('.notes-kind-bar')).toBeNull();
  });
});

/* ==================== 2. 目录模式：.sql.md 归 SQL 片段页，笔记页不显示 ==================== */

describe('目录模式：.sql.md 文件不出现在笔记列表', () => {
  it('目录里 a.md + b.sql.md → 列表只有 a.md，且页面文本不含 SQL', async () => {
    localStorage.setItem('pm.notes.dir', 'C:\\notes');
    stubElectronApi({
      notesList: () => Promise.resolve({
        success: true,
        data: [
          { name: 'a.md', size: 1200, mtime: '2026-11-20T10:00:00.000Z' },
          { name: 'b.sql.md', size: 800, mtime: '2026-11-20T09:00:00.000Z' },
        ],
      }),
      attachmentEnsureNoteDir: () => Promise.resolve({ success: true }),
    });
    const { container } = render(<NotesBody />);
    await waitFor(() => expect(container.querySelectorAll('.card2').length).toBe(1));

    // 只剩 a.md：b.sql.md 归 SQL 片段页（那边接管新增/编辑/删除/列表/搜索/导出）
    const cards = container.querySelector('.cards') as HTMLElement;
    expect(cards.textContent).toContain('a');
    expect(cards.textContent).not.toContain('b');

    // 不再有类型标识，也不再有类型筛选条
    expect(container.querySelector('.notes-kind-bar')).toBeNull();
    expect(container.querySelector('.pill.pill-info')).toBeNull();
    expect(container.querySelector('[role="img"][aria-label*="片段"]')).toBeNull();

    // 页头同样只有「新建笔记」
    const head = container.querySelector('.pg-tools') as HTMLElement;
    expect(within(head).getByRole('button', { name: /新建笔记/ })).toBeTruthy();
    expect(within(head).queryByRole('button', { name: /新建 SQL 片段/ })).toBeNull();

    // 目录条只数笔记篇数（b.sql.md 不算）
    expect(container.querySelector('.notes-dirbar')?.textContent).toContain('1 篇');
    expect(container.textContent).not.toContain('SQL');
  });

  it('目录模式新建笔记 → 存成 标题.md（弹窗里选不出 .sql.md 了）', async () => {
    localStorage.setItem('pm.notes.dir', 'C:\\notes');
    stubElectronApi({
      notesList: () => Promise.resolve({ success: true, data: [] }),
      attachmentEnsureNoteDir: () => Promise.resolve({ success: true }),
    });
    const { container } = render(<NotesBody />);

    const head = container.querySelector('.pg-tools') as HTMLElement;
    fireEvent.click(await waitFor(() => within(head).getByRole('button', { name: /新建笔记/ })));

    await waitFor(() => expect(document.querySelector('.assert-hint code')).toBeTruthy());
    const name = document.querySelector('.assert-hint code')!.textContent || '';
    expect(name).toBe('C:\\notes\\未命名笔记.md');
    expect(name.includes('.sql.md')).toBe(false);
    expect(document.body.querySelector('.notes-kind-bar')).toBeNull();
    expect(document.body.textContent).not.toContain('SQL');
  });
});

/* ==================== 3. 减法没改坏笔记自己的功能：新建 / 编辑 / 搜索 / 分页 ==================== */

describe('笔记的新建 / 编辑 / 搜索 / 分页与减法前一致', () => {
  it('编辑笔记：改标题保存后列表与落盘数据都用新标题，弹窗里没有类型选择器', async () => {
    const saved: { key: string; data: Array<{ title: string; content: string; kind?: string }> }[] = [];
    stubElectronApi({
      wsGet: (key: string) => Promise.resolve(key === 'notes' ? { success: true, data: [NOTES[0]] } : { success: false }),
      wsSet: (key: string, data: unknown) => {
        saved.push({ key, data: data as Array<{ title: string; content: string; kind?: string }> });
        return Promise.resolve({ success: true });
      },
    });
    const { container } = render(<NotesBody />);
    await waitFor(() => expect(container.querySelectorAll('.card2').length).toBe(1));

    // 卡片上的「编辑」是图标按钮，title 是「编辑」
    fireEvent.click(container.querySelector('.card2 .ibtn[title="编辑"]') as HTMLElement);
    const title = await waitFor(() => document.querySelector('input[aria-label="标题"]') as HTMLInputElement);
    expect(title.value).toBe('登录偶发 500 排查');
    // 正文还在（编辑入口没有丢掉内容）
    expect((document.querySelector('textarea[aria-label*="内容"]') as HTMLTextAreaElement).value)
      .toContain('点击登录偶发 500');
    // 弹窗里已经没有类型选择器 / SQL 文案
    expect(document.body.querySelector('.notes-kind-bar')).toBeNull();
    expect(document.body.textContent).not.toContain('SQL');

    fireEvent.change(title, { target: { value: '登录偶发 500 排查（补充）' } });
    fireEvent.click(within(document.body).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].key).toBe('notes');
    expect(saved[0].data[0].title).toBe('登录偶发 500 排查（补充）');
    expect(saved[0].data[0].content).toContain('点击登录偶发 500');
    // kind 不被这次减法改掉（老数据字段原样保留）
    expect(saved[0].data[0].kind).toBe('note');
    await waitFor(() => expect(container.textContent).toContain('登录偶发 500 排查（补充）'));
  });

  const many = Array.from({ length: 30 }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return {
      id: `m${n}`,
      title: `条目标题 ${n}`,
      content: `正文 ${n}`,
      kind: 'note',
      tags: [],
      // 越靠后越新 → 排序后第 1 页是 30..07，第 2 页是 06..01
      updatedAt: `2026-11-${String(1 + i).padStart(2, '0')}T10:00:00.000Z`,
    };
  });

  it('一页 24 条 + 翻页 + 搜索都能用', async () => {
    stubElectronApi({
      wsGet: (key: string) => Promise.resolve(key === 'notes' ? { success: true, data: many } : { success: false }),
    });
    const { container } = render(<NotesBody />);
    await waitFor(() => expect(container.querySelectorAll('.card2').length).toBe(24));

    // 分页条：30 条 / 每页 24 → 1 / 2
    const pager = container.querySelector('.pager') as HTMLElement;
    expect(pager).toBeTruthy();
    expect(pager.querySelector('.pager-cur')?.textContent).toBe('1 / 2');
    expect(container.textContent).toContain('条目标题 30');
    expect(container.textContent).not.toContain('条目标题 01');

    // 下一页 → 第 2 页只剩 6 条
    const pagerBtns = pager.querySelectorAll('.pager-ctrl .pager-btn');
    fireEvent.click(pagerBtns[3]); // 4 个按钮：首页 / 上一页 / 下一页 / 末页
    await waitFor(() => expect(container.querySelectorAll('.card2').length).toBe(6));
    expect(container.querySelector('.pager-cur')?.textContent).toBe('2 / 2');
    expect(container.textContent).toContain('条目标题 01');

    // 搜索：只剩命中的那条，且分页复位到第 1 页（1 条时不渲染分页条）
    const search = container.querySelector('.pg-tools .search input') as HTMLInputElement;
    expect(search).toBeTruthy();
    fireEvent.change(search, { target: { value: '条目标题 15' } });
    await waitFor(() => expect(container.querySelectorAll('.card2').length).toBe(1));
    expect(container.textContent).toContain('条目标题 15');
    expect(container.querySelector('.pager')).toBeNull();
    expect(container.textContent).not.toContain('SQL');
  });
});

/* ==================== 4. 工具箱 JSON 输入框占位符（与本轮无关，原样保留） ==================== */

describe('工具箱 JSON 输入框占位符', () => {
  it('占位符 ≤ 30 字，完整说明（含 Ctrl+Enter）仍在 title 与 aria-label 里', () => {
    const { container } = render(<JsonTool />);
    const ta = container.querySelector('textarea.json-io') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();

    const placeholder = ta.getAttribute('placeholder') || '';
    // 430px 宽的输入框放不下 40 字，占位符必须短（按字符数算，不是按字节）
    expect(Array.from(placeholder).length).toBeLessThanOrEqual(30);
    expect(placeholder).toContain('单引号');
    expect(placeholder).toContain('无引号键');
    expect(placeholder).toContain('注释');
    expect(placeholder).toContain('多余逗号');

    // 完整说明一个字都没少：title（悬停）+ aria-label（读屏）
    for (const attr of ['title', 'aria-label']) {
      const full = ta.getAttribute(attr) || '';
      expect(full, `${attr} 应保留完整说明`).toContain('Ctrl+Enter');
      expect(full).toContain('日志');
      expect(full).toContain('无引号键');
      expect(full.length).toBeGreaterThan(placeholder.length);
    }
  });
});
