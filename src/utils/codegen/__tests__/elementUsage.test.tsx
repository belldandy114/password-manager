/**
 * 引用完整性闸门（RA3-01 / `[C-110]`「有人在用不许删」）—— **1.36.0（B6）从
 * `src/components/codegen/__tests__/elementRefGuard.test.tsx` 搬来**（裁定 Z2 第 3 条）。
 *
 * 搬家的两个理由：
 * 1. `elementUsage / canDeleteElement / scanElementRefs` 已从 `utils/record/recorderModel.ts`
 *    搬进 `utils/codegen/elementUsage.ts`（B7 要整块删录制器，元素库不能跟着断）；
 * 2. 原文件是靠**渲染组件**（ElementLibTab 的删除按钮 / ArtifactPicker）来断言闸门的，
 *    而 B6-B 会把那两处闸门与横幅一起摘掉 —— 组件级断言活不过下一批。
 *
 * 所以这里断言的是**纯函数本身**（数据进、结论出），深度不降级：
 * ① 被引用 → 不许删，且能说清「谁在第几步」；② 整页删除按「删完之后」批量查；
 * ③ 没被引用 → 必须能删（不能一律拒）；④ 悬空引用必须被检出，且不误报。
 *
 * 原来那几条**只存在于 DOM 的断言**（拦截横幅 `[data-ref-block]`、toast 文案、表格行数）
 * 随组件闸门一起被 B6-B 删除，见 `docs/契约-收敛-渲染层.md` §6.3；它们的语义在这里用
 * `used` / `dangling` / `message` 三样数据表达，断言数量不减。
 */
import { describe, it, expect } from 'vitest';

import {
  elementUsage, canDeleteElement, scanElementRefs, collectElementIds,
  type UiRecording,
} from '../elementUsage';

/* ================================================================
   本地工厂（替代原来的 newRecording / newStep：那两条来自 B7 要删的模块）
   ================================================================ */

/** 一步：只带 `elementId`（这一个字段就是引用闸门的全部输入） */
function step(elementId?: string) {
  return elementId ? { elementId } : {};
}

/** 一份录制：`elementId` 挂在指定下标那一步（步号 = 下标 + 1） */
function recording(id: string, name: string, stepIds: Array<string | undefined>, check?: UiRecording['check']): UiRecording {
  return { id, name, steps: stepIds.map((s) => step(s)), ...(check ? { check } : {}) };
}

/** 一页两个元素：`el-account` / `el-city` */
const PAGE = {
  id: 'page-1',
  elements: [{ id: 'el-account' }, { id: 'el-city' }],
};

/* ================================================================
   ① 被引用时必须能说清「谁在第几步」
   ================================================================ */
describe('RA3-01 ① 被引用的元素：能说清谁在用、在第几步', () => {
  it('elementUsage 返回 1 条使用点，带录制名与 0 基下标', () => {
    const used = elementUsage([recording('rec-1', '登录后进首页', [undefined, 'el-account', undefined])], 'el-account');
    expect(used).toHaveLength(1);
    expect(used[0]).toEqual({ recordingId: 'rec-1', recordingName: '登录后进首页', stepIndex: 1 });
  });

  it('canDeleteElement → ok:false，message 含条数与录制名（界面据此提示「谁在用」）', () => {
    const gate = canDeleteElement([recording('rec-1', '登录后进首页', [undefined, 'el-account'])], 'el-account');
    expect(gate.ok).toBe(false);
    expect(gate.used).toHaveLength(1);
    expect(gate.message).toContain('1 个步骤');
    expect(gate.message).toContain('登录后进首页');
    expect(gate.message).toContain('引用');
  });

  it('多份录制引用同一个元素 → 录制名去重后用「、」连起来', () => {
    const gate = canDeleteElement([
      recording('rec-1', '登录后进首页', ['el-account']),
      recording('rec-2', '下单', ['el-account']),
    ], 'el-account');
    expect(gate.used).toHaveLength(2);
    expect(gate.message).toContain('2 个步骤');
    expect(gate.message).toContain('登录后进首页、下单');
  });

  it('同一步被同 id 引用多次也只算一条（按 step 下标去重的前提：一条 step 只挂一个 elementId）', () => {
    const used = elementUsage([recording('rec-1', 'A', ['el-account', 'el-account'])], 'el-account');
    expect(used).toHaveLength(2);
    expect(used.map((u) => u.stepIndex)).toEqual([0, 1]);
  });
});

/* ================================================================
   ② 删整页：按「删完之后」的现存页面批量查
   ================================================================ */
