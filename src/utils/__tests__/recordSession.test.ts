import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'fs';
import path from 'path';
import { INSTALL_FN_SRC } from '../../../electron/record-inject.js';
import {
  AUDIT_ACTION,
  MAX_EVENTS,
  FLUSH_MS,
  POLL_BATCH,
  POLL_EXPR,
  PROFILE_ROOT_NAME,
  MAX_DRAIN_ROUNDS,
  QUEUE_FN_SRC,
  PAGE_READY_EXPR,
  TAKE_MISSING,
  MAX_REINSTALL,
  TAKE_TAMPERED,
  browserLabel,
  sanitizeAuditCode,
  sanitizeAuditItem,
  RECENT_STOP_LIMIT,
  START_TIMEOUT_MS,
  browserCandidates,
  createRecordSession,
  findBrowser,
  guardTick,
  parseProcessList,
} from '../../../electron/record-session.js';
import { CHROMIUM_EXECUTABLES } from '../../../electron/record-probe.js';
import { registerEntriesIpc } from '../../../electron/ipc-entries.js';
import {
  ERR_PROBE,
  ERR_STATUS,
  ERR_STOP,
  ERR_VALIDATE,
  registerRecordIpc,
} from '../../../electron/ipc-record.js';

/**
 * S3 · `electron/record-session.js`：录制会话状态机（单会话）+ 子进程/临时目录生死管理。
 *
 * 全部外部能力走 deps 注入（spawn / fs / clock / 进程表 / CDP / 探针），
 * **不起真 Chrome、不写真实盘、不真等 15 秒**，否则这套测试在 CI 上必然翻车。
 */

type Row = { pid: number; commandLine: string; creationDate: number };

const DATA_DIR = 'C:/data/pm';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** 取数组最后一项（tsconfig 的 lib 是 ES2020，没有 Array.prototype.at） */
const lastOf = <T,>(list: T[]): T => list[list.length - 1];

type Overrides = {
  processes?: Row[];
  /** 第几次读 DevToolsActivePort 才成功（Infinity = 永不出现 → 触发 15 s 超时） */
  portReadyAt?: number;
  portText?: string;
  killFails?: boolean;
  onCallWithArgs?: (fn: string, args: unknown[]) => unknown;
  validateResult?: unknown;
  maxEvents?: number;
  which?: (name: string) => string;
  exists?: (p: string) => boolean;
  listProcesses?: () => Row[];
  /** 数据目录（空串 = 未就绪，用于 SEC-R2-03 的拒绝启动用例） */
  getDataDir?: () => string;
  /** `rmSync` 抛错（模拟 Windows 上「进程还占着目录」）：返回 undefined = 成功，返回 Error = 抛它 */
  rmError?: (dir: string, attempt: number) => Error | undefined;
  /** 进程是否还活着（默认 false = 已经退干净；true = 模拟「一直不退」） */
  isProcessAlive?: (pid: number) => boolean;
  /** `record-profiles/` 下的子目录名（scanOrphans 清残留目录用） */
  readdirSync?: (dir: string) => string[];
  /** 浏览器本体 spawn 抛错（R3-02：启动失败要写审计） */
  spawnThrows?: boolean;
  /** connectCdp 抛错（同上） */
  connectCdpThrows?: string;
  /** `clock.setInterval` 抛错（R3-07：调度失败必须当场收敛，不许泄漏会话） */
  setIntervalThrows?: string;
  /** 卡住 start 的「连接阶段」：resolve 之前一直停在 starting 窗口（R3-04 用例用） */
  holdConnect?: { promise: Promise<void> };
  /** 接管一次取队列的返回（SEC-R3-02 的 10 万条 / SEC-R3-07 的哨兵） */
  evaluateQueueTake?: (queue: string[]) => unknown;
  /** 替换能力探针（P3 的 workspaceDir 校验用例） */
  probeAbilities?: (input: { workspaceDir: string; force: boolean }) => unknown;
  /** 页面就绪探针的返回序列（D-4：注入前必须等到目标文档） */
  pageReadySteps?: Array<{ ready: string; href: string }>;
};

function harness(opts: Overrides = {}) {
  const spawnCalls: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = [];
  const removed: string[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const emitted: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  /** `listProcesses` 被调次数（stop 热路径**不该**调它：PowerShell 枚举是 D-3 的长尾根因） */
  let listProcessCalls = 0;
  /** 被删过的目录集合：`existsSync` 据此模拟「删了就真的不存在」 */
  const goneDirs = new Set<string>();
  /** 每次 rmSync 尝试记录（重试次数用） */
  const rmAttempts: Array<{ dir: string; attempt: number; probes: number }> = [];
  /** isProcessAlive 被调次数（用来锁「先等进程退、再删目录」的顺序） */
  let aliveProbes = 0;
  /** connectCdp 的实参（**只该有 port**：目标发现是 cdp-client 的职责，RA2-01 / 契约 v21） */
  const connects: Array<{ port: number; timeout?: number }> = [];
  const callWithArgsCalls: Array<{ fn: string; args: unknown[] }> = [];
  const evalCalls: string[] = [];
  const queue: string[] = [];

  let nowMs = Date.parse('2026-11-25T03:00:00.000Z');
  let portReads = 0;
  let intervalFn: (() => unknown) | null = null;
  let processes: Row[] = opts.processes ?? [];
  let cdpClosed = false;

  const child = {
    pid: 4242,
    killed: false,
    exitCode: null as number | null,
    on: () => child,
    once: () => child,
    kill: () => { child.killed = true; },
    stdout: { on: () => child.stdout },
    stderr: { on: () => child.stderr },
  };

  const fs = {
    // 删过的目录一律报「不存在」（模拟「删了就是删了」，stop 后 Test-Path 为假的等价物）
    existsSync: (p: string) => {
      if (goneDirs.has(p)) return false;
      return p.includes('DevToolsActivePort') ? portReads >= (opts.portReadyAt ?? 1) : true;
    },
    readFileSync: (p: string) => {
      if (p.includes('DevToolsActivePort')) {
        portReads += 1;
        if (portReads >= (opts.portReadyAt ?? 1)) return opts.portText ?? '52345\n/devtools/browser/abc-123';
        throw new Error('ENOENT');
      }
      throw new Error('ENOENT');
    },
    mkdirSync: () => undefined,
    /**
     * 旧版这里**恒成功** —— 这正是「现场 3/4 轮删不掉、单测却全绿」的假绿源头（评审 R3 点名的
     * `recordSession.test.ts:85`）。现在支持注入抛错（模拟 Windows 进程占着目录）。
     */
    rmSync: (p: string) => {
      const attempt = rmAttempts.filter((x) => x.dir === p).length + 1;
      rmAttempts.push({ dir: p, attempt, probes: aliveProbes });
      const err = opts.rmError ? opts.rmError(p, attempt) : undefined;
      if (err) throw err;
      removed.push(p);
      goneDirs.add(p);
    },
    readdirSync: (dir: string) => (opts.readdirSync ? opts.readdirSync(dir) : []),
    writeFileSync: () => undefined,
  };

  const clock = {
    now: () => nowMs,
    sleep: async (ms: number) => { nowMs += ms; },
    /** 同步睡：单测里不真等（记录调用即可） */
    sleepSync: (ms: number) => { nowMs += ms; },
    setInterval: (fn: () => unknown) => {
      if (opts.setIntervalThrows) throw new Error(opts.setIntervalThrows);
      intervalFn = fn;
      return 1;
    },
    clearInterval: () => { intervalFn = null; },
    setTimeout: (fn: () => unknown) => { fn(); return 1; },
    clearTimeout: () => undefined,
  };

  let readyProbes = 0;

  const spawn = (cmd: string, args: string[], spawnOpts: Record<string, unknown> = {}) => {
    spawnCalls.push({ cmd, args, opts: spawnOpts });
    if (cmd === 'taskkill' && opts.killFails) {
      const fail = { ...child, pid: 0, killed: true };
      throw new Error('taskkill 失败：拒绝访问');
    }
    // 浏览器本体 spawn 失败（用「不是 taskkill 的那次 spawn」区分，避免误伤杀进程）
    if (cmd !== 'taskkill' && opts.spawnThrows) throw new Error('spawn EACCES：拒绝访问');
    return child;
  };

  const cdp = {
    wsUrl: '',
    errors: [] as string[],
    send: async () => ({}),
    evaluate: async (expr: string) => {
      evalCalls.push(expr);
      // D-4：注入前会先探「页面就绪」，默认直接回「目标文档已就绪」
      if (/document\.readyState/.test(expr)) {
        const idx = readyProbes;
        readyProbes += 1;
        const step = opts.pageReadySteps && opts.pageReadySteps[Math.min(idx, opts.pageReadySteps.length - 1)];
        return JSON.stringify(step || { ready: 'complete', href: 'https://example.com/login' });
      }
      if (/__dshQueueTake/.test(expr)) {
        if (opts.evaluateQueueTake) return opts.evaluateQueueTake(queue);
        return queue.splice(0, POLL_BATCH);
      }
      return undefined;
    },
    callWithArgs: async (fn: string, args: unknown[]) => {
      callWithArgsCalls.push({ fn, args });
      if (opts.onCallWithArgs) return opts.onCallWithArgs(fn, args);
      return { count: 2, precise: false };
    },
    waitFor: async () => true,
    close: () => { cdpClosed = true; },
  };

  const deps = {
    spawn,
    fs,
    clock,
    platform: 'win32',
    env: { PROGRAMFILES: 'C:/Program Files', LOCALAPPDATA: 'C:/Users/u/AppData/Local' },
    which: opts.which ?? ((name: string) => (name === 'chrome' || name === 'msedge' ? CHROME : '')),
    exists: opts.exists ?? ((p: string) => p === CHROME),
    listProcesses: () => {
      listProcessCalls += 1;
      return opts.listProcesses ? opts.listProcesses() : processes;
    },
    /** 默认「进程已经退干净」；注入 true 可模拟「一直不退」 */
    isProcessAlive: (pid: number) => { aliveProbes += 1; return opts.isProcessAlive ? opts.isProcessAlive(pid) : false; },
    connectCdp: async (o: { port: number; timeout?: number }) => {
      connects.push({ port: o.port, timeout: o.timeout });
      if (opts.connectCdpThrows) throw new Error(opts.connectCdpThrows);
      if (opts.holdConnect) await opts.holdConnect.promise;
      return cdp;
    },
    probeAbilities: opts.probeAbilities ?? (() => ({ probedAt: '2026-11-25T03:00:00.000Z', abilities: [] })),
    getDataDir: opts.getDataDir ?? (() => DATA_DIR),
    getPassword: () => 'master-pw',
    getMainWindow: () => ({ webContents: { send: () => undefined } }),
    appendAudit: (entry: Record<string, unknown>) => { audits.push(entry); },
    onEvents: (list: Array<Record<string, unknown>>) => { emitted.push(...list); },
    log: (line: string) => { logs.push(String(line)); },
    limits: {
      startTimeoutMs: 15_000,
      flushMs: FLUSH_MS,
      pollBatch: POLL_BATCH,
      maxEvents: opts.maxEvents ?? MAX_EVENTS,
    },
  };

  const session = createRecordSession(deps as never);

  return {
    deps,
    session,
    spawnCalls,
    removed,
    audits,
    emitted,
    connects,
    callWithArgsCalls,
    evalCalls,
    queue,
    child,
    fs,
    clock,
    logs,
    rmAttempts,
    /** 目录是否还「存在」（删过的算不存在，等价于现场 `Test-Path`） */
    dirExists: (p: string) => !goneDirs.has(p),
    get portReads() { return portReads; },
    get cdpClosed() { return cdpClosed; },
    get listProcessCalls() { return listProcessCalls; },
    setProcesses: (rows: Row[]) => { processes = rows; },
    /** 手动跑一次 16 ms 轮询（生产由 setInterval 驱动） */
    tick: async () => { if (intervalFn) await intervalFn(); },
    get hasInterval() { return !!intervalFn; },
    killCalls: () => spawnCalls.filter((c) => c.cmd === 'taskkill'),
    /** 手动跑一次 tick（R3-07 的守卫用） */
    runTick: () => { if (intervalFn) (intervalFn as () => unknown)(); },
  };
}



describe('record-session：进程表解析（纯函数，wmic/CIM 两种口味都要认）', () => {
  it('解析 pid|创建时间|命令行 三列，命令行里的 | 不被切断', () => {
    const text = [
      '4242|2026-11-25T03:00:05.000Z|C:/chrome.exe --remote-debugging-port=0 --user-data-dir=C:/data/pm/record-profiles/s1',
      '777|2026-11-25T02:00:00.000Z|C:/Program Files/Google/Chrome/chrome.exe --user-data-dir=C:/Users/u/App Data',
      '888|2026-11-25T02:10:00.000Z|C:/x.exe --title=a|b',
      '',
    ].join('\r\n');
    const rows = parseProcessList(text);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ pid: 4242, commandLine: expect.stringContaining('--user-data-dir=') });
    expect(rows[0].creationDate).toBe(Date.parse('2026-11-25T03:00:05.000Z'));
    expect(rows[2].commandLine).toBe('C:/x.exe --title=a|b');
  });

  it('空行 / 缺列 / 非数字 pid 一律跳过（不许因为一行脏数据整轮失败）', () => {
    const rows = parseProcessList('\n坏行\nabc|2026-11-25T03:00:05.000Z|cmd\n900|not-a-date|cmd2\n');
    expect(rows).toEqual([]);
  });

  it('常量与契约一致：16 ms 合批 / 单批 20 / 5000 上限 / 15 s 启动超时 / 临时 profile 根目录名', () => {
    expect(FLUSH_MS).toBe(16);
    expect(POLL_BATCH).toBe(20);
    expect(MAX_EVENTS).toBe(5000);
    expect(START_TIMEOUT_MS).toBe(15000);
    expect(PROFILE_ROOT_NAME).toBe('record-profiles');
    expect(AUDIT_ACTION).toBe('record-session');
  });
});

