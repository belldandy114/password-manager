import { create } from 'zustand';
import type { PasswordEntry, VaultData, ViewMode, SortField, SortOrder, AppSettings, SearchField, SortOption } from '../types';

interface AppState {
  // Auth
  isLocked: boolean;
  isSetup: boolean | null;
  masterPassword: string;

  // Data
  entries: PasswordEntry[];
  tags: string[];
  trash: PasswordEntry[];

  // UI
  viewMode: ViewMode;
  searchQuery: string;
  searchField: SearchField;
  filterEnv: string;
  filterTag: string;
  filterTags: Set<string>;
  tagSidebarCollapsed: boolean;
  sortField: SortField;
  sortOrder: SortOrder;
  sortOption: SortOption;
  selectedIds: Set<string>;

  // Settings
  settings: AppSettings;

  // Signals (for keyboard shortcuts / cross-component triggers)
  triggerNewEntry: number;
  pmSubPage: string;

  // Actions
  signalNewEntry: () => void;
  setPmSubPage: (page: string) => void;
  setLocked: (locked: boolean) => void;
  setIsSetup: (setup: boolean) => void;
  setMasterPassword: (pw: string) => void;
  setVaultData: (data: VaultData) => void;
  setTrash: (data: PasswordEntry[]) => void;
  setViewMode: (mode: ViewMode) => void;
  setSearchQuery: (q: string) => void;
  setSearchField: (f: SearchField) => void;
  setFilterEnv: (env: string) => void;
  setFilterTag: (tag: string) => void;
  setFilterTags: (tags: Set<string>) => void;
  setTagSidebarCollapsed: (v: boolean) => void;
  setSortField: (field: SortField) => void;
  setSortOrder: (order: SortOrder) => void;
  setSortOption: (opt: SortOption) => void;
  toggleSelected: (id: string) => void;
  selectAll: (ids: string[]) => void;
  clearSelected: () => void;
  setSettings: (s: AppSettings) => void;
  updateSettings: (s: Partial<AppSettings>) => void;

  // Filtered & sorted entries
  getFilteredEntries: () => PasswordEntry[];
}

// 排序字段标签
export const sortFieldLabels: Record<SortField, string> = {
  updatedAt: '修改时间',
  createdAt: '创建时间',
  name: '名称',
};

// 排序方向标签
export const sortOrderLabels: Record<SortOrder, string> = {
  desc: '↓ 降序',
  asc: '↑ 升序',
};

// 组合排序选项的显示标签（兼容旧版）
export const sortOptionLabels: Record<SortOption, string> = {
  'updatedAt-desc': '修改时间 ↓',
  'updatedAt-asc': '修改时间 ↑',
  'createdAt-desc': '创建时间 ↓',
  'createdAt-asc': '创建时间 ↑',
  'name-asc': '名称 A-Z',
  'name-desc': '名称 Z-A',
};

export const searchFieldLabels: Record<SearchField, string> = {
  all: '全部',
  name: '名称',
  url: 'URL',
  username: '账号',
  tags: '标签',
};

