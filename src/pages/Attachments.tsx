import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AttachmentFileMeta, Note, WeeklyFile } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useStore } from '../store/useStore';
import { useConfirm } from '../components/confirm';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons, Pill } from '../components/ui';
import { Modal } from '../components/Modal';
import { Pager } from '../components/Pager';
import { ToastContainer } from '../components/Toast';
import { useToast } from '../hooks/useToast';
import { AttImage } from '../components/MarkdownView';
import { ImageLightbox } from '../components/ImageLightbox';
import { extractAttIds } from '../utils/attachRefs';
import { copyPlain } from '../utils/clipboard';
import { formatRecent } from '../utils/time';

/**
 * 附件集中管理。
 *
 * 附件（截图、密钥文件、证书）本来是散在「网址管理」的条目里和「测试笔记」的正文里的，
 * 想找一张图只能挨个点开。这一页把 attachments 目录整个列出来，并反查它被谁引用：
 * - 引用关系在渲染层算：主进程只给 id/大小/时间，不碰业务数据；
 * - 缩略图按需逐张解密（`AttImage`），一页几百个附件也不会一次性全解；
 * - 「未被引用」单独标出来 —— 删条目时附件不会跟着删，这些就是可以清理的孤儿。
 */
export function AttachmentsBody({ afterHead }: { afterHead?: React.ReactNode } = {}) {
  // 条目走 store（entries 不在 vaultCollections 里，ws:get 读不到），笔记走通用集合
  const entries = useStore(s => s.entries);
  /** 目录模式笔记的位置：设置页新入口写的是 settings.notesDir，旧版本只在 localStorage */
  const settings = useStore(s => s.settings);
  const { items: notes } = useCollection<Note>('notes');
  const [files, setFiles] = useState<AttachmentFileMeta[]>([]);
  /** 附件目录（磁盘绝对路径）：目录为空时也要能显示 */
  const [dir, setDir] = useState('');
  /** 笔记附件目录（`<笔记目录>/attachments`，1.25.1）：未启用目录模式时为空串 */
  const [notesDir, setNotesDir] = useState('');
  /** 目录是否真的存在：自定义到移动硬盘后拔出时，要明确告诉用户而不是显示「0 个附件」 */
  const [dirExists, setDirExists] = useState(true);
  /** 来源筛选：全部 / 笔记目录 / 全局目录（1.25.1） */
  const [scopeFilter, setScopeFilter] = useState<'all' | 'note' | 'entry'>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [onlyOrphan, setOnlyOrphan] = useState(false);
  /** 页面级提示改用全局 toast（右上浮层、3 秒自动消失），不再在列表上方插一行字 */
  const { toasts, addToast, removeToast } = useToast();
  /** 点缩略图进灯箱：与测试笔记一致，滚轮缩放 / 拖动 / Esc 关闭 */
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  /** 非图片附件（证书/密钥）：缩略图读不出来的原因，按 id 记 */
  const [brokenKinds, setBrokenKinds] = useState<Record<string, 'missing' | 'not-image'>>({});
  /** 文本预览（非图片附件能按 UTF-8 读出来时） */
  const [textPreview, setTextPreview] = useState<{ title: string; text: string; truncated: boolean; size: number } | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  /** 批量导出用的多选（附件 id） */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);
  const { ask, confirmNode } = useConfirm();

  /** 成功绿 / 失败红 / 提示蓝 */
  const flash = (msg: string, type: 'success' | 'error' | 'info' = 'success') => addToast(msg, type);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.electronAPI.attachmentList();
      if (!r.success) { setError(r.error || '读取附件目录失败'); setFiles([]); return; }
      setError('');
      setFiles(r.data || []);
      setDir(r.dir || r.data?.[0]?.dir || '');
      setNotesDir(r.notesDir || '');
      setDirExists(r.dirExists !== false);
      setBrokenKinds({});
      setPage(1);
    } catch {
      setError('读取附件目录失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  /**
   * 反查引用：附件 id → 引用它的条目 / 笔记。
   * 条目附件在 `entry.attachments`，笔记图片在正文的 `pm-att:<id>` 里。
   *
   * 1.24.4：笔记有两种存储模式——加密库集合（上面 `notes`）和自选目录（.md 文件，
   * Notes 页的 LS_DIR）。目录模式笔记的正文同样能粘图，此前只扫集合，
   * 导致目录模式用户的所有笔记截图都被标成「未引用」。
   */
  const vaultOwners = useMemo(() => {
    const map = new Map<string, { kind: 'entry' | 'note'; id: string; label: string }[]>();
    const push = (attId: string, owner: { kind: 'entry' | 'note'; id: string; label: string }) => {
      const list = map.get(attId);
      if (list) list.push(owner);
      else map.set(attId, [owner]);
    };
    for (const e of entries || []) {
      for (const a of e.attachments || []) {
        push(a.id, { kind: 'entry', id: e.id, label: e.name || '未命名' });
      }
    }
    for (const n of notes || []) {
      for (const id of extractAttIds(n.content || '')) {
        push(id, { kind: 'note', id: n.id, label: n.title || '未命名笔记' });
      }
    }
    return map;
  }, [entries, notes]);

  /** 目录模式笔记（.md 文件）正文里的附件引用；打开页面时读一次 */
  const [dirOwners, setDirOwners] = useState<Map<string, { kind: 'note'; id: string; label: string }[]>>(new Map());
  useEffect(() => {
    let alive = true;
    void (async () => {
      // 设置页的目录入口只写 settings，旧版本只写 localStorage：两处都要认，
      // 否则从设置页选的目录会被这里当成「没有目录模式笔记」，图片全被标成未引用。
      let dir = settings.notesDir || '';
      if (!dir) {
        try { dir = localStorage.getItem('pm.notes.dir') || ''; } catch { /* 忽略 */ }
      }
      if (!dir) { setDirOwners(new Map()); return; }
      const lr = await window.electronAPI.notesList(dir);
      if (!alive) return;
      if (!lr.success || !Array.isArray(lr.data)) return;
      const map = new Map<string, { kind: 'note'; id: string; label: string }[]>();
      for (const f of (lr.data as WeeklyFile[])) {
        const r = await window.electronAPI.notesRead(dir, f.name);
        const body = r.success && r.data ? String(r.data.content || '') : '';
        for (const attId of extractAttIds(body)) {
          const owner = { kind: 'note' as const, id: f.name, label: f.name.replace(/\.md$/i, '') || '未命名笔记' };
          const list = map.get(attId);
          if (list) list.push(owner);
          else map.set(attId, [owner]);
        }
      }
      if (alive) setDirOwners(map);
    })();
    return () => { alive = false; };
  }, [settings.notesDir]);

  const owners = useMemo(() => {
    if (dirOwners.size === 0) return vaultOwners;
    const map = new Map(vaultOwners);
    for (const [k, v] of dirOwners) {
      const ex = map.get(k);
      map.set(k, ex ? [...ex, ...v] : v);
    }
    return map;
  }, [vaultOwners, dirOwners]);

  /**
   * 附件原名：只有条目附件在 vault 里存了 name（笔记里的截图没有），
   * 导出时用它保住扩展名，卡片上也显示它。
   */
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries || []) {
      for (const a of e.attachments || []) {
        if (a.name) map.set(a.id, a.name);
      }
    }
    return map;
  }, [entries]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return files
      .map(f => ({ ...f, name: names.get(f.id) || '', owners: owners.get(f.id) || [] }))
      .filter(f => {
        // 1.25.1：来源筛选（笔记目录 / 全局目录）
        if (scopeFilter !== 'all' && (f.scope || 'entry') !== scopeFilter) return false;
        if (onlyOrphan && f.owners.length > 0) return false;
        if (!q) return true;
        return f.id.toLowerCase().includes(q)
          || f.name.toLowerCase().includes(q)
          || f.owners.some(o => o.label.toLowerCase().includes(q));
      });
  }, [files, owners, names, search, onlyOrphan, scopeFilter]);

  /** 两个来源各有多少个（筛选条计数） */
  const scopeCounts = useMemo(() => {
    let note = 0;
    let entry = 0;
    for (const f of files) {
      if ((f.scope || 'entry') === 'note') note += 1;
      else entry += 1;
    }
    return { all: files.length, note, entry };
  }, [files]);

  const orphanCount = useMemo(
    () => files.filter(f => (owners.get(f.id) || []).length === 0).length,
    [files, owners],
  );

  // 分页：几百个附件一次性渲染会卡（每个缩略图都要解密），一页 24 个（4×6）
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const curPage = Math.min(page, totalPages);
  const pagedRows = useMemo(
    () => rows.slice((curPage - 1) * pageSize, curPage * pageSize),
    [rows, curPage, pageSize],
  );

  const totalBytes = useMemo(() => files.reduce((n, f) => n + (f.size || 0), 0), [files]);

  const exportOne = async (f: AttachmentFileMeta & { name?: string }) => {
    const r = await window.electronAPI.attachmentExport({ id: f.id, name: f.name });
    if (r.canceled) return;
    if (!r.success) { flash(r.error || '导出失败', 'error'); return; }
    flash('已导出');
  };

  /**
   * 批量导出所选附件。
   *
   * 换机/交接时一个个点太慢。主进程按 id 逐个解密后写到用户选的目录，
   * 重名自动加 -2/-3 后缀（绝不覆盖已有文件），单个失败不影响其它。
   * 结果必须如实汇报「导出几个 / 跳过几个 / 失败几个」，不能只说「已导出」。
   */
  const exportSelected = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setExporting(true);
    try {
      const r = await window.electronAPI.attachmentExportMany({ ids });
      if (r.canceled) return;   // 用户取消选目录：不算失败，不弹错误
      if (!r.success || !r.data) { flash(r.error || '批量导出失败', 'error'); return; }
      const { dir, exported, skipped, failed } = r.data;
      const extra: string[] = [];
      if (skipped > 0) extra.push(`跳过 ${skipped} 个重名`);
      if (failed > 0) extra.push(`失败 ${failed} 个`);
      flash(`已导出 ${exported} 个到 ${dir}${extra.length ? `（${extra.join('，')}）` : ''}`);
      if (exported > 0) setSelectedIds(new Set());
    } catch (e) {
      flash(e instanceof Error ? e.message : '批量导出失败', 'error');
    } finally {
      setExporting(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  /** 全选/取消全选「当前筛选结果」（不是全库），符合用户看到什么选什么的直觉 */
  const allRowsSelected = rows.length > 0 && rows.every(f => selectedIds.has(f.id));
  const toggleSelectAll = () => {
    if (allRowsSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map(f => f.id)));
  };

  /** 与测试笔记里的图片查看一致：解密出 dataURL 后交给灯箱 */
  const openZoom = async (f: AttachmentFileMeta & { name?: string }) => {
    // 已知不是图片（证书/密钥）：直接走文本预览，别再去解一次图
    if (brokenKinds[f.id] === 'not-image') { void previewText(f); return; }
    const r = await window.electronAPI.attachmentReadImage({ id: f.id });
    if (!r.success || !r.data?.dataUrl) {
      if (r.code === 'not-image') {
        setBrokenKinds(prev => ({ ...prev, [f.id]: 'not-image' }));
        void previewText(f);
        return;
      }
      flash('图片无法读取', 'error');
      return;
    }
    setZoom({ src: r.data.dataUrl, alt: f.name || `附件 ${f.id.slice(0, 8)}` });
  };

  /** 在资源管理器里定位这个附件（或直接打开附件目录） */
  const reveal = async (id?: string) => {
    const r = await window.electronAPI.attachmentReveal(id ? { id } : undefined);
    if (!r.success) flash(r.error || '打开目录失败', 'error');
  };

  /** 打开笔记附件目录（`<笔记目录>/attachments`）：先确保它存在，再交给主进程定位 */
  const revealNoteDir = async () => {
    const r = await window.electronAPI.attachmentEnsureNoteDir();
    if (!r.success || !r.data?.dir) { flash(r.error || '笔记附件目录不可用', 'error'); return; }
    // 目录里可能还没有附件：attachmentReveal 不带 id 时打开的是全局目录，
    // 所以这里用「打开目录」的通用能力（notesReveal 只认笔记目录，正好）
    const nr = await window.electronAPI.notesReveal(r.data.dir);
    if (!nr.success) flash(nr.error || '打开目录失败', 'error');
  };

  const copyDir = async () => {
    if (!dir) return;
    await copyPlain(dir);
    flash('已复制附件目录');
  };

  /** 更改附件目录：主进程先把已有附件复制过去，成功才切换，不用重启 */
  const changeDir = async () => {
    const p = await window.electronAPI.attachmentPickDir();
    if (!p.success || !p.data?.dir) return;
    const r = await window.electronAPI.attachmentSetDir({ dir: p.data.dir });
    if (!r.success || !r.data) { flash(r.error || '切换附件目录失败', 'error'); return; }
    flash(r.data.copied
      ? `已切换附件目录，复制 ${r.data.copied} 个附件`
      : '已切换附件目录（目标目录已有全部附件）');
    void load();
  };

  /**
   * 非图片附件（证书 / 密钥 / 配置）：按 UTF-8 读一段给用户看。
   * 二进制文件主进程会拒绝，提示导出。
   */
  const previewText = async (f: AttachmentFileMeta & { name?: string }) => {
    const r = await window.electronAPI.attachmentTextPreview({ id: f.id });
    if (!r.success || !r.data) { flash(r.error || '无法预览，请导出后查看', 'error'); return; }
    setTextPreview({
      title: f.name || `附件 ${f.id.slice(0, 8)}`,
      text: r.data.text,
      truncated: r.data.truncated,
      size: r.data.size,
    });
  };

  const removeOne = (f: AttachmentFileMeta) => {
    const used = owners.get(f.id) || [];
    ask({
      title: '删除附件',
      message: used.length
        ? `这个附件还被 ${used.length} 处引用（${used.slice(0, 3).map(u => u.label).join('、')}${used.length > 3 ? ' 等' : ''}），删除后那些位置会显示「图片已失效」。确定删除？`
        : '这个附件没有被任何条目或笔记引用，可以安全删除。',
      confirmText: '删除',
      onOk: async () => {
        const r = await window.electronAPI.attachmentDelete({ id: f.id });
        if (!r.success) { flash(r.error || '删除失败', 'error'); return; }
        setFiles(prev => prev.filter(x => x.id !== f.id));
        flash('已删除');
      },
    });
  };

  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <>
        <PageHead
          icon={<Icons.image size={16} />}
          title="附件管理"
          desc="截图与文件都加密存在本地；这里能看到每个附件被谁引用，也能清理没人用的"
          tools={
            <>
              {/* 空库时「搜索 / 仅未引用」没有意义，只留刷新与导出 */}
              {files.length > 0 && (
                <>
                  <SearchBox value={search} onChange={v => { setSearch(v); setPage(1); }} placeholder="搜索附件 id / 引用它的条目" />
                  <button
                    className={`btn btn-sm ${onlyOrphan ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => { setOnlyOrphan(v => !v); setPage(1); }}
                    title="只显示没有被任何条目或笔记引用的附件"
                  >
                    仅未引用{orphanCount ? ` (${orphanCount})` : ''}
                  </button>
                </>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => void load()} title="重新扫描附件目录">
                <Icons.refresh size={13} /> 刷新
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void exportSelected()}
                disabled={selectedIds.size === 0 || exporting}
                title="把选中的附件解密后导出到你选的目录（重名自动加后缀，不覆盖）"
              >
                <Icons.download size={13} /> {exporting ? '导出中…' : `导出所选${selectedIds.size > 0 ? `（${selectedIds.size}）` : ''}`}
              </button>
            </>
          }
        />

        {afterHead}

        {dir && (
          <div className="att-dir-bar">
            <Icons.folder size={13} />
            <span className="att-dir-label">全局目录</span>
            <code className="att-dir-path" title={dir}>{dir}</code>
            {!dirExists && <span className="att-dir-warn">目录不存在（移动硬盘没插？）</span>}
            <button type="button" className="btn btn-ghost btn-sm att-dir-btn" onClick={() => void copyDir()}>
              复制路径
            </button>
            <button type="button" className="btn btn-ghost btn-sm att-dir-btn" onClick={() => void reveal()}>
              打开目录
            </button>
            <button type="button" className="btn btn-ghost btn-sm att-dir-btn" onClick={() => void changeDir()} title="更改附件存放位置（含随手记粘贴的图片）">
              更改目录
            </button>
          </div>
        )}

        {/* 1.25.1：笔记附件单独一个目录（<笔记目录>/attachments），与 .md 文件放在一起 */}
        {notesDir && (
          <div className="att-dir-bar att-dir-bar-note">
            <Icons.note size={13} />
            <span className="att-dir-label">笔记目录</span>
            <code className="att-dir-path" title={notesDir}>{notesDir}</code>
            <button type="button" className="btn btn-ghost btn-sm att-dir-btn" onClick={() => void copyPlain(notesDir).then(() => flash('已复制笔记附件目录'))}>
              复制路径
            </button>
            <button type="button" className="btn btn-ghost btn-sm att-dir-btn" onClick={() => void revealNoteDir()}>
              打开目录
            </button>
            <span className="att-dir-hint">目录模式笔记里粘贴的截图存这里，跟着笔记目录走</span>
          </div>
        )}


        {/* 1.25.1：附件现在有两个来源（笔记目录 / 全局目录），给一个来源筛选 */}
        {files.length > 0 && (
          <div className="notes-kind-bar att-scope-bar">
            {([
              ['all', `全部 ${scopeCounts.all}`],
              ['note', `笔记目录 ${scopeCounts.note}`],
              ['entry', `全局目录 ${scopeCounts.entry}`],
            ] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`view-switch-btn${scopeFilter === k ? ' is-on' : ''}`}
                onClick={() => { setScopeFilter(k); setPage(1); }}
              >{label}</button>
            ))}
          </div>
        )}

        <Panel
          title="附件"
          meta={`${files.length} 个 · ${kb(totalBytes)}${orphanCount ? ` · ${orphanCount} 个未引用` : ''}`}
        >
          {error ? (
            <div className="tbl-empty">{error}</div>
          ) : loading ? (
            <div className="tbl-empty">扫描附件目录…</div>
          ) : rows.length === 0 ? (
            <Empty
              icon={<Icons.image size={22} />}
              title={files.length === 0 ? '还没有附件' : '没有匹配的附件'}
              desc={files.length === 0
                ? '在「网址管理」的条目里添加附件，或在「测试笔记」里 Ctrl+V 粘贴截图，都会出现在这里'
                : '换个关键字，或关掉「仅未引用」'}
            />
          ) : (
            <>
            <div className="att-bulk-bar">
              <label className="att-bulk-all">
                <input type="checkbox" checked={allRowsSelected} onChange={toggleSelectAll} aria-label="全选当前筛选结果" />
                全选当前 {rows.length} 个
              </label>
              {selectedIds.size > 0 && (
                <>
                  <span className="att-bulk-count">已选 {selectedIds.size} 个</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelectedIds(new Set())}>清空选择</button>
                </>
              )}
            </div>
            <div className="att-grid">
              {pagedRows.map(f => (
                <div key={f.id} className={`att-card${selectedIds.has(f.id) ? ' is-selected' : ''}`}>
                  <label className="att-card-check" title="选中以批量导出">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(f.id)}
                      onChange={() => toggleSelect(f.id)}
                      aria-label={`选中附件 ${f.name || f.id.slice(0, 8)}`}
                    />
                  </label>
                  <button
                    type="button"
                    className="att-card-thumb"
                    onClick={() => void openZoom(f)}
                    title={brokenKinds[f.id] === 'not-image' ? '点击预览文本 / 导出' : '点击放大 / 缩小（与测试笔记一致）'}
                  >
                    <AttImage
                      id={f.id}
                      alt="附件预览"
                      onBroken={(code) => setBrokenKinds(prev => (prev[f.id] === code ? prev : { ...prev, [f.id]: code }))}
                    />
                  </button>
                  <div className="att-card-body">
                    <div className="att-card-name" title={f.name || f.id}>
                      {f.name || `附件 ${f.id.slice(0, 8)}`}
                    </div>
                    <div className="att-card-dir" title={f.file || f.dir || ''}>
                      <Icons.folder size={11} /> {f.dir || '—'}
                    </div>
                    {/* 来源：笔记目录 / 全局目录（1.25.1） */}
                    <div className="att-card-scope">
                      <span className={`att-scope-chip${(f.scope || 'entry') === 'note' ? ' is-note' : ''}`}>
                        {(f.scope || 'entry') === 'note' ? '笔记目录' : '全局目录'}
                      </span>
                    </div>
                    <div className="att-card-meta">
                      <span className="att-card-size">{kb(f.size)}</span>
                      <span className="att-card-time" title={f.updatedAt}>{formatRecent(f.updatedAt)}</span>
                    </div>
                    <div className="att-card-owners">
                      {f.owners.length === 0 ? (
                        <Pill tone="warn">未引用</Pill>
                      ) : (
                        f.owners.slice(0, 2).map(o => (
                          <span key={`${o.kind}:${o.id}`} className="att-owner" title={o.label}>
                            {o.kind === 'entry' ? <Icons.link size={11} /> : <Icons.note size={11} />}
                            {o.label}
                          </span>
                        ))
                      )}
                      {f.owners.length > 2 && <span className="att-owner-more">+{f.owners.length - 2}</span>}
                    </div>
                  </div>
                  <div className="att-card-actions">
                    <IconBtn title={f.file ? `定位文件：${f.file}` : '定位附件文件'} onClick={() => void reveal(f.id)}><Icons.folder size={13} /></IconBtn>
                    <IconBtn title="导出到本地" onClick={() => void exportOne(f)}><Icons.download size={13} /></IconBtn>
                    <IconBtn title="删除附件" danger onClick={() => removeOne(f)}><Icons.trash size={13} /></IconBtn>
                  </div>
                </div>
              ))}
            </div>
            {rows.length > pageSize && (
              <Pager
                total={rows.length}
                page={curPage}
                pageSize={pageSize}
                onPage={setPage}
                onPageSize={setPageSize}
                pageSizes={[24, 48, 96]}
              />
            )}
            </>
          )}
        </Panel>
      {zoom && <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
      <Modal
        open={!!textPreview}
        onClose={() => setTextPreview(null)}
        title={textPreview ? `预览：${textPreview.title}` : '预览'}
        className="att-preview-modal"
      >
        {textPreview && (
          <>
            <div className="text-sm text-muted" style={{ marginBottom: 8 }}>
              {Math.max(1, Math.round(textPreview.size / 1024))} KB
              {textPreview.truncated ? '（文件较大，只显示前面一部分）' : ''}
            </div>
            <pre className="att-text-view">{textPreview.text}</pre>
          </>
        )}
      </Modal>
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {confirmNode}
    </>
  );
}

/**
 * 独立页面外壳。
 * 侧栏已把「测试笔记 / 附件管理」合并成一项「笔记与附件」（NotesAttachments.tsx），
 * 这个导出保留给旧路由 / 直达链接使用，行为与合并页里的「附件」页签一致。
 */
export function Attachments() {
  return (
    <div className="content-area">
      <Page>
        <AttachmentsBody />
      </Page>
    </div>
  );
}
