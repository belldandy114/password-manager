/**
 * UI 录制器（S4b：会话面 → 能点的一页）。
 *
 * **本页只做四件事**：录（接 `record:start`/`record:stop`）、看（候选与命中数）、验（`record:validate`）、
 * 落（`uiRecordings` + `pomPages` 两向）。产物三选归 S6、能力灯归 S5、录制后端归 S3。
 *
 * 五条写死的口径（都能被机械判定）：
 *
 * 1. **三种状态共用一个根节点** `.pg.rec-page`（AC-15 的几何断言按这个选择器取数）：
 *    空态 / 录制中 / 校验报告，靠「有没有草稿、有没有报告」切换，不新造页签容器。
 * 2. **两个 tabpanel 始终在 DOM 里**（非激活的那个 `hidden`）：AC-1 在**停止之后**才读
 *    `.rec-cand[data-recommended="true"]`，如果候选面板随页签卸载，那条断言会读成 0 条
 *    ——「0 条推荐」在 AC-1 里是**判失败**（空真），不能让卸载制造这个假绿。
 * 3. **先校验、后停止**：`record:validate` 在会话结束后一律回「会话已结束」，所以「停止并校验」
 *    的顺序是 validate → stop；报告在 stop resolve 之前就已渲染，天然满足 AC-2 的
 *    「`record:stop` resolve 后 3000 ms 内出现报告」。
 * 4. **事件订阅只有一处**（`App.tsx`），本页只读 store 里的草稿：页面上订阅会在
 *    「切页 → 回来」时留下第二条通道，事件翻倍。
 * 5. **两个落库入口语义相反**（AC-3 的两个方向）：`record-save` 只写唯一命中，
 *    `record-save-anyway` 才带命中 0 / 多命中，且必须二次确认。
 *
 * 视觉：类名全部照 `04-视觉方向.md` §9.2 的映射表（`.pg` / `.toolbar` / `.rec-row` / `.tabs` /
 * `.tab2` / `.pnl` / `.split` / `.dev-list` / `.dev-banner` / `.dev-scroll` / `.tbl` / `.dev-tag`），
 * **零新增样式、零色值字面量**、不用 `<datalist>`、不拼 `/json/list` 或 `ws://`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { PageHead, Panel, Empty, Icons } from '../components/ui';
import { ToastContainer } from '../components/Toast';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { AbilityBar, recordBlocked } from '../components/recorder/AbilityBar';
import { ArtifactPicker } from '../components/recorder/ArtifactPicker';
import { CandidateCard } from '../components/recorder/CandidateCard';
import { CheckReport } from '../components/recorder/CheckReport';
import { SessionBanner } from '../components/recorder/SessionBanner';
import { useToast } from '../hooks/useToast';
import { useStore } from '../store/useStore';
import type { RecorderDraft } from '../store/useStore';
import {
  buildCheckRows,
  checkSummaryOf,
  elementsToSave,
  pickRecommended,
  planRecordingSave,
  recordingNameOf,
  toRecording,
  validateItemsOf,
  type CheckRow,
  type UiRecording,
} from '../utils/record/recorderModel';
import { capsOf, trimToCaps } from '../utils/collectionTrim';
import { callIpc } from '../utils/ipc';
import { newId } from '../utils/id';
import type { PomElementRow, PomPage } from '../components/codegen/pomModel';
import type { PomLocatorKind } from '../utils/codegen/pageobject';
import type { RecordAbility, RecordValidateRow } from '../types';

/* ================================================================
   能力灯与产物：两个组件都不在本页产出，本页只负责**挂载**与传参
   ================================================================ */

/**
 * 能力灯面板 `src/components/recorder/AbilityBar.tsx`（S5 交付）。
 *
 * 它自己的 `AbilityBarProps` 就是契约真源（`{ abilities, probedAt, busy, onReprobe, stubbed? }`），
 * 本页**不再复制一份接口定义**——S4b 那轮留的本地 `AbilityBarProps` 只是「组件还没落地时的占位」，
 * 组件落地后两份定义并存必然漂移，所以这里删掉、改成一句指向。
 *
 * 页面负责的只有三件事：探测（`record:probe`）、把结果原样交出去、以及**灯 1 红时禁用开始录制**。
 * 那最后一条现在由 `recordBlocked()` 统一判（面板与主按钮读同一份 abilities，不各写一遍）。
 */

