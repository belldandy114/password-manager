import React, { useEffect, useState } from 'react';
import { prefetchPage } from '../pages/loaders';
import {
  IconFileText, IconCalendarStats, IconClipboardCheck,
  IconPencil, IconBug, IconTable, IconJson, IconTool, IconChartBar,
  IconTerminal2, IconApi, IconSettings, IconLock, IconServer, IconPhoto, IconBell, IconFolder,
  IconHome2,
} from '@tabler/icons-react';

interface Props {
  currentPage: string;
  onNavigate: (page: string) => void;
  onLock: () => void;
  /** 打开「提醒」面板（超期缺陷 / 不可达环境 / 久未备份） */
  onNotices: () => void;
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}



/* ---------- 分组折叠记忆（C14，1.30.1 补兜底） ----------
 * 用户折叠了哪个分组要跨重启保持：首屏默认全部展开（没有键 / 读到坏数据都按「全展开」），
 * 折叠后写进 localStorage，下次打开原样恢复。只存字符串布尔值，
 * 不碰 store、不碰 IPC —— 折叠纯属界面偏好。
 */
const COLLAPSED_KEY = 'pm.sidebar.collapsed';

/** 读折叠记忆：键不存在 / JSON 坏 / 不是普通对象 / 无 localStorage 一律当「全部展开」 */
function readCollapsedGroups(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // 只认 === true：历史上手改出来的 "true" 字符串之类一律当展开，宁多显示不少显示
    const out: Record<string, boolean> = {};
    for (const [title, collapsed] of Object.entries(parsed as Record<string, unknown>)) {
      if (collapsed === true) out[title] = true;
    }
    return out;
  } catch {
    return {};
  }
}

function writeCollapsedGroups(next: Record<string, boolean>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
  } catch { /* 隐私模式/配额满写不了：本次会话仍然折叠，刷新后回到全部展开 */ }
}

