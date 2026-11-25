import { describe, it, expect } from 'vitest';
import { which } from '../../../electron/which.js';
import {
  ABILITY_IDS,
  PROBE_TTL_MS,
  STUB_ENV,
  probeAbilities,
  resetProbeCache,
  isChromiumExecutable,
  redactEvidenceText,
} from '../../../electron/record-probe.js';

/**
 * S2 · `electron/record-probe.js`：4 类本机能力探针 + 5 盏灯 + 60 s 缓存 + 仅测试可用探针注入口。
 *
 * 全部走 **deps 注入**（假 which / 假 exec / 假 readdir），**不起任何真实子进程**，
 * 也不读真实磁盘——否则单测会随开发机装没装 JDK 而变红。
 */

type Deps = Record<string, unknown>;

const STUB = {
  /** 一份「健康机器」的假依赖：Chrome 在 PATH 上、node 是 v22、JDK + jar 齐全、工程内装了 @playwright/test */
  healthy(overrides: Deps = {}) {
    const whichMap: Record<string, string> = {
      chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      node: 'C:/Program Files/nodejs/node.exe',
      javac: 'C:/jdk/bin/javac.exe',
      java: 'C:/jdk/bin/java.exe',
    };
    const execCalls: string[] = [];
    const deps = {
      platform: 'win32',
      homeDir: 'C:/Users/测试员',
      env: {} as Record<string, string>,
      which: (name: string) => whichMap[name] || '',
      exec: (cmd: string, args: string[]) => {
        execCalls.push([cmd, ...args].join(' '));
        if (/node/.test(cmd)) return { ok: true, out: 'v22.22.0' };
        return { ok: false, out: '' };
      },
      exists: () => true,
      readdir: (dir: string) => (dir === 'C:/proj' ? ['playwright-1.49.0.jar', 'README.md'] : ['@playwright', 'react']),
      readTextFile: () => '',
      now: () => 1000,
      isPackaged: false,
      ...overrides,
      execCalls,
      whichMap,
    };
    return deps as never as Deps & { execCalls: string[]; whichMap: Record<string, string> };
  },
};

const byId = (result: { abilities: Array<{ id: string; state: string; detail?: string; fixHint?: string; evidence?: Array<{ cmd: string; out: string }> }> }, id: string) => {
  const hit = result.abilities.find((a) => a.id === id);
  if (!hit) throw new Error(`缺少灯：${id}`);
  return hit;
};

describe('which：从 ipc-codelab.js 抽出的找程序工具（行为不变）', () => {
  it('win32 走 where、类 Unix 走 which，取第一行非空', () => {
    const seen: string[] = [];
    const win = which('chrome', {
      platform: 'win32',
      execFileSync: (cmd: string) => {
        seen.push(cmd);
        return '\r\nC:\\Program Files\\Google\\Chrome\\Application\\chrome.exe\r\n';
      },
    });
    expect(win).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(seen).toEqual(['where']);

    const seenWhich: string[] = [];
    expect(which('node', {
      platform: 'linux',
      execFileSync: (cmd: string) => {
        seenWhich.push(cmd);
        return '/usr/bin/node\n';
      },
    })).toBe('/usr/bin/node');
    expect(seenWhich).toEqual(['which']);
  });

  it('找不到 / 执行失败一律回空串（不抛）', () => {
    expect(which('nope', { platform: 'linux', execFileSync: () => { throw new Error('not found'); } })).toBe('');
    expect(which('nope', { platform: 'win32', execFileSync: () => '' })).toBe('');
  });
});

