import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { JmxInspectResult, JmxLibDir, JmxLibFile, JmxLibListing, JmxLibMeta, JmxRun } from '../types';
import { Icons, IconBtn, SearchBox, Empty } from './ui';
import { Modal } from './Modal';
import { formatRecent } from '../utils/time';

/**
 * JmxLibrary —— 压力测试「脚本库」
 *
 * 和用例库的区别：只收 .jmx；点一个脚本就把「运行配置」填好（脚本路径 + 输出目录 + 线程/循环），
 * 每个脚本自己的默认参数存在主进程的 jmxlib.json 里。
 */

interface Props {
  onPick: (absPath: string, rel: string, meta: JmxLibMeta) => void;
  /** 运行完成后调用，用来刷新「最近运行」 */
  refreshKey?: number;
}

const joinWin = (root: string, rel: string) => {
  const base = root.replace(/[\\/]+$/, '');
  return rel ? `${base}\\${rel.replace(/\//g, '\\')}` : base;
};

export function JmxLibrary({ onPick, refreshKey = 0 }: Props) {
  const [root, setRoot] = useState('');
  const [configured, setConfigured] = useState(false);
  const [listing, setListing] = useState<JmxLibListing | null>(null);
  const [subs, setSubs] = useState<Record<string, JmxLibDir[]>>({});
  const [files, setFiles] = useState<Record<string, JmxLibFile[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null);
  const [dlg, setDlg] = useState<{ kind: 'mkdir' | 'mkdir-in' | 'rename' | 'settings' | 'new-script'; rel?: string; value?: string; meta?: JmxLibMeta; form?: { url: string; method: string; threads: string; loops: string } } | null>(null);
  const [settingsInfo, setSettingsInfo] = useState<JmxInspectResult | null>(null);

  const loadRoot = useCallback(async () => {
    const r = await window.electronAPI.jmxlibList('');
    if (!r.success || !r.data) {
      setNotice({ tone: 'bad', text: r.error || '读取脚本库失败' });
      return;
    }
    setListing(r.data);
    setRoot(r.data.root);
    setConfigured(r.data.configured);
  }, []);

  const loadDir = useCallback(async (rel: string) => {
    const r = await window.electronAPI.jmxlibList(rel);
    if (!r.success || !r.data) return;
    setSubs(prev => ({ ...prev, [rel]: r.data!.dirs }));
    setFiles(prev => ({ ...prev, [rel]: r.data!.files }));
  }, []);

  useEffect(() => { void loadRoot(); }, [loadRoot, refreshKey]);


  const chooseRoot = async () => {
    const r = await window.electronAPI.jmxlibChooseRoot();
    if (!r.success) { if (!r.canceled) setNotice({ tone: 'bad', text: r.error || '选择失败' }); return; }
    setNotice(null);
    await loadRoot();
    setExpanded(new Set());
    setSubs({});
    setFiles({});
  };

  const toggle = async (rel: string) => {
    const next = new Set(expanded);
    if (next.has(rel)) {
      next.delete(rel);
    } else {
      next.add(rel);
      await loadDir(rel);
    }
    setExpanded(next);
  };

  const refreshTree = async () => {
    await loadRoot();
    for (const rel of expanded) await loadDir(rel);
  };

  // 外部（导入/重命名等 IPC）完成后发个事件让列表刷新；测试里也用它代替原生对话框
  useEffect(() => {
    const h = () => { void refreshTree(); };
    window.addEventListener('pm:jmxlib-refresh', h);
    return () => window.removeEventListener('pm:jmxlib-refresh', h);
  }, [expanded]);

  const importFiles = async (targetRel: string) => {
    const picked = await window.electronAPI.jmxlibPickFiles();
    if (!picked.success) { if (!picked.canceled) setNotice({ tone: 'bad', text: picked.error || '选择失败' }); return; }
    const paths = (picked.data as string[]) || [];
    if (!paths.length) return;
    setBusy(true);
    const r = await window.electronAPI.jmxlibImport(targetRel, paths);
    setBusy(false);
    if (!r.success) { setNotice({ tone: 'bad', text: `导入失败：${r.error}` }); return; }
    const data = r.data as { imported: string[]; failed: string[] };
    await refreshTree();
    setNotice(data.failed.length
      ? { tone: 'warn', text: `已导入 ${data.imported.length} 个，失败 ${data.failed.length} 个：${data.failed.join('；')}` }
      : { tone: 'ok', text: `已导入 ${data.imported.length} 个脚本` });
  };

  /** 打开脚本设置时顺带取一次检查结果（参数列表、数据文件、趋势都用它） */
  const openSettings = async (f: JmxLibFile) => {
    // 列表里的 meta 可能是加载时的快照，先取一次最新的（含最近运行）
    const dir = f.rel.split('/').slice(0, -1).join('/');
    const lr = await window.electronAPI.jmxlibList(dir);
    const fresh = lr.success && lr.data ? lr.data.files.find(x => x.rel === f.rel) : null;
    setDlg({ kind: 'settings', rel: f.rel, value: f.name, meta: { ...(fresh ? fresh.meta : f.meta) } });
    setSettingsInfo(null);
    const r = await window.electronAPI.jmxlibValidate(f.rel);
    if (r.success && r.data) setSettingsInfo(r.data);
  };

  const doCreateTemplate = async () => {
    const f = dlg?.form;
    if (!f) return;
    if (!f.url.trim()) { setNotice({ tone: 'bad', text: '请填写请求地址' }); return; }
    const r = await window.electronAPI.jmxlibCreateTemplate('', {
      name: dlg?.value || undefined,
      url: f.url.trim(),
      method: f.method,
      threads: f.threads ? Number(f.threads) : undefined,
      loops: f.loops ? Number(f.loops) : undefined,
    });
    if (!r.success) { setNotice({ tone: 'bad', text: r.error || '新建失败' }); return; }
    setDlg(null);
    await refreshTree();
    setNotice({ tone: 'ok', text: `已生成脚本「${r.data?.name || ''}」，点它就能跑` });
  };

  const doMkdir = async () => {
    if (!dlg?.value?.trim()) return;
    const r = await window.electronAPI.jmxlibMkdir('', dlg.value.trim());
    if (!r.success) { setNotice({ tone: 'bad', text: r.error || '新建失败' }); return; }
    setDlg(null);
    await refreshTree();
  };

  const doRename = async () => {
    if (!dlg?.rel || !dlg.value?.trim()) return;
    const r = await window.electronAPI.jmxlibRename(dlg.rel, dlg.value.trim());
    if (!r.success) { setNotice({ tone: 'bad', text: r.error || '重命名失败' }); return; }
    setDlg(null);
    await refreshTree();
  };

  const doSaveMeta = async () => {
    if (!dlg?.rel) return;
    const r = await window.electronAPI.jmxlibMetaSet(dlg.rel, dlg.meta || {});
    if (!r.success) { setNotice({ tone: 'bad', text: r.error || '保存失败' }); return; }
    setDlg(null);
    await refreshTree();
    setNotice({ tone: 'ok', text: '脚本参数已保存' });
  };

  const remove = async (f: JmxLibFile) => {
    const r = await window.electronAPI.jmxlibDelete(f.rel);
    if (!r.success) { setNotice({ tone: 'bad', text: r.error || '删除失败' }); return; }
    await refreshTree();
    setNotice({ tone: 'ok', text: `已删除「${f.name}」（进回收站，可恢复）` });
  };

  const validate = async (f: JmxLibFile) => {
    const r = await window.electronAPI.jmxlibValidate(f.rel);
    if (!r.success || !r.data) { setNotice({ tone: 'bad', text: r.error || '检查失败' }); return; }
    const d = r.data;
    if (!d.ok) { setNotice({ tone: 'bad', text: `脚本有问题：${d.error}` }); return; }
    const bits = [`${d.threadGroups} 个线程组`];
    if (d.threadsDefault) bits.push(`默认线程 ${d.threadsDefault}`);
    if (d.loopsDefault) bits.push(`默认循环 ${d.loopsDefault}`);
    if (d.params.length) bits.push(`可覆盖参数 ${d.params.map(p => p.name).join(' / ')}`);
    const low = (d.files || []).filter(f => f.exists && f.lines > 0 && d.threadsDefault && f.lines < d.threadsDefault);
    if (d.missingFiles.length) {
      setNotice({ tone: 'warn', text: `${bits.join(' · ')}；引用的文件找不到：${d.missingFiles.join('、')}` });
    } else if (low.length) {
      setNotice({
        tone: 'warn',
        text: `${bits.join(' · ')}；${low.map(f => `${f.path} 只有 ${f.lines} 行`).join('、')}，少于线程数 ${d.threadsDefault}，多线程会重复读同一批数据`,
      });
    } else {
      setNotice({ tone: 'ok', text: `${d.testName ? `「${d.testName}」` : ''}${bits.join(' · ')}` });
    }
  };

  const pickOne = async (f: JmxLibFile) => {
    // 点的时候现取一次 meta：列表里的可能是旧快照（别处刚改过参数/输出目录）
    const dir = f.rel.split('/').slice(0, -1).join('/');
    const lr = await window.electronAPI.jmxlibList(dir);
    const fresh = lr.success && lr.data ? lr.data.files.find(x => x.rel === f.rel) : null;
    // 只带脚本自己存的参数；没存输出目录就交给页面保留用户当前选择
    // （1.28.2：之前这里会先取默认目录再传过去，把用户设好的目录冲掉了）
    onPick(joinWin(root, f.rel), f.rel, { ...(fresh ? fresh.meta : f.meta) });
    setNotice({ tone: 'ok', text: `已载入「${f.name}」，检查参数后点「开始运行」` });
  };

  const q = query.trim().toLowerCase();
  const matchFile = (f: JmxLibFile) => !q || f.name.toLowerCase().includes(q);

  const rows = useMemo(() => {
    if (!listing) return [];
    const out: { dir: JmxLibDir; level: 1 | 2 }[] = [];
    for (const d of listing.dirs) {
      out.push({ dir: d, level: 1 });
      if (expanded.has(d.rel)) {
        for (const sub of subs[d.rel] || []) out.push({ dir: sub, level: 2 });
      }
    }
    return out;
  }, [listing, expanded, subs]);

  if (!configured) {
    return (
      <Empty
        compact
        icon={<Icons.folder size={20} />}
        title="还没有脚本库目录"
        desc="选一个放 .jmx 的文件夹；之后点脚本就能把路径、输出目录、线程/循环一次填好"
        action={<button className="btn btn-primary btn-sm" onClick={() => void chooseRoot()}>选择目录</button>}
      />
    );
  }

  return (
    <div className="jmxlib">
      <div className="jmxlib-bar">
        <SearchBox value={query} onChange={setQuery} placeholder="搜索脚本名" />
        <button className="btn btn-secondary btn-sm" onClick={() => void importFiles('')} disabled={busy}>
          <Icons.upload size={13} /> 导入脚本
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => setDlg({ kind: 'mkdir', value: '' })}>
          <Icons.plus size={13} /> 新建文件夹
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setDlg({ kind: 'new-script', value: '', form: { url: '', method: 'GET', threads: '10', loops: '1' } })}
          title="按模板生成一个最小可跑的 HTTP 脚本"
        >
          <Icons.plus size={13} /> 新建脚本
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => void chooseRoot()} title="更换脚本库目录">
          <Icons.folder size={13} /> 更换目录
        </button>
      </div>

      {notice && (
        <div className={`jmxlib-notice is-${notice.tone}`} role="status">
          {notice.text}
          <button className="jmxlib-notice-x" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
        </div>
      )}

      <div className="jmxlib-tree">
        {listing?.dirs.length === 0 && (
          <div className="jmxlib-empty">还没有文件夹 —— 先「新建文件夹」按系统分类，再导入脚本</div>
        )}
        {rows.map(({ dir, level }) => (
          <React.Fragment key={dir.rel}>
            <div
              className={`jmxlib-dir is-l${level}`}
              onClick={() => void toggle(dir.rel)}
              role="button"
              tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void toggle(dir.rel); } }}
              title={dir.rel}
            >
              <span className={`jmxlib-chev${expanded.has(dir.rel) ? ' is-open' : ''}`}><Icons.chevron size={11} /></span>
              <Icons.folder size={13} />
              <span className="jmxlib-name">{dir.name}</span>
              <em className="jmxlib-n">{dir.jmxCount}</em>
              <span className="jmxlib-row-actions" onClick={e => e.stopPropagation()}>
                <IconBtn title="往这里导入脚本" onClick={() => void importFiles(dir.rel)}><Icons.upload size={12} /></IconBtn>
                <IconBtn title="新建子文件夹" onClick={() => setDlg({ kind: 'mkdir-in', rel: dir.rel, value: '' })}><Icons.plus size={12} /></IconBtn>
                <IconBtn title="重命名" onClick={() => setDlg({ kind: 'rename', rel: dir.rel, value: dir.name })}><Icons.pencil size={12} /></IconBtn>
                <IconBtn danger title="删除（进回收站）" onClick={async () => { const r = await window.electronAPI.jmxlibDelete(dir.rel); if (r.success) { await refreshTree(); setNotice({ tone: 'ok', text: '已删除文件夹' }); } else setNotice({ tone: 'bad', text: r.error || '删除失败' }); }}><Icons.trash size={12} /></IconBtn>
              </span>
            </div>
            {expanded.has(dir.rel) && (
              <>
                {(files[dir.rel] || []).filter(matchFile).map(f => (
                  <ScriptRow
                    key={f.rel}
                    file={f}
                    indent={level === 1 ? 1 : 2}
                    onPick={() => void pickOne(f)}
                    onValidate={() => void validate(f)}
                    onSettings={() => void openSettings(f)}
                    onReveal={() => void window.electronAPI.jmxlibReveal(f.rel)}
                    onRename={() => setDlg({ kind: 'rename', rel: f.rel, value: f.name })}
                    onDelete={() => void remove(f)}
                  />
                ))}
                {level === 1 && (subs[dir.rel] || []).length === 0 && (files[dir.rel] || []).filter(matchFile).length === 0 && (
                  <div className="jmxlib-hint">空文件夹 · 可以往这里导入脚本</div>
                )}
              </>
            )}
          </React.Fragment>
        ))}
        {(listing?.files || []).filter(matchFile).length > 0 && (
          <div className="jmxlib-hint jmxlib-root-head">根目录脚本</div>
        )}
        {(listing?.files || []).filter(matchFile).map(f => (
          <ScriptRow
            key={f.rel}
            file={f}
            indent={0}
            onPick={() => void pickOne(f)}
            onValidate={() => void validate(f)}
            onSettings={() => void openSettings(f)}
            onReveal={() => void window.electronAPI.jmxlibReveal(f.rel)}
            onRename={() => setDlg({ kind: 'rename', rel: f.rel, value: f.name })}
            onDelete={() => void remove(f)}
          />
        ))}
      </div>

      {/* 新建文件夹 / 重命名 */}
      <Modal
        open={!!dlg && dlg.kind !== 'settings'}
        onClose={() => setDlg(null)}
        title={dlg?.kind === 'rename' ? '重命名' : '新建文件夹'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDlg(null)}>取消</button>
            <button className="btn btn-primary" onClick={() => { if (dlg?.kind === 'rename') void doRename(); else if (dlg?.kind === 'mkdir-in') void doMkdirIn(); else void doMkdir(); }}>确定</button>
          </>
        }
      >
        <div className="form-group">
          <label>名称</label>
          <input
            value={dlg?.value || ''}
            onChange={e => setDlg(prev => (prev ? { ...prev, value: e.target.value } : prev))}
            onKeyDown={e => { if (e.key === 'Enter') { if (dlg?.kind === 'rename') void doRename(); else if (dlg?.kind === 'mkdir-in') void doMkdirIn(); else void doMkdir(); } }}
            placeholder="例如：生产环境 / 登录压测"
            autoFocus
            aria-label="名称"
          />
        </div>
      </Modal>

      {/* 新建脚本（模板） */}
      <Modal
        open={dlg?.kind === 'new-script'}
        onClose={() => setDlg(null)}
        title="新建脚本（HTTP 模板）"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDlg(null)}>取消</button>
            <button className="btn btn-primary" onClick={() => void doCreateTemplate()}>生成</button>
          </>
        }
      >
        <div className="form-group">
          <label>脚本名称</label>
          <input
            value={dlg?.value || ''}
            onChange={e => setDlg(prev => (prev ? { ...prev, value: e.target.value } : prev))}
            placeholder="例如：登录接口-基线"
            aria-label="脚本名称"
          />
          <div className="input-hint">留空则用「主机名-路径」命名；自动补 <code>.jmx</code></div>
        </div>
        <div className="jmxlib-form-row">
          <div className="form-group" style={{ flex: '0 0 110px' }}>
            <label>方法</label>
            <select
              value={dlg?.form?.method || 'GET'}
              onChange={e => setDlg(prev => (prev ? { ...prev, form: { ...prev.form!, method: e.target.value } } : prev))}
              aria-label="请求方法"
            >
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </div>
          <div className="form-group">
            <label>请求地址</label>
            <input
              value={dlg?.form?.url || ''}
              onChange={e => setDlg(prev => (prev ? { ...prev, form: { ...prev.form!, url: e.target.value } } : prev))}
              placeholder="https://example.com/api/login"
              aria-label="请求地址"
            />
          </div>
        </div>
        <div className="jmxlib-form-row">
          <div className="form-group">
            <label>默认线程数</label>
            <input
              value={dlg?.form?.threads || ''}
              onChange={e => setDlg(prev => (prev ? { ...prev, form: { ...prev.form!, threads: e.target.value } } : prev))}
              inputMode="numeric"
              placeholder="10"
              aria-label="默认线程数"
            />
          </div>
          <div className="form-group">
            <label>默认循环</label>
            <input
              value={dlg?.form?.loops || ''}
              onChange={e => setDlg(prev => (prev ? { ...prev, form: { ...prev.form!, loops: e.target.value } } : prev))}
              inputMode="numeric"
              placeholder="1"
              aria-label="默认循环"
            />
          </div>
        </div>
        <div className="input-hint">
          模板里线程/循环写成 <code>{'${__P(threads,10)}'}</code> 形式，运行页填的数字才会真正覆盖。
          生成后在 JMeter GUI 里再补请求体、断言、CSV 等。
        </div>
      </Modal>

      {/* 脚本默认参数 */}
      <Modal
        open={dlg?.kind === 'settings'}
        onClose={() => setDlg(null)}
        title={`脚本设置 · ${dlg?.value || ''}`}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setDlg(null)}>取消</button>
            <button className="btn btn-primary" onClick={() => void doSaveMeta()}>保存</button>
          </>
        }
      >
        <div className="form-group">
          <label>输出目录</label>
          <div className="jmxlib-dir-row">
            <input
              value={dlg?.meta?.outDir || ''}
              onChange={e => setDlg(prev => (prev ? { ...prev, meta: { ...prev.meta, outDir: e.target.value } } : prev))}
              placeholder="留空则用数据目录下的 jmeter-reports"
              aria-label="输出目录"
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={async () => {
                const r = await window.electronAPI.jmxlibPickDir();
                if (r.success && r.data) setDlg(prev => (prev ? { ...prev, meta: { ...prev.meta, outDir: r.data!.dir } } : prev));
              }}
            >选择</button>
          </div>
          <div className="input-hint">每次运行会在这个目录下新建 <code>report-时间戳</code>，不会覆盖历史报告</div>
        </div>
        <div className="jmxlib-form-row">
          <div className="form-group">
            <label>线程数</label>
            <input
              value={dlg?.meta?.threads ?? ''}
              onChange={e => setDlg(prev => (prev ? { ...prev, meta: { ...prev.meta, threads: e.target.value ? Number(e.target.value) : undefined } } : prev))}
              placeholder="例如：200"
              inputMode="numeric"
              aria-label="线程数"
            />
          </div>
          <div className="form-group">
            <label>循环次数</label>
            <input
              value={dlg?.meta?.loops ?? ''}
              onChange={e => setDlg(prev => (prev ? { ...prev, meta: { ...prev.meta, loops: e.target.value ? Number(e.target.value) : undefined } } : prev))}
              placeholder="例如：30"
              inputMode="numeric"
              aria-label="循环次数"
            />
          </div>
        </div>
        <div className="form-group">
          <label>备注</label>
          <textarea
            value={dlg?.meta?.note || ''}
            onChange={e => setDlg(prev => (prev ? { ...prev, meta: { ...prev.meta, note: e.target.value } } : prev))}
            placeholder="这个脚本压什么、前置条件、数据准备……"
            rows={3}
            aria-label="备注"
          />
        </div>
        {dlg?.meta?.lastRun && (
          <div className="input-hint">
            最近运行：{formatRecent(dlg.meta.lastRun.at)} · {dlg.meta.lastRun.ok ? '成功' : '失败'}
            {dlg.meta.lastRun.reportDir ? <> · <code>{dlg.meta.lastRun.reportDir}</code></> : null}
          </div>
        )}

        {/* 参数面板：脚本里 ${__P(name,default)} 声明过的参数，运行页可直接填 */}
        {!!settingsInfo?.params.length && (
          <div className="form-group">
            <label>脚本参数（<code>{'${__P(...)}'}</code>）</label>
            <div className="jmxlib-params">
              {settingsInfo.params.map(p => (
                <label key={p.name} className="jmxlib-param">
                  <span>{p.name}</span>
                  <input
                    value={dlg?.meta?.params?.[p.name] ?? ''}
                    onChange={e => setDlg(prev => (prev ? {
                      ...prev,
                      meta: { ...prev.meta, params: { ...(prev.meta?.params || {}), [p.name]: e.target.value } },
                    } : prev))}
                    placeholder={p.value ? `默认 ${p.value}` : '未设置'}
                    aria-label={`参数 ${p.name}`}
                  />
                </label>
              ))}
            </div>
            <div className="input-hint">运行时会以 <code>-J名字=值</code> 传给 JMeter；留空则用脚本里的默认值</div>
          </div>
        )}

        {/* 数据文件预检 */}
        {!!settingsInfo?.files.length && (
          <div className="form-group">
            <label>数据文件预检</label>
            <div className="jmxlib-files">
              {settingsInfo.files.map(f => {
                const threads = dlg?.meta?.threads || settingsInfo.threadsDefault || 0;
                const low = f.exists && f.lines > 0 && threads > 0 && f.lines < threads;
                return (
                  <div key={f.path} className={`jmxlib-file ${!f.exists ? 'is-bad' : low ? 'is-warn' : 'is-ok'}`}>
                    <span className="jmxlib-file-name" title={f.abs}>{f.path}</span>
                    <span className="jmxlib-file-meta">
                      {!f.exists ? '找不到' : `${f.lines} 行 · ${f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`}`}
                    </span>
                    {!f.exists && <span className="jmxlib-file-tip">路径不存在，运行时会取不到数据</span>}
                    {low && <span className="jmxlib-file-tip">行数少于线程数（{threads}），多线程会重复读同一批数据</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 历史趋势 */}
        {!!dlg?.meta?.runs?.length && (
          <div className="form-group">
            <label>最近 {dlg.meta.runs.length} 次趋势</label>
            <RunTrend runs={dlg.meta.runs} />
          </div>
        )}
      </Modal>
    </div>
  );

  async function doMkdirIn() {
    const rel = dlg?.rel || '';
    const name = dlg?.value?.trim();
    if (!name) return;
    const r = await window.electronAPI.jmxlibMkdir(rel, name);
    if (!r.success) { setNotice({ tone: 'bad', text: r.error || '新建失败' }); return; }
    setDlg(null);
    const next = new Set(expanded);
    next.add(rel);
    setExpanded(next);
    await loadDir(rel);
    await loadRoot();
  }
}

function ScriptRow({ file, indent, onPick, onValidate, onSettings, onReveal, onRename, onDelete }: {
  file: JmxLibFile;
  indent: number;
  onPick: () => void;
  onValidate: () => void;
  onSettings: () => void;
  onReveal: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const meta = file.meta || {};
  const last = meta.lastRun;
  return (
    <div
      className={`jmxlib-row is-l${indent}`}
      onClick={onPick}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(); } }}
      title={`点击载入运行配置\n${file.rel}`}
    >
      <Icons.chart size={13} />
      <span className="jmxlib-name">{file.name}</span>
      {meta.note ? <span className="jmxlib-note" title={meta.note}>{meta.note}</span> : null}
      {last && (
        <span className={`jmxlib-last ${last.ok ? 'is-ok' : 'is-bad'}`} title={`最近运行：${new Date(last.at).toLocaleString()}${last.reportDir ? `\n报告：${last.reportDir}` : ''}`}>
          {last.ok ? '✓' : '✗'} {formatRecent(last.at)}
        </span>
      )}
      <span className="jmxlib-row-actions" onClick={e => e.stopPropagation()}>
        <IconBtn title="检查脚本" onClick={onValidate}><Icons.check size={12} /></IconBtn>
        <IconBtn title="脚本设置" onClick={onSettings}><Icons.tool size={12} /></IconBtn>
        <IconBtn title="在资源管理器中显示" onClick={onReveal}><Icons.folder size={12} /></IconBtn>
        <IconBtn title="重命名" onClick={onRename}><Icons.pencil size={12} /></IconBtn>
        <IconBtn danger title="删除（进回收站）" onClick={onDelete}><Icons.trash size={12} /></IconBtn>
      </span>
    </div>
  );
}







/** 最近几次运行的走势：横轴次数，实线吞吐量，红点错误率（越大越红） */
function RunTrend({ runs }: { runs: JmxRun[] }) {
  const list = runs.slice(-12);
  const w = 320;
  const h = 86;
  const pad = 8;
  const maxTps = Math.max(1, ...list.map(r => r.tps || 0));
  const stepX = list.length > 1 ? (w - pad * 2) / (list.length - 1) : 0;
  const pts = list.map((r, i) => {
    const x = list.length > 1 ? pad + i * stepX : w / 2;
    const y = h - pad - ((r.tps || 0) / maxTps) * (h - pad * 2);
    return { x, y, r };
  });
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const last = list[list.length - 1];
  const badRuns = list.filter(r => r.errorPct > 0).length;
  return (
    <div className="jmxlib-trend">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" height={h} role="img" aria-label="最近运行趋势">
        <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} className="jmxlib-trend-axis" />
        <path d={line} className="jmxlib-trend-line" />
        {pts.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r="2.6" className="jmxlib-trend-dot" />
            {p.r.errorPct > 0 && (
              <circle
                cx={p.x}
                cy={h - pad - 2}
                r={Math.min(6, 2 + p.r.errorPct / 10)}
                className="jmxlib-trend-err"
              />
            )}
          </g>
        ))}
      </svg>
      <div className="jmxlib-trend-legend">
        <span>最新 {last ? `${last.tps} TPS` : '-'}</span>
        <span className={last && last.errorPct > 0 ? 'is-bad' : ''}>错误率 {last ? `${last.errorPct}%` : '-'}</span>
        <span className={badRuns ? 'is-bad' : ''}>{badRuns ? `${badRuns} 次有错误` : '全部无错误'}</span>
      </div>
    </div>
  );
}



