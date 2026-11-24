import { describe, it, expect } from 'vitest';
import {
  TRUNCATED_REASONS,
  FINDINGS_DETAIL_CAP,
  SCAN_MAX_FILES,
  SCAN_MAX_DEPTH,
  SCAN_TIMEOUT_MS,
  SKIP_DIRS,
} from '../../../electron/scan-collect.js';
import type { ScanTruncatedReason as BackendReason } from '../../../electron/scan-collect.js';
import { MAX_HITS_PER_RULE } from '../../../electron/scan-rules.js';
import { SCAN_TRUNCATED_REASONS } from '../../types';
import type { ScanTruncatedReason } from '../../types';
import {
  FINDINGS_CAP,
  SCAN_HISTORY_FINDINGS_CAP,
  MAX_HITS_PER_RULE as RENDERER_MAX_HITS_PER_RULE,
  SCAN_MAX_FILES as RENDERER_SCAN_MAX_FILES,
  SCAN_MAX_DEPTH as RENDERER_SCAN_MAX_DEPTH,
  SCAN_TIMEOUT_MS as RENDERER_SCAN_TIMEOUT_MS,
} from '../../components/codeaudit/scanModel';

/**
 * 跨层常量门禁（第 1 轮评审 R-03 / R-05 / C10）。
 *
 * 两件事在这里被机械锁死，**不靠注释提醒**：
 *   1. **枚举单一真源**：`ScanTruncatedReason` 以前有两份声明（`src/types.ts` 7 值含 `'files'`、
 *      `electron/scan-collect.d.ts` 6 值不含），C-09 v17 裁定 scan 侧**不含 `files`**（`files` 只归
 *      `allure:parse`）。现在 `scan-collect.d.ts` 直接 import `src/types.ts` 的联合类型，
 *      这里再做一次运行时集合比对，防止「改了 JS 数组忘了改类型」。
 *   2. **常量双源**：明细上限 2000 / 落库上限 300 / 每规则折叠 3 / 文件数 2000 / 深度 12 / 超时 60 s
 *      在渲染层各有一份手写副本（`scanModel.ts`：渲染层不 import 主进程常量）。
 *      后端调上限而文案没跟上时，界面会说谎且门禁全绿——所以这里**同时 import 两侧比较**。
 *      （这批常量已从 `AuditTab.tsx` 下沉到 `scanModel.ts` 并被导出，所以是纯 import 比对，
 *      不需要读源码文本；任何一侧改名/删掉都会直接编译不过。）
 */
describe('ScanTruncatedReason 单一真源（R-03：scan 侧不含 files）', () => {
  it('types.ts 与 scan-collect 的原因集合逐字一致（运行时集合比对）', () => {
    expect([...SCAN_TRUNCATED_REASONS]).toEqual([...TRUNCATED_REASONS]);
    // 大小写/顺序都无关地再比一次，避免「只是碰巧长度相同」
    expect([...SCAN_TRUNCATED_REASONS].sort()).toEqual([...TRUNCATED_REASONS].sort());
  });

  it('scan 侧**不含** files（files 只归 allure:parse），且恰好 6 个值', () => {
    expect(TRUNCATED_REASONS).not.toContain('files');
    expect(SCAN_TRUNCATED_REASONS).not.toContain('files');
    expect(TRUNCATED_REASONS).toHaveLength(6);
    expect([...TRUNCATED_REASONS].sort()).toEqual(
      ['depth', 'file-size', 'findings', 'max-files', 'suppressed', 'timeout'],
    );
  });

  it('两边的联合类型可互相赋值（编译期单一真源：任一侧多/少一个值都编译不过）', () => {
    const typingToBackend: BackendReason[] = [...SCAN_TRUNCATED_REASONS];
    const backendToTyping: ScanTruncatedReason[] = [...TRUNCATED_REASONS];
    expect(typingToBackend).toEqual(backendToTyping);
  });
});

describe('跨层常量相等（R-05 / C10：后端调上限，界面文案不许说谎）', () => {
  it('明细上限：主进程 FINDINGS_DETAIL_CAP === 渲染层 FINDINGS_CAP === 2000', () => {
    expect(FINDINGS_DETAIL_CAP).toBe(2000);
    expect(FINDINGS_CAP).toBe(FINDINGS_DETAIL_CAP);
  });

  it('落库上限：SCAN_HISTORY_FINDINGS_CAP === 300，且严格小于明细上限（C-29：两者必须解耦）', () => {
    expect(SCAN_HISTORY_FINDINGS_CAP).toBe(300);
    expect(SCAN_HISTORY_FINDINGS_CAP).toBeLessThan(FINDINGS_DETAIL_CAP);
  });

  it('每规则折叠上限：主进程 MAX_HITS_PER_RULE === 渲染层 scanModel 的同名常量 === 3', () => {
    expect(MAX_HITS_PER_RULE).toBe(3);
    // 这条就是 C10 要的东西：后端把 3 改成 5、渲染层文案还写 3 → 这里直接红
    expect(RENDERER_MAX_HITS_PER_RULE).toBe(MAX_HITS_PER_RULE);
  });

  it('扫描覆盖上限：文件数 2000 / 深度 12 / 超时 60000ms 在两侧同值（文案里的那三个数）', () => {
    expect(RENDERER_SCAN_MAX_FILES).toBe(SCAN_MAX_FILES);
    expect(RENDERER_SCAN_MAX_DEPTH).toBe(SCAN_MAX_DEPTH);
    expect(RENDERER_SCAN_TIMEOUT_MS).toBe(SCAN_TIMEOUT_MS);
    // 顺带锁住主进程这一侧的取值（契约 C-53）
    expect([SCAN_MAX_FILES, SCAN_MAX_DEPTH, SCAN_TIMEOUT_MS]).toEqual([2000, 12, 60000]);
  });
});

describe('目录守卫清单（C-54 v16/v17）', () => {
  it('SKIP_DIRS 含全部 9 个约定目录 + 新增的 coverage，且不误伤普通目录', () => {
    for (const name of ['node_modules', '.git', 'dist', 'release', 'build', 'target', '.venv', 'vendor', 'out', 'coverage']) {
      expect(SKIP_DIRS.has(name)).toBe(true);
    }
    for (const name of ['src', 'electron', 'run', 'docs', 'test']) {
      expect(SKIP_DIRS.has(name)).toBe(false);
    }
  });
});
