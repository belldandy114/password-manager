// @vitest-environment jsdom
/**
 * 引用完整性闸门（RA3-01 / `[C-110]`「有人在用不许删」+ 产物生成前兜底）。
 *
 * 这组用例存在的理由：`canDeleteElement` / `scanElementRefs` 在 `recorderModel.ts` 里**早就有实现、
 * 有单测**，但生产代码零调用 —— 删元素、删整页、导产物三处都不查引用，`UiStep.elementId` 会静默悬空。
 * 所有单测当时都是绿的，所以「有实现无调用」这类缺陷只能靠**从界面这一侧**断言来抓：
 * 用例全部走组件的真实交互（点删除按钮 / 点生成），断言的是「界面到底拦没拦、提示说了谁在用」。
 *
 * 四条（对应 acceptance ①②③④）：
 * ① 被引用元素删除被拒，提示含正确条数/步号；
 * ② 删整页被拒并列出涉及元素；
 * ③ 无引用时可正常删（不能一律拒绝，那是另一种坏）；
 * ④ `dangling` 存在时产物生成被拦。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';

import { ElementLibTab } from '../ElementLibTab';
import { ArtifactPicker } from '../../recorder/ArtifactPicker';
import { newRecording, newStep } from '../../../utils/record/recorderModel';
import type { UiRecording } from '../../../utils/record/recorderModel';
import type { PomPage } from '../pomModel';

/** 一页两个元素：`el-account` / `el-city` */
const PAGE: PomPage = {
  id: 'page-1',
  name: '登录页',
  baseUrl: 'https://example.com/login',
  className: 'LoginPage',
  elements: [
    { id: 'el-account', name: '账号框', locator: '#account', kind: 'css' },
    { id: 'el-city', name: '城市', locator: '#city', kind: 'css' },
  ],
  updatedAt: '2026-11-26T10:00:00.000Z',
};

/**
 * 一份录制：`elementId` 挂在**指定下标**的那一步上（默认第 2 步 = 数组下标 1）。
 * 步号 = 下标 + 1，所以断言里用的是人话「第 N 步」。
 */
function recordingUsing(elementId: string, stepIndex = 1): UiRecording {
  const steps = [
    newStep({
      index: 0,
      action: 'click',
      locator: { kind: 'css', value: '#login' },
      elementId: stepIndex === 0 ? elementId : undefined,
    }),
    newStep({
      index: 1,
      action: 'fill',
      locator: { kind: 'css', value: '#account' },
      elementId: stepIndex === 1 ? elementId : undefined,
    }),
    newStep({
      index: 2,
      action: 'click',
      locator: { kind: 'css', value: '#city' },
      elementId: stepIndex === 2 ? elementId : undefined,
    }),
  ];
  return newRecording({
    id: 'rec-1',
    name: '登录后进首页',
    baseUrl: 'https://example.com/login',
    startedAt: '2026-11-26T10:00:00.000Z',
    steps,
  });
}

interface Calls { toast: Array<[string, string | undefined]>; asks: number; writes: Array<{ key: string; items: unknown[] }> }

function install(cfg: { pages: PomPage[]; recordings: UiRecording[] }): Calls {
  const calls: Calls = { toast: [], asks: 0, writes: [] };
  (window as any).electronAPI = {
    wsGet: vi.fn(async (key: string) => ({
      success: true,
      data: key === 'pomPages' ? cfg.pages : key === 'uiRecordings' ? cfg.recordings : [],
    })),
    wsSet: vi.fn(async (key: string, items: unknown[]) => {
      calls.writes.push({ key, items });
      return { success: true };
    }),
    clipboardCopy: vi.fn(async () => ({ success: true })),
  };
  return calls;
}

const noopToast = (sink: Calls) => (msg: string, type?: 'info' | 'success' | 'error') => {
  sink.toast.push([msg, type]);
};

beforeEach(() => cleanup());
afterEach(() => cleanup());

