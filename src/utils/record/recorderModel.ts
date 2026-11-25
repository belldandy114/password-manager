/**
 * 录制步骤数据模型与纯逻辑（契约 §9.1 `[C-109]` / `[C-110]`、AC-20）。
 *
 * **这个文件是谁的唯一真源**：S4b 的录制页面（列表 / 步骤表 / 引用提示）与 S6 的三产物
 * （Java POM / 零依赖 `.mjs` / Playwright `.spec.ts`）都从这里取类型与判定，页面里不要再各写一份。
 *
 * 三条口径（写死在 `src/utils/__tests__/recorderModel.test.ts`）：
 *
 * 1. **值只存 `length` / `selectedIndex`**（`[C-119]` 第 2 款、SEC-04）：`electron/record-inject.js`
 *    的 `valueMetaOf()` 对 `input` / `textarea` / `contenteditable` 一律只回
 *    `{ length, redacted: true }`，`select` 只回 `{ selectedIndex, redacted: true }`。
 *    本文件沿用这两个形状（v19 补 `selectedIndex`），**永不出现 `value` 键**——多存一个值
 *    就是明文入库，且会随备份/明文导出/生成物一起流出去。
 * 2. **两种上限语义相反，别混**（这是 `[C-109]` 与 `[C-24a]` 的区别）：
 *    - **单份**：`steps > MAX_STEPS(300)` → **拒绝保存**（`planRecordingSave` 的 `ok:false`），
 *      裁掉中间的步骤会让脚本语义错乱，宁可让用户自己删；
 *    - **单库**：20 份 / 1536 KB → **裁剪**（走 `trimToCaps(capsOf('uiRecordings'))`），
 *      并把 `trimNotice(dropped)` 的中文提示交给调用方展示（`[C-09]`：不许静默截断）。
 * 3. **`steps[i].index === i`**（AC-20 第 5 条）：`index` 显式存储（不靠数组下标，因为插入/裁剪会漂），
 *    但正常数据里它必须等于数组下标 —— 三份产物「同源」的机械判据就靠这条。
 *
 * 纯函数约定：不 import React / Node / fs / ipc；不原地改入参（都返回新对象，入参保持原样）。
 * 唯一的外部依赖是 `src/utils/id.ts` 的 `newId()`（浏览器侧 `crypto.randomUUID` 兜底）与
 * `src/utils/collectionTrim.ts` 的上限口径 —— 两处都是渲染层纯工具，不引 Node 类型。
 */

import { newId } from '../id';
import { trimToCaps, capsOf, trimNotice } from '../collectionTrim';
// 只借类型：`record:event` / `record:validate` 的形状归 S3 的 `types.ts`（契约 §9.6 owner 表），
// 本文件不重复声明一份，否则两处漂移时编译器不会提醒（`import type` 不产生运行时依赖）。
import type { RecordEvent, RecordValidateItem, RecordValidateRow } from '../../types';

/* ================================================================
   类型（与契约 §9.1 的 `uiRecordings` / `UiStep` 逐字对齐）
   ================================================================ */

/** 单份录制的步数上限（契约 `[C-109]`：`steps ≤ 300`，超出**拒绝保存**） */
export const MAX_STEPS = 300;

/** 定位器 / 校验候选的策略枚举（与 `record:validate` 的 `items[].strategy` 同一套） */
export type UiLocatorKind = 'css' | 'xpath' | 'text' | 'role';

/** 步骤动作（`[C-114]` 事件形状的 `action` 再补 `navigate` / `assert` 两个人工步骤） */
export type UiStepAction = 'navigate' | 'click' | 'fill' | 'select' | 'press' | 'assert';

/** 步骤的定位器（`kind` 与 `PomElementRow.kind` 同枚举，`role` 时带可访问名） */
export interface UiStepLocator {
  kind: UiLocatorKind;
  value: string;
  roleName?: string;
}

