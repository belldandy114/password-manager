// @vitest-environment jsdom
// P2 三项体验（1.30.1）的常驻回归护栏。
// 由来：这三条行为交付时只有一个一次性探针（已删），改样式/改页面时没有任何东西会拦住回归。
// 这里只断言「用户能感知的行为」，不断言内部实现：
//   1) 工作台零数据时首屏只留 1 个空态容器，有 1 条待办时三张面板全部回来；
//   2) 侧栏分组折叠写进 localStorage、重新挂载后保持、坏数据回落全展开；
//   3) 「笔记与附件」主入口恢复上次页签，显式附件入口不被记忆覆盖。
// mock 方式照 pages.smoke.test.tsx：window.electronAPI 整体打桩成「IPC 一律失败」，
// 这正好是「还没解锁 / 还没有数据」时主进程的真实形态，也是空数据路径的入口。
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';

import { Home } from '../Home';
import { Sidebar } from '../../components/Sidebar';
import { NotesAttachments } from '../NotesAttachments';
import { useZentaoStore } from '../../store/zentaoStore';

// 任何 IPC 调用都回 { success: false }：页面必须能在「没数据」时渲染
function stubElectronApi() {
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
    takeRecords() { return []; }
  };
});

beforeEach(() => {
  localStorage.clear();
  // 缺陷数据来自 zentaoStore（模块级单例），每个用例先清空，避免互相污染
  useZentaoStore.setState({ bugs: [], fetchedAt: '' });
});
afterEach(() => cleanup());

/* ============================ 1. 工作台空态收敛 ============================ */

describe('P2-1 工作台空态收敛', () => {
  it('零数据：首屏只渲染 1 个 .home-empty，且合并空态的入口都在', async () => {
    const { container } = render(<Home />);
    // 等异步汇总（wsGet / backupList 全部失败）跑完，页面进入稳定零数据态
    await waitFor(() => expect(container.querySelectorAll('.home-panel').length).toBeGreaterThan(0));

    // 核心断言：三张待办面板的空态合并成 1 个容器（改回三张独立空态 → 立刻变 3）
    expect(container.querySelectorAll('.home-empty').length).toBe(1);
    // 合并态存在：三个原始面板标题都不再单独出现
    expect(container.textContent).not.toContain('缺陷待办');
    expect(container.textContent).not.toContain('环境不可达');
    expect(container.textContent).not.toContain('接口回归');
    // 空态没有压掉入口：主行动 + 三个页面跳转 + 整板空时的两个入口
    for (const name of ['去拉取缺陷', '缺陷管理', '环境矩阵', '接口调试', '网址管理', '笔记']) {
      expect(screen.getAllByRole('button', { name }).length, `入口「${name}」不见了`).toBeGreaterThan(0);
    }
  });

  it('有 1 条未关闭缺陷：缺陷待办 / 环境不可达 / 接口回归三张面板全部重现', async () => {
    useZentaoStore.setState({
      bugs: [{
        id: 42, title: '登录偶发 500', status: 'active', severity: '1',
        openedDate: '2026-11-20', assignedTo: 'me',
      }] as never,
      fetchedAt: new Date().toISOString(),
    });

    const { container } = render(<Home />);
    await waitFor(() => expect(container.textContent).toContain('缺陷待办'));

    // 三张面板按原样回来（不是合并态）
    expect(container.textContent).toContain('缺陷待办');
    expect(container.textContent).toContain('环境不可达');
    expect(container.textContent).toContain('接口回归');
    // 清单行与徽章也是真的渲染出来了，不只是标题
    expect(container.textContent).toContain('登录偶发 500');
    expect(container.textContent).toContain('1 个未关闭');
    // 合并态的入口不再出现（有数据时不该同时存在两套待办 UI）
    expect(screen.queryByRole('button', { name: '去拉取缺陷' })).toBeNull();
  });
});

/* ========================== 2. 侧栏分组折叠记忆 =========================== */

