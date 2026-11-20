import React, { useEffect, useState } from 'react';
import { Page, Icons } from '../components/ui';
import { NotesBody } from './Notes';
import { AttachmentsBody } from './Attachments';

/**
 * 「测试笔记」与「附件管理」合并成的一个菜单页（1.30.1）。
 *
 * 为什么合并：这两个页面是同一件事的两面 —— 笔记正文里贴的截图（`pm-att:` 引用）
 * 和网址条目里的附件，都要在「附件管理」里反查引用；以前分成两个侧栏项，
 * 用户找一张图要来回切。现在一个入口两个页签，页头（搜索/新建/刷新/导出）各归各的，
 * 互不干扰。
 *
 * 三个子组件的关系：
 *   NotesAttachments（本文件，外壳 + 页签）
 *     ├─ NotesBody（原 Notes 页，去掉 .content-area/Page 外壳）
 *     └─ AttachmentsBody（原 Attachments 页，同样去掉外壳）
 * 旧的独立导出 `Notes` / `Attachments` 仍在，供旧路由与直达链接使用。
 */
export type NotesScope = 'notes' | 'attachments';

const SCOPES: { id: NotesScope; label: string; icon: React.ReactNode }[] = [
  { id: 'notes', label: '测试笔记', icon: <Icons.note size={13} /> },
  { id: 'attachments', label: '附件管理', icon: <Icons.image size={13} /> },
];

/* ---------- 记住上次页签（1.30.1） ----------
 * 合并成一个侧栏入口后，主入口永远是 `initialScope="notes"`，于是用户每次回到
 * 这一页都被拽回「测试笔记」，上次看的附件列表要重新点一次。这里把用户的选择
 * 记在 localStorage，下次从主入口进来直接落到上次那个页签。
 *
 * 两条路径的优先级（顺序不能反，这就是「显式 scope 不被记忆覆盖」的落点）：
 *   1. 显式 `initialScope="attachments"`（首页「附件管理」快捷入口 / 条目里的
 *      「查看附件」/ 命令面板 / 旧路由）**永远赢** —— 用户点的就是附件管理，
 *      把他送到测试笔记就是骗人；
 *   2. 其余情况（主入口 `initialScope="notes"`）恢复记忆，没有记忆才落笔记。
 *
 * 键名沿用项目既有风格（`pm.sidebar.collapsed` / `pm.cases.scope` /
 * `pm.api.collapsedGroups`），只存一个字符串，不碰 IPC、不碰 store 数据结构。
 */
const SCOPE_KEY = 'pm.notes.scope';

function isScope(v: unknown): v is NotesScope {
  return v === 'notes' || v === 'attachments';
}

/** 读记忆：隐私模式 / 坏数据 / 历史遗留值一律当「没记过」，回落到入口给的默认页签 */
function readStoredScope(): NotesScope | null {
  try {
    const raw = localStorage.getItem(SCOPE_KEY);
    return isScope(raw) ? raw : null;
  } catch {
    return null;
  }
}

function writeStoredScope(scope: NotesScope) {
  try {
    localStorage.setItem(SCOPE_KEY, scope);
  } catch { /* 隐私模式/配额满写不了：本次会话仍然记得，下次从主入口回到默认页签 */ }
}

/** 这次进来落哪个页签：显式附件入口不接受记忆覆盖，主入口才恢复记忆 */
function resolveScope(initialScope: NotesScope): NotesScope {
  if (initialScope === 'attachments') return 'attachments';
  return readStoredScope() ?? initialScope;
}

export function NotesAttachments({ initialScope = 'notes' }: { initialScope?: NotesScope } = {}) {
  const [scope, setScope] = useState<NotesScope>(() => resolveScope(initialScope));

  // 同一个组件实例上切换入口（notes ⇄ attachments）时按同一条优先级重算，
  // 不能简单 `setScope(initialScope)` —— 那会把主入口的记忆恢复丢掉
  useEffect(() => { setScope(resolveScope(initialScope)); }, [initialScope]);

  // 页签一变就记住：用户点页签、以及显式附件入口，都算「上次看的是这个页签」
  useEffect(() => { writeStoredScope(scope); }, [scope]);

  const tabs = (
    <div className="tabs" role="tablist" aria-label="笔记与附件">
      {SCOPES.map(s => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={scope === s.id}
          className={`tab2${scope === s.id ? ' is-active' : ''}`}
          onClick={() => setScope(s.id)}
        >
          {s.icon}<span>{s.label}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="content-area">
      <Page>
        {scope === 'notes' ? <NotesBody afterHead={tabs} /> : <AttachmentsBody afterHead={tabs} />}
      </Page>
    </div>
  );
}
