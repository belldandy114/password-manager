import React, { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { createOverlayToken, isTopOverlay, pushOverlay, removeOverlay } from './overlayStack';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  closeOnOverlay?: boolean;
  /** 没有可见标题时给读屏用的名字（有 title 时忽略） */
  ariaLabel?: string;
}

/** 可聚焦元素。`:not([disabled])` 之外还要排掉 `tabindex="-1"` 与隐藏元素。 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 同一时刻只允许最上层那个弹窗响应 Esc / Tab。
 *
 * 以前每个 Modal 各自往 document 上挂 keydown，嵌套时（比如「删除标签」确认框盖在
 * 「标签管理」上）按一次 Esc 会把两个一起关掉。打开顺序记在 overlayStack 里。
 */
function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('disabled')) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    // offsetParent 为 null 通常是 display:none；position:fixed 的元素 offsetParent 也是 null，
    // 所以再用 getClientRects 兜一次。
    return el.offsetParent !== null || el.getClientRects().length > 0;
  });
}

export function Modal({ open, onClose, title, children, footer, className, closeOnOverlay = true, ariaLabel }: Props) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const stackId = useRef<symbol>(Symbol('modal'));
  const titleId = useId();
  /**
   * onClose 几乎都是内联箭头（`() => setEditing(null)`），每次父组件渲染都是新引用。
   * 直接放进 effect 依赖会让「每敲一个字 → effect 重建 → 焦点被拉回第一个可聚焦元素」，
   * 表现为编辑笔记时输入一个字符就失焦、像被弹出编辑框。放进 ref 后 effect 只随 open 跑一次。
   */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Esc 与「关闭后焦点归还」：焦点不还回去会落到 body 上，键盘用户直接失去位置。
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!isTopOverlay(stackId.current)) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab') return;

    const nodes = focusablesIn(dialogRef.current);
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (nodes.length === 0) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    const active = document.activeElement as HTMLElement | null;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    // 焦点跑出弹窗（点了背后、或程序化移动）时，Tab 先把它拉回弹窗内。
    if (!active || !dialog.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    pushOverlay(stackId.current);
    restoreRef.current = (document.activeElement as HTMLElement) || null;

    // 等一帧再聚焦：弹窗内容可能还在挂载（比如刚 setState 出来的表单）
    const raf = requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      // 表单弹窗优先聚焦第一个输入框（编辑笔记时光标直接落在标题），
      // 没有输入框才退回第一个可聚焦元素（确认框的按钮）。
      const preferred = root.querySelector<HTMLElement>('[data-autofocus="1"]')
        || root.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])');
      if (preferred) preferred.focus();
      else {
        const nodes = focusablesIn(root);
        if (nodes.length > 0) nodes[0].focus();
        else root.focus();
      }
    });

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', handleKeyDown, true);
      removeOverlay(stackId.current);
      const back = restoreRef.current;
      if (back && document.contains(back)) {
        try { back.focus(); } catch { /* 元素可能已经卸载 */ }
      }
    };
  }, [open, handleKeyDown]);

  if (!open) return null;

  // 挂到 body 再渲染：页面容器一旦有 transform（进入动画、hover 位移、filter 等），
  // position:fixed 会以那个容器为基准，弹窗就会跑到页面底部而不是视口中间（1.27.0 修）。
  return createPortal(
    <div
      className="modal-overlay"
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current && closeOnOverlay) onClose(); }}
    >
      <div
        className={`modal ${className || ''}`}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        {title && (
          <div className="modal-header">
            <span id={titleId}>{title}</span>
            <button className="close-btn" onClick={onClose} aria-label="关闭">&times;</button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

