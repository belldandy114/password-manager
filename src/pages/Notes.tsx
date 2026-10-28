import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Note, WeeklyFile } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Modal } from '../components/Modal';
import { useConfirm } from '../components/confirm';
import { Page, PageHead, Panel, Empty, IconBtn, SearchBox, Icons } from '../components/ui';
import { formatRecent } from '../utils/time';

const LS_DIR = 'pm.notes.dir';

const emptyNote = (): Note => ({
  id: '', title: '', content: '', tags: [], updatedAt: new Date().toISOString(),
});

function escapeHtml(s: string) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' } as Record<string, string>)[c]);
}

/** 极简 Markdown 渲染（标题/列表/粗体/行内代码/代码块），内容全部先转义 */
function mdToHtml(md: string): string {
  const lines = escapeHtml(md || '').split('\n');
  let html = '';
  let inCode = false;
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += line + '\n'; continue; }
    if (/^### /.test(line)) html += `<h4>${line.slice(4)}</h4>`;
    else if (/^## /.test(line)) html += `<h3>${line.slice(3)}</h3>`;
    else if (/^# /.test(line)) html += `<h2>${line.slice(2)}</h2>`;
    else if (/^\s*[-*] /.test(line)) html += `<li>${line.replace(/^\s*[-*] /, '')}</li>`;
    else if (line.trim() === '') html += '<div style="height:8px"></div>';
    else html += `<p>${line}</p>`;
  }
  if (inCode) html += '</code></pre>';
  return html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
};

/** 文件名 → 显示标题（去掉扩展名） */
const titleOf = (name: string) => String(name || '').replace(/\.(md|markdown|txt)$/i, '');

/** 标题 → 合法文件名 */
const fileOf = (title: string) =>
  `${String(title || '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').slice(0, 80) || '未命名笔记'}.md`;

export function Notes() {
  const { items, save, loading } = useCollection<Note>('notes');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Note | null>(null);
  const { ask, confirmNode } = useConfirm();
  const [preview, setPreview] = useState<Note | null>(null);

  /* ---------- 自选目录模式（一篇一个 .md 文件） ---------- */
  const [dir, setDir] = useState(() => localStorage.getItem(LS_DIR) || '');
  const [files, setFiles] = useState<WeeklyFile[]>([]);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState('');
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [dirEditing, setDirEditing] = useState<{ name: string; title: string; content: string } | null>(null);
  const [dirPreview, setDirPreview] = useState<{ name: string; title: string; content: string; mtime: string } | null>(null);
  const [dirSaving, setDirSaving] = useState(false);

  const dirMode = !!dir;

  const loadDir = useCallback(async (target: string) => {
    if (!target) return;
    setDirLoading(true);
    setDirError('');
    const res = await window.electronAPI.notesList(target);
    setDirLoading(false);
    if (!res.success) {
      setDirError(res.error || '读取目录失败');
      setFiles([]);
      return;
    }
    setFiles(res.data || []);
    setBodies({});
  }, []);

  useEffect(() => { if (dir) loadDir(dir); }, [dir, loadDir]);

  const pickDir = async () => {
    const res = await window.electronAPI.notesPickDir();
    if (res.success && res.data) {
      setDir(res.data);
      localStorage.setItem(LS_DIR, res.data);
      setPreview(null);
    }
  };

  const useLocalVault = () => {
    setDir('');
    localStorage.removeItem(LS_DIR);
    setDirError('');
    setFiles([]);
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
    const cached = bodies[f.name];
    if (cached !== undefined) {
      setDirPreview(null);
      setDirEditing({ name: f.name, title: titleOf(f.name), content: cached });
      return;
    }
    const r = await window.electronAPI.notesRead(dir, f.name);
    if (r.success && r.data) {
      setBodies(b => ({ ...b, [f.name]: r.data!.content }));
      setDirPreview(null);
      setDirEditing({ name: f.name, title: titleOf(f.name), content: r.data.content });
    }
  };

  const saveDirNote = async () => {
    if (!dirEditing) return;
    const title = dirEditing.title.trim();
    if (!title) { setDirError('请填写标题'); return; }
    setDirSaving(true);
    setDirError('');
    let name = dirEditing.name;
    if (!name) {
      // 新建：文件名交给主进程按标题生成（重名会自动加 -2，不会覆盖已有笔记）
      const r = await window.electronAPI.notesSave(dir, '', dirEditing.content, title);
      name = r.success && r.data ? r.data.name : fileOf(title);
      if (!r.success) setDirError(r.error || '保存失败');
    } else {
      const want = fileOf(title);
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
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? items.filter(n => [n.title, n.content, (n.tags || []).join(' ')].some(v => (v || '').toLowerCase().includes(q)))
      : items;
    return [...list].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  }, [items, search]);

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

  /* ---------- 目录模式下的搜索结果 ---------- */
  const dirVisible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter(f =>
      f.name.toLowerCase().includes(q) || (bodies[f.name] || '').toLowerCase().includes(q),
    );
  }, [files, search, bodies]);

  useEffect(() => {
    if (dirMode && search.trim()) ensureBodies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirMode, search]);

  const dirBar = (
    <div className="notes-dirbar">
      <Icons.folder size={13} />
      <span className="notes-dirpath" title={dir}>{dir}</span>
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
          desc={dirMode ? '笔记以 .md 文件保存在你选择的目录里，可随时用其它编辑器打开' : '踩坑记录、测试结论、环境说明，支持 Markdown，加密保存在本地'}
          tools={
            <>
              {!dirMode && (
                <button className="btn btn-secondary btn-sm" onClick={pickDir} title="改为保存到自己选的目录">
                  <Icons.folder size={13} /> 存到目录
                </button>
              )}
              <SearchBox value={search} onChange={setSearch} placeholder={dirMode ? '搜索文件名 / 正文' : '搜索标题 / 内容'} />
              <button
                className="btn btn-primary btn-sm"
                onClick={() => (dirMode ? setDirEditing({ name: '', title: '', content: '' }) : setEditing(emptyNote()))}
              >
                <Icons.plus size={13} /> 新建笔记
              </button>
            </>
          }
        />

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
                desc="点右上角「新建笔记」，会在这个目录下生成一个 .md 文件"
                action={
                  <button className="btn btn-primary btn-sm" onClick={() => setDirEditing({ name: '', title: '', content: '' })}>
                    <Icons.plus size={13} /> 新建笔记
                  </button>
                }
              />
            </Panel>
          ) : dirVisible.length === 0 ? (
            <Panel><div className="tbl-empty">没有匹配的笔记，换个关键词试试{scanning ? '（正在检索正文…）' : ''}</div></Panel>
          ) : (
            <div className="cards">
              {dirVisible.map(f => (
                <div key={f.name} className="card2 is-clickable" onClick={() => openDirNote(f)}>
                  <div className="card2-head">
                    <div className="card2-title" title={titleOf(f.name)}>{titleOf(f.name)}</div>
                    <div className="card2-actions" onClick={e => e.stopPropagation()}>
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
                    <Icons.note size={11} />
                    {fmtDate(f.mtime)}
                    <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>
                      {(f.size / 1024).toFixed(1)} KB
                    </span>
                  </div>
                  <div className="card2-body" style={{
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}>
                    {(bodies[f.name] !== undefined
                      ? bodies[f.name]
                      : ''
                    ).replace(/[#*`>]/g, '').replace(/\n+/g, ' ').trim() || '（点开查看正文）'}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : loading ? (
          /* ---------------- 本地加密库模式 ---------------- */
          <Panel><div className="tbl-empty">加载中…</div></Panel>
        ) : filtered.length === 0 ? (
          <Panel>
            <Empty
              icon={<Icons.note size={22} />}
              title={search ? '没有匹配的笔记' : '还没有笔记'}
              desc={search ? '换个关键词试试' : '记下第一个测试结论或踩坑记录，支持 Markdown 语法'}
              action={search ? undefined : (
                <button className="btn btn-primary btn-sm" onClick={() => setEditing(emptyNote())}>
                  <Icons.plus size={13} /> 新建笔记
                </button>
              )}
            />
          </Panel>
        ) : (
          <div className="cards">
            {filtered.map(n => (
              <div key={n.id} className="card2 is-clickable" onClick={() => setPreview(n)}>
                <div className="card2-head">
                  <div className="card2-title" title={n.title}>{n.title}</div>
                  <div className="card2-actions" onClick={e => e.stopPropagation()}>
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
                  <Icons.note size={11} />
                  {fmtDate(n.updatedAt)}
                  {n.tags?.length > 0 && <span className="chip" style={{ marginLeft: 'auto' }}>{n.tags.join(' · ')}</span>}
                </div>

                <div className="card2-body" style={{
                  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}>
                  {(n.content || '').replace(/[#*`>]/g, '').replace(/\n+/g, ' ').trim() || '（空笔记）'}
                </div>
              </div>
            ))}
          </div>
        )}
      </Page>

      {/* 本地库：编辑 */}
      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? '编辑笔记' : '新建笔记'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={saveEditing}>保存</button>
          </>
        }
      >
        {editing && (
          <>
            <div className="form-group">
              <label>标题 *</label>
              <input value={editing.title} onChange={e => setEditing({ ...editing, title: e.target.value })} placeholder="例如：资产系统登录偶发 500 的排查" autoFocus />
            </div>
            <div className="form-group">
              <label>内容（支持 Markdown）</label>
              <textarea
                value={editing.content}
                onChange={e => setEditing({ ...editing, content: e.target.value })}
                rows={16}
                className="code-input"
                placeholder={'## 现象\n\n## 原因\n\n## 结论'}
              />
            </div>
          </>
        )}
      </Modal>

      {/* 本地库：预览 */}
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title={preview?.title || ''}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setPreview(null)}>关闭</button>
            <button className="btn btn-primary" onClick={() => { setEditing(preview); setPreview(null); }}>编辑</button>
          </>
        }
      >
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: mdToHtml(preview?.content || '') }} />
      </Modal>

      {/* 目录模式：编辑 */}
      <Modal
        open={!!dirEditing}
        onClose={() => setDirEditing(null)}
        title={dirEditing?.name ? '编辑笔记' : '新建笔记'}
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
            <div className="form-group">
              <label>标题 *（同时作为文件名）</label>
              <input
                value={dirEditing.title}
                onChange={e => setDirEditing({ ...dirEditing, title: e.target.value })}
                placeholder="例如：资产系统登录偶发 500 的排查"
                autoFocus
              />
            </div>
            <div className="form-group">
              <label>内容（Markdown）</label>
              <textarea
                value={dirEditing.content}
                onChange={e => setDirEditing({ ...dirEditing, content: e.target.value })}
                rows={16}
                className="code-input"
                placeholder={'## 现象\n\n## 原因\n\n## 结论'}
              />
            </div>
            <div className="assert-hint">
              保存为 <code>{dir ? `${dir}\\${fileOf(dirEditing.title || '未命名笔记')}` : fileOf(dirEditing.title)}</code>
              ；改标题会同步重命名文件。
            </div>
          </>
        )}
      </Modal>

      {/* 目录模式：预览 */}
      <Modal
        open={!!dirPreview}
        onClose={() => setDirPreview(null)}
        title={dirPreview?.title || ''}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDirPreview(null)}>关闭</button>
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
              onClick={() => { setDirEditing(dirPreview); setDirPreview(null); }}
            >
              编辑
            </button>
          </>
        }
      >
        <div className="card2-meta" style={{ marginBottom: 10 }}>
          <Icons.note size={11} />
          {dirPreview?.name}
          <span className="text-sm text-muted" style={{ marginLeft: 'auto' }}>{formatRecent(dirPreview?.mtime || '')}</span>
        </div>
        <div className="markdown-body" dangerouslySetInnerHTML={{ __html: mdToHtml(dirPreview?.content || '') }} />
      </Modal>

      {confirmNode}
    </div>
  );
}
