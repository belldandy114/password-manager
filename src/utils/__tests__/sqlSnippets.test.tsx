// @vitest-environment jsdom
// SQL 片段独立页的回归（1.30.2）。
//
// 分两段：
//   A. 纯口径（页面把这些函数导出，页面逻辑全部走它们）：KPI / 搜索 / 排序 / 标签栏
//   B. 真实渲染（jsdom + 打桩 IPC）：列表与 KPI、搜索无结果文案、收藏筛选、新建落盘、
//      点行编辑回填 + 重排、旧数据不带新字段也能编辑、目录模式渲染完整页面
//      （1.31 起目录模式直接读写 `.sql.md`，细节见 utils/__tests__/sqlFrontmatter.test.ts）
//
// 断言的判据来自 docs/agents/sql-snippets-page.md §7（12 条验收）。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import type { Note } from '../../types';
import {
  startOfWeek, sqlOnly, countSql, matchSql, filterSql, sortSql, tagsOf, countByTag,
  buildSqlMarkdown, exportFileName, fmtStamp,
  SqlSnippets,
} from '../../pages/SqlSnippets';

/* ============================ A. 纯口径 ============================ */

const note = (over: Partial<Note>): Note => ({
  id: 'n', title: '', content: '', tags: [], updatedAt: '2026-11-01T00:00:00.000Z', ...over,
});
const sql = (over: Partial<Note>): Note => note({ kind: 'sql', ...over });

/** 2026-11-21 是周六 → 本周一 = 2026-11-16 00:00（本地时区） */
const SAT = new Date(2026, 10, 21, 10, 30, 0);
const MONDAY = new Date(2026, 10, 16, 0, 0, 0).getTime();
/** 周一 00:00 之后 1 分钟（算「本周」） */
const IN_WEEK = new Date(2026, 10, 16, 0, 1, 0).toISOString();
/** 周一 00:00 之前 1 分钟（算「上周」） */
const LAST_WEEK = new Date(2026, 10, 15, 23, 59, 0).toISOString();

describe('SQL 片段：数据源只认 kind==="sql"', () => {
  it('普通笔记 / 周报片段都不进这一页', () => {
    const notes: Note[] = [
      sql({ id: 's1' }),
      note({ id: 'n1', kind: 'note' }),
      note({ id: 'w1', kind: 'weekly' }),
      note({ id: 'n2' }), // 老数据没有 kind = 普通笔记
    ];
    expect(sqlOnly(notes).map(n => n.id)).toEqual(['s1']);
    expect(sqlOnly(null)).toEqual([]);
  });
});

describe('SQL 片段：KPI 口径（全部 / 收藏 / 本周新增）', () => {
  it('本周一 00:00 是一周的起点，周日仍算上一周', () => {
    expect(new Date(startOfWeek(SAT)).getDay()).toBe(1);
    expect(startOfWeek(SAT)).toBe(MONDAY);
    const sundayNoon = new Date(2026, 10, 22, 12, 0, 0);
    expect(new Date(startOfWeek(sundayNoon)).getDate()).toBe(16);
  });

  it('「本周新增」按 updatedAt >= 本周一 00:00 计；「全部 / 收藏」只数 sql 条目', () => {
    const notes: Note[] = [
      sql({ id: 'a', starred: true, updatedAt: IN_WEEK }),
      sql({ id: 'b', updatedAt: LAST_WEEK }),
      note({ id: 'c', kind: 'note', updatedAt: IN_WEEK }), // 不是 sql，KPI 不该数进去
    ];
    expect(countSql(notes, SAT)).toEqual({ all: 2, starred: 1, week: 1 });
  });

  it('updatedAt 坏值 / 空值不计入本周新增，也不炸', () => {
    const notes: Note[] = [
      sql({ id: 'x', updatedAt: '' }),
      sql({ id: 'y', updatedAt: 'not-a-date' }),
      sql({ id: 'z', updatedAt: IN_WEEK }),
    ];
    expect(countSql(notes, SAT)).toEqual({ all: 3, starred: 0, week: 1 });
  });

  it('「收藏」筛选只剩 starred===true，计数与之一致', () => {
    const notes: Note[] = [
      sql({ id: 'a', starred: true }),
      sql({ id: 'b', starred: false }),
      sql({ id: 'c' }), // 老数据没有 starred
    ];
    expect(filterSql(notes, { starredOnly: true }).map(n => n.id)).toEqual(['a']);
    expect(countSql(notes, SAT).starred).toBe(filterSql(notes, { starredOnly: true }).length);
  });
});