describe('record-session：正常 start → stop', () => {
  it('拿不到数据目录 → 拒绝启动，不许静默降级成「只做前三道检查」（SEC-R2-03 收口）', async () => {
    const h = harness({ getDataDir: () => '' });
    const r = await h.session.start({ url: 'https://example.com/login' });
    expect(r).toMatchObject({ ok: false, error: '数据目录未就绪，无法启动录制' });
    expect(h.spawnCalls).toHaveLength(0);   // 一个进程都没起
    expect(h.connects).toHaveLength(0);     // 更没连 CDP
    // 状态可回到 idle：下一次还能正常启动（不是卡在 starting）
    expect(h.session.status()).toBe(null);
  });

  it('数据目录就绪且 profile 落在其下 → containment 为 checked，正常启动', async () => {
    const h = harness();
    const r = await h.session.start({ url: 'https://example.com/login' });
    expect(r.ok).toBe(true);
    const userDir = String(h.spawnCalls[0].args.find((a) => a.startsWith('--user-data-dir=')));
    // 归一化后必须以数据目录开头（validateUserDataDir 的包含性检查真的跑到了）
    expect(userDir.replace('--user-data-dir=', '')).toMatch(/^C:\/data\/pm\/record-profiles\//);
  });

  it('spawn 用 args 数组 + shell:false，端口取自 DevToolsActivePort，启动 URL 与入库 URL 分开', async () => {
    const h = harness();
    const r = await h.session.start({ url: 'https://admin:pw@example.com/login?projectCode=ABC&from=uitest' });
    expect(r.ok).toBe(true);
    expect(String(r.data?.sessionId)).toMatch(/^[0-9a-f]{24}$/);

    const call = h.spawnCalls[0];
    expect(call.cmd).toBe(CHROME);
    expect(Array.isArray(call.args)).toBe(true);
    expect(call.opts.shell).toBe(false);
    expect(call.args).toContain('--remote-debugging-port=0');
    const userDir = call.args.find((a) => a.startsWith('--user-data-dir='));
    expect(userDir).toBeTruthy();
    // 临时 profile 建在**数据目录下**（不是 %TEMP%），且带 record-profiles/<sessionId>
    expect(String(userDir)).toContain(`${DATA_DIR}/${PROFILE_ROOT_NAME}/`);
    expect(String(userDir)).toContain(String(r.data?.sessionId));

    // 启动 URL 保留业务 query（丢了 ?projectCode= 被测系统打开的是坏链接）且剥掉 userinfo
    expect(call.args[call.args.length - 1]).toBe('https://example.com/login?projectCode=ABC&from=uitest');
    expect(call.args.join(' ')).not.toContain('admin');
    expect(call.args.join(' ')).not.toContain('pw@');
    // 不含 <redacted> 占位（v19：占位不用于导航）
    expect(call.args.join(' ')).not.toContain('<redacted>');

    // RA3-07：出参只回浏览器名，本机绝对路径不出主进程
    expect(r.data?.browser).toBe('Chrome');
    expect(String(r.data?.browser)).not.toContain('/');
    expect(r.data?.port).toBe(52345);
    // cdp-client 的目标解析交给它自己（t18 修成按 port 解析 /json/list）：
    // 会话层只给 port（来自 DevToolsActivePort 第一行）+ 当前实现兼容用的 wsUrl，
    // **绝不**在这里自己 /json/list 或拼 ws://（两处实现必然漂移）
    // 目标发现是 cdp-client 的职责：会话层**只给 port**（不再传 wsUrl，契约 v21 / RA2-01）
    expect(h.connects[0]).toEqual({ port: 52345, timeout: expect.any(Number) });

    // 注入顺序：先装队列（参数 = binding 名），再装 S2 的注入器（参数 = nonce）
    const binding = h.callWithArgsCalls[0];
    const nonce = createHash('sha256').update(String(r.data?.sessionId)).digest('hex').slice(0, 12);
    // 第二个参数是通道标记（SEC-R3-07），poll 用它识别「__dshQueueTake 被替换」
    expect(binding.args).toEqual([`__dsh_${nonce}`, nonce]);
    expect(h.callWithArgsCalls[1].fn).toBe(INSTALL_FN_SRC);
    expect(h.callWithArgsCalls[1].args).toEqual([nonce]);
    // 轮询表达式是常量
    // 轮询表达式是**常量**（含被替换检测），不含任何外部输入
    await h.tick();
    expect(h.evalCalls.length).toBeGreaterThan(0);
    expect(h.evalCalls.some((e) => e === POLL_EXPR)).toBe(true);
    expect(h.evalCalls.every((e) => e === POLL_EXPR || e === PAGE_READY_EXPR)).toBe(true);
    expect(POLL_EXPR.includes('__dshTakeTampered__')).toBe(true);
    expect(h.hasInterval).toBe(true);

    // 入库 / 出参 → 只留 origin + path（业务 query 与 userinfo 都不出境）
    const status = h.session.status();
    expect(status?.url).toBe('https://example.com/login');
    expect(JSON.stringify(status)).not.toContain('projectCode');
    expect(JSON.stringify(status)).not.toContain('admin');
    await h.session.stop({ sessionId: String(r.data?.sessionId) });
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.host).toBe('example.com');
    expect(JSON.stringify(audit)).not.toContain('projectCode');
    expect(JSON.stringify(audit)).not.toContain('/login');
  });

  it('status 只暴露 recording；stop 杀自有 pid、删 profile、写 13 字段审计（含 truncated）', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/login?token=SECRET' });
    const sid = String(started.data?.sessionId);
    const profileDir = String(h.spawnCalls[0].args.find((a) => a.startsWith('--user-data-dir='))).replace('--user-data-dir=', '');

    const st = h.session.status();
    expect(st).toEqual({
      sessionId: sid,
      state: 'recording',
      startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      url: 'https://example.com/login',
    });
    expect(JSON.stringify(st)).not.toContain('SECRET');
    expect(JSON.stringify(st)).not.toContain('stopping');

    const stopped = await h.session.stop({ sessionId: sid });
    expect(stopped.ok).toBe(true);
    expect(stopped.data).toMatchObject({
      ok: true,
      received: 0,
      pushed: 0,
      dropped: 0,
      truncated: false,
      cleaned: { killed: true, profileRemoved: true },
    });

    // 杀进程：taskkill /PID 4242 /T /F，args 数组，绝不 /IM
    const kills = h.killCalls();
    expect(kills).toHaveLength(1);
    expect(kills[0].args).toEqual(['/PID', '4242', '/T', '/F']);
    expect(kills[0].opts.shell).toBe(false);
    expect(h.spawnCalls.every((c) => !c.args.includes('/IM'))).toBe(true);

    // 临时 profile 已删（数据目录下那个），且**删完真的不存在**（等价于现场 Test-Path）
    expect(h.removed).toContain(profileDir);
    expect(h.dirExists(profileDir)).toBe(false);

    // stop 热路径**不许**调 listProcesses（PowerShell 全量枚举是 D-3 的长尾根因）
    expect(h.listProcessCalls).toBe(0);

    // 审计 13 字段（契约 [C-119] 第 7 款：v20 起含 truncated），只记 host
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(Object.keys(audit).sort()).toEqual([
      'action', 'sessionId', 'host', 'startedAt', 'stoppedAt',
      'eventCount', 'received', 'pushed', 'dropped', 'truncated', 'killed', 'profileRemoved', 'ok',
    ].sort());
    expect(audit.action).toBe(AUDIT_ACTION);
    expect(audit.host).toBe('example.com');
    expect(audit.killed).toBe(true);
    expect(audit.profileRemoved).toBe(true);
    expect(audit.ok).toBe(true);
    expect(JSON.stringify(audit)).not.toContain('SECRET');
    expect(JSON.stringify(audit)).not.toContain('/login');

    expect(h.session.getState()).toBe('idle');
    expect(h.session.status()).toBeNull();
    expect(h.hasInterval).toBe(false);
  });

  it('taskkill 抛错时 killed:false，仍删 profile、仍写审计且 ok:false', async () => {
    // taskkill 派发失败（无权限 / 进程已消失的极端情形）→ 一律不假装杀成功
    const h = harness({ killFails: true });
    const started = await h.session.start({ url: 'https://example.com/' });
    const stopped = await h.session.stop({ sessionId: String(started.data?.sessionId) });

    expect(stopped.ok).toBe(true);
    expect(stopped.data?.cleaned).toMatchObject({ killed: false, profileRemoved: true });
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.killed).toBe(false);
    expect(audit.ok).toBe(false);
    expect(audit.profileRemoved).toBe(true);
  });

  it('目录被占用（rmSync 抛 EPERM）→ profileRemoved:false + 出参与日志写明占用子项，审计 ok:false', async () => {
    // 这是评审点名的「零覆盖」路径：旧实现 catch 完只回 false，看不见为什么
    const h = harness({
      rmError: (dir) => {
        const err = new Error('EPERM: operation not permitted, unlink');
        (err as unknown as { code: string }).code = 'EPERM';
        // Windows 真机上的形态：被占用的是 profile 里的**某个文件**，Node 把它的绝对路径放进 e.path
        (err as unknown as { path: string }).path = `${dir}/Default/Cookies`;
        return err;
      },
    });
    const started = await h.session.start({ url: 'https://example.com/' });
    const sid = String(started.data?.sessionId);
    const profileDir = String(h.spawnCalls[0].args.find((a) => a.startsWith('--user-data-dir='))).replace('--user-data-dir=', '');
    const stopped = await h.session.stop({ sessionId: sid });

    // 出参：false + 原因（不含绝对路径，只给相对子项）
    expect(stopped.data?.cleaned.profileRemoved).toBe(false);
    const err = stopped.data?.cleaned.profileRemovedError as { code: string; item: string } | undefined;
    expect(err?.code).toBe('EPERM');
    expect(err?.item).toBe('Default/Cookies');

    // 审计同源：ok:false + profileRemoved:false + **契约 v23 的可选原因字段**（13 必填 + 1 可选 = 14）
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.profileRemoved).toBe(false);
    expect(audit.ok).toBe(false);
    expect(Object.keys(audit)).toHaveLength(14);
    expect(audit.profileRemovedError).toMatchObject({ code: 'EPERM', item: 'Default/Cookies' });

    // 有界重试：3 次（0 / 120 / 240 ms），不是「无限重试」也不是「一次就放弃」
    expect(h.rmAttempts.filter((a) => a.dir === profileDir)).toHaveLength(3);
    // 日志里写清是哪个子项被占（排障用；不含绝对路径）
    const line = h.logs.find((l) => l.includes('删不掉')) || '';
    expect(line).toContain('EPERM@Default/Cookies');
    expect(line).not.toContain('C:/data/pm');
  });

  it('进程一直不退：按 exitWaitMs 有界等待（不无限轮询），仍尝试删并写明结果', async () => {
    const h = harness({ isProcessAlive: () => true });
    const started = await h.session.start({ url: 'https://example.com/' });
    const t0 = h.clock.now();
    const stopped = await h.session.stop({ sessionId: String(started.data?.sessionId) });
    // 有界：只等 exitWaitMs（800ms），不是死循环
    expect(h.clock.now() - t0).toBeLessThanOrEqual(800 + 400);
    expect(stopped.data?.cleaned.profileRemoved).toBe(true); // 删一次就成功（进程没真占着）
    expect(h.logs.some((l) => l.includes('未退出'))).toBe(true);
  });

  it('重复 stop 幂等：同 id 回零计数，未知 id 回「会话已结束」', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    const sid = String(started.data?.sessionId);
    await h.session.stop({ sessionId: sid });

    const again = await h.session.stop({ sessionId: sid });
    expect(again.ok).toBe(true);
    expect(again.data).toMatchObject({ received: 0, pushed: 0, dropped: 0, truncated: false, cleaned: { killed: false, profileRemoved: false } });

    const unknown = await h.session.stop({ sessionId: 'deadbeefdeadbeefdeadbeef' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toBe('会话已结束');
  });
});

