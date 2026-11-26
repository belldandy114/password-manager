import { describe, it, expect } from 'vitest';
import {
  TRUNCATED_REASONS,
  FINDINGS_DETAIL_CAP,
  rankOfReason,
  pickReason,
  createFindingCollector,
  createScanGuards,
  isArtifactPath,
} from '../../../electron/scan-collect.js';

/**
 * 扫描收集与原因分流（契约 C-09 / C-29 / C-30 / C-53 的 v16 口径）。
 *
 * 这个模块存在的**唯一理由**是把两件原来混在 `ipc-scan.js` 遍历循环里的事拆出来，
 * 让它们能被单测锁死：
 *   1. `truncatedReason` 的**优先级**（v16 裁定：禁止「先到先得」，先遇到的折叠会把 `timeout` 盖掉）；
 *   2. 明细收集 / 总数计数的**状态机**（明细到 2000 后继续遍历、只累加 `totalFindings` 与 `counts`）。
 *
 * 三条可断言不变量（C-30 v16，单测与 QA 都按式子核，不是「大概一致」）：
 *   ① `counts.high + counts.medium + counts.low === totalFindings`
 *   ② `findings.length <= totalFindings`（未到明细上限时两者相等）
 *   ③ 「折叠」只置 `suppressed`，`findings` 只表示明细被砍
 */

/** 造一条 ScanHit（字段与 electron/scan-rules.js 的 hits 一致） */
const h = (severity = 'medium', extra: Record<string, unknown> = {}) => ({
  ruleId: 'ui-hard-sleep',
  severity,
  category: 'ui',
  title: '硬编码等待',
  line: 1,
  snippet: 'Thread.sleep(3000);',
  ...extra,
});

describe('原因优先级（C-09 v16：timeout > max-files > depth > file-size > suppressed > findings）', () => {
  it('优先级表就是这个顺序，且只有这 6 个值（多一个少一个都不行）', () => {
    expect([...TRUNCATED_REASONS]).toEqual([
      'timeout', 'max-files', 'depth', 'file-size', 'suppressed', 'findings',
    ]);
  });

  it('先折叠（suppressed）后超时（timeout）→ 取 timeout，不是先到的 suppressed', () => {
    // 这正是 v16 修的那个 bug：ipc-scan.js:133 原来写 `if (!truncatedReason) truncatedReason = reason`，
    // 先遇到的折叠会把后来的 timeout 盖掉，界面报的截断原因是假的。
    expect(pickReason('suppressed', 'timeout')).toBe('timeout');
  });

  it('折叠优先于明细到顶：同一文件既折叠又到顶 → 取 suppressed', () => {
    expect(pickReason('findings', 'suppressed')).toBe('suppressed');
  });

  it('file-size 优先于 suppressed 与 findings（文件没读全比折叠严重）', () => {
    expect(pickReason('suppressed', 'file-size')).toBe('file-size');
    expect(pickReason('findings', 'file-size')).toBe('file-size');
  });

  it('空值不参与比较：任意一个为空就取另一个，两个都空返回空串', () => {
    expect(pickReason('', 'timeout')).toBe('timeout');
    expect(pickReason('timeout', '')).toBe('timeout');
    expect(pickReason('', '')).toBe('');
  });

  it('未知取值按最低优先级处理（拼错的 reason 不许压过 timeout）', () => {
    // 照 electron/allure-parse.js:52-60 的 rankOfReason：未知值 indexOf 为 -1，
    // 直接比较会让它的「优先级」比 timeout 还高，界面就会报一个不存在的截断原因。
    expect(rankOfReason('mid')).toBe(Number.POSITIVE_INFINITY);
    expect(pickReason('mid', 'timeout')).toBe('timeout');
    expect(pickReason('findings', 'mid')).toBe('findings');
    // 两个都未知：保留先到的那个（确定性，C-10）
    expect(pickReason('mid', 'blocker')).toBe('mid');
  });
});

