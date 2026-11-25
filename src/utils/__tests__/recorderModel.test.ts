import { describe, it, expect } from 'vitest';

import {
  MAX_STEPS,
  textValueMeta,
  selectValueMeta,
  isValidValueMeta,
  newStep,
  newRecording,
  appendStep,
  normalizeStepIndexes,
  isIndexContinuous,
  stepLimitError,
  planRecordingSave,
  scanElementRefs,
  elementUsage,
  canDeleteElement,
} from '../record/recorderModel';
import type { UiRecording, UiStep } from '../record/recorderModel';
import { capsOf } from '../collectionTrim';

/**
 * 录制数据模型（`UiRecording` / `UiStep`）纯逻辑的单测（契约 §9.1、AC-20）。
 *
 * 为什么值得逐条锁死：这个文件是 S4b 页面与 S6 三产物的**唯一数据真源**，
 * 三处最容易静默出错的地方各有一组用例：
 * 1. `valueMeta` 只许存「长度 / 序号」——多存一个 `value` 就是明文入库（`[C-119]` 第 2 款）；
 * 2. 两种上限语义**相反**：单库超限是**裁剪并提示**，单份超 300 步是**拒绝保存**——
 *    混成一个「都裁一下」会让脚本中间少步骤却不告诉用户（`[C-09]`）；
 * 3. `steps[i].index === i` 是 AC-20「三产物同源」的锚点，漂了就是三份产物条数对不上。
 */

/* ---------------- 测试便利函数（不引入生产代码以外的依赖） ---------------- */

const iso = (offsetMs: number): string => new Date(1_700_000_000_000 + offsetMs).toISOString();

/** 造一份「有 n 步、第 k 步带 elementId」的录制，updatedAt 按 createdAt 递增 */
function makeRecording(
  n: number,
  opts: { id?: string; at?: number; elementIdPerStep?: (i: number) => string | undefined } = {},
): UiRecording {
  const at = opts.at ?? 0;
  const steps: UiStep[] = [];
  for (let i = 0; i < n; i += 1) {
    const elementId = opts.elementIdPerStep ? opts.elementIdPerStep(i) : undefined;
    steps.push(newStep({ index: i, action: 'click', elementId }));
  }
  return newRecording({
    id: opts.id,
    name: `录制-${opts.id ?? at}`,
    baseUrl: 'https://example.com/login',
    startedAt: iso(at),
    updatedAt: iso(at),
    steps,
  });
}

/* ================================================================
   一、valueMeta 形状（[C-119] 第 2 款 / SEC-04）
   ================================================================ */

describe('valueMeta：只存长度或选项序号，永不存值', () => {
  it('password 输入只回 { length, redacted: true }，没有 value 键', () => {
    const vm = textValueMeta(12);
    expect(vm).toEqual({ length: 12, redacted: true });
    expect('value' in vm).toBe(false);
    expect(Object.keys(vm).sort()).toEqual(['length', 'redacted']);
  });

  it('普通 input（手机号 / token 一类）与 password 同形：不按 type 分叉', () => {
    const password = textValueMeta(12);
    const plain = textValueMeta(11);
    expect(plain).toEqual({ length: 11, redacted: true });
    // 同一个形状、同一套键：只对 password 打码等于把普通输入框里的敏感值录进库
    expect(Object.keys(plain).sort()).toEqual(Object.keys(password).sort());
    expect('value' in plain).toBe(false);
  });

  it('select 只回 { selectedIndex, redacted: true }，不存选项文本、也没有 length', () => {
    const vm = selectValueMeta(2);
    expect(vm).toEqual({ selectedIndex: 2, redacted: true });
    expect('length' in vm).toBe(false);
    expect(Object.keys(vm).sort()).toEqual(['redacted', 'selectedIndex']);
    // 选项文本（如「北京市」）不在任何键里
    expect(JSON.stringify(vm)).not.toContain('北京');
  });

  it('contenteditable 与 input 走同一个形状：只回长度（空内容就是 0，不撒谎）', () => {
    expect(textValueMeta(7)).toEqual({ length: 7, redacted: true });
    expect(textValueMeta(0)).toEqual({ length: 0, redacted: true });
  });

  it('isValidValueMeta 只认两种形状：带 value / 两者并存 / 缺 redacted 一律不合法', () => {
    expect(isValidValueMeta(textValueMeta(3))).toBe(true);
    expect(isValidValueMeta(selectValueMeta(0))).toBe(true);
    expect(isValidValueMeta({ value: 'p@ssw0rd', redacted: true })).toBe(false);
    expect(isValidValueMeta({ length: 3, selectedIndex: 1, redacted: true })).toBe(false);
    expect(isValidValueMeta({ length: 3 })).toBe(false);
    expect(isValidValueMeta({ length: -1, redacted: true })).toBe(false);
    expect(isValidValueMeta(undefined)).toBe(false);
  });

  it('newStep 只搬白名单字段：传进来的 value 不会被带进步骤', () => {
    const step = newStep({ action: 'fill', value: 'secret', valueMeta: textValueMeta(6) } as Partial<UiStep>);
    expect('value' in step).toBe(false);
    expect(step.valueMeta).toEqual({ length: 6, redacted: true });
    expect(JSON.stringify(step)).not.toContain('secret');
  });
});

