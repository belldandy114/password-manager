import { describe, it, expect } from 'vitest';
import {
  UNINSTALL_PRODUCT_NAME,
  REG_UNINSTALL_KEYS,
  REG_QUERY_TIMEOUT_MS,
  SIZE_BUDGET_MS,
  SIZE_MAX_DEPTH,
  SIZE_MAX_ENTRIES,
  MANAGED_DATA_FILES,
  MANAGED_DATA_DIRS,
  uninstallMode,
  parseUninstallString,
  parseRegQueryOutput,
  findUninstaller,
  isInside,
  dataSizeOf,
  listManagedDataPaths,
  isDataDirAck,
  removeManagedData,
} from '../../../electron/uninstall.js';
import type { UninstallIo } from '../../../electron/uninstall.js';
import * as uninstallModule from '../../../electron/uninstall.js';

/**
 * 卸载（R3）纯函数层 —— 契约 §3.4 / §3.5 / D5 / D7，
 * 判据见 `docs/验收-设置细分-免密-卸载.md` 的 AC-UN-01 / 04 / 05 / 06 / 10 / 11 / 12 / 13 / 14。
 *
 * 全部用**注入替身**：内存文件树 + `execFileSync` 计数器，不碰真实磁盘、不起 Electron、
 * 不用 Buffer / fs / os / path（`tsconfig` 是 `types: []`；路径分隔符从模块自己的输出里取，
 * 所以这套测试不靠硬编码 `\\`）。
 */

/* ---------------------------------------------------------------- 替身 */

type FsNode = { kind: 'file'; size: number } | { kind: 'dir' };

/** 路径分隔符取自模块输出（`path.join('D','vault.enc')`），避免测试里写死 Windows 反斜杠 */
const SEP = listManagedDataPaths('D')[0].charAt(1);
const join = (...parts: string[]) => parts.join(SEP);
/** 替身的键归一：分隔符统一 + 小写（Windows 语义不敏感） */
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();

interface Seed {
  path: string;
  kind: 'file' | 'dir';
  size?: number;
  /** 让 readdirSync 把它报告成软链（体积统计要跳过） */
  symlink?: boolean;
}

function makeFs(seed: Seed[]) {
  const tree = new Map<string, FsNode>();
  const symlinks = new Set<string>();
  const calls = { execFile: 0, rmdir: 0, unlink: 0, rm: 0, readdir: 0, realpath: 0 };
  const execFileArgs: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  const log: string[] = [];

  for (const s of seed) {
    tree.set(norm(s.path), s.kind === 'file' ? { kind: 'file', size: s.size ?? 0 } : { kind: 'dir' });
    if (s.symlink) symlinks.add(norm(s.path));
  }

  /** `dir` 的直属子项名（键已归一，所以返回的也就是小写名） */
  const childrenOf = (dir: string) => {
    const base = norm(dir).replace(/\/+$/, '');
    const out: string[] = [];
    for (const key of tree.keys()) {
      if (!key.startsWith(base + '/')) continue;
      const rest = key.slice(base.length + 1);
      if (!rest || rest.includes('/')) continue;
      out.push(rest);
    }
    return out;
  };

  const io: Partial<UninstallIo> = {
    existsSync: (p: string) => tree.has(norm(p)),
    statSync: (p: string) => {
      const n = tree.get(norm(p));
      if (!n) throw new Error('ENOENT: ' + p);
      return { size: n.kind === 'file' ? n.size : 0, isDirectory: () => n.kind === 'dir' };
    },
    readdirSync: (p: string) => {
      calls.readdir += 1;
      const base = norm(p);
      if (!tree.has(base)) throw new Error('ENOENT: ' + p);
      return childrenOf(p).map((name) => {
        const key = norm(join(p, name));
        return {
          name,
          isDirectory: () => tree.get(key)?.kind === 'dir',
          isSymbolicLink: () => symlinks.has(key),
        };
      });
    },
    // 恒等 realpath：软链逃逸场景在用例里显式覆盖
    realpathSync: (p: string) => {
      calls.realpath += 1;
      if (!tree.has(norm(p))) throw new Error('ENOENT: ' + p);
      return p;
    },
    unlinkSync: (p: string) => {
      calls.unlink += 1;
      if (!tree.delete(norm(p))) throw new Error('ENOENT: ' + p);
    },
    rmSync: (p: string) => {
      calls.rm += 1;
      const base = norm(p);
      for (const key of [...tree.keys()]) {
        if (key === base || key.startsWith(base + '/')) tree.delete(key);
      }
    },
    rmdirSync: (p: string) => {
      calls.rmdir += 1;
      tree.delete(norm(p));
    },
    execFileSync: (file: string, args: string[], opts?: Record<string, unknown>) => {
      calls.execFile += 1;
      execFileArgs.push({ file, args, opts: opts || {} });
      throw new Error('测试替身：不该真的执行外部命令');
    },
  };

  return { io, tree, calls, execFileArgs, log, exists: (p: string) => tree.has(norm(p)) };
}

