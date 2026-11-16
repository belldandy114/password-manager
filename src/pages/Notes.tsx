import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Note, NoteLink, Snippet, WeeklyFile, EnvEntry } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useStore } from '../store/useStore';
import { Modal } from '../components/Modal';
import { Pager } from '../components/Pager';
import { useConfirm } from '../components/confirm';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons } from '../components/ui';
import { formatRecent } from '../utils/time';
import { attImageMarkdown, extractAttIds } from '../utils/attachRefs';
import { clipboardImageFiles, insertAtCaret } from '../components/pasteImage';
import { MarkdownView, AttImage } from '../components/MarkdownView';
import { ImageLightbox } from '../components/ImageLightbox';
import { copyPlain } from '../utils/clipboard';
import { planDirKinds, countDirKinds, type DirNoteKind } from '../utils/noteKind';

const LS_DIR = 'pm.notes.dir';
/** 旧「SQL 片段」集合并入笔记的迁移标记。旧集合**不删**，留作兜底。 */
const LS_SQL_MERGED = 'pm.notes.sql-merged-v1';

type NoteKind = 'note' | 'sql';
type KindFilter = 'all' | NoteKind;

const emptyNote = (kind: NoteKind = 'note'): Note => ({
  id: '', title: '', content: '', tags: [], kind, updatedAt: new Date().toISOString(),
});

/** 老数据没有 kind 字段，一律当普通笔记 */
const kindOf = (n: Note): NoteKind => (n.kind === 'sql' ? 'sql' : 'note');

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

/**
 * 文件名 → 显示标题（去掉扩展名）。
 * 1.25.1：SQL 片段的文件名约定是 `标题.sql.md`，只剥 `.md` 会显示成「查用户.sql」，
 * 所以 `.sql` 也一起剥掉。
 */
const titleOf = (name: string) =>
  String(name || '').replace(/\.sql\.(md|markdown|txt)$/i, '').replace(/\.(md|markdown|txt|sql)$/i, '');

