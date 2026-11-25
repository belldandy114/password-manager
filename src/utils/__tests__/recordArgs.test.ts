import { describe, it, expect } from 'vitest';
import {
  MAX_URL_LENGTH,
  QUERY_WHITELIST,
  ALLOWED_FLAGS,
  urlForStorage,
  urlForLaunch,
  validateUserDataDir,
  validateSelectorItems,
  buildChromeArgs,
  parseDevToolsActivePort,
} from '../../../electron/record-args.js';

/**
 * S2 · `electron/record-args.js`：录制域的 URL / flag / 端口文件白名单。
 *
 * 真源只有这一处（契约 `[C-114]`「校验真源只有一处」）：主进程 `ipc-record.js`
 * 与页内 `record-inject.js` 都不得另写一套规则。
 */

const UD = 'C:/Users/u/AppData/Roaming/password-manager/record-profiles/s1';

describe('record-args：URL 白名单与脱敏（[C-114] / [C-119] 第 5 款）', () => {
  it('http / https 通过，返回 origin + path 的 baseUrl', () => {
    const a = urlForStorage('http://example.com:8080/login?page=2');
    expect(a.ok).toBe(true);
    expect(a.origin).toBe('http://example.com:8080');
    expect(a.baseUrl).toBe('http://example.com:8080/login');
    expect(a.host).toBe('example.com:8080');
    expect(a.path).toBe('/login');

    const b = urlForStorage('https://example.com/');
    expect(b.ok).toBe(true);
    expect(b.baseUrl).toBe('https://example.com/');
  });

  it('拒绝 - 开头（命令行参数注入的前置条件）', () => {
    expect(urlForStorage('--remote-debugging-port=9222')).toMatchObject({ ok: false, error: 'URL 不合法' });
    expect(urlForStorage('  -x https://example.com').ok).toBe(false);
  });

  it('file / chrome / devtools / javascript 显式黑名单', () => {
    for (const bad of [
      'file:///C:/Windows/win.ini',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'chrome-extension://abc/popup.html',
      'view-source:https://example.com',
    ]) {
      expect(urlForStorage(bad), bad).toMatchObject({ ok: false, error: 'URL 不合法' });
    }
  });

  it('query：非白名单键**整条 query 丢弃**，不留键名、不留 <redacted> 占位（SEC-R2-02）', () => {
    const r = urlForStorage('https://example.com/login?token=abc123&page=2&access_token=xyz');
    expect(r.ok).toBe(true);
    // 命中凭据类键 → 整条 query 丢掉：键名本身泄露接口形态（与 v19 给 #fragment 的理由同口径）
    expect(r.url).toBe('https://example.com/login');
    expect(r.url).not.toContain('token');
    expect(r.url).not.toContain('redacted');
    expect(r.url).not.toContain('<');
    expect(r.url).not.toContain('abc123');
    expect(r.baseUrl).toBe('https://example.com/login');
    expect(QUERY_WHITELIST).not.toContain('token');
    expect(QUERY_WHITELIST).not.toContain('access_token');
  });

  it('query：全部命中白名单且值合法才保留原值', () => {
    const r = urlForStorage('https://example.com/list?page=2&tab=main&lang=zh-CN');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/list?page=2&tab=main&lang=zh-CN');
    expect(r.baseUrl).toBe('https://example.com/list');
  });

  it('自由文本 / 跳转目标键已移出白名单：from / q / keyword / filter / sort / view / mode', () => {
    for (const key of ['from', 'q', 'keyword', 'filter', 'sort', 'view', 'mode']) {
      expect(QUERY_WHITELIST, key).not.toContain(key);
      const r = urlForStorage(`https://example.com/p?${key}=x`);
      expect(r.ok, key).toBe(true);
      expect(r.url, key).toBe('https://example.com/p');
    }
  });

  it('query 值级校验：嵌套 URL / @ / 11–19 位纯数字 / 超 200 字一律整条丢弃（SEC-R2-01）', () => {
    const attacks: Array<[string, string]> = [
      // from 已移出白名单；这里用**仍在白名单**的键来证明值级校验独立生效
      ['https://example.com/p?page=http%3A%2F%2Fu%3Ap%40x%2F', 'u%3Ap'],
      ['https://example.com/p?from=http%3A%2F%2Fu%3Ap%40x%2F', 'from'],
      ['https://example.com/p?q=13800138000', '13800138000'],
      ['https://example.com/p?page=13800138000', '13800138000'],   // 手机号形态
      ['https://example.com/p?tab=110101199003074477', '110101199003074477'], // 身份证形态
      ['https://example.com/p?id=a@b.example.com', 'a@b'],
      ['https://example.com/p?page=' + 'a'.repeat(201), 'aaaa'],
    ];
    for (const [url, secret] of attacks) {
      const r = urlForStorage(url);
      expect(r.ok, url).toBe(true);
      expect(r.url, url).toBe('https://example.com/p');
      expect(r.url, url).not.toContain(secret);
    }
    // 边界：恰好 200 字的值仍然保留（不是一刀切）
    const okValue = 'a'.repeat(200);
    expect(urlForStorage(`https://example.com/p?page=${okValue}`).url).toBe(`https://example.com/p?page=${okValue}`);
  });

  it('剥掉 userinfo（username / password 一律丢弃）', () => {
    const r = urlForStorage('https://admin:p%40ss@example.com/login');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/login');
    expect(r.baseUrl).toBe('https://example.com/login');
    expect(r.url).not.toContain('admin');
    expect(r.url).not.toContain('@');
  });

  it(`长度边界：恰好 ${MAX_URL_LENGTH} 字通过，多 1 字拒绝`, () => {
    const head = 'https://example.com/';
    const atLimit = head + 'a'.repeat(MAX_URL_LENGTH - head.length);
    expect(atLimit.length).toBe(MAX_URL_LENGTH);
    expect(urlForStorage(atLimit).ok).toBe(true);

    const overLimit = head + 'a'.repeat(MAX_URL_LENGTH - head.length + 1);
    expect(overLimit.length).toBe(MAX_URL_LENGTH + 1);
    expect(urlForStorage(overLimit)).toMatchObject({ ok: false, error: 'URL 不合法' });
  });

  it('非字符串 / 空串 / 含 NUL 与换行一律拒', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, 'https://example.com/a\nb', 'https://example.com/a\u0000b']) {
      expect(urlForStorage(bad as unknown), String(bad)).toMatchObject({ ok: false, error: 'URL 不合法' });
    }
  });
});