describe('record-session：失败与并发', () => {
  it('DevToolsActivePort 一直不出现 → 15 s 超时回「启动失败」，并杀掉子进程、删 profile', async () => {
    const h = harness({ portReadyAt: Infinity });
    const r = await h.session.start({ url: 'https://example.com/' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('启动失败');
    expect(h.session.getState()).toBe('idle');
    expect(h.child.killed).toBe(true);
    expect(h.removed.length).toBe(1);
    expect(h.killCalls().every((c) => !c.args.includes('/IM'))).toBe(true);
    // 超时确实等到 15 s（按注入的假时钟）
    expect(h.portReads).toBeGreaterThan(100);
  });

  it('子进程启动即退出 → 立刻回「启动失败」（不必等满 15 s）', async () => {
    const h = harness({ portReadyAt: Infinity });
    const pending = h.session.start({ url: 'https://example.com/' });
    // 模拟子进程退出：把 exitCode 置上，并让下一次读文件失败
    h.child.exitCode = 1;
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(['启动失败', '浏览器启动被拦截']).toContain(String(r.error));
    expect(h.session.getState()).toBe('idle');
  });

  it('并发 start：第二次立刻回「启动进行中，请稍候重试」，不排队', async () => {
    const h = harness({ portReadyAt: 3 });
    const first = h.session.start({ url: 'https://example.com/a' });
    const second = await h.session.start({ url: 'https://example.com/b' });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('启动进行中，请稍候重试');
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
  });

  it('已有会话在录制 → 「已有会话在录制」并带现有 sessionId；未解锁的 URL 校验先抛', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    const second = await h.session.start({ url: 'https://example.com/x' });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('已有会话在录制');
    expect(second.data).toMatchObject({ sessionId: started.data?.sessionId });

    const bad = await h.session.start({ url: 'file:///etc/passwd' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('URL 不合法');
    expect(h.spawnCalls).toHaveLength(1);
  });

  it('找不到 Chromium 系浏览器 → 「未检测到 Chromium 系浏览器」，且不 spawn', async () => {
    const h = harness({ which: () => '', exists: () => false });
    const r = await h.session.start({ url: 'https://example.com/' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('未检测到 Chromium 系浏览器');
    expect(h.spawnCalls).toHaveLength(0);
  });
});

describe('record-session：启动扫残留（只碰自己的 profile 根）', () => {
  it('只杀 cmdline 前缀匹配本应用临时 profile 根的进程，不碰用户真实浏览器', async () => {
    const h = harness();
    const root = `${DATA_DIR}/${PROFILE_ROOT_NAME}`;
    h.setProcesses([
      { pid: 111, commandLine: `${CHROME} --remote-debugging-port=0 --user-data-dir=${root}/old1`, creationDate: Date.now() - 60_000 },
      { pid: 222, commandLine: `${CHROME} --user-data-dir=C:/Users/u/AppData/Local/Google/Chrome/User Data`, creationDate: Date.now() - 60_000 },
      { pid: 333, commandLine: `C:/msedge.exe --user-data-dir=${root}/old2`, creationDate: Date.now() - 60_000 },
      { pid: 444, commandLine: 'C:/x.exe --user-data-dir=D:/other', creationDate: Date.now() - 60_000 },
    ]);

    const r = await h.session.scanOrphans();
    expect(r.scanned).toBe(4);
    expect(r.killed).toBe(2);
    const killedPids = h.killCalls().map((c) => c.args[1]);
    expect(killedPids.sort()).toEqual(['111', '333']);
    expect(h.spawnCalls.every((c) => !c.args.includes('/IM'))).toBe(true);
    expect(h.spawnCalls.every((c) => c.opts.shell === false)).toBe(true);
    // 扫残留也要留痕（审计 action 固定），且不因清理成功而写 ok:true 的「会话」
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.action).toBe(AUDIT_ACTION);
    expect(audit.sessionId).toBe('startup-scan');
  });

  it('进程表读不到（无权限）→ 不重试、不抛，写审计后继续', async () => {
    const h = harness({ listProcesses: () => { throw new Error('拒绝访问'); } });
    const r = await h.session.scanOrphans();
    expect(r.scanned).toBe(0);
    expect(r.killed).toBe(0);
    expect(lastOf(h.audits)).toMatchObject({ action: AUDIT_ACTION, sessionId: 'startup-scan', ok: false });
  });
});

describe('record-session：事件（16 ms 合批 / 单批 20 / 5000 截断）', () => {
  it('从页内队列取事件 → 补 sessionId/seq → 交给上抛回调；非法事件丢弃计数', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    const sid = String(started.data?.sessionId);

    h.queue.push(JSON.stringify({ action: 'click', target: { tag: 'button', text: '登录' }, candidates: [{ strategy: 'css', selector: '#go', count: 1, precise: true }], ms: 5 }));
    h.queue.push('不是 JSON');
    h.queue.push(JSON.stringify({ action: 'nope', target: { tag: 'div' }, candidates: [], ms: 6 }));
    h.queue.push(JSON.stringify({ action: 'fill', target: { tag: 'input' }, candidates: [], valueMeta: { length: 3, redacted: true }, ms: 7, seq: 999 }));

    await h.tick();
    expect(h.emitted).toHaveLength(2);
    // target.text 一律不转发（主进程是载荷唯一强制点：页面文本可能是手机号 / token）
    expect(h.emitted[0]).toEqual({
      sessionId: sid,
      seq: 1,
      action: 'click',
      target: { tag: 'button' },
      candidates: [{ strategy: 'css', selector: '#go', count: 1, precise: true }],
      ms: 5,
    });
    expect(JSON.stringify(h.emitted[0])).not.toContain('登录');
    // 主进程自己发 seq，页面给的 seq 一律丢弃
    expect(h.emitted[1]).toMatchObject({ sessionId: sid, seq: 2, action: 'fill', valueMeta: { length: 3, redacted: true } });
    expect(h.emitted[1].seq).not.toBe(999);

    const stopped = await h.session.stop({ sessionId: sid });
    expect(stopped.data).toMatchObject({ received: 4, pushed: 2, dropped: 2, truncated: false });
    expect((stopped.data as unknown as Record<string, unknown>).eventCount).toBeUndefined();
    expect((lastOf(h.audits) as Record<string, unknown>).eventCount).toBe(2);
  });

  it('伪造载荷（页面绕过注入器直调 binding）：长度截断、未知键全丢、seq/sessionId 由主进程重发', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    const sid = String(started.data?.sessionId);

    h.queue.push(JSON.stringify({
      // 伪造：超长 tag/role/text、21 个候选（含超长 selector）、一堆未知键、想冒充 sessionId/seq、夹带明文
      sessionId: 'forged-session',
      seq: 999999,
      action: 'click',
      value: '明文口令',
      extra: 'x',
      target: { tag: 't'.repeat(300), role: 'r'.repeat(200), text: '机密正文', href: 'https://x/?token=T' },
      candidates: Array.from({ length: 21 }, (_, i) => ({
        strategy: 'css',
        selector: i === 0 ? '#' + 'a'.repeat(600) : `#c${i}`,
        count: i,
        precise: i === 1,
        junk: 'x',
      })),
      ms: 12,
    }));

    await h.tick();
    expect(h.emitted).toHaveLength(1);
    const ev = h.emitted[0] as Record<string, unknown>;
    expect(ev.sessionId).toBe(sid);
    expect(ev.seq).toBe(1);
    const target = ev.target as Record<string, unknown>;
    expect(String(target.tag)).toHaveLength(32);
    expect(String(target.role)).toHaveLength(64);
    expect(target.text).toBeUndefined();
    expect(target.href).toBeUndefined();
    const candidates = ev.candidates as Array<Record<string, unknown>>;
    expect(candidates.length).toBeLessThanOrEqual(POLL_BATCH);
    // 超长 selector（>500）整条候选被丢弃，而不是截断成半截选择器
    expect(candidates.every((c) => String(c.selector).length <= 500)).toBe(true);
    expect(candidates.some((c) => String(c.selector).startsWith('#aaaa'))).toBe(false);
    expect(candidates[0]).toEqual({ strategy: 'css', selector: '#c1', count: 1, precise: true });
    // 未知键与明文值全部不进载荷
    expect(Object.keys(ev).sort()).toEqual(['action', 'candidates', 'ms', 'seq', 'sessionId', 'target']);
    expect(JSON.stringify(ev)).not.toContain('明文口令');
    expect(JSON.stringify(ev)).not.toContain('机密正文');
    expect(JSON.stringify(ev)).not.toContain('forged-session');
    await h.session.stop({ sessionId: sid });
  });

  it('到上限置 truncated 且不静默：只在 stop 出参 + 审计里体现，事件仍只带约定键', async () => {
    const h = harness({ maxEvents: 2 });
    const started = await h.session.start({ url: 'https://example.com/' });
    for (let i = 0; i < 4; i += 1) {
      h.queue.push(JSON.stringify({ action: 'click', target: { tag: 'a' }, candidates: [], ms: i }));
    }
    await h.tick();
    const profileDir = String(h.spawnCalls[0].args.find((a) => a.startsWith('--user-data-dir='))).replace('--user-data-dir=', '');
    h.setProcesses([{ pid: 4242, commandLine: `${CHROME} --user-data-dir=${profileDir}`, creationDate: h.clock.now() - 1000 }]);
    const stopped = await h.session.stop({ sessionId: String(started.data?.sessionId) });
    expect(stopped.data).toMatchObject({ pushed: 2, dropped: 2, truncated: true });
    expect(h.emitted.filter((e) => e.action === 'session-ended')).toHaveLength(1);
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.dropped).toBe(2);
    expect(audit.ok).toBe(true);
    // 载荷仍只带约定键：6 个 + 可选的 valueMeta，没有第 7 个自由字段
    for (const e of h.emitted) {
      const keys = Object.keys(e).sort();
      expect(keys.every((k) => ['action', 'candidates', 'ms', 'seq', 'sessionId', 'target', 'valueMeta'].includes(k))).toBe(true);
    }
  });

  it('valueMeta 是判别联合：{length} 或 {selectedIndex}，两者同时出现/都没有一律剥掉', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    h.queue.push(JSON.stringify({ action: 'fill', target: { tag: 'input' }, candidates: [], valueMeta: { length: 3, redacted: true }, ms: 1 }));
    h.queue.push(JSON.stringify({ action: 'fill', target: { tag: 'input' }, candidates: [], valueMeta: { length: 3, selectedIndex: 1, redacted: true }, ms: 2 }));
    h.queue.push(JSON.stringify({ action: 'fill', target: { tag: 'input' }, candidates: [], valueMeta: { redacted: true }, ms: 3 }));
    h.queue.push(JSON.stringify({ action: 'select', target: { tag: 'select' }, candidates: [], valueMeta: { selectedIndex: 2, redacted: true }, ms: 4 }));
    h.queue.push(JSON.stringify({ action: 'fill', target: { tag: 'input' }, candidates: [], valueMeta: { length: 3, redacted: false }, ms: 5 }));
    await h.tick();
    expect(h.emitted[0].valueMeta).toEqual({ length: 3, redacted: true });
    expect(h.emitted[1].valueMeta).toBeUndefined();
    expect(h.emitted[2].valueMeta).toBeUndefined();
    expect(h.emitted[3].valueMeta).toEqual({ selectedIndex: 2, redacted: true });
    expect(h.emitted[4].valueMeta).toBeUndefined();
    // 永远不许出现 value 键（明文）
    expect(JSON.stringify(h.emitted)).not.toContain('"value"');
    await h.session.stop({ sessionId: String(started.data?.sessionId) });
  });

  it('单批不超过 POLL_BATCH 条（25 条分两次取：20 + 5）', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    for (let i = 0; i < 25; i += 1) h.queue.push(JSON.stringify({ action: 'click', target: { tag: 'a' }, candidates: [], ms: i }));
    await h.tick();
    expect(h.emitted).toHaveLength(POLL_BATCH);
    await h.tick();
    expect(h.emitted).toHaveLength(25);
    await h.session.stop({ sessionId: String(started.data?.sessionId) });
  });
});