/** 列表卡片的纯文本摘要：去掉 Markdown 记号与图片附件引用（图片单独用缩略图展示） */
const plainPreview = (md: string) =>
  String(md || '')
    .replace(/!\[[^\]]*\]\(pm-att:[a-zA-Z0-9-]+\)/g, '')
    .replace(/[#*`>]/g, '')
    .replace(/\n+/g, ' ')
    .trim();

/**
 * 标题 → 合法文件名。
 *
 * 1.25.1：目录模式下 SQL 片段用 `标题.sql.md` 命名 —— 这是**类型判定的第一依据**
 * （`utils/noteKind.ts` 的 `kindDecidedByName`），不靠读正文就能分类。
 */
const fileOf = (title: string, kind: NoteKind = 'note') => {
  const base = String(title || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 80) || '未命名笔记';
  return kind === 'sql' ? `${base}.sql.md` : `${base}.md`;
};

/**
 * 编辑态里的图片预览条。
 *
 * 编辑时正文只有 `![名](pm-att:<id>)` 这一行文字，看不到图，等于「不知道自己贴了什么」。
 * 这里把正文里引用到的附件按顺序解密成缩略图列出来，点一下进灯箱（可缩放、背景透明）。
 */
function EditAttStrip({ content }: { content: string }) {
  const ids = useMemo(() => extractAttIds(content || ''), [content]);
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  if (!ids.length) return null;
  return (
    <div className="note-att-strip">
      <div className="note-att-strip-head">
        <Icons.image size={12} /> 正文里的图片（{ids.length}）
        <span className="text-sm text-muted">点缩略图放大</span>
      </div>
      <div className="note-att-strip-body">
        {ids.map((id, i) => (
          <button
            key={id}
            type="button"
            className="note-att-thumb"
            title={`第 ${i + 1} 张，点击放大`}
            onClick={async () => {
              const r = await window.electronAPI.attachmentReadImage({ id });
              if (!r.success || !r.data?.dataUrl) return;
              setZoom({ src: r.data.dataUrl, alt: `图片 ${i + 1}` });
            }}
          >
            <AttImage id={id} alt={`图片 ${i + 1}`} />
          </button>
        ))}
      </div>
      {zoom && <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </div>
  );
}

/**
 * 笔记的「关联」编辑区（1.25.0）。
 *
 * 踩坑记录往往对应「某个系统的某个地址」「某条缺陷」「某个环境」，以前只能在正文里
 * 手写「#1234 那个 bug」，靠人肉搜索。这里存的是引用（kind + id + label），
 * 不复制内容：被引用对象改名/删除时笔记不会跟着变脏，反查时按 id 去集合里取，
 * 取不到就显示「已删除」。
 *
 * **纯本地标记**：缺陷关联只是笔记上的一个 id，不写回禅道、不修改禅道任何数据。
 *
 * 选对象用「可点的快捷标签」而不是 `<datalist>` —— 后者在输入框聚焦时更新候选项
 * 会让 Chromium 原生崩溃（见 AGENTS.md）。
 */
function NoteLinksEditor({
  links, onChange,
}: {
  links: NoteLink[];
  onChange: (next: NoteLink[]) => void;
}) {
  const entries = useStore(s => s.entries);
  const [envs, setEnvs] = useState<EnvEntry[]>([]);
  const [kind, setKind] = useState<NoteLink['kind']>('entry');
  const [pick, setPick] = useState('');
  const [bugId, setBugId] = useState('');
  const [bugTitle, setBugTitle] = useState('');

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await window.electronAPI.wsGet('environments');
        if (alive && r && r.success && Array.isArray(r.data)) setEnvs(r.data as EnvEntry[]);
      } catch { /* 未解锁 / 读不到就当没有环境可选 */ }
    })();
    return () => { alive = false; };
  }, []);

  const has = (k: NoteLink['kind'], id: string) => links.some(l => l.kind === k && l.id === id);

  const add = (link: NoteLink) => {
    if (!link.id || has(link.kind, link.id)) return;
    onChange([...links, link]);
  };

  const remove = (k: NoteLink['kind'], id: string) => {
    onChange(links.filter(l => !(l.kind === k && l.id === id)));
  };

  const kindLabel: Record<NoteLink['kind'], string> = {
    entry: '网址条目', bug: '缺陷', env: '环境', checklist: '用例',
  };

  const options = kind === 'entry'
    ? entries.map(e => ({ id: String(e.id), label: String(e.name || e.url || e.id) }))
    : kind === 'env'
      ? envs.map(e => ({ id: String(e.id), label: [e.system, e.envType].filter(Boolean).join(' · ') || e.url || String(e.id) }))
      : [];

  return (
    <div className="form-group">
      <div className="field-label-row">
        <label>关联（{links.length}）</label>
        <span className="text-sm text-muted">只是本地标记，不会写回禅道</span>
      </div>

      {links.length === 0 ? (
        <div className="input-hint">可以把这条笔记挂到某个网址、某条缺陷或某个环境上，之后在条目详情里能反查到</div>
      ) : (
        <div className="note-link-chips">
          {links.map(l => (
            <span className="note-link-chip" key={`${l.kind}:${l.id}`} title={`${kindLabel[l.kind] || l.kind} · ${l.id}`}>
              <span className="note-link-kind">{kindLabel[l.kind] || l.kind}</span>
              <span className="note-link-label">{l.label || l.id}</span>
              <button
                type="button"
                className="note-link-x"
                title="移除关联"
                aria-label={`移除关联 ${l.label || l.id}`}
                onClick={() => remove(l.kind, l.id)}
              >×</button>
            </span>
          ))}
        </div>
      )}

      <div className="note-link-add">
        <select
          value={kind}
          onChange={e => { setKind(e.target.value as NoteLink['kind']); setPick(''); }}
          aria-label="关联类型"
        >
          <option value="entry">网址条目</option>
          <option value="env">环境</option>
          <option value="bug">缺陷</option>
        </select>

        {kind === 'bug' ? (
          <>
            <input
              value={bugId}
              onChange={e => setBugId(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="缺陷 id（纯数字）"
              aria-label="缺陷 id"
              style={{ width: 130 }}
            />
            <input
              value={bugTitle}
              onChange={e => setBugTitle(e.target.value)}
              placeholder="标题（可选，方便以后认出来）"
              aria-label="缺陷标题"
            />
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!bugId.trim()}
              onClick={() => {
                const id = bugId.trim();
                add({ kind: 'bug', id, label: bugTitle.trim() || `#${id}` });
                setBugId('');
                setBugTitle('');
              }}
            >添加</button>
          </>
        ) : (
          <>
            <select
              value={pick}
              onChange={e => setPick(e.target.value)}
              aria-label={kind === 'entry' ? '选择网址条目' : '选择环境'}
            >
              <option value="">{options.length ? '选择一个…' : '（没有可选项）'}</option>
              {options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={!pick}
              onClick={() => {
                const o = options.find(x => x.id === pick);
                if (o) add({ kind, id: o.id, label: o.label });
                setPick('');
              }}
            >添加</button>
          </>
        )}
      </div>
    </div>
  );
}

export function Notes() {
  const { items, save, loading, reload } = useCollection<Note>('notes');
  const settings = useStore(s => s.settings);
  const updateSettings = useStore(s => s.updateSettings);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const { ask, confirmNode } = useConfirm();
  const [preview, setPreview] = useState<Note | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [toast, setToast] = useState('');
  const snippetSeed = useStore(s => s.snippetSeed);
  const consumeSnippetSeed = useStore(s => s.consumeSnippetSeed);
  const mergedRef = useRef(false);

  /**
   * 1.24.3：原来独立的「SQL 片段」页取消，历史数据并进笔记。
   * 迁移只在本地加密库模式做一次：目录模式是纯 .md 文件，没有类型元数据。
   * 旧 snippets 集合保留不删 —— 万一写入失败，下次启动还会重试，数据不会凭空消失。
   * 这两个 effect 必须放在 dirMode / dirEditing 声明之后（依赖数组在渲染时求值）。
   */

  /* ---------- 自选目录模式（一篇一个 .md 文件） ---------- */
  /** 目录优先读设置（设置页也能改），旧版本只在 localStorage 里存 */
  const [dir, setDir] = useState(() => settings.notesDir || localStorage.getItem(LS_DIR) || '');
  const [files, setFiles] = useState<WeeklyFile[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState('');
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [dirEditing, setDirEditing] = useState<{ name: string; title: string; content: string; kind?: DirNoteKind } | null>(null);
  const [dirPreview, setDirPreview] = useState<{ name: string; title: string; content: string; mtime: string } | null>(null);
  const [dirSaving, setDirSaving] = useState(false);
  /** 粘贴截图的提示（成功 / 失败 / 保存中） */
  const [attachHint, setAttachHint] = useState('');
  /**
   * 目录模式下每个文件的类型（1.25.1）。
   *
   * 目录模式没有 `kind` 元数据，类型靠 `utils/noteKind.ts` 的纯函数判：
   * 先看文件名（`.sql.md` 结尾直接定），判不出来的才按需读正文，**最多读 20 个**
   * （几百个文件全读一遍会让页面卡住）。剩下的默认 note。
   */
  const [dirKinds, setDirKinds] = useState<Record<string, DirNoteKind>>({});

  const dirMode = !!dir;

  /** 旧版本目录只存在 localStorage：迁进设置，设置页与主进程自检才看得到 */
  useEffect(() => {
    const legacy = localStorage.getItem(LS_DIR) || '';
    if (legacy && !settings.notesDir) {
      updateSettings({ notesDir: legacy });
      void window.electronAPI.settingsSave({ notesDir: legacy });
    }
  }, [settings.notesDir, updateSettings]);

  /* ---------- 旧「SQL 片段」并入 ---------- */
  useEffect(() => {
    if (loading || dirMode || mergedRef.current || localStorage.getItem(LS_SQL_MERGED)) return;
    mergedRef.current = true;
    void (async () => {
      const r = await window.electronAPI.wsGet('snippets');
      if (!r.success || !Array.isArray(r.data) || r.data.length === 0) return;
      const olds = r.data as Snippet[];
      const have = new Set(items.map(n => `${n.title}\u0000${n.content}`));
      const add: Note[] = olds
        .filter(s => !have.has(`${s.title}\u0000${s.sql || ''}`))
        .map(s => ({
          id: s.id || crypto.randomUUID(),
          title: s.title || '（未命名 SQL 片段）',
          content: s.sql || '',
          tags: s.tags || [],
          kind: 'sql' as const,
          updatedAt: s.updatedAt || new Date().toISOString(),
        }));
      if (add.length) {
        const ok = await save([...items, ...add]);
        if (!ok || ok.success === false) { mergedRef.current = false; return; }
        setToast(`已并入 ${add.length} 条历史 SQL 片段`);
        setTimeout(() => setToast(''), 3000);
      }
      localStorage.setItem(LS_SQL_MERGED, '1');
    })();
  }, [loading, dirMode, items, save]);

  /** 命令面板粘贴一段 SQL → 直接开新建弹窗，预置为 SQL 类型 */
  useEffect(() => {
    if (!snippetSeed || !snippetSeed.text.trim()) return;
    if (dirMode) setDirEditing({ name: '', title: '', content: snippetSeed.text });
    else { setKindFilter('all'); setEditing({ ...emptyNote('sql'), content: snippetSeed.text }); }
    consumeSnippetSeed();
  }, [snippetSeed, consumeSnippetSeed, dirMode]);

  const loadDir = useCallback(async (target: string) => {
    if (!target) return;
    setDirLoading(true);
    setDirError('');
    const res = await window.electronAPI.notesList(target);
    setDirLoading(false);
    if (!res.success) {
      setDirError(res.error || '读取目录失败');
      setFiles([]);
      setDirKinds({});
      return;
    }
    const list = res.data || [];
    setFiles(list);
    setBodies({});
    // 先按文件名分类（零 IO）；判不出来的留给下面的 effect 按需读正文
    setDirKinds(planDirKinds(list.map(f => f.name), {}, 20).kinds);
    // 切目录后自动建出 <笔记目录>/attachments（用户要求「切完就能看到这个文件夹」）
    void window.electronAPI.attachmentEnsureNoteDir?.();
  }, []);

  /**
   * 目录模式的类型分类（1.25.1）：文件名判不出来的，按需读正文补齐。
   *
   * 只读 `planDirKinds` 给出的 `toRead`（最多 20 个），读完再算一次最终分类。
   * 依赖 `files` 而不是 `bodies`：`bodies` 会被全文搜索不断追加，不该触发重新分类。
   * 所以 `bodies` 用 ref 读最新值 —— 这样依赖数组是完整的，不需要抑制 hooks 依赖告警。
   */
  const classifyRef = useRef('');
  const bodiesRef = useRef(bodies);
  bodiesRef.current = bodies;
  useEffect(() => {
    if (!dir || files.length === 0) return;
    const key = `${dir}\u0000${files.map(f => f.name).join('\u0000')}`;
    if (classifyRef.current === key) return;
    classifyRef.current = key;
    void (async () => {
      const known = bodiesRef.current;
      const first = planDirKinds(files.map(f => f.name), known, 20);
      if (first.toRead.length === 0) { setDirKinds(first.kinds); return; }
      const read: Record<string, string> = {};
      for (const name of first.toRead) {
        const r = await window.electronAPI.notesRead(dir, name);
        read[name] = r.success && r.data ? String(r.data.content || '') : '';
      }
      // 正文顺手塞进 bodies：卡片摘要与全文搜索都能直接用，不用再读一次
      setBodies(b => ({ ...read, ...b }));
      setDirKinds(planDirKinds(files.map(f => f.name), { ...known, ...read }, 20).kinds);
    })();
  }, [dir, files]);

  // 随手记小窗另开一个窗口写同一批笔记：主窗口回到前台时重新读一次，避免列表还是旧的。
  // 两种存储模式都要刷——目录模式下随手记写的是 .md 文件，只 reload 加密库是看不到的。
  useEffect(() => {
    const onFocus = () => {
      void reload();
      const d = localStorage.getItem(LS_DIR) || '';
      if (d) void loadDir(d);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload, loadDir]);

  useEffect(() => { if (dir) loadDir(dir); }, [dir, loadDir]);

  const pickDir = async () => {
    const res = await window.electronAPI.notesPickDir();
    if (res.success && res.data) {
      setDir(res.data);
      localStorage.setItem(LS_DIR, res.data);
      // 双写：设置页/主进程自检也指向同一个目录
      updateSettings({ notesDir: res.data });
      // 先落盘再建目录：主进程的 notesAttachDir() 是从 settings.json 读 notesDir 的
      await window.electronAPI.settingsSave({ notesDir: res.data });
      // 切完目录立刻在新目录下建出 attachments（用户要求「切完就能看到」）
      void window.electronAPI.attachmentEnsureNoteDir?.();
      setPreview(null);
    }
  };

  const useLocalVault = () => {
    setDir('');
    localStorage.removeItem(LS_DIR);
    updateSettings({ notesDir: '' });
    void window.electronAPI.settingsSave({ notesDir: '' });
    setDirError('');
    setFiles([]);
    setDirKinds({});
  };

  /** 全文搜索：按需把目录里的文件读一遍建索引 */
  const ensureBodies = async () => {
    if (scanning || !dir) return;
    const todo = files.filter(f => bodies[f.name] === undefined);
    if (todo.length === 0) return;
    setScanning(true);
    const map = { ...bodies };
    for (const f of todo) {
      const r = await window.electronAPI.notesRead(dir, f.name);
      map[f.name] = r.success && r.data ? r.data.content : '';
    }
    setBodies(map);
    setScanning(false);
  };

  const openDirNote = async (f: WeeklyFile) => {
    const cached = bodies[f.name];
    if (cached !== undefined) {
      setDirPreview({ name: f.name, title: titleOf(f.name), content: cached, mtime: f.mtime });
      return;
    }
    const r = await window.electronAPI.notesRead(dir, f.name);
    if (r.success && r.data) {
      setBodies(b => ({ ...b, [f.name]: r.data!.content }));
      setDirPreview({ name: f.name, title: titleOf(f.name), content: r.data.content, mtime: r.data.mtime });
    } else {
      setDirError(r.error || '读取失败');
    }
  };

  const editDirNote = async (f: WeeklyFile) => {
    const kind = dirKinds[f.name] || 'note';
    const cached = bodies[f.name];
    if (cached !== undefined) {
      setDirPreview(null);
      setDirEditing({ name: f.name, title: titleOf(f.name), content: cached, kind });
      return;
    }
    const r = await window.electronAPI.notesRead(dir, f.name);
    if (r.success && r.data) {
      setBodies(b => ({ ...b, [f.name]: r.data!.content }));
      setDirPreview(null);
      setDirEditing({ name: f.name, title: titleOf(f.name), content: r.data.content, kind });
    }
  };

  const saveDirNote = async () => {
    if (!dirEditing) return;
    const title = dirEditing.title.trim();
    if (!title) { setDirError('请填写标题'); return; }
    setDirSaving(true);
    setDirError('');
    // 类型决定文件名后缀（.sql.md / .md）—— 这是目录模式唯一的类型元数据
    const kind: DirNoteKind = dirEditing.kind === 'sql' ? 'sql' : 'note';
    let name = dirEditing.name;
    if (!name) {
      // 新建：文件名交给主进程按标题生成（重名会自动加 -2，不会覆盖已有笔记）。
      // 主进程的 notesFileName 只会补 .md，所以 SQL 片段这里自己拼好文件名再传。
      const want = fileOf(title, kind);
      const r = await window.electronAPI.notesSave(dir, want, dirEditing.content, title);
      name = r.success && r.data ? r.data.name : want;
      if (!r.success) setDirError(r.error || '保存失败');
    } else {
      const want = fileOf(title, kind);
      if (want !== name) {
        const rr = await window.electronAPI.notesRename(dir, name, want);
        if (rr.success && rr.data) name = rr.data.name;
        else setDirError(rr.error || '重命名失败（内容仍会保存到原文件）');
      }
      const rs = await window.electronAPI.notesSave(dir, name, dirEditing.content, title);
      if (!rs.success) setDirError(rs.error || '保存失败');
    }
    setDirSaving(false);
    setDirEditing(null);
    await loadDir(dir);
  };

  const removeDirNote = async (name: string) => {
    const r = await window.electronAPI.notesDelete(dir, name);
    if (!r.success) setDirError(r.error || '删除失败');
    await loadDir(dir);
  };

  /* ---------- 本地加密库模式 ---------- */
  /**
   * 周报片段（kind='weekly'）也存 notes 集合，但它们属于周报页的片段库，
   * 不是「测试笔记」：混进列表里既搜不到意义，还会把笔记计数撑大。
   * 这里统一排除，笔记页只显示 note / sql 两类。
   */
  const visibleItems = useMemo(
    () => items.filter(n => String(n.kind || '') !== 'weekly'),
    [items],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = visibleItems.filter(n => {
      if (kindFilter !== 'all' && kindOf(n) !== kindFilter) return false;
      if (!q) return true;
      return [n.title, n.content, (n.tags || []).join(' ')].some(v => (v || '').toLowerCase().includes(q));
    });
    return [...list].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [visibleItems, search, kindFilter]);

  const counts = useMemo(() => ({
    all: visibleItems.length,
    note: visibleItems.filter(n => kindOf(n) === 'note').length,
    sql: visibleItems.filter(n => kindOf(n) === 'sql').length,
  }), [visibleItems]);

  // 长列表分页：几百条笔记一次性渲染会明显卡顿，一页 24 条
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const pagedNotes = useMemo(
    () => filtered.slice((curPage - 1) * pageSize, curPage * pageSize),
    [filtered, curPage, pageSize],
  );
  useEffect(() => { setPage(1); }, [search, kindFilter]);

  const saveEditing = async () => {
    if (!editing || !editing.title.trim()) return;
    const entry: Note = { ...editing, id: editing.id || crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const next = editing.id ? items.map(i => (i.id === entry.id ? entry : i)) : [...items, entry];
    await save(next);
    setEditing(null);
  };

  const remove = async (id: string) => {
    await save(items.filter(i => i.id !== id));
  };

  const copySql = (n: Note) => {
    void navigator.clipboard.writeText(n.content || '');
    setToast('SQL 已复制到剪贴板');
    setTimeout(() => setToast(''), 1500);
  };

  /**
   * 粘贴截图 → 加密附件。
   * 正文里只留 `![说明](pm-att:<id>)`，图片本体按会话密钥加密存在 attachments 目录。
   *
   * 1.25.1：目录模式下截图存到 `<笔记目录>/attachments`（`scope: 'note'`），
   * 与 .md 文件放在一起；本地加密库模式仍存全局附件目录。
   * 读取时主进程先找笔记目录再回退全局，所以老截图（全局目录）照样能显示。
   */
  const pasteImages = async (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    put: (v: string) => void,
    scope: 'note' | 'entry' = 'entry',
  ) => {
    const files = clipboardImageFiles(e);
    if (!files.length) return; // 普通文本粘贴交给浏览器
    e.preventDefault();
    const el = e.currentTarget;
    setAttachHint('正在加密保存截图…');
    // saveImageFiles 不支持 scope（公共组件，随手记也在用），这里自己走一遍：
    // 逐张转 dataURL → 带 scope 送主进程加密落盘。
    const saved: { id: string; name: string }[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result || ''));
          reader.onerror = () => reject(new Error('读取图片失败'));
          reader.readAsDataURL(file);
        });
        const r = await window.electronAPI.attachmentSaveImage({ dataUrl, name: file.name, scope });
        if (r.success && r.data) saved.push({ id: r.data.id, name: r.data.name });
        else errors.push(r.error || '保存失败');
      } catch (err) {
        errors.push((err as Error).message || '保存失败');
      }
    }
    if (!saved.length) { setAttachHint(errors[0] || '截图保存失败'); return; }
    const md = saved.map(a => attImageMarkdown(a.id, a.name.replace(/\.\w+$/, ''))).join('\n');
    put(insertAtCaret(el, `${md}\n`));
    setAttachHint(errors.length
      ? `已保存 ${saved.length} 张，${errors.length} 张失败`
      : `已加密保存 ${saved.length} 张截图${scope === 'note' ? '（笔记目录/attachments）' : ''}`);
    setTimeout(() => setAttachHint(''), 2500);
  };

  /* ---------- 目录模式下的搜索结果 ---------- */
  /** 目录模式：类型筛选 + 关键词过滤（1.25.1 起类型筛选也生效） */
  const dirVisible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files.filter(f => {
      if (kindFilter !== 'all' && (dirKinds[f.name] || 'note') !== kindFilter) return false;
      if (!q) return true;
      return f.name.toLowerCase().includes(q) || (bodies[f.name] || '').toLowerCase().includes(q);
    });
  }, [files, search, bodies, kindFilter, dirKinds]);

  /** 目录模式的类型计数（筛选条上的数字） */
  const dirCounts = useMemo(() => countDirKinds(dirKinds), [dirKinds]);

  useEffect(() => {
    if (dirMode && search.trim()) ensureBodies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirMode, search]);

  /** 目录条上的路径：点击复制（长路径用户经常要粘到资源管理器） */
  const copyDirPath = async () => {
    if (!dir) return;
    await copyPlain(dir);
    setToast('目录路径已复制');
    setTimeout(() => setToast(''), 1500);
  };

  const dirBar = (
    <div className="notes-dirbar">
      <Icons.folder size={13} />
      <button
        type="button"
        className="notes-dirpath"
        title={`点击复制路径：${dir}`}
        onClick={() => void copyDirPath()}
      >{dir}</button>
      <button className="btn btn-ghost btn-sm" onClick={() => window.electronAPI.notesReveal(dir)}>
        打开目录
      </button>
      <button className="btn btn-ghost btn-sm" onClick={pickDir}>
        <Icons.pencil size={11} /> 切换目录
      </button>
      <button className="btn btn-ghost btn-sm" onClick={useLocalVault} title="改回保存在软件内的加密库">
        改回本地库
      </button>
      <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
        {files.length} 篇
      </span>
    </div>
  );

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.note size={16} />}
          title="测试笔记"
          desc={dirMode ? '笔记以 .md 文件保存在你选择的目录里，可随时用其它编辑器打开' : '踩坑记录、测试结论、SQL 语句片段，支持 Markdown，加密保存在本地'}
          tools={
            <>
              {!dirMode && (
                <button className="btn btn-secondary btn-sm" onClick={pickDir} title="改为保存到自己选的目录">
                  <Icons.folder size={13} /> 存到目录
                </button>
              )}
              <SearchBox value={search} onChange={setSearch} placeholder={dirMode ? '搜索文件名 / 正文' : '搜索标题 / 内容 / 标签'} />
              <button
                className="btn btn-primary btn-sm"
                onClick={() => (dirMode
                  // 目录模式：当前筛选是 SQL 时直接新建 SQL 片段（文件名 .sql.md）
                  ? setDirEditing({ name: '', title: '', content: '', kind: kindFilter === 'sql' ? 'sql' : 'note' })
                  : setEditing(emptyNote(kindFilter === 'sql' ? 'sql' : 'note')))}
              >
                <Icons.plus size={13} /> {kindFilter === 'sql' ? '新建片段' : '新建笔记'}
              </button>
            </>
          }
        />

        {/* 两个菜单合并后，用类型筛选区分 Markdown 笔记与 SQL 语句。
            1.25.1：目录模式也显示 —— 类型由 utils/noteKind.ts 按「文件名 + 正文特征」判出来，
            计数用目录文件的实际分类（dirCounts），不再是本地库的 counts。 */}
        <div className="notes-kind-bar">
          {([
            ['all', `全部 ${dirMode ? dirCounts.all : counts.all}`],
            ['note', `笔记 ${dirMode ? dirCounts.note : counts.note}`],
            ['sql', `SQL 片段 ${dirMode ? dirCounts.sql : counts.sql}`],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`view-switch-btn${kindFilter === k ? ' is-on' : ''}`}
              onClick={() => setKindFilter(k)}
            >{label}</button>
          ))}
        </div>
        {toast && <div className="inline-hint">{toast}</div>}

        {dirMode && dirBar}

        {dirError && (
          <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400, marginBottom: 12 }}>
            {dirError}
          </div>
        )}

        {/* ---------------- 目录模式 ---------------- */}
        {dirMode ? (
          dirLoading ? (
            <Panel><div className="tbl-empty">读取目录…</div></Panel>
          ) : files.length === 0 ? (
            <Panel>
              <Empty
                icon={<Icons.note size={22} />}
                title="这个目录里还没有笔记"
                desc="点右上角「新建笔记」，会在这个目录下生成一个 .md 文件（SQL 片段是 .sql.md）"
                action={
                  <button className="btn btn-primary btn-sm" onClick={() => setDirEditing({ name: '', title: '', content: '', kind: 'note' })}>
                    <Icons.plus size={13} /> 新建笔记
                  </button>
                }
              />
            </Panel>
          ) : dirVisible.length === 0 ? (
            <Panel>
              <div className="tbl-empty">
                {kindFilter === 'sql'
                  ? '这个目录里没有识别到 SQL 片段（文件名以 .sql.md 结尾，或正文以 -- / /* 开头且含 SQL 语句）'
                  : kindFilter === 'note'
                    ? '这个目录里没有普通笔记（其余文件都被识别成 SQL 片段了）'
                    : `没有匹配的笔记，换个关键词试试${scanning ? '（正在检索正文…）' : ''}`}
              </div>
            </Panel>
          ) : (
            <div className="cards">
              {dirVisible.map(f => {
                const k = dirKinds[f.name] || 'note';
                return (
                <div key={f.name} className="card2 is-clickable" onClick={() => openDirNote(f)}>
                  <div className="card2-head">
                    <div className="card2-title" title={titleOf(f.name)}>{titleOf(f.name)}</div>
                    <div className="card2-actions" onClick={e => e.stopPropagation()}>
                      {k === 'sql' && (
                        <IconBtn
                          title="复制 SQL"
                          onClick={() => {
                            void copyPlain(bodies[f.name] || '');
                            setToast('SQL 已复制到剪贴板');
                            setTimeout(() => setToast(''), 1500);
                          }}
                        ><Icons.copy size={13} /></IconBtn>
                      )}
                      <IconBtn
                        title="钉成小窗（浮在桌面上照着做）"
                        onClick={() => { void window.electronAPI.pinOpen({ id: `dir::${f.name}`, kind: 'note' }); }}
                      ><Icons.pin size={13} /></IconBtn>
                      <IconBtn title="编辑" onClick={() => editDirNote(f)}><Icons.pencil size={13} /></IconBtn>
                      <IconBtn
                        title="删除（进回收站）"
                        danger
                        onClick={() => ask({
                          title: '删除笔记',
                          message: `确定删除「${titleOf(f.name)}」？文件会移入回收站，可找回。`,
                          confirmText: '删除',
                          onOk: () => removeDirNote(f.name),
                        })}
                      ><Icons.trash size={13} /></IconBtn>
                    </div>
                  </div>
                  <div className="card2-meta">
                    {k === 'sql' ? <Icons.db size={11} /> : <Icons.note size={11} />}
                    {fmtDate(f.mtime)}
                    {k === 'sql' && <span className="chip">SQL</span>}
                    <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
                      {(f.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <div
                    className={`card2-body${k === 'sql' ? ' note-sql-preview' : ''}`}
                    style={{
                      display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}
                  >
                    {k === 'sql'
                      ? (bodies[f.name] || '（点开查看正文）')
                      : (plainPreview(bodies[f.name] !== undefined ? bodies[f.name] : '') || '（点开查看正文）')}
                  </div>
                </div>
                );
              })}
            </div>
          )
        ) : loading ? (
          /* ---------------- 本地加密库模式 ---------------- */
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : filtered.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.note size={22} />}
              title={search ? '没有匹配的内容' : kindFilter === 'sql' ? '还没有 SQL 片段' : '还没有笔记'}
              desc={search ? '换个关键词试试' : '踩坑记录、测试结论、常用 SQL 语句，都存在这里'}
              hint={<>写完后用 <kbd>Ctrl+K</kbd> 全局搜索，随时找回</>}
              action={search || kindFilter === 'all' ? undefined : (
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyNote(kindFilter === 'sql' ? 'sql' : 'note'))}>
                  <Icons.plus size={13} /> {kindFilter === 'sql' ? '新建 SQL 片段' : '新建笔记'}
                </button>
              )}
            />
          </Panel>
        ) : (
          <>
          <div className="cards">
            {pagedNotes.map(n => (
              <div key={n.id} className="card2 is-clickable" onClick={() => setPreview(n)}>
                <div className="card2-head">
                  <div className="card2-title" title={n.title}>{n.title}</div>
                  <div className="card2-actions" onClick={e => e.stopPropagation()}>
                    {kindOf(n) === 'sql' && (
                      <IconBtn title="复制 SQL" onClick={() => copySql(n)}><Icons.copy size={13} /></IconBtn>
                    )}
                    <IconBtn
                      title="钉成小窗（浮在桌面上照着做）"
                      onClick={() => { void window.electronAPI.pinOpen({ id: n.id, kind: 'note' }); }}
                    ><Icons.pin size={13} /></IconBtn>
                    <IconBtn title="编辑" onClick={() => setEditing(n)}><Icons.pencil size={13} /></IconBtn>
                    <IconBtn
                      title="删除"
                      danger
                      onClick={() => ask({
                        title: '删除笔记',
                        message: `确定删除「${n.title}」？删除后不可恢复。`,
                        confirmText: '删除',
                        onOk: () => remove(n.id),
                      })}
                    ><Icons.trash size={13} /></IconBtn>
                  </div>
                </div>

                <div className="card2-meta">
                  {kindOf(n) === 'sql' ? <Icons.db size={11} /> : <Icons.note size={11} />}
                  {fmtDate(n.updatedAt)}
                  {kindOf(n) === 'sql' && <span className="chip">SQL</span>}
                  {/* 关联数量：一眼看出这条笔记挂在哪些对象上，点开才看明细 */}
                  {(n.links?.length || 0) > 0 && (
                    <span className="chip note-link-count" title={(n.links || []).map(l => l.label || l.id).join('、')}>
                      <Icons.link size={10} /> {n.links!.length}
                    </span>
                  )}
                  {n.tags?.length > 0 && <span className="chip" style={{ marginLeft: 'auto' }}>{n.tags.join(' · ')}</span>}
                </div>

                {kindOf(n) === 'sql' ? (
                  <div className="card2-body note-sql-preview" style={{
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>{n.content || '（空片段）'}</div>
                ) : (
                  <div className="card2-body" style={{
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {plainPreview(n.content) || (extractAttIds(n.content || '').length ? '' : '（空笔记）')}
                  </div>
                )}

                {/* 正文里有截图就在卡片上给缩略图，不用点开才知道记了什么 */}
                {kindOf(n) !== 'sql' && extractAttIds(n.content || '').length > 0 && (
                  <div className="card2-thumbs">
                    {extractAttIds(n.content || '').slice(0, 3).map(id => (
                      <AttImage key={id} id={id} />
                    ))}
                    {extractAttIds(n.content || '').length > 3 && (
                      <span className="card2-thumb-more">+{extractAttIds(n.content || '').length - 3}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {filtered.length > pageSize && (
            <Pager
              total={filtered.length}
              page={curPage}
              pageSize={pageSize}
              onPage={setPage}
              onPageSize={setPageSize}
              pageSizes={[24, 48, 96]}
            />
          )}
          </>
        )}
      </Page>

      {/* 本地库：编辑（Markdown 笔记 / SQL 片段共用，只是渲染方式不同） */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={`${editing?.id ? '编辑' : '新建'}${editing && kindOf(editing) === 'sql' ? ' SQL 片段' : '笔记'}`}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={saveEditing} disabled={!editing?.title.trim()}>保存</button>
          </>
        }
      >
        {editing && (
          <>
            <div className="form-group">
              <label>类型</label>
              <div className="notes-kind-bar">
                {([['note', 'Markdown 笔记'], ['sql', 'SQL 片段']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`view-switch-btn${kindOf(editing) === k ? ' is-on' : ''}`}
                    onClick={() => setEditing({ ...editing, kind: k })}
                  >{label}</button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label>标题 *</label>
              <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="例如：资产系统登录偶发 500 的排查" data-autofocus="1" aria-label="标题" />
            </div>
            <div className="form-group">
              <label>标签（逗号分隔）</label>
              <input
                value={(editing.tags || []).join(', ')}
                onChange={e => setEditing({ ...editing, tags: e.target.value.split(/[,，]/).map(s => s.trim()).filter(Boolean) })}
                placeholder="例如：登录, 回归, 造数"
                aria-label="标签"
              />
            </div>
            <div className="form-group">
              <label>{kindOf(editing) === 'sql' ? 'SQL 语句' : '内容（支持 Markdown）'}</label>
              <textarea
                value={editing.content}
                onChange={e => setEditing({ ...editing, content: e.target.value })}
                onPaste={e => void pasteImages(e, v => setEditing(prev => (prev ? { ...prev, content: v } : prev)))}
                rows={16}
                className="code-input"
                placeholder={kindOf(editing) === 'sql' ? 'SELECT * FROM t_user WHERE status = 1;' : '## 现象\n\n## 原因\n\n## 结论'}
                aria-label={kindOf(editing) === 'sql' ? 'SQL 语句' : '内容（支持 Markdown）'}
              />
              <div className="input-hint">
                {kindOf(editing) === 'sql'
                  ? '保存后在卡片上点复制图标，即可一键复制整段 SQL。'
                  : <>支持 <kbd>Ctrl+V</kbd> 直接粘贴截图，图片会加密存在本地。</>}
              </div>
              {kindOf(editing) !== 'sql' && attachHint && <div className="inline-hint">{attachHint}</div>}
              {kindOf(editing) !== 'sql' && <EditAttStrip content={editing.content} />}
            </div>
            {/* 关联区只给 Markdown 笔记：SQL 片段是「拿来就用的语句」，挂关联没有意义 */}
            {kindOf(editing) !== 'sql' && (
              <NoteLinksEditor
                links={editing.links || []}
                onChange={next => setEditing(prev => (prev ? { ...prev, links: next } : prev))}
              />
            )}
          </>
        )}
      </Modal>

      {/* 本地库：预览（SQL 不能走 Markdown，_ 和 * 会被当成格式符） */}
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.title || ''}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setPreview(null)}>关闭</button>
            {preview && kindOf(preview) === 'sql' && (
              <button className="btn btn-ghost" onClick={() => copySql(preview)}><Icons.copy size={13} /> 复制 SQL</button>
            )}
            <button className="btn btn-primary" onClick={() => { setEditing(preview); setPreview(null); }}>编辑</button>
          </>
        }
      >
        {preview && kindOf(preview) === 'sql'
          ? <pre className="code-block note-sql-block">{preview.content}</pre>
          : <MarkdownView md={preview?.content || ''} />}
      </Modal>

      {/* 目录模式：编辑 */}
      <Modal
        open={!!dirEditing}
        onClose={() => setDirEditing(null)}
        title={`${dirEditing?.name ? '编辑' : '新建'}${dirEditing?.kind === 'sql' ? ' SQL 片段' : '笔记'}`}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDirEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={saveDirNote} disabled={dirSaving || !dirEditing?.title.trim()}>
              {dirSaving ? '保存中…' : '保存到目录'}
            </button>
          </>
        }
      >
        {dirEditing && (
          <>
            {/* 目录模式的类型靠文件名约定（.sql.md），所以这里必须能选类型 */}
            <div className="form-group">
              <label>类型</label>
              <div className="notes-kind-bar">
                {([['note', 'Markdown 笔记'], ['sql', 'SQL 片段']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`view-switch-btn${(dirEditing.kind || 'note') === k ? ' is-on' : ''}`}
                    onClick={() => setDirEditing({ ...dirEditing, kind: k })}
                  >{label}</button>
                ))}
              </div>
              <div className="input-hint">
                SQL 片段会存成 <code>标题.sql.md</code>，列表里按文件名自动识别类型。
              </div>
            </div>
            <div className="form-group">
              <label>标题 *（同时作为文件名）</label>
              <input
                value={dirEditing.title}
                onChange={e => setDirEditing({ ...dirEditing, title: e.target.value })}
                placeholder="例如：资产系统登录偶发 500 的排查"
                autoFocus aria-label="标题" />
            </div>
            <div className="form-group">
              <label>{dirEditing.kind === 'sql' ? 'SQL 语句' : '内容（Markdown）'}</label>
              <textarea
                value={dirEditing.content}
                onChange={e => setDirEditing({ ...dirEditing, content: e.target.value })}
                onPaste={e => void pasteImages(
                  e,
                  v => setDirEditing(prev => (prev ? { ...prev, content: v } : prev)),
                  // 目录模式：截图存到 <笔记目录>/attachments，跟着笔记目录走
                  'note',
                )}
                rows={16}
                className="code-input"
                placeholder={dirEditing.kind === 'sql' ? 'SELECT * FROM t_user WHERE status = 1;' : '## 现象\n\n## 原因\n\n## 结论'}
                aria-label={dirEditing.kind === 'sql' ? 'SQL 语句' : '内容（Markdown）'} />
              <div className="input-hint">
                支持 <kbd>Ctrl+V</kbd> 直接粘贴截图，图片会加密存在
                <code>{dir ? `${dir}\\attachments` : '本地附件目录'}</code>。
              </div>
              {attachHint && <div className="inline-hint">{attachHint}</div>}
              <EditAttStrip content={dirEditing.content} />
            </div>
            <div className="assert-hint">
              保存为 <code>{dir ? `${dir}\\${fileOf(dirEditing.title || '未命名笔记', dirEditing.kind === 'sql' ? 'sql' : 'note')}` : fileOf(dirEditing.title, dirEditing.kind === 'sql' ? 'sql' : 'note')}</code>
              ；改标题会同步重命名文件。
            </div>
          </>
        )}
      </Modal>

      {/* 目录模式：预览（SQL 片段不能走 Markdown，_ 和 * 会被当成格式符） */}
      <Modal
        open={!!dirPreview}
        onClose={() => setDirPreview(null)}
        title={dirPreview?.title || ''}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDirPreview(null)}>关闭</button>
            {dirPreview && (dirKinds[dirPreview.name] || 'note') === 'sql' && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  void copyPlain(dirPreview.content || '');
                  setToast('SQL 已复制到剪贴板');
                  setTimeout(() => setToast(''), 1500);
                }}
              >
                <Icons.copy size={13} /> 复制 SQL
              </button>
            )}
            {dirPreview && (
              <button
                className="btn btn-ghost"
                onClick={() => window.electronAPI.notesReveal(dir, dirPreview.name)}
              >
                在资源管理器中显示
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={() => {
                // 预览 → 编辑：带上类型（目录模式没有 kind 元数据，靠 dirKinds 判出来的）
                if (!dirPreview) return;
                setDirEditing({
                  name: dirPreview.name,
                  title: dirPreview.title,
                  content: dirPreview.content,
                  kind: dirKinds[dirPreview.name] || 'note',
                });
                setDirPreview(null);
              }}
            >
              编辑
            </button>
          </>
        }
      >
        <div className="card2-meta" style={{ marginBottom: 10 }}>
          {(dirPreview && (dirKinds[dirPreview.name] || 'note') === 'sql') ? <Icons.db size={11} /> : <Icons.note size={11} />}
          {dirPreview?.name}
          {dirPreview && (dirKinds[dirPreview.name] || 'note') === 'sql' && <span className="chip">SQL</span>}
          <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>{formatRecent(dirPreview?.mtime || '')}</span>
        </div>
        {dirPreview && (dirKinds[dirPreview.name] || 'note') === 'sql'
          ? <pre className="code-block note-sql-block">{dirPreview.content}</pre>
          : <MarkdownView md={dirPreview?.content || ''} />}
      </Modal>

      {confirmNode}
    </div>
  );
}


