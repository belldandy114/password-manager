import React, { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from '../utils/markdown';

/** 单张加密图片：挂载后解密成 dataURL。列表缩略图与正文图片共用。 */
export function AttImage({ id, alt, className }: { id: string; alt?: string; className?: string }) {
  const [src, setSrc] = useState('');
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let alive = true;
    setSrc('');
    setBroken(false);
    void window.electronAPI.attachmentReadImage({ id }).then(r => {
      if (!alive) return;
      if (!r.success || !r.data?.dataUrl) { setBroken(true); return; }
      setSrc(r.data.dataUrl);
    });
    return () => { alive = false; };
  }, [id]);

  if (broken) {
    return <span className={`att-thumb is-broken${className ? ` ${className}` : ''}`} title="图片无法读取">图片已失效</span>;
  }
  return (
    <img
      className={`att-thumb${className ? ` ${className}` : ''}`}
      src={src || undefined}
      alt={alt || '图片'}
      title={alt || '图片'}
    />
  );
}

/**
 * 渲染笔记 / 周报 Markdown，并把 `pm-att:<id>` 图片附件补上 src。
 *
 * 图片是加密存的，不能在渲染时直接给地址：先渲染出带 data-att 的占位 <img>，
 * 挂载后逐张调主进程解密，拿到 dataURL 再塞进 src。同一张图在本组件生命周期内只解一次。
 */
export function MarkdownView({ md, className }: { md: string; className?: string }) {
  const body = useMemo(() => renderMarkdown(md), [md]);
  const ref = useRef<HTMLDivElement>(null);
  const cache = useRef<Map<string, string>>(new Map());

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

  return (
    <div ref={ref} className={`markdown-body${className ? ` ${className}` : ''}`}>
      {body}
    </div>
  );
}