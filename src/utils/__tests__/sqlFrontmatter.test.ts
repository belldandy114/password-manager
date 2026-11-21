// @vitest-environment jsdom
// 目录模式的 SQL 片段（1.31）：`.sql.md` + YAML frontmatter。
//
// 本文件两块：
//   A. 纯函数（`utils/sqlFrontmatter.ts`）：解析容错、序列化、文件名规则（与 Notes.tsx 的
//      `fileOf(title,'sql')` 同一套，边界锁死）、Note ↔ 文件映射。
//   B. 页面（jsdom + 内存假目录）：目录模式下渲染完整页面、列表只来自 `.sql.md`、新增/编辑/
//      删除/收藏/搜索/排序/导出，以及「笔记页不再显示 `.sql.md`」的交叉验证。
//
// 假目录直接实现 `notesList/notesRead/notesSave/notesRename/notesDelete` 的行为，
// 所以「写进去的字节 → 读回来还能认出字段」是端到端验的，不只是函数自测。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

import { useStore } from '../../store/useStore';
import { kindDecidedByName } from '../noteKind';
import {
  parseSqlFile, serializeSqlFile, sqlFileName, uniqueSqlFileName, titleOfSqlFile,
  noteFromSqlFile, sqlFileText, EMPTY_META, dirId, dirNameOf,
} from '../sqlFrontmatter';
import { SqlSnippets } from '../../pages/SqlSnippets';
import { NotesBody } from '../../pages/Notes';

/** 老文件：没有 frontmatter，整篇都是 SQL（缩进与空行都有意义） */
const LEGACY_SQL = 'SELECT *\nFROM t_old\nWHERE a = 1\n  AND b = 2';

/* ============================ A. 纯函数 ============================ */

