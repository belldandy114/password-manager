// @vitest-environment jsdom
/**
 * B6-B：粘贴导入弹窗 + 元素表 pw / 来源列（渲染层契约 §6.2 / 裁定 §18.3）。
 *
 * 锁七件事：
 * 1. 工具栏有「粘贴导入」，点开是弹窗、点取消能关；
 * 2. 三种格式各粘一次，预览行数与解析结果一致，且**每行「来源判定」与「依据」两列都非空**；
 * 3. 认不出的输入 → 固定文案 + 0 条可导入，**write 一次都不发**（pomPages 前后不变）；
 * 4. 唯一写入路径：导入后只有一次 `wsSet('pomPages')`，且新元素带 `source: 'paste'`、id 非空、
 *    老元素的 id 不被洗掉；
 * 5. 「来源」列优先读元素自带 `source`（粘贴导入 / 手工添加 / 录制器），老元素回退派生；
 * 6. 类型下拉 5 项、含「Playwright 链（原样存）」；
 * 7. `pw` 元素的「上次校验」列是固定文案「未校验（pw 链需在 Playwright 中验证）」且**不含任何数字**
 *    （Z9：body 兜底必然命中 1，显示命中数就是假阳性）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { ElementLibTab } from '../ElementLibTab';
import type { PomPage } from '../pomModel';
import type { UiRecording } from '../../../utils/codegen/elementUsage';

/* ---------------- 夹具 ---------------- */

const PAGE: PomPage = {
  id: 'page-1',
  name: '登录页',
  baseUrl: 'https://example.com/login',
  className: 'LoginPage',
  elements: [
    // 老元素：没有 source，但被录制引用 → 「来源」列必须回退到派生文案
    { id: 'el-legacy', name: '账号框', locator: '#account', kind: 'css' },
    // 手工添加
    { id: 'el-manual', name: '提交', locator: '#submit', kind: 'css', source: 'manual' },
    // pw 元素：上次校验列必须是固定文案
    { id: 'el-pw', name: '结果行', locator: "page.locator('#row').filter({ hasText: '全部' })", kind: 'pw' },
  ],
  updatedAt: '2026-11-27T10:00:00.000Z',
};

const RECORDING = {
  id: 'rec-1',
  name: '登录后进首页',
  steps: [{ elementId: 'el-legacy' }],
} as unknown as UiRecording;

interface Calls { writes: Array<{ key: string; items: unknown[] }>; toast: string[] }

function install(cfg: { pages: PomPage[]; recordings?: UiRecording[] }): Calls {
  const calls: Calls = { writes: [], toast: [] };
  (window as any).electronAPI = {
    wsGet: vi.fn(async (key: string) => ({
      success: true,
      data: key === 'pomPages' ? cfg.pages : key === 'uiRecordings' ? (cfg.recordings || []) : [],
    })),
    wsSet: vi.fn(async (key: string, items: unknown[]) => {
      calls.writes.push({ key, items });
      return { success: true };
    }),
    clipboardCopy: vi.fn(async () => ({ success: true })),
  };
  return calls;
}

const noToast = (sink: Calls) => (msg: string) => { sink.toast.push(msg); };
const noAsk = () => {};

/** 弹窗挂在 Modal 里（document 级查询，Modal 自带 overlay） */
const dialog = () => document.querySelector('.modal') as HTMLElement | null;

async function bootTrimmed(cfg?: { pages?: PomPage[]; recordings?: UiRecording[]; rows?: number }) {
  const calls = install({ pages: cfg?.pages || [PAGE], recordings: cfg?.recordings ?? [RECORDING] });
  const { container } = render(<ElementLibTab addToast={noToast(calls)} ask={noAsk} />);
  const rows = cfg?.rows ?? 3;
  await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(rows));
  return { calls, container };
}

/** 工具栏里点「粘贴导入」，返回弹窗里的 textarea */
async function openDialog({ calls, container }: { calls: Calls; container: HTMLElement }) {
  const btn = [...container.querySelectorAll('button')].find((b) => (b.textContent || '').includes('粘贴导入'));
  expect(btn).toBeTruthy();
  fireEvent.click(btn as HTMLButtonElement);
  await waitFor(() => expect(dialog()).toBeTruthy());
  const ta = dialog()!.querySelector('textarea') as HTMLTextAreaElement;
  expect(ta).toBeTruthy();
  return ta;
}