describe('record-probe：Chromium 系白名单判定（灯 chrome）', () => {
  it('白名单内可执行名认作 Chromium，Firefox 一律不认', () => {
    expect(isChromiumExecutable('chrome.exe')).toBe(true);
    expect(isChromiumExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe(true);
    expect(isChromiumExecutable('/usr/bin/msedge')).toBe(true);
    expect(isChromiumExecutable('brave.exe')).toBe(true);
    expect(isChromiumExecutable('firefox.exe')).toBe(false);
    expect(isChromiumExecutable('C:/Program Files/Mozilla Firefox/firefox.exe')).toBe(false);
    expect(isChromiumExecutable('')).toBe(false);
  });

  it('找到 Chromium → green，证据里带可执行文件', () => {
    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy());
    const chrome = byId(r, 'chrome');
    expect(chrome.state).toBe('green');
    expect(chrome.evidence?.[0].out).toContain('chrome.exe');
  });

  it('只装了 Firefox → red（不是 yellow，也不是 grey），且 detail 说清为什么不支持', () => {
    resetProbeCache();
    const deps = STUB.healthy({
      which: (name: string) => (name === 'firefox' ? 'C:/Program Files/Mozilla Firefox/firefox.exe' : ''),
      exists: () => false,
    });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const chrome = byId(r, 'chrome');
    expect(chrome.state).toBe('red');
    expect(chrome.detail).toMatch(/Chromium/);
  });

  it('一个都没有 → red，并给 fixHint（安装 Chrome / Edge）', () => {
    resetProbeCache();
    const deps = STUB.healthy({ which: () => '', exists: () => false });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(byId(r, 'chrome').state).toBe('red');
    expect(byId(r, 'chrome').fixHint).toBeTruthy();
  });
});

describe('record-probe：PATH 上的 node（不许用 process.execPath 冒充）', () => {
  it('which 找不到 node → red，且不去执行任何「自带运行时」路径', () => {
    resetProbeCache();
    const deps = STUB.healthy({ which: (name: string) => (name === 'chrome' ? 'C:/chrome.exe' : '') });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(byId(r, 'node').state).toBe('red');
    expect(deps.execCalls.filter((c: string) => /node/.test(c))).toEqual([]);
  });

  it('node v22 → green（零依赖 .mjs 的前置，[C-118]）', () => {
    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy());
    expect(byId(r, 'node').state).toBe('green');
    expect(byId(r, 'node').evidence?.[0].out).toBe('v22.22.0');
  });

  it('node v18 → yellow（装了但版本不够，不是 red）', () => {
    resetProbeCache();
    const deps = STUB.healthy({ exec: () => ({ ok: true, out: 'v18.19.0' }) });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const node = byId(r, 'node');
    expect(node.state).toBe('yellow');
    expect(node.detail).toMatch(/22/);
  });

  it('node 探测超时/报错 → red，不抛（探针整体不因单个灯失败而炸）', () => {
    resetProbeCache();
    const deps = STUB.healthy({ exec: () => ({ ok: false, out: '', timedOut: true }) });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(byId(r, 'node').state).toBe('red');
  });
});

describe('record-probe：JDK + Playwright jar 两级（灯 jdk-jar）', () => {
  it('javac + jar 都有 → green', () => {
    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy());
    expect(byId(r, 'jdk-jar').state).toBe('green');
    expect(byId(r, 'jdk-jar').evidence?.some((e) => e.out.includes('playwright-1.49.0.jar'))).toBe(true);
  });

  it('只有 JDK（缺 jar）→ yellow，且 detail 点明缺哪一级', () => {
    resetProbeCache();
    const deps = STUB.healthy({ readdir: () => ['README.md'] });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const jdk = byId(r, 'jdk-jar');
    expect(jdk.state).toBe('yellow');
    expect(jdk.detail).toMatch(/jar/);
  });

  it('只有 jar（缺 javac）→ yellow', () => {
    resetProbeCache();
    const deps = STUB.healthy({ which: (n: string) => (n === 'javac' ? '' : n === 'chrome' ? 'C:/chrome.exe' : n === 'node' ? 'C:/node.exe' : '') });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(byId(r, 'jdk-jar').state).toBe('yellow');
  });

  it('都没有 → red', () => {
    resetProbeCache();
    const deps = STUB.healthy({ which: () => '', readdir: () => [], exists: () => false });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(byId(r, 'jdk-jar').state).toBe('red');
  });
});