/** 受管清单的 fixture：根目录 + 10 文件 + 5 目录（backups 里放一个子文件）+ 用户自有文件 */
function managedFixture(dataDir: string): Seed[] {
  return [
    { path: dataDir, kind: 'dir' as const },
    ...MANAGED_DATA_FILES.map((f) => ({ path: join(dataDir, f), kind: 'file' as const, size: 16 })),
    ...MANAGED_DATA_DIRS.map((d) => ({ path: join(dataDir, d), kind: 'dir' as const })),
    { path: join(dataDir, 'backups', 'b1.bak'), kind: 'file' as const, size: 32 },
    { path: join(dataDir, 'mine.txt'), kind: 'file' as const, size: 8 },
  ];
}

/* ---------------------------------------------------------------- 用例 */

describe('uninstall：mode 矩阵与清单单一真源（§3.4 / §3.5）', () => {
  it('uninstallMode：packaged → installed，源码/npm start → dev', () => {
    expect(uninstallMode(true)).toBe('installed');
    expect(uninstallMode(false)).toBe('dev');
    expect(uninstallMode(undefined)).toBe('dev');
  });

  it('listManagedDataPaths：10 文件 + 5 目录 = 15 项，且互不重复、不含 dataDir 本身', () => {
    const paths = listManagedDataPaths('D');
    expect(paths.length).toBe(15);
    expect(new Set(paths).size).toBe(15);
    expect(MANAGED_DATA_FILES.length).toBe(10);
    expect(MANAGED_DATA_DIRS.length).toBe(5);
    expect(paths).not.toContain('D');
    for (const f of MANAGED_DATA_FILES) expect(paths).toContain(join('D', f));
    for (const d of MANAGED_DATA_DIRS) expect(paths).toContain(join('D', d));
  });

  it('listManagedDataPaths：空 dataDir 返回空数组（不编造路径）', () => {
    expect(listManagedDataPaths('')).toEqual([]);
  });

  it('常量与契约一致：产品名、三个注册表键、1500ms 查询预算、2000ms/6 层/20000 条体积预算', () => {
    expect(UNINSTALL_PRODUCT_NAME).toBe('测试中台');
    expect(REG_UNINSTALL_KEYS.length).toBe(3);
    expect(REG_UNINSTALL_KEYS[0].startsWith('HKCU')).toBe(true);
    expect(REG_UNINSTALL_KEYS.some((k) => k.includes('WOW6432Node'))).toBe(true);
    expect(REG_QUERY_TIMEOUT_MS).toBe(1500);
    expect(SIZE_BUDGET_MS).toBe(2000);
    expect(SIZE_MAX_DEPTH).toBe(6);
    expect(SIZE_MAX_ENTRIES).toBe(20000);
  });

  it('导出面 = 18 个纯函数/常量（与 electron/uninstall.d.ts 的声明逐项对应）', () => {
    const names = Object.keys(uninstallModule).filter((k) => k !== 'default').sort();
    expect(names).toEqual([
      'MANAGED_DATA_DIRS',
      'MANAGED_DATA_FILES',
      'REG_QUERY_TIMEOUT_MS',
      'REG_UNINSTALL_KEYS',
      'SIZE_BUDGET_MS',
      'SIZE_MAX_DEPTH',
      'SIZE_MAX_ENTRIES',
      'UNINSTALL_PRODUCT_NAME',
      'dataSizeOf',
      'defaultIo',
      'findUninstaller',
      'isDataDirAck',
      'isInside',
      'listManagedDataPaths',
      'parseRegQueryOutput',
      'parseUninstallString',
      'removeManagedData',
      'uninstallMode',
    ]);
  });
});

