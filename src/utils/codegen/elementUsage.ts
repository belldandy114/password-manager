/**
 * 元素引用守卫（`[C-110]`「有人在用不许删」+ 产物生成前的悬空引用兜底）。
 *
 * **1.36.0（B6）从 `src/utils/record/recorderModel.ts` 搬出来**（裁定 Z2 / 渲染层契约 §6.3）：
 * 录制器整块（`src/utils/record/**`）在 B7 删除，而这三个纯函数**还要继续守着元素库**——
 * 老库里仍存着 `uiRecordings`，删元素前查引用这条守卫仍然有价值。
 *
 * 搬家原则（Z2 写死）：
 * 1. 只搬「纯函数 + 最小类型」，**读端零行为变化**（文案逐字不变，界面照旧显示那句话）；
 * 2. 所需类型（`UiRecording` 的最小子集）在本文件**本地声明**，不 import `utils/record/`；
 * 3. `src/utils/codegen/**` 不许反向依赖 `src/components/**` —— 页面集合用结构型 typing，
 *    `PomPage[]` 直接可传（与搬家前的做法一致）。
 */

/** 页面集合的结构型入参（只关心 `elements[].id`） */
export interface ElementRefPageLike {
  id?: string;
  elements?: Array<{ id?: string }>;
}

/**
 * 录制的最小形状（结构型）：只用到 `id` / `name` / `steps[].elementId`。
 *
 * `check` 是给 `ElementLibTab` 的「上次校验」派生留的**兼容位**：那段派生代码在 B6-B 会删
 * （来源列改读 `el.source`），删完这里就可以把这一个可选字段一起去掉。
 */
export interface UiRecording {
  id: string;
  name?: string;
  steps?: Array<{ elementId?: string } | null | undefined>;
  check?: { at?: string; total: number; passed: number; failed?: number; approx?: boolean };
}

/** 断链引用：某份录制的第几步指向了一个已经不存在的元素 */
export interface DanglingElementRef {
  recordingId: string;
  /** 数组下标（`index` 连续时等于 `step.index`），界面用它定位 `steps[stepIndex]` */
  stepIndex: number;
  elementId: string;
}

/** 元素使用点（`[C-110]`「有人在用不许删」的证据） */
export interface ElementUsage {
  recordingId: string;
  recordingName: string;
  stepIndex: number;
}

/** 收集 `pomPages` 里现存的元素 id（缺 `id` 的历史元素不参与，等同「未关联」） */
export function collectElementIds(pages: ElementRefPageLike[]): Set<string> {
  const ids = new Set<string>();
  for (const page of Array.isArray(pages) ? pages : []) {
    const elements = (page && page.elements) || [];
    for (const el of elements) {
      if (el && typeof el.id === 'string' && el.id) ids.add(el.id);
    }
  }
  return ids;
}

/**
 * 扫描断链：步骤里的 `elementId` 在 `pomPages` 里找不到 → 一条 `dangling`。
 *
 * 什么时候会断：元素被删、或元素被删后从备份/旧库导入。界面据此提示
 * 「第 N 步引用的元素已不存在」，三产物生成前也必须先过这一关（否则产物里会出现空定位器）。
 */
export function scanElementRefs(
  recordings: UiRecording[],
  pages: ElementRefPageLike[],
): { dangling: DanglingElementRef[] } {
  const known = collectElementIds(pages);
  const dangling: DanglingElementRef[] = [];
  for (const rec of Array.isArray(recordings) ? recordings : []) {
    const steps = (rec && rec.steps) || [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      const elementId = step && step.elementId;
      if (typeof elementId === 'string' && elementId && !known.has(elementId)) {
        dangling.push({ recordingId: String((rec && rec.id) || ''), stepIndex: i, elementId });
      }
    }
  }
  return { dangling };
}

/** 某个元素被哪些步骤引用（删元素前的执行点） */
export function elementUsage(recordings: UiRecording[], elementId: string): ElementUsage[] {
  const out: ElementUsage[] = [];
  if (!elementId) return out;
  for (const rec of Array.isArray(recordings) ? recordings : []) {
    const steps = (rec && rec.steps) || [];
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (step && step.elementId === elementId) {
        out.push({
          recordingId: String((rec && rec.id) || ''),
          recordingName: String((rec && rec.name) || (rec && rec.id) || '未命名录制'),
          stepIndex: i,
        });
      }
    }
  }
  return out;
}

/**
 * 删除元素前的闸门（`[C-110]`：元素被录制步骤引用时**不许删**）。
 *
 * 返回中文文案给界面直接展示；`ok:true` 时 `message` 是空串（没被用就别吓用户）。
 */
export function canDeleteElement(
  recordings: UiRecording[],
  elementId: string,
): { ok: boolean; used: ElementUsage[]; message: string } {
  const used = elementUsage(recordings, elementId);
  if (!used.length) return { ok: true, used, message: '' };

  const names: string[] = [];
  for (const u of used) {
    if (names.indexOf(u.recordingName) < 0) names.push(u.recordingName);
  }
  return {
    ok: false,
    used,
    message: `该元素正被 ${names.join('、')} 的 ${used.length} 个步骤引用，删掉会让这些步骤指不到元素；请先删除或改掉这些步骤`,
  };
}