describe('record-probe：工程内 @playwright/test（灯 playwright）', () => {
  it('装了 → green', () => {
    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy());
    expect(byId(r, 'playwright').state).toBe('green');
  });

  it('没装 → red，fixHint 给出安装命令', () => {
    resetProbeCache();
    const deps = STUB.healthy({ exists: (p: string) => !p.includes('@playwright') });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const pw = byId(r, 'playwright');
    expect(pw.state).toBe('red');
    expect(pw.fixHint).toMatch(/@playwright\/test/);
  });

  it('只有 @playwright/* 其它子包（没装 @playwright/test）→ red，不能判绿（RA2-07 假绿）', () => {
    resetProbeCache();
    // 只装了 experimental-utils：判「node_modules/@playwright 目录存在」就会假绿
    const deps = STUB.healthy({
      exists: (p: string) => p.includes('experimental-utils') || !p.includes('@playwright'),
    });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(byId(r, 'playwright').state).toBe('red');
    // 判据必须落在包的**具体路径**上：node_modules/@playwright/test
    expect(byId(r, 'playwright').evidence?.[0].cmd).toMatch(/@playwright\/test/);
  });
});

describe('record-probe：灯 5 workspace —— 未选目录必须 grey（J-6）', () => {
  it('未选工程目录 → grey（不是 red，也不是 green）', () => {
    resetProbeCache();
    const r = probeAbilities({}, STUB.healthy());
    expect(byId(r, 'workspace').state).toBe('grey');
    // 依赖工程目录的灯（playwright）也只能 grey：判红等于把「没选」当成「坏了」
    expect(byId(r, 'playwright').state).toBe('grey');
  });

  it('选了且存在 → green；选了但不存在 → red 并给 fixHint', () => {
    resetProbeCache();
    expect(byId(probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy()), 'workspace').state).toBe('green');

    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/nope' }, STUB.healthy({ exists: (p: string) => p !== 'C:/nope' }) as never);
    expect(byId(r, 'workspace').state).toBe('red');
    expect(byId(r, 'workspace').fixHint).toBeTruthy();
  });

  it('灯 id 固定 5 个（chrome / node / jdk-jar / playwright / workspace）', () => {
    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy());
    expect(ABILITY_IDS).toEqual(['chrome', 'node', 'jdk-jar', 'playwright', 'workspace']);
    expect(r.abilities.map((a) => a.id)).toEqual(ABILITY_IDS);
    expect(r.abilities.every((a) => ['green', 'yellow', 'red', 'grey'].includes(a.state))).toBe(true);
  });
});

describe('record-probe：60 s 缓存', () => {
  it('60 s 内命中缓存（probedAt 不变），force 绕过', () => {
    resetProbeCache();
    const first = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy()) as { probedAt: string };
    const second = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy({ which: () => '', exists: () => false }) as never) as { probedAt: string };
    expect(second.probedAt).toBe(first.probedAt);
    expect(PROBE_TTL_MS).toBe(60000);

    const forced = probeAbilities({ workspaceDir: 'C:/proj', force: true }, STUB.healthy({ which: () => '', exists: () => false }) as never);
    expect(byId(forced, 'chrome').state).toBe('red');
  });

  it('超过 60 s 后重新探测（按注入的 now 判定，不看真实时钟）', () => {
    resetProbeCache();
    let clock = 1000;
    const deps = STUB.healthy({ now: () => clock });
    probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    clock += PROBE_TTL_MS + 1;
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy({ now: () => clock, which: (n: string) => (n === 'chrome' ? 'C:/chrome.exe' : '') }) as never);
    expect(byId(r, 'node').state).toBe('red');
  });
});