/** 粘文本 → 点「识别」→ 返回预览行数 */
async function parse(text: string, booted: { calls: Calls; container: HTMLElement }, manual?: string) {
  const ta = await openDialog(booted);
  fireEvent.change(ta, { target: { value: text } });
  if (manual) {
    const sel = dialog()!.querySelector('select') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: manual } });
  }
  const runBtn = [...dialog()!.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '识别');
  expect(runBtn).toBeTruthy();
  fireEvent.click(runBtn as HTMLButtonElement);
  await waitFor(() => expect(dialog()!.textContent).toContain('识别'));
  return dialog()!.querySelectorAll('tbody tr').length;
}

beforeEach(() => { cleanup(); delete (window as any).electronAPI; });
afterEach(() => cleanup());

/* ================================================================
   ① 工具栏入口与开关
   ================================================================ */
describe('B6-B ① 入口：工具栏有「粘贴导入」，弹窗能开能关', () => {
  it('点「粘贴导入」打开弹窗，点「取消」关闭且不写库', async () => {
    const booted = await bootTrimmed();
    await openDialog(booted);
    expect(dialog()!.textContent).toContain('粘贴导入');

    const cancel = [...dialog()!.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '取消');
    fireEvent.click(cancel as HTMLButtonElement);
    await waitFor(() => expect(dialog()).toBeNull());
    expect(booted.calls.writes.some((w) => w.key === 'pomPages')).toBe(false);
  });
});

/* ================================================================
   ② 三种格式：行数一致 + 两列非空
   ================================================================ */
describe('B6-B ② 三格式预览：行数与解析一致，来源判定与依据两列都非空', () => {
  const RECORDER_JSON = JSON.stringify({
    steps: [
      { type: 'click', selectors: [['#submit']], title: '提交' },
      { type: 'click', selectors: [['role/button[name="登录"]']], title: '登录' },
    ],
  });
  const PLAYWRIGHT = [
    "await page.getByRole('button', { name: '登录' }).click();",
    "await page.getByText('全部').click();",
  ].join('\n');
  const HTML = '<button id="submit">提交</button>';

  const expectRows = (n: number) => {
    const rows = [...dialog()!.querySelectorAll('tbody tr')] as HTMLElement[];
    expect(rows.length).toBe(n);
    for (const tr of rows) {
      const cells = [...tr.querySelectorAll('td')].map((td) => (td.textContent || '').trim());
      // 「来源判定」与「依据」两列都必须有字（不确定就写「确定/推定/无法识别」+ 一句为什么）
      // 同一格里可能还跟着「重复（已有）」标记，所以按前缀判
      const confidence = cells.find((c) => /^(确定|推定|无法识别)/.test(c));
      expect(confidence).toBeTruthy();
      const reasonCell = cells.find((c) => c.length > 8);
      expect(reasonCell).toBeTruthy();
    }
  };

  it('DevTools Recorder JSON → 2 行，头部显示识别结论与依据', async () => {
    const booted = await bootTrimmed();
    expect(await parse(RECORDER_JSON, booted)).toBe(2);
    expect(dialog()!.textContent).toContain('DevTools Recorder');
    expect(dialog()!.textContent).toMatch(/依据/);
    expectRows(2);
  });

  it('Playwright codegen 脚本 → 2 行', async () => {
    const booted = await bootTrimmed();
    expect(await parse(PLAYWRIGHT, booted)).toBe(2);
    expect(dialog()!.textContent).toContain('Playwright');
    expectRows(2);
  });

  it('Elements HTML → 1 行', async () => {
    const booted = await bootTrimmed();
    expect(await parse(HTML, booted)).toBe(1);
    expect(dialog()!.textContent).toContain('HTML');
    expectRows(1);
  });

  it('手动改选解析器 → 只重解析不重新识别（HTML 文本按 Playwright 解析 → 0 行）', async () => {
    const booted = await bootTrimmed();
    expect(await parse(HTML, booted, 'playwright-js')).toBe(0);
    expect(dialog()!.textContent).toContain('Playwright');
  });
});

/* ================================================================
   ③ 认不出：固定文案 + 不写入
   ================================================================ */