describe('record-args：flag 正向白名单（SEC-09，不是黑名单三条）', () => {
  it('默认 args 是数组，含 --remote-debugging-port=0 与主进程拼的 --user-data-dir', () => {
    const r = buildChromeArgs({ url: 'https://example.com/', userDataDir: UD });
    expect(r.ok).toBe(true);
    const args = r.args as string[];
    expect(Array.isArray(args)).toBe(true);
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain(`--user-data-dir=${UD}`);
    expect(args[args.length - 1]).toBe('https://example.com/');
    // 不出现「先探端口再传参」的固定端口，也不出现 0.0.0.0
    expect(args.some((a) => /--remote-debugging-port=(?!0$)\d/.test(a))).toBe(false);
    expect(args.some((a) => a.includes('0.0.0.0'))).toBe(false);
  });

  it('白名单内的 flag 通过（枚举全集，正向放行）', () => {
    for (const flag of ALLOWED_FLAGS) {
      const sample = flag.valuePattern ? `${flag.name}=${flag.sample}` : flag.name;
      const r = buildChromeArgs({ url: 'https://example.com/', userDataDir: UD, flags: [sample] });
      expect(r.ok, sample).toBe(true);
      expect(r.args).toContain(sample);
    }
  });

  it('未登记的 flag 一律拒（正向白名单，不是黑名单三条）', () => {
    const dangerous = [
      '--no-sandbox',
      '--disable-web-security',
      '--remote-allow-origins=*',
      '--proxy-server=http://evil:8080',
      '--ignore-certificate-errors',
      '--load-extension=C:/evil',
      '--remote-debugging-address=0.0.0.0',
      '--user-data-dir=C:/other',
      '--enable-automation',
      '--some-future-flag',
      '--headless=new', // RA2-08：无头会话用户点不到页面，录制器的全部价值在真人点击 → 已从白名单移除
    ];
    for (const flag of dangerous) {
      expect(buildChromeArgs({ url: 'https://example.com/', userDataDir: UD, flags: [flag] }), flag)
        .toMatchObject({ ok: false, error: '浏览器启动被拦截' });
    }
  });

  it('白名单 flag 的值也必须匹配（--window-size 只接受 W,H）', () => {
    expect(buildChromeArgs({ url: 'https://example.com/', userDataDir: UD, flags: ['--window-size=1280,800'] }).ok).toBe(true);
    for (const bad of ['--window-size=1280', '--window-size=abc,def', '--window-size=1280,800;rm -rf /', '--window-size=']) {
      expect(buildChromeArgs({ url: 'https://example.com/', userDataDir: UD, flags: [bad] }), bad)
        .toMatchObject({ ok: false, error: '浏览器启动被拦截' });
    }
  });

  it('flag 里混入空白 / 换行 / 非字符串一律拒（args 数组仍是数组，绝不拼命令行）', () => {
    for (const bad of ['--headless=new ', '--headless=new\n--no-sandbox', '--headless=new --no-sandbox', 7, null]) {
      expect(buildChromeArgs({ url: 'https://example.com/', userDataDir: UD, flags: [bad as unknown] }))
        .toMatchObject({ ok: false, error: '浏览器启动被拦截' });
    }
  });

  it('userDataDir 必填且必须是绝对路径（--user-data-dir 只由主进程拼）', () => {
    for (const bad of ['', 'record-profiles/s1', './x', 'C:/x\n--no-sandbox', null]) {
      expect(buildChromeArgs({ url: 'https://example.com/', userDataDir: bad as unknown }))
        .toMatchObject({ ok: false });
    }
  });

  it('userDataDir 必须在应用数据目录下：拒 UNC / 拒 .. 逃逸 / 拒越界前缀（SEC-R2-03）', () => {
    const dataDir = 'C:/data/pm';
    const bad = [
      '\\\\share\\record\\s1',          // UNC：共享盘
      '//share/record/s1',              // UNC（正斜杠写法）
      'D:/OneDrive/record/s1',          // 数据目录之外
      'C:/data/pm-evil/record/s1',      // 前缀相同但不是子目录
      `${dataDir}/record-profiles/../../../Windows/Temp/s1`, // .. 逃逸
      'C:/Windows/Temp/s1',             // 系统临时目录
    ];
    for (const dir of bad) {
      expect(validateUserDataDir(dir, { dataDir }), dir).toMatchObject({ ok: false, error: '浏览器启动被拦截' });
      expect(buildChromeArgs({ url: 'https://example.com/', userDataDir: dir, dataDir }), dir)
        .toMatchObject({ ok: false, error: '浏览器启动被拦截' });
    }

    // 合法：数据目录下的 record-profiles/<id>
    const good = `${dataDir}/record-profiles/s1`;
    expect(validateUserDataDir(good, { dataDir })).toMatchObject({ ok: true, dir: good, containment: 'checked' });
    expect(buildChromeArgs({ url: 'https://example.com/', userDataDir: good, dataDir }).ok).toBe(true);
    // 反斜杠写法等价（Windows）
    expect(validateUserDataDir('C:\\data\\pm\\record-profiles\\s1', { dataDir }).ok).toBe(true);
    // 未注入 dataDir 时只能做「绝对路径 / UNC / ..」三项检查，containment 显式标 skipped（不得假装查过）
    expect(validateUserDataDir(good)).toMatchObject({ ok: true, containment: 'skipped' });
    expect(validateUserDataDir('\\\\share\\s1')).toMatchObject({ ok: false });
  });

  it('URL 非法时 buildChromeArgs 直接拒（不把非法 URL 交给 spawn）', () => {
    expect(buildChromeArgs({ url: 'file:///etc/passwd', userDataDir: UD }))
      .toMatchObject({ ok: false, error: 'URL 不合法' });
  });
});