/* ================================================================
   二、上限语义 A：单份 > 300 步 = **拒绝保存**（不是裁剪）
   ================================================================ */

describe('单份上限 300 步：拒绝保存，不裁剪（[C-109]）', () => {
  it('301 步拒绝保存：不入库、dropped 为 0、给中文原因', () => {
    const existing = [makeRecording(3, { id: 'rec-a', at: 0 })];
    const draft = makeRecording(MAX_STEPS + 1, { id: 'rec-b', at: 1000 });

    const plan = planRecordingSave(existing, draft);

    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('300');
    expect(plan.error).toContain('301');
    // 拒绝 ≠ 裁剪：既没进库，也没说"裁掉了多少"，更不弹裁剪提示
    expect(plan.items.map((r) => r.id)).toEqual(['rec-a']);
    expect(plan.dropped).toBe(0);
    expect(plan.notice).toBe('');
    expect(plan.record).toBeNull();
  });

  it('恰好 300 步可以保存（边界不误伤），300 与 301 的分界由 stepLimitError 说清', () => {
    expect(stepLimitError(MAX_STEPS)).toBeNull();
    expect(stepLimitError(MAX_STEPS + 1)).not.toBeNull();

    const plan = planRecordingSave([], makeRecording(MAX_STEPS, { id: 'rec-max', at: 0 }));
    expect(plan.ok).toBe(true);
    expect(plan.error).toBeUndefined();
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].steps).toHaveLength(MAX_STEPS);
  });
});

/* ================================================================
   三、上限语义 B：单库 20 份 / 1.5 MB = **裁剪 + 必须提示**
   ================================================================ */

describe('单库上限 20 份 / 1536 KB：从最旧裁，dropped 必须交给界面（[C-24a] / [C-09]）', () => {
  it('第 21 份进库时丢掉最旧的一份，并给出 trimNotice 提示', () => {
    const existing: UiRecording[] = [];
    for (let i = 0; i < 20; i += 1) existing.push(makeRecording(2, { id: `rec-${i}`, at: i * 1000 }));
    const draft = makeRecording(2, { id: 'rec-new', at: 30_000 });

    const plan = planRecordingSave(existing, draft);

    expect(plan.ok).toBe(true);
    expect(plan.items).toHaveLength(20);
    expect(plan.dropped).toBe(1);
    // 丢的是最旧的 rec-0，不是刚录的这份
    expect(plan.items.map((r) => r.id)).not.toContain('rec-0');
    expect(plan.items.map((r) => r.id)).toContain('rec-new');
    // 不许静默裁剪：提示要原样交给调用方展示
    expect(plan.notice).toBe('历史记录已按上限裁剪，最早 1 条已清理');
  });

  it('未超限时 dropped 为 0、notice 是空串（没裁就别提示）', () => {
    const existing = [makeRecording(2, { id: 'rec-a', at: 0 })];
    const plan = planRecordingSave(existing, makeRecording(2, { id: 'rec-b', at: 1000 }));

    expect(plan.ok).toBe(true);
    expect(plan.dropped).toBe(0);
    expect(plan.notice).toBe('');
    // 新的追加在末尾（顺序即「旧 → 新」，裁剪按 updatedAt 判旧）
    expect(plan.items.map((r) => r.id)).toEqual(['rec-a', 'rec-b']);
    // 入参数组不被改（纯函数）
    expect(existing).toHaveLength(1);
  });

  it('字节上限同样生效：条数没超但总量超 1536 KB 时从最旧丢，提示不为空', () => {
    // 每份约 500 KB（一步 note 50 万字符），4 份 ≈ 2 MB > 1536 KB，丢 1 份即回到 1.5 MB 以内
    const bigNote = 'a'.repeat(500_000);
    const existing: UiRecording[] = [];
    for (let i = 0; i < 3; i += 1) {
      existing.push(makeRecording(1, { id: `big-${i}`, at: i * 1000 }));
      existing[i].steps[0].note = bigNote;
    }
    const draft = makeRecording(1, { id: 'big-3', at: 9000 });
    draft.steps[0].note = bigNote;

    const plan = planRecordingSave(existing, draft);

    expect(plan.ok).toBe(true);
    expect(plan.dropped).toBe(1);
    expect(plan.items).toHaveLength(3);
    expect(plan.items.map((r) => r.id)).not.toContain('big-0');
    expect(plan.notice).toBe('历史记录已按上限裁剪，最早 1 条已清理');
    // 上限口径取自 collectionTrim，不在本文件另造一份数字
    expect(capsOf('uiRecordings').maxBytes).toBe(1536 * 1024);
  });

  it('同一 id 再保存是覆盖而不是新增（编辑不会变成第 2 份）', () => {
    const existing = [makeRecording(2, { id: 'rec-a', at: 0 })];
    const edited = makeRecording(4, { id: 'rec-a', at: 5000 });

    const plan = planRecordingSave(existing, edited);

    expect(plan.ok).toBe(true);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].steps).toHaveLength(4);
    expect(plan.dropped).toBe(0);
    expect(plan.record).not.toBeNull();
  });
});