describe('B6-B ③ 认不出不写入', () => {
  it('粘一段中文 → 固定文案，导入按钮不可用，且 pomPages 一次都不写', async () => {
    const booted = await bootTrimmed();
    expect(await parse('我今天想加一个登录按钮', booted)).toBe(0);

    expect(dialog()!.textContent).toContain(
      '无法识别：支持 DevTools Recorder 导出的 JSON / Playwright codegen 脚本 / Elements 复制的 HTML',
    );
    const importBtn = [...dialog()!.querySelectorAll('button')].find((b) => /^导入\s*\d+\s*条/.test((b.textContent || '').trim()));
    expect(importBtn).toBeTruthy();
    expect((importBtn as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(importBtn as HTMLButtonElement);
    expect(booted.calls.writes.some((w) => w.key === 'pomPages')).toBe(false);
    // 元素表行数不变
    expect(booted.container.querySelectorAll('tbody tr').length).toBe(3);
  });
});

/* ================================================================
   ④ 唯一写入路径 + source 落库
   ================================================================ */
describe('B6-B ④ 导入写入：只写一次 pomPages，新元素 source=paste、id 非空，老元素 id 不变', () => {
  it('勾选后导入 → 1 次 wsSet，元素加 2 条且 source 全是 paste', async () => {
    const booted = await bootTrimmed();
    expect(await parse("await page.getByRole('button', { name: '登录' }).click();", booted)).toBe(1);

    const importBtn = [...dialog()!.querySelectorAll('button')].find((b) => /^导入\s*\d+\s*条/.test((b.textContent || '').trim()));
    fireEvent.click(importBtn as HTMLButtonElement);

    await waitFor(() => expect(booted.calls.writes.filter((w) => w.key === 'pomPages')).toHaveLength(1));
    const pages = booted.calls.writes.find((w) => w.key === 'pomPages')!.items as PomPage[];
    expect(pages).toHaveLength(1);
    const els = pages[0].elements;
    expect(els.length).toBe(4); // 原 3 条 + 导入 1 条
    const imported = els[els.length - 1];
    expect(imported.source).toBe('paste');
    expect(imported.id).toBeTruthy();
    expect(imported.kind).toBe('role');
    // 老元素 id 没被洗掉
    expect(els.slice(0, 3).map((e) => e.id)).toEqual(['el-legacy', 'el-manual', 'el-pw']);
    await waitFor(() => expect(dialog()).toBeNull());
  });
});

/* ================================================================
   ⑤「来源」列口径（裁定 §18.3）
   ================================================================ */
describe('B6-B ⑤ 来源列：优先 source，老元素回退派生', () => {
  it('manual → 手工添加；pw 无 source + 无引用 → 手工添加（回退）；被引用的老元素 → 派生文案', async () => {
    const { container } = await bootTrimmed();
    const cells = [...container.querySelectorAll('[data-col="source"]')].map((td) => (td.textContent || '').trim());
    expect(cells[0]).toContain('登录后进首页'); // 老元素：回退到 uiRecordings 派生
    expect(cells[1]).toBe('手工添加');
    expect(cells[2]).toBe('手工添加');
  });

  it('元素自带 source 优先于派生（paste 的即使被录制引用也显示「粘贴导入」）', async () => {
    const page: PomPage = {
      ...PAGE,
      elements: [{ id: 'el-legacy', name: '账号框', locator: '#account', kind: 'css', source: 'paste' }],
    };
    const { container } = await bootTrimmed({ pages: [page], rows: 1 });
    const cell = container.querySelector('[data-col="source"]') as HTMLElement;
    expect(cell.textContent!.trim()).toBe('粘贴导入');
    // 派生信息不丢：放进 title，供 hover 查看
    expect(cell.getAttribute('title') || '').toContain('登录后进首页');
  });
});

/* ================================================================
   ⑥⑦ 类型下拉 5 项 + pw 的上次校验（Z9）
   ================================================================ */
describe('B6-B ⑥⑦ pw 下拉与上次校验', () => {
  it('类型下拉 5 项且含「Playwright 链（原样存）」', async () => {
    const { container } = await bootTrimmed();
    const select = container.querySelector('tbody select') as HTMLSelectElement;
    const opts = [...select.querySelectorAll('option')].map((o) => (o.textContent || '').trim());
    expect(opts).toEqual(['css 选择器', 'xpath', '可见文本', '角色（role）', 'Playwright 链（原样存）']);
  });

  it('pw 元素的「上次校验」是固定文案且不含任何数字（Z9 不许伪造命中）', async () => {
    const { container } = await bootTrimmed();
    const checks = [...container.querySelectorAll('[data-col="last-check"]')].map((td) => (td.textContent || '').trim());
    expect(checks[2]).toBe('未校验（pw 链需在 Playwright 中验证）');
    expect(checks[2]).not.toMatch(/\d/);
    // 非 pw 元素仍是派生口径（B8 才改字段）
    expect(checks[1]).toBe('未校验');
  });
});
