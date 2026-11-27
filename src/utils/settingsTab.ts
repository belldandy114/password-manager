/**
 * settingsTab.ts —— 设置页 tab 的**唯一真源**（1.37.0）
 *
 * 契约：`docs/契约-设置细分-免密-卸载.md` §1.1（7 个 id / 顺序 / 文案）、§1.2（历史 id 全量映射）、
 * §1.3（归一化算法，逐字实现）、§10 KEEP-L2。
 *
 * 为什么从 Settings.tsx 下沉到这里（契约 D1）：Settings.tsx 有 2500 行且 import React / Modal / Toast，
 * 无法单测；而「历史 localStorage id 必须全部落到新 tab，漏一条就是白屏」这条只能靠单测兜。
 *
 * 约束：
 * - 纯 TS，**不 import React / JSX / Node 内置模块**（`tsconfig.json` 的 `types: []`，渲染层不许引 Node 类型）；
 * - 无副作用（不读不写 localStorage，读写在调用方 Settings.tsx 的 useState / useEffect）；
 * - 图标只存 `Icons` 的**键名**，节点由 Settings.tsx 渲染（`<Icons[t.icon] />`）。
 */

/** 7 个 tab id（顺序即 rail 渲染顺序，见 SETTINGS_TABS） */
export type SettingsTab = 'security' | 'appearance' | 'interaction' | 'data' | 'tasks' | 'about' | 'danger';

/** 图标键名，全部来自 `src/components/ui.tsx` 的 `Icons` */
export type SettingsTabIcon = 'lock' | 'tool' | 'key' | 'db' | 'clock' | 'note' | 'trash';

/** localStorage 键名**不换**（老用户的值直接复用，归一化在读时完成） */
export const SETTINGS_TAB_KEY = 'pm.settings.tab';

/**
 * rail 与内容区的**同一份**真源：nav 与 switch 都从这里派生，禁止两处各写一份。
 * 顺序 = 契约 §1.1 的表格顺序。
 */
export const SETTINGS_TABS: readonly { id: SettingsTab; label: string; hint: string; icon: SettingsTabIcon }[] = [
  { id: 'security', label: '安全', hint: '主密码 / 锁定 / 剪贴板', icon: 'lock' },
  { id: 'appearance', label: '外观', hint: '主题 / 背景 / 玻璃', icon: 'tool' },
  { id: 'interaction', label: '交互', hint: '浏览器 / 快捷键 / 托盘', icon: 'key' },
  { id: 'data', label: '数据与备份', hint: '备份 / 目录 / 自检', icon: 'db' },
  { id: 'tasks', label: '定时任务', hint: '巡检 / 禅道 / 回归', icon: 'clock' },
  { id: 'about', label: '关于与更新', hint: '版本 / 更新 / 日志', icon: 'note' },
  { id: 'danger', label: '危险区', hint: '卸载 / 清空 / 重置', icon: 'trash' },
];

/** 合法 id 全集（判定用） */
export const SETTINGS_TAB_IDS: readonly SettingsTab[] = SETTINGS_TABS.map(t => t.id);

/**
 * 历史 id → 当前 id（契约 §1.2 全量表，**一条都不能少**，缺一条 = 老用户白屏）。
 *
 * ⚠️ 用 `Object.create(null)` 建表：`localStorage` / JSON 里出现过 `__proto__`、`constructor`
 * 这类键，对象字面量查表会命中原型链（`'constructor' in {}` 为真），把 tab 解析成 `Object` 之类
 * 的怪值。null 原型的表没有原型链，未命中的键一律 `undefined`。
 * 与 id 同名的 identity 项也显式列出，防止有人把 identity 当「未映射」删掉。
 */
export const LEGACY_TAB_MAP: Record<string, SettingsTab> = Object.assign(
  Object.create(null) as Record<string, SettingsTab>,
  {
    // v1.35 及更早（5 tab 之前）
    general: 'appearance',
    browser: 'interaction',
    shortcuts: 'interaction',
    security: 'security',
    tasks: 'tasks',
    data: 'data',
    about: 'about',
    // v1.36 的 5 tab（本次之前）同名原样可用
    appearance: 'appearance',
    // 历史别名（防御性：曾出现在文档 / 旧截图里）
    update: 'about',
    backup: 'data',
    password: 'security',
    hotkey: 'interaction',
    hotkeys: 'interaction',
    tray: 'interaction',
    theme: 'appearance',
    background: 'appearance',
    // 本次新增
    uninstall: 'danger',
    danger: 'danger',
    interaction: 'interaction',
  } as Record<string, SettingsTab>,
);

/**
 * 把任意历史 / 脏数据 tab id 归一到 7 个合法 id 之一（契约 §1.3，判定顺序**短路、不可重排**）：
 * 1. 非字符串 / `null` / `undefined` / `''` → `security`
 * 2. 去首尾空白 + 转小写
 * 3. `LEGACY_TAB_MAP` 命中 → 映射值作为候选
 * 4. 否则候选 = 归一化后的字符串本身
 * 5. 候选 ∈ `SETTINGS_TAB_IDS` → 返回；否则 → `security`（唯一兜底值）
 *
 * 幂等：`normalizeSettingsTab(normalizeSettingsTab(x)) === normalizeSettingsTab(x)`。
 * 副作用：无。
 */
export function normalizeSettingsTab(raw: string | null | undefined): SettingsTab {
  // 1) 非字符串（含 null / undefined / 被塞进来的对象）一律回安全页：
  //    防御 localStorage 被写进对象后 `String(raw)` 出 '[object Object]' 这类值。
  if (typeof raw !== 'string') return 'security';
  // 2) 去空白 + 小写：'  DANGER ' → 'danger'，大小写差异不得导致回落
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return 'security';
  // 3) 历史映射（null 原型表，'__proto__' / 'constructor' 不会命中）
  // 5) 候选必须 ∈ 合法集，否则回 security
  const candidate = LEGACY_TAB_MAP[normalized] || normalized;
  return (SETTINGS_TAB_IDS as readonly string[]).includes(candidate) ? (candidate as SettingsTab) : 'security';
}
