import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import { Dashboard } from './Dashboard';
import { TrashPage } from './TrashPage';
import { ImportPage } from './ImportPage';
import { ExportPage } from './ExportPage';
import { TagSidebar } from '../components/TagSidebar';
import { MemberAccountsTab } from '../components/MemberAccountsTab';
import { EntryDetailDrawer } from '../components/EntryDetailDrawer';
import { Page, PageHead, Icons } from '../components/ui';
import { SecurityAudit } from '../components/SecurityAudit';

type SubPage = 'dashboard' | 'members' | 'trash' | 'import' | 'export';

/**
 * 顶部 tab：契约 §3.2 的顺序「所有网址 → 成员账号 → 回收站 → 导入数据 → 导出数据」。
 * 导出给单测断言顺序用（改动这里就等于改 UI，不该悄悄改）。
 */
export const subNavItems: { key: SubPage; label: string }[] = [
  { key: 'dashboard', label: '所有网址' },
  { key: 'members', label: '成员账号' },
  { key: 'trash', label: '回收站' },
  { key: 'import', label: '导入数据' },
  { key: 'export', label: '导出数据' },
];

export function PasswordManagerPage() {
  const subPage = useStore(s => s.pmSubPage) as SubPage;
  const setSubPage = useStore(s => s.setPmSubPage);
  const trash = useStore(s => s.trash);
  const entries = useStore(s => s.entries);
  const setSearchQuery = useStore(s => s.setSearchQuery);
  const [auditOpen, setAuditOpen] = useState(false);
  /**
   * 「成员账号」tab 的详情抽屉实例。
   * 为什么不放 store：抽屉是页面级 UI 状态，进 store 会让「切 tab 是否保留抽屉」变成全局行为。
   * Dashboard 自己有一份（卡片视图用），两个 tab 不会同时挂载，各持有各的即可。
   */
  const [detail, setDetail] = useState<{ entryId: string; trigger: HTMLElement | null } | null>(null);
  const detailEntry = detail ? (entries.find(e => e.id === detail.entryId) || null) : null;

  const renderSubPage = () => {
    switch (subPage) {
      case 'dashboard': return <Dashboard />;
      case 'members': return (
        <MemberAccountsTab
          entries={entries}
          onOpenDetail={(entry, trigger) => setDetail({ entryId: entry.id, trigger })}
        />
      );
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
          tools={
            <button className="btn btn-secondary btn-sm" onClick={() => setAuditOpen(true)}>
              <Icons.check size={13} /> 安全体检
            </button>
          }
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

      <SecurityAudit
        open={auditOpen}
        onClose={() => setAuditOpen(false)}
        onPick={name => { setSubPage('dashboard'); setSearchQuery(name); }}
      />

      {/* 成员账号 tab 的详情抽屉：只读展示（只传 open/entry/trigger/onClose）。
          A 片的 EntryDetailDrawer 在 open=false / entry 为空时返回 null，
          所以关闭态**不会**留下 .drawer 骨架（玻璃扫描不会把它算成实心块）。 */}
      <EntryDetailDrawer
        open={subPage === 'members' && !!detailEntry}
        entry={detailEntry}
        trigger={detail?.trigger ?? null}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}
