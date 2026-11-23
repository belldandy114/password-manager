// @vitest-environment jsdom
// B 片回归：成员账号 tab（docs/agents/entry-ux-next.md §3.2 / §8）
//
// 判据分两段：
//   A. 纯口径（页面把函数导出，逻辑全走它们）：聚合 / 筛选 / 排序 / 写入纯函数
//   B. 真实渲染（jsdom + 打桩 IPC）：tab 顺序、表格列、空态、筛选、增删改落盘、
//      保存失败不改本地状态、双向可见、抽屉复用且关闭态不渲染骨架、密码复制走敏感通道
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';
import { readFileSync } from 'node:fs';

import type { PasswordEntry } from '../../types';
import { useStore } from '../../store/useStore';
import {
  MemberAccountsTab,
  flattenMemberAccounts,
  filterMemberAccounts,
  sortMemberAccounts,
  upsertAccount,
  removeAccount,
  emptyAccount,
} from '../../components/MemberAccountsTab';
import { PasswordManagerPage, subNavItems } from '../../pages/PasswordManagerPage';
import { EntryCard } from '../../components/EntryCard';
import { EntryDetailDrawer } from '../../components/EntryDetailDrawer';

/* ---------------- 打桩 IPC ---------------- */

interface RecordedCall { channel: string; args: any[] }
let recorded: RecordedCall[] = [];
/** entriesUpdate 的桩：默认按入参把整条替换进库（与主进程「整条替换 + 返回整库」一致） */
let entriesUpdateImpl: (entry: PasswordEntry) => any = (entry) => ({
  success: true,
  data: { entries: BASE_ENTRIES.map(e => (e.id === entry.id ? entry : e)), tags: [] },
});