export function Sidebar({ currentPage, onNavigate, onLock, onNotices }: Props) {
  /** 侧栏项是 div：补按钮语义 + Enter/Space，键盘才能切页面 */
  const navKey = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
  };
  // 禅道「我的 Bug」未读数：主进程定时检查到新 Bug 时推过来，进页面即清零
  const [unread, setUnread] = useState(0);
  // C14：分组折叠（默认展开，收起的选择记在 localStorage）
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>(readCollapsedGroups);
  const toggleGroup = (title: string) => {
    setCollapsedGroups((prev) => {
      const next = { ...prev, [title]: !prev[title] };
      writeCollapsedGroups(next);
      return next;
    });
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      const r = await window.electronAPI.zentaoUnread();
      if (alive && r.success && typeof r.data === 'number') setUnread(r.data);
    })();
    const off = window.electronAPI.onZentaoUnread((n) => setUnread(Number(n) || 0));
    return () => { alive = false; off(); };
  }, []);

  // 打开禅道页就等于「看了」，红点清零
  useEffect(() => {
    if (currentPage !== 'zentao' || unread === 0) return;
    setUnread(0);
    window.electronAPI.zentaoUnreadClear().catch(() => { /* ignore */ });
  }, [currentPage, unread]);

  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <img src="./图标.png" alt="测试中台" className="sidebar-logo-icon" />
        测试中台
      </div>

      <nav className="sidebar-nav sidebar-nav-groups">
        {/* 工作台：不放进任何分组，固定在最上面 —— 它是落地页，
            收进「测试工作」组里一旦折叠就点不到了 */}
        <div
          className={`nav-item nav-item-home ${currentPage === 'home' ? 'active' : ''}`}
          role="button"
          tabIndex={0}
          aria-current={currentPage === 'home' ? 'page' : undefined}
          onClick={() => onNavigate('home')}
          onMouseEnter={() => prefetchPage('home')}
          onFocus={() => prefetchPage('home')}
          onKeyDown={navKey(() => onNavigate('home'))}
          title="工作台：缺陷待办 / 环境不可达 / 接口回归 / 备份 / 今日笔记"
        >
          {homeIcon}
          <span>工作台</span>
        </div>
        {GROUPS.map(group => (
          <div key={group.title} className={`sidebar-group${collapsedGroups[group.title] ? ' is-collapsed' : ''}`}>
            <button
              type="button"
              className="sidebar-group-title"
              onClick={() => toggleGroup(group.title)}
              aria-expanded={!collapsedGroups[group.title]}
              title={collapsedGroups[group.title] ? `展开「${group.title}」` : `收起「${group.title}」`}
            >
              <span>{group.title}</span>
              <span className="sidebar-group-chevron">{collapsedGroups[group.title] ? '▸' : '▾'}</span>
            </button>
            {!collapsedGroups[group.title] && group.items.map(item => (
              <div
                key={item.id}
                className={`nav-item ${currentPage === item.id ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                aria-current={currentPage === item.id ? 'page' : undefined}
                onClick={() => onNavigate(item.id)}
                onMouseEnter={() => prefetchPage(item.id)}
                onFocus={() => prefetchPage(item.id)}
                onKeyDown={navKey(() => onNavigate(item.id))}
                title={item.label}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.id === 'zentao' && unread > 0 && (
                  <span className="nav-dot" title={`${unread} 个新 Bug 未看`}>
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
      </nav>

      {/* System zone - bottom */}
      <div className="sidebar-system">
        <div
          className="nav-item"
          role="button"
          tabIndex={0}
          onClick={onNotices}
          onKeyDown={navKey(onNotices)}
          title="提醒：超期缺陷 / 不可达环境 / 久未备份"
        >
          {bellIcon}
          <span>提醒</span>
          {unread > 0 && <span className="nav-dot">{unread > 99 ? '99+' : unread}</span>}
        </div>
        <div
          className={`nav-item ${currentPage === 'settings' ? 'active' : ''}`}
          role="button"
          tabIndex={0}
          aria-current={currentPage === 'settings' ? 'page' : undefined}
          onClick={() => onNavigate('settings')}
          onKeyDown={navKey(() => onNavigate('settings'))}
        >
          {settingsIcon}
          <span>设置</span>
        </div>
        <div className="nav-item" role="button" tabIndex={0} onClick={onLock} onKeyDown={navKey(onLock)}>
          {lockIcon}
          <span>锁定</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- 图标（Tabler，统一 17px / 1.6 描边） ---------- */
const nav = (C: React.ComponentType<{ size?: number; stroke?: number }>) => (
  <C size={17} stroke={1.6} />
);

const pmIcon = nav(IconFileText);
const homeIcon = nav(IconHome2);
const envIcon = nav(IconServer);
const attachIcon = nav(IconPhoto);
const casesIcon = nav(IconFolder);
const reportIcon = nav(IconCalendarStats);
const checkIcon = nav(IconClipboardCheck);
const noteIcon = nav(IconPencil);
const bugIcon = nav(IconBug);
const dataGenIcon = nav(IconTable);
const jsonIcon = nav(IconJson);
const toolboxIcon = nav(IconTool);
const chartIcon = nav(IconChartBar);
const terminalIcon = nav(IconTerminal2);
const apiIcon = nav(IconApi);
const settingsIcon = nav(IconSettings);
const lockIcon = nav(IconLock);
const bellIcon = nav(IconBell);

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '密码库',
    items: [{ id: 'passwordManager', label: '网址管理', icon: pmIcon }],
  },
  {
    title: '测试工作',
    items: [
      { id: 'environments', label: '环境矩阵', icon: envIcon },
      { id: 'weeklyReport', label: '周报', icon: reportIcon },
      { id: 'notes', label: '笔记与附件', icon: noteIcon },
      { id: 'cases', label: '用例库', icon: casesIcon },
      { id: 'zentao', label: '缺陷管理', icon: bugIcon },
    ],
  },
  {
    // 原来统称「工具」，5 项挤在一起没有共同点：接口调试/压测是「对外发请求」，
    // 代码调试/造数/小工具是「自己手边的辅助」，按这个界拆开。
    title: '接口与压测',
    items: [
      { id: 'apiClient', label: '接口调试', icon: apiIcon },
      { id: 'perfTest', label: '压力测试', icon: chartIcon },
    ],
  },
  {
    title: '开发辅助',
    items: [
      { id: 'codeLab', label: '代码调试', icon: terminalIcon },
      { id: 'dataGenerator', label: '测试数据', icon: dataGenIcon },
      { id: 'toolbox', label: '工具箱', icon: toolboxIcon },
    ],
  },
];