describe('record-session：record:lock-stop（锁定/自动锁/关窗/防截屏 = 同步停录）', () => {
  it('锁定即停录：杀掉浏览器、推 session-ended、status 回 null、写审计', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/secret?token=T' });
    const sid = String(started.data?.sessionId);
    const profileDir = String(h.spawnCalls[0].args.find((a) => a.startsWith('--user-data-dir='))).replace('--user-data-dir=', '');
    h.setProcesses([{ pid: 4242, commandLine: `${CHROME} --user-data-dir=${profileDir}`, creationDate: h.clock.now() - 1000 }]);

    const r = h.session.lockStop('session-lock');
    expect(r).toMatchObject({ ok: true, killed: true, profileRemoved: true });
    expect(h.session.status()).toBeNull();
    expect(h.session.getState()).toBe('idle');
    expect(h.emitted.some((e) => e.action === 'session-ended')).toBe(true);
    expect((lastOf(h.audits) as Record<string, unknown>).sessionId).toBe(sid);
  });

  it('没有会话时 lockStop 是空操作（幂等，不写审计）', async () => {
    const h = harness();
    const before = h.audits.length;
    const r = h.session.lockStop('window-close');
    expect(r).toMatchObject({ ok: true, killed: false, profileRemoved: false });
    expect(h.audits.length).toBe(before);
  });
});

describe('record-session：record:validate（参数化 + 逐条超时 + 入参校验）', () => {
  it('selector / strategy 只经结构化参数传给页内常量函数', async () => {
    const h = harness({ validateResult: { count: 2, precise: false } });
    const started = await h.session.start({ url: 'https://example.com/' });
    const r = await h.session.validate({
      sessionId: String(started.data?.sessionId),
      items: [{ strategy: 'css', selector: '#login' }],
    });
    expect(r.ok).toBe(true);
    expect(r.data?.results[0]).toMatchObject({ strategy: 'css', selector: '#login', count: 2, precise: false });
    const call = lastOf(h.callWithArgsCalls)!;
    expect(call.args).toEqual(['css', '#login']);
    expect(call.fn).toContain('function');
    expect(call.fn).not.toContain('#login');
  });

  it('入参校验：items >50 / 非法 strategy / selector 超长或含 NUL 换行 → 入参不合法', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    const sid = String(started.data?.sessionId);
    const many = Array.from({ length: 51 }, () => ({ strategy: 'css', selector: '#a' }));

    for (const items of [
      many,
      [{ strategy: 'jquery', selector: '#a' }],
      [{ strategy: 'css', selector: 'a'.repeat(501) }],
      [{ strategy: 'css', selector: 'a\nb' }],
      [{ strategy: 'css', selector: 'a\u0000b' }],
      [{ strategy: 'css' }],
    ]) {
      const r = await h.session.validate({ sessionId: sid, items: items as never });
      expect(r.ok, JSON.stringify(items).slice(0, 60)).toBe(false);
      expect(r.error).toBe('入参不合法');
    }
    await h.session.stop({ sessionId: sid });
  });

  it('单条超时 → 该条 invalid:true + error「超时」，其余照常返回（先到者生效）', async () => {
    const h = harness({
      onCallWithArgs: (fn, args) => {
        if (args[1] === '#slow') throw new Error('超时（3000ms）：CDP Runtime.callFunctionOn');
        return { count: 1, precise: true };
      },
    });
    const started = await h.session.start({ url: 'https://example.com/' });
    const r = await h.session.validate({
      sessionId: String(started.data?.sessionId),
      items: [{ strategy: 'css', selector: '#slow' }, { strategy: 'css', selector: '#fast' }],
    });
    expect(r.ok).toBe(true);
    expect(r.data?.results[0]).toMatchObject({ invalid: true, error: '超时', count: 0, precise: false });
    expect(r.data?.results[1]).toMatchObject({ count: 1, precise: true });
  });

  it('会话不存在 / 已结束 → 「会话已结束」', async () => {
    const h = harness();
    const r = await h.session.validate({ sessionId: 'nope', items: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('会话已结束');
  });
});



describe('record-session：启动失败也要留痕（R3-02）', () => {
  it('spawn 浏览器就失败 → 写一条 13 字段审计（ok:false），并尽力删目录', async () => {
    const h = harness({ spawnThrows: true });
    const before = h.audits.length;
    const r = await h.session.start({ url: 'https://example.com/login' });
    expect(r).toMatchObject({ ok: false, error: '启动失败' });
    expect(h.audits.length).toBe(before + 1);
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(Object.keys(audit)).toHaveLength(13);
    expect(audit.sessionId).toMatch(/^[0-9a-f]{24}$/);
    expect(audit.host).toBe('example.com');
    expect(audit.killed).toBe(false);
    expect(audit.ok).toBe(false);
    expect(audit.eventCount).toBe(0);
  });

  it('等 DevToolsActivePort 超时 → 杀子进程 + 删目录 + 审计（ok:false, killed:true）', async () => {
    const h = harness({ portReadyAt: Infinity });
    const r = await h.session.start({ url: 'https://example.com/' });
    expect(r.ok).toBe(false);
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.sessionId).toMatch(/^[0-9a-f]{24}$/);
    expect(audit.ok).toBe(false);
    expect(audit.killed).toBe(true);
    expect(audit.profileRemoved).toBe(true);
  });

  it('CDP 连接失败 → 杀子进程 + 删目录 + 审计（ok:false）', async () => {
    const h = harness({ connectCdpThrows: '目标发现失败：/json/list 里没有可用的 page target' });
    const r = await h.session.start({ url: 'https://example.com/' });
    expect(r).toMatchObject({ ok: false, error: '启动失败' });
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.ok).toBe(false);
    expect(audit.killed).toBe(true);
    expect(audit.profileRemoved).toBe(true);
    expect(h.child.killed).toBe(true);
  });
});