export const useStore = create<AppState>((set, get) => ({
  isLocked: true,
  isSetup: null,
  masterPassword: '',
  triggerNewEntry: 0,
  pmSubPage: 'dashboard',
  entries: [],
  tags: [],
  trash: [],
  viewMode: 'card',
  searchQuery: '',
  searchField: 'all',
  filterEnv: 'all',
  filterTag: 'all',
  filterTags: new Set(),
  tagSidebarCollapsed: false,
  sortField: 'updatedAt',
  sortOrder: 'desc',
  sortOption: 'updatedAt-desc',
  selectedIds: new Set(),
  settings: {
    clipboardClearDelay: 30,
    passwordAutoHideDelay: 10,
    autoLockDelay: 5,
    defaultViewMode: 'card',
    defaultEnvFilter: 'all',
    theme: 'dark',
    browserPaths: {},
    keybindings: {
      newEntry: 'Ctrl+N',
      search: 'Ctrl+F',
      settings: 'Ctrl+,',
      lock: 'Ctrl+Shift+L',
      trash: 'Ctrl+Shift+T',
      import: 'Ctrl+Shift+I',
      export: 'Ctrl+Shift+E',
    },
  },

  signalNewEntry: () => set((s) => ({ triggerNewEntry: s.triggerNewEntry + 1 })),
  setPmSubPage: (page) => set({ pmSubPage: page }),
  setLocked: (locked) => set({ isLocked: locked }),
  setIsSetup: (setup) => set({ isSetup: setup }),
  setMasterPassword: (pw) => set({ masterPassword: pw }),
  setVaultData: (data) => set({ entries: data.entries, tags: data.tags }),
  setTrash: (data) => set({ trash: data }),
  setViewMode: (mode) => {
    set({ viewMode: mode });
    // Also save preference for next session
    const state = useStore.getState();
    window.electronAPI.settingsSave({ defaultViewMode: mode }).catch(() => {});
  },
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchField: (f) => set({ searchField: f }),
  setFilterEnv: (env) => set({ filterEnv: env }),
  setFilterTag: (tag) => set({ filterTag: tag }),
  setFilterTags: (tags) => set({ filterTags: tags }),
  setTagSidebarCollapsed: (v) => set({ tagSidebarCollapsed: v }),
  setSortField: (field) => set({ sortField: field }),
  setSortOrder: (order) => set({ sortOrder: order }),
  setSortOption: (opt) => set({ sortOption: opt }),
  toggleSelected: (id) => set((s) => {
    const next = new Set(s.selectedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    return { selectedIds: next };
  }),
  selectAll: (ids) => set({ selectedIds: new Set(ids) }),
  clearSelected: () => set({ selectedIds: new Set() }),
  setSettings: (s) => set((state) => ({
    settings: s,
    // Apply saved view mode preference
    viewMode: s.defaultViewMode || state.viewMode,
  })),
  updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial } })),

  getFilteredEntries: () => {
    const state = get();
    let result = [...state.entries];

    // Search with field scope
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      const field = state.searchField;
      result = result.filter(e => {
        if (field === 'all' || field === 'name') {
          if (e.name.toLowerCase().includes(q)) return true;
        }
        if (field === 'all' || field === 'url') {
          if (e.url.toLowerCase().includes(q)) return true;
        }
        if (field === 'all' || field === 'username') {
          if (e.username.toLowerCase().includes(q)) return true;
        }
        if (field === 'all' || field === 'tags') {
          if (e.tags.some(t => t.toLowerCase().includes(q))) return true;
        }
        return false;
      });
    }

    // Filter by env
    if (state.filterEnv !== 'all') {
      result = result.filter(e => e.envType === state.filterEnv);
    }

    // Filter by tag (sidebar multi-select takes priority, then dropdown)
    if (state.filterTags && state.filterTags.size > 0) {
      result = result.filter(e => {
        if (!e.tags || e.tags.length === 0) return false;
        return Array.from(state.filterTags).every(t => e.tags.includes(t));
      });
    } else if (state.filterTag !== 'all') {
      result = result.filter(e => e.tags && e.tags.includes(state.filterTag));
    }

    // Sort using field + order
    const sf: SortField = (['updatedAt', 'createdAt', 'name'].includes(state.sortField) ? state.sortField : 'updatedAt');
    const so: SortOrder = (['asc', 'desc'].includes(state.sortOrder) ? state.sortOrder : 'desc');
    result.sort((a, b) => {
      let cmp = 0;
      if (sf === 'name') cmp = a.name.localeCompare(b.name);
      else if (sf === 'updatedAt') cmp = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      else if (sf === 'createdAt') cmp = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return so === 'asc' ? -cmp : cmp;
    });

    return result;
  },
}));
