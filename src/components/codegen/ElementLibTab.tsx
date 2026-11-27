/**
 * 页签②：元素库 → Playwright POM
 *
 * pomPages 集合的增删改查 + 生成 Page Object；元素表本身在 ElementTable.tsx。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { useState, useEffect, useMemo } from 'react';
import { Page, Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import { useCollection } from '../../hooks/useCollection';
import { generatePageObject } from '../../utils/codegen/pageobject';
import type { GeneratedFile } from '../../utils/codegen/escape';
import { ElementTable } from './ElementTable';
import type { ElementMeta } from './ElementTable';
import { saveJavaFile, GeneratedFilesView } from './GeneratedFiles';
import { blankPage, blankElement, cleanPageForWrite, validatePage, trimPagesForWrite, normalizePageKinds, MAX_PAGES, MAX_ELEMENTS, EL_WORK_DIR_KEY } from './pomModel';
import type { PomWritePlan } from './pomModel';
import type { PomPage, PomElementRow } from './pomModel';
// 1.37.0（S3）：▶ 校验面板（CDP 点验）。**与「试跑」是两件事**，互不替代（[A2-14]）：
// 试跑 = 子进程 + Playwright（验「Playwright 认不认」）；点验 = 本机浏览器 + CDP（验「现在指到谁」）。
import { HitTestPanel } from './HitTestPanel';
// 1.36.0（B6 / 裁定 Z2）：引用守卫已从录制器模型（`record/recorderModel`，B7 整块删除）搬到
// `utils/codegen/elementUsage` —— 这三个纯函数还要继续守着元素库（老库里仍存 uiRecordings）。
import { elementUsage, canDeleteElement, scanElementRefs } from '../../utils/codegen/elementUsage';
import type { ElementUsage, UiRecording } from '../../utils/codegen/elementUsage';
import { PasteImportDialog } from './PasteImportDialog';
// 1.36.0（B8）：试跑结果的行类型（主进程 t20 已定稿，渲染层只消费）
import type { ElTrialInputItem, ElTrialItem } from '../../types';
import { copyPlain } from '../../utils/clipboard';

/* ================================================================
   引用完整性闸门（RA3-01 / `[C-110]`「有人在用不许删」）
   ================================================================ */

/**
 * 「谁在用」的人话描述：**条数 + 具体步骤**。
 *
 * 为什么不直接用 `canDeleteElement()` 返回的 `message`：那句只有录制名与引用数，
 * 没有「第几步」——而用户要改的是具体那一步，只说「有人在用」等于让他自己去翻录制。
 * 所以这里用同一次调用的 `used`（`ElementUsage[]`，带 `stepIndex`）拼出更可执行的文案。
 */
function describeUsage(used: ElementUsage[]): string {
  const recIds: string[] = [];
  for (const u of used) if (recIds.indexOf(u.recordingId) < 0) recIds.push(u.recordingId);
  const head = used.slice(0, 3).map((u) => `${u.recordingName} 第 ${u.stepIndex + 1} 步`).join('、');
  return `被 ${recIds.length} 条录制的 ${used.length} 个步骤引用（${head}${used.length > 3 ? ' 等' : ''}）`;
}

/** 拦截横幅的数据（不弹窗：用户需要边看清单边去改录制，弹窗一关就忘了） */
interface RefBlock {
  kind: 'element' | 'page';
  title: string;
  /** 每条 = 一个引用点（`元素名：录制名 第 N 步`） */
  lines: string[];
}

/* ================================================================
   「来源 / 上次校验」两列（**派生只读**，不写回 pomPages）
   ================================================================ */