describe('frontmatter 解析：容错边界', () => {
  it('没有 frontmatter 的老文件 → 字段全空、整篇都是正文', () => {
    const f = parseSqlFile(LEGACY_SQL);
    expect(f.hasFrontmatter).toBe(false);
    expect(f.meta).toEqual(EMPTY_META);
    expect(f.content).toBe(LEGACY_SQL);
    // 结尾多几个空行不影响正文
    expect(parseSqlFile(`${LEGACY_SQL}\n\n`).content).toBe(LEGACY_SQL);
    // BOM + CRLF 也能吃（Windows 记事本存出来的文件）
    expect(parseSqlFile(`\uFEFF${LEGACY_SQL.replace(/\n/g, '\r\n')}`).content).toBe(LEGACY_SQL);
  });

  it('`---` 只开不闭 → 不当前言，整篇当正文（宁可多当正文，也不吞 SQL）', () => {
    const f = parseSqlFile('---\ndbOrEnv: x\nSELECT 1');
    expect(f.hasFrontmatter).toBe(false);
    expect(f.meta).toEqual(EMPTY_META);
    expect(f.content).toContain('SELECT 1');
  });

  it('空 frontmatter（只有两条分隔线）→ 字段全空，正文完整', () => {
    const f = parseSqlFile('---\n---\n\nSELECT 1');
    expect(f.hasFrontmatter).toBe(true);
    expect(f.meta).toEqual(EMPTY_META);
    expect(f.content).toBe('SELECT 1');
  });

  it('含冒号的值：只按第一个冒号切分，后面的冒号原样保留', () => {
    const f = parseSqlFile('---\nremark: 只读: 别在生产跑\ndbOrEnv: test_order / 预发\n---\nselect 1');
    expect(f.meta.remark).toBe('只读: 别在生产跑');
    expect(f.meta.dbOrEnv).toBe('test_order / 预发');
  });

  it('值里的 # 不当注释吃掉', () => {
    expect(parseSqlFile('---\nremark: 只看 # 号后面的部分\n---\nselect 1').meta.remark)
      .toBe('只看 # 号后面的部分');
  });

  it('引号包裹的值会剥引号并还原转义（变量说明里的换行写成 \\n）', () => {
    const f = parseSqlFile('---\nvarHint: "{{orderNo}} = 订单号\\n{{today}} = 今天"\n---\nselect 1');
    expect(f.meta.varHint).toBe('{{orderNo}} = 订单号\n{{today}} = 今天');
  });

  it('starred 布尔：true/yes/1 为真，false / 缺省 / 乱写为假', () => {
    const star = (v: string) => parseSqlFile(`---\nstarred: ${v}\n---\n`).meta.starred;
    expect(star('true')).toBe(true);
    expect(star('YES')).toBe(true);
    expect(star('1')).toBe(true);
    expect(star('false')).toBe(false);
    expect(star('')).toBe(false);
    expect(star('乱写')).toBe(false);
    expect(parseSqlFile('---\nremark: x\n---\n').meta.starred).toBe(false);
  });

  it('tags：[a, b] 与 a, b 都能读，元素里的逗号用引号包；写一律 [a, b]', () => {
    expect(parseSqlFile('---\ntags: [订单, 造数]\n---\n').meta.tags).toEqual(['订单', '造数']);
    expect(parseSqlFile('---\ntags: 订单, 造数\n---\n').meta.tags).toEqual(['订单', '造数']);
    expect(parseSqlFile('---\ntags: ["a,b", 造数]\n---\n').meta.tags).toEqual(['a,b', '造数']);
    expect(parseSqlFile('---\ntags: []\n---\n').meta.tags).toEqual([]);
    expect(serializeSqlFile({ tags: ['订单', '造数'] }, 'select 1')).toContain('tags: [订单, 造数]');
  });

  it('多行 SQL：正文逐字保留（缩进、空行、横线注释都不动）', () => {
    const sql = '-- 查订单\nSELECT *\n  FROM t_order\n\nWHERE a = 1\n   AND b = 2';
    expect(parseSqlFile(serializeSqlFile({ dbOrEnv: 'test / 预发' }, sql)).content).toBe(sql);
  });

  it('序列化 → 解析往返一致（6 个字段 + 正文）', () => {
    const meta = {
      dbOrEnv: 'test_order / 预发',
      varHint: '{{orderNo}} = 订单号',
      remark: '只读，别在生产跑',
      starred: true,
      tags: ['订单', '造数'],
      updatedAt: '2026-11-21T12:05:00.000Z',
    };
    const content = 'SELECT * FROM t_refund WHERE order_no = {{orderNo}}';
    const back = parseSqlFile(serializeSqlFile(meta, content));
    expect(back.hasFrontmatter).toBe(true);
    expect(back.meta).toEqual(meta);
    expect(back.content).toBe(content);
  });

  it('空字段整行不写（dbOrEnv/varHint/remark），starred/tags/updatedAt 始终写', () => {
    const text = serializeSqlFile({}, 'select 1');
    expect(text).not.toContain('dbOrEnv:');
    expect(text).not.toContain('varHint:');
    expect(text).not.toContain('remark:');
    expect(text).toContain('\nstarred: false\n');
    expect(text).toContain('\ntags: []\n');
    expect(text).toContain('\nupdatedAt: ""\n');
    expect(text).toContain('\n---\n\nselect 1\n');
  });
});

