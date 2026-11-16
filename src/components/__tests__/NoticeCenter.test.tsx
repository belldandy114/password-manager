// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { NoticeCenter } from '../NoticeCenter';
import { useEnvProbeStore } from '../../store/envProbeStore';

/**
 * 提醒中心的一键清除（1.25.0 重做后的约定）：
 *  1. 有事项时列表带「全部清除」按钮
 *  2. 清除后消息中心为空（用户要求：清除之后不存在任何内容）
 *  3. **按单条 key 记已读**：清掉的不再回来
 *  4. 新出现的事项照常显示（不会因为「签名变了」把清掉的全部复活）
 *  5. 「恢复已清除的提醒」把清掉的请回来
 *
 * 旧实现按「整批签名」判断，任何一条变动都会让清掉的全部复活 —— 那是被否定的行为，
 * 所以这里第 4 条断言的是「只有新事项显示，老事项仍保持已清除」。
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

  it('清除后消息中心为空，且重开仍为空', async () => {
    mockApi(makeStatus([{ id: '101', title: '登录偶发 500', days: 5 }]));
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('全部清除')).toBeTruthy());

    screen.getByText('全部清除').click();
    // 用户要求：清除之后消息中心为空，不存在任何内容
    await waitFor(() => expect(screen.getByText('暂无提醒')).toBeTruthy());
    expect(screen.queryByText('#101 待验证已 5 天')).toBeNull();

    // 重挂（从 localStorage 读回已读集合）仍为空
    cleanup();
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('暂无提醒')).toBeTruthy());
    expect(screen.queryByText('#101 待验证已 5 天')).toBeNull();
  });

  it('新事项照常显示，已清除的老事项不复活', async () => {
    mockApi(makeStatus([{ id: '101', title: '登录偶发 500', days: 5 }]));
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('全部清除')).toBeTruthy());
    screen.getByText('全部清除').click();
    await waitFor(() => expect(screen.getByText('暂无提醒')).toBeTruthy());

    // 出现新事项：只有新的显示，老的仍是已清除
    mockApi(makeStatus([
      { id: '101', title: '登录偶发 500', days: 5 },
      { id: '102', title: '导出超时', days: 2 },
    ]));
    cleanup();
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('#102 待验证已 2 天')).toBeTruthy());
    expect(screen.queryByText('#101 待验证已 5 天')).toBeNull();
  });

  it('「恢复已清除的提醒」把事项请回来', async () => {
    mockApi(makeStatus([{ id: '201', title: '上传失败', days: 9 }]));
    const { rerender } = render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('全部清除')).toBeTruthy());

    screen.getByText('全部清除').click();
    await waitFor(() => expect(screen.getByText('恢复已清除的提醒')).toBeTruthy());

    screen.getByText('恢复已清除的提醒').click();
    await waitFor(() => expect(screen.getByText('#201 待验证已 9 天')).toBeTruthy());

    // 落盘的已读集合也被清掉：重新打开列表仍在
    rerender(<NoticeCenter open={false} onClose={() => {}} onNavigate={() => {}} />);
    rerender(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('#201 待验证已 9 天')).toBeTruthy());
  });

  it('环境不可达事项同样可被清除', async () => {
    useEnvProbeStore.setState({
      results: { e1: { id: 'e1', url: 'http://192.0.2.10:8080', ok: false, error: '超时', ms: 1 } },
      at: Date.now(),
    });
    mockApi(makeStatus([]));
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);

    await waitFor(() => expect(screen.getByText('不可达：192.0.2.10:8080')).toBeTruthy());
    screen.getByText('全部清除').click();
    await waitFor(() => expect(screen.getByText('暂无提醒')).toBeTruthy());
  });

  it('已读集合有上限，不会无限增长', async () => {
    // 造 600 条事项，清除后落盘集合应被裁到 500 条以内
    const many = Array.from({ length: 600 }, (_, i) => ({ id: String(1000 + i), title: `t${i}`, days: 1 }));
    mockApi(makeStatus(many));
    render(<NoticeCenter open onClose={() => {}} onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText('全部清除')).toBeTruthy());
    screen.getByText('全部清除').click();
    await waitFor(() => expect(screen.getByText('暂无提醒')).toBeTruthy());

    const raw = localStorage.getItem('pm.notices.dismissed.v2');
    expect(raw).toBeTruthy();
    const keys = Object.keys(JSON.parse(raw as string).keys);
    expect(keys.length).toBeLessThanOrEqual(500);
  });
});
