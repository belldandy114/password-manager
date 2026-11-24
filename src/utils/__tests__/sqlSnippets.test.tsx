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
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import type { Note } from '../../types';
import {
  startOfWeek, sqlOnly, countSql, matchSql, filterSql, sortSql, tagsOf, countByTag,
  buildSqlMarkdown, exportFileName, fmtStamp, dbEnvValues,
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

/* ----------------------------------------------------------------
   第三批 C：库 / 环境已有值（纯函数 dbEnvValues）
   ---------------------------------------------------------------- */
describe('SQL 片段：库 / 环境已有值（dbEnvValues）', () => {
  it('按出现次数降序、去重、trim；同票按首次出现顺序', () => {
    const notes: Note[] = [
      sql({ id: 'a', dbOrEnv: 'test_order' }),
      sql({ id: 'b', dbOrEnv: 'test_order / 预发' }),
      sql({ id: 'c', dbOrEnv: 'test_order / 预发' }),
      sql({ id: 'd', dbOrEnv: '  test_order  ' }),
      sql({ id: 'e', dbOrEnv: '' }),
      sql({ id: 'f', dbOrEnv: 'test_order / 预发' }),
    ];
    // 预发 3 次 > test_order 2 次（b 的 "test_order / 预发" 是**另一个**值，不能拆开算）
    expect(dbEnvValues(notes)).toEqual(['test_order / 预发', 'test_order']);

    // 同票时按首次出现：x 先出现、y 后出现
    expect(dbEnvValues([
      sql({ id: 'g', dbOrEnv: 'x' }),
      sql({ id: 'h', dbOrEnv: 'y' }),
    ])).toEqual(['x', 'y']);
  });

  it('最多 8 个；max 可调，0 / 负数返回空', () => {
    const notes = Array.from({ length: 10 }, (_, i) => sql({ id: `n${i}`, dbOrEnv: `db_${i}` }));
    const all = dbEnvValues(notes);
    expect(all).toHaveLength(8);
    expect(all[0]).toBe('db_0');
    expect(dbEnvValues(notes, 2)).toEqual(['db_0', 'db_1']);
    expect(dbEnvValues(notes, 0)).toEqual([]);
    expect(dbEnvValues(notes, -1)).toEqual([]);
  });

  it('只统计 kind==="sql"：普通笔记 / 周报片段的 dbOrEnv 不参与', () => {
    const notes: Note[] = [
      note({ id: 'n1', dbOrEnv: '缺省 kind 的笔记' }),
      note({ id: 'n2', kind: 'note', dbOrEnv: '笔记库' }),
      note({ id: 'w1', kind: 'weekly', dbOrEnv: '周报库' }),
      sql({ id: 's1', dbOrEnv: '只看这个' }),
    ];
    expect(dbEnvValues(notes)).toEqual(['只看这个']);
  });

  it('空入参 / null / 只有空值：返回空数组，不抛错', () => {
    expect(dbEnvValues([])).toEqual([]);
    expect(dbEnvValues(null)).toEqual([]);
    expect(dbEnvValues(undefined)).toEqual([]);
    expect(dbEnvValues([sql({ id: 'x', dbOrEnv: '   ' })])).toEqual([]);
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

/* ==================================================================
   「填充变量并复制」（1.31.x）
   判据：docs/agents/sql-snippets-page.md §3「变量」+ §7 第 13 条。
   ================================================================== */

describe('SQL 片段页：填充变量并复制', () => {
  /** 复制走 navigator.clipboard；jsdom 没有实现，这里接一个只记录调用的桩 */
  let copied: string[] = [];
  const clipboardStub = {
    writeText: (t: string) => { copied.push(String(t)); return Promise.resolve(); },
  };

  beforeAll(() => {
    Object.defineProperty(navigator, 'clipboard', { value: clipboardStub, configurable: true });
  });
  beforeEach(() => { copied = []; });

  const VAR_FIXTURE: Note[] = [
    {
      id: 'v1', title: '查订单', content: 'select *from {{table}} where {{id}}=1',
      tags: [], kind: 'sql', updatedAt: new Date().toISOString(),
      varHint: '{{table}} = 表名；{{id}} = 主键',
    },
    {
      id: 'v2', title: '没变量的片段', content: 'select count(*) from t_order',
      tags: [], kind: 'sql', updatedAt: '2019-01-01T00:00:00.000Z',
    },
  ];

  const copyBtnOf = (container: HTMLElement, titlePart: string) => {
    const row = ROWS(container).find(r => r.textContent!.includes(titlePart)) as HTMLElement;
    return row.querySelector('.cell-actions button[title*="复制"]') as HTMLElement;
  };
  const dialogOf = () => document.querySelector('[role="dialog"]') as HTMLElement;

  it('点复制：弹窗列出 {{table}} / {{id}} 两个输入框，并显示变量说明里的释义', async () => {
    stubElectronApi(VAR_FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.click(copyBtnOf(container, '查订单'));
    const dlg = await waitFor(dialogOf);

    expect(dlg.textContent).toContain('检测到 2 个变量');
    expect(dlg.textContent).toContain('{{table}}');
    expect(dlg.textContent).toContain('{{id}}');
    // 变量说明联动：释义显示在输入框附近
    expect(dlg.textContent).toContain('表名');
    expect(dlg.textContent).toContain('主键');
    // 两个输入框（aria-label 精确到变量名，避免与搜索框混淆）
    expect(dlg.querySelector('input[aria-label="变量 table"]')).toBeTruthy();
    expect(dlg.querySelector('input[aria-label="变量 id"]')).toBeTruthy();
  });

  it('填完变量点「替换并复制」：剪贴板拿到完整 SQL，未填的保留原样，弹窗关闭', async () => {
    stubElectronApi(VAR_FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.click(copyBtnOf(container, '查订单'));
    const dlg = await waitFor(dialogOf);

    const tableInput = dlg.querySelector('input[aria-label="变量 table"]') as HTMLInputElement;
    const idInput = dlg.querySelector('input[aria-label="变量 id"]') as HTMLInputElement;
    fireEvent.change(tableInput, { target: { value: '33' } });

    // 实时预览：只填了一个时，另一个还是 {{变量}}
    expect(dlg.textContent).toContain('select *from 33 where {{id}}=1');

    fireEvent.change(idInput, { target: { value: '1333' } });
    // 两个都填好 → 预览就是最终要复制的完整语句
    expect(dlg.textContent).toContain('select *from 33 where 1333=1');

    fireEvent.click(within(dlg).getByRole('button', { name: /替换并复制/ }));
    await waitFor(() => expect(copied).toEqual(['select *from 33 where 1333=1']));

    await waitFor(() => expect(container.textContent).toContain('已复制'));
    await waitFor(() => expect(dialogOf()).toBeNull());
  });

  it('留空的变量保留原样：只填 table 时，剪贴板里仍是 {{id}}', async () => {
    stubElectronApi(VAR_FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.click(copyBtnOf(container, '查订单'));
    const dlg = await waitFor(dialogOf);
    fireEvent.change(dlg.querySelector('input[aria-label="变量 table"]') as HTMLInputElement, { target: { value: '33' } });

    fireEvent.click(within(dlg).getByRole('button', { name: /替换并复制/ }));
    await waitFor(() => expect(copied).toEqual(['select *from 33 where {{id}}=1']));
  });

  it('没有变量的片段：弹窗提示「这段内容里没有 {{变量}}，可以直接复制」，点「复制原文」复制原文', async () => {
    stubElectronApi(VAR_FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.click(copyBtnOf(container, '没变量的片段'));
    const dlg = await waitFor(dialogOf);

    expect(dlg.textContent).toContain('这段内容里没有');
    expect(dlg.querySelectorAll('input[aria-label^="变量 "]').length).toBe(0);

    fireEvent.click(within(dlg).getByRole('button', { name: /复制原文/ }));
    await waitFor(() => expect(copied).toEqual(['select count(*) from t_order']));
  });

  it('「复制原文」在有变量时也不做替换（与替换并复制是两条独立的路径）', async () => {
    stubElectronApi(VAR_FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.click(copyBtnOf(container, '查订单'));
    const dlg = await waitFor(dialogOf);
    fireEvent.change(dlg.querySelector('input[aria-label="变量 table"]') as HTMLInputElement, { target: { value: '33' } });

    fireEvent.click(within(dlg).getByRole('button', { name: /复制原文/ }));
    await waitFor(() => expect(copied).toEqual(['select *from {{table}} where {{id}}=1']));
  });
});

/* ==================================================================
   第二批（docs/agents/sql-copy-vars-next.md §3.A / §3.B / §3.D）
   A：变量说明一键生成 / B：常用日期变量一键填 / D：CopyVarsModal 抽取
   ================================================================== */

describe('SQL 片段页：变量说明一键生成（第二批 A）', () => {
  const VAR_NOTE: Note = {
    id: 'g1', title: '查订单', content: 'select * from {{t}} where {{id}}=1',
    tags: [], kind: 'sql', updatedAt: new Date().toISOString(), varHint: '{{id}} = 主键',
  };

  const openEdit = async (container: HTMLElement) => {
    fireEvent.click(ROWS(container)[0]);
    return await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
  };
  const genBtn = (dialog: HTMLElement) => (
    within(dialog).getByRole('button', { name: '按正文生成' }) as HTMLButtonElement
  );

  it('按正文生成：缺的 {{t}} 补成 {{t}} = ，已有 {{id}} = 主键 一个字都不改；再点一次不变', async () => {
    stubElectronApi([VAR_NOTE]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    const dialog = await openEdit(container);

    const hint = within(dialog).getByLabelText('变量说明') as HTMLTextAreaElement;
    expect(hint.value).toBe('{{id}} = 主键');

    fireEvent.click(genBtn(dialog));
    expect(hint.value).toBe('{{id}} = 主键；{{t}} = ');

    // 幂等：连点两次文本完全不变（不产生重复条目）
    fireEvent.click(genBtn(dialog));
    expect(hint.value).toBe('{{id}} = 主键；{{t}} = ');
  });

  it('正文没有 {{变量}}：按钮 disabled，title 说明「正文里没有 {{变量}}」', async () => {
    stubElectronApi([{
      id: 'g2', title: '没变量的片段', content: 'select count(*) from t_order',
      tags: [], kind: 'sql', updatedAt: new Date().toISOString(),
    }]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    const dialog = await openEdit(container);

    const btn = genBtn(dialog);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('title')).toContain('正文里没有 {{变量}}');

    // 正文里写上变量后按钮可用（不是一次性判定的死状态）
    fireEvent.change(within(dialog).getByLabelText('SQL 正文'), { target: { value: 'select * from {{t}}' } });
    expect(genBtn(dialog).disabled).toBe(false);
  });
});

/* ----------------------------------------------------------------
   第三批 C：「库 / 环境」已有值标签行（页面渲染）
   ---------------------------------------------------------------- */
describe('SQL 片段页：库 / 环境已有值标签（第三批 C）', () => {
  const DB_NOTES: Note[] = [
    {
      id: 'e1', title: '片段一', content: 'select 1', tags: [], kind: 'sql',
      updatedAt: '2026-01-01T00:00:00.000Z', dbOrEnv: 'test_order / 预发',
    },
    {
      id: 'e2', title: '片段二', content: 'select 2', tags: [], kind: 'sql',
      updatedAt: '2026-01-02T00:00:00.000Z', dbOrEnv: 'test_order / 预发',
    },
    {
      id: 'e3', title: '片段三', content: 'select 3', tags: [], kind: 'sql',
      updatedAt: '2026-01-03T00:00:00.000Z', dbOrEnv: 'test_order',
    },
  ];

  const openEdit = async (container: HTMLElement, title: string) => {
    const row = ROWS(container).find(r => r.textContent!.includes(title)) as HTMLElement;
    fireEvent.click(row);
    return await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
  };

  it('编辑弹窗列出已有值（次数降序），点标签把值填进输入框', async () => {
    stubElectronApi(DB_NOTES);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(3));
    const dialog = await openEdit(container, '片段一');

    const chips = [...dialog.querySelectorAll('.suggest-row button.chip')].map(b => b.textContent);
    expect(chips).toEqual(['test_order / 预发', 'test_order']);

    fireEvent.click(within(dialog).getByRole('button', { name: 'test_order' }));
    expect((within(dialog).getByLabelText('库或环境') as HTMLInputElement).value).toBe('test_order');
  });

  it('库里没有历史值时不渲染标签行（不出现空标题 / 空容器）', async () => {
    stubElectronApi([{
      id: 'x1', title: '没库名', content: 'select 1', tags: [], kind: 'sql',
      updatedAt: new Date().toISOString(),
    }]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    const dialog = await openEdit(container, '没库名');

    expect(dialog.querySelector('.suggest-row')).toBeNull();
    expect(dialog.querySelectorAll('button.chip').length).toBe(0);
  });

  it('仍可自由输入组合值：点标签后再手改，保存按手写的落盘', async () => {
    stubElectronApi(DB_NOTES);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(3));
    const dialog = await openEdit(container, '片段三');

    fireEvent.click(within(dialog).getByRole('button', { name: 'test_order / 预发' }));
    const input = within(dialog).getByLabelText('库或环境') as HTMLInputElement;
    expect(input.value).toBe('test_order / 预发');

    fireEvent.change(input, { target: { value: 'test_order / 预发 / 回归' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(saved.length).toBe(1));
    const edited = saved[0].data.find(n => n.id === 'e3')!;
    expect(edited.dbOrEnv).toBe('test_order / 预发 / 回归');
  });

  it('禁用 <datalist>：编辑弹窗里没有任何 datalist 元素', async () => {
    stubElectronApi(DB_NOTES);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(3));
    await openEdit(container, '片段一');

    expect(document.querySelector('datalist')).toBeNull();
  });
});

describe('SQL 片段页：常用日期变量一键填（第二批 B）', () => {
  let copied: string[] = [];
  beforeAll(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => { copied.push(String(t)); return Promise.resolve(); } },
      configurable: true,
    });
  });
  beforeEach(() => { copied = []; });
  afterEach(() => { vi.useRealTimers(); });

  const DATE_NOTE: Note = {
    id: 'd1', title: '日期片段',
    content: "select '{{today}}' as d, '{{now}}' as n, '{{orderNo}}' as o",
    tags: [], kind: 'sql', updatedAt: new Date().toISOString(),
  };

  const openCopy = async (container: HTMLElement) => {
    fireEvent.click(ROWS(container)[0].querySelector('.cell-actions button[title*="复制"]') as HTMLElement);
    return await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
  };

  it('只有识别出的日期变量给「填今天」/「填现在」，未知变量不给按钮', async () => {
    stubElectronApi([DATE_NOTE]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    const dlg = await openCopy(container);

    expect(dlg.querySelectorAll('[data-fill-var]').length).toBe(2);
    expect(dlg.querySelector('[data-fill-var="today"]')?.textContent).toBe('填今天');
    expect(dlg.querySelector('[data-fill-var="now"]')?.textContent).toBe('填现在');
    expect(dlg.querySelector('[data-fill-var="orderNo"]')).toBeNull();
  });

  it('点「填今天」/「填现在」：输入框与预览同步更新（固定 2026-03-01 09:05:06）', async () => {
    stubElectronApi([DATE_NOTE]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    const dlg = await openCopy(container);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 1, 9, 5, 6));
    fireEvent.click(dlg.querySelector('[data-fill-var="today"]') as HTMLElement);
    fireEvent.click(dlg.querySelector('[data-fill-var="now"]') as HTMLElement);
    vi.useRealTimers();

    const todayInput = dlg.querySelector('input[aria-label="变量 today"]') as HTMLInputElement;
    const nowInput = dlg.querySelector('input[aria-label="变量 now"]') as HTMLInputElement;
    expect(todayInput.value).toBe('2026-03-01');
    expect(nowInput.value).toBe('2026-03-01 09:05:06');
    // 预览与输入框同源：预览什么就复制什么
    expect(dlg.querySelector('.sql-var-preview')?.textContent)
      .toBe("select '2026-03-01' as d, '2026-03-01 09:05:06' as n, '{{orderNo}}' as o");

    fireEvent.click(within(dlg).getByRole('button', { name: /替换并复制/ }));
    await waitFor(() => expect(copied).toEqual(["select '2026-03-01' as d, '2026-03-01 09:05:06' as n, '{{orderNo}}' as o"]));
  });

  it('关窗重开：变量值被清空（与抽取前行为一致）', async () => {
    stubElectronApi([DATE_NOTE]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));

    const dlg = await openCopy(container);
    fireEvent.change(dlg.querySelector('input[aria-label="变量 today"]') as HTMLInputElement, { target: { value: '2026-03-01' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '关闭' }));
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());

    const again = await openCopy(container);
    expect((again.querySelector('input[aria-label="变量 today"]') as HTMLInputElement).value).toBe('');
  });

  it('日期输入框仍是 .form-group 的直接子元素（背景图玻璃选择器依赖它，E 片扫描的前提）', async () => {
    stubElectronApi([DATE_NOTE]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    const dlg = await openCopy(container);

    const input = dlg.querySelector('input[aria-label="变量 today"]') as HTMLInputElement;
    // 一旦有人把 input 包进一层 div，`html[data-bg='image'] .modal .form-group > input` 就匹配不上，
    // 背景图模式下这个输入框会回到不透明实底 —— E 片的弹窗扫描会红。这里用 DOM 结构把它钉住。
    expect(input.parentElement?.classList.contains('form-group')).toBe(true);
    expect(input.parentElement?.parentElement?.classList.contains('modal-body')).toBe(true);
    // 填值按钮是 input 的兄弟节点（不是包一层 flex 容器）
    expect(dlg.querySelector('[data-fill-var="today"]')?.parentElement).toBe(input.parentElement);
  });
});

/* ==================================================================
   第三批：选中一段文字 → 「转化为变量」
   判据（用户给的流程）：选中 → 点按钮 → 弹窗填名称/说明 → 确定后
   ① SQL 里那段变成 {{名字}}；② 变量说明里出现 `{{名字}} = 说明`。
   ================================================================== */

describe('SQL 片段页：选中文字转化为变量', () => {
  const openNew = async (container: HTMLElement) => {
    fireEvent.click(within(container.querySelector('.pg-tools') as HTMLElement).getByRole('button', { name: /新增片段/ }));
    return await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
  };
  const sqlArea = (root: ParentNode) => root.querySelector('textarea[aria-label="SQL 正文"]') as HTMLTextAreaElement;
  const hintArea = (root: ParentNode) => root.querySelector('textarea[aria-label="变量说明"]') as HTMLTextAreaElement;
  const draftDialog = () => {
    const all = document.querySelectorAll('[role="dialog"]');
    return all.length >= 2 ? all[all.length - 1] as HTMLElement : null;
  };
  /** 等第二个弹窗（转化弹窗）出现并返回它；TS 需要显式收窄，所以不用 waitFor 的返回值 */
  const waitDraft = async (): Promise<HTMLElement> => {
    let el: HTMLElement | null = null;
    await waitFor(() => {
      el = draftDialog();
      expect(el).not.toBeNull();
    });
    return el as unknown as HTMLElement;
  };

  it('没选中就点：只给提示，不打开转化弹窗', async () => {
    stubElectronApi([]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(container.textContent).toContain('还没有 SQL 片段'));
    const dlg = await openNew(container);
    fireEvent.change(sqlArea(dlg), { target: { value: 'select 1' } });

    fireEvent.click(within(dlg).getByRole('button', { name: /转化为变量/ }));

    expect(container.textContent).toContain('选中');
    expect(document.querySelectorAll('[role="dialog"]').length).toBe(1);
  });

  it('选中 id → 填说明「主键」→ SQL 换成 {{id}}、变量说明追加 {{id}} = 主键', async () => {
    stubElectronApi([]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(container.textContent).toContain('还没有 SQL 片段'));
    const dlg = await openNew(container);
    const sql = 'select * from t_order where id = 1';
    fireEvent.change(sqlArea(dlg), { target: { value: sql } });
    const s = sql.indexOf('id = 1');
    sqlArea(dlg).setSelectionRange(s, s + 2);

    fireEvent.click(within(dlg).getByRole('button', { name: /转化为变量/ }));
    const draft = await waitDraft();
    expect((draft.querySelector('input[aria-label="变量名"]') as HTMLInputElement).value).toBe('id');

    fireEvent.change(draft.querySelector('input[aria-label="变量说明（新）"]') as HTMLElement, { target: { value: '主键' } });
    fireEvent.click(within(draft).getByRole('button', { name: /^确定$/ }));

    await waitFor(() => expect(sqlArea(dlg).value).toBe('select * from t_order where {{id}} = 1'));
    expect(hintArea(dlg).value).toContain('{{id}} = 主键');
    // 转化弹窗关掉了，只剩编辑弹窗
    await waitFor(() => expect(document.querySelectorAll('[role="dialog"]').length).toBe(1));
  });

  it('选中中文：变量名留空、确定不可用（不瞎猜名字）', async () => {
    stubElectronApi([]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(container.textContent).toContain('还没有 SQL 片段'));
    const dlg = await openNew(container);
    const sql = 'select * from t where 中文 = 1';
    fireEvent.change(sqlArea(dlg), { target: { value: sql } });
    const s = sql.indexOf('中文');
    sqlArea(dlg).setSelectionRange(s, s + 2);

    fireEvent.click(within(dlg).getByRole('button', { name: /转化为变量/ }));
    const draft = await waitDraft();
    const nameInput = draft.querySelector('input[aria-label="变量名"]') as HTMLInputElement;
    expect(nameInput.value).toBe('');
    expect((within(draft).getByRole('button', { name: /^确定$/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('该变量已有释义：说明框预填原释义，确定后改的是释义而不是重复追加', async () => {
    stubElectronApi([{
      id: 'v1', title: '查订单', content: 'select * from t_order where id = 1',
      tags: [], kind: 'sql', updatedAt: new Date().toISOString(), varHint: '{{id}} = 主键',
    }]);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    fireEvent.click(ROWS(container)[0]);
    const dlg = await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
    const sql = 'select * from t_order where id = 1';
    const s = sql.indexOf('id = 1');
    sqlArea(dlg).setSelectionRange(s, s + 2);

    fireEvent.click(within(dlg).getByRole('button', { name: /转化为变量/ }));
    const draft = await waitDraft();
    expect((draft.querySelector('input[aria-label="变量说明（新）"]') as HTMLInputElement).value).toBe('主键');

    fireEvent.change(draft.querySelector('input[aria-label="变量说明（新）"]') as HTMLElement, { target: { value: '订单主键' } });
    fireEvent.click(within(draft).getByRole('button', { name: /^确定$/ }));
    await waitFor(() => expect(hintArea(dlg).value).toBe('{{id}} = 订单主键'));
  });
});


/* ==================================================================
   C 片（docs/agents/entry-ux-next.md §3.3 / §8 裁定）
   1) 三张统计卡从右栏 .pm-main 移到页头下方、.pm-shell 之前（全宽）
   2) 挂点对齐：页面提供的 DOM 结构必须和 redesign.css 末尾的 `.sql-kpi-top` /
      `.entry-card-check` 选择器对得上。上一批踩过的坑就是「CSS 写了、类名没对上，
      测试全绿但功能全错」，所以这两处挂点在这里钉成断言。
   注：Vitest 默认关闭 CSS 处理（`?raw` 导入得到空串，实测 length=0），因此本文件
   不做 CSS 文本断言；数值契约（16px / 11px / max-height 64 / 卡面 --surface-2 +
   1px --line / 勾选框 24×24 与 focus-visible 描边）由 scripts/check-stacking.js
   与 D 片的真实 Electron 几何测量兜住。
   ================================================================== */
import type { PasswordEntry } from '../../types';
import { EntryCard } from '../../components/EntryCard';

const CARD_ENTRY: PasswordEntry = {
  id: 'e-kpi', name: '合同管理系统', envType: 'testing',
  url: 'https://example.com', username: 'u', password: 'p', notes: '', tags: [],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
};

describe('SQL 片段页：三张统计卡在页头下方、.pm-shell 之前', () => {
  const pgChildren = (container: HTMLElement) =>
    [...(container.querySelector('.pg') as HTMLElement).children];
  const topIndex = (container: HTMLElement, sel: string) =>
    pgChildren(container).findIndex(el => el.matches(sel));

  it('DOM 顺序 .pg-head → .sql-kpi-top → .pm-shell；三卡不再在 .pm-main 里', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    const head = topIndex(container, '.pg-head');
    const kpi = topIndex(container, '.sql-kpi-top');
    const shell = topIndex(container, '.pm-shell');
    expect(head).toBeGreaterThanOrEqual(0);
    expect(kpi).toBeGreaterThan(head);
    expect(shell).toBeGreaterThan(kpi);

    // 防止「复制一份留在原处」：右栏里一张都不该剩
    expect(container.querySelector('.pm-shell .home-stat')).toBeNull();
    expect(container.querySelector('.pm-main .home-stat')).toBeNull();
  });

  it('仍是三张卡：全部片段 / 收藏 / 本周新增，计数沿用 countSql', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    const cards = container.querySelectorAll('.sql-kpi-top .home-stat');
    expect(cards).toHaveLength(3);
    const kpi = KPI(container);
    expect(kpi).toHaveLength(3);
    expect(kpi[0]).toContain('全部片段');
    expect(kpi[1]).toContain('收藏');
    expect(kpi[2]).toContain('本周新增');
    expect(kpi[0]).toContain('2'); // 只有两条 kind==='sql'
  });

  it('CSS 挂点对齐：.sql-kpi-top 是 .pg 的直接子元素，内部 .home-stats.is-3 > 三张 .home-stat', async () => {
    stubElectronApi(FIXTURE);
    const { container } = render(<SqlSnippets />);
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    const top = container.querySelector('.sql-kpi-top') as HTMLElement;
    expect(top).toBeTruthy();
    expect(top.parentElement?.classList.contains('pg')).toBe(true);
    // redesign.css 里的压缩规则写在 `.sql-kpi-top .home-stats.is-3` /
    // `.sql-kpi-top .home-stat` 上：这两个类名少一个，规则就静默失效
    const stats = top.querySelector('.home-stats') as HTMLElement;
    expect(stats).toBeTruthy();
    expect(stats.classList.contains('is-3')).toBe(true);
    expect(stats.querySelectorAll(':scope > .home-stat')).toHaveLength(3);
  });
});

describe('C 片挂点对齐：卡片勾选框的 DOM 与 .entry-card-check 选择器', () => {
  it('勾选框是 .card-header 的第一个子元素，类名就是 entry-card-check（含一个 checkbox）', () => {
    const { container } = render(<EntryCard entry={CARD_ENTRY} onEdit={() => {}} onCopy={() => {}} />);
    const header = container.querySelector('.entry-card .card-header') as HTMLElement;
    expect(header).toBeTruthy();
    const first = header.firstElementChild as HTMLElement;
    expect(first.classList.contains('entry-card-check')).toBe(true);
    expect(first.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
    // 类名一旦漂移（比如改成 entry-check），redesign.css 里的 24×24 与
    // focus-visible 规则就会全部落空 —— 这条断言就是那个守卫
    expect(container.querySelectorAll('.entry-card-check input[type="checkbox"]')).toHaveLength(1);
  });
});

describe('SQL 片段表格：更新时间列放得下完整时间', () => {
  it('列宽守卫：redesign.css 末尾把第 3 列（更新时间）撑到 132px', () => {
    const css = readFileSync('src/styles/redesign.css', 'utf8');
    // 表头列序是 名称 / 库·环境 / 更新时间 / 操作，用户截图里被截成「11-23 14:」
    const i = css.lastIndexOf('.sql-table th:nth-child(3)');
    expect(i).toBeGreaterThan(-1);
    expect(css.slice(i, css.indexOf('}', i))).toContain('width: 132px');
  });
});