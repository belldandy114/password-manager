import { describe, it, expect } from 'vitest';

import {
  HIT_NOTE_IFRAME,
  HIT_NOTE_TRIAL,
  HIT_UI_STATES,
  hitViewOf,
  runLabelOf,
} from '../hitPanelModel';
import type { ElHitFacts, ElHitReason, ElHitSession, ElHitTestResult } from '../../../types';

/**
 * 点验面板状态机单测（12 态）。
 *
 * 守的是三件「错了也看不出来」的事：
 * 1. **状态数与 reason 一一对应**——少一个状态就是一个 reason 在界面上没有出口（孤立 reason），
 *    多一个状态就是一个永远触发不到的假分支（[A2-4] 之外最隐蔽的一类 bug）；
 * 2. **「没验」不许渲染成「没命中」**——失败态不得携带任何命中事实；
 * 3. 逐字文案（多命中「匹配到 3 个，框的是第 1 个」、iframe / shadow DOM 明说不支持）。
 */

/** 主进程 `ElHitReason` 的 7 个值（`src/types.ts:1162-1169`）；这里手写一份是为了「多一个值就红」 */
const ALL_REASONS: ElHitReason[] = [
  'ok',
  'not-found',
  'not-visible',
  'iframe-only',
  'login-required',
  'unsupported',
  'timeout',
];

const facts = (patch: Partial<ElHitFacts>): ElHitFacts => ({
  found: true,
  total: 1,
  truncated: false,
  visible: true,
  inIframe: false,
  iframes: 0,
  reason: 'ok',
  label: '',
  approx: false,
  kind: 'css',
  locator: '#a',
  source: 'draft',
  ms: 12,
  ...patch,
});

const session = (patch: Partial<ElHitSession> = {}): ElHitSession => ({
  open: true,
  sessionId: 'sid-1',
  browserId: 'chrome',
  port: 9222,
  url: 'https://example.com/login',
  startedAt: '2026-11-28T00:00:00.000Z',
  lastHitAt: '',
  idleStopInMs: 600000,
  ...patch,
});

const result = (hit: ElHitFacts): ElHitTestResult => ({ op: 'verify', hit, session: session() });

describe('12 个状态：清单固定、且覆盖全部 7 个 reason', () => {
  it('状态清单恰好 12 个且顺序固定（改它就要同步方案 §2.2 的表）', () => {
    expect(HIT_UI_STATES).toHaveLength(12);
    expect([...HIT_UI_STATES]).toEqual([
      'idle',
      'connecting',
      'ok',
      'multi',
      'not-found',
      'not-visible',
      'iframe-only',
      'login-required',
      'unsupported',
      'timeout',
      'failed',
      'session-ended',
    ]);
  });

  it('7 个 reason 全部能落到某个状态（无孤立 reason）', () => {
    const seen = new Set<string>();
    for (const reason of ALL_REASONS) {
      const v = hitViewOf({ result: result(facts({ reason })) });
      seen.add(v.state);
      expect(v.state).not.toBe('idle');
    }
    // ok 拆两档，其余 6 个各一档
    expect(seen.size).toBe(7);
  });

  it('每个状态都有一个可达的输入（没有永远触发不到的分支）', () => {
    const reachable = new Set<string>();
    reachable.add(hitViewOf({}).state);
    reachable.add(hitViewOf({ busy: true }).state);
    reachable.add(hitViewOf({ fail: { error: 'x', code: 'c' } }).state);
    reachable.add(hitViewOf({ session: session({ open: false }) }).state);
    for (const reason of ALL_REASONS) {
      reachable.add(hitViewOf({ result: result(facts({ reason })) }).state);
      if (reason === 'ok') reachable.add(hitViewOf({ result: result(facts({ reason, total: 3 })) }).state);
    }
    expect([...reachable].sort()).toEqual([...HIT_UI_STATES].sort());
  });
});

