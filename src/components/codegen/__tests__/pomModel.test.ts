import { describe, it, expect } from 'vitest';

import { blankElement, cleanPageForWrite, type PomPage } from '../pomModel';

/**
 * 契约 §9 [C-110]（v18 / 裁定 J-13）：元素 `id` 的类型可选、**写入必填**，
 * 且**保存白名单必须透传 `id`**。
 *
 * 这组用例守的是本轮唯一一条**数据丢失**路径：`ElementLibTab` 保存时按
 * name/locator/kind/role/note 逐字段重建元素，任何不在清单里的字段都会被丢掉 ——
 * 迁移回填的 `id` 会在用户「编辑一次 + 保存一次」之后被洗白，
 * `UiStep.elementId` 随之变成悬空引用，AC-8「重开应用后逐字段相等」当场失败。
 *
 * 落点说明：本模块的上限裁剪用例在**同目录**的 `../pomModel.test.ts`（t41 时代就放那儿）；
 * 本文件按 S1 分片 inScope 指定的路径（`src/components/codegen/__tests__/`）承载 id 相关用例。
 * 两处 import 的是同一个 `../pomModel`，没有第二份实现。
 */
describe('[C-110] 元素 id：新建即定、保存不被洗白', () => {
  const draftWith = (elements: PomPage['elements']): PomPage => ({
    id: 'pom-1',
    name: '  登录页  ',
    baseUrl: '  https://example.com/login  ',
    className: '',
    note: '',
    elements,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('blankElement() 自带 id，且每次都是新的', () => {
    const a = blankElement();
    const b = blankElement();
    expect(typeof a.id).toBe('string');
    expect((a.id as string).length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
    expect(a.kind).toBe('css');
  });

  it('已有 id 的元素：保存后 id 不变（迁移回填的 id 不被洗白）', () => {
    const clean = cleanPageForWrite(draftWith([
      { id: 'fixed-id', name: '账号', locator: '#account', kind: 'css', role: '' },
    ]));
    expect(clean.elements[0].id).toBe('fixed-id');
    // 连存两次仍不变（幂等，不是"每次保存换一个 id"）
    expect(cleanPageForWrite(clean).elements[0].id).toBe('fixed-id');
  });

  it('历史元素没有 id（读端容错）→ 保存时补一个非空 id，不写 undefined / 空串', () => {
    const clean = cleanPageForWrite(draftWith([
      { name: '账号', locator: '#account', kind: 'css', role: '' },
    ]));
    expect(typeof clean.elements[0].id).toBe('string');
    expect((clean.elements[0].id as string).length).toBeGreaterThan(0);
  });

  it('白名单仍只保留契约字段（草稿里的临时字段不会被写进库）', () => {
    const dirty = { name: '账号', locator: '#account', kind: 'css', role: '', 临时字段: 'x' } as unknown as PomPage['elements'][0];
    const clean = cleanPageForWrite(draftWith([dirty]));
    expect(Object.keys(clean.elements[0]).sort()).toEqual(['id', 'kind', 'locator', 'name']);
  });

  it('页面字段同样走归一（name / baseUrl 去空白，updatedAt 刷新）', () => {
    const clean = cleanPageForWrite(draftWith([]));
    expect(clean.name).toBe('登录页');
    expect(clean.baseUrl).toBe('https://example.com/login');
    expect(clean.updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
  });
});