/* ================================================================
   ① 被引用元素删除被拒
   ================================================================ */
describe('RA3-01 ① 删元素：被引用时拒绝并说清谁在用', () => {
  it('点删除 → 不弹确认、元素还在，且提示含「1 条录制」「第 2 步」与录制名', async () => {
    const calls = install({ pages: [PAGE], recordings: [recordingUsing('el-account')] });
    const { container } = render(
      <ElementLibTab addToast={noopToast(calls)} ask={() => { calls.asks += 1; }} />,
    );
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));

    // 第 1 行 = 账号框（被引用），点它的删除按钮
    const del = container.querySelector('button[aria-label="删除第 1 个元素"]') as HTMLButtonElement;
    fireEvent.click(del);

    // 被拒的关键证据：**没走弹窗确认**（ask 没被调用）、元素没被移除、也没写盘
    expect(calls.asks).toBe(0);
    expect(container.querySelectorAll('tbody tr').length).toBe(2);
    expect(calls.writes.some((w) => w.key === 'pomPages')).toBe(false);

    // 提示要能回答「谁在用」：条数 + 步号 + 录制名
    const text = calls.toast.map(([m]) => m).join('\n');
    expect(text).toContain('1 条录制');
    expect(text).toContain('第 2 步');
    expect(text).toContain('登录后进首页');
    // 可读原因，不是「不允许」三个字
    expect(text).toContain('引用');
    // 界面上要有可达的引用清单（不是只弹一个 toast 就没了）
    const banner = container.querySelector('[data-ref-block]') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('登录后进首页 第 2 步');
  });
});

/* ================================================================
   ② 删整页被拒
   ================================================================ */
describe('RA3-01 ② 删整页：批量查引用，被拒时列出涉及元素', () => {
  it('整页有引用 → 不弹确认、页面还在，提示含涉及元素名与条数', async () => {
    const calls = install({ pages: [PAGE], recordings: [recordingUsing('el-city', 2)] });
    const { container } = render(
      <ElementLibTab addToast={noopToast(calls)} ask={() => { calls.asks += 1; }} />,
    );
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));

    const delPage = container.querySelector('button[aria-label="删除页面 登录页"]') as HTMLButtonElement;
    expect(delPage).toBeTruthy();
    fireEvent.click(delPage);

    expect(calls.asks).toBe(0);
    expect(calls.writes.some((w) => w.key === 'pomPages')).toBe(false);
    // toast：条数 + 涉及的元素名（开着别的面板时也能看到发生了什么）
    const text = calls.toast.map(([m]) => m).join('\n');
    expect(text).toContain('城市');      // 涉及的元素名
    expect(text).toContain('1 条');      // 条数
    // 横幅：逐条列出「哪个元素 · 哪份录制 · 第几步」（要改的是具体那一步）
    const banner = container.querySelector('[data-ref-block="page"]') as HTMLElement;
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('城市');
    expect(banner.textContent).toContain('登录后进首页 第 3 步');
  });
});

/* ================================================================
   ③ 无引用时可以正常删
   ================================================================ */
describe('RA3-01 ③ 无引用时不得一律拒绝', () => {
  it('元素没有被任何录制引用 → 照常删掉那一行，不弹拦截横幅', async () => {
    const calls = install({ pages: [PAGE], recordings: [] });
    const { container } = render(
      <ElementLibTab addToast={noopToast(calls)} ask={() => { calls.asks += 1; }} />,
    );
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));

    fireEvent.click(container.querySelector('button[aria-label="删除第 1 个元素"]') as HTMLButtonElement);

    // 元素删除是「改草稿」而不是立刻落库（原有行为：保存页面时才写盘），这里只断言真的删掉了
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(1));
    // 拦截横幅不该出现（正文里「来源 / 上次校验」的说明含「引用」二字，所以按锚点判而不是搜文本）
    expect(container.querySelector('[data-ref-block]')).toBeNull();
    expect(calls.toast.map(([m]) => m).join()).not.toContain('引用');
  });

  it('整页没有被任何录制引用 → 照常弹确认并允许删除', async () => {
    const calls = install({ pages: [PAGE], recordings: [] });
    const { container } = render(
      <ElementLibTab addToast={noopToast(calls)} ask={() => { calls.asks += 1; }} />,
    );
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(2));
    fireEvent.click(container.querySelector('button[aria-label="删除页面 登录页"]') as HTMLButtonElement);
    expect(calls.asks).toBe(1);
  });
});

