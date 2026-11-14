// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { NoticeCenter } from '../NoticeCenter';
import { useEnvProbeStore } from '../../store/envProbeStore';

/**
 * 提醒中心的一键清除（1.24.4）约定：
 *  1. 有事项时列表带「全部清除」按钮
 *  2. 清除后同一批状态不再显示（空态说明 + 可恢复）
 *  3. 状态集合变化（新事项）→ 自动恢复显示，不会漏掉新提醒
 *  4. 「恢复显示」把这批事项请回来
 */

type Api = Record<string, unknown>;

function makeStatus(verify: Array<{ id: string; title: string; days: number }>) {
  return {
    enabled: true,
    interval: 10,
    configured: true,
    unlocked: true,
    staleOn: true,
    staleDays: 3,
    lastCheck: {
      at: new Date().toISOString(),
      ok: true,
      fresh: 0,
      staleRows: { verify, handle: [] as Array<{ id: string; title: string; days: number }> },
    },
  };
}

function mockApi(status: ReturnType<typeof makeStatus>): Api {
  const api: Api = {
    zentaoNotifyStatus: vi.fn(async () => ({ success: true, data: status })),
    zentaoNotifyNow: vi.fn(async () => ({ success: true })),
    backupList: vi.fn(async () => ({ success: true, data: [] })),
  };
  (window as unknown as { electronAPI: Api }).electronAPI = api;
  return api;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('NoticeCenter 一键清除', () => {
  beforeEach(() => {
    localStorage.clear();
    useEnvProbeStore.setState({ results: {}, at: null });
  });

  it('有事项时显示列表与「全部清除」', async () => {
    mockApi(makeStatus([{ id: '101', title: '登录偶发 500', days: 5 }]));
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText('#101 待验证已 5 天')).toBeTruthy());
    expect(screen.getByText('全部清除')).toBeTruthy();
  });

  it('清除后不再显示，但可恢复；状态变化自动恢复展示', async () => {
    const status = makeStatus([{ id: '101', title: '登录偶发 500', days: 5 }]);
    mockApi(status);
    const { rerender } = render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('全部清除')).toBeTruthy());

    screen.getByText('全部清除').click();
    await waitFor(() => expect(screen.getByText(/已清除 1 条提醒/)).toBeTruthy());
    expect(screen.getByText('恢复显示')).toBeTruthy();

    // 状态没变：重新打开仍是已清除空态（重挂 = 全新实例， dismissedSig 从 localStorage 读回）
    cleanup();
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText(/已清除 1 条提醒/)).toBeTruthy());

    // 出现新事项（签名变化）→ 自动恢复显示，且不丢老事项
    mockApi(makeStatus([
      { id: '101', title: '登录偶发 500', days: 5 },
      { id: '102', title: '导出超时', days: 2 },
    ]));
    cleanup();
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('#102 待验证已 2 天')).toBeTruthy());
    expect(screen.getByText('#101 待验证已 5 天')).toBeTruthy();
  });

  it('「恢复显示」把这批事项请回来', async () => {
    mockApi(makeStatus([{ id: '201', title: '上传失败', days: 9 }]));
    const { rerender } = render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('全部清除')).toBeTruthy());

    screen.getByText('全部清除').click();
    await waitFor(() => expect(screen.getByText('恢复显示')).toBeTruthy());

    screen.getByText('恢复显示').click();
    await waitFor(() => expect(screen.getByText('#201 待验证已 9 天')).toBeTruthy());

    // 落盘的签名也被清掉：重新打开列表仍在
    rerender(<NoticeCenter open={false} onClose={() => {}} onNavigate={() => {}} />);
    rerender(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('#201 待验证已 9 天')).toBeTruthy());
  });

  it('环境不可达事项同样可被清除（签名覆盖全部分组）', async () => {
    useEnvProbeStore.setState({
      results: { e1: { id: 'e1', url: 'http://10.0.0.8:8080', ok: false, error: '超时' } },
      at: Date.now(),
    });
    mockApi(makeStatus([]));
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText('不可达：10.0.0.8:8080')).toBeTruthy());
    screen.getByText('全部清除').click();
    await waitFor(() => expect(screen.getByText(/已清除 1 条提醒/)).toBeTruthy());
  });
});