describe('record-session：启动清扫必须删目录（D-2 的另一半）', () => {
  it('杀掉残留进程后删它的 profile 目录；进程早没了的残留目录也清掉；不碰当前会话', async () => {
    const root = `${DATA_DIR}/${PROFILE_ROOT_NAME}`;
    const staleDir = `${root}/0123456789abcdef01234567`;   // cmdline 里能匹配到的那个
    const orphanDir = `${root}/89abcdef0123456789abcdef`;  // 进程早没了、目录还在
    const h = harness({ readdirSync: (dir: string) => (dir === root ? ['0123456789abcdef01234567', '89abcdef0123456789abcdef', 'not-a-session'] : []) });
    h.setProcesses([
      { pid: 111, commandLine: `${CHROME} --remote-debugging-port=0 --user-data-dir=${staleDir}`, creationDate: Date.now() - 60_000 },
      { pid: 222, commandLine: `${CHROME} --user-data-dir=C:/Users/u/AppData/Local/Google/Chrome/User Data`, creationDate: Date.now() - 60_000 },
    ]);

    const r = await h.session.scanOrphans();
    expect(r.scanned).toBe(2);
    expect(r.killed).toBe(1);
    // 两个 sessionId 形状的目录都被删，非 sessionId 名字一律不碰
    expect(h.removed).toContain(staleDir);
    expect(h.removed).toContain(orphanDir);
    expect(h.removed.some((p) => p.includes('not-a-session'))).toBe(false);
    expect(h.dirExists(staleDir)).toBe(false);
    expect(h.dirExists(orphanDir)).toBe(false);

    // 审计如实记：杀了 + 真删了
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.sessionId).toBe('startup-scan');
    expect(audit.killed).toBe(true);
    expect(audit.profileRemoved).toBe(true);
    expect(audit.ok).toBe(true);
    expect(String(r.errors.length)).toBe('0');
  });

  it('残留目录被占用 → 审计 profileRemoved:false 且 errors 写明占用子项（不吞）', async () => {
    const root = `${DATA_DIR}/${PROFILE_ROOT_NAME}`;
    const staleDir = `${root}/0123456789abcdef01234567`;
    const h = harness({
      readdirSync: (dir: string) => (dir === root ? ['0123456789abcdef01234567'] : []),
      rmError: (dir) => {
        const err = new Error('EBUSY: resource busy or locked');
        (err as unknown as { code: string }).code = 'EBUSY';
        (err as unknown as { path: string }).path = `${dir}/Lockfile`;
        return err;
      },
    });
    const r = await h.session.scanOrphans();
    expect(r.removed).toBe(0);
    expect(r.errors.join('|')).toContain('EBUSY@Lockfile');
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.profileRemoved).toBe(false);
    expect(audit.ok).toBe(false);
  });
});

describe('record-session：删目录的顺序锁（D-2 的根因回归）', () => {
  it('先等进程真的退出，才动 rmSync（砍掉 waitUntil 这条必红）', async () => {
    // 前 5 次探测都「还活着」，第 6 次才退；若实现是「派发 taskkill 后立刻 rmSync」，
    // 第一次 rm 会落在 probes=1（进程还没退）—— 那正是现场 3/4 轮删不掉的形态。
    let alive = 5;
    const h = harness({ isProcessAlive: () => { const now = alive; alive -= 1; return now > 0; } });
    const started = await h.session.start({ url: 'https://example.com/' });
    const profileDir = String(h.spawnCalls[0].args.find((a) => a.startsWith('--user-data-dir='))).replace('--user-data-dir=', '');
    const stopped = await h.session.stop({ sessionId: String(started.data?.sessionId) });

    const attempts = h.rmAttempts.filter((a) => a.dir === profileDir);
    expect(attempts).toHaveLength(1);              // 一删就成（进程已退，不需要重试）
    // 关键断言：第一次 rm 之前至少探测了 6 次（= 等到进程消失）
    expect(attempts[0].probes).toBeGreaterThanOrEqual(6);
    expect(stopped.data?.cleaned.profileRemoved).toBe(true);
    expect(h.dirExists(profileDir)).toBe(false);
  });
});

// ─────────────────────────────────────────────── t36：错误路径（R3-03/04/07/09/10 + M2）

/** 把 ipc-record 的 5 个 handler 抓出来（注入替身 ipcMain，不 mock electron） */
function ipcHarness(recordSession: Record<string, () => unknown>) {
  const handlers = new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>();
  const ipcMain = {
    handle: (name: string, fn: (event: unknown, input?: unknown) => Promise<unknown>) => { handlers.set(name, fn); },
  };
  registerRecordIpc({ recordSession, getPassword: () => 'pw', ipcMain } as never);
  const call = (name: string, input?: unknown) => {
    const fn = handlers.get(name);
    if (!fn) throw new Error(`没注册通道：${name}`);
    return fn(null, input);
  };
  return { handlers, call };
}

describe('ipc-record：错误文案必须场景化（R3-03 / [C-04] 禁「操作失败」）', () => {
  it('四个非 start 通道的 catch 各给自己的中文文案，且不再出现「操作失败」', async () => {
    const boom = () => { throw new Error('底层炸了：ENOENT'); };
    const h = ipcHarness({
      probe: boom, start: async () => { throw new Error('x'); }, stop: async () => { throw new Error('x'); },
      validate: async () => { throw new Error('x'); }, status: boom,
    } as never);

    const probe = await h.call('record:probe', {});
    expect(probe).toEqual({ success: false, error: ERR_PROBE });
    const stop = await h.call('record:stop', { sessionId: 'a' });
    expect(stop).toEqual({ success: false, error: ERR_STOP });
    const validate = await h.call('record:validate', { sessionId: 'a', items: [] });
    expect(validate).toEqual({ success: false, error: ERR_VALIDATE });
    const status = await h.call('record:status');
    expect(status).toEqual({ success: false, error: ERR_STATUS });

    // 契约 [C-04]：整个模块不许再出现「操作失败」这种笼统文案
    for (const answer of [probe, stop, validate, status]) {
      expect(JSON.stringify(answer)).not.toContain('操作失败');
    }
    // 四条串互不相同（一句兜底糊住所有失败 = 修了文案没修可诊断性）
    expect(new Set([ERR_PROBE, ERR_STOP, ERR_VALIDATE, ERR_STATUS]).size).toBe(4);
    // start 复用契约表里已有的「启动失败」
    const start = await h.call('record:start', { url: 'https://example.com/' });
    expect(start).toEqual({ success: false, error: '启动失败' });
  });

  it('会话层返回可预期错误时原样透传（不被场景文案盖掉）', async () => {
    const h = ipcHarness({
      probe: () => ({}),
      start: async () => ({ ok: false, error: '启动进行中，请稍候重试' }),
      stop: async () => ({ ok: false, error: '会话已结束' }),
      validate: async () => ({ ok: false, error: '入参不合法' }),
      status: () => null,
    } as never);
    expect(await h.call('record:start', { url: 'x' })).toEqual({ success: false, error: '启动进行中，请稍候重试' });
    expect(await h.call('record:stop', { sessionId: 'a' })).toEqual({ success: false, error: '会话已结束' });
    expect(await h.call('record:validate', { sessionId: 'a', items: [] })).toEqual({ success: false, error: '入参不合法' });
  });

  it('未解锁一律「未解锁」，且不许先碰会话层（pw 前置）', async () => {
    const handlers = new Map<string, (e: unknown, i?: unknown) => Promise<unknown>>();
    let touched = 0;
    registerRecordIpc({
      recordSession: new Proxy({}, { get: () => () => { touched += 1; return {}; } }),
      getPassword: () => null,
      ipcMain: { handle: (n: string, f: never) => { handlers.set(n, f as never); } },
    } as never);
    for (const ch of ['record:probe', 'record:start', 'record:stop', 'record:validate', 'record:status']) {
      const ans = await handlers.get(ch)!(null, {});
      expect(ans).toEqual({ success: false, error: '未解锁' });
    }
    expect(touched).toBe(0);
  });
});

describe('record-session：starting 窗口的 stop 语义（R3-04）', () => {
  it('start 进行中 stop → 「启动进行中，请稍候重试」，并让这一轮 start 真中止（不留 recording）', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness({ holdConnect: { promise: gate } });

    const starting = h.session.start({ url: 'https://example.com/login' });
    // 让 start 走到「连接 CDP」这个 await（此时 state 已是 starting，session 还是 null）
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session.getState()).toBe('starting');
    expect(h.session.status()).toBeNull();

    const stopped = await h.session.stop({ sessionId: 'whatever' });
    // 旧实现这里回「会话已结束」，但 start 随后照样成功 → 用户以为停了其实在录
    expect(stopped).toEqual({ ok: false, error: '启动进行中，请稍候重试' });

    release();
    const started = await starting;
    // 关键：这一轮 start 必须失败，不能后来自己变成 recording
    expect(started).toMatchObject({ ok: false, error: '启动失败' });
    expect(String(started.detail)).toMatch(/停止请求/);
    expect(h.session.getState()).toBe('idle');
    expect(h.session.status()).toBeNull();
    // 起了就得收：杀进程 + 删目录 + 写审计
    expect(h.killCalls().length).toBeGreaterThanOrEqual(1);
    expect(h.removed.length).toBeGreaterThanOrEqual(1);
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.ok).toBe(false);
    // 取消过之后还能正常再开一轮（没被卡死）
    const again = await h.session.start({ url: 'https://example.com/' });
    expect(again.ok).toBe(true);
  });
});

