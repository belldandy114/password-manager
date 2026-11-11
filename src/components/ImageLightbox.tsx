import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createOverlayToken, isTopOverlay, pushOverlay, removeOverlay } from './overlayStack';

/**
 * 图片灯箱：只显示照片本身（背景透明，不套白卡片），支持放大 / 缩小 / 拖动。
 *
 * 为什么不用 window.open：Electron 里新开窗口会带一整套浏览器外壳（标题栏、菜单），
 * 而且 dataURL 写进新窗口后无法再交互缩放。这里用 portal 盖在当前页面上，
 * 背景半透明，图片保持原样（PNG 的透明区域直接透出背景）。
 *
 * 交互：滚轮缩放、双击复位、按住拖动平移、Esc 关闭、+/- 缩放、0 复位。
 */
export function ImageLightbox({
  src, alt, onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const stackId = useRef<symbol>(createOverlayToken());
  const restoreRef = useRef<HTMLElement | null>(null);

  // 入栈：灯箱从弹窗里点开时它才是「最上层」，Esc 只关它、不关下面的弹窗
  useEffect(() => {
    pushOverlay(stackId.current);
    restoreRef.current = (document.activeElement as HTMLElement) || null;
    const raf = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      removeOverlay(stackId.current);
      const back = restoreRef.current;
      if (back && document.contains(back)) {
        try { back.focus(); } catch { /* 原元素可能已卸载 */ }
      }
    };
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((delta: number) => {
    setScale((s) => {
      const next = Math.min(8, Math.max(0.2, Math.round((s + delta) * 100) / 100));
      if (next <= 1) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  // 键盘：Esc 关闭、+/- 缩放、0 复位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isTopOverlay(stackId.current)) return;
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(0.25); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(-0.25); return; }
      if (e.key === '0') { e.preventDefault(); reset(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, zoomBy, reset]);

  // 滚轮缩放：必须用非 passive 监听才能 preventDefault（否则整页跟着滚）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 0.15 : -0.15);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale <= 1) return;
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };

  const onPointerUp = () => { dragRef.current = null; };

  return createPortal(
    <div
      className="img-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={alt || '图片预览'}
      onClick={onClose}
      tabIndex={-1}
    >
      <div className="img-lightbox-bar" onClick={(e) => e.stopPropagation()}>
        <span className="img-lightbox-title" title={alt}>{alt || '图片'}</span>
        <span className="img-lightbox-scale">{Math.round(scale * 100)}%</span>
        <button type="button" className="img-lightbox-btn" onClick={() => zoomBy(-0.25)} title="缩小（-）">−</button>
        <button type="button" className="img-lightbox-btn" onClick={() => zoomBy(0.25)} title="放大（+）">+</button>
        <button type="button" className="img-lightbox-btn" onClick={reset} title="原始大小（0）">1:1</button>
        <button type="button" className="img-lightbox-btn is-close" ref={closeBtnRef} onClick={onClose} title="关闭（Esc）" aria-label="关闭预览">×</button>
      </div>

      <div
        ref={stageRef}
        className={`img-lightbox-stage${scale > 1 ? ' is-zoomed' : ''}`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}
      >
        <img
          className="img-lightbox-img"
          src={src}
          alt={alt || '图片'}
          draggable={false}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>

      <div className="img-lightbox-hint">滚轮缩放 · 双击复位 · Esc 关闭</div>
    </div>,
    document.body,
  );
}
