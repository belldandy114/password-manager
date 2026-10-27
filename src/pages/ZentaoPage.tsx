import React, { useEffect, useMemo, useState } from 'react';
import type { ZentaoBug, ZentaoConfig } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useZentaoStore } from '../store/zentaoStore';
import { Page, PageHead, Panel, Empty, Field, Icons, Pill, SearchBox, type PillTone } from '../components/ui';

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  active: { label: '激活', tone: 'bad' },
  resolved: { label: '已解决', tone: 'ok' },
  closed: { label: '已关闭', tone: 'mute' },
  postponed: { label: '已延期', tone: 'warn' },
};

const SEVERITY: Record<string, { label: string; tone: PillTone }> = {
  '1': { label: '致命', tone: 'bad' },
  '2': { label: '严重', tone: 'warn' },
  '3': { label: '一般', tone: 'mute' },
  '4': { label: '轻微', tone: 'mute' },
};

/** 统计维度：key 为 status 字段值，或 unclosed / fixed 这类派生维度 */
const DIMS: { key: string; label: string; tone: PillTone }[] = [
  { key: 'unclosed', label: '未关闭', tone: 'warn' },
  { key: 'active', label: '激活', tone: 'bad' },
  { key: 'resolved', label: '已解决', tone: 'ok' },
  { key: 'closed', label: '已关闭', tone: 'mute' },
  { key: 'fixed', label: '已修复', tone: 'ok' },
];

const isFixed = (b: ZentaoBug) => String(b.resolution || '') === 'fixed';
const isClosed = (b: ZentaoBug) => String(b.status || '') === 'closed';
const isUnclosed = (b: ZentaoBug) => !isClosed(b);

const matchDim = (b: ZentaoBug, dim: string) => {
  if (!dim) return true;
  if (dim === 'unclosed') return isUnclosed(b);
  if (dim === 'fixed') return isFixed(b);
  return String(b.status || '') === dim;
};

const dimLabel = (dim: string) =>
  DIMS.find(d => d.key === dim)?.label || STATUS[dim]?.label || dim;

/** 禅道 20.x 的「我的地盘」页面地址（index.php?m=my&f=bug 会 302，不能用） */
const QUICK_LINKS: { label: string; page: string }[] = [
  { label: '我的 Bug', page: 'my-work-bug.html' },
  { label: '我的任务', page: 'my-work-task.html' },
  { label: '我的需求', page: 'my-work-story.html' },
  { label: '我的测试单', page: 'my-work-testtask.html' },
  { label: '我的用例', page: 'my-work-testcase.html' },
  { label: '我的待办', page: 'my-work-todo.html' },
];

