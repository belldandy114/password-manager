import { create } from 'zustand';
import type { PasswordEntry, VaultData, ViewMode, SortField, SortOrder, AppSettings, SearchField, SortOption } from '../types';
import { fuzzyMatch } from '../utils/search';

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
  /** 「新增网址」的预填数据（快速搜索里回车新建时带过来的 URL / 名称） */
  newEntrySeed: Partial<PasswordEntry> | null;
  pmSubPage: string;
  /** 命令面板触发的跨页动作（kind + 时间戳，页面监听变化后执行） */
  cmdSignal: { kind: string; at: number } | null;
  /**
   * 「测试数据 → 接口调试」的请求体种子。
   * 放 store 而不是 URL/命令字符串：生成结果可能上千条，塞进 cmdSignal 的 kind 里
   * 既不好读也不好截断，这里直接传数组，接口调试页消费后清空。
   */
  apiBodySeed: { values: string[]; at: number } | null;
  /**
   * 「命令面板粘贴 JSON」的原文种子。
   * 和 apiBodySeed 的区别：那边是结构化数组、要重新序列化成 JSON；
   * 这里粘贴进来的本来就是一段 JSON 文本，原样填进去才对（再序列化会变成带转义的字符串）。
   */
  apiBodyText: { text: string; at: number } | null;
  /** 「命令面板粘贴 SQL」的片段草稿正文 */
  snippetSeed: { text: string; at: number } | null;
  /** 「全局搜索选中某个测试数据类型」的预选种子，测试数据页挂载后消费 */
  dataGeneratorSeed: { type: string; at: number } | null;

  // Actions
  signalNewEntry: (seed?: Partial<PasswordEntry>) => void;
  signalCmd: (kind: string) => void;
  /** 把生成的数据交给接口调试页填进请求体 */
  seedApiBody: (values: string[]) => void;
  consumeApiBodySeed: () => void;
  seedApiBodyText: (text: string) => void;
  consumeApiBodyText: () => void;
  seedSnippet: (text: string) => void;
  consumeSnippetSeed: () => void;
  seedDataGenerator: (type: string) => void;
  consumeDataGeneratorSeed: () => void;
  /** 工具箱跳转意图：命令面板/接口调试「在工具箱打开某个工具」并带初始文本 */
  toolboxIntent: { tool: string; text?: string; at: number } | null;
  openToolboxTool: (tool: string, text?: string) => void;
  consumeToolboxIntent: () => void;
  /** 跨组件请求跳页（页面内按钮跳别的页面时用；App 监听后切页并清空） */
  navigateTo: string | null;
  requestNavigate: (page: string) => void;
  consumeNavigate: () => void;
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
  newEntrySeed: null,
  cmdSignal: null,
  apiBodySeed: null,
  apiBodyText: null,
  snippetSeed: null,
  dataGeneratorSeed: null,
  toolboxIntent: null,
  navigateTo: null,
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
    accent: 'teal',
    density: 'standard',
    minimizeToTray: false,
    closeToTray: false,
    contentProtection: false,
    launchAtLogin: false,
    lastPage: 'passwordManager',
    zentaoNotify: false,
    zentaoNotifyInterval: 10,
    zentaoStaleOn: false,
    zentaoStaleDays: 3,
    envProbeInterval: 0,
    envProbeNotifyOnFlip: true,
    backupKeep: 7,
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

  signalNewEntry: (seed) => set((s) => ({
    triggerNewEntry: s.triggerNewEntry + 1,
    // 种子只在这一次触发里有效：不带参数触发（Ctrl+N）会把它清空，
    // 否则上次从快速搜索带过来的 URL 会残留在下一次新建弹窗里。
    newEntrySeed: seed || null,
  })),
  signalCmd: (kind) => set({ cmdSignal: { kind, at: Date.now() } }),
  seedApiBody: (values) => set({ apiBodySeed: { values, at: Date.now() } }),
  consumeApiBodySeed: () => set({ apiBodySeed: null }),
  seedApiBodyText: (text) => set({ apiBodyText: { text, at: Date.now() } }),
  consumeApiBodyText: () => set({ apiBodyText: null }),
  seedSnippet: (text) => set({ snippetSeed: { text, at: Date.now() } }),
  consumeSnippetSeed: () => set({ snippetSeed: null }),
  seedDataGenerator: (type) => set({ dataGeneratorSeed: { type, at: Date.now() } }),
  consumeDataGeneratorSeed: () => set({ dataGeneratorSeed: null }),
  openToolboxTool: (tool, text) => set({ toolboxIntent: { tool, text, at: Date.now() } }),
  consumeToolboxIntent: () => set({ toolboxIntent: null }),
  requestNavigate: (page) => set({ navigateTo: page }),
  consumeNavigate: () => set({ navigateTo: null }),
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

    // Search with field scope (支持拼音首字母/全拼模糊匹配)
    if (state.searchQuery) {
      const field = state.searchField;
      const q = state.searchQuery.trim();
      const hit = (v: string) => fuzzyMatch(v || '', q);
      result = result.filter(e => {
        if ((field === 'all' || field === 'name') && hit(e.name)) return true;
        if ((field === 'all' || field === 'url') && hit(e.url)) return true;
        if ((field === 'all' || field === 'username') && hit(e.username)) return true;
        if ((field === 'all' || field === 'tags') && (e.tags || []).some(t => hit(t))) return true;
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
      // 收藏条目始终置顶，不受排序方向影响
      if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
      let cmp = 0;
      if (sf === 'name') cmp = a.name.localeCompare(b.name);
      else if (sf === 'updatedAt') cmp = new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
      else if (sf === 'createdAt') cmp = new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      return so === 'asc' ? -cmp : cmp;
    });

    return result;
  },
}));
