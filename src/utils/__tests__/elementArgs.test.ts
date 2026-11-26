import { describe, it, expect } from 'vitest';
import {
  BUDGET,
  ERR,
  KINDS,
  MASK,
  MAX_ITEMS,
  PROFILE_DIR_NAME,
  RESULT_SENTINEL,
  buildDeps,
  buildTrialScript,
  computeBudget,
  isInsideProfile,
  maskPath,
  parseTrialOutput,
  profileDirOf,
  pwChainPlan,
  summarizeChildError,
  validateTrialArgs,
} from '../../../electron/element-args.js';

/**
 * 元素库 · 定位/试跑的纯函数层（1.36.0 / B8，契约 §12.6 / §12.7，裁定 Q4 / Q5）。
 *
 * 这一层之所以要被单测锁死，是因为它守着四条**不能靠肉眼验**的规则：
 *   ① 上限文案是契约文本（`items > 20` 的固定文案）；
 *   ② 临时脚本的结构（`launchPersistentContext` / `channel:'chrome'` / `trial:true` / 哨兵）——
 *      没有 playwright 的机器上「跑起来没报错」根本证明不了这些；
 *   ③ 三段超时预算的上限不许被调用方突破；
 *   ④ profile 的**路径包含性**（本方案唯一删目录的动作，属安全红线）。
 */

const CSS = { kind: 'css', locator: '#login' };
const okArgs = (over: Record<string, unknown> = {}) => ({
  dir: 'C:/work/pw',
  url: 'https://example.com/a',
  items: [CSS],
  ...over,
});

describe('validateTrialArgs：入参校验（文案是契约的一部分）', () => {
  it('合法入参 → ok，并回 withStyle/budget', () => {
    const r = validateTrialArgs(okArgs({ withStyle: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.url).toBe('https://example.com/a');
    expect(r.items).toEqual([{ kind: 'css', locator: '#login' }]);
    expect(r.withStyle).toBe(true);
    expect(r.budget.launch).toBe(BUDGET.launch);
  });

  it('items > 20 → 固定文案「一次最多校验 20 个元素」（逐字）', () => {
    const items = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ kind: 'css', locator: `#a${i}` }));
    const r = validateTrialArgs(okArgs({ items }));
    expect(r).toEqual({ ok: false, error: '一次最多校验 20 个元素' });
  });

  it('恰好 20 条 → 仍可跑（边界不许提前一天红）', () => {
    const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({ kind: 'css', locator: `#a${i}` }));
    const r = validateTrialArgs(okArgs({ items }));
    expect(r.ok).toBe(true);
  });

  it('空 items / 缺 dir / 非 http(s) url → 各自固定文案', () => {
    expect(validateTrialArgs(okArgs({ items: [] }))).toEqual({ ok: false, error: ERR.noItems });
    expect(validateTrialArgs(okArgs({ dir: '  ' }))).toEqual({ ok: false, error: ERR.emptyDir });
    expect(validateTrialArgs(okArgs({ url: 'ftp://x/y' }))).toEqual({ ok: false, error: ERR.badUrl });
    expect(validateTrialArgs(okArgs({ url: 'example.com' }))).toEqual({ ok: false, error: ERR.badUrl });
  });

  it('locator 空 / 超 500 字符 → 拒绝（超长会让临时脚本爆掉）', () => {
    expect(validateTrialArgs(okArgs({ items: [{ kind: 'css', locator: '   ' }] }))).toEqual({ ok: false, error: ERR.emptyLocator });
    const long = { kind: 'xpath', locator: `//div[${'a'.repeat(500)}]` };
    expect(validateTrialArgs(okArgs({ items: [long] }))).toEqual({ ok: false, error: ERR.longLocator });
  });

  it('未知策略 → 拒绝并带上那个值', () => {
    const r = validateTrialArgs(okArgs({ items: [{ kind: 'id', locator: '#a' }] }));
    expect(r).toEqual({ ok: false, error: '未知的定位方式：id' });
  });

  it('role 必须有 roleName；roleName 也有上限', () => {
    expect(validateTrialArgs(okArgs({ items: [{ kind: 'role', locator: '登录' }] }))).toEqual({ ok: false, error: ERR.roleNeedsName });
    const longRole = { kind: 'role', locator: '登录', roleName: 'x'.repeat(101) };
    expect(validateTrialArgs(okArgs({ items: [longRole] }))).toEqual({ ok: false, error: ERR.longRoleName });
    const good = validateTrialArgs(okArgs({ items: [{ kind: 'role', locator: '登录', roleName: 'button' }] }));
    expect(good.ok).toBe(true);
  });

  it('五种策略都认（css / xpath / text / role / pw）', () => {
    expect(KINDS).toEqual(['css', 'xpath', 'text', 'role', 'pw']);
    for (const kind of KINDS) {
      const item = kind === 'role' ? { kind, locator: '确定', roleName: 'button' } : { kind, locator: '#a' };
      expect(validateTrialArgs(okArgs({ items: [item] })).ok).toBe(true);
    }
  });

  it('缺省 kind 当 css（历史元素可能没写 kind）', () => {
    const r = validateTrialArgs(okArgs({ items: [{ locator: '#a' }] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].kind).toBe('css');
  });
});

