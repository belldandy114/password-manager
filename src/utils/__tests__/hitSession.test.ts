import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  __setSessionForTest,
  _reset,
  auditHitSession,
  clearPidFile,
  configure,
  guardProfileForCleanup,
  handle,
  isPidAlive,
  killOurs,
  parseCimJson,
  parseTasklistName,
  pickBrowserExe,
  readPidFile,
  safeHost,
  safeUrl,
  status,
  stopSession,
  stopSessionSync,
  verifyProcess,
  writePidFile,
} from '../../../electron/hit-session.js';

/**
 * 元素库 A₂ · 会话状态机的**安全边界**（契约 [A2-4][A2-10][A2-11][A2-13]）。
 *
 * 这里只测不该起浏览器的部分：进程校验的编排、账本、审计脱敏、入参回执。
 * 真机路径（起浏览器 → 连 CDP → 高亮 → 退出）由 QA 的执行记录覆盖，单测不假跑进程。
 */
describe('hit-session · 进程双校验后的 kill 编排（[A2-10]：未通过的绝不进 taskkill）', () => {
  const profileDir = 'C:\\data\\el-hit-profile';
  const startedAt = '2026-11-27T10:00:00';

  it('进程名不对 / 命令行不含本 profile / pid 非法 → skipped，**kill 一次都不调**', () => {
    const calls: number[] = [];
    const r = killOurs(
      [
        { pid: 201, name: 'notepad.exe', cmd: `notepad --user-data-dir="${profileDir}"` },
        { pid: 202, name: 'chrome.exe', cmd: '"chrome.exe" --user-data-dir="C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data"' },
        { pid: 203, name: 'msedge.exe', cmd: `msedge --user-data-dir="${profileDir}"`, creation: '2026-11-01T09:00:00' },
        { pid: 0, name: 'chrome.exe', cmd: 'whatever' },
      ],
      { profileDir, startedAt },
      (pid) => calls.push(pid)
    );
    expect(calls).toEqual([]);
    expect(r.killed).toEqual([]);
    expect(r.skipped.map((s) => s.pid)).toEqual([201, 202, 203, 0]);
  });

  it('三项全过的才被杀；用户的普通浏览器（同机另一个 chrome.exe）不受影响', () => {
    const calls: number[] = [];
    const r = killOurs(
      [
        { pid: 301, name: 'chrome.exe', cmd: `"chrome.exe" --user-data-dir="${profileDir}"`, creation: '2026-11-27T10:00:04' },
        { pid: 302, name: 'chrome.exe', cmd: '"chrome.exe" --user-data-dir="C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data"', creation: '2026-11-27T08:00:00' },
        { pid: 303, name: 'msedge.exe', cmd: `msedge --user-data-dir="${profileDir}"`, creation: '2026-11-27T10:00:06' },
      ],
      { profileDir, startedAt },
      (pid) => calls.push(pid)
    );
    expect(calls).toEqual([301, 303]);
    expect(r.killed).toEqual([301, 303]);
    expect(r.skipped.map((s) => s.pid)).toEqual([302]);
  });

  it('禁按镜像名批量杀：编排里只接受 pid 入参，没有「按名字杀」的口子', () => {
    // 这条是行为断言：kill 收到的是**具体 pid**，不是进程名（批量杀的形态传不进这个签名）
    const seen: unknown[] = [];
    killOurs([{ pid: 401, name: 'chrome.exe', cmd: `--user-data-dir=${profileDir}`, creation: startedAt }], { profileDir, startedAt }, (pid) => seen.push(pid));
    expect(seen).toEqual([401]);
    expect(seen.every((x) => typeof x === 'number')).toBe(true);
  });
});