export function ZentaoPage() {
  const { items, save } = useCollection<ZentaoConfig>('integrations');
  const cfg = useMemo(() => items.find(i => i.id === 'zentao'), [items]);

  // 数据与筛选都放在 store 里：切走页面组件会卸载，useState 会丢
  const bugs = useZentaoStore(s => s.bugs);
  const total = useZentaoStore(s => s.total);
  const loggedIn = useZentaoStore(s => s.loggedIn);
  const fetchedAt = useZentaoStore(s => s.fetchedAt);
  const project = useZentaoStore(s => s.project);
  const status = useZentaoStore(s => s.status);
  const severity = useZentaoStore(s => s.severity);
  const query = useZentaoStore(s => s.query);
  const setBugs = useZentaoStore(s => s.setBugs);
  const setLoggedIn = useZentaoStore(s => s.setLoggedIn);
  const setFilter = useZentaoStore(s => s.setFilter);
  const clearAll = useZentaoStore(s => s.clear);

  const [form, setForm] = useState({ baseUrl: '', account: '', password: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (cfg) setForm({ baseUrl: cfg.baseUrl, account: cfg.account, password: cfg.password });
  }, [cfg]);

  const persist = async (next: { baseUrl: string; account: string; password: string }) => {
    const entry: ZentaoConfig = { id: 'zentao', ...next, updatedAt: new Date().toISOString() };
    const others = items.filter(i => i.id !== 'zentao');
    await save([...others, entry]);
  };

  const currentCfg = (): ZentaoConfig => ({
    id: 'zentao',
    baseUrl: form.baseUrl.trim(),
    account: form.account.trim(),
    password: form.password,
  }) as ZentaoConfig;

  const login = async () => {
    setError('');
    if (!form.baseUrl.trim()) { setError('请填写禅道地址，例如 http://zentao.example.com/zentao'); return; }
    setBusy('login');
    const res = await window.electronAPI.zentaoLogin(currentCfg());
    setBusy('');
    if (res.success) {
      setLoggedIn(true);
      await persist({ baseUrl: form.baseUrl.trim(), account: form.account.trim(), password: form.password });
    } else {
      setLoggedIn(false);
      setError(res.error || '登录失败');
    }
  };

  const loadBugs = async () => {
    setError('');
    setBusy('bugs');
    const res = await window.electronAPI.zentaoMyBugs(currentCfg());
    setBusy('');
    if (res.success && res.data) {
      setBugs(res.data, res.total || res.data.length);
      setLoggedIn(true);
      await persist({ baseUrl: form.baseUrl.trim(), account: form.account.trim(), password: form.password });
    } else {
      setError(res.error || '拉取失败');
    }
  };

  const openUrl = (path: string) => {
    const base = form.baseUrl.trim().replace(/\/+$/, '');
    if (!base) { setError('请先填写禅道地址'); return; }
    window.electronAPI.browserOpen({ browser: 'default', url: `${base}/${path.replace(/^\/+/, '')}` });
  };

  /** 项目清单：按 Bug 数从多到少 */
  const projects = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of bugs) {
      const key = b.productName || '未分类';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [bugs]);

  /** 按项目 × 维度统计 */
  const byProject = useMemo(() => {
    const rows = projects.map(([name]) => {
      const list = bugs.filter(b => (b.productName || '未分类') === name);
      const row = {
        name,
        total: list.length,
        unclosed: list.filter(isUnclosed).length,
        active: list.filter(b => String(b.status) === 'active').length,
        resolved: list.filter(b => String(b.status) === 'resolved').length,
        closed: list.filter(isClosed).length,
        fixed: list.filter(isFixed).length,
        fatal: list.filter(b => String(b.severity) === '1').length,
      };
      return row;
    });
    return rows;
  }, [bugs, projects]);

  /** 顶部卡片：全量统计（可点击筛选） */
  const overall = useMemo(() => ({
    total: bugs.length,
    unclosed: bugs.filter(isUnclosed).length,
    active: bugs.filter(b => String(b.status) === 'active').length,
    resolved: bugs.filter(b => String(b.status) === 'resolved').length,
    closed: bugs.filter(isClosed).length,
    fixed: bugs.filter(isFixed).length,
  }), [bugs]);

  const severityCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const b of bugs) {
      const k = String(b.severity || '未知');
      map[k] = (map[k] || 0) + 1;
    }
    return map;
  }, [bugs]);

  const visibleBugs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bugs.filter(b => {
      if (project && (b.productName || '未分类') !== project) return false;
      if (!matchDim(b, status)) return false;
      if (severity && String(b.severity) !== severity) return false;
      if (q && ![b.id, b.title, b.productName, b.status].some(v => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [bugs, project, status, severity, query]);

  const hasFilter = !!(project || status || severity || query.trim());

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.bug size={16} />}
          title="禅道"
          desc="连接公司禅道，按项目查看名下 Bug 与统计；账号密码加密保存在本地"
          tools={
            <>
              {loggedIn && <Pill tone="ok" dot>已登录</Pill>}
              {bugs.length > 0 && (
                <Pill tone="info">
                  {bugs.length} 条{fetchedAt ? ` · ${fetchedAt.slice(11, 16)} 拉取` : ''}
                </Pill>
              )}
              <button className="btn btn-secondary btn-sm" onClick={login} disabled={busy === 'login'}>
                <Icons.lock size={13} /> {busy === 'login' ? '登录中…' : '登录并保存'}
              </button>
              <button className="btn btn-primary btn-sm" onClick={loadBugs} disabled={busy === 'bugs'}>
                <Icons.refresh size={13} /> {busy === 'bugs' ? '拉取中…' : '拉取我的 Bug'}
              </button>
            </>
          }
        />

        {error && (
          <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {error}
          </div>
        )}

        <Panel title="连接配置" meta={form.baseUrl ? form.baseUrl.replace(/^https?:\/\//, '') : '未配置'}>
          <div className="grid3" style={{ gridTemplateColumns: '1.7fr 1fr 1fr' }}>
            <Field label="禅道地址">
              <input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="http://zentao.example.com/zentao" />
            </Field>
            <Field label="账号">
              <input value={form.account} onChange={e => setForm({ ...form, account: e.target.value })} placeholder="用户名" />
            </Field>
            <Field label="密码">
              <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="密码" />
            </Field>
          </div>
          <div className="pg-sub" style={{ marginTop: 12 }}>
            地址可只填 <code>zentao.example.com/zentao</code>，协议会自动补全；只填到根地址也能识别。
            拉取 Bug 时会自动登录，无需先点登录。
          </div>
        </Panel>

        <Panel title="快捷入口" meta={`${QUICK_LINKS.length} 个`}>
          <div className="zt-quick">
            {QUICK_LINKS.map(l => (
              <button key={l.page} className="btn btn-secondary" onClick={() => openUrl(l.page)}>
                {l.label}
                <Icons.extern size={12} />
              </button>
            ))}
          </div>
        </Panel>

        {bugs.length > 0 && (
          <Panel
            title="统计（点击筛选下方列表）"
            meta={`共 ${bugs.length} 条${total > bugs.length ? ` / 禅道共 ${total}` : ''}`}
            tools={hasFilter ? (
              <button className="btn btn-ghost btn-sm" onClick={() => setFilter({ project: '', status: '', severity: '', query: '' })}>
                清除筛选
              </button>
            ) : undefined}
          >
            <div className="zt-cards">
              <StatCard label="全部" value={overall.total} tone="info" active={!status && !severity}
                onClick={() => setFilter({ status: '', severity: '' })} />
              {DIMS.map(d => (
                <StatCard key={d.key} label={d.label} value={(overall as Record<string, number>)[d.key] || 0} tone={d.tone}
                  active={status === d.key} onClick={() => setFilter({ status: status === d.key ? '' : d.key })} />
              ))}
              {Object.entries(SEVERITY).map(([k, v]) => (
                <StatCard key={k} label={v.label} value={severityCount[k] || 0} tone={v.tone}
                  active={severity === k} onClick={() => setFilter({ severity: severity === k ? '' : k })} />
              ))}
            </div>

            <div className="zt-proj-wrap">
              <table className="tbl zt-proj">
                <thead>
                  <tr>
                    <th style={{ minWidth: 180 }}>项目</th>
                    <th className="num">总计</th>
                    {DIMS.map(d => <th key={d.key} className="num">{d.label}</th>)}
                    <th className="num">致命</th>
                  </tr>
                </thead>
                <tbody>
                  {byProject.map(r => (
                    <tr key={r.name} className={project === r.name ? 'is-active' : undefined}>
                      <td>
                        <button className="zt-proj-name" onClick={() => setFilter({ project: project === r.name ? '' : r.name })} title={r.name}>
                          {r.name}
                        </button>
                      </td>
                      <td className="cell-num">
                        <button className="zt-num" onClick={() => setFilter({ project: r.name, status: '', severity: '' })}>{r.total}</button>
                      </td>
                      {DIMS.map(d => (
                        <td key={d.key} className="cell-num">
                          <button
                            className={`zt-num${(r as unknown as Record<string, number>)[d.key] ? '' : ' zero'}`}
                            onClick={() => setFilter({ project: r.name, status: d.key })}
                          >
                            {(r as unknown as Record<string, number>)[d.key]}
                          </button>
                        </td>
                      ))}
                      <td className="cell-num">
                        <button
                          className={`zt-num${r.fatal ? ' danger' : ' zero'}`}
                          onClick={() => setFilter({ project: r.name, severity: '1' })}
                        >
                          {r.fatal}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}

        {bugs.length > 0 && (
          <Panel
            title="我的 Bug"
            meta={`${visibleBugs.length} / ${bugs.length} 条`}
            tools={
              <div className="zt-filters">
                <select value={project} onChange={e => setFilter({ project: e.target.value })}>
                  <option value="">全部项目</option>
                  {projects.map(([p, n]) => <option key={p} value={p}>{p}（{n}）</option>)}
                </select>
                <select value={status} onChange={e => setFilter({ status: e.target.value })}>
                  <option value="">全部状态</option>
                  {DIMS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                </select>
                <select value={severity} onChange={e => setFilter({ severity: e.target.value })}>
                  <option value="">全部严重程度</option>
                  {Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <SearchBox value={query} onChange={v => setFilter({ query: v })} placeholder="标题 / ID" />
              </div>
            }
            flush
          >
            {hasFilter && (
              <div className="zt-active-filter">
                <span>当前筛选：</span>
                {project && <Pill tone="info">{project}<button onClick={() => setFilter({ project: '' })}><Icons.close size={11} /></button></Pill>}
                {status && <Pill tone="warn">{dimLabel(status)}<button onClick={() => setFilter({ status: '' })}><Icons.close size={11} /></button></Pill>}
                {severity && <Pill tone={SEVERITY[severity]?.tone}>{SEVERITY[severity]?.label || severity}<button onClick={() => setFilter({ severity: '' })}><Icons.close size={11} /></button></Pill>}
                {query.trim() && <Pill tone="mute">“{query.trim()}”<button onClick={() => setFilter({ query: '' })}><Icons.close size={11} /></button></Pill>}
              </div>
            )}

            {visibleBugs.length === 0 ? (
              <Empty
                icon={<Icons.bug size={22} />}
                title="没有符合条件的 Bug"
                desc="点上面的「清除筛选」看全部"
              />
            ) : (
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 78 }}>ID</th>
                    <th>标题</th>
                    <th style={{ width: 96 }}>状态</th>
                    <th style={{ width: 92 }}>严重程度</th>
                    <th style={{ width: 70 }}>优先级</th>
                    <th style={{ width: 190 }}>项目</th>
                    <th style={{ width: 104 }}>截止</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleBugs.map(b => {
                    const st = STATUS[b.status || ''];
                    const sev = SEVERITY[String(b.severity)];
                    return (
                      <tr key={b.id} className="zt-row" onClick={() => openUrl(`bug-view-${b.id}.html`)} title="在浏览器中打开该 Bug">
                        <td className="cell-mono">#{b.id}</td>
                        <td className="cell-strong" style={{ maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.title}>
                          {isFixed(b) && <span className="zt-fixed" title="解决方案：已修复">已修复</span>}
                          {b.title}
                        </td>
                        <td><Pill tone={st?.tone || 'mute'} dot>{st?.label || b.status || '—'}</Pill></td>
                        <td>{sev ? <Pill tone={sev.tone}>{sev.label}</Pill> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        <td className="cell-num">{b.pri || '—'}</td>
                        <td style={{ color: 'var(--text-muted)', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.productName}>
                          {b.productName || '—'}
                        </td>
                        <td className="cell-num" style={{ color: 'var(--text-muted)' }}>{b.deadline || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Panel>
        )}

        {bugs.length === 0 && (
          <Panel>
            <Empty
              icon={<Icons.bug size={22} />}
              title="还没有 Bug 数据"
              desc="填好上面的地址账号后点「拉取我的 Bug」，结果会一直保留，切换页面也不会丢"
            />
          </Panel>
        )}
      </Page>
    </div>
  );
}

function StatCard({
  label, value, tone, active, onClick,
}: {
  label: string;
  value: number;
  tone: PillTone;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button className={`zt-card is-${tone}${active ? ' is-active' : ''}`} onClick={onClick}>
      <span className="zt-card-num">{value}</span>
      <span className="zt-card-label">{label}</span>
    </button>
  );
}