describe('computeBudget：三段预算上限（Q5）', () => {
  it('缺省 = launch 15s / goto 15s / items 20s / total 50s / 单条 2s', () => {
    const b = computeBudget(undefined);
    expect(b).toEqual({ launch: 15000, goto: 15000, items: 20000, total: 50000, trialItem: 2000 });
  });

  it('调用方给的 timeoutMs 只能收紧总预算，不能突破单段上限', () => {
    const tighter = computeBudget(12000);
    expect(tighter.total).toBe(12000);
    expect(tighter.launch).toBeLessThanOrEqual(BUDGET.launch);
    expect(tighter.goto).toBeLessThanOrEqual(BUDGET.goto);

    const huge = computeBudget(10 ** 9);
    expect(huge.total).toBe(BUDGET.total); // 50s 是硬顶，调用方写多大都不行
    expect(huge.launch).toBe(BUDGET.launch);
    expect(huge.goto).toBe(BUDGET.goto);
    expect(huge.items).toBe(BUDGET.items);
  });

  it('给得太小 / 脏值 → 落到下限或被忽略，绝不回 0/NaN', () => {
    const tiny = computeBudget(1);
    expect(tiny.total).toBe(5000);
    expect(tiny.items).toBeGreaterThan(0);
    for (const v of ['abc', null, {}, -1, Number.NaN]) {
      const b = computeBudget(v);
      expect(Number.isFinite(b.total)).toBe(true);
      expect(b.total).toBeGreaterThan(0);
      expect(b.items).toBeGreaterThan(0);
    }
  });
});

