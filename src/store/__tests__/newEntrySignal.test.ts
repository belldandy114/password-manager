import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../useStore';

/**
 * 回归：Ctrl+空格把网址存进网址管理后，反复进出「网址管理」都会再弹一次新增窗口。
 * 旧实现里 triggerNewEntry 只增不减，Dashboard 每次挂载看到 >0 就开弹窗。
 */
describe('新增网址一次性信号', () => {
  beforeEach(() => {
    useStore.setState({ triggerNewEntry: 0, newEntrySeed: null });
  });

  it('带种子触发后可读到种子，消费后信号与种子一起清零', () => {
    useStore.getState().signalNewEntry({ url: 'https://example.com', name: '示例' });
    expect(useStore.getState().triggerNewEntry).toBe(1);
    expect(useStore.getState().newEntrySeed).toEqual({ url: 'https://example.com', name: '示例' });

    useStore.getState().consumeNewEntry();
    expect(useStore.getState().triggerNewEntry).toBe(0);
    expect(useStore.getState().newEntrySeed).toBeNull();
  });

  it('消费后不会残留 >0 的信号，下一次触发仍能正常开弹窗', () => {
    useStore.getState().signalNewEntry();
    useStore.getState().consumeNewEntry();
    expect(useStore.getState().triggerNewEntry).toBe(0);

    useStore.getState().signalNewEntry();
    expect(useStore.getState().triggerNewEntry).toBe(1);
    expect(useStore.getState().newEntrySeed).toBeNull();
  });
});
