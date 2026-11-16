import React, { useMemo, useState } from 'react';
import type { TestAccount, EntryAccount, PasswordEntry } from '../types';
import { useCollection } from '../hooks/useCollection';
import { useStore } from '../store/useStore';
import { copyPlain, copySensitive } from '../utils/clipboard';
import { pickOrphanAccounts } from '../utils/systemGroups';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from './Toast';
import { callIpc } from '../utils/ipc';

/**
 * 历史账号兜底条。
 *
 * v3 迁移把「测试账号」并进网址条目后，系统名对不上的那些没能并进去。
 * 原来的「测试账号」页被删掉了，这里保证它们**仍然看得见、复制得到**，
 * 不然就成了「数据还在库里，界面上找不到」。
 *
 * 1.25.0 起还能**手动挂到条目**：以前这些账号永远归不了位，只能复制粘贴，
 * 用户得自己进条目编辑弹窗再手打一遍账号密码。
 *
 * 没有任何历史账号时整个组件不渲染，不占地方。
 */
export function OrphanAccounts() {
  const entries = useStore(s => s.entries);
  const { items: legacy, save: saveLegacy } = useCollection<TestAccount>('accounts');
  const [open, setOpen] = useState(false);
  /** 正在挂载中的账号 id（防重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null);
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

  /**
   * 把历史账号挂到某个条目上。
   *
   * 两步都要判错，且**顺序很重要**：
   * 1. 先 `entriesUpdate` 把账号写进 `entry.accounts`（这一步失败就整体放弃，legacy 不动）；
   * 2. 再从 legacy `accounts` 集合里移除（这一步失败要**回滚第 1 步**，否则条目上多了一个
   *    账号、legacy 里还留着同一个 —— 下次解锁迁移会再并一次，出现重复账号）。
   */
  const attachTo = async (acc: TestAccount, entry: PasswordEntry) => {
    if (busyId) return;
    setBusyId(acc.id);
    const nextAccount: EntryAccount = {
      id: acc.id || `acc-${Date.now()}`,
      role: acc.role || '未填角色',
      username: acc.username || '',
      password: acc.password || '',
      note: acc.note || '',
    };
    const prevAccounts = entry.accounts || [];
    // 同 id 已存在就不重复加（幂等）
    const merged = prevAccounts.some(a => a.id === nextAccount.id)
      ? prevAccounts
      : [...prevAccounts, nextAccount];

    try {
      const upd = await callIpc(() => window.electronAPI.entriesUpdate({ ...entry, accounts: merged }));
      if (!upd.ok) {
        addToast(`挂载失败：${upd.error}`, 'error');
        return;
      }
      if (upd.data) useStore.getState().setVaultData(upd.data);

      const remaining = (legacy || []).filter(a => a.id !== acc.id);
      const saved = await callIpc(() => saveLegacy(remaining));
      if (!saved.ok) {
        // 回滚第 1 步：把刚加进去的账号摘掉，保持「要么都成、要么都不动」
        const rollback = await callIpc(() =>
          window.electronAPI.entriesUpdate({ ...entry, accounts: prevAccounts }),
        );
        if (rollback.ok && rollback.data) useStore.getState().setVaultData(rollback.data);
        addToast(
          rollback.ok
            ? `挂载失败：${saved.error}（已回滚，条目未改动）`
            : `挂载失败：${saved.error}，且回滚也失败，请手动检查条目「${entry.name}」`,
          'error',
          6000,
        );
        return;
      }
      addToast(`已把「${acc.username}」挂到「${entry.name}」`, 'success');
    } finally {
      setBusyId(null);
    }
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
        在网址管理里把条目名（或这些账号的系统名）改成一致后，它们下次解锁会自动并进对应条目；
        也可以直接在下面选一个条目手动挂上去。
      </div>
      {open && (
        <table className="tbl orphan-table">
          <thead>
            <tr>
              <th style={{ width: 200 }}>系统（旧数据）</th>
              <th style={{ width: 110 }}>角色</th>
              <th>账号</th>
              <th style={{ width: 100 }}>密码</th>
              <th style={{ width: 220 }}>挂到条目</th>
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
                <td>
                  <select
                    className="orphan-attach-select"
                    value=""
                    disabled={busyId === a.id}
                    aria-label={`把账号 ${a.username} 挂到条目`}
                    onChange={e => {
                      const id = e.target.value;
                      const target = (entries || []).find(x => x.id === id);
                      if (target) void attachTo(a, target);
                      // 受控 value="" 会自动回到占位项，不需要额外复位
                    }}
                  >
                    <option value="">{busyId === a.id ? '挂载中…' : '选择条目…'}</option>
                    {(entries || []).map(e => (
                      <option key={e.id} value={e.id}>{e.name}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
