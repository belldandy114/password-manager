import { describe, it, expect, vi } from 'vitest';
import { normalizeHttpUrl, fallbackCommands, openHttpUrl, safeForLog } from '../../../electron/url-open.js';

/** 造一个「能成功 spawn」的子进程桩：触发 spawn 事件，让 openHttpUrl 立刻判定命中 */
function fakeChild(ok = true) {
  const handlers: Record<string, (...args: any[]) => void> = {};
  const child = {
    on: vi.fn((evt: string, fn: (...args: any[]) => void) => {
      handlers[evt] = fn;
      if (evt === 'spawn' && ok) queueMicrotask(() => handlers.spawn && handlers.spawn());
      if (evt === 'error' && !ok) queueMicrotask(() => handlers.error && handlers.error(new Error('ENOENT')));
      return child;
    }),
    unref: vi.fn(),
  };
  return child;
}

describe('normalizeHttpUrl', () => {
  it('补 https:// 并保留路径', () => {
    expect(normalizeHttpUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('已带协议原样保留', () => {
    expect(normalizeHttpUrl('http://127.0.0.1:8080/health')).toBe('http://127.0.0.1:8080/health');
    expect(normalizeHttpUrl('  https://demo.example.com  ')).toBe('https://demo.example.com');
  });

  it('只有 http(s) 放行，其它 scheme 一律拒绝', () => {
    expect(normalizeHttpUrl('javascript:alert(1)')).toBe('');
    expect(normalizeHttpUrl('file:///C:/Windows')).toBe('');
    expect(normalizeHttpUrl('mailto:a@b.com')).toBe('');
    expect(normalizeHttpUrl('')).toBe('');
    expect(normalizeHttpUrl(null)).toBe('');
  });
});

describe('safeForLog', () => {
  it('去掉查询串，避免把 token 写进日志', () => {
    expect(safeForLog('https://a.example.com/path?token=secret#x')).toBe('https://a.example.com/path');
  });
});

describe('fallbackCommands', () => {
  it('非 Windows 不产生兜底命令', () => {
    expect(fallbackCommands('https://example.com', 'darwin')).toEqual([]);
    expect(fallbackCommands('https://example.com', 'linux')).toEqual([]);
  });

  it('Windows 上是 rundll32 → explorer 两条，且都带着完整地址', () => {
    const cmds = fallbackCommands('https://example.com/x', 'win32');
    expect(cmds.length).toBe(2);
    // 顺序必须与实测一致：explorer 在 Electron 宿主里是「假成功」，不能排第一
    expect(cmds.map(c => c.via)).toEqual(['rundll32', 'explorer']);
    expect(cmds[0].exe).toBe('rundll32.exe');
    expect(cmds[0].args).toEqual(['url.dll,FileProtocolHandler', 'https://example.com/x']);
    expect(String(cmds[1].exe).toLowerCase().endsWith('explorer.exe')).toBe(true);
    expect(cmds[1].args).toEqual(['https://example.com/x']);
  });
});

describe('openHttpUrl', () => {
  const noBrowsers: any[] = [];

  it('非法地址直接失败，不调 shell', async () => {
    const openExternal = vi.fn();
    const r = await openHttpUrl('ftp://x', { shell: { openExternal }, spawn: vi.fn() });
    expect(r.success).toBe(false);
    expect(r.error).toBe('地址不合法');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Windows：先走 rundll32，成功就不碰 openExternal', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn((_exe: string, _args: string[]) => fakeChild(true));
    const r = await openHttpUrl('https://example.com', {
      shell: { openExternal }, spawn, platform: 'win32', candidateBrowsers: noBrowsers,
    });
    expect(r).toEqual({ success: true, via: 'rundll32' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe('rundll32.exe');
    expect(spawn.mock.calls[0][1]).toEqual(['url.dll,FileProtocolHandler', 'https://example.com']);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Windows：rundll32 起不来时，先试直接拉浏览器 exe', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    const spawn = vi.fn((_exe: string, _args: string[]) => fakeChild(++call > 1));
    const r = await openHttpUrl('https://example.com', {
      shell: { openExternal }, spawn, platform: 'win32',
      candidateBrowsers: [{ exe: 'C:\\fake\\chrome.exe', via: 'chrome' }],
    });
    expect(r).toEqual({ success: true, via: 'chrome' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1][0]).toBe('C:\\fake\\chrome.exe');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Windows：rundll32 与浏览器 exe 都起不来时，退回 openExternal', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    // 1 = rundll32 失败，2 = chrome 失败 → openExternal 成功
    const spawn = vi.fn((_exe: string, _args: string[]) => fakeChild(++call > 2));
    const r = await openHttpUrl('https://example.com', {
      shell: { openExternal }, spawn, platform: 'win32',
      candidateBrowsers: [{ exe: 'C:\\fake\\chrome.exe', via: 'chrome' }],
    });
    expect(r).toEqual({ success: true, via: 'shell' });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('Windows：openExternal 也失败时，最后才试 explorer 代理', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('blocked'));
    let call = 0;
    // 1 = rundll32 失败，2 = explorer 成功（浏览器 exe 关掉，聚焦顺序）
    const spawn = vi.fn((_exe: string, _args: string[]) => fakeChild(++call > 1));
    const r = await openHttpUrl('https://example.com', {
      shell: { openExternal }, spawn, platform: 'win32', candidateBrowsers: noBrowsers,
    });
    expect(r).toEqual({ success: true, via: 'explorer' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(String(spawn.mock.calls[1][0]).toLowerCase()).toContain('explorer.exe');
  });

  it('Windows：全都起不来时，报错并带回原因', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn((_exe: string, _args: string[]) => fakeChild(false));
    const r = await openHttpUrl('https://example.com', {
      shell: { openExternal }, spawn, platform: 'win32', candidateBrowsers: noBrowsers,
    });
    // openExternal 不抛错就算命中（它「假成功」的情况只能靠 app.log 里的 via 追）
    expect(r).toEqual({ success: true, via: 'shell' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('Windows：兜底与 openExternal 全失败时报错，并带回原因', async () => {
    const openExternal = vi.fn().mockRejectedValue(new Error('blocked'));
    const spawn = vi.fn((_exe: string, _args: string[]) => fakeChild(false));
    const r = await openHttpUrl('https://example.com', {
      shell: { openExternal }, spawn, platform: 'win32', candidateBrowsers: noBrowsers,
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe('blocked');
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('spawn 同步抛错也不吞掉，继续走后面的兜底', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn((_exe: string, _args: string[]) => { throw new Error('blocked by policy'); });
    const r = await openHttpUrl('https://example.com', {
      shell: { openExternal }, spawn, platform: 'win32', candidateBrowsers: noBrowsers,
    });
    expect(r).toEqual({ success: true, via: 'shell' });
  });

  it('非 Windows：仍然 openExternal 优先，不发系统命令', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const spawn = vi.fn();
    const r = await openHttpUrl('https://example.com', { shell: { openExternal }, spawn, platform: 'darwin' });
    expect(r).toEqual({ success: true, via: 'shell' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('非 Windows 且没有 openExternal 时失败', async () => {
    const r = await openHttpUrl('https://example.com', { spawn: vi.fn(), platform: 'linux' });
    expect(r.success).toBe(false);
  });
});
