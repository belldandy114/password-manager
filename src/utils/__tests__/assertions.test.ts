import { describe, it, expect } from 'vitest';

import {
  ASSERTION_SEED,
  FRAMEWORK_LABELS,
  CATEGORY_LABELS,
  filterAssertions,
  listAssertions,
  mergeAssertions,
  rowsToAssertions,
  isAssertRow,
  toAssertionRow,
  validateAssertionInput,
  removeAssertionRow,
  type AssertionSnippet,
  type CustomAssertionRow,
} from '../assertions';
import type { AssertionFramework, AssertionCategory } from '../assertionsSeed';

/**
 * 1.4 断言模板库的单测（契约 §3.6 / [C-97]–[C-99]）。
 *
 * 种子只在断言里「验形状」，不逐个比代码正文（正文是人写的可复制片段，
 * 用 golden 去锁它会让人下次改个措辞就要更新 30 个文件）。
 */

describe('ASSERTION_SEED：内置片段', () => {
  it('至少 30 条（任务书下限）', () => {
    expect(ASSERTION_SEED.length).toBeGreaterThanOrEqual(30);
  });

  it('id 唯一、非空', () => {
    const ids = ASSERTION_SEED.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ASSERTION_SEED) expect(s.id.trim()).not.toBe('');
  });

  it('每条都齐活：title / code / tags / framework / category / lang 都合法', () => {
    const frameworks = Object.keys(FRAMEWORK_LABELS) as AssertionFramework[];
    const categories = Object.keys(CATEGORY_LABELS) as AssertionCategory[];
    for (const s of ASSERTION_SEED) {
      expect(s.title.trim()).not.toBe('');
      expect(s.code.trim()).not.toBe('');
      expect(s.tags.length).toBeGreaterThan(0);
      expect(frameworks).toContain(s.framework);
      expect(categories).toContain(s.category);
      expect(s.lang).toBe('java'); // [C-82]：本批只做 Java
    }
  });

  it('框架与用途三维覆盖到位（任务书点名的六类都在）', () => {
    const frameworks = new Set(ASSERTION_SEED.map(s => s.framework));
    expect(frameworks.has('restassured')).toBe(true);
    expect(frameworks.has('playwright')).toBe(true);

    const categories = new Set(ASSERTION_SEED.map(s => s.category));
    for (const c of ['status', 'json', 'schema', 'visibility', 'text', 'attribute'] as AssertionCategory[]) {
      expect(categories.has(c)).toBe(true);
    }
  });

  it('片段里没有占位符 / 伪代码（会被用户直接粘进测试类）', () => {
    for (const s of ASSERTION_SEED) {
      expect(s.code).not.toMatch(/TODO|xxx|\.\.\.<|你的地址/);
      // 每条都以分号或 } 收尾：证明它是能落进方法体的完整语句
      expect(s.code.trim().endsWith(';') || s.code.trim().endsWith('}')).toBe(true);
    }
  });

  it('每条都带依赖说明（note）或至少不是空字符串', () => {
    for (const s of ASSERTION_SEED) {
      if (s.note !== undefined) expect(s.note.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('listAssertions：三维检索（[C-98]）', () => {
  it('空 query 返回全部（顺序 = 种子原序）', () => {
    expect(listAssertions()).toHaveLength(ASSERTION_SEED.length);
    expect(listAssertions().map(s => s.id)).toEqual(ASSERTION_SEED.map(s => s.id));
  });

  it('query 匹配 title / tags / code，且不区分大小写', () => {
    const byTitle = listAssertions('状态码');
    expect(byTitle.length).toBeGreaterThan(0);

    const upper = listAssertions('RESTASSURED');
    const lower = listAssertions('restassured');
    expect(upper.map(s => s.id)).toEqual(lower.map(s => s.id));
    expect(upper.length).toBeGreaterThan(0);

    // 只在 code 里出现的词也能命中
    const byCode = listAssertions('statusCode(200)');
    expect(byCode.some(s => s.id === 'ra-status-200')).toBe(true);
  });

  it('query 不命中 → 空数组（不是全量）', () => {
    expect(listAssertions('这个词不存在-zzz')).toEqual([]);
  });

  it('framework 精确过滤', () => {
    const pw = listAssertions(undefined, 'playwright');
    expect(pw.length).toBeGreaterThan(0);
    expect(pw.every(s => s.framework === 'playwright')).toBe(true);

    const ra = listAssertions(undefined, 'restassured');
    expect(ra.every(s => s.framework === 'restassured')).toBe(true);
    // 两个框架的结果不重叠
    expect(ra.some(s => pw.some(p => p.id === s.id))).toBe(false);
  });

  it('category 过滤（附加维度）', () => {
    const schema = listAssertions(undefined, undefined, { category: 'schema' });
    expect(schema.length).toBeGreaterThan(0);
    expect(schema.every(s => s.category === 'schema')).toBe(true);
  });

  it('lang 过滤：java 命中，其它语言为空', () => {
    expect(listAssertions(undefined, undefined, { lang: 'java' }).length).toBe(ASSERTION_SEED.length);
  });

  it('query 前后空白不影响结果（trim）', () => {
    expect(listAssertions('  schema  ').map(s => s.id)).toEqual(listAssertions('schema').map(s => s.id));
  });
});

describe('filterAssertions：同一套判据也能过滤自定义片段（页面用的就是它）', () => {
  const custom: AssertionSnippet[] = [
    { id: 'x1', title: '订单金额断言', lang: 'java', framework: 'restassured', category: 'json', tags: ['金额'], code: 'body("amount", greaterThan(0));' },
    { id: 'x2', title: '弹窗关闭', lang: 'java', framework: 'playwright', category: 'visibility', tags: ['dialog'], code: 'assertThat(page.locator("#dlg")).isHidden();' },
  ];

  it('对任意数组生效（不是只对种子生效）', () => {
    expect(filterAssertions(custom)).toHaveLength(2);
    expect(filterAssertions(custom, '金额').map(s => s.id)).toEqual(['x1']);
    expect(filterAssertions(custom, undefined, 'playwright').map(s => s.id)).toEqual(['x2']);
    expect(filterAssertions(custom, undefined, undefined, { category: 'json' }).map(s => s.id)).toEqual(['x1']);
  });

  it('与 listAssertions 是同一条规则（种子侧结果一致）', () => {
    expect(filterAssertions(ASSERTION_SEED, 'schema')).toEqual(listAssertions('schema'));
  });
});

describe('mergeAssertions：种子在前、自定义按 updatedAt 降序（[C-98]）', () => {
  const custom: AssertionSnippet[] = [
    { id: 'c1', title: '自定义一', lang: 'java', framework: 'restassured', category: 'json', tags: ['a'], code: 'assertThat(1);', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'c2', title: '自定义二', lang: 'java', framework: 'playwright', category: 'text', tags: ['b'], code: 'assertThat(2);', updatedAt: '2026-03-01T00:00:00.000Z' },
    { id: 'c3', title: '自定义三（无时间）', lang: 'java', framework: 'junit', category: 'general', tags: ['c'], code: 'assertThat(3);' },
  ];

  it('种子全部在前，且保持原序', () => {
    const merged = mergeAssertions(ASSERTION_SEED, custom);
    expect(merged.slice(0, ASSERTION_SEED.length).map(s => s.id)).toEqual(ASSERTION_SEED.map(s => s.id));
  });

  it('自定义在后，按 updatedAt 降序，无时间的排最后', () => {
    const merged = mergeAssertions(ASSERTION_SEED, custom);
    const tail = merged.slice(ASSERTION_SEED.length).map(s => s.id);
    expect(tail).toEqual(['c2', 'c1', 'c3']);
  });

  it('空输入不炸：种子在、自定义空', () => {
    expect(mergeAssertions(ASSERTION_SEED, [])).toHaveLength(ASSERTION_SEED.length);
    expect(mergeAssertions([], custom).map(s => s.id)).toEqual(['c2', 'c1', 'c3']);
  });
});

describe('codeSnippets 映射：kind=assert（[C-97]）', () => {
  const row = (over: Partial<CustomAssertionRow> = {}): CustomAssertionRow => ({
    id: 'r1',
    name: '我的断言',
    lang: 'java',
    code: 'assertThat(page.locator("#a")).isVisible();',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-02-01T00:00:00.000Z',
    kind: 'assert',
    framework: 'playwright',
    category: 'visibility',
    tags: ['自定义'],
    ...over,
  });

  it('isAssertRow 只认 kind=assert（CodeLab 的普通片段不算）', () => {
    expect(isAssertRow(row())).toBe(true);
    expect(isAssertRow({ id: 'x', name: 'n', lang: 'java', code: 'c', createdAt: '', updatedAt: '' })).toBe(false);
    expect(isAssertRow({ kind: 'sql', id: 'x', code: 'c' })).toBe(false);
    expect(isAssertRow(null)).toBe(false);
    expect(isAssertRow('assert')).toBe(false);
  });

  it('rowsToAssertions：过滤非断言行、name→title、按 updatedAt 降序、code 原样', () => {
    const rows = [
      row({ id: 'old', updatedAt: '2026-01-05T00:00:00.000Z', code: 'assertThat(1);' }),
      { id: 'lab', name: '代码调试片段', lang: 'java', code: 'System.out.println();', createdAt: '', updatedAt: '' },
      row({ id: 'new', updatedAt: '2026-05-05T00:00:00.000Z', code: 'assertThat(2);' }),
    ];
    const out = rowsToAssertions(rows);
    expect(out.map(s => s.id)).toEqual(['new', 'old']);
    expect(out[0].title).toBe('我的断言');
    expect(out[0].code).toBe('assertThat(2);');
    expect(out.every(s => s.lang === 'java')).toBe(true);
  });

  it('toAssertionRow 新建：带 kind=assert、随机 uuid、ISO 时间', () => {
    const r = toAssertionRow({ name: ' 新片段 ', code: 'assertThat(x);' });
    expect(r.kind).toBe('assert');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.name).toBe('新片段');
    expect(r.framework).toBe('restassured');
    expect(r.category).toBe('general');
    expect(Number.isNaN(Date.parse(r.createdAt))).toBe(false);
    expect(r.createdAt).toBe(r.updatedAt);
  });

  it('toAssertionRow 更新：保留 id 与 createdAt，只动内容与 updatedAt', () => {
    const before = row();
    const after = toAssertionRow({ name: '改名', code: 'assertThat(y);', tags: ['t'] }, before);
    expect(after.id).toBe(before.id);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.name).toBe('改名');
    expect(after.code).toBe('assertThat(y);');
    expect(after.tags).toEqual(['t']);
    expect(after.framework).toBe('playwright'); // 没传就沿用旧值
  });

  it('validateAssertionInput 给的是可读原因，不是「输入有误」', () => {
    expect(validateAssertionInput({ name: ' ', code: 'x' })).toBe('标题不能为空（检索和列表都靠它认片段）');
    expect(validateAssertionInput({ name: 'n', code: '  ' })).toBe('代码不能为空');
    expect(validateAssertionInput({ name: 'n', code: 'c' })).toBeNull();
  });

  it('removeAssertionRow 只删断言行；内置种子不在这个数组里，删不到', () => {
    const rows = [row({ id: 'keep' }), row({ id: 'drop' }), { id: 'lab', kind: undefined, code: 'x' }];
    const next = removeAssertionRow(rows, 'drop');
    expect(next).toHaveLength(2);
    expect(isAssertRow(next[0]) && (next[0] as CustomAssertionRow).id).toBe('keep');
    // 非断言行即使 id 撞上也不动
    const untouched = removeAssertionRow(rows, 'lab');
    expect(untouched).toHaveLength(3);
    // 种子 id 不在行数组里 → 整个数组不变
    expect(removeAssertionRow(rows, ASSERTION_SEED[0].id)).toHaveLength(3);
  });
});