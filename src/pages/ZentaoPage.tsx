import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ZentaoBug, ZentaoConfig, MyBugScope } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useZentaoStore } from '../store/zentaoStore';

/**
 * 「当前项目列表属于哪套配置」的归属标记。
 * 放模块级而不是组件 ref：页面切走会卸载，ref 每次重置成空 → 重新挂载时
 * 会把「配置已加载」误判成「换了配置」，进而清空已拉取的 Bug（1.12.x 修）。
 */
let projectsOwnerModule = '';
import { Page, PageHead, Panel, Empty, Field, Icons, Pill, SearchBox, BusyProgress, type PillTone } from '../components/ui';
import { Modal } from '../components/Modal';
import { BugDrawer } from '../components/BugDrawer';
import { bugsToText, bugsToCsv } from '../utils/bugText';
import { Pager } from '../components/Pager';
import { BugTrend } from '../components/BugTrend';
import { ZentaoSummary } from '../components/ZentaoSummary';
import { ProjectPicker } from '../components/ProjectPicker';
import { useStore } from '../store/useStore';
import { useConfirm } from '../components/confirm';
import { formatHm } from '../utils/time';

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  active: { label: '激活', tone: 'bad' },
  resolved: { label: '已解决', tone: 'ok' },
  closed: { label: '已关闭', tone: 'mute' },
  postponed: { label: '已延期', tone: 'warn' },
};

const SEVERITY: Record<string, { label: string; tone: PillTone }> = {
  '1': { label: '致命', tone: 'bad' },
  '2': { label: '严重', tone: 'warn' },
  '3': { label: '一般', tone: 'mute' },
  '4': { label: '轻微', tone: 'mute' },
};

/** 统计维度：status 字段值，或 unclosed / fixed 这类派生维度 */
const DIMS: { key: string; label: string; tone: PillTone }[] = [
  { key: 'unclosed', label: '未关闭', tone: 'warn' },
  { key: 'active', label: '激活', tone: 'bad' },
  { key: 'resolved', label: '已解决', tone: 'ok' },
  { key: 'closed', label: '已关闭', tone: 'mute' },
  { key: 'fixed', label: '已修复', tone: 'ok' },
];

const isFixed = (b: ZentaoBug) => String(b.resolution || '') === 'fixed';
const isClosed = (b: ZentaoBug) => String(b.status || '') === 'closed';
const isUnclosed = (b: ZentaoBug) => !isClosed(b);

const matchDim = (b: ZentaoBug, dim: string) => {
  if (!dim) return true;
  if (dim === 'unclosed') return isUnclosed(b);
  if (dim === 'fixed') return isFixed(b);
  return String(b.status || '') === dim;
};

const dimLabel = (dim: string) => DIMS.find(d => d.key === dim)?.label || STATUS[dim]?.label || dim;

/** 禅道 20.x 的「我的地盘」页面地址（index.php?m=my&f=bug 会 302，不能用） */
const QUICK_LINKS: { label: string; page: string }[] = [
  { label: '我的 Bug', page: 'my-work-bug.html' },
  { label: '我的任务', page: 'my-work-task.html' },
  { label: '我的需求', page: 'my-work-story.html' },
  { label: '我的测试单', page: 'my-work-testtask.html' },
  { label: '我的用例', page: 'my-work-testcase.html' },
  { label: '我的待办', page: 'my-work-todo.html' },
];

type TabId = 'mine' | 'project' | 'summary';

/** 项目 Bug 里的「全部项目」伪 id */
const ALL_PROJECT = '__all__';

/** 明细表每页条数（分页渲染，避免上万行一次性上屏） */
const PAGE_SIZES = [50, 100, 200];

/** 命令面板信号的「已处理」标记：放模块级，页面重新挂载也不会重复执行 */
let lastCmdAt = 0;