/** `2026-11-26T10:02:00.000Z` → `11-26 10:02`（本地时间；只用于展示，不参与判据） */
function shortAt(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/**
 * 从 `uiRecordings` 派生元素的两列数据。
 *
 * **为什么不给元素加 `source` / `lastCheck` 字段**（裁定 A，队长已确认）：
 * 1. `cleanPageForWrite()` 是字段白名单——加字段就得同时改白名单，等于把 S1 刚修掉的
 *    「存一次页面字段被洗」重新开一个口子；
 * 2. 即便加了字段，写入方是录制页的 `saveToLibrary`（S4b，本片不改），新字段在落库时永远是
 *    `undefined` —— 两列恒空比没有更糟；
 * 3. 来源与校验时刻本来就**已经存在**：`UiStep.elementId` 指向元素，`UiRecording.check` 记着
 *    那次元素级校验。派生出来的值可追溯到具体录制与步骤，比影子字段更可信。
 *
 * 扫描**复用** `recorderModel.elementUsage()`（只读、唯一实现），不在这里另写一遍；
 * 且只按 `recordings` 的引用做一次 memo：`ElementLibTab` 会随每次按键重渲染，
 * 每次渲染全扫 20 份 × 300 步会把编辑手感拖垮。
 */
function buildMetaOf(recordings: UiRecording[], elements: PomElementRow[]): (el: PomElementRow) => ElementMeta {
  const byId = new Map<string, UiRecording>();
  for (const rec of recordings) byId.set(rec.id, rec);

  // 一次收集「哪些元素 id 被引用过」，再对每个 id 调一次 elementUsage（而不是 per-render 全扫）
  const used = new Map<string, ReturnType<typeof elementUsage>>();
  for (const rec of recordings) {
    const steps = Array.isArray(rec.steps) ? rec.steps : [];
    for (const step of steps) {
      const id = step && step.elementId;
      if (!id || used.has(id)) continue;
      used.set(id, elementUsage(recordings, id));
    }
  }

  const cache = new Map<string, ElementMeta>();
  return (el: PomElementRow): ElementMeta => {
    const id = String(el.id || '');
    if (!id) {
      // 历史元素没有 id：读端容错（`[C-110]`），谈不上被录制引用
      return { source: '手工添加', lastCheck: '未校验', sourceTitle: '这条元素没有 id（v1.34.0 及以前落库），不会被录制引用' };
    }
    const hit = cache.get(id);
    if (hit) return hit;

    const usages = used.get(id) || [];
    if (usages.length === 0) {
      const meta: ElementMeta = {
        source: '手工添加',
        lastCheck: '未校验',
        sourceTitle: '没有任何录制引用这条元素',
        lastCheckTitle: '没有被录制引用过，也就没有元素级校验记录',
      };
      cache.set(id, meta);
      return meta;
    }

    const labels: string[] = [];
    let bestAt = '';
    let total = 0;
    let passed = 0;
    for (const u of usages) {
      const label = `${u.recordingName} 第 ${u.stepIndex + 1} 步`;
      if (labels.indexOf(label) < 0) labels.push(label);
      const rec = byId.get(u.recordingId);
      const check = rec && rec.check;
      if (check && check.at && (!bestAt || check.at > bestAt)) {
        bestAt = check.at;
        total = check.total;
        passed = check.passed;
      }
    }

    const meta: ElementMeta = {
      source: labels.length === 1 ? labels[0] : `${labels[0]} 等 ${labels.length} 处`,
      sourceTitle: labels.join('\n'),
      lastCheck: bestAt ? `${shortAt(bestAt)} · 唯一命中 ${passed}/${total}` : '未校验',
      lastCheckTitle: bestAt
        ? `引用它的录制最近一次元素级校验：${checkSummaryText(passed, total)}`
        : '引用它的录制还没有出过校验报告',
    };
    cache.set(id, meta);
    return meta;
  };
}

function checkSummaryText(passed: number, total: number): string {
  return `唯一命中 ${passed} 条 / 共 ${total} 条（应用内只校验当页命中数，不等于 CI 通过）`;
}

/* ================================================================
   试跑（1.36.0 / B8）：`el:trial-run` 的四种状态
   ================================================================ */

/** 2026-11-28T02:03:04.000Z → 11-28 02:03（试跑结果面板的时间戳） */
function fmtTrialTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

// 工作目录的键定义在 pomModel（设置页也要读写它，见那里的注释：避免设置页把整个 codegen
// 组件树拉进自己的 chunk）；这里 re-export，保持既有 import 路径（含单测）可用。
export { EL_WORK_DIR_KEY };

export interface TrialState {
  /** `hit1` 命中 1 ／ `miss` 未命中 ／ `multi` 命中多个 ／ `skip` 未执行 ／ `fail` 可操作性检查失败 */
  key: 'hit1' | 'miss' | 'multi' | 'skip' | 'fail';
  label: string;
  detail: string;
  /** `.dev-tag` 的语义类（is-ok / is-error / is-warn / is-unknown） */
  cls: string;
}

/**
 * 这一条**是否真的验过了**（决定要不要回填 `hitCount / checkedAt`）。
 *
 * 判据来自主进程（`electron/element-args.js`，本文件只消费）：
 * - 每条结果默认 `trial: 'skip'`；`count() > 0` 才会去 `click({trial:true})`，成功 → `ok`，抛错 → `fail`；
 * - 解析不了的白名单链（变量 / filter({has}) / 未知方法）**带 `skipReason`** → `skip` + `error`；
 * - `items` 段超预算 → `skip` + `error: 'items 段超时，未执行'`；
 * - **`count() === 0` 时 `trial` 停在 `skip` 但 `error` 为空** —— 这才是「选择器未命中」。
 *
 * 所以「skip + 有 error」= 未执行（不许写命中数），「skip + 无 error + hit=0」= 真的未命中（要写 0）。
 */
export function trialSettled(item: ElTrialItem): boolean {
  if (item.trial === 'ok' || item.trial === 'fail') return true;
  return item.hit === 0 && !item.error;
}

/**
 * 把主进程的一条结果翻译成界面状态（纯函数，单测锁）。
 *
 * **三件「不是 0 命中」的事必须分得开**（`types.ts` 的 ElTrialItem 注释第 2 条 + `element-args.js` 的
 * `rowOf` 默认值）：
 * 1. `hit === 0` **且没有 `error`** → 选择器未命中（红）——页面上真的没有这个元素；
 * 2. `trial === 'skip'` **且带 `error`** → **未执行**（灰）：pw 链里有变量插值 / `filter({has})` /
 *    未知方法，或 items 段超时，白名单解析不了就不硬跑。**绝不能显示成 0 命中**
 *    （那是把「没验」说成「验了没中」）；
 * 3. `loginRequired` → 需要登录（黄），此时根本不该有结果行（见页面级横幅）。
 */
export function trialStateOf(item: ElTrialItem): TrialState {
  if (!trialSettled(item)) {
    return {
      key: 'skip',
      label: '未执行',
      detail: item.error || '这条定位器无法在应用内试跑（变量插值 / filter({has}) / 未知方法），请在 Playwright 里手验',
      cls: 'is-unknown',
    };
  }
  if (item.hit === 0) {
    return {
      key: 'miss',
      label: '选择器未命中',
      detail: item.error || '页面上没有匹配元素：检查定位器，或确认页面已经加载到目标状态',
      cls: 'is-error',
    };
  }
  if (item.hit > 1) {
    return {
      key: 'multi',
      label: `命中 ${item.hit} 个，请细化`,
      detail: item.error || '一次命中多个元素：生成物里的取第一个是巧合，缩小范围（加 filter / 更具体的 css）',
      cls: 'is-warn',
    };
  }
  return {
    key: item.trial === 'fail' ? 'fail' : 'hit1',
    label: '命中 1',
    detail: item.trial === 'fail'
      ? (item.error || '命中了，但可操作性检查没过（可能被遮挡 / 不可见 / 只读）')
      : `可见 ${item.visible ? '是' : '否'} · 可操作性检查 ${item.trial === 'ok' ? '通过' : '未做'}`,
    cls: item.trial === 'fail' ? 'is-warn' : 'is-ok',
  };
}

/* ================================================================
   页签②：元素库 → POM
   ================================================================ */

export function ElementLibTab({
  addToast,
  ask,
}: {
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void;
  ask: (opts: { title: string; message?: string; confirmText?: string; onOk: () => void }) => void;
}) {
  const { items, save, loading } = useCollection<PomPage>('pomPages');
  /**
   * 录制集合：**只读**，只用于「来源 / 上次校验」两列的派生（不参与 `pomPages` 的写入路径）。
   * 没解锁 / 读失败时退回空数组：两列显示「手工添加 / 未校验」，不影响元素库本身。
   */
  const { items: recordings } = useCollection<UiRecording>('uiRecordings');
  const [activeId, setActiveId] = useState('');
  const [draft, setDraft] = useState<PomPage | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [genErr, setGenErr] = useState('');
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});
  /** 上限裁剪提示（[C-25]：不许静默丢） */
  const [trimWarn, setTrimWarn] = useState('');
  /** 删除元素/删页面被引用拦下时的清单（不弹窗，见 `RefBlock`） */
  const [refBlock, setRefBlock] = useState<RefBlock | null>(null);
  /** 1.36.0（B6）：粘贴导入弹窗 */
  const [pasteOpen, setPasteOpen] = useState(false);
  /** 1.36.0（B8）：试跑（`el:trial-run`）—— 结果与忙碌态 */
  const [trialBusy, setTrialBusy] = useState(false);
  const [trial, setTrial] = useState<{
    at: string;
    /** 与「参与试跑的元素」一一对应的结果（顺序一致，空 = 需要登录 / 依赖缺失） */
    results: { item: ElTrialItem; el: PomElementRow }[];
    loginRequired: boolean;
    message: string;
    truncated: boolean;
  } | null>(null);
  /** 裁剪结果统一处理：横幅常显 + toast 一次，两处写入共用 */
  const noteTrim = (plan: PomWritePlan) => {
    if (!plan.dropped) return;
    setTrimWarn(plan.notice);
    addToast(plan.notice, 'info');
  };

  /**
   * 首次读完库后自动选中第一条。
   *
   * 判据是「**还没有草稿**」，不是「activeId 不在 items 里」——后者会把刚点「新建页面」
   * 得到的那份未保存草稿当成「已被删除」再清空（新建时 items 里当然没有它），
   * 表现是点了新建什么都不出来。删除页面的清理在 removePage 里显式做。
   */
  useEffect(() => {
    if (loading || draft) return;
    const first = items[0];
    if (!first) return;
    setActiveId(first.id);
    // 1.37.0（S3 / [A0-3] ②）：读库投影先归一 kind —— 老记录缺 kind 时下拉显示 `css` 且可保存，
    // 不归一的话 `<select value={undefined}>` 匹配不到任何 option，界面看起来像「类型丢了」。
    setDraft(normalizePageKinds({ ...first, elements: first.elements.map((e) => ({ ...e })) }));
  }, [loading, items, draft]);

  const select = (p: PomPage) => {
    setActiveId(p.id);
    setDraft(normalizePageKinds({ ...p, elements: p.elements.map((e) => ({ ...e })) }));
    setErr('');
    setFiles([]);
    setGenErr('');
  };

  const createPage = () => {
    if (items.length >= MAX_PAGES) {
      addToast(`最多 ${MAX_PAGES} 个页面，先删几个再建`, 'error');
      return;
    }
    const p = blankPage();
    setActiveId(p.id);
    setDraft(p);
    setErr('');
    setFiles([]);
  };

  const patchDraft = (patch: Partial<PomPage>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  /**
   * 两列的派生数据。**memo 只跟 `recordings` 走**（不含 `draft`）：
   * `buildMetaOf` 返回的是「按元素 id 查表」的闭包，元素表每敲一个字都重渲染也不重扫。
   */
  const metaOf = useMemo(() => buildMetaOf(recordings, draft ? draft.elements : []), [recordings, draft]);

  const patchElement = (index: number, patch: Partial<PomElementRow>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const elements = prev.elements.map((el, i) => (i === index ? { ...el, ...patch } : el));
      return { ...prev, elements };
    });
  };

  /**
   * 1.36.0（B8）：试跑（`el:trial-run`）—— **本批唯一的写入方**，也是 `hitCount/checkedAt`
   * 这两个字段存在的全部理由（裁定 Z10：没有写入方的字段不加）。
   *
   * 四条硬约束（对应裁定 §十二）：
   * 1. 工作目录从 **localStorage** 取（`EL_WORK_DIR_KEY`），不进 vault；没选目录就明说，不静默失败；
   * 2. 只把「能跑」的元素发下去（≤ 20 条，与主进程上限一致），`kind=role` 带 `roleName`；
   * 3. `loginRequired` 时**不写任何 hitCount**（页面根本没打开，写 0 就是把「没验」说成「没中」）；
   * 4. `trial === 'skip'` 时同样不写 hitCount —— 只在**真跑过**（ok / fail）时才回填。
   */
  const runTrial = async () => {
    if (!draft) return;
    const active = draft.elements;
    if (!active.length) {
      addToast('这个页面还没有元素，先加元素再试跑', 'error');
      return;
    }
    let dir = '';
    try { dir = localStorage.getItem(EL_WORK_DIR_KEY) || ''; } catch { dir = ''; }
    if (!dir) {
      setTrial({ at: new Date().toISOString(), results: [], loginRequired: false, truncated: false,
        message: '还没选 Playwright 工作目录：去「设置 → 数据与备份 → Playwright 工作目录」选一个，再回来点试跑' });
      addToast('还没选 Playwright 工作目录（设置 → 数据与备份）', 'error');
      return;
    }
    if (!draft.baseUrl) {
      addToast('这个页面还没填「页面地址（baseUrl）」，试跑不知道打开哪个页面', 'error');
      return;
    }
    const picked = active.slice(0, 20);
    const items: ElTrialInputItem[] = picked.map((el) => ({
      kind: el.kind,
      locator: el.locator,
      // t26（AR-4 组件侧的第三处，与 HitTestPanel / 生成器同口径 `String(x).trim()`）：
      // 这里原来写 `String(el.role || '')` —— 用户在元素表里敲 ` 提交 ` 时，
      // 试跑会把带空格的可访问名发下去，Playwright 的 `getByRole(name)` 是全等匹配 → 必然 0 命中，
      // 而界面报「选择器未命中」（[A0-6] 那类最难排查的假红）。三处必须同一个口径。
      ...(el.kind === 'role' ? { roleName: String(el.role ?? '').trim() } : {}),
      ...(el.name ? { name: el.name } : {}),
    }));
    setTrialBusy(true);
    try {
      const r = await window.electronAPI.elTrialRun({
        dir, url: draft.baseUrl, items, withStyle: false,
      });
      const now = new Date().toISOString();
      if (!r.success || !r.data) {
        // 依赖缺失 / 参数被拦：主进程给的是固定文案，原样显示（不改写成「未命中」）
        setTrial({ at: now, results: [], loginRequired: false, truncated: false,
          message: r.error || '试跑失败：主进程没有返回结果' });
        addToast(r.error || '试跑失败', 'error');
        return;
      }
      const data = r.data;
      const rows = data.results.map((item, i) => ({ item, el: picked[i] })).filter((x) => !!x.el);
      setTrial({
        at: now,
        results: rows,
        loginRequired: !!data.loginRequired,
        truncated: !!data.truncated,
        message: data.message || '',
      });
      // 回填：只给「真跑过」的元素写字段（skip / loginRequired 一律不写）
      if (!data.loginRequired) {
        setDraft((prev) => {
          if (!prev) return prev;
          const byId = new Map<string, ElTrialItem>();
          rows.forEach((row) => { if (row.el?.id) byId.set(String(row.el.id), row.item); });
          const elements = prev.elements.map((el) => {
            const item = byId.get(String(el.id));
            // 只回填「真的验过」的（未执行 / 需要登录一律不写，否则就是把「没验」说成「没中」）
            if (!item || !trialSettled(item)) return el;
            return { ...el, hitCount: item.hit, checkedAt: now };
          });
          return { ...prev, elements };
        });
      }
      if (data.loginRequired) {
        addToast('页面需要登录：在弹出的窗口里登录后点「重试」', 'info');
      } else if (data.truncated) {
        addToast('试跑到预算上限提前结束：已完成的部分照回，剩下的请再试一次', 'info');
      } else {
        addToast(`试跑完成：${rows.length} 条，用时 ${data.ms} ms`, 'success');
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTrial({ at: new Date().toISOString(), results: [], loginRequired: false, truncated: false,
        message: `试跑调用失败：${msg}` });
      addToast(`试跑调用失败：${msg}`, 'error');
    } finally {
      setTrialBusy(false);
    }
  };

  const addElement = () => {    if (!draft) return;
    if (draft.elements.length >= MAX_ELEMENTS) {
      addToast(`单个页面最多 ${MAX_ELEMENTS} 个元素`, 'error');
      return;
    }
    // [C-110]：新建元素时就把 id 定下来（写端必填），不要等保存才生成 —— 否则同一次编辑
    // 在不同保存轮次会拿到不同 id，引用它的录制步骤（UiStep.elementId）就漂了。
    patchDraft({ elements: [...draft.elements, blankElement()] });
  };

  const removeElement = (index: number) => {
    if (!draft) return;
    const el = draft.elements[index];
    if (!el) return;
    const id = String(el.id || '');
    /**
     * 删元素前先查引用（`canDeleteElement(recordings, elementId)`，注意参数顺序是**录制在前**）。
     *
     * 没引用 → 照旧直接删（**不能一律拒绝**：那样用户永远删不掉元素，是另一种坏）。
     * 有引用 → 不删、不弹确认，直接把「谁在用」列出来。
     */
    const gate = canDeleteElement(recordings, id);
    if (!gate.ok) {
      setRefBlock({
        kind: 'element',
        title: `不能删除「${el.name || '未命名元素'}」：它还在被引用`,
        lines: gate.used.map((u) => `${el.name || '未命名元素'}：${u.recordingName} 第 ${u.stepIndex + 1} 步`),
      });
      addToast(`不能删除「${el.name || '未命名元素'}」：${describeUsage(gate.used)}；删掉会让这些步骤指不到元素`, 'error');
      return;
    }
    setRefBlock(null);
    patchDraft({ elements: draft.elements.filter((_, i) => i !== index) });
  };

  /**
   * 1.36.0（B6）：把粘贴导入的行写进当前页面。
   *
   * **唯一写入路径**（渲染层契约 §6.2）：合并草稿 → `validatePage` → `cleanPageForWrite`
   * （字段白名单，透传 id / source）→ `trimPagesForWrite`（上限裁剪，钉住刚保存的这条）→ `save`
   * （就是 `useCollection('pomPages')` 那一条 `ws:set`）。**不新开写库通道、不新增 IPC**。
   */
  const importPasted = async (rows: PomElementRow[]) => {
    if (!draft || !rows.length) return; // 认不出/没勾 → 一条都不写
    const merged: PomPage = {
      ...draft,
      elements: [...draft.elements, ...rows].slice(0, MAX_ELEMENTS),
    };
    const message = validatePage(merged, items);
    if (message) {
      setErr(message);
      addToast(message, 'error');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const clean = cleanPageForWrite(merged);
      const exists = items.some((p) => p.id === clean.id);
      const next = exists ? items.map((p) => (p.id === clean.id ? clean : p)) : [clean, ...items];
      const plan = trimPagesForWrite(next, clean.id);
      const r = await save(plan.items);
      noteTrim(plan);
      if (!r.success) {
        setErr(r.error || '导入失败');
        addToast(r.error || '导入失败', 'error');
        return;
      }
      setDraft(clean);
      setActiveId(clean.id);
      addToast(`已导入 ${rows.length} 条元素（还要点「保存页面」才会写进加密库）`, 'success');
    } finally {
      setBusy(false);
    }
  };

  const savePage = async () => {
    if (!draft) return;
    const message = validatePage(draft, items);
    if (message) {
      setErr(message);
      addToast(message, 'error');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      // [C-110] ②：归一化（含**白名单透传元素 id**）提在 pomModel 里，单测锁「保存一次后 id 不变」。
      // 原先这段就地按 name/locator/kind/role/note 重建元素对象，会把迁移回填的 id 洗白。
      const clean: PomPage = cleanPageForWrite(draft);
      const exists = items.some((p) => p.id === clean.id);
      const next = exists ? items.map((p) => (p.id === clean.id ? clean : p)) : [clean, ...items];
      // [C-24]/[C-25]：ws:set 之前按上限裁剪；keepId=刚保存的这条，保证它不会被当"最旧"清掉
      const plan = trimPagesForWrite(next, clean.id);
      const r = await save(plan.items);
      noteTrim(plan);
      if (!r.success) {
        setErr(r.error || '保存失败');
        addToast(r.error || '保存失败', 'error');
        return;
      }
      setDraft(clean);
      setActiveId(clean.id);
      addToast(exists ? '页面已更新' : '页面已保存到加密库', 'success');
    } finally {
      setBusy(false);
    }
  };

  /**
   * 删整页前批量查引用（这页最多 200 个元素，逐个问 `canDeleteElement` 既慢又散）。
   *
   * ⚠️ **不能写成 `scanElementRefs(recordings, [p])`**：那等于把 `[p]` 当「现存全部页面」，
   * 返回的是「引用了**不在** p 里的元素」的步骤 —— 语义正好反过来（除了这页以外的引用全算悬空）。
   * 正确做法是扫**删除后的页面集合**，再收敛到本页的元素 id 上：这样得到的就是
   * 「删了这页会断哪些引用」，而且真的复用了 `scanElementRefs`（不是又一段死代码）。
   */
  const removePage = (p: PomPage) => {
    const memberIds = new Set<string>();
    for (const el of p.elements) {
      const id = String(el.id || '');
      if (id) memberIds.add(id);
    }
    const after = items.filter((x) => x.id !== p.id);
    const hit = scanElementRefs(recordings, after).dangling.filter((d) => memberIds.has(d.elementId));

    if (hit.length) {
      const nameOf = (elementId: string) => {
        const el = p.elements.find((x) => String(x.id || '') === elementId);
        return el ? (el.name || el.locator || elementId) : elementId;
      };
      const recNameOf = (recordingId: string) => {
        const rec = recordings.find((r) => r.id === recordingId);
        return rec ? (rec.name || rec.id) : recordingId;
      };
      const recIds: string[] = [];
      for (const d of hit) if (recIds.indexOf(d.recordingId) < 0) recIds.push(d.recordingId);

      setRefBlock({
        kind: 'page',
        title: `不能删除页面「${p.name || '未命名页面'}」：${hit.length} 个步骤还在引用这页的元素`,
        lines: hit.map((d) => `${nameOf(d.elementId)}：${recNameOf(d.recordingId)} 第 ${d.stepIndex + 1} 步`),
      });
      addToast(
        `不能删除页面「${p.name || '未命名页面'}」：${hit.length} 个步骤、${recIds.length} 条录制仍在引用`
        + `（涉及 ${Array.from(new Set(hit.map((d) => nameOf(d.elementId)))).join('、')}）`,
        'error',
      );
      return;
    }

    setRefBlock(null);
    ask({
      title: '删除元素库页面',
      message: `确定删除「${p.name || '未命名页面'}」？只删这份元素表，不影响已生成的 Java 文件。`,
      confirmText: '删除',
      onOk: () => {
        void (async () => {
          const plan = trimPagesForWrite(items.filter((x) => x.id !== p.id));
          const r = await save(plan.items);
          noteTrim(plan);
          if (!r.success) {
            addToast(r.error || '删除失败', 'error');
            return;
          }
          if (activeId === p.id) {
            setDraft(null);
            setActiveId('');
          }
          addToast('已删除', 'success');
        })();
      },
    });
  };

  const generate = async () => {
    if (!draft) return;
    const message = validatePage(draft, items);
    if (message) {
      setErr(message);
      addToast(message, 'error');
      return;
    }
    setBusy(true);
    setGenErr('');
    setFiles([]);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const res = generatePageObject({
        className: (draft.className || '').trim() || draft.name.trim(),
        packageName: 'pages',
        baseUrl: draft.baseUrl.trim(),
        pageName: draft.name.trim(),
        elements: draft.elements.map((el) => ({
          name: el.name.trim(),
          locator: el.locator,
          kind: el.kind,
          ...(el.kind === 'role' ? { roleName: String(el.role ?? '').trim() } : {}),
        })),
      });
      if (!res.ok) {
        setGenErr(res.error);
        return;
      }
      setFiles(res.files);
      if (res.warnings.length) addToast(`已生成，但有 ${res.warnings.length} 条告警`, 'info');
      else addToast('已生成 Page Object', 'success');
    } catch (e) {
      setGenErr('生成失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async (file: GeneratedFile, defaultName: string) => {
    await saveJavaFile(file, defaultName, addToast, setSavedAt);
  };

  return (
    <div className="split">
      {/* ---- 左：页面列表（普通列表 .dev-list*，不复用数据生成器的两行类型卡 .tdg-type） ---- */}
      <Panel
        title="页面"
        meta={loading ? '加载中…' : `${items.length}/${MAX_PAGES}`}
        flush
        tools={
          <button className="btn btn-secondary btn-sm" onClick={createPage} disabled={loading}>
            <Icons.plus size={13} /> 新建页面
          </button>
        }
      >
        <div className="dev-list">
          {loading && <div className="text-sm text-muted">正在读加密库…</div>}
          {!loading && items.length === 0 && (
            <div className="text-sm text-muted">
              还没有元素库页面。点上面「新建页面」，填页面名与地址，再加元素。
            </div>
          )}
          {!loading && items.map((p) => {
            const on = p.id === activeId;
            return (
              /* 行容器**不交互**：原来给 div 挂 role=button + tabIndex + onClick，里面再嵌删除
                 button，等于「交互控件内嵌交互控件」（ARIA 不允许，读屏用户会遇到两个焦点、
                 也分不清哪个代表"选中"）。现在行只是布局容器，选中由名称按钮承担，
                 删除键是它的**兄弟节点**；选中语义用 aria-current（不是 aria-pressed ——
                 那是"开关按下"的意思，列表选中不是这东西）。 */
              <div key={p.id} className={`dev-list-item${on ? ' is-on' : ''}`}>
                <button
                  type="button"
                  className="dev-list-name"
                  aria-current={on ? 'true' : undefined}
                  title={p.name}
                  onClick={() => select(p)}
                  /* 唯一保留的内联：只重置浏览器给 <button> 的默认外观（灰底 + 2px outset 边框 +
                     居中），排版仍由 `.dev-list-name` 负责。CSS 里没有可复用的「裸按钮」类，
                     而 src/styles/ 不在本批 inScope —— 回执「本批不做清单」里已写明补法。 */
                  style={{ background: 'none', border: 0, textAlign: 'left' }}
                >
                  {p.name || '未命名页面'}
                </button>
                <span className="dev-list-count">{p.elements.length} 个元素</span>
                <button
                  className="btn btn-ghost btn-sm dev-list-del"
                  onClick={() => removePage(p)}
                  title="删除这个页面"
                  aria-label={`删除页面 ${p.name}`}
                >
                  <Icons.trash size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* ---- 右：编辑 + 生成 ---- */}
      <div>
        {!draft
          ? (
            <Panel title="元素表">
              <Empty
                icon={<Icons.db size={22} />}
                title="左侧没有可编辑的页面"
                desc={items.length ? '选一个页面，或新建一个。' : '元素库存在加密库里，跟着库走 —— 先新建一个页面。'}
                hint="页面名 + 地址 + 元素表（name / locator / kind），保存后才写进 vault。"
              />
            </Panel>
          )
          : (
            <>
              <Panel
                title="页面基础信息"
                meta={draft.name || '未命名'}
                tools={
                  <div className="tool-inline">
                    <button className="btn btn-secondary btn-sm" onClick={() => void savePage()} disabled={busy}>
                      <Icons.check size={13} /> 保存页面
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => void generate()} disabled={busy}>
                      <Icons.tool size={13} /> 生成 POM
                    </button>
                  </div>
                }
              >
                {busy && <BusyProgress active label="处理中…" />}
                {/* [C-25]：裁剪必须让用户看见，不许静默丢；提示会一直留到下次保存 */}
                {trimWarn && (
                  <div className="dev-banner is-warn" role="status"><Icons.clock size={14} /><div className="text-sm">{trimWarn}</div></div>
                )}
                <div className="grid2">
                  <Field label="页面名" hint="页面内唯一；也是 Java 类名的种子">
                    <input
                      value={draft.name}
                      onChange={(e) => patchDraft({ name: e.target.value })}
                      placeholder="登录页"
                      maxLength={80}
                    />
                  </Field>
                  <Field label="页面地址（baseUrl）">
                    <input
                      value={draft.baseUrl}
                      onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                      placeholder="https://example.com/login"
                      maxLength={500}
                    />
                  </Field>
                  <Field label="Java 类名（可选）" hint="留空则由页面名生成；建议给英文名">
                    <input
                      value={draft.className || ''}
                      onChange={(e) => patchDraft({ className: e.target.value })}
                      placeholder="LoginPage"
                      maxLength={80}
                    />
                  </Field>
                  <Field label="备注（可选）">
                    <input
                      value={draft.note || ''}
                      onChange={(e) => patchDraft({ note: e.target.value })}
                      placeholder="这个页面是干什么的"
                      maxLength={200}
                    />
                  </Field>
                </div>

                {err && (
                  <div className="dev-banner is-error mt-8" role="alert">
                    <Icons.bug size={14} />
                    <div className="text-sm">{err}</div>
                  </div>
                )}

                <div className="tool-inline mt-16">
                  <span className="dev-tag is-unknown">
                    <Icons.list size={13} />
                    {draft.elements.length}/{MAX_ELEMENTS} 个元素
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={addElement}
                    disabled={draft.elements.length >= MAX_ELEMENTS}
                    title={draft.elements.length >= MAX_ELEMENTS ? `单个页面最多 ${MAX_ELEMENTS} 个元素` : '加一行'}
                  >
                    <Icons.plus size={13} /> 加元素
                  </button>
                  {/* 1.36.0（B6）：粘贴导入。入口只有这一个 —— 不做「选文件」，粘贴是唯一输入。 */}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setPasteOpen(true)}
                    disabled={draft.elements.length >= MAX_ELEMENTS}
                    title={
                      draft.elements.length >= MAX_ELEMENTS
                        ? `单个页面最多 ${MAX_ELEMENTS} 个元素`
                        : '从 DevTools Recorder JSON / Playwright codegen 脚本 / Elements HTML 导入元素'
                    }
                  >
                    <Icons.copy size={13} /> 粘贴导入
                  </button>
                  {/* 1.36.0（B8）：试跑。没有工作目录时按钮不隐藏 —— 点了会明确告诉你该去哪设，
                      隐藏按钮等于让用户猜「为什么没有这个能力」。 */}
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void runTrial()}
                    disabled={trialBusy || !draft.elements.length}
                    title={draft.elements.length ? '在 Playwright 里真跑一遍这些定位器（最多 20 条）' : '先加元素'}
                    data-el-trial="run"
                  >
                    <Icons.search size={13} /> {trialBusy ? '试跑中…' : '试跑'}
                  </button>
                </div>

                {/* 大表必须套 .dev-scroll：.pnl 是 overflow:hidden，不套会把右侧列裁掉 */}
                <ElementTable
                  elements={draft.elements}
                  onPatch={patchElement}
                  onRemove={removeElement}
                  metaOf={metaOf}
                />

                {/*
                  1.37.0（S3）：▶ 校验（CDP 点验）。
                  **常挂**（不是点 ▶ 才挂载）：① 用户得先看到入口才知道有这个能力；
                  ② `scripts/ui-glass-opaque-scan.js` 只扫「已经在 DOM 里」的元素，
                  跑完才出现的面板永远扫不到，等于玻璃门禁永远不覆盖它。
                  **放在元素表之后**（不是浮层/绝对定位）：浮层会压住元素表的操作列。
                */}
                <HitTestPanel
                  pageId={draft.id}
                  baseUrl={draft.baseUrl}
                  elements={draft.elements}
                  pageSaved={items.some((p) => p.id === draft.id)}
                  addToast={addToast}
                />
                {/*
                  1.36.0（B8）：试跑结果。四种状态（命中 1 / 未命中 / 命中多个 / 未执行）各占一行，
                  「未执行」与「需要登录」**不显示成 0 命中**（裁定 Z9：假命中比不显示更糟）。
                  已知限制：截图只给路径 —— 渲染层读不了 file://，不做内嵌预览（不新增 IPC）。
                */}
                {trial && (
                  <div className="el-trial mt-16" role="region" aria-label="试跑结果">
                    <div className="el-trial-head">
                      <span className="text-sm">
                        <b>试跑结果</b>
                        <span className="text-muted"> · {trial.results.length} 条 · {fmtTrialTime(trial.at)}</span>
                      </span>
                      <div className="tool-inline">
                        {trial.truncated && <span className="dev-tag is-warn"><Icons.clock size={13} /> 提前结束</span>}
                        <button className="btn btn-ghost btn-sm" onClick={() => void runTrial()} disabled={trialBusy}>
                          <Icons.tool size={13} /> {trial.loginRequired ? '重试' : '再跑一次'}
                        </button>
                      </div>
                    </div>
                    {trial.loginRequired && (
                      <div className="dev-banner is-warn" role="alert" data-trial="login">
                        <Icons.lock size={14} />
                        <div className="text-sm">
                          页面需要登录：请在弹出的窗口里登录后点「重试」。
                          <span className="text-muted">（这不是「未命中」—— 页面还没打开到能查元素的状态）</span>
                        </div>
                      </div>
                    )}
                    {!trial.loginRequired && trial.message && (
                      <div className="dev-banner is-info" role="status" data-trial="message">
                        <Icons.list size={14} />
                        <div className="text-sm">{trial.message}</div>
                      </div>
                    )}
                    {trial.results.length > 0 && (
                      <div className="dev-scroll is-short">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th scope="col" style={{ width: 160 }}>元素</th>
                              <th scope="col" style={{ width: 150 }}>结果</th>
                              <th scope="col">说明</th>
                              <th scope="col" style={{ width: 220 }}>截图</th>
                            </tr>
                          </thead>
                          <tbody>
                            {trial.results.map(({ item, el }) => {
                              const st = trialStateOf(item);
                              return (
                                <tr key={String(el.id)} data-trial-state={st.key}>
                                  <td>{el.name || '未命名元素'}</td>
                                  <td>
                                    <span className={`dev-tag ${st.cls}`}>{st.label}</span>
                                  </td>
                                  <td className="text-sm">
                                    <div>{st.detail}</div>
                                    {item.style && (
                                      <div className="text-muted">读到的样式：{item.style.color} / {item.style.background} / {item.style.fontSize}</div>
                                    )}
                                  </td>
                                  <td className="text-sm">
                                    {item.shotPath ? (
                                      <>
                                        <div className="el-shot-path" title={item.shotPath}>{item.shotPath}</div>
                                        <button
                                          className="btn btn-ghost btn-sm"
                                          onClick={async () => {
                                            await copyPlain(String(item.shotPath));
                                            addToast('截图路径已复制（用资源管理器打开即可）', 'success');
                                          }}
                                        >
                                          <Icons.copy size={12} /> 复制路径
                                        </button>
                                      </>
                                    ) : (
                                      <span className="text-muted">—</span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                    <div className="text-sm text-muted mt-8">
                      已知限制：截图只显示路径、不做内嵌预览（渲染层读不了 <code>file://</code>，为此新开通道不划算）。
                      「未执行」是没法在应用内真跑（变量插值 / filter({'{'}has{'}'}) / 未知方法），不等于 0 命中。
                    </div>
                  </div>
                )}
                {/* 引用完整性拦截横幅（RA3-01）：列出「谁在用」，并指出下一步该去哪改 */}
                {refBlock ? (
                  <div className="dev-banner is-error mt-8" data-ref-block={refBlock.kind} role="alert">
                    <Icons.bug size={14} />
                    <div className="text-sm">
                      <div><b>{refBlock.title}</b></div>
                      {/* 内联只重置 <ul> 的默认缩进：src/styles/** 不在本片 inScope，无现成可复用类（同 :360 的先例） */}
                      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                        {refBlock.lines.slice(0, 8).map((line) => <li key={line}>{line}</li>)}
                        {refBlock.lines.length > 8 ? <li>…等 {refBlock.lines.length} 处</li> : null}
                      </ul>
                      <div className="text-muted">
                        要删，请先去「录制器」把这些步骤删掉或改指向别的元素，再回来删；
                        直接删会让录制步骤指不到元素（`[C-110]`）。
                      </div>
                    </div>
                    <span className="dev-banner-act">
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRefBlock(null)}>
                        知道了
                      </button>
                    </span>
                  </div>
                ) : null}
                <div className="text-sm text-muted mt-8">
                  「来源 / 上次校验」两列由**录制记录派生**（只读，不写回元素库）：
                  来源 = 引用这条元素的录制与步骤，上次校验 = 该录制最近一次元素级校验的汇总。
                  应用内通过 ≠ CI 通过。
                </div>

                {genErr && (
                  <div className="dev-banner is-error mt-8" role="alert">
                    <Icons.bug size={14} />
                    <div className="text-sm">{genErr}</div>
                  </div>
                )}
              </Panel>

              {files.length > 0 && (
                <Panel title="生成的 Page Object" meta={`${files.length} 个文件`}>
                  <div className="dev-banner is-info">
                    <Icons.check size={14} />
                    <div className="text-sm">
                      生成只到预览为止，保存要你自己点（会弹系统保存框）。元素定位器里的引号 / 反斜杠已按 Java 规则转义。
                    </div>
                  </div>
                  <GeneratedFilesView
                    files={files}
                    defaultSaveName={`${(draft.className || draft.name || 'Page').trim()}.java`}
                    onSave={(f, n) => void saveFile(f, n)}
                  />
                  {Object.keys(savedAt).length > 0 && (
                    <div className="text-sm text-muted mt-8">
                      已保存：{Object.entries(savedAt).map(([p, abs]) => `${p.split('/').pop()} → ${abs}`).join('；')}
                    </div>
                  )}
                </Panel>
              )}
            </>
          )}
      </div>
      {/* 粘贴导入弹窗：只在有草稿时可开；写入走 importPasted → 唯一那条 ws:set */}
      <PasteImportDialog
        open={pasteOpen && !!draft}
        onClose={() => setPasteOpen(false)}
        onImport={(rows) => { void importPasted(rows); }}
        existing={draft ? draft.elements : []}
        remaining={draft ? MAX_ELEMENTS - draft.elements.length : 0}
      />
    </div>
  );
}