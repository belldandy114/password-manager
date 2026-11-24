import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PasswordEntry, EntryAccount, VaultData } from '../types';
import { useStore } from '../store/useStore';
import { Modal } from './Modal';
import { useConfirm } from './confirm';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from './Toast';
import { Icons } from './ui';
import { callIpc } from '../utils/ipc';
import { copySensitive } from '../utils/clipboard';
import { newId } from '../utils/id';

/**
 * 网址管理 →「成员账号」tab（契约 §3.2 / §8）。
 *
 * 数据只有一份：`entry.accounts`。这里的行是**派生**出来的（`entries.flatMap`），
 * 不存副本、也不建第二个集合 —— 所以卡片里的「其他角色账号」弹窗、详情抽屉、
 * 本 tab 看到的东西天然一致，不存在「两边改了要同步」的问题。
 *
 * 写入口径照 `OrphanAccounts.attachTo`：先 `entriesUpdate` 落盘（主进程整条替换 +
 * 返回整库），**成功才** `setVaultData`；失败红 toast 且本地一个字都不动。
 * 密码复制一律走 `copySensitive`（主进程定时清空 + 审计），不用 `copyPlain`。
 *
 * 样式由 C 片在 redesign.css 统一处理，这里只落语义与既有类名
 * （`.tbl` / `.btn` / `.env-badge` / `.form-group`）。
 */

export interface MemberAccountRow extends EntryAccount {
  entryId: string;
  entryName: string;
  envType: string;
}

/** 聚合：所有条目的 accounts 摊平成表格行（契约 §3.2 的 flatMap 口径） */
export function flattenMemberAccounts(entries: PasswordEntry[] | null | undefined): MemberAccountRow[] {
  if (!Array.isArray(entries)) return [];
  const out: MemberAccountRow[] = [];
  for (const e of entries) {
    for (const a of e.accounts || []) {
      out.push({ ...a, entryId: e.id, entryName: e.name, envType: e.envType });
    }
  }
  return out;
}

/** 筛选：按网址（'all' / 空 = 不过滤）+ 关键字（账号 / 角色 / 网址名，大小写不敏感） */
export function filterMemberAccounts(
  rows: MemberAccountRow[],
  opts: { entryId?: string; q?: string } = {},
): MemberAccountRow[] {
  const entryId = opts.entryId && opts.entryId !== 'all' ? opts.entryId : '';
  const q = String(opts.q ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (entryId && r.entryId !== entryId) return false;
    if (!q) return true;
    return [r.username, r.role, r.entryName].some(v => String(v || '').toLowerCase().includes(q));
  });
}

/** 默认排序：网址名（中文序）→ 角色（中文序）；纯函数，不就地改入参 */
export function sortMemberAccounts(rows: MemberAccountRow[]): MemberAccountRow[] {
  return [...rows].sort((a, b) => (
    String(a.entryName || '').localeCompare(String(b.entryName || ''), 'zh')
    || String(a.role || '').localeCompare(String(b.role || ''), 'zh')
  ));
}

/** 写入：同 id 原位替换，新 id 追加到尾部；返回新对象，不改入参 */
export function upsertAccount(entry: PasswordEntry, account: EntryAccount): PasswordEntry {
  const prev = entry.accounts || [];
  const hit = prev.some(a => a.id === account.id);
  return {
    ...entry,
    accounts: hit ? prev.map(a => (a.id === account.id ? account : a)) : [...prev, account],
  };
}

/** 删除：只摘掉匹配 id 的那个账号；返回新对象，不改入参 */
export function removeAccount(entry: PasswordEntry, accountId: string): PasswordEntry {
  return { ...entry, accounts: (entry.accounts || []).filter(a => a.id !== accountId) };
}

/** 新账号骨架：id 走 utils/id 的 newId（与编辑弹窗/孤儿挂载同一个 id 空间） */
export function emptyAccount(
  role = '', username = '', password = '', note = '',
): EntryAccount {
  return { id: newId('acc-'), role, username, password, note };
}

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
const ENV_LABEL: Record<string, string> = {
  production: '正式',
  testing: '测试',
  development: '开发',
  staging: '预发布',
};

export const MEMBER_EMPTY_HINT =
  '还没有成员账号。在任意网址的详情抽屉或卡片里的账号弹窗新增，会出现在这里';

interface Draft {
  isNew: boolean;
  entryId: string;
  account: EntryAccount;
}

