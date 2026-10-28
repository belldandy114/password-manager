import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WeeklyFile } from '../types';
import { Modal } from '../components/Modal';
import { Page, PageHead, Panel, Empty, SearchBox, Icons, Pill } from '../components/ui';
import { renderMarkdown, dateFromName, weekdayOf, weekNoOf } from '../utils/markdown';
import { buildWeeklyDraft, weekRange, weekOptions, compareWeeks, buildGroupMessage } from '../utils/weeklyDraft';
import { useZentaoStore } from '../store/zentaoStore';
import { useStore } from '../store/useStore';

let lastCmdAt = 0;

const DEFAULT_DIR = '';
const LS_KEY = 'weekly.report.dir';

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

const today = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const TEMPLATE = `**一、本周工作**

1. 

**二、问题与风险**

1. 

**三、下周计划**

1. 
`;

export function WeeklyReport() {
  const [dir, setDir] = useState(() => localStorage.getItem(LS_KEY) || DEFAULT_DIR);
  // 生成草稿选的是「几周前」：0=本周、1=上周、2=两周前…
  // 旧版本把 0 存成 0、把「上周」错存成 -1（那时 weekRange 的方向反了），这里把负数一律当 0。
  const [draftOffset, setDraftOffset] = useState(() => {
    const v = Number(localStorage.getItem('pm.weekly.draftOffset'));
    return Number.isFinite(v) && v >= 0 && v <= 8 ? v : 0;
  });
  const [files, setFiles] = useState<WeeklyFile[]>([]);
  const [current, setCurrent] = useState<string>('');
  const [content, setContent] = useState('');
  const [mtime, setMtime] = useState('');
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchBody, setSearchBody] = useState(false);
  const [bodyIndex, setBodyIndex] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dirDraft, setDirDraft] = useState(dir);

  // 编辑器：draft=null 表示查看模式
  const [draft, setDraft] = useState<{ name: string; text: string; isNew: boolean } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 禅道数据（周报草稿用）
  const ztBugs = useZentaoStore(s => s.bugs);
  // 本周 vs 上周对比（跟草稿选的那一周同步）
  const cmp = useMemo(() => compareWeeks(ztBugs, draftOffset), [ztBugs, draftOffset]);
  const [msgCopied, setMsgCopied] = useState(false);
  // 命令面板「生成周报草稿」
  const cmdSignal = useStore(s => s.cmdSignal);

  useEffect(() => { setDirDraft(dir); }, [dir]);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError('');
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
    if (res.success && res.data) {
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

  /** 从禅道「我的 Bug」生成一周草稿 */
  const genDraft = (offset = draftOffset) => {
    if (ztBugs.length === 0) {
      setError('还没有禅道数据：请先到「禅道 → 我的 Bug」点一次「拉取我的 Bug」');
      return;
    }
    const { start, end, friday } = weekRange(offset);
    setError('');
    setShowPreview(false);
    setDraft({ name: `${friday}.md`, text: buildWeeklyDraft(ztBugs, start, end), isNew: true });
  };

  // 命令面板「生成周报草稿」
  useEffect(() => {
    if (!cmdSignal || cmdSignal.at === lastCmdAt) return;
    if (cmdSignal.kind !== 'weekly:draft') return;
    lastCmdAt = cmdSignal.at;
    genDraft(draftOffset);
  }, [cmdSignal, draftOffset]);

  const startNew = () => {
    setError('');
    setShowPreview(false);
    setDraft({ name: `${today()}.md`, text: TEMPLATE, isNew: true });
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
              <select
                className="wk-draft-week"
                value={draftOffset}
                onChange={e => {
                  const v = Number(e.target.value);
                  setDraftOffset(v);
                  localStorage.setItem('pm.weekly.draftOffset', String(v));
                }}
                disabled={editing}
                title="选哪一周生成草稿"
              >
                {weekOptions(9).map(o => (
                  <option key={o.offset} value={o.offset}>{o.label}（{o.start.slice(5)} ~ {o.end.slice(5)}）</option>
                ))}
              </select>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => genDraft(draftOffset)}
                disabled={editing}
                title="用禅道「我的 Bug」生成所选周的草稿"
              >
                <Icons.bug size={13} /> 生成草稿
              </button>
              <button className="btn btn-primary btn-sm" onClick={startNew} disabled={editing}>
                <Icons.plus size={13} /> 新建周报
              </button>
            </>
          }
        />

        {error && (
          <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {error}
          </div>
        )}

        {/* 本周 vs 上周：同一套口径的硬数字，省得每周手算「比上周多了几条」 */}
        {ztBugs.length > 0 && (
          <Panel
            title={`${draftOffset === 0 ? '本周' : draftOffset === 1 ? '上周' : `${draftOffset} 周前`} vs ${draftOffset === 0 ? '上周' : draftOffset === 1 ? '前两周' : `${draftOffset + 1} 周前`}`}
            meta={`${cmp.cur.start} ~ ${cmp.cur.end}　对比 ${cmp.prev.start} ~ ${cmp.prev.end}`}
            collapsible
            tools={
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(buildGroupMessage(ztBugs, cmp.cur.start, cmp.cur.end));
                    setMsgCopied(true);
                    setTimeout(() => setMsgCopied(false), 1600);
                  } catch { setError('复制失败，请检查剪贴板权限'); }
                }}
                title="复制成一段可以直接发群里的纯文本"
              >
                <Icons.copy size={12} /> {msgCopied ? '已复制' : '复制群消息'}
              </button>
            }
          >
            <div className="wk-cmp">
              <div className="wk-cmp-head">
                <span />
                <span>本周</span>
                <span>上周</span>
                <span>变化</span>
              </div>
              {[
                { label: '新提', cur: cmp.cur.created, prev: cmp.prev.created, lowerBetter: true },
                { label: '解决', cur: cmp.cur.resolved, prev: cmp.prev.resolved, lowerBetter: false },
                { label: '关闭', cur: cmp.cur.closed, prev: cmp.prev.closed, lowerBetter: false },
                { label: '未关闭', cur: cmp.cur.unclosed, prev: cmp.prev.unclosed, lowerBetter: true },
              ].map(r => {
                const d = r.cur - r.prev;
                const tone = d === 0 ? 'flat' : (d > 0) === r.lowerBetter ? 'bad' : 'good';
                return (
                  <div className="wk-cmp-row" key={r.label}>
                    <span className="wk-cmp-label">{r.label}</span>
                    <b>{r.cur}</b>
                    <span className="wk-cmp-prev">{r.prev}</span>
                    <span className={`wk-delta is-${tone}`}>
                      {d === 0 ? '持平' : d > 0 ? `↑ ${d}` : `↓ ${-d}`}
                    </span>
                  </div>
                );
              })}
            </div>
            {cmp.cur.byProject.length > 0 && (
              <div className="wk-cmp-proj">
                {cmp.cur.byProject.slice(0, 5).map(p => (
                  <span key={p.name} className="chip">
                    {p.name}：{p.created}/{p.resolved}/{p.closed}
                  </span>
                ))}
                <span className="drawer-hint-inline">（按项目：新提/解决/关闭）</span>
              </div>
            )}
          </Panel>
        )}

        <Panel title="周报目录" meta={dir} collapsible defaultOpen={false}>
          <div className="wk-dir">
            <input
              value={dirDraft}
              onChange={e => setDirDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') applyDir(); }}
              placeholder={DEFAULT_DIR}
              spellCheck={false}
            />
            <button className="btn btn-secondary btn-sm" onClick={pickDir}>选择目录</button>
            <button className="btn btn-primary btn-sm" onClick={applyDir}>打开</button>
          </div>
          <div className="pg-sub" style={{ marginTop: 10 }}>
            默认 <code></code>，支持 .md / .markdown / .txt；
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
                    spellCheck={false}
                  />
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
              <article className="md-body">
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
    </div>
  );
}
