/**
 * 页面懒加载表（1.26.0）。
 *
 * 为什么单独一张表：`App.tsx` 的 `lazy()` 和侧栏「悬停预取」必须指向**同一份**
 * import 路径。以前只有 App 里那 13 行 lazy，侧栏想预取就得再抄一遍路径，
 * 抄错一个字母的表现是「点开白屏」；现在两边都从这里取，改页面只改一处。
 *
 * 预取只解决「第一次进这个页面」的等待（实测各页 330~905ms），
 * 失败不影响功能：点进去时 lazy 会重新走一次 import()。
 */

export const PAGE_LOADERS = {
  home: () => import('./Home').then(m => ({ default: m.Home })),
  passwordManager: () => import('./PasswordManagerPage').then(m => ({ default: m.PasswordManagerPage })),
  settings: () => import('./Settings').then(m => ({ default: m.Settings })),
  dataGenerator: () => import('./DataGenerator').then(m => ({ default: m.DataGenerator })),
  toolbox: () => import('./Toolbox').then(m => ({ default: m.Toolbox })),
  environments: () => import('./Environments').then(m => ({ default: m.Environments })),
  weeklyReport: () => import('./WeeklyReport').then(m => ({ default: m.WeeklyReport })),
  notes: () => import('./Notes').then(m => ({ default: m.Notes })),
  attachments: () => import('./Attachments').then(m => ({ default: m.Attachments })),
  zentao: () => import('./ZentaoPage').then(m => ({ default: m.ZentaoPage })),
  apiClient: () => import('./ApiClient').then(m => ({ default: m.ApiClient })),
  perfTest: () => import('./PerfTest').then(m => ({ default: m.PerfTest })),
  codeLab: () => import('./CodeLab').then(m => ({ default: m.CodeLab })),
  cases: () => import('./Cases').then(m => ({ default: m.Cases })),
} as const;

export type PageKey = keyof typeof PAGE_LOADERS;

/** 老路由 → 当前承载页面（与 App.renderPage 的兼容分支保持一致） */
const PAGE_ALIAS: Record<string, string> = {
  jsonConverter: 'toolbox',
  accounts: 'passwordManager',
  snippets: 'notes',
  // 用例页目前没有实现（vault 里的 checklists 也没有写入方），
  // 真要做的时候把 'checklists' 指到新页面即可，预取不用改别处。
};
/** 已经预取过的页面不再重复 import()（模块本身也会缓存，这里只是省一次调用） */
const fetched = new Set<string>();

/**
 * 预取某个页面的 chunk。只接受已知页面 id，老路由（accounts / snippets 等）
 * 会走别名映射，避免「悬停预取 A、点开落到 B」时预取白做。
 */
export function prefetchPage(page: string): void {
  const key = PAGE_ALIAS[page] ?? page;
  if (fetched.has(key)) return;
  const load = (PAGE_LOADERS as Record<string, (() => Promise<unknown>) | undefined>)[key];
  if (!load) return;
  fetched.add(key);
  try {
    void load().catch(() => { fetched.delete(key); });
  } catch {
    fetched.delete(key);
  }
}



