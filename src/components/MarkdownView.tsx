import React, { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../utils/markdown';
import { ImageLightbox } from './ImageLightbox';

/** 单张加密图片：挂载后解密成 dataURL。列表缩略图与正文图片共用。 */
export function AttImage({
  id, alt, className, onBroken,
}: {
  id: string;
  alt?: string;
  className?: string;
  /** 读取失败时回传原因：missing=文件没了，not-image=不是图片（证书/密钥等） */
  onBroken?: (code: 'missing' | 'not-image') => void;
}) {
  const [src, setSrc] = useState('');
  const [broken, setBroken] = useState<'' | 'missing' | 'not-image'>('');
  // 回调每次渲染都是新函数：用 ref 存，避免把它塞进 effect 依赖导致重复解密
  const onBrokenRef = useRef(onBroken);
  onBrokenRef.current = onBroken;

  useEffect(() => {
    let alive = true;
    setSrc('');
    setBroken('');
    void window.electronAPI.attachmentReadImage({ id }).then(r => {
      if (!alive) return;
      if (!r.success || !r.data?.dataUrl) {
        const code = r.code === 'not-image' ? 'not-image' : 'missing';
        setBroken(code);
        onBrokenRef.current?.(code);
        return;
      }
      setSrc(r.data.dataUrl);
    });
    return () => { alive = false; };
  }, [id]);

  if (broken) {
    return (
      <span
        className={`att-thumb is-broken${broken === 'not-image' ? ' is-file' : ''}${className ? ` ${className}` : ''}`}
        title={broken === 'not-image' ? '加密文件（非图片），可预览或导出' : '图片无法读取'}
      >
        {broken === 'not-image' ? '文件' : '图片已失效'}
      </span>
    );
  }
  return (
    <img
      className={`att-thumb${className ? ` ${className}` : ''}`}
      src={src || undefined}
      alt={alt || '图片'}
      title={alt || '图片'}
      loading="lazy"
      decoding="async"
    />
  );
}

/**
 * 渲染笔记 / 周报 Markdown，并把 `pm-att:<id>` 图片附件补上 src。
 *
 * 图片是加密存的，不能在渲染时直接给地址：先渲染出带 data-att 的占位 <img>，
 * 挂载后逐张调主进程解密，拿到 dataURL 再塞进 src。同一张图在本组件生命周期内只解一次。
 *
 * 点击任意图片进灯箱（背景透明、可缩放），不再需要另开窗口。
 */
export function MarkdownView({ md, className }: { md: string; className?: string }) {
  const body = useMemo(() => renderMarkdown(md), [md]);
  const ref = useRef<HTMLDivElement>(null);
  const cache = useRef<Map<string, string>>(new Map());
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const imgs = Array.from(root.querySelectorAll('img[data-att]')) as HTMLImageElement[];
    if (!imgs.length) return;
    let alive = true;
    for (const img of imgs) {
      const id = img.getAttribute('data-att') || '';
      if (!id) continue;
      const hit = cache.current.get(id);
      if (hit) { img.src = hit; continue; }
      void window.electronAPI.attachmentReadImage({ id }).then(r => {
        if (!alive) return;
        if (!r.success || !r.data?.dataUrl) {
          img.classList.add('is-broken');
          img.alt = `${img.alt || '图片'}（无法读取）`;
          return;
        }
        cache.current.set(id, r.data.dataUrl);
        img.src = r.data.dataUrl;
      });
    }
    return () => { alive = false; };
  }, [md]);

  /** 点正文里的图片 → 灯箱。用事件委托，避免给每张图单独挂 handler。 */
  const onBodyClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName !== 'IMG') return;
    const img = target as HTMLImageElement;
    if (!img.src || img.classList.contains('is-broken')) return;
    e.preventDefault();
    setZoom({ src: img.src, alt: img.alt || '图片' });
  };

  return (
    <>
      <div
        ref={ref}
        className={`markdown-body${className ? ` ${className}` : ''}`}
        onClick={onBodyClick}
      >
        {body}
      </div>
      {zoom && <ImageLightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </>
  );
}
