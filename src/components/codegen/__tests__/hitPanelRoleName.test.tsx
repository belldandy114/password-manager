// @vitest-environment jsdom
/**
 * t26（review-arch AR-4b）：点验面板发给主进程的 `roleName` 必须与生成器**同口径 trim**。
 *
 * 守的是一个「报错会说谎」的缺陷：role→roleName 的映射在本仓有三条路径
 * （`ElementLibTab` 试跑 / `HitTestPanel` 点验 / `pageobject` 生成），
 * 只要有一条不 trim，用户在元素表里敲 ` 提交 `（首尾各一个空格）就会：
 *   库里存 `' 提交 '` → `getByRole(name)` 全等匹配失败 → 面板显示「没命中：页面上找不到这条定位器」。
 * 用户看到的是「定位器写错了」，真实原因却是名字带空格 —— 这类假红最难排查。
 *
 * 这里只锁**组件这一半**（生成器那半由 t24 改）：断言 IPC 入参里的 `roleName` 已经去掉首尾空白，
 * 且**不动中间的空格**（可访问名本身可以含空格，`String(x).trim()` 只削两端）。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';

import { HitTestPanel } from '../HitTestPanel';
import type { PomElementRow } from '../pomModel';
import type { ElHitTestInput } from '../../../types';

/* ---------------- 夹具 ---------------- */

const SESSION_EMPTY = {
  open: false, sessionId: '', browserId: '', port: 0, url: '', startedAt: '', lastHitAt: '', idleStopInMs: 0,
};

const HIT_OK = {
  found: true, total: 1, truncated: false, visible: true, inIframe: false, iframes: 0,
  reason: 'ok', label: '提交', approx: true, kind: 'role', locator: 'button',
  roleName: '提交', source: 'draft', ms: 12,
};

/** 一条 role 元素：可访问名带首尾空格（用户手滑最常见的形态） */
const ROW_ROLE: PomElementRow = { id: 'r-role', name: '提交按钮', locator: 'button', kind: 'role', role: '  提交  ' };
/** 一条 css 元素：不该带 roleName 字段 */
const ROW_CSS: PomElementRow = { id: 'r-css', name: '用户名', locator: '#user', kind: 'css' };

/** 装 electronAPI 桩，返回收到的 el:hit-test 入参列表 */
function install(): ElHitTestInput[] {
  const calls: ElHitTestInput[] = [];
  (window as any).electronAPI = {
    elHitTest: vi.fn(async (input: ElHitTestInput) => {
      calls.push(input);
      if (input.op === 'status') return { success: true, data: { op: 'status', session: SESSION_EMPTY } };
      return { success: true, data: { op: 'verify', hit: HIT_OK, session: SESSION_EMPTY } };
    }),
    logTail: vi.fn(async () => ({ success: true, data: { path: '', text: '' } })),
    logOpen: vi.fn(async () => ({ success: true })),
  };
  return calls;
}

const verifyCalls = (calls: ElHitTestInput[]) => calls.filter((c) => (c.op || 'verify') === 'verify');

beforeEach(() => { install(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/* ---------------- 断言 ---------------- */

describe('AR-4b：roleName 与生成器同口径 trim', () => {
  it('「 提交 」这种带首尾空格的可访问名 → 发下去的 roleName 是「提交」', async () => {
    const calls = install();
    const { getByText } = render(
      <HitTestPanel pageId="p1" baseUrl="https://example.com/login" elements={[ROW_ROLE]} pageSaved={false} />,
    );
    fireEvent.click(getByText('▶ 校验'));
    await waitFor(() => expect(verifyCalls(calls).length).toBe(1));

    const sent = verifyCalls(calls)[0];
    expect(sent.roleName).toBe('提交');
    // 逐字断言「没有首尾空白」——用 toBe 已经覆盖，这里再显式写一条便于读报告
    expect(String(sent.roleName)).toBe(String(sent.roleName).trim());
    expect(sent.kind).toBe('role');
  });

  it('中间的空格**不能**被 trim 掉（可访问名本身允许含空格）', async () => {
    const calls = install();
    const row: PomElementRow = { ...ROW_ROLE, role: ' 保存 并退出 ' };
    const { getByText } = render(
      <HitTestPanel pageId="p1" baseUrl="https://example.com/login" elements={[row]} pageSaved={false} />,
    );
    fireEvent.click(getByText('▶ 校验'));
    await waitFor(() => expect(verifyCalls(calls).length).toBe(1));
    expect(verifyCalls(calls)[0].roleName).toBe('保存 并退出');
  });

  it('空可访问名 → 发空串（不变成 undefined，主进程按 [A2-2] 第 7 步报「role 缺少名称」）', async () => {
    const calls = install();
    const row: PomElementRow = { ...ROW_ROLE, role: '   ' };
    const { getByText } = render(
      <HitTestPanel pageId="p1" baseUrl="https://example.com/login" elements={[row]} pageSaved={false} />,
    );
    fireEvent.click(getByText('▶ 校验'));
    await waitFor(() => expect(verifyCalls(calls).length).toBe(1));
    expect(verifyCalls(calls)[0].roleName).toBe('');
  });

  it('非 role 元素**不带** roleName 字段（[A0-2]：只有 role 需要第二字段）', async () => {
    const calls = install();
    const { getByText } = render(
      <HitTestPanel pageId="p1" baseUrl="https://example.com/login" elements={[ROW_CSS]} pageSaved={false} />,
    );
    fireEvent.click(getByText('▶ 校验'));
    await waitFor(() => expect(verifyCalls(calls).length).toBe(1));
    expect('roleName' in verifyCalls(calls)[0]).toBe(false);
  });

  it('库里已有这条（pageSaved=true）时走 pageId+elementId 来源，不发 locator/roleName', async () => {
    const calls = install();
    const { getByText } = render(
      <HitTestPanel pageId="p1" baseUrl="https://example.com/login" elements={[ROW_ROLE]} pageSaved />,
    );
    fireEvent.click(getByText('▶ 校验'));
    await waitFor(() => expect(verifyCalls(calls).length).toBe(1));
    const sent = verifyCalls(calls)[0];
    expect(sent.pageId).toBe('p1');
    expect(sent.elementId).toBe('r-role');
    expect('roleName' in sent).toBe(false);
  });
});