describe('文件名规则：与 Notes.tsx 的 fileOf(title,"sql") 同一套（边界锁死）', () => {
  it('普通标题 → 标题.sql.md；显示标题去掉后缀', () => {
    expect(sqlFileName('查未支付订单')).toBe('查未支付订单.sql.md');
    expect(titleOfSqlFile('查未支付订单.sql.md')).toBe('查未支付订单');
    expect(titleOfSqlFile('老的.sql')).toBe('老的');
    expect(titleOfSqlFile('老的.md')).toBe('老的');
  });

  it('空标题 / 纯空白标题 → 兜底「未命名笔记.sql.md」', () => {
    expect(sqlFileName('')).toBe('未命名笔记.sql.md');
    expect(sqlFileName('   ')).toBe('未命名笔记.sql.md');
    expect(sqlFileName('\n\t ')).toBe('未命名笔记.sql.md');
  });

  it('非法字符 \\ / : * ? " < > | 全换成 _', () => {
    expect(sqlFileName('a\\b/c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j.sql.md');
  });

  it('连续空白折叠成一个空格、首尾空白去掉、超长截 80 字', () => {
    expect(sqlFileName('  查   订单  ')).toBe('查 订单.sql.md');
    const long = 'x'.repeat(200);
    expect(sqlFileName(long)).toBe(`${'x'.repeat(80)}.sql.md`);
  });

  it('标题里已经带 .sql.md / .md 不重复拼', () => {
    expect(sqlFileName('查订单.sql.md')).toBe('查订单.sql.md');
    expect(sqlFileName('查订单.md')).toBe('查订单.sql.md');
  });

  it('重名：加 -2、-3…，后缀插在 .sql.md 之前（否则不再被认成片段）', () => {
    expect(uniqueSqlFileName('a.sql.md', [])).toBe('a.sql.md');
    expect(uniqueSqlFileName('a.sql.md', ['a.sql.md'])).toBe('a-2.sql.md');
    expect(uniqueSqlFileName('a.sql.md', ['a.sql.md', 'a-2.sql.md'])).toBe('a-3.sql.md');
    expect(kindDecidedByName('a-2.sql.md')).toBe(true);   // 关键：仍被判成 SQL 片段
    expect(kindDecidedByName('a.sql-2.md')).toBe(false);  // 反面教材：后缀插错位置
    expect(uniqueSqlFileName('A.sql.md', ['a.SQL.md'])).toBe('A-2.sql.md'); // Windows 大小写不敏感
  });
});

describe('Note ↔ 文件映射', () => {
  it('noteFromSqlFile：id 带 dir:: 前缀、标题去后缀、字段来自 frontmatter，缺 updatedAt 回退 mtime', () => {
    const n = noteFromSqlFile('查订单.sql.md', '---\nstarred: true\n---\n\nselect 1', '2026-11-21T12:05:00.000Z');
    expect(n.id).toBe(dirId('查订单.sql.md'));
    expect(n.title).toBe('查订单');
    expect(n.kind).toBe('sql');
    expect(n.starred).toBe(true);
    expect(n.content).toBe('select 1');
    expect(n.updatedAt).toBe('2026-11-21T12:05:00.000Z');
    expect(dirNameOf(n.id)).toBe('查订单.sql.md');
    expect(dirNameOf('vault-uuid')).toBe('');
  });

  it('sqlFileText：把 Note 写回文件，字段与正文都不丢', () => {
    const n = noteFromSqlFile('查订单.sql.md', '---\nremark: 只读\n---\n\nselect 1');
    const back = parseSqlFile(sqlFileText(n));
    expect(back.meta.remark).toBe('只读');
    expect(back.content).toBe('select 1');
  });
});

/* ============================ B. 页面（内存假目录） ============================ */

interface DirLog { op: string; name?: string; next?: string; content?: string }

/** 内存假目录：行为对齐 electron/ipc-files.js 的 notes:* */
function fakeDir(initial: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initial));
  const log: DirLog[] = [];
  const mtime = '2026-11-21T12:05:00.000Z';
  const overrides: Record<string, unknown> = {
    notesList: () => {
      log.push({ op: 'list' });
      return Promise.resolve({
        success: true,
        data: [...files.keys()].map(name => ({ name, size: (files.get(name) || '').length, mtime })),
      });
    },
    notesRead: (_dir: string, name: string) => {
      log.push({ op: 'read', name });
      return files.has(name)
        ? Promise.resolve({ success: true, data: { name, content: files.get(name) as string, mtime } })
        : Promise.resolve({ success: false, error: '文件不存在' });
    },
    notesSave: (_dir: string, name: string, content: string) => {
      log.push({ op: 'save', name, content });
      files.set(name, content);
      return Promise.resolve({ success: true, data: { name } });
    },
    notesRename: (_dir: string, name: string, next: string) => {
      log.push({ op: 'rename', name, next });
      if (files.has(next)) return Promise.resolve({ success: false, error: '同名文件已存在' });
      files.set(next, files.get(name) || '');
      files.delete(name);
      return Promise.resolve({ success: true, data: { name: next } });
    },
    notesDelete: (_dir: string, name: string) => {
      log.push({ op: 'delete', name });
      files.delete(name);
      return Promise.resolve({ success: true });
    },
    notesReveal: () => Promise.resolve({ success: true }),
    attachmentEnsureNoteDir: () => Promise.resolve({ success: true }),
  };
  return { files, log, overrides };
}