describe('SQL 片段：搜索三路（标题 / 正文 / 标签）', () => {
  const list: Note[] = [
    sql({ id: 't', title: '查未支付订单', content: 'select 1', tags: ['订单'] }),
    sql({ id: 'c', title: '账号状态', content: 'select * from t_user where status = 1', tags: [] }),
    sql({ id: 'g', title: '回归脚本', content: 'select 2', tags: ['造数', '回归'] }),
  ];

  it('命中标题', () => {
    expect(filterSql(list, { q: '未支付' }).map(n => n.id)).toEqual(['t']);
  });

  it('命中 SQL 正文片段', () => {
    expect(filterSql(list, { q: 't_user' }).map(n => n.id)).toEqual(['c']);
  });

  it('命中标签', () => {
    expect(filterSql(list, { q: '回归' }).map(n => n.id)).toEqual(['g']);
  });

  it('大小写不敏感；无结果返回空数组（页面据此显示「没有匹配」）', () => {
    expect(filterSql(list, { q: 'T_USER' }).map(n => n.id)).toEqual(['c']);
    expect(filterSql(list, { q: '完全不存在' })).toEqual([]);
    expect(matchSql(list[0], '')).toBe(true); // 空搜索 = 不过滤
  });

  it('标签筛选与搜索可以叠加', () => {
    expect(filterSql(list, { tag: '造数' }).map(n => n.id)).toEqual(['g']);
    expect(filterSql(list, { tag: '造数', q: '不存在' })).toEqual([]);
  });
});

describe('SQL 片段：排序两路', () => {
  it('名称按 localeCompare("zh") 升序（与中文排序规则一致，不硬编码顺序）', () => {
    const list: Note[] = [
      sql({ id: '1', title: 'B 方案' }),
      sql({ id: '2', title: 'A 方案' }),
      sql({ id: '3', title: 'C 方案' }),
    ];
    const expected = ['B 方案', 'A 方案', 'C 方案'].sort((a, b) => a.localeCompare(b, 'zh'));
    expect(sortSql(list, 'title').map(n => n.title)).toEqual(expected);
  });

  it('最近修改按 updatedAt 降序；来回切不丢数据、不改动入参', () => {
    const list: Note[] = [
      sql({ id: 'old', updatedAt: '2026-11-01T00:00:00.000Z' }),
      sql({ id: 'new', updatedAt: '2026-11-20T00:00:00.000Z' }),
    ];
    const snapshot = list.map(n => n.id);
    expect(sortSql(list, 'recent').map(n => n.id)).toEqual(['new', 'old']);
    expect(sortSql(list, 'title').map(n => n.id).length).toBe(2);
    expect(sortSql(list, 'recent').map(n => n.id)).toEqual(['new', 'old']);
    expect(list.map(n => n.id)).toEqual(snapshot); // 入参没被就地排序
  });
});

describe('SQL 片段：左侧标签栏', () => {
  it('标签是并集（中文序），计数只数 sql 条目', () => {
    const notes: Note[] = [
      sql({ id: 'a', tags: ['订单', '造数'] }),
      sql({ id: 'b', tags: ['订单'] }),
      note({ id: 'c', kind: 'note', tags: ['笔记标签'] }),
    ];
    expect(tagsOf(notes)).toEqual(['订单', '造数'].sort((a, b) => a.localeCompare(b, 'zh')));
    expect(countByTag(notes)).toEqual({ 订单: 2, 造数: 1 });
  });
});

