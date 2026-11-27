'use strict';

/**
 * element-args.js —— 「元素库 · 定位/试跑」的**纯函数**层（1.36.0 / B8）。
 *
 * 为什么单独一层：本域有四类**必须可单测**的规则，放在 IPC 文件里就只能端到端验：
 *   1. 入参校验（items ≤ 20、locator ≤ 500、策略枚举）—— 文案是契约的一部分；
 *   2. 临时 `.mjs` 脚本的内容构造（判据：结构对不对，不是「跑起来没报错」）；
 *   3. 三段超时预算（launch / goto / items / total）；
 *   4. profile 目录的**路径包含性判定**（本方案唯一的删除目录动作，属安全红线）。
 *
 * 本模块不碰 fs / electron / 进程，只用 `path` 做纯字符串计算，所以能直接被 vitest 引用。
 *
 * ⚠️ 主进程**不得** `require('playwright')`：Playwright 只在子进程里由 node 解析。
 * 本文件因此只生成脚本文本，不 import 任何浏览器库。
 */

const path = require('path');

/** 一次最多校验多少条（Q5 定稿：>20 直接拒，文案固定） */
const MAX_ITEMS = 20;
/** 单条 locator 的字符上限 */
const MAX_LOCATOR_LEN = 500;
/**
 * role 可访问名的字符上限（**与渲染层同一个数**）。
 *
 * C-09（review-code P2）：这里原来是 100，而 `pomModel.validatePage` 与元素表的输入框都是 40 ——
 * 同一条元素「界面能填 40、主进程放到 100」，两处结论不同。现在统一取 **40**（写端更严的那一边），
 * 渲染层两处保持不变即自动一致。
 */
const MAX_ROLE_NAME_LEN = 40;
/**
 * 支持的定位策略（`pw` = 原样存的 Playwright 链）。
 *
 * 契约 [A0-5]：这份清单**不是**第二份手写真源 —— 顺序与取值必须与
 * `src/utils/codegen/pageobject.ts` 的 `POM_LOCATOR_KINDS` 逐项相等（A₀ 扩到 10 值），
 * `src/utils/__tests__/elementArgs.test.ts` 的 parity 单测会 red。
 * 为什么必须扩：界面按生成器清单渲染下拉，能把 10 种都发到 `el:trial-run`；
 * 这里少一种，运行期就回「未知的定位方式」——A₀ 在试跑这条路径上等于没生效（真实 live bug）。
 */
const KINDS = ['css', 'xpath', 'text', 'role', 'pw', 'label', 'placeholder', 'alttext', 'title', 'testid'];

/**
 * 三段超时预算（Q5 定稿：launch ≤15s / goto ≤15s / items ≤20s / 总 ≤50s；单条 trial 2s）。
 * 三个分段时间是**脚本内**自己用的（Playwright 的 timeout 参数）；`total` 是**主进程**的硬上限
 * （超了 taskkill 进程树，把已拿到的结果退回）。
 */
const BUDGET = Object.freeze({
  launch: 15000,
  goto: 15000,
  items: 20000,
  total: 50000,
  trialItem: 2000,
});

/** 持久 profile 的固定子目录名（登录态就存这里；不进 vault / 备份 / 导出） */
const PROFILE_DIR_NAME = '.pm-profile';
/** 临时脚本前缀（写完立即删；名字随机防撞） */
const SCRIPT_PREFIX = '.pm-el-trial-';
/** 子进程往 stdout 打结果的哨兵（stdout 里还会混着 Playwright 的日志） */
const RESULT_SENTINEL = '@@PM_EL@@';

/** 契约里写死的文案（单测逐字锁，改文案必须同时改测试） */
const ERR = {
  noItems: '请至少选择一个元素',
  tooManyItems: `一次最多校验 ${MAX_ITEMS} 个元素`,
  badUrl: '请输入 http/https 开头的地址',
  emptyLocator: '定位器不能为空',
  longLocator: `定位器最多 ${MAX_LOCATOR_LEN} 个字符`,
  badKind: (k) => `未知的定位方式：${k}`,
  roleNeedsName: '「角色（role）」定位必须填写可访问名',
  longRoleName: `role 名称最多 ${MAX_ROLE_NAME_LEN} 个字符`,
  emptyDir: '请先选择 Playwright 工作目录',
  busy: '正在运行，请稍候',
  noNode: '没找到 Node.js 运行时（node 命令不可用）',
  profileOutside: `拒绝清理：只允许删 <工作目录>/${PROFILE_DIR_NAME}`,
  profileTarget: `只允许清理 <工作目录>/${PROFILE_DIR_NAME}，收到的是外部路径`,
  pwUnsupported: '这条 Playwright 链含动态部分，暂不能自动试跑（请在 Playwright 里手验）',
};

