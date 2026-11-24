import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Page, PageHead, Panel, Empty, Field, BusyProgress, Icons } from '../components/ui';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { useConfirm } from '../components/confirm';
import { useCollection } from '../hooks/useCollection';
import { newId } from '../utils/id';
import { formatRecent } from '../utils/time';
import {
  buildCoverage, assertCoverageConsistency, coveragePercent, trimCoverageItems,
  UNKNOWN_REASON_TEXT, type CoverageRef, type CoverageResult, type CoverageState,
} from '../utils/coverage';
import {
  importCaseMapsCsv, buildManualEntry, caseMapSummary, isCaseMapCsvFile, unsupportedFileMessage,
  CASE_MAP_LIMITS, CASE_MAP_UNSUPPORTED_MSG, type CaseMapEntry, type ImportReport,
} from '../utils/caseMaps';
import { trimToCaps, capsOf, trimNotice } from '../utils/collectionTrim';
import type { ApiRequest } from '../types';

/**
 * 资产台账（开发辅助）—— 模块 4.1 覆盖矩阵 + 4.2 用例映射。
 *
 * 两条口径贯穿全页（都是"不这么做用户就不会信这个数字"的那类）：
 *
 * 1. **覆盖矩阵永远给分子/分母，不给裸百分比**（[C-32]）。`覆盖 3/5` 与 `60%` 信息量不同：
 *    接口集合只有 5 个时，60% 可能意味着"漏导入了 40 个接口"，光看百分比看不出来。
 *    三态合计必须等于接口总数（[C-31]），不成立就当场标红并拒绝落库。
 * 2. **用例映射的写入点必须先 `trimToCaps`**（[C-24]/[C-25]，v10 更正落点后由本页落地）。
 *    `dropped > 0` 时界面必须出现「历史记录已按上限裁剪，最早 N 条已清理」——
 *    静默丢数据是这类工具最不可接受的失败模式。
 *
 * 视觉：三态标签用 `.dev-tag`（`is-ok` / `is-fail` / `is-heur`），**不用 `.pill-*`**；
 * 大表一律套 `.dev-scroll`（`.pnl` 是 `overflow:hidden`，不套会把右侧列裁掉）；
 * 表格 `tableLayout:'fixed'` + 内联列宽。全页不写 css、不改 `src/types.ts`。
 */

const TABS = [
  { id: 'coverage', label: '覆盖矩阵' },
  { id: 'caseMap', label: '用例映射' },
] as const;

type TabId = typeof TABS[number]['id'];

/** 三态 → `.dev-tag` 变体 + 中文名 */
const STATE_META: Record<CoverageState, { cls: string; label: string }> = {
  covered: { cls: 'is-ok', label: '已覆盖' },
  missing: { cls: 'is-fail', label: '未覆盖' },
  unknown: { cls: 'is-heur', label: '无法判定' },
};

export function AssetLedger() {
  const [tab, setTab] = useState<TabId>('coverage');
  const { toasts, addToast, removeToast } = useToast();
  const { ask, confirmNode } = useConfirm();

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.list size={16} />}
          title="资产台账"
          desc="接口集合与代码引用对齐成覆盖矩阵，再把用例编号映射到具体脚本上。台账支持手工维护与规范化 CSV 导入。"
        />

        <div className="tabs" role="tablist" aria-label="资产台账">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`assetledger-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`assetledger-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab2${tab === t.id ? ' is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div role="tabpanel" id={`assetledger-panel-${tab}`} aria-labelledby={`assetledger-tab-${tab}`}>
          {tab === 'coverage'
            ? <CoverageTab addToast={addToast} />
            : <CaseMapTab addToast={addToast} ask={ask} />}
        </div>
      </Page>
      {confirmNode}
    </div>
  );
}

/* ================================================================
   页签①：覆盖矩阵
   ================================================================ */

/** `scan:run` 的返回（types.ts 里是 unknown，收窄由 W5 负责：契约 [C-46]） */
interface ScanRunData {
  root?: string;
  files?: number;
  fileList?: string[];
  bytes?: number;
  skippedSymlinks?: number;
  truncated?: boolean;
  truncatedReason?: string;
  counts?: Record<string, number>;
  findings?: Array<{ ruleId?: string; file?: string; line?: number; snippet?: string; method?: string; path?: string }>;
  ms?: number;
}