describe('record-session：事件管线异常必须收敛（R3-07）', () => {
  it('setInterval 调度失败 → 回「启动失败」、不泄漏会话、写审计、下一次 start 仍可用', async () => {
    const h = harness({ setIntervalThrows: '定时器不可用' });
    const r = await h.session.start({ url: 'https://example.com/' });
    expect(r).toMatchObject({ ok: false, error: '启动失败' });
    expect(String(r.detail)).toContain('事件管线启动失败');
    // 不泄漏：状态回 idle、status 为 null —— 旧实现这里会永远回「已有会话在录制」
    expect(h.session.getState()).toBe('idle');
    expect(h.session.status()).toBeNull();
    expect(h.hasInterval).toBe(false);
    // 收尾：杀进程 + 删目录 + 写审计（ok:false）
    expect(h.killCalls().length).toBeGreaterThanOrEqual(1);
    expect(h.removed.length).toBeGreaterThanOrEqual(1);
    expect((lastOf(h.audits) as Record<string, unknown>).ok).toBe(false);
  });

  it('guardTick：同步抛错 / promise reject 都交给 onError，而且不会冒出第二次', async () => {
    const seen: string[] = [];
    guardTick(() => { throw new Error('sync-boom'); }, (e) => { seen.push(String((e as Error).message)); });
    expect(seen).toEqual(['sync-boom']);

    guardTick(() => Promise.reject(new Error('async-boom')), (e) => { seen.push(String((e as Error).message)); });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['sync-boom', 'async-boom']);

    // 正常路径不误报；onError 自己抛也不许冒泡出来
    guardTick(() => Promise.resolve(1), () => { seen.push('不该被调用'); });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['sync-boom', 'async-boom']);
    expect(() => guardTick(() => { throw new Error('again'); }, () => { throw new Error('onError 也炸'); })).not.toThrow();
  });
});

describe('record-session：幂等窗口的边界（R3-09）', () => {
  it('进程内只记最近 RECENT_STOP_LIMIT 个 id：窗口内回零计数，超出回「会话已结束」', async () => {
    expect(RECENT_STOP_LIMIT).toBeGreaterThanOrEqual(1);
    const h = harness();
    const ids: string[] = [];
    for (let i = 0; i < RECENT_STOP_LIMIT + 1; i += 1) {
      const started = await h.session.start({ url: 'https://example.com/' });
      ids.push(String(started.data?.sessionId));
      await h.session.stop({ sessionId: ids[i] });
    }
    // 最新那个还在窗口内
    const newest = await h.session.stop({ sessionId: ids[ids.length - 1] });
    expect(newest.data?.received).toBe(0);
    expect(newest.data?.cleaned).toEqual({ killed: false, profileRemoved: false });
    // 最早那个已被挤出窗口（有界幂等是**已知取舍**：进程内、最近 N 次）
    const oldest = await h.session.stop({ sessionId: ids[0] });
    expect(oldest).toEqual({ ok: false, error: '会话已结束' });
  });
});

describe('record-session：浏览器清单只有一个真源（R3-10）', () => {
  it('ipc-browser.js 里登记的可执行文件，findBrowser 都能认出来（跨文件漂移守卫）', () => {
    const env = { PROGRAMFILES: 'C:/Program Files', 'PROGRAMFILES(X86)': 'C:/Program Files (x86)', LOCALAPPDATA: 'C:/Users/u/AppData/Local' };
    const deps = {
      platform: 'win32', env, which: () => '', exists: () => false,
    };
    const candidates = browserCandidates(deps as never);
    // 真源是 ipc-browser.js 的 KNOWN_BROWSERS；这里**读源码**取它的 exe 清单，于是
    // 「有人往 KNOWN_BROWSERS 加一个浏览器、findBrowser 却不认」会当场红。
    //
    // 取舍（队长认可、代价记在这里）：正则解析源码比 `import { KNOWN_BROWSERS }` 脆 ——
    // 一旦 ipc-browser.js 换了写法（不再写 `'...\\xxx.exe'` 字面量），这条会**假红**。
    // 为什么不去给 ipc-browser.js 补 `.d.ts`：那个文件属别的片（浏览器域），
    // 我这轮只该改录制域；补一个跨片声明文件会让「谁改了什么」变模糊。
    // 因此下面**每条断言都带可执行说明**：先看计数断言（源码格式变了会先红在这里），
    // 再看逐条 exe 断言（那才是真漂移）。看到红请先确认是哪一类，不要直接去改 findBrowser。
    const source = readFileSync(path.join(process.cwd(), 'electron', 'ipc-browser.js'), 'utf8');
    const exeNames = Array.from(new Set((source.match(/[A-Za-z0-9_]+\.exe/g) || []).map((x) => x.toLowerCase())));
    expect(
      exeNames.length,
      `从 electron/ipc-browser.js 源码里只解析出 ${exeNames.length} 个 .exe（期望 ≥9）——`
      + '先怀疑源码换了写法（例如改成常量拼接/变量），这是假红；确认格式没变再看下面的逐条断言',
    ).toBeGreaterThanOrEqual(9); // chrome / msedge / firefox / brave / opera / vivaldi / 360 / qq / quark
    const stemOf = (p: string) => p.replace(/\.exe$/i, '');
    const unlisted: string[] = [];
    for (const exe of exeNames) {
      // Firefox 是**故意不认**的（非 Chromium），单独有反例用例
      if (exe === 'firefox.exe') continue;
      if (!CHROMIUM_EXECUTABLES.includes(stemOf(exe))) {
        unlisted.push(exe);
        continue;
      }
      expect(
        candidates.some((c) => c.endsWith(`/${exe}`)),
        `browserCandidates() 里没有 ${exe}：源码格式若是刚改过的，先看上面那条计数断言（假红）；`
        + '否则才是真漂移 —— 说明 findBrowser 的安装布局没跟着 ipc-browser.js 走',
      ).toBe(true);
      const hit = findBrowser({
        platform: 'win32', env, which: () => '', exists: (p: string) => p.endsWith(`/${exe}`),
      } as never);
      expect(hit.endsWith(`/${exe}`), `findBrowser 没认出 ${exe}（同上：先排除假红）`).toBe(true);
    }
    // 已知缺口**锁在这里**（不是悄悄跳过）：这三个都是 Chromium 系，但 `record-probe.js` 的
    // `CHROMIUM_EXECUTABLES` 白名单里没有 —— 补白名单属 record-probe 面（本片 outOfScope）。
    // 谁把它们加进白名单，这条会红，逼着他把上面的漂移断言一起放开。
    expect(unlisted.sort()).toEqual(['360chrome.exe', 'qqbrowser.exe', 'quark.exe']);
  });

  it('非 Windows 平台有 unix 路径（含 Brave，评审指出的 darwin 漂移就在这里）', () => {
    const list = browserCandidates({ platform: 'darwin', env: {} } as never);
    expect(list).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(list).toContain('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
    expect(browserCandidates({ platform: 'linux', env: {} } as never)).toContain('/usr/bin/chromium');
  });

  it('非 Chromium（Firefox）永远不被选中', () => {
    const env = { PROGRAMFILES: 'C:/Program Files' };
    const hit = findBrowser({
      platform: 'win32', env, which: () => '', exists: (p: string) => p.endsWith('/firefox.exe'),
    } as never);
    expect(hit).toBe('');
  });
});

describe('record-session：启动 URL 只解析一次（M2 假绿转真守门）', () => {
  it('spawn 末位参数 = urlForLaunch 的结果（不是脱敏版），且 resolveUrls 那层改坏会红', async () => {
    const h = harness();
    const raw = 'https://example.com/login?projectCode=ABC&from=uitest#/step/2';
    const started = await h.session.start({ url: raw });
    expect(started.ok).toBe(true);
    const args = h.spawnCalls[0].args;
    const navUrl = args[args.length - 1];
    // 业务 query 保留、fragment 也保留（启动版语义）
    expect(navUrl).toContain('projectCode=ABC');
    expect(navUrl).toContain('from=uitest');
    // 与入库版必须不同（若 start 又把 input.url 传给 buildChromeArgs，这条就失去区分力）
    expect(navUrl).not.toBe('https://example.com/login');
  });
});

// ─────────────────────────────────────────────── t39：排空 / 截断 / 篡改 / 隐私触发 / 三条校验

describe('record-session：停止前必须排空页内队列（RA3-02）', () => {
  it('停止前没被轮询取走的事件，不会被静默丢掉（计入 received/pushed）', async () => {
    const h = harness();
    await h.session.start({ url: 'https://example.com/' });
    // 用户点了两下就立刻停：轮询还没来得及跑
    h.queue.push(JSON.stringify({ action: 'click', target: { tag: 'button' }, candidates: [], ms: 1 }));
    h.queue.push(JSON.stringify({ action: 'click', target: { tag: 'button' }, candidates: [], ms: 2 }));

    const stopped = await h.session.stop({ sessionId: String(h.session.status()?.sessionId) });
    // 旧实现：stop 起手就关 CDP → 这两条既不计 received 也不计 dropped，最后一下点击直接消失
    expect(stopped.data?.received).toBe(2);
    expect(stopped.data?.pushed).toBe(2);
    expect(stopped.data?.dropped).toBe(0);
    expect(stopped.data?.truncated).toBe(false);
    expect(h.emitted.filter((e) => e.action === 'click')).toHaveLength(2);
    // 审计与出参同源
    expect((lastOf(h.audits) as Record<string, unknown>).pushed).toBe(2);
  });

  it('drain 有界：页面永远取不完时，最多 20 轮；剩下的一次性计 dropped + truncated', async () => {
    const one = JSON.stringify({ action: 'click', target: { tag: 'a' }, candidates: [], ms: 1 });
    const h = harness({ evaluateQueueTake: () => new Array(POLL_BATCH).fill(one) });
    await h.session.start({ url: 'https://example.com/' });
    const before = h.evalCalls.length;
    const stopped = await h.session.stop({ sessionId: String(h.session.status()?.sessionId) });

    // 20 轮 drain + 1 次「剩余清点」
    const drainCalls = h.evalCalls.length - before;
    expect(drainCalls).toBe(MAX_DRAIN_ROUNDS + 1);
    expect(stopped.data?.truncated).toBe(true);
    // 最后那批没处理的**计入 dropped**（不是静默丢）
    expect(Number(stopped.data?.dropped)).toBeGreaterThan(0);
    expect(h.logs.some((l) => l.includes('仍有') && l.includes('dropped'))).toBe(true);
  });
});

describe('record-session：事件轮询必须截断（SEC-R3-02 本地 DoS）', () => {
  it('页面返回 10 万条 → 只处理 pollBatch 条，其余计入 dropped，并置 truncated', async () => {
    const one = JSON.stringify({ action: 'click', target: { tag: 'a' }, candidates: [], ms: 1 });
    const h = harness({ evaluateQueueTake: () => new Array(100000).fill(one) });
    const started = await h.session.start({ url: 'https://example.com/' });
    expect(started.ok).toBe(true);

    const t0 = h.clock.now();
    await h.tick(); // 一次轮询
    const elapsed = h.clock.now() - t0;

    // 只吃 20 条，其余 99980 条算 dropped —— 不是把 10 万条全 normalize 一遍
    expect(h.emitted.filter((e) => e.action === 'click')).toHaveLength(POLL_BATCH);
    expect(h.logs.some((l) => l.includes('超过单批上限') && l.includes('99980'))).toBe(true);
    expect(elapsed).toBeLessThan(1000); // 假时钟下只是「没做 10 万次 normalize」的等价断言

    const stopped = await h.session.stop({ sessionId: String(started.data?.sessionId) });
    expect(stopped.data?.truncated).toBe(true);
    expect(stopped.data?.dropped).toBeGreaterThanOrEqual(100000 - POLL_BATCH);
  });

  it('元素形状校验：非对象/数组/超大串一律丢弃计数，不进 normalize', async () => {
    let first = true;
    const h = harness({
      evaluateQueueTake: () => {
        if (!first) return [];
        first = false;
        return [42, null, ['x'], 'x'.repeat(9000), JSON.stringify({ action: 'click', target: { tag: 'a' }, candidates: [], ms: 1 })];
      },
    });
    await h.session.start({ url: 'https://example.com/' });
    await h.tick();
    const stopped = await h.session.stop({ sessionId: String(h.session.status()?.sessionId) });
    expect(stopped.data?.pushed).toBe(1); // 只有那条合法 JSON 串进去了
    expect(stopped.data?.dropped).toBe(4);
  });
});

describe('record-session：取事件通道被替换不许静默空转（SEC-R3-07）', () => {
  it('__dshQueueTake 被换掉 → 显式告警 + 收敛停录（写审计 + 推 session-ended）', async () => {
    const h = harness({ evaluateQueueTake: () => TAKE_TAMPERED });
    const started = await h.session.start({ url: 'https://example.com/' });
    const sid = String(started.data?.sessionId);

    await h.tick();

    // 收敛：会话结束、端口释放、审计 ok:false
    expect(h.session.status()).toBeNull();
    expect(h.session.getState()).toBe('idle');
    expect(h.hasInterval).toBe(false);
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.sessionId).toBe(sid);
    expect(audit.ok).toBe(false);
    // 推了 session-ended（渲染层能立刻知道录制停了，而不是「点了没反应」）
    expect(h.emitted.some((e) => e.action === 'session-ended')).toBe(true);
    // 显式告警落日志
    expect(h.logs.some((l) => l.includes('__dshQueueTake') && l.includes('替换'))).toBe(true);
    // 检测链路的两端都要在：注入侧打标记、轮询侧比标记（删任一端这条就红）
    expect(QUEUE_FN_SRC).toContain('take.__dshTake');
    expect(QUEUE_FN_SRC).toContain('window.__dshTakeMark');
    expect(POLL_EXPR).toContain('__dshTakeMark');
    // 之后还能再开一轮
    expect((await h.session.start({ url: 'https://example.com/' })).ok).toBe(true);
  });
});

