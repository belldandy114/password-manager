import { describe, it, expect } from 'vitest';
import {
  APPROX_KINDS,
  ERR_HIT,
  HIT_BUDGET,
  HIT_KINDS,
  HIT_PROFILE_DIR_NAME,
  HIT_REASONS,
  HIT_SCRIPT,
  IMPLICIT_ROLE_NAMES,
  MAX_TOTAL,
  VISIBLE_PREDICATE_SRC,
  buildHitScriptArgs,
  buildLaunchArgs,
  commandHasProfile,
  computeHitBudget,
  devToolsPortPath,
  hitProfileDirOf,
  isApproxKind,
  isBrowserProcessName,
  isCreationAfter,
  isHttpUrl,
  isInsideHitProfile,
  isInsidePath,
  normalizeHitFacts,
  normalizeKind,
  parseBrowserWsPath,
  parseDevToolsPort,
  pickKillable,
  pidFilePath,
  pwPlanOf,
  splitRoleSelector,
  supportsHitTest,
  validateHitTestArgs,
} from '../../../electron/hit-args.js';
// C-09：上限的单一真源在 element-args（这里只 import 断言同值，不改它）
import { MAX_ROLE_NAME_LEN as EL_MAX_ROLE_NAME_LEN, MAX_LOCATOR_LEN as EL_MAX_LOCATOR_LEN } from '../../../electron/element-args.js';
import {
  MAX_ROLE_NAME_LEN as HIT_MAX_ROLE_NAME_LEN,
  MAX_LOCATOR_LEN as HIT_MAX_LOCATOR_LEN,
  parsePowerShellDate,
  pickProcShell,
  queryFailureOf,
} from '../../../electron/hit-args.js';
// AR-3 漂移门的另一半：kind 清单的**真源**（TS 侧）。这里只 import、不改它。
import { POM_LOCATOR_KINDS } from '../codegen/pageobject';

/**
 * 元素库 A₂ · CDP 点验的纯函数层（契约 [A2-2][A2-3][A2-6][A2-7][A2-8][A2-9][A2-10]）。
 *
 * 这一层被单测锁死的理由：它守着五条**不能靠肉眼验**的规则 ——
 *   ① 页内脚本的只读边界（不碰凭证、不读整页文本、不写页面状态）；
 *   ② `visible` 口径（[A2-3]：opacity:0 仍算可见）—— 与上游 isVisible 相反；
 *   ③ 端口协商（只认 DevToolsActivePort 第一行、禁 --remote-debugging-address、禁探空闲端口）；
 *   ④ kill 前的进程双校验（未通过的 pid 绝不进 taskkill）；
 *   ⑤ 入参 9 步校验的**文案与顺序**（文案是契约，用户看的就这几句）。
 */
describe('hit-args · 页内脚本只读边界（[A2-7]）', () => {
  it('不含凭证类存储与整页文本读取的标识符', () => {
    for (const word of ['cookie', 'localStorage', 'sessionStorage', 'innerHTML', 'innerText']) {
      expect(HIT_SCRIPT).not.toContain(word);
    }
  });

  it('不发起任何网络请求、不写页面状态、不滚动、不点击', () => {
    for (const word of ['fetch(', 'XMLHttpRequest', 'scrollIntoView', '.click(', 'dispatchEvent', 'setAttribute', 'document.write']) {
      expect(HIT_SCRIPT).not.toContain(word);
    }
  });

  it('不进 iframe / shadow DOM（[N-2]：跨文档查不了也不该查）', () => {
    expect(HIT_SCRIPT).not.toContain('shadowRoot');
    expect(HIT_SCRIPT).not.toContain('contentDocument');
    // 但仍要数主文档的 iframe 个数（给 reason='iframe-only'）
    expect(HIT_SCRIPT).toContain("getElementsByTagName('iframe')");
  });

  it('定位值只经 arguments 进来（脚本里没有任何拼串痕迹）', () => {
    expect(HIT_SCRIPT).toContain('JSON.parse(String(argsJson))');
    // 模板里不该再有未替换的插值占位
    expect(HIT_SCRIPT).not.toContain('${');
    expect(buildHitScriptArgs({ kind: 'css', locator: '#a' })).toBe('{"kind":"css","locator":"#a","roleName":""}');
  });

  it('只用白名单里的页面 API（DOM 查询 / getClientRects / getComputedStyle）', () => {
    expect(HIT_SCRIPT).toContain('querySelectorAll');
    expect(HIT_SCRIPT).toContain('getClientRects');
    expect(HIT_SCRIPT).toContain('getComputedStyle');
    expect(HIT_SCRIPT).toContain('document.evaluate');
  });
});