/**
 * 值元数据（契约 `[C-119]` 第 2 款 / SEC-04；v19 定为**判别联合**，与 `src/types.ts:1156`
 * 的 `RecordValueMeta` 逐字同一形状）。
 *
 * - 输入类控件（`input` 含 `type=password`、`textarea`、`contenteditable`）→ `{ length, redacted: true }`；
 * - `select` → `{ selectedIndex, redacted: true }`，**不存选项文本**。
 *
 * **为什么是判别联合而不是「两个字段都可选」**（v19 裁定，本片落地）：后者在类型层允许
 * `{ length: 3, selectedIndex: 1 }` 这种「两个都造出来」的值——那正是把「省/市」「账户类型」
 * 这类业务信息变相存进库的构造方式。改成联合后**编译期就挡住**，不必等运行期。
 *
 * 两者分工（不是二选一）：
 * - **判别联合**挡的是「我们自己构造的值」；
 * - `isValidValueMeta()` 挡的是「**别人送来的**值」——`record:event` 的载荷来自页面，是不可信输入，
 *   类型系统对它无能为力（`any` 进来的数据可能带 `value` 键）。
 */
export type UiValueMeta = { redacted: true } & ({ length: number } | { selectedIndex: number });

/** 断言步骤的比较口径（`assert` 动作专用） */
export interface UiStepAssert {
  kind: 'url' | 'text' | 'title';
  contains: string;
}

/** 一个步骤（契约 §9.1 的 `UiStep`） */
export interface UiStep {
  id: string;
  /** **显式存**的步骤序号（不靠数组下标）；正常数据里必须等于数组下标，见 `isIndexContinuous` */
  index: number;
  action: UiStepAction;
  locator?: UiStepLocator;
  /** 元素库里 `PomElementRow.id` 的引用（`[C-110]`）；断了就是 `scanElementRefs` 的 dangling */
  elementId?: string;
  valueMeta?: UiValueMeta;
  /** 环境变量名（如 `ACCOUNT`），生成物里写 `process.env.X`，**永不存明文** */
  valueRef?: string;
  note?: string;
  assert?: UiStepAssert;
}

/** 最近一次元素级校验的汇总（契约 `[C-109]` 的 `check`） */
export interface UiRecordingCheck {
  /** ISO 字符串（`[C-22]`） */
  at: string;
  total: number;
  passed: number;
  failed: number;
  /** 校验结果是否只是「近似」（如文案被截断后比较） */
  approx?: boolean;
}

/** 一份录制（契约 §9.1 的 `uiRecordings` 元素） */
export interface UiRecording {
  /** 新建走 `newId()`；迁移/导入的历史数据可能缺，读端容错（见 `newRecording`） */
  id: string;
  /** 1–80 字符 */
  name: string;
  /** 关联 `pomPages` 页面；关联后 `baseUrl` 以页面为准 */
  pageId?: string;
  /** `http(s)://…`，≤ 500 字符，**入库前已脱敏**（`[C-119]` 第 5 款） */
  baseUrl: string;
  /** ISO（`[C-22]`） */
  startedAt: string;
  /** ISO（`[C-22]`） */
  updatedAt: string;
  /** ≤ `MAX_STEPS` 步 */
  steps: UiStep[];
  check?: UiRecordingCheck;
}

/* ================================================================
   valueMeta：形状工厂 + 校验（唯一读值位点的「下游形状」）
   ================================================================ */

/** 值元数据允许出现的全部键（多一个就是违规；`value` 永远不在这里） */
export const VALUE_META_KEYS: string[] = ['length', 'selectedIndex', 'redacted'];

/**
 * 输入类控件的值元数据：只回长度。
 *
 * `input`（含 `type=password` / `text` / `number` / `email` …）、`textarea`、`contenteditable`
 * **不分叉**，全走这一个工厂 —— 只对 password 打码等于把普通输入框里的手机号、身份证、token
 * 全部录进库（SEC-04 的原话）。
 */
export function textValueMeta(length: number): UiValueMeta {
  const n = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0;
  return { length: n, redacted: true };
}

