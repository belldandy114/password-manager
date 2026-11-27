/**
 * 点验面板的**状态机与文案**（纯函数，零 React、零 DOM）。
 *
 * 为什么从 `HitTestPanel.tsx` 里拆出来：这张 12 态表是「界面与主进程事实字段的唯一映射」，
 * 它必须能被单测逐条锁死（外层组件渲染不了、也没必要为了测映射去装 jsdom）。
 * 组件只消费 `hitViewOf()` 的结果，不再自己写 if —— 否则状态判断会散成两处，必然漂移。
 *
 * 契约：`docs/契约-元素库-A0A1A2.md` [A2-3]（7 个 reason 的语义与逐字文案）/ [A2-4]（失败不带事实）；
 * 方案：`docs/方案-元素库-A0A1A2-界面.md` §2.1-§2.3。
 */

import type { ElHitFacts, ElHitSession, ElHitTestResult } from '../../types';
/* ================================================================
   状态机（纯函数，可单测；组件只做渲染与调用）
   ================================================================ */

/** 12 个 UI 状态（顺序 = 文档顺序，改动必须同步 `docs/方案-…-界面.md` §2.2 的表） */
export const HIT_UI_STATES = [
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
] as const;

export type HitUiState = (typeof HIT_UI_STATES)[number];

/** `.dev-tag` 真实存在的 5 档（redesign.css:8819-8832；**没有** `is-warn` / `is-error`） */
export interface HitTag {
  text: string;
  cls: string;
}

export interface HitView {
  state: HitUiState;
  tag: HitTag;
  /** 结论行文案（逐字；多命中包含「匹配到 N 个，框的是第 1 个」） */
  verdict: string;
  /** 只有真的查过才有（`[A2-4]`：失败态没有这个字段） */
  facts?: ElHitFacts;
  /** 只有 `failed` 有 */
  error?: { message: string; code: string };
}

/** 常驻说明行（[N-2] 与 [A2-14] 的结论句；两条都逐字定稿，别改写） */
export const HIT_NOTE_IFRAME = '点验不进 iframe / shadow DOM；这类元素请用 Playwright 试跑';
export const HIT_NOTE_TRIAL =
  '试跑验的是「Playwright 认不认」，点验验的是「我机器上现在指到哪个元素」；两者不一致时以试跑为准';

/** `reason='ok'` 的单/多命中文案。`total` 是实数，`truncated` 单独追加，不合并句子。 */
function okVerdict(total: number, visible: boolean, truncated: boolean): string {
  const tail = truncated ? '（已截断到 50）' : '';
  if (total > 1) {
    // 任务书逐字要求「匹配到 3 个，框的是第 1 个」；后半句补的是「第一个可见性」这个**另一个事实**
    // （契约 [A2-3] 的 ok 文案含它）。两句合成一行，不并列两个结论位。
    return `匹配到 ${total} 个，框的是第 1 个；第一个${visible ? '可见' : '不可见'}${tail}`;
  }
  return `命中 ${total} 个，第一个${visible ? '可见' : '不可见'}${tail}`;
}

/**
 * 事实字段 → 界面状态（**唯一**的状态判定处；组件不许自己写 if）。
 *
 * 优先级（顺序即语义，改顺序就是改行为）：
 *   busy（请求在飞）> fail（`success:false`）> result.hit.reason > session.open===false > idle
 *
 * 为什么 `not-visible` 排在 `ok` 之前：`[A2-3]` 里两者的条件重叠
 * （`ok` = `total > 0`，`not-visible` = `total > 0 && visible === false`），
 * 更具体的条件必须优先，否则「命中 1 个但不可见」会被渲染成成功态。
 */
export function hitViewOf(input: {
  busy?: boolean;
  fail?: { error: string; code?: string } | null;
  result?: ElHitTestResult | null;
  session?: ElHitSession | null;
}): HitView {
  if (input.busy) {
    return {
      state: 'connecting',
      tag: { text: '连接中', cls: 'is-unknown' },
      verdict: '正在连接浏览器（最多 30 秒）：首次会新开一个窗口，用的是它当时的登录态',
    };
  }

  if (input.fail) {
    const code = String(input.fail.code || '').trim();
    return {
      state: 'failed',
      tag: { text: '失败', cls: 'is-fail' },
      verdict: `点验没跑起来：${input.fail.error}`,
      error: { message: input.fail.error, code: code || '—' },
    };
  }

  const hit = input.result?.hit;
  if (hit) {
    switch (hit.reason) {
      case 'ok':
        return hit.total > 1
          ? {
            state: 'multi',
            tag: { text: `命中 ${hit.total}`, cls: 'is-heur' },
            verdict: okVerdict(hit.total, hit.visible, hit.truncated),
            facts: hit,
          }
          : {
            state: 'ok',
            tag: { text: '命中 1', cls: 'is-ok' },
            verdict: okVerdict(hit.total, hit.visible, hit.truncated),
            facts: hit,
          };
      case 'not-visible':
        return {
          state: 'not-visible',
          tag: { text: '命中但不可见', cls: 'is-heur' },
          verdict: '命中了但不可见（可能被折叠 / 隐藏）',
          facts: hit,
        };
      case 'not-found':
        return {
          state: 'not-found',
          tag: { text: '未命中', cls: 'is-fail' },
          verdict: '没命中：页面上找不到这条定位器',
          facts: hit,
        };
      case 'iframe-only':
        return {
          state: 'iframe-only',
          tag: { text: '不支持 iframe', cls: 'is-unknown' },
          verdict: `主文档没命中，但页面有 ${hit.iframes} 个 iframe；本版不进 iframe（iframe / shadow DOM 不支持）`,
          facts: hit,
        };
      case 'login-required':
        return {
          state: 'login-required',
          tag: { text: '需要登录', cls: 'is-heur' },
          verdict: '页面需要登录：在打开的浏览器里登录后再点一次',
          facts: hit,
        };
      case 'unsupported':
        return {
          state: 'unsupported',
          tag: { text: '暂不支持', cls: 'is-unknown' },
          verdict: '这条定位器暂不支持浏览器点验（请在 Playwright 试跑里验证）',
          facts: hit,
        };
      case 'timeout':
      default:
        return {
          state: 'timeout',
          tag: { text: '超时', cls: 'is-heur' },
          verdict: '点验超时（已返回已完成的事实），请重试',
          facts: hit,
        };
    }
  }

  if (input.session && input.session.open === false && String(input.session.sessionId || '') !== '') {
    // sessionId 非空 = 「确实有过一次会话，现在结束了」；从没连过（sessionId 为 '' ）应留在 idle，
    // 否则一进页面就显示「会话已结束」，看起来像刚失败过。
    return {
      state: 'session-ended',
      tag: { text: '会话已结束', cls: 'is-unverified' },
      verdict: '会话已结束（浏览器已关闭）；再点「▶ 校验」会重新拉起',
    };
  }

  return {
    state: 'idle',
    tag: { text: '未开始', cls: 'is-unverified' },
    verdict: '还没验过：点「▶ 校验」会在你的浏览器里打开这个地址，并把命中的元素框出来',
  };
}

/** 主按钮文案（按状态变；其余按钮固定） */
export function runLabelOf(state: HitUiState): string {
  if (state === 'connecting') return '校验中…';
  if (state === 'session-ended') return '重新开始';
  if (state === 'login-required') return '再点一次';
  if (state === 'timeout' || state === 'failed') return '重试';
  if (state === 'idle') return '▶ 校验';
  return '重新校验';
}