/** `record:validate` 单次入参上限（契约 §9.2：`items ≤ 50`）——超过要分批，不许截断 */
const VALIDATE_BATCH = 50;

const TAB_RECORD = 'record';
const TAB_REPORT = 'report';

type TabId = typeof TAB_RECORD | typeof TAB_REPORT;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** 元素名（`PomElementRow.name` ≤ 60 字符）：动作 + 标签 + 步骤号，用户可在元素库改 */
function elementNameOf(row: CheckRow, draft: RecorderDraft): string {
  const tag = (draft.steps[row.stepIndex] && draft.steps[row.stepIndex].target.tag) || 'element';
  const action = row.action || 'click';
  return `${action} ${tag} #${row.stepIndex + 1}`.slice(0, 60);
}

export function Recorder() {
  const { toasts, addToast, removeToast } = useToast();

  /* ---------------- 本机能力（灯 1 决定能不能开录；灯本身在 AbilityBar） ---------------- */
  const [abilities, setAbilities] = useState<RecordAbility[]>([]);
  const [probedAt, setProbedAt] = useState('');
  const [probing, setProbing] = useState(false);
  const [stubbed, setStubbed] = useState(false);

  /* ---------------- 表单 ---------------- */
  const [url, setUrl] = useState('');
  const [pageId, setPageId] = useState('');
  const [pages, setPages] = useState<PomPage[]>([]);

  /* ---------------- 动作状态（state 给渲染，ref 给「防重复提交」） ---------------- */
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const [confirmAnyway, setConfirmAnyway] = useState(false);
  /**
   * 三个 in-flight 闸门用 ref 而不是 state：`setStarting(true)` 要等下一次渲染才生效，
   * 双击 / 连点会在同一个 tick 里进两次 handler——「提交中防重复」靠 state 是防不住的。
   */
  const startingRef = useRef(false);
  const stoppingRef = useRef(false);
  const savingRef = useRef(false);

  /* ---------------- 报告（本页状态；落库写进 `UiRecording.check`） ---------------- */
  const [report, setReport] = useState<CheckRow[] | null>(null);
  const [reportAt, setReportAt] = useState('');
  const [tab, setTab] = useState<TabId>(TAB_RECORD);

  const draft = useStore((s) => s.recorder);
  const recording = !!draft && !!draft.sessionId && !draft.ended;
  const steps = draft ? draft.steps : [];

  /**
   * 产物三选（`ArtifactPicker`，S6 交付）的入参：**当前录制**——录制中就是「已经录到的这几步」，
   * 停止后仍是同一份（草稿不随会话结束清空，`recorderEnd()` 只打 `ended` 标记）。
   *
   * 为什么 `updatedAt` 取 `reportAt || startedAt` 而不是 `new Date()`：产物是纯函数生成，
   * `rec` 的引用一变产物就会重算一遍（`buildArtifacts` 里两份模板 + POM 生成）。
   * 每次渲染都换时间戳 = 每次渲染都重算，纯属自找卡顿；这里给一个**稳定**的时间值。
   */
  const artifactRec = useMemo<UiRecording | null>(() => {
    if (!draft || steps.length === 0) return null;
    return toRecording(draft.steps, {
      id: draft.recordingId,
      name: recordingNameOf(draft.url, draft.startedAt),
      baseUrl: draft.url || 'https://example.com/',
      startedAt: draft.startedAt,
      updatedAt: reportAt || draft.startedAt,
      pageId: draft.pageId || undefined,
      check: report ? checkSummaryOf(report, reportAt) : undefined,
    });
  }, [draft, steps.length, report, reportAt]);

  /* ================================================================
     数据加载：能力探测 + 元素库页面列表 + 会话态复原
     ================================================================ */

  const probe = useCallback(async (force: boolean) => {
    setProbing(true);
    const r = await callIpc(() => window.electronAPI.recordProbe({ force }));
    if (r.ok && r.data) {
      setAbilities(Array.isArray(r.data.abilities) ? r.data.abilities : []);
      setProbedAt(r.data.probedAt || '');
      // 探针注入口（`PM_RECORD_PROBE_STUB`）生效时才有：交给灯面板打个标记，
      // 免得把「构造出来的红灯」当成真实环境结论（QA 的 AC-14 反例就靠它构造）。
      setStubbed(r.data.stubbed === true);
    } else if (!r.ok) {
      addToast(`本机能力探测失败：${r.error}`, 'error');
    }
    setProbing(false);
  }, [addToast]);

  const loadPages = useCallback(async () => {
    const r = await callIpc(() => window.electronAPI.wsGet('pomPages'));
    if (r.ok && Array.isArray(r.data)) setPages(r.data as PomPage[]);
  }, []);

  useEffect(() => {
    void probe(false);
    void loadPages();
  }, [probe, loadPages]);

  /**
   * 会话态复原（契约 J-2 / `record:status` 存在的理由）：
   * 切页签或重挂之后 `sessionId` 不能靠猜——从主进程拿回来，才能继续 stop / validate。
   */
  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await callIpc(() => window.electronAPI.recordStatus());
      if (!alive || !r.ok || !r.data) return;
      const st = r.data;
      const cur = useStore.getState().recorder;
      if (cur && cur.sessionId === st.sessionId) {
        useStore.getState().recorderPatchSession({ url: st.url, startedAt: st.startedAt });
        return;
      }
      useStore.getState().recorderBegin({
        sessionId: st.sessionId,
        // 新草稿：录制 id 换新的（旧草稿已经不在，重新 bind 到本会话）
        recordingId: newId(),
        url: st.url,
        startedAt: st.startedAt,
      });
      addToast('检测到仍在进行的录制会话，已接回该会话（切页期间的动作无法补录）', 'info', 5000);
    })();
    return () => { alive = false; };
  }, [addToast]);

  /* ================================================================
     灯 1 门禁（AC-14b：只禁灯 1，灯 2/3/4/5 红不禁用）
     ================================================================ */

  /**
   * 灯 1 门禁（AC-14b：只禁灯 1，灯 2/3/4/5 红不禁用）。
   *
   * `recordBlocked()` 是 `AbilityBar.tsx` 导出的判据：**面板上灯 1 的颜色与主按钮是否禁用
   * 必须来自同一次判断**。原来本页内联了同一段 `find(a => a.id === 'chrome')`，
   * 两处逻辑一旦分叉就会出现「灯是红的、按钮还能点」这种最难查的形态。
   */
  const blocked = recordBlocked(abilities);
  /** 只用于禁用原因条里的现状文案（`chromeLamp.detail`），不参与门禁判断 */
  const chromeLamp = useMemo(() => abilities.find((a) => a.id === 'chrome'), [abilities]);
  const blockReason = useMemo(() => {
    // 文案照 `04-视觉方向.md` §5「原因文案（可直抄）」
    const tail = steps.length > 0 ? `；已录的 ${steps.length} 步不受影响。` : '。';
    return `未检测到可用的 Chromium 系浏览器，开始录制已禁用。装好 Chrome 或 Edge 后点右上角 ↻ 重新探测${tail}`;
  }, [steps.length]);

  /* ================================================================
     校验（会话必须还活着）
     ================================================================ */

  /**
   * 跑一次元素级校验，返回**原始结果**（带步骤下标），不直接拼行。
   *
   * 为什么返回原始结果而不是行：`record:stop` 之前可能还有几条事件在主进程队列里
   * （16 ms 合批）。**注意时序**（t39 加了 stop 前排空：`stopCore` 会先有界 drain、再 emit 事件、
   * 最后才 return），所以这些步骤是在 `record:stop` **resolve 之前**就已经 emit 出去的，
   * 渲染层拿到 stop 结果时它们**已经在 store 里**了——「晚到」指的是「比上一批晚」，不是
   * 「比 stop 结果晚」。报告行仍按**停止后的最终步骤数**生成，否则 AC-2 的「`tbody tr` 行数 =
   * 该会话步骤数」会差 1 行——这 1 行就是用户最后点的那一下。
   * 万一仍有未参与校验的步骤，`buildCheckRows` 会给它一行「未参与校验」，而不是让它凭空消失。
   */
  const runValidate = useCallback(async (
    d: RecorderDraft,
  ): Promise<Array<RecordValidateRow & { stepIndex: number }>> => {
    const { stepIndexes, items } = validateItemsOf(d.steps);
    const results: Array<RecordValidateRow & { stepIndex: number }> = [];
    for (let i = 0; i < items.length; i += VALIDATE_BATCH) {
      const chunk = items.slice(i, i + VALIDATE_BATCH);
      const r = await callIpc(() => window.electronAPI.recordValidate({ sessionId: d.sessionId, items: chunk }));
      if (!r.ok || !r.data) {
        addToast(`元素级校验失败：${r.ok ? '返回为空' : r.error}`, 'error');
        break;
      }
      r.data.results.forEach((row, j) => {
        const stepIndex = stepIndexes[i + j];
        if (typeof stepIndex === 'number') results.push({ ...row, stepIndex });
      });
    }
    return results;
  }, [addToast]);

  /* ================================================================
     开始 / 停止
     ================================================================ */

  const handleStart = useCallback(async () => {
    if (startingRef.current || useStore.getState().recorder?.sessionId) return;
    const target = url.trim();
    if (!target) {
      addToast('请先填目标页址（http:// 或 https:// 开头）', 'error');
      return;
    }
    startingRef.current = true;
    setStarting(true);
    setSavedMessage('');
    const r = await callIpc(() => window.electronAPI.recordStart({
      url: target,
      pageId: pageId || undefined,
    }));
    if (!r.ok || !r.data) {
      startingRef.current = false;
      setStarting(false);
      addToast(r.ok ? '启动失败' : r.error, 'error');
      // 灯 1 可能是缓存里的旧结论（60 s）：失败后强制重探一次，让禁用的按钮有机会自愈
      void probe(true);
      return;
    }
    const { sessionId, browser, port } = r.data;
    useStore.getState().recorderBegin({
      sessionId,
      recordingId: newId(),
      browser,
      port,
      pageId,
    });
    // start 只回 sessionId/browser/port：脱敏后的 url 与 startedAt 从 status 补齐（两个 URL 不是同一个值）
    const st = await callIpc(() => window.electronAPI.recordStatus());
    if (st.ok && st.data) {
      useStore.getState().recorderPatchSession({ url: st.data.url, startedAt: st.data.startedAt });
    }
    setReport(null);
    setReportAt('');
    setTab(TAB_RECORD);
    startingRef.current = false;
    setStarting(false);
    addToast('已开始录制：在弹出的 Chrome 窗口里操作被测系统', 'success', 4000);
  }, [addToast, pageId, probe, url]);

  const handleStop = useCallback(async () => {
    const d = useStore.getState().recorder;
    if (!d || stoppingRef.current) return;
    stoppingRef.current = true;
    setStopping(true);
    // ① 先校验（会话还活着才能验），② 再停止；报告在 stop resolve 前已就绪
    const results = await runValidate(d);
    const r = await callIpc(() => window.electronAPI.recordStop({ sessionId: d.sessionId }));
    if (!r.ok) {
      addToast(`停止失败：${r.error}`, 'error');
    } else if (r.data) {
      useStore.getState().recorderEnd({ truncated: r.data.truncated, dropped: r.data.dropped });
      if (r.data.truncated) {
        // `[C-09]`：到顶必须显式告警，不许静默
        addToast('事件已达上限（5000），后续动作未记录', 'error', 6000);
      } else if (r.data.dropped > 0) {
        addToast(`有 ${r.data.dropped} 条事件因不合规被丢弃`, 'info', 5000);
      }
    }
    // 行数按**停止后的最终步骤**生成：合批里晚到的那几步也要占一行（否则 AC-2 差行）
    const latest = useStore.getState().recorder;
    setReport(buildCheckRows(latest ? latest.steps : d.steps, results));
    setReportAt(new Date().toISOString());
    setTab(TAB_REPORT);
    stoppingRef.current = false;
    setStopping(false);
  }, [addToast, runValidate]);

  const handleRevalidate = useCallback(async () => {
    const d = useStore.getState().recorder;
    if (!d) return;
    if (d.ended) {
      addToast('会话已结束：停止后再校验会回「会话已结束」，要重跑请重新录制', 'error', 5000);
      return;
    }
    const results = await runValidate(d);
    setReport(buildCheckRows(d.steps, results));
    setReportAt(new Date().toISOString());
    addToast('已重新校验', 'success');
  }, [addToast, runValidate]);

  /* ================================================================
     落库（两个方向：只写唯一命中 / 强制写全部可写的）
     ================================================================ */

  const saveToLibrary = useCallback(async (mode: 'unique' | 'all') => {
    const d = useStore.getState().recorder;
    const rows = report;
    if (!d || !rows || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSavedMessage('');
    try {
      const at = new Date().toISOString();
      const targets = elementsToSave(rows, mode);

      // ---- ① 元素库：先 get-or-create 拿到稳定 id（重复保存不会把同一元素存两份） ----
      const pagesRes = await callIpc(() => window.electronAPI.wsGet('pomPages'));
      if (!pagesRes.ok) {
        addToast(pagesRes.error, 'error');
        return;
      }
      const allPages: PomPage[] = Array.isArray(pagesRes.data) ? (pagesRes.data as PomPage[]) : [];
      const host = hostOf(d.url);
      const current = (d.pageId ? allPages.find((p) => p.id === d.pageId) : undefined)
        || allPages.find((p) => p.baseUrl === d.url)
        || null;
      const page: PomPage = current || {
        id: newId(),
        name: (host || '录制页面').slice(0, 80),
        baseUrl: d.url || 'https://example.com/',
        elements: [],
        updatedAt: at,
      };
      const elements: PomElementRow[] = page.elements.slice();
      const elementIdOfStep = new Map<number, string>();
      for (const row of targets) {
        if (!row.selector) continue;
        let el = elements.find((e) => e.locator === row.selector);
        if (!el) {
          el = {
            id: newId(),
            name: elementNameOf(row, d),
            locator: row.selector,
            kind: row.strategy as PomLocatorKind,
            note: `由录制第 ${row.stepIndex + 1} 步保存`,
          };
          elements.push(el);
        } else if (!el.id) {
          // 历史元素没有 id（v1.34.0 及以前）：读容错、写必填（`[C-110]` J-13）
          el = { ...el, id: newId() };
          const idx = elements.findIndex((e) => e.locator === row.selector);
          if (idx >= 0) elements[idx] = el;
        }
        elementIdOfStep.set(row.stepIndex, String(el.id));
      }
      const nextPage: PomPage = { ...page, elements, updatedAt: at };
      const nextPages = current
        ? allPages.map((p) => (p.id === page.id ? nextPage : p))
        : [...allPages, nextPage];
      // 上限（`[C-24]` pomPages 200 份 / 512 KB）：超出从最旧丢，丢了要说（`[C-09]`）
      const trimmedPages = trimToCaps(nextPages, capsOf('pomPages'), {
        timeOf: (p: PomPage) => p.updatedAt,
      });
      const wrotePages = await callIpc(() => window.electronAPI.wsSet('pomPages', trimmedPages.items));
      if (!wrotePages.ok) {
        addToast(`元素库保存失败：${wrotePages.error}`, 'error');
        return;
      }

      // ---- ② 录制本身：带上 `elementId`（`[C-110]` 的唯一锚点），过保存计划 ----
      const stepsWithIds = d.steps.map((rec, i) => {
        const id = elementIdOfStep.get(i);
        return id ? { ...rec, step: { ...rec.step, elementId: id } } : rec;
      });
      const rec = toRecording(stepsWithIds, {
        id: d.recordingId,
        name: recordingNameOf(d.url, d.startedAt),
        baseUrl: d.url || 'https://example.com/',
        startedAt: d.startedAt,
        updatedAt: at,
        pageId: page.id,
        check: checkSummaryOf(rows, at),
      });
      const cur = await callIpc(() => window.electronAPI.wsGet('uiRecordings'));
      if (!cur.ok) {
        addToast(cur.error, 'error');
        return;
      }
      const recordings: UiRecording[] = Array.isArray(cur.data) ? (cur.data as UiRecording[]) : [];
      const plan = planRecordingSave(recordings, rec);
      if (!plan.ok) {
        // > 300 步是**拒绝保存**（不是裁剪）：把原因原样交给用户
        addToast(plan.error || '保存失败', 'error', 6000);
        return;
      }
      const wrote = await callIpc(() => window.electronAPI.wsSet('uiRecordings', plan.items));
      if (!wrote.ok) {
        addToast(`录制保存失败：${wrote.error}`, 'error');
        return;
      }
      if (plan.dropped > 0) {
        // `[C-09]`：单库上限裁剪必须说出来，不许静默
        addToast(plan.notice || `历史记录已按上限裁剪，最早 ${plan.dropped} 条已清理`, 'info', 6000);
      }
      const written = elementIdOfStep.size;
      if (written === 0) {
        addToast(
          mode === 'unique'
            ? '没有唯一命中的元素，元素库未写入（录制本身已保存）；需要强制写入请点「仍要保存」'
            : '没有可写入元素库的定位器（命中 0 / 多命中的行也不算可用，只在「仍要保存」下才写）',
          'info',
          6000,
        );
      } else {
        addToast(
          `已保存：${rec.name}（${mode === 'all' ? '含不可用定位器，' : ''}元素库写入 ${written} 个）`,
          'success',
          4000,
        );
      }
      setSavedMessage(`已保存 ${rec.name}`);
      void loadPages();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [addToast, loadPages, report]);

  const handleSave = useCallback(() => { void saveToLibrary('unique'); }, [saveToLibrary]);
  const handleSaveAnyway = useCallback(() => { setConfirmAnyway(true); }, []);

  /* ================================================================
     渲染
     ================================================================ */

  const pageOptions = pages.map((p) => ({ id: p.id, label: p.name || p.baseUrl }));
  const showBlockBanner = blocked && !recording;

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <div className="pg rec-page">
        <PageHead
          icon={<Icons.terminal size={16} />}
          title="UI 录制器"
          desc="对被测系统点一遍，把点过的地方变成带唯一性证明的定位器。应用内只做「录 + 验 + 落 + 生成」，不做正式回归；应用内通过 ≠ CI 通过。"
        />

        <div className="toolbar">
          <div className="rec-row">
            <label className="field is-grow">
              <span className="field-label">目标页址</span>
              <input
                type="text"
                value={url}
                placeholder="https://example.com/login"
                aria-label="目标页址"
                disabled={recording}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className="field is-fixed">
              <span className="field-label">关联页面</span>
              <select
                aria-label="关联页面"
                value={pageId}
                disabled={recording}
                onChange={(e) => {
                  const next = e.target.value;
                  setPageId(next);
                  const hit = pages.find((p) => p.id === next);
                  if (hit && !url.trim()) setUrl(hit.baseUrl);
                }}
              >
                <option value="">不关联（保存时按页址自动建）</option>
                {pageOptions.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
            {recording ? (
              <button
                type="button"
                className="btn btn-primary"
                data-act="record-stop"
                disabled={stopping}
                title="先对每一步跑一次元素级命中校验，再结束会话"
                onClick={() => { void handleStop(); }}
              >
                {stopping ? '正在停止…' : '停止并校验'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                data-act="record-start"
                disabled={blocked || starting}
                // AC-14b：灯 1 红时既要 disabled，也要非空 data-reason（可读中文）
                data-reason={blocked ? blockReason : undefined}
                title={blocked ? blockReason : '打开一个真实 Chrome 窗口开始录制'}
                onClick={() => { void handleStart(); }}
              >
                {starting ? '正在启动…' : '开始录制'}
              </button>
            )}
          </div>
          <div className="rec-row">
            <span className="text-sm text-muted">
              只支持 Chromium 系浏览器；录制结果只在本机保存。会话与临时 profile 在停止后自动清理。
            </span>
          </div>
        </div>

        {/* 禁用原因位（`04-视觉方向.md` §5：`#rec-block-reason` 在 `.tabs` 之前） */}
        {showBlockBanner ? (
          <div className="dev-banner is-error" id="rec-block-reason">
            <span aria-hidden="true">✗</span>
            <span>{blockReason}</span>
            <span className="dev-banner-act">
              <span className="text-sm text-muted">
                {chromeLamp?.detail || '未探测到浏览器'}
              </span>
            </span>
          </div>
        ) : null}

        {/*
          能力灯（`AbilityBar`，S5 交付）。挂载点在 `.tabs` **之前**：灯 1 决定 `.toolbar` 里的
          主按钮能不能点，灯放在页签里会让「按钮为什么是灰的」和「证据在哪」分处两个页签
          （`04-视觉方向.md` §1.1 的原话）。

          `data-slot="ability-bar"` 是 S4b 留下的挂载点标记，保留下来：玻璃扫描脚本与后续
          回归都按它认位置（值没变，只是里面的占位文案换成了真组件）。

          `onReprobe` 只做**面板级**一次 `record:probe({ force: true })`：5 盏灯必须是同一时刻
          的快照，逐灯刷新会让「灯 1 是 10:01、灯 3 是 10:05」这种事无法回答（同文件 §4.3）。
        */}
        <div data-slot="ability-bar">
          <AbilityBar
            abilities={abilities}
            probedAt={probedAt}
            busy={probing}
            stubbed={stubbed}
            onReprobe={() => { void probe(true); }}
          />
        </div>

        <div className="tabs" role="tablist" aria-label="UI 录制器">
          <button
            type="button"
            role="tab"
            id="rec-tab-record"
            aria-selected={tab === TAB_RECORD}
            aria-controls="rec-panel-record"
            tabIndex={tab === TAB_RECORD ? 0 : -1}
            className={`tab2${tab === TAB_RECORD ? ' is-active' : ''}`}
            onClick={() => setTab(TAB_RECORD)}
          >
            <span>录制</span>
          </button>
          <button
            type="button"
            role="tab"
            id="rec-tab-report"
            aria-selected={tab === TAB_REPORT}
            aria-controls="rec-panel-report"
            tabIndex={tab === TAB_REPORT ? 0 : -1}
            className={`tab2${tab === TAB_REPORT ? ' is-active' : ''}`}
            onClick={() => setTab(TAB_REPORT)}
          >
            <span>校验报告</span>
            {report ? <span className="dev-list-count">{report.length}</span> : null}
          </button>
        </div>

        {/* 录制面板：**始终渲染**（非激活时 hidden）——AC-1 在停止后仍要读到候选锚点 */}
        <div
          role="tabpanel"
          id="rec-panel-record"
          aria-labelledby="rec-tab-record"
          hidden={tab !== TAB_RECORD}
        >
          {!draft ? (
            <Panel>
              <Empty
                icon={<Icons.terminal size={22} />}
                title="还没有录制会话"
                desc="填好目标页址后点「开始录制」，本机 Chrome 会打开一个新窗口，你在里面的每次点击 / 输入都会变成一步。"
                hint="只支持 Chromium 系浏览器；录制结果只在本机保存，录制过程中不落盘，点「保存」才写一次。"
              />
            </Panel>
          ) : (
            <>
              <SessionBanner
                sessionId={draft.sessionId}
                startedAt={draft.startedAt}
                stepCount={steps.length}
                browser={draft.browser}
                port={draft.port}
                ended={draft.ended}
                truncated={draft.truncated}
                dropped={draft.dropped}
              />
              <Panel
                title="录制会话"
                meta={`已录 ${steps.length} 步${report ? ' · 已出校验报告' : ''}`}
                tools={(
                  <span className="text-sm text-muted">
                    关闭 Chrome 窗口或锁定应用都会同步停录
                  </span>
                )}
              >
                <div className="split">
                  <div className="dev-list" role="list" aria-label="已录步骤">
                    {steps.length === 0 ? (
                      <div className="text-sm text-muted" style={{ padding: '8px 6px' }}>
                        还没有录到动作：去 Chrome 窗口里点一下被测系统的元素。
                      </div>
                    ) : steps.map((rec, i) => (
                      <div className="dev-list-item" key={rec.step.id} data-step-id={rec.step.id}>
                        <span className="dev-list-name">
                          {i + 1}. {rec.step.action} {rec.target.tag ? `<${rec.target.tag}>` : ''}
                        </span>
                        <span className="dev-list-count">
                          {rec.chosen >= 0 && rec.candidates[rec.chosen]
                            ? (rec.candidates[rec.chosen].count === null ? '—' : rec.candidates[rec.chosen].count)
                            : '无'}
                        </span>
                        <button
                          type="button"
                          className="dev-list-del ibtn"
                          title={`删除第 ${i + 1} 步`}
                          aria-label={`删除第 ${i + 1} 步`}
                          onClick={() => useStore.getState().recorderDropStep(i)}
                        >
                          <Icons.trash size={13} />
                        </button>
                      </div>
                    ))}
                  </div>

                  <div>
                    <Panel
                      title="定位器候选"
                      meta={`${steps.reduce((n, r) => n + r.candidates.length, 0)} 个候选 · 推荐 ${steps.filter((r) => pickRecommended(r.candidates) >= 0).length} 个`}
                    >
                      {steps.length === 0 ? (
                        <div className="text-sm text-muted">选中一步之后，这里显示页内给出的全部候选与命中数。</div>
                      ) : (
                        <div className="dev-scroll">
                          {steps.map((rec, i) => (
                            <CandidateCard
                              key={rec.step.id}
                              rec={rec}
                              stepNo={i + 1}
                              onChoose={(idx) => useStore.getState().recorderChoose(i, idx)}
                            />
                          ))}
                        </div>
                      )}
                    </Panel>
                  </div>
                </div>
              </Panel>
            </>
          )}
        </div>

        {/* 报告面板：同样始终渲染（`hidden` 只影响可见性，不影响 AC-2 的 DOM 读取） */}
        <div
          role="tabpanel"
          id="rec-panel-report"
          aria-labelledby="rec-tab-report"
          hidden={tab !== TAB_REPORT}
        >
          {report ? (
            <CheckReport
              rows={report}
              at={reportAt}
              sessionEnded={!recording}
              saving={saving}
              savedMessage={savedMessage}
              onSave={handleSave}
              onSaveAnyway={handleSaveAnyway}
              onRevalidate={() => { void handleRevalidate(); }}
            />
          ) : (
            <Panel>
              <Empty
                icon={<Icons.list size={22} />}
                compact
                title="还没有校验报告"
                desc="录完动作后点「停止并校验」：每个步骤都会当页跑一次元素级命中校验，报告里逐行给命中数。"
                hint="校验必须发生在会话还活着的时候——停止之后再校验会回「会话已结束」。"
              />
            </Panel>
          )}
        </div>

        {/*
          产物三选（`ArtifactPicker`，S6 交付）。挂成**页签之外的 `.pnl` 分区**，不是第三个页签：
          1. 本页两个页签被玻璃扫描脚本按「页签 === 2 / tabpanel === 2」登记
             （`scripts/ui-glass-opaque-scan.js` 的 READY_PRED，`=== 2` 是精确值）——加第三个页签会让
             那道门禁直接红，而那个脚本不在本片 inScope；
          2. 更实际的理由：产物要**在任何页签下都能看**。挂在页签里的话，停止后页面自动切到
             「校验报告」，用户想导出还得先切回去；而且 `hidden` 的子树在浏览器里不可见，
             S7 的 AC-16 判据虽然只读 DOM，但人要点「复制代码」就点不到了。

          ⚠️ 已知取舍（`data-artifact` 锚点）：AC-16 要求 `.tb-pre.dev-code[data-artifact=…]` ——
          属性必须挂在 `<pre>` 上，而那个 `<pre>` 由全站共享的 `CodeBlock`（`src/components/ui.tsx`）
          渲染、不接受额外属性。S6 的做法是挂载后用 `pre.setAttribute('data-artifact', id)` 补这一个
          数据属性（见 `ArtifactPicker.tsx` 的 `ArtifactCode`）：末期给共享组件加 prop 的回归面
          （全站 30+ 处调用）远大于这一个属性的收益，故接受该方案并在此留痕。
        */}
        <Panel
          title="产物"
          meta={
            artifactRec
              ? `${artifactRec.steps.length} 步 · 两份同源（步骤与定位器逐条一致）`
              : '还没有可导出的录制'
          }
          tools={(
            <span className="text-sm text-muted">
              应用内只做「录 + 验 + 落 + 生成」，产物的执行结果以在你自己的环境里跑出来的为准
            </span>
          )}
        >
          <ArtifactPicker
            rec={artifactRec}
            emptyHint="先在「录制」页签录几步并停止，这里就能导出两份产物：① Java POM 与 ③ Playwright .spec.ts。"
          />
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmAnyway}
        variant="warning"
        title="把不可用的定位器也写进元素库？"
        message="「仍要保存」会把命中 0 或多命中的定位器一起写进元素库。用它们生成的两份产物（POM / .spec.ts）在回放时一定失败，需要你之后手工改定位器。"
        confirmText="仍要保存"
        cancelText="取消"
        onCancel={() => setConfirmAnyway(false)}
        onConfirm={() => {
          setConfirmAnyway(false);
          void saveToLibrary('all');
        }}
      />
    </div>
  );
}
