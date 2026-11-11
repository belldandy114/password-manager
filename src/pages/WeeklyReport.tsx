import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WeeklyFile } from '../types';
import { Modal } from '../components/Modal';
import { ZentaoDigestDialog } from '../components/ZentaoDigestDialog';
import { Page, PageHead, Panel, Empty, SearchBox, Icons, Pill } from '../components/ui';
import { renderMarkdown, dateFromName, weekdayOf, weekNoOf } from '../utils/markdown';
import { useStore } from '../store/useStore';

let lastCmdAt = 0;

// 不内置任何本机路径：老版本把某台机器的周报目录写死在这里，等于把使用者目录结构
// 一起提交进了公开仓库。现在的默认值就是「没选」，由用户在界面上挑一次后存进 localStorage。
const DEFAULT_DIR = '';
const LS_KEY = 'weekly.report.dir';

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};


export function WeeklyReport() {
  const [dir, setDir] = useState(() => localStorage.getItem(LS_KEY) || DEFAULT_DIR);
  // 周次已固定为「本周」（1.9.3 去掉周次下拉与「本周 vs 上周」对比）
  const [files, setFiles] = useState<WeeklyFile[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState('');
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  /** 中性提示（例如「已合并：更新 3 个章节」），和红色报错分开放 */
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [searchBody, setSearchBody] = useState(false);
  const [bodyIndex, setBodyIndex] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dirDraft, setDirDraft] = useState(dir);

  // 编辑器：draft=null 表示查看模式
  const [draft, setDraft] = useState<{ name: string; text: string; isNew: boolean } | null>(null);
  const [digestOpen, setDigestOpen] = useState(false);
  /** 「生成并保存」撞上同名文件时先问一句，别把上周的周报悄悄覆盖掉 */
  const [overwrite, setOverwrite] = useState<{ name: string; text: string; note: string } | null>(null);

  // 汇总页「生成周报」把草稿写进 localStorage 再跳过来：这里接住并填入编辑器
  useEffect(() => {
    try {
      const raw = localStorage.getItem('pm.weekly.pendingDraft');
      if (!raw) return;
      localStorage.removeItem('pm.weekly.pendingDraft');
      const d = JSON.parse(raw);
      if (d && typeof d.text === 'string' && d.text.trim()) {
        setDraft({ name: d.name || `${today()}.md`, text: d.text, isNew: true });
      }
    } catch { /* 草稿坏了就当没给过 */ }
  }, []);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 禅道数据（周报草稿用）
  // 命令面板「生成周报草稿」
  const cmdSignal = useStore(s => s.cmdSignal);

  useEffect(() => { setDirDraft(dir); }, [dir]);

  const load = useCallback(async (target: string) => {
    setError('');
    if (!target) {
      // 还没选目录：清空列表即可，不要把「未指定周报目录」当成错误弹出来
      setFiles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const res = await window.electronAPI.weeklyList(target);
    setLoading(false);
    if (!res.success) {
      setError(res.error || '读取目录失败');
      setFiles([]);
      return;
    }
    const list = (res.data || []).slice().sort((a, b) => (a.name < b.name ? 1 : -1));
    setFiles(list);
    if (list.length && !list.some(f => f.name === current)) setCurrent(list[0].name);
  }, [current]);

  useEffect(() => { load(dir); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dir]);

  const readFile = useCallback(async (name: string) => {
    if (!name) return;
    setReading(true);
    const res = await window.electronAPI.weeklyRead(dir, name);
    setReading(false);
    if (res.success && res.data) {
      setContent(res.data.content);
      setMtime(res.data.mtime);
    } else {
      setContent('');
      setError(res.error || '读取失败');
    }
  }, [dir]);

  useEffect(() => { if (!draft) readFile(current); }, [current, dir, draft, readFile]);

  const pickDir = async () => {
    const res = await window.electronAPI.weeklyPickDir();
    if (!res || res.success === false) {
      setError(`打开目录选择框失败：${(res && res.error) || '未知原因'}（可以手动把目录路径粘到下面的输入框）`);
      return;
    }
    if (!res.data) { setError(''); return; }
    {
      setDir(res.data);
      localStorage.setItem(LS_KEY, res.data);
      setCurrent('');
      setBodyIndex({});
    }
  };

  const applyDir = () => {
    const next = dirDraft.trim();
    if (!next || next === dir) return;
    setDir(next);
    localStorage.setItem(LS_KEY, next);
    setCurrent('');
    setBodyIndex({});
  };

  /** 全文搜索：把目录里的文件逐个读一遍建索引（只做一次） */
  const ensureBodyIndex = async () => {
    if (scanning) return;
    setScanning(true);
    const map: Record<string, string> = { ...bodyIndex };
    for (const f of files) {
      if (map[f.name] !== undefined) continue;
      const r = await window.electronAPI.weeklyRead(dir, f.name);
      map[f.name] = r.success && r.data ? r.data.content : '';
    }
    setBodyIndex(map);
    setScanning(false);
  };

  useEffect(() => {
    if (searchBody && search.trim() && Object.keys(bodyIndex).length === 0) ensureBodyIndex();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchBody, search]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter(f => {
      if (f.name.toLowerCase().includes(q)) return true;
      if (searchBody) return (bodyIndex[f.name] || '').toLowerCase().includes(q);
      return false;
    });
  }, [files, search, searchBody, bodyIndex]);

  const meta = useMemo(() => {
    const dates = files.map(f => dateFromName(f.name)).filter(Boolean).sort();
    return { count: files.length, from: dates[0] || '', to: dates[dates.length - 1] || '' };
  }, [files]);

  const curDate = dateFromName(current);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  };

  const reveal = () => { if (current) window.electronAPI.weeklyReveal(dir, current); };

  /* ---------------- 新建 / 编辑 / 删除 ---------------- */

  // 命令面板「生成周报草稿」：走同一套多公司流程，别再生成旧格式
  useEffect(() => {
    if (!cmdSignal || cmdSignal.at === lastCmdAt) return;
    if (cmdSignal.kind !== 'weekly:draft') return;
    lastCmdAt = cmdSignal.at;
    setError('');
    setDigestOpen(true);
  }, [cmdSignal]);

  const startNew = () => {
    setError('');
    setShowPreview(false);
    // 空白起步：模板往往和当周实际要写的内容对不上，删起来比补起来费劲
    setDraft({ name: `${today()}.md`, text: '', isNew: true });
  };

  const startEdit = () => {
    if (!current) return;
    setError('');
    setShowPreview(false);
    setDraft({ name: current, text: content, isNew: false });
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setError('');
    const name = draft.name.trim();
    const target = draft.isNew && !/\.(md|markdown|txt)$/i.test(name) ? `${name}.md` : name;

    if (!draft.isNew && target !== current) {
      const rn = await window.electronAPI.weeklyRename(dir, current, target);
      if (!rn.success) { setSaving(false); setError(rn.error || '重命名失败'); return; }
    }
    const res = await window.electronAPI.weeklySave(dir, target, draft.text);
    setSaving(false);
    if (!res.success) { setError(res.error || '保存失败'); return; }
    setDraft(null);
    setBodyIndex(b => { const n = { ...b }; delete n[current]; return n; });
    setCurrent(target);
    setFiles(prev => {
      const rest = prev.filter(f => f.name !== current && f.name !== target);
      return [{ name: target, size: res.data?.size || 0, mtime: res.data?.mtime || new Date().toISOString() }, ...rest]
        .sort((a, b) => (a.name < b.name ? 1 : -1));
    });
    await load(dir);
    await readFile(target);
  };

  /**
   * 「生成并保存」：直接把 markdown 写成周报文件。
   * 文件名优先用编辑器里那个（用户可能已经改过），否则用弹窗给的「统计结束日期」。
   */
  const writeDigestFile = useCallback(async (target: string, text: string, note: string) => {
    setSaving(true);
    setError('');
    const res = await window.electronAPI.weeklySave(dir, target, text);
    setSaving(false);
    if (!res.success) {
      // 存不进去也别把正文丢掉：退回草稿态，让用户能手动保存或复制
      setDraft({ name: target, text, isNew: true });
      setError(`自动保存失败：${res.error || '未知原因'}（正文已放进编辑器，可手动保存）`);
      return;
    }
    setNotice(`${note ? `${note}；` : ''}已保存 ${target}`);
    setBodyIndex(b => { const n = { ...b }; delete n[target]; return n; });
    // 保存后仍然停在编辑态：数据刚导出，多半还要补两句别的
    setDraft({ name: target, text, isNew: false });
    setCurrent(target);
    setFiles(prev => {
      const rest = prev.filter(f => f.name !== target);
      return [{ name: target, size: res.data?.size || 0, mtime: res.data?.mtime || new Date().toISOString() }, ...rest]
        .sort((a, b) => (a.name < b.name ? 1 : -1));
    });
  }, [dir]);

  const doDelete = async () => {
    if (!current) return;
    const name = current;
    const res = await window.electronAPI.weeklyDelete(dir, name);
    setConfirmDelete(false);
    if (!res.success) { setError(res.error || '删除失败'); return; }
    const rest = files.filter(f => f.name !== name);
    setFiles(rest);
    setBodyIndex(b => { const n = { ...b }; delete n[name]; return n; });
    setCurrent(rest[0]?.name || '');
    if (rest.length === 0) setContent('');
  };

  const editing = !!draft;

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.note size={16} />}
          title="周报"
          desc="直接读写本地工作记录目录里的周报（Markdown），可以新建、修改、删除"
          tools={
            <>
              {meta.count > 0 && (
                <Pill tone="info">
                  {meta.count} 篇{meta.from ? ` · ${meta.from} ~ ${meta.to}` : ''}
                </Pill>
              )}
              <button className="btn btn-secondary btn-sm" onClick={() => load(dir)} disabled={loading}>
                <Icons.refresh size={13} /> {loading ? '刷新中…' : '刷新'}
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => { setError(''); setNotice(''); setDigestOpen(true); }}
                title={draft && draft.text.trim()
                  ? '编辑器里有内容：生成时默认合并进去，只更新同名项目章节'
                  : '按现有周报格式，从多家公司的禅道一次性汇总生成'}
              >
                <Icons.bug size={13} /> 从禅道生成
              </button>
              <button className="btn btn-primary btn-sm" onClick={startNew} disabled={editing}>
                <Icons.plus size={13} /> 新建周报
              </button>
            </>
          }
        />

        {!dir && (
          <div className="pill" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', fontWeight: 400 }}>
            还没有选择周报目录 —— 展开上方「周报目录」，点「选择」挑一个文件夹（只记住本机，不会上传到任何地方）。
          </div>
        )}

        {error && (
          <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {error}
          </div>
        )}

        {notice && !error && (
          <div className="pill" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', fontWeight: 400 }}>
            {notice}
            <button
              type="button"
              className="digest-link"
              onClick={() => setNotice('')}
            >
              知道了
            </button>
          </div>
        )}

        <Panel title="周报目录" meta={dir || '未选择（首次用请点「选择目录」）'} collapsible defaultOpen={!dir}>
          <div className="wk-dir">
            <input
              value={dirDraft}
              onChange={e => setDirDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyDir(); }}
              placeholder="周报所在的文件夹，例如 D:\周报"
              spellCheck={false} aria-label="周报文件夹" />
            <button className="btn btn-secondary btn-sm" onClick={pickDir}>选择目录</button>
            <button className="btn btn-primary btn-sm" onClick={applyDir}>打开</button>
          </div>
          <div className="pg-sub" style={{ marginTop: 10 }}>
            目录由你自己选（只存在本机 localStorage），支持 .md / .markdown / .txt；
            新建与修改直接写文件，删除走系统回收站（可找回）。
          </div>
        </Panel>

        <div className="split">
          <Panel
            title="周报列表"
            meta={`${visible.length} / ${files.length}`}
            flush
            tools={
              <button
                className={`ibtn${searchBody ? ' is-active' : ''}`}
                title="搜索正文内容"
                aria-label="搜索正文内容"
                onClick={() => setSearchBody(!searchBody)}
              >
                {searchBody ? <Icons.eye size={14} /> : <Icons.search size={14} />}
              </button>
            }
          >
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <SearchBox
                value={search}
                onChange={setSearch}
                placeholder={searchBody ? '搜文件名 / 正文' : '搜文件名（日期）'}
              />
            </div>
            {loading && files.length === 0 ? (
              <div className="tbl-empty">读取中…</div>
            ) : visible.length === 0 ? (
              <Empty
                compact
                icon={<Icons.note size={20} />}
                title={files.length === 0 ? '目录里没有周报文件' : '没有匹配项'}
                desc={files.length === 0 ? '点右上角「新建周报」写第一篇' : '换个关键词，或关掉正文搜索'}
                hint={<>周报以 .md 保存，可用 <kbd>Ctrl+K</kbd> 搜到</>}
              />
            ) : (
              <div className="wk-list">
                {visible.map(f => {
                  const d = dateFromName(f.name);
                  const active = f.name === current;
                  return (
                    <button
                      key={f.name}
                      className={`wk-item${active ? ' is-active' : ''}`}
                      onClick={() => { setDraft(null); setCurrent(f.name); }}
                      title={f.name}
                    >
                      <span className="wk-date">{d || f.name}</span>
                      <span className="wk-sub">{d ? `${weekdayOf(d)} · 第 ${weekNoOf(d)} 周` : fmtSize(f.size)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel
            title={editing
              ? (draft.isNew ? '新建周报' : `编辑 · ${current}`)
              : (curDate ? `${curDate} ${weekdayOf(curDate)}` : (current || '周报内容'))}
            meta={!editing && current ? `${current}${mtime ? ` · 更新于 ${mtime.slice(0, 10)}` : ''}` : undefined}
            tools={editing ? (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowPreview(v => !v)}>
                  {showPreview ? '继续编辑' : '预览'}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => { setDraft(null); setError(''); }}>取消</button>
                <button className="btn btn-primary btn-sm" onClick={saveDraft} disabled={saving}>
                  {saving ? '保存中…' : '保存'}
                </button>
              </>
            ) : current ? (
              <>
                <button className="btn btn-secondary btn-sm" onClick={startEdit}>
                  <Icons.pencil size={12} /> 编辑
                </button>
                <button className="btn btn-secondary btn-sm" onClick={reveal}>
                  <Icons.extern size={12} /> 打开文件位置
                </button>
                <button className="btn btn-secondary btn-sm" onClick={copyAll}>
                  <Icons.copy size={12} /> {copied ? '已复制' : '复制全文'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(true)} title="删除到回收站">
                  <Icons.trash size={12} /> 删除
                </button>
              </>
            ) : undefined}
          >
            {editing ? (
              <div className="wk-editor">
                <div className="field">
                  <span className="field-label">文件名（日期建议用周五）</span>
                  <input
                    value={draft.name}
                    onChange={e => setDraft({ ...draft, name: e.target.value })}
                    placeholder="2026-10-30.md"
                    spellCheck={false} aria-label="文件名" />
                </div>
                {showPreview ? (
                  <article className="md-body wk-preview">{renderMarkdown(draft.text)}</article>
                ) : (
                  <textarea
                    className="wk-md-input"
                    value={draft.text}
                    onChange={e => setDraft({ ...draft, text: e.target.value })}
                    spellCheck={false}
                    placeholder={'**一、本周工作**\n\n1. ...'}
                  />
                )}
                <div className="wk-editor-foot">
                  <span className="pg-sub" style={{ margin: 0 }}>
                    支持 Markdown：<code>**小节**</code>、<code>1.</code>、<code>-</code>、<code>（1）</code>、<code># 标题</code>
                  </span>
                  <span className="pg-sub" style={{ margin: 0 }}>{draft.text.length} 字</span>
                </div>
              </div>
            ) : !current ? (
              <Empty
                icon={<Icons.note size={22} />}
                title="选择或新建一篇周报"
                desc="左侧列表按日期倒序，点一下查看；右上角可以新建"
              />
            ) : reading ? (
              <div className="tbl-empty">读取中…</div>
            ) : (
              <article className="md-body wk-read">
                {curDate && (
                  <div className="md-title">
                    {curDate} 周报
                    <span className="md-title-sub">第 {weekNoOf(curDate)} 周 · {weekdayOf(curDate)}</span>
                  </div>
                )}
                {renderMarkdown(content)}
              </article>
            )}
          </Panel>
        </div>
      </Page>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="删除周报"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>取消</button>
            <button className="btn btn-primary" onClick={doDelete}>删除到回收站</button>
          </>
        }
      >
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          确定删除 <strong>{current}</strong> ？
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
            文件会被移到系统回收站，需要时可以恢复。
          </div>
        </div>
      </Modal>

      <Modal
        open={!!overwrite}
        onClose={() => setOverwrite(null)}
        title="这个文件名已经存在"
        footer={
          <>
            <button className="btn btn-secondary btn-sm" onClick={() => setOverwrite(null)}>取消</button>
            <button
              className="btn btn-primary btn-sm"
              disabled={saving}
              onClick={() => {
                const o = overwrite;
                setOverwrite(null);
                if (o) void writeDigestFile(o.name, o.text, o.note);
              }}
            >
              {saving ? '保存中…' : '覆盖'}
            </button>
          </>
        }
      >
        <div style={{ fontSize: 13, lineHeight: 1.8 }}>
          目录里已经有 <strong>{overwrite?.name}</strong>，覆盖后原内容就没有了。
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 6 }}>
            想保留旧文件的话，点「取消」，然后在左侧点「新建周报」改个文件名再保存。
          </div>
        </div>
      </Modal>

      <ZentaoDigestDialog
        open={digestOpen}
        onClose={() => setDigestOpen(false)}
        // 只有「正在编辑的草稿」才作为合并对象；只是点开看某篇历史周报不算,
        // 否则生成后文件名会变成那篇旧文件，一保存就把历史覆盖掉
        existing={draft ? draft.text : ''}
        onGenerated={(text, name, note, saveNow) => {
          setDigestOpen(false);
          setError('');
          setShowPreview(false);
          setNotice(note || '');
          const editingSaved = !!draft && !draft.isNew && !!draft.name.trim();
          if (draft && draft.text.trim()) {
            // 正在编辑：沿用原文件名，补出来的还是这一篇
            setDraft({ ...draft, text });
          } else {
            // 其它情况一律按新文件走（文件名 = 统计区间的结束日期）
            setDraft({ name, text, isNew: true });
          }

          if (!saveNow) return;
          // 正在补充某一篇已保存的周报 → 存回那一篇，不动名字；
          // 其余情况按「统计结束日期」命名（比编辑器默认的今天更准）
          const target = editingSaved ? draft!.name.trim() : name;
          if (!dir) {
            setError('还没有选择周报目录：先在「周报目录」里选一个文件夹，再点「生成并保存」');
            return;
          }
          // 正在补充某一篇已保存的周报 → 覆盖的就是它自己，不用问；
          // 其余情况目标文件若已存在，先确认一次
          if (!editingSaved && files.some(f => f.name === target)) {
            setOverwrite({ name: target, text, note: note || '' });
            return;
          }
          void writeDigestFile(target, text, note || '');
        }}
      />
    </div>
  );
}
