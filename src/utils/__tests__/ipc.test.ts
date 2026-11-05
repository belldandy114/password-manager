import { describe, it, expect } from 'vitest';
import { callIpc } from '../ipc';

describe('callIpc 统一 IPC 结果', () => {
  it('success:true → ok，并带出 data', async () => {
    const r = await callIpc(async () => ({ success: true, data: { a: 1 } }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toEqual({ a: 1 });
  });

  it('success:false → 失败，带主进程给的错误文案', async () => {
    const r = await callIpc(async () => ({ success: false, error: '磁盘已满' }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('磁盘已满');
  });

  it('success:false 且没有 error → 用中文兜底，不会是 undefined', async () => {
    const r = await callIpc(async () => ({ success: false }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBeTruthy();
    expect(!r.ok && r.error).not.toBe('undefined');
  });

  it('抛异常 → 失败并带出异常信息（不向外抛）', async () => {
    const r = await callIpc(async () => { throw new Error('IPC 通道断了'); });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe('IPC 通道断了');
  });

  it('抛非 Error 值 / 空信息 → 兜底文案', async () => {
    const r1 = await callIpc(async () => { throw 'boom'; });
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.error).toBe('boom');
    const r2 = await callIpc(async () => { throw new Error('   '); });
    expect(!r2.ok && r2.error).toBeTruthy();
  });

  it('返回 null/undefined（旧 handler 没返回值）→ 失败而不是崩溃', async () => {
    for (const v of [null, undefined]) {
      const r = await callIpc(async () => v);
      expect(r.ok).toBe(false);
    }
  });

  it('canceled:true 视为成功（用户取消不是错误）', async () => {
    const r = await callIpc(async () => ({ canceled: true }));
    expect(r.ok).toBe(true);
  });

  it('只有 data 没有 success（部分老接口）→ 视为成功', async () => {
    const r = await callIpc(async () => ({ data: 'x' }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.data).toBe('x');
  });
});
