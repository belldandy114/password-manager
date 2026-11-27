/**
 * B6-A：粘贴导入的三个解析器 + 三格式自动识别（渲染层契约 §6.2 / 方案 §10.1）。
 *
 * 测试先于实现写（TDD）：本文件首跑时 `elementPaste/` 目录还不存在 → 整文件红。
 *
 * 锁的六件事（§6.2 的「必锁 6 条」+ 逐格式 3 条）：
 * 1. 三种格式各能识别，并且每行都带 `confidence` 与**非空的 `reason`**（不能只说「认出来了」）；
 * 2. 一段中文 → `source: null` + `candidates.length === 0` + 固定文案；
 * 3. 三种同时命中按固定顺序取先（① Recorder JSON → ② Playwright 脚本 → ③ HTML）；
 * 4. 转不成精确定位的（`filter()` / `nth()` / 只有 class 的 HTML）标 `guess`，**不静默当 exact**；
 * 5. HTML 连标签都解析不出 → `unknown` 且 `locator: ''`；
 * 6. 全是纯函数：不读 `window`、不碰 IPC（node 环境就能跑）。
 */
import { describe, it, expect } from 'vitest';

import {
  detectElementPaste, parseBySource, parseRecorder, parsePlaywright, parseHtml,
  PASTE_UNKNOWN_REASON,
  type ElementPasteCandidate,
} from '../elementPaste';

const SOURCES = ['recorder-json', 'playwright-js', 'html'];
const CONFIDENCES = ['exact', 'guess', 'unknown'];

/** 每行的公共约束：kind 合法、reason 非空、confidence 有值、source 与解析器一致 */
function assertRowShape(rows: ElementPasteCandidate[], source: string) {
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(SOURCES).toContain(r.source);
    expect(r.source).toBe(source);
    expect(CONFIDENCES).toContain(r.confidence);
    expect(typeof r.reason).toBe('string');
    expect(r.reason.trim().length).toBeGreaterThan(0);
    expect(typeof r.name).toBe('string');
  }
}

/* ================================================================
   ① DevTools Recorder 导出的 JSON
   ================================================================ */
describe('parseRecorder：DevTools Recorder JSON 的 steps[].selectors', () => {
  const RECORDER = JSON.stringify({
    title: '登录流程',
    steps: [
      { type: 'click', selectors: [['#submit'], ['aria/提交']], target: 'main', title: '提交按钮' },
      { type: 'click', selectors: [['role/button[name="登录"]']], title: '登录' },
      { type: 'click', selectors: [['text/全部']] },
      { type: 'click', selectors: [['.row:nth-child(2)']] },
    ],
  });

  it('css 选择器 → kind=css / exact，名字取 step.title', () => {
    const rows = parseRecorder(RECORDER);
    assertRowShape(rows, 'recorder-json');
    const submit = rows.find((r) => r.locator === '#submit');
    expect(submit).toBeTruthy();
    expect(submit!.kind).toBe('css');
    expect(submit!.confidence).toBe('exact');
    expect(submit!.name).toBe('提交按钮');
  });

  it('role 选择器 → kind=role（locator 存角色名，role 存可访问名）', () => {
    const rows = parseRecorder(RECORDER);
    const role = rows.find((r) => r.kind === 'role');
    expect(role).toBeTruthy();
    expect(role!.locator).toBe('button');
    expect(role!.role).toBe('登录');
  });

  it('text 选择器 → kind=text', () => {
    const rows = parseRecorder(RECORDER);
    expect(rows.some((r) => r.kind === 'text' && r.locator === '全部')).toBe(true);
  });

  it('结构性 css（:nth-child）→ confidence=guess，不冒充 exact', () => {
    const rows = parseRecorder(RECORDER);
    const nth = rows.find((r) => r.locator.includes(':nth-child'));
    expect(nth).toBeTruthy();
    expect(nth!.confidence).toBe('guess');
    expect(nth!.reason).toMatch(/结构|nth-child|不稳/);
  });

  it('没有 steps → 空数组（不抛）', () => {
    expect(parseRecorder('{"steps":[]}')).toEqual([]);
    expect(parseRecorder('not json')).toEqual([]);
  });
});

/* ================================================================
   ② Playwright codegen 脚本
   ================================================================ */
describe('parsePlaywright：getByRole / getByText / locator / filter 链', () => {
  const SCRIPT = [
    "await page.goto('https://example.com/login');",
    "await page.getByRole('button', { name: '登录' }).click();",
    "await page.getByText('全部').click();",
    "await page.locator('#row').filter({ hasText: '审核结果' }).click();",
    "await page.locator('#list').nth(2).click();",
    "await page.getByPlaceholder('请输入账号').fill('x');",
  ].join('\n');

  it('getByRole → kind=role（locator=角色名、role=可访问名），且 confidence=exact', () => {
    const rows = parsePlaywright(SCRIPT);
    assertRowShape(rows, 'playwright-js');
    const role = rows.find((r) => r.kind === 'role');
    expect(role).toBeTruthy();
    expect(role!.locator).toBe('button');
    expect(role!.role).toBe('登录');
    expect(role!.confidence).toBe('exact');
  });

  it('getByText → kind=text', () => {
    const rows = parsePlaywright(SCRIPT);
    expect(rows.some((r) => r.kind === 'text' && r.locator === '全部')).toBe(true);
  });

  it('含 filter({ hasText }) 的整条链 → kind=pw 且 confidence=guess（不静默降级）', () => {
    const rows = parsePlaywright(SCRIPT);
    const pw = rows.find((r) => r.kind === 'pw' && r.locator.includes('filter('));
    expect(pw).toBeTruthy();
    expect(pw!.confidence).toBe('guess');
    // 元素名建议从 hasText 取一段（渲染层契约 §6.2「hasText → 元素名建议」）
    expect(pw!.name).toContain('审核结果');
  });

  it('.nth(N) 链 → kind=pw / guess', () => {
    const rows = parsePlaywright(SCRIPT);
    const nth = rows.find((r) => r.kind === 'pw' && r.locator.includes('.nth('));
    expect(nth).toBeTruthy();
    expect(nth!.confidence).toBe('guess');
  });

  it('getByPlaceholder 单条 → kind=placeholder / exact（A₀ 之后有专属 kind，不再暂存成 pw）', () => {
    const rows = parsePlaywright(SCRIPT);
    const ph = rows.find((r) => r.locator === '请输入账号');
    expect(ph).toBeTruthy();
    // D-4（[A1-8] (3)）：A₀ 之前这里落 pw；A₀ 之后落 placeholder —— 断言改值，用例保留
    expect(ph!.kind).toBe('placeholder');
    expect(ph!.confidence).toBe('exact');
    expect(ph!.name).toContain('请输入账号');
  });

  it('goto / 非定位行不产生候选', () => {
    const rows = parsePlaywright("await page.goto('https://example.com');");
    expect(rows).toEqual([]);
  });
});