function stubElectronApi(overrides: Record<string, unknown> = {}) {
  const failIpc = () => Promise.resolve({ success: false, error: 'stub' });
  const unsubscribe = () => () => {};
  const base: Record<string, unknown> = {
    // 本地库集合：目录模式下不该被用来渲染列表（给空数组，若真用了会一眼看出来）
    wsGet: (key: string) => Promise.resolve(key === 'notes' ? { success: true, data: [] } : { success: false }),
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
const TOOLS = (root: ParentNode) => root.querySelector('.pg-tools') as HTMLElement;
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement;

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
  localStorage.setItem('pm.notes.dir', 'C:\\notes');
  // 目录也会从 store.settings 读（笔记页）：清空，避免上一个用例漏进来
  useStore.setState({ settings: { ...useStore.getState().settings, notesDir: '' } });
});

afterEach(() => cleanup());

const FM_SQL = [
  '---',
  'dbOrEnv: test_order / 预发',
  'varHint: "{{orderNo}} = 订单号"',
  'starred: true',
  'tags: [订单]',
  'updatedAt: 2026-11-21T12:05:00.000Z',
  '---',
  '',
  'SELECT * FROM t_order WHERE paid = 0',
].join('\n');

describe('目录模式：完整页面 + 列表只来自 .sql.md', () => {
  it('渲染标签栏 / KPI / 搜索 / 排序 / 表格，不再是「请到笔记与附件里管理」的提示页', async () => {
    const d = fakeDir({
      '查未支付订单.sql.md': FM_SQL,
      '老片段.sql.md': LEGACY_SQL,
      '一条普通笔记.md': '# 普通笔记\n不是片段',
    });
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    // 完整页面：左侧栏 + 三张 KPI + 搜索框 + 排序下拉 + 表格
    expect(container.querySelector('.tag-sidebar')).toBeTruthy();
    expect(KPI(container)).toHaveLength(3);
    expect(container.querySelector('.search input')).toBeTruthy();
    expect(container.querySelector('select[aria-label="排序方式"]')).toBeTruthy();
    expect(container.querySelector('.tbl')).toBeTruthy();

    // 旧提示整段没了
    expect(container.textContent).not.toContain('请到「笔记与附件」里管理');
    expect(container.textContent).not.toContain('本页只在本地加密库里读写');

    // 列表只来自 .sql.md；标题去掉 .sql 后缀；普通 .md 不进这页
    const text = container.textContent || '';
    expect(text).toContain('查未支付订单');
    expect(text).not.toContain('一条普通笔记');
    expect(ROWS(container).map(r => r.textContent).join(' ')).not.toContain('.sql.md');
    expect(ROWS(container).some(r => (r.textContent || '').includes('查未支付订单'))).toBe(true);
    expect(ROWS(container).some(r => (r.textContent || '').includes('老片段'))).toBe(true);

    // KPI：全部 2 / 收藏 1（收藏来自 frontmatter.starred）
    expect(KPI(container)[0]).toContain('2');
    expect(KPI(container)[1]).toContain('1');

    // 目录 IPC：列了一次目录，只读了那两篇 .sql.md
    expect(d.log.some(x => x.op === 'list')).toBe(true);
    expect(d.log.filter(x => x.op === 'read').map(x => x.name).sort())
      .toEqual(['查未支付订单.sql.md', '老片段.sql.md']);
  });

  it('搜索 / 排序与本地库模式同口径（都走 filterSql / sortSql）', async () => {
    const d = fakeDir({
      'A 片段.sql.md': `---\ntags: []\nupdatedAt: 2026-11-01T00:00:00.000Z\n---\n\nselect * from t_user`,
      'B 片段.sql.md': `---\ntags: []\nupdatedAt: 2026-11-02T00:00:00.000Z\n---\n\nselect * from t_order`,
    });
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    // 默认「最近修改」：B 更新更晚，排在前
    expect(ROWS(container)[0].textContent).toContain('B 片段');

    // 搜索命中正文
    fireEvent.change(container.querySelector('.search input') as HTMLInputElement, { target: { value: 't_user' } });
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    expect(ROWS(container)[0].textContent).toContain('A 片段');

    // 清空搜索 + 按名称排序
    fireEvent.change(container.querySelector('.search input') as HTMLInputElement, { target: { value: '' } });
    await waitFor(() => expect(ROWS(container).length).toBe(2));
    fireEvent.change(container.querySelector('select[aria-label="排序方式"]') as HTMLSelectElement, { target: { value: 'title' } });
    await waitFor(() => expect(ROWS(container)[0].textContent).toContain('A 片段'));
  });
});

