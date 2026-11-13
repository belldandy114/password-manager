import React, { useMemo, useState } from 'react';
import type { TestAccount } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useStore } from '../store/useStore';
import { copyPlain, copySensitive } from '../utils/clipboard';
import { pickOrphanAccounts } from '../utils/systemGroups';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from './Toast';

/**
 * 历史账号兜底条。
 *
 * v3 迁移把「测试账号」并进网址条目后，系统名对不上的那些没能并进去。
 * 原来的「测试账号」页被删掉了，这里保证它们**仍然看得见、复制得到**，
 * 不然就成了「数据还在库里，界面上找不到」。
 *
 * 没有任何历史账号时整个组件不渲染，不占地方。
 */
export function OrphanAccounts() {
  const entries = useStore(s => s.entries);
  const { items: legacy } = useCollection<TestAccount>('accounts');
  const [open, setOpen] = useState(false);
  const { toasts, addToast, removeToast } = useToast();

  const orphans = useMemo(
    () => pickOrphanAccounts(entries || [], legacy || []),
    [entries, legacy],
  );

  if (orphans.length === 0) return null;

  const copyUser = async (text: string) => {
    if (!text) return;
    await copyPlain(text);
    addToast('已复制账号', 'success');
  };

  const copyPw = async (text: string) => {
    if (!text) { addToast('这个账号没有密码', 'error'); return; }
    const ok = await copySensitive(text, '密码');
    addToast(ok ? '密码已复制，30 秒后自动清空' : '复制失败', ok ? 'success' : 'error');
  };

  return (
    <div className="orphan-strip">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <div className="orphan-head">
        <span className="orphan-dot" aria-hidden="true" />
        <span>
          有 <b>{orphans.length}</b> 个账号的系统名和任何网址条目都对不上，没并进去
        </span>
        <button type="button" className="orphan-toggle" onClick={() => setOpen(v => !v)}>
          {open ? '收起' : '看看是哪几个'}
        </button>
      </div>
      <div className="orphan-hint">
        在网址管理里把条目名（或这些账号的系统名）改成一致后，它们下次解锁会自动并进对应条目。
      </div>
      {open && (
        <table className="tbl orphan-table">
          <thead>
            <tr>
              <th style={{ width: 200 }}>系统（旧数据）</th>
              <th style={{ width: 110 }}>角色</th>
              <th>账号</th>
              <th style={{ width: 100 }}>密码</th>
            </tr>
          </thead>
          <tbody>
            {orphans.map(a => (
              <tr key={a.id}>
                <td>{a.system || '未归属系统'}</td>
                <td className="text-muted">{a.role || '未填角色'}</td>
                <td className="cell-strong">
                  <button type="button" className="acc-user-link" onClick={() => void copyUser(a.username || '')} title="点击复制账号">
                    {a.username}
                  </button>
                </td>
                <td>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copyPw(a.password || '')}>
                    复制密码
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