describe('uninstall：卸载器发现（§3.4，AC-UN-01 / AC-UN-03 / AC-UN-10）', () => {
  it('dev（isPackaged:false）**一次都不查注册表**、不猜右侧同名 exe', () => {
    const fs = makeFs([{ path: 'C:\\App\\Uninstall 测试中台.exe', kind: 'file', size: 1 }]);
    const found = findUninstaller({
      isPackaged: false,
      execPath: 'C:\\App\\测试中台.exe',
      productName: UNINSTALL_PRODUCT_NAME,
      io: fs.io,
    });
    expect(found).toEqual({ path: null, source: null, regKey: null });
    expect(fs.calls.execFile).toBe(0);
    expect(fs.calls.readdir).toBe(0);
  });

  it('installed：HKCU 命中 → source=registry-hkcu，reg 调用用参数数组、带 1500ms 超时、无 shell', () => {
    const exe = 'C:\\Program Files\\测试中台\\Uninstall 测试中台.exe';
    const regText = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}',
      `    DisplayName    REG_SZ    ${UNINSTALL_PRODUCT_NAME}`,
      `    UninstallString    REG_SZ    "${exe}" /S`,
    ].join('\r\n');
    const fs = makeFs([{ path: exe, kind: 'file', size: 1 }]);
    const io = {
      ...fs.io,
      execFileSync: (file: string, args: string[], opts?: Record<string, unknown>) => {
        fs.execFileArgs.push({ file, args, opts: opts || {} });
        return regText;
      },
    };
    const found = findUninstaller({ isPackaged: true, execPath: 'C:\\Program Files\\测试中台\\测试中台.exe', io });
    expect(found.path).toBe(exe);
    expect(found.source).toBe('registry-hkcu');
    expect(found.regKey).toContain('HKEY_CURRENT_USER');
    expect(fs.execFileArgs.length).toBe(1);
    expect(fs.execFileArgs[0].file).toBe('reg');
    expect(fs.execFileArgs[0].args).toEqual(['query', REG_UNINSTALL_KEYS[0], '/s']);
    expect(fs.execFileArgs[0].opts.timeout).toBe(REG_QUERY_TIMEOUT_MS);
    expect('shell' in fs.execFileArgs[0].opts).toBe(false);
  });

  it('installed：HKCU 查不到 → 继续 HKLM，source=registry-hklm', () => {
    const exe = 'C:\\App\\Uninstall 测试中台.exe';
    const hklmText = [
      'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}',
      `    DisplayName    REG_SZ    ${UNINSTALL_PRODUCT_NAME}`,
      `    UninstallString    REG_SZ    "${exe}"`,
    ].join('\n');
    const fs = makeFs([{ path: exe, kind: 'file', size: 1 }]);
    let call = 0;
    const io = {
      ...fs.io,
      execFileSync: () => {
        call += 1;
        if (call === 1) throw new Error('reg: 键不存在');
        return hklmText;
      },
    };
    const found = findUninstaller({ isPackaged: true, execPath: 'C:\\App\\测试中台.exe', io });
    expect(found.path).toBe(exe);
    expect(found.source).toBe('registry-hklm');
    expect(call).toBe(2);
  });

  it('installed：注册表全空但 exe 同级有 Uninstall 测试中台.exe → source=exe-sibling', () => {
    const appDir = 'C:\\App';
    const sibling = join(appDir, `Uninstall ${UNINSTALL_PRODUCT_NAME}.exe`);
    const fs = makeFs([{ path: sibling, kind: 'file', size: 1 }]);
    const found = findUninstaller({ isPackaged: true, execPath: join(appDir, '测试中台.exe'), io: fs.io });
    expect(found.path).toBe(sibling);
    expect(found.source).toBe('exe-sibling');
    expect(found.regKey).toBeNull();
  });

  it('installed：注册表与同级都没有 → 三项全 null（绝不凭空猜路径）', () => {
    const fs = makeFs([]);
    const found = findUninstaller({ isPackaged: true, execPath: 'C:\\App\\x.exe', io: fs.io });
    expect(found).toEqual({ path: null, source: null, regKey: null });
  });

  it('注册表里 DisplayName 对但 exe 不存在 → 不采用该条', () => {
    const text = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{GUID}',
      `    DisplayName    REG_SZ    ${UNINSTALL_PRODUCT_NAME}`,
      '    UninstallString    REG_SZ    "C:\\Gone\\Uninstall 测试中台.exe"',
    ].join('\n');
    const fs = makeFs([]);
    const io = { ...fs.io, execFileSync: () => text };
    expect(findUninstaller({ isPackaged: true, execPath: 'C:\\App\\x.exe', io }).path).toBeNull();
  });
});

