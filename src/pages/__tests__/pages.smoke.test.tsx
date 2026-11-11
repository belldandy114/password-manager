// @vitest-environment jsdom
// 18 个页面此前 0 单测：这里只做「挂载不炸」的烟雾测试，防止页面在空数据/空权限下崩溃。
// 不测交互（交互由各工具层单测与打包版 UI 探针覆盖），所以刻意保持极简。
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ReactElement } from 'react';

import { Accounts } from '../../pages/Accounts';
import { ApiClient } from '../../pages/ApiClient';
import { CodeLab } from '../../pages/CodeLab';
import { Dashboard } from '../../pages/Dashboard';
import { DataGenerator } from '../../pages/DataGenerator';
import { Environments } from '../../pages/Environments';
import { ExportPage } from '../../pages/ExportPage';
import { ImportPage } from '../../pages/ImportPage';
import { Notes } from '../../pages/Notes';
import { PasswordManagerPage } from '../../pages/PasswordManagerPage';
import { PerfTest } from '../../pages/PerfTest';
import { Settings } from '../../pages/Settings';
import { Snippets } from '../../pages/Snippets';
import { Toolbox } from '../../pages/Toolbox';
import { TrashPage } from '../../pages/TrashPage';
import { WeeklyReport } from '../../pages/WeeklyReport';
import { ZentaoPage } from '../../pages/ZentaoPage';

const PAGES: Array<[string, () => ReactElement]> = [
  ['Accounts', Accounts],
  ['ApiClient', ApiClient],
  ['CodeLab', CodeLab],
  ['Dashboard', Dashboard],
  ['DataGenerator', DataGenerator],
  ['Environments', Environments],
  ['ExportPage', ExportPage],
  ['ImportPage', ImportPage],
  ['Notes', Notes],
  ['PasswordManagerPage', PasswordManagerPage],
  ['PerfTest', PerfTest],
  ['Settings', Settings],
  ['Snippets', Snippets],
  ['Toolbox', Toolbox],
  ['TrashPage', TrashPage],
  ['WeeklyReport', WeeklyReport],
  ['ZentaoPage', ZentaoPage],
];

// 任何 IPC 调用都回 { success: true, data: 空 }：页面在「还没解锁 / 还没有数据」时的状态，
// 是最容易崩的那个状态，也正是烟雾测试要覆盖的。
function stubElectronApi() {
  // 默认回 { success: false }：这是「还没解锁 / 环境不支持」时主进程的真实形态，
  // 页面必须能在这种结果下渲染（而不是假设 data 一定有内容）。
  const failIpc = () => Promise.resolve({ success: false, error: 'stub' });
  // onXxx / offXxx 这类订阅式接口不是 Promise，返回值会被当成退订函数调用
  const unsubscribe = () => () => {};
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy({} as Record<string, unknown>, {
    get(_obj, prop: string) {
      if (/^(on|off|once|remove|unsubscribe|subscribe)/i.test(prop)) return unsubscribe;
      return failIpc;
    },
  });
}

beforeAll(() => {
  stubElectronApi();
  // jsdom 没有这几个观察器 / 媒体查询，页面里用到会直接抛
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  class RO {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = RO;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
});

afterEach(() => cleanup());

describe.each(PAGES)('页面烟雾测试 %s', (_name, Page) => {
  it('空数据下挂载不抛错，且渲染出内容', () => {
    const { container } = render(<Page />);
    expect(container.firstChild).toBeTruthy();
    expect((container.textContent || '').length).toBeGreaterThan(0);
  });
});