describe('P2-2 侧栏分组折叠记忆', () => {
  const sidebarProps = { currentPage: 'home', onNavigate: () => {}, onLock: () => {}, onNotices: () => {} };
  const groupTitles = () => Array.from(document.querySelectorAll('.sidebar-group-title')) as HTMLElement[];

  it('点击分组标题折叠：写 localStorage 键 pm.sidebar.collapsed，重新挂载后保持折叠', () => {
    const first = render(<Sidebar {...sidebarProps} />);
    // 首屏默认全部展开
    expect(groupTitles().length).toBe(4);
    expect(groupTitles().every(t => t.getAttribute('aria-expanded') === 'true')).toBe(true);
    // 键盘可达：标题行是原生 button，Enter/Space 天然可用
    expect(groupTitles()[1].tagName).toBe('BUTTON');

    fireEvent.click(groupTitles()[1]); // 折叠「测试工作」
    expect(groupTitles()[1].getAttribute('aria-expanded')).toBe('false');
    // 键名 + 键值都锁死：存储格式变了就红
    expect(JSON.parse(localStorage.getItem('pm.sidebar.collapsed') || '{}')).toEqual({ 测试工作: true });
    first.unmount();

    // 模拟「重新打开应用」：重新挂载，折叠状态必须从 localStorage 恢复
    render(<Sidebar {...sidebarProps} />);
    expect(groupTitles()[1].getAttribute('aria-expanded')).toBe('false');
    expect(groupTitles()[0].getAttribute('aria-expanded')).toBe('true');
    // 折叠后该组不再渲染导航项
    const collapsedGroup = document.querySelectorAll('.sidebar-group')[1];
    expect(collapsedGroup.querySelectorAll('.nav-item').length).toBe(0);
  });

  it('坏值（null / 数组 / 非 JSON / 截断对象）读取不抛错并回落全展开', () => {
    for (const bad of ['null', '[]', 'oops', '{oops']) {
      localStorage.setItem('pm.sidebar.collapsed', bad);
      const { unmount } = render(<Sidebar {...sidebarProps} />);
      expect(groupTitles().length, `坏值 ${bad} 下分组数量不对`).toBe(4);
      expect(groupTitles().every(t => t.getAttribute('aria-expanded') === 'true'), `坏值 ${bad} 没有回落全展开`).toBe(true);
      unmount();
    }
  });
});

/* ========================= 3. 合并页记住上次页签 ========================== */

describe('P2-3 合并页记住上次页签', () => {
  /** 当前选中的页签文字（`.tab2.is-active` 就是渲染出来的选中态） */
  const activeTab = () => {
    const tab = document.querySelector('.tab2.is-active');
    return tab ? (tab.textContent || '').trim() : '';
  };

  it('主入口（initialScope=notes）恢复上次页签：记忆为附件 → 落附件管理', () => {
    localStorage.setItem('pm.notes.scope', 'attachments');
    const app = render(<NotesAttachments initialScope="notes" />);
    // 「记忆优先于主入口默认页签」—— 这条红了说明记忆被忽略
    expect(activeTab()).toContain('附件管理');
    app.unmount();
  });

  it('显式 initialScope=attachments 不被记忆覆盖：记忆为 notes 也落附件管理', () => {
    localStorage.setItem('pm.notes.scope', 'notes');
    const app = render(<NotesAttachments initialScope="attachments" />);
    // 「显式入口优先于记忆」—— 这条红了说明用户点附件管理却被送去笔记
    expect(activeTab()).toContain('附件管理');
    app.unmount();
  });

  it('完整回路：主入口里切到附件 → 重新挂载（等同刷新/再进）→ 仍落附件管理', () => {
    const first = render(<NotesAttachments initialScope="notes" />);
    fireEvent.click(screen.getByRole('tab', { name: /附件管理/ }));
    first.unmount();

    const again = render(<NotesAttachments initialScope="notes" />);
    expect(activeTab()).toContain('附件管理');
    again.unmount();
  });

  it('页签切换会写入记忆；坏值回落主入口默认的测试笔记', () => {
    const app = render(<NotesAttachments />);
    expect(activeTab()).toBe('测试笔记');
    fireEvent.click(screen.getByRole('tab', { name: /附件管理/ }));
    expect(activeTab()).toContain('附件管理');
    expect(localStorage.getItem('pm.notes.scope')).toBe('attachments');
    app.unmount();

    // 坏值不该把页面顶到空页签
    localStorage.setItem('pm.notes.scope', 'oops');
    const again = render(<NotesAttachments />);
    expect(activeTab()).toBe('测试笔记');
    again.unmount();
  });
});