describe('uninstall：UninstallString 与 reg 输出解析（§3.4）', () => {
  it('带引号/不带引号都能取到 exe；msiexec、相对路径、非 exe、非字符串一律 null', () => {
    expect(parseUninstallString('"C:\\App\\Uninstall 测试中台.exe" /S')).toBe('C:\\App\\Uninstall 测试中台.exe');
    expect(parseUninstallString('C:\\App\\Uninstall.exe /S')).toBe('C:\\App\\Uninstall.exe');
    expect(parseUninstallString('  "C:\\App\\U.exe"  ')).toBe('C:\\App\\U.exe');
    expect(parseUninstallString('MsiExec.exe /X{1234}')).toBeNull();
    expect(parseUninstallString('Uninstall.exe /S')).toBeNull();
    expect(parseUninstallString('C:\\App\\uninst.bat')).toBeNull();
    expect(parseUninstallString('')).toBeNull();
    expect(parseUninstallString(null)).toBeNull();
    expect(parseUninstallString(42)).toBeNull();
  });

  it('parseRegQueryOutput 按 HKEY 分段收集 DisplayName / UninstallString', () => {
    const text = [
      'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{A}',
      '    DisplayName    REG_SZ    别的软件',
      '    UninstallString    REG_SZ    "C:\\Other\\u.exe"',
      '',
      'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{B}',
      `    DisplayName    REG_SZ    ${UNINSTALL_PRODUCT_NAME}`,
      '    UninstallString    REG_SZ    "C:\\App\\Uninstall 测试中台.exe"',
    ].join('\r\n');
    const items = parseRegQueryOutput(text);
    expect(items.length).toBe(2);
    expect(items[0].displayName).toBe('别的软件');
    expect(items[1].displayName).toBe(UNINSTALL_PRODUCT_NAME);
    expect(items[1].uninstallString).toContain('Uninstall 测试中台.exe');
    expect(parseRegQueryOutput('')).toEqual([]);
    expect(parseRegQueryOutput(null)).toEqual([]);
  });
});

describe('uninstall：路径归属与 dataDirAck（§3.3 / AC-UN-05 / AC-UN-06）', () => {
  it('isInside：子路径 true、同路径 true、前缀相似的不同目录 false、大小写不敏感', () => {
    const dir = 'C:\\Data\\app';
    expect(isInside(dir, join(dir, 'vault.enc'))).toBe(true);
    expect(isInside(dir, join(dir, 'backups', 'x.bak'))).toBe(true);
    expect(isInside(dir, dir)).toBe(true);
    expect(isInside(dir, 'C:\\Data\\app2\\vault.enc')).toBe(false);
    expect(isInside(dir, 'C:\\Data')).toBe(false);
    expect(isInside(dir.toUpperCase(), join(dir, 'vault.enc'))).toBe(true);
    expect(isInside('', dir)).toBe(false);
    expect(isInside(dir, '')).toBe(false);
  });

  it('isDataDirAck：同路径 true，全大写 true（Windows 不敏感）', () => {
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\测试中台';
    expect(isDataDirAck(dir, dir)).toBe(true);
    expect(isDataDirAck(dir.toUpperCase(), dir)).toBe(true);
  });

  it('isDataDirAck：空/非字符串/异目录一律 false（删数据的硬闸门）', () => {
    const dir = 'C:\\Users\\me\\AppData\\Roaming\\测试中台';
    expect(isDataDirAck('', dir)).toBe(false);
    expect(isDataDirAck('   ', dir)).toBe(false);
    expect(isDataDirAck(undefined, dir)).toBe(false);
    expect(isDataDirAck(null, dir)).toBe(false);
    expect(isDataDirAck(123, dir)).toBe(false);
    expect(isDataDirAck('C:\\Windows', dir)).toBe(false);
    expect(isDataDirAck(join(dir, 'sub'), dir)).toBe(false);
  });
});

