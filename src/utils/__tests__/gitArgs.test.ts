import { describe, it, expect } from 'vitest';
import {
  GIT_SCOPES, MAX_FILES, WRITE_COMMANDS,
  buildProbeArgs, buildDiffArgs,
  parseStatusZ, parseNumstatZ, statusOf, mergeDiff, filterByScope,
} from '../../../electron/git-args.js';

/**
 * 模块 6 Git 影响面：只读命令白名单 + `-z` 解析（契约 C-57〜C-60）。
 *
 * 两个最容易出事的地方，各有一条专门的回归：
 *   1. **不能有任意参数口子**——渲染层只能传 root + scope，命令为四条白名单之一；
 *   2. **rename 是两段**——少消费一段，后面所有条目整体错位（表现是「有文件列表，但状态/路径全不对」）。
 *
 * ⚠️ 段序以**实测 git 2.39.1** 为准，不是以契约为准：
 *   - `status --porcelain -z` 里 rename 是 `R  <新路径>\0<旧路径>\0`（**新在前**），
 *     契约 §2.3 写的 `R  old\0new\0` 与实测相反；
 *   - `diff --numstat -z` 里 rename 是 `add\tdel\t\0<旧路径>\0<新路径>\0`（**旧在前**），与契约一致。
 * 实测命令与原始字节见 docs/acceptance/W6-A.md §3。
 */

const NUL = '\x00';
/** 用 NUL 拼接 git -z 的原始输出（比在字面量里写转义安全，也不踩八进制转义的坑） */
const z = (...segs: string[]): string => segs.join(NUL) + NUL;

describe('命令白名单（C-57）：参数只能由本模块产出', () => {
  it('probe 的三条命令逐字正确（前 6 个是 S-03 的 -c 前缀，命令体从第 7 个开始）', () => {
    const p = buildProbeArgs();
    expect(p.branch.slice(6)).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    expect(p.head.slice(6)).toEqual(['rev-parse', '--short', 'HEAD']);
    expect(p.status.slice(6)).toEqual(['status', '--porcelain', '-z']);
  });

  it('diff 的三种 scope 逐字正确（scope 只影响后缀）', () => {
    // 前 6 个是 S-03 的 -c 前缀（见下面「S-03」用例），这里只看命令体
    expect((buildDiffArgs('unstaged') as { args: string[] }).args.slice(6)).toEqual(['diff', '--numstat', '-z']);
    expect((buildDiffArgs('staged') as { args: string[] }).args.slice(6)).toEqual(['diff', '--numstat', '-z', '--cached']);
    expect((buildDiffArgs('head') as { args: string[] }).args.slice(6)).toEqual(['diff', '--numstat', '-z', 'HEAD']);
  });

  it('未知 scope 被拒绝，且错误串是 C-60 的文案（不拼进命令）', () => {
    expect(buildDiffArgs('push')).toMatchObject({ ok: false, error: '未知的 diff 范围：push' });
    expect(buildDiffArgs('')).toMatchObject({ ok: false, error: '未知的 diff 范围：' });
    expect(buildDiffArgs(undefined as unknown as string)).toMatchObject({ ok: false });
    expect(GIT_SCOPES).toEqual(['unstaged', 'staged', 'head']);
  });

  it('返回的是防御性拷贝：调用方改了不影响下一次（避免被拼进额外参数）', () => {
    const a = buildProbeArgs();
    a.branch.push('push');
    expect(buildProbeArgs().branch.slice(6)).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
    const d = buildDiffArgs('head') as { ok: true; args: string[] };
    d.args.push('--force');
    expect((buildDiffArgs('head') as { ok: true; args: string[] }).args.slice(6)).toEqual(['diff', '--numstat', '-z', 'HEAD']);
  });

  it('全部白名单命令里没有任何写命令（commit/push/checkout/stash/reset/clean/config 一个都不许有）', () => {
    const all = [
      ...Object.values(buildProbeArgs()).flat(),
      ...GIT_SCOPES.map((s) => (buildDiffArgs(s) as { ok: true; args: string[] }).args).flat(),
    ].map((x) => String(x).toLowerCase());
    for (const bad of WRITE_COMMANDS) expect(all).not.toContain(bad);
    expect(WRITE_COMMANDS.length).toBeGreaterThanOrEqual(7);
  });
});