/**
 * `pw` 链允许出现的方法名（白名单）。
 *
 * 为什么必须是白名单 + 结构化解析、而不是把用户那条链**拼**进脚本：
 * `pw` 的 locator 是用户自己粘进来的文本，直接拼进生成的 `.mjs` 就是**代码注入**
 * （`getByText('a'); process.exit(1);//` 这种）。所以这里把链解析成
 * `{ name, args }`，参数只接受「字符串 / 数字 / `{ name | hasText: 字符串 }`」，
 * 再用 `JSON.stringify` 重新序列化——拼进去的永远是字面量，不是代码。
 */
const PW_METHODS = ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByTestId', 'first', 'last', 'nth', 'filter'];
/** 尾巴上的动作一律丢掉（试跑只做可操作性检查，不真点） */
const PW_ACTION_TAIL = /\.(click|dblclick|fill|press|check|uncheck|hover|selectOption|type|clear|tap|focus|pressSequentially)\s*\([\s\S]*$/;


/** 脱敏占位（Q4 硬约束①：`el:deps` 不回真实绝对路径） */
const MASK = '<工作目录>';

/** 判断一个值是不是「非空、且不是纯空白」的字符串 */
const isStr = (v) => typeof v === 'string' && v.trim() !== '';

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * 路径脱敏：只允许回 `<工作目录>` 或其内部相对后缀，绝不回真实盘符 / 用户名。
 * 不在工作目录下的路径一律回 `<其他路径>`（连长度都不泄露）。
 *
 * @param {string} workDir 用户选的工作目录
 * @param {string} target 要展示的路径
 * @returns {string}
 */
function maskPath(workDir, target) {
  const base = str(workDir);
  const t = str(target);
  if (!t) return MASK;
  if (!base) return MASK;
  let rel = '';
  try {
    rel = path.relative(path.resolve(base), path.resolve(t));
  } catch {
    return MASK;
  }
  if (rel === '') return MASK;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return '<其他路径>';
  return `${MASK}/${rel.replace(/\\/g, '/')}`;
}

/**
 * 把一条调用拆成 `{ name, argsRaw }`：支持 `a(x).b(y)` 这种链，参数里允许括号与引号。
 * 拆不出来就返回 null（调用方据此回「暂不能自动试跑」）。
 *
 * @param {string} src
 * @returns {Array<{ name: string, argsRaw: string }>|null}
 */
function splitCalls(src) {
  const text = String(src || '').trim();
  if (!text) return null;
  const calls = [];
  let i = 0;
  while (i < text.length) {
    const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(i));
    if (!m) return null;
    const name = m[1];
    let depth = 0;
    let quote = '';
    let j = i + m[0].length - 1; // 指向 '('
    let end = -1;
    for (; j < text.length; j += 1) {
      const ch = text[j];
      if (quote) {
        if (ch === '\\') { j += 1; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) return null;
    calls.push({ name, argsRaw: text.slice(i + m[0].length, end) });
    i = end + 1;
    if (i >= text.length) break;
    if (text[i] !== '.') return null;
    i += 1;
  }
  return calls.length ? calls : null;
}

/** 把参数原文解析成安全的字面量（字符串 / 数字 / `{ name|hasText: 字符串 }`）；不认识的返回 undefined */
function parseLiteralArgs(argsRaw) {
  const raw = String(argsRaw || '').trim();
  if (!raw) return [];
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let k = 0; k < raw.length; k += 1) {
    const ch = raw[k];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += raw[k + 1] || ''; k += 1; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);

  const values = [];
  for (const part of parts) {
    const p = part.trim();
    if (!p) return undefined;
    const str = /^(['"])([\s\S]*)\1$/.exec(p);
    if (str) { values.push(str[2]); continue; }
    const tpl = /^`([^`$]*)`$/.exec(p);
    if (tpl) { values.push(tpl[1]); continue; }
    if (/^-?\d+(\.\d+)?$/.test(p)) { values.push(Number(p)); continue; }
    const obj = /^\{\s*([\s\S]*?)\s*\}$/.exec(p);
    if (!obj) return undefined;
    const kv = {};
    for (const pair of obj[1].split(',')) {
      const m = /^\s*(name|hasText)\s*:\s*(['"])([\s\S]*?)\2\s*$/.exec(pair);
      if (!m) return undefined;
      kv[m[1]] = m[3];
    }
    values.push(kv);
  }
  return values;
}

/**
 * 把「元素库原样存的 Playwright 链」翻译成生成脚本里的一条**表达式**（白名单，绝不 eval）。
 *
 * 例：`page.getByRole('button', { name: '登录' }).click()` → `page.getByRole("button", { "name": "登录" })`
 *
 * 做不到（含变量、模板插值、`filter({ has })`、未知方法…）就回 `{ ok:false, reason }`，
 * 由上层记成 `trial:'skip'` + 明确文案 —— **不许**当成「0 命中」，也不许硬拼进脚本。
 *
 * @param {string} chain
 * @returns {{ ok: true, expr: string } | { ok: false, reason: string }}
 */
function pwChainPlan(chain) {
  const src = String(chain || '').trim().replace(/^page\./, '').replace(PW_ACTION_TAIL, '');
  if (!src) return { ok: false, reason: ERR.pwUnsupported };
  // 先挡掉一眼就知道是动态的写法（变量、模板插值、箭头函数、分号、解构……）
  if (/[;`$]|=>|\.\.\.|\bfunction\b|\bprocess\b|\brequire\b|\bimport\b/.test(src)) {
    return { ok: false, reason: ERR.pwUnsupported };
  }
  const calls = splitCalls(src);
  if (!calls) return { ok: false, reason: ERR.pwUnsupported };
  /** 结构化计划：`[{ name, args }]`。子进程按计划**逐个 apply**，全程没有代码拼接。 */
  const plan = [];
  for (const call of calls) {
    if (!PW_METHODS.includes(call.name)) return { ok: false, reason: ERR.pwUnsupported };
    const args = parseLiteralArgs(call.argsRaw);
    if (!args) return { ok: false, reason: ERR.pwUnsupported };
    if (call.name === 'locator') {
      if (args.length !== 1 || typeof args[0] !== 'string') return { ok: false, reason: ERR.pwUnsupported };
    }
    if (call.name.startsWith('getBy')) {
      // getByRole(role, options) 是两参；其余 getByX(text) 是一参
      const second = args[1];
      const secondOk = args.length === 1 || (args.length === 2 && second && typeof second === 'object' && !Array.isArray(second));
      if (typeof args[0] !== 'string' || !secondOk) return { ok: false, reason: ERR.pwUnsupported };
    }
    if (call.name === 'filter' && (args.length !== 1 || typeof args[0] !== 'object')) return { ok: false, reason: ERR.pwUnsupported };
    if (call.name === 'nth' && (args.length !== 1 || typeof args[0] !== 'number')) return { ok: false, reason: ERR.pwUnsupported };
    if ((call.name === 'first' || call.name === 'last') && args.length !== 0) return { ok: false, reason: ERR.pwUnsupported };
    plan.push({ name: call.name, args });
  }
  return { ok: true, plan };
}