describe('uninstall：按清单删数据（§3.5 / D5，AC-UN-04）', () => {
  it('只删清单内 15 项，清单外用户文件保留，error 为 null', () => {
    const dir = 'D';
    const fs = makeFs(managedFixture(dir));
    const res = removeManagedData({ dataDir: dir, io: fs.io, log: (m) => fs.log.push(m) });

    expect(res.removedPaths.length).toBe(15);
    expect(res.error).toBeNull();
    for (const f of MANAGED_DATA_FILES) expect(fs.exists(join(dir, f))).toBe(false);
    for (const d of MANAGED_DATA_DIRS) expect(fs.exists(join(dir, d))).toBe(false);
    // 用户自己丢进数据目录的东西不受影响
    expect(fs.exists(join(dir, 'mine.txt'))).toBe(true);
    expect(fs.exists(join(dir, 'backups', 'b1.bak'))).toBe(false);
  });

  it('二次调用幂等：返回 removedPaths=[] 且 error=null，不抛', () => {
    const dir = 'D';
    const fs = makeFs(managedFixture(dir));
    removeManagedData({ dataDir: dir, io: fs.io });
    const again = removeManagedData({ dataDir: dir, io: fs.io });
    expect(again.removedPaths).toEqual([]);
    expect(again.error).toBeNull();
    expect(fs.exists(join(dir, 'mine.txt'))).toBe(true);
  });

  it('数据目录本来就不存在 → 没有可删的（幂等，不报错）', () => {
    const fs = makeFs([]);
    const res = removeManagedData({ dataDir: 'D', io: fs.io });
    expect(res).toEqual({ removedPaths: [], error: null });
  });

  it('dataDir 为空 → 直接返回错误，不删任何东西', () => {
    const fs = makeFs(managedFixture('D'));
    const res = removeManagedData({ dataDir: '', io: fs.io });
    expect(res.removedPaths).toEqual([]);
    expect(res.error).toBe('数据目录为空');
    expect(fs.calls.unlink).toBe(0);
    expect(fs.calls.rm).toBe(0);
  });

  it('realpath 指向界外 → 跳过该目标并记日志，文件仍在', () => {
    const dir = 'D';
    const fs = makeFs(managedFixture(dir));
    const escaped = join(dir, 'attachments');
    const io = {
      ...fs.io,
      realpathSync: (p: string) => (norm(p) === norm(escaped) ? 'C:\\outside\\attachments' : p),
    };
    const res = removeManagedData({ dataDir: dir, io, log: (m) => fs.log.push(m) });
    expect(res.removedPaths).not.toContain(escaped);
    expect(res.removedPaths.length).toBe(14);
    expect(fs.exists(escaped)).toBe(true);
    expect(fs.log.some((m) => m.includes('跳过越界'))).toBe(true);
  });

  it('删空后用**非递归** rmdir 收尾；目录里还有用户文件时保留目录', () => {
    const dir = 'D';
    const onlyManaged = makeFs([
      { path: dir, kind: 'dir' as const },
      ...MANAGED_DATA_FILES.map((f) => ({ path: join(dir, f), kind: 'file' as const, size: 1 })),
      ...MANAGED_DATA_DIRS.map((d) => ({ path: join(dir, d), kind: 'dir' as const })),
    ]);
    removeManagedData({ dataDir: dir, io: onlyManaged.io });
    expect(onlyManaged.calls.rmdir).toBe(1);
    expect(onlyManaged.exists(dir)).toBe(false);

    const withUserFile = makeFs(managedFixture(dir));
    removeManagedData({ dataDir: dir, io: withUserFile.io });
    expect(withUserFile.calls.rmdir).toBe(0);
    expect(withUserFile.exists(dir)).toBe(true);
  });
});

