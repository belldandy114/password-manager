import { describe, it, expect } from 'vitest';
import { cmpVersion, shouldNotifyUpdate } from '../../../electron/update-check.js';

describe('update-check.cmpVersion 版本比较', () => {
  it('逐段数值比较（不是字符串比较）', () => {
    expect(cmpVersion('1.7.10', '1.7.9')).toBe(1);
    expect(cmpVersion('1.10.0', '1.9.9')).toBe(1);
    expect(cmpVersion('2.0.0', '1.99.99')).toBe(1);
    expect(cmpVersion('1.7.2', '1.7.2')).toBe(0);
    expect(cmpVersion('1.6.2', '1.7.0')).toBe(-1);
  });

  it('段数不同时按 0 补齐', () => {
    expect(cmpVersion('1.7', '1.7.0')).toBe(0);
    expect(cmpVersion('1.7', '1.7.1')).toBe(-1);
    expect(cmpVersion('1.7.0.1', '1.7.0')).toBe(1);
  });

  it('非法/空版本不抛异常', () => {
    expect(() => cmpVersion('', '1.0.0')).not.toThrow();
    expect(cmpVersion('', '1.0.0')).toBe(-1);
    expect(cmpVersion('x.y', '1.0.0')).toBe(-1);
  });
});

describe('update-check.shouldNotifyUpdate 是否提醒', () => {
  it('有新版本且没提示过 → 提示', () => {
    expect(shouldNotifyUpdate({ current: '1.7.2', latest: '1.7.3' })).toBe(true);
  });

  it('同一版本已经提示过 → 不再提示（避免每次启动都弹）', () => {
    expect(shouldNotifyUpdate({ current: '1.7.2', latest: '1.7.3', lastNotified: '1.7.3' })).toBe(false);
  });

  it('提示过旧版本、又出了更新的版本 → 继续提示', () => {
    expect(shouldNotifyUpdate({ current: '1.7.2', latest: '1.7.4', lastNotified: '1.7.3' })).toBe(true);
  });

  it('版本不高于当前 → 不提示', () => {
    expect(shouldNotifyUpdate({ current: '1.7.3', latest: '1.7.3' })).toBe(false);
    expect(shouldNotifyUpdate({ current: '1.7.3', latest: '1.7.2' })).toBe(false);
  });

  it('带 v 前缀也能比', () => {
    expect(shouldNotifyUpdate({ current: 'v1.7.2', latest: 'v1.7.3' })).toBe(true);
  });

  it('缺参数 → 不提示（宁可不弹，也不弹错）', () => {
    expect(shouldNotifyUpdate({ current: '', latest: '1.7.3' })).toBe(false);
    expect(shouldNotifyUpdate({ current: '1.7.2', latest: '' })).toBe(false);
    expect(shouldNotifyUpdate({})).toBe(false);
  });
});