describe('parseStatusZ（status --porcelain -z，rename 双段）', () => {
  it('普通条目：A/M/??/D 各自成条，结尾空段被跳过', () => {
    const text = z('A  added.txt', ' M keep.txt', ' D old.txt', '?? untracked.md');
    const { entries } = parseStatusZ(text);
    expect(entries.map((e) => [e.x, e.y, e.path])).toEqual([
      ['A', ' ', 'added.txt'],
      [' ', 'M', 'keep.txt'],
      [' ', 'D', 'old.txt'],
      ['?', '?', 'untracked.md'],
    ]);
  });

  it('**rename 双段**：第一段是新路径、第二段是旧路径（实测 git 2.39.1）', () => {
    const text = z('R  新名字 file.txt', 'old name.txt');
    const { entries } = parseStatusZ(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ x: 'R', path: '新名字 file.txt', origPath: 'old name.txt' });
  });

  it('**rename 后面紧跟普通条目不能错位**（少消费一段就会把 old 当成下一条的路径）', () => {
    const text = z('R  new.txt', 'old.txt', 'M  other.txt', '?? x.md');
    const { entries } = parseStatusZ(text);
    expect(entries.map((e) => e.path)).toEqual(['new.txt', 'other.txt', 'x.md']);
    expect(entries[0].origPath).toBe('old.txt');
    expect(entries[1].origPath).toBe('');
    expect(entries[2]).toMatchObject({ x: '?', y: '?' });
  });

  it('路径含空格与中文、含制表符都原样保留（-z 不加引号）', () => {
    const text = z('M  带 空格 的 目录/文件 中文.txt', '?? a\tb.txt');
    const { entries } = parseStatusZ(text);
    expect(entries[0].path).toBe('带 空格 的 目录/文件 中文.txt');
    expect(entries[1].path).toBe('a\tb.txt');
  });

  it('路径里含换行也原样保留（Windows 建不出这种文件，只能在解析层验：-z 按 NUL 切段）', () => {
    const text = z('M  line\nbreak.txt', '?? ok.md');
    const { entries } = parseStatusZ(text);
    expect(entries[0].path).toBe('line\nbreak.txt');
    expect(entries[1].path).toBe('ok.md');
  });

  it('空输入 / 只有空段 → 空结果（不抛异常）', () => {
    expect(parseStatusZ('').entries).toEqual([]);
    expect(parseStatusZ(NUL).entries).toEqual([]);
  });
});

describe('parseNumstatZ（diff --numstat -z，rename 双段）', () => {
  it('普通条目：add、del、path 三段用制表符分隔', () => {
    const text = `1\t1\tkeep.txt${NUL}0\t3\tgone.txt${NUL}`;
    const { entries } = parseNumstatZ(text);
    expect(entries).toEqual([
      { path: 'keep.txt', origPath: '', additions: 1, deletions: 1, binary: false },
      { path: 'gone.txt', origPath: '', additions: 0, deletions: 3, binary: false },
    ]);
  });

  it('二进制文件 `-`：additions/deletions 记 0 且标 binary', () => {
    const { entries } = parseNumstatZ(`-\t-\tlogo.png${NUL}`);
    expect(entries[0]).toMatchObject({ path: 'logo.png', additions: 0, deletions: 0, binary: true });
  });

  it('**rename 双段**：路径为空后跟旧路径、新路径两段', () => {
    const text = `0\t0\t${NUL}old name.txt${NUL}新名字 file.txt${NUL}`;
    const { entries } = parseNumstatZ(text);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ origPath: 'old name.txt', path: '新名字 file.txt', additions: 0, deletions: 0 });
  });

  it('**rename 后面紧跟普通条目不能错位**', () => {
    const text = `1\t1\tother.txt${NUL}0\t0\t${NUL}old.txt${NUL}new.txt${NUL}0\t2\tafter.txt${NUL}`;
    const { entries } = parseNumstatZ(text);
    expect(entries.map((e) => e.path)).toEqual(['other.txt', 'new.txt', 'after.txt']);
    expect(entries[1].origPath).toBe('old.txt');
  });

  it('空 diff → 空结果', () => {
    expect(parseNumstatZ('').entries).toEqual([]);
  });
});

describe('filterByScope：每个范围只留自己那部分改动', () => {
  const entries = [
    { x: ' ', y: 'M', path: 'worktree-only.txt', origPath: '' }, // 只在工作区改了
    { x: 'M', y: ' ', path: 'staged-mod.txt', origPath: '' },    // 已暂存修改
    { x: 'A', y: ' ', path: 'staged-add.txt', origPath: '' },    // 已暂存新增
    { x: 'R', y: ' ', path: 'renamed.txt', origPath: 'old.txt' },// 已暂存重命名
    { x: '?', y: '?', path: 'untracked.md', origPath: '' },      // 未跟踪
  ];

  it('staged 只留索引侧有改动的（工作区侧修改不算）', () => {
    const kept = filterByScope(entries, 'staged').map((e: { path: string }) => e.path);
    expect(kept).toEqual(['staged-mod.txt', 'staged-add.txt', 'renamed.txt']);
    expect(kept).not.toContain('worktree-only.txt');
  });

  it('unstaged 只留工作区侧改动 + 未跟踪（已暂存的不重复算）', () => {
    const kept = filterByScope(entries, 'unstaged').map((e: { path: string }) => e.path);
    expect(kept).toEqual(['worktree-only.txt', 'untracked.md']);
  });

  it('head 是 HEAD→工作区，全部保留', () => {
    expect(filterByScope(entries, 'head').map((e: { path: string }) => e.path)).toHaveLength(5);
  });
});