describe('uninstall：体积统计（§3.4 / AC-UN-12）', () => {
  it('累加文件体积、breakdown 降序、文件与目录都出现在直属项里', () => {
    const dir = 'D';
    const fs = makeFs([
      { path: dir, kind: 'dir' },
      { path: join(dir, 'a.bin'), kind: 'file', size: 1024 },
      { path: join(dir, 'b.bin'), kind: 'file', size: 100 },
      { path: join(dir, 'backups'), kind: 'dir' },
      { path: join(dir, 'backups', 'x.bak'), kind: 'file', size: 50 },
    ]);
    const r = dataSizeOf(dir, { io: fs.io });
    expect(r.size).toBe(1174);
    // 降序：1024（a.bin）> 100（b.bin）> 50（backups 目录内部累加）
    expect(r.breakdown.map((b) => b.dir)).toEqual(['a.bin', 'b.bin', 'backups']);
    expect(r.breakdown[0].size).toBe(1024);
    expect(r.breakdown[2].size).toBe(50);
    expect(r.error).toBeUndefined();
  });

  it('空目录 → size 0、breakdown 空、无 error', () => {
    const fs = makeFs([{ path: 'D', kind: 'dir' }]);
    expect(dataSizeOf('D', { io: fs.io })).toEqual({ size: 0, breakdown: [] });
  });

  it('顶层不可读 → size 0 + 明确 error（危险区卡片据此降级，而不是显示 0 B 骗用户）', () => {
    const fs = makeFs([{ path: 'D', kind: 'dir' }]);
    const io = {
      ...fs.io,
      readdirSync: () => { throw new Error('EACCES: 权限不足'); },
    };
    const r = dataSizeOf('D', { io });
    expect(r.size).toBe(0);
    expect(r.error).toContain('无法读取数据目录');
  });

  it('软链跳过（不跟随，避免环），原因写进 error', () => {
    const dir = 'D';
    const fs = makeFs([
      { path: dir, kind: 'dir' },
      { path: join(dir, 'real.bin'), kind: 'file', size: 10 },
      { path: join(dir, 'loop'), kind: 'dir', symlink: true },
    ]);
    const r = dataSizeOf(dir, { io: fs.io });
    expect(r.size).toBe(10);
    expect(r.error).toContain('跳过');
  });

  it('目录层级超过 6 层不计入，原因写进 error', () => {
    const dir = 'D';
    const chain = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
    const seed: Seed[] = [{ path: dir, kind: 'dir' }];
    let cur = dir;
    for (const name of chain) {
      cur = join(cur, name);
      seed.push({ path: cur, kind: 'dir' });
    }
    seed.push({ path: join(cur, 'deep.bin'), kind: 'file', size: 99 });
    const fs = makeFs(seed);
    const r = dataSizeOf(dir, { io: fs.io });
    expect(r.size).toBe(0);
    expect(r.error).toContain(`超过 ${SIZE_MAX_DEPTH} 层`);
  });

  it('超预算 → 不抛、返回已统计值为下限 + 「统计超时」', () => {
    const dir = 'D';
    const seed: Seed[] = [{ path: dir, kind: 'dir' }];
    for (let i = 0; i < 5; i += 1) seed.push({ path: join(dir, `f${i}.bin`), kind: 'file', size: 100 });
    const fs = makeFs(seed);
    let clock = 0;
    const io = { ...fs.io };
    const r = dataSizeOf(dir, { io, budgetMs: 10, now: () => { clock += 40; return clock; } });
    expect(r.error).toContain('统计超时');
    expect(typeof r.size).toBe('number');
    expect(r.size).toBeGreaterThanOrEqual(0);
  });
});