describe('buildTrialScript：临时 .mjs 的结构（不跑浏览器也要能验）', () => {
  const script = buildTrialScript({
    url: 'https://example.com/x',
    items: [{ kind: 'css', locator: '#login' }, { kind: 'pw', locator: 'getByRole("button")' }],
    withStyle: true,
    budget: computeBudget(0),
  });

  it('用持久 profile + 真 Chrome + 有头（三条写死，不许混用自带 Chromium）', () => {
    expect(script).toContain('chromium.launchPersistentContext(PROFILE');
    expect(script).toContain("channel: 'chrome'");
    expect(script).toContain('headless: false');
    expect(script).toContain('PM_EL_PROFILE');
  });

  it('试跑用 click({ trial: true })（只做可操作性检查，不真点）', () => {
    expect(script).toContain('click({ trial: true');
    expect(script).toContain('BUDGET.trialItem');
  });

  it('四种策略的取值方式都在；pw 链原样当 Playwright 表达式用', () => {
    expect(script).toContain("page.locator('xpath=' + it.locator)");
    expect(script).toContain("page.locator('text=' + it.locator)");
    expect(script).toContain('page.getByRole(it.roleName, { name: it.locator })');
    expect(script).toContain('page.locator(it.locator)');
  });

  it('登录态单独成一个字段（不许把「需要登录」报成 0 命中）', () => {
    expect(script).toContain('input[type="password"]');
    expect(script).toContain('loginRequired');
    expect(script).toContain('loginRequired: true');
  });

  it('结果带哨兵打 stdout，且含 hit / visible / trial / 截图 / 样式', () => {
    expect(script).toContain(RESULT_SENTINEL);
    expect(script).toContain('loc.count()');
    expect(script).toContain('isVisible()');
    expect(script).toContain('first.screenshot({ path: shot');
    expect(script).toContain('getComputedStyle');
    expect(script).toContain('shotPath');
  });

  it('withStyle 才读样式；入参里的 URL 与 locator 被原样嵌入（JSON 转义，不是拼字符串）', () => {
    expect(script).toContain('if (INPUT.withStyle)');
    expect(script).toContain('https://example.com/x');
    expect(script).toContain('getByRole');
    const off = buildTrialScript({ url: 'https://e.com', items: [{ kind: 'css', locator: '#login' }], withStyle: false });
    expect(off).toContain('withStyle": false');
  });

  it('脚本不 import 本仓库任何模块（主进程与子进程边界：只 import playwright/node:）', () => {
    const imports = script.match(/^import .*$/gm) || [];
    expect(imports.length).toBeGreaterThanOrEqual(4);
    for (const line of imports) {
      expect(line).toMatch(/^import .* from '(playwright|node:[a-z]+)';$/);
    }
  });

  it('逐条上报（超时才能拿回已完成部分）：emit 至少 4 处（登录/逐条/收尾/异常）', () => {
    const count = (script.match(/\bemit\(/g) || []).length;
    expect(count).toBeGreaterThanOrEqual(4);
    expect(script).toContain('results.push(row);');
    // 逐条上报紧跟在 push 之后，中间不许插入 return/break
    const afterPush = script.slice(script.indexOf('results.push(row);'), script.indexOf('results.push(row);') + 220);
    expect(afterPush).toContain('emit({');
  });

  it('超时/异常路径也会打一条结果（否则主进程只能拿到空 stdout）', () => {
    expect(script).toContain('catch (e)');
    expect(script).toContain('finally');
    expect(script).toContain('ctx.close()');
  });
});

describe('parseTrialOutput：只认哨兵后的最后一条 JSON', () => {
  it('混着 Playwright 日志时也能取出结果', () => {
    const stdout = `[pw] launching\nnoise\n${RESULT_SENTINEL}{"results":[{"hit":1}],"ms":42}\nmore noise\n`;
    expect(parseTrialOutput(stdout)).toEqual({ results: [{ hit: 1 }], ms: 42 });
  });

  it('没有哨兵 / 半截 JSON / 非对象 → null（宁可回「没拿到结果」也不许编）', () => {
    expect(parseTrialOutput('plain log only')).toBeNull();
    expect(parseTrialOutput(`${RESULT_SENTINEL}{"results":`)).toBeNull();
    expect(parseTrialOutput(`${RESULT_SENTINEL}"just a string"`)).toBeNull();
    expect(parseTrialOutput('')).toBeNull();
  });
});

describe('profile 目录：命名 + 路径包含性（本方案唯一删目录的动作）', () => {
  const dir = 'C:/work/pw';

  it('固定拼在 <工作目录>/.pm-profile；空目录 → 空串（绝不对根路径动手）', () => {
    expect(profileDirOf(dir).endsWith(PROFILE_DIR_NAME)).toBe(true);
    expect(profileDirOf('')).toBe('');
  });

  it('profile 自身与它内部的路径算命中', () => {
    const base = profileDirOf(dir);
    expect(isInsideProfile(dir, base)).toBe(true);
    expect(isInsideProfile(dir, `${base}/Default/Cache`)).toBe(true);
    expect(isInsideProfile(dir, `${base}/`)).toBe(true);
  });

  it('外部路径 / 上级目录 / 相似前缀 / 工作目录本身 → 一律拒绝', () => {
    for (const t of [
      'C:/Windows',
      'C:/Windows/System32',
      'C:/work',
      'C:/work/pw2/.pm-profile',
      'C:/work/pw/.pm-profile-evil',
      'D:/work/pw/.pm-profile',
      '../outside/.pm-profile',
      '../../etc',
      '',
    ]) {
      expect(isInsideProfile(dir, t)).toBe(false);
    }
  });

  it('`..` 会被 resolve 归一：`<dir>/.pm-profile/../.pm-profile` 归一后合法', () => {
    const base = profileDirOf(dir);
    expect(isInsideProfile(dir, `${base}/../.pm-profile`)).toBe(true);
    expect(isInsideProfile(dir, `${base}/../../secret`)).toBe(false);
  });
});

describe('pwChainPlan：pw 链只走白名单解析（不 eval、不拼接代码）', () => {
  it('常见链解析成「方法名 + 字面量参数」的结构化计划', () => {
    expect(pwChainPlan("page.getByRole('button', { name: '登录' }).click()")).toEqual({
      ok: true,
      plan: [{ name: 'getByRole', args: ['button', { name: '登录' }] }],
    });
    expect(pwChainPlan("getByText('确定')")).toEqual({ ok: true, plan: [{ name: 'getByText', args: ['确定'] }] });
    expect(pwChainPlan("page.locator('.dup').nth(2)")).toEqual({
      ok: true,
      plan: [{ name: 'locator', args: ['.dup'] }, { name: 'nth', args: [2] }],
    });
  });

  it('尾巴上的动作被丢掉（试跑不真点），filter/first 保留', () => {
    const p = pwChainPlan("page.getByRole('button',{name:'x'}).filter({ hasText: '提交' }).first().click()");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.plan.map((s) => s.name)).toEqual(['getByRole', 'filter', 'first']);
  });

  it('含变量 / 字符串拼接 / 分号 / 注入载荷 / 未知方法 → 一律拒绝（报 skip，不硬跑）', () => {
    for (const bad of [
      'page.locator(sel)',
      "page.getByText('a' + b)",
      "page.getByText('a'); process.exit(1) //",
      "page.locator('x').count()",
      'page.locator(`#${id}`)',
      "page.locator('x').evaluate(() => 1)",
      '',
    ]) {
      const r = pwChainPlan(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(ERR.pwUnsupported);
    }
  });

  it('注入载荷不会被当成代码：解析结果里不含分号 / process', () => {
    const r = pwChainPlan("page.getByText('a'); process.exit(1) //");
    expect(JSON.stringify(r)).not.toContain('process.exit');
  });

  it('validateTrialArgs 把失败的那条标成 skipReason（不是抛错，也不是 0 命中）', () => {
    const r = validateTrialArgs(okArgs({ items: [{ kind: 'pw', locator: 'page.locator(sel)' }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.items[0].skipReason).toBe(ERR.pwUnsupported);
    expect(r.items[0].pwPlan).toBeUndefined();
  });
});

describe('summarizeChildError：把 stderr 归纳成一句人话（且脱敏）', () => {
  it('缺 playwright → 给的是「装什么」，不是内部栈行', () => {
    const stderr = 'node:internal/modules/package_json_reader:314\n  throw new ERR_MODULE_NOT_FOUND(\nError [ERR_MODULE_NOT_FOUND]: Cannot find package \'playwright\' imported from C:\\a\\b';
    const msg = summarizeChildError(stderr);
    expect(msg).toContain('npm i -D playwright');
    expect(msg).not.toContain('package_json_reader');
  });

  it('其它错误挑真正的错误行，且把盘符路径抹成 <路径>', () => {
    const msg = summarizeChildError('some noise\nTimeoutError: page.goto: Timeout 15000ms exceeded at C:\\Users\\me\\x.mjs\nat more()');
    expect(msg).toContain('TimeoutError');
    expect(msg).not.toMatch(/[A-Za-z]:\\/);
    expect(msg).not.toContain('some noise');
  });

  it('空 stderr / 只有噪声 → 空串（调用方据此回固定兜底文案）', () => {
    expect(summarizeChildError('')).toBe('');
    expect(summarizeChildError('   \n  ')).toBe('');
  });
});

describe('maskPath / buildDeps：不回真实绝对路径（Q4 硬约束①）', () => {
  it('maskPath：自己 → <工作目录>；内部 → <工作目录>/相对；外部 → <其他路径>', () => {
    expect(maskPath('C:/work/pw', 'C:/work/pw')).toBe(MASK);
    expect(maskPath('C:/work/pw', 'C:/work/pw/.pm-profile')).toBe(`${MASK}/.pm-profile`);
    expect(maskPath('C:/work/pw', 'C:/Windows/System32')).toBe('<其他路径>');
    // 一个真实的盘符 / 用户名都不许漏
    expect(maskPath('C:/work/pw', 'C:/Windows/System32')).not.toMatch(/[A-Za-z]:/);
  });

  it('两盏灯永远都在；缺 node → 红 + 可执行提示', () => {
    const d = buildDeps({ workDir: 'C:/work/pw', nodePath: null, playwrightOk: false });
    expect(d.lamps.map((l) => l.id)).toEqual(['node', 'playwright']);
    expect(d.ready).toBe(false);
    const node = d.lamps[0];
    expect(node.state).toBe('red');
    expect(node.detail).toBe(ERR.noNode);
    expect(node.fixHint).toBeTruthy();
  });

  it('两盏都绿才算 ready；且 dir 已脱敏（不含盘符）', () => {
    const d = buildDeps({ workDir: 'C:/work/pw', nodePath: 'C:/Program Files/nodejs/node.exe', playwrightOk: true });
    expect(d.ready).toBe(true);
    expect(d.dir).toBe(MASK);
    expect(JSON.stringify(d)).not.toMatch(/[A-Za-z]:\\|[A-Za-z]:\//);
    expect(d.lamps.every((l) => l.state === 'green')).toBe(true);
  });

  it('playwright 缺失时给的是「装什么」而不是「再试一次」', () => {
    const d = buildDeps({ workDir: 'C:/work/pw', nodePath: 'node.exe', playwrightOk: false });
    const pw = d.lamps[1];
    expect(pw.state).toBe('red');
    expect(pw.fixHint).toContain('npm i -D playwright');
  });
});

