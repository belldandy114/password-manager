// @vitest-environment jsdom
/**
 * B8-B：元素库「试跑」（`el:trial-run`）—— 渲染层契约 §6.4 / 裁定 Z9、Z10。
 *
 * 锁五件事：
 * 1. **四种状态分得开**（纯函数 `trialStateOf`）：命中 1 / 未命中（红）/ 命中多个（黄）/
 *    未执行（灰，带原因）。`trial='skip'` **绝不**显示成「0 命中」——那是把「没验」说成「验了没中」；
 * 2. 没选工作目录时**不发 IPC**，直接说「去设置里选」；
 * 3. 真跑过（ok / fail）的元素才回填 `hitCount / checkedAt`；`skip` 元素**一个字段都不写**（Z10 的写入方口径）；
 * 4. 登录失效（`loginRequired: true`）→ 显示登录提示 + 「重试」按钮，**不写任何 hitCount**；
 * 5. 元素表「上次校验」列改读自带字段（有 hitCount 优先），pw 且无 hitCount 时仍是固定文案。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { ElementLibTab, trialStateOf, EL_WORK_DIR_KEY } from '../ElementLibTab';
import type { PomPage } from '../pomModel';
import type { ElTrialItem, ElTrialResult } from '../../../types';

/* ---------------- 夹具 ---------------- */

const PAGE: PomPage = {
  id: 'page-1',
  name: '登录页',
  baseUrl: 'https://example.com/login',
  elements: [
    { id: 'el-ok', name: '确定', locator: '#ok', kind: 'css' },
    { id: 'el-miss', name: '取消', locator: '#nope', kind: 'css' },
    { id: 'el-multi', name: '重复行', locator: '.dup', kind: 'css' },
    { id: 'el-skip', name: '动态链', locator: "page.locator(`#row-${i}`)", kind: 'pw' },
  ],
  updatedAt: '2026-11-28T02:00:00.000Z',
};

const item = (patch: Partial<ElTrialItem>): ElTrialItem => ({
  kind: 'css', locator: '#ok', hit: 1, visible: true, trial: 'ok', ...patch,
});

/** 四条结果：命中 1 / 未命中 / 命中 3 / 未执行（skip 带原因） */
const RESULTS: ElTrialItem[] = [
  item({ locator: '#ok', hit: 1, trial: 'ok' }),
  // 真未命中：主进程 count()=0 → trial 停在 skip，但**没有 error**（element-args.js 的 rowOf 默认值）
  item({ locator: '#nope', hit: 0, trial: 'skip' }),
  item({ locator: '.dup', hit: 3, trial: 'fail', error: '可操作性检查未通过：元素不可见' }),
  item({ locator: 'page.locator(`#row-${i}`)', hit: 0, trial: 'skip', error: '含变量插值，无法在应用内试跑' }),
];

interface Calls {
  trial: Array<{ dir: string; url: string; items: unknown[] }>;
  toast: string[];
}

function install(cfg: { pages?: PomPage[]; trial?: Partial<ElTrialResult> | 'throw' } = {}): Calls {
  const calls: Calls = { trial: [], toast: [] };
  (window as any).electronAPI = {
    wsGet: vi.fn(async (key: string) => ({
      success: true,
      data: key === 'pomPages' ? (cfg.pages || [PAGE]) : [],
    })),
    wsSet: vi.fn(async () => ({ success: true })),
    clipboardCopy: vi.fn(async () => ({ success: true })),
    elTrialRun: vi.fn(async (input: { dir: string; url: string; items: unknown[] }) => {
      calls.trial.push(input);
      if (cfg.trial === 'throw') throw new Error('boom');
      return { success: true, data: { results: RESULTS, ms: 1234, ...(cfg.trial || {}) } };
    }),
  };
  return calls;
}

const noToast = (sink: Calls) => (msg: string) => { sink.toast.push(msg); };
const noAsk = () => {};

async function boot(cfg?: Parameters<typeof install>[0]) {
  const calls = install(cfg);
  const { container } = render(<ElementLibTab addToast={noToast(calls)} ask={noAsk} />);
  await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(4));
  return { calls, container };
}

const btn = (root: HTMLElement, text: string) =>
  [...root.querySelectorAll('button')].find((b) => (b.textContent || '').includes(text)) as HTMLButtonElement | undefined;

/** 点工具栏「试跑」并等结果面板出现 */
async function runTrial(root: HTMLElement) {
  const run = btn(root, '试跑');
  expect(run).toBeTruthy();
  fireEvent.click(run!);
  await waitFor(() => expect(root.querySelector('.el-trial')).toBeTruthy());
  return root.querySelector('.el-trial') as HTMLElement;
}

