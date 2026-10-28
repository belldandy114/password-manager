import React, { useEffect, useState } from 'react';
import type { ZentaoBug, ZentaoBugDetail, ZentaoAttachment, ZentaoConfig } from '../types';
import { Icons, Pill } from './ui';
import { bugToText } from '../utils/bugText';

/**
 * Bug 详情抽屉：点列表行直接在这里看重现步骤，不用来回切浏览器。
 * 列表里已有的字段直接用，缺的（重现步骤/附件）走 zentao:bug-detail 现拉。
 */
export function BugDrawer({
  bug, cfg, onClose,
}: {
  bug: ZentaoBug | null;
  cfg: ZentaoConfig | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ZentaoBugDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  // 点缩略图放大查看
  const [preview, setPreview] = useState<string>('');
  // 附件下载状态（同一时刻只处理一个，避免并下发一堆请求）
  const [busyFile, setBusyFile] = useState('');
  const [fileTip, setFileTip] = useState('');

  useEffect(() => {
    if (!bug || !cfg) { setDetail(null); return; }
    let alive = true;
    setLoading(true);
    setError('');
    setDetail(null);
    setPreview('');
    (async () => {
      const res = await window.electronAPI.zentaoBugDetail(cfg, bug.id);
      if (!alive) return;
      setLoading(false);
      if (res.success && res.data) setDetail(res.data);
      else setError(res.error || '读取详情失败');
    })();
    return () => { alive = false; };
  }, [bug, cfg]);

  // Esc：先关大图，再关抽屉
  useEffect(() => {
    if (!bug) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (preview) { setPreview(''); return; }
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [bug, preview, onClose]);

  if (!bug) return null;

  const base = cfg?.baseUrl || '';
  const openBrowser = () => {
    window.electronAPI.browserOpen({ browser: 'default', url: `${base.replace(/\/+$/, '')}/bug-view-${bug.id}.html` });
  };
  const copy = async () => {
    await navigator.clipboard.writeText(bugToText(bug, base));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  /** 取附件：主进程带登录态下载；open=直接打开，save=另存为 */
  const getAttachment = async (a: ZentaoAttachment, mode: 'open' | 'save') => {
    if (!cfg) return;
    setBusyFile(a.url);
    setFileTip('');
    const res = await window.electronAPI.zentaoAttachment(cfg, a.url, a.name, mode);
    setBusyFile('');
    if (res.canceled) return;
    if (res.success) {
      setFileTip(mode === 'save' ? `已保存：${res.data?.path}` : `已打开：${res.data?.name}`);
    } else {
      setFileTip(res.error || '附件下载失败');
    }
  };

  return (
    <>
      <div className="drawer-mask" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer-head">
          <div className="drawer-title">
            <span className="cell-mono">#{bug.id}</span>
            <span className="drawer-title-text" title={bug.title}>{bug.title}</span>
          </div>
          <button className="ibtn" onClick={onClose} title="关闭" aria-label="关闭">
            <Icons.close size={14} />
          </button>
        </header>

        <div className="drawer-body">
          <div className="drawer-meta">
            <Pill tone={bug.status === 'active' ? 'bad' : bug.status === 'resolved' ? 'ok' : 'mute'} dot>
              {{ active: '激活', resolved: '已解决', closed: '已关闭', postponed: '已延期' }[String(bug.status)] || bug.status || '—'}
            </Pill>
            {bug.severity && (
              <Pill tone={String(bug.severity) === '1' ? 'bad' : String(bug.severity) === '2' ? 'warn' : 'mute'}>
                {{ '1': '致命', '2': '严重', '3': '一般', '4': '轻微' }[String(bug.severity)] || `严重度 ${bug.severity}`}
              </Pill>
            )}
            {bug.resolution === 'fixed' && <Pill tone="ok">已修复</Pill>}
          </div>

          <dl className="drawer-kv">
            <div><dt>项目</dt><dd>{bug.productName || '—'}</dd></div>
            <div><dt>指派给</dt><dd>{bug.assignedTo || '—'}</dd></div>
            <div><dt>创建者</dt><dd>{bug.openedBy || '—'}</dd></div>
            <div><dt>创建日期</dt><dd>{bug.date || '—'}</dd></div>
            <div><dt>截止日期</dt><dd>{bug.deadline || '—'}</dd></div>
            <div><dt>优先级</dt><dd>{bug.pri || '—'}</dd></div>
          </dl>

          <div className="drawer-section">
            <h5>重现步骤</h5>
            {loading && <div className="drawer-hint">读取中…</div>}
            {!loading && error && <div className="drawer-hint is-bad">{error}</div>}
            {!loading && !error && detail && (
              <>
                <pre className="drawer-steps">{detail.steps}</pre>

                {!!detail.images?.length && (
                  <div className="drawer-shots">
                    <div className="drawer-shots-head">
                      <span>截图 {detail.images.length} 张</span>
                      <span className="drawer-hint-inline">点图片放大</span>
                    </div>
                    <div className="shot-grid">
                      {detail.images.map((img, i) => (
                        <button
                          key={img.src || i}
                          className="shot-thumb"
                          onClick={() => setPreview(img.dataUrl)}
                          title={`查看大图（图${i + 1}）`}
                        >
                          <img src={img.dataUrl} alt={`图${i + 1}`} loading="lazy" />
                          <span className="shot-idx">{i + 1}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {(detail.imageFailed || 0) > 0 && (
                  <div className="drawer-hint-inline" style={{ marginTop: 8 }}>
                    有 {detail.imageFailed} 张图片没取到（可能被权限限制或体积过大），可在浏览器中查看原图。
                  </div>
                )}

                {detail.attachments.length > 0 && (
                  <div className="drawer-files">
                    <span>附件：</span>
                    {detail.attachments.map(a => (
                      <span key={a.url} className="drawer-file">
                        <span className="chip">{a.name}</span>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busyFile === a.url}
                          title="带登录态取回，用系统默认程序打开"
                          onClick={() => getAttachment(a, 'open')}
                        >
                          {busyFile === a.url ? '取回中…' : '打开'}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busyFile === a.url}
                          title="另存到指定位置"
                          onClick={() => getAttachment(a, 'save')}
                        >
                          另存
                        </button>
                      </span>
                    ))}
                    {fileTip && <span className="drawer-hint-inline">{fileTip}</span>}
                  </div>
                )}
              </>
            )}
          </div>
          {!!detail?.history?.length && (
            <div className="drawer-section">
              <h5>流转记录（{detail.history.length}）</h5>
              <div className="hist-list">
                {detail.history.map((h, i) => (
                  <div className="hist-row" key={`${h.time}-${i}`}>
                    <div className="hist-head">
                      <span className={`hist-tag is-${h.action || 'other'}`}>{h.label}</span>
                      {h.who && <span className="hist-who">{h.who}</span>}
                      {h.time && <span className="hist-time">{h.time}</span>}
                    </div>
                    {h.text && <div className="hist-text">{h.text}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <footer className="drawer-foot">
          <button className="btn btn-secondary btn-sm" onClick={copy}>{copied ? '已复制' : '复制汇报文本'}</button>
          <button className="btn btn-primary btn-sm" onClick={openBrowser}>
            <Icons.extern size={12} /> 浏览器打开
          </button>
        </footer>
      </aside>

      {preview && (
        <div className="shot-viewer" onClick={() => setPreview('')}>
          <img src={preview} alt="大图" onClick={e => e.stopPropagation()} />
          <button className="shot-viewer-close" onClick={() => setPreview('')} title="关闭">×</button>
        </div>
      )}
    </>
  );
}