describe('record-probe：仅测试可用的探针注入口（J-9 / AC-14 四类反例机械化）', () => {
  const logged: string[] = [];
  const stubFor = (payload: unknown, overrides: Deps = {}) =>
    STUB.healthy({
      env: { [STUB_ENV]: 'C:/tmp/probe-stub.json' },
      readTextFile: () => JSON.stringify(payload),
      log: (line: string) => logged.push(line),
      ...overrides,
    });

  it('生效时返回值带 stubbed:true，且灯态来自桩数据', () => {
    resetProbeCache();
    logged.length = 0;
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, stubFor({ chrome: 'red', node: 'red' }) as never);
    expect(r.stubbed).toBe(true);
    expect(byId(r, 'chrome').state).toBe('red');
    expect(byId(r, 'node').state).toBe('red');
    // 桩没覆盖到的灯不假装健康
    expect(byId(r, 'workspace').state).toBe('grey');
    // J-9：生效必须在日志里显式标识「使用桩数据」；SEC-R2-08：只打**文件名**，不打绝对路径
    expect(logged.join('\n')).toContain('桩数据');
    expect(logged.join('\n')).toContain('probe-stub.json');
    expect(logged.join('\n')).not.toContain('C:/tmp');
  });

  it('AC-14 四类反例可以机械构造：无 node / 只有 Firefox / 缺 jar / 未选目录', () => {
    resetProbeCache();
    const r = probeAbilities({}, stubFor({
      chrome: { state: 'red', detail: '只找到 Firefox（非 Chromium 系）' },
      node: 'red',
      'jdk-jar': { state: 'yellow', detail: '缺 playwright jar' },
      workspace: 'grey',
    }) as never);
    expect(byId(r, 'node').state).toBe('red');
    expect(byId(r, 'chrome').detail).toMatch(/Firefox/);
    expect(byId(r, 'jdk-jar').state).toBe('yellow');
    expect(byId(r, 'workspace').state).toBe('grey');
  });

  it('打包版（app.isPackaged）强制忽略桩：即使 env 设了也不 stubbed', () => {
    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, stubFor({ chrome: 'red' }, { isPackaged: true }) as never);
    expect(r.stubbed).toBeUndefined();
    expect(byId(r, 'chrome').state).toBe('green');
  });

  it('桩文件读不到 / 不是 JSON → 忽略桩并走真实探针，不抛', () => {
    resetProbeCache();
    const broken = STUB.healthy({
      env: { [STUB_ENV]: 'C:/tmp/nope.json' },
      readTextFile: () => { throw new Error('ENOENT'); },
    });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, broken as never);
    expect(r.stubbed).toBeUndefined();
    expect(byId(r, 'chrome').state).toBe('green');

    resetProbeCache();
    const notJson = STUB.healthy({ env: { [STUB_ENV]: 'C:/tmp/x.json' }, readTextFile: () => 'not json' });
    expect((probeAbilities({ workspaceDir: 'C:/proj' }, notJson as never)).stubbed).toBeUndefined();
  });
});

describe('record-probe：证据里的本机绝对路径必须脱敏（[C-114] record:probe 条）', () => {
  it('用户目录 → <用户目录>，工程目录 → <工程目录>', () => {
    const out = redactEvidenceText('C:/Users/测试员/jdk/bin/javac.exe', {
      homeDir: 'C:/Users/测试员',
      workspaceDir: 'C:/proj',
    });
    expect(out).toBe('<用户目录>/jdk/bin/javac.exe');
    expect(redactEvidenceText('C:/proj/lib/a.jar', { homeDir: 'C:/Users/测试员', workspaceDir: 'C:/proj' })).toBe('<工程目录>/lib/a.jar');
  });

  it('探针结果里不残留 homeDir / workspaceDir 原串', () => {
    resetProbeCache();
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy());
    const dump = JSON.stringify(r);
    expect(dump).not.toContain('测试员');
  });
});


