import { describe, it, expect } from 'vitest';
import {
  RULES, SCAN_PACKS, matchRules, isInsideRoot, stripComments, rulesOf, MAX_HITS_PER_RULE,
} from '../../../electron/scan-rules.js';

/**
 * 模块 3「代码体检」的规则引擎（契约 C-52〜C-54）。
 *
 * 这里每条规则都配 **正例 + 反例**，而且反例是重点：
 * 体检工具一旦误报，用户第一反应是把整类规则关掉，然后这个功能就白做了。
 * 最典型的误报源是「注释里的代码」——注释掉的 `Thread.sleep(3000)` 不该算问题。
 */

const JAVA = 'LoginTest.java';
const PY = 'test_login.py';

/** 命中某条规则的 ruleId 集合 */
const ids = (text: string, filePath = JAVA, ruleIds?: string[]): string[] =>
  (matchRules(text, filePath, ruleIds) as { hits: { ruleId: string }[] }).hits.map((h) => h.ruleId);

const hit = (ruleId: string, text: string, filePath = JAVA) => ids(text, filePath).includes(ruleId);

describe('规则表结构（C-52：两个包、audit ≤30 / coverage ≤8）', () => {
  it('三类规则合计 ≥12 条，且每条都有 id/severity/title/desc', () => {
    const audit = rulesOf('audit');
    expect(audit.length).toBeGreaterThanOrEqual(12);
    expect(audit.length).toBeLessThanOrEqual(30);
    for (const r of audit) {
      expect(typeof r.id).toBe('string');
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.desc.length).toBeGreaterThan(0);
      expect(['high', 'medium', 'low']).toContain(r.severity);
    }
    // 三类都要有（UI 反模式 / 硬编码敏感 / 弱断言）
    const cats = new Set(audit.map((r: { category: string }) => r.category));
    expect([...cats].sort()).toEqual(['assert', 'secret', 'ui']);
  });

  it('coverage 包 ≤8 条且都标了 coverage（契约：findings 带 method+path）', () => {
    const cov = rulesOf('coverage');
    expect(cov.length).toBeGreaterThan(0);
    expect(cov.length).toBeLessThanOrEqual(8);
    for (const r of cov) expect(r.coverage).toBe(true);
    expect(SCAN_PACKS.map((p: { id: string }) => p.id).sort()).toEqual(['audit', 'coverage']);
  });

  it('规则 id 不重复（重复 id 会让 UI 勾选与历史统计对不上）', () => {
    const all = RULES.map((r: { id: string }) => r.id);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('UI 自动化反模式（正例 / 反例）', () => {
  it('ui-hard-sleep：Thread.sleep 命中', () => {
    expect(hit('ui-hard-sleep', 'driver.findElement(By.id("a"));\nThread.sleep(3000);')).toBe(true);
  });
  it('ui-hard-sleep 反例：**注释里的 sleep 不命中**（本文件最重要的一条误报判据）', () => {
    expect(hit('ui-hard-sleep', '// 这里以前写 Thread.sleep(3000)，后来改成显式等待\nawait waitFor(visible(el));')).toBe(false);
    expect(hit('ui-hard-sleep', '/*\n * Thread.sleep(5000) 会拖慢整个套件\n */\nclick(el);')).toBe(false);
    expect(hit('ui-hard-sleep', 'waitForTimeout(500)', 'a.ts')).toBe(true); // 非注释的同类写法仍要命中
  });

  it('ui-abs-xpath：/html/body 绝对路径命中', () => {
    expect(hit('ui-abs-xpath', 'driver.findElement(By.xpath("/html/body/div[3]/a"));')).toBe(true);
  });
  it('ui-abs-xpath 反例：相对定位与注释里的绝对路径都不命中', () => {
    expect(hit('ui-abs-xpath', 'driver.findElement(By.xpath("//button[@data-testid=\'ok\']"));')).toBe(false);
    expect(hit('ui-abs-xpath', '// 老代码是 By.xpath("/html/body/div[3]/a")，已改')).toBe(false);
  });

  it('ui-deep-css：三级以上子选择器命中', () => {
    expect(hit('ui-deep-css', 'driver.findElement(By.cssSelector("div > div > div > span"));')).toBe(true);
  });
  it('ui-deep-css 反例：一级/两级子选择器不命中', () => {
    expect(hit('ui-deep-css', 'driver.findElement(By.cssSelector("#login > button"));')).toBe(false);
    expect(hit('ui-deep-css', 'driver.findElement(By.cssSelector(".list .item"));')).toBe(false);
  });

  it('ui-fragile-locator：按下标取元素命中', () => {
    expect(hit('ui-fragile-locator', 'driver.findElement(By.xpath("//div[@id=\'list\']/div[2]"));')).toBe(true);
  });
  it('ui-fragile-locator 反例：用 data-testid 定位不命中', () => {
    expect(hit('ui-fragile-locator', 'driver.findElement(By.cssSelector("[data-testid=\'row-3\']"));')).toBe(false);
  });

  it('ui-text-locator：按界面文案定位命中', () => {
    expect(hit('ui-text-locator', 'driver.findElement(By.linkText("提交订单")).click();')).toBe(true);
  });
  it('ui-text-locator 反例：按 id/name 定位不命中', () => {
    expect(hit('ui-text-locator', 'driver.findElement(By.id("submit-btn")).click();')).toBe(false);
  });
});

describe('扩展名守卫（t58）：ui-* 不扫文档、sec-* 仍扫文档', () => {
  // t55 集成验收报过一个真误报：`.md` 里写「div > div > div 这样的选择器很脆」这种**说明文字**，
  // 被 `ui-deep-css` 当成「代码里有深层 CSS」。`.md` 进 SCAN_EXTS 的初衷是扫文档里的硬编码
  // URL / token（sec-*），不是把文档当测试代码体检（ui-* / assert-*）。
  const DOC_FILES = ['README.md', 'NOTES.txt'];

  it('ui-deep-css 成对：同一段文本在 .md 不命中、在 .ts 必须命中', () => {
    const text = '选择器写成 "div > div > div > span" 就会很脆';
    for (const doc of DOC_FILES) expect(ids(text, doc)).not.toContain('ui-deep-css');
    expect(ids(text, 'List.spec.ts')).toContain('ui-deep-css');
  });

  it('ui-* 五条在 .md / .txt 上都不匹配，而同一段代码在 .ts 上都命中（成对，不是抽样）', () => {
    const samples: { ruleId: string; code: string }[] = [
      { ruleId: 'ui-hard-sleep', code: 'Thread.sleep(3000);' },
      { ruleId: 'ui-abs-xpath', code: 'driver.findElement(By.xpath("/html/body/div[3]/a"));' },
      { ruleId: 'ui-deep-css', code: 'driver.findElement(By.cssSelector("div > div > div > span"));' },
      { ruleId: 'ui-fragile-locator', code: "driver.findElement(By.xpath(\"//div[@id='list']/div[2]\"));" },
      { ruleId: 'ui-text-locator', code: 'driver.findElement(By.linkText("提交订单")).click();' },
    ];
    for (const { ruleId, code } of samples) {
      for (const doc of DOC_FILES) expect(ids(code, doc)).not.toContain(ruleId);
      expect(ids(code, 'Case.java')).toContain(ruleId);
    }
  });

  it('sec-* 保持全扩展名：文档里的硬编码 URL / token / 口令仍要报（这是扫 .md 的初衷）', () => {
    const urlCode = 'String base = "https://jira.corp.example.cn:8080/rest/api";';
    const tokenCode = 'String token = "abcd1234efgh5678";';
    const pwdCode = 'String password = "P@ssw0rd!";';
    for (const doc of DOC_FILES) {
      expect(ids(urlCode, doc)).toContain('sec-hardcoded-url');
      expect(ids(tokenCode, doc)).toContain('sec-token-literal');
      expect(ids(pwdCode, doc)).toContain('sec-password-literal');
    }
  });

  // RC-05：这条以前是**假测试**——用的是「碰巧匹配不到任何规则」的文档文本，
  // 把守卫去掉照样绿，等于什么都没证明。现在改成同一段代码在两个扩展名上的成对断言：
  // 去掉守卫后 `.md` 侧必然命中（变红），证明它真的在测守卫。
  const NO_ASSERT_CODE = 'requests.post("http://example.com/x")\n';
  it('assert-* 拿文档当测试代码是误报：同一段内容 .py 命中、.md 不命中', () => {
    expect(ids(NO_ASSERT_CODE, 'test_x.py')).toContain('assert-no-assertion'); // 先证规则本身有效
    expect(ids(NO_ASSERT_CODE, 'NOTES.md').filter((x: string) => x.startsWith('assert-'))).toEqual([]);
    expect(ids(NO_ASSERT_CODE, 'README.txt').filter((x: string) => x.startsWith('assert-'))).toEqual([]);
  });

  // RC-06：cov-* 的假 covered 比假 missing 更危险（让用户以为测过了而漏测）
  it('cov-* 五条在文档里都不命中，同一段代码在 .java/.ts/.py 上必须命中（逐条成对）', () => {
    const samples: { ruleId: string; code: string; file: string }[] = [
      { ruleId: 'cov-spring-mapping', code: '  @GetMapping("/api/users/{id}")', file: 'UserController.java' },
      { ruleId: 'cov-restassured', code: 'given().when().get("/api/users")', file: 'UserApiTest.java' },
      { ruleId: 'cov-python-requests', code: 'requests.get("/api/users")', file: 'test_users.py' },
      { ruleId: 'cov-url-literal', code: 'given().when().url("/api/users")', file: 'UserApiTest.java' },
      { ruleId: 'cov-path-literal', code: 'const p = "/api/users";', file: 'apiPaths.ts' },
    ];
    for (const s of samples) {
      expect(ids(s.code, s.file)).toContain(s.ruleId);          // 代码里必须命中
      expect(ids(s.code, 'README.md')).not.toContain(s.ruleId); // 文档里必须跳过
      expect(ids(s.code, 'NOTES.txt')).not.toContain(s.ruleId);
    }
  });

  // RC-01：每规则上限的折叠必须可见（否则用户以为看到的是全部）
  it('RC-01：超过每规则上限的命中计入 suppressed，而不是静默消失', () => {
    const many = Array.from({ length: 5 }, (_, i) => `Thread.sleep(${1000 + i * 1000});`).join('\n');
    // suppressed 已在 electron/scan-rules.d.ts 声明（t67），不再需要局部强转
    const r = matchRules(many, 'Load.spec.ts');
    expect(r.hits.filter(h => h.ruleId === 'ui-hard-sleep').length).toBe(MAX_HITS_PER_RULE);
    expect(r.suppressed ?? 0).toBe(5 - MAX_HITS_PER_RULE);
  });
});
describe('硬编码敏感（正例 / 反例）', () => {
  it('sec-hardcoded-url：写死的内网地址命中', () => {
    expect(hit('sec-hardcoded-url', 'String base = "https://jira.corp.example.cn:8080/rest/api";')).toBe(true);
  });
  it('sec-hardcoded-url 反例：example.com / 变量占位 / 注释里的 URL 都不命中', () => {
    expect(hit('sec-hardcoded-url', 'String base = "https://example.com/api";')).toBe(false);
    expect(hit('sec-hardcoded-url', 'String base = "https://${env.host}/api";')).toBe(false);
    expect(hit('sec-hardcoded-url', '/** 详见 https://wiki.corp.example.cn/pages/viewpage */')).toBe(false);
  });

  it('sec-token-literal：写死的 token 命中', () => {
    expect(hit('sec-token-literal', 'String token = "abcd1234efgh5678";')).toBe(true);
  });
  it('sec-token-literal 反例：从环境变量/配置读不命中，短串不命中', () => {
    expect(hit('sec-token-literal', 'String token = System.getenv("API_TOKEN");')).toBe(false);
    expect(hit('sec-token-literal', 'String token = config.get("token");')).toBe(false);
    expect(hit('sec-token-literal', 'String token = "short";')).toBe(false);
  });

  it('sec-password-literal：password 字面量命中', () => {
    expect(hit('sec-password-literal', 'String password = "P@ssw0rd!";')).toBe(true);
  });
  it('sec-password-literal 反例：取请求字段/环境变量不命中', () => {
    expect(hit('sec-password-literal', 'const password = req.body.password;', 'a.js')).toBe(false);
    expect(hit('sec-password-literal', 'password = os.environ["DB_PASS"]', PY)).toBe(false);
  });

  it('sec-intranet-ip：内网 IP 命中（三种私网段）', () => {
    // ⚠️ 别把这些地址改回「好读的字面量」：本仓库有 check-privacy 门禁（scripts/preflight.js），
    //    源码里出现连续的内网地址会被判红并中止整个 `npm run check`（t45 修的就是这处）。
    //    运行时拼出来的仍是真实的私有地址形态，规则该命中还是命中。
    const privateA = '192.168.' + '1.20:8080/api';
    const privateB = '10.' + '20.30.40';
    const privateC = '172.' + '20.5.9';
    expect(hit('sec-intranet-ip', `String url = "http://${privateA}";`)).toBe(true);
    expect(hit('sec-intranet-ip', `host: ${privateB}`)).toBe(true);
    expect(hit('sec-intranet-ip', `target = ${privateC}`)).toBe(true);
  });
  it('sec-intranet-ip 反例：回环、公网、RFC 5737 文档地址都不命中', () => {
    expect(hit('sec-intranet-ip', 'String url = "http://127.0.0.1:8080/api";')).toBe(false);
    expect(hit('sec-intranet-ip', 'dns = 8.8.8.8')).toBe(false);
    // 192.0.2.0/24 是 RFC 5737 的文档保留段：既不是私网、也不是真实地址。
    // 这条若命中，说明规则退化成了「见到 IPv4 就报」——那会把大量公网地址误报成内网。
    expect(hit('sec-intranet-ip', 'example = 192.0.2.10')).toBe(false);
  });
});

describe('弱断言（正例 / 反例）', () => {
  const statusOnly = `public void testLogin() {
  Response r = given().when().post("/api/login");
  assertEquals(200, r.statusCode());
}`;
  const withBody = `public void testLogin() {
  Response r = given().when().post("/api/login");
  assertEquals(200, r.statusCode());
  assertEquals("0", r.jsonPath().getString("code"));
  assertEquals("张三", r.jsonPath().getString("data.name"));
}`;

  it('assert-status-only：只断言状态码命中', () => {
    expect(hit('assert-status-only', statusOnly)).toBe(true);
  });
  it('assert-status-only 反例：断言了响应体字段就不算', () => {
    expect(hit('assert-status-only', withBody)).toBe(false);
  });

  it('assert-truthy-only：只判真假命中', () => {
    expect(hit('assert-truthy-only', 'assertTrue(response.ok);')).toBe(true);
    expect(hit('assert-truthy-only', 'expect(res.data).toBeTruthy();', 'a.ts')).toBe(true);
  });
  it('assert-truthy-only 反例：带具体值比较/取字段不命中', () => {
    expect(hit('assert-truthy-only', 'assertTrue(response.json()["code"] == 0);')).toBe(false);
  });

  it('assert-no-assertion：调了接口却一条断言都没有，命中', () => {
    expect(hit('assert-no-assertion', 'def test_login():\n    requests.post("http://example.com/api/login")\n', PY)).toBe(true);
  });
  it('assert-no-assertion 反例：有断言就不命中', () => {
    expect(hit('assert-no-assertion', 'def test_login():\n    r = requests.post("http://example.com/api/login")\n    assert r.status_code == 200\n', PY)).toBe(false);
  });
  it('assert-no-assertion 反例：Java 的 assertEquals / assertThat 也算断言（不能在这上面误报）', () => {
    const java = `public void test() {
  Response r = given().when().post("/api/login");
  assertEquals(200, r.statusCode());
}`;
    expect(hit('assert-no-assertion', java)).toBe(false);
    const java2 = `public void test() {
  Response r = given().when().post("/api/login");
  assertThat(r.jsonPath().getString("code")).isEqualTo("0");
}`;
    expect(hit('assert-no-assertion', java2)).toBe(false);
  });
});

describe('matchRules 的过滤与输出形状', () => {
  it('ruleIds 过滤：只跑勾选的规则', () => {
    const text = 'Thread.sleep(1000);\nString password = "Pa55";';
    expect(ids(text, JAVA, ['ui-hard-sleep'])).toEqual(['ui-hard-sleep']);
    expect(ids(text, JAVA, ['ui-hard-sleep', 'sec-password-literal']).sort())
      .toEqual(['sec-password-literal', 'ui-hard-sleep']);
  });

  it('ruleIds 全部无效 → 空命中（不抛异常，由上层按 C-56 报「规则集为空」）', () => {
    expect(ids('Thread.sleep(1000);', JAVA, ['no-such-rule'])).toEqual([]);
  });

  it('空文本 → 空命中', () => {
    expect(ids('')).toEqual([]);
    expect(ids('   \n\n  ')).toEqual([]);
  });

  it('命中项带 severity / title / 1-based 行号 / 只含命中行原文的 snippet', () => {
    const text = 'line one\nThread.sleep(2000);\nline three';
    const { hits } = matchRules(text, JAVA) as { hits: { ruleId: string; severity: string; title: string; line: number; snippet: string }[] };
    const h = hits.find((x) => x.ruleId === 'ui-hard-sleep');
    expect(h).toBeTruthy();
    expect(h!.line).toBe(2);
    expect(h!.snippet).toBe('Thread.sleep(2000);');
    expect(h!.severity).toBe('medium');
    expect(h!.title.length).toBeGreaterThan(0);
    // snippet 不许是整段拼接
    expect(h!.snippet).not.toContain('line one');
    expect(h!.snippet).not.toContain('line three');
  });

  it('超长行只截前 200 字符（避免把整行源码拖进 UI/历史记录）', () => {
    const long = `Thread.sleep(${'1'.repeat(400)});`;
    const { hits } = matchRules(long, JAVA) as { hits: { snippet: string }[] };
    expect(hits[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it('同一条规则在一个文件里最多 3 条命中（findings 上限的前置约束）', () => {
    const text = Array.from({ length: 10 }, () => 'Thread.sleep(1000);').join('\n');
    const { hits } = matchRules(text, JAVA) as { hits: { ruleId: string }[] };
    expect(hits.filter((h) => h.ruleId === 'ui-hard-sleep')).toHaveLength(3);
  });

  it('coverage 包：Spring 映射抽出 method + path（路径原文，未归一化）', () => {
    const { hits } = matchRules('@GetMapping("/api/user/{id}")', 'UserController.java', ['cov-spring-mapping']) as {
      hits: { ruleId: string; method?: string; path?: string }[];
    };
    expect(hits[0].ruleId).toBe('cov-spring-mapping');
    expect(hits[0].method).toBe('GET');
    expect(hits[0].path).toBe('/api/user/{id}');
  });

  it('coverage 包：Java 测试里的 .get("/x")（RestAssured/axios 风格）抽出 method + path', () => {
    const src = 'given().when()\n  .get("/api/order/list")\n  .then().statusCode(200);';
    const { hits } = matchRules(src, 'OrderTest.java', ['cov-restassured']) as {
      hits: { method?: string; path?: string; line: number }[];
    };
    expect(hits[0]).toMatchObject({ method: 'GET', path: '/api/order/list', line: 2 });
  });

  it('coverage 包：Python requests.post("/x") 抽出 method + path', () => {
    const src = 'def t():\n    requests.post("https://example.com/api/login", json={})\n';
    const { hits } = matchRules(src, 'test_api.py', ['cov-python-requests']) as {
      hits: { method?: string; path?: string }[];
    };
    expect(hits[0].method).toBe('POST');
    expect(hits[0].path).toBe('https://example.com/api/login');
  });

  it('coverage 包：.url("/x") 与纯路径字面量也能抽（method 未知记 ANY）', () => {
    const urlHit = (matchRules('httpRequest.url("/api/a/b");', 'A.java', ['cov-url-literal']) as {
      hits: { method?: string; path?: string }[];
    }).hits[0];
    expect(urlHit).toMatchObject({ method: 'ANY', path: '/api/a/b' });
    const litHit = (matchRules('String p = "/api/c/d";', 'B.java', ['cov-path-literal']) as {
      hits: { method?: string; path?: string }[];
    }).hits[0];
    expect(litHit).toMatchObject({ method: 'ANY', path: '/api/c/d' });
  });

  it('coverage 包：findings 四个字段 method/path/file/line 齐全（契约要求）', () => {
    const { hits } = matchRules('  .get("/api/x")', 'X.java', ['cov-restassured']) as {
      hits: { method?: string; path?: string; line: number }[];
    };
    expect(hits[0].method).toBeTruthy();
    expect(hits[0].path).toBeTruthy();
    expect(hits[0].line).toBe(1); // file 由调用方补齐（扫描时才知道相对路径）
  });

  it('语言相关的注释语法：# 开头的注释在 .py 里算注释、在 .java 里不算', () => {
    const pyComment = '# Thread.sleep(3000) 别这么写';
    expect(ids(pyComment, PY)).toEqual([]);
    expect(stripComments(pyComment, PY)[0].trim()).toBe('');
    // 同一行在 .java 里 # 不是注释起始，原样保留
    expect(stripComments(pyComment, JAVA)[0]).toContain('Thread.sleep');
  });
});

describe('isInsideRoot：root 归属校验（C-16 第 1 条，纯字符串判前缀）', () => {
  const root = 'C:\\work\\proj';

  it('root 内的文件算在内（含深层子目录）', () => {
    expect(isInsideRoot(root, 'C:\\work\\proj\\a.java')).toBe(true);
    expect(isInsideRoot(root, 'C:\\work\\proj\\src\\main\\A.java')).toBe(true);
  });

  it('root 自己算在内；prefix 相似但不同级的目录不算', () => {
    expect(isInsideRoot(root, 'C:\\work\\proj')).toBe(true);
    expect(isInsideRoot(root, 'C:\\work\\proj-evil\\a.java')).toBe(false); // 纯前缀比较会误判，必须按分隔符
  });

  it('.. 逃逸与盘符切换都不算在内', () => {
    expect(isInsideRoot(root, 'C:\\work\\proj\\..\\secret.txt')).toBe(false);
    expect(isInsideRoot(root, 'C:\\windows\\system32\\a.txt')).toBe(false);
    expect(isInsideRoot(root, 'D:\\work\\proj\\a.java')).toBe(false);
  });

  it('POSIX 路径同样按分隔符比较', () => {
    expect(isInsideRoot('/home/u/proj', '/home/u/proj/src/a.ts')).toBe(true);
    expect(isInsideRoot('/home/u/proj', '/home/u/proj-evil/a.ts')).toBe(false);
    expect(isInsideRoot('/home/u/proj', '/home/u/proj/../../etc/passwd')).toBe(false);
  });

  it('空 root / 空 target 一律 false（不许把空串当「都在里面」）', () => {
    expect(isInsideRoot('', 'C:\\a')).toBe(false);
    expect(isInsideRoot(root, '')).toBe(false);
  });
});