/** `select` 的值元数据：只回选项序号，不回选项文本 */
export function selectValueMeta(selectedIndex: number): UiValueMeta {
  const n = Number.isFinite(selectedIndex) ? Math.max(0, Math.floor(selectedIndex)) : 0;
  return { selectedIndex: n, redacted: true };
}

/**
 * 值元数据是否合法：**恰好** `{ length }` 或 `{ selectedIndex }` 之一 + `redacted: true`。
 *
 * 用途是给写盘/生成前的守卫（S6）与页面（S4b）一处共用的判据：两者并存、
 * 带 `value`、缺 `redacted`、负数长度都不合法。
 */
export function isValidValueMeta(vm: unknown): boolean {
  if (!vm || typeof vm !== 'object') return false;
  const o = vm as Record<string, unknown>;
  if (o.redacted !== true) return false;
  const keys = Object.keys(o);
  if (keys.some((k) => VALUE_META_KEYS.indexOf(k) < 0)) return false;
  const hasLength = typeof o.length === 'number';
  const hasIndex = typeof o.selectedIndex === 'number';
  // 互斥：两者并存等于「不知道这是哪种控件」
  if (hasLength === hasIndex) return false;
  const n = (hasLength ? o.length : o.selectedIndex) as number;
  return Number.isFinite(n) && n >= 0;
}

/* ================================================================
   工厂：id 必填、index 连续、updatedAt 是 ISO
   ================================================================ */

