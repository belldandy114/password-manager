// @vitest-environment jsdom
// A 片回归：卡片详情抽屉 + 勾选框多选（docs/agents/entry-ux-next.md §3.1 / §7.3）
//
// 三组判据：
//   A. 卡片：勾选框是**唯一**改 selectedIds 的卡片内元素；点主体 / Enter / Space 开抽屉
//   B. 抽屉：字段齐全、密码默认打码、复制密码走敏感通道、三条关闭路径、焦点归还、TOTP 有才显示
//   C. Dashboard 接线：点卡片出抽屉、勾选不开抽屉且批量条与批量删除仍可用
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react';
import React, { useState } from 'react';
import { readFileSync } from 'node:fs';

import type { PasswordEntry } from '../../types';
import { useStore } from '../../store/useStore';
import { EntryCard } from '../../components/EntryCard';
import { EntryDetailDrawer } from '../../components/EntryDetailDrawer';
import { Dashboard } from '../../pages/Dashboard';
import { formatDateTime } from '../../utils/time';

/* ---------------- 打桩 IPC ---------------- */

interface RecordedCall { channel: string; args: any[] }
let recorded: RecordedCall[] = [];

/**
 * 只实现本片真正用到的通道，其余落到 failIpc：
 * 抽屉/卡片的代码必须能容忍「拿到 success:false」而不炸。
 */
