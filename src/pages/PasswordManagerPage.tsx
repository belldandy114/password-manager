import React from 'react';
import { useStore } from '../store/useStore';
import { Dashboard } from './Dashboard';
import { TrashPage } from './TrashPage';
import { ImportPage } from './ImportPage';
import { ExportPage } from './ExportPage';
import { TagSidebar } from '../components/TagSidebar';
import { Page, PageHead, Icons } from '../components/ui';

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
    <div className="content-area">
      <Page>
        <PageHead
          icon={<Icons.key size={16} />}
          title="网址管理"
          desc="按环境与标签整理账号密码，支持搜索、批量操作、安全体检与加密备份"
        />

        <div className="tabs">
          {subNavItems.map(item => (
            <button
              key={item.key}
              className={`tab2${subPage === item.key ? ' is-active' : ''}`}
              onClick={() => setSubPage(item.key)}
            >
              <span>{item.label}</span>
              {item.key === 'trash' && trash.length > 0 && <span className="tab-count">{trash.length}</span>}
            </button>
          ))}
        </div>

        <div className="pm-shell">
          {subPage === 'dashboard' && <TagSidebar />}
          <div className="pm-main">{renderSubPage()}</div>
        </div>
      </Page>
    </div>
  );
}