function stubElectronApi(overrides: Record<string, unknown> = {}) {
  recorded = [];
  const track = (channel: string, impl?: (...a: any[]) => any) => (...args: any[]) => {
    recorded.push({ channel, args });
    return impl ? impl(...args) : Promise.resolve({ success: true });
  };
  const base: Record<string, unknown> = {
    clipboardCopy: track('clipboardCopy'),
    auditLog: track('auditLog'),
    entriesUpdate: track('entriesUpdate', (entry: PasswordEntry) => entriesUpdateImpl(entry)),
    entriesDelete: track('entriesDelete', () => ({ success: true, data: { entries: [], tags: [] } })),
    wsGet: track('wsGet', () => ({ success: false })),
    onClipboardCleared: () => () => {},
    ...overrides,
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(base, {
    get(obj: Record<string, unknown>, prop: string) {
      if (prop in obj) return obj[prop];
      if (/^(on|off|once|remove|unsubscribe|subscribe)/i.test(prop)) return () => () => {};
      return track(prop);
    },
  });
}

const calls = (channel: string) => recorded.filter(r => r.channel === channel);

/* ---------------- 固件 ---------------- */

const entry = (over: Partial<PasswordEntry>): PasswordEntry => ({
  id: 'e', name: '条目', envType: 'testing', url: 'https://example.com',
  username: '', password: '', notes: '', tags: [],
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

const ENTRY_A = entry({
  id: 'e-a', name: '合同管理系统', envType: 'testing',
  accounts: [
    { id: 'acc-a1', role: '管理员', username: 'admin@a', password: 'Adm1n!', note: '内网' },
    { id: 'acc-a2', role: '只读', username: 'viewer@a', password: 'V13w!' },
  ],
});
const ENTRY_B = entry({
  id: 'e-b', name: '支付网关', envType: 'production',
  accounts: [{ id: 'acc-b1', role: '运营', username: 'ops@b', password: 'O75!' }],
});
const ENTRY_C = entry({ id: 'e-c', name: '没有账号的条目' });
const ENTRY_D = entry({ id: 'e-d', name: '空账号数组', accounts: [] });

const BASE_ENTRIES = [ENTRY_A, ENTRY_B, ENTRY_C, ENTRY_D];

/** 与生产一致：组件从 store 拿 entries，落盘后 setVaultData 触发同一份数据重渲染 */
function Harness({ onOpenDetail }: { onOpenDetail?: (e: PasswordEntry) => void }) {
  const entries = useStore(s => s.entries);
  return <MemberAccountsTab entries={entries} onOpenDetail={onOpenDetail} />;
}

beforeEach(() => {
  localStorage.clear();
  stubElectronApi();
  entriesUpdateImpl = (e) => ({
    success: true,
    data: { entries: BASE_ENTRIES.map(x => (x.id === e.id ? e : x)), tags: [] },
  });
  useStore.setState({
    entries: BASE_ENTRIES,
    tags: [],
    selectedIds: new Set<string>(),
    pmSubPage: 'members',
    searchQuery: '',
    viewMode: 'card',
  });
});

afterEach(() => cleanup());

const ROWS = (root: ParentNode) => [...root.querySelectorAll('.mem-acc-table tbody tr')] as HTMLElement[];
const dialog = () => document.querySelector('[role="dialog"]') as HTMLElement | null;

/* ============================ A. 纯口径 ============================ */

describe('成员账号：聚合口径只认 entry.accounts', () => {
  it('无 accounts / accounts 为空的条目不产生行；每行带 entryId / entryName / envType', () => {
    const rows = flattenMemberAccounts(BASE_ENTRIES);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.id)).toEqual(['acc-a1', 'acc-a2', 'acc-b1']);
    expect(rows[0]).toMatchObject({ entryId: 'e-a', entryName: '合同管理系统', envType: 'testing' });
    // 只读聚合：不改入参
    expect(BASE_ENTRIES[0].accounts).toHaveLength(2);
  });

  it('null / undefined / 空数组都不炸', () => {
    expect(flattenMemberAccounts([])).toEqual([]);
    expect(flattenMemberAccounts(null as unknown as PasswordEntry[])).toEqual([]);
    expect(flattenMemberAccounts(undefined as unknown as PasswordEntry[])).toEqual([]);
  });
});

describe('成员账号：筛选与排序', () => {
  const rows = () => flattenMemberAccounts(BASE_ENTRIES);

  it('按网址筛选：只剩该网址的账号；「全部」/ 空值等于不过滤', () => {
    expect(filterMemberAccounts(rows(), { entryId: 'e-b' }).map(r => r.id)).toEqual(['acc-b1']);
    expect(filterMemberAccounts(rows(), { entryId: 'all' })).toHaveLength(3);
    expect(filterMemberAccounts(rows(), {})).toHaveLength(3);
  });

  it('关键字命中账号 / 角色 / 网址名，大小写不敏感，空白等于不过滤', () => {
    expect(filterMemberAccounts(rows(), { q: 'viewer' }).map(r => r.id)).toEqual(['acc-a2']);
    expect(filterMemberAccounts(rows(), { q: '运营' }).map(r => r.id)).toEqual(['acc-b1']);
    expect(filterMemberAccounts(rows(), { q: '支付' }).map(r => r.id)).toEqual(['acc-b1']);
    expect(filterMemberAccounts(rows(), { q: 'ADMIN' }).map(r => r.id)).toEqual(['acc-a1']);
    expect(filterMemberAccounts(rows(), { q: '   ' })).toHaveLength(3);
  });

  it('网址筛选与关键字可叠加', () => {
    expect(filterMemberAccounts(rows(), { entryId: 'e-a', q: '只读' }).map(r => r.id)).toEqual(['acc-a2']);
    expect(filterMemberAccounts(rows(), { entryId: 'e-a', q: '运营' })).toEqual([]);
  });

  it('默认排序：网址名中文序 → 同网址内角色中文序；不改入参', () => {
    const input = rows();
    const snapshot = input.map(r => r.id);
    const sorted = sortMemberAccounts(input);
    // 网址名先分块（合同管理系统 在 支付网关 之前），块内再按角色中文序
    expect(sorted.map(r => r.entryName)).toEqual(['合同管理系统', '合同管理系统', '支付网关']);
    expect(sorted.map(r => r.role)).toEqual(['管理员', '只读', '运营']);
    expect(input.map(r => r.id)).toEqual(snapshot);
  });
});

describe('成员账号：写入纯函数', () => {
  it('upsertAccount 新 id 追加到尾部、同 id 原位替换；都不改入参', () => {
    const before = JSON.parse(JSON.stringify(ENTRY_A));
    const added = upsertAccount(ENTRY_A, { id: 'acc-new', role: '审计', username: 'audit@a', password: 'x' });
    expect(added.accounts).toHaveLength(3);
    expect(added.accounts![2].id).toBe('acc-new');
    expect(ENTRY_A.accounts).toHaveLength(2);

    const edited = upsertAccount(ENTRY_A, { id: 'acc-a1', role: '超级管理员', username: 'sa@a', password: 'y' });
    expect(edited.accounts![0]).toMatchObject({ id: 'acc-a1', role: '超级管理员', username: 'sa@a' });
    expect(edited.accounts![1]).toEqual({ id: 'acc-a2', role: '只读', username: 'viewer@a', password: 'V13w!' });
    expect(JSON.parse(JSON.stringify(ENTRY_A))).toEqual(before);
  });

  it('removeAccount 只删匹配 id，其它账号与入参不动', () => {
    const out = removeAccount(ENTRY_A, 'acc-a1');
    expect(out.accounts!.map(a => a.id)).toEqual(['acc-a2']);
    expect(ENTRY_A.accounts).toHaveLength(2);
  });

  it('emptyAccount 的 id 用 utils/id 的 newId（acc- 前缀）且字段可空', () => {
    const a = emptyAccount('审计', 'audit@a', 'pw', '备注');
    expect(a.id.startsWith('acc-')).toBe(true);
    expect(a.id).not.toBe(emptyAccount().id);
    expect(a).toMatchObject({ role: '审计', username: 'audit@a', password: 'pw', note: '备注' });
    expect(emptyAccount()).toMatchObject({ role: '', username: '', password: '' });
  });
});

/* ============================ B. 渲染 ============================ */

describe('顶部 tab：成员账号排在所有网址之后', () => {
  it('subNavItems 顺序与 key 都符合契约', () => {
    expect(subNavItems.map(i => i.label)).toEqual(['所有网址', '成员账号', '回收站', '导入数据', '导出数据']);
    expect(subNavItems.map(i => i.key)).toEqual(['dashboard', 'members', 'trash', 'import', 'export']);
  });

  it('切到 members 时渲染成员账号表、不渲染标签侧栏', () => {
    const { container } = render(<PasswordManagerPage />);
    expect(container.querySelector('.mem-acc-table')).toBeTruthy();
    expect(container.querySelector('.tag-sidebar')).toBeNull();
    const tabs = [...container.querySelectorAll('.tabs .tab2')].map(t => (t.textContent || '').trim());
    expect(tabs[1]).toBe('成员账号');
  });
});

describe('成员账号表：列 / 数据 / 空态', () => {
  it('列头是 网址 / 环境 / 角色 / 账号 / 密码 / 备注 / 操作，行数 = 聚合数', () => {
    const { container } = render(<Harness />);
    const heads = [...container.querySelectorAll('.mem-acc-table thead th')].map(t => (t.textContent || '').trim());
    expect(heads).toEqual(['网址', '环境', '角色', '账号', '密码', '备注', '操作']);
    expect(ROWS(container)).toHaveLength(3);
    const table = container.querySelector('.mem-acc-table') as HTMLElement;
    expect(table.textContent).toContain('合同管理系统');
    expect(table.textContent).toContain('支付网关');
    // 没有 accounts 的条目只出现在筛选下拉里，不占表格行
    expect(table.textContent).not.toContain('没有账号的条目');
  });

  it('环境列是徽标文本（正式 / 测试）', () => {
    const { container } = render(<Harness />);
    const badges = [...container.querySelectorAll('.mem-acc-table .env-badge')].map(b => b.textContent);
    expect(badges).toEqual(expect.arrayContaining(['测试', '正式']));
  });

  it('密码默认打码，点「显示」才出现明文', () => {
    const { container } = render(<Harness />);
    const row = ROWS(container).find(r => (r.textContent || '').includes('admin@a'))!;
    expect(row.querySelector('.mem-acc-pwd')!.textContent).toBe('••••••••');
    fireEvent.click(within(row).getByRole('button', { name: /显示/ }));
    expect(row.querySelector('.mem-acc-pwd')!.textContent).toBe('Adm1n!');
  });

  it('空态文案与契约逐字一致', () => {
    useStore.setState({ entries: [ENTRY_C, ENTRY_D] });
    const { container } = render(<Harness />);
    expect(container.textContent).toContain(
      '还没有成员账号。在任意网址的详情抽屉或卡片里的账号弹窗新增，会出现在这里',
    );
    expect(ROWS(container)).toHaveLength(0);
  });

  it('按网址筛选生效，「全部」恢复', () => {
    const { container } = render(<Harness />);
    const sel = container.querySelector('select[aria-label="按网址筛选"]') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'e-b' } });
    expect(ROWS(container)).toHaveLength(1);
    expect(ROWS(container)[0].textContent).toContain('ops@b');
    fireEvent.change(sel, { target: { value: 'all' } });
    expect(ROWS(container)).toHaveLength(3);
  });

  it('关键字筛选生效，且与「全部网址」一致地走账号 / 角色 / 网址名三路', () => {
    const { container } = render(<Harness />);
    const q = container.querySelector('input[aria-label="搜索成员账号"]') as HTMLInputElement;
    fireEvent.change(q, { target: { value: '支付' } });
    expect(ROWS(container)).toHaveLength(1);
    fireEvent.change(q, { target: { value: '只读' } });
    expect(ROWS(container)).toHaveLength(1);
    fireEvent.change(q, { target: { value: 'viewer@a' } });
    expect(ROWS(container)).toHaveLength(1);
    fireEvent.change(q, { target: { value: '查无此词' } });
    expect(ROWS(container)).toHaveLength(0);
  });

  it('默认按网址名 + 角色排序', () => {
    const { container } = render(<Harness />);
    const roles = ROWS(container).map(r => r.querySelectorAll('td')[2].textContent?.trim());
    expect(roles).toEqual(['管理员', '只读', '运营']);
    const names = ROWS(container).map(r => r.querySelectorAll('td')[0].textContent?.trim());
    expect(names).toEqual(['合同管理系统', '合同管理系统', '支付网关']);
  });

  it('网址列可点开详情抽屉（回调带该条 entry）', () => {
    const onOpenDetail = vi.fn();
    const { container } = render(<Harness onOpenDetail={onOpenDetail} />);
    fireEvent.click(within(ROWS(container)[0]).getByRole('button', { name: '合同管理系统' }));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    expect(onOpenDetail.mock.calls[0][0].id).toBe('e-a');
  });
});