describe('record-session：出参只回浏览器名（RA3-07）', () => {
  it('Chrome / Edge / Brave / 非 exe 路径都收敛成展示名，绝不含目录', () => {
    expect(browserLabel('C:/Program Files/Google/Chrome/Application/chrome.exe')).toBe('Chrome');
    expect(browserLabel('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')).toBe('Edge');
    expect(browserLabel('/usr/bin/brave-browser')).toBe('Brave');
    expect(browserLabel('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')).toBe('Google Chrome');
    for (const p of ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/brave-browser', 'C:/x/QQBrowser.exe']) {
      expect(browserLabel(p)).not.toContain('/');
      expect(browserLabel(p)).not.toContain('\\');
    }
  });
});

describe('record-session：三条 P3 校验', () => {
  it('scanOrphans：数据目录为空 → 直接跳过，不读进程表、审计 ok:false', async () => {
    const h = harness({ getDataDir: () => '' });
    const r = await h.session.scanOrphans();
    expect(r.scanned).toBe(0);
    expect(r.killed).toBe(0);
    expect(r.removed).toBe(0);
    expect(r.errors.join('|')).toContain('数据目录未就绪');
    expect(h.listProcessCalls).toBe(0);
    expect((lastOf(h.audits) as Record<string, unknown>).ok).toBe(false);
  });

  it('probe：workspaceDir 非字符串 / 超长 / 含控制字符 → 收敛成「未选工程目录」，不改出参形状', async () => {
    const seen: Array<{ workspaceDir: string; force: boolean }> = [];
    const h = harness({
      probeAbilities: (input: { workspaceDir: string; force: boolean }) => {
        seen.push(input);
        return { probedAt: 'x', abilities: [] };
      },
    });

    for (const bad of [42, {}, [], 'a'.repeat(2000), 'C:/proj\nx', 'C:/proj\u0000x'] as unknown[]) {
      const r = h.session.probe({ workspaceDir: bad } as never) as { abilities: unknown[] };
      expect(Array.isArray(r.abilities)).toBe(true); // 形状不变（仍是 5 灯的结果包）
    }
    expect(seen.map((x) => x.workspaceDir)).toEqual(['', '', '', '', '', '']);
    // 合法路径原样透传
    h.session.probe({ workspaceDir: 'C:/proj', force: true });
    expect(seen[seen.length - 1]).toEqual({ workspaceDir: 'C:/proj', force: true });
  });
});

describe('ipc-record：5 条通道逐条 pw 前置（逐通道用例）', () => {
  const channels = ['record:probe', 'record:start', 'record:stop', 'record:validate', 'record:status'];
  for (const channel of channels) {
    it(`${channel} 未解锁 → 未解锁`, async () => {
      const handlers = new Map<string, (e: unknown, i?: unknown) => Promise<unknown>>();
      let touched = 0;
      registerRecordIpc({
        recordSession: new Proxy({}, { get: () => () => { touched += 1; return {}; } }),
        getPassword: () => null,
        ipcMain: { handle: (n: string, f: never) => { handlers.set(n, f as never); } },
      } as never);
      const ans = await handlers.get(channel)!(null, {});
      expect(ans).toEqual({ success: false, error: '未解锁' });
      expect(touched).toBe(0);
    });
  }
});

describe('ipc-entries：运行期打开防截屏要停录（SEC-R3-03 / [C-114a] 第四触发源）', () => {
  function entriesHarness(opts: { settings: Record<string, unknown>; recordLockStop?: () => void }) {
    const handlers = new Map<string, (e: unknown, i?: unknown) => unknown>();
    const calls = { clearCaches: 0, lockStop: 0, protect: [] as boolean[] };
    const win = { isDestroyed: () => false, isVisible: () => true, setContentProtection: (v: boolean) => { calls.protect.push(v); } };
    const deps: Record<string, unknown> = {
      ipcMain: { handle: (n: string, f: never) => { handlers.set(n, f as never); } },
      getPassword: () => 'pw',
      loadSettings: () => ({ ...opts.settings }),
      saveSettings: () => undefined,
      getWindowPrefs: () => ({ ...opts.settings }),
      getMainWindow: () => win,
      clearCaches: () => { calls.clearCaches += 1; },
      createTray: () => undefined,
      destroyTray: () => undefined,
      ztRestartNotify: () => undefined,
      restartAutoUpdateCheck: () => undefined,
    };
    // 关键：没注入窄接口时它必须是 **undefined**（不是 no-op 函数），否则 typeof 判定会假通过
    deps.recordLockStop = opts.recordLockStop ? () => { calls.lockStop += 1; } : undefined;
    // 其它依赖（本用例不会走到）统一给 no-op
    const proxied = new Proxy(deps, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : () => undefined) });
    registerEntriesIpc(proxied as never);
    const save = (prefs: Record<string, unknown>) => handlers.get('settings:save')!(null, prefs);
    return { calls, save };
  }

  it('从关到开 → 停录一次；已经是开 → 不再重复触发', () => {
    const h = entriesHarness({ settings: { contentProtection: false } });
    h.save({ contentProtection: true });
    expect(h.calls.clearCaches).toBe(1);
    expect(h.calls.protect).toEqual([true]);
    // 再存一次同一状态（旧值已是 true）→ 不重复停录
    const h2 = entriesHarness({ settings: { contentProtection: true } });
    h2.save({ contentProtection: true });
    expect(h2.calls.clearCaches).toBe(0);
  });

  it('关掉防截屏不停录；注入了窄接口 recordLockStop 时优先用它（不清缓存）', () => {
    const off = entriesHarness({ settings: { contentProtection: true } });
    off.save({ contentProtection: false });
    expect(off.calls.clearCaches).toBe(0);

    const narrow = entriesHarness({ settings: { contentProtection: false }, recordLockStop: () => undefined });
    narrow.save({ contentProtection: true });
    expect(narrow.calls.lockStop).toBe(1);
    expect(narrow.calls.clearCaches).toBe(0); // 有窄接口就不清 vault 缓存
  });
});