describe('record-probe：第二段安全评审的 S2 修复（SEC-R2）', () => {
  it('缓存是**真用例**：TTL 内命中缓存时 probedAt 取首次的时钟值（删掉缓存查询必红）', () => {
    resetProbeCache();
    let clock = 1_000;
    const first = probeAbilities({ workspaceDir: 'C:/proj' }, STUB.healthy({ now: () => clock, which: (n: string) => (n === 'chrome' ? 'C:/chrome.exe' : '') }) as never);
    const firstAt = first.probedAt;

    // 时钟推进到 TTL 之内（40 s），且换成「另一台机器」的依赖：命中缓存就该原样返回首次结果
    clock += 40_000;
    const second = probeAbilities(
      { workspaceDir: 'C:/proj' },
      STUB.healthy({ now: () => clock, which: () => '', exists: () => false }) as never,
    );
    expect(second.probedAt).toBe(firstAt);                    // 未重探（真缓存）
    expect(byId(second, 'chrome').state).toBe('green');        // 也没用新依赖重算

    // 跨过 TTL（再 +21 s > 60 s）→ 必须真的重探：新时钟 + 新依赖生效
    clock += PROBE_TTL_MS - 40_000 + 1;
    const third = probeAbilities(
      { workspaceDir: 'C:/proj' },
      STUB.healthy({ now: () => clock, which: () => '', exists: () => false }) as never,
    );
    expect(third.probedAt).not.toBe(firstAt);
    expect(byId(third, 'chrome').state).toBe('red');
  });

  it('脱敏是**集成断言**：evidence 里出现 homeDir 原串 → 回渲染层时已消失（删掉脱敏必红）', () => {
    resetProbeCache();
    const home = 'C:/Users/测试员';
    const nodeInHome = `${home}/AppData/Roaming/nvm/v22.22.0/node.exe`;
    const deps = STUB.healthy({
      homeDir: home,
      which: (name: string) => {
        if (name === 'node') return nodeInHome;      // evidence 里必含 homeDir 原串
        if (name === 'chrome') return 'C:/Program Files/Google/Chrome/Application/chrome.exe';
        if (name === 'javac') return `${home}/jdk/bin/javac.exe`;
        return '';
      },
    });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const dump = JSON.stringify(r.abilities);
    expect(dump).not.toContain(home);
    expect(dump).not.toContain('测试员');
    // javac 来自 which，它的路径会原样进 evidence —— 删掉脱敏这一条必红
    expect(byId(r, 'jdk-jar').evidence?.[0].out).toBe('<用户目录>/jdk/bin/javac.exe');
  });

  it('homeDir 为空时脱敏不能零生效：按路径形态正则兜底（SEC-R2-09）', () => {
    resetProbeCache();
    const deps = STUB.healthy({
      homeDir: '',
      which: (name: string) => (name === 'javac' ? 'C:/Users/alice/jdk/bin/javac.exe' : name === 'chrome' ? 'C:/chrome.exe' : ''),
    });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(JSON.stringify(r.abilities)).not.toContain('alice');
    expect(byId(r, 'jdk-jar').evidence?.[0].out).toBe('<用户目录>/jdk/bin/javac.exe');
    // 三条形态规则各一条（Windows / Linux / macOS）；只换「用户段」，其余分隔符原样
    expect(redactEvidenceText('C:\\Users\\bob\\x', { homeDir: '' })).toBe('<用户目录>\\x');
    expect(redactEvidenceText('C:/Users/bob/x', {})).toBe('<用户目录>/x');
    expect(redactEvidenceText('/home/carol/x', {})).toBe('<用户目录>/x');
    expect(redactEvidenceText('/Users/dave/x', {})).toBe('<用户目录>/x');
  });

  it('桩通道硬化：>64 KB 的桩直接失效（SEC-R2-07）', () => {
    resetProbeCache();
    const huge = JSON.stringify({ chrome: 'red', pad: 'x'.repeat(70 * 1024) });
    const deps = STUB.healthy({
      env: { [STUB_ENV]: 'C:/tmp/huge.json' },
      readTextFile: () => huge,
      log: () => {},
    });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(r.stubbed).toBeUndefined();       // 桩失效 → 走真实探针
    expect(byId(r, 'chrome').state).toBe('green');
  });

  it('桩通道硬化：形状不合法的桩值被丢弃，detail/evidence 有长度上限（SEC-R2-07）', () => {
    resetProbeCache();
    const deps = STUB.healthy({
      env: { [STUB_ENV]: 'C:/tmp/stub.json' },
      readTextFile: () => JSON.stringify({
        chrome: { state: 'red', detail: 'd'.repeat(5000), fixHint: 'h'.repeat(5000), evidence: [{ cmd: 'c', out: 'o'.repeat(5000), extra: 'x' }] },
        node: { state: 'not-a-state' },
        'jdk-jar': 'generated',
      }),
      log: () => {},
    });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(r.stubbed).toBe(true);
    const chrome = byId(r, 'chrome');
    expect(String(chrome.detail).length).toBeLessThanOrEqual(200);
    expect(String(chrome.fixHint).length).toBeLessThanOrEqual(200);
    expect(chrome.evidence?.[0]).toEqual({ cmd: 'c', out: 'o'.repeat(200) });
    expect(Object.keys(chrome.evidence?.[0] || {}).sort()).toEqual(['cmd', 'out']);
    expect(byId(r, 'node').state).toBe('grey');   // 非法灯态 → 不假装健康
  });

  it('桩生效的日志不写绝对路径（SEC-R2-08）', () => {
    resetProbeCache();
    const logged: string[] = [];
    const deps = STUB.healthy({
      env: { [STUB_ENV]: 'C:/Users/测试员/AppData/Local/Temp/stub.json' },
      readTextFile: () => JSON.stringify({ chrome: 'red' }),
      log: (line: string) => logged.push(line),
    });
    probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const line = logged.join('\n');
    expect(line).toContain('桩数据');
    expect(line).toContain('stub.json');
    expect(line).not.toContain('测试员');       // 不把用户名写进 app.log
    expect(line).not.toContain('C:/Users');
  });

  it('detectPackaged 失败按**打包版**处理（宁严勿宽）：require(electron) 不可用且未显式注入 → 桩失效', () => {
    resetProbeCache();
    const deps = STUB.healthy({
      env: { [STUB_ENV]: 'C:/tmp/stub.json' },
      readTextFile: () => JSON.stringify({ chrome: 'red' }),
      log: () => {},
    });
    delete (deps as Record<string, unknown>).isPackaged;   // 不显式注入 → 走探测
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    expect(r.stubbed).toBeUndefined();
  });
});


