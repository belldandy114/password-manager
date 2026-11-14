import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { AttachmentFileMeta, Note, WeeklyFile } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useStore } from '../store/useStore';
import { useConfirm } from '../components/confirm';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons, Pill } from '../components/ui';
import { AttImage } from '../components/MarkdownView';
import { extractAttIds } from '../utils/attachRefs';
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
export function Attachments() {
  // 条目走 store（entries 不在 vaultCollections 里，ws:get 读不到），笔记走通用集合
  const entries = useStore(s => s.entries);
  const { items: notes } = useCollection<Note>('notes');
  const [files, setFiles] = useState<AttachmentFileMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [onlyOrphan, setOnlyOrphan] = useState(false);
  const [hint, setHint] = useState('');
  const { ask, confirmNode } = useConfirm();

  const flash = (msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint(''), 1800);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.electronAPI.attachmentList();
      if (!r.success) { setError(r.error || '读取附件目录失败'); setFiles([]); return; }
      setError('');
      setFiles(r.data || []);
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
      let dir = '';
      try { dir = localStorage.getItem('pm.notes.dir') || ''; } catch { /* 忽略 */ }
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
  }, []);

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
        if (onlyOrphan && f.owners.length > 0) return false;
        if (!q) return true;
        return f.id.toLowerCase().includes(q)
          || f.name.toLowerCase().includes(q)
          || f.owners.some(o => o.label.toLowerCase().includes(q));
      });
  }, [files, owners, names, search, onlyOrphan]);

  const orphanCount = useMemo(
    () => files.filter(f => (owners.get(f.id) || []).length === 0).length,
    [files, owners],
  );

  const totalBytes = useMemo(() => files.reduce((n, f) => n + (f.size || 0), 0), [files]);

  const exportOne = async (f: AttachmentFileMeta & { name?: string }) => {
    const r = await window.electronAPI.attachmentExport({ id: f.id, name: f.name });
    if (r.canceled) return;
    if (!r.success) { flash(r.error || '导出失败'); return; }
    flash('已导出');
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
        if (!r.success) { flash(r.error || '删除失败'); return; }
        setFiles(prev => prev.filter(x => x.id !== f.id));
        flash('已删除');
      },
    });
  };

  const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.image size={16} />}
          title="附件管理"
          desc="截图与文件都加密存在本地；这里能看到每个附件被谁引用，也能清理没人用的"
          tools={
            <>
              <SearchBox value={search} onChange={setSearch} placeholder="搜索附件 id / 引用它的条目" />
              <button
                className={`btn btn-sm ${onlyOrphan ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setOnlyOrphan(v => !v)}
                title="只显示没有被任何条目或笔记引用的附件"
              >
                仅未引用{orphanCount ? ` (${orphanCount})` : ''}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={() => void load()} title="重新扫描附件目录">
                <Icons.refresh size={13} /> 刷新
              </button>
            </>
          }
        />

        {hint && <div className="inline-hint">{hint}</div>}

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
            <div className="att-grid">
              {rows.map(f => (
                <div key={f.id} className="att-card">
                  <div className="att-card-thumb">
                    <AttImage id={f.id} alt="附件预览" />
                  </div>
                  <div className="att-card-body">
                    <div className="att-card-name" title={f.name || f.id}>
                      {f.name || `附件 ${f.id.slice(0, 8)}`}
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
                    <IconBtn title="导出到本地" onClick={() => void exportOne(f)}><Icons.download size={13} /></IconBtn>
                    <IconBtn title="删除附件" danger onClick={() => removeOne(f)}><Icons.trash size={13} /></IconBtn>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </Page>
      {confirmNode}
    </div>
  );
}