/* ================================================================
   ④ 产物生成前兜底
   ================================================================ */
describe('RA3-01 ④ 产物：有 dangling 时禁止生成', () => {
  it('步骤引用的元素已不存在 → 不渲染任何产物代码块，并显示「有 N 个步骤引用的元素已不存在」', async () => {
    // 录制引用了 el-gone，但元素库里只有 el-city（el-gone 被删过）
    install({ pages: [{ ...PAGE, elements: [{ id: 'el-city', name: '城市', locator: '#city', kind: 'css' }] }], recordings: [] });
    const rec = recordingUsing('el-gone', 1);
    const { container } = render(<ArtifactPicker rec={rec} />);

    await waitFor(() => expect(container.textContent).toContain('已不存在'));
    // 禁止生成：三块产物一块都不许出现
    expect(container.querySelectorAll('pre.tb-pre.dev-code').length).toBe(0);
    expect(container.querySelectorAll('[data-act="copy-artifact"]').length).toBe(0);
    expect(container.textContent).toContain('1 个步骤');
    expect(container.textContent).toContain('登录后进首页');
    expect(container.textContent).toContain('el-gone');
  });

  it('元素都还在 → 正常生成两块产物（不能一律拦）', async () => {
    install({ pages: [PAGE], recordings: [] });
    const rec = recordingUsing('el-account', 1);
    const { container } = render(<ArtifactPicker rec={rec} />);
    await waitFor(() => expect(container.querySelectorAll('pre.tb-pre.dev-code[data-artifact]').length).toBe(2));
    // t52：产物② .mjs 已按裁定拿掉，交付只剩 pom + spec 两块
    expect(container.textContent).not.toContain('已不存在');
  });
});

/* ================================================================
   成本口径（队长在 t38 追加的两条要求）
   ================================================================ */
describe('RA3-01 成本：懒加载 + 只查一次', () => {
  it('没有录制时不发 ws:get（录制页刚进来不该为空态付这次 IPC）', async () => {
    const calls = install({ pages: [PAGE], recordings: [] });
    const { container } = render(<ArtifactPicker rec={null} />);
    await waitFor(() => expect(container.textContent).toContain('还没有可导出的录制'));
    const wsGet = (window as any).electronAPI.wsGet as ReturnType<typeof vi.fn>;
    expect(wsGet.mock.calls.filter((c: unknown[]) => c[0] === 'pomPages')).toHaveLength(0);
    // 空态也不该出现任何「检查中 / 已不存在」的噪音
    expect(container.querySelector('[data-ref-block]')).toBeNull();
    void calls;
  });

  it('有录制时只读一次 pomPages（引用 memo，不每渲染都 ws:get）', async () => {
    install({ pages: [PAGE], recordings: [] });
    const rec = recordingUsing('el-account', 1);
    const { container, rerender } = render(<ArtifactPicker rec={rec} />);
    await waitFor(() => expect(container.querySelectorAll('pre.tb-pre.dev-code').length).toBe(2));
    rerender(<ArtifactPicker rec={rec} />);
    rerender(<ArtifactPicker rec={rec} />);
    const wsGet = (window as any).electronAPI.wsGet as ReturnType<typeof vi.fn>;
    expect(wsGet.mock.calls.filter((c: unknown[]) => c[0] === 'pomPages')).toHaveLength(1);
  });
});
