import React, { useEffect, useMemo, useState } from 'react';
import type { ZentaoBug, ZentaoConfig } from '../types';
import { useCollection, PageHeader } from '../hooks/useCollection';

const STATUS_LABEL: Record<string, string> = {
  active: '激活', resolved: '已解决', closed: '已关闭', postponed: '延期',
};
const SEVERITY_LABEL: Record<string, string> = { '1': '1 致命', '2': '2 严重', '3': '3 一般', '4': '4 轻微' };

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

  return (
    <div className="content-area">
      <div className="module-page">
        <PageHeader title="禅道" desc="连接公司禅道，快速查看名下 Bug 与统计（账号密码加密保存在本地）">
          {loggedIn && <span className="badge-ok">已登录</span>}
        </PageHeader>

        <div className="module-section">
          <div className="module-section-title">连接配置</div>
          <div className="zt-form">
            <div className="form-group">
              <label>禅道地址</label>
              <input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="http://zentao.example.com/zentao" />
            </div>
            <div className="form-group">
              <label>账号</label>
              <input value={form.account} onChange={e => setForm({ ...form, account: e.target.value })} placeholder="用户名" />
            </div>
            <div className="form-group">
              <label>密码</label>
              <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="密码" />
            </div>
            <div className="zt-actions">
              <button className="btn btn-primary btn-sm" onClick={login} disabled={busy === 'login'}>
                {busy === 'login' ? '登录中…' : '登录并保存'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={loadBugs} disabled={busy === 'bugs'}>
                {busy === 'bugs' ? '拉取中…' : '拉取我的 Bug'}
              </button>
            </div>
            {error && <div className="input-hint" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{error}</div>}
          </div>
        </div>

        <div className="module-section">
          <div className="module-section-title">快捷入口</div>
          <div className="zt-links">
            {QUICK_LINKS.map(l => (
              <button key={l.page} className="btn btn-sm btn-secondary" onClick={() => openUrl(l.page)}>{l.label}</button>
            ))}
          </div>
        </div>

        {bugs && (
          <div className="module-section">
            <div className="module-section-title">
              我的 Bug（{bugs.length}{total > bugs.length ? ` / 共 ${total}` : ''}）
            </div>
            {stats && (
              <div className="zt-stats">
                {Object.entries(stats.byStatus).map(([k, v]) => (
                  <span key={k} className="zt-stat">{STATUS_LABEL[k] || k}：<strong>{v}</strong></span>
                ))}
                {Object.entries(stats.bySeverity).map(([k, v]) => (
                  <span key={k} className="zt-stat">{SEVERITY_LABEL[k] || `严重度 ${k}`}：<strong>{v}</strong></span>
                ))}
              </div>
            )}
            {bugs.length === 0 ? (
              <div className="module-empty">没有查到 Bug（可能是权限或接口差异，可先用上方快捷入口查看）</div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>ID</th>
                    <th>标题</th>
                    <th style={{ width: 80 }}>状态</th>
                    <th style={{ width: 86 }}>严重程度</th>
                    <th style={{ width: 64 }}>优先级</th>
                    <th style={{ width: 160 }}>产品</th>
                    <th style={{ width: 96 }}>截止日期</th>
                  </tr>
                </thead>
                <tbody>
                  {bugs.map(b => (
                    <tr key={b.id} onClick={() => openUrl(`bug-view-${b.id}.html`)} style={{ cursor: 'pointer' }}>
                      <td>{b.id}</td>
                      <td title={b.title}>{b.title}</td>
                      <td>{STATUS_LABEL[b.status || ''] || b.status || '-'}</td>
                      <td>{SEVERITY_LABEL[String(b.severity)] || b.severity || '-'}</td>
                      <td>{b.pri || '-'}</td>
                      <td title={b.productName}>{b.productName || '-'}</td>
                      <td>{b.deadline || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {!bugs && (
          <div className="module-tip">
            提示：登录后会话保存在内存中（重启程序需重新登录）；拉取 Bug 时会自动登录，无需先点「登录并保存」。
          </div>
        )}
      </div>
    </div>
  );
}
