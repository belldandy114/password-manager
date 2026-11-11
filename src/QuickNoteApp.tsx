import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Note, WorkspaceKey } from './types';
import { attImageMarkdown } from './utils/attachRefs';
import { clipboardImageFiles, insertAtCaret, saveImageFiles } from './components/pasteImage';
import { applyAccent, applyDensity, applyTheme, watchSystemTheme } from './utils/theme';

/** 随手记的标题兜底：随手记 11-09 19:12 */
function stampTitle(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `随手记 ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 随手记小窗（全局键 Ctrl+Shift+N）。
 *
 * 目的：脑子里蹦出一句话时不用切页面 / 不用找笔记本——按一下键，写完 Ctrl+Enter，
 * 直接进「测试笔记」集合（和笔记页是同一份加密数据）。截图可以直接 Ctrl+V 粘贴，
 * 图片走 #5 的加密附件通道，正文只留一行 pm-att 引用。
 */
export function QuickNoteApp() {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  /** 每次由主进程叫出来：清掉上一次的「已保存」并聚焦输入 */
  useEffect(() => {
    // 窗口是透明无边框的：html 上挂个类，让 body 背景透明，只留卡片
    document.documentElement.classList.add('qn-window');
    const off = window.electronAPI.onQuickNoteFocus(() => {
      setHint('');
      setSaving(false);
      requestAnimationFrame(() => textRef.current?.focus());
    });
    textRef.current?.focus();
    return () => {
      off();
      document.documentElement.classList.remove('qn-window');
    };
  }, []);

  /**
   * 小窗是独立的 BrowserWindow（`?window=quicknote`），不经过 App.tsx 的主题初始化，
   * 所以这里必须自己读一次设置并应用主题 / 强调色 / 密度，否则浅色主题用户会
   * 看到一个深色小窗。
   */
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
      } catch {
        /* 读不到设置就按 CSS 默认主题 */
      }
    })();
    return () => { if (off) off(); };
  }, []);

  const hide = useCallback(() => { void window.electronAPI.quicknoteHide(); }, []);

  const save = useCallback(async () => {
    const body = text.trim();
    if (!body) { setHint('先写点内容再保存'); textRef.current?.focus(); return; }
    setSaving(true);
    setHint('');
    try {
      const finalTitle = title.trim() || stampTitle();

      /**
       * 笔记页有两种存储模式：软件内的加密库（ws:set 'notes'）和用户自选的目录（一篇一个 .md）。
       * 小窗必须跟着当前模式走——否则用户切到目录模式后，随手记还往加密库里写，
       * 笔记页只列目录里的文件，看起来就是「随手记保存的内容不见了」。
       */
      const dir = localStorage.getItem('pm.notes.dir') || '';
      if (dir) {
        const r = await window.electronAPI.notesSave(dir, '', body, finalTitle);
        if (!r?.success) { setHint('保存失败：' + (r?.error || '未知错误')); return; }
        setTitle('');
        setText('');
        setHint(`已保存到目录：${r.data?.name || finalTitle}`);
        setTimeout(() => { void window.electronAPI.quicknoteHide(); }, 600);
        return;
      }

      const key: WorkspaceKey = 'notes';
      const got = await window.electronAPI.wsGet(key);
      const list = got?.success && Array.isArray(got.data) ? (got.data as Note[]) : [];
      const note: Note = {
        id: crypto.randomUUID(),
        title: finalTitle,
        content: body,
        tags: ['随手记'],
        updatedAt: new Date().toISOString(),
      };
      const res = await window.electronAPI.wsSet(key, [note, ...list]);
      if (!res?.success) { setHint('保存失败：' + (res?.error || '未知错误')); return; }
      setTitle('');
      setText('');
      setHint('已保存到「测试笔记」');
      // 留半秒让人看见提示，再收起小窗
      setTimeout(() => { void window.electronAPI.quicknoteHide(); }, 600);
    } catch (e) {
      setHint('保存失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSaving(false);
    }
  }, [text, title]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); hide(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
  };

  /** 粘贴截图 → 加密附件（和笔记页同一套逻辑） */
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = clipboardImageFiles(e);
    if (!files.length) return;
    e.preventDefault();
    const el = e.currentTarget;
    setHint('正在加密保存截图…');
    const { saved, errors } = await saveImageFiles(files);
    if (!saved.length) { setHint(errors[0] || '截图保存失败'); return; }
    const md = saved.map(a => attImageMarkdown(a.id, a.name.replace(/\.\w+$/, ''))).join('\n');
    setText(insertAtCaret(el, `${md}\n`));
    setHint(errors.length ? `已保存 ${saved.length} 张，${errors.length} 张失败` : `已加密保存 ${saved.length} 张截图`);
  };

  return (
    <div className="qn-root" onKeyDown={onKeyDown}>
      <div className="qn-head">
        <span className="qn-dot" aria-hidden />
        <span className="qn-title">随手记</span>
        <span className="qn-tip">Ctrl+Enter 保存 · Esc 收起</span>
        <button className="qn-x" onClick={hide} title="收起（Esc）" aria-label="收起">×</button>
      </div>
      <input
        className="qn-input"
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); textRef.current?.focus(); } }}
        placeholder="标题（可留空，自动按时间命名）"
        maxLength={120} aria-label="标题" />
      <textarea
        ref={textRef}
        className="qn-text"
        value={text}
        onChange={e => setText(e.target.value)}
        onPaste={e => void onPaste(e)}
        placeholder={'想到什么写什么，支持 Markdown、支持 Ctrl+V 粘截图…'}
        spellCheck={false}
      />
      <div className="qn-foot">
        <span className={`qn-hint${hint.startsWith('保存失败') ? ' is-error' : ''}`}>{hint}</span>
        <span className="qn-count">{text.trim() ? `${text.trim().length} 字` : ''}</span>
        <button className="btn btn-ghost btn-sm" onClick={hide}>收起</button>
        <button className="btn btn-primary btn-sm" onClick={() => void save()} disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}