import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { WeeklyFile } from '../types';
import { Page, PageHead, Panel, Empty, SearchBox, Icons, Pill } from '../components/ui';
import { renderMarkdown, dateFromName, weekdayOf, weekNoOf } from '../utils/markdown';

const DEFAULT_DIR = '';
const LS_KEY = 'weekly.report.dir';

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

export function WeeklyReport() {
  const [dir, setDir] = useState(() => localStorage.getItem(LS_KEY) || DEFAULT_DIR);
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
    // 默认打开最新一篇
    if (list.length && !list.some(f => f.name === current)) setCurrent(list[0].name);
  }, [current]);

  useEffect(() => { load(dir); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dir]);

  useEffect(() => {
    if (!current) return;
    (async () => {
      setReading(true);
      const res = await window.electronAPI.weeklyRead(dir, current);
      setReading(false);
      if (res.success && res.data) {
        setContent(res.data.content);
        setMtime(res.data.mtime);
      } else {
        setContent('');
        setError(res.error || '读取失败');
      }
    })();
  }, [current, dir]);

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
    return {
      count: files.length,
      from: dates[0] || '',
      to: dates[dates.length - 1] || '',
    };
  }, [files]);

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  };

  const reveal = () => { if (current) window.electronAPI.weeklyReveal(dir, current); };

  const curDate = dateFromName(current);

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.note size={16} />}
          title="周报"
          desc="直接读取本地工作记录目录里的周报文件，按周查看详细内容"
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
            </>
          }
        />

        {error && (
          <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {error}
          </div>
        )}

        <Panel title="周报目录" meta={dir}>
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
            默认读取 <code></code>，支持 .md / .markdown / .txt；
            目录路径会记在本机，下次打开自动定位。
          </div>
        </Panel>

        <div className="split">
          <Panel
            title="周报列表"
            meta={`${visible.length} / ${files.length}`}
            flush
            tools={<IconToggle on={searchBody} onClick={() => setSearchBody(!searchBody)} title="搜索正文内容" />}
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
                desc={files.length === 0 ? '检查上面的目录路径是否正确' : '换个关键词，或关掉正文搜索'}
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
                      onClick={() => setCurrent(f.name)}
                      title={f.name}
                    >
                      <span className="wk-date">{d || f.name}</span>
                      <span className="wk-sub">
                        {d ? `${weekdayOf(d)} · 第 ${weekNoOf(d)} 周` : fmtSize(f.size)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel
            title={curDate ? `${curDate} ${weekdayOf(curDate)}` : (current || '周报内容')}
            meta={current ? `${current}${mtime ? ` · 更新于 ${mtime.slice(0, 10)}` : ''}` : undefined}
            tools={
              current ? (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={reveal}>
                    <Icons.extern size={12} /> 打开文件位置
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={copyAll}>
                    <Icons.copy size={12} /> {copied ? '已复制' : '复制全文'}
                  </button>
                </>
              ) : undefined
            }
          >
            {!current ? (
              <Empty
                icon={<Icons.note size={22} />}
                title="选择一篇周报"
                desc="左侧列表按日期倒序排列，点一下即可查看详细内容"
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
    </div>
  );
}

function IconToggle({ on, onClick, title }: { on: boolean; onClick: () => void; title: string }) {
  return (
    <button
      className={`ibtn${on ? ' is-active' : ''}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {on ? <Icons.eye size={14} /> : <Icons.search size={14} />}
    </button>
  );
}
