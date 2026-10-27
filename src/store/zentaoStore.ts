import { create } from 'zustand';
import type { ZentaoBug } from '../types';

/**
 * 禅道数据放在 store 里，而不是页面组件的 useState：
 * 侧边栏切走页面会卸载组件，useState 会丢 —— 表现为「拉取完切个页面内容就没了」。
 */
interface ZentaoState {
  bugs: ZentaoBug[];
  total: number;
  loggedIn: boolean;
  fetchedAt: string;

  // 筛选条件（切页回来仍然保留）
  project: string;   // '' = 全部项目
  status: string;    // '' = 全部状态
  severity: string;  // '' = 全部严重程度
  query: string;

  setBugs: (bugs: ZentaoBug[], total: number) => void;
  setLoggedIn: (v: boolean) => void;
  setFilter: (patch: Partial<Pick<ZentaoState, 'project' | 'status' | 'severity' | 'query'>>) => void;
  clear: () => void;
}

export const useZentaoStore = create<ZentaoState>((set) => ({
  bugs: [],
  total: 0,
  loggedIn: false,
  fetchedAt: '',

  project: '',
  status: '',
  severity: '',
  query: '',

  setBugs: (bugs, total) => set({ bugs, total, fetchedAt: new Date().toISOString() }),
  setLoggedIn: (loggedIn) => set({ loggedIn }),
  setFilter: (patch) => set(patch),
  clear: () => set({ bugs: [], total: 0, loggedIn: false, fetchedAt: '', project: '', status: '', severity: '', query: '' }),
}));
