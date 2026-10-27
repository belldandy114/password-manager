import React, { useEffect, useMemo, useState } from 'react';
import type { ZentaoBug, ZentaoConfig } from '../types';
import { useCollection } from '../hooks/useCollection';
import { Page, PageHead, Panel, Empty, Field, Icons, Pill, type PillTone } from '../components/ui';

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  active: { label: '激活', tone: 'bad' },
  resolved: { label: '已解决', tone: 'ok' },
  closed: { label: '已关闭', tone: 'mute' },
  postponed: { label: '延期', tone: 'warn' },
};

const SEVERITY: Record<string, { label: string; tone: PillTone }> = {
  '1': { label: '致命', tone: 'bad' },
  '2': { label: '严重', tone: 'warn' },
  '3': { label: '一般', tone: 'mute' },
  '4': { label: '轻微', tone: 'mute' },
};

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

  const [form, setForm] = useState({ baseUrl: '', account: '', password: '' });
  const [loggedIn, setLoggedIn] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [bugs, setBugs] = useState<ZentaoBug[] | null>(null);
  const [total, setTotal] = useState(0);
  const [filter, setFilter] = useState('');

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
      setBugs(res.data);
      setTotal(res.total || res.data.length);
      setLoggedIn(true);
    } else {
      setError(res.error || '拉取失败');
    }
  };

  const openUrl = (path: string) => {
    const base = form.baseUrl.trim().replace(/\/+$/, '');
    if (!base) { setError('请先填写禅道地址'); return; }
    window.electronAPI.browserOpen({ browser: 'default', url: `${base}/${path.replace(/^\/+/, '')}` });
  };

  const stats = useMemo(() => {
    if (!bugs) return null;
    const byStatus: Record<string, number> = {};
    const bySeverity: Record<string, number> = {};
    for (const b of bugs) {
      const s = b.status || '未知';
      byStatus[s] = (byStatus[s] || 0) + 1;
      const sev = b.severity ? String(b.severity) : '未知';
      bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    }
    return { byStatus, bySeverity };
  }, [bugs]);

  const visibleBugs = useMemo(() => {
    if (!bugs) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return bugs;
    return bugs.filter(b => [b.id, b.title, b.productName, b.status].some(v => (v || '').toLowerCase().includes(q)));
  }, [bugs, filter]);

  return (
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.bug size={16} />}
          title="禅道"
          desc="连接公司禅道，查看名下 Bug 与统计；账号密码加密保存在本地"
          tools={
            <>
              {loggedIn && <Pill tone="ok" dot>已登录</Pill>}
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

        {bugs && (
          <Panel
            title="我的 Bug"
            meta={total > bugs.length ? `${bugs.length} / 共 ${total}` : `${bugs.length} 条`}
            tools={
              <div className="search">
                <span className="search-ico"><Icons.search size={14} /></span>
                <input
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="筛选标题 / ID / 产品"
                  style={{ width: 190 }}
                />
              </div>
            }
            flush
          >
            {stats && (
              <div className="zt-stats2">
                {Object.entries(stats.byStatus).map(([k, v]) => (
                  <span key={k} className="zt-stat2">
                    {STATUS[k]?.label || k}
                    <strong>{v}</strong>
                  </span>
                ))}
                <span style={{ width: 1, background: 'var(--border)', margin: '0 2px' }} />
                {Object.entries(stats.bySeverity).map(([k, v]) => (
                  <span key={k} className="zt-stat2">
                    {SEVERITY[k]?.label || `严重度 ${k}`}
                    <strong>{v}</strong>
                  </span>
                ))}
              </div>
            )}

            {visibleBugs.length === 0 ? (
              <Empty
                icon={<Icons.bug size={22} />}
                title={filter ? '没有匹配的 Bug' : '没有查到 Bug'}
                desc={filter ? '换个关键词试试' : '可能是权限或接口差异，可先用上方快捷入口在浏览器里查看'}
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
                    <th style={{ width: 190 }}>产品</th>
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
      </Page>
    </div>
  );
}
