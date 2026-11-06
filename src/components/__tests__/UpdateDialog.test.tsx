// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { UpdateDialog } from '../UpdateDialog';

/**
 * 更新弹窗的核心约定：
 *  1. 一打开就展示更新内容，并自动开始下载（不用再去设置页点两次）
 *  2. 下载成功后给出「安装并重启」与可取消的自动安装
 *  3. 没有安装包直链 / 下载失败时有兜底出口
 */

type Api = Record<string, unknown>;

function mockApi(overrides: Api = {}): Api {
  const api: Api = {
    onUpdateProgress: () => () => {},
    updateCheck: vi.fn(async () => ({ success: false, error: 'offline' })),
    updateDownload: vi.fn(async () => ({
      success: true,
      data: { file: 'C:\\tmp\\Setup.exe', size: 1024, verified: true },
    })),
    updateInstall: vi.fn(async () => ({ success: true })),
    updatePickFile: vi.fn(async () => ({ success: false, canceled: true })),
    browserOpen: vi.fn(),
    ...overrides,
  };
  (window as unknown as { electronAPI: Api }).electronAPI = api;
  return api;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseInfo = {
  current: '1.18.0',
  latest: '1.19.0',
  url: 'https://example.com/releases/tag/v1.19.0',
  downloadUrl: 'https://example.com/Setup.exe',
  notes: '## 本次更新\n- 一键更新\n- 修复若干问题',
};

describe('UpdateDialog', () => {
  it('一打开就展示更新内容并自动开始下载', async () => {
    const api = mockApi();
    render(<UpdateDialog open info={baseInfo} onClose={() => {}} />);

    expect(screen.getByText('发现新版本 v1.19.0')).toBeTruthy();
    expect(screen.getByText('一键更新')).toBeTruthy();
    expect(screen.getByText('当前 v1.18.0')).toBeTruthy();

    await waitFor(() => expect(api.updateDownload).toHaveBeenCalledTimes(1));
    expect((api.updateDownload as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(baseInfo.downloadUrl);
  });

  it('下载完成后给出「安装并重启」和可取消的自动安装', async () => {
    mockApi();
    render(<UpdateDialog open info={baseInfo} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /安装并重启/ })).toBeTruthy());
    expect(screen.getByRole('button', { name: '暂不安装' })).toBeTruthy();
    expect(screen.getByText(/SHA-256 已校验/)).toBeTruthy();
  });

  it('启动推送没带更新说明时，自动补一次检查再展示', async () => {
    const api = mockApi({
      updateCheck: vi.fn(async () => ({
        success: true,
        data: { ...baseInfo, notes: '## 补回来的说明\n- 服务端拉到的内容' },
      })),
    });
    render(
      <UpdateDialog
        open
        info={{ current: '1.18.0', latest: '1.19.0', url: baseInfo.url }}
        onClose={() => {}}
      />,
    );

    await waitFor(() => expect(api.updateCheck).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('服务端拉到的内容')).toBeTruthy());
  });

  it('没有安装包直链时给「打开发布页」出口，不强行下载', async () => {
    const api = mockApi();
    render(
      <UpdateDialog
        open
        info={{ current: '1.18.0', latest: '1.19.0', url: baseInfo.url, notes: '只有说明没有包' }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: /打开发布页/ })).toBeTruthy();
    expect(api.updateDownload).not.toHaveBeenCalled();
  });

  it('下载失败时展示原因与兜底按钮', async () => {
    mockApi({
      updateDownload: vi.fn(async () => ({ success: false, error: '网络连接被重置', canMirror: true })),
    });
    render(<UpdateDialog open info={baseInfo} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('网络连接被重置')).toBeTruthy());
    expect(screen.getByRole('button', { name: '浏览器下载' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '选择本地安装包' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /换镜像重试/ })).toBeTruthy();
  });

  it('关掉再打开同一版本不会重复下载', async () => {
    const api = mockApi();
    const { rerender } = render(<UpdateDialog open info={baseInfo} onClose={() => {}} />);
    await waitFor(() => expect(api.updateDownload).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button', { name: /安装并重启/ })).toBeTruthy());

    rerender(<UpdateDialog open={false} info={baseInfo} onClose={() => {}} />);
    rerender(<UpdateDialog open info={baseInfo} onClose={() => {}} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /安装并重启/ })).toBeTruthy());
    expect(api.updateDownload).toHaveBeenCalledTimes(1);
  });
});