describe('目录模式：新增 / 编辑 / 删除', () => {
  /** 填完弹窗点保存（名称 + SQL 必填） */
  async function fillAndSave(container: HTMLElement, fields: Record<string, string>, star = false) {
    fireEvent.click(within(TOOLS(container)).getByRole('button', { name: /新增片段/ }));
    const dlg = await waitFor(() => dialog());
    for (const [label, value] of Object.entries(fields)) {
      fireEvent.change(within(dlg).getByLabelText(label), { target: { value } });
    }
    if (star) fireEvent.click(within(dlg).getByRole('checkbox'));
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(dialog()).toBeNull());
  }

  it('新增：写 标题.sql.md = frontmatter（键顺序固定）+ 空行 + 正文；重名加 -2', async () => {
    const d = fakeDir({});
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(container.textContent).toContain('还没有 SQL 片段'));

    const fields = {
      名称: '查订单',
      库或环境: 'test_order / 预发',
      'SQL 正文': 'select * from t_order',
      变量说明: '{{today}} = 今天',
      备注: '别在生产跑',
      标签: '订单, 造数',
    };
    await fillAndSave(container, fields, true);

    const text = d.files.get('查订单.sql.md') as string;
    expect(text).toBeTruthy();
    const [head, body] = text.split('\n---\n\n');
    const lines = head.split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('---');
    expect(lines[1]).toBe('dbOrEnv: test_order / 预发');
    expect(lines[2]).toBe('varHint: "{{today}} = 今天"'); // `{{` 开头必须引号
    expect(lines[3]).toBe('remark: 别在生产跑');
    expect(lines[4]).toBe('starred: true');
    expect(lines[5]).toBe('tags: [订单, 造数]');
    expect(lines[6]).toMatch(/^updatedAt: \d{4}-\d{2}-\d{2}T/); // ISO 串自带冒号，不引号
    // 空行 + 正文，正文里没有 frontmatter 残留
    expect(body.replace(/\s+$/, '')).toBe('select * from t_order');

    // 落盘后再读回来，字段一模一样（写与读一致）
    const back = parseSqlFile(text);
    expect(back.meta.dbOrEnv).toBe('test_order / 预发');
    expect(back.meta.varHint).toBe('{{today}} = 今天');
    expect(back.meta.tags).toEqual(['订单', '造数']);
    expect(back.meta.starred).toBe(true);

    // 重名：第二条不覆盖第一条，落成 查订单-2.sql.md
    await fillAndSave(container, fields, true);
    expect(d.files.has('查订单-2.sql.md')).toBe(true);
    expect(d.files.get('查订单.sql.md')).toBe(text); // 第一条没被冲掉
    expect(kindDecidedByName('查订单-2.sql.md')).toBe(true);
  });

  it('编辑无 frontmatter 的老文件：字段空、正文一字不差；保存后补 frontmatter 且正文照旧', async () => {
    const d = fakeDir({ '老片段.sql.md': LEGACY_SQL });
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(ROWS(container).length).toBe(1));

    fireEvent.click(ROWS(container)[0]);
    const dlg = await waitFor(() => dialog());
    expect((within(dlg).getByLabelText('名称') as HTMLInputElement).value).toBe('老片段');
    expect((within(dlg).getByLabelText('库或环境') as HTMLInputElement).value).toBe('');
    expect((within(dlg).getByLabelText('备注') as HTMLInputElement).value).toBe('');
    expect((within(dlg).getByLabelText('SQL 正文') as HTMLTextAreaElement).value).toBe(LEGACY_SQL);

    fireEvent.change(within(dlg).getByLabelText('备注'), { target: { value: '只读，别在生产跑' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(dialog()).toBeNull());

    const text = d.files.get('老片段.sql.md') as string;
    expect(text.startsWith('---\n')).toBe(true);
    expect(text).toContain('remark: 只读，别在生产跑');
    expect(text).not.toContain('dbOrEnv:'); // 空字段不写空行
    // 正文一字不差（含缩进与空行）
    expect(text.split('\n---\n\n')[1].replace(/\s+$/, '')).toBe(LEGACY_SQL);
    // 保存后能再读回来
    expect(parseSqlFile(text).content).toBe(LEGACY_SQL);
  });

  it('改标题会重命名文件（笔记页同款行为），旧文件不残留', async () => {
    const d = fakeDir({ '老片段.sql.md': LEGACY_SQL });
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(ROWS(container).length).toBe(1));

    fireEvent.click(ROWS(container)[0]);
    const dlg = await waitFor(() => dialog());
    fireEvent.change(within(dlg).getByLabelText('名称'), { target: { value: '改过名的片段' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(d.files.has('改过名的片段.sql.md')).toBe(true));

    expect(d.files.has('老片段.sql.md')).toBe(false);
    expect(d.log.some(x => x.op === 'rename' && x.name === '老片段.sql.md' && x.next === '改过名的片段.sql.md')).toBe(true);
    expect(parseSqlFile(d.files.get('改过名的片段.sql.md') as string).content).toBe(LEGACY_SQL);
  });

  it('删除：确认后只删那一个 .sql.md；标题重名的普通 .md 不会出现在这页、也删不到', async () => {
    const d = fakeDir({
      '查订单.sql.md': FM_SQL,
      '查订单.md': '# 同名的普通笔记\n不能因为标题一样就被当片段删掉',
    });
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(ROWS(container).length).toBe(1));

    // 普通笔记不在列表 → 没有它的删除入口
    expect(container.textContent).not.toContain('同名的普通笔记');

    fireEvent.click(within(ROWS(container)[0]).getByTitle('删除'));
    const confirm = await waitFor(() => dialog());
    expect(confirm.textContent).toContain('查订单.sql.md'); // 确认文案里带了要删的文件名
    fireEvent.click(within(confirm).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(d.files.has('查订单.sql.md')).toBe(false));
    expect(d.log.some(x => x.op === 'delete' && x.name === '查订单.sql.md')).toBe(true);
    expect(d.files.has('查订单.md')).toBe(true); // 普通笔记毫发无伤
  });
});

