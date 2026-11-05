import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { ZentaoBug, ZentaoProject, MyBugScope } from '../types';
import type { SummaryFormat } from '../utils/bugSummary';

/** 上一次汇总的关键数字（同项目组合下用来算环比） */
export interface SumSnapshot {
  key: string;
  at: string;
  total: number;
  fixed: number;
  active: number;
  resolved: number;
  closed: number;
}

/**
 * 禅道数据放在 store 里，而不是页面组件的 useState：
 * 侧边栏切走页面会卸载组件，useState 会丢 —— 表现为「拉取完切个页面内容就没了」。
 */
interface ZentaoState {
  /* ---- 我的 Bug ---- */
  bugs: ZentaoBug[];
  total: number;
  fetchedAt: string;
  project: string;   // '' = 全部项目
  status: string;    // '' = 全部状态（也可以是 unclosed / fixed）
  severity: string;  // '' = 全部严重程度
  query: string;
  /** 我的 Bug 视图：指派给我 / 我提交的 / 待我验证（切页面不丢） */
  mineScope: MyBugScope;
  /** 我的 Bug 三个视图要查哪些项目（禅道 REST 强制 product；空数组=还没选） */
  mineProductIds: string[];
  /** 三个视图勾了「全部项目」时为 true（忽略 mineProductIds，查所有项目） */
  mineAllProjects: boolean;

  /* ---- 项目 Bug（整个项目，不限指派人） ---- */
  projects: ZentaoProject[];
  activeProject: string;      // 产品 id
  projectBugs: ZentaoBug[];
  projectTotal: number;
  projectFetchedAt: string;
  pStatus: string;
  pSeverity: string;
  /** 模块筛选（模块路径全名，'' = 全部模块） */
  pModule: string;
  pQuery: string;

  /* ---- 多项目汇总 ---- */
  sumBugs: ZentaoBug[];
  /** 产品 id → { 模块 id: 模块路径 } */
  sumModules: Record<string, Record<string, string>>;
  /** 当前选择要汇总的项目（持久化） */
  sumProductIds: string[];
  /** 上次实际拉取到的项目（用来提示「选择变了但数据没更新」） */
  sumDataIds: string[];
  /** 排除人员（显示名）：名下挂着的缺陷不计入「按人员」 */
  sumExclude: string[];
  /** 测试人员名单（本地标记）：用来一键把这类人从人员表里排除，持久化 */
  sumTesters: string[];
  /** 时间窗（天）：0 = 全部，7 / 30 / 90 = 只看这些天里提交的缺陷 */
  sumSince: number;
  /** 统计日切分点（HH:mm，默认 17:30）：17:30 → 次日 17:30 记作一个统计日 */
  sumDayCutoff: string;
  /** 上次汇总的关键数字，用来显示「较上次 +N/-N」 */
  sumSnapshot: SumSnapshot | null;
  /** 复制格式偏好 */
  sumFormat: SummaryFormat;
  sumFetchedAt: string;

  setBugs: (bugs: ZentaoBug[], total: number) => void;
  setMineScope: (scope: MyBugScope) => void;
  setMineProductIds: (ids: string[]) => void;
  setMineAllProjects: (all: boolean) => void;
  /** 切换禅道配置时清掉上一套地址的项目/选择，避免串数据 */
  resetProjectScope: () => void;
  setFilter: (patch: Partial<Pick<ZentaoState, 'project' | 'status' | 'severity' | 'query'>>) => void;
  setProjects: (list: ZentaoProject[]) => void;
  setActiveProject: (id: string) => void;
  setProjectBugs: (bugs: ZentaoBug[], total: number) => void;
  setPFilter: (patch: Partial<Pick<ZentaoState, 'pStatus' | 'pSeverity' | 'pModule' | 'pQuery'>>) => void;
  setSummary: (bugs: ZentaoBug[], modules: Record<string, Record<string, string>>, dataIds: string[]) => void;
  setSumProductIds: (ids: string[]) => void;
  setSumExclude: (names: string[]) => void;
  setSumTesters: (names: string[]) => void;
  setSumSince: (days: number) => void;
  setSumDayCutoff: (hhmm: string) => void;
  setSumFormat: (fmt: SummaryFormat) => void;
  /** 记下本次结果作为下次的环比基准 */
  saveSumSnapshot: (snap: SumSnapshot) => void;
  clear: () => void;
}