describe('成员账号：新增 / 编辑 / 删除写回 entry.accounts', () => {
  it('新增：未选所属网址时保存禁用；选网址 + 填字段后写回该条（新 id 用 newId）', async () => {
    const { container } = render(<Harness />);
    fireEvent.click(within(container).getByRole('button', { name: '新增成员账号' }));

    const dlg = await waitFor(dialog) as HTMLElement;
    const save = within(dlg).getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true); // 所属网址必填

    fireEvent.change(within(dlg).getByLabelText('所属网址'), { target: { value: 'e-b' } });
    expect(save.disabled).toBe(false);
    fireEvent.change(within(dlg).getByLabelText('角色'), { target: { value: '审计' } });
    fireEvent.change(within(dlg).getByLabelText('账号'), { target: { value: 'audit@b' } });
    fireEvent.change(within(dlg).getByLabelText('密码'), { target: { value: 'Aud1t!' } });
    fireEvent.change(within(dlg).getByLabelText('备注'), { target: { value: '季度审计用' } });
    fireEvent.click(save);

    await waitFor(() => expect(calls('entriesUpdate').length).toBe(1));
    const sent = calls('entriesUpdate')[0].args[0] as PasswordEntry;
    expect(sent.id).toBe('e-b');
    expect(sent.accounts).toHaveLength(2);
    const created = sent.accounts![1];
    expect(created.id.startsWith('acc-')).toBe(true);
    expect(created).toMatchObject({ role: '审计', username: 'audit@b', password: 'Aud1t!', note: '季度审计用' });
    // 其它条目没被顺手改掉
    expect(sent.name).toBe('支付网关');

    await waitFor(() => expect(ROWS(container)).toHaveLength(4));
    expect(dialog()).toBeNull();
    expect(useStore.getState().entries.find(e => e.id === 'e-b')!.accounts).toHaveLength(2);
  });

  it('编辑：同 id 原位替换，其它账号字段逐一不变', async () => {
    const { container } = render(<Harness />);
    const row = ROWS(container).find(r => (r.textContent || '').includes('admin@a'))!;
    fireEvent.click(within(row).getByRole('button', { name: '编辑' }));

    const dlg = await waitFor(dialog) as HTMLElement;
    expect((within(dlg).getByLabelText('账号') as HTMLInputElement).value).toBe('admin@a');
    fireEvent.change(within(dlg).getByLabelText('角色'), { target: { value: '超级管理员' } });
    fireEvent.change(within(dlg).getByLabelText('密码'), { target: { value: 'N3wPw!' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(calls('entriesUpdate').length).toBe(1));
    const sent = calls('entriesUpdate')[0].args[0] as PasswordEntry;
    expect(sent.accounts![0]).toMatchObject({ id: 'acc-a1', role: '超级管理员', password: 'N3wPw!', username: 'admin@a' });
    expect(sent.accounts![1]).toEqual({ id: 'acc-a2', role: '只读', username: 'viewer@a', password: 'V13w!' });

    await waitFor(() => expect(container.textContent).toContain('超级管理员'));
  });

  it('删除有二次确认：取消不落盘，确认才写回', async () => {
    const { container } = render(<Harness />);
    const row = ROWS(container).find(r => (r.textContent || '').includes('viewer@a'))!;

    fireEvent.click(within(row).getByRole('button', { name: '删除' }));
    const dlg = await waitFor(dialog) as HTMLElement;
    expect(dlg.textContent).toContain('删除');
    fireEvent.click(within(dlg).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(dialog()).toBeNull());
    expect(calls('entriesUpdate').length).toBe(0);

    fireEvent.click(within(ROWS(container).find(r => (r.textContent || '').includes('viewer@a'))!)
      .getByRole('button', { name: '删除' }));
    const dlg2 = await waitFor(dialog) as HTMLElement;
    fireEvent.click(within(dlg2).getByRole('button', { name: '删除' }));

    await waitFor(() => expect(calls('entriesUpdate').length).toBe(1));
    const sent = calls('entriesUpdate')[0].args[0] as PasswordEntry;
    expect(sent.id).toBe('e-a');
    expect(sent.accounts!.map(a => a.id)).toEqual(['acc-a1']);
    await waitFor(() => expect(ROWS(container)).toHaveLength(2));
  });
});

describe('成员账号：保存失败不改本地状态', () => {
  it('entriesUpdate 返回 success:false → 界面不变 + 红 toast + entry.accounts 未被改', async () => {
    entriesUpdateImpl = () => ({ success: false, error: '未解锁' });
    const before = JSON.parse(JSON.stringify(useStore.getState().entries));

    const { container } = render(<Harness />);
    fireEvent.click(within(container).getByRole('button', { name: '新增成员账号' }));
    const dlg = await waitFor(dialog) as HTMLElement;
    fireEvent.change(within(dlg).getByLabelText('所属网址'), { target: { value: 'e-b' } });
    fireEvent.change(within(dlg).getByLabelText('角色'), { target: { value: '审计' } });
    fireEvent.change(within(dlg).getByLabelText('账号'), { target: { value: 'audit@b' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(container.querySelector('.toast.error')).toBeTruthy());
    expect(container.querySelector('.toast.error')!.textContent).toContain('保存失败');
    expect(container.querySelector('.toast.error')!.textContent).toContain('未解锁');

    // 本地状态与界面都不动
    expect(JSON.parse(JSON.stringify(useStore.getState().entries))).toEqual(before);
    expect(ROWS(container)).toHaveLength(3);
    // 弹窗不关，用户填的内容还在
    const stillOpen = dialog();
    expect(stillOpen).toBeTruthy();
    expect((within(stillOpen as HTMLElement).getByLabelText('账号') as HTMLInputElement).value).toBe('audit@b');
  });
});

describe('成员账号：与卡片账号弹窗同源（双向可见）', () => {
  it('tab 里新增的账号，卡片「+N」弹窗与详情抽屉都能看到同一条', async () => {
    const { container } = render(<Harness />);
    fireEvent.click(within(container).getByRole('button', { name: '新增成员账号' }));
    const dlg = await waitFor(dialog) as HTMLElement;
    fireEvent.change(within(dlg).getByLabelText('所属网址'), { target: { value: 'e-a' } });
    fireEvent.change(within(dlg).getByLabelText('角色'), { target: { value: '审计' } });
    fireEvent.change(within(dlg).getByLabelText('账号'), { target: { value: 'audit@a-new' } });
    fireEvent.change(within(dlg).getByLabelText('密码'), { target: { value: 'P@ss!' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(ROWS(container)).toHaveLength(4));

    // 同一份 store 数据喂给卡片与抽屉：两处必须看到同一个 account id
    const liveA = useStore.getState().entries.find(e => e.id === 'e-a')!;
    expect(liveA.accounts).toHaveLength(3);
    const addedId = liveA.accounts![2].id;

    const card = render(<EntryCard entry={liveA} onEdit={() => {}} onCopy={() => {}} />);
    const more = card.container.querySelector('.cred-more') as HTMLElement;
    expect(more.textContent).toBe('+3');
    fireEvent.click(more);
    await waitFor(() => expect(document.querySelector('.role-acc-list')).toBeTruthy());
    const cardModal = document.querySelector('.role-acc-list') as HTMLElement;
    expect(cardModal.textContent).toContain('audit@a-new');
    expect(cardModal.querySelectorAll('.role-acc-row')).toHaveLength(3);

    const drawer = render(<EntryDetailDrawer open entry={liveA} trigger={null} onClose={() => {}} />);
    expect(drawer.container.textContent).toContain('其他角色账号（3）');
    expect(drawer.container.textContent).toContain('audit@a-new');
    expect(liveA.accounts![2].id).toBe(addedId);
  });

  it('tab 里删除的账号，卡片弹窗同时消失（同一 field，不做第二份数据）', async () => {
    const { container } = render(<Harness />);
    const row = ROWS(container).find(r => (r.textContent || '').includes('viewer@a'))!;
    fireEvent.click(within(row).getByRole('button', { name: '删除' }));
    const dlg = await waitFor(dialog) as HTMLElement;
    fireEvent.click(within(dlg).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(ROWS(container)).toHaveLength(2));

    const liveA = useStore.getState().entries.find(e => e.id === 'e-a')!;
    expect(liveA.accounts!.map(a => a.id)).toEqual(['acc-a1']);

    const card = render(<EntryCard entry={liveA} onEdit={() => {}} onCopy={() => {}} />);
    expect((card.container.querySelector('.cred-more') as HTMLElement).textContent).toBe('+1');
  });
});

describe('成员账号：密码复制走敏感通道', () => {
  it('复制密码调用 clipboardCopy 且 delay>0，不直接用 navigator.clipboard.writeText', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = render(<Harness />);
    const row = ROWS(container).find(r => (r.textContent || '').includes('admin@a'))!;
    fireEvent.click(within(row).getByRole('button', { name: /复制/ }));

    await waitFor(() => expect(calls('clipboardCopy').length).toBe(1));
    const payload = calls('clipboardCopy')[0].args[0] as { text: string; delay: number };
    expect(payload.text).toBe('Adm1n!');
    expect(payload.delay).toBeGreaterThan(0);
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe('成员账号：抽屉复用 A 的组件，关闭态不渲染骨架', () => {
  it('members tab 关闭态没有 .drawer 节点；点网址列才出现', async () => {
    const { container } = render(<PasswordManagerPage />);
    // 契约的 DOM 判据：关闭态 querySelector('.drawer.entry-drawer') === null
    expect(container.querySelector('.drawer.entry-drawer')).toBeNull();
    // 更严的一条：连抽屉骨架（.drawer / .drawer-mask）都不该存在，否则玻璃扫描会把空骨架算成实心块
    expect(container.querySelector('.drawer')).toBeNull();
    expect(container.querySelector('.drawer-mask')).toBeNull();

    fireEvent.click(within(container).getByRole('button', { name: '支付网关' }));
    await waitFor(() => expect(container.querySelector('.drawer')).toBeTruthy());
    expect(container.querySelector('.drawer')!.textContent).toContain('支付网关');
    // 只传了 open/entry/trigger/onClose：不该出现编辑/删除入口（那是 Dashboard 的用法）
    expect(within(container.querySelector('.drawer') as HTMLElement).queryByRole('button', { name: '编辑' })).toBeNull();
  });
});

/* ==================================================================
   接线守卫（t9）：成员账号 tab 的挂点类名 ↔ redesign.css 规则
   ----------------------------------------------------------------
   背景：B 片（t4）交付了 DOM 但样式表不在 inScope，5 个类名一条规则都没落盘，
   「网址」列的 <button class="mem-acc-entry"> 吃浏览器默认按钮底，背景图模式下
   一块实心白牌（D1 判违规 5 行 × 2 主题）。t8 的教训是「接线类改动必须机械化」，
   所以这里把「DOM 里有这个类 ⇔ CSS 里有这条规则」钉成判据。

   注：Vitest 关掉了 CSS 处理（`?raw` 为 ''），所以用 node:fs 真读文件。
   ================================================================== */
const REDESIGN_CSS = readFileSync('src/styles/redesign.css', 'utf8');

/** 取某条规则的声明体（文本断言，不依赖 jsdom 布局） */
function cssRuleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(`${selector} → ${at}`).not.toContain('→ -1');
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('成员账号接线守卫：CSS 规则与组件挂点类名一致', () => {
  it('redesign.css 里有 .mem-acc-entry 与 data-bg 作用域的 .mem-acc-bar 两条规则，且数值符合契约', () => {
    const entry = cssRuleBody(REDESIGN_CSS, '.mem-acc-entry {');
    expect(entry).toContain('background: none');
    expect(entry).toContain('border: 0');
    expect(entry).toContain('padding: 0');
    expect(entry).toContain('cursor: pointer');
    expect(entry).toContain('var(--accent)');

    const bar = cssRuleBody(REDESIGN_CSS, "html[data-bg='image'] .mem-acc-bar {");
    expect(bar).toContain('background-color: var(--glass-side)');
    // 非背景图模式的实底不能丢（观感不退化）
    expect(cssRuleBody(REDESIGN_CSS, '.mem-acc-bar {')).toContain('var(--surface-2)');
  });

  it('渲染成员账号 tab：4 个有视觉的挂点类都在 DOM 里，且各自的 CSS 规则都存在', () => {
    const { container } = render(<Harness />);

    // 5 个类在 DOM 里（.mem-acc 是纯容器，不需要视觉规则）
    expect(container.querySelector('.mem-acc')).toBeTruthy();
    expect(container.querySelector('.mem-acc-bar')).toBeTruthy();
    expect(container.querySelector('.mem-acc-table')).toBeTruthy();
    expect(container.querySelector('.mem-acc-entry')).toBeTruthy();
    expect(container.querySelector('.mem-acc-pwd')).toBeTruthy();

    // 反向：DOM 里出现的每个 mem-acc-* 类，CSS 里必须有同名规则（漂移/漏写即红）
    const used = new Set<string>();
    container.querySelectorAll('[class]').forEach((el) => {
      String(el.className).split(/\s+/).forEach((c) => { if (c.startsWith('mem-acc')) used.add(c); });
    });
    const visual = [...used].filter(c => c !== 'mem-acc').sort();
    expect(visual).toEqual(['mem-acc-bar', 'mem-acc-entry', 'mem-acc-pwd', 'mem-acc-table']);
    for (const cls of visual) {
      expect(`${cls} → ${REDESIGN_CSS.indexOf(`.${cls}`)}`).not.toContain('→ -1');
    }
  });
});