describe('明细收集 / 计数状态机（C-30 v16 不变量）', () => {
  it('未到明细上限：findings.length === totalFindings，不置 truncated、没有原因', () => {
    const c = createFindingCollector({ maxFindings: 10 });
    c.addHits([h('high'), h('medium'), h('low')], 'a.ts');
    const s = c.snapshot();
    expect(s.findings).toHaveLength(3);
    expect(s.totalFindings).toBe(3);
    expect(s.truncated).toBe(false);
    expect(s.truncatedReason).toBeUndefined();
    expect(s.counts).toEqual({ high: 1, medium: 1, low: 1 });
  });

  it('明细到顶后继续计数（不停止、不丢计数）：明细 3 条、总数 6 条', () => {
    const c = createFindingCollector({ maxFindings: 3 });
    c.addHits([h('high'), h('high'), h('medium')], 'a.ts');
    c.addHits([h('low'), h('medium'), h('high')], 'b.ts'); // 第二个文件：明细已满，只计数
    const s = c.snapshot();
    expect(s.findings).toHaveLength(3);
    expect(s.totalFindings).toBe(6);
    expect(s.truncated).toBe(true);
    expect(s.truncatedReason).toBe('findings');
  });

  it('不变量①：counts.high + medium + low === totalFindings（含计数分支）', () => {
    const c = createFindingCollector({ maxFindings: 2 });
    c.addHits([h('high'), h('medium'), h('low'), h('low'), h('high')], 'a.ts');
    const s = c.snapshot();
    const sum = s.counts.high + s.counts.medium + s.counts.low;
    expect(s.totalFindings).toBe(5);
    expect(sum).toBe(s.totalFindings);
    // 明细被砍到 2 条，但 counts 记的是全量 —— 这正是「摘要不能再拿 findings 现算」的原因
    expect(s.findings).toHaveLength(2);
    expect(sum).not.toBe(s.findings.length);
  });

  it('不变量②：findings.length <= totalFindings 恒成立，未到上限时相等', () => {
    const c = createFindingCollector({ maxFindings: 4 });
    c.addHits([h(), h(), h()], 'a.ts');
    expect(c.snapshot().findings.length).toBeLessThanOrEqual(c.snapshot().totalFindings);
    expect(c.snapshot().findings.length).toBe(c.snapshot().totalFindings);
    c.addHits([h(), h(), h()], 'b.ts');
    expect(c.snapshot().findings.length).toBeLessThan(c.snapshot().totalFindings);
  });

  it('命中数恰好等于上限、没有多余命中 → 不算「明细被砍」（不置 findings 原因）', () => {
    // 只在**真的要丢一条**明细时才置 'findings'；恰好装满 2000 条不等于被截断。
    const c = createFindingCollector({ maxFindings: 3 });
    c.addHits([h(), h(), h()], 'a.ts');
    const s = c.snapshot();
    expect(s.findings).toHaveLength(3);
    expect(s.totalFindings).toBe(3);
    expect(s.truncated).toBe(false);
    expect(s.truncatedReason).toBeUndefined();
  });

  it('「同文件同规则折叠」只置 suppressed，绝不出现 findings（v16 的 bug 回归锁）', () => {
    // 场景就是 W7 实测的那次：有折叠、但明细一条都没少（远不到上限）。
    const c = createFindingCollector({ maxFindings: 2000 });
    c.addHits([h(), h()], 'a.ts');
    c.addSuppressed(1034);
    const s = c.snapshot();
    expect(s.findings).toHaveLength(2);
    expect(s.totalFindings).toBe(2);
    expect(s.suppressed).toBe(1034);
    expect(s.truncated).toBe(true);
    expect(s.truncatedReason).toBe('suppressed');
    expect(s.truncatedReason).not.toBe('findings');
  });

  it('先折叠后超时 → 最终原因是 timeout，且折叠条数照旧保留（信息不丢）', () => {
    const c = createFindingCollector({ maxFindings: 2000 });
    c.addHits([h()], 'a.ts');
    c.addSuppressed(5);          // 先到：suppressed
    c.markTruncated('timeout');  // 后到：timeout，优先级更高
    const s = c.snapshot();
    expect(s.truncatedReason).toBe('timeout');
    expect(s.suppressed).toBe(5);
    expect(s.truncated).toBe(true);
  });

  it('先明细到顶、后折叠 → 最终原因是 suppressed（折叠比明细更「该说」）', () => {
    const c = createFindingCollector({ maxFindings: 1 });
    c.addHits([h(), h()], 'a.ts');
    expect(c.snapshot().truncatedReason).toBe('findings');
    c.addSuppressed(1);
    expect(c.snapshot().truncatedReason).toBe('suppressed');
  });

  it('addHits 返回真正收进明细的条数（不是命中条数）', () => {
    const c = createFindingCollector({ maxFindings: 2 });
    expect(c.addHits([h(), h(), h()], 'a.ts')).toBe(2);
    expect(c.addHits([h()], 'b.ts')).toBe(0);
    expect(c.snapshot().totalFindings).toBe(4);
  });

  it('addSuppressed 忽略 0 / 负数 / 非数字（不许把「没有折叠」变成一次截断）', () => {
    const c = createFindingCollector({ maxFindings: 10 });
    for (const v of [0, -3, NaN, undefined, null]) c.addSuppressed(v as unknown as number);
    const s = c.snapshot();
    expect(s.suppressed).toBe(0);
    expect(s.truncated).toBe(false);
  });

  // 1.36.0：coverage 包已下线，规则引擎不再产出 method/path；但收集器**仍按「有值才透传」**
  // 处理这两个历史字段（旧 scanRuns 记录有它们），所以这条用例保留，只改措辞。
  it('finding 字段齐：file 由调用方给，method/path（历史字段）只在有值时透传', () => {
    const c = createFindingCollector({ maxFindings: 10 });
    c.addHits([h('low', { ruleId: 'legacy-coverage-hit', method: 'GET', path: '/api/users', line: 2 })], 'B.java');
    c.addHits([h('high', { ruleId: 'assert-no-assertion' })], 'A.java');
    const [cov, plain] = c.snapshot().findings;
    expect(cov).toEqual({
      ruleId: 'legacy-coverage-hit', severity: 'low', title: '硬编码等待',
      file: 'B.java', line: 2, snippet: 'Thread.sleep(3000);', method: 'GET', path: '/api/users',
    });
    // 没有 method/path 时**不许**塞 undefined 键（IPC 结构化克隆会把它变成 null）
    expect(Object.prototype.hasOwnProperty.call(plain, 'method')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(plain, 'path')).toBe(false);
  });

  it('未知 severity 归到最低档 low，保证不变量①不被一个脏数据打破', () => {
    const c = createFindingCollector({ maxFindings: 10 });
    c.addHits([h('blocker'), h('high')], 'a.ts');
    const s = c.snapshot();
    expect(s.counts).toEqual({ high: 1, medium: 0, low: 1 });
    expect(s.counts.high + s.counts.medium + s.counts.low).toBe(s.totalFindings);
  });

  it('maxFindings clamp：缺省 2000，0 / 负数 / NaN / 小数都不许把明细关成 0 条', () => {
    expect(FINDINGS_DETAIL_CAP).toBe(2000);
    for (const bad of [0, -1, NaN, undefined]) {
      const c = createFindingCollector({ maxFindings: bad as unknown as number });
      c.addHits([h()], 'a.ts');
      expect(c.snapshot().findings).toHaveLength(1);
    }
    const c = createFindingCollector({ maxFindings: 2.9 });
    c.addHits([h(), h(), h()], 'a.ts');
    expect(c.snapshot().findings).toHaveLength(2); // floor 到 2
  });

  it('snapshot 是快照：之后继续收集不会改到已经取走的那份', () => {
    const c = createFindingCollector({ maxFindings: 10 });
    c.addHits([h()], 'a.ts');
    const before = c.snapshot();
    c.addHits([h()], 'b.ts');
    expect(before.findings).toHaveLength(1);
    expect(before.totalFindings).toBe(1);
    expect(c.snapshot().findings).toHaveLength(2);
  });
});

