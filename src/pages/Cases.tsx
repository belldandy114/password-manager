import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CasesDir, CasesFile, CasesListing, CasesPreview, CasesSearchHit } from '../types';
import { Page, PageHead, Panel, Empty, IconBtn, Icons, SearchBox, Pill } from '../components/ui';
import { Modal } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { ToastContainer } from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { callIpc } from '../utils/ipc';
import { formatRecent } from '../utils/time';
import { formatSize } from '../../electron/cases-paths';
import { renderMarkdown } from '../utils/markdown';
import { useStore } from '../store/useStore';

/**
 * 用例库（1.26.0）。
 *
 * 定位：**文件管家**。用例文件由 xmind / Excel / Markdown 编辑，这里只负责
 * 「按系统/模块收纳 → 双击交给系统默认应用 → 需要时导出」。
 *
 * 刻意不做的事：不在应用内解析 xmind/csv 内容，也不做富文本编辑器 ——
 * 一旦开始解析，格式差异（xmind 版本、Excel 合并单元格）会变成无底洞。
 */

const MAX_DEPTH = 2; // Test_Cases/<系统>/<模块>，再深就成文件管理器了

const depthOf = (rel: string) => rel.split('/').filter(Boolean).length;

/** 文件类型角标：xmind 这类长名只显示前 4 个字符 */
function extLabel(ext: string): string {
  const e = ext.replace(/^\./, '').toUpperCase();
  if (!e) return 'FILE';
  return e.length > 4 ? e.slice(0, 4) : e;
}

