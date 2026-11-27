/**
 * 声明文件：让渲染层单测可以 import electron/uninstall.js
 *
 * 该 .js 是**纯函数模块**（不 `require('electron')`，`isPackaged` / `execPath` /
 * `execFileSync` / 文件系统读写全部注入，见契约 D7），所以这里只写签名，
 * 不引 `@types/node`（`tsconfig.json` 是 `types: []`）。
 * 导出的 18 个值逐个对应 `Object.keys(require('./uninstall.js'))`，不多不少。
 */

/** `app.isPackaged` 为真 = 安装版；否则源码 / `npm start`（契约 §3.4） */
export type UninstallMode = 'installed' | 'dev';
/** 卸载器是从哪儿找到的（契约 §3.4 的发现顺序） */
export type UninstallerSource = 'registry-hkcu' | 'registry-hklm' | 'exe-sibling';

/** `readdirSync(..., { withFileTypes: true })` 的元素（单测可传替身，故全字段可选） */
export interface UninstallDirent {
  name?: string;
  isDirectory?: () => boolean;
  isSymbolicLink?: () => boolean;
}

/** `statSync()` 的最小形状（只用到 size / isDirectory） */
export interface UninstallStat {
  size?: number;
  isDirectory?: () => boolean;
}

/**
 * 注入的文件系统/进程替身（契约 §3.4：`dataSizeOf` 注入 readdir/stat，
 * 卸载器发现注入 `execFileSync`）。生产实现见 `defaultIo()`。
 */
export interface UninstallIo {
  existsSync(p: string): boolean;
  statSync(p: string): UninstallStat;
  readdirSync(p: string, opts?: { withFileTypes: boolean }): UninstallDirent[];
  realpathSync(p: string): string;
  unlinkSync(p: string): void;
  rmdirSync(p: string): void;
  rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }): void;
  /** `reg query <key> /s`：**参数数组**调用，绝不 shell: true */
  execFileSync(file: string, args: string[], opts?: Record<string, unknown>): string;
}

/** `findUninstaller()` 的返回；找不到时三项全 null */
export interface UninstallerFound {
  path: string | null;
  source: UninstallerSource | null;
  regKey: string | null;
}

export interface FindUninstallerInput {
  isPackaged?: boolean;
  execPath?: string;
  productName?: string;
  io?: Partial<UninstallIo>;
}

/** `reg query` 解析出来的单条卸载项 */
export interface RegUninstallEntry {
  key: string;
  displayName: string;
  uninstallString: string;
}

/** `dataSizeOf()` 的 breakdown 元素：`DATA_DIR` 直属子项名称 + 体积（字节） */
export interface DataSizeEntry {
  dir: string;
  size: number;
}

export interface DataSizeResult {
  /** 总字节数；超预算/无权限时是**下限值**（见 error） */
  size: number;
  /** 直属子项体积，降序，最多 8 条 */
  breakdown: DataSizeEntry[];
  /** 统计超时 / 无权限 / 软链跳过 等原因（存在时 size 为下限值） */
  error?: string;
}

export interface DataSizeOptions {
  io?: Partial<UninstallIo>;
  /** 总耗时预算，默认 2000ms */
  budgetMs?: number;
  /** 注入时钟（便于单测超时分支） */
  now?: () => number;
}

export interface RemoveManagedDataInput {
  dataDir?: string;
  io?: Partial<UninstallIo>;
  /** 越界跳过等情况的日志出口（主进程传 `console.log`，落 app.log） */
  log?: (msg: string) => void;
}

export interface RemoveManagedDataResult {
  /** 受管清单里实际删掉的绝对路径 */
  removedPaths: string[];
  /** 失败原因汇总；全部成功为 null */
  error: string | null;
}

/** 产品名（注册表 `DisplayName` 与 NSIS 卸载器产物名都靠它） */
export declare const UNINSTALL_PRODUCT_NAME: string;
/** `reg query` 用的三个键（HKCU → HKLM → WOW6432Node） */
export declare const REG_UNINSTALL_KEYS: string[];
/** 注册表查询超时（1500ms，超时按「未找到」处理） */
export declare const REG_QUERY_TIMEOUT_MS: number;
/** 体积统计总耗时预算（2000ms） */
export declare const SIZE_BUDGET_MS: number;
/** 体积统计递归深度上限（6） */
export declare const SIZE_MAX_DEPTH: number;
/** 体积统计条目上限（20000） */
export declare const SIZE_MAX_ENTRIES: number;
/** 受管删除清单里的文件（10 项） */
export declare const MANAGED_DATA_FILES: string[];
/** 受管删除清单里的目录（5 项） */
export declare const MANAGED_DATA_DIRS: string[];

/** 真实 io 实现；可传替身覆盖任意一项（单测用） */
export declare function defaultIo(overrides?: Partial<UninstallIo>): UninstallIo;
/** `app.isPackaged` → `'installed' | 'dev'` */
export declare function uninstallMode(isPackaged?: boolean): UninstallMode;
/** 解析注册表的 `UninstallString`；不是 `.exe` 绝对路径时返回 null */
export declare function parseUninstallString(raw: unknown): string | null;
/** 解析 `reg query <key> /s` 的输出 */
export declare function parseRegQueryOutput(text: unknown): RegUninstallEntry[];
/** 卸载器发现（dev 直接返回三项 null，不查注册表、不猜路径） */
export declare function findUninstaller(input?: FindUninstallerInput): UninstallerFound;
/** `child` 是否仍在 `parent` 之下（调用方负责先 realpath 归一） */
export declare function isInside(parent: string, child: string): boolean;
/** `dataDir` 的体积统计（深度 ≤6、条目 ≤20000、预算 2000ms） */
export declare function dataSizeOf(dir: string, opts?: DataSizeOptions): DataSizeResult;
/** 受管删除清单的绝对路径（单一真源，10 文件 + 5 目录） */
export declare function listManagedDataPaths(dataDir: string): string[];
/** `dataDirAck` 校验（Windows 大小写不敏感；非字符串一律 false） */
export declare function isDataDirAck(ack: unknown, dataDir: string): boolean;
/** 按受管清单删数据（文件不存在不报错，自身幂等；越界目标跳过） */
export declare function removeManagedData(input?: RemoveManagedDataInput): RemoveManagedDataResult;