describe('statusOf 合成两列 XY（C-59）', () => {
  it('?? → untracked；X/Y 组合成六种状态', () => {
    expect(statusOf('?', '?', false)).toBe('untracked');
    expect(statusOf('M', ' ', false)).toBe('staged-modified');
    expect(statusOf(' ', 'M', false)).toBe('modified');
    expect(statusOf('A', ' ', false)).toBe('added');
    expect(statusOf(' ', 'D', false)).toBe('deleted');
    expect(statusOf('R', ' ', false)).toBe('renamed');
  });

  it('二进制加 -binary 后缀', () => {
    expect(statusOf(' ', 'M', true)).toBe('modified-binary');
    expect(statusOf('?', '?', true)).toBe('untracked-binary');
  });
});

describe('mergeDiff：状态字母 + 行数合并，2000 截断', () => {
  const statusEntries = [
    { x: 'R', y: ' ', path: 'new.txt', origPath: 'old.txt' },
    { x: ' ', y: 'M', path: 'keep.txt', origPath: '' },
    { x: '?', y: '?', path: 'brand.md', origPath: '' },
  ];
  const numstatEntries = [
    { path: 'new.txt', origPath: 'old.txt', additions: 0, deletions: 0, binary: false },
    { path: 'keep.txt', origPath: '', additions: 2, deletions: 1, binary: false },
  ];

  it('合并后条数/状态/行数/rename 的 old+new 都对', () => {
    const { files, truncated } = mergeDiff({ statusEntries, numstatEntries });
    expect(truncated).toBe(false);
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ['new.txt', 'renamed', 0, 0],
      ['keep.txt', 'modified', 2, 1],
      ['brand.md', 'untracked', 0, 0],
    ]);
    expect(files[0].origPath).toBe('old.txt');
    expect(files[2].origPath).toBeUndefined();
  });

  it('二进制条目 status 带 -binary 且行数为 0', () => {
    const { files } = mergeDiff({
      statusEntries: [{ x: ' ', y: 'M', path: 'a.png', origPath: '' }],
      numstatEntries: [{ path: 'a.png', origPath: '', additions: 0, deletions: 0, binary: true }],
    });
    expect(files[0]).toMatchObject({ status: 'modified-binary', additions: 0, deletions: 0 });
  });

  it('超过 2000 个文件 → truncated=true 且只保留前 2000 条', () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => ({ x: 'M', y: ' ', path: `f${i}.txt`, origPath: '' }));
    const { files, truncated } = mergeDiff({ statusEntries: many, numstatEntries: [] });
    expect(truncated).toBe(true);
    expect(files).toHaveLength(MAX_FILES);
    expect(MAX_FILES).toBe(2000);
  });

  it('空改动 → files 空、truncated false', () => {
    expect(mergeDiff({ statusEntries: [], numstatEntries: [] })).toEqual({ files: [], truncated: false });
  });
});
/**
 * 安全评审 **S-03**：`git status` / `git diff` 会读**仓库自己的** `.git/config`。
 * 别人发来的仓库里写一条 `core.fsmonitor=/path/to/evil`（或 `core.hooksPath`、`diff.external`），
 * 你跑一次体检就执行了别人的程序。所以每次调用都前置三个 `-c` 禁用项，
 * 而且**必须在子命令之前**（`git -c k=v status`）——顺序错了等于没禁用。
 */
describe('S-03：每次 git 调用都前置三个 -c 禁执行项', () => {
  const EXPECT_PREFIX = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-c', 'diff.external='];

  it('三个禁用项的字面量就是这三对（直接盯字面量：常量被改名/挪位置也照样抓得住）', () => {
    const A = buildProbeArgs();
    expect(A.status.filter((a: string) => a === '-c')).toHaveLength(3);
    expect(A.status).toContain('core.fsmonitor=false');
    expect(A.status).toContain('core.hooksPath=');
    expect(A.status).toContain('diff.external=');
  });

  it('buildProbeArgs 的三条命令都以这三个 -c 开头', () => {
    const A = buildProbeArgs() as unknown as Record<string, string[]>;
    for (const key of ['branch', 'head', 'status']) {
      expect(A[key].slice(0, 6)).toEqual(EXPECT_PREFIX);
    }
  });

  it('buildDiffArgs 三个 scope 都以这三个 -c 开头，且子命令跟在后面', () => {
    for (const scope of GIT_SCOPES) {
      const r = buildDiffArgs(scope);
      expect(r.ok).toBe(true);
      expect((r as { ok: true; args: string[] }).args.slice(0, 6)).toEqual(EXPECT_PREFIX);
      expect((r as { ok: true; args: string[] }).args[6]).toBe('diff');
    }
  });

  it('所有 git 调用共 4 条，无一漏掉前缀（逐条核对，不是抽样）', () => {
    const A = buildProbeArgs();
    const all = [A.branch, A.head, A.status, ...GIT_SCOPES.map((s) => (buildDiffArgs(s) as { ok: true; args: string[] }).args)];
    expect(all).toHaveLength(6);
    for (const args of all) expect(args.slice(0, 6)).toEqual(EXPECT_PREFIX);
  });
});