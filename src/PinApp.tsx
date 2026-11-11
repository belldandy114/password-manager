import React, { useCallback, useEffect, useState } from 'react';
import type { PasswordEntry } from './types';
import { applyAccent, applyDensity, applyTheme, watchSystemTheme } from './utils/theme';
import { openUrlInDefaultBrowser } from './utils/openUrl';

const ENV_LABEL: Record<string, string> = { production: '正式', testing: '测试', development: '开发', staging: '预发布' };

/**
 * 「钉」小窗（`?window=pin&id=xxx`）。
 *
 * 一条记录一个置顶窗口：测试时主窗口缩在后面，小窗一直浮着显示网址/账号/密码。
 *
 * 为什么不新建 IPC 取单条：`entries:get-all` 已经有了，按 id 找一次就够；
 * 条目内容不进 URL 参数（URL 会进窗口标题和日志），只传 id。
 */
export function PinApp() {
  const [entry, setEntry] = useState<PasswordEntry | null>(null);
  const [error, setError] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [hint, setHint] = useState('');

  const id = new URLSearchParams(window.location.search).get('id') || '';

  const load = useCallback(async () => {
    if (!id) { setError('这个小窗没有指定条目'); return; }
    try {
      const r = await window.electronAPI.entriesGetAll();
      if (!r.success || !r.data) { setError('密码库未解锁'); return; }
      const hit = (r.data.entries || []).find((e) => e.id === id);
      if (!hit) { setError('条目已不存在'); setEntry(null); return; }
      setError('');
      setEntry(hit);
    } catch {
      setError('读取失败');
    }
  }, [id]);

  useEffect(() => {
    document.documentElement.classList.add('pin-window');
    void load();
    // 主窗口改了这条之后，小窗切回来就能看到新值
    const onFocus = () => { void load(); setHint(''); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.documentElement.classList.remove('pin-window');
    };
  }, [load]);

  // 小窗是独立 BrowserWindow，不走 App.tsx 的主题初始化，这里自己读一次
  useEffect(() => {
    let off: (() => void) | undefined;
    (async () => {
      try {
        const prefs = await window.electronAPI.settingsGet();
        if (!prefs) return;
        applyTheme(prefs.theme);
        applyAccent(prefs.accent);
        applyDensity(prefs.density);
        if (prefs.theme === 'system') off = watchSystemTheme(() => applyTheme('system'));
      } catch { /* 按 CSS 默认主题 */ }
    })();
    return () => { if (off) off(); };
  }, []);

  const flash = (msg: string) => {
    setHint(msg);
    window.setTimeout(() => setHint(''), 1600);
  };

  const copy = async (text: string, label: string) => {
    if (!text) { flash(`没有${label}`); return; }
    // 小窗复制一律给自动清除留时间：这窗口是浮在桌面上的
    await window.electronAPI.clipboardCopy({ text, delay: 20000 });
    flash(`${label}已复制，20 秒后自动清空`);
  };

  const close = () => { void window.electronAPI.pinClose(); };

  return (
    <div className="pin-card">
      <div className="pin-head">
        <span className="pin-title" title={entry?.name || ''}>{entry?.name || '未命名'}</span>
        <div className="pin-head-actions">
          <button type="button" className="pin-icon" onClick={() => void load()} title="刷新">↻</button>
          <button type="button" className="pin-icon pin-close" onClick={close} title="关闭" aria-label="关闭小窗">×</button>
        </div>
      </div>

      {error ? (
        <div className="pin-empty">{error}</div>
      ) : !entry ? (
        <div className="pin-empty">读取中…</div>
      ) : (
        <div className="pin-body">
          <div className="pin-row">
            <span className="pin-label">环境</span>
            <span className={`pin-env env-${entry.envType}`}>{ENV_LABEL[entry.envType] || entry.envType}</span>
            {entry.tags && entry.tags.length > 0 && (
              <span className="pin-tags">{entry.tags.slice(0, 3).join(' · ')}</span>
            )}
          </div>

          <div className="pin-row">
            <span className="pin-label">网址</span>
            <button
              type="button"
              className="pin-value pin-link"
              title={entry.url || ''}
              onClick={() => { void openUrlInDefaultBrowser(entry.url || ''); }}
            >
              {entry.url || '—'}
            </button>
            <button type="button" className="pin-copy" onClick={() => void copy(entry.url || '', '网址')} title="复制网址">复制</button>
          </div>

          <div className="pin-row">
            <span className="pin-label">账号</span>
            <span className="pin-value" title={entry.username || ''}>{entry.username || '—'}</span>
            <button type="button" className="pin-copy" onClick={() => void copy(entry.username || '', '账号')} title="复制账号">复制</button>
          </div>

          <div className="pin-row">
            <span className="pin-label">密码</span>
            <span className="pin-value pin-pw">
              {entry.password ? (showPw ? entry.password : '•'.repeat(Math.min(entry.password.length, 20))) : '—'}
            </span>
            <button type="button" className="pin-copy" onClick={() => setShowPw((v) => !v)} title={showPw ? '隐藏密码' : '显示密码'}>
              {showPw ? '隐藏' : '显示'}
            </button>
            <button type="button" className="pin-copy" onClick={() => void copy(entry.password || '', '密码')} title="复制密码">复制</button>
          </div>

          {entry.notes && (
            <div className="pin-note" title={entry.notes}>{entry.notes}</div>
          )}
        </div>
      )}

      <div className="pin-foot">{hint || '拖动标题栏移动 · 关掉主窗口不会关掉它'}</div>
    </div>
  );
}