export function MemberAccountsTab({
  entries, onOpenDetail,
}: {
  entries: PasswordEntry[];
  /** 点「网址」列打开详情抽屉（A 片的 EntryDetailDrawer，由宿主页渲染） */
  onOpenDetail?: (entry: PasswordEntry, trigger: HTMLElement | null) => void;
}) {
  const { toasts, addToast, removeToast } = useToast();
  const { ask, confirmNode } = useConfirm();
  const [entryId, setEntryId] = useState('all');
  const [q, setQ] = useState('');
  /** 哪些账号的密码已展示（按账号 id；没有密码的 id 不会进来） */
  const [shown, setShown] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);

  const allRows = useMemo(() => flattenMemberAccounts(entries), [entries]);
  const rows = useMemo(
    () => sortMemberAccounts(filterMemberAccounts(allRows, { entryId, q })),
    [allRows, entryId, q],
  );
  /** 筛选下拉的选项：只列真有条目的网址，按名字中文序（与行序同一口径） */
  const entryOptions = useMemo(
    () => [...entries].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh')),
    [entries],
  );

  /**
   * 唯一的写盘出口：先落盘、成功才更新界面。
   * 失败时**不动**本地状态（列数、字段、弹窗都不变），只弹错误 toast。
   */
  const persist = async (next: PasswordEntry): Promise<boolean> => {
    const res = await callIpc(() => window.electronAPI.entriesUpdate(next));
    if (!res.ok) {
      addToast(`保存失败：${res.error}`, 'error', 4000);
      return false;
    }
    if (res.data) useStore.getState().setVaultData(res.data as VaultData);
    return true;
  };

  const entryOf = (id: string) => entries.find(e => e.id === id) || null;

  const saveDraft = async () => {
    if (!draft || !draft.entryId) return;
    const entry = entryOf(draft.entryId);
    if (!entry) { addToast('所属网址已不存在，请刷新后重试', 'error'); return; }
    const ok = await persist(upsertAccount(entry, draft.account));
    if (!ok) return; // 失败：弹窗留着，用户填的内容不丢
    setDraft(null);
    addToast(draft.isNew ? '已新增成员账号' : '已更新成员账号', 'success');
  };

  const askDelete = (row: MemberAccountRow) => {
    ask({
      title: '删除成员账号',
      message: `确定从「${row.entryName}」删除${row.role || '这个'}账号「${row.username || '--'}」？只影响该网址的成员账号，不影响网址本身。`,
      confirmText: '删除',
      onOk: async () => {
        const entry = entryOf(row.entryId);
        if (!entry) { addToast('所属网址已不存在，请刷新后重试', 'error'); return; }
        const ok = await persist(removeAccount(entry, row.id));
        if (ok) addToast('已删除成员账号', 'success');
      },
    });
  };

  const copyPassword = async (row: MemberAccountRow) => {
    if (!row.password) { addToast('这个账号没有密码', 'error'); return; }
    const label = `${row.role || '账号'}-密码`;
    const ok = await copySensitive(row.password, label);
    if (ok) window.electronAPI.auditLog?.(`复制${label}`, row.entryName).catch(() => { /* 审计失败不影响复制 */ });
    addToast(ok ? '密码已复制，剪贴板稍后自动清空' : '复制失败', ok ? 'success' : 'error');
  };

  const toggleShown = (id: string) => {
    setShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const openAdd = () => setDraft({ isNew: true, entryId: '', account: emptyAccount() });
  const openEdit = (row: MemberAccountRow) => setDraft({
    isNew: false,
    entryId: row.entryId,
    account: { id: row.id, role: row.role, username: row.username, password: row.password, note: row.note },
  });

  const patchDraft = (patch: Partial<EntryAccount> | { entryId: string }) => {
    setDraft((prev) => {
      if (!prev) return prev;
      if ('entryId' in patch) return { ...prev, entryId: String(patch.entryId) };
      return { ...prev, account: { ...prev.account, ...patch } };
    });
  };

  const draftEntry = draft ? entryOf(draft.entryId) : null;

  return (
    <div className="mem-acc">
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      <div className="mem-acc-bar">
        <select
          aria-label="按网址筛选"
          value={entryId}
          onChange={e => setEntryId(e.target.value)}
        >
          <option value="all">全部网址</option>
          {entryOptions.map(e => (
            <option key={e.id} value={e.id}>{e.name}</option>
          ))}
        </select>
        <input
          type="text"
          aria-label="搜索成员账号"
          placeholder="搜索账号 / 角色 / 网址名"
          value={q}
          onChange={e => setQ(e.target.value)}
        />
        <span className="text-sm text-muted">{rows.length} / {allRows.length} 个账号</span>
        <button type="button" className="btn btn-primary btn-sm" onClick={openAdd}>
          <Icons.plus size={13} /> 新增成员账号
        </button>
      </div>

      {allRows.length === 0 ? (
        <div className="empty-state">
          <Icons.user size={40} />
          <h3>还没有成员账号</h3>
          <p>{MEMBER_EMPTY_HINT}</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="tbl-empty">没有匹配的成员账号，换个关键字或网址试试</div>
      ) : (
        <table className="tbl mem-acc-table">
          <thead>
            <tr>
              <th>网址</th>
              <th>环境</th>
              <th>角色</th>
              <th>账号</th>
              <th>密码</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const role = row.role || '未填角色';
              const visible = shown.has(row.id);
              return (
                <tr key={`${row.entryId}:${row.id}`}>
                  <td>
                    <button
                      type="button"
                      className="mem-acc-entry"
                      title={`打开「${row.entryName}」的详情抽屉`}
                      onClick={e => {
                        const entry = entryOf(row.entryId);
                        if (entry) onOpenDetail?.(entry, e.currentTarget);
                      }}
                    >{row.entryName}</button>
                  </td>
                  <td>
                    <span className={`env-badge env-${row.envType}`}>
                      {ENV_LABEL[row.envType] || row.envType}
                    </span>
                  </td>
                  <td>{role}</td>
                  <td className="cell-mono" title={row.username}>{row.username || '--'}</td>
                  <td>
                    <span className="mem-acc-pwd cell-mono">
                      {visible ? (row.password || '--') : MASK}
                    </span>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`${visible ? '隐藏' : '显示'}「${role}」的密码`}
                      onClick={() => toggleShown(row.id)}
                    >{visible ? '隐藏' : '显示'}</button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label={`复制「${role}」的密码`}
                      disabled={!row.password}
                      onClick={() => void copyPassword(row)}
                    >复制</button>
                  </td>
                  <td title={row.note}>{row.note || '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label="编辑"
                      onClick={() => openEdit(row)}
                    ><Icons.pencil size={12} /> 编辑</button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      aria-label="删除"
                      onClick={() => askDelete(row)}
                    ><Icons.trash size={12} /> 删除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.isNew ? '新增成员账号' : '编辑成员账号'}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setDraft(null)}>取消</button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!draft || !draft.entryId}
              onClick={() => void saveDraft()}
            >保存</button>
          </>
        }
      >
        {draft && (
          <>
            <div className="form-group">
              <label>所属网址 *</label>
              <EntryPicker
                options={entryOptions}
                value={draft.entryId}
                onChange={id => patchDraft({ entryId: id })}
              />
              <div className="input-hint">账号属于某一条网址；改这里等于把它挂到另一个条目上</div>
            </div>
            <div className="form-group">
              <label>角色</label>
              <input
                type="text"
                aria-label="角色"
                value={draft.account.role}
                onChange={e => patchDraft({ role: e.target.value })}
                placeholder="管理员 / 普通用户 / 只读"
              />
            </div>
            <div className="form-group">
              <label>账号</label>
              <input
                type="text"
                aria-label="账号"
                value={draft.account.username}
                onChange={e => patchDraft({ username: e.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="form-group">
              <label>密码</label>
              <input
                type="text"
                aria-label="密码"
                value={draft.account.password}
                onChange={e => patchDraft({ password: e.target.value })}
                spellCheck={false}
              />
            </div>
            <div className="form-group">
              <label>备注</label>
              <input
                type="text"
                aria-label="备注"
                value={draft.account.note || ''}
                onChange={e => patchDraft({ note: e.target.value })}
              />
            </div>
            {draft.isNew && draftEntry && (
              <div className="input-hint">将挂到「{draftEntry.name}」，用的是新 id（acc-…），不会覆盖已有账号</div>
            )}
          </>
        )}
      </Modal>

      {confirmNode}
    </div>
  );
}

/* ---------------- 可搜索的「所属网址」下拉 ----------------
   用户反馈：原生 <select> 在 85 个网址里滚着找太费劲，要能搜索。
   ⚠️ 不能用 <datalist>（AGENTS.md：Chromium 会直接崩，0xC0000005 无 JS 报错），
   所以这里自己做 combobox：输入框过滤 + 列表 + 键盘上下/回车/ESC。 */
function EntryPicker({ options, value, onChange }: {
  options: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = options.find(o => o.id === value);
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? options.filter(o => o.name.toLowerCase().includes(k)) : options;
  }, [options, q]);

  // 点外面收起（mousedown 早于 blur，避免"选了但没生效"）
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) { setOpen(false); setQ(''); }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const choose = (id: string) => { onChange(id); setOpen(false); setQ(''); };

  return (
    <div className="entry-picker" ref={wrapRef}>
      <input
        type="text"
        role="combobox"
        aria-label="所属网址"
        aria-expanded={open}
        aria-controls="entry-picker-list"
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="输入关键字搜索网址"
        /* 关掉时直接把已选名称放进 value：之前用绝对定位的 overlay 叠在输入框上，
           占位符 + overlay 两份文字会重叠（1.32.2 用户反馈） */
        value={open ? q : (selected ? selected.name : '')}
        onFocus={() => { setOpen(true); setQ(''); setActive(0); }}
        onChange={e => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, Math.max(list.length - 1, 0))); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') {
            if (open && list[active]) { e.preventDefault(); choose(list[active].id); }
          } else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setQ(''); }
        }}
      />

      {open && (
        <ul className="entry-picker-list" id="entry-picker-list" role="listbox" aria-label="网址候选">
          {list.length === 0
            ? <li className="entry-picker-empty">没有匹配的网址</li>
            : list.map((o, i) => (
              <li
                key={o.id}
                role="option"
                aria-selected={o.id === value}
                className={`entry-picker-item${i === active ? ' is-active' : ''}${o.id === value ? ' is-selected' : ''}`}
                onMouseDown={e => { e.preventDefault(); choose(o.id); }}
                onMouseEnter={() => setActive(i)}
              >{o.name}</li>
            ))}
        </ul>
      )}
    </div>
  );
}