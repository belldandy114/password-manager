// @vitest-environment jsdom
// C 片回归：附件页两条目录条（docs/agents/entry-ux-next.md §3.4 / §8 裁定 4）
//
// 判据：
//   - 两处 .att-dir-bar 都不再有路径文本节点，也不再有「复制路径」按钮；
//   - 只留「打开目录」「更改目录」，完整路径进按钮 title；
//   - 两个按钮仍分别触发原通道（attachmentReveal / notesReveal；笔记条用现成
//     notesPickDir + settingsSave({notesDir})，零新增 IPC）；
//   - 取消静默、失败红 toast 且原值不变；未配置目录时整块不渲染。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import React from 'react';

import { useStore } from '../../store/useStore';
import { AttachmentsBody } from '../../pages/Attachments';

interface RecordedCall { channel: string; args: any[] }
let recorded: RecordedCall[] = [];

function stubElectronApi(overrides: Record<string, unknown> = {}) {
  recorded = [];
  const track = (channel: string, impl?: (...a: any[]) => any) => (...args: any[]) => {
    recorded.push({ channel, args });
    return impl ? impl(...args) : Promise.resolve({ success: true });
  };
  const base: Record<string, unknown> = {
    attachmentList: track('attachmentList', () => ({
      success: true,
      dir: 'fixtures/att-global',
      notesDir: 'fixtures/notes-home/attachments',
      dirExists: true,
      data: [],
    })),
    attachmentReveal: track('attachmentReveal', () => ({ success: true })),
    attachmentEnsureNoteDir: track('attachmentEnsureNoteDir', () => ({
      success: true, data: { dir: 'fixtures/notes-home/attachments' },
    })),
    notesReveal: track('notesReveal', () => ({ success: true })),
    attachmentPickDir: track('attachmentPickDir', () => ({ success: true, data: { dir: 'fixtures/new-att' } })),
    attachmentSetDir: track('attachmentSetDir', () => ({ success: true, data: { copied: 3 } })),
    notesPickDir: track('notesPickDir', () => ({ success: true, data: 'fixtures/new-notes' })),
    settingsSave: track('settingsSave', () => ({ success: true })),
    wsGet: track('wsGet', () => ({ success: false })),
    onClipboardCleared: () => () => {},
  };
  // 覆盖项也要记调用（否则「取消时到底有没有调 notesPickDir」这类断言只能靠猜）
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    merged[k] = typeof v === 'function' ? track(k, v as (...a: any[]) => any) : v;
  }
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(merged, {
    get(obj: Record<string, unknown>, prop: string) {
      if (prop in obj) return obj[prop];
      if (/^(on|off|once|remove|unsubscribe|subscribe)/i.test(prop)) return () => () => {};
      return track(prop);
    },
  });
}

const calls = (channel: string) => recorded.filter(r => r.channel === channel);

beforeEach(() => {
  localStorage.clear();
  stubElectronApi();
  useStore.setState({
    entries: [],
    tags: [],
    selectedIds: new Set<string>(),
    settings: { ...useStore.getState().settings, notesDir: 'fixtures/notes-home' },
  });
});

afterEach(() => cleanup());

const bars = (root: ParentNode) => [...root.querySelectorAll('.att-dir-bar')] as HTMLElement[];
const noteBar = (root: ParentNode) => root.querySelector('.att-dir-bar-note') as HTMLElement;

describe('附件页目录条：只留按钮，不再露路径文本', () => {
  it('两条目录条都不再有路径节点、也没有「复制路径」按钮；只剩「打开目录」「更改目录」', async () => {
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(bars(container)).toHaveLength(2));

    // 路径文本节点：原来那个 <code class="att-dir-path"> 整块删掉
    expect(container.querySelectorAll('.att-dir-path')).toHaveLength(0);
    const text = container.textContent || '';
    expect(text).not.toContain('fixtures/att-global');
    expect(text).not.toContain('fixtures/notes-home/attachments');

    // 「复制路径」按钮按 §8 裁定一并删掉
    expect(within(container).queryByRole('button', { name: '复制路径' })).toBeNull();
    expect(text).not.toContain('复制路径');

    for (const bar of bars(container)) {
      const labels = [...bar.querySelectorAll('button')].map(b => (b.textContent || '').trim());
      expect(labels).toEqual(['打开目录', '更改目录']);
    }
  });

  it('完整路径进「打开目录」的 title（悬停可见）', async () => {
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(bars(container)).toHaveLength(2));

    const globalOpen = within(bars(container).find(b => !b.classList.contains('att-dir-bar-note'))!)
      .getByRole('button', { name: '打开目录' });
    expect(globalOpen.getAttribute('title')).toContain('fixtures/att-global');

    const noteOpen = within(noteBar(container)).getByRole('button', { name: '打开目录' });
    expect(noteOpen.getAttribute('title')).toContain('fixtures/notes-home/attachments');
  });

  it('未配置目录时两块整块不渲染（不留空按钮）', async () => {
    stubElectronApi({
      attachmentList: () => ({ success: true, dir: '', notesDir: '', dirExists: true, data: [] }),
    });
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(container.querySelector('.tbl-empty, .empty-state, .att-grid')).toBeTruthy());
    expect(bars(container)).toHaveLength(0);
    expect(within(container).queryByRole('button', { name: '打开目录' })).toBeNull();
    expect(within(container).queryByRole('button', { name: '更改目录' })).toBeNull();
  });
});