describe('hit-args · visible 判据（[A2-3]，与上游口径相反的地方）', () => {
  /** 直接把注入脚本里那一行源码拉出来执行 —— 测的是**生产用的那段源码**，不是镜像函数 */
  const predicate = new Function('el', 'vis', `return ${VISIBLE_PREDICATE_SRC}`) as (
    el: { getClientRects: () => unknown[] },
    vis: string
  ) => boolean;

  it('零尺寸 / 没有 box → 不可见', () => {
    expect(predicate({ getClientRects: () => [] }, 'visible')).toBe(false);
  });

  it('visibility:hidden → 不可见（判据逐字取 [A2-3]，不含 collapse —— 契约只写了 hidden）', () => {
    expect(predicate({ getClientRects: () => [{}] }, 'hidden')).toBe(false);
    // 判据文本本身就是契约：多一个字符都不行（否则「按契约」只是口头的）
    expect(VISIBLE_PREDICATE_SRC).toBe("el.getClientRects().length > 0 && vis !== 'hidden'");
  });

  it('有 box 且 visibility:visible → 可见', () => {
    expect(predicate({ getClientRects: () => [{}] }, 'visible')).toBe(true);
  });

  it('**opacity:0 仍算可见**（[A2-3] 逐字；上游 isVisible 判不可见，那是另一套口径）', () => {
    // 只给一个带 opacity:0 的元素，判据里根本不该出现 opacity（出现了就说明照搬了上游）
    const el = { getClientRects: () => [{}], style: { opacity: '0' }, opacity: 0 };
    expect(predicate(el as unknown as { getClientRects: () => unknown[] }, 'visible')).toBe(true);
    expect(VISIBLE_PREDICATE_SRC).not.toContain('opacity');
  });
});

describe('hit-args · 隐式角色表（[A2-7]：只认 8 个）', () => {
  it('恰好 8 条，且就是契约列的那 8 个', () => {
    expect(IMPLICIT_ROLE_NAMES.length).toBe(8);
    expect([...IMPLICIT_ROLE_NAMES].sort()).toEqual(
      ['button', 'checkbox', 'combobox', 'heading', 'img', 'link', 'radio', 'textbox'].sort()
    );
  });

  it('页内脚本里那张表与常量同步（改一处不改另一处 = 漂移）', () => {
    expect(HIT_SCRIPT).toContain(`var IMPLICIT = ${JSON.stringify(IMPLICIT_ROLE_NAMES)};`);
  });
});

describe('hit-args · 定位方式归一（[A0-3] / [A2-2] 第 6 步）', () => {
  it('10 个合法值原样返回', () => {
    for (const k of HIT_KINDS) expect(normalizeKind(k)).toBe(k);
    expect(HIT_KINDS.length).toBe(10);
  });

  /**
   * AR-3（review-arch 的 P1）：`HIT_KINDS` 是本仓库第三份 kind 清单（真源是 TS 的
   * `POM_LOCATOR_KINDS`，CJS 层因运行时 require 不到 TS 只能有副本）。
   *
   * 老断言只锁「长度 = 10 + normalizeKind 自反」——那是**只锁基数、不锁集合**：
   * 把 `title` 换成 `titel`、或整体换成另外 10 个词，都能过。后果是扩 kind 时
   * `normalizeKind` 静默降级成 css、`supportsHitTest` 恒 true，用户只会看到「没命中」。
   *
   * 现在两条断言：**有序相等**（顺序也是契约，与 POM_LOCATOR_KINDS 逐项一致）
   * + **排序后集合相等**（顺序有意义的解释留给上面那条；这一条防「换个顺序但集合对」被漏掉）。
   */
  it('与 POM_LOCATOR_KINDS 同源：有序相等 + 集合相等（AR-3 漂移门）', () => {
    const tsIds = POM_LOCATOR_KINDS.map((k) => k.id);
    expect(HIT_KINDS).toEqual(tsIds); // 有序：顺序变了也红
    expect([...HIT_KINDS].sort()).toEqual([...tsIds].sort()); // 集合：删一项/换一项必红
    expect(new Set(HIT_KINDS).size).toBe(tsIds.length); // 无重复项（长度对但重复也红）
  });

  it('supportsHitTest 只认清单内的值：未知 kind 不再恒 true（AR-3 的另一半）', () => {
    for (const k of HIT_KINDS) expect(supportsHitTest(k)).toBe(true);
    // 脏值 / 未来新增但没同步过来的 kind / 空值 → false（老实现因为先 normalizeKind 而恒 true）
    for (const bad of ['shadow', 'titel', '', '   ', undefined, null]) {
      expect(supportsHitTest(bad)).toBe(false);
    }
    // 与 normalizeKind 的分工仍在：脏值进流程会当 css（[A2-2] 第 6 步），但「支持吗」要如实回 false
    expect(normalizeKind('shadow')).toBe('css');
    expect(supportsHitTest('shadow')).toBe(false);
  });

  it('无值 / 空串 / 大小写 / 脏值 一律当 css（绝不抛异常）', () => {
    for (const bad of [undefined, null, '', '   ', 'CSS', ' Css ', 'shadow', 123, {}]) {
      expect(normalizeKind(bad)).toBe('css');
    }
  });

  it('不做「以 / 开头就当 xpath」的推断（与上游同一条明确否定）', () => {
    expect(normalizeKind('//div[@id="x"]')).toBe('css');
  });

  it('text / role / pw 是近似口径（approx:true）', () => {
    expect(isApproxKind('text')).toBe(true);
    expect(isApproxKind('role')).toBe(true);
    expect(isApproxKind('pw')).toBe(true);
    expect(isApproxKind('css')).toBe(false);
    expect(APPROX_KINDS).toEqual(['text', 'role', 'pw']);
    expect(supportsHitTest('css')).toBe(true);
  });
  it('role 定位器按第一个冒号切成「角色:可访问名」', () => {
    expect(splitRoleSelector('button:登录')).toEqual({ role: 'button', name: '登录' });
    expect(splitRoleSelector('button:登录:备注')).toEqual({ role: 'button', name: '登录:备注' });
    expect(splitRoleSelector('button')).toEqual({ role: 'button', name: '' });
  });
});