/* ============================ B. 真实渲染 ============================ */

type SavedCall = { key: string; data: Note[] };
let saved: SavedCall[] = [];

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
      if (prop in obj) return obj[prop];
      if (/^(on|off|once|remove|unsubscribe|subscribe)/i.test(prop)) return unsubscribe;
      return failIpc;
    },
  });
}

const ROWS = (root: ParentNode) => [...root.querySelectorAll('.tbl tbody tr')] as HTMLElement[];
const KPI = (root: ParentNode) => [...root.querySelectorAll('.home-stat')].map(el => el.textContent || '');

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
});

beforeEach(() => {
  localStorage.clear();
  saved = [];
});

afterEach(() => cleanup());

const FIXTURE: Note[] = [
  {
    id: 's1', title: '查未支付订单', content: 'select * from t_order where paid = 0',
    tags: ['订单'], kind: 'sql', updatedAt: '2020-01-01T00:00:00.000Z',
    dbOrEnv: 'test_order', varHint: '{{today}} = 今天', remark: '只读', starred: true,
  },
  {
    id: 's2', title: '账号状态', content: 'select * from t_user where status = 1',
    tags: ['账号'], kind: 'sql', updatedAt: new Date().toISOString(),
  },
  {
    id: 'n1', title: '一条普通笔记', content: '踩坑记录', tags: [], kind: 'note',
    updatedAt: new Date().toISOString(),
  },
];

describe('SQL 片段页：列表 / KPI / 搜索 / 收藏 / 排序', () => {
  it('只列 sql 条目（普通笔记不出现），KPI 三卡口径与筛选一致', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    expect(container.textContent).not.toContain('一条普通笔记');
    expect(container.querySelector('.tbl')?.textContent).toContain('查未支付订单');
    expect(container.querySelector('.tbl')?.textContent).toContain('test_order');

    const kpi = KPI(container);
    expect(kpi[0]).toContain('2'); // 全部
    expect(kpi[1]).toContain('1'); // 收藏
    expect(kpi[2]).toContain('1'); // 本周新增（s2 是刚更新的）
    expect(container.querySelector('.tag-sidebar')?.textContent).toContain('收藏');
  });

  it('搜索：命中正文，无结果给「没有匹配」而不是空白', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    const input = container.querySelector('.search input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 't_user' } });
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    expect(ROWS(container)[0].textContent).toContain('账号状态');

    fireEvent.change(input, { target: { value: '这个词库里有吗' } });
    await waitFor(() => expect(container.querySelector('.tbl')).toBeNull());
    expect(container.textContent).toContain('没有匹配');
  });

  it('切「收藏」只剩 starred===true，KPI 收藏数与之一致', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    const rail = container.querySelector('.tag-sidebar') as HTMLElement;
    fireEvent.click(within(rail).getByRole('button', { name: /^收藏/ }));
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    expect(ROWS(container)[0].textContent).toContain('查未支付订单');
    expect(KPI(container)[1]).toContain('1');
  });

  it('排序：切「名称」按中文升序，切回「最近修改」恢复降序', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    // 默认最近修改：刚更新的 s2 在前
    expect(ROWS(container)[0].textContent).toContain('账号状态');

    const sel = container.querySelector('select[aria-label="排序方式"]') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'title' } });
    await waitFor(() => expect(ROWS(container)[0].textContent).toContain('查未支付订单'));
    const expected = ['查未支付订单', '账号状态'].sort((a, b) => a.localeCompare(b, 'zh'));
    expect(ROWS(container).map(r => expected.find(t => r.textContent!.includes(t)))).toEqual(expected);

    fireEvent.change(sel, { target: { value: 'recent' } });
    await waitFor(() => expect(ROWS(container)[0].textContent).toContain('账号状态'));
  });
});