export const useZentaoStore = create<ZentaoState>()(
  persist(
    (set) => ({
  bugs: [],
  total: 0,
  fetchedAt: '',
  project: '',
  status: '',
  severity: '',
  query: '',
  mineScope: 'assigned',
  mineProductIds: [],
  mineAllProjects: false,

  projects: [],
  activeProject: '',
  projectBugs: [],
  projectTotal: 0,
  projectFetchedAt: '',
  pStatus: '',
  pSeverity: '',
  pModule: '',
  pQuery: '',

  sumBugs: [],
  sumModules: {},
  sumProductIds: [],
  sumDataIds: [],
  sumExclude: [],
  sumTesters: [],
  sumSince: 0,
  sumDayCutoff: '17:30',
  sumSnapshot: null,
  sumFormat: 'text',
  sumFetchedAt: '',

  setBugs: (bugs, total) => set({ bugs, total, fetchedAt: new Date().toISOString() }),
  setMineScope: (mineScope) => set({ mineScope }),
  setMineProductIds: (mineProductIds) => set({ mineProductIds, mineAllProjects: false }),
  setMineAllProjects: (mineAllProjects) => set({ mineAllProjects }),
  resetProjectScope: () => set({
    projects: [], activeProject: '', projectBugs: [], projectTotal: 0, projectFetchedAt: '',
    mineProductIds: [], mineAllProjects: false,
    sumBugs: [], sumModules: {}, sumProductIds: [], sumDataIds: [], sumFetchedAt: '',
  }),
  setFilter: (patch) => set(patch),
  setProjects: (list) => set({ projects: list }),
  // 切换项目时清掉上一个项目的筛选与数据，避免看起来「没数据」
  setActiveProject: (id) => set((s) => (s.activeProject === id
    ? { activeProject: id }
    : { activeProject: id, pStatus: '', pSeverity: '', pModule: '', pQuery: '', projectBugs: [], projectTotal: 0 })),
  setProjectBugs: (bugs, total) => set({ projectBugs: bugs, projectTotal: total, projectFetchedAt: new Date().toISOString() }),
  setPFilter: (patch) => set(patch),
  setSummary: (bugs, modules, dataIds) => set({
    sumBugs: bugs, sumModules: modules, sumDataIds: dataIds,
    sumFetchedAt: new Date().toISOString(),
  }),
  setSumProductIds: (sumProductIds) => set({ sumProductIds }),
  setSumExclude: (sumExclude) => set({ sumExclude }),
  setSumTesters: (sumTesters) => set({ sumTesters }),
  setSumSince: (sumSince) => set({ sumSince }),
  setSumDayCutoff: (sumDayCutoff) => set({ sumDayCutoff }),
  setSumFormat: (sumFormat) => set({ sumFormat }),
  saveSumSnapshot: (sumSnapshot) => set({ sumSnapshot }),
  clear: () => set({
    bugs: [], total: 0, fetchedAt: '', project: '', status: '', severity: '', query: '',
    projects: [], activeProject: '', projectBugs: [], projectTotal: 0, projectFetchedAt: '',
    pStatus: '', pSeverity: '', pModule: '', pQuery: '', mineProductIds: [], mineAllProjects: false,
    sumBugs: [], sumModules: {}, sumProductIds: [], sumDataIds: [], sumFetchedAt: '', sumSnapshot: null,
  }),
    }),
    {
      name: 'pm.zentao.store',
      storage: createJSONStorage(() => sessionStorage),
      // 只存数据与筛选状态：函数、临时 busy 标记不进存储
      partialize: (st) => ({
        bugs: st.bugs, total: st.total, fetchedAt: st.fetchedAt,
        mineScope: st.mineScope, mineProductIds: st.mineProductIds, mineAllProjects: st.mineAllProjects,
        projects: st.projects, activeProject: st.activeProject,
        projectBugs: st.projectBugs, projectTotal: st.projectTotal, projectFetchedAt: st.projectFetchedAt,
        project: st.project, status: st.status, severity: st.severity, query: st.query,
        pStatus: st.pStatus, pSeverity: st.pSeverity, pModule: st.pModule, pQuery: st.pQuery,
        // 汇总的 Bug 量大，只把「选了哪些项目 / 排除了谁 / 测试人员名单 / 时间窗 / 上次快照」留在会话里，数据每次重拉
        sumProductIds: st.sumProductIds, sumExclude: st.sumExclude, sumTesters: st.sumTesters,
        sumSince: st.sumSince, sumDayCutoff: st.sumDayCutoff,
        sumSnapshot: st.sumSnapshot, sumFormat: st.sumFormat,
      }),
      version: 2,
    },
  ),
);