describe('hit-args · 入参 9 步校验（[A2-2]：文案与顺序是契约）', () => {
  const okCtx = { unlocked: true, findElement: () => ({ kind: 'css', locator: '#login' }) };

  it('① op 不在三值内 → 固定文案', () => {
    expect(validateHitTestArgs({ op: 'run' } as unknown as { op: 'verify' }, okCtx)).toEqual({
      ok: false,
      error: '未知的点验操作：run',
      code: 'bad-op',
    });
  });

  it('② status / stop 跳过 3-8（不需要 url 与定位器）', () => {
    expect(validateHitTestArgs({ op: 'status' }, {})).toEqual({ ok: true, op: 'status', plan: null });
    expect(validateHitTestArgs({ op: 'stop' }, {})).toEqual({ ok: true, op: 'stop', plan: null });
    // 缺省 op = verify
    const v = validateHitTestArgs({ url: 'https://example.com', locator: '#a', kind: 'css' }, okCtx);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.op).toBe('verify');
  });

  it('③ 两组来源都给 / 都不给 → 同一句文案', () => {
    const msg = '请给出要验的元素：pageId + elementId，或 locator + kind';
    expect(validateHitTestArgs({ url: 'https://a.example', locator: '#a', pageId: 'p', elementId: 'e' }, okCtx)).toEqual({
      ok: false,
      error: msg,
      code: 'bad-source',
    });
    expect(validateHitTestArgs({ url: 'https://a.example' }, okCtx)).toEqual({ ok: false, error: msg, code: 'bad-source' });
    // 只给一半也算「来源不成立」
    expect(validateHitTestArgs({ url: 'https://a.example', pageId: 'p' }, okCtx)).toEqual({
      ok: false,
      error: msg,
      code: 'bad-source',
    });
  });

  it('④ 只放行 http/https：file:// / chrome:// / devtools:// / javascript: 全拒', () => {
    for (const bad of [
      'file:///C:/x.html',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'about:blank',
      '',
    ]) {
      const r = validateHitTestArgs({ url: bad, locator: '#a', kind: 'css' }, okCtx);
      expect(r).toEqual({ ok: false, error: '请输入 http/https 开头的地址', code: 'bad-url' });
    }
    for (const good of ['http://example.com', 'https://example.com/a?b=1']) {
      expect(isHttpUrl(good)).toBe(true);
      expect(validateHitTestArgs({ url: good, locator: '#a', kind: 'css' }, okCtx).ok).toBe(true);
    }
  });

  it('⑤ 定位值为空 / 超过 500 字 → 各自固定文案', () => {
    expect(validateHitTestArgs({ url: 'https://a.example', locator: '   ', kind: 'css' }, okCtx)).toEqual({
      ok: false,
      error: '定位器不能为空',
      code: 'empty-locator',
    });
    const long = validateHitTestArgs({ url: 'https://a.example', locator: 'x'.repeat(501), kind: 'css' }, okCtx);
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.code).toBe('long-locator');
  });

  it('⑥ 脏 kind 一律当 css，**不报错**（与 el:trial-run 的 badKind 口径有意不同）', () => {
    const r = validateHitTestArgs({ url: 'https://a.example', locator: '#a', kind: 'shadow' }, okCtx);
    expect(r.ok).toBe(true);
    if (r.ok && r.plan) expect(r.plan.kind).toBe('css');
  });

  it('⑦ role 必须有可访问名，且不超过 40 字（C-09：与渲染层同一个上限）', () => {
    expect(validateHitTestArgs({ url: 'https://a.example', locator: 'button', kind: 'role' }, okCtx)).toEqual({
      ok: false,
      error: '「角色（role）」定位必须填写可访问名', // C-13：用户文案里不再出现字段名 roleName
      code: 'role-needs-name',
    });
    // 40 正好可过、41 被拦（边界两侧都钉住）
    expect(
      validateHitTestArgs(
        { url: 'https://a.example', locator: 'button', kind: 'role', roleName: 'x'.repeat(40) },
        okCtx
      ).ok
    ).toBe(true);
    const long = validateHitTestArgs(
      { url: 'https://a.example', locator: 'button', kind: 'role', roleName: 'x'.repeat(41) },
      okCtx
    );
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.code).toBe('long-role-name');
  });

  it('⑨ 未解锁 → 固定文案（含「未解锁」），且**不能**误报「元素不存在」', () => {
    const r = validateHitTestArgs({ url: 'https://a.example', pageId: 'p', elementId: 'e' }, { unlocked: false, findElement: () => ({}) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('locked');
      expect(r.error).toBe(ERR_HIT.locked);
      expect(r.error).toContain('未解锁');
    }
  });

  it('⑧ 已解锁但元素不存在 → 固定文案', () => {
    const r = validateHitTestArgs({ url: 'https://a.example', pageId: 'p', elementId: 'missing' }, {
      unlocked: true,
      findElement: () => null,
    });
    expect(r).toEqual({ ok: false, error: '这条元素在元素库中不存在（可能已被删除）', code: 'not-in-vault' });
  });

  it('来源一取到元素时，用**库里的真值**建计划（不是调用方给的）', () => {
    const r = validateHitTestArgs({ url: 'https://a.example', pageId: 'p', elementId: 'e' }, {
      unlocked: true,
      findElement: () => ({ kind: 'role', locator: 'button', role: '登录' }),
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.plan) {
      expect(r.plan.source).toBe('vault');
      expect(r.plan.kind).toBe('role');
      expect(r.plan.locator).toBe('button');
      expect(r.plan.roleName).toBe('登录');
    }
  });

  it('pw 链：能解析且方法都在白名单里才算支持，否则给既有文案', () => {
    expect(pwPlanOf("page.getByRole('button', { name: '登录' })").ok).toBe(true);
    const bad = pwPlanOf('page.locator(x).click()');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe(ERR_HIT.pwUnsupported);
  });
});

