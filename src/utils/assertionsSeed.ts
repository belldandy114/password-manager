/**
 * 1.4 断言模板库的**内置种子**（契约 §3.6 / [C-97]/[C-98]）。
 *
 * 三条硬规矩：
 * 1. **静态常量、只读、不落库**（[C-97]）：种子不进 vault，页面不给删除按钮；
 *    用户自己的片段另存 `codeSnippets` 集合（带 `kind:'assert'`），见 `assertions.ts`。
 * 2. **只做 Java**（[C-82]）：`lang` 目前只有 `'java'` 一个值，留着是为了将来加语言不改结构。
 * 3. **片段必须真能用**：每条都是能直接粘进测试类里的语句/语句块，不是伪代码；
 *    依赖的静态导入写在 `note` 里（不放代码正文，否则「展示与复制逐字符一致」[C-99] 会被注释噪声污染）。
 *
 * 三维检索：`lang`（语言）/ `framework`（框架）/ `category`（用途），见 `listAssertions`。
 * 与契约 §3.6 的接口相比多了 `lang` 与 `category` **两个附加字段**（契约只列了 id/title/framework/tags/code/note）：
 * 任务要求三维检索，而契约的字段名一个没改，属纯追加。
 */

export type AssertionFramework = 'restassured' | 'playwright' | 'junit' | 'hamcrest';
export type AssertionLang = 'java';
export type AssertionCategory =
  | 'status' // 状态码 / 响应时间
  | 'json' // JSON 字段取值
  | 'schema' // JSON Schema 结构校验
  | 'visibility' // 元素可见 / 可点 / 数量
  | 'text' // 文本内容
  | 'attribute' // 属性 / class / CSS
  | 'general'; // 其它（超时、抛异常、URL、标题）

export interface AssertionSnippet {
  id: string;
  title: string;
  lang: AssertionLang;
  framework: AssertionFramework;
  category: AssertionCategory;
  tags: string[];
  code: string;
  note?: string;
  /**
   * 附加字段（契约 §3.6 未列）：只有「用户自定义片段」才有，用于 [C-98] 的
   * 「自定义在后、按 updatedAt 降序」。种子不带这个字段。
   */
  updatedAt?: string;
}

export const FRAMEWORK_LABELS: Record<AssertionFramework, string> = {
  restassured: 'RestAssured',
  playwright: 'Playwright',
  junit: 'JUnit 5',
  hamcrest: 'Hamcrest',
};

export const CATEGORY_LABELS: Record<AssertionCategory, string> = {
  status: '状态码',
  json: 'JSON 字段',
  schema: 'Schema',
  visibility: '可见性',
  text: '文本',
  attribute: '属性',
  general: '其它',
};