/** ISO 字符串（`[C-22]`）：统一走 `toISOString()`，别用本地格式 */
function isoTimestamp(at?: string): string {
  if (typeof at === 'string' && at) {
    const t = Date.parse(at);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

/**
 * 新建一个步骤。**只搬白名单字段**（`locator` / `elementId` / `valueMeta` / `valueRef` /
 * `note` / `assert`），传进来的任何自由字段一律不带走 —— 与元素库
 * `cleanPageForWrite()` 同一条口径：多带的字段迟早会把明文或临时态写进库里。
 */
export function newStep(init: Partial<UiStep> = {}): UiStep {
  const step: UiStep = {
    id: String(init.id || newId()),
    index: Number.isInteger(init.index) ? Number(init.index) : 0,
    action: (init.action || 'click') as UiStepAction,
  };
  if (init.locator) {
    const loc = { ...init.locator };
    if (loc.roleName === undefined) delete loc.roleName;
    step.locator = loc;
  }
  if (init.elementId) step.elementId = String(init.elementId);
  if (init.valueMeta) step.valueMeta = { ...init.valueMeta };
  if (init.valueRef) step.valueRef = String(init.valueRef);
  if (init.note) step.note = String(init.note);
  if (init.assert) step.assert = { ...init.assert };
  return step;
}

/**
 * 新建一份录制：`id` / `startedAt` / `updatedAt` 都必填（漏了就地补），`steps` 缺省为 `[]`
 * ——**空录制是合法状态**（刚点「开始录制」还没做动作）。
 *
 * `steps` 传进来时会顺带 `normalizeStepIndexes()`：外部导入的录制可能 `index` 漂了。
 */
export function newRecording(init: Partial<UiRecording> = {}): UiRecording {
  const at = isoTimestamp(undefined);
  const rec: UiRecording = {
    id: String(init.id || newId()),
    name: init.name !== undefined ? String(init.name) : '未命名录制',
    baseUrl: init.baseUrl !== undefined ? String(init.baseUrl) : '',
    startedAt: isoTimestamp(init.startedAt),
    updatedAt: isoTimestamp(init.updatedAt) || at,
    steps: normalizeStepIndexes(init.steps || []),
  };
  if (init.pageId) rec.pageId = String(init.pageId);
  if (init.check) rec.check = { ...init.check };
  return rec;
}

/**
 * 追加一步：新步骤的 `index` **由当前步数决定**（`= steps.length`），这是「升序连续」的唯一入口。
 *
 * 不碰 `updatedAt`（保持纯函数、可重放）；要刷新时间由调用方显式赋值。
 * 也不在这里拦 `MAX_STEPS`：录制期允许超过再逐步删（`planRecordingSave` 会在保存时拒绝并给原因）。
 */
export function appendStep(rec: UiRecording, init: Partial<UiStep> = {}): UiRecording {
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  const step = newStep({ ...init, index: steps.length });
  return { ...rec, steps: [...steps, step] };
}

/**
 * 把 `index` 拉回数组下标（升序连续）。**幂等**：已经连续时返回结构相等的副本。
 *
 * 只改 `index`，不动 `id` / `action` / 值元数据 —— 重排不能改变数据身份（AC-8 逐字段相等的前提）。
 */
export function normalizeStepIndexes(steps: UiStep[]): UiStep[] {
  const src = Array.isArray(steps) ? steps : [];
  return src.map((s, i) => (s.index === i ? s : { ...s, index: i }));
}

/** `steps[i].index === i` 是否全部成立（AC-20 第 5 条的机械判据） */
export function isIndexContinuous(rec: Pick<UiRecording, 'steps'>): boolean {
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  for (let i = 0; i < steps.length; i += 1) {
    if (steps[i].index !== i) return false;
  }
  return true;
}

/* ================================================================
   上限语义 A：单份 > 300 步 → **拒绝保存**（不是裁剪）
   ================================================================ */

/**
 * 单份步数超限的中文原因；没超返回 `null`。
 *
 * 提示写「不会自动裁剪」是刻意的：`[C-109]` 明确这一步**不许静默裁剪**——裁掉中间的步骤会让
 * 生成脚本的语义错乱（少一个 `fill` 就可能让后面的断言全红），宁可让用户自己删。
 */
export function stepLimitError(count: number): string | null {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (n <= MAX_STEPS) return null;
  return `单份录制最多 ${MAX_STEPS} 步，当前 ${n} 步；超出的步骤不会被自动裁掉，请先删除多余步骤再保存`;
}

/** `planRecordingSave()` 的结果：`ok:false` 时 `items` 是入参原样（一份都不写） */
export interface RecordingSavePlan {
  /** 能否保存 */
  ok: boolean;
  /** 规整（`index` 已归位）后的这一份；被拒绝时为 `null` */
  record: UiRecording | null;
  /** 要落盘的**完整集合**（已裁剪）；被拒绝时 = 入参副本 */
  items: UiRecording[];
  /** 因单库上限被裁掉的份数（0 = 没超限） */
  dropped: number;
  /** `trimNotice(dropped)` 的中文提示；`dropped === 0` 时是空串。**必须交给界面展示**（`[C-09]`） */
  notice: string;
  /** 拒绝原因（中文，可直接展示）；能保存时为 `undefined` */
  error?: string;
}

/**
 * 保存一份录制的完整计划（**纯函数**：不写盘、不调 IPC、不改入参）。
 *
 * 顺序是刻意的，两种上限语义各有归属：
 * 1. **先判单份**：`steps > MAX_STEPS` → 直接 `ok:false`（**拒绝**，不进库、不裁剪、不提示裁剪）；
 * 2. **再走单库裁剪**：`trimToCaps(list, capsOf('uiRecordings'))` —— 20 份 / 1536 KB，
 *    超出**从最旧丢**，`dropped` 与 `notice` 一起返回给调用方（不许静默）。
 *
 * 同 `id` 覆盖而不是追加：用户在页面上编辑既有录制时，不该把一份变成两份（那会白吃一条上限）。
 */
export function planRecordingSave(recordings: UiRecording[], draft: UiRecording): RecordingSavePlan {
  const list = Array.isArray(recordings) ? recordings : [];
  const steps = Array.isArray(draft && draft.steps) ? draft.steps : [];

  const error = stepLimitError(steps.length);
  if (error) {
    return { ok: false, record: null, items: [...list], dropped: 0, notice: '', error };
  }

  const normalized: UiRecording = { ...draft, steps: normalizeStepIndexes(steps) };
  const at = list.findIndex((r) => r && r.id === normalized.id);
  const next = at >= 0 ? list.map((r, i) => (i === at ? normalized : r)) : [...list, normalized];

  const trimmed = trimToCaps(next, capsOf('uiRecordings'), {
    // 从最旧丢：录制的时间真源是 `updatedAt`（`[C-22]`），不靠数组顺序
    timeOf: (r: UiRecording) => (r && r.updatedAt) || undefined,
  });

  return {
    ok: true,
    record: normalized,
    items: trimmed.items,
    dropped: trimmed.dropped,
    notice: trimNotice(trimmed.dropped),
  };
}

/* ================================================================
   引用完整性：`UiStep.elementId` ↔ `PomElementRow.id`
   ================================================================ */

/**
 * 页面集合的结构型入参（只关心 `elements[].id`）。
 *
 * 刻意不 import `src/components/codegen/pomModel`：`src/utils/**` 反向依赖 `src/components/**`
 * 会把纯工具层和页面层绑死。结构型 typing 让 `PomPage[]` 直接可传。
 */
export interface ElementRefPageLike {
  id?: string;
  elements?: Array<{ id?: string }>;
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
      const elementId = steps[i] && steps[i].elementId;
      if (typeof elementId === 'string' && elementId && !known.has(elementId)) {
        dangling.push({ recordingId: String(rec.id || ''), stepIndex: i, elementId });
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
      if (steps[i] && steps[i].elementId === elementId) {
        out.push({
          recordingId: String(rec.id || ''),
          recordingName: String(rec.name || rec.id || '未命名录制'),
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

/* ================================================================
   S4b：`record:event` → 步骤（页面载荷是**不可信输入**，这里全量洗一遍）
   ================================================================ */

/**
 * 一个定位器候选（与契约 §9.2「事件形状」的 `candidates[]` 逐字对齐）。
 *
 * `count` 可以是 `null`（页内算不出来时），`precise` 由页内给（`count === 1`），
 * 但**两者都要在本层重新对着看一遍**：`precise:true` 而 `count:3` 的载荷一律不认作推荐。
 */
export interface UiCandidate {
  strategy: UiLocatorKind;
  selector: string;
  count: number | null;
  precise: boolean;
  roleName?: string;
}

/**
 * 录制中的一步：步骤本体 + 页内给的全部候选。
 *
 * 候选**不入库**（`UiStep` 里没有这个字段，契约 §9.1 也没给）：它只用于候选面板、推荐判定
 * 和送 `record:validate` 的入参。落库时经 `toRecording()` 收敛成 `UiStep[]`。
 */
export interface RecordedStep {
  step: UiStep;
  /** 元素标签（`target.text` 主进程**一律不转发**，见 `electron/record-session.js` 第 6 条） */
  target: { tag: string; role?: string };
  candidates: UiCandidate[];
  /** 当前选中的候选下标；`-1` = 没有可用候选（该步骤不能落库，也不送 validate） */
  chosen: number;
}

/** 推荐优先级：css 最稳（能直接 `querySelectorAll` 求命中数）、text 最脆（文案一改就断） */
export const CANDIDATE_PRIORITY: UiLocatorKind[] = ['css', 'xpath', 'role', 'text'];

/** `selector` 上限（契约 §9.2 `record:validate`：≤ 500 字符、禁 `\u0000` 与换行） */
export const MAX_SELECTOR_LEN = 500;

/** 允许出现在载荷里的策略（其余一律丢弃，别把页内瞎写的 strategy 透到主进程） */
const LOCATOR_KINDS: UiLocatorKind[] = ['css', 'xpath', 'role', 'text'];

/**
 * 洗候选：**来源不可信**（页面载荷，可能是伪造的）。
 *
 * 丢掉的东西里最要紧的是超长 `selector`——主进程会**整条候选丢弃**（不截断成半截选择器），
 * 渲染层先丢一遍是为了「面板上显示的一定能送进 validate」，不会点了半天才发现入参不合法。
 */
export function normalizeCandidates(raw: unknown): UiCandidate[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: UiCandidate[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const strategy = String(c.strategy || '');
    if (LOCATOR_KINDS.indexOf(strategy as UiLocatorKind) < 0) continue;
    const selector = typeof c.selector === 'string' ? c.selector : '';
    if (!selector || selector.length > MAX_SELECTOR_LEN) continue;
    if (/[\u0000\r\n]/.test(selector)) continue;
    const count = typeof c.count === 'number' && Number.isFinite(c.count) ? Math.max(0, Math.floor(c.count)) : null;
    const cand: UiCandidate = {
      strategy: strategy as UiLocatorKind,
      selector,
      count,
      // 推荐判定只认 `count === 1`；页内给的 precise 只作展示（与 count 冲突时以 count 为准）
      precise: count === 1,
    };
    if (typeof c.roleName === 'string' && c.roleName) cand.roleName = c.roleName;
    out.push(cand);
  }
  return out;
}

/** 能否作为「推荐」：唯一命中才算（`[C-109]` / AC-1 的判据就是 `data-count === 1`） */
export function isRecommendedCandidate(c: UiCandidate): boolean {
  return !!c && c.count === 1 && c.precise === true;
}

/**
 * 从候选里挑推荐的**下标**，没有返回 `-1`。
 *
 * 多个候选都唯一命中时按 `CANDIDATE_PRIORITY` 取（css > xpath > role > text）——
 * 不取第一个：页内给候选的顺序是「data-testid → role → text → css路径」，
 * 第一个唯一命中的往往是 role，而 role 在这套系统里一律算「近似」。
 */
export function pickRecommended(candidates: UiCandidate[]): number {
  const list = Array.isArray(candidates) ? candidates : [];
  let best = -1;
  let bestRank = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < list.length; i += 1) {
    if (!isRecommendedCandidate(list[i])) continue;
    const rank = CANDIDATE_PRIORITY.indexOf(list[i].strategy);
    if (rank >= 0 && rank < bestRank) {
      best = i;
      bestRank = rank;
    }
  }
  return best;
}

/** 候选 → 步骤定位器 */
export function locatorOf(c: UiCandidate): UiStepLocator {
  const loc: UiStepLocator = { kind: c.strategy, value: c.selector };
  if (c.roleName) loc.roleName = c.roleName;
  return loc;
}

/**
 * 一条 `record:event` → 一步。
 *
 * 三条口径：
 * 1. `valueMeta` 走 `isValidValueMeta()` 白名单——**这是它存在的理由**（载荷不可信，
 *    `{ value: 'xxx' }` 这种必须在这里就被丢掉，别指望类型系统）；
 * 2. `locator` 直接取推荐候选；一个唯一命中的都没有时**不硬凑**（`locator` 留空，
 *    面板会显示「无唯一命中」，该步骤不可落库）；
 * 3. `elementId` 不在这里填：元素是**保存时**才落元素库的，录制期没有元素 id 可指。
 */
export function stepFromEvent(event: RecordEvent | null | undefined, index: number): RecordedStep {
  const candidates = normalizeCandidates(event && event.candidates);
  const chosen = pickRecommended(candidates);
  const rawMeta = event && event.valueMeta;
  const step = newStep({
    index,
    action: (event && event.action ? event.action : 'click') as UiStepAction,
    locator: chosen >= 0 ? locatorOf(candidates[chosen]) : undefined,
    valueMeta: isValidValueMeta(rawMeta) ? (rawMeta as UiValueMeta) : undefined,
  });
  const target = (event && event.target) || { tag: '' };
  const recorded: RecordedStep = {
    step,
    target: { tag: String(target.tag || '') },
    candidates,
    chosen,
  };
  if (target.role) recorded.target.role = String(target.role);
  return recorded;
}

/** 用户改选候选：只换 `locator` 与 `chosen`，步骤 `id` 不变（AC-8 的逐字段相等靠它） */
export function chooseCandidate(rec: RecordedStep, index: number): RecordedStep {
  const candidates = Array.isArray(rec.candidates) ? rec.candidates : [];
  if (index < -1 || index >= candidates.length) return rec;
  const step: UiStep = { ...rec.step };
  if (index >= 0) step.locator = locatorOf(candidates[index]);
  else delete step.locator;
  return { ...rec, step, chosen: index };
}

/** `toRecording()` 的入参：只留调用方真正要决定的字段，其余由工厂兜底 */
export interface RecordingInit {
  id: string;
  name: string;
  baseUrl: string;
  startedAt: string;
  updatedAt?: string;
  pageId?: string;
  check?: UiRecordingCheck;
}

/**
 * 录制中的步骤 → 一份可落库的 `UiRecording`。
 *
 * `index` 在这里再归位一次（`normalizeStepIndexes`）：录制期可能删过步骤，
 * 而 AC-20「三产物同源」依赖 `steps[i].index === i`。
 */
export function toRecording(recs: RecordedStep[], init: RecordingInit): UiRecording {
  const steps: UiStep[] = (Array.isArray(recs) ? recs : []).map((rec) => {
    const step: UiStep = { ...rec.step };
    if (rec.chosen >= 0 && rec.candidates[rec.chosen]) step.locator = locatorOf(rec.candidates[rec.chosen]);
    else delete step.locator;
    return step;
  });
  const rec = newRecording({
    id: init.id,
    name: init.name,
    baseUrl: init.baseUrl,
    startedAt: init.startedAt,
    updatedAt: init.updatedAt,
    pageId: init.pageId,
    check: init.check,
    steps,
  });
  return rec;
}

/* ================================================================
   S4b：校验入参、校验结果 → 报告行
   ================================================================ */

/**
 * 把录制步骤拆成 `record:validate` 的入参。
 *
 * 返回 `stepIndexes` 与 `items` 是**同长同序**的：结果回来时靠它把每一行放回对应步骤
 * （界面右键「命中数」与「步骤」对不上，就是这里对齐错了）。没有定位器的步骤不送校验。
 */
export function validateItemsOf(recs: RecordedStep[]): { stepIndexes: number[]; items: RecordValidateItem[] } {
  const stepIndexes: number[] = [];
  const items: RecordValidateItem[] = [];
  (Array.isArray(recs) ? recs : []).forEach((rec, i) => {
    const loc = rec && rec.step && rec.step.locator;
    if (!loc || !loc.value) return;
    stepIndexes.push(i);
    items.push({ strategy: loc.kind, selector: loc.value });
  });
  return { stepIndexes, items };
}

/** 校验报告的一行（`<tr data-step-id>` 的数据源） */
export interface CheckRow {
  stepId: string;
  /** 数组下标（`index` 连续时等于 `step.index`） */
  stepIndex: number;
  action: UiStepAction;
  strategy: string;
  selector: string;
  /** 命中数：**必须是整数**（表格 `td[data-col="count"]` 的判据是 `/^\d+$/`） */
  count: number;
  precise: boolean;
  ms: number;
  invalid?: boolean;
  error?: string;
  /** 可作为「推荐 / 默认可落库」：唯一命中且没超时 */
  recommended: boolean;
}

/** 校验结果 + 原步骤下标 → 报告行（每个步骤一行，没有定位器的步骤也占一行） */
export function buildCheckRows(
  recs: RecordedStep[],
  results: Array<RecordValidateRow & { stepIndex: number }>,
): CheckRow[] {
  const byStep = new Map<number, RecordValidateRow & { stepIndex: number }>();
  for (const r of Array.isArray(results) ? results : []) {
    if (r && typeof r.stepIndex === 'number') byStep.set(r.stepIndex, r);
  }
  const rows: CheckRow[] = [];
  (Array.isArray(recs) ? recs : []).forEach((rec, i) => {
    const loc = rec && rec.step && rec.step.locator;
    const hit = byStep.get(i);
    const row: CheckRow = {
      stepId: String((rec && rec.step && rec.step.id) || ''),
      stepIndex: i,
      action: (rec && rec.step && rec.step.action) || 'click',
      strategy: hit ? String(hit.strategy || '') : loc ? loc.kind : '',
      selector: hit ? String(hit.selector || '') : loc ? loc.value : '',
      // 没有命中结果时给 0：`td[data-col="count"]` 的判据是整数，写 `—` 会被判「命中数列非整数」
      count: hit && Number.isFinite(hit.count) ? Math.max(0, Math.floor(hit.count)) : 0,
      precise: !!(hit && hit.precise),
      ms: hit && Number.isFinite(hit.ms) ? Math.max(0, Math.floor(hit.ms)) : 0,
      recommended: false,
    };
    if (!hit) {
      row.invalid = true;
      row.error = loc ? '未参与校验' : '无唯一命中的定位器';
    } else {
      if (hit.invalid === true) row.invalid = true;
      if (typeof hit.error === 'string' && hit.error) row.error = hit.error;
    }
    row.recommended = !row.invalid && row.count === 1 && row.precise;
    rows.push(row);
  });
  return rows;
}

/** 报告的四种结论（`04-视觉方向.md` §1.4；灰度可辨靠「符号 + 文案」，不只靠颜色） */
export interface CheckConclusion {
  /** `.dev-tag` 的修饰类（复用现成五个，零新增选择器） */
  tone: 'is-ok' | 'is-heur' | 'is-fail' | 'is-unknown';
  /** 符号（`aria-hidden`，与文案一起构成三重编码） */
  mark: string;
  text: string;
}

/**
 * 行 → 结论。**判定顺序写死**（顺序错了会把「命中 0」判成「近似」）：
 * 超时 → 命中 0 → 多命中 → 唯一命中 → 其余按近似。
 */
export function conclusionOf(row: CheckRow): CheckConclusion {
  if (row.invalid) return { tone: 'is-unknown', mark: '~', text: row.error || '校验未完成，不参与通过' };
  if (row.count === 0) return { tone: 'is-fail', mark: '✗', text: '命中 0（不可落库）' };
  if (row.count > 1) return { tone: 'is-heur', mark: '⚠', text: `命中 ${row.count} 个（不唯一）` };
  if (row.count === 1 && row.precise) return { tone: 'is-ok', mark: '✓', text: '唯一命中' };
  return { tone: 'is-unknown', mark: '~', text: '近似，不参与通过' };
}

/**
 * 保存到元素库时**该写哪些行**——AC-3 的两个方向就是这条函数的两个 mode。
 *
 * - `'unique'`（默认按钮 `[data-act="record-save"]`）：只写唯一命中的行。
 *   `count=0` / `count>1` / 超时一律不写 —— 把 0 命中的定位器写进元素库，
 *   等于让后面三份产物带着一条一定失败的定位器出去。
 * - `'all'`（「仍要保存」`[data-act="record-save-anyway"]`，二次确认后才走）：
 *   除了「超时/没定位器」这种**根本没法用**的行，其余全写。
 */
export function elementsToSave(rows: CheckRow[], mode: 'unique' | 'all'): CheckRow[] {
  const list = Array.isArray(rows) ? rows : [];
  if (mode === 'unique') return list.filter((r) => r.recommended);
  return list.filter((r) => !r.invalid && !!r.strategy && !!r.selector);
}

/** 报告汇总（落库写进 `UiRecording.check`；`approx` = 存在不精确行） */
export function checkSummaryOf(rows: CheckRow[], at: string): UiRecordingCheck {
  const list = Array.isArray(rows) ? rows : [];
  let passed = 0;
  let failed = 0;
  let approx = false;
  for (const r of list) {
    const c = conclusionOf(r);
    if (c.tone === 'is-ok') passed += 1;
    else if (c.tone === 'is-fail') failed += 1;
    else approx = true;
  }
  return { at, total: list.length, passed, failed, approx };
}

/**
 * 一份录制的展示名：`host · HH:MM`（没有 host 就退回「未命名录制」）。
 * 名字必须 1–80 字符（契约 §9.1），这里截断到 60 给后面的序号留位置。
 */
export function recordingNameOf(baseUrl: string, at: string): string {
  let host = '';
  try {
    host = new URL(baseUrl).host;
  } catch { host = ''; }
  const hhmm = at.slice(11, 16);
  const name = host ? `${host} · ${hhmm}` : `未命名录制 · ${hhmm}`;
  return name.slice(0, 60);
}