/**
 * profile 目录的固定位置：`<工作目录>/.pm-profile`。
 * @param {string} workDir
 * @returns {string}
 */
function profileDirOf(workDir) {
  const base = str(workDir);
  if (!base) return '';
  return path.join(path.resolve(base), PROFILE_DIR_NAME);
}

/**
 * 路径包含性校验（Q4 硬约束②）。
 *
 * 实现刻意**不是**「字符串拼接后 startsWith」：先 `path.resolve` 归一（消掉 `..`、重复分隔符、
 * 末尾反斜杠），再比较 `=== ` 或 `startsWith(base + path.sep)`，最后用 `path.relative` 反证一次。
 * 只用于判断「调用方传进来的 target 是否落在 `<工作目录>/.pm-profile` 里」；
 * **真正的删除目标永远由本函数自己算**（`profileDirOf`），不删调用方给的路径。
 *
 * @param {string} workDir 工作目录
 * @param {string} target 调用方给的路径
 * @returns {boolean}
 */
function isInsideProfile(workDir, target) {
  const base = profileDirOf(workDir);
  if (!base) return false;
  return isInsidePath(base, target);
}

/**
 * 通用路径包含性校验（[A2-9]：从 `isInsideProfile` 抽出来，供点验 profile 复用同一算法）。
 *
 * 实现刻意**不是**「字符串拼接后 startsWith」：先 `path.resolve` 归一（消掉 `..`、重复分隔符、
 * 末尾反斜杠），再比较 `===` 或 `startsWith(base + path.sep)`，最后用 `path.relative` 反证一次。
 * **真正的删除目标永远由调用方自己算**，不删外部给的路径。
 *
 * @param {string} base 基准目录（绝对路径）
 * @param {string} target 待判定路径
 * @returns {boolean}
 */