// t56：**用户真正看到的那条路径**（本机能力面板里 node 灯的 detail）必须不再宣传已移除的 .mjs 产物。
// 为什么单独立一组：t54 的 grep 只覆盖了 src/** 的页面文案，t55 复包时在 electron/record-probe.js
// 里抓到 2 处「零依赖 .mjs 产物…」，而它们正是这两条 detail —— 面板上 node 灯红/黄时用户就会看到。
// 所以这里断言的是 **probe 返回值的 detail**（渲染层直接拿去显示的字段），不是源码字符串。
describe('t56 · node 灯的 detail 不许再宣传已移除的 .mjs 产物', () => {
  const FORBIDDEN = ['.mjs', '零依赖'];

  it('红态（PATH 上找不到 node）：detail 不提 .mjs / 零依赖，但仍说清「要用你自己的 Node」', () => {
    resetProbeCache();
    const deps = STUB.healthy({ which: (name: string) => (name === 'chrome' ? 'C:/chrome.exe' : '') });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const node = byId(r, 'node');
    expect(node.state).toBe('red');
    for (const w of FORBIDDEN) expect(String(node.detail)).not.toContain(w);
    // 语义不能一起丢：仍要告诉用户「不是用应用自带的 Node」
    expect(String(node.detail)).toContain('Node');
  });

  it('低版本态（v18）：detail 不提 .mjs / 零依赖，但保留 Node ≥ 22 的硬要求（[C-118] 不放宽）', () => {
    resetProbeCache();
    const deps = STUB.healthy({ exec: () => ({ ok: true, out: 'v18.19.0' }) });
    const r = probeAbilities({ workspaceDir: 'C:/proj' }, deps as never);
    const node = byId(r, 'node');
    expect(node.state).toBe('yellow');
    for (const w of FORBIDDEN) expect(String(node.detail)).not.toContain(w);
    expect(String(node.detail)).toContain('22');
  });
});