describe('压缩/打包产物路径守卫（C-54 v16）', () => {
  it('命中：.min. / .bundle. / app.asar.unpacked', () => {
    expect(isArtifactPath('run/resources/app.asar.unpacked/dist-tdg/assets/exceljs.min-TeKDQ3pi.js')).toBe(true);
    expect(isArtifactPath('dist/assets/exceljs.min.js')).toBe(true);
    expect(isArtifactPath('src/vendor/legacy.bundle.js')).toBe(true);
  });

  it('不命中：正常源码与「名字里恰好有 min」的文件（误报对照）', () => {
    for (const p of ['src/utils/a.ts', 'electron/minmax.js', 'src/min.js', 'test/AdminTest.java', 'docs/minimum.md']) {
      expect(isArtifactPath(p)).toBe(false);
    }
    expect(isArtifactPath('')).toBe(false);
    expect(isArtifactPath(undefined as unknown as string)).toBe(false);
  });
});

/**
 * S-03（第 1 轮评审 review-sec）：v16 的两个守卫**静默**丢文件——用户读到「0 命中」会误判干净。
 * C-09 禁止静默截断，跳过也必须可读，所以加 `skippedByGuard`（照 `skippedSymlinks` 的做法）。
 */
describe('守卫计数 skippedByGuard（S-03：跳过也必须可见）', () => {
  it('有守卫跳过的条目 → 计数 > 0；一条都没有 → 0（两档都要覆盖）', () => {
    const dirty = createScanGuards();
    expect(dirty.skipDir('coverage')).toBe(true);   // coverage 是 v16 新增的目录守卫
    expect(dirty.skipDir('node_modules')).toBe(true);
    expect(dirty.skipFile('run/resources/app.asar.unpacked/x/index.js')).toBe(true);
    expect(dirty.count()).toBe(3);

    const clean = createScanGuards();
    expect(clean.skipDir('src')).toBe(false);
    expect(clean.skipFile('src/utils/a.ts')).toBe(false);
    expect(clean.count()).toBe(0);
  });

  it('返回的字段名逐字是 skippedByGuard（契约 S-03：名字不许漂）', () => {
    const g = createScanGuards();
    g.skipDir('coverage');
    expect(Object.keys(g.snapshot())).toEqual(['skippedByGuard']);
    expect(g.snapshot()).toEqual({ skippedByGuard: 1 });
  });

  it('被守卫跳过的文件**不占** maxFiles 预算、也不进 files（与 files 是两套计数）', () => {
    // 这条锁的是语义边界：skippedByGuard 与 files / skippedSymlinks 各算各的，不许互相并入
    const g = createScanGuards();
    for (const name of ['node_modules', '.git', 'dist', 'release', 'build', 'target', '.venv', 'vendor', 'out', 'coverage']) {
      expect(g.skipDir(name)).toBe(true);
    }
    expect(g.snapshot()).toEqual({ skippedByGuard: 10 });
  });
});