function isInsidePath(base, target) {
  const b = str(base);
  const t = str(target);
  if (!b || !t) return false;
  let resolvedBase;
  let resolved;
  try {
    resolvedBase = path.resolve(b);
    resolved = path.resolve(t);
  } catch {
    return false;
  }
  const eq = resolved === resolvedBase;
  const inside = resolved.startsWith(resolvedBase + path.sep);
  if (!eq && !inside) return false;
  // 反证：归一后的相对路径不许以 .. 开头（防 win32 大小写/尾分隔符的边缘差异）
  const rel = path.relative(resolvedBase, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 三段超时预算：用调用方给的 `timeoutMs`（可选）压总上限，但**单段上限写死不让突破**。
 * @param {unknown} timeoutMs
 * @returns {{ launch: number, goto: number, items: number, total: number, trialItem: number }}
 */
function computeBudget(timeoutMs) {
  const asked = Number(timeoutMs);
  const total = Number.isFinite(asked) && asked > 0
    ? Math.min(BUDGET.total, Math.max(5000, Math.floor(asked)))
    : BUDGET.total;
  const launch = Math.min(BUDGET.launch, total);
  const goto = Math.min(BUDGET.goto, total);
  const items = Math.min(BUDGET.items, Math.max(0, total - launch));
  return { launch, goto, items: items || BUDGET.trialItem, total, trialItem: BUDGET.trialItem };
}

/**
 * 校验 `el:trial-run` 的入参。
 *
 * 错误一律**返回**而不是抛（IPC 层要回 `{ success:false, error }`，抛出去会变成未捕获异常）。
 * 文案全部走 `ERR`，单测逐字锁。
 *
 * @param {any} input
 * @returns {{ ok: true, url: string, dir: string, items: Array<{kind: string, locator: string, roleName?: string, name?: string}>, withStyle: boolean, budget: ReturnType<typeof computeBudget> }
 *          | { ok: false, error: string }}
 */
function validateTrialArgs(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const dir = str(raw.dir);
  if (!dir) return { ok: false, error: ERR.emptyDir };

  const url = str(raw.url);
  if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: ERR.badUrl };

  const items = Array.isArray(raw.items) ? raw.items : [];
  if (!items.length) return { ok: false, error: ERR.noItems };
  if (items.length > MAX_ITEMS) return { ok: false, error: ERR.tooManyItems };

  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] && typeof items[i] === 'object' ? items[i] : {};
    const kind = str(it.kind) || 'css';
    if (!KINDS.includes(kind)) return { ok: false, error: ERR.badKind(kind) };
    const locator = typeof it.locator === 'string' ? it.locator : '';
    if (!locator.trim()) return { ok: false, error: ERR.emptyLocator };
    if (locator.length > MAX_LOCATOR_LEN) return { ok: false, error: ERR.longLocator };
    const row = { kind, locator };
    if (kind === 'role') {
      const roleName = str(it.roleName);
      if (!roleName) return { ok: false, error: ERR.roleNeedsName };
      if (roleName.length > MAX_ROLE_NAME_LEN) return { ok: false, error: ERR.longRoleName };
      row.roleName = roleName;
    }
    if (kind === 'pw') {
      // 原链 → 结构化计划（白名单解析）；解析不出就标 skip（**不许**拼进脚本，也不许报成 0 命中）
      const plan = pwChainPlan(locator);
      if (plan.ok) row.pwPlan = plan.plan;
      else row.skipReason = plan.reason;
    }
    if (isStr(it.name)) row.name = str(it.name).slice(0, 200);
    out.push(row);
  }

  return { ok: true, url, dir, items: out, withStyle: raw.withStyle === true, budget: computeBudget(raw.timeoutMs) };
}