describe('优先级：busy > fail > reason > 会话已结束 > 未开始', () => {
  it('请求在飞时即使有旧结果也显示连接中', () => {
    const v = hitViewOf({ busy: true, result: result(facts({ reason: 'ok' })) });
    expect(v.state).toBe('connecting');
    expect(v.verdict).toContain('正在连接浏览器');
  });

  it('失败压过旧结果，且**不携带任何命中事实**（[A2-4]）', () => {
    const v = hitViewOf({
      fail: { error: '浏览器起来了但没拿到调试端口（DevToolsActivePort 未生成），请重试', code: 'dap-timeout' },
      result: result(facts({ reason: 'ok', total: 4 })),
    });
    expect(v.state).toBe('failed');
    expect(v.facts).toBeUndefined();
    expect(v.error?.code).toBe('dap-timeout');
    expect(v.verdict).toContain('点验没跑起来');
    // 失败态不许出现「0 个命中」这类数字结论
    expect(v.verdict).not.toMatch(/命中\s*\d/);
  });

  it('not-visible 优先于 ok（两者条件在契约里重叠）', () => {
    expect(hitViewOf({ result: result(facts({ reason: 'not-visible', total: 1, visible: false })) }).state)
      .toBe('not-visible');
    expect(hitViewOf({ result: result(facts({ reason: 'ok', total: 1, visible: false })) }).state).toBe('ok');
  });

  it('会话已结束只在「确实有过会话」时显示；从没连过是未开始', () => {
    expect(hitViewOf({ session: session({ open: false, sessionId: 'sid-1' }) }).state).toBe('session-ended');
    expect(hitViewOf({ session: session({ open: false, sessionId: '' }) }).state).toBe('idle');
  });
});

describe('逐字文案', () => {
  it('多命中 = 「匹配到 3 个，框的是第 1 个；第一个可见」', () => {
    const v = hitViewOf({ result: result(facts({ reason: 'ok', total: 3 })) });
    expect(v.state).toBe('multi');
    expect(v.verdict).toBe('匹配到 3 个，框的是第 1 个；第一个可见');
    expect(v.tag.text).toBe('命中 3');
    expect(v.tag.cls).toBe('is-heur');
  });

  it('多命中且第一个不可见 → 后半句跟着变', () => {
    const v = hitViewOf({ result: result(facts({ reason: 'ok', total: 2, visible: false })) });
    expect(v.verdict).toBe('匹配到 2 个，框的是第 1 个；第一个不可见');
  });

  it('命中数触顶时追加「已截断到 50」，不合并进数字', () => {
    const v = hitViewOf({ result: result(facts({ reason: 'ok', total: 50, truncated: true })) });
    expect(v.verdict).toBe('匹配到 50 个，框的是第 1 个；第一个可见（已截断到 50）');
  });

  it('单命中 = 「命中 1 个，第一个可见」', () => {
    expect(hitViewOf({ result: result(facts({ reason: 'ok' })) }).verdict).toBe('命中 1 个，第一个可见');
  });

  it('iframe-only 报出 iframe 数量，并且明说不支持', () => {
    const v = hitViewOf({ result: result(facts({ found: false, total: 0, iframes: 2, reason: 'iframe-only' })) });
    expect(v.state).toBe('iframe-only');
    expect(v.verdict).toContain('页面有 2 个 iframe');
    expect(v.verdict).toContain('本版不进 iframe');
  });

  it('unsupported 只说不支持，绝不出现「通过 / 已验证 / 等价」这类结论词', () => {
    const v = hitViewOf({ result: result(facts({ found: false, total: 0, reason: 'unsupported' })) });
    expect(v.state).toBe('unsupported');
    expect(v.verdict).toContain('暂不支持浏览器点验');
    expect(v.verdict).not.toMatch(/通过|已验证|等价/);
  });

  it('两条常驻说明含 shadow DOM 明确不支持（[N-2]）与试跑/点验分工（[A2-14]）', () => {
    expect(HIT_NOTE_IFRAME).toContain('iframe');
    expect(HIT_NOTE_IFRAME).toContain('shadow DOM');
    expect(HIT_NOTE_IFRAME).toContain('Playwright 试跑');
    expect(HIT_NOTE_TRIAL).toContain('以试跑为准');
  });
});

describe('主按钮文案按状态变', () => {
  it('未开始 → ▶ 校验；连接中 → 校验中…；会话已结束 → 重新开始', () => {
    expect(runLabelOf('idle')).toBe('▶ 校验');
    expect(runLabelOf('connecting')).toBe('校验中…');
    expect(runLabelOf('session-ended')).toBe('重新开始');
  });

  it('需要登录 / 超时 / 失败都给「再来一次」语义的文案', () => {
    expect(runLabelOf('login-required')).toBe('再点一次');
    expect(runLabelOf('timeout')).toBe('重试');
    expect(runLabelOf('failed')).toBe('重试');
  });

  it('有结论的状态都是「重新校验」', () => {
    for (const s of ['ok', 'multi', 'not-found', 'not-visible', 'iframe-only', 'unsupported'] as const) {
      expect(runLabelOf(s)).toBe('重新校验');
    }
  });
});