/** 内置片段（36 条；顺序即页面默认顺序，[C-98] 要求种子按原序在前） */
export const ASSERTION_SEED: AssertionSnippet[] = [
  /* ---------------- RestAssured：状态码 ---------------- */
  {
    id: 'ra-status-200',
    title: 'RestAssured · 状态码等于 200',
    lang: 'java',
    framework: 'restassured',
    category: 'status',
    tags: ['status', '状态码', '200', 'restassured', 'given when then'],
    code: 'given().when().get("/users/1").then().statusCode(200);',
    note: '静态导入：io.restassured.RestAssured.given',
  },
  {
    id: 'ra-status-4xx',
    title: 'RestAssured · 4xx 之一（400 或 404）',
    lang: 'java',
    framework: 'restassured',
    category: 'status',
    tags: ['status', '状态码', '4xx', '400', '404', 'anyOf'],
    code: 'given().when().get("/users/9999").then().statusCode(anyOf(is(400), is(404)));',
    note: '静态导入：org.hamcrest.Matchers.anyOf / is',
  },
  {
    id: 'ra-status-2xx-range',
    title: 'RestAssured · 2xx 区间（不锁死具体值）',
    lang: 'java',
    framework: 'restassured',
    category: 'status',
    tags: ['status', '状态码', '2xx', 'allOf', 'range'],
    code: 'given().when().get("/health").then()\n    .statusCode(allOf(greaterThanOrEqualTo(200), lessThan(300)));',
    note: '静态导入：org.hamcrest.Matchers.allOf / greaterThanOrEqualTo / lessThan',
  },
  {
    id: 'ra-time-limit',
    title: 'RestAssured · 响应时间上限（毫秒）',
    lang: 'java',
    framework: 'restassured',
    category: 'status',
    tags: ['time', '耗时', '性能', 'timeout', '毫秒'],
    code: 'given().when().get("/orders").then().time(lessThan(2000L));',
    note: '响应时间属于「同类阈值」，不是性能测试结论：真正的分位数看压测报告',
  },

  /* ---------------- RestAssured：JSON 字段 ---------------- */
  {
    id: 'ra-json-path-eq',
    title: 'RestAssured · JSON 字段等于固定值',
    lang: 'java',
    framework: 'restassured',
    category: 'json',
    tags: ['json', 'body', 'jsonpath', 'equalTo', '字段'],
    code: 'given().when().get("/users/1").then().body("data.status", equalTo("ACTIVE"));',
    note: '静态导入：org.hamcrest.Matchers.equalTo',
  },
  {
    id: 'ra-json-nested-not-null',
    title: 'RestAssured · 嵌套字段非空（含数组下标）',
    lang: 'java',
    framework: 'restassured',
    category: 'json',
    tags: ['json', 'body', 'nested', '嵌套', '数组', 'notNullValue'],
    code: 'given().when().get("/orders?page=1").then().body("data.list[0].orderId", notNullValue());',
    note: '静态导入：org.hamcrest.Matchers.notNullValue',
  },
  {
    id: 'ra-json-type',
    title: 'RestAssured · 字段类型断言（数字不能变字符串）',
    lang: 'java',
    framework: 'restassured',
    category: 'json',
    tags: ['json', 'type', '类型', 'instanceOf', 'integer'],
    code: 'given().when().get("/stats").then().body("data.total", instanceOf(Integer.class));',
    note: '静态导入：org.hamcrest.Matchers.instanceOf',
  },
  {
    id: 'ra-json-array-not-empty',
    title: 'RestAssured · 数组字段非空',
    lang: 'java',
    framework: 'restassured',
    category: 'json',
    tags: ['json', 'array', '数组', 'empty', 'not'],
    code: 'given().when().get("/orders").then().body("data.items", not(empty()));',
    note: '静态导入：org.hamcrest.Matchers.not / empty',
  },
  {
    id: 'ra-json-has-item',
    title: 'RestAssured · 数组包含某个值',
    lang: 'java',
    framework: 'restassured',
    category: 'json',
    tags: ['json', 'array', '数组', 'hasItem', '包含'],
    code: 'given().when().get("/orders").then().body("data.items.status", hasItem("PAID"));',
    note: '静态导入：org.hamcrest.Matchers.hasItem',
  },

  /* ---------------- RestAssured：JSON Schema ---------------- */
  {
    id: 'ra-schema-classpath',
    title: 'RestAssured · JSON Schema（classpath 里的文件）',
    lang: 'java',
    framework: 'restassured',
    category: 'schema',
    tags: ['schema', 'json-schema', 'contract', '契约', 'matchesJsonSchemaInClasspath'],
    code: 'given().when().get("/users/1").then()\n    .body(matchesJsonSchemaInClasspath("schemas/user.json"));',
    note: '需要 rest-assured json-schema-validator 模块；静态导入 io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchemaInClasspath',
  },
  {
    id: 'ra-schema-file',
    title: 'RestAssured · JSON Schema（本地文件路径）',
    lang: 'java',
    framework: 'restassured',
    category: 'schema',
    tags: ['schema', 'json-schema', 'file', '本地文件', 'matchesJsonSchema'],
    code: 'given().when().get("/orders").then()\n    .body(matchesJsonSchema(new File("src/test/resources/schemas/order.json")));',
    note: '静态导入 io.restassured.module.jsv.JsonSchemaValidator.matchesJsonSchema；路径用相对路径，别写本机绝对路径',
  },
  {
    id: 'ra-schema-2020-12',
    title: 'RestAssured · JSON Schema 指定草案版本（2020-12）',
    lang: 'java',
    framework: 'restassured',
    category: 'schema',
    tags: ['schema', 'json-schema', 'draft', '2020-12', 'specversion'],
    code: 'given().when().get("/orders").then().body(\n    JsonSchemaValidator.schemaValidation(new File("src/test/resources/schemas/order.json"))\n        .version(SpecVersion.VersionFlag.V202012));',
    note: '导入：io.restassured.module.jsv.JsonSchemaValidator、com.networknt.schema.SpecVersion',
  },

  /* ---------------- RestAssured：响应头 / 配置 / 整体 ---------------- */
  {
    id: 'ra-header-content-type',
    title: 'RestAssured · 响应头 content-type',
    lang: 'java',
    framework: 'restassured',
    category: 'general',
    tags: ['header', '响应头', 'content-type', 'containsString'],
    code: 'given().when().get("/users/1").then().header("Content-Type", containsString("application/json"));',
    note: '静态导入：org.hamcrest.Matchers.containsString',
  },
  {
    id: 'ra-body-contains',
    title: 'RestAssured · 响应体包含关键字（兜底断言）',
    lang: 'java',
    framework: 'restassured',
    category: 'general',
    tags: ['body', 'containsString', '兜底', '关键字'],
    code: 'given().when().get("/users/1").then().body(containsString("\"status\":\"ACTIVE\""));',
    note: '只在结构不稳定时兜底用；能取字段就别比整串（顺序/空格一变就红）',
  },
  {
    id: 'ra-base-uri',
    title: 'RestAssured · 基地址与端口（前置）',
    lang: 'java',
    framework: 'restassured',
    category: 'general',
    tags: ['baseuri', '配置', '端口', 'host', '示例地址'],
    code: 'RestAssured.baseURI = "https://api.example.com";\nRestAssured.port = 443;\nRestAssured.basePath = "/v1";',
    note: '示例一律用 example.com，别把真实内网地址写进测试类（公开仓库）',
  },

  /* ---------------- Playwright（Java）：可见性 ---------------- */
  {
    id: 'pw-visible',
    title: 'Playwright · 元素可见',
    lang: 'java',
    framework: 'playwright',
    category: 'visibility',
    tags: ['visible', '可见', 'isVisible', 'locator', 'assertThat'],
    code: 'assertThat(page.locator("#login-btn")).isVisible();',
    note: '静态导入：com.microsoft.playwright.assertions.PlaywrightAssertions.assertThat',
  },
  {
    id: 'pw-hidden',
    title: 'Playwright · 元素不可见（消失断言）',
    lang: 'java',
    framework: 'playwright',
    category: 'visibility',
    tags: ['hidden', '隐藏', '消失', 'isHidden', 'toast'],
    code: 'assertThat(page.locator(".toast")).isHidden();',
    note: 'isHidden 对「不存在」也成立；要区分「还在但透明」用 expect(locator).not().toBeVisible() 之外再看 CSS',
  },
  {
    id: 'pw-enabled-role',
    title: 'Playwright · 按角色取按钮并断言可点',
    lang: 'java',
    framework: 'playwright',
    category: 'visibility',
    tags: ['role', 'aria', 'enabled', '可点', 'button', 'GetByRoleOptions'],
    code: 'assertThat(page.getByRole(AriaRole.BUTTON, new Page.GetByRoleOptions().setName("提交"))).isEnabled();',
    note: '导入：com.microsoft.playwright.options.AriaRole；按角色+名称取比 CSS 稳',
  },
  {
    id: 'pw-count',
    title: 'Playwright · 列表条数',
    lang: 'java',
    framework: 'playwright',
    category: 'visibility',
    tags: ['count', '条数', 'hasCount', '列表', 'table'],
    code: 'assertThat(page.locator("table tbody tr")).hasCount(3);',
    note: 'hasCount 会等到达标；要断言「至少 N 条」用 hasCount 之外的循环判定',
  },

  /* ---------------- Playwright（Java）：文本 ---------------- */
  {
    id: 'pw-text-eq',
    title: 'Playwright · 文本等于',
    lang: 'java',
    framework: 'playwright',
    category: 'text',
    tags: ['text', '文本', 'hasText', '等于'],
    code: 'assertThat(page.locator("h1")).hasText("登录");',
    note: 'hasText(String) 是「包含」语义；要严格相等用 hasText(Pattern.compile("^登录$"))',
  },
  {
    id: 'pw-text-regex',
    title: 'Playwright · 文本正则匹配',
    lang: 'java',
    framework: 'playwright',
    category: 'text',
    tags: ['text', 'regex', '正则', 'Pattern', 'hasText'],
    code: 'assertThat(page.locator("h1")).hasText(Pattern.compile("^登录\\s*$"));',
    note: '导入 java.util.regex.Pattern',
  },
  {
    id: 'pw-contains-text',
    title: 'Playwright · 包含文本（提示语）',
    lang: 'java',
    framework: 'playwright',
    category: 'text',
    tags: ['text', 'containsText', '提示', '含有', 'testid'],
    code: 'assertThat(page.getByTestId("msg")).containsText("保存成功");',
    note: 'getByTestId 需要页面有 data-testid；没有就用 getByText',
  },

  /* ---------------- Playwright（Java）：属性 ---------------- */
  {
    id: 'pw-attr-href',
    title: 'Playwright · 属性值匹配（href）',
    lang: 'java',
    framework: 'playwright',
    category: 'attribute',
    tags: ['attribute', '属性', 'href', 'hasAttribute', '链接'],
    code: 'assertThat(page.locator("a.next")).hasAttribute("href", Pattern.compile("/page/2$"));',
    note: 'hasAttribute 第二个参数既可以是字符串（相等）也可以是 Pattern',
  },
  {
    id: 'pw-attr-class',
    title: 'Playwright · class 含某个状态类',
    lang: 'java',
    framework: 'playwright',
    category: 'attribute',
    tags: ['class', 'hasClass', '状态', '样式', 'is-active'],
    code: 'assertThat(page.locator("form#login")).hasClass(Pattern.compile("is-active"));',
    note: 'hasClass(Pattern) 是子串匹配；要整个 class 属性相等传字符串',
  },
  {
    id: 'pw-css-color',
    title: 'Playwright · 计算样式（颜色）',
    lang: 'java',
    framework: 'playwright',
    category: 'attribute',
    tags: ['css', 'style', '样式', '颜色', 'hasCSS', 'color'],
    code: 'assertThat(page.locator("#banner")).hasCSS("color", "rgb(255, 0, 0)");',
    note: '取值是 computed style 的序列化形式，改主题令牌会让这条跟着变红',
  },

  /* ---------------- Playwright（Java）：页面级 ---------------- */
  {
    id: 'pw-url',
    title: 'Playwright · 当前 URL 匹配',
    lang: 'java',
    framework: 'playwright',
    category: 'general',
    tags: ['url', '路由', 'hasURL', '跳转'],
    code: 'assertThat(page).hasURL(Pattern.compile(".*/dashboard$"));',
    note: '跳转后立即断言会偶发失败；Playwright 的 assertThat 自带重试窗口',
  },
  {
    id: 'pw-title',
    title: 'Playwright · 页面标题',
    lang: 'java',
    framework: 'playwright',
    category: 'general',
    tags: ['title', '标题', 'hasTitle'],
    code: 'assertThat(page).hasTitle("首页 - 测试中台");',
    note: '标题带环境后缀时改用 Pattern',
  },

  /* ---------------- JUnit 5 ---------------- */
  {
    id: 'ju-assert-equals',
    title: 'JUnit · 相等断言（带失败信息）',
    lang: 'java',
    framework: 'junit',
    category: 'general',
    tags: ['junit', 'assertEquals', '断言', '信息'],
    code: 'assertEquals(200, response.statusCode(), "HTTP 状态码应为 200");',
    note: '静态导入：org.junit.jupiter.api.Assertions.assertEquals；第三个参数是失败信息，别省',
  },
  {
    id: 'ju-assert-all',
    title: 'JUnit · 一次性报告多条断言',
    lang: 'java',
    framework: 'junit',
    category: 'general',
    tags: ['junit', 'assertAll', '聚合', '多条'],
    code: 'assertAll(\n    () -> assertEquals("ACTIVE", data.getStatus()),\n    () -> assertNotNull(data.getId()),\n    () -> assertTrue(data.getCount() > 0)\n);',
    note: 'assertAll 会把所有失败一次报出来，比串行断言省一轮排查',
  },
  {
    id: 'ju-timeout',
    title: 'JUnit · 超时断言',
    lang: 'java',
    framework: 'junit',
    category: 'general',
    tags: ['junit', 'timeout', '超时', 'assertTimeoutPreemptively'],
    code: 'assertTimeoutPreemptively(Duration.ofSeconds(5), () -> api.call("/slow"));',
    note: '导入 java.time.Duration；Preemptively 会中断线程，注意别包共享状态',
  },
  {
    id: 'ju-assert-throws',
    title: 'JUnit · 期望抛异常并看消息',
    lang: 'java',
    framework: 'junit',
    category: 'general',
    tags: ['junit', 'assertThrows', '异常', '负向'],
    code: 'ApiException e = assertThrows(ApiException.class, () -> api.get("/missing"));\nassertTrue(e.getMessage().contains("404"));',
    note: '负向用例：既要断言类型，也要断言可读消息（否则抛什么都算过）',
  },

  /* ---------------- Hamcrest ---------------- */
  {
    id: 'hm-has-key',
    title: 'Hamcrest · Map 含某个 key',
    lang: 'java',
    framework: 'hamcrest',
    category: 'json',
    tags: ['hamcrest', 'hasKey', 'map', 'json', '键'],
    code: 'assertThat(jsonMap, hasKey("id"));',
    note: '静态导入：org.hamcrest.MatcherAssert.assertThat、org.hamcrest.Matchers.hasKey',
  },
  {
    id: 'hm-has-size',
    title: 'Hamcrest · 集合条数',
    lang: 'java',
    framework: 'hamcrest',
    category: 'json',
    tags: ['hamcrest', 'hasSize', '条数', '集合'],
    code: 'assertThat(items, hasSize(3));',
    note: '静态导入 org.hamcrest.Matchers.hasSize；数组用 arrayWithSize',
  },
  {
    id: 'hm-close-to',
    title: 'Hamcrest · 浮点数近似相等（带容差）',
    lang: 'java',
    framework: 'hamcrest',
    category: 'json',
    tags: ['hamcrest', 'closeTo', '浮点', '容差', 'double'],
    code: 'assertThat(rate, closeTo(0.98, 0.01));',
    note: '浮点不要用 equalTo：0.1+0.2 会给你 0.30000000000000004',
  },
  {
    id: 'hm-string-chain',
    title: 'Hamcrest · 字符串组合断言',
    lang: 'java',
    framework: 'hamcrest',
    category: 'text',
    tags: ['hamcrest', 'allOf', 'containsString', 'startsWith', '文本'],
    code: 'assertThat(msg, allOf(containsString("成功"), startsWith("操作")));',
    note: '组合断言失败时的报错会带上每条 matcher 的结论，比 && 串起来好查',
  },
  {
    id: 'hm-has-item',
    title: 'Hamcrest · 集合包含某个元素',
    lang: 'java',
    framework: 'hamcrest',
    category: 'json',
    tags: ['hamcrest', 'hasItem', '包含', '集合'],
    code: 'assertThat(statusList, hasItem("PAID"));',
    note: '静态导入 org.hamcrest.Matchers.hasItem；判「全部满足」用 everyItem',
  },
  {
    id: 'hm-has-property',
    title: 'Hamcrest · Bean 有可读属性',
    lang: 'java',
    framework: 'hamcrest',
    category: 'attribute',
    tags: ['hamcrest', 'hasProperty', 'bean', '属性', 'getter'],
    code: 'assertThat(orderDto, hasProperty("status"));',
    note: '按 getter 判定：字段叫 status 但只有 setter 时这条会红',
  },
];