export function ZentaoPage() {
  const { items, save } = useCollection<ZentaoConfig>('integrations');
  const { ask, confirmNode } = useConfirm();
  // 多套禅道配置：items 里每条都是一套 {baseUrl, account, password}，
  // editingId 指向「当前正在看/用」的那套（新建时先是一个还不存在的 uuid）。
  const [editingId, setEditingId] = useState<string>(() => {
    try { return localStorage.getItem('pm.zentao.active') || 'zentao'; } catch { return 'zentao'; }
  });
  const cfg = useMemo(
    () => items.find(i => i.id === editingId) || items.find(i => i.id === 'zentao'),
    [items, editingId],
  );
  // 老库里没有 'zentao' 这条（或删光了）时，自动落到第一条已保存配置
  useEffect(() => {
    if (items.length === 0) return;
    if (items.some(i => i.id === editingId)) return;
    if (items.some(i => i.id === 'zentao')) return;
    setEditingId(items[0].id);
  }, [items, editingId]);

  /* ---------- store：我的 Bug ---------- */
  const bugs = useZentaoStore(s => s.bugs);
  const fetchedAt = useZentaoStore(s => s.fetchedAt);
  const project = useZentaoStore(s => s.project);
  const status = useZentaoStore(s => s.status);
  const severity = useZentaoStore(s => s.severity);
  const query = useZentaoStore(s => s.query);
  const setBugs = useZentaoStore(s => s.setBugs);
  const mineScope = useZentaoStore(s => s.mineScope);
  const setMineScope = useZentaoStore(s => s.setMineScope);
  const mineProductIds = useZentaoStore(s => s.mineProductIds);
  const mineAllProjects = useZentaoStore(s => s.mineAllProjects);
  const setMineAllProjects = useZentaoStore(s => s.setMineAllProjects);
  const resetProjectScope = useZentaoStore(s => s.resetProjectScope);
  const setMineProductIds = useZentaoStore(s => s.setMineProductIds);
  const setFilter = useZentaoStore(s => s.setFilter);

  /* ---------- store：项目 Bug ---------- */
  const projects = useZentaoStore(s => s.projects);
  const activeProject = useZentaoStore(s => s.activeProject);
  const pBugs = useZentaoStore(s => s.projectBugs);
  const pTotal = useZentaoStore(s => s.projectTotal);
  const pStatus = useZentaoStore(s => s.pStatus);
  const pSeverity = useZentaoStore(s => s.pSeverity);
  const pModule = useZentaoStore(s => s.pModule);
  const pQuery = useZentaoStore(s => s.pQuery);
  const pFetchedAt = useZentaoStore(s => s.projectFetchedAt);
  const setProjects = useZentaoStore(s => s.setProjects);
  const setActiveProject = useZentaoStore(s => s.setActiveProject);
  const setProjectBugs = useZentaoStore(s => s.setProjectBugs);
  const setPFilter = useZentaoStore(s => s.setPFilter);

  const scopeProjectIds = useZentaoStore(s => s.scopeProjectIds);
  const setScopeProjects = useZentaoStore(s => s.setScopeProjects);
  const setScopeData = useZentaoStore(s => s.setScopeData);

  const [tab, setTab] = useState<TabId>('mine');
  const [form, setForm] = useState<{ company?: string; baseUrl: string; account: string; password: string }>({ company: '', baseUrl: '', account: '', password: '' });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [projQuery, setProjQuery] = useState('');
  // Bug 详情抽屉
  const [detailBug, setDetailBug] = useState<ZentaoBug | null>(null);
  // 批量选择
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // 预设管理弹窗
  const [copiedTip, setCopiedTip] = useState('');
  // 分页（两个 tab 各记各的）
  const [pageMine, setPageMine] = useState(1);
  const [pageProj, setPageProj] = useState(1);
  const [pageSize, setPageSize] = useState(100);
  // 全量 Bug 缓存状态（命中时显示「缓存 · N 分钟前」）
  const [cacheInfo, setCacheInfo] = useState('');
  // 命令面板「刷新我的 Bug」
  const cmdSignal = useStore(s => s.cmdSignal);

  // 配置身份（地址 + 账号）一变，上一套的项目列表/已选项目全部失效：
  // 不清会报「所选项目不在项目列表里（选了 22）」——那是旧地址的项目 id。
  const cfgIdentity = `${(cfg && cfg.baseUrl) || ''}|${(cfg && cfg.account) || ''}`;

  // 数据持久化统一由 zentaoStore（IndexedDB）负责，不再往 localStorage 写大对象
  // 记住「当前项目列表属于哪套配置」：只有身份真的变了才清，
  // 否则登录成功后 baseUrl 落库导致的身份变化会把刚拉到的项目又清空。

  useEffect(() => {
    if (!cfg || !cfg.baseUrl) return;
    if (projectsOwnerModule === cfgIdentity) return;
    if (projectsOwnerModule) resetProjectScope();
    projectsOwnerModule = cfgIdentity;
  }, [cfgIdentity, resetProjectScope]);
  useEffect(() => {
    if (cfg) setForm({ company: cfg.company || '', baseUrl: cfg.baseUrl, account: cfg.account, password: cfg.password });
  }, [cfg]);

  // 记住当前用的是哪套配置（下次打开还是它，主进程的定时提醒也跟着它）
  useEffect(() => {
    try { localStorage.setItem('pm.zentao.active', editingId); } catch { /* ignore */ }
    window.electronAPI.settingsSave({ zentaoActiveId: editingId }).catch(() => { /* 配置还没落库时忽略 */ });
  }, [editingId]);

  const persist = async (next: { company?: string; baseUrl: string; account: string; password: string }) => {
    const id = editingId || 'zentao';
    const entry: ZentaoConfig = { id, ...next, updatedAt: new Date().toISOString() };
    const others = items.filter(i => i.id !== id);
    await save([...others, entry]);
    // 新建的配置第一次保存后才有 id，这里把「活跃配置」钉在它上面
    if (editingId !== id) setEditingId(id);
  };

  /** 切到另一套已保存配置 */
  const switchCfg = (id: string) => {
    setError('');
    setEditingId(id);
  };

  /** 新建一套（先只清空表单，保存/登录成功后才真正落库） */
  const addCfg = () => {
    setError('');
    setEditingId(crypto.randomUUID());
    setForm({ company: '', baseUrl: '', account: '', password: '' });
  };

  const removeCfg = () => {
    if (!cfg) return;
    const target = cfg;
    ask({
      title: '删除这套禅道配置？',
      message: `${target.baseUrl}\n${target.account}\n\n只删配置本身，已拉取的 Bug 数据不受影响。`,
      confirmText: '删除',
      danger: true,
      onOk: async () => {
        const rest = items.filter(i => i.id !== target.id);
        await save(rest);
        const nextCfg = rest[0];
        setEditingId(nextCfg ? nextCfg.id : 'zentao');
        setForm(nextCfg
          ? { company: nextCfg.company || '', baseUrl: nextCfg.baseUrl, account: nextCfg.account, password: nextCfg.password }
          : { company: '', baseUrl: '', account: '', password: '' });
      },
    });
  };

  useEffect(() => {
    if (!cmdSignal || cmdSignal.at === lastCmdAt) return;
    if (cmdSignal.kind !== 'zentao:refresh-mine') return;
    lastCmdAt = cmdSignal.at;
    if (scopeProjectIds.length) void loadScopeData(scopeProjectIds, true);
    else void loadProjects();
  }, [cmdSignal]);

  // 筛选条件变了就回到第一页
  useEffect(() => { setPageMine(1); }, [project, status, severity, query]);
  useEffect(() => { setPageProj(1); }, [activeProject, pStatus, pSeverity, pModule, pQuery]);

  // 勾选只在当前列表里有意义：切标签页 / 换视图 / 换项目都清掉。
  // 否则「我的 Bug」勾 3 条 → 切到「项目 Bug」点复制，按钮写着"复制 3"却一条都复制不出来。
  useEffect(() => {
    setSelected(new Set());
  }, [tab, mineScope, project, activeProject]);

  // 切标签页把上一条错误提示清掉，免得红条跟着串
  useEffect(() => {
    setError('');
  }, [tab]);

  const currentCfg = (): ZentaoConfig => ({
    id: editingId || 'zentao',
    baseUrl: form.baseUrl.trim(),
    account: form.account.trim(),
    password: form.password,
  }) as ZentaoConfig;

  const ready = () => {
    if (!form.baseUrl.trim()) { setError('请填写禅道地址，例如 http://zentao.example.com/zentao'); return false; }
    if (!form.account.trim() || !form.password) { setError('请填写账号和密码'); return false; }
    return true;
  };

  const login = async () => {
    setError('');
    if (!ready()) return;
    setBusy('login');
    const res = await window.electronAPI.zentaoLogin(currentCfg());
    setBusy('');
    if (res.success) {
      await persist({ company: (form.company || '').trim(), baseUrl: form.baseUrl.trim(), account: form.account.trim(), password: form.password });
      // 登录成功就把项目列表拉一遍：换配置后项目作用域会被清，落地后立刻重建，
      // 免得接着点「我提交的」时列表为空（报「请重新载入项目」/显示未选择项目）
      void loadProjects();
    } else {
      setError(res.error || '登录失败');
    }
  };

  /** 切换「指派给我 / 我提交的 / 待我验证」：直接在同一份项目数据上本地过滤，不再请求禅道 */
  const switchScope = (v: MyBugScope) => {
    if (v === mineScope) return;
    setMineScope(v);
    setFilter({ project: '', status: '', severity: '', query: '' });
    if (pBugs.length) deriveMine(pBugs, v);
    else void loadMine(v);
  };

  const SCOPE_LABEL: Record<MyBugScope, string> = {
    assigned: '指派给我',
    opened: '我提交的',
    verify: '待我验证',
  };
  const scopeLabel = SCOPE_LABEL[mineScope];
  // 「我提交的 / 待我验证」按项目拉：记住选中的项目，默认挑当前项目
  // 最近一次「我的 Bug」响应的过滤信息（服务端可能不按账号过滤，主进程会本地再过一遍）
  const [mineMeta, setMineMeta] = useState<{ account: string; filtered: boolean; dropped: number; scanned: number; withAccount: number; unknown: number } | null>(null);
  const [projOpen, setProjOpen] = useState(false);
  const [projDraft, setProjDraft] = useState<string[]>([]);

  /**
   * 确保「我的 Bug」有选中的项目：没项目列表就先拉一次；没选过就默认选中当前项目（或列表第一个）。
   * 禅道 REST 强制要 product，而且全量遍历 31 个项目要好几秒，所以不能默认全查。
   */
  const ensureMineProjects = async (): Promise<string[]> => {
    let list = projects;
    if (!list.length) {
      const r = await window.electronAPI.zentaoProjects(currentCfg());
      if (r.success && r.data) { list = r.data; setProjects(list); projectsOwnerModule = cfgIdentity; }
    }
    if (!list.length) return [];
    const valid = mineProductIds.filter(id => list.some(p => String(p.id) === String(id)));
    if (valid.length) return valid;
    // activeProject 可能是上一套地址的项目 id：不在当前列表里就不能当兜底，否则会报
    // 「所选项目不在项目列表里（选了 22）」——这正是切配置后串数据的那条路径。
    const activeValid = activeProject && list.some(x => String(x.id) === String(activeProject));
    const fallback = activeValid ? activeProject : String(list[0].id);
    setMineProductIds([fallback]);
    return [fallback];
  };

  const openProjPicker = async () => {
    const ids = await ensureMineProjects();
    setProjDraft(ids);
    setProjQuery('');
    setProjOpen(true);
  };

  const mineProjectLabel = (() => {
    if (mineAllProjects) return `全部 ${projects.length} 个项目`;
    if (!mineProductIds.length) return "未选择项目";
    if (mineProductIds.length > 1) return `${mineProductIds.length} 个项目`;
    const hit = projects.find(p => String(p.id) === String(mineProductIds[0]));
    if (!hit) return mineProductIds[0];
    return hit.programName ? `${hit.programName} / ${hit.name}` : hit.name;
  })();
  const loadMine = async (scope: MyBugScope = mineScope, idsOverride?: string[], allOverride?: boolean) => {
    setError('');
    if (!ready()) return;
    // 已有当前项目的全量数据时，三个视图都从它本地派生，避免重复拉取
    if (scopeProjectIds.length && pBugs.length && !mineAllProjects && !idsOverride && allOverride === undefined) {
      deriveMine(pBugs, scope);
      return;
    }
    setBusy('mine');
    // 「全部项目」以前只改了标签，实际还是查选中的项目 —— 这里真的用全部 id
    const useAll = allOverride === undefined ? mineAllProjects : allOverride;
    // 弹窗点「确定」时直接传入选中的 ids：那一瞬间 store 里的 mineProductIds 还是旧值
    const ids = idsOverride && idsOverride.length
      ? idsOverride
      : useAll && projects.length
        ? projects.map(p => String(p.id))
        : await ensureMineProjects();
    if (!ids.length) { setBusy(''); setError('请先选择要查询的项目'); return; }
    let res = await window.electronAPI.zentaoMyBugs(currentCfg(), scope, ids);

    // 兜底：项目列表过期（切了另一套地址/换了账号）时，服务端会说「所选项目不在项目列表里」。
    // 这时重新拉一次项目、用新列表里有效的 id 重试，而不是把错误甩给用户。
    if (!res.success && /不在项目列表里/.test(String(res.error || ''))) {
      const fresh = await window.electronAPI.zentaoProjects(currentCfg());
      if (fresh.success && fresh.data && fresh.data.length) {
        setProjects(fresh.data);
        const valid = fresh.data
          .map(p => String(p.id))
          .filter(id => ids.includes(id));
        const retryIds = valid.length ? valid : [String(fresh.data[0].id)];
        setMineProductIds(retryIds);
        res = await window.electronAPI.zentaoMyBugs(currentCfg(), scope, retryIds);
      }
    }

    setBusy('');
    if (res.success && res.data) {
      setMineMeta({
        account: res.account || form.account.trim(),
        filtered: !!res.filteredByAccount,
        dropped: Number(res.dropped) || 0,
        scanned: Number(res.scanned) || 0,
        withAccount: Number(res.withAccount) || 0,
        unknown: 0,
      });
      setBugs(res.data, res.total || res.data.length);
      await persist({ company: (form.company || '').trim(), baseUrl: form.baseUrl.trim(), account: form.account.trim(), password: form.password });
    } else {
      setError(res.error || '拉取失败');
    }
  };

  const loadProjects = async () => {
    setError('');
    if (!ready()) return;
    setBusy('projects');
    const res = await window.electronAPI.zentaoProjects(currentCfg());
    setBusy('');
    if (res.success && res.data) {
      // 把「我有 Bug 的项目」排到前面：默认选中的就是自己实际在测的那个
      const mineNames = new Set(bugs.map(b => b.productName).filter(Boolean));
      const sorted = res.data.slice().sort((a, b) => {
        const an = mineNames.has(a.name) ? 0 : 1;
        const bn = mineNames.has(b.name) ? 0 : 1;
        return an - bn;
      });
      setProjects(sorted);
      projectsOwnerModule = cfgIdentity;
      // 只拉项目列表，不自动选、不自动拉数据；由用户在上方选择后才加载
      const stillValid = scopeProjectIds.filter(id => sorted.some(p => String(p.id) === String(id)));
      if (stillValid.length !== scopeProjectIds.length) setScopeProjects(stillValid);
      await persist({ company: (form.company || '').trim(), baseUrl: form.baseUrl.trim(), account: form.account.trim(), password: form.password });
      // 「先点刷新、配置才第一次落库」时，configIdentity 会从空值变成真实地址，
      // 上面那个 effect 会误判成「换了配置」而把刚拉到的项目列表清空。
      // 这里把归属标记复位，让 effect 用新身份重新登记，而不是清数据。
      projectsOwnerModule = '';
    } else {
      setError(res.error || '拉取项目列表失败');
    }
  };

  /** 从当前项目的全量 Bug 里本地派生「我的 Bug」三个视图，零网络请求 */
  const deriveMine = (all: ZentaoBug[], scope: MyBugScope = mineScope) => {
    const acct = form.account.trim().toLowerCase();
    const fieldOf = (b: ZentaoBug) => (scope === 'opened' ? b.openedByAccount : b.assignedToAccount);
    const withAccount = all.filter(b => b.assignedToAccount || b.openedByAccount).length;
    // 部分 Bug 缺账号字段时，它们无法判定归属，会被过滤掉；单独计数并在界面显式说明
    const unknown = withAccount > 0 ? all.filter(b => !fieldOf(b)).length : 0;
    // 服务端完全没给账号字段时保留全量，但界面会明确标红「未过滤 · 含项目全量」
    const rows = withAccount === 0 ? all : all.filter(b => {
      const who = String(fieldOf(b) || '').toLowerCase();
      if (who !== acct) return false;
      const st = String(b.status || '').toLowerCase();
      if (scope === 'verify') return st === 'resolved';
      if (scope === 'assigned') return st !== 'closed';
      return true;
    });
    setBugs(rows, rows.length);
    setMineMeta({
      account: form.account.trim(), filtered: withAccount > 0,
      dropped: all.length - rows.length, scanned: all.length, withAccount, unknown,
    });
  };

  /** 一次拉取当前项目的全量 Bug，三个 tab 共享这一份数据 */
  const loadScopeData = async (productIds: string[], force = false) => {
    const ids = productIds.filter(Boolean);
    if (!ids.length || !ready()) return;
    setError('');
    setBusy('pb');
    setCacheInfo('');
    // 多项目用 summary 接口一次拿全（它内部按 id 去重、并发抓各产品，并返回模块名表）
    const res = await window.electronAPI.zentaoSummary(currentCfg(), ids, force);
    setBusy('');
    if (res.success && res.data) {
      setScopeData(res.data, res.modules || {}, ids);
      deriveMine(res.data);
      if (res.cached) {
        const min = Math.max(1, Math.round((res.ageMs || 0) / 60000));
        setCacheInfo(`缓存 · ${min} 分钟前`);
      } else if (res.fetchedAt) {
        setCacheInfo(`刚更新 · ${formatHm(res.fetchedAt)}`);
      }
      const failed = res.errors || [];
      if (failed.length) setError(`部分项目拉取失败：${failed.slice(0, 3).join('；')}`);
      await persist({ company: (form.company || '').trim(), baseUrl: form.baseUrl.trim(), account: form.account.trim(), password: form.password });
    } else {
      setError(res.error || '拉取项目缺陷失败');
    }
  };

  /** 三个 tab 共用的「按当前所选项目重新拉取最新」入口 */
  const refreshScope = () => {
    if (!scopeProjectIds.length) { void loadProjects(); return; }
    void loadScopeData(scopeProjectIds, true);
  };

  /** 全局只在这里换项目集合：清空时只清数据，选中后才拉一次 */
  const changeScopeProjects = async (ids: string[]) => {
    if (ids.length === scopeProjectIds.length && ids.every(id => scopeProjectIds.includes(id))) return;
    setScopeProjects(ids);
    setSelected(new Set());
    if (ids.length) await loadScopeData(ids, false);
  };

  const loadProjectBugs = async (productId: string, force = false) => {
    if (!productId) return;
    setError('');
    setActiveProject(productId);
    setBusy('pb');
    setCacheInfo('');
    const res = productId === ALL_PROJECT
      ? await window.electronAPI.zentaoAllBugs(currentCfg(), force)
      : await window.electronAPI.zentaoProjectBugs(currentCfg(), productId, force);
    setBusy('');
    if (res.success && res.data) {
      setProjectBugs(res.data, res.total || res.data.length);
      if (res.cached) {
        const min = Math.max(1, Math.round((res.ageMs || 0) / 60000));
        setCacheInfo(`缓存 · ${min} 分钟前`);
      } else if (res.fetchedAt) {
        setCacheInfo(`刚更新 · ${formatHm(res.fetchedAt)}`);
      }
    } else {
      setError(res.error || '拉取项目 Bug 失败');
    }
  };

  const openUrl = (path: string) => {
    const base = form.baseUrl.trim().replace(/\/+$/, '');
    if (!base) { setError('请先填写禅道地址'); return; }
    window.electronAPI.browserOpen({ browser: 'default', url: `${base}/${path.replace(/^\/+/, '')}` });
  };

  /* ---------- 我的 Bug：项目清单 ---------- */
  const myProjects = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of bugs) {
      const key = b.productName || '未分类';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [bugs]);

  const overall = useMemo(() => ({
    total: bugs.length,
    unclosed: bugs.filter(isUnclosed).length,
    active: bugs.filter(b => String(b.status) === 'active').length,
    resolved: bugs.filter(b => String(b.status) === 'resolved').length,
    closed: bugs.filter(isClosed).length,
    fixed: bugs.filter(isFixed).length,
  }), [bugs]);

  const severityCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const b of bugs) {
      const k = String(b.severity || '未知');
      map[k] = (map[k] || 0) + 1;
    }
    return map;
  }, [bugs]);

  const visibleMine = useMemo(() => {
    const q = query.trim().toLowerCase();
    return bugs.filter(b => {
      if (project && (b.productName || '未分类') !== project) return false;
      if (!matchDim(b, status)) return false;
      if (severity && String(b.severity) !== severity) return false;
      if (q && ![b.id, b.title, b.productName, b.status, b.assignedTo].some(v => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [bugs, project, status, severity, query]);

  /* ---------- 项目 Bug ---------- */
  const pStats = useMemo(() => ({
    total: pBugs.length,
    unclosed: pBugs.filter(isUnclosed).length,
    active: pBugs.filter(b => String(b.status) === 'active').length,
    resolved: pBugs.filter(b => String(b.status) === 'resolved').length,
    closed: pBugs.filter(isClosed).length,
    fixed: pBugs.filter(isFixed).length,
  }), [pBugs]);

  const pSeverityCount = useMemo(() => {
    const map: Record<string, number> = {};
    for (const b of pBugs) {
      const k = String(b.severity || '未知');
      map[k] = (map[k] || 0) + 1;
    }
    return map;
  }, [pBugs]);

  const visibleProject = useMemo(() => {
    const q = pQuery.trim().toLowerCase();
    return pBugs.filter(b => {
      if (!matchDim(b, pStatus)) return false;
      if (pSeverity && String(b.severity) !== pSeverity) return false;
      if (pModule && (b.moduleName || '未指定模块') !== pModule) return false;
      if (q && ![b.id, b.title, b.assignedTo, b.openedBy, b.status].some(v => String(v || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }, [pBugs, pStatus, pSeverity, pModule, pQuery]);

  /** 模块清单（带条数），用于「按模块筛选」下拉 */
  const pModuleList = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of pBugs) {
      const k = b.moduleName || '未指定模块';
      map.set(k, (map.get(k) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [pBugs]);

  const projName = useMemo(
    () => scopeProjectIds.length > 1
      ? `${scopeProjectIds.length} 个项目`
      : (activeProject === ALL_PROJECT ? '全部项目' : projects.find(p => String(p.id) === String(scopeProjectIds[0] || activeProject))?.name || ''),
    [projects, activeProject, scopeProjectIds],
  );

  /** 「全部项目」时按项目汇总，点一行就能跳到该项目 */
  const allProjectRows = useMemo(() => {
    const map = new Map<string, ProjRow>();
    for (const b of pBugs) {
      const name = b.productName || '未分类';
      const row = map.get(name) || { name, total: 0, unclosed: 0, active: 0, resolved: 0, closed: 0, fixed: 0, fatal: 0 };
      row.total++;
      if (isUnclosed(b)) row.unclosed++;
      if (String(b.status) === 'active') row.active++;
      if (String(b.status) === 'resolved') row.resolved++;
      if (isClosed(b)) row.closed++;
      if (isFixed(b)) row.fixed++;
      if (String(b.severity) === '1') row.fatal++;
      map.set(name, row);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [pBugs]);

  /* ---------- 分页切片 ---------- */
  const minePage = useMemo(
    () => visibleMine.slice((pageMine - 1) * pageSize, pageMine * pageSize),
    [visibleMine, pageMine, pageSize],
  );
  const projPage = useMemo(
    () => visibleProject.slice((pageProj - 1) * pageSize, pageProj * pageSize),
    [visibleProject, pageProj, pageSize],
  );

  /** 导出当前筛选结果为 CSV（不受分页限制） */
  const exportCsv = async (list: ZentaoBug[], tag: string) => {
    if (list.length === 0) { setCopiedTip('没有可导出的数据'); setTimeout(() => setCopiedTip(''), 1600); return; }
    const res = await window.electronAPI.saveText(bugsToCsv(list, form.baseUrl), `${tag}-${new Date().toISOString().slice(0, 10)}.csv`);
    if (res.success) {
      setCopiedTip(`已导出 ${list.length} 条`);
      setTimeout(() => setCopiedTip(''), 1800);
    } else if (!res.canceled) {
      setCopiedTip(res.error || '导出失败');
      setTimeout(() => setCopiedTip(''), 2400);
    }
  };

  /* ---------- 复制汇报文本 ---------- */
  const copyBugs = async (list: ZentaoBug[], format: 'list' | 'table' = 'list') => {
    // 没勾选就复制「当前筛选后的全部」，不再偷偷截断到前 50 条（以前提示写着 N 条，其实只给了 50 条）
    const picked = selected.size > 0 ? list.filter(b => selected.has(b.id)) : list;
    if (picked.length === 0) {
      setCopiedTip(selected.size > 0 ? '勾选的条目不在当前列表，已清空选择' : '没有可复制的内容');
      setTimeout(() => setCopiedTip(''), 2200);
      if (selected.size > 0) setSelected(new Set());
      return;
    }
    try {
      await navigator.clipboard.writeText(bugsToText(picked, form.baseUrl, format));
      setCopiedTip(`已复制 ${picked.length} 条`);
    } catch {
      setCopiedTip('复制失败：点一下窗口再试');
    }
    setTimeout(() => setCopiedTip(''), 1800);
    setSelected(new Set());
  };

  const toggleOne = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = (list: ZentaoBug[]) => {
    setSelected(prev => (prev.size >= list.length ? new Set() : new Set(list.map(b => b.id))));
  };

  /** 从「全部」的项目行跳到具体项目；dim 是状态维度，sev 是严重程度（两者互斥） */
  const jumpToProject = (name: string, dim?: string, sev?: string) => {
    const target = projects.find(p => p.name === name);
    setPFilter({ pStatus: dim || '', pSeverity: sev || '', pQuery: '', pModule: '' });
    if (target) loadProjectBugs(target.id);
  };

  const filteredProjects = useMemo(() => {
    const q = projQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(p =>
      String(p.name || '').toLowerCase().includes(q) ||
      String(p.programName || '').toLowerCase().includes(q) ||
      String(p.id).includes(q)
    );
  }, [projects, projQuery]);

  const hasFilter = !!(project || status || severity || query.trim());
  const hasPFilter = !!(pStatus || pSeverity || pModule || pQuery.trim());

  // 搜索把当前项目过滤掉时，<select> 没有匹配项 → 显示空白，看着像"没选项目"。
  // 把当前项目补回选项里，保证下拉始终显示真实选中的项目。
  const selectProjects = useMemo(() => {
    if (!activeProject || activeProject === ALL_PROJECT) return filteredProjects;
    if (filteredProjects.some(p => String(p.id) === String(activeProject))) return filteredProjects;
    const cur = projects.find(p => String(p.id) === String(activeProject));
    return cur ? [cur, ...filteredProjects] : filteredProjects;
  }, [filteredProjects, projects, activeProject]);

  return (
    <div className="content-area">
      <Page>
        <BusyProgress active={!!busy} label={
          busy === 'projects' ? '正在读取禅道项目列表…'
            : busy === 'pb' ? '正在拉取当前项目全部缺陷…'
              : busy === 'mine' ? '正在筛选我的 Bug…'
                : busy === 'login' ? '正在登录禅道…' : '正在处理…'
        } />
        <PageHead
          icon={<Icons.bug size={16} />}
          title="缺陷管理"
          desc="选一次项目即可：三个标签共用同一份缺陷数据，切换视图不再重复拉取；汇总按当前项目统计修复率与模块剩余"
          tools={
            <>
              <button className="btn btn-secondary btn-sm" onClick={login} disabled={busy === 'login'}>
                <Icons.lock size={13} /> {busy === 'login' ? '登录中…' : '登录并保存'}
              </button>
              {tab === 'mine' && (
                <button className="btn btn-primary btn-sm" onClick={() => loadMine()} disabled={busy === 'mine'}>
                  <Icons.refresh size={13} /> {busy === 'mine' ? '拉取中…' : `拉取「${scopeLabel}」`}
                </button>
              )}
              {tab === 'project' && (
                <>
                  {activeProject === ALL_PROJECT && (
                    <button className="btn btn-ghost btn-sm" onClick={() => loadProjectBugs(ALL_PROJECT, true)} disabled={busy === 'pb'} title="忽略缓存，重新拉全部项目">
                      <Icons.refresh size={13} /> 强制刷新
                    </button>
                  )}
                  <button className="btn btn-primary btn-sm" onClick={loadProjects} disabled={busy === 'projects'}>
                    <Icons.refresh size={13} /> {busy === 'projects' ? '读取中…' : '刷新项目列表'}
                  </button>
                </>
              )}
              {tab === 'summary' && (
                <button className="btn btn-secondary btn-sm" onClick={loadProjects} disabled={busy === 'projects'}>
                  <Icons.refresh size={13} /> {busy === 'projects' ? '读取中…' : '刷新项目列表'}
                </button>
              )}
            </>
          }
        />

        {error && (
          <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, alignSelf: 'flex-start', whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {error}
          </div>
        )}

        {/* 已配置 → 默认折叠；未配置 → 默认展开，避免用户找不到输入框 */}
        <Panel
          key={items.length > 0 ? 'cfg-yes' : 'cfg-no'}
          title="连接配置"
          meta={form.company ? form.company : form.baseUrl ? form.baseUrl.replace(/^https?:\/\//, '') : '未配置 · 点此展开填写'}
          collapsible
          defaultOpen={!(cfg && cfg.baseUrl)}
        >
          {/* 多套配置：点一下即切换「拉取哪个地址的禅道」 */}
          <div className="zt-cfg-row">
            <span className="zt-cfg-label">已保存配置</span>
            <div className="zt-cfg-list">
              {items.map(i => (
                <button
                  key={i.id}
                  className={`zt-cfg-chip${i.id === (cfg ? cfg.id : editingId) ? ' is-active' : ''}`}
                  onClick={() => switchCfg(i.id)}
                  title={`${i.baseUrl}　${i.account}`}
                >
                  <span className="zt-cfg-url">{i.company || i.baseUrl.replace(/^https?:\/\//, '') || '未填地址'}</span>
                  <span className="zt-cfg-acc">{i.account || '-'}</span>
                </button>
              ))}
              <button className="zt-cfg-chip zt-cfg-add" onClick={addCfg} title="新建一套禅道地址/账号">
                ＋ 新建
              </button>
            </div>
            {cfg && (
              <button className="btn btn-ghost btn-sm" onClick={removeCfg} title="只删配置，不动已拉取的数据">
                删除当前
              </button>
            )}
          </div>

          <div className="grid4" style={{ display: 'grid', gridTemplateColumns: '1fr 1.6fr 1fr 1fr', gap: 12 }}>
            <Field label="名称">
              <input value={form.company || ''} onChange={e => setForm({ ...form, company: e.target.value })}
                placeholder="例如 示例科技 · 测试环境" title="给这套配置起个名字，列表和标题都显示它" />
            </Field>
            <Field label="禅道地址">
              <input value={form.baseUrl} onChange={e => setForm({ ...form, baseUrl: e.target.value })}
                placeholder="http://<禅道域名或IP>:<端口>/zentao" />
            </Field>
            <Field label="账号">
              <input value={form.account} onChange={e => setForm({ ...form, account: e.target.value })} placeholder="用户名" />
            </Field>
            <Field label="密码">
              <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="密码" />
            </Field>
          </div>
          <div className="pg-sub" style={{ marginTop: 12 }}>
            地址可只填 <code>host:端口/zentao</code>，协议会自动补全。「公司 / 客户」只用于区分多套配置（显示在配置名前面）。拉取时自动登录，无需先点登录；
            「项目 Bug」走禅道 REST API（<code>api.php/v1</code>），取的是该项目下所有指派人的缺陷。
          </div>
        </Panel>

        <div className="tabs">
          <button className={`tab2${tab === 'mine' ? ' is-active' : ''}`} onClick={() => setTab('mine')}>
            <Icons.bug size={13} /><span>我的 Bug</span>
          </button>
          <button className={`tab2${tab === 'project' ? ' is-active' : ''}`} onClick={() => setTab('project')}>
            <Icons.db size={13} /><span>项目 Bug</span>
          </button>
          <button className={`tab2${tab === 'summary' ? ' is-active' : ''}`} onClick={() => setTab('summary')}>
            <Icons.chart size={13} /><span>汇总</span>
          </button>
          <div className="zt-global-scope">
            <span className="zt-global-scope-label">当前项目</span>
            <ProjectPicker
              projects={projects}
              value={scopeProjectIds}
              onChange={ids => void changeScopeProjects(ids)}
              placeholder={projects.length ? `从 ${projects.length} 个项目中选择` : '请先读取项目列表'}
              disabled={busy === 'pb' || projects.length === 0}
            />
          </div>
        </div>

        {projects.length > 0 && scopeProjectIds.length === 0 && (
          <div className="zt-scope-hint">
            <Icons.folder size={13} />
            请先从上方「当前项目」选择 1 个或多个项目，选好后才会加载下面三个标签的数据。
          </div>
        )}

        {tab === 'mine' && (
          <div className="zt-scope-row">
          <div className="zt-scope" role="tablist" aria-label="我的 Bug 视图">
            {([
              { v: 'assigned' as MyBugScope, label: '指派给我', hint: '别人指派给我、还没关闭的 Bug' },
              { v: 'opened' as MyBugScope, label: '我提交的', hint: '我创建的 Bug（含已关闭）' },
              { v: 'verify' as MyBugScope, label: '待我验证', hint: '已解决、等我验证的 Bug' },
            ]).map(s => (
              <button
                key={s.v}
                role="tab"
                aria-selected={mineScope === s.v}
                className={`zt-scope-btn${mineScope === s.v ? ' is-active' : ''}`}
                onClick={() => switchScope(s.v)}
                title={s.hint}
              >
                {s.label}
              </button>
            ))}
          </div>
            <button
              className="btn btn-secondary btn-sm zt-tab-refresh"
              onClick={refreshScope}
              disabled={busy === 'pb' || !scopeProjectIds.length}
              title="按当前项目重新从禅道拉取最新缺陷，三个标签同步更新"
            >
              <Icons.refresh size={12} /> {busy === 'pb' ? '拉取中…' : '重新拉取'}
            </button>
          </div>
        )}

        {tab === 'mine' && (
          <div className="zt-mine-proj">
            <span className="zt-mine-proj-label">项目</span>
            <Pill tone="info">{mineProjectLabel}</Pill>
            <span className="zt-mine-proj-hint">与上方「当前项目」一致，切换项目只需操作一次</span>
            {mineMeta && (() => {
              // 0 条时不报「未按账号复核」：那是「没有数据」，不是「无法复核」
              const empty = bugs.length === 0;
              const warn = !empty && !mineMeta.filtered;
              // 服务端返回了 N 条，但一条都没有当前账号 → 账号不匹配（最常见：禅道里不是这个登录名）
              const noMatch = empty && mineMeta.scanned > 0 && mineMeta.withAccount > 0;
              const text = empty
                ? `${mineMeta.account} · 0 条${mineMeta.scanned ? `（服务端 ${mineMeta.scanned} 条）` : ''}`
                : mineMeta.filtered
                  ? `${mineMeta.account}${mineMeta.dropped ? ` · 已滤掉 ${mineMeta.dropped} 条` : ''}${mineMeta.unknown ? ` · ${mineMeta.unknown} 条无账号字段` : ''}`
                  : '未过滤 · 含项目全量';
              const tip = noMatch
                ? `服务端返回 ${mineMeta.scanned} 条，但没有一条属于账号「${mineMeta.account}」。请确认登录账号是否为禅道登录名（不是姓名/邮箱）。`
                : empty
                  ? `服务端没有返回该项目的记录（账号 ${mineMeta.account}）。可能项目选错，或该项目下确实没有你的「${scopeLabel}」。`
                  : mineMeta.filtered
                    ? `服务端未按账号过滤，已本地保留 ${mineMeta.account} 的记录`
                    : `禅道未返回创建人账号字段，无法按登录账号「${mineMeta.account}」过滤；当前列表是所选项目的全部缺陷，可能包含他人数据。请确认禅道 REST 版本，或到「项目 Bug」查看全量。`;
              return (
                <span
                  className={`zt-mine-account${warn || noMatch ? ' is-warn' : ''}`}
                  title={tip}
                >
                  <Icons.key size={11} />
                  {text}
                </span>
              );
            })()}
          </div>
        )}

        {tab === 'mine' && (
          <>
            <Panel title="快捷入口" meta={`${QUICK_LINKS.length} 个`}>
              <div className="zt-quick">
                {QUICK_LINKS.map(l => (
                  <button key={l.page} className="btn btn-secondary" onClick={() => openUrl(l.page)}>
                    {l.label}
                    <Icons.extern size={12} />
                  </button>
                ))}
              </div>
            </Panel>

            {bugs.length > 0 && (
              <Panel
                title="统计（点数字筛选下方列表）"
                meta={`${scopeLabel} 共 ${bugs.length} 条${fetchedAt ? ` · ${formatHm(fetchedAt)} 拉取` : ''}`}
                tools={hasFilter ? (
                  <button className="btn btn-ghost btn-sm" onClick={() => setFilter({ project: '', status: '', severity: '', query: '' })}>清除筛选</button>
                ) : undefined}
              >
                <StatRow
                  overall={overall} severityCount={severityCount}
                  status={status} severity={severity}
                  onStatus={v => setFilter({ status: status === v ? '' : v })}
                  onSeverity={v => setFilter({ severity: severity === v ? '' : v })}
                />
                {bugs.length > 0 && <BugTrend bugs={bugs} weeks={8} />}
              </Panel>
            )}

            {bugs.length > 0 ? (
              <Panel
                title={scopeLabel}
                meta={`${visibleMine.length} / ${bugs.length} 条`}
                tools={
                  <div className="zt-actions">
                    <button className="btn btn-secondary btn-sm" onClick={() => copyBugs(visibleMine)} title="复制为汇报文本">
                      <Icons.copy size={12} /> {selected.size > 0 ? `复制 ${selected.size}` : '复制'}
                    </button>
                    <button className="btn btn-ghost btn-sm" onClick={() => exportCsv(visibleMine, scopeLabel)} title="导出为 CSV（当前筛选全部）">
                      <Icons.download size={12} /> 导出
                    </button>
                  </div>
                }
                flush
              >
                <div className="zt-filterbar">
                  <select value={project} onChange={e => setFilter({ project: e.target.value })}>
                    <option value="">全部项目</option>
                    {myProjects.map(([p, n]) => <option key={p} value={p}>{p}（{n}）</option>)}
                  </select>
                  <select value={status} onChange={e => setFilter({ status: e.target.value })}>
                    <option value="">全部状态</option>
                    {DIMS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                  </select>
                  <select value={severity} onChange={e => setFilter({ severity: e.target.value })}>
                    <option value="">全部严重程度</option>
                    {Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                  <SearchBox value={query} onChange={v => setFilter({ query: v })} placeholder="标题 / ID" />
                </div>
                <FilterBar
                  chips={[
                    project && { label: project, tone: 'info' as PillTone, clear: () => setFilter({ project: '' }) },
                    status && { label: dimLabel(status), tone: 'warn' as PillTone, clear: () => setFilter({ status: '' }) },
                    severity && { label: SEVERITY[severity]?.label || severity, tone: SEVERITY[severity]?.tone || 'mute', clear: () => setFilter({ severity: '' }) },
                    query.trim() && { label: `“${query.trim()}”`, tone: 'mute' as PillTone, clear: () => setFilter({ query: '' }) },
                  ].filter(Boolean) as { label: string; tone: PillTone; clear: () => void }[]}
                />
                {selected.size > 0 && (
                  <div className="zt-selectbar">
                    <span>已选 {selected.size} 条</span>
                    <button className="btn btn-ghost btn-sm" onClick={() => copyBugs(visibleMine, 'table')}>复制为表格</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>取消选择</button>
                  </div>
                )}
                {visibleMine.length === 0 ? (
                  <Empty icon={<Icons.bug size={22} />} title="没有符合条件的 Bug" desc="点上面的「清除筛选」看全部"
                    hint={<>也可以按 <kbd>Ctrl+K</kbd> 全局搜索，或用上方「刷新」重新拉取</>} />
                ) : (
                  <>
                    <BugTable
                      bugs={minePage}
                      onOpen={bug => setDetailBug(bug)}
                      // 「指派给我」时指派人就是自己，没必要占一列；「我提交的」最需要看派给了谁
                      showAssignee={mineScope !== 'assigned'}
                      selected={selected}
                      onToggle={toggleOne}
                      onToggleAll={() => toggleAll(minePage)}
                    />
                    <Pager
                      total={visibleMine.length}
                      page={pageMine}
                      pageSize={pageSize}
                      onPage={setPageMine}
                      onPageSize={setPageSize}
                      pageSizes={PAGE_SIZES}
                    />
                  </>
                )}
              </Panel>
            ) : (
              <Panel>
                <Empty
                  icon={<Icons.bug size={22} />}
                  title={mineMeta ? `「${scopeLabel}」下没有你的 Bug` : '还没有 Bug 数据'}
                  desc={
                    mineMeta
                      ? `已按账号 ${mineMeta.account} 过滤本项目${mineScope === 'verify' ? '（仅统计「已解决」且未关闭的 Bug）' : ''}。如果确认应该有，检查项目是否选对，或在禅道网页端核对一下状态。`
                      : `选「${scopeLabel}」后点右上角「拉取」，结果会一直保留，切换页面也不会丢`
                  }
                />
              </Panel>
            )}
          </>
        )}

        {tab === 'project' && (
          <>
            {projects.length === 0 ? (
              <Panel>
                <Empty
                  icon={<Icons.db size={22} />}
                  title="还没有项目列表"
                  desc="点右上角「刷新项目列表」，会读取禅道里你能看到的全部产品/项目"
                  action={<button className="btn btn-primary btn-sm" onClick={loadProjects}>读取项目列表</button>}
                />
              </Panel>
            ) : (
              <>
                <div className="zt-proj-status">
                  <span className="zt-proj-status-label">当前项目</span>
                  {projName && <Pill tone="info">{projName}</Pill>}
                  {pBugs.length > 0 && (
                    <span className="pg-sub" style={{ margin: 0 }}>
                      共 <strong>{pTotal || pBugs.length}</strong> 条缺陷{pFetchedAt ? ` · ${formatHm(pFetchedAt)} 拉取` : ''}{cacheInfo ? ` · ${cacheInfo}` : ''}
                    </span>
                  )}
                  <span className="pg-sub" style={{ margin: 0 }}>换项目请用上方「当前项目」，可按名称搜索定位</span>
                  <button
                    className="btn btn-secondary btn-sm zt-tab-refresh"
                    onClick={refreshScope}
                    disabled={busy === 'pb' || !scopeProjectIds.length}
                    title="按当前项目重新从禅道拉取最新缺陷，三个标签同步更新"
                  >
                    <Icons.refresh size={13} /> {busy === 'pb' ? '拉取中…' : '重新拉取'}
                  </button>
                </div>

                {pBugs.length > 0 && (
                  <Panel
                    title="项目统计（点击筛选）"
                    meta={hasPFilter ? `${visibleProject.length} / ${pBugs.length} 条` : `${pBugs.length} 条`}
                    tools={hasPFilter ? (
                      <button className="btn btn-ghost btn-sm" onClick={() => setPFilter({ pStatus: '', pSeverity: '', pModule: '', pQuery: '' })}>清除筛选</button>
                    ) : undefined}
                  >
                    <StatRow
                      overall={pStats} severityCount={pSeverityCount}
                      status={pStatus} severity={pSeverity}
                      onStatus={v => setPFilter({ pStatus: pStatus === v ? '' : v })}
                      onSeverity={v => setPFilter({ pSeverity: pSeverity === v ? '' : v })}
                    />
                    {activeProject === ALL_PROJECT && allProjectRows.length > 0 && (
                      <ProjectTable
                        rows={allProjectRows}
                        activeName=""
                        onPick={jumpToProject}
                        onPickFatal={name => jumpToProject(name, '', '1')}
                      />
                    )}
                    <div className="pg-sub" style={{ marginTop: 12 }}>
                      {activeProject === ALL_PROJECT
                        ? `这里是所有项目的全部缺陷（共 ${allProjectRows.length} 个项目），点项目行可跳到该项目。`
                        : '这里是「整个项目」的缺陷，包含所有指派人 —— 和「我的 Bug」互补。'}
                    </div>
                  </Panel>
                )}

                {pBugs.length > 0 ? (
                  <Panel
                    title={projName ? `${projName} · 全部 Bug` : '全部 Bug'}
                    meta={`${visibleProject.length} / ${pBugs.length} 条`}
                    tools={
                      <div className="zt-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => copyBugs(visibleProject)} title="复制为汇报文本">
                          <Icons.copy size={12} /> {selected.size > 0 ? `复制 ${selected.size}` : '复制'}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => exportCsv(visibleProject, projName || '项目Bug')} title="导出为 CSV（当前筛选全部）">
                          <Icons.download size={12} /> 导出
                        </button>
                      </div>
                    }
                    flush
                  >
                    <div className="zt-filterbar">
                      <select value={pStatus} onChange={e => setPFilter({ pStatus: e.target.value })}>
                        <option value="">全部状态</option>
                        {DIMS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
                      </select>
                      <select value={pSeverity} onChange={e => setPFilter({ pSeverity: e.target.value })}>
                        <option value="">全部严重程度</option>
                        {Object.entries(SEVERITY).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                      </select>
                      {pModuleList.length > 0 && (
                        <select
                          value={pModule}
                          onChange={e => setPFilter({ pModule: e.target.value })}
                          title="按模块筛选（模块名由禅道模块树解析）"
                          style={{ maxWidth: 220 }}
                        >
                          <option value="">全部模块（{pModuleList.length}）</option>
                          {pModuleList.map(([name, n]) => <option key={name} value={name}>{name}（{n}）</option>)}
                        </select>
                      )}
                      <SearchBox value={pQuery} onChange={v => setPFilter({ pQuery: v })} placeholder="标题 / 指派给" />
                    </div>
                    <FilterBar
                      chips={[
                        pStatus && { label: dimLabel(pStatus), tone: 'warn' as PillTone, clear: () => setPFilter({ pStatus: '' }) },
                        pSeverity && { label: SEVERITY[pSeverity]?.label || pSeverity, tone: SEVERITY[pSeverity]?.tone || 'mute', clear: () => setPFilter({ pSeverity: '' }) },
                        pModule && { label: `模块：${pModule}`, tone: 'info' as PillTone, clear: () => setPFilter({ pModule: '' }) },
                        pQuery.trim() && { label: `“${pQuery.trim()}”`, tone: 'mute' as PillTone, clear: () => setPFilter({ pQuery: '' }) },
                      ].filter(Boolean) as { label: string; tone: PillTone; clear: () => void }[]}
                    />
                    {selected.size > 0 && (
                      <div className="zt-selectbar">
                        <span>已选 {selected.size} 条</span>
                        <button className="btn btn-ghost btn-sm" onClick={() => copyBugs(visibleProject, 'table')}>复制为表格</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>取消选择</button>
                      </div>
                    )}
                    <BugTable
                      bugs={projPage}
                      onOpen={bug => setDetailBug(bug)}
                      showAssignee
                      showModule={activeProject !== ALL_PROJECT}
                      selected={selected}
                      onToggle={toggleOne}
                      onToggleAll={() => toggleAll(projPage)}
                    />
                    <Pager
                      total={visibleProject.length}
                      page={pageProj}
                      pageSize={pageSize}
                      onPage={setPageProj}
                      onPageSize={setPageSize}
                      pageSizes={PAGE_SIZES}
                    />
                  </Panel>
                ) : (
                  <Panel>
                    <Empty
                      icon={<Icons.bug size={22} />}
                      title={activeProject ? (busy === 'pb' ? '正在拉取…' : '这个项目下没有缺陷') : '选一个项目看全部 Bug'}
                      desc={activeProject ? '换个项目试试，或去禅道里确认该项目是否有缺陷' : '项目列表来自禅道产品，选中后会拉取该项目所有指派人下的 Bug'}
                    />
                  </Panel>
                )}
              </>
            )}
          </>
        )}

        {tab === 'summary' && (
          <ZentaoSummary
            projects={projects}
            getCfg={currentCfg}
            ready={ready}
            onError={setError}
            sharedBugs={pBugs}
            sharedModules={useZentaoStore.getState().sumModules}
            scopeProjectIds={scopeProjectIds}
            onRefresh={refreshScope}
          />
        )}
      </Page>

      {/* Bug 详情抽屉 */}
      <Modal
        open={projOpen}
        title="选择要查询的项目"
        onClose={() => setProjOpen(false)}
        footer={(
          <>
            <button className="btn btn-secondary" onClick={() => setProjDraft([])}>清空</button>
            <button className="btn btn-secondary" onClick={() => setProjDraft(filteredProjects.map(x => String(x.id)))}>全选（{filteredProjects.length}）</button>
            <button
              className="btn btn-primary"
              onClick={() => {
                if (!projDraft.length) return;
                setMineProductIds(projDraft);
                setProjOpen(false);
                void loadMine(mineScope, projDraft);
              }}
            >
              确定（查 {projDraft.length} 个）
            </button>
          </>
        )}
      >
        <div className="zt-proj-search">
          <SearchBox value={projQuery} onChange={setProjQuery} placeholder="搜索项目名或编号，例如 62" />
          <span className="zt-proj-count">
            {projQuery.trim() ? `${filteredProjects.length} / ${projects.length}` : `${projects.length} 个项目`}
          </span>
        </div>
        <div className="zt-proj-list">
          {projects.length === 0 && <div className="zt-proj-empty">还没有项目列表，请先连接禅道</div>}
          {projects.length > 0 && filteredProjects.length === 0 && (
            <div className="zt-proj-empty">没有匹配「{projQuery}」的项目</div>
          )}
          {filteredProjects.map(pr => {
            const id = String(pr.id);
            const on = projDraft.includes(id);
            return (
              <label key={id} className={`zt-proj-item${on ? ' is-on' : ''}`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => setProjDraft(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])}
                />
                <span className="zt-proj-name">
                  {pr.programName && <span className="zt-proj-program" title={`项目集：${pr.programName}`}>{pr.programName} / </span>}
                  {pr.name}
                </span>
                <span className="zt-proj-id">#{id}</span>
              </label>
            );
          })}
        </div>
      </Modal>

      <BugDrawer bug={detailBug} cfg={cfg || null} onClose={() => setDetailBug(null)} />
      {confirmNode}

      {copiedTip && <div className="toast-inline">{copiedTip}</div>}
    </div>
  );
}

/* ---------------- 子组件 ---------------- */

function StatRow({
  overall, severityCount, status, severity, onStatus, onSeverity,
}: {
  overall: Record<string, number>;
  severityCount: Record<string, number>;
  status: string;
  severity: string;
  onStatus: (key: string) => void;
  onSeverity: (key: string) => void;
}) {
  return (
    <div className="zt-cards">
      <StatCard label="全部" value={overall.total} tone="info" active={!status && !severity} onClick={() => { onStatus(''); onSeverity(''); }} />
      {DIMS.map(d => (
        <StatCard key={d.key} label={d.label} value={overall[d.key] || 0} tone={d.tone} active={status === d.key} onClick={() => onStatus(d.key)} />
      ))}
      {Object.entries(SEVERITY).map(([k, v]) => (
        <StatCard key={k} label={v.label} value={severityCount[k] || 0} tone={v.tone} active={severity === k} onClick={() => onSeverity(k)} />
      ))}
    </div>
  );
}

function StatCard({ label, value, tone, active, onClick }: { label: string; value: number; tone: PillTone; active?: boolean; onClick: () => void }) {
  return (
    <button className={`zt-card is-${tone}${active ? ' is-active' : ''}`} onClick={onClick}>
      <span className="zt-card-num">{value}</span>
      <span className="zt-card-label">{label}</span>
    </button>
  );
}

type ProjRow = { name: string; total: number; unclosed: number; active: number; resolved: number; closed: number; fixed: number; fatal: number };

function ProjectTable({ rows, activeName, onPick, onPickFatal }: {
  rows: ProjRow[];
  activeName: string;
  onPick: (name: string, dim?: string) => void;
  onPickFatal: (name: string) => void;
}) {
  return (
    <div className="zt-proj-wrap">
      <table className="tbl zt-proj">
        <thead>
          <tr>
            <th style={{ minWidth: 180 }}>项目</th>
            <th className="num">总计</th>
            {DIMS.map(d => <th key={d.key} className="num">{d.label}</th>)}
            <th className="num">致命</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.name} className={activeName === r.name ? 'is-active' : undefined}>
              <td>
                <button className="zt-proj-name" onClick={() => onPick(r.name)} title={r.name}>{r.name}</button>
              </td>
              <td className="cell-num">
                <button className="zt-num" onClick={() => onPick(r.name, '')}>{r.total}</button>
              </td>
              {DIMS.map(d => (
                <td key={d.key} className="cell-num">
                  <button className={`zt-num${r[d.key as keyof ProjRow] ? '' : ' zero'}`} onClick={() => onPick(r.name, d.key)}>
                    {r[d.key as keyof ProjRow]}
                  </button>
                </td>
              ))}
              <td className="cell-num">
                <button className={`zt-num${r.fatal ? ' danger' : ' zero'}`} onClick={() => onPickFatal(r.name)}>{r.fatal}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FilterBar({ chips }: { chips: { label: string; tone: PillTone; clear: () => void }[] }) {
  if (chips.length === 0) return null;
  return (
    <div className="zt-active-filter">
      <span>当前筛选：</span>
      {chips.map((c, i) => (
        <span key={i} className={`pill pill-${c.tone}`}>
          {c.label}
          <button onClick={c.clear}><Icons.close size={11} /></button>
        </span>
      ))}
    </div>
  );
}

function BugTable({
  bugs, onOpen, showAssignee, showModule, selected, onToggle, onToggleAll,
}: {
  bugs: ZentaoBug[];
  onOpen: (bug: ZentaoBug) => void;
  showAssignee: boolean;
  showModule?: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}) {
  const allChecked = bugs.length > 0 && bugs.every(b => selected.has(b.id));
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th style={{ width: 34 }}>
            <input type="checkbox" className="tbl-check" checked={allChecked} onChange={onToggleAll} aria-label="全选" />
          </th>
          <th style={{ width: 78 }}>ID</th>
          <th>标题</th>
          <th style={{ width: 96 }}>状态</th>
          <th style={{ width: 92 }}>严重程度</th>
          {showModule && <th style={{ width: 170 }}>模块</th>}
          {showAssignee && <th style={{ width: 96 }}>指派给</th>}
          <th style={{ width: 70 }}>优先级</th>
          <th style={{ width: 170 }}>项目</th>
          <th style={{ width: 108 }}>创建日期</th>
        </tr>
      </thead>
      <tbody>
        {bugs.map(b => {
          const st = STATUS[b.status || ''];
          const sev = SEVERITY[String(b.severity)];
          return (
            <tr key={b.id} className={`zt-row${selected.has(b.id) ? ' is-selected' : ''}`} onClick={() => onOpen(b)} title="查看详情">
              <td onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  className="tbl-check"
                  checked={selected.has(b.id)}
                  onChange={() => onToggle(b.id)}
                  aria-label={`选择 #${b.id}`}
                />
              </td>
              <td className="cell-mono">#{b.id}</td>
              <td className="cell-strong" style={{ maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.title}>
                {isFixed(b) && <span className="zt-fixed" title="解决方案：已修复">已修复</span>}
                {b.title}
              </td>
              <td><Pill tone={st?.tone || 'mute'} dot>{st?.label || b.status || '—'}</Pill></td>
              <td>{sev ? <Pill tone={sev.tone}>{sev.label}</Pill> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
              {showModule && (
                <td
                  style={{ color: 'var(--text-muted)', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={b.moduleName || ''}
                >
                  {b.moduleName || '—'}
                </td>
              )}
              {showAssignee && <td style={{ color: 'var(--text-muted)' }}>{b.assignedTo || '—'}</td>}
              <td className="cell-num">{b.pri || '—'}</td>
              <td style={{ color: 'var(--text-muted)', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.productName}>
                {b.productName || '—'}
              </td>
              {/* 之前写成 date || deadline，没创建日期时会显示截止日期，列名对不上 */}
              <td className="cell-num" style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{b.date || '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}