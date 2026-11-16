// @vitest-environment jsdom
// 附件缩略图的三条分支：正常图片 / 非图片文件 / 文件丢失。
// 非图片分支是 1.24.7 新增的（证书、密钥这类附件以前一律显示「图片已失效」）。
import { describe, it, expect, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';
import { AttImage } from '../MarkdownView';

type ReadResult = { success: boolean; code?: 'missing' | 'not-image'; data?: { dataUrl: string } };
function stubRead(impl: () => Promise<ReadResult>) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { attachmentReadImage: impl };
}

afterEach(() => cleanup());

describe('AttImage', () => {
  it('正常图片渲染 img 的 dataURL', async () => {
    stubRead(() => Promise.resolve({ success: true, data: { dataUrl: 'data:image/png;base64,AAA' } }));
    const { container } = render(<AttImage id="img-1" alt="图" />);
    await waitFor(() => {
      expect(container.querySelector('img')?.getAttribute('src')).toContain('data:image/png');
    });
  });

  it('非图片附件显示「文件」并回调 not-image', async () => {
    let code = '';
    stubRead(() => Promise.resolve({ success: false, code: 'not-image', data: undefined }));
    const { container } = render(<AttImage id="cert-1" onBroken={(c) => { code = c; }} />);
    await waitFor(() => expect(container.textContent).toContain('文件'));
    expect(code).toBe('not-image');
    expect(container.querySelector('.att-thumb.is-file')).toBeTruthy();
  });

  it('文件丢失显示「图片已失效」', async () => {
    let code = '';
    stubRead(() => Promise.resolve({ success: false, code: 'missing' }));
    const { container } = render(<AttImage id="gone-1" onBroken={(c) => { code = c; }} />);
    await waitFor(() => expect(container.textContent).toContain('图片已失效'));
    expect(code).toBe('missing');
    expect(container.querySelector('.att-thumb.is-file')).toBeNull();
  });
});
