import type * as React from 'react';
import type { Attachment } from '../types';

/**
 * 粘贴图片的公共逻辑（渲染层）。
 *
 * 截图属于敏感信息（可能带客户数据、内网地址），所以不走「存到临时目录再引用」，
 * 一律送主进程用会话密钥加密落盘，正文里只留 `pm-att:<id>` 引用。
 */

/** 从剪贴板事件里挑出图片文件（复制的网页图片、截图工具都走这条） */
export function clipboardImageFiles(e: ClipboardEvent | React.ClipboardEvent): File[] {
  const dt = (e as ClipboardEvent).clipboardData;
  if (!dt) return [];
  const out: File[] = [];
  const items = dt.items ? Array.from(dt.items) : [];
  for (const item of items) {
    if (item.kind !== 'file' || !/^image\//i.test(item.type || '')) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  // 少数环境 items 为空但 files 有值
  if (!out.length && dt.files) {
    for (const f of Array.from(dt.files)) if (/^image\//i.test(f.type || '')) out.push(f);
  }
  return out;
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/** 逐张加密保存，返回可用的附件元数据；失败的条目带上原因 */
export async function saveImageFiles(
  files: File[],
): Promise<{ saved: Attachment[]; errors: string[] }> {
  const saved: Attachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      const dataUrl = await fileToDataUrl(file);
      const r = await window.electronAPI.attachmentSaveImage({ dataUrl, name: file.name });
      if (r.success && r.data) saved.push(r.data);
      else errors.push(r.error || '保存失败');
    } catch (e) {
      errors.push((e as Error).message || '保存失败');
    }
  }
  return { saved, errors };
}

/** 在 textarea 光标处插入文本，并把光标移到插入内容之后 */
export function insertAtCaret(el: HTMLTextAreaElement, text: string): string {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  const next = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  // 受控组件下一次渲染才会更新 DOM，这里先把光标位置记下来
  requestAnimationFrame(() => {
    try {
      el.selectionStart = pos;
      el.selectionEnd = pos;
    } catch { /* 元素可能已经不在了 */ }
  });
  return next;
}