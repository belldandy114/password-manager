import { create } from 'zustand';
import type { ZentaoBug, ZentaoProject, MyBugScope } from '../types';

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
  pQuery: string;

  setBugs: (bugs: ZentaoBug[], total: number) => void;
  setMineScope: (scope: MyBugScope) => void;
  setMineProductIds: (ids: string[]) => void;
  setMineAllProjects: (all: boolean) => void;
  setFilter: (patch: Partial<Pick<ZentaoState, 'project' | 'status' | 'severity' | 'query'>>) => void;
  setProjects: (list: ZentaoProject[]) => void;
  setActiveProject: (id: string) => void;
  setProjectBugs: (bugs: ZentaoBug[], total: number) => void;
  setPFilter: (patch: Partial<Pick<ZentaoState, 'pStatus' | 'pSeverity' | 'pQuery'>>) => void;
  clear: () => void;
}

export const useZentaoStore = create<ZentaoState>((set) => ({
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
  pQuery: '',

  setBugs: (bugs, total) => set({ bugs, total, fetchedAt: new Date().toISOString() }),
  setMineScope: (mineScope) => set({ mineScope }),
  setMineProductIds: (mineProductIds) => set({ mineProductIds, mineAllProjects: false }),
  setMineAllProjects: (mineAllProjects) => set({ mineAllProjects }),
  setFilter: (patch) => set(patch),
  setProjects: (list) => set({ projects: list }),
  // 切换项目时清掉上一个项目的筛选与数据，避免看起来「没数据」
  setActiveProject: (id) => set({ activeProject: id, pStatus: '', pSeverity: '', pQuery: '', projectBugs: [], projectTotal: 0 }),
  setProjectBugs: (bugs, total) => set({ projectBugs: bugs, projectTotal: total, projectFetchedAt: new Date().toISOString() }),
  setPFilter: (patch) => set(patch),
  clear: () => set({
    bugs: [], total: 0, fetchedAt: '', project: '', status: '', severity: '', query: '',
    projects: [], activeProject: '', projectBugs: [], projectTotal: 0, projectFetchedAt: '',
    pStatus: '', pSeverity: '', pQuery: '', mineProductIds: [], mineAllProjects: false,
  }),
}));