/**
 * 生成子进程要跑的临时 `.mjs` 全文。
 *
 * 契约 §12.6 的六步都在里面：`launchPersistentContext(profileDir, { channel:'chrome', headless:false })`
 * → `goto` → 逐条取 locator → `count/可见性/click({trial:true})/截图`（`withStyle` 再读 computed style）
 * → 结果 JSON 打 stdout（带哨兵）→ 主进程解析后删脚本、profile 保留。
 *
 * 登录态单独成一个字段（`loginRequired`）：契约 §12.6 明确「需登录」不许报成「选择器未命中」，
 * 所以脚本在逐条跑之前先判一次，命中就直接把 `loginRequired:true` 打回来。
 *
 * @param {{ url: string, items: any[], withStyle?: boolean, budget?: any, workDir?: string }} input
 * @returns {string} 可直接 `node xxx.mjs` 的源码
 */
function buildTrialScript(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const url = str(raw.url);
  const items = Array.isArray(raw.items) ? raw.items : [];
  const withStyle = raw.withStyle === true;
  const budget = raw.budget && typeof raw.budget === 'object' ? raw.budget : computeBudget(0);
  const payload = JSON.stringify({ url, items, withStyle }, null, 2);
  const b = JSON.stringify(budget);
  return `// 由「元素库 · 定位/试跑」即时生成，跑完就删（不进仓库、不进 vault）。
import { chromium } from 'playwright';
import os from 'node:os';
import nodePath from 'node:path';
import crypto from 'node:crypto';

const SENTINEL = ${JSON.stringify(RESULT_SENTINEL)};
const INPUT = ${payload};
const BUDGET = ${b};
const PROFILE = process.env.PM_EL_PROFILE || '';

function emit(payload) {
  // 单独一行 + 哨兵：stdout 里还混着 Playwright 自己的日志，主进程按行找最后一条
  process.stdout.write('\\n' + SENTINEL + JSON.stringify(payload) + '\\n');
}

const started = Date.now();
let ctx = null;
const results = [];

/** 每条结果都要能区分「未命中 / 需登录 / 依赖缺失」，三者文案不许混（契约 §12.6 验收 1） */
function rowOf(it, extra) {
  return Object.assign({ kind: it.kind, locator: it.locator, hit: 0, visible: false, trial: 'skip' }, extra);
}

/**
 * 按「方法名 + 字面量参数」把 pw 链在 page 上逐个 apply。
 * 这里**没有 eval、没有字符串拼代码**：计划来自纯函数层的白名单解析，
 * 参数只有字符串/数字/对象（name|hasText），子进程只做方法调用。
 */
function buildPw(page, plan) {
  let cur = page;
  for (const step of plan || []) cur = cur[step.name].apply(cur, step.args);
  return cur;
}

try {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    timeout: BUDGET.launch,
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(BUDGET.trialItem);
  await page.goto(INPUT.url, { waitUntil: 'domcontentloaded', timeout: BUDGET.goto });

  // 登录态检测：有密码框，或 URL 明显落在登录/SSO 页 → 单独回 loginRequired，不报 0 命中
  const loginRequired = await page.evaluate(() => {
    const hasPassword = !!document.querySelector('input[type="password"]');
    const looksLogin = /(login|signin|sign-in|sso|passport|auth)/i.test(String(location.href));
    return hasPassword || looksLogin;
  });
  if (loginRequired) {
    emit({ loginRequired: true, results: [], ms: Date.now() - started });
  } else {
    const deadline = started + BUDGET.items;
    for (const it of INPUT.items) {
      if (Date.now() > deadline) {
        // 条目段超预算：已跑完的照回，剩下的标 skip 并让主进程置 truncated
        results.push(rowOf(it, { trial: 'skip', error: 'items 段超时，未执行' }));
        continue;
      }
      const row = rowOf(it, {});
      if (it.skipReason) {
        // 这条链解析不出（含变量/未知方法）：如实标 skip + 文案，绝不硬拼进脚本
        row.trial = 'skip';
        row.error = it.skipReason;
        results.push(row);
        emit({ loginRequired: false, results, ms: Date.now() - started });
        continue;
      }
      try {
        let loc = null;
        if (it.kind === 'css') loc = page.locator(it.locator);
        else if (it.kind === 'xpath') loc = page.locator('xpath=' + it.locator);
        // 契约 [A0-6]：text 必须与生成物的 getByText 同源。
        // 以前是 page.locator(文本引擎前缀 + locator) —— 那是 Playwright 的文本引擎，
        // 大小写/精确度语义与 getByText 不同，结果是「试跑假红、POM 命中」（生成物用的就是 getByText）。
        else if (it.kind === 'text') loc = page.getByText(it.locator);
        // 契约 [A0-6]：role 的两个字段以前写反了（getByRole(roleName, { name: locator })）——
        // locator 才是角色（pageobject.ts 的 ariaRoleOf(el.locator)），roleName 是可访问名
        // （ElementLibTab.tsx 传的是 el.role）。参数颠倒的后果是试跑里 role 元素必然 0 命中。
        // C-08（review-code P2）：可访问名**为空时不许传 { name: '' }** —— Playwright 会把空名字
        // 当「可访问名等于空串」的过滤器，必然 0 命中，正是本批要消灭的「试跑假红」。
        // 不传 name 选项 = 只按角色匹配（与 Playwright 默认语义一致）。
        else if (it.kind === 'role') loc = page.getByRole(it.locator, (it.roleName && String(it.roleName).trim()) ? { name: it.roleName } : {});
        // A₀ 新增的 5 种语义化定位（契约 [A0-5]/[A0-7]）：与生成物的 getByXxx 同源，
        // 不许掉进 css 的 page.locator(it.locator) —— 那样 label 会被当成非法 CSS 选择器，试跑必然假红。
        else if (it.kind === 'label') loc = page.getByLabel(it.locator);
        else if (it.kind === 'placeholder') loc = page.getByPlaceholder(it.locator);
        else if (it.kind === 'alttext') loc = page.getByAltText(it.locator);
        else if (it.kind === 'title') loc = page.getByTitle(it.locator);
        else if (it.kind === 'testid') loc = page.getByTestId(it.locator);
        else loc = buildPw(page, it.pwPlan); // pw：按纯函数层给的「方法名 + 字面量参数」逐个 apply
        row.hit = await loc.count();
        if (row.hit > 0) {
          const first = loc.first();
          try { row.visible = await first.isVisible(); } catch (e) { row.visible = false; }
          try {
            await first.click({ trial: true, timeout: BUDGET.trialItem });
            row.trial = 'ok';
          } catch (e) {
            row.trial = 'fail';
            // 原文照抄，不吞不改写（契约 §12.6 验收 2）
            row.error = String((e && e.message) || e);
          }
          if (INPUT.withStyle) {
            try {
              row.style = await first.evaluate((el) => {
                const cs = getComputedStyle(el);
                return {
                  color: cs.color,
                  background: cs.backgroundColor,
                  fontSize: cs.fontSize,
                  fontWeight: cs.fontWeight,
                  display: cs.display,
                };
              });
            } catch (e) { row.style = null; }
          }
          try {
            const shot = nodePath.join(os.tmpdir(), 'pm-el-' + crypto.randomBytes(6).toString('hex') + '.png');
            await first.screenshot({ path: shot, timeout: BUDGET.trialItem });
            row.shotPath = shot;
          } catch (e) { /* 截图失败不影响命中结论 */ }
        }
      } catch (e) {
        row.trial = 'fail';
        row.error = String((e && e.message) || e);
      }
      results.push(row);
      // 逐条上报：主进程按「最后一条哨兵」取结果，于是**超时也能拿回已完成的部分**（Q4 硬约束③）
      emit({ loginRequired: false, results, ms: Date.now() - started });
    }
    emit({ loginRequired: false, results, ms: Date.now() - started });
  }
} catch (e) {
  emit({ loginRequired: false, results, ms: Date.now() - started, error: String((e && e.message) || e) });
  process.exitCode = 1;
} finally {
  if (ctx) { try { await ctx.close(); } catch (e) { /* 关不掉也要让进程退出 */ } }
}
`;
}