function stubElectronApi(overrides: Record<string, unknown> = {}) {
  recorded = [];
  const track = (channel: string, impl?: (...a: any[]) => any) => (...args: any[]) => {
    recorded.push({ channel, args });
    return impl ? impl(...args) : Promise.resolve({ success: true });
  };
  const base: Record<string, unknown> = {
    clipboardCopy: track('clipboardCopy'),
    auditLog: track('auditLog'),
    totpCode: track('totpCode', () => ({ success: true, data: { code: '123456', remain: 17 } })),
    entriesGetAll: track('entriesGetAll', () => ({ success: true, data: { entries: [], tags: [] } })),
    entriesDelete: track('entriesDelete', () => ({ success: true, data: { entries: [], tags: [] } })),
    entriesUpdate: track('entriesUpdate', () => ({ success: true, data: { entries: [], tags: [] } })),
    pinOpen: track('pinOpen'),
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

const ENTRY: PasswordEntry = {
  id: 'e-1',
  name: '生产后台',
  envType: 'production',
  url: 'https://admin.example.com',
  username: 'admin@example.com',
  password: 'S3cret!pw',
  notes: '只读账号，别改数据',
  tags: ['生产', '后台'],
  createdAt: '2026-11-19T02:05:00.000Z',
  updatedAt: '2026-11-20T03:10:00.000Z',
  attachments: [
    { id: 'a1', name: '证书.pfx', size: 100, kind: 'entry', createdAt: '2026-11-19T00:00:00.000Z' } as any,
  ],
  accounts: [
    { id: 'acc-1', role: '管理员', username: 'root@example.com', password: 'RootPw!', note: '仅内网' },
    { id: 'acc-2', role: '只读', username: 'viewer@example.com', password: 'ViewPw!', note: '' },
  ],
};

const storeSnapshot = () => {
  const s = useStore.getState();
  return {
    searchQuery: s.searchQuery,
    searchField: s.searchField,
    filterEnv: s.filterEnv,
    filterTag: s.filterTag,
    sortField: s.sortField,
    sortOrder: s.sortOrder,
    viewMode: s.viewMode,
    entries: JSON.parse(JSON.stringify(s.entries)),
    selectedIds: [...s.selectedIds].sort(),
  };
};

beforeEach(() => {
  localStorage.clear();
  localStorage.clear();
  stubElectronApi();
  useStore.setState({
    entries: [ENTRY],
    tags: ['生产', '后台'],
    viewMode: 'card',
    selectedIds: new Set<string>(),
    searchQuery: '',
    searchField: 'all',
    filterEnv: 'all',
    filterTag: 'all',
    filterTags: new Set<string>(),
    sortField: 'updatedAt',
    sortOrder: 'desc',
    triggerNewEntry: 0,
  });
});

afterEach(() => cleanup());

const renderCard = (over: Record<string, unknown> = {}) => {
  const onOpenDetail = vi.fn();
  const utils = render(
    <EntryCard
      entry={ENTRY}
      onEdit={vi.fn()}
      onCopy={vi.fn()}
      onOpenDetail={onOpenDetail}
      {...over}
    />,
  );
  const card = () => utils.container.querySelector('.entry-card') as HTMLElement;
  const check = () => utils.container.querySelector('.entry-card input[type="checkbox"]') as HTMLInputElement;
  return { ...utils, onOpenDetail, card, check };
};

/* ============================ A. 卡片 ============================ */

describe('卡片：勾选框负责多选，主体负责开抽屉', () => {
  it('勾选框存在、带 aria-label「选择 <名称>」；点它只切选中，不开抽屉', () => {
    const { check, onOpenDetail } = renderCard();
    expect(check()).toBeTruthy();
    expect(check().getAttribute('aria-label')).toBe('选择 生产后台');

    fireEvent.click(check());
    expect(useStore.getState().selectedIds.has(ENTRY.id)).toBe(true);
    expect(onOpenDetail).not.toHaveBeenCalled();

    fireEvent.click(check());
    expect(useStore.getState().selectedIds.has(ENTRY.id)).toBe(false);
  });

  it('勾选不改 selectedIds 以外的任何状态（选 ≠ 用：不记「最近使用」）', () => {
    const { check } = renderCard();
    const before = storeSnapshot();

    fireEvent.click(check());

    const after = storeSnapshot();
    expect({ ...after, selectedIds: [] }).toEqual({ ...before, selectedIds: [] });
    expect(localStorage.getItem('pm.recent.entries')).toBeNull();
  });

  it('点卡片主体打开抽屉（回调带 entry 与触发元素），且不选中', () => {
    const { card, onOpenDetail } = renderCard();
    fireEvent.click(card());

    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    const [entry, trigger] = onOpenDetail.mock.calls[0];
    expect(entry.id).toBe(ENTRY.id);
    // 触发元素 = 卡片本身，抽屉据此在关闭后归还焦点
    expect(trigger).toBe(card());
    expect(useStore.getState().selectedIds.size).toBe(0);
    // 「最近使用」仍由卡片主体点击记录（scripts/ui-round17-test.js 依赖它）
    expect(String(localStorage.getItem('pm.recent.entries'))).toContain(ENTRY.id);
  });

  it('键盘 Enter / Space 在卡片本体上等价点击；焦点在内部按钮时不误触发', () => {
    const { card, onOpenDetail } = renderCard();
    card().focus();

    fireEvent.keyDown(card(), { key: 'Enter' });
    expect(onOpenDetail).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(card(), { key: ' ' });
    expect(onOpenDetail).toHaveBeenCalledTimes(2);

    const inner = card().querySelector('.card-actions button') as HTMLElement;
    inner.focus();
    fireEvent.keyDown(inner, { key: 'Enter' });
    expect(onOpenDetail).toHaveBeenCalledTimes(2);
  });

  it('选中态仍在卡片上（class=selected），状态由 checkbox 承载而非 aria-selected', async () => {
    const { card, check } = renderCard();
    expect(check().checked).toBe(false);

    act(() => { useStore.getState().toggleSelected(ENTRY.id); });

    await waitFor(() => expect(check().checked).toBe(true));
    expect(card().className).toContain('selected');
    expect(card().hasAttribute('aria-selected')).toBe(false);
  });
});

/* ============================ B. 抽屉 ============================ */

const renderDrawer = (over: Record<string, unknown> = {}, entry: PasswordEntry | null = ENTRY) => {
  const onClose = vi.fn();
  const utils = render(
    <EntryDetailDrawer open entry={entry} trigger={null} onClose={onClose} {...over} />,
  );
  return { ...utils, onClose };
};

describe('抽屉：内容与安全口径', () => {
  it('展示名称 / 环境徽标 / URL / 用户名 / 密码 / 标签 / 备注 / 附件数量 / 创建与更新时间 / 其他角色账号', () => {
    const { container } = renderDrawer();
    const text = container.textContent || '';

    expect(text).toContain('生产后台');
    expect(container.querySelector('.drawer .env-badge')?.textContent).toBe('正式');
    expect(text).toContain('https://admin.example.com');
    expect(text).toContain('admin@example.com');
    expect(text).toContain('生产');
    expect(text).toContain('只读账号，别改数据');
    expect(text).toContain('附件');
    expect(text).toContain(`创建 ${formatDateTime(ENTRY.createdAt)}`);
    expect(text).toContain(`更新 ${formatDateTime(ENTRY.updatedAt)}`);
    // 其他角色账号：只读列表 + 每个账号两条复制入口
    expect(text).toContain('其他角色账号（2）');
    expect(text).toContain('管理员');
    expect(text).toContain('root@example.com');
    expect(text).toContain('只读');
  });

  it('密码默认打码：不出现明文；点「显示密码」才出现，再点回打码', () => {
    const { container } = renderDrawer();
    const pwd = () => container.querySelector('.entry-detail-pwd') as HTMLElement;

    expect(pwd().textContent).toBe('••••••••');
    expect(container.textContent).not.toContain(ENTRY.password);

    fireEvent.click(within(container).getByRole('button', { name: '显示密码' }));
    expect(pwd().textContent).toBe(ENTRY.password);

    fireEvent.click(within(container).getByRole('button', { name: '隐藏密码' }));
    expect(pwd().textContent).toBe('••••••••');
  });

  it('「复制密码」走敏感通道（clipboardCopy 且 delay>0）+ 审计日志，不走 navigator.clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = renderDrawer();
    fireEvent.click(within(container).getByRole('button', { name: '复制密码' }));

    await waitFor(() => expect(calls('clipboardCopy').length).toBe(1));
    const payload = calls('clipboardCopy')[0].args[0] as { text: string; delay: number };
    expect(payload.text).toBe(ENTRY.password);
    // 敏感复制必须带自动清空延迟（settings.clipboardClearDelay = 30s）
    expect(payload.delay).toBeGreaterThan(0);
    expect(calls('auditLog').length).toBeGreaterThan(0);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('角色账号的密码复制同样走敏感通道（label 带「密码」）', async () => {
    const { container } = renderDrawer();
    const row = [...container.querySelectorAll('.role-acc-row')]
      .find(r => (r.textContent || '').includes('管理员')) as HTMLElement;
    // 1.32.8：角色账号的按钮也换成图标，按 aria-label 定位（文字已为空）
    const pwdRow = [...row.querySelectorAll('.role-acc-line')]
      .find(l => (l.textContent || '').includes('密码')) as HTMLElement;
    const pwdCopy = pwdRow.querySelector('button[aria-label*="复制"]') as HTMLButtonElement;
    expect(pwdCopy).toBeTruthy();
    expect((pwdCopy.textContent || '').trim()).toBe('');
    expect(pwdCopy.querySelector('svg')).toBeTruthy();
    fireEvent.click(pwdCopy);

    await waitFor(() => expect(calls('clipboardCopy').length).toBe(1));
    expect((calls('clipboardCopy')[0].args[0] as { text: string }).text).toBe('RootPw!');
    expect((calls('clipboardCopy')[0].args[0] as { delay: number }).delay).toBeGreaterThan(0);
  });

  it('URL / 用户名复制走普通通道（不承诺清空剪贴板）', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { container } = renderDrawer();
    fireEvent.click(within(container).getByRole('button', { name: '复制网址' }));
    fireEvent.click(within(container).getByRole('button', { name: '复制用户名' }));

    await waitFor(() => expect(writeText.mock.calls.length).toBe(2));
    expect(calls('clipboardCopy').length).toBe(0);
  });

  it('有 TOTP 才显示：无 secret 不出现占位；有 secret 显示 6 位码与剩余秒数', async () => {
    const { container, rerender } = renderDrawer();
    expect(container.querySelector('.entry-detail-totp')).toBeNull();

    rerender(
      <EntryDetailDrawer open entry={{ ...ENTRY, totpSecret: 'JBSWY3DPEHPK3PXP' }} trigger={null} onClose={vi.fn()} />,
    );
    await waitFor(() => expect(container.querySelector('.entry-detail-totp')?.textContent).toContain('123456'));
    // 剩余秒数由 TotpBadge 的 showRemaining 渲染（默认 false → 卡片调用点一个字不改）
    const sec = container.querySelector('.entry-detail-totp .totp-sec')?.textContent || '';
    expect(sec).toMatch(/^\d+s$/);
    const n = Number(sec.replace('s', ''));
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(30);
  });

  it('底部「编辑」「删除」只是入口：点击回调上层，抽屉不自己删', () => {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const { container } = renderDrawer({ onEdit, onDelete });

    fireEvent.click(within(container).getByRole('button', { name: '编辑' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: ENTRY.id }));

    fireEvent.click(within(container).getByRole('button', { name: '删除' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: ENTRY.id }));
    expect(calls('entriesDelete').length).toBe(0);
  });

  it('不传 onEdit / onDelete 时两个按钮都不渲染（成员账号 tab 的用法）', () => {
    const { container } = renderDrawer();
    expect(within(container).queryByRole('button', { name: '编辑' })).toBeNull();
    expect(within(container).queryByRole('button', { name: '删除' })).toBeNull();
  });
});

describe('抽屉：关闭与焦点归还', () => {
  it('Esc / 点遮罩 / 「关闭」三条路径都关', () => {
    const { container, onClose } = renderDrawer();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(container.querySelector('.drawer-mask') as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);

    const closeBtns = within(container).getAllByRole('button', { name: '关闭' });
    fireEvent.click(closeBtns[0]);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('关闭后焦点回到打开前的元素', async () => {
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="opener" onClick={() => setOpen(true)}>打开详情</button>
          <EntryDetailDrawer
            open={open}
            entry={open ? ENTRY : null}
            trigger={null}
            onClose={() => { onClose(); setOpen(false); }}
          />
        </>
      );
    }
    const { getByTestId } = render(<Harness />);
    const opener = getByTestId('opener') as HTMLElement;
    opener.focus();
    fireEvent.click(opener);

    // 打开后焦点进抽屉（关闭按钮），键盘用户不会丢位置
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('关闭'));

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('打开前焦点已丢（activeElement 是 body）时，退回 trigger 元素', async () => {
    const outer = document.createElement('button');
    outer.textContent = '触发卡片';
    document.body.appendChild(outer);

    const { rerender } = render(
      <EntryDetailDrawer open entry={ENTRY} trigger={outer} onClose={() => {}} />,
    );
    (document.activeElement as HTMLElement | null)?.blur?.();

    rerender(<EntryDetailDrawer open={false} entry={null} trigger={outer} onClose={() => {}} />);
    await waitFor(() => expect(document.activeElement).toBe(outer));
    outer.remove();
  });
});

/* ============================ C. Dashboard 接线 ============================ */

describe('Dashboard：卡片视图点主体开抽屉、勾选框不影响批量条', () => {
  it('点卡片主体 → 右侧抽屉出现，内容是该条目', async () => {
    const { container } = render(<Dashboard />);
    await waitFor(() => expect(container.querySelector('.entry-card')).toBeTruthy());

    fireEvent.click(container.querySelector('.entry-card') as HTMLElement);

    await waitFor(() => expect(container.querySelector('.drawer')).toBeTruthy());
    expect(container.querySelector('.drawer')?.textContent).toContain('生产后台');
    expect(container.querySelector('.drawer .env-badge')?.textContent).toBe('正式');
  });

  it('点勾选框 → 不开抽屉，批量条出现', async () => {
    const { container } = render(<Dashboard />);
    await waitFor(() => expect(container.querySelector('.entry-card')).toBeTruthy());

    fireEvent.click(container.querySelector('.entry-card input[type="checkbox"]') as HTMLElement);

    await waitFor(() => expect(container.querySelector('.batch-bar')).toBeTruthy());
    expect(container.querySelector('.drawer')).toBeNull();
    expect(useStore.getState().selectedIds.has(ENTRY.id)).toBe(true);
  });

  it('勾选后批量删除仍能执行：二次确认 → entriesDelete 带该 id', async () => {
    const { container } = render(<Dashboard />);
    await waitFor(() => expect(container.querySelector('.entry-card')).toBeTruthy());

    fireEvent.click(container.querySelector('.entry-card input[type="checkbox"]') as HTMLElement);
    await waitFor(() => expect(container.querySelector('.batch-bar')).toBeTruthy());

    const delBtn = [...container.querySelectorAll('.batch-bar button')]
      .find(b => (b.textContent || '').trim() === '删除') as HTMLElement;
    expect(delBtn).toBeTruthy();
    fireEvent.click(delBtn);

    const dialog = await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));

    await waitFor(() => expect(calls('entriesDelete').length).toBe(1));
    expect(calls('entriesDelete')[0].args[0]).toEqual({ ids: [ENTRY.id], permanent: true });
  });

  it('抽屉底部「删除」走既有二次确认：确认前不调用 entriesDelete', async () => {
    const { container } = render(<Dashboard />);
    await waitFor(() => expect(container.querySelector('.entry-card')).toBeTruthy());
    fireEvent.click(container.querySelector('.entry-card') as HTMLElement);
    await waitFor(() => expect(container.querySelector('.drawer')).toBeTruthy());

    fireEvent.click(within(container.querySelector('.drawer') as HTMLElement).getByRole('button', { name: '删除' }));

    const dialog = await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
    expect(dialog.textContent).toContain('彻底删除');
    expect(calls('entriesDelete').length).toBe(0);

    fireEvent.click(within(dialog).getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(calls('entriesDelete').length).toBe(1));
    expect(calls('entriesDelete')[0].args[0]).toEqual({ ids: [ENTRY.id], permanent: true });
  });

  it('抽屉底部「编辑」复用既有编辑弹窗（EntryForm 打开且回填该条目）', async () => {
    const { container } = render(<Dashboard />);
    await waitFor(() => expect(container.querySelector('.entry-card')).toBeTruthy());
    fireEvent.click(container.querySelector('.entry-card') as HTMLElement);
    await waitFor(() => expect(container.querySelector('.drawer')).toBeTruthy());

    fireEvent.click(within(container.querySelector('.drawer') as HTMLElement).getByRole('button', { name: '编辑' }));

    const dialog = await waitFor(() => document.querySelector('[role="dialog"]') as HTMLElement);
    expect((within(dialog).getByLabelText('名称') as HTMLInputElement).value).toBe('生产后台');
    // 抽屉让位给编辑弹窗，不叠着两层
    expect(container.querySelector('.drawer')).toBeNull();
  });
});

/* ==================================================================
   接线守卫（t8 repair）：CSS 选择器 ↔ 组件根类名
   ----------------------------------------------------------------
   A 片踩过的坑：CSS 写了 `.drawer.entry-drawer`（460px + 玻璃），组件根节点却是
   `drawer entry-detail-drawer` —— 两条规则一条都不命中，测试全绿、宽度超标、
   D1 扫描还会因为「520×全高不透明白块」误红。

   这一组用例把「选择器 ↔ 类名」变成机械判据：
     1) 真读 src/styles/redesign.css 文本，断言两条规则都在，且宽度就是 460px；
     2) 真渲染抽屉，断言根节点类名同时含 drawer 与 entry-drawer、且旧名不许回来。
   任何一边漂移（改名、删规则、宽度改成别的值）都会红。

   ⚠️ jsdom 没有布局：这里只断「接线 + 声明值」，460px 的实际 computed 宽度由
   qa 在真实 Electron 里量（本片交付回执里有 getComputedStyle 的原始输出）。
   ================================================================== */
const REDESIGN_CSS = readFileSync('src/styles/redesign.css', 'utf8');

/** 取某条规则的声明体（文本断言：不依赖 jsdom 的布局能力） */
function cssRuleBody(css: string, selector: string): string {
  const at = css.indexOf(selector);
  expect(`${selector} → ${at}`).not.toContain('→ -1');
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

describe('抽屉接线守卫：CSS 选择器必须与组件根类名一致', () => {
  it('redesign.css 里两条抽屉规则都在，宽度是 460px（契约 420–480）', () => {
    const base = cssRuleBody(REDESIGN_CSS, '.drawer.entry-drawer {');
    expect(base).toContain('width: 460px');
    // 背景图模式那条：只改底色，不叠其它属性
    const glass = cssRuleBody(REDESIGN_CSS, "html[data-bg='image'] .drawer.entry-drawer {");
    expect(glass).toContain('background-color: var(--glass-modal)');
  });

  it('组件根节点类名同时含 drawer 与 entry-drawer，旧名 entry-detail-drawer 不再出现', () => {
    const { container } = render(<EntryDetailDrawer open entry={ENTRY} trigger={null} onClose={() => {}} />);
    const root = container.querySelector('.drawer') as HTMLElement;
    expect(root).toBeTruthy();

    const classes = (root.className || '').split(/\s+/).filter(Boolean);
    expect(classes).toContain('drawer');
    expect(classes).toContain('entry-drawer');
    // 漂移的另一半：旧名一回来，两条 CSS 规则就再次全部落空
    expect(root.className).not.toContain('entry-detail-drawer');

    // 选择器能真的选中它（而不是只靠 className 字符串巧合）
    expect(container.querySelector('.drawer.entry-drawer')).toBe(root);
  });
});

/* ==================================================================
   1.32.8 体验修：信息行对齐 + 复制/显示/隐藏改图标
   用户反馈：①几行信息没对齐，用户名一长就把「复制」挤出抽屉；②文字按钮太占位。
   ================================================================== */

describe('条目详情抽屉：信息行布局与图标按钮', () => {
  it('复制 / 打开 / 显示隐藏 全部是带 aria-label 的图标按钮，不再有文字按钮', () => {
    const { container } = renderDrawer();
    for (const label of ['复制网址', '打开网址', '复制用户名', '显示密码', '复制密码']) {
      const btn = container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
      expect(btn, `缺少 ${label} 按钮`).toBeTruthy();
      expect(btn.textContent || '').toBe('');   // 图标按钮：没有可见文字
      expect(btn.getAttribute('title')).toBeTruthy();
      expect(btn.querySelector('svg')).toBeTruthy();
    }
    // 值/动作两个容器都在：值负责省略，动作固定宽度不收缩
    expect(container.querySelectorAll('.entry-detail-val').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll('.entry-detail-actions').length).toBe(3);
  });

  it('CSS 守卫：值收敛 + 动作不收缩 + 抽屉内单列（改规则或删规则必须红）', () => {
    const css = readFileSync('src/styles/redesign.css', 'utf8');
    const block = (sel: string) => {
      const i = css.indexOf(sel);
      return i < 0 ? '' : css.slice(i, css.indexOf('}', i));
    };
    const val = block('.entry-detail-val {');
    expect(val).toContain('min-width: 0');
    expect(val).toContain('text-overflow: ellipsis');
    expect(block('.entry-detail-actions {')).toContain('flex: 0 0 auto');
    expect(block('.entry-drawer .drawer-kv {')).toContain('grid-template-columns: 1fr');
  });
});