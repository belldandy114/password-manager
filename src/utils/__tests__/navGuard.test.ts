import { describe, expect, it } from 'vitest';
import {
  decideWindowOpen,
  inspectWebviewAttach,
  isAllowedMainNavigation,
  isAllowedWebviewNavigation,
  isWithinDir,
  toLocalPath,
} from '../../../electron/nav-guard.js';

const DIST = 'C:\\app\\resources\\app.asar\\dist';
const TDG_DIST = 'C:\\app\\resources\\app.asar.unpacked\\dist-tdg';
const TDG_PRELOAD = 'C:\\app\\resources\\app.asar\\electron\\preload-tdg.cjs';

const prod = () => ({ dev: false, distDir: DIST, tdgDistDir: TDG_DIST, tdgPreloadPath: TDG_PRELOAD });
const dev = () => ({ dev: true, distDir: DIST, tdgDistDir: TDG_DIST, tdgPreloadPath: TDG_PRELOAD });

const fileUrl = (p: string) => 'file:///' + p.replace(/\\/g, '/').replace(/^\//, '');

describe('toLocalPath', () => {
  it('把 file:/// URL 还原成 Windows 路径', () => {
    expect(toLocalPath(fileUrl(DIST + '\\index.html'))).toBe(DIST + '\\index.html');
  });

  it('还原中文路径的百分号编码', () => {
    expect(toLocalPath('file:///C:/%E6%B5%8B%E8%AF%95/index.html')).toBe('C:\\测试\\index.html');
  });

  it('裸路径原样返回', () => {
    expect(toLocalPath('/home/x/index.html')).toBe('/home/x/index.html');
  });

  it('空值返回空串', () => {
    expect(toLocalPath('')).toBe('');
    expect(toLocalPath(null)).toBe('');
  });
});

describe('isWithinDir', () => {
  it('目录自身算在内', () => {
    expect(isWithinDir(DIST, DIST)).toBe(true);
  });

  it('子路径算在内，且大小写不敏感、斜杠方向不敏感', () => {
    expect(isWithinDir('c:/APP/resources/app.asar/dist/assets/a.js', DIST)).toBe(true);
  });

  it('前缀相同但不在目录内不算', () => {
    expect(isWithinDir('C:\\app\\dist2\\x.js', DIST)).toBe(false);
  });

  it('父目录不算', () => {
    expect(isWithinDir('C:\\app\\resources', DIST)).toBe(false);
  });

  it('空参数不算', () => {
    expect(isWithinDir('', DIST)).toBe(false);
    expect(isWithinDir(DIST, '')).toBe(false);
  });
});

describe('isAllowedMainNavigation（打包态）', () => {
  it('放行 dist 下的页面', () => {
    expect(isAllowedMainNavigation(fileUrl(DIST + '\\index.html'), prod())).toBe(true);
  });

  it('放行 dist 下的 hash 路由', () => {
    expect(isAllowedMainNavigation(fileUrl(DIST + '\\index.html') + '#/notes', prod())).toBe(true);
  });

  it('拦下 dist 之外的本机文件', () => {
    expect(isAllowedMainNavigation('file:///C:/Windows/System32/drivers/etc/hosts', prod())).toBe(false);
    expect(isAllowedMainNavigation('file:///C:/Users/me/Desktop/secret.txt', prod())).toBe(false);
  });

  it('拦下外部 http(s)', () => {
    expect(isAllowedMainNavigation('https://example.com/', prod())).toBe(false);
    expect(isAllowedMainNavigation('http://127.0.0.1:8080/', prod())).toBe(false);
  });

  it('拦下危险协议', () => {
    expect(isAllowedMainNavigation('javascript:alert(1)', prod())).toBe(false);
    expect(isAllowedMainNavigation('data:text/html,<h1>x</h1>', prod())).toBe(false);
  });

  it('放行 about:blank（窗口初始化值）', () => {
    expect(isAllowedMainNavigation('about:blank', prod())).toBe(true);
  });
});

describe('isAllowedMainNavigation（开发态）', () => {
  it('只放行 localhost:5173 同源', () => {
    expect(isAllowedMainNavigation('http://localhost:5173/', dev())).toBe(true);
    expect(isAllowedMainNavigation('http://localhost:5173/#/notes', dev())).toBe(true);
  });

  it('拦下同机其它端口', () => {
    expect(isAllowedMainNavigation('http://localhost:5174/', dev())).toBe(false);
    expect(isAllowedMainNavigation('http://localhost:8080/', dev())).toBe(false);
  });

  it('开发态也不再放行外部站点', () => {
    expect(isAllowedMainNavigation('https://example.com/', dev())).toBe(false);
  });
});

describe('isAllowedWebviewNavigation', () => {
  it('打包态放行 dist-tdg', () => {
    expect(isAllowedWebviewNavigation(fileUrl(TDG_DIST + '\\index.html'), prod())).toBe(true);
  });

  it('打包态放行 tdg: 协议（只服务 dist-tdg）', () => {
    expect(isAllowedWebviewNavigation('tdg://app/index.html', prod())).toBe(true);
  });

  it('打包态拦下 dist 之外的 file', () => {
    expect(isAllowedWebviewNavigation(fileUrl('C:\\Windows\\win.ini'), prod())).toBe(false);
  });

  it('开发态只放行 localhost:5174', () => {
    expect(isAllowedWebviewNavigation('http://localhost:5174/', dev())).toBe(true);
    expect(isAllowedWebviewNavigation('http://localhost:5173/', dev())).toBe(false);
  });

  it('拦下外部站点与 about:blank 以外的伪协议', () => {
    expect(isAllowedWebviewNavigation('https://evil.example/', prod())).toBe(false);
    expect(isAllowedWebviewNavigation('javascript:alert(1)', prod())).toBe(false);
  });
});

describe('decideWindowOpen', () => {
  it('http(s) 一律拒绝新窗口，并交回外部地址', () => {
    expect(decideWindowOpen('https://example.com/a')).toEqual({
      action: 'deny',
      external: 'https://example.com/a',
    });
  });

  it('其它协议只拒绝，不外转', () => {
    expect(decideWindowOpen('file:///C:/Windows/win.ini')).toEqual({ action: 'deny' });
    expect(decideWindowOpen('javascript:alert(1)')).toEqual({ action: 'deny' });
    expect(decideWindowOpen('about:blank')).toEqual({ action: 'deny' });
  });

  it('空值也只拒绝', () => {
    expect(decideWindowOpen('')).toEqual({ action: 'deny' });
  });
});

describe('inspectWebviewAttach', () => {
  it('放行官方 src + 官方 preload', () => {
    const r = inspectWebviewAttach(
      { src: fileUrl(TDG_DIST + '\\index.html'), preload: fileUrl(TDG_PRELOAD) },
      prod(),
    );
    expect(r.allow).toBe(true);
    expect(r.sanitizedPreload).toBe(fileUrl(TDG_PRELOAD));
    expect(r.preloadRemoved).toBe(false);
  });

  it('src 在白名单内但 preload 不是官方的 → 剥掉 preload 而不是整体拒绝', () => {
    const r = inspectWebviewAttach(
      { src: fileUrl(TDG_DIST + '\\index.html'), preload: 'C:\\evil\\payload.js' },
      prod(),
    );
    expect(r.allow).toBe(true);
    expect(r.sanitizedPreload).toBeUndefined();
    expect(r.preloadRemoved).toBe(true);
  });

  it('src 不在白名单 → 整体拒绝并给出原因', () => {
    const r = inspectWebviewAttach({ src: 'https://evil.example/' }, prod());
    expect(r.allow).toBe(false);
    expect(r.reason).toContain('https://evil.example/');
  });

  it('没有 src（about:blank）放行，preload 被剥掉', () => {
    const r = inspectWebviewAttach({ src: 'about:blank' }, prod());
    expect(r.allow).toBe(true);
    expect(r.sanitizedPreload).toBeUndefined();
  });

  it('裸路径形式的 preload 也能认出来', () => {
    const r = inspectWebviewAttach({ src: fileUrl(TDG_DIST + '\\index.html'), preload: TDG_PRELOAD }, prod());
    expect(r.sanitizedPreload).toBe(TDG_PRELOAD);
  });
});