function CoverageTab({ addToast }: { addToast: (msg: string, type?: 'info' | 'success' | 'error') => void }) {
  const [root, setRoot] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [scan, setScan] = useState<ScanRunData | null>(null);
  const [result, setResult] = useState<CoverageResult | null>(null);
  const [endpointCount, setEndpointCount] = useState(0);
  const [savedNotice, setSavedNotice] = useState('');
  const [filter, setFilter] = useState<'' | CoverageState>('');

  const pickRoot = async () => {
    const r = await window.electronAPI.scanPickRoot();
    if (!r.success) {
      if (!r.canceled) addToast(r.error || '选择目录失败', 'error');
      return;
    }
    setRoot(r.data?.dir || '');
  };

  const run = async () => {
    if (!root) {
      setErr('还没有选代码目录：先点「选择目录」');
      return;
    }
    setBusy(true);
    setErr('');
    setResult(null);
    setScan(null);
    setSavedNotice('');
    try {
      // 1) 接口集合（分母的来源）：apiRequests 是接口调试页维护的那份
      const epRes = await window.electronAPI.wsGet('apiRequests');
      if (!epRes.success) {
        setErr(epRes.error || '读取接口集合失败（库可能已锁定）');
        return;
      }
      const endpoints = (Array.isArray(epRes.data) ? epRes.data : []) as ApiRequest[];
      setEndpointCount(endpoints.length);
      if (!endpoints.length) {
        setErr('接口集合是空的：先去「接口调试」导入或新建接口，否则覆盖矩阵没有分母');
        return;
      }

      // 2) 代码引用（只取路径原文，归一化在 coverage.ts）
      const token = newId('cov-');
      const scanRes = await window.electronAPI.scanRun({ root, pack: 'coverage', token });
      if (!scanRes.success) {
        if (scanRes.canceled) { addToast('已取消扫描', 'info'); return; }
        setErr(scanRes.error || '扫描失败');
        return;
      }
      const data = (scanRes.data || {}) as ScanRunData;
      setScan(data);

      const refs: CoverageRef[] = (data.findings || []).map((f) => ({
        method: f.method,
        path: f.path,
        file: f.file,
        line: f.line,
        snippet: f.snippet,
        ruleId: f.ruleId,
      }));

      // 3) 三态矩阵
      const built = buildCoverage({
        endpoints: endpoints.map((e) => ({ id: e.id, name: e.name, group: e.group, method: e.method, url: e.url })),
        refs,
        baseUrl: baseUrl.trim() || undefined,
      });
      setResult(built);

      const bad = assertCoverageConsistency(built.summary);
      if (bad) {
        setErr(bad);
        return; // [C-31]：不成立就不保存
      }

      // 4) 落一条 coverageRuns（走 [C-24]/[C-25] 的裁剪，dropped 必须说给用户）
      const trimmed = trimCoverageItems(built.items, 5000);
      const record = {
        id: newId('cov-'),
        at: new Date().toISOString(),
        root: data.root || root,
        files: Number(data.files) || 0,
        total: built.summary.total,
        covered: built.summary.covered,
        missing: built.summary.missing,
        undetermined: built.summary.undetermined,
        items: trimmed.items,
        truncated: !!trimmed.truncated || !!data.truncated,
        ...(data.ms ? { ms: data.ms } : {}),
        updatedAt: new Date().toISOString(),
      };
      const prev = await window.electronAPI.wsGet('coverageRuns');
      const list = Array.isArray(prev.data) ? prev.data : [];
      const caps = capsOf('coverageRuns');
      const cut = trimToCaps([record, ...list], caps, { timeOf: (x: unknown) => (x as { at?: string }).at });
      const written = await window.electronAPI.wsSet('coverageRuns', cut.items);
      if (!written.success) {
        addToast(written.error || '保存覆盖记录失败', 'error');
        return;
      }
      const notices: string[] = [`三态合计 ${built.summary.total} = 接口总数 ${built.summary.total}`];
      if (cut.dropped) notices.push(trimNotice(cut.dropped));
      if (trimmed.truncated) notices.push('单条记录超过 5000 项，未覆盖项已截断（只展示前 N 条未覆盖项）');
      setSavedNotice(notices.join('；'));
      addToast(`覆盖矩阵：${built.summary.covered}/${built.summary.total} 已覆盖`, 'success');
    } catch (e) {
      setErr('运行失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const rows = useMemo(() => {
    if (!result) return [];
    return filter ? result.items.filter((i) => i.state === filter) : result.items;
  }, [result, filter]);

  return (
    <div>
      {busy && <BusyProgress active label="扫描代码并比对接口…" />}

      <Panel
        title="① 取数与运行"
        meta={scan ? `扫描 ${scan.files ?? 0} 个文件 · ${scan.ms ?? 0} ms` : undefined}
        tools={
          <div className="tool-inline" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void pickRoot()} disabled={busy}>
              <Icons.folder size={13} /> 选择目录
            </button>
            <button className="btn btn-primary btn-sm" onClick={() => void run()} disabled={busy}>
              <Icons.refresh size={13} /> 运行覆盖矩阵
            </button>
          </div>
        }
      >
        <div className="grid2" style={{ gap: 12 }}>
          <Field label="代码目录" hint="扫描根目录：只读、只抽路径原文，不改任何文件">
            <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="先用「选择目录」挑一个" />
          </Field>
          <Field label="接口 baseURL（可选）" hint="填了会从绝对 URL 里剥掉这个前缀，让 https://host/v1 与 /v1 两种写法能对上">
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com/v1" />
          </Field>
        </div>

        <div className="text-sm text-muted" style={{ marginTop: 6 }}>
          接口集合来自「接口调试」的 apiRequests（当前 {endpointCount || '—'} 个）；代码引用来自扫描
          <code> pack=coverage </code>
          的取数规则（Spring 注解 / 链式调用 / requests / 路径字面量）。
        </div>

        {err && (
          <div className="dev-banner is-error" role="alert" style={{ marginTop: 8 }}>
            <Icons.bug size={14} />
            <div className="text-sm">{err}</div>
          </div>
        )}

        {savedNotice && (
          <div className="dev-banner is-info" style={{ marginTop: 8 }}>
            <Icons.check size={14} />
            <div className="text-sm">{savedNotice}</div>
          </div>
        )}
      </Panel>

      {result && (
        <Panel title="② 覆盖矩阵" meta={`${result.summary.total} 个接口`}>
          {/* 三态统计：**永远同时给分子/分母**（[C-32] 禁止只给百分比） */}
          <div className="tool-inline" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
            <span className="dev-tag is-ok">
              <Icons.check size={13} /> 已覆盖 {result.summary.covered}/{result.summary.total}
            </span>
            <span className="dev-tag is-fail">
              <Icons.close size={13} /> 未覆盖 {result.summary.missing}/{result.summary.total}
            </span>
            <span className="dev-tag is-heur">
              <Icons.bug size={13} /> 无法判定 {result.summary.undetermined}/{result.summary.total}
            </span>
            <span className="dev-tag is-unknown">
              <Icons.chart size={13} /> 覆盖率 {coveragePercent(result.summary)}%（{result.summary.covered}/{result.summary.total}）
            </span>
            <span className={`dev-tag ${assertCoverageConsistency(result.summary) ? 'is-fail' : 'is-ok'}`}>
              <Icons.list size={13} />
              {`三态合计 ${result.summary.covered + result.summary.missing + result.summary.undetermined} = 接口总数 ${result.summary.total}`}
            </span>
            {result.skippedStatic > 0 && (
              <span className="dev-tag is-unverified">
                <Icons.image size={13} /> 另有 {result.skippedStatic} 个静态资源已排除
              </span>
            )}
          </div>

          {scan && (scan.truncated || scan.skippedSymlinks) ? (
            <div className="dev-banner is-warn" style={{ marginBottom: 8 }}>
              <Icons.bug size={14} />
              <div className="text-sm">
                {scan.files ?? 0} 个文件
                {scan.skippedSymlinks ? `，跳过 ${scan.skippedSymlinks} 个符号链接` : ''}
                {scan.truncated ? `，结果被截断（${scan.truncatedReason || '上限'}）` : ''}
                —— 覆盖统计可能偏低，先看这条再决定要不要补用例。
              </div>
            </div>
          ) : null}

          {result.warnings.length > 0 && (
            <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
              {result.warnings.map((w) => (
                <div className="dev-banner is-warn" key={w}>
                  <Icons.bug size={14} />
                  <div className="text-sm">{w}</div>
                </div>
              ))}
            </div>
          )}

          <div className="tool-inline" style={{ gap: 8, marginBottom: 8 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value as '' | CoverageState)} aria-label="按状态筛选">
              <option value="">全部（{result.items.length}）</option>
              <option value="covered">只看已覆盖（{result.summary.covered}）</option>
              <option value="missing">只看未覆盖（{result.summary.missing}）</option>
              <option value="unknown">只看无法判定（{result.summary.undetermined}）</option>
            </select>
            <span className="text-sm text-muted">无法判定的行必须看「原因」列：它决定你是去补代码，还是去补接口集合。</span>
          </div>

          {result.items.length === 0
            ? (
              <Empty
                icon={<Icons.inbox size={22} />}
                title="矩阵是空的"
                desc="接口集合为空，或全部被判定为静态资源排除掉了。"
                hint="先去「接口调试」导入接口，再回来跑一次。"
              />
            )
            : (
              <div className="dev-scroll" style={{ maxHeight: 460 }}>
                <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 78 }}>方法</th>
                      <th scope="col">接口路径</th>
                      <th scope="col" style={{ width: 104 }}>状态</th>
                      <th scope="col" style={{ width: 320 }}>命中位置 / 原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((it, i) => {
                      const meta = STATE_META[it.state];
                      return (
                        <tr key={`${it.method}-${it.path}-${i}`}>
                          <td>{it.method}</td>
                          <td title={it.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {it.path || '（空路径）'}
                            {it.name ? <span className="text-sm text-muted"> · {it.name}</span> : null}
                          </td>
                          <td><span className={`dev-tag ${meta.cls}`}>{meta.label}</span></td>
                          <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {it.state === 'covered'
                              ? <span title={it.ref}>{it.ref || '—'}</span>
                              : it.state === 'unknown'
                                ? <span title={it.reason}>{it.reason || UNKNOWN_REASON_TEXT['unrecognized-call']}</span>
                                : <span className="text-sm text-muted">代码里没有对它的调用</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
        </Panel>
      )}

      {!result && !err && (
        <Panel title="② 覆盖矩阵">
          <Empty
            icon={<Icons.chart size={22} />}
            title="还没有跑过覆盖矩阵"
            desc="先选代码目录，再点「运行覆盖矩阵」。接口集合来自接口调试，代码引用来自只读扫描。"
            hint="结果会按三态展示：已覆盖 / 未覆盖 / 无法判定（无法判定一定带原因，不会给你一个空单元格）。"
          />
        </Panel>
      )}
    </div>
  );
}

/* ================================================================
   页签②：用例映射
   ================================================================ */

function CaseMapTab({
  addToast,
  ask,
}: {
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void;
  ask: (opts: { title: string; message?: string; confirmText?: string; onOk: () => void }) => void;
}) {
  const { items, save, loading } = useCollection<CaseMapEntry>('caseMaps');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState<{ id?: string; caseNo: string; caseTitle: string; targetRef: string; note: string }>({
    caseNo: '', caseTitle: '', targetRef: '', note: '',
  });

  const summary = useMemo(() => caseMapSummary(items), [items]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => `${it.caseNo} ${it.caseTitle || ''} ${it.target.ref} ${it.note || ''}`.toLowerCase().includes(q));
  }, [items, query]);

  /** 统一的写入口：**先裁剪再写**，dropped 必须说出来（[C-24]/[C-25]） */
  const writeAll = useCallback(async (next: CaseMapEntry[]): Promise<boolean> => {
    const caps = capsOf('caseMaps');
    const cut = trimToCaps(next, caps, { timeOf: (x) => (x as CaseMapEntry).updatedAt });
    const r = await save(cut.items);
    if (!r.success) {
      setErr(r.error || '写入失败');
      addToast(r.error || '写入失败', 'error');
      return false;
    }
    if (cut.dropped) {
      const msg = trimNotice(cut.dropped);
      setNotice(msg);
      addToast(msg, 'info');
    }
    return true;
  }, [addToast, save]);

  const submitDraft = async () => {
    const built = buildManualEntry(
      { id: draft.id, caseNo: draft.caseNo, caseTitle: draft.caseTitle, targetRef: draft.targetRef, note: draft.note },
      items,
    );
    if (built.error || !built.entry) {
      setErr(built.error || '校验失败');
      return;
    }
    setErr('');
    const exists = items.some((it) => it.id === built.entry!.id);
    const next = exists ? items.map((it) => (it.id === built.entry!.id ? built.entry! : it)) : [built.entry, ...items];
    if (await writeAll(next)) {
      setDraft({ caseNo: '', caseTitle: '', targetRef: '', note: '' });
      addToast(exists ? '映射已更新' : '映射已新增', 'success');
    }
  };

  const editRow = (it: CaseMapEntry) => {
    setDraft({ id: it.id, caseNo: it.caseNo, caseTitle: it.caseTitle || '', targetRef: it.target.ref, note: it.note || '' });
    setErr('');
  };

  const removeRow = (it: CaseMapEntry) => {
    ask({
      title: '删除用例映射',
      message: `确定删除「${it.caseNo}」（→ ${it.target.ref}）？只删这条映射，不动用例与脚本本身。`,
      confirmText: '删除',
      onOk: () => { void writeAll(items.filter((x) => x.id !== it.id)).then((ok) => ok && addToast('已删除', 'success')); },
    });
  };

  /**
   * CSV 导入。
   *
   * 对话框**故意把 xmind/xlsx 也列出来**：只过滤 .csv 的话用户选不到 xmind，也就永远看不到那句
   * 「不支持 xmind/Excel 解析」的说明——他会以为工具坏了。选到非 CSV 就只给固定文案，不尝试解析（[C-36]）。
   */
  const importCsv = async () => {
    const picked = await window.electronAPI.pickFile('选择用例映射 CSV', [
      { name: '规范化 CSV', extensions: ['csv'] },
      { name: '其它（不支持解析，仅用于确认提示）', extensions: ['xmind', 'xlsx', 'xls'] },
    ]);
    if (!picked.success) {
      if (!picked.canceled) addToast(picked.error || '选择文件失败', 'error');
      return;
    }
    const file = picked.data?.file || '';
    const name = picked.data?.name || file;
    if (!isCaseMapCsvFile(name)) {
      setReport(null);
      setErr(unsupportedFileMessage(name));
      addToast(CASE_MAP_UNSUPPORTED_MSG, 'error');
      return;
    }
    const read = await window.electronAPI.readTextFile(file);
    if (!read.success || !read.data) {
      setErr(read.error || '读取文件失败');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      // 读文件可能很慢，先让界面转一圈（按钮 disabled + BusyProgress）
      await new Promise((r) => setTimeout(r, 0));
      const result = importCaseMapsCsv(read.data.text, items);
      setReport(result.report);
      if (result.report.errors.length) setErr(result.report.errors.join('；'));
      const ok = await writeAll(result.items);
      if (ok) {
        addToast(
          `导入完成：新增 ${result.report.added} / 更新 ${result.report.updated} / 合并 ${result.report.merged} / 跳过 ${result.report.skipped} / 无效 ${result.report.invalid}`,
          result.report.invalid ? 'info' : 'success',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {busy && <BusyProgress active label="导入中…" />}

      <Panel
        title="① 导入 / 统计"
        meta={loading ? '加载中…' : `${summary.total}/${CASE_MAP_LIMITS.maxItems}`}
        tools={
          <div className="tool-inline" style={{ gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => void importCsv()} disabled={busy || loading}>
              <Icons.upload size={13} /> 导入 CSV
            </button>
          </div>
        }
      >
        <div className="tool-inline" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
          <span className="dev-tag is-ok"><Icons.list size={13} /> 共 {summary.total} 条</span>
          <span className="dev-tag is-unknown"><Icons.folder size={13} /> 映射到文件 {summary.file}</span>
          <span className="dev-tag is-unknown"><Icons.terminal size={13} /> 映射到方法 {summary.method}</span>
          <span className="dev-tag is-unverified"><Icons.upload size={13} /> CSV 来源 {summary.csv}</span>
          <span className="dev-tag is-unverified"><Icons.pencil size={13} /> 手工维护 {summary.manual}</span>
        </div>

        <div className="text-sm text-muted">
          只支持**规范化 CSV**（表头可用中文或英文：用例编号 / 用例标题 / 脚本 / 类型 / 备注）。
          选到 .xmind 或 .xlsx 会直接给出「{CASE_MAP_UNSUPPORTED_MSG}」，不做任何尝试性解析。
          以「用例编号」为幂等键：重复导入是更新而不是新增。
        </div>

        {err && (
          <div className="dev-banner is-error" role="alert" style={{ marginTop: 8 }}>
            <Icons.bug size={14} />
            <div className="text-sm">{err}</div>
          </div>
        )}

        {notice && (
          <div className="dev-banner is-warn" style={{ marginTop: 8 }} role="status">
            <Icons.clock size={14} />
            <div className="text-sm">{notice}</div>
          </div>
        )}

        {report && (
          <div className="dev-banner is-info" style={{ marginTop: 8 }} role="status">
            <Icons.check size={14} />
            <div className="text-sm">
              导入结果：数据行 {report.rows} 行 → 新增 {report.added} / 更新 {report.updated}（其中合并 {report.merged}）/
              跳过 {report.skipped} / 无效 {report.invalid}
              {report.added + report.updated + report.skipped + report.invalid === report.rows ? ' · 计数自洽' : ' · ⚠ 计数不自洽'}
            </div>
          </div>
        )}
      </Panel>

      <Panel title={draft.id ? '② 编辑映射' : '② 新增映射'} meta={draft.caseNo || undefined}>
        <div className="grid2" style={{ gap: 12 }}>
          <Field label="用例编号（必填）" hint="集合内唯一；重复导入时按它更新">
            <input value={draft.caseNo} onChange={(e) => setDraft({ ...draft, caseNo: e.target.value })} placeholder="TC-001" maxLength={CASE_MAP_LIMITS.caseNo} />
          </Field>
          <Field label="用例标题（可选）">
            <input value={draft.caseTitle} onChange={(e) => setDraft({ ...draft, caseTitle: e.target.value })} placeholder="登录成功" maxLength={CASE_MAP_LIMITS.caseTitle} />
          </Field>
          <Field label="脚本（必填）" hint="文件路径，或「文件#方法」；带 # 会按方法级映射">
            <input value={draft.targetRef} onChange={(e) => setDraft({ ...draft, targetRef: e.target.value })} placeholder="src/test/java/LoginTest.java#testLogin" maxLength={CASE_MAP_LIMITS.targetRef} />
          </Field>
          <Field label="备注（可选）">
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="对应哪条流程" maxLength={CASE_MAP_LIMITS.note} />
          </Field>
        </div>
        <div className="tool-inline" style={{ gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary btn-sm" onClick={() => void submitDraft()} disabled={busy}>
            <Icons.check size={13} /> {draft.id ? '保存修改' : '新增映射'}
          </button>
          {draft.id && (
            <button className="btn btn-ghost btn-sm" onClick={() => setDraft({ caseNo: '', caseTitle: '', targetRef: '', note: '' })}>
              取消编辑
            </button>
          )}
        </div>
      </Panel>

      <Panel
        title="③ 映射清单"
        meta={`${filtered.length}/${items.length}`}
        tools={
          <div className="tool-inline" style={{ gap: 8 }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜编号 / 标题 / 脚本 / 备注"
              aria-label="筛选用例映射"
            />
          </div>
        }
      >
        {loading
          ? <div className="text-sm text-muted">正在读加密库…</div>
          : items.length === 0
            ? (
              <Empty
                icon={<Icons.inbox size={22} />}
                title="还没有用例映射"
                desc="上面手工新增一条，或导入一份规范化 CSV。"
                hint="映射存在加密库里（caseMaps 集合），跟着库走；换机器导库就带走。"
              />
            )
            : (
              <div className="dev-scroll" style={{ maxHeight: 460 }}>
                <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: 120 }}>用例编号</th>
                      <th scope="col" style={{ width: 180 }}>标题</th>
                      <th scope="col">脚本</th>
                      <th scope="col" style={{ width: 88 }}>类型</th>
                      <th scope="col" style={{ width: 76 }}>来源</th>
                      <th scope="col" style={{ width: 96 }}>更新时间</th>
                      <th scope="col" style={{ width: 108 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((it) => (
                      <tr key={it.id}>
                        <td>{it.caseNo}</td>
                        <td title={it.caseTitle} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.caseTitle || '—'}</td>
                        <td title={it.target.ref} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.target.ref}</td>
                        <td>
                          <span className={`dev-tag ${it.target.kind === 'method' ? 'is-ok' : 'is-unknown'}`}>
                            {it.target.kind === 'method' ? '方法' : '文件'}
                          </span>
                        </td>
                        <td><span className={`dev-tag ${it.source === 'csv' ? 'is-unverified' : 'is-heur'}`}>{it.source === 'csv' ? 'CSV' : '手工'}</span></td>
                        <td>{it.updatedAt ? formatRecent(it.updatedAt) : '—'}</td>
                        <td>
                          <div className="tool-inline" style={{ gap: 4 }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => editRow(it)} title="编辑" aria-label={`编辑 ${it.caseNo}`}>
                              <Icons.pencil size={13} />
                            </button>
                            <button className="btn btn-ghost btn-sm" onClick={() => removeRow(it)} title="删除" aria-label={`删除 ${it.caseNo}`}>
                              <Icons.trash size={13} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
      </Panel>
    </div>
  );
}