/**
 * 从子进程 stdout 里取最后一条结果（哨兵 + JSON）。
 * 半截 / 坏 JSON / 没有哨兵 → 一律返回 null（调用方据此回「没有拿到结果」而不是编一个）。
 *
 * @param {string} stdout
 * @returns {any|null}
 */
function parseTrialOutput(stdout) {
  const text = typeof stdout === 'string' ? stdout : '';
  const idx = text.lastIndexOf(RESULT_SENTINEL);
  if (idx < 0) return null;
  const line = text.slice(idx + RESULT_SENTINEL.length).split(/\r?\n/)[0];
  if (!line || !line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 两盏灯（node / playwright 包）。**只回脱敏后的目录**，不回任何真实绝对路径。
 *
 * @param {{ workDir: string, nodePath?: string|null, playwrightOk?: boolean|null, playwrightDetail?: string }} input
 * @returns {{ lamps: Array<{id: string, label: string, state: 'green'|'red', detail: string, fixHint?: string}>, dir: string, ready: boolean }}
 */
function buildDeps(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const workDir = str(raw.workDir);
  const nodeOk = isStr(raw.nodePath) || raw.nodePath === true;
  const pwOk = raw.playwrightOk === true;
  const lamps = [
    {
      id: 'node',
      label: 'Node.js',
      state: nodeOk ? 'green' : 'red',
      detail: nodeOk ? '已找到 node 运行时（路径已隐藏）' : ERR.noNode,
      fixHint: nodeOk ? undefined : '安装 Node.js（建议 LTS）后重启应用',
    },
    {
      id: 'playwright',
      label: 'playwright 包',
      state: pwOk ? 'green' : 'red',
      detail: pwOk
        ? (raw.playwrightLocal === true
          ? '工作目录里已安装 playwright'
          : '已找到 playwright（不在该目录的 node_modules 里，用的是上层安装）')
        : (str(raw.playwrightDetail) || '工作目录里没有 playwright 包（node_modules/playwright）'),
      fixHint: pwOk ? undefined : '在该工作目录执行 npm i -D playwright 后重试',
    },
  ];
  return {
    lamps,
    dir: maskPath(workDir, workDir),
    ready: lamps.every((l) => l.state === 'green'),
  };
}

/**
 * 把子进程 stderr 归纳成**一句能给用户看**的话（纯函数，可单测）。
 *
 * 为什么需要：直接把 stderr 第一行回渲染层会得到
 * `node:internal/modules/package_json_reader:314` 这种内部栈行——既没信息量，
 * 也可能带出本机绝对路径。这里做两件事：① 认得出「缺包」就给**可执行提示**；
 * ② 其余情况挑真正的错误行，并把盘符路径抹成 `<路径>`。
 *
 * @param {string} stderr
 * @returns {string} 已脱敏的一句话（可能为空串）
 */
function summarizeChildError(stderr) {
  const text = String(stderr || '');
  if (/ERR_MODULE_NOT_FOUND|Cannot find package 'playwright'|Cannot find module 'playwright'/i.test(text)) {
    return '这个目录里找不到 playwright 包：请在该工作目录执行 npm i -D playwright 后重试';
  }
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const picked = lines.find((l) => /^(Error|TypeError|RangeError|SyntaxError|TimeoutError)\b|^ERR_/.test(l)) || lines[0] || '';
  return picked.replace(/[A-Za-z]:\\[^\s"']*|\/[\w./-]{12,}/g, '<路径>').slice(0, 300);
}

module.exports = {
  MAX_ITEMS,
  MAX_LOCATOR_LEN,
  MAX_ROLE_NAME_LEN,
  KINDS,
  BUDGET,
  PROFILE_DIR_NAME,
  SCRIPT_PREFIX,
  RESULT_SENTINEL,
  MASK,
  ERR,
  maskPath,
  profileDirOf,
  isInsideProfile,
  isInsidePath,
  computeBudget,
  validateTrialArgs,
  buildTrialScript,
  parseTrialOutput,
  buildDeps,
  pwChainPlan,
  summarizeChildError,
};