/* ================================================================
   ③ Elements 复制的 outerHTML
   ================================================================ */
describe('parseHtml：outerHTML → tag / id / class / aria 推定 css', () => {
  it('有 id → `#id` 且 exact', () => {
    const rows = parseHtml('<button id="submit" class="btn btn-primary">提交</button>');
    assertRowShape(rows, 'html');
    expect(rows[0].locator).toBe('#submit');
    expect(rows[0].kind).toBe('css');
    expect(rows[0].confidence).toBe('exact');
    expect(rows[0].name).toContain('提交');
  });

  it('只有 class（无 id）→ 结构性 css，标 guess', () => {
    const rows = parseHtml('<div class="row item">审核结果</div>');
    expect(rows[0].locator).toBe('.row');
    expect(rows[0].confidence).toBe('guess');
    expect(rows[0].reason).toMatch(/guess|推定|不确定|结构性/);
  });

  it('aria-label → 属性选择器，exact', () => {
    const rows = parseHtml('<span aria-label="关闭">×</span>');
    expect(rows[0].locator).toBe('[aria-label="关闭"]');
    expect(rows[0].confidence).toBe('exact');
  });

  it('连标签都解析不出 → unknown 且 locator 为空串（名字取文本前 30 字）', () => {
    const rows = parseHtml('就是一段纯文本，不是 HTML');
    expect(rows).toHaveLength(1);
    expect(rows[0].confidence).toBe('unknown');
    expect(rows[0].locator).toBe('');
    expect(rows[0].name.length).toBeLessThanOrEqual(30);
  });
});

/* ================================================================
   detect：三格式自动识别 + 固定判定顺序
   ================================================================ */
describe('detectElementPaste：判定顺序固定为 ① Recorder JSON → ② Playwright 脚本 → ③ HTML', () => {
  const RECORDER = JSON.stringify({ steps: [{ type: 'click', selectors: [['#submit']], title: '提交' }] });

  it('Recorder JSON → source=recorder-json（即便文本里也含 locator( 字样，① 优先）', () => {
    // ① 与 ② 同时命中：JSON 里带 locator( 的 selector，顺序必须取 ①
    const both = JSON.stringify({ steps: [{ type: 'click', selectors: [["locator('#a')"]], title: 'A' }] });
    expect(detectElementPaste(both).source).toBe('recorder-json');
    expect(detectElementPaste(RECORDER).source).toBe('recorder-json');
  });

  it('Playwright 脚本 → source=playwright-js（即便含 `<`，② 优先于 ③）', () => {
    const text = "await page.getByRole('button', { name: '<空>' }).click();\nawait page.getByText('全部').click();";
    expect(detectElementPaste(text).source).toBe('playwright-js');
  });

  it('HTML → source=html', () => {
    expect(detectElementPaste('<div id="a">x</div>').source).toBe('html');
  });

  it('一段中文 → source=null + 0 条候选 + 固定文案（逐字）', () => {
    const r = detectElementPaste('我今天想加一个登录按钮');
    expect(r.source).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.reason).toBe(PASTE_UNKNOWN_REASON);
    expect(PASTE_UNKNOWN_REASON).toBe('无法识别：支持 DevTools Recorder 导出的 JSON / Playwright codegen 脚本 / Elements 复制的 HTML');
  });

  it('空文本 → source=null（不抛）', () => {
    expect(detectElementPaste('').source).toBeNull();
    expect(detectElementPaste('   ').candidates).toEqual([]);
  });

  it('识别出来的每一行都带 source / confidence / reason', () => {
    for (const text of [RECORDER, "await page.getByText('x').click();", '<b id="z">y</b>']) {
      const r = detectElementPaste(text);
      expect(r.source).toBeTruthy();
      for (const row of r.candidates) {
        expect(row.source).toBe(r.source);
        expect(row.reason.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('parseBySource：用户在下拉里改选后只重解析、不重新识别', () => {
    // HTML 文本被强制按 playwright 解析 → 拿不到候选（而不是回头又判成 html）
    expect(parseBySource('playwright-js', '<div id="a">x</div>')).toEqual([]);
    // Recorder JSON 强制按 html 解析 → 只拿到 unknown 行
    const forced = parseBySource('html', RECORDER);
    expect(forced.length).toBe(1);
    expect(forced[0].confidence).toBe('unknown');
    // 正常路径
    expect(parseBySource('html', '<div id="a">x</div>')[0].locator).toBe('#a');
  });
});