describe('RA3-01 ② 删整页：先算删完后的 dangling，再按成员 id 过滤', () => {
  it('整页被引用 → 删完后能列出该页成员对应的悬空引用（界面据此拒绝并列出元素）', () => {
    const recordings = [recording('rec-1', '登录后进首页', [undefined, undefined, 'el-city'])];
    // ElementLibTab.removePage 的真实用法：把「删掉这页之后」的数组交给 scanElementRefs
    const after = [] as typeof PAGE[];
    const memberIds = new Set(PAGE.elements.map((e) => String(e.id)));
    const hit = scanElementRefs(recordings, after).dangling.filter((d) => memberIds.has(d.elementId));
    expect(hit).toHaveLength(1);
    expect(hit[0]).toEqual({ recordingId: 'rec-1', stepIndex: 2, elementId: 'el-city' });
  });

  it('整页没被引用 → 删完后一条悬空都没有（不能一律拒）', () => {
    // 另一页 PAGE2 的元素 el-other 在别处被引用：删 PAGE 不该把它算成悬空
    const PAGE2 = { id: 'page-2', elements: [{ id: 'el-other' }] };
    const recordings = [recording('rec-1', '别的流程', ['el-other'])];
    expect(scanElementRefs(recordings, [PAGE2]).dangling).toEqual([]);
  });
});

/* ================================================================
   ③ 无引用时不得一律拒绝
   ================================================================ */
describe('RA3-01 ③ 没被引用 → 必须能删', () => {
  it('没有任何录制 → ok:true 且 message 是空串（别拿警告吓用户）', () => {
    const gate = canDeleteElement([], 'el-account');
    expect(gate.ok).toBe(true);
    expect(gate.message).toBe('');
    expect(gate.used).toEqual([]);
  });

  it('有录制但引用的是别的元素 → 同样 ok:true', () => {
    const gate = canDeleteElement([recording('rec-1', 'A', ['el-city'])], 'el-account');
    expect(gate.ok).toBe(true);
  });

  it('空 elementId → 不算任何引用（历史元素没有 id，谈不上被引用）', () => {
    expect(elementUsage([recording('rec-1', 'A', ['el-account'])], '')).toEqual([]);
    expect(canDeleteElement([recording('rec-1', 'A', ['el-account'])], '').ok).toBe(true);
  });
});

/* ================================================================
   ④ 悬空引用（dangling）
   ================================================================ */
describe('RA3-01 ④ 悬空引用必须检出、且不误报', () => {
  it('步骤引用的元素已不存在 → 一条 dangling，带录制 id / 步下标 / 元素 id', () => {
    const r = scanElementRefs([recording('rec-1', '登录后进首页', [undefined, 'el-gone'])], [PAGE]);
    expect(r.dangling).toHaveLength(1);
    expect(r.dangling[0]).toEqual({ recordingId: 'rec-1', stepIndex: 1, elementId: 'el-gone' });
  });

  it('元素都还在 → 0 条悬空（不能一律报「已不存在」）', () => {
    expect(scanElementRefs([recording('rec-1', 'A', ['el-account', 'el-city'])], [PAGE]).dangling).toEqual([]);
  });

  it('collectElementIds 只收非空字符串 id（缺 id 的历史元素等同「未关联」）', () => {
    const ids = collectElementIds([{ id: 'p', elements: [{ id: 'a' }, {}, { id: '' }, { id: 'b' }] }]);
    expect([...ids].sort()).toEqual(['a', 'b']);
  });

  it('脏输入不抛：null / 缺 steps / 非数组一律当成空', () => {
    expect(elementUsage(null as unknown as UiRecording[], 'x')).toEqual([]);
    expect(scanElementRefs(null as unknown as UiRecording[], null as unknown as [])).toEqual({ dangling: [] });
    expect(canDeleteElement([{ id: 'r' } as UiRecording], 'x').ok).toBe(true);
  });

  it('录制缺 name → 提示里退到录制 id（两条都缺才是「未命名录制」，搬家前就是这个口径）', () => {
    const gate = canDeleteElement([{ id: 'rec-9', steps: [{ elementId: 'el-account' }] } as UiRecording], 'el-account');
    expect(gate.message).toContain('rec-9');
    // 两条都没有 → 固定文案兜底，不能显示空串
    const bare = canDeleteElement([{ steps: [{ elementId: 'el-account' }] } as UiRecording], 'el-account');
    expect(bare.message).toContain('未命名录制');
  });
});
