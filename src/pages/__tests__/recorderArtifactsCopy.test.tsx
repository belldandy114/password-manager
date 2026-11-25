// @vitest-environment jsdom
/**
 * 「产物」区文案的**空态**回归（t54）。
 *
 * 为什么必须单独有这个文件：t52 的「DOM 文本不含 `.mjs`」只验了**有录制数据**时的文本，
 * 而用户第一次进「产物」区看到的是**空态**（`ArtifactPicker` 的 `emptyHint`）。
 * t53 复包时 backend 在安装包 asar 里就命中过那句旧文案（还写着「零依赖 .mjs … 三份产物」）——
 * 也就是说 t52 那条断言是**假绿**：只验了一半的状态。
 *
 * 这个文件渲染的是**生产页面**（`<Recorder />`）而**不是**给 `ArtifactPicker` 传一个本地字面量：
 * 只有这样，`Recorder.tsx` 里那句 `emptyHint` 被改回旧措辞时才会真红。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { createElement } from 'react';

import { Recorder } from '../Recorder';
import { useStore } from '../../store/useStore';
import { newRecording, newStep, textValueMeta } from '../../utils/record/recorderModel';

/** 旧文案里出现过的三个词：一个都不许再出现在用户可见文本里 */
const FORBIDDEN = ['.mjs', '零依赖', '三份'];

function installApi(hasDraft: boolean) {
  const abilities = [
    { id: 'chrome', state: 'green', label: '浏览器', detail: 'Chrome 121', evidence: [] },
    { id: 'node', state: 'green', label: 'Node', detail: 'v22', evidence: [] },
  ];
  (window as any).electronAPI = {
    recordProbe: vi.fn(async () => ({ success: true, data: { abilities, probedAt: '2026-11-26T10:00:00.000Z' } })),
    recordStatus: vi.fn(async () => ({ success: true, data: null })),
    wsGet: vi.fn(async () => ({ success: true, data: [] })),
    wsSet: vi.fn(async () => ({ success: true })),
    clipboardCopy: vi.fn(async () => ({ success: true })),
  };
  void hasDraft;
}

/** 进入「产物」区的入口：产物面板常驻在录制页，不需要切页签 */
async function renderRecorder() {
  const view = render(createElement(Recorder));
  // 等页面挂载 + 能力灯渲染（AbilityBar 固定 5 盏，与探测到几条 ability 无关）
  await waitFor(() => expect(view.container.querySelector('.pg.rec-page')).toBeTruthy());
  await waitFor(() => expect(view.container.querySelectorAll('.rec-lamp').length).toBe(5));
  return view;
}

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe('t54 · 空态文案（用户第一次进「产物」区看到的就是它）', () => {
  it('没有录制数据时：空态提示不宣传已移除的 .mjs，并明确只列两份', async () => {
    installApi(false);
    useStore.setState({ recorder: null });
    const { container } = await renderRecorder();

    // 确认我们渲染的**就是空态**（而不是有数据的那一半）
    const text = container.textContent || '';
    expect(text).toContain('还没有可导出的录制');
    expect(text).toContain('先在「录制」页签录几步'); // emptyHint 真的渲染了

    // 旧文案的三个词：空态里 0 命中
    for (const word of FORBIDDEN) {
      expect(text).not.toContain(word);
    }
    // 两份要明确写出来（不能只是「不含旧词」而让人不知道有啥）
    expect(text).toContain('两份');
    expect(text).toContain('Java POM');
    expect(text).toContain('Playwright .spec.ts');
    // 也不许再出现「第②份」相关的选项/代码块
    expect(container.querySelector('[data-artifact-block="mjs"]')).toBeNull();
  });
});

describe('t54 · 有数据时同样不宣传 .mjs（补上 t52 覆盖的那一半，两个状态一起验）', () => {
  it('有录制时：面板 meta 说「两份同源」，且各项文案不含旧词', async () => {
    installApi(true);
    const rec = newRecording({
      id: 'rec-t54',
      name: 't54',
      baseUrl: 'https://example.com/login',
      startedAt: '2026-11-26T10:00:00.000Z',
      steps: [newStep({ index: 0, action: 'click', locator: { kind: 'css', value: '#login' } })],
    });
    useStore.setState({
      recorder: {
        sessionId: 's1',
        startedAt: rec.startedAt,
        url: rec.baseUrl,
        browser: 'Chrome 121',
        port: 9222,
        pageId: '',
        recordingId: rec.id,
        steps: [
          {
            step: rec.steps[0],
            target: { tag: 'button' },
            candidates: [{ strategy: 'css', selector: '#login', count: 1, precise: true }],
            chosen: 0,
          },
        ],
        lastSeq: 1,
        ended: true,
        truncated: false,
        dropped: 0,
      } as any,
    });

    const { container } = await renderRecorder();
    const text = container.textContent || '';
    expect(text).toContain('两份同源');
    for (const word of FORBIDDEN) {
      expect(text).not.toContain(word);
    }
    // 交付的两块都在
    await waitFor(() => expect(container.querySelectorAll('pre.tb-pre.dev-code[data-artifact]').length).toBe(2));
  });
});