describe('hit-session · 进程输出的解析（命令行/时间都从这里来）', () => {
  it('tasklist CSV 取第一列进程名', () => {
    expect(parseTasklistName('"chrome.exe","1234","Console","1","120,000 K"')).toBe('chrome.exe');
    expect(parseTasklistName('"msedge.exe","42","Console","1","80,000 K"\r\n')).toBe('msedge.exe');
    expect(parseTasklistName('')).toBe('');
  });

  it('「查无此任务」提示行 / 非 exe 行 → 空串（B-2 根因：这行曾被当成进程名）', () => {
    // 英文版与中文版 tasklist 都会在查不到时打提示；它不是进程名
    expect(parseTasklistName('INFO: No tasks are running which match the specified criteria.')).toBe('');
    expect(parseTasklistName('信息: 没有运行的任务匹配指定标准。')).toBe('');
    expect(parseTasklistName('INFO: No tasks are running')).toBe('');
    // 不像进程名的裸行也不认（只接受 xxx.exe）
    expect(parseTasklistName('ERROR: The RPC server is unavailable.')).toBe('');
    expect(parseTasklistName('not-a-process')).toBe('');
  });

  it('CIM 的 JSON：正常 / 带 BOM / 坏 JSON', () => {
    expect(parseCimJson('{"CommandLine":"chrome.exe --x","CreationDate":"2026-11-27T10:00:04"}')).toEqual({
      cmd: 'chrome.exe --x',
      creation: '2026-11-27T10:00:04',
    });
    expect(parseCimJson('\uFEFF{"CommandLine":"a"}')).toEqual({ cmd: 'a', creation: '' });
    expect(parseCimJson('')).toBe(null);
    expect(parseCimJson('not json')).toBe(null);
    expect(parseCimJson('null')).toBe(null);
  });
});