describe('目录模式：收藏（frontmatter.starred）/ 导出', () => {
  it('收藏来自 frontmatter.starred；点星标写回文件且不动 updatedAt', async () => {
    const d = fakeDir({
      '甲.sql.md': '---\nstarred: false\ntags: []\nupdatedAt: 2026-11-01T00:00:00.000Z\n---\n\nselect 1',
      '乙.sql.md': '---\nstarred: true\ntags: []\nupdatedAt: 2026-11-02T00:00:00.000Z\n---\n\nselect 2',
    });
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    // KPI 收藏 = 1，来自乙的 frontmatter
    expect(KPI(container)[1]).toContain('1');

    // 「收藏」筛选只剩乙
    fireEvent.click(within(container.querySelector('.tag-sidebar') as HTMLElement).getByRole('button', { name: /^收藏/ }));
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    expect(ROWS(container)[0].textContent).toContain('乙');
    fireEvent.click(within(container.querySelector('.tag-sidebar') as HTMLElement).getByRole('button', { name: /^全部/ }));
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    // 给甲点星标 → 文件里 starred: true，updatedAt 保持原值
    const rowA = ROWS(container).find(r => (r.textContent || '').includes('甲')) as HTMLElement;
    fireEvent.click(within(rowA).getByTitle('收藏'));
    await waitFor(() => expect(d.files.get('甲.sql.md')).toContain('starred: true'));
    expect(d.files.get('甲.sql.md')).toContain('updatedAt: 2026-11-01T00:00:00.000Z');
    await waitFor(() => expect(KPI(container)[1]).toContain('2'));
  });

  it('导出 Markdown 在目录模式也取当前筛选（不是全部）', async () => {
    const saved: { content: string; name: string }[] = [];
    const d = fakeDir({
      '甲.sql.md': '---\ndbOrEnv: test_db\ntags: []\nupdatedAt: 2026-11-01T00:00:00.000Z\n---\n\nselect * from t_user',
      '乙.sql.md': '---\ntags: []\nupdatedAt: 2026-11-02T00:00:00.000Z\n---\n\nselect * from t_order',
    });
    stubElectronApi({
      ...d.overrides,
      saveText: (content: string, defaultName: string) => {
        saved.push({ content, name: defaultName });
        return Promise.resolve({ success: true, data: { file: 'C:\\tmp\\out.md' } });
      },
    });
    const { container } = render(React.createElement(SqlSnippets));
    await waitFor(() => expect(ROWS(container).length).toBe(2));

    fireEvent.click(within(TOOLS(container)).getByRole('button', { name: /导出 MD/ }));
    await waitFor(() => expect(saved.length).toBe(1));
    expect(saved[0].content.startsWith('# SQL 片段（2 条）')).toBe(true);
    expect(saved[0].content).toContain('## 甲');
    expect(saved[0].content).toContain('## 乙');
    expect(saved[0].name).toMatch(/^SQL片段-\d{8}-\d{4}\.md$/);
    await waitFor(() => expect(container.textContent).toContain('已导出 2 条'));

    // 筛选到 1 条后导出 1 条
    fireEvent.change(container.querySelector('.search input') as HTMLInputElement, { target: { value: 't_order' } });
    await waitFor(() => expect(ROWS(container).length).toBe(1));
    fireEvent.click(within(TOOLS(container)).getByRole('button', { name: /导出 MD/ }));
    await waitFor(() => expect(saved.length).toBe(2));
    expect(saved[1].content.startsWith('# SQL 片段（1 条）')).toBe(true);
    expect(saved[1].content).toContain('## 乙');
    expect(saved[1].content).not.toContain('## 甲');
  });
});

describe('交叉验证：笔记页不再显示 .sql.md（与 t2 的减法对齐）', () => {
  it('目录里 a.md + b.sql.md → 笔记页只渲染 a.md', async () => {
    const d = fakeDir({
      'a.md': '# 一篇普通笔记',
      'b.sql.md': '---\nstarred: true\n---\n\nselect 1',
    });
    stubElectronApi(d.overrides);
    const { container } = render(React.createElement(NotesBody));
    await waitFor(() => expect(container.querySelectorAll('.card2').length).toBe(1));

    expect(container.querySelector('.cards')?.textContent).toContain('a');
    expect(container.querySelector('.cards')?.textContent).not.toContain('b');
    // SQL 片段页那边能找到它（同一份假目录）
    expect(d.files.has('b.sql.md')).toBe(true);
  });
});
