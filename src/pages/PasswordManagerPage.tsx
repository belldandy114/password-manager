import React from 'react';
import { useStore } from '../store/useStore';
import { Dashboard } from './Dashboard';
import { TrashPage } from './TrashPage';
import { ImportPage } from './ImportPage';
import { ExportPage } from './ExportPage';
import { TagSidebar } from '../components/TagSidebar';

type SubPage = 'dashboard' | 'trash' | 'import' | 'export';

const subNavItems: { key: SubPage; label: string }[] = [
  { key: 'dashboard', label: '所有网址' },
  { key: 'trash', label: '回收站' },
  { key: 'import', label: '导入数据' },
  { key: 'export', label: '导出数据' },
];

export function PasswordManagerPage() {
  const subPage = useStore(s => s.pmSubPage) as SubPage;
  const setSubPage = useStore(s => s.setPmSubPage);
  const trash = useStore(s => s.trash);

  const renderSubPage = () => {
    switch (subPage) {
      case 'dashboard': return <Dashboard />;
      case 'trash': return <TrashPage />;
      case 'import': return <ImportPage />;
      case 'export': return <ExportPage />;
    }
  };

  return (
    <div style={{
      width: '100%',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Sub-navigation tab bar */}
      <div className="pm-tab-bar">
        {subNavItems.map(item => (
          <div
            key={item.key}
            className={`pm-tab-item ${subPage === item.key ? 'active' : ''}`}
            onClick={() => setSubPage(item.key)}
          >
            {item.label}
            {item.key === 'trash' && trash.length > 0 && (
              <span className="pm-tab-badge">{trash.length}</span>
            )}
          </div>
        ))}
      </div>

      {/* Content: TagSidebar (only on dashboard) + page content */}
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'row',
        overflow: 'hidden',
      }}>
        {subPage === 'dashboard' && <TagSidebar />}
        <div className="main-content" style={{ border: 'none', flex: 1 }}>
          {renderSubPage()}
        </div>
      </div>
    </div>
  );
}