describe('record-session：清理失败原因要进审计（契约 v23 / SEC-07 闭环）', () => {
  it('删 profile 失败 → 审计里有 profileRemovedError {code, item}，且不含绝对路径', async () => {
    const h = harness({
      rmError: (dir) => {
        const err = new Error('EPERM: operation not permitted, unlink');
        (err as unknown as { code: string }).code = 'EPERM';
        (err as unknown as { path: string }).path = `${dir}/Default/Cookies`;
        return err;
      },
    });
    const started = await h.session.start({ url: 'https://example.com/' });
    expect(started.ok).toBe(true);
    const stopped = await h.session.stop({ sessionId: String(started.data?.sessionId) });

    // 出参（stop）与审计（audit:list 能查到的）都要有原因
    expect(stopped.data?.cleaned.profileRemoved).toBe(false);
    expect(stopped.data?.cleaned.profileRemovedError).toMatchObject({ code: 'EPERM' });
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.profileRemoved).toBe(false);
    const reason = audit.profileRemovedError as { code: string; item: string };
    expect(reason.code).toBe('EPERM');
    // item 只放相对子项（Default/Cookies 这类），绝不含绝对路径 / 盘符 / ..
    expect(reason.item).not.toContain(':');
    expect(reason.item).not.toContain('C:/');
    expect(reason.item).not.toContain(DATA_DIR);
    expect(reason.item.startsWith('/')).toBe(false);
    expect(reason.item.includes('..')).toBe(false);
    // 整条审计里不许出现数据目录（那是用户目录结构）
    expect(JSON.stringify(audit)).not.toContain(DATA_DIR);
    expect(Object.keys(audit)).not.toContain('message');
    expect(Object.keys(reason).sort()).toEqual(['code', 'item']);
  });

  it('审计原因的清洗：绝对路径 / 盘符 / `..` 一律清空（宁可少给线索）', () => {
    expect(sanitizeAuditItem('Default/Cookies')).toBe('Default/Cookies');
    expect(sanitizeAuditItem('Default\\Cache\\data_1')).toBe('Default/Cache/data_1');
    // 绝对路径：任何形态都不许进审计
    expect(sanitizeAuditItem('C:/Users/u/AppData/Local/pm/record-profiles/abc/Default/Cookies')).toBe('');
    expect(sanitizeAuditItem('/home/u/.config/pm/Default/Cookies')).toBe('home/u/.config/pm/Default/Cookies');
    expect(sanitizeAuditItem('../secret')).toBe('');
    expect(sanitizeAuditItem(null)).toBe('');
    expect(sanitizeAuditCode('EPERM')).toBe('EPERM');
    expect(sanitizeAuditCode('EBUSY: x/y')).toBe('EBUSYxy');
    expect(sanitizeAuditCode('')).toBe('UNKNOWN');
  });

  it('占用的子项带 `..`（越出 profile 目录）→ 审计里 item 被清空，不留可导航路径', async () => {
    const h = harness({
      rmError: (dir) => {
        const err = new Error('EBUSY: resource busy or locked');
        (err as unknown as { code: string }).code = 'EBUSY';
        // 病态/恶意形态：错误路径里带 `..`（真机上来自符号链接或损坏的句柄）
        (err as unknown as { path: string }).path = `${dir}/../outside.txt`;
        return err;
      },
    });
    const started = await h.session.start({ url: 'https://example.com/' });
    await h.session.stop({ sessionId: String(started.data?.sessionId) });
    const audit = lastOf(h.audits) as Record<string, unknown>;
    const reason = audit.profileRemovedError as { code: string; item: string };
    expect(reason.code).toBe('EBUSY');
    // 审计里必须是空（sanitizeAuditItem 生效）；若改回 String(reason.item) 这里会变成 '../outside.txt'
    expect(reason.item).toBe('');
  });

  it('删成功时审计里**不出现**这个可选字段（契约：仅 profileRemoved:false 时出现）', async () => {
    const h = harness();
    const started = await h.session.start({ url: 'https://example.com/' });
    await h.session.stop({ sessionId: String(started.data?.sessionId) });
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.profileRemoved).toBe(true);
    expect('profileRemovedError' in audit).toBe(false);
    // 13 个必填字段一个不少
    expect(Object.keys(audit).sort()).toEqual([
      'action', 'dropped', 'eventCount', 'host', 'killed', 'ok', 'profileRemoved',
      'pushed', 'received', 'sessionId', 'startedAt', 'stoppedAt', 'truncated',
    ]);
  });
});

// ─────────────────────────────────────────────── t43：D-4 篡改守卫 / 同步 stop 重试

describe('record-session：D-4 守卫判据（按标记，不按源码文本）', () => {
  it('注入源与轮询表达式在**真执行**下彼此一致：QUEUE_FN_SRC 装好 → POLL_EXPR 取到数组，不误判', async () => {
    // 这是 D-4 的核心：判据必须是「标记还在且属于本会话」，不是「源码逐字相同」。
    // 所以这里把**真的** QUEUE_FN_SRC 放进假 window 执行，再用**真的** POLL_EXPR 去取。
    const win: Record<string, unknown> = {};
    const nonce = 'abcdef123456';
    const install = new Function('window', `return (${QUEUE_FN_SRC})`)(win) as (name: string, n: string) => boolean;
    install(`__dsh_${nonce}`, nonce);

    const take = new Function('window', `return ${POLL_EXPR}`);
    const first = take(win);
    expect(Array.isArray(first)).toBe(true); // 不是任何哨兵串 → 不误判
    expect(first).toEqual([]);

    // 真的压一条事件进去，再取：能拿到
    (win[`__dsh_${nonce}`] as (json: string) => void)(JSON.stringify({ action: 'click' }));
    expect((take(win) as string[])).toHaveLength(1);
  });

  it('页面**真的替换**了取事件函数 → 守卫仍然拦（不许拿掉安全换绿）', () => {
    const win: Record<string, unknown> = {};
    const nonce = 'abcdef123456';
    const install = new Function('window', `return (${QUEUE_FN_SRC})`)(win) as (name: string, n: string) => boolean;
    install(`__dsh_${nonce}`, nonce);
    const take = new Function('window', `return ${POLL_EXPR}`);

    // ① 页面把函数换成自己的（没有标记）
    win.__dshQueueTake = () => [];
    expect(take(win)).toBe(TAKE_TAMPERED);

    // ② 页面更狡猾：抄了标记但换了函数体（标记对不上本会话）
    win.__dshQueueTake = Object.assign(() => [], { __dshTake: '另外一个nonce' });
    expect(take(win)).toBe(TAKE_TAMPERED);

    // ③ **已知边界**（如实写出来，不假装能拦）：页面若连 `__dshTakeMark` 一起改成自洽的一对，
    // 标记比对就分辨不出来 —— 同源页面本来就能伪造窗口里的任何东西（也能直接调我们的 push 函数）。
    // 所以判据的目标是「发现被换掉」（①②）+ 不静默丢事件，不是「阻止同源页面作恶」。
    win.__dshTakeMark = '另外一个nonce';
    win.__dshQueueTake = Object.assign(() => [], { __dshTake: '另外一个nonce' });
    expect(Array.isArray(take(win))).toBe(true);
  });

  it('注入物整个不见了（导航换文档）→ 判「缺失」，不是「篡改」', () => {
    const take = new Function('window', `return ${POLL_EXPR}`);
    expect(take({})).toBe(TAKE_MISSING); // 函数根本不在 = 文档换了（导航冲掉）
    expect(take({ __dshTakeMark: 'abcdef123456' })).toBe(TAKE_MISSING); // 只剩标记，函数没了
  });

  it('缺失 → 自动重新注入（会话继续活着），不是停录', async () => {
    const h = harness({ evaluateQueueTake: () => TAKE_MISSING });
    const started = await h.session.start({ url: 'https://example.com/' });
    const sid = String(started.data?.sessionId);
    const installsBefore = h.callWithArgsCalls.filter((c) => c.args.length === 2).length;

    await h.tick();          // poll 看到「缺失」
    await new Promise((r) => setTimeout(r, 30)); // 重注入是异步的

    // 会话仍在录制
    expect(h.session.status()?.sessionId).toBe(sid);
    expect(h.session.getState()).toBe('recording');
    // 注入被重做了一次（队列 + 注入器各一次）
    const installsAfter = h.callWithArgsCalls.filter((c) => c.args.length === 2).length;
    expect(installsAfter).toBeGreaterThan(installsBefore);
    expect(h.logs.some((l) => l.includes('重新注入'))).toBe(true);
  });

  it('缺失一直存在（重注入到上限）→ 收敛停录并写审计', async () => {
    const h = harness({ evaluateQueueTake: () => TAKE_MISSING });
    await h.session.start({ url: 'https://example.com/' });
    for (let i = 0; i <= MAX_REINSTALL + 1; i += 1) {
      await h.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.session.status()).toBeNull();
    expect(h.session.getState()).toBe('idle');
    expect((lastOf(h.audits) as Record<string, unknown>).ok).toBe(false);
    expect(h.logs.some((l) => l.includes('反复丢失'))).toBe(true);
  });
});

describe('record-session：注入前要等目标文档（D-4 根因）', () => {
  it('页面还停在 about:blank 时不注入，等到目标文档就绪再注入', async () => {
    const h = harness({
      pageReadySteps: [
        { ready: 'loading', href: 'about:blank' },
        { ready: 'complete', href: 'about:blank' },
        { ready: 'complete', href: 'https://example.com/login' },
      ],
    });
    const started = await h.session.start({ url: 'https://example.com/login' });
    expect(started.ok).toBe(true);
    // 至少探了 3 次就绪，且注入发生在最后一次之后
    const readyProbes = h.evalCalls.filter((e) => e === PAGE_READY_EXPR).length;
    expect(readyProbes).toBeGreaterThanOrEqual(3);
    expect(h.callWithArgsCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('record-session：同步 stop 路径也要有界重试（D-2）', () => {
  it('同步路径 EBUSY 一次后重试成功：profileRemoved:true，不再把 EBUSY 记成失败', async () => {
    // 第 1 次删失败（模拟刚 taskkill 完句柄未释放），第 2 次成功
    let attempt = 0;
    const h = harness({
      rmError: () => {
        attempt += 1;
        if (attempt === 1) {
          const err = new Error('EBUSY: resource busy or locked');
          (err as unknown as { code: string }).code = 'EBUSY';
          (err as unknown as { path: string }).path = `${'C:/data/pm/record-profiles/x'}/Default/Account Web Data`;
          return err;
        }
        return undefined;
      },
    });
    await h.session.start({ url: 'https://example.com/' });
    const lock = h.session.lockStop('t43-sync-test');
    expect(lock.profileRemoved).toBe(true);
    expect(attempt).toBeGreaterThanOrEqual(2); // 真的重试过
  });

  it('同步路径持续删不掉：原因进审计（profileRemovedError），且日志写明重试次数', async () => {
    const h = harness({
      rmError: (dir) => {
        const err = new Error('EBUSY: 持续占用');
        (err as unknown as { code: string }).code = 'EBUSY';
        (err as unknown as { path: string }).path = `${dir}/Default/Account Web Data`;
        return err;
      },
    });
    await h.session.start({ url: 'https://example.com/' });
    const lock = h.session.lockStop('t43-sync-test');
    expect(lock.profileRemoved).toBe(false);
    const audit = lastOf(h.audits) as Record<string, unknown>;
    expect(audit.profileRemovedError).toMatchObject({ code: 'EBUSY', item: 'Default/Account Web Data' });
    expect(h.logs.some((l) => l.includes('同步路径') && l.includes('已试 3 次'))).toBe(true);
  });
});