describe('hit-args · 超时预算（[A2-6]：调用方只能压小）', () => {
  it('超大的 timeoutMs 也压到 30000', () => {
    expect(computeHitBudget(999999).total).toBe(HIT_BUDGET.total);
    expect(computeHitBudget(600000).total).toBe(30000);
  });

  it('太小的抬到下限 5000（防止一调就超时）', () => {
    expect(computeHitBudget(100).total).toBe(5000);
  });

  it('缺省时返回三段写死上限', () => {
    expect(computeHitBudget()).toEqual({ total: 30000, launch: 15000, attach: 10000, query: 5000 });
    expect(computeHitBudget().launch).toBe(HIT_BUDGET.launch);
  });
});

describe('hit-args · 端口协商（[A2-8]：只认 DevToolsActivePort 第一行）', () => {
  it('第一行是端口，第二行是 browser 端点路径（两者分开解析）', () => {
    const text = '5778\n/devtools/browser/abc-123\n';
    expect(parseDevToolsPort(text)).toBe(5778);
    expect(parseBrowserWsPath(text)).toBe('/devtools/browser/abc-123');
  });

  it('第一行不是正整数 → null（0 / 非数字 / 空都算没就绪）', () => {
    expect(parseDevToolsPort('0\n/devtools/browser/x')).toBe(null);
    expect(parseDevToolsPort('devtools/browser/x')).toBe(null);
    expect(parseDevToolsPort('')).toBe(null);
    expect(parseDevToolsPort('-1')).toBe(null);
  });

  it('第二行不是 browser 端点 → 空串（防止拿 page 端点去发 Browser.close）', () => {
    expect(parseBrowserWsPath('5778\n/devtools/page/XYZ')).toBe('');
    expect(parseBrowserWsPath('5778')).toBe('');
  });

  it('启动参数只有五个，且**没有** --remote-debugging-address（上游 buildLaunchArgs:759 有，本项目明禁）', () => {
    const args = buildLaunchArgs({ profileDir: 'C:\\d\\el-hit-profile', url: 'https://example.com' });
    expect(args).toEqual([
      '--remote-debugging-port=0',
      '--user-data-dir=C:\\d\\el-hit-profile',
      '--no-first-run',
      '--no-default-browser-check',
      'https://example.com',
    ]);
    expect(args.join(' ')).not.toContain('--remote-debugging-address');
    // 也不许出现「指定具体端口」的写法（探空闲端口那套是 TOCTOU）
    expect(args.join(' ')).not.toMatch(/--remote-debugging-port=(?!0)\d/);
  });

  it('没有 profileDir 直接抛（参数错误要早暴露，不许静默用用户默认 profile）', () => {
    expect(() => buildLaunchArgs({ url: 'https://example.com' } as unknown as { profileDir: string })).toThrow(TypeError);
  });
});

