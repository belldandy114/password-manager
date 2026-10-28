import React from 'react';

interface Props {
  currentPage: string;
  onNavigate: (page: string) => void;
  onLock: () => void;
}

interface NavItem {
  id: string;
  label: string;
  icon: React.ReactNode;
}



export function Sidebar({ currentPage, onNavigate, onLock }: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <img src="./图标.png" alt="测试工具" className="sidebar-logo-icon" />
        测试工具
      </div>

      <nav className="sidebar-nav sidebar-nav-groups">
        {GROUPS.map(group => (
          <div key={group.title} className="sidebar-group">
            <div className="sidebar-group-title">{group.title}</div>
            {group.items.map(item => (
              <div
                key={item.id}
                className={`nav-item ${currentPage === item.id ? 'active' : ''}`}
                onClick={() => onNavigate(item.id)}
                title={item.label}
              >
                {item.icon}
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        ))}
      </nav>

      {/* System zone - bottom */}
      <div className="sidebar-system">
        <div
          className={`nav-item ${currentPage === 'settings' ? 'active' : ''}`}
          onClick={() => onNavigate('settings')}
        >
          {settingsIcon}
          <span>设置</span>
        </div>
        <div className="nav-item" onClick={onLock}>
          {lockIcon}
          <span>锁定</span>
        </div>
      </div>
    </div>
  );
}

/* ---------- 图标 ---------- */
const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24' };

const pmIcon = (
  <svg {...S}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
  </svg>
);

const accountIcon = (
  <svg {...S}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
    <circle cx="12" cy="7" r="4"/>
  </svg>
);

const reportIcon = (
  <svg {...S}>
    <path d="M8 2v3M16 2v3"/>
    <rect x="3" y="5" width="18" height="16" rx="2"/>
    <path d="M3 10h18"/>
    <path d="M8 14h3M8 17h6"/>
  </svg>
);

const checkIcon = (
  <svg {...S}>
    <polyline points="9 11 12 14 22 4"/>
    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
  </svg>
);

const dbIcon = (
  <svg {...S}>
    <ellipse cx="12" cy="5" rx="8" ry="3"/>
    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5"/>
    <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6"/>
  </svg>
);

const noteIcon = (
  <svg {...S}>
    <path d="M12 20h9"/>
    <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>
  </svg>
);

const bugIcon = (
  <svg {...S}>
    <rect x="8" y="6" width="8" height="12" rx="4"/>
    <path d="M8 10H4M20 10h-4M8 14H4M20 14h-4M12 6V3M9 3h6"/>
  </svg>
);

const dataGenIcon = (
  <svg {...S}>
    <ellipse cx="12" cy="5" rx="9" ry="3"/>
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
  </svg>
);

const jsonIcon = (
  <svg {...S}>
    <path d="M14 3v4a1 1 0 0 0 1 1h4"/>
    <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/>
    <line x1="9" y1="9" x2="10" y2="9"/>
    <line x1="9" y1="13" x2="15" y2="13"/>
    <line x1="9" y1="17" x2="12" y2="17"/>
  </svg>
);

const toolboxIcon = (
  <svg {...S}>
    <path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z"/>
    <path d="M18 2l4 4"/>
  </svg>
);

const apiIcon = (
  <svg {...S}>
    <path d="M4 12h13"/>
    <polyline points="12 6 18 12 12 18"/>
    <path d="M20 5v14"/>
  </svg>
);

const settingsIcon = (
  <svg {...S}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </svg>
);

const lockIcon = (
  <svg {...S}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
  </svg>
);

const GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '密码库',
    items: [{ id: 'passwordManager', label: '网址管理', icon: pmIcon }],
  },
  {
    title: '测试工作',
    items: [
      { id: 'accounts', label: '测试账号', icon: accountIcon },
      { id: 'weeklyReport', label: '周报', icon: reportIcon },
      { id: 'snippets', label: 'SQL 片段', icon: dbIcon },
      { id: 'notes', label: '测试笔记', icon: noteIcon },
      { id: 'zentao', label: '禅道', icon: bugIcon },
    ],
  },
  {
    title: '工具',
    items: [
      { id: 'dataGenerator', label: '测试数据', icon: dataGenIcon },
      { id: 'jsonConverter', label: 'JSON 转化', icon: jsonIcon },
      { id: 'toolbox', label: '工具箱', icon: toolboxIcon },
      { id: 'apiClient', label: '接口调试', icon: apiIcon },
    ],
  },
];