export function Cases() {
  const { ask, confirmNode } = useConfirm();
  const [root, setRoot] = useState('');
  const [configured, setConfigured] = useState(false);
  const [rel, setRel] = useState('');
  const [listing, setListing] = useState<CasesListing | null>(null);
  const [systems, setSystems] = useState<CasesDir[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  /** 页面级提示改用全局 toast（右上浮层、3 秒自动消失） */
  const { toasts, addToast, removeToast } = useToast();
  const [busy, setBusy] = useState(false);
  const [dlg, setDlg] = useState<{ kind: 'mkdir' | 'rename'; value: string; rel?: string; parent?: string } | null>(null);
  // 左侧树：系统（一级）展开后加载模块（二级），两级封顶
  const [subs, setSubs] = useState<Record<string, CasesDir[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 右键菜单 / 拖拽
  const [menu, setMenu] = useState<{ x: number; y: number; rel: string | null; kind?: 'dir' | 'file' } | null>(null);
  const [dragRel, setDragRel] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [fileDrag, setFileDrag] = useState(false);
  // 排序 / 搜索范围 / 预览
  const [sortField, setSortField] = useState<'name' | 'mtime' | 'size'>(
    () => (localStorage.getItem('pm.cases.sort') as 'name' | 'mtime' | 'size') || 'mtime',
  );
  const [sortAsc, setSortAsc] = useState(() => localStorage.getItem('pm.cases.sortAsc') === '1');
  const [scope, setScope] = useState<'here' | 'all'>(() => (localStorage.getItem('pm.cases.scope') === 'all' ? 'all' : 'here'));
  const [hits, setHits] = useState<CasesSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{ rel: string; name: string; data: CasesPreview | null; loading: boolean; err?: string } | null>(null);
  const [previewSheet, setPreviewSheet] = useState(0);
  const openCaseIntent = useStore(s => s.casesIntent);
  const consumeCasesIntent = useStore(s => s.consumeCasesIntent);

  const flash = useCallback((msg: string) => addToast(msg, 'success'), [addToast]);
  /** 页面级错误：红 toast（空字符串 = 清空，直接忽略） */
  const flashErr = useCallback((msg: string) => { if (msg) addToast(msg, 'error'); }, [addToast]);

  const load = useCallback(async (targetRel: string) => {
    setLoading(true);
    flashErr('');
    const cfg = await callIpc(() => window.electronAPI.casesConfig());
    if (!cfg.ok) { flashErr(cfg.error); setLoading(false); return; }
    const info = cfg.data as { root: string; configured: boolean; exists: boolean } | undefined;
    setRoot(info?.root || '');
    setConfigured(!!info?.configured);
    if (!info?.configured) {
      setListing(null); setSystems([]); setLoading(false); return;
    }
    const [cur, rootList] = await Promise.all([
      callIpc(() => window.electronAPI.casesList(targetRel)),
      callIpc(() => window.electronAPI.casesList('')),
    ]);
    if (cur.ok && cur.data) {
      const data = cur.data as CasesListing;
      setListing(data);
      setRel(data.rel || '');
    } else {
      flashErr(cur.ok ? '读取用例库失败' : cur.error);
      setListing(null);
    }
    if (rootList.ok && rootList.data) setSystems((rootList.data as CasesListing).dirs);
    setLoading(false);
  }, []);

  useEffect(() => { void load(''); }, [load]);

  /* ---------------- 左侧树（两级）/ 拖拽 ---------------- */

  const loadSubs = useCallback(async (systemRel: string) => {
    const r = await callIpc(() => window.electronAPI.casesList(systemRel));
    if (!r.ok || !r.data) return;
    setSubs(prev => ({ ...prev, [systemRel]: (r.data as CasesListing).dirs }));
  }, []);

  const toggleExpand = async (systemRel: string) => {
    const next = new Set(expanded);
    if (next.has(systemRel)) next.delete(systemRel);
    else { next.add(systemRel); await loadSubs(systemRel); }
    setExpanded(next);
  };

  /** 建/删/移之后刷新根目录与已展开系统的子目录 */
  const refreshTree = useCallback(async () => {
    const r = await callIpc(() => window.electronAPI.casesList(''));
    if (r.ok && r.data) setSystems((r.data as CasesListing).dirs);
    const next: Record<string, CasesDir[]> = {};
    for (const s of expanded) {
      const sub = await callIpc(() => window.electronAPI.casesList(s));
      if (sub.ok && sub.data) next[s] = (sub.data as CasesListing).dirs;
    }
    setSubs(next);
  }, [expanded]);


  // 排序 / 搜索范围记忆
  useEffect(() => { try { localStorage.setItem('pm.cases.sort', sortField); } catch { /* ignore */ } }, [sortField]);
  useEffect(() => { try { localStorage.setItem('pm.cases.sortAsc', sortAsc ? '1' : '0'); } catch { /* ignore */ } }, [sortAsc]);
  useEffect(() => { try { localStorage.setItem('pm.cases.scope', scope); } catch { /* ignore */ } }, [scope]);

  /** 记住最近打开的文件（工作台「最近用例」用） */
  const rememberRecent = useCallback((targetRel: string, name: string) => {
    try {
      const list = JSON.parse(localStorage.getItem('pm.cases.recent') || '[]') as { rel: string; name: string; at: number }[];
      const next = [{ rel: targetRel, name, at: Date.now() }, ...list.filter(x => x.rel !== targetRel)].slice(0, 20);
      localStorage.setItem('pm.cases.recent', JSON.stringify(next));
    } catch { /* ignore */ }
  }, []);

  const openPreview = useCallback(async (targetRel: string, name?: string) => {
    const label = name || targetRel.split('/').pop() || targetRel;
    setPreview({ rel: targetRel, name: label, data: null, loading: true });
    setPreviewSheet(0);
    const r = await callIpc(() => window.electronAPI.casesPreview(targetRel));
    if (!r.ok) { setPreview({ rel: targetRel, name: label, data: null, loading: false, err: r.error }); return; }
    setPreview({ rel: targetRel, name: label, data: r.data as CasesPreview, loading: false });
    rememberRecent(targetRel, label);
  }, [rememberRecent]);

  // 全库搜索：输入停下 260ms 再查，避免每敲一个字都扫盘
  useEffect(() => {
    if (scope !== 'all' || !query.trim()) { setHits([]); setSearching(false); return; }
    let alive = true;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const r = await callIpc(() => window.electronAPI.casesSearch(query.trim(), 200));
      if (!alive) return;
      setSearching(false);
      setHits(r.ok && r.data ? (r.data as { hits: CasesSearchHit[] }).hits : []);
    }, 260);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [query, scope]);

  // 外部改动自动刷新（编辑保存、外部新增/改名后不用手动点刷新）
  const relRef = useRef(rel);
  useEffect(() => { relRef.current = rel; }, [rel]);
  useEffect(() => {
    if (!configured) return;
    if (typeof window.electronAPI.onCasesChanged !== 'function') return;
    const off = window.electronAPI.onCasesChanged(() => {
      void load(relRef.current);
      void refreshTree();
    });
    return off;
  }, [configured, load, refreshTree]);

  // 工作台「最近用例」点进来：定位到文件所在目录并打开预览
  useEffect(() => {
    if (!openCaseIntent) return;
    const target = openCaseIntent.rel;
    consumeCasesIntent();
    const dir = target.split('/').slice(0, -1).join('/');
    void (async () => {
      await load(dir);
      if (dir) {
        const next = new Set(expanded);
        const top = dir.split('/')[0];
        if (top) { next.add(top); setExpanded(next); await loadSubs(top); }
      }
      await openPreview(target);
    })();
  }, [openCaseIntent, consumeCasesIntent, load, loadSubs, expanded, openPreview]);

  /** 外部文件拖入 / 选文件后统一走这里 */
  const importFiles = useCallback(async (files: File[], targetRel: string) => {
    const paths = files.map(f => window.electronAPI.filePathFor?.(f) || '').filter(Boolean);
    if (!paths.length) {
      flashErr('读不到文件路径：请用「上传文件」按钮选择，或从资源管理器拖入');
      return;
    }
    setBusy(true);
    const r = await callIpc(() => window.electronAPI.casesImport(targetRel, paths));
    setBusy(false);
    if (!r.ok) { flashErr(`导入失败：${r.error}`); return; }
    const data = r.data as { imported: string[]; failed: string[] } | undefined;
    await load(rel);
    await refreshTree();
    const ok = data?.imported.length || 0;
    const bad = data?.failed.length || 0;
    flash(bad ? `已导入 ${ok} 个，${bad} 个失败` : `已导入 ${ok} 个文件`);
    if (bad) flashErr(`未导入：${(data?.failed ?? []).join('；')}`);
  }, [flash, load, refreshTree, rel]);

  /** 从拖拽事件里取出要移动的条目（支持多选；老格式单条兜底） */
  const relsFromDrop = (e: React.DragEvent): string[] => {
    try {
      const raw = e.dataTransfer.getData('application/x-cases-rels');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr.filter((x): x is string => typeof x === 'string' && !!x);
      }
    } catch { /* 老格式 */ }
    const one = e.dataTransfer.getData('application/x-cases-rel') || dragRel;
    return one ? [one] : [];
  };

  /** 拖到任意目录 = 移动（文件可进任意一级；文件夹只能进根/系统），支持多个一起拖 */
  const moveMany = useCallback(async (rels: string[], targetRel: string) => {
    if (!rels.length) return;
    let moved = 0;
    let failMsg = '';
    for (const src of rels) {
      if (!src || src === targetRel || targetRel.startsWith(src + '/')) continue;
      const r = await callIpc(() => window.electronAPI.casesMove(src, targetRel));
      if (!r.ok) { failMsg = r.error; continue; }
      const data = r.data as { unchanged?: boolean } | undefined;
      if (!data?.unchanged) moved += 1;
    }
    await load(rel);
    await refreshTree();
    if (moved) flash(`已移动 ${moved} 项到「${targetRel.split('/').pop() || '用例库'}」`);
    if (failMsg) flashErr(`部分未移动：${failMsg}`);
  }, [flash, load, refreshTree, rel]);

  const onTreeDragOver = (e: React.DragEvent, targetRel: string) => {
    if (!dragRel) return; // 外部文件不在这里接，交给列表区
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropOn(targetRel);
  };

  const onTreeDrop = async (e: React.DragEvent, targetRel: string) => {
    e.preventDefault();
    e.stopPropagation();
    setDropOn(null);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) { await importFiles(files, targetRel); return; }
    await moveMany(relsFromDrop(e), targetRel);
    setDragRel(null);
  };

  // 右键菜单：Esc 关闭
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menu]);

  /** 面包屑也可以接拖放：拖到上一级 = 移出去 */
  const crumbDrop = (targetRel: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!dragRel) return;
      e.preventDefault();
      setDropOn(targetRel);
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDropOn(null);
      void moveMany(relsFromDrop(e), targetRel);
      setDragRel(null);
    },
  });

  const openMenu = (e: React.MouseEvent, targetRel: string | null, kind?: 'dir' | 'file') => {
    e.preventDefault();
    e.stopPropagation();
    // 菜单靠近右下角时往回挪，避免出屏
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - 240),
      rel: targetRel,
      kind,
    });
  };


  /* ---------------- 目录操作 ---------------- */

  const chooseRoot = async () => {
    const r = await callIpc(() => window.electronAPI.casesChooseRoot());
    if (!r.ok) { flashErr(r.error); return; }
    const data = r.data as { root: string } | undefined;
    if (!data?.root) return; // 用户取消
    flash('用例库目录已设置');
    await load('');
  };

  const changeRoot = () => {
    ask({
      title: '更改用例库位置',
      message: '会先选择新目录，把现有用例文件全部复制过去并校验数量，成功后旧目录进回收站。文件多时需要等一会儿，中途请不要关闭应用。',
      confirmText: '开始迁移',
      onOk: async () => {
        const chosen = await pickDirectory('迁移');
        if (!chosen) return;
        setBusy(true);
        const r = await callIpc(() => window.electronAPI.casesChangeRoot(chosen));
        setBusy(false);
        if (!r.ok) { flashErr(`迁移失败：${r.error}`); return; }
        const data = r.data as { root: string; moved: number } | undefined;
        flash(`已迁移到新目录（${data?.moved ?? 0} 个文件）`);
        await load('');
      },
    });
  };

  /** 选一个目录：mode=export 用导出标题，mode=迁移 用「新的用例库目录」标题 */
  const pickDirectory = async (mode: 'export' | '迁移' = 'export'): Promise<string | null> => {
    const r = await callIpc(() => (
      mode === '迁移' ? window.electronAPI.casesPickDir() : window.electronAPI.casesPickExportDir()
    ));
    if (!r.ok) { flashErr(r.error); return null; }
    return (r.data as string | undefined) || null;
  };

  const upload = async () => {
    const picked = await callIpc(() => window.electronAPI.casesPickFiles());
    if (!picked.ok) { flashErr(picked.error); return; }
    const files = picked.data as string[] | undefined;
    if (!files?.length) return;
    setBusy(true);
    const r = await callIpc(() => window.electronAPI.casesImport(rel, files));
    setBusy(false);
    if (!r.ok) { flashErr(`上传失败：${r.error}`); return; }
    const data = r.data as { imported: string[]; failed: string[] } | undefined;
    await load(rel);
    await refreshTree();
    const ok = data?.imported.length || 0;
    const bad = data?.failed.length || 0;
    flash(bad ? `已导入 ${ok} 个，${bad} 个失败（详见文件列表）` : `已导入 ${ok} 个文件`);
    if (bad) flashErr(`未导入：${(data?.failed ?? []).join('；')}`);
  };

  const doMkdir = async () => {
    if (!dlg) return;
    const name = dlg.value.trim();
    const parent = dlg.parent ?? rel;
    if (!name) return;
    const r = await callIpc(() => window.electronAPI.casesMkdir(parent, name));
    if (!r.ok) { flashErr(r.error); return; }
    const data = r.data as { name: string } | undefined;
    setDlg(null);
    // 在系统上新建子文件夹后自动展开它，用户能立刻看到结果
    if (parent) {
      const next = new Set(expanded);
      next.add(parent);
      setExpanded(next);
      await loadSubs(parent);
    }
    await load(rel);
    flash(`已新建文件夹「${data?.name || name}」`);
  };

  const doRename = async () => {
    const target = dlg?.rel;
    if (!target) return;
    const name = dlg.value.trim();
    if (!name) return;
    const r = await callIpc(() => window.electronAPI.casesRename(target, name));
    if (!r.ok) { flashErr(r.error); return; }
    setDlg(null);
    await load(rel);
    flash('已重命名');
  };

  /** 整目录导入：保留内部结构，重名自动加后缀（模块里不允许，避免第三级） */
  const importFolder = async () => {
    if (depthOf(rel) >= MAX_DEPTH) {
      flashErr('最多两级：请在根目录或系统目录导入文件夹');
      return;
    }
    const picked = await callIpc(() => window.electronAPI.casesPickImportDir());
    if (!picked.ok) { flashErr(picked.error); return; }
    const dir = picked.data as string | undefined;
    if (!dir) return;
    setBusy(true);
    const r = await callIpc(() => window.electronAPI.casesImportFolder(rel, dir));
    setBusy(false);
    if (!r.ok) { flashErr(`导入文件夹失败：${r.error}`); return; }
    const data = r.data as { name: string; files: number } | undefined;
    await load(rel);
    await refreshTree();
    flash(`已导入文件夹「${data?.name || ''}」（${data?.files ?? 0} 个文件）`);
  };
  const openItem = async (targetRel: string) => {
    rememberRecent(targetRel, targetRel.split('/').pop() || targetRel);
    const r = await callIpc(() => window.electronAPI.casesOpen(targetRel));
    if (!r.ok) { flashErr(`打开失败：${r.error}`); return; }
    const how = (r.data as { how?: string } | undefined)?.how;
    if (how === 'open-with') flash('没有默认应用，已弹出「打开方式」让你选');
  };

  const openWithItem = async (targetRel: string) => {
    const r = await callIpc(() => window.electronAPI.casesOpenWith(targetRel));
    if (!r.ok) flashErr(`打开失败：${r.error}`);
  };

  const revealItem = async (targetRel: string) => {
    const r = await callIpc(() => window.electronAPI.casesReveal(targetRel));
    if (!r.ok) flashErr(r.error);
  };

  const removeOne = (targetRel: string, label: string) => {
    ask({
      title: '删除',
      message: `确定删除「${label}」？会放进系统回收站，可以恢复。`,
      confirmText: '删除',
      danger: true,
      onOk: async () => {
        const r = await callIpc(() => window.electronAPI.casesDelete(targetRel));
        if (!r.ok) { flashErr(r.error); return; }
        setSelected(prev => { const next = new Set(prev); next.delete(targetRel); return next; });
        await load(rel);
        flash('已移入回收站');
      },
    });
  };

  const exportSelected = async (rels: string[]) => {
    if (!rels.length) return;
    const dest = await pickDirectory();
    if (!dest) return;
    setBusy(true);
    const r = await callIpc(() => window.electronAPI.casesExport(rels, dest));
    setBusy(false);
    if (!r.ok) { flashErr(`导出失败：${r.error}`); return; }
    const data = r.data as { exported: string[]; failed: string[] } | undefined;
    flash(`已导出 ${data?.exported.length ?? 0} 项到 ${dest}`);
    if (data?.failed.length) flashErr(`部分未导出：${data.failed.join('；')}`);
  };

  /* ---------------- 展示数据 ---------------- */

  const segments = rel.split('/').filter(Boolean);
  const dirs = useMemo(() => listing?.dirs || [], [listing]);
  const files = useMemo(() => listing?.files || [], [listing]);
  const sortedFiles = useMemo(() => {
    const arr = [...files];
    arr.sort((a, b) => {
      let cmp: number;
      if (sortField === 'name') cmp = a.name.localeCompare(b.name, 'zh');
      else if (sortField === 'size') cmp = a.size - b.size;
      else cmp = String(a.mtime).localeCompare(String(b.mtime));
      return sortAsc ? cmp : -cmp;
    });
    return arr;
  }, [files, sortField, sortAsc]);
  const q = query.trim().toLowerCase();
  const shownDirs = useMemo(
    () => dirs.filter(d => !q || d.name.toLowerCase().includes(q)),
    [dirs, q],
  );
  const shownFiles = useMemo(
    () => sortedFiles.filter(f => !q || f.name.toLowerCase().includes(q)),
    [sortedFiles, q],
  );
  const atMaxDepth = depthOf(rel) >= MAX_DEPTH;
  const topRel = segments[0] || '';

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  /** 拖拽起点：拖的是「选中集合里的一个」就带上全部选中项 */
  const dragStart = (e: React.DragEvent, srcRel: string) => {
    const list = selected.has(srcRel) ? [...selected] : [srcRel];
    e.dataTransfer.setData('application/x-cases-rels', JSON.stringify(list));
    e.dataTransfer.setData('application/x-cases-rel', srcRel);
    e.dataTransfer.effectAllowed = 'move';
    setDragRel(srcRel);
  };

  const fileRow = (f: CasesFile) => (
    <div
      key={f.rel}
      className={`cases-row${selected.has(f.rel) ? ' is-picked' : ''}`}
      onClick={() => toggle(f.rel)}
      onDoubleClick={() => void openItem(f.rel)}
      draggable
      onDragStart={e => dragStart(e, f.rel)}
      onDragEnd={() => { setDragRel(null); setDropOn(null); }}
      onContextMenu={e => openMenu(e, f.rel, 'file')}
      title={`双击用系统默认应用打开；拖到文件夹或左侧目录可移动\n${f.rel}`}
    >
      <input
        type="checkbox"
        className="tbl-check"
        checked={selected.has(f.rel)}
        onChange={() => toggle(f.rel)}
        onClick={e => e.stopPropagation()}
        aria-label={`选择 ${f.name}`}
      />
      <span className={`cases-ext is-${f.ext.replace('.', '') || 'file'}`}>{extLabel(f.ext)}</span>
      <span className="cases-main">
        <span className="cases-name">{f.name}</span>
        <span className="cases-meta">{formatSize(f.size)} · {formatRecent(f.mtime)}</span>
      </span>
      <span className="cases-actions" onClick={e => e.stopPropagation()}>
        <IconBtn title="预览" onClick={() => void openPreview(f.rel, f.name)}><Icons.eye size={12} /></IconBtn>
        <IconBtn title="用默认应用打开" onClick={() => void openItem(f.rel)}><Icons.extern size={12} /></IconBtn>
        <IconBtn title="在文件夹中显示" onClick={() => void revealItem(f.rel)}><Icons.folder size={12} /></IconBtn>
        <IconBtn title="重命名" onClick={() => setDlg({ kind: 'rename', rel: f.rel, value: f.name })}>
          <Icons.pencil size={12} />
        </IconBtn>
        <IconBtn title="导出这一项" onClick={() => void exportSelected([f.rel])}><Icons.download size={12} /></IconBtn>
        <IconBtn danger title="删除（进回收站）" onClick={() => removeOne(f.rel, f.name)}><Icons.trash size={12} /></IconBtn>
      </span>
    </div>
  );

  const dirRow = (d: CasesDir) => (
    <div
      key={d.rel}
      className={`cases-row is-dir${selected.has(d.rel) ? ' is-picked' : ''}${dropOn === d.rel ? ' is-drop' : ''}`}
      onClick={() => { if (depthOf(d.rel) <= MAX_DEPTH) void load(d.rel); }}
      onDoubleClick={() => { if (depthOf(d.rel) <= MAX_DEPTH) void load(d.rel); }}
      title={depthOf(d.rel) >= MAX_DEPTH ? '已经是最后一级（系统 / 模块）' : `进入「${d.name}」；也可以把文件直接拖进来`}
      role="button"
      tabIndex={0}
      draggable={depthOf(d.rel) > 0}
      onDragStart={e => dragStart(e, d.rel)}
      onDragEnd={() => { setDragRel(null); setDropOn(null); }}
      onContextMenu={e => openMenu(e, d.rel, 'dir')}
      onDragOver={e => {
        if (!dragRel && !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = dragRel ? 'move' : 'copy';
        setDropOn(d.rel);
      }}
      onDragLeave={() => setDropOn(null)}
      onDrop={e => {
        e.preventDefault();
        e.stopPropagation();
        setDropOn(null);
        const files = Array.from(e.dataTransfer.files || []);
        if (files.length) { void importFiles(files, d.rel); return; }
        void moveMany(relsFromDrop(e), d.rel);
        setDragRel(null);
      }}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void load(d.rel); } }}
    >
      <input
        type="checkbox"
        className="tbl-check"
        checked={selected.has(d.rel)}
        onChange={() => toggle(d.rel)}
        onClick={e => e.stopPropagation()}
        aria-label={`选择文件夹 ${d.name}`}
      />
      <span className="cases-ext is-dir"><Icons.folder size={14} /></span>
      <span className="cases-main">
        <span className="cases-name">{d.name}</span>
        <span className="cases-meta">{d.fileCount} 个文件 · {formatRecent(d.mtime)}</span>
      </span>
      <span className="cases-actions" onClick={e => e.stopPropagation()}>
        <IconBtn title="打开这个文件夹" onClick={() => { if (depthOf(d.rel) <= MAX_DEPTH) void load(d.rel); }}>
          <Icons.chevron size={12} />
        </IconBtn>
        <IconBtn title="在文件夹中显示" onClick={() => void revealItem(d.rel)}><Icons.folder size={12} /></IconBtn>
        <IconBtn title="重命名" onClick={() => setDlg({ kind: 'rename', rel: d.rel, value: d.name })}>
          <Icons.pencil size={12} />
        </IconBtn>
        <IconBtn title="导出这个文件夹" onClick={() => void exportSelected([d.rel])}><Icons.download size={12} /></IconBtn>
        <IconBtn danger title="删除（进回收站）" onClick={() => removeOne(d.rel, d.name)}><Icons.trash size={12} /></IconBtn>
      </span>
    </div>
  );

  /* ---------------- 渲染 ---------------- */

  if (loading && !listing) {
    return (
      <div className="content-area">
        <Page>
          <PageHead title="用例库" desc="按系统 / 模块收纳用例文件，双击交给系统默认应用打开" />
          <div className="tbl-empty">读取用例库…</div>
        </Page>
      </div>
    );
  }

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.folder size={16} />}
          title="用例库"
          desc="按「系统 / 模块」收纳 xmind、Excel、Markdown 用例；双击用系统默认应用打开，应用内不编辑。注意：这里是明文目录，不像密码库那样加密"
          tools={
            configured ? (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => void chooseRoot()} disabled={busy}>
                  <Icons.folder size={13} /> 更改目录
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => void load(rel)} disabled={busy}>
                  <Icons.refresh size={13} /> 刷新
                </button>
                <button className="btn btn-primary btn-sm" onClick={() => void upload()} disabled={busy}>
                  <Icons.upload size={13} /> 上传文件
                </button>
              </>
            ) : undefined
          }
        />


        {!configured ? (
          <Panel>
            <Empty
              icon={<Icons.folder size={22} />}
              title="还没有设置用例库目录"
              desc="选一个固定目录（建议命名为 Test_Cases）存放各系统的用例文件；之后可以随时更改，改的时候会自动迁移。"
              hint="用例库是明文目录：xmind / Excel 文件本身没有加密，别把账号密码存进去。"
              action={
                <button className="btn btn-primary" onClick={() => void chooseRoot()}>
                  <Icons.folder size={13} /> 选择目录
                </button>
              }
            />
          </Panel>
        ) : (
          <div className="split" style={{ gridTemplateColumns: '248px minmax(0, 1fr)' }}>
            <Panel title={<span className="cases-side-title">系统<span className="cases-side-n">{systems.length}</span></span>} flush>
              <div
                className="cases-tree"
                onContextMenu={e => openMenu(e, null)}
                title="空白处右击：新建系统文件夹"
              >
                <button
                  className={`cases-tree-item${rel === '' ? ' is-on' : ''}${dropOn === '' ? ' is-drop' : ''}`}
                  onClick={() => void load('')}
                  onDragOver={e => onTreeDragOver(e, '')}
                  onDragLeave={() => setDropOn(null)}
                  onDrop={e => void onTreeDrop(e, '')}
                >
                  <span className="cases-chev is-hidden" />
                  <Icons.list size={13} /> 全部文件
                </button>
                {systems.map(d => {
                  const open = expanded.has(d.rel);
                  const active = rel === d.rel || rel.startsWith(d.rel + '/');
                  return (
                    <React.Fragment key={d.rel}>
                      <div
                        className={`cases-tree-item${active ? ' is-on' : ''}${dropOn === d.rel ? ' is-drop' : ''}`}
                        onClick={() => void load(d.rel)}
                        onContextMenu={e => openMenu(e, d.rel)}
                        onDragOver={e => onTreeDragOver(e, d.rel)}
                        onDragLeave={() => setDropOn(null)}
                        onDrop={e => void onTreeDrop(e, d.rel)}
                        role="button"
                        tabIndex={0}
                        title={d.rel}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void load(d.rel); } }}
                      >
                        <button
                          className={`cases-chev${open ? ' is-open' : ''}`}
                          onClick={e => { e.stopPropagation(); void toggleExpand(d.rel); }}
                          aria-expanded={open}
                          aria-label={open ? `收起「${d.name}」` : `展开「${d.name}」`}
                          title={open ? '收起模块' : '展开模块'}
                        >
                          <Icons.chevron size={11} />
                        </button>
                        <Icons.folder size={13} />
                        <span className="cases-tree-name">{d.name}</span>
                        <em className="cases-tree-n" title={`${d.dirCount} 个模块 · ${d.fileCount} 个顶层文件`}>{d.dirCount}</em>
                      </div>
                      {open && (subs[d.rel] || []).map(m => (
                        <div
                          key={m.rel}
                          className={`cases-tree-item is-sub${rel === m.rel ? ' is-on' : ''}${dropOn === m.rel ? ' is-drop' : ''}`}
                          onClick={() => void load(m.rel)}
                          onContextMenu={e => openMenu(e, m.rel)}
                          onDragOver={e => onTreeDragOver(e, m.rel)}
                          onDragLeave={() => setDropOn(null)}
                          onDrop={e => void onTreeDrop(e, m.rel)}
                          role="button"
                          tabIndex={0}
                          title={m.rel}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void load(m.rel); } }}
                        >
                          <span className="cases-chev is-hidden" />
                          <Icons.folder size={12} />
                          <span className="cases-tree-name">{m.name}</span>
                          <em className="cases-tree-n">{m.fileCount}</em>
                        </div>
                      ))}
                      {open && !(subs[d.rel] || []).length && (
                        <div className="cases-tree-hint">还没有模块 · 右击系统新建</div>
                      )}
                    </React.Fragment>
                  );
                })}
                {systems.length === 0 && (
                  <div className="cases-tree-empty">还没有系统文件夹<br />空白处右击新建第一个</div>
                )}
              </div>
            </Panel>

            <Panel
              flush
              title={
                <span className="cases-crumb">
                  <button className={`cases-crumb-link${dropOn === '' ? ' is-drop' : ''}`} onClick={() => void load('')} {...crumbDrop('')}>用例库</button>
                  {segments.map((seg, i) => {
                    const target = segments.slice(0, i + 1).join('/');
                    const last = i === segments.length - 1;
                    return (
                      <React.Fragment key={target}>
                        <span className="cases-crumb-sep">/</span>
                        {last ? (
                          <span className="cases-crumb-cur">{seg}</span>
                        ) : (
                          <button className={`cases-crumb-link${dropOn === target ? ' is-drop' : ''}`} onClick={() => void load(target)} {...crumbDrop(target)}>{seg}</button>
                        )}
                      </React.Fragment>
                    );
                  })}
                  <span className="cases-count">{listing?.files.length ?? 0} 个文件</span>
                </span>
              }
              tools={
                <>
                  <div className="cases-scope" role="group" aria-label="搜索范围">
                    <button
                      className={`cases-scope-btn${scope === 'here' ? ' is-on' : ''}`}
                      onClick={() => setScope('here')}
                      title="只在当前目录里搜"
                    >
                      当前目录
                    </button>
                    <button
                      className={`cases-scope-btn${scope === 'all' ? ' is-on' : ''}`}
                      onClick={() => setScope('all')}
                      title="在所有系统 / 模块里搜文件名"
                    >
                      全库
                    </button>
                  </div>
                  <SearchBox
                    value={query}
                    onChange={setQuery}
                    placeholder={scope === 'all' ? '全库搜索文件名…' : '搜索文件名'}
                  />
                  <select
                    className="cases-sort"
                    value={`${sortField}:${sortAsc ? 'asc' : 'desc'}`}
                    onChange={e => {
                      const [field, order] = e.target.value.split(':');
                      setSortField(field as 'name' | 'mtime' | 'size');
                      setSortAsc(order === 'asc');
                    }}
                    title="文件排序方式"
                  >
                    <option value="mtime:desc">最近修改</option>
                    <option value="mtime:asc">最早修改</option>
                    <option value="name:asc">名称 A→Z</option>
                    <option value="name:desc">名称 Z→A</option>
                    <option value="size:desc">大小 大到小</option>
                    <option value="size:asc">大小 小到大</option>
                  </select>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => void importFolder()}
                    disabled={busy || atMaxDepth}
                    title={atMaxDepth ? '最多两级：请在根目录或系统目录导入' : '选一个文件夹整体导入（保留内部结构）'}
                  >
                    <Icons.upload size={13} /> 导入文件夹
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setDlg({ kind: 'mkdir', value: '' })}
                    disabled={atMaxDepth}
                    title={atMaxDepth ? '最多两级：Test_Cases / 系统 / 模块' : '在当前目录新建模块文件夹'}
                  >
                    <Icons.plus size={13} /> 新建文件夹
                  </button>
                </>
              }
            >
              <div
                className={`cases-list${fileDrag ? ' is-file-drag' : ''}`}
                onDragOver={e => {
                  if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'copy';
                  setFileDrag(true);
                }}
                onDragLeave={() => setFileDrag(false)}
                onDrop={async e => {
                  if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
                  e.preventDefault();
                  setFileDrag(false);
                  await importFiles(Array.from(e.dataTransfer.files || []), rel);
                }}
              >
                {fileDrag && (
                  <div className="cases-drop-hint">松开即导入到「{segments[segments.length - 1] || '用例库'}」</div>
                )}
                {selected.size > 0 && (
                  <div className="cases-batch">
                    <span>已选 {selected.size} 项</span>
                    <button className="btn btn-sm btn-secondary" onClick={() => void exportSelected([...selected])} disabled={busy}>
                      <Icons.download size={12} /> 导出所选
                    </button>
                    <button
                      className="btn btn-sm btn-secondary"
                      onClick={() => {
                        ask({
                          title: '删除所选',
                          message: `确定删除选中的 ${selected.size} 项？会放进系统回收站。`,
                          confirmText: '删除',
                          danger: true,
                          onOk: async () => {
                            let failed = 0;
                            for (const r of [...selected]) {
                              const res = await callIpc(() => window.electronAPI.casesDelete(r));
                              if (!res.ok) failed += 1;
                            }
                            setSelected(new Set());
                            await load(rel);
                            flash(failed ? `删除完成，${failed} 项失败` : '已移入回收站');
                          },
                        });
                      }}
                    >
                      <Icons.trash size={12} /> 删除所选
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>取消选择</button>
                  </div>
                )}

                {scope === 'all' && q ? (
                  searching ? (
                    <div className="tbl-empty">全库搜索中…</div>
                  ) : hits.length === 0 ? (
                    <Empty
                      compact
                      icon={<Icons.search size={20} />}
                      title="全库没有匹配的文件"
                      desc="换个关键词，或切回「当前目录」"
                    />
                  ) : (
                    <>
                      <div className="cases-hit-head">全库找到 {hits.length} 个文件</div>
                      {hits.map(h => (
                        <div
                          key={h.rel}
                          className="cases-row cases-hit"
                          onDoubleClick={() => void openPreview(h.rel, h.name)}
                          onClick={() => toggle(h.rel)}
                          title={`双击预览\n${h.rel}`}
                        >
                          <input
                            type="checkbox"
                            className="tbl-check"
                            checked={selected.has(h.rel)}
                            onChange={() => toggle(h.rel)}
                            onClick={e => e.stopPropagation()}
                            aria-label={`选择 ${h.name}`}
                          />
                          <span className={`cases-ext is-${h.ext.replace('.', '') || 'file'}`}>{extLabel(h.ext)}</span>
                          <span className="cases-main">
                            <span className="cases-name">{h.name}</span>
                            <span className="cases-meta">{h.dir || '用例库'} · {formatSize(h.size)} · {formatRecent(h.mtime)}</span>
                          </span>
                          <span className="cases-actions" onClick={e => e.stopPropagation()}>
                            <IconBtn title="预览" onClick={() => void openPreview(h.rel, h.name)}><Icons.eye size={12} /></IconBtn>
                            <IconBtn title="定位到所在目录" onClick={() => { setScope('here'); void load(h.dir); }}><Icons.folder size={12} /></IconBtn>
                            <IconBtn title="用默认应用打开" onClick={() => void openItem(h.rel)}><Icons.extern size={12} /></IconBtn>
                          </span>
                        </div>
                      ))}
                    </>
                  )
                ) : shownDirs.length === 0 && shownFiles.length === 0 ? (
                  <Empty
                    compact
                    icon={<Icons.folder size={20} />}
                    title={q ? '没有匹配的文件' : (rel ? '这个文件夹还是空的' : '用例库还是空的')}
                    desc={q ? '换个关键词试试' : '先建一个系统文件夹，再把 xmind / Excel 用例上传进来'}
                    action={
                      q ? undefined : (
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => setDlg({ kind: 'mkdir', value: '' })}
                            disabled={atMaxDepth}
                          >
                            <Icons.plus size={13} /> 新建文件夹
                          </button>
                          <button className="btn btn-primary btn-sm" onClick={() => void upload()} disabled={busy}>
                            <Icons.upload size={13} /> 上传文件
                          </button>
                        </div>
                      )
                    }
                  />
                ) : (
                  <>
                    {shownDirs.map(dirRow)}
                    {shownFiles.map(fileRow)}
                  </>
                )}
              </div>
              <div className="cases-foot">
                <Pill tone="ok">明文目录</Pill>
                <span className="text-sm text-muted">{root}</span>
              </div>
            </Panel>
          </div>
        )}

        {/* 左树右键菜单：新建子文件夹 / 重命名 / 定位 / 删除 */}
        {menu && createPortal(
          <>
            <div
              className="context-menu-overlay"
              onClick={() => setMenu(null)}
              onContextMenu={e => { e.preventDefault(); setMenu(null); }}
            />
            <div className="context-menu cases-ctx" style={{ left: menu.x, top: menu.y }} role="menu">
              {menu.rel === null ? (
                <>
                  <div className="context-menu-item" onClick={() => { setMenu(null); setDlg({ kind: 'mkdir', value: '', parent: '' }); }}>
                    <span className="context-menu-icon"><Icons.plus size={13} /></span>
                    <span>新建系统文件夹</span>
                  </div>
                  <div className="context-menu-sep" />
                  <div className="context-menu-item" onClick={() => { setMenu(null); void load(rel); }}>
                    <span className="context-menu-icon"><Icons.refresh size={13} /></span>
                    <span>刷新</span>
                  </div>
                </>
              ) : (
                <>
                  {menu.kind === 'file' ? (
                    <div className="context-menu-item" onClick={() => { const r = menu.rel as string; setMenu(null); void openItem(r); }}>
                      <span className="context-menu-icon"><Icons.extern size={13} /></span>
                      <span>用默认应用打开</span>
                    </div>
                  ) : (
                    <div className="context-menu-item" onClick={() => { const r = menu.rel as string; setMenu(null); void load(r); }}>
                      <span className="context-menu-icon"><Icons.folder size={13} /></span>
                      <span>打开文件夹</span>
                    </div>
                  )}
                  {menu.kind !== 'file' && depthOf(menu.rel) < MAX_DEPTH && (
                    <div className="context-menu-item" onClick={() => { const r = menu.rel as string; setMenu(null); setDlg({ kind: 'mkdir', value: '', parent: r }); }}>
                      <span className="context-menu-icon"><Icons.plus size={13} /></span>
                      <span>新建子文件夹</span>
                    </div>
                  )}
                  {menu.kind === 'file' && (
                    <div className="context-menu-item" onClick={() => { const r = menu.rel as string; setMenu(null); void openWithItem(r); }}>
                      <span className="context-menu-icon"><Icons.tool size={13} /></span>
                      <span>用其他应用打开…</span>
                    </div>
                  )}
                  <div className="context-menu-item" onClick={() => { const r = menu.rel as string; setMenu(null); setDlg({ kind: 'rename', rel: r, value: r.split('/').pop() || '' }); }}>
                    <span className="context-menu-icon"><Icons.pencil size={13} /></span>
                    <span>重命名</span>
                  </div>
                  <div className="context-menu-item" onClick={() => { const r = menu.rel as string; setMenu(null); void revealItem(r); }}>
                    <span className="context-menu-icon"><Icons.folder size={13} /></span>
                    <span>在资源管理器中显示</span>
                  </div>
                  <div className="context-menu-item" onClick={() => { const r = menu.rel as string; setMenu(null); void exportSelected([r]); }}>
                    <span className="context-menu-icon"><Icons.download size={13} /></span>
                    <span>导出</span>
                  </div>
                  <div className="context-menu-sep" />
                  <div className="context-menu-item is-danger" onClick={() => { const r = menu.rel as string; setMenu(null); removeOne(r, r.split('/').pop() || r); }}>
                    <span className="context-menu-icon"><Icons.trash size={13} /></span>
                    <span>删除（进回收站）</span>
                  </div>
                </>
              )}
            </div>
          </>,
          document.body,
        )}
        {/* 新建文件夹 / 重命名 */}
        <Modal
          open={!!dlg}
          onClose={() => setDlg(null)}
          title={dlg?.kind === 'rename' ? '重命名' : '新建文件夹'}
          footer={
            <>
              <button className="btn btn-secondary" onClick={() => setDlg(null)}>取消</button>
              <button
                className="btn btn-primary"
                disabled={!dlg?.value.trim()}
                onClick={() => (dlg?.kind === 'rename' ? void doRename() : void doMkdir())}
              >
                {dlg?.kind === 'rename' ? '保存' : '创建'}
              </button>
            </>
          }
        >
          <div className="form-group">
            <label>{dlg?.kind === 'rename' ? '新名称' : '文件夹名称（系统名或模块名）'}</label>
            <input
              className="input"
              value={dlg?.value || ''}
              onChange={e => setDlg(prev => (prev ? { ...prev, value: e.target.value } : prev))}
              onKeyDown={e => { if (e.key === 'Enter') { void (dlg?.kind === 'rename' ? doRename() : doMkdir()); } }}
              placeholder="例如：支付系统 / 登录模块"
              autoFocus
              aria-label="名称"
            />
            <div className="input-hint">名称里的 <code>&lt; &gt; : " / \ | ? *</code> 会被自动去掉</div>
          </div>
        </Modal>

        {/* 应用内预览：md / csv / xlsx / 图片 / 文本；其余提示用默认应用 */}
        <Modal
          open={!!preview}
          onClose={() => setPreview(null)}
          title={preview ? `预览 · ${preview.name}` : '预览'}
          className="modal-wide"
          footer={
            preview ? (
              <>
                <button className="btn btn-secondary" onClick={() => setPreview(null)}>关闭</button>
                <button className="btn btn-secondary" onClick={() => void revealItem(preview.rel)}>在文件夹中显示</button>
                <button className="btn btn-secondary" onClick={() => void openWithItem(preview.rel)}>用其他应用打开</button>
                <button className="btn btn-primary" onClick={() => void openItem(preview.rel)}>用默认应用打开</button>
              </>
            ) : undefined
          }
        >
          {preview?.loading ? (
            <div className="tbl-empty">读取文件…</div>
          ) : preview?.err ? (
            <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400 }}>{preview.err}</div>
          ) : !preview?.data ? null : (() => {
            const d = preview.data;
            if (d.kind === 'markdown') {
              return <div className="cases-md">{renderMarkdown(d.text)}</div>;
            }
            if (d.kind === 'text') {
              return <pre className="cases-pre">{d.text}</pre>;
            }
            if (d.kind === 'csv') {
              const rows = d.rows || [];
              return (
                <div className="cases-table-wrap">
                  <table className="tbl cases-preview-tbl">
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          {r.map((c, j) => <td key={j}>{c}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="text-sm text-muted">共 {rows.length} 行{rows.length >= 200 ? '（只显示前 200 行）' : ''} · {d.encoding}</div>
                </div>
              );
            }
            if (d.kind === 'table') {
              const sheet = d.sheets[previewSheet] || d.sheets[0];
              return (
                <>
                  {d.sheets.length > 1 && (
                    <div className="tabs cases-sheet-tabs">
                      {d.sheets.map((s, i) => (
                        <button
                          key={s.name}
                          className={`tab2${i === previewSheet ? ' is-active' : ''}`}
                          onClick={() => setPreviewSheet(i)}
                        >
                          {s.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="cases-table-wrap">
                    <table className="tbl cases-preview-tbl">
                      <tbody>
                        {(sheet?.rows || []).map((r, i) => (
                          <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                    {sheet?.more && <div className="text-sm text-muted">只显示前 200 行</div>}
                  </div>
                </>
              );
            }
            if (d.kind === 'image') {
              return <div className="cases-img-wrap"><img src={d.dataUrl} alt={d.name} /></div>;
            }
            if (d.kind === 'too-large') {
              return (
                <Empty
                  compact
                  title="文件太大，没有在应用内预览"
                  desc={`${formatSize(d.size)}，超过 8 MB 上限`}
                  action={<button className="btn btn-primary btn-sm" onClick={() => preview && void openItem(preview.rel)}>用默认应用打开</button>}
                />
              );
            }
            return (
              <Empty
                compact
                title="这个类型不支持应用内预览"
                desc="xmind / pdf / 压缩包等请用默认应用打开"
                action={<button className="btn btn-primary btn-sm" onClick={() => preview && void openItem(preview.rel)}>用默认应用打开</button>}
              />
            );
          })()}
        </Modal>
        <ToastContainer toasts={toasts} onRemove={removeToast} />

        {confirmNode}
      </Page>
    </div>
  );
}

