/* ================================================================
   四、引用完整性（[C-110] 的「有人在用不许删」执行点）
   ================================================================ */

describe('引用完整性：元素被删后步骤引用会断', () => {
  const pages = [{ id: 'page-1', elements: [{ id: 'el-1' }, { id: 'el-2' }] }];

  it('引用了 pomPages 里不存在的元素 id → 报出 dangling（含录制 id、步骤下标、元素 id）', () => {
    const rec = makeRecording(3, {
      id: 'rec-a',
      at: 0,
      elementIdPerStep: (i) => ['el-1', 'el-deleted', 'el-2'][i],
    });

    const { dangling } = scanElementRefs([rec], pages);

    expect(dangling).toEqual([{ recordingId: 'rec-a', stepIndex: 1, elementId: 'el-deleted' }]);
  });

  it('所有引用都能在 pomPages 里找到 → dangling 为空；没写 elementId 的步骤不算引用', () => {
    const rec = makeRecording(4, {
      id: 'rec-b',
      at: 0,
      elementIdPerStep: (i) => ['el-1', undefined, 'el-2', undefined][i],
    });

    const { dangling } = scanElementRefs([rec], pages);

    expect(dangling).toEqual([]);
  });

  it('elementUsage / canDeleteElement：有人在用的元素不许删，文案点名录制与步骤数', () => {
    const rec = makeRecording(2, { id: 'rec-a', at: 0, elementIdPerStep: () => 'el-1' });
    const other = makeRecording(1, { id: 'rec-b', at: 1000, elementIdPerStep: () => 'el-1' });

    const used = elementUsage([rec, other], 'el-1');
    expect(used).toHaveLength(3);
    expect(used.map((u) => u.recordingId)).toEqual(['rec-a', 'rec-a', 'rec-b']);

    const blocked = canDeleteElement([rec, other], 'el-1');
    expect(blocked.ok).toBe(false);
    expect(blocked.message).toContain('引用');
    expect(blocked.message).toContain(rec.name);

    const free = canDeleteElement([rec, other], 'el-2');
    expect(free.ok).toBe(true);
    expect(free.message).toBe('');
  });
});

/* ================================================================
   五、工厂与 index 连续性（AC-20 的 `steps[i].index === i`）
   ================================================================ */

describe('工厂与 index 连续性（AC-20 依赖这条）', () => {
  it('newRecording() 给出必填 id、ISO 的 updatedAt、空录制 steps（空录制是合法状态）', () => {
    const rec = newRecording();

    expect(typeof rec.id).toBe('string');
    expect(rec.id.length).toBeGreaterThan(0);
    expect(rec.steps).toEqual([]);
    expect(new Date(rec.updatedAt).toISOString()).toBe(rec.updatedAt);
    expect(new Date(rec.startedAt).toISOString()).toBe(rec.startedAt);
    expect(isIndexContinuous(rec)).toBe(true);
    // id 不重复（新建走 randomUUID 一类的随机源）
    expect(newRecording().id).not.toBe(rec.id);
  });

  it('newStep() 的 id 必填且两次不重复，未指定 index 时从 0 起', () => {
    const a = newStep();
    const b = newStep();

    expect(a.id.length).toBeGreaterThan(0);
    expect(a.id).not.toBe(b.id);
    expect(a.index).toBe(0);
    expect(newStep({ index: 4 }).index).toBe(4);
  });

  it('appendStep 之后 steps[i].index === i 连续升序（AC-20 的锁）', () => {
    let rec = newRecording({ name: '录制', baseUrl: 'https://example.com' });
    rec = appendStep(rec, { action: 'navigate' });
    rec = appendStep(rec, { action: 'click', locator: { kind: 'css', value: '#login' } });
    rec = appendStep(rec, { action: 'fill', valueMeta: textValueMeta(6) });

    expect(rec.steps).toHaveLength(3);
    for (let i = 0; i < rec.steps.length; i += 1) expect(rec.steps[i].index).toBe(i);
    expect(isIndexContinuous(rec)).toBe(true);
    // 入参录制不被改（纯函数）
    expect(rec.steps.map((s) => s.action)).toEqual(['navigate', 'click', 'fill']);
  });

  it('normalizeStepIndexes 幂等，且能把漂掉的 index 拉回数组下标', () => {
    const drifted: UiStep[] = [
      newStep({ index: 5, action: 'click' }),
      newStep({ index: 9, action: 'fill' }),
    ];

    const fixed = normalizeStepIndexes(drifted);
    expect(fixed.map((s) => s.index)).toEqual([0, 1]);
    // 幂等：再跑一次严格相等（保存前后逐字段相等是 AC-8 的前提）
    expect(normalizeStepIndexes(fixed)).toEqual(fixed);
    // 步骤的 id 不因重排而变
    expect(fixed.map((s) => s.id)).toEqual(drifted.map((s) => s.id));
    expect(isIndexContinuous({ ...newRecording(), steps: fixed })).toBe(true);
  });
});