describe('record-args：DevToolsActivePort 两行解析（[C-117] 第 1 条）', () => {
  it('正常两行：只回第一行端口（第二行指向 browser 端点，不回给调用方）', () => {
    const r = parseDevToolsActivePort('52345\n/devtools/browser/8f3a-11e9\n');
    expect(r).toMatchObject({ ok: true, port: 52345 });
    expect(Object.keys(r).sort()).toEqual(['ok', 'port']);
  });

  it('缺第二行 / 端口非数字 / 端口越界 / 空内容一律拒', () => {
    for (const bad of ['', '\n', '52345', '52345\n', 'abc\n/devtools/browser/x', '0\n/devtools/browser/x', '65536\n/devtools/browser/x', '-1\n/devtools/browser/x', '52345\nnot-a-path']) {
      expect(parseDevToolsActivePort(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
  });

  it('第二行仍做形状校验，但**不回**任何可连接地址（RA2-01 的防回退）', () => {
    const r = parseDevToolsActivePort('52345\r\n/devtools/browser/8f3a\r\n');
    expect(r.ok).toBe(true);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain('ws://');
    expect(dump).not.toContain('devtools/browser');
    expect((r as unknown as Record<string, unknown>).wsUrl).toBeUndefined();
    expect((r as unknown as Record<string, unknown>).wsPath).toBeUndefined();
  });

  it('wsPath 只认 /devtools/<安全字符>：拒 ..、拒 ?、拒空白（SEC-R2-11）', () => {
    for (const badPath of [
      '/devtools/browser/../../etc/passwd',
      '/devtools/browser/x?token=1',
      '/devtools/browser/x y',
      '/devtools/browser/x#frag',
      '/devtools/browser/%2e%2e/x',
      '/json/version',
    ]) {
      expect(parseDevToolsActivePort(`52345\n${badPath}`), badPath).toMatchObject({ ok: false });
    }
    expect(parseDevToolsActivePort('52345\n/devtools/browser/8f3a-11e9_ab.c').ok).toBe(true);
  });
});


// ---------------------------------------------------------------- t20 / RA2 新增

describe('record-args：启动 URL 与入库 URL 必须拆开（RA2-03）', () => {
  it('urlForLaunch 保留业务 query 与 fragment，只剥 userinfo', () => {
    const r = urlForLaunch('https://admin:pw@example.com/login?projectCode=ABC&from=uitest#/step/2');
    expect(r.ok).toBe(true);
    const url = String(r.url);
    expect(url).toContain('projectCode=ABC');      // 业务参数必须保留，否则被测系统打开坏链接
    expect(url).toContain('from=uitest');
    expect(url).toContain('#/step/2');             // SPA 路由片段也要保留
    expect(url).not.toContain('admin');
    expect(url).not.toContain('pw@');
    expect(String(r.host)).toBe('example.com');
  });

  it('urlForLaunch 只做安全校验：拒危险 scheme / 拒 - 开头 / 拒超长 / 拒控制字符', () => {
    for (const bad of ['file:///C:/Windows/win.ini', 'chrome://settings', 'devtools://x', 'javascript:alert(1)', '--remote-debugging-port=1']) {
      expect(urlForLaunch(bad), bad).toMatchObject({ ok: false, error: 'URL 不合法' });
    }
    const long = 'https://example.com/' + 'a'.repeat(MAX_URL_LENGTH);
    expect(long.length).toBeGreaterThan(MAX_URL_LENGTH);
    expect(urlForLaunch(long)).toMatchObject({ ok: false, error: 'URL 不合法' });
    expect(urlForLaunch('https://example.com/a\nb')).toMatchObject({ ok: false, error: 'URL 不合法' });
  });

  it('urlForStorage 对同一个 URL 做脱敏：业务 query 不在白名单 → 整条丢、fragment 也丢', () => {
    const r = urlForStorage('https://admin:pw@example.com/login?projectCode=ABC&from=uitest#/step/2');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://example.com/login');
    expect(r.baseUrl).toBe('https://example.com/login');
    expect(String(r.url)).not.toContain('projectCode');
    expect(String(r.url)).not.toContain('#');
  });

  it('buildChromeArgs 的导航参数用**启动版**（有业务 query），不是脱敏版', () => {
    const dir = 'C:/data/pm/record-profiles/s1';
    const r = buildChromeArgs({ url: 'https://example.com/login?projectCode=ABC', userDataDir: dir, dataDir: 'C:/data/pm' });
    expect(r.ok).toBe(true);
    const args = r.args as string[];
    expect(args[args.length - 1]).toBe('https://example.com/login?projectCode=ABC');
    expect(args.join(' ')).not.toContain('<redacted>');
  });
});

describe('record-args：DevToolsActivePort 不许回可连接的 browser ws（t19 反哺）', () => {
  it('返回值里出现 ws:// 或 devtools/browser 即红（防回退）', () => {
    const r = parseDevToolsActivePort('52345\n/devtools/browser/8f3a-11e9');
    expect(r.ok).toBe(true);
    expect(r.port).toBe(52345);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain('ws://');
    expect(dump).not.toContain('devtools/browser');
    // 只有端口可用：目标发现是 cdp-client 的职责（自己 GET /json/list）
    expect(Object.keys(r).sort()).toEqual(['ok', 'port']);
  });
});

describe('record-args：selector 校验真源已搬到这里（RA2-06）', () => {
  it('合法入参原样返回', () => {
    expect(validateSelectorItems([{ strategy: 'css', selector: '#login' }])).toEqual({
      ok: true,
      items: [{ strategy: 'css', selector: '#login' }],
    });
    expect(validateSelectorItems([])).toEqual({ ok: true, items: [] });
  });

  it('非数组 / >50 条 / 非法策略 / 缺 selector / >500 字 / 含 NUL 或换行 → 入参不合法', () => {
    const many = Array.from({ length: 51 }, () => ({ strategy: 'css', selector: '#a' }));
    const bads: unknown[] = [
      null,
      'x',
      many,
      [{ strategy: 'jquery', selector: '#a' }],
      [{ strategy: 'css' }],
      [{ strategy: 'css', selector: '' }],
      [{ strategy: 'css', selector: 'a'.repeat(501) }],
      [{ strategy: 'css', selector: 'a\nb' }],
      [{ strategy: 'css', selector: 'a\u0000b' }],
      [{ strategy: 'css', selector: '#a' }, { strategy: 'nope', selector: '#b' }],
    ];
    for (const bad of bads) {
      expect(validateSelectorItems(bad as never), JSON.stringify(bad)?.slice(0, 50)).toEqual({ ok: false, error: '入参不合法' });
    }
  });
});
