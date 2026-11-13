import React, { useCallback, useEffect, useState } from 'react';
import type { Note, PasswordEntry } from './types';
import { applyAccent, applyDensity, applyTheme, watchSystemTheme } from './utils/theme';
import { openUrlInDefaultBrowser } from './utils/openUrl';
import { MarkdownView } from './components/MarkdownView';

const ENV_LABEL: Record<string, string> = { production: '正式', testing: '测试', development: '开发', staging: '预发布' };

/**
 * 「钉」小窗（`?window=pin&kind=entry|note&id=xxx`）。
 *
 * 一条记录一个置顶窗口：测试时主窗口缩在后面，小窗一直浮着。
 * - `kind=entry`（默认）：显示网址/账号/密码，边看边操作；
 * - `kind=note`：显示一条测试笔记的正文，照着步骤做，不用来回切窗口。
 *
 * 为什么不新建 IPC 取单条：`entries:get-all` / `ws:get` 已经有了，按 id 找一次就够；
 * 内容不进 URL 参数（URL 会进窗口标题和日志），只传 id。
 */
export function PinApp() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id') || '';
  const kind = params.get('kind') === 'note' ? 'note' : 'entry';

  const [entry, setEntry] = useState<PasswordEntry | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [error, setError] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [hint, setHint] = useState('');

  const load = useCallback(async () => {
    if (!id) { setError('这个小窗没有指定内容'); return; }
    try {
      if (kind === 'note') {
        // 目录模式：笔记是磁盘上的 .md，不在加密库；id 用 `dir::文件名` 区分
        if (id.startsWith('dir::')) {
          const name = id.slice(5);
          const dir = localStorage.getItem('pm.notes.dir') || '';
          if (!dir) { setError('笔记目录未设置，请在笔记页重新选一次目录'); setNote(null); return; }
          const fr = await window.electronAPI.notesRead(dir, name);
          if (!fr.success || !fr.data) { setError(fr.error || '读取笔记失败'); setNote(null); return; }
          setError('');
          setNote({
            id,
            title: name.replace(/\.md$/i, ''),
            content: fr.data.content || '',
            tags: [],
            updatedAt: '',
          } as Note);
          return;
        }
        const r = await window.electronAPI.wsGet('notes');
        if (!r.success) { setError('密码库未解锁'); return; }
        const list = (r.data as Note[]) || [];
        const hit = list.find((n) => n.id === id);
        if (!hit) { setError('笔记已不存在'); setNote(null); return; }
        setError('');
        setNote(hit);
        return;
      }
      const r = await window.electronAPI.entriesGetAll();
      if (!r.success || !r.data) { setError('密码库未解锁'); return; }
      const hit = (r.data.entries || []).find((e) => e.id === id);
      if (!hit) { setError('条目已不存在'); setEntry(null); return; }
      setError('');
      setEntry(hit);
    } catch {
      setError('读取失败');
    }
  }, [id, kind]);

  useEffect(() => {
    document.documentElement.classList.add('pin-window');
    if (kind === 'note') document.documentElement.classList.add('pin-window-note');
    void load();
    // 主窗口改了这条之后，小窗切回来就能看到新值
    const onFocus = () => { void load(); setHint(''); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.documentElement.classList.remove('pin-window');
      document.documentElement.classList.remove('pin-window-note');
    };
  }, [load, kind]);

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

  const title = kind === 'note' ? (note?.title || '未命名笔记') : (entry?.name || '未命名');

  return (
    <div className={`pin-card${kind === 'note' ? ' pin-card-note' : ''}`}>
      <div className="pin-head">
        <span className="pin-title" title={title}>{title}</span>
        <div className="pin-head-actions">
          <button type="button" className="pin-icon" onClick={() => void load()} title="刷新">↻</button>
          <button type="button" className="pin-icon pin-close" onClick={close} title="关闭" aria-label="关闭小窗">×</button>
        </div>
      </div>

      {error ? (
        <div className="pin-empty">{error}</div>
      ) : kind === 'note' ? (
        !note ? (
          <div className="pin-empty">读取中…</div>
        ) : (
          <div className="pin-note-body">
            <MarkdownView md={note.content || ''} className="pin-md" />
            {!note.content?.trim() && <div className="pin-empty">（空笔记）</div>}
          </div>
        )
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

      <div className="pin-foot">
        {hint || (kind === 'note'
          ? <button type="button" className="pin-foot-btn" onClick={() => void copy(note?.content || '', '正文')}>复制正文</button>
          : '拖标题栏移动 · 拖右下角改大小')}
      </div>

      {/* 无边框透明窗口拖边缘的命中区太窄，放一个显式手柄 */}
      <div
        className="pin-grip"
        role="separator"
        aria-label="拖动调整小窗大小"
        title="拖动调整大小"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.screenX;
          const startY = e.screenY;
          const startW = window.innerWidth;
          const startH = window.innerHeight;
          const onMove = (ev: MouseEvent) => {
            void window.electronAPI.pinResize({
              w: startW + (ev.screenX - startX),
              h: startH + (ev.screenY - startY),
            });
          };
          const onUp = () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
          };
          window.addEventListener('mousemove', onMove);
          window.addEventListener('mouseup', onUp);
        }}
      />
    </div>
  );
}