describe('hit-session · 清理前的 profile 包含性校验（[A2-9]）', () => {
  it('只有「数据目录下的 el-hit-profile」才允许清理；外部路径一律拒绝', () => {
    expect(guardProfileForCleanup('C:\\data', 'C:\\data\\el-hit-profile')).toBe(true);
    // 用户日常浏览器 profile（最危险的那种误删）
    expect(guardProfileForCleanup('C:\\data', 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data')).toBe(false);
    // 同名前缀的兄弟目录
    expect(guardProfileForCleanup('C:\\data', 'C:\\data\\el-hit-profile-copy')).toBe(false);
    // 目录名对了但不在数据目录下
    expect(guardProfileForCleanup('C:\\data', 'C:\\other\\el-hit-profile')).toBe(false);
    // .. 逃逸
    expect(guardProfileForCleanup('C:\\data', 'C:\\data\\el-hit-profile\\..\\..\\other')).toBe(false);
    expect(guardProfileForCleanup('C:\\data', '')).toBe(false);
  });
});

describe('hit-session · 浏览器路径只复用一份（[A2-16] 第 4 条）', () => {
  it('先 Chrome 再 Edge，都没有就空串（由调用方转成「没找到可用浏览器」）', () => {
    expect(pickBrowserExe((id) => (id === 'chrome' ? 'C:\\chrome.exe' : 'C:\\msedge.exe'))).toBe('C:\\chrome.exe');
    expect(pickBrowserExe((id) => (id === 'msedge' ? 'C:\\msedge.exe' : null))).toBe('C:\\msedge.exe');
    expect(pickBrowserExe(() => null)).toBe('');
    // findBrowser 自己抛错也不许把点验带崩
    expect(
      pickBrowserExe((id) => {
        if (id === 'chrome') throw new Error('boom');
        return 'C:\\msedge.exe';
      })
    ).toBe('C:\\msedge.exe');
  });
});

describe('hit-session · pid 账本（[A2-10]：5 个字段，坏文件不抛）', () => {
  it('写进去什么读出来什么；文件不存在回 null', () => {
    const dir = process.env.TEMP || '.';
    const info = { pid: 4321, sessionId: 's-1', exe: 'C:\\chrome.exe', profileDir: dir, startedAt: '2026-11-27T10:00:00' };
    expect(writePidFile(dir, info).ok).toBe(true);
    const back = readPidFile(dir);
    expect(back).toEqual({ pid: 4321, sessionId: 's-1', exe: 'C:\\chrome.exe', startedAt: '2026-11-27T10:00:00' });
    clearPidFile(dir);
    expect(readPidFile(dir)).toBe(null);
  });
});

describe('hit-session · 审计脱敏（[A2-13]：恰好 8 个键，只留 host）', () => {
  const captured: Array<Record<string, unknown>> = [];
  beforeEach(() => {
    captured.length = 0;
    configure({ audit: (e: Record<string, unknown>) => captured.push(e), now: () => Date.parse('2026-11-27T10:05:00') });
    _reset();
  });

  it('8 个键、不出现 query、不出现元素名/label', () => {
    auditHitSession(
      {
        sessionId: 's-9',
        browserId: 'chrome',
        url: 'https://example.com/login?token=SECRET#frag',
        startedAt: '2026-11-27T10:00:00',
        hits: 3,
      },
      { killed: true }
    );
    expect(captured.length).toBe(1);
    const entry = captured[0];
    expect(Object.keys(entry).length).toBe(8);
    expect(Object.keys(entry).sort()).toEqual(
      ['action', 'browserId', 'host', 'hits', 'killed', 'sessionId', 'startedAt', 'stoppedAt'].sort()
    );
    expect(entry.action).toBe('el-hit-session');
    expect(entry.host).toBe('example.com');
    expect(entry.hits).toBe(3);
    expect(entry.killed).toBe(true);
    expect(JSON.stringify(entry)).not.toContain('SECRET');
    expect(JSON.stringify(entry)).not.toContain('token');
    expect(JSON.stringify(entry)).not.toContain('/login');
  });

  it('URL 脱敏：只留 协议//host/path（query 与片段一律丢）', () => {
    expect(safeUrl('https://a.example:8443/x/y?q=1#z')).toBe('https://a.example:8443/x/y');
    expect(safeHost('https://a.example:8443/x?q=1')).toBe('a.example:8443');
    expect(safeUrl('not a url')).toBe('');
    expect(safeHost('')).toBe('');
  });
});

describe('hit-session · 三个 op 的分流（[A2-1]/[A2-4]）', () => {
  beforeEach(() => {
    configure({ isUnlocked: () => false, findElement: () => null, dataDir: '' });
    _reset();
  });

  it('status 只读：没有会话时回 open:false，且**绝不拉起浏览器**', () => {
    expect(status()).toEqual({
      open: false,
      sessionId: '',
      browserId: '',
      port: 0,
      url: '',
      startedAt: '',
      lastHitAt: '',
      idleStopInMs: 600000,
    });
  });

  it('status op 走通（不需要 url / 定位器）', async () => {
    const r = await handle({ op: 'status' });
    expect(r.success).toBe(true);
    expect(r.data && r.data.session && r.data.session.open).toBe(false);
  });

  it('入参不合法 → success:false + 固定文案，且**不带 hit**（[A2-4]）', async () => {
    const r = await handle({ url: 'file:///C:/x.html', locator: '#a', kind: 'css' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('请输入 http/https 开头的地址');
    expect('hit' in (r.data || {})).toBe(false);
  });

  it('未解锁 + 落库来源 → 「未解锁」固定文案（不许说成元素不存在）', async () => {
    const r = await handle({ url: 'https://a.example', pageId: 'p', elementId: 'e' });
    expect(r.success).toBe(false);
    expect(r.error).toContain('未解锁');
    expect(r.code).toBe('locked');
  });

  it('没装浏览器时如实回「没找到可用的浏览器」，同样不带 hit（[A2-4] 硬口径）', async () => {
    // 注意：isUnlocked 必须为 true —— SEC-01 之后锁定态会在**起浏览器之前**就被拦住，
    // 那样测到的就不是「没装浏览器」这条分支了（锁定态单独有一条测试）。
    configure({ dataDir: process.env.TEMP || '.', findBrowser: () => '', isUnlocked: () => true });
    const r = await handle({ url: 'https://a.example', locator: '#a', kind: 'css' });
    expect(r.success).toBe(false);
    expect(r.error).toBe('没找到可用的浏览器（需要本机装有 Chrome 或 Edge）');
    expect(r.code).toBe('no-browser');
    expect(r.data).toBeUndefined();
  });
});

describe('hit-session · B-1 修复：生产接线必须给真 spawn / spawnSync', () => {
  it('ipc-hit.js 的 configure 里注入了 child_process 的 spawn 与 spawnSync', () => {
    // 静态门：这条缺陷（缺注入 → 点验生产路径恒失败）只有看接线处才能抓到，
    // 单测自己注入假 spawn 是看不见它的（QA t15 的 B-1 就是这么漏的）。
    const src = fs.readFileSync(path.resolve(__dirname, '../../../electron/ipc-hit.js'), 'utf8');
    expect(src).toContain("require('child_process')");
    expect(src).toMatch(/hitSession\.configure\(\{[\s\S]*?\bspawn\b,/);
    expect(src).toMatch(/hitSession\.configure\(\{[\s\S]*?\bspawnSync\b,/);
  });

  it('真实 spawnSync 冒烟：活 pid 判活、不存在的 pid 判死（走真的 tasklist）', () => {
    configure({ spawn, spawnSync, now: () => Date.now(), log: () => {}, audit: () => {} });
    expect(isPidAlive(process.pid)).toBe(true);
    // 999999 基本不可能存在；关键是它会返回 tasklist 的 INFO 提示行，
    // 而这行**不再**被当成进程名（B-2 根因）。
    expect(isPidAlive(999999)).toBe(false);
  });
});

describe('hit-session · B-2 修复：stop 在 L1 之后进程已不在 → stopped:true / killed:false', () => {
  beforeEach(() => {
    _reset();
  });

  it('进程早就不在时：只查 tasklist、不 taskkill、<3s、killed=false', async () => {
    const dataDir = path.join(process.env.TEMP || '.', 'pm-hit-t20');
    const profileDir = path.join(dataDir, 'el-hit-profile');
    const calls: string[][] = [];
    configure({
      dataDir,
      now: () => Date.now(),
      log: () => {},
      audit: () => {},
      // tasklist 一律回「查无此任务」提示行 —— 修好后 isPidAlive 必须判死
      spawnSync: ((file: string, args: string[]) => {
        calls.push([file, ...(args || [])]);
        return { stdout: 'INFO: No tasks are running which match the specified criteria.\r\n', status: 0 };
      }) as unknown as typeof spawnSync,
    });
    __setSessionForTest({
      sessionId: 's-t20',
      browserId: 'chrome',
      pid: 424242,
      profileDir,
      port: 0,
      browserWsPath: '',
      client: { closed: false, close() {} },
      url: 'https://example.com',
      startedAt: new Date().toISOString(),
      lastHitAtMs: Date.now(),
    });

    const t0 = Date.now();
    const r = await stopSession('user');
    const ms = Date.now() - t0;

    expect(r.success).toBe(true);
    expect(r.data && r.data.stopped).toBe(true);
    expect(r.data && r.data.killed).toBe(false);
    expect(ms).toBeLessThan(3000);
    // 进程早不在 → 不该去 taskkill（老实现会连打两次 /T 再 /T /F 并报 stop-failed）
    expect(calls.some((c) => c[0] === 'taskkill')).toBe(false);
    expect(calls.every((c) => c[0] === 'tasklist')).toBe(true);
    // 会话已从单例摘除
    expect(status().open).toBe(false);
  });
});

describe('hit-session · C-02：没有 pwsh 的机器上 verifyProcess 不能恒 false', () => {
  const profileDir = 'C:\\data\\el-hit-profile';

  /** 造一个只会说「我是 chrome、我的命令行里有本 profile」的假 spawnSync，并记录被调用的可执行文件 */
  function fakeSpawn(calls: Array<[string, string[]]>, opts?: { creation?: string }) {
    return ((file: string, args: string[]) => {
      calls.push([file, args || []]);
      if (file === 'tasklist') return { stdout: '"chrome.exe","4242","Console","1","1 K"\r\n', status: 0 };
      return {
        stdout: JSON.stringify({
          CommandLine: `"chrome.exe" --user-data-dir="${profileDir}"`,
          CreationDate: opts && opts.creation ? opts.creation : `/Date(${Date.now()})/`,
        }),
        status: 0,
      };
    }) as unknown as typeof spawnSync;
  }

  beforeEach(() => {
    _reset();
  });

  it('探测不到 pwsh → 用 powershell.exe，且仍拿到进程信息（ok:true）', () => {
    const calls: Array<[string, string[]]> = [];
    configure({
      which: () => '', // 模拟 Win10/11 默认没有 pwsh
      now: () => Date.now(),
      log: () => {},
      audit: () => {},
      spawnSync: fakeSpawn(calls),
    });
    const startedAt = new Date(Date.now() - 5000).toISOString();
    const v = verifyProcess(4242, profileDir, startedAt);

    expect(v.ok).toBe(true); // 老实现这里恒 false（spawnSync('pwsh') 直接失败）
    const shells = calls.map((c) => c[0]);
    expect(shells).toContain('powershell.exe');
    expect(shells).not.toContain('pwsh');
  });

  it('探测到 pwsh → 仍优先用 pwsh（默认路径不变）', () => {
    const calls: Array<[string, string[]]> = [];
    configure({
      which: (name: string) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : ''),
      now: () => Date.now(),
      log: () => {},
      audit: () => {},
      spawnSync: fakeSpawn(calls),
    });
    const v = verifyProcess(4242, profileDir, new Date(Date.now() - 5000).toISOString());
    expect(v.ok).toBe(true);
    expect(calls.map((c) => c[0])).toContain('pwsh');
  });

  it('5.1 的 /Date(ms)/ 创建时间也算数（只换 shell 不换日期解析 = 没修好）', () => {
    const calls: Array<[string, string[]]> = [];
    configure({
      which: () => '',
      now: () => Date.now(),
      log: () => {},
      audit: () => {},
      spawnSync: fakeSpawn(calls, { creation: `/Date(${Date.now() - 1000})/` }),
    });
    const v = verifyProcess(4242, profileDir, new Date(Date.now() - 5000).toISOString());
    expect(v.ok).toBe(true);
  });

  it('创建时间早于会话（pid 被复用）仍然拒（回退不等于放宽）', () => {
    const calls: Array<[string, string[]]> = [];
    configure({
      which: () => '',
      now: () => Date.now(),
      log: () => {},
      audit: () => {},
      spawnSync: fakeSpawn(calls, { creation: `/Date(${Date.now() - 600000})/` }),
    });
    const v = verifyProcess(4242, profileDir, new Date(Date.now() - 5000).toISOString());
    expect(v.ok).toBe(false);
    expect(String(v.why)).toContain('创建时间');
  });
});

describe('hit-session · SEC-01：锁定态的闸门必须在「起浏览器之前」', () => {
  beforeEach(() => {
    _reset();
  });

  it('锁定态 + 草稿来源 → 未解锁，且 **spawn 调用计数 = 0**（不是「起了再判」）', async () => {
    const spawnCalls: string[] = [];
    configure({
      dataDir: process.env.TEMP || '.',
      // 故意给一个存在的浏览器路径：确保「没找到浏览器」这条早退不会替闸门背锅
      findBrowser: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      isUnlocked: () => false,
      spawn: ((...args: unknown[]) => {
        spawnCalls.push(String(args[0]));
        throw new Error('锁定态不该 spawn');
      }) as unknown as typeof spawn,
      spawnSync: (() => ({ stdout: '', status: 0 })) as unknown as typeof spawnSync,
      log: () => {},
      audit: () => {},
      now: () => Date.now(),
    });

    const r = await handle({ url: 'https://a.example', locator: '#a', kind: 'css' });
    expect(r.success).toBe(false);
    expect(r.code).toBe('locked');
    expect(r.error).toBe('密码库未解锁：请先解锁再点验');
    // 最关键的一条：闸门在起浏览器之前，所以一次 spawn 都不该发生
    expect(spawnCalls.length).toBe(0);
  });

  it('解锁后同一入参才会走到「起浏览器」那一步（证明上一条不是空转）', async () => {
    const spawnCalls: string[] = [];
    configure({
      dataDir: process.env.TEMP || '.',
      findBrowser: () => 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      isUnlocked: () => true,
      spawn: ((...args: unknown[]) => {
        spawnCalls.push(String(args[0]));
        // 给一个没有 pid 的假子进程 → startSession 立刻回 launch-failed，不会真跑浏览器
        return { pid: 0, on: () => {} };
      }) as unknown as typeof spawn,
      spawnSync: (() => ({ stdout: '', status: 0 })) as unknown as typeof spawnSync,
      log: () => {},
      audit: () => {},
      now: () => Date.now(),
    });

    const r = await handle({ url: 'https://a.example', locator: '#a', kind: 'css' });
    expect(r.success).toBe(false);
    expect(r.code).toBe('launch-failed');
    expect(spawnCalls.length).toBe(1); // 解锁之后确实尝试起了（对照上一条的 0）
  });
});

describe('hit-session · SEC-02：退出路径与启动失败都必须写审计（8 键不变）', () => {
  const profileDir = 'C:\\data\\el-hit-profile';

  beforeEach(() => {
    _reset();
  });

  it('will-quit（stopSessionSync）写一条 8 键审计，host 只留 host', () => {
    const audits: Array<Record<string, unknown>> = [];
    configure({
      dataDir: 'C:\\data',
      now: () => Date.parse('2026-11-27T10:05:00.000Z'),
      log: () => {},
      audit: (e: Record<string, unknown>) => audits.push(e),
      spawnSync: (() => ({ stdout: 'INFO: No tasks are running\r\n', status: 0 })) as unknown as typeof spawnSync,
      which: () => '',
    });
    __setSessionForTest({
      sessionId: 's-quit',
      browserId: 'chrome',
      pid: 777,
      profileDir,
      port: 0,
      browserWsPath: '',
      client: { closed: false, close() {} },
      url: 'https://example.com/login?token=SECRET',
      startedAt: '2026-11-27T10:00:00.000Z',
      hits: 2,
    });

    stopSessionSync('quit');

    expect(audits.length).toBe(1);
    const entry = audits[0];
    expect(Object.keys(entry).length).toBe(8);
    expect(Object.keys(entry).sort()).toEqual(
      ['action', 'browserId', 'host', 'hits', 'killed', 'sessionId', 'startedAt', 'stoppedAt'].sort()
    );
    expect(entry.host).toBe('example.com');
    expect(JSON.stringify(entry)).not.toContain('SECRET');
    expect(entry.killed).toBe(false); // 进程已不在，没走 taskkill
  });

  it('startSession 失败出口（等不到 DevToolsActivePort）也写审计，host 用请求地址的 host', async () => {
    const audits: Array<Record<string, unknown>> = [];
    const tmp = path.join(process.env.TEMP || '.', 'pm-hit-audit');
    fs.mkdirSync(tmp, { recursive: true });
    let clock = 0;
    configure({
      dataDir: tmp,
      findBrowser: () => 'C:\\fake\\chrome.exe',
      isUnlocked: () => true,
      // 每次取时间都跳 10s → waitForDevTools 的轮询立刻超时（不必真等 15s）
      now: () => (clock += 10000),
      log: () => {},
      audit: (e: Record<string, unknown>) => audits.push(e),
      spawn: (() => ({ pid: 9911, on: () => {} })) as unknown as typeof spawn,
      spawnSync: (() => ({ stdout: 'INFO: No tasks are running\r\n', status: 0 })) as unknown as typeof spawnSync,
      which: () => '',
    });

    const r = await handle({ url: 'https://example.com/a', locator: '#a', kind: 'css' });
    expect(r.success).toBe(false);
    // 失败原因必须是「起来但没拿到调试端口」，而不是别的分支
    expect(r.code).toBe('dap-timeout');

    const startAudit = audits.filter((e) => e.action === 'el-hit-session');
    expect(startAudit.length).toBeGreaterThanOrEqual(1);
    const entry = startAudit[startAudit.length - 1];
    expect(Object.keys(entry).length).toBe(8);
    expect(entry.host).toBe('example.com');
    expect(entry.hits).toBe(0);
    expect(entry.killed).toBe(false); // 校验不过（没有命令行）→ 不杀
    expect('reason' in entry).toBe(false);
    expect('url' in entry).toBe(false);
    expect('path' in entry).toBe(false);
    expect('label' in entry).toBe(false);
  });
});