describe('附件页目录条：两个按钮仍触发原通道', () => {
  it('全局条：打开目录 → attachmentReveal；更改目录 → attachmentPickDir + attachmentSetDir', async () => {
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(bars(container)).toHaveLength(2));
    const bar = bars(container).find(b => !b.classList.contains('att-dir-bar-note'))!;

    fireEvent.click(within(bar).getByRole('button', { name: '打开目录' }));
    await waitFor(() => expect(calls('attachmentReveal').length).toBe(1));

    fireEvent.click(within(bar).getByRole('button', { name: '更改目录' }));
    await waitFor(() => expect(calls('attachmentPickDir').length).toBe(1));
    await waitFor(() => expect(calls('attachmentSetDir').length).toBe(1));
    expect(calls('attachmentSetDir')[0].args[0]).toEqual({ dir: 'fixtures/new-att' });
  });

  it('笔记条：打开目录 → attachmentEnsureNoteDir + notesReveal', async () => {
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(bars(container)).toHaveLength(2));

    fireEvent.click(within(noteBar(container)).getByRole('button', { name: '打开目录' }));
    await waitFor(() => expect(calls('attachmentEnsureNoteDir').length).toBe(1));
    await waitFor(() => expect(calls('notesReveal').length).toBe(1));
    expect(calls('notesReveal')[0].args[0]).toBe('fixtures/notes-home/attachments');
  });

  it('笔记条：更改目录 → notesPickDir + settingsSave({notesDir})，并同步到 store', async () => {
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(bars(container)).toHaveLength(2));

    fireEvent.click(within(noteBar(container)).getByRole('button', { name: '更改目录' }));

    await waitFor(() => expect(calls('notesPickDir').length).toBe(1));
    await waitFor(() => expect(calls('settingsSave').length).toBe(1));
    expect(calls('settingsSave')[0].args[0]).toEqual({ notesDir: 'fixtures/new-notes' });
    await waitFor(() => expect(useStore.getState().settings.notesDir).toBe('fixtures/new-notes'));
    // 与 Notes 页同口径：localStorage 也双写，旧版本/笔记页都认它
    expect(localStorage.getItem('pm.notes.dir')).toBe('fixtures/new-notes');
  });

  it('用户取消（success:true 但没选目录）：静默返回，不写设置', async () => {
    stubElectronApi({ notesPickDir: () => ({ success: true, data: null }) });
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(bars(container)).toHaveLength(2));

    fireEvent.click(within(noteBar(container)).getByRole('button', { name: '更改目录' }));

    await waitFor(() => expect(calls('notesPickDir').length).toBe(1));
    await waitFor(() => expect(container.querySelectorAll('.toast').length).toBe(0));
    expect(calls('settingsSave').length).toBe(0);
    expect(useStore.getState().settings.notesDir).toBe('fixtures/notes-home');
  });

  it('选择失败：红 toast，且原目录与设置都不动', async () => {
    stubElectronApi({ notesPickDir: () => ({ success: false, error: '目录不可用' }) });
    const { container } = render(<AttachmentsBody />);
    await waitFor(() => expect(bars(container)).toHaveLength(2));

    fireEvent.click(within(noteBar(container)).getByRole('button', { name: '更改目录' }));

    await waitFor(() => expect(container.querySelector('.toast.error')).toBeTruthy());
    expect(container.querySelector('.toast.error')!.textContent).toContain('目录不可用');
    expect(calls('settingsSave').length).toBe(0);
    expect(useStore.getState().settings.notesDir).toBe('fixtures/notes-home');
    // 目录条上的「打开目录」title 仍是原路径（UI 没变）
    expect(within(noteBar(container)).getByRole('button', { name: '打开目录' })
      .getAttribute('title')).toContain('fixtures/notes-home/attachments');
  });
});
