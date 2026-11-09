import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './ui';
import { renderMarkdown } from '../utils/markdown';

/** 更新信息（启动推送 / 手动检查 / 发布页三处的并集） */
export interface UpdateInfoLike {
  current: string;
  latest: string;
  url?: string;
  notes?: string;
  downloadUrl?: string;
  assetName?: string;
  digest?: string;
}

type Phase = 'idle' | 'downloading' | 'ready' | 'error';

/** 下载完成后自动安装的倒计时（秒）。点「暂不安装」或关掉弹窗就会取消。 */
const AUTO_INSTALL_SEC = 5;

function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtEta(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `${Math.ceil(sec)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m} 分 ${s} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

/**
 * 更新弹窗：点「去更新」直接在这里看更新内容 → 自动下载 → 自动启动安装。
 *
 * 以前要「去设置 → 通用 → 检查更新 → 下载 → 安装」五步，现在是两步：
 * 点「去更新」打开本弹窗，下载完成后倒计时自动安装（可点「暂不安装」取消）。
 * 关闭弹窗会中止自动安装——避免用户已经离开时应用突然退出。
 */
export function UpdateDialog({
  open,
  info,
  onClose,
}: {
  open: boolean;
  info: UpdateInfoLike | null;
  onClose: () => void;
}) {
  /** 从 update:check 补全的详细信息（启动推送可能只有版本号与链接） */
  const [detail, setDetail] = useState<UpdateInfoLike | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ received: 0, total: 0, speed: 0, threads: 1, link: '' });
  const [error, setError] = useState('');
  const [canMirror, setCanMirror] = useState(false);
  const [viaMirror, setViaMirror] = useState(false);
  const [verified, setVerified] = useState(false);
  const [file, setFile] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [autoInstall, setAutoInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  /** 更新说明没滚到底时给底部渐隐，提示「下面还有」 */
  const [notesMore, setNotesMore] = useState(false);
  const notesRef = useRef<HTMLDivElement>(null);
  const startedRef = useRef(false);
  const busyRef = useRef(false);

  const shown = useMemo<UpdateInfoLike | null>(() => {
    if (!info && !detail) return null;
    return { ...(info || { current: '', latest: '' }), ...(detail || {}) } as UpdateInfoLike;
  }, [info, detail]);

  const hasDownload = !!shown?.downloadUrl;

  /* 下载进度：常驻订阅，关掉弹窗再打开也不会丢进度 */
  useEffect(() => {
    const off = window.electronAPI?.onUpdateProgress?.((p) => setProgress({
      received: p.received || 0,
      total: p.total || 0,
      speed: p.speed || 0,
      threads: p.threads || 1,
      link: p.link || '',
    }));
    return () => { try { off?.(); } catch { /* 忽略 */ } };
  }, []);

  /* 打开时：信息不全（缺更新说明 / 安装包直链）就补一次 update:check */
  useEffect(() => {
    if (!open || !info) return;
    let alive = true;
    if (!info.notes || !info.downloadUrl) {
      window.electronAPI?.updateCheck?.()
        .then((r) => { if (alive && r?.success && r.data) setDetail(r.data as UpdateInfoLike); })
        .catch(() => { /* 离线就用手上的信息 */ });
    }
    return () => { alive = false; };
  }, [open, info]);

  /* 只在「版本号变了」时重置状态：
     重新打开同一个版本的弹窗要保留已下载/下载中的进度，否则会白下一遍。 */
  const initVersionRef = useRef('');
  useEffect(() => {
    if (!open) return;
    const v = shown?.latest || '';
    if (initVersionRef.current === v) return;
    initVersionRef.current = v;
    startedRef.current = false;
    setPhase('idle');
    setError('');
    setProgress({ received: 0, total: 0, speed: 0, threads: 1, link: '' });
    setCountdown(0);
    setAutoInstall(false);
    setFile('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, shown?.latest]);

  const startDownload = useCallback(async (mirror = false) => {
    if (busyRef.current) return;
    const url = shown?.downloadUrl;
    if (!url) {
      setError('这个版本没有可用的安装包，请点「发布页」手动下载');
      setPhase('error');
      return;
    }
    busyRef.current = true;
    setPhase('downloading');
    setError('');
    setVerified(false);
    setProgress({ received: 0, total: 0, speed: 0, threads: 1, link: '' });
    try {
      const res = await window.electronAPI.updateDownload(url, mirror, {
        expectedSha256: shown?.digest || '',
        threads: mirror, // 加速重试 = 直接 6 分片并行
      });
      if (res?.success && res.data) {
        setFile(res.data.file);
        setViaMirror(!!mirror);
        setVerified(!!res.data.verified);
        setPhase('ready');
        setCountdown(AUTO_INSTALL_SEC);
        setAutoInstall(true);
      } else {
        setError(res?.error || '下载失败');
        setCanMirror(!!res?.canMirror);
        setPhase('error');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '下载失败');
      setPhase('error');
    } finally {
      busyRef.current = false;
    }
  }, [shown]);

  /* 打开后自动开始下载：这就是「点去更新 → 直接下载并安装」的一步到位 */
  useEffect(() => {
    if (!open || !hasDownload) return;
    if (phase !== 'idle' || startedRef.current) return;
    startedRef.current = true;
    void startDownload(false);
  }, [open, hasDownload, phase, startDownload]);

  const install = useCallback(async () => {
    if (!file || installing) return;
    setInstalling(true);
    const res = await window.electronAPI.updateInstall(file);
    if (!res?.success) {
      setInstalling(false);
      setAutoInstall(false);
      setError(res?.error || '启动安装失败');
      setPhase('error');
    }
    // 成功时主进程会在 1.2 秒后退出应用，这里不用再改状态
  }, [file, installing]);

  /* 倒计时：只在弹窗打开且没有取消时推进，到 0 自动安装 */
  useEffect(() => {
    if (phase !== 'ready' || !autoInstall || !open) return;
    if (countdown <= 0) { void install(); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [phase, autoInstall, open, countdown, install]);

  /* 关掉弹窗 = 放弃自动安装（下载仍会在后台完成，重开可继续） */
  useEffect(() => {
    if (!open) setAutoInstall(false);
  }, [open]);

  const pickLocal = async () => {
    const res = await window.electronAPI.updatePickFile();
    if (res?.canceled) return;
    if (res?.success && res.data) {
      setFile(res.data.file);
      setError('');
      setPhase('ready');
      setCountdown(0);
      setAutoInstall(false);
    } else {
      setError(res?.error || '选择文件失败');
      setPhase('error');
    }
  };

  const openRelease = () => {
    if (shown?.url) window.electronAPI.browserOpen({ browser: 'default', url: shown.url });
  };

  /** 内容是否还有未滚到的部分（换内容/改尺寸都要重算，否则渐隐会一直挂着） */
  const syncNotesMore = useCallback(() => {
    const el = notesRef.current;
    if (!el) { setNotesMore(false); return; }
    setNotesMore(el.scrollHeight - el.scrollTop - el.clientHeight > 4);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(syncNotesMore, 0);
    return () => clearTimeout(t);
  }, [open, shown?.notes, syncNotesMore]);

  const percent = progress.total > 0
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : 0;

  const primary = (() => {
    if (phase === 'downloading') {
      return (
        <button className="btn btn-primary btn-sm" disabled>
          <Icons.download size={13} /> {progress.total ? `下载中 ${percent}%` : `已下载 ${(progress.received / 1024 / 1024).toFixed(1)} MB`}
        </button>
      );
    }
    if (phase === 'ready') {
      return (
        <button className="btn btn-primary btn-sm" onClick={() => void install()} disabled={installing}>
          <Icons.check size={13} /> {installing ? '正在启动安装…' : `安装并重启${autoInstall && countdown > 0 ? `（${countdown}s）` : ''}`}
        </button>
      );
    }
    if (phase === 'error') {
      return (
        <button className="btn btn-primary btn-sm" onClick={() => void startDownload(canMirror)}>
          <Icons.refresh size={13} /> {canMirror ? '加速重试' : '重试'}
        </button>
      );
    }
    if (!hasDownload) {
      return (
        <button className="btn btn-primary btn-sm" onClick={openRelease}>
          <Icons.extern size={13} /> 打开发布页
        </button>
      );
    }
    return (
      <button className="btn btn-primary btn-sm" onClick={() => void startDownload(false)}>
        <Icons.download size={13} /> 下载并安装
      </button>
    );
  })();

  return (
    <Modal
      open={open && !!shown}
      onClose={onClose}
      title={`发现新版本 v${shown?.latest || ''}`}
      className="update-dlg"
      footer={(
        <div className="update-dlg-foot">
          <span className="update-dlg-foot-hint">
            {phase === 'ready'
              ? (autoInstall ? '安装程序启动后应用会自动退出，请先保存正在编辑的内容' : '已下载完成，点「安装并重启」开始更新')
              : phase === 'downloading'
                ? '正在后台下载，可以继续用其它功能'
                : '更新不会影响已保存的账号数据'}
          </span>
          <div className="update-dlg-foot-btns">
            {phase === 'ready' && autoInstall && countdown > 0 && (
              <button className="btn btn-ghost btn-sm" onClick={() => { setAutoInstall(false); setCountdown(0); }}>
                暂不安装
              </button>
            )}
            <button className="btn btn-secondary btn-sm" onClick={onClose}>关闭</button>
            {primary}
          </div>
        </div>
      )}
    >
      <div className="update-dlg-vers">
        <span className="update-dlg-ver">当前 v{shown?.current || '—'}</span>
        <span className="update-dlg-arrow">→</span>
        <span className="update-dlg-ver is-new">最新 v{shown?.latest || '—'}</span>
        {shown?.assetName && <span className="update-dlg-asset">{shown.assetName}</span>}
      </div>

      <div className="update-dlg-section-title">更新内容</div>
      <div
        className={`update-dlg-notes${notesMore ? ' is-more' : ''}`}
        ref={notesRef}
        onScroll={syncNotesMore}
      >
        {shown?.notes
          ? renderMarkdown(shown.notes)
          : <div className="update-dlg-empty">这个版本没有提供更新说明，点下方「发布页」可查看详情。</div>}
      </div>

      {phase === 'downloading' && (progress.received > 0 || progress.total > 0) && (
        <div className="update-dlg-progress">
          <div className="dl-bar">
            <div
              className="dl-bar-fill"
              style={{ width: progress.total ? `${percent}%` : '20%' }}
            />
          </div>
          <div className="dl-meta">
            <span>{fmtBytes(progress.received)}{progress.total ? ` / ${fmtBytes(progress.total)}` : ''}</span>
            {progress.speed > 0 && <span>{fmtBytes(progress.speed)}/s</span>}
            {progress.total > progress.received && progress.speed > 0 && (
              <span>剩余 {fmtEta((progress.total - progress.received) / progress.speed)}</span>
            )}
            <span className="dl-meta-dim" title="走代理还是直连由系统代理设置决定；直连很慢时检查 VPN 分流规则是否放行 github.com 与 *.githubusercontent.com">
              {progress.link ? (progress.link === '直连' ? '直连 · 检查 VPN 分流' : progress.link) : '链路检测中…'}
            </span>
            {phase === 'downloading' && progress.speed > 0 && progress.speed < 150 * 1024 && !viaMirror && (
              <button className="btn btn-sm btn-ghost" onClick={() => void startDownload(true)} title="改用 6 分片并行下载">
                太慢？多线程加速
              </button>
            )}
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div className="update-dlg-done">
          <Icons.check size={13} />
          已下载 {file.split('\\').pop()}
          {viaMirror ? '（多线程加速）' : ''}
          {verified ? ' · SHA-256 已校验' : ''}
        </div>
      )}

      {phase === 'error' && (
        <div className="update-dlg-error">
          <div>{error}</div>
          <div className="update-dlg-error-actions">
            {shown?.url && (
              <button className="btn btn-sm btn-secondary" onClick={openRelease}>浏览器下载</button>
            )}
            <button className="btn btn-sm btn-secondary" onClick={() => void pickLocal()}>选择本地安装包</button>
          </div>
        </div>
      )}

      {shown?.url && (
        <button className="update-dlg-link" onClick={openRelease}>
          <Icons.extern size={12} /> 在浏览器查看完整发布说明
        </button>
      )}
    </Modal>
  );
}
