/**
 * ▶ 校验面板（CDP 点验 / `el:hit-test`）—— 1.37.0（S3）
 *
 * 契约：`docs/契约-元素库-A0A1A2.md` 的 [A2-1]/[A2-3]/[A2-4]/[A2-14]；
 * 交互与视觉：`docs/方案-元素库-A0A1A2-界面.md` §0-§5。
 *
 * 三条不许违反的口径（都翻了车才会被发现的类型）：
 *
 * 1. **「没验」不许显示成「没命中」**（[A2-4]）：通道失败（`success:false`）走 `failed` 状态，
 *    该状态**不显示任何命中数字**，只给错误文案 + 错误码 + 日志尾部入口。
 * 2. **点验是近似实现**（[A2-7]）：`approx:true`（text / role / pw）时结论旁必须挂
 *    「近似口径（与 Playwright 实现不完全等价）」，且**不许**写「已验证 / 等价」。
 * 3. **不写库**（[A2-14] 证伪形态）：本组件不碰 `pomPages`，也不回填 `hitCount / checkedAt`
 *    （那是「试跑」`el:trial-run` 的唯一职责）。所以这里没有任何 `save` 调用。
 *
 * 状态机：**12 态**，与 `el:hit-test` 的事实字段一一对应，没有孤立状态（见 `hitViewOf` 的注释）：
 *   - 7 个 `reason` → 8 个渲染分支（`ok` 按 `total === 1` / `total > 1` 拆两档，
 *     且 `not-visible` **优先于** `ok`，因为前者的条件更具体）；
 *   - 4 个非 reason 状态：`idle`（本地态）/ `connecting`（请求在飞）/ `failed`（`success:false`）/
 *     `session-ended`（`session.open === false`）。
 *
 * ⚠️ 「shadow DOM」**不是**独立状态：`ElHitReason` 只有 7 个取值，主进程也不探测 shadow root
 * （`HIT_SCRIPT` 在 main frame 的 `document` 上 query）。给它造一个永远触发不到的状态分支，
 * 就正是验收里要禁的「孤立状态」。所以它落在**常驻说明行**里（[N-2] 的固定说明，见下），
 * 与 `iframe-only` 状态同源、同时可见。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Icons } from '../ui';
import type { ElHitSession, ElHitTestInput, ElHitTestResult } from '../../types';
import { HIT_NOTE_IFRAME, HIT_NOTE_TRIAL, hitViewOf, runLabelOf } from './hitPanelModel';
import type { PomElementRow } from './pomModel';

/* 状态机与文案已下沉到 `hitPanelModel.ts`（纯函数，可单测）。

   组件只做三件事：调 IPC、按 `hitViewOf()` 的结果渲染、把「结束校验」收干净。
   **不许**在这里再写一套 reason → 文案的 if：那会让状态判断散成两处（[A2-1] 的
   「三份状态判断必然漂移」是同一条教训）。 */

/* ================================================================
   组件
   ================================================================ */

type CallResult =
  | { ok: true; data: ElHitTestResult }
  | { ok: false; fail: { error: string; code?: string } };

export interface HitTestPanelProps {
  /** 库里的页面 id（`pageSaved === false` 时不用它） */
  pageId: string;
  /** 当前草稿页面地址（baseUrl） */
  baseUrl: string;
  elements: PomElementRow[];
  /** 这个页面是否已经存进库：存过才用「库里那条」来源（pageId + elementId），否则用草稿来源 */
  pageSaved: boolean;
  addToast?: (msg: string, type?: 'info' | 'success' | 'error') => void;
}