beforeEach(() => {
  cleanup();
  delete (window as any).electronAPI;
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => cleanup());

/* ================================================================
   ① 纯函数：四种状态
   ================================================================ */
describe('B8-B ① trialStateOf：四种状态（含「未执行 ≠ 0 命中」）', () => {
  it('命中 1 → is-ok「命中 1」', () => {
    const s = trialStateOf(item({ hit: 1, trial: 'ok' }));
    expect(s.key).toBe('hit1');
    expect(s.label).toBe('命中 1');
    expect(s.cls).toBe('is-ok');
  });

  it('命中 0 且无 error → is-error「选择器未命中」（count()=0，没去点）', () => {
    const s = trialStateOf(item({ hit: 0, trial: 'skip' }));
    expect(s.key).toBe('miss');
    expect(s.label).toBe('选择器未命中');
    expect(s.cls).toBe('is-error');
  });

  it('命中 3 → is-warn「命中 3 个，请细化」', () => {
    const s = trialStateOf(item({ hit: 3, trial: 'fail', error: '不可见' }));
    expect(s.key).toBe('multi');
    expect(s.label).toBe('命中 3 个，请细化');
    expect(s.cls).toBe('is-warn');
  });

  it('未执行（skip）→ 灰标「未执行」且**不出现任何命中数字**（Z9）', () => {
    const s = trialStateOf(item({ hit: 0, trial: 'skip', error: '含变量插值，无法在应用内试跑' }));
    expect(s.key).toBe('skip');
    expect(s.label).toBe('未执行');
    expect(s.cls).toBe('is-unknown');
    expect(s.label).not.toMatch(/\d/);
    expect(s.detail).toContain('变量插值');
  });

  it('未执行的条目带的是主进程原文（items 段超时 / 链解析不了都照抄，不改写）', () => {
    const timeout = trialStateOf(item({ hit: 0, trial: 'skip', error: 'items 段超时，未执行' }));
    expect(timeout.key).toBe('skip');
    expect(timeout.detail).toBe('items 段超时，未执行');
  });

  it('万一主进程没给原因，也有默认说明（不许空着让人以为「没中」）', () => {
    // 合成态：trial=skip 但 hit>0（正常路径里不会出现，只用于锁兜底文案）
    const s = trialStateOf(item({ hit: 2, trial: 'skip' }));
    expect(s.key).toBe('skip');
    expect(s.detail).toContain('无法在应用内试跑');
  });

  it('命中但有 fail → 仍是命中数，细节说清「可操作性检查没过」', () => {
    const s = trialStateOf(item({ hit: 1, trial: 'fail', error: '' }));
    expect(s.key).toBe('fail');
    expect(s.cls).toBe('is-warn');
    expect(s.detail).toContain('可操作性检查');
  });
});

/* ================================================================
   ② 没选工作目录：不发 IPC
   ================================================================ */
describe('B8-B ② 没选工作目录时不试跑，直接指路', () => {
  it('点「试跑」→ 不发 el:trial-run，面板说「去设置里选目录」', async () => {
    const booted = await boot();
    const panel = await runTrial(booted.container);
    expect(booted.calls.trial.length).toBe(0);
    expect(panel.textContent).toContain('Playwright 工作目录');
    expect(panel.querySelector('[data-trial="message"]')).toBeTruthy();
  });
});

/* ================================================================
   ③ 真跑一遍：四种状态各一行 + 只给真跑过的元素回填字段
   ================================================================ */
describe('B8-B ③ 试跑结果面板与字段回填', () => {
  it('发出去的 items 与元素一一对应（kind / locator / name）', async () => {
    localStorage.setItem(EL_WORK_DIR_KEY, 'D:\\pm-el');
    const booted = await boot();
    await runTrial(booted.container);
    expect(booted.calls.trial.length).toBe(1);
    const sent = booted.calls.trial[0];
    expect(sent.dir).toBe('D:\\pm-el');
    expect(sent.url).toBe('https://example.com/login');
    expect(sent.items.length).toBe(4);
    expect(sent.items[0]).toMatchObject({ kind: 'css', locator: '#ok', name: '确定' });
  });

  it('四条结果按四种状态渲染（data-trial-state 可区分，且都不相同）', async () => {
    localStorage.setItem(EL_WORK_DIR_KEY, 'D:\\pm-el');
    const booted = await boot();
    const panel = await runTrial(booted.container);
    await waitFor(() => expect(panel.querySelectorAll('tbody tr').length).toBe(4));
    const states = [...panel.querySelectorAll('tbody tr')].map((r) => r.getAttribute('data-trial-state'));
    expect(new Set(states).size).toBe(4);
    expect(states).toContain('skip');
    expect(states).toContain('miss');
    expect(states).toContain('multi');
    // 「未执行」那一行必须是「未执行」四个字，而不是「命中 0」
    const skipRow = [...panel.querySelectorAll('tbody tr')].find((r) => r.getAttribute('data-trial-state') === 'skip')!;
    expect(skipRow.textContent).toContain('未执行');
    expect(skipRow.textContent).not.toContain('命中 0');
  });

  it('「上次校验」列：真跑过的元素读自带 hitCount，skip 元素保持「—」（不回填、不冒充 0）', async () => {
    localStorage.setItem(EL_WORK_DIR_KEY, 'D:\\pm-el');
    const booted = await boot();
    const panel = await runTrial(booted.container);
    await waitFor(() => expect(panel.querySelectorAll('tbody tr').length).toBe(4));
    // 元素表（.el-trial 之外那张）里的「上次校验」列
    const table = booted.container.querySelector('table.tbl') as HTMLElement;
    const cellText = [...table.querySelectorAll('tbody tr')].map((tr) => tr.lastElementChild!.previousElementSibling!.textContent || '');
    expect(cellText[0]).toMatch(/命中 1/);
    expect(cellText[1]).toMatch(/未命中/);
    expect(cellText[2]).toMatch(/命中 3 个/);
    // pw + 没有 hitCount → 既有固定口径，不显示数字；t22 起这两格允许换行（不裁切、不缩文案）
    expect(cellText[3]).toContain('未校验（pw 链需在 Playwright 中验证）');
  });

  it('截图只给路径 + 复制按钮，**不做内嵌预览**（已知限制）', async () => {
    localStorage.setItem(EL_WORK_DIR_KEY, 'D:\\pm-el');
    const booted = await boot({ trial: {} });
    // 给第一条结果补一个 shotPath
    const api = (window as any).electronAPI;
    api.elTrialRun = vi.fn(async () => ({
      success: true,
      data: { results: RESULTS.map((r, i) => (i === 0 ? { ...r, shotPath: 'C:\\Temp\\shot-1.png' } : r)), ms: 900 },
    }));
    const panel = await runTrial(booted.container);
    await waitFor(() => expect(panel.querySelectorAll('tbody tr').length).toBe(4));
    expect(panel.textContent).toContain('C:\\Temp\\shot-1.png');
    expect(btn(panel, '复制路径')).toBeTruthy();
    expect(panel.querySelector('img')).toBeNull();
    expect(panel.textContent).toContain('已知限制');
  });
});

/* ================================================================
   ④ 登录失效：提示 + 重试，且不写 hitCount
   ================================================================ */
describe('B8-B ④ 页面需要登录', () => {
  it('loginRequired → 登录提示 + 「重试」按钮，且不写任何 hitCount', async () => {
    localStorage.setItem(EL_WORK_DIR_KEY, 'D:\\pm-el');
    const booted = await boot({ trial: { results: [], loginRequired: true, message: '停在登录页' } });
    const panel = await runTrial(booted.container);
    expect(panel.querySelector('[data-trial="login"]')).toBeTruthy();
    expect(panel.textContent).toContain('页面需要登录：请在弹出的窗口里登录后点「重试」');
    expect(btn(panel, '重试')).toBeTruthy();
    // 不显示成命中 0
    expect(panel.textContent).not.toContain('选择器未命中');

    // 元素表的「上次校验」列一个数字都不该多出来
    const table = booted.container.querySelector('table.tbl') as HTMLElement;
    const cellText = [...table.querySelectorAll('tbody tr')].map((tr) => tr.lastElementChild!.previousElementSibling!.textContent || '');
    // 没跑成 → 走 meta 回退（「未校验」），关键是**不许冒出任何命中数字**
    expect(cellText[0]).toBe('未校验');
    expect(cellText.slice(0, 3).join('')).not.toMatch(/\d/);
  });

  it('主进程序列化失败（success:false）→ 原样显示错误，不编成「未命中」', async () => {
    localStorage.setItem(EL_WORK_DIR_KEY, 'D:\\pm-el');
    const booted = await boot();
    (window as any).electronAPI.elTrialRun = vi.fn(async () => ({ success: false, error: '缺少 playwright：npm i -D playwright' }));
    const panel = await runTrial(booted.container);
    expect(panel.textContent).toContain('缺少 playwright');
    expect(panel.textContent).not.toContain('选择器未命中');
  });
});

/* ================================================================
   t26（AR-4 组件侧第三处）：试跑发出去的 roleName 也必须 trim
   ================================================================ */

/** 4 行页面：其中一行是 role 且可访问名带首尾空格（用户手滑的典型形态） */
const PAGE_ROLE: PomPage = {
  id: 'page-role',
  name: '登录页',
  baseUrl: 'https://example.com/login',
  elements: [
    { id: 'el-1', name: '用户名', locator: '#user', kind: 'css' },
    { id: 'el-2', name: '提交按钮', locator: 'button', kind: 'role', role: '  提交  ' },
    { id: 'el-3', name: '密码', locator: '#pwd', kind: 'css' },
    { id: 'el-4', name: '登录', locator: '登录', kind: 'text' },
  ],
  updatedAt: '2026-11-28T02:00:00.000Z',
};

describe('AR-4：试跑路径的 roleName 与点验 / 生成器同口径 trim', () => {
  it('可访问名「 提交 」→ 发给主进程的是「提交」（不带首尾空格）', async () => {
    localStorage.setItem(EL_WORK_DIR_KEY, 'D:\\pm-el');
    const booted = await boot({ pages: [PAGE_ROLE] });
    await runTrial(booted.container);
    const sent = booted.calls.trial[0];
    const roleItem = (sent.items as Array<{ roleName?: string; kind: string }>).find((i) => i.kind === 'role');
    expect(roleItem).toBeTruthy();
    expect(roleItem!.roleName).toBe('提交');
    expect(String(roleItem!.roleName)).toBe(String(roleItem!.roleName).trim());
  });
});