describe('hit-args · profile 与路径包含性（[A2-9]）', () => {
  it('profile 目录固定名，落在数据目录下', () => {
    expect(HIT_PROFILE_DIR_NAME).toBe('el-hit-profile');
    expect(hitProfileDirOf('C:\\data')).toBe('C:\\data\\el-hit-profile');
    expect(hitProfileDirOf('')).toBe('');
  });

  it('DevToolsActivePort / pid 账本都在 profile 里', () => {
    expect(devToolsPortPath('C:\\d\\p')).toBe('C:\\d\\p\\DevToolsActivePort');
    expect(pidFilePath('C:\\d\\p')).toBe('C:\\d\\p\\pm-hit.pid');
  });

  it('包含性：自身与子路径通过，前缀相同的兄弟目录与 .. 逃逸不通过', () => {
    expect(isInsidePath('C:\\a\\b', 'C:\\a\\b')).toBe(true);
    expect(isInsidePath('C:\\a\\b', 'C:\\a\\b\\c')).toBe(true);
    expect(isInsidePath('C:\\a\\b', 'C:\\a\\b-c')).toBe(false);
    expect(isInsidePath('C:\\a\\b', 'C:\\a\\b\\..\\c')).toBe(false);
    expect(isInsidePath('', 'C:\\a')).toBe(false);
  });

  it('点验 profile 的包含性判定只认自己算出来的那个目录', () => {
    const dir = hitProfileDirOf('C:\\data');
    expect(isInsideHitProfile('C:\\data', dir)).toBe(true);
    expect(isInsideHitProfile('C:\\data', `${dir}\\x`)).toBe(true);
    expect(isInsideHitProfile('C:\\data', 'C:\\data\\.pm-profile')).toBe(false);
    expect(isInsideHitProfile('C:\\data', 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data')).toBe(false);
  });
});

describe('hit-args · kill 前的进程双校验（[A2-10]：未通过的绝不进 taskkill）', () => {
  const profileDir = 'C:\\data\\el-hit-profile';

  it('进程名白名单（大小写不敏感）', () => {
    expect(isBrowserProcessName('msedge.exe')).toBe(true);
    expect(isBrowserProcessName('CHROME.EXE')).toBe(true);
    expect(isBrowserProcessName('chromium.exe')).toBe(true);
    expect(isBrowserProcessName('notepad.exe')).toBe(false);
    expect(isBrowserProcessName('chrome')).toBe(false);
    expect(isBrowserProcessName('')).toBe(false);
  });

  it('命令行判 profile 之前先归一（引号 / 正斜杠 / 大小写）', () => {
    expect(commandHasProfile('"C:\\...\\chrome.exe" --user-data-dir="C:\\data\\el-hit-profile"', profileDir)).toBe(true);
    expect(commandHasProfile('chrome.exe --user-data-dir=C:/data/el-hit-profile', profileDir)).toBe(true);
    expect(commandHasProfile('C:\\DATA\\EL-HIT-PROFILE', profileDir)).toBe(true);
    expect(commandHasProfile('chrome.exe --user-data-dir="C:\\data\\其他-profile"', profileDir)).toBe(false);
    expect(commandHasProfile('', profileDir)).toBe(false);
  });

  it('创建时间要晚于（允许 2s 抖动）会话开始', () => {
    expect(isCreationAfter('2026-11-27T10:00:01', '2026-11-27T10:00:00')).toBe(true);
    expect(isCreationAfter('2026-11-27T10:00:00', '2026-11-27T10:00:00')).toBe(true);
    expect(isCreationAfter('2026-11-20T10:00:00', '2026-11-27T10:00:00')).toBe(false);
    // 取不到时间 → false（宁可少杀，不许错杀）
    expect(isCreationAfter('', '2026-11-27T10:00:00')).toBe(false);
  });

  it('夹具断言：不合规的进程全部进 skipped，只有三项全过的进 ours', () => {
    const procs = [
      { pid: 101, name: 'chrome.exe', cmd: `"chrome.exe" --user-data-dir="${profileDir}"`, creation: '2026-11-27T10:00:05' },
      { pid: 102, name: 'notepad.exe', cmd: `notepad C:\\data\\el-hit-profile`, creation: '2026-11-27T10:00:05' },
      { pid: 103, name: 'chrome.exe', cmd: `"chrome.exe" --user-data-dir="C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data"` },
      { pid: 104, name: 'msedge.exe', cmd: `msedge.exe --user-data-dir="${profileDir}"`, creation: '2026-11-01T09:00:00' },
      { pid: 0, name: 'chrome.exe', cmd: 'whatever' },
    ];
    const r = pickKillable(procs, { profileDir, startedAt: '2026-11-27T10:00:00' });
    expect(r.ours.map((p) => p.pid)).toEqual([101]);
    expect(r.skipped.map((p) => p.pid)).toEqual([102, 103, 104, 0]);
    // 每条 skipped 都带理由（界面/日志要能说清「为什么没动这个 pid」）
    for (const s of r.skipped) expect(String(s.why).length).toBeGreaterThan(4);
    expect(r.skipped[1].why).toContain('命令行里没有本次 profile');
  });
});

describe('hit-args · 事实归一（[A2-3]：7 个 reason 各自只对应一种事实）', () => {
  const meta = { kind: 'css', locator: '#a', source: 'draft' as const };

  it('total=0 且无 iframe、非登录页 → not-found', () => {
    expect(normalizeHitFacts({ total: 0, iframes: 0, login: false }, meta).reason).toBe('not-found');
  });

  it('total=0 但有 iframe → iframe-only（不许说成「没命中」）', () => {
    const f = normalizeHitFacts({ total: 0, iframes: 2, login: false }, meta);
    expect(f.reason).toBe('iframe-only');
    expect(f.iframes).toBe(2);
  });

  it('total=0 且是登录页 → login-required', () => {
    expect(normalizeHitFacts({ total: 0, iframes: 0, login: true }, meta).reason).toBe('login-required');
  });

  it('total>0 但不可见 → not-visible；可见 → ok', () => {
    expect(normalizeHitFacts({ total: 3, visible: false }, meta).reason).toBe('not-visible');
    expect(normalizeHitFacts({ total: 3, visible: true }, meta).reason).toBe('ok');
  });

  it('页内判不支持（pw）→ unsupported，且不因为 total=0 被吞成 not-found', () => {
    expect(normalizeHitFacts({ total: 0, unsupported: true }, meta).reason).toBe('unsupported');
    expect(normalizeHitFacts({ total: 0 }, { ...meta, reason: 'unsupported' }).reason).toBe('unsupported');
  });

  it('total 截到 50 并置 truncated（[A2-1] 上限）', () => {
    const f = normalizeHitFacts({ total: 60, visible: true }, meta);
    expect(f.total).toBe(MAX_TOTAL);
    expect(f.truncated).toBe(true);
    expect(normalizeHitFacts({ total: 3, visible: true }, meta).truncated).toBe(false);
  });

  it('label 截 40 字且去掉换行（页面文本只回界面，不落盘）', () => {
    const f = normalizeHitFacts({ total: 1, visible: true, label: 'a\nb\tc' + 'x'.repeat(60) }, meta);
    expect(f.label.length).toBe(40);
    expect(f.label).not.toContain('\n');
    expect(f.label.startsWith('a b c')).toBe(true);
  });

  it('inIframe 恒为 false（[N-2]），found 由 total 推出来', () => {
    expect(normalizeHitFacts({ total: 2, visible: true, inIframe: true }, meta).inIframe).toBe(false);
    expect(normalizeHitFacts({ total: 2, visible: true }, meta).found).toBe(true);
    expect(normalizeHitFacts({ total: 0 }, meta).found).toBe(false);
  });

  it('approx 由 kind 判定（text / role / pw），并保留来源与回显字段', () => {
    expect(normalizeHitFacts({ total: 0 }, { ...meta, kind: 'text' }).approx).toBe(true);
    expect(normalizeHitFacts({ total: 0 }, { ...meta, kind: 'css' }).approx).toBe(false);
    const f = normalizeHitFacts({ total: 0 }, { ...meta, source: 'vault', pageId: 'p', elementId: 'e', roleName: '登录' });
    expect(f.source).toBe('vault');
    expect(f.pageId).toBe('p');
    expect(f.elementId).toBe('e');
    expect(f.roleName).toBe('登录');
  });

  it('页面返回脏数据（负数 / 字符串 / null）一律收敛，不抛', () => {
    expect(normalizeHitFacts({ total: -5, iframes: 'x' }, meta).total).toBe(0);
    expect(normalizeHitFacts(null as unknown as object, meta).reason).toBe('not-found');
    expect(normalizeHitFacts({ total: '3', visible: 'yes' }, meta).visible).toBe(false);
  });
});

describe('hit-args · C-02：PowerShell 不许写死（pwsh → powershell.exe）', () => {
  it('有 pwsh 就用 pwsh；没有就回退 powershell.exe；探测抛错也回退', () => {
    expect(pickProcShell(() => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
    expect(pickProcShell(() => '')).toBe('powershell.exe'); // Win10/11 默认没有 pwsh
    expect(pickProcShell(() => '   ')).toBe('powershell.exe');
    expect(pickProcShell(() => { throw new Error('where 挂了'); })).toBe('powershell.exe');
    expect(pickProcShell()).toBe('powershell.exe'); // 没给探测器也不许返回空
  });

  it('CreationDate 两种格式都认：ISO（pwsh 7）与 /Date(ms)/（Windows PowerShell 5.1）', () => {
    expect(parsePowerShellDate('2026-11-27T04:01:10.068Z')).toBe(Date.parse('2026-11-27T04:01:10.068Z'));
    expect(parsePowerShellDate('/Date(1795754066982)/')).toBe(1795754066982);
    expect(parsePowerShellDate('/Date(1795754066982+0800)/')).toBe(1795754066982);
    expect(Number.isNaN(parsePowerShellDate(''))).toBe(true);
    expect(Number.isNaN(parsePowerShellDate(null))).toBe(true);
  });

  it('**只换 shell 不换日期解析等于没修**：5.1 的 /Date(ms)/ 也能让 isCreationAfter 成立', () => {
    const startedAt = '2026-11-27T10:00:00.000Z';
    const justAfter = Date.parse(startedAt) + 4000;
    // 5.1 格式（老实现 Date.parse('/Date(...)/') = NaN → 恒 false → verifyProcess 恒不通过）
    expect(isCreationAfter(`/Date(${justAfter})/`, startedAt)).toBe(true);
    // ISO 格式照旧
    expect(isCreationAfter(new Date(justAfter).toISOString(), startedAt)).toBe(true);
    // 真正的「创建时间早于会话」仍要拒
    expect(isCreationAfter(`/Date(${Date.parse(startedAt) - 600000})/`, startedAt)).toBe(false);
  });
});

describe('hit-args · C-03：非法选择器不伪装成「没命中」', () => {
  it('selectorInvalid → 固定失败回执（code=query-failed），且不新增 reason 值', () => {
    expect(queryFailureOf({ selectorInvalid: true })).toEqual({
      error: '定位器写法不合法（选择器语法错误），请检查后重试',
      code: 'query-failed',
    });
    expect(queryFailureOf({ total: 0 })).toBe(null);
    expect(queryFailureOf({ total: 3, visible: true })).toBe(null);
    expect(queryFailureOf(null)).toBe(null);
    // 「不新增 reason 值」的机械判据：reason 词表仍是 7 个，query-failed 不在里面
    expect(HIT_REASONS.length).toBe(7);
    expect(HIT_REASONS).not.toContain('query-failed');
  });

  it('页内脚本不再产 invalid 字段；归一后的事实里也没有 invalid 键', () => {
    expect(HIT_SCRIPT).toContain('selectorInvalid: bad');
    // 裸 `invalid:` 作为对象键不该再出现（老实现 invalid: bad === 'selector'）
    expect(/(^|[^a-zA-Z])invalid:/.test(HIT_SCRIPT)).toBe(false);
    const facts = normalizeHitFacts({ total: 1, visible: true }, { kind: 'css', locator: '#a' });
    expect('invalid' in facts).toBe(false);
    expect(Object.keys(facts)).not.toContain('invalid');
  });
});

describe('hit-args · C-09：上限只有一个数（与 element-args 同值）', () => {
  it('role 名上限两处同值（40），定位值上限两处同值（500）', () => {
    expect(HIT_MAX_ROLE_NAME_LEN).toBe(EL_MAX_ROLE_NAME_LEN);
    expect(HIT_MAX_LOCATOR_LEN).toBe(EL_MAX_LOCATOR_LEN);
    expect(HIT_MAX_ROLE_NAME_LEN).toBe(40); // 与渲染层 validatePage / maxLength 同值
    expect(HIT_MAX_LOCATOR_LEN).toBe(500);
  });
});

describe('hit-args · SEC-01：解锁闸门对「任何来源」生效（契约 v5）', () => {
  const LOCKED = { unlocked: false, findElement: () => ({ kind: 'css', locator: '#a' }) };

  it('草稿来源在锁定态也被拦（旧实现只拦落库来源）', () => {
    const r = validateHitTestArgs({ url: 'https://a.example', locator: '#a', kind: 'css' }, LOCKED);
    expect(r).toEqual({ ok: false, error: '密码库未解锁：请先解锁再点验', code: 'locked' });
  });

  it('**顺序**：锁定态必须报「未解锁」，不许报「元素不存在」', () => {
    const r = validateHitTestArgs({ url: 'https://a.example', pageId: 'p', elementId: 'missing' }, {
      unlocked: false,
      findElement: () => null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('locked');
      expect(r.error).toBe('密码库未解锁：请先解锁再点验');
      expect(r.error).not.toContain('不存在');
    }
  });

  it('旧文案（把「用草稿绕过」写进提示里）已全仓清零', () => {
    expect(ERR_HIT.locked).toBe('密码库未解锁：请先解锁再点验');
    expect(ERR_HIT.locked).not.toContain('草稿');
  });
});

describe('hit-args · SEC-06 / SEC-07：kill 前置校验的两处加固', () => {
  const profileDir = 'C:\\data\\el-hit-profile';
  const startedAt = '2026-11-27T10:00:00.000Z';
  const goodProc = {
    pid: 5151,
    name: 'chrome.exe',
    cmd: `"chrome.exe" --user-data-dir="${profileDir}"`,
    creation: `/Date(${Date.parse(startedAt) + 4000})/`,
  };

  it('SEC-06：startedAt 为空 → 视为校验失败（宁可跳过、不杀）', () => {
    const r = pickKillable([goodProc], { profileDir, startedAt: '' });
    expect(r.ours).toEqual([]);
    expect(r.skipped.length).toBe(1);
    expect(String(r.skipped[0].why)).toContain('开始时间');
    // 有 startedAt 时同一份夹具是能过的（证明拒的是「缺时间」而不是别的）
    expect(pickKillable([goodProc], { profileDir, startedAt }).ours.map((p) => p.pid)).toEqual([5151]);
  });

  it('SEC-07：同前缀目录（el-hit-profile-backup）不再命中本 profile', () => {
    expect(commandHasProfile(`"chrome.exe" --user-data-dir="${profileDir}"`, profileDir)).toBe(true);
    expect(commandHasProfile(`"chrome.exe" --user-data-dir="${profileDir}\\Default"`, profileDir)).toBe(true);
    expect(commandHasProfile(`"chrome.exe" --user-data-dir="${profileDir}-backup"`, profileDir)).toBe(false);
    expect(commandHasProfile(`"chrome.exe" --user-data-dir="C:\\data\\xel-hit-profile"`, profileDir)).toBe(false);
    // 端到端：同前缀目录的进程不能进 ours
    const bad = { ...goodProc, pid: 6262, cmd: `"chrome.exe" --user-data-dir="${profileDir}-backup"` };
    const r = pickKillable([goodProc, bad], { profileDir, startedAt });
    expect(r.ours.map((p) => p.pid)).toEqual([5151]);
    expect(r.skipped.map((p) => p.pid)).toEqual([6262]);
  });
});