export function HitTestPanel({ pageId, baseUrl, elements, pageSaved, addToast }: HitTestPanelProps) {
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<{ error: string; code?: string } | null>(null);
  const [result, setResult] = useState<ElHitTestResult | null>(null);
  const [session, setSession] = useState<ElHitSession | null>(null);
  /** 串行进度：**只存内存**，不落库、不进 audit、不回填 hitCount */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** 批量跑完的汇总（一条短句，不参与状态判定） */
  const [summary, setSummary] = useState('');
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');
  const [picked, setPicked] = useState('');
  const sectionRef = useRef<HTMLElement | null>(null);
  const runRef = useRef<HTMLButtonElement | null>(null);

  const view = hitViewOf({ busy, fail, result, session });

  /** 默认选第一条；元素被删/换页时回落到第一条（不让 select 变成空白） */
  const pickedId = useMemo(() => {
    if (picked && elements.some((e) => String(e.id || '') === picked)) return picked;
    return String(elements[0]?.id || '');
  }, [picked, elements]);

  const indexOfPicked = Math.max(0, elements.findIndex((e) => String(e.id || '') === pickedId));

  const bodyOf = useCallback((el: PomElementRow): ElHitTestInput => {
    const base = { op: 'verify' as const, url: baseUrl.trim() };
    const id = String(el.id || '');
    // [A2-2] 来源**恰好一组**。库里那条优先（主进程按 id 取真值，验的就是库里的元素）；
    // 页面还没保存过时库里没有它，只能用草稿来源，否则会踩「这条元素在元素库中不存在」。
    if (pageSaved && pageId && id) return { ...base, pageId, elementId: id };
    return {
      ...base,
      locator: el.locator,
      kind: el.kind,
      // t26（AR-4b）：可访问名与生成器**同口径** `String(x).trim()`。
      // 三条路径里面板这条最靠用户：用户敲 ` 提交 ` 带首尾空格时，不 trim 就会把空格发下去，
      // 而 Playwright 的 `getByRole(name)` 是**全等**匹配 → 库里写着「提交」的元素永远 0 命中，
      // 且报的是「没命中」而不是「名字带空格」（[A0-6] 那一类最难排查的假红）。
      // 只 trim 不改大小写、不做其它归一：可访问名区分大小写，与生成物保持一致。
      ...(el.kind === 'role' ? { roleName: String(el.role ?? '').trim() } : {}),
    };
  }, [baseUrl, pageId, pageSaved]);

  const call = useCallback(async (input: ElHitTestInput): Promise<CallResult> => {
    try {
      const r = await window.electronAPI.elHitTest(input);
      if (r && r.success && r.data) {
        setSession(r.data.session);
        return { ok: true, data: r.data };
      }
      return { ok: false, fail: { error: (r && r.error) || '点验失败：主进程没有返回结果', code: r && r.code } };
    } catch (e) {
      return { ok: false, fail: { error: '点验调用失败：' + (e instanceof Error ? e.message : String(e)), code: 'ipc-error' } };
    }
  }, []);

  /** 挂载即问一次会话状态（`op:'status'` 只读，**绝不拉起浏览器**，见 [A2-5]） */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const r = await call({ op: 'status' });
      if (!alive || !r.ok) return;
      setResult(null);
      setBusy(false);
    })();
    return () => { alive = false; };
  }, [call]);

  const runOne = useCallback(async (el: PomElementRow) => {
    setBusy(true);
    setFail(null);
    setLogOpen(false);
    setSummary('');
    const r = await call(bodyOf(el));
    setBusy(false);
    if (r.ok) {
      setResult(r.data);
      return true;
    }
    setFail(r.fail);
    setResult(null);
    return false;
  }, [bodyOf, call]);

  const onRun = useCallback(async () => {
    const el = elements[indexOfPicked];
    if (!el) {
      addToast?.('这个页面还没有元素，先加元素再校验', 'error');
      return;
    }
    setProgress(null);
    const ok = await runOne(el);
    if (ok) setProgress({ done: 1, total: 1 });
  }, [addToast, elements, indexOfPicked, runOne]);

  /**
   * 依次校验全部：**前端串行** `await` 每一条。
   *
   * 不能 `Promise.all`：主进程对异参并发直接回 `ERR.busy`（[A2-5]），并发只会得到一堆「正在运行」。
   * 也不能在后端加批量 op：`[A2-1]` 规定单次只验 1 条（批量归试跑）。所以「批量」= 这里的一个 for。
   */
  const onRunAll = useCallback(async () => {
    if (!elements.length) {
      addToast?.('这个页面还没有元素，先加元素再校验', 'error');
      return;
    }
    setBusy(true);
    setFail(null);
    setResult(null);
    setLogOpen(false);
    setSummary('');
    const tally = { ok: 0, miss: 0, other: 0 };
    setProgress({ done: 0, total: elements.length });
    for (let i = 0; i < elements.length; i += 1) {
      setProgress({ done: i + 1, total: elements.length });
      const r = await call(bodyOf(elements[i]));
      if (!r.ok) {
        // 硬失败（浏览器没起来 / 导航失败 / busy）立刻停：继续跑只会把同一条错误刷 12 遍
        setBusy(false);
        setFail(r.fail);
        return;
      }
      setResult(r.data);
      const reason = r.data.hit?.reason;
      if (reason === 'ok') tally.ok += 1;
      else if (reason === 'not-found') tally.miss += 1;
      else tally.other += 1;
    }
    setBusy(false);
    setSummary(
      `本轮：命中 ${tally.ok} / 未命中 ${tally.miss} / 其它 ${tally.other}（共 ${elements.length} 条；点验不写库）`,
    );
  }, [addToast, bodyOf, call, elements]);

  /** 结束校验：一次收干净（关浏览器 + 清结果/进度/汇总/日志），不留半截状态 */
  const onStop = useCallback(async () => {
    const r = await call({ op: 'stop' });
    setResult(null);
    setFail(null);
    setProgress(null);
    setSummary('');
    setLogOpen(false);
    setLogText('');
    if (!r.ok) {
      addToast?.(r.fail.error, 'error');
      return;
    }
    const killed = r.data.killed === true;
    const already = r.data.alreadyStopped === true;
    if (r.data.stopped) {
      addToast?.(already ? '浏览器已经关了' : `浏览器已关闭${killed ? '（有进程是强制结束的）' : ''}`, 'info');
    }
  }, [addToast, call]);

  /** 失败态的日志尾部：复用既有 `log:tail`（**不加 IPC**，也不读文件系统） */
  const onLog = useCallback(async () => {
    if (logOpen) {
      setLogOpen(false);
      return;
    }
    try {
      const r = await window.electronAPI.logTail(20);
      const text = r && r.success && r.data ? r.data.text || '' : '';
      setLogText(text || '（读不到日志文件，或它还是空的）');
    } catch (e) {
      setLogText('读日志失败：' + (e instanceof Error ? e.message : String(e)));
    }
    setLogOpen(true);
  }, [logOpen]);

  /** Esc 关面板：只收展开区，不清结论；挂在本区块上（不挂 window，避免与 Modal / 命令面板抢事件） */
  const onKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    if (!logOpen && !summary) return;
    e.stopPropagation();
    setLogOpen(false);
    setSummary('');
    runRef.current?.focus();
  };

  const canStop = !!session?.open;
  const facts = view.facts;
  const approx = !!facts?.approx;

  return (
    <section
      ref={sectionRef}
      className="el-hit"
      data-hit-state={view.state}
      data-hit-expanded={logOpen ? 'true' : 'false'}
      role="region"
      aria-label="点验面板"
      aria-busy={busy ? 'true' : 'false'}
      onKeyDown={onKeyDown}
    >
      {/* 一行操作条：主操作 ▶ 在最左；**面板头只有外层那一行 .pnl-title**，这里不起标题 */}
      <div className="el-hit-bar">
        <button
          ref={runRef}
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => void onRun()}
          disabled={busy || !elements.length}
          data-el-hit="run"
          title={elements.length ? '在本机浏览器里打开页面地址，把这条定位器命中的元素框出来（只查 1 条）' : '先加元素'}
        >
          <Icons.search size={13} /> {runLabelOf(view.state)}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void onRunAll()}
          disabled={busy || !elements.length}
          data-el-hit="all"
          title={`逐条串行校验 ${elements.length} 条：共 ${elements.length} 次调用；不写库、不回填「上次校验」`}
        >
          <Icons.list size={13} /> 依次校验全部
        </button>

        <select
          className="el-hit-pick"
          value={pickedId}
          onChange={(e) => setPicked(e.target.value)}
          aria-label="要校验的元素"
          disabled={!elements.length}
          title="选一条元素再点 ▶ 校验"
        >
          {elements.length === 0 && <option value="">（还没有元素）</option>}
          {elements.map((el, i) => (
            <option key={String(el.id || i)} value={String(el.id || '')}>
              {`${i + 1}. ${el.name || '未命名'}`}
            </option>
          ))}
        </select>

        <span className="el-hit-tag-wire">
          <span className={`dev-tag ${view.tag.cls}`} data-hit-tag>
            {view.state === 'not-visible' ? <Icons.eyeOff size={13} /> : null}
            {view.state === 'ok' ? <Icons.check size={13} /> : null}
            {view.state === 'multi' ? <Icons.eye size={13} /> : null}
            {view.state === 'failed' || view.state === 'not-found' ? <Icons.bug size={13} /> : null}
            {view.state === 'login-required' ? <Icons.lock size={13} /> : null}
            {view.state === 'timeout' ? <Icons.clock size={13} /> : null}
            {view.state === 'connecting' ? <Icons.clock size={13} /> : null}
            {view.state === 'idle' || view.state === 'session-ended' ? <Icons.db size={13} /> : null}
            {view.tag.text}
          </span>
        </span>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void onStop()}
          disabled={!canStop}
          data-el-hit="stop"
          title={canStop ? '关闭点验会话的浏览器窗口（一次收干净）' : '当前没有正在运行的点验会话'}
        >
          <Icons.close size={13} /> 关闭浏览器
        </button>

        {progress && (
          <span className="el-hit-progress" data-hit-progress aria-live="polite">
            第 {progress.done} / {progress.total} 个
          </span>
        )}
      </div>

      {/* 结论行：状态变化只有这一处播报（aria-live），语义由**文字**承担，不只靠颜色 */}
      <p className="el-hit-verdict" data-hit-verdict aria-live="polite" aria-atomic="true">
        {view.verdict}
      </p>

      {/* 失败态：错误码 + 日志尾部入口。**不显示任何命中数字**（[A2-4]） */}
      {view.state === 'failed' && view.error && (
        <div className="el-hit-facts">
          <span>
            错误码 <code className="el-hit-code" data-hit-code>{view.error.code}</code>
          </span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void onLog()} data-el-hit="log" aria-expanded={logOpen}>
            <Icons.note size={13} /> {logOpen ? '收起日志尾部' : '查看日志尾部'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void window.electronAPI.logOpen()} data-el-hit="logdir">
            <Icons.folder size={13} /> 打开日志目录
          </button>
        </div>
      )}

      {logOpen && (
        <pre className="el-hit-log" data-hit-log tabIndex={0}>
          {logText}
        </pre>
      )}

      {/* 事实字段：只报事实，不判对错；数字列 tabular-nums */}
      {facts && (
        <div className="el-hit-facts" data-hit-facts>
          <span>类型 <code className="el-hit-code">{facts.kind || 'css'}</code></span>
          <span className="num">命中 {facts.total}{facts.truncated ? '（已截断）' : ''}</span>
          <span>可见 {facts.visible ? '是' : '否'}</span>
          {facts.label ? <span title={facts.label}>标签 {facts.label}</span> : null}
          <span className="num">用时 {facts.ms} ms</span>
          <span className="el-hit-locator" data-hit-locator title={facts.locator}>{facts.locator}</span>
        </div>
      )}

      {approx && (
        <div className="dev-banner is-warn" role="status" data-hit-approx>
          <Icons.clock size={14} />
          <div>近似口径（与 Playwright 实现不完全等价）</div>
        </div>
      )}

      {summary && (
        <div className="dev-banner is-info" role="status" data-hit-summary>
          <Icons.list size={14} />
          <div>{summary}</div>
        </div>
      )}

      {/* 两条常驻说明（[N-2] / [A2-14]；idle 态也必须在，玻璃扫描才扫得到本面板） */}
      <div className="dev-banner is-info" role="note" data-hit-note="iframe">
        <Icons.db size={14} />
        <div>{HIT_NOTE_IFRAME}</div>
      </div>
      <div className="dev-banner is-info" role="note" data-hit-note="trial">
        <Icons.tool size={14} />
        <div>{HIT_NOTE_TRIAL}</div>
      </div>
    </section>
  );
}