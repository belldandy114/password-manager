import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconStar, IconStarFilled } from '@tabler/icons-react';
import type { Note } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useStore } from '../store/useStore';
import { Modal } from '../components/Modal';
import { CopyVarsModal } from '../components/CopyVarsModal';
import { ToastContainer } from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../components/confirm';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons } from '../components/ui';
import { formatRecent } from '../utils/time';
import { getTagHue } from '../utils/tagColors';
import { extractVars, mergeVarHint, parseVarHint, sanitizeVarName, wrapSelection, upsertVarHint } from '../utils/sqlVars';
import { kindDecidedByName } from '../utils/noteKind';
import {
  noteFromSqlFile, sqlFileText, sqlFileName, uniqueSqlFileName, titleOfSqlFile, dirNameOf,
} from '../utils/sqlFrontmatter';

/* ============================================================
   SQL 片段独立页（1.30.2）

   数据就住在 `notes` 集合里（`kind === 'sql'` 的条目），只是从笔记页里
   **拆出来单独给出入口和字段**：
   - 笔记页过滤掉 sql，避免同一批片段两个入口（见 Notes.tsx 的 visibleItems）
   - 这里多出 dbOrEnv / varHint / remark / starred 四个字段（types.ts 的 Note，
     全部可选、缺省 = 空，老条目不需要迁移）
   - 1.31.x：复制改成「填充变量并复制」——弹窗按正文里 `{{变量}}` 出现顺序生成输入框，
     填完替换后再进剪贴板；留空的变量保留原样。纯逻辑在 utils/sqlVars.ts。
     「复制原文」按钮仍在，两条路径独立（原文不做任何替换）。

   目录模式（笔记以 `标题.sql.md` 文件存盘）本期只给提示、不渲染表格：
   文件模式的类型与正文都归笔记页管，这里再读写一遍会变成两套数据源。
   ============================================================ */

/** 目录模式的判据：沿用笔记页那个 localStorage 键（Notes.tsx 的 LS_DIR），不新增设置项 */
const DIR_KEY = 'pm.notes.dir';

const SORTS = [
  { id: 'recent', label: '最近修改' },
  { id: 'title', label: '名称' },
] as const;
export type SqlSort = typeof SORTS[number]['id'];

/** 筛选状态：左侧栏只有一个选中项（全部 / 收藏 / 某个标签） */
export interface SqlFilter {
  /** 搜索词：标题 + 正文 + 标签 */
  q?: string;
  /** 只看某个标签（空 = 不限） */
  tag?: string;
  /** 只看收藏 */
  starredOnly?: boolean;
}

/* ---------------- 纯函数（导出给单测，页面逻辑全部走它们） ---------------- */

/**
 * 本周一 00:00 的时间戳（本地时区，周一为一周起点）。
 * 周日属于「上一周」的尾巴：getDay()=0 → 回退 6 天。
 */
export function startOfWeek(now: Date = new Date()): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/** 只认 kind === 'sql'：普通笔记与周报片段（kind='weekly'）都不进这一页 */
export function sqlOnly(notes: Note[] | null | undefined): Note[] {
  return (notes || []).filter(n => n.kind === 'sql');
}

/** KPI 三卡的口径：全部 / 收藏 / 本周新增（本周 = updatedAt >= 本周一 00:00） */
export function countSql(notes: Note[] | null | undefined, now: Date = new Date()): { all: number; starred: number; week: number } {
  const list = sqlOnly(notes);
  const since = startOfWeek(now);
  let week = 0;
  for (const n of list) {
    const t = Date.parse(n.updatedAt || '');
    if (!Number.isNaN(t) && t >= since) week += 1;
  }
  return { all: list.length, starred: list.filter(n => n.starred === true).length, week };
}

/** 搜索命中：标题 / SQL 正文 / 标签三路，大小写不敏感 */
export function matchSql(n: Note, q: string): boolean {
  const key = String(q || '').trim().toLowerCase();
  if (!key) return true;
  return [n.title, n.content, (n.tags || []).join(' ')].some(v => String(v || '').toLowerCase().includes(key));
}

/** 先按 sql 过滤，再叠「收藏 / 标签 / 搜索」三个条件 */
export function filterSql(notes: Note[] | null | undefined, f: SqlFilter = {}): Note[] {
  return sqlOnly(notes).filter(n => {
    if (f.starredOnly && n.starred !== true) return false;
    if (f.tag && !(n.tags || []).includes(f.tag)) return false;
    return matchSql(n, f.q || '');
  });
}

/** 排序：名称按中文 localeCompare 升序；最近修改按 updatedAt 降序（默认） */
export function sortSql(notes: Note[], sort: SqlSort): Note[] {
  const list = [...notes];
  if (sort === 'title') {
    list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh'));
  } else {
    list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  }
  return list;
}

/** 每个标签下有多少条（左侧栏计数） */
export function countByTag(notes: Note[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of sqlOnly(notes)) {
    for (const t of n.tags || []) {
      if (t) out[t] = (out[t] || 0) + 1;
    }
  }
  return out;
}

/** 所有标签的并集（按中文序） */
export function tagsOf(notes: Note[] | null | undefined): string[] {
  return Object.keys(countByTag(notes)).sort((a, b) => a.localeCompare(b, 'zh'));
}

/**
 * 「库 / 环境」已有值：已有片段里出现过的 dbOrEnv，按出现次数降序、去重、最多 `max` 个。
 *
 * 用途是编辑弹窗输入框下方的可点标签 —— ⚠️ **不用 `<datalist>`**：AGENTS.md 记录它会在
 * 输入框聚焦时候选项更新时让 Chromium 直接崩溃（0xC0000005，无 JS 报错）。
 * 组合值（`test_order / 预发`）本身就是合法值，不做解析；大小写敏感
 * （`TEST_ORDER` 与 `test_order` 是两个真实库名）。同票按首次出现顺序，顺序稳定。
 */
export function dbEnvValues(notes: Note[] | null | undefined, max = 8): string[] {
  const seen = new Map<string, { count: number; first: number }>();
  let index = 0;
  for (const n of sqlOnly(notes)) {
    const v = String(n.dbOrEnv || '').trim();
    if (!v) continue;
    const hit = seen.get(v);
    if (hit) hit.count += 1;
    else seen.set(v, { count: 1, first: index });
    index += 1;
  }
  return [...seen.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[1].first - b[1].first)
    .slice(0, Math.max(0, Math.floor(Number(max) || 0)))
    .map(([v]) => v);
}

const newId = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `sql-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
);

const splitTags = (raw: string): string[] => raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);

/* ---------------- 导出 Markdown（1.31：只导，不做导入） ---------------- */

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * 时间戳 → `YYYY-MM-DD HH:mm`（本地时区）。
 * 坏值 / 空值返回空串，调用方据此**整行省略**「更新时间」，不留空冒号。
 */
export function fmtStamp(iso: string | null | undefined): string {
  const d = new Date(String(iso || ''));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 导出文件名：`SQL片段-YYYYMMDD-HHmm.md`（本地时区，与「更新时间」同口径） */
export function exportFileName(now: Date = new Date()): string {
  return `SQL片段-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}.md`;
}

/**
 * 把一批片段拼成 Markdown（纯函数；格式写死，回归直接比字符串）。
 *
 * 每个片段长这样（字段顺序固定）：
 *
 *   ## 名称
 *   - 库/环境：test_order / 预发
 *   - 变量：{{orderNo}} = 订单号
 *   - 备注：只读，别在生产跑
 *   - 标签：订单, 造数
 *   - 更新时间：2026-11-21 12:05
 *
 *   ```sql
 *   SELECT ...
 *   ```
 *
 * 规则：
 * - **空字段整行省略**（没有「- 备注：」这种空冒号行）；
 * - 正文原样放进代码块，**不转义、不替换 `{{变量}}`**（本期没有变量引擎）；
 * - 片段之间用 `---` 分隔，前后各留一个空行 —— 否则 Markdown 不会渲染成分隔线；
 * - 顺序 = 传入顺序（排序是调用方的事，这里不偷偷重排）。
 */
export function buildSqlMarkdown(items: Note[] | null | undefined): string {
  const list = Array.isArray(items) ? items : [];
  const head = `# SQL 片段（${list.length} 条）`;
  if (list.length === 0) return `${head}\n\n（没有可导出的片段）\n`;
  const blocks = list.map(n => {
    // 名称里的换行会把 `##` 标题拆掉，压成一行
    const title = String(n.title || '').replace(/\s+/g, ' ').trim() || '（未命名）';
    const fields: string[] = [];
    const db = String(n.dbOrEnv || '').trim();
    if (db) fields.push(`- 库/环境：${db}`);
    const vars = String(n.varHint || '').trim();
    if (vars) fields.push(`- 变量：${vars}`);
    const remark = String(n.remark || '').trim();
    if (remark) fields.push(`- 备注：${remark}`);
    const tags = (n.tags || []).map(t => String(t || '').trim()).filter(Boolean);
    if (tags.length > 0) fields.push(`- 标签：${tags.join(', ')}`);
    const at = fmtStamp(n.updatedAt);
    if (at) fields.push(`- 更新时间：${at}`);
    return [`## ${title}`, ...fields, '', '```sql', String(n.content || ''), '```'].join('\n');
  });
  return `${head}\n\n${blocks.join('\n\n---\n\n')}\n`;
}

/* ---------------- 页面 ---------------- */

export function SqlSnippets({ onNavigate }: { onNavigate?: (page: string) => void } = {}) {
  return (
    <div className="content-area">
      <Page>
        <SqlSnippetsBody onNavigate={onNavigate} />
      </Page>
    </div>
  );
}

export function SqlSnippetsBody({ onNavigate }: { onNavigate?: (page: string) => void } = {}) {
  const { items: vaultItems, save, loading: vaultLoading, reload: reloadVault } = useCollection<Note>('notes');
  const { ask, confirmNode } = useConfirm();
  /**
   * 目录模式（1.31）：`localStorage.pm.notes.dir` 有值就走目录里的 `.sql.md` 文件。
   * 挂载时定一次 —— 切目录要走笔记页，本页不自带目录选择器。
   */
  const [dir] = useState(() => {
    try { return localStorage.getItem(DIR_KEY) || ''; } catch { return ''; }
  });
  const dirMode = !!dir;
  const [dirItems, setDirItems] = useState<Note[]>([]);
  const [dirLoading, setDirLoading] = useState(dirMode);
  const [dirError, setDirError] = useState('');

  /** 两个数据源共用同一套列表 / 搜索 / 排序 / KPI：只是 items 的来源不同 */
  const items = dirMode ? dirItems : vaultItems;
  const loading = dirMode ? dirLoading : vaultLoading;

  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [sort, setSort] = useState<SqlSort>('recent');
  const [editing, setEditing] = useState<Note | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  /** 页面级提示一律走全局 toast（右上浮层、3 秒自动消失），不再在列表上方插一行文字 */
  const { toasts, addToast, removeToast } = useToast();
  const snippetSeed = useStore(s => s.snippetSeed);
  const consumeSnippetSeed = useStore(s => s.consumeSnippetSeed);

  /**
   * 提示条走全局 toast：右上浮层、3 秒自动消失、点一下可提前关掉。
   * 以前是页面里插一行 `.inline-hint`（会把列表往下顶、还得自己做定时器去清），
   * 现在与工作台 / 工具箱等页面同一套观感。类型决定左侧色条与图标。
   */
  const flash = (msg: string, type: 'success' | 'error' | 'info' = 'success') => addToast(msg, type);

  /**
   * 读目录：只认 `.sql.md`（`kindDecidedByName`，utils/noteKind.ts 既有规则），
   * 再逐篇读回来解析 frontmatter。目录里可能有几百篇笔记，但只读这几篇片段。
   *
   * 用到的 IPC：`notesList` / `notesRead`（现有通道，未新增 IPC）。
   */
  const loadDir = useCallback(async () => {
    if (!dir) return;
    setDirLoading(true);
    setDirError('');
    const list = await window.electronAPI.notesList(dir);
    if (!list.success) {
      setDirError(list.error || '读取目录失败');
      setDirItems([]);
      setDirLoading(false);
      return;
    }
    const names = (list.data || []).map(f => f.name).filter(n => kindDecidedByName(n));
    const out: Note[] = [];
    for (const name of names) {
      const r = await window.electronAPI.notesRead(dir, name);
      if (r.success && r.data) out.push(noteFromSqlFile(name, r.data.content, r.data.mtime));
    }
    setDirItems(out);
    setDirLoading(false);
  }, [dir]);

  useEffect(() => { if (dirMode) void loadDir(); }, [dirMode, loadDir]);

  const kpi = useMemo(() => countSql(items), [items]);
  const tags = useMemo(() => tagsOf(items), [items]);
  const tagCounts = useMemo(() => countByTag(items), [items]);
  const rows = useMemo(
    () => sortSql(filterSql(items, { q, tag, starredOnly }), sort),
    [items, q, tag, starredOnly, sort],
  );

  /** 复制弹窗的目标片段（fillVars / 变量说明 / 剪贴板都在 CopyVarsModal 里） */
  const [copyTarget, setCopyTarget] = useState<Note | null>(null);

  /** 已有片段里出现过的「库 / 环境」值：编辑弹窗下方给可点标签（⚠️ 不是 datalist） */
  const dbEnvOptions = useMemo(() => dbEnvValues(items), [items]);

  /**
   * 「变量说明」一键生成：按正文里的 `{{变量}}` 补 `{{name}} = ` 模板。
   * 纯函数 mergeVarHint 负责「已有释义原样保留 + 缺的追加 + 幂等」，这里只做接线。
   * 正文里没有变量时按钮 disabled（见变量说明那一行的 JSX）。
   */
  const editingVars = useMemo(() => extractVars(editing?.content || ''), [editing?.content]);
  const genVarHint = () => {
    if (!editing) return;
    setEditing({ ...editing, varHint: mergeVarHint(editing.varHint || '', editingVars) });
  };

  /**
   * 「转化为变量」：把 SQL 里**选中的那一段**包成 `{{名字}}`，并顺手把「名字 = 说明」写进变量说明。
   *
   * 选区在点击那一刻从 textarea 的 ref 上现读（不维护 selection state）——
   * 按钮带 onMouseDown preventDefault，点它不会把焦点抢走、选区因此不会丢。
   * 没选中就只给一句提示，不悄悄改正文。
   */
  const sqlRef = useRef<HTMLTextAreaElement | null>(null);
  const [varDraft, setVarDraft] = useState<{ name: string; desc: string; start: number; end: number } | null>(null);
  const openVarDraft = () => {
    if (!editing) return;
    const el = sqlRef.current;
    const start = el ? el.selectionStart ?? 0 : 0;
    const end = el ? el.selectionEnd ?? 0 : 0;
    if (!el || start >= end) {
      flash('先在 SQL 里选中一段文字，再点「转化为变量」', 'info');
      return;
    }
    const name = sanitizeVarName(String(editing.content || '').slice(start, end));
    const hint = parseVarHint(editing.varHint || '');
    // 这个变量已经有释义 → 预填出来供修改（确定后改的是释义，不会重复追加一条）
    setVarDraft({ name, desc: hint[name] || '', start, end });
  };
  const varNameOk = !!varDraft && /^[\w.-]+$/.test(varDraft.name.trim());
  const confirmVarDraft = () => {
    if (!editing || !varDraft || !varNameOk) return;
    const name = varDraft.name.trim();
    const wrapped = wrapSelection(editing.content, varDraft.start, varDraft.end, name);
    if (!wrapped) {
      setVarDraft(null);
      flash('正文已经变了，请重新选中再点一次', 'info');
      return;
    }
    setEditing({
      ...editing,
      content: wrapped.text,
      varHint: upsertVarHint(editing.varHint || '', name, varDraft.desc),
    });
    setVarDraft(null);
    flash(`已转为 {{${name}}}`);
  };

  /** 命令面板「粘贴 SQL」→ 直接开新增弹窗（目录模式下保存成 `标题.sql.md`） */
  useEffect(() => {
    if (!snippetSeed || !String(snippetSeed.text || '').trim()) return;
    setEditing({
      id: '', title: '', content: String(snippetSeed.text), tags: [], kind: 'sql',
      dbOrEnv: '', varHint: '', remark: '', starred: false, updatedAt: new Date().toISOString(),
    });
    consumeSnippetSeed();
  }, [snippetSeed, consumeSnippetSeed]);

  /* ---------------- 弹窗 ---------------- */

  const openNew = () => {
    setErr('');
    setEditing({
      id: '', title: '', content: '', tags: [], kind: 'sql',
      dbOrEnv: '', varHint: '', remark: '', starred: false, updatedAt: new Date().toISOString(),
    });
  };

  /**
   * 导出当前列表为 Markdown（1.31）。
   *
   * - 取 `rows`：左侧「收藏 / 标签」+ 搜索 + 排序之后的结果，**和屏幕上看到的一致**；
   *   没有筛选时就是全部。导出条数写进 toast，用户不用打开文件也能核对。
   * - 落盘走现有 `file:save-text` 通道（preload 的 `saveText`，见 types.ts），
   *   不新增 IPC、不新增依赖。
   * - 用户在保存对话框点「取消」→ `canceled: true` → **静默返回**，不弹错误提示。
   * - 当前筛选 0 条时不弹对话框，直接提示（少一次无效的选路径操作）。
   */
  const exportMd = async () => {
    if (rows.length === 0) {
      flash('当前筛选下没有可导出的片段', 'info');
      return;
    }
    try {
      const r = await window.electronAPI.saveText(
        buildSqlMarkdown(rows),
        exportFileName(),
        [{ name: 'Markdown', extensions: ['md'] }],
      );
      if (r?.canceled) return; // 用户取消：静默
      if (!r || r.success === false) {
        flash(r?.error || '导出失败', 'error');
        return;
      }
      flash(`已导出 ${rows.length} 条`);
    } catch (e) {
      // IPC 异常也不能把页面打崩：给一条提示就行
      flash((e as Error)?.message || '导出失败', 'error');
    }
  };

  const openEdit = (n: Note) => {
    setErr('');
    setEditing({ ...n });
  };

  const canSave = !!editing && !!String(editing.title || '').trim() && !!String(editing.content || '').trim();

  const saveEditing = async () => {
    if (!editing) return;
    if (!String(editing.title || '').trim() || !String(editing.content || '').trim()) {
      setErr('名称和 SQL 都不能为空');
      return;
    }
    const base: Note = {
      ...editing,
      kind: 'sql',
      title: String(editing.title).trim(),
      // 本地库沿用原来的「只裁首尾空白」；目录模式不裁 —— 文件里的 SQL 缩进要一字不差
      content: dirMode ? String(editing.content || '') : String(editing.content || '').trim(),
      tags: editing.tags || [],
      dbOrEnv: String(editing.dbOrEnv || '').trim(),
      varHint: String(editing.varHint || '').trim(),
      remark: String(editing.remark || '').trim(),
      starred: editing.starred === true,
      updatedAt: new Date().toISOString(),
    };
    if (dirMode) {
      await saveDirEditing(base);
      return;
    }
    const isNew = !editing.id;
    const entry: Note = { ...base, id: editing.id || newId() };
    // 整集合写回：改一条不能把别处（笔记 / 周报片段）的条目冲掉
    const next = isNew ? [...items, entry] : items.map(i => (i.id === entry.id ? entry : i));
    setSaving(true);
    const r = await save(next);
    setSaving(false);
    if (r && r.success === false) {
      setErr(r.error || '保存失败');
      return;
    }
    setEditing(null);
    flash(isNew ? '已新增片段' : '已保存');
  };

  /**
   * 目录模式保存：把 Note 写成 `标题.sql.md`（frontmatter + 空行 + SQL 正文）。
   *
   * - 文件名规则同笔记页 `fileOf(title, 'sql')`：`sqlFileName(title)`；重名加 `-2`、`-3`…
   *   （`uniqueSqlFileName`）。**不能**直接把 `标题.sql.md` 交给 `notes:save` 就完事 ——
   *   主进程只在自己生成文件名时去重，给了名字就 `writeFileSync` 覆盖。
   * - 改标题会重命名文件（`notesRename`）；重命名失败仍把内容存回原文件，不丢这次编辑。
   * - 没有 frontmatter 的老 `.sql.md`：解析出来字段为空、正文完整，这里保存时自动补前言。
   */
  const saveDirEditing = async (entry: Note) => {
    const current = dirNameOf(entry.id);
    const title = String(entry.title || '').trim();
    const taken = dirItems.map(i => dirNameOf(i.id)).filter(n => n && n !== current);
    const titleChanged = !!current && titleOfSqlFile(current) !== title;
    let target = current || uniqueSqlFileName(sqlFileName(title), taken);
    if (titleChanged) target = uniqueSqlFileName(sqlFileName(title), taken);
    const text = sqlFileText(entry);
    setSaving(true);
    setDirError('');
    if (current && target !== current) {
      const rr = await window.electronAPI.notesRename(dir, current, target);
      if (rr.success && rr.data) target = rr.data.name;
      else {
        setDirError(rr.error || '重命名失败（内容仍会保存到原文件）');
        target = current;
      }
    }
    const r = await window.electronAPI.notesSave(dir, target, text, title);
    setSaving(false);
    if (!r.success) {
      setErr(r.error || '保存失败');
      return;
    }
    setEditing(null);
    await loadDir();
    flash(current ? '已保存' : '已新增片段');
  };

  const toggleStar = async (n: Note) => {
    // 收藏只是标记，不改 updatedAt —— 否则「本周新增」会跟着跳
    if (dirMode) {
      // 目录模式：改的是文件里的 frontmatter.starred，updatedAt 保持原值
      const name = dirNameOf(n.id);
      const r = await window.electronAPI.notesSave(dir, name, sqlFileText({ ...n, starred: n.starred !== true }), n.title);
      if (!r.success) setDirError(r.error || '保存失败');
      await loadDir();
      return;
    }
    const next = items.map(i => (i.id === n.id ? { ...i, starred: i.starred !== true } : i));
    await save(next);
  };

  const removeRow = (n: Note) => {
    if (dirMode) {
      const name = dirNameOf(n.id);
      // 只删 `.sql.md`：按**文件名**判（按标题判会在同名时误删普通 .md）
      if (!kindDecidedByName(name)) {
        setDirError(`不是 .sql.md 片段文件，拒绝删除：${name || '（未知文件）'}`);
        return;
      }
      ask({
        title: '删除 SQL 片段',
        message: `确定删除「${n.title}」？文件 ${name} 会被移到回收站，可找回。`,
        confirmText: '删除',
        onOk: async () => {
          const r = await window.electronAPI.notesDelete(dir, name);
          if (!r.success) {
            setDirError(r.error || '删除失败');
            return;
          }
          await loadDir();
          flash('已删除');
        },
      });
      return;
    }
    ask({
      title: '删除 SQL 片段',
      message: `确定删除「${n.title}」？删除后不可恢复。`,
      confirmText: '删除',
      onOk: async () => {
        await save(items.filter(i => i.id !== n.id));
        flash('已删除');
      },
    });
  };

  /**
   * 复制入口：先开弹窗（不直接进剪贴板）。
   * 没有 `{{变量}}` 的片段也开同一个弹窗，只把提示换成「可以直接复制」——照用户确认的截图，
   * 复制结果要看得见、要点得到，不在点按钮的同一瞬间偷偷写剪贴板。
   */
  const openCopy = (n: Note) => setCopyTarget(n);

  /**
   * 弹窗复制成功后的提示：两条不带上文的文案补回 `SQL ` 前缀，与抽组件前的页面文案逐字一致
   * （带替换计数的文案本来就没有前缀，原样透出）。文案由页面决定，组件只说「做了什么」。
   */
  const onCopied = (message: string) => {
    flash(message === '已复制原文' || message === '已复制（没有变量）' ? `SQL ${message}` : message);
  };

  const clearFilters = () => { setQ(''); setTag(''); setStarredOnly(false); };

  const filtering = !!q.trim() || !!tag || starredOnly;

  /** 目录模式下的一条工具栏：路径 + 打开目录 + 去笔记页（不再是「本页不管理目录」的提示） */
  const dirBar = dirMode ? (
    <div className="notes-dirbar">
      <Icons.folder size={13} />
      <span
        className="text-sm"
        title={`SQL 片段以 标题.sql.md 存在这个目录：${dir}`}
        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >{dir}</span>
      <button className="btn btn-ghost btn-sm" onClick={() => void window.electronAPI.notesReveal(dir)}>
        打开目录
      </button>
      {onNavigate && (
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => onNavigate('notes')}>
          去笔记与附件
        </button>
      )}
    </div>
  ) : null;

  return (
    <>
      <PageHead
        icon={<Icons.db size={16} />}
        title="SQL 片段"
        desc={dirMode
          ? '目录模式：片段以 标题.sql.md 存在你选的目录里，字段写在文件头的 YAML frontmatter'
          : '常用 SQL、造数与校验脚本，按库 / 环境归档；复制时弹出变量输入框，填完替换后再进剪贴板，留空保留原样'}
        tools={
          <>
            <span className="text-sm text-muted">{kpi.all} 条</span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void (dirMode ? loadDir() : reloadVault())}
              title={dirMode ? '重新读取目录里的 .sql.md' : '重新读取本地库'}
            >
              <Icons.refresh size={13} /> 刷新
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => void exportMd()}
              title={`把当前筛选结果导出成 Markdown（${rows.length} 条）`}
            >
              <Icons.download size={13} /> 导出 MD
            </button>
            <button className="btn btn-primary btn-sm" onClick={openNew} title="新增一条 SQL 片段">
              <Icons.plus size={13} /> 新增片段
            </button>
          </>
        }
      />

      {dirBar}
      {dirError && (
        <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400, marginBottom: 12 }}>
          {dirError}
        </div>
      )}


      <div className="pm-shell">
        <aside className="tag-sidebar">
          <div className="tag-sidebar-header">
            <span className="tag-sidebar-title">筛选</span>
          </div>
          <div
            className={`tag-sidebar-item${!starredOnly && !tag ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            aria-pressed={!starredOnly && !tag}
            onClick={() => { setStarredOnly(false); setTag(''); }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStarredOnly(false); setTag(''); } }}
          >
            <span className="tag-sidebar-name">全部</span>
            <span className="tag-sidebar-count">{kpi.all}</span>
          </div>
          <div
            className={`tag-sidebar-item${starredOnly ? ' active' : ''}`}
            role="button"
            tabIndex={0}
            aria-pressed={starredOnly}
            onClick={() => { setStarredOnly(true); setTag(''); }}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStarredOnly(true); setTag(''); } }}
          >
            <span className="tag-sidebar-name">收藏</span>
            <span className="tag-sidebar-count">{kpi.starred}</span>
          </div>

          <div className="tag-sidebar-header">
            <span className="tag-sidebar-title">标签</span>
            {tag && (
              <button className="btn btn-ghost btn-sm" onClick={() => setTag('')} title="清掉标签筛选">
                全部标签
              </button>
            )}
          </div>
          {tags.length === 0 ? (
            <div className="text-sm text-muted" style={{ padding: '2px 12px 10px' }}>还没有标签</div>
          ) : tags.map(t => (
            <div
              key={t}
              className={`tag-sidebar-item${tag === t ? ' active' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={tag === t}
              onClick={() => setTag(tag === t ? '' : t)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTag(tag === t ? '' : t); } }}
            >
              <span className="tag-sidebar-dot" style={{ background: `hsl(${getTagHue(t)}, 55%, 55%)` }} />
              <span className="tag-sidebar-name">{t}</span>
              <span className="tag-sidebar-count">{tagCounts[t] || 0}</span>
            </div>
          ))}
        </aside>

        <div className="pm-main">
          {/* KPI 三卡：口径写死在 countSql()，与左侧栏计数同源，不会两边对不上 */}
          <div className="home-stats is-3">
            <div className="home-stat"><b>{kpi.all}</b><i>全部片段</i></div>
            <div className="home-stat"><b>{kpi.starred}</b><i>收藏</i></div>
            <div className="home-stat"><b>{kpi.week}</b><i>本周新增</i></div>
          </div>

          <div className="toolbar">
            <SearchBox value={q} onChange={setQ} placeholder="搜索名称 / SQL 正文 / 标签" />
            <span className="text-sm text-muted">{rows.length} / {kpi.all} 条</span>
            <select
              aria-label="排序方式"
              value={sort}
              onChange={e => setSort(e.target.value as SqlSort)}
              style={{ marginLeft: 'auto' }}
            >
              {SORTS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>

          {loading ? (
            <Panel><div className="tbl-empty">{dirMode ? '读取目录…' : '读取本地库…'}</div></Panel>
          ) : kpi.all === 0 ? (
            <Panel>
              <Empty
                icon={<Icons.db size={22} />}
                title="还没有 SQL 片段"
                desc={dirMode
                  ? '新增的片段会在这个目录下生成 标题.sql.md，字段写在文件头，可以直接用别的编辑器改'
                  : '把常用查询、造数与校验脚本存进来，按库 / 环境归档；变量用 {{名字}} 写，在「变量说明」里注明含义'}
                action={
                  <button className="btn btn-primary btn-sm" onClick={openNew}>
                    <Icons.plus size={13} /> 新增片段
                  </button>
                }
              />
            </Panel>
          ) : rows.length === 0 ? (
            <Panel>
              <Empty
                icon={<Icons.search size={22} />}
                title="没有匹配"
                desc="换个关键词，或者清掉左侧的标签 / 收藏筛选"
                action={<button className="btn btn-secondary btn-sm" onClick={clearFilters}>清空筛选</button>}
              />
            </Panel>
          ) : (
            <Panel flush>
              <table className="tbl sql-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>库 / 环境</th>
                    <th>更新时间</th>
                    <th className="cell-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(n => (
                    <tr
                      key={n.id}
                      tabIndex={0}
                      style={{ cursor: 'pointer' }}
                      title="点这一行编辑；Tab 聚焦后按 Enter 也能打开"
                      aria-label={`${n.title}${n.dbOrEnv ? `，${n.dbOrEnv}` : ''}${n.starred === true ? '，已收藏' : ''}，按 Enter 编辑`}
                      onClick={() => openEdit(n)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEdit(n); }
                      }}
                    >
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                          {n.starred === true && (
                            <span role="img" aria-label="已收藏" style={{ display: 'inline-flex', flex: 'none', color: 'var(--warn)' }}>
                              <IconStarFilled size={12} />
                            </span>
                          )}
                          {/* title 挂在真正被截断的 span 上：.sql-table 是 table-layout: fixed，
                              长标题靠省略号截断，不挂 title 就只能看到半截。
                              浏览器取**最内层**带 title 的元素，所以这里不会被行级的
                              「点这一行编辑」覆盖：停在文字上看全文，停在行空白处看操作提示。 */}
                          <span
                            title={n.title}
                            style={{ fontWeight: 600, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          >
                            {n.title}
                          </span>
                        </div>
                        {(n.tags || []).length > 0 && (
                          <div className="text-sm text-muted">{n.tags.join(' · ')}</div>
                        )}
                      </td>
                      {/* 库 / 环境：这一列的省略号是 .sql-table 在 td 上做的（td 才是被截断的盒子），
                          所以 title 挂在 td 上 —— 整格都能悬停出全文；空值不挂，免得弹出空气泡。 */}
                      <td title={n.dbOrEnv || undefined}>
                        {n.dbOrEnv ? <span>{n.dbOrEnv}</span> : <span className="text-muted">—</span>}
                      </td>
                      <td className="text-sm text-muted">{formatRecent(n.updatedAt)}</td>
                      <td className="cell-actions" onClick={e => e.stopPropagation()}>
                        <IconBtn title="复制 SQL（可填 {{变量}}）" onClick={() => openCopy(n)}>
                          <Icons.copy size={13} />
                        </IconBtn>
                        <IconBtn
                          title={n.starred === true ? '取消收藏' : '收藏'}
                          active={n.starred === true}
                          onClick={() => void toggleStar(n)}
                        >
                          {n.starred === true ? <IconStarFilled size={13} /> : <IconStar size={13} />}
                        </IconBtn>
                        <IconBtn title="编辑" onClick={() => openEdit(n)}>
                          <Icons.pencil size={13} />
                        </IconBtn>
                        <IconBtn title="删除" danger onClick={() => removeRow(n)}>
                          <Icons.trash size={13} />
                        </IconBtn>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}

          {filtering && rows.length > 0 && (
            <div className="text-sm text-muted" style={{ marginTop: 8 }}>
              正在按{q.trim() ? '关键词' : ''}{q.trim() && (tag || starredOnly) ? ' + ' : ''}
              {tag ? `标签「${tag}」` : ''}{tag && starredOnly ? ' + ' : ''}{starredOnly ? '收藏' : ''}筛选
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={clearFilters}>清空筛选</button>
            </div>
          )}
        </div>
      </div>

      {/* 新增 / 编辑弹窗：名称与 SQL 必填，Esc 关闭（Modal 自带），焦点先落名称输入框 */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing && editing.id ? '编辑 SQL 片段' : '新增 SQL 片段'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={() => void saveEditing()} disabled={saving || !canSave}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        {editing && (
          <>
            <div className="form-group">
              <label>名称 *</label>
              <input
                value={editing.title}
                onChange={e => setEditing({ ...editing, title: e.target.value })}
                placeholder="例如：查某天未支付的订单"
                data-autofocus="1"
                aria-label="名称"
              />
            </div>
            <div className="form-group">
              <label>库 / 环境</label>
              <input
                value={editing.dbOrEnv || ''}
                onChange={e => setEditing({ ...editing, dbOrEnv: e.target.value })}
                placeholder="例如：test_order / 预发"
                aria-label="库或环境"
              />
              {/* 已有值：可点标签（⚠️ 禁用 datalist，Chromium 会崩）。没有历史值时整行不渲染 */}
              {dbEnvOptions.length > 0 && (
                <div className="suggest-row" aria-label="已有库 / 环境值">
                  {dbEnvOptions.map(v => (
                    <button
                      key={v}
                      type="button"
                      className="chip"
                      onClick={() => setEditing({ ...editing, dbOrEnv: v })}
                    >{v}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="form-group">
              {/* 标题行：标签在左、「转化为变量」贴右（与「变量说明 / 按正文生成」同一套排布） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label>SQL *</label>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 'auto' }}
                  onMouseDown={e => e.preventDefault()}
                  onClick={openVarDraft}
                  title="先在正文里选中一段文字，再把它变成 {{变量}}"
                >转化为变量</button>
              </div>
              <textarea
                ref={sqlRef}
                className="code-input"
                value={editing.content}
                onChange={e => setEditing({ ...editing, content: e.target.value })}
                rows={10}
                spellCheck={false}
                placeholder="SELECT * FROM t_order WHERE created_at >= '{{today}}';"
                aria-label="SQL 正文"
              />
              <div className="input-hint">
                变量用 <code>{'{{名字}}'}</code> 写；复制时会按出现顺序生成输入框，留空则保留原样。
              </div>
            </div>
            <div className="form-group">
              {/* 标题行：标签在左、生成按钮贴右（与接口调试的字段标题行同一套排布） */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label>变量说明</label>
                <button
                  className="btn btn-ghost btn-sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={genVarHint}
                  disabled={editingVars.length === 0}
                  title={editingVars.length === 0
                    ? '正文里没有 {{变量}}'
                    : '按正文里的变量补 {{名字}} = ，已有释义不动'}
                >按正文生成</button>
              </div>
              <textarea
                value={editing.varHint || ''}
                onChange={e => setEditing({ ...editing, varHint: e.target.value })}
                rows={2}
                placeholder="例如：{{orderNo}} = 订单号；{{today}} = 今天"
                aria-label="变量说明"
              />
            </div>
            <div className="form-group">
              <label>备注</label>
              <input
                value={editing.remark || ''}
                onChange={e => setEditing({ ...editing, remark: e.target.value })}
                placeholder="例如：造数后要回滚，别在生产跑"
                aria-label="备注"
              />
            </div>
            <div className="form-group">
              <label>标签（逗号分隔）</label>
              <input
                value={(editing.tags || []).join(', ')}
                onChange={e => setEditing({ ...editing, tags: splitTags(e.target.value) })}
                placeholder="例如：造数, 订单, 回归"
                aria-label="标签"
              />
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={editing.starred === true}
                  onChange={e => setEditing({ ...editing, starred: e.target.checked })}
                />
                收藏（左侧「收藏」里能快速找到）
              </label>
            </div>
            {err && (
              <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400 }}>{err}</div>
            )}
          </>
        )}
      </Modal>

      {/* 转化为变量：选中一段 → 起个名字 + 写说明 → 确定后正文变成 {{名字}}、说明追加 `{{名字}} = 说明`。
          说明留空只补名字；这个变量已有释义时不重复追加，改的是释义（赋值符按原文保留）。 */}
      <Modal
        open={!!varDraft}
        onClose={() => setVarDraft(null)}
        title="转化为变量"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setVarDraft(null)}>取消</button>
            <button className="btn btn-primary" disabled={!varNameOk} onClick={confirmVarDraft}>确定</button>
          </>
        }
      >
        {varDraft && (
          <>
            <div className="form-group">
              <label>变量名 *</label>
              <input
                value={varDraft.name}
                onChange={e => setVarDraft({ ...varDraft, name: e.target.value })}
                aria-label="变量名"
                placeholder="字母 / 数字 / _ . -，例如 orderNo"
                spellCheck={false}
                data-autofocus="1"
              />
              <div className="input-hint">
                正文里会变成 <code>{`{{${varDraft.name.trim() || '名字'}}}`}</code>
                {!varNameOk && ' —— 变量名只能用字母、数字、下划线、点和横线'}
              </div>
            </div>
            <div className="form-group">
              <label>说明</label>
              <input
                value={varDraft.desc}
                onChange={e => setVarDraft({ ...varDraft, desc: e.target.value })}
                aria-label="变量说明（新）"
                placeholder="例如：订单号"
              />
              <div className="input-hint">
                写到「变量说明」里：<code>{`{{${varDraft.name.trim() || '名字'}}}`}</code> = 说明（留空则只补名字）
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* 填充变量并复制：输入框按 {{变量}} 出现顺序生成，「变量说明」里的释义显示在标签旁，
          底部预览与「替换并复制」调用同一个 fillVars —— 预览到什么就复制什么。
          弹窗本体在 components/CopyVarsModal.tsx（笔记页复用同一个组件）。 */}
      <CopyVarsModal
        open={!!copyTarget}
        content={copyTarget?.content || ''}
        varHint={copyTarget?.varHint || ''}
        title="填充变量并复制 SQL"
        onClose={() => setCopyTarget(null)}
        onCopied={onCopied}
      />

      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {confirmNode}
    </>
  );
}