describe('SQL 片段页：长文本靠 title 显示全文（table-layout: fixed + 省略号）', () => {
  it('名称列与库·环境列的 span 带完整 title；空库名不挂 title；行级提示各管各的', async () => {
    const longTitle = '查某天已支付但超过 24 小时未回调、且涉及优惠券分摊与退款流水核对的订单';
    const longDb = 'test_order_2026_q4 / 预发环境（华东）';
    stubElectronApi([
      {
        id: 'long', title: longTitle, content: 'select 1', tags: ['订单'], kind: 'sql',
        updatedAt: '2020-01-01T00:00:00.000Z', dbOrEnv: longDb,
      },
      {
        id: 'nodb', title: '没写库的片段', content: 'select 2', tags: [], kind: 'sql',
        updatedAt: '2019-01-01T00:00:00.000Z',
      },
    ]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    const row = ROWS(container).find(r => r.textContent!.includes('未回调')) as HTMLElement;
    const nameSpan = row.querySelector('td:nth-child(1) span[title]') as HTMLElement;
    const dbTd = row.querySelector('td:nth-child(2)') as HTMLElement;
    // 完整值（不是省略号后的可见文本，也不是行级提示）
    expect(nameSpan.getAttribute('title')).toBe(longTitle);
    expect(dbTd.getAttribute('title')).toBe(longDb);
    // 行级 title 仍是操作提示；列级 title 挂在更内层的元素上，两者不互相覆盖
    expect(row.getAttribute('title')).toContain('点这一行编辑');
    expect(nameSpan.getAttribute('title')).not.toContain('点这一行编辑');
    expect(nameSpan.getAttribute('title')).not.toBe(row.getAttribute('title'));

    // 空库 / 环境：不挂 title，避免悬停弹出空气泡（落在行级提示上）
    const noDbRow = ROWS(container).find(r => r.textContent!.includes('没写库的片段')) as HTMLElement;
    expect(noDbRow.querySelector('td:nth-child(2)')?.getAttribute('title')).toBeNull();
    expect(noDbRow.querySelector('td:nth-child(1) span[title]')?.getAttribute('title')).toBe('没写库的片段');
  });
});

describe('SQL 片段页：新增 / 编辑（四个新字段）', () => {
  it('新增：名称与 SQL 必填；保存后 kind=sql、四个新字段按弹窗内容落盘', async () => {
    stubElectronApi([]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(container.textContent).toContain('还没有 SQL 片段'));

    fireEvent.click(within(container.querySelector('.pg-tools') as HTMLElement).getByRole('button', { name: /新增片段/ }));
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
    const saveBtn = within(dialog).getByRole('button', { name: '保存' }) as HTMLButtonElement;

    expect(saveBtn.disabled).toBe(true); // 名称 + SQL 都空
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '查订单' } });
    expect(saveBtn.disabled).toBe(true); // 只填名称仍不可保存
    fireEvent.change(within(dialog).getByLabelText('SQL 正文'), { target: { value: 'select * from t_order' } });
    expect(saveBtn.disabled).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('库或环境'), { target: { value: 'test_order' } });
    fireEvent.change(within(dialog).getByLabelText('变量说明'), { target: { value: '{{today}} = 今天' } });
    fireEvent.change(within(dialog).getByLabelText('备注'), { target: { value: '别在生产跑' } });
    fireEvent.change(within(dialog).getByLabelText('标签'), { target: { value: '订单, 造数' } });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(saveBtn);

    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].key).toBe('notes');
    expect(saved[0].data.length).toBe(1);
    expect(saved[0].data[0]).toMatchObject({
      kind: 'sql',
      title: '查订单',
      content: 'select * from t_order',
      dbOrEnv: 'test_order',
      varHint: '{{today}} = 今天',
      remark: '别在生产跑',
      starred: true,
      tags: ['订单', '造数'],
    });
  });

  it('编辑：点行回填全部字段；保存后 updatedAt 更新、旧字段不丢、列表重排到最前', async () => {
    const old: Note = {
      id: 'old', title: '旧片段', content: 'select 1', tags: ['a'], kind: 'sql',
      updatedAt: '2020-01-01T00:00:00.000Z', dbOrEnv: 'old_db', varHint: '{{x}}', remark: '旧备注',
      starred: false, links: [{ kind: 'env', id: 'e1', label: '预发' }],
    };
    const newer: Note = {
      id: 'newer', title: '新片段', content: 'select 2', tags: [], kind: 'sql',
      updatedAt: '2020-06-01T00:00:00.000Z',
    };
    stubElectronApi([old, newer]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));
    expect(ROWS(container)[0].textContent).toContain('新片段'); // 最近修改降序

    const oldRow = ROWS(container).find(r => r.textContent!.includes('旧片段')) as HTMLElement;
    fireEvent.click(oldRow);
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);

    // 回填：名称 / 库环境 / SQL / 变量说明 / 备注 + 收藏与标签
    expect((within(dialog).getByLabelText('名称') as HTMLInputElement).value).toBe('旧片段');
    expect((within(dialog).getByLabelText('库或环境') as HTMLInputElement).value).toBe('old_db');
    expect((within(dialog).getByLabelText('SQL 正文') as HTMLTextAreaElement).value).toBe('select 1');
    expect((within(dialog).getByLabelText('变量说明') as HTMLTextAreaElement).value).toBe('{{x}}');
    expect((within(dialog).getByLabelText('备注') as HTMLInputElement).value).toBe('旧备注');
    expect((within(dialog).getByLabelText('标签') as HTMLInputElement).value).toBe('a');

    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: '改过的片段' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(saved.length).toBe(1));
    const arr = saved[0].data;
    expect(arr.length).toBe(2); // 另一条不能被冲掉
    const edited = arr.find(n => n.id === 'old')!;
    expect(edited.title).toBe('改过的片段');
    expect(edited.updatedAt > '2020-06-01T00:00:00.000Z').toBe(true); // 时间更新了
    expect(edited.tags).toEqual(['a']); // 旧字段不丢
    expect(edited.links).toEqual([{ kind: 'env', id: 'e1', label: '预发' }]);

    // 列表按 updatedAt 重排：刚编辑的排到最前
    await waitFor(() => expect(ROWS(container)[0].textContent).toContain('改过的片段'));
  });

  it('旧数据（没有四个新字段）能正常列出并编辑保存，保存后不丢旧字段', async () => {
    const legacy: Note = {
      id: 'legacy', title: '老的 SQL 片段', content: 'select * from t_old', tags: ['历史'],
      kind: 'sql', updatedAt: '2019-01-01T00:00:00.000Z',
    };
    stubElectronApi([legacy]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    expect(container.querySelector('.tbl')?.textContent).toContain('老的 SQL 片段');
    expect(container.textContent).not.toContain('NaN');

    fireEvent.click(ROWS(container)[0]);
    const dialog = await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
    // 缺省字段当空：不报错、输入框是空的
    expect((within(dialog).getByLabelText('库或环境') as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText('备注') as HTMLInputElement).value).toBe('');

    fireEvent.change(within(dialog).getByLabelText('库或环境'), { target: { value: '旧库' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(saved.length).toBe(1));
    const savedLegacy = saved[0].data[0];
    expect(savedLegacy.dbOrEnv).toBe('旧库');
    expect(savedLegacy.title).toBe('老的 SQL 片段');
    expect(savedLegacy.content).toBe('select * from t_old');
    expect(savedLegacy.tags).toEqual(['历史']);
    expect(savedLegacy.kind).toBe('sql');
  });
});

describe('SQL 片段页：目录模式（1.31 起完整可用，不再是提示页）', () => {
  it('渲染完整页面：列表来自目录里的 .sql.md，标签栏/KPI/排序都在', async () => {
    localStorage.setItem('pm.notes.dir', 'C:\\notes');
    const reads: string[] = [];
    let listCalls = 0;
    stubElectronApi([], {
      notesList: () => {
        listCalls += 1;
        return Promise.resolve({
          success: true,
          data: [
            { name: '查未支付订单.sql.md', size: 120, mtime: '2026-11-21T12:05:00.000Z' },
            { name: '一条普通笔记.md', size: 80, mtime: '2026-11-20T12:05:00.000Z' },
          ],
        });
      },
      notesRead: (_dir: string, name: string) => {
        reads.push(name);
        const content = name.endsWith('.sql.md')
          ? '---\nstarred: true\ntags: [订单]\nupdatedAt: 2026-11-21T12:05:00.000Z\n---\n\nselect 1'
          : '# 普通笔记';
        return Promise.resolve({ success: true, data: { name, content, mtime: '2026-11-21T12:05:00.000Z' } });
      },
    });
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));

    // 完整页面：左侧栏 + 三张 KPI + 排序下拉 + 表格
    expect(container.querySelector('.tag-sidebar')).toBeTruthy();
    expect(KPI(container)).toHaveLength(3);
    expect(container.querySelector('select[aria-label="排序方式"]')).toBeTruthy();

    // 旧提示整段删了
    expect(container.textContent).not.toContain('请到「笔记与附件」里管理');
    expect(container.textContent).not.toContain('本页只在本地加密库里读写');

    // 列表只来自 .sql.md；标题去掉 .sql 后缀；收藏来自 frontmatter.starred
    expect(container.querySelector('.tbl')?.textContent).toContain('查未支付订单');
    expect(container.querySelector('.tbl')?.textContent).not.toContain('.sql.md');
    expect(container.textContent).not.toContain('一条普通笔记');
    expect(KPI(container)[1]).toContain('1');

    // 目录 IPC 真的被调用了，而且只读了那篇 .sql.md（普通 .md 不读）
    expect(listCalls).toBeGreaterThan(0);
    expect(reads).toEqual(['查未支付订单.sql.md']);
  });
});

/* ============================ C. 导出 Markdown（1.31） ============================ */

describe('导出 Markdown：buildSqlMarkdown 的固定格式', () => {
  it('0 条：标题写「0 条」并附一句说明，不是空字符串', () => {
    const md = buildSqlMarkdown([]);
    expect(md).toBe('# SQL 片段（0 条）\n\n（没有可导出的片段）\n');
    // null / undefined 与空数组同口径（调用方可能还没读到数据）
    expect(buildSqlMarkdown(null)).toBe(md);
    expect(buildSqlMarkdown(undefined)).toBe(md);
  });

  it('全字段：字段顺序固定，正文原样进 ```sql 代码块（{{变量}} 不替换、不转义）', () => {
    const one = sql({
      title: '查未支付订单',
      content: "SELECT *\nFROM t_order\nWHERE no = '{{orderNo}}';",
      dbOrEnv: 'test_order / 预发',
      varHint: '{{orderNo}} = 订单号',
      remark: '只读，别在生产跑',
      tags: ['订单', '造数'],
      updatedAt: new Date(2026, 10, 21, 12, 5).toISOString(),
    });
    const md = buildSqlMarkdown([one]);

    expect(md).toBe([
      '# SQL 片段（1 条）',
      '',
      '## 查未支付订单',
      '- 库/环境：test_order / 预发',
      '- 变量：{{orderNo}} = 订单号',
      '- 备注：只读，别在生产跑',
      '- 标签：订单, 造数',
      '- 更新时间：2026-11-21 12:05',
      '',
      '```sql',
      "SELECT *\nFROM t_order\nWHERE no = '{{orderNo}}';",
      '```',
      '',
    ].join('\n'));

    // 字段顺序（按出现位置比，避免「恰好都包含」的假阳性）
    const order = ['## 查未支付订单', '- 库/环境：', '- 变量：', '- 备注：', '- 标签：', '- 更新时间：', '```sql'];
    const at = order.map(k => md.indexOf(k));
    expect(at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1]))).toBe(true);

    // 正文一个字符都没动：变量没被替换成值，引号也没被转义
    expect(md).toContain("WHERE no = '{{orderNo}}';");
  });

  it('空字段整行省略（不留空冒号）；坏时间戳也不留行；只缺一部分时只省略那几行', () => {
    const bare = sql({ title: '最少字段', content: 'select 1', updatedAt: '' });
    expect(buildSqlMarkdown([bare])).toBe('# SQL 片段（1 条）\n\n## 最少字段\n\n```sql\nselect 1\n```\n');
    for (const label of ['库/环境', '变量', '备注', '标签', '更新时间']) {
      expect(buildSqlMarkdown([bare])).not.toContain(`- ${label}：`);
    }
    // 没有任何一行以冒号结尾 = 没有「- 备注：」这种空冒号
    expect(buildSqlMarkdown([bare]).split('\n').some(l => l.endsWith('：'))).toBe(false);

    const half = sql({ title: '半填', content: 'select 2', dbOrEnv: 'test_db', tags: [], updatedAt: 'not-a-date' });
    const md2 = buildSqlMarkdown([half]);
    expect(md2).toContain('- 库/环境：test_db');
    expect(md2).not.toContain('- 标签：');
    expect(md2).not.toContain('- 更新时间：');

    // 时间戳自身的边界：空 / 坏值都返回空串（上层据此省略整行）
    expect(fmtStamp('')).toBe('');
    expect(fmtStamp('not-a-date')).toBe('');
    expect(fmtStamp(null)).toBe('');
  });

  it('多条：标题计数 = 条数，块之间用 --- 分隔（n-1 条，前后各留空行），顺序与传入一致', () => {
    const list = [
      sql({ id: 'a', title: '甲', content: 'select 1', updatedAt: '' }),
      sql({ id: 'b', title: '乙', content: 'select 2', updatedAt: '' }),
      sql({ id: 'c', title: '丙', content: 'select 3', updatedAt: '' }),
    ];
    const md = buildSqlMarkdown(list);
    expect(md.startsWith('# SQL 片段（3 条）')).toBe(true);
    expect(md.match(/^## /gm) || []).toHaveLength(3);
    expect(md.match(/^---$/gm) || []).toHaveLength(2);
    // 前后各一个空行，Markdown 才会把 --- 渲染成分隔线（紧贴上一行会变成标题下划线）
    expect(md).toContain('\n\n---\n\n');
    expect(md.indexOf('## 甲')).toBeLessThan(md.indexOf('## 乙'));
    expect(md.indexOf('## 乙')).toBeLessThan(md.indexOf('## 丙'));
    // 结尾只有一个换行，不堆空行
    expect(md.endsWith('```\n')).toBe(true);
    expect(md.endsWith('\n\n')).toBe(false);
  });

  it('默认文件名 SQL片段-YYYYMMDD-HHmm.md（本地时区，补零）', () => {
    expect(exportFileName(new Date(2026, 10, 21, 9, 5))).toBe('SQL片段-20261121-0905.md');
    expect(exportFileName(new Date(2026, 0, 2, 0, 0))).toBe('SQL片段-20260102-0000.md');
    expect(exportFileName()).toMatch(/^SQL片段-\d{8}-\d{4}\.md$/);
    // 文件名里的时间与「更新时间」同一口径（本地时区、同样的补零）
    expect(fmtStamp(new Date(2026, 10, 21, 9, 5).toISOString())).toBe('2026-11-21 09:05');
  });
});

describe('SQL 片段页：导出按钮与保存通道', () => {
  const exportBtn = (container: HTMLElement) => (
    within(container.querySelector('.pg-tools') as HTMLElement).getByRole('button', { name: /导出 MD/ })
  );

  it('页头有「导出 MD」次级按钮，位置紧挨「刷新」', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    const btn = exportBtn(container);
    expect(btn.className).toContain('btn-secondary'); // 次级按钮，不抢「新增片段」的主按钮
    const tools = container.querySelector('.pg-tools') as HTMLElement;
    const labels = [...tools.querySelectorAll('button')].map(b => (b.textContent || '').trim());
    expect(labels.indexOf('导出 MD')).toBe(labels.indexOf('刷新') + 1);
  });

  it('只导当前筛选后的列表：搜索命中 1 条 → 文件头写 1 条、toast 报「已导出 1 条」', async () => {
    const calls: { content: string; name: string }[] = [];
    stubElectronApi(FIXTURE, {
      saveText: (content: string, defaultName: string) => {
        calls.push({ content, name: defaultName });
        return Promise.resolve({ success: true, data: { file: 'C:\\tmp\\out.md' } });
      },
    });
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.change(container.querySelector('.search input') as HTMLInputElement, { target: { value: 't_user' } });
    await waitFor(() => expect(ROWS(container).length).toBe(1));

    fireEvent.click(exportBtn(container));
    await waitFor(() => expect(calls.length).toBe(1));

    expect(calls[0].content.startsWith('# SQL 片段（1 条）')).toBe(true);
    expect(calls[0].content).toContain('## 账号状态');
    expect(calls[0].content).not.toContain('查未支付订单'); // 被筛掉的不进文件
    expect(calls[0].name).toMatch(/^SQL片段-\d{8}-\d{4}\.md$/);
    await waitFor(() => expect(container.textContent).toContain('已导出 1 条'));
  });

  it('左侧「收藏」筛选同样计入：导出的是收藏那条，而不是全部', async () => {
    const calls: { content: string }[] = [];
    stubElectronApi(FIXTURE, {
      saveText: (content: string) => {
        calls.push({ content });
        return Promise.resolve({ success: true, data: { file: 'C:\\tmp\\out.md' } });
      },
    });
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.click(within(container.querySelector('.tag-sidebar') as HTMLElement).getByRole('button', { name: /^收藏/ }));
    await waitFor(() => expect(ROWS(container).length).toBe(1));

    fireEvent.click(exportBtn(container));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].content.startsWith('# SQL 片段（1 条）')).toBe(true);
    expect(calls[0].content).toContain('## 查未支付订单');
    expect(calls[0].content).not.toContain('## 账号状态');
  });

  it('用户取消保存：静默返回，不抛错、不提示失败也不提示成功', async () => {
    let calls = 0;
    stubElectronApi(FIXTURE, {
      saveText: () => { calls += 1; return Promise.resolve({ success: false, canceled: true }); },
    });
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    // 判据一：点击本身不抛（同步异常会让 fireEvent 直接失败）
    expect(() => fireEvent.click(exportBtn(container))).not.toThrow();
    await waitFor(() => expect(calls).toBe(1));

    // 判据二：界面上一句提示都没有（既不是失败，也不是成功），列表也没被打断。
    // 判据三：handler 内的 rejection 已被 catch —— vitest 会把未处理的 rejection 判为失败。
    expect(container.textContent).not.toContain('导出失败');
    expect(container.textContent).not.toContain('已导出');
    expect(ROWS(container).length).toBe(2);
  });

  it('当前筛选 0 条：不弹保存对话框，直接给提示', async () => {
    let calls = 0;
    stubElectronApi(FIXTURE, {
      saveText: () => { calls += 1; return Promise.resolve({ success: true, data: { file: 'x' } }); },
    });
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.change(container.querySelector('.search input') as HTMLInputElement, { target: { value: '库里没有这个词' } });
    await waitFor(() => expect(container.textContent).toContain('没有匹配'));

    fireEvent.click(exportBtn(container));
    await waitFor(() => expect(container.textContent).toContain('当前筛选下没有可导出的片段'));
    expect(calls).toBe(0); // 一次无效的「选路径」都不该发生
  });
});
