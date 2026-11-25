// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { render, waitFor } from '@testing-library/react';

import {
  stepsToCalls,
  buildMjsScript,
  buildSpecTs,
  buildPomArtifact,
  buildArtifacts,
  pomRowsFromRecording,
  extractSpecLocators,
  extractMjsSelectors,
  envRefsOf,
  ARTIFACT_PREREQ,
  RUNTIME_HELPERS,
  RUNTIME_TARGETING,
  type ScriptCall,
} from '../record/recordScript';
import { newRecording, newStep, textValueMeta, selectValueMeta } from '../record/recorderModel';
import { ArtifactPicker } from '../../components/recorder/ArtifactPicker';
import type { UiRecording, UiStep } from '../record/recorderModel';
import { generatePageObject } from '../codegen/pageobject';

/**
 * 三产物（Java POM / 零依赖 `.mjs` / Playwright `*.spec.ts`）的单测。
 *
 * 判据来源：
 * - **AC-20 同源**（`03-验收方案.md` §5.5 + `01-方案:141` 的 J-15 裁定）：三份产物必须由同一个
 *   `stepsToCalls()` 中间表示 reduce 生成。②③ 按「步骤 ↔ 定位器逐条一致」判；①（Java POM）
 *   **结构里没有步骤**，按 J-15 改判「元素集合与 `steps[].elementId` 一一对应（数量 + locator 逐条相等）」。
 *   本文件把这三条各自写死，**不靠「三份看起来一样」**。
 * - **AC-5 明文检索**：三个产物里 grep 不到任何口令串（哨兵串只在本文件里用）。
 * - `[C-118]`：`pageobject.ts` 零改动——本文件顺手断言它的语言闸门还在。
 */

/** 哨兵口令（AC-5 的检索目标；只出现在本文件里，绝不进产物） */
const SENTINEL = 'Pw_AC5_9x!QZ';

/**
 * AC-20 的分母：1 份 5 步录制，navigate / click / fill / select / assert 各 1。
 * `steps[i].index === i` 是 AC-20 第 5 条（显式存、升序连续）。
 */
function fixture(): UiRecording {
  const stepList: UiStep[] = [
    // ① 打开页面（navigate 的「定位器」就是目标地址）
    newStep({ index: 0, action: 'navigate' }),
    // ② 点击
    newStep({ index: 1, action: 'click', locator: { kind: 'css', value: '#login' } }),
    // ③ 输入口令（值只存长度；valueRef 指向环境变量名）
    newStep({
      index: 2,
      action: 'fill',
      locator: { kind: 'css', value: '#account' },
      valueMeta: textValueMeta(11),
      valueRef: 'ACCOUNT',
      elementId: 'el-account',
    }),
    // ④ 下拉（只存序号，不存选项文本）
    newStep({
      index: 3,
      action: 'select',
      locator: { kind: 'css', value: '#city' },
      valueMeta: selectValueMeta(2),
      elementId: 'el-city',
    }),
    // ⑤ 断言
    newStep({ index: 4, action: 'assert', assert: { kind: 'url', contains: '/home' } }),
  ];
  return newRecording({
    id: 'rec-fixture',
    name: '登录后进首页',
    baseUrl: 'https://example.com/login',
    startedAt: '2026-11-26T10:00:00.000Z',
    updatedAt: '2026-11-26T10:02:00.000Z',
    steps: stepList,
  });
}

/** 抽取「产物里的定位器数组」：对 .spec.ts 按行解析，不依赖 calls（否则就是自证） */
function locatorsOf(code: string, id: 'mjs' | 'spec'): string[] {
  return id === 'mjs' ? extractMjsSelectors(code) : extractSpecLocators(code);
}

describe('S6 · 中间表示 stepsToCalls（AC-20 的地基）', () => {
  it('每个步骤一条调用，index 升序连续，且全都带可回放的「定位器值」', () => {
    const rec = fixture();
    const calls = stepsToCalls(rec);

    expect(calls).toHaveLength(rec.steps.length);
    expect(calls.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
    rec.steps.forEach((s, i) => expect(s.index).toBe(i));
    // 五步各自的「定位器值」：navigate=目标地址、assert=断言内容（都是该步在产物里唯一出现的字符串）
    expect(calls.map((c) => c.locatorValue)).toEqual([
      'https://example.com/login',
      '#login',
      '#account',
      '#city',
      '/home',
    ]);
    expect(calls[2].valueRef).toBe('ACCOUNT');
    expect(calls[3].selectedIndex).toBe(2);
    expect(calls[4].assert).toEqual({ kind: 'url', contains: '/home' });
  });

  it('三份产物都由 calls reduce 出来：②③ 的定位器数组逐元素相等（AC-20 第 3、4 条）', () => {
    const rec = fixture();
    const calls = stepsToCalls(rec);
    const aMjs = locatorsOf(buildMjsScript(rec).code, 'mjs');
    const aSpec = locatorsOf(buildSpecTs(rec).code, 'spec');

    // ② ③ 的长度 = 步骤数；且与中间表示的 locatorValue 逐条相等
    expect(aMjs).toHaveLength(rec.steps.length);
    expect(aSpec).toHaveLength(rec.steps.length);
    expect(aMjs).toEqual(calls.map((c) => c.locatorValue));
    expect(aSpec).toEqual(calls.map((c) => c.locatorValue));
    expect(aMjs).toEqual(aSpec);
  });

  it('① Java POM 按 J-15 判：元素集合与 elementId 一一对应，locator 逐条相等', () => {
    const rec = fixture();
    const calls = stepsToCalls(rec);
    const rows = pomRowsFromRecording(rec);
    // 只有「元素类步骤」进 POM：navigate / assert 不是元素（POM 结构里没有步骤概念）
    const elementCalls = calls.filter((c) => c.elementLike);
    expect(rows).toHaveLength(elementCalls.length);

    // 数量 + locator 逐条相等（J-15 的原话）
    expect(rows.map((r) => r.locator)).toEqual(elementCalls.map((c) => c.pomLocator));
    // elementId 一一对应：有 elementId 的步骤，元素行的 id 必须就是它（[C-110] 的唯一锚点）
    const withId = rec.steps.filter((s) => s.elementId);
    expect(withId).toHaveLength(2);
    for (const step of withId) {
      const row = rows.find((r) => r.locator === step.locator!.value);
      expect(row?.id).toBe(step.elementId);
    }
    // 没有 elementId 的元素步骤也要有 id（blankElement 在新建那一刻就给）
    rows.forEach((r) => expect(String(r.id || '')).not.toBe(''));
  });

  it('没有定位器的动作步骤不会静默少一步：给出 warnings 而不是悄悄消失', () => {
    const rec = newRecording({
      id: 'rec-degenerate',
      name: '缺定位器',
      baseUrl: 'https://example.com/',
      startedAt: '2026-11-26T10:00:00.000Z',
      steps: [newStep({ index: 0, action: 'click' })],
    });
    const mjs = buildMjsScript(rec);
    const spec = buildSpecTs(rec);
    expect(mjs.warnings.join()).toContain('第 1 步');
    expect(spec.warnings.join()).toContain('第 1 步');
    // 也不许给「没有定位器的那一步」编一个假定位器出来。
    // t32 起这里有且只有一条**起始导航**（`[C-10a]` D-1 的修复），它属于「步骤外的前置」，
    // 不是给 click 步补出来的假 selector —— 判定从「数组为空」改成「只有前置的 baseUrl」。
    expect(extractSpecLocators(spec.code)).toEqual([rec.baseUrl]);
    expect(extractMjsSelectors(mjs.code)).toEqual([rec.baseUrl]);
  });
});

describe('S6 · 零依赖 .mjs（Node ≥ 22）——【P3 · 本期未交付】', () => {
  it('单文件零依赖：没有 import / require，只碰 Node 22 才有的全局（fetch / WebSocket）', () => {
    const art = buildMjsScript(fixture());
    expect(art.ok).toBe(true);
    expect(art.lang).toBe('js');
    expect(art.filename.endsWith('.mjs')).toBe(true);
    expect(/\bimport\s/.test(art.code)).toBe(false);
    expect(/\brequire\(/.test(art.code)).toBe(false);
    // 全局 WebSocket 是 Node ≥ 22 才有的（Node 18/20 没有）——这正是前置条件的由来
    expect(art.code).toContain('new WebSocket(');
    expect(art.prereq).toContain('Node ≥ 22');
    expect(art.runCommand).toBe(`node ${art.filename}`);
  });

  it('值只走 process.env：缺环境变量 exit(2) + 中文提示', () => {
    const art = buildMjsScript(fixture());
    expect(art.code).toContain('process.env[');
    expect(art.code).toContain("'ACCOUNT'");
    expect(art.code).toContain('process.exit(2)');
    expect(art.code).toContain('缺少环境变量');
    // 环境变量清单来自 stepsToCalls（不是模板里另抄一份）
    expect(envRefsOf(stepsToCalls(fixture()))).toEqual(['ACCOUNT']);
  });

  it('产物里没有任何明文值（AC-5 哨兵串 0 命中），也不把「长度」当值用', () => {
    const rec = fixture();
    // 把哨兵串伪装成「用户可能误填」的各种位置：note / valueRef 之外的字段都不能把它带出去
    rec.steps[2].note = SENTINEL;
    const art = buildMjsScript(rec);
    expect(art.code).not.toContain(SENTINEL);
    expect(art.code).not.toContain('"length"');
    expect(art.code).toContain("'ACCOUNT'");
  });

  it('select 用选项序号回放（不写选项文本），press 用按键名', () => {
    const art = buildMjsScript(fixture());
    expect(art.code).toContain('index: 2');
    expect(art.code).toContain("'Enter'");
  });

  it('同一份录制生成两次逐字相等（无时间戳，[C-85]）', () => {
    const a = buildMjsScript(fixture());
    const b = buildMjsScript(fixture());
    expect(a.code).toBe(b.code);
  });
});

describe('S6 · Playwright *.spec.ts', () => {
  it('用 @playwright/test 语法 + test.use({ baseURL })，值走 process.env[...] ?? \'\'', () => {
    const art = buildSpecTs(fixture());
    expect(art.ok).toBe(true);
    expect(art.lang).toBe('ts');
    expect(art.filename.endsWith('.spec.ts')).toBe(true);
    expect(art.code).toContain("import { test, expect } from '@playwright/test';");
    expect(art.code).toContain('test.use({ baseURL: "https://example.com/login" });');
    expect(art.code).toContain("process.env['ACCOUNT'] ?? ''");
    expect(art.runCommand).toBe(`npx playwright test ${art.filename}`);
    expect(art.prereq).toContain('@playwright/test');
  });

  it('五种动作都有对应调用，断言用 toHaveURL + RegExp', () => {
    const code = buildSpecTs(fixture()).code;
    expect(code).toContain('await page.goto("https://example.com/login");');
    expect(code).toContain('await page.locator("#login").click();');
    expect(code).toContain("await page.locator(\"#account\").fill(process.env['ACCOUNT'] ?? '');");
    expect(code).toContain('await page.locator("#city").selectOption({ index: 2 });');
    expect(code).toContain('await expect(page).toHaveURL(new RegExp("/home"));');
  });

  it('产物里没有明文值（note 里塞哨兵串也不带出去）', () => {
    const rec = fixture();
    rec.steps[1].note = SENTINEL;
    rec.steps[2].valueRef = 'ACCOUNT';
    const art = buildSpecTs(rec);
    expect(art.code).not.toContain(SENTINEL);
    expect(art.code).toContain("process.env['ACCOUNT'] ?? ''");
  });
});

describe('S6 · Java POM 适配（[C-118]：生成器零改动）', () => {
  it('只调既有 generatePageObject：语言闸门没被动过（lang 仍只认 java）', () => {
    const res = generatePageObject({ className: 'X', baseUrl: 'https://a/', pageName: 'X', elements: [], lang: 'python' as never });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('暂只支持 Java（lang=java）');
  });

  it('产物是编译得过的 Java 骨架：class / 元素方法 / open()，且不写 System.getenv（[C-119] #4）', () => {
    const art = buildPomArtifact(fixture());
    expect(art.ok).toBe(true);
    expect(art.lang).toBe('java');
    expect(art.filename.endsWith('.java')).toBe(true);
    expect(art.code).toContain('public class ');
    expect(art.code).toContain('public void open()');
    expect(art.code).toContain('page.locator("#account")');
    // POM 不含步骤 ⇒ 不写 System.getenv（这是 [C-118] 与 [C-119] #4 的交叉口径）
    expect(art.code).not.toContain('System.getenv');
    // 产物里没有明文值
    expect(art.code).not.toContain(SENTINEL);
  });

  it('role 元素映射成 css（录制里的 role 候选本身就是 [role="x"] 这种合法 CSS）', () => {
    const rec = newRecording({
      id: 'rec-role',
      name: 'role 元素',
      baseUrl: 'https://example.com/',
      startedAt: '2026-11-26T10:00:00.000Z',
      steps: [newStep({ index: 0, action: 'click', locator: { kind: 'role', value: '[role="button"]', roleName: 'button' } })],
    });
    const rows = pomRowsFromRecording(rec);
    expect(rows[0].kind).toBe('css');
    expect(rows[0].locator).toBe('[role="button"]');
    expect(buildPomArtifact(rec).code).toContain('page.locator("[role=\\"button\\"]")');
  });

  it('text 元素去掉引擎前缀再交给生成器（pageobject 的 text 分支要的是裸文本）', () => {
    const rec = newRecording({
      id: 'rec-text',
      name: 'text 元素',
      baseUrl: 'https://example.com/',
      startedAt: '2026-11-26T10:00:00.000Z',
      steps: [newStep({ index: 0, action: 'click', locator: { kind: 'text', value: 'text=保存' } })],
    });
    const rows = pomRowsFromRecording(rec);
    expect(rows[0].locator).toBe('保存');
    expect(buildPomArtifact(rec).code).toContain('page.getByText("保存")');
  });
});

describe('S6 · 缺口与上限（不许静默）', () => {
  it('fill 没填 valueRef：给 warnings + 可检索的占位环境变量名，不生成空值', () => {
    const rec = newRecording({
      id: 'rec-noref',
      name: '缺环境变量名',
      baseUrl: 'https://example.com/',
      startedAt: '2026-11-26T10:00:00.000Z',
      steps: [newStep({ index: 0, action: 'fill', locator: { kind: 'css', value: '#pwd' }, valueMeta: textValueMeta(8) })],
    });
    const mjs = buildMjsScript(rec);
    const spec = buildSpecTs(rec);
    expect(mjs.warnings.join()).toContain('STEP_1_VALUE');
    expect(spec.warnings.join()).toContain('STEP_1_VALUE');
    expect(mjs.code).toContain('STEP_1_VALUE');
    expect(spec.code).toContain("process.env['STEP_1_VALUE']");
  });

  it('select 缺选项序号：给 warnings 并按 0 回放（不静默跳过、不少一步）', () => {
    const rec = newRecording({
      id: 'rec-noidx',
      name: '缺序号',
      baseUrl: 'https://example.com/',
      startedAt: '2026-11-26T10:00:00.000Z',
      steps: [newStep({ index: 0, action: 'select', locator: { kind: 'css', value: '#city' }, valueMeta: textValueMeta(2) })],
    });
    const art = buildSpecTs(rec);
    expect(art.warnings.join()).toContain('选项序号');
    expect(art.code).toContain('selectOption({ index: 0 })');
  });

  it('空录制也能出交付的两份产物（不崩、不编造元素）', () => {
    const rec = newRecording({ id: 'rec-empty', name: '空录制', baseUrl: 'https://example.com/', startedAt: '2026-11-26T10:00:00.000Z' });
    // t52：交付路径只产 pom + spec（.mjs 进 P3，见 buildMjsScript 的说明）
    const arts = buildArtifacts(rec, ['pom', 'mjs', 'spec']);
    expect(arts.map((a) => a.id)).toEqual(['pom', 'spec']);
    expect(arts.map((a) => a.ok)).toEqual([true, true]);
    expect(stepsToCalls(rec)).toEqual([]);
    expect(pomRowsFromRecording(rec)).toEqual([]);
  });

  it('三档前置条件逐条写进产物（01-方案 §5.4）', () => {
    expect(ARTIFACT_PREREQ.mjs).toContain('Node ≥ 22');
    expect(ARTIFACT_PREREQ.spec).toContain('@playwright/test');
    expect(ARTIFACT_PREREQ.pom).toContain('JDK');
    const arts = buildArtifacts(fixture(), ['pom', 'mjs', 'spec']);
    arts.forEach((a) => expect(a.prereq).toBe(ARTIFACT_PREREQ[a.id]));
  });
});

/** 抽出来的 locatorValue 允许被 `calls` 之外的代码看见吗？——只允许在 calls 里定义一次 */
function _typecheck(calls: ScriptCall[]) {
  return calls.map((c) => c.locatorValue);
}
void _typecheck;

/* ================================================================
   t32 回归：D-1（P1）——录制不带 navigate 时产物必须自带起始导航
   ================================================================ */

/**
 * S7（t25）AC-10a 的复现录制：**6 步纯 click/fill/select，没有 navigate**。
 *
 * 为什么真实录制长这样：浏览器是应用自己拉起来的（`record:start` 传 URL 给 Chrome），
 * 那次导航**不是录到的事件**，所以 `steps` 里永远不会出现 `navigate`。
 * 产物若不自带起始导航，干净环境（about:blank）回放第一步就找不到元素 —— D-1 的根因。
 */
function recordingWithoutNavigate(): UiRecording {
  return newRecording({
    id: 'rec-no-nav',
    name: 'AC-10a 复现：无导航',
    baseUrl: 'https://example.com/login',
    startedAt: '2026-11-25T12:00:00.000Z',
    steps: [
      newStep({ index: 0, action: 'fill', locator: { kind: 'css', value: '#account' }, valueMeta: textValueMeta(6), valueRef: 'STEP_1_VALUE' }),
      newStep({ index: 1, action: 'fill', locator: { kind: 'css', value: '#pwd' }, valueMeta: textValueMeta(6), valueRef: 'STEP_2_VALUE' }),
      newStep({ index: 2, action: 'select', locator: { kind: 'css', value: '#city' }, valueMeta: selectValueMeta(2) }),
      newStep({ index: 3, action: 'click', locator: { kind: 'css', value: '#login' } }),
      newStep({ index: 4, action: 'click', locator: { kind: 'css', value: 'body > button:nth-of-type(2)' } }),
      newStep({ index: 5, action: 'click', locator: { kind: 'css', value: '#go' } }),
    ],
  });
}

describe('t32 · 起始导航（D-1 回归）', () => {
  it('首条不是 navigate → 调用序列最前补一条「步骤外的前置」导航', () => {
    const rec = recordingWithoutNavigate();
    const calls = stepsToCalls(rec);

    // 6 步 + 1 条前置
    expect(calls).toHaveLength(rec.steps.length + 1);
    expect(calls[0].action).toBe('navigate');
    expect(calls[0].locatorValue).toBe(rec.baseUrl);
    // 打标：前置不是步骤（index=-1、preamble=true），这样它不会冒充第 1 步、也不进 POM 元素集合
    expect(calls[0].index).toBe(-1);
    expect(calls[0].preamble).toBe(true);
    expect(calls[0].elementLike).toBe(false);
    // 原有 6 步原样跟在后面
    expect(calls.slice(1).map((c) => c.locatorValue)).toEqual(rec.steps.map((s) => s.locator!.value));
    // 录制步骤的 index 仍是 0..5（补出来的导航不改写任何 step.index）
    expect(calls.slice(1).map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('首条已经是 navigate → 不重复补（各出现 1 次）', () => {
    const rec = fixture(); // 该 fixture 的 step 0 就是 navigate
    const calls = stepsToCalls(rec);
    expect(calls).toHaveLength(rec.steps.length);
    expect(calls.filter((c) => c.action === 'navigate')).toHaveLength(1);
    const code = buildMjsScript(rec).code;
    expect((code.match(/action: 'navigate'/g) || []).length).toBe(1);
    expect((buildSpecTs(rec).code.match(/await page\.goto\(/g) || []).length).toBe(1);
  });

  it('产物里 navigate / page.goto 各出现 1 次，且 URL 等于 baseUrl', () => {
    const rec = recordingWithoutNavigate();
    const mjs = buildMjsScript(rec).code;
    const spec = buildSpecTs(rec).code;

    // ⚠️ 数的是**步骤表里的动作行**：`dshStep` 的页内执行器里也有 `'navigate'` 字面量，
    // 用裸 grep `navigate` 会数成 2 次（S7 若按裸串判会假红）。
    expect((mjs.match(/action: 'navigate'/g) || []).length).toBe(1);
    expect((spec.match(/await page\.goto\(/g) || []).length).toBe(1);
    expect(spec).toContain(`await page.goto(${JSON.stringify(rec.baseUrl)});`);
    // 起始导航必须在最前（第一个 call 就是它）
    expect(extractMjsSelectors(mjs)[0]).toBe(rec.baseUrl);
    expect(extractSpecLocators(spec)[0]).toBe(rec.baseUrl);
    // 录制步骤数仍是 6（前置不计入），AC-10a 的「打印步骤数 = 录制步骤数」靠它
    expect(mjs).toContain('const RECORDED_STEPS = 6;');
    expect(mjs).toContain('录制步骤：6 步');
    expect(spec).toContain('（6 步）');
  });

  it('前置导航不进 POM 元素集合（J-15 的 elementId 一一对应不受影响）', () => {
    const rec = recordingWithoutNavigate();
    const rows = pomRowsFromRecording(rec);
    expect(rows).toHaveLength(6);
    expect(rows.map((r) => r.locator)).toEqual(rec.steps.map((s) => s.locator!.value));
  });

  it('没有 baseUrl 时不编造导航，改给可读告警', () => {
    const rec = recordingWithoutNavigate();
    const broken: UiRecording = { ...rec, baseUrl: '' };
    const calls = stepsToCalls(broken);
    expect(calls).toHaveLength(broken.steps.length);
    expect(calls.some((c) => c.preamble)).toBe(false);
    const mjs = buildMjsScript(broken);
    expect(mjs.warnings.join()).toContain('起始导航');
    expect(mjs.code).not.toContain("action: 'navigate'");
  });
});

describe('t32 · 失败提示不许是 undefined（D-1 回归）', () => {
  it('载荷按对象传入（不被 JSON.stringify 两次）', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    // 根因就是这两行：`const payload = JSON.stringify({...})` + `JSON.stringify(payload)`
    // → 页内收到的是字符串，step.action / step.selector 全是 undefined
    expect(code).toContain('const payload = {');
    expect(code).not.toContain('const payload = JSON.stringify(');
    expect(code).not.toContain('JSON.stringify(JSON.stringify');
    // 死代码（算出来没用的 expr）也不该留着
    expect(code).not.toContain('const expr = ');
  });

  it('步骤表带上「第几步」与真实 selector，外层失败提示引用它们', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain("no: 1");
    expect(code).toContain('selector: "#account"');
    // 外层提示用 step.no + step.selector，而不是拿循环下标凑数
    expect(code).toContain('step.no');
    expect(code).toContain('step.selector');
  });

  it('页内执行器：真跑一遍它，缺失元素时回报真实 selector；收到字符串载荷时给可读错误', async () => {
    // 直接执行生成物里那段 `dshStep`（jsdom 提供 document），证明「不再出现 undefined」
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    const start = code.indexOf('async function dshStep(');
    expect(start).toBeGreaterThan(0);
    const end = code.indexOf('\n}\n', start);
    const src = code.slice(start, end + 2);
    // eslint-disable-next-line no-new-func
    const dshStep = new Function(`return (${src})`)() as (step: unknown, value?: string) => Promise<string>;

    const missing = await dshStep({ action: 'fill', selector: '#__nope__' }, 'x');
    expect(missing).toBe('找不到元素：#__nope__');
    expect(String(missing)).not.toContain('undefined');

    // 防御纵深：万一又被双重编码成字符串，要说清「载荷格式不对」而不是「找不到元素：undefined」
    const asString = await dshStep(JSON.stringify({ action: 'fill', selector: '#account' }), 'x');
    expect(asString).toContain('载荷格式不对');
    expect(asString).not.toContain('找不到元素：undefined');
  });
});

/* ================================================================
   t40 回归（D-1 续）：等就绪 / 每步超时 / 上下文失效重连 / 任何终止都有输出
   ================================================================ */

/** 把产物里那段运行期助手（`RUNTIME_HELPERS`）真跑起来，拿到可调用的函数 */
function helpers() {
  // eslint-disable-next-line no-new-func
  return new Function(`${RUNTIME_HELPERS}; return { withTimeout, isContextLost, waitReady, evaluateWithRetry };`)() as {
    withTimeout: <T>(p: Promise<T>, ms: number, note?: string) => Promise<{ timedOut: boolean; value?: T; note?: string }>;
    isContextLost: (e: unknown) => boolean;
    waitReady: (
      evaluate: (expr: string) => Promise<string>,
      timeoutMs: number,
      sleepFn?: (ms: number) => Promise<void>,
    ) => Promise<{ ready: boolean; lastState: string }>;
    evaluateWithRetry: (
      send: (expression: string) => Promise<string>,
      attempts?: number,
      sleepFn?: (ms: number) => Promise<void>,
    ) => Promise<{ value: string; retries: number }>;
  };
}

const noSleep = async () => {};

describe('t40 · 导航后等就绪（不许固定 sleep 600）', () => {
  it('慢加载页（3s 才 ready）：轮询到 complete 才算好，且不再用固定等待', () => {
    const { waitReady } = helpers();
    let n = 0;
    // 模拟「3 秒才 ready」：前 10 次 loading，第 11 次 complete
    const evaluate = async () => { n += 1; return n <= 10 ? 'loading' : 'complete'; };
    return waitReady(evaluate, 10000, noSleep).then((r) => {
      expect(r.ready).toBe(true);
      expect(n).toBeGreaterThan(10);
      const code = buildMjsScript(recordingWithoutNavigate()).code;
      // 固定等待必须消失，改成 readyState 轮询
      expect(code).not.toContain('setTimeout(r, 600)');
      expect(code).toContain("document.readyState");
    });
  });

  it('页面一直不 ready：有界返回 false（不挂死），产物里有显式失败信息与 10s 上限', async () => {
    const { waitReady } = helpers();
    const t0 = Date.now();
    const r = await waitReady(async () => 'loading', 300, noSleep);
    expect(r.ready).toBe(false);
    expect(r.lastState).toBe('loading');
    expect(Date.now() - t0).toBeLessThan(3000);

    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain('const READY_TIMEOUT_MS = 10000');
    expect(code).toContain('页面仍未就绪');
    expect(code).toContain('当前 URL');
  });
});

describe('t40 · 每步都有超时', () => {
  it('永不返回的一步会被 withTimeout 判成超时（而不是挂死）', async () => {
    const { withTimeout } = helpers();
    const t0 = Date.now();
    const r = await withTimeout(new Promise<string>(() => { /* 永不 settle */ }), 120, '第 1 步（fill，#account）');
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(String(r.note)).toContain('第 1 步（fill，#account）');
  });

  it('产物里每步有 5s 超时，超时提示带「第 N 步（action，selector）」与当时 URL', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain('const STEP_TIMEOUT_MS = 5000');
    expect(code).toContain('超时（');
    expect(code).toContain('stepLabel(step)');
    expect(code).toMatch(/当前 URL/);
  });

  it('单条 CDP 命令也有超时，且不是把总超时调到 180s 混过去', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain('const CDP_TIMEOUT_MS');
    expect(code).toContain('CDP ');
    // 防「把超时调大到看起来不挂」：任何超时都必须远小于 S7 观测到的 180s
    const nums = Array.from(code.matchAll(/TIMEOUT_MS = (\d+)/g)).map((m) => Number(m[1]));
    expect(nums.length).toBeGreaterThanOrEqual(3);
    nums.forEach((n) => expect(n).toBeLessThan(180000));
  });
});

describe('t40 · 导航导致执行上下文失效后重连重试', () => {
  it('isContextLost 认得 context destroyed / target closed，不把普通错误当上下文失效', () => {
    const { isContextLost } = helpers();
    expect(isContextLost(new Error('Execution context was destroyed.'))).toBe(true);
    expect(isContextLost(new Error('Cannot find context with specified id'))).toBe(true);
    expect(isContextLost(new Error('CDP Runtime.evaluate 超时（4000ms）'))).toBe(true);
    expect(isContextLost(new Error('找不到元素：#account'))).toBe(false);
  });

  it('evaluateWithRetry：第一次抛上下文失效 → 重新取上下文后成功（最多 2 次重试）', async () => {
    const { evaluateWithRetry } = helpers();
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) throw new Error('Execution context was destroyed.');
      return 'complete';
    };
    const r = await evaluateWithRetry(send, 2, noSleep);
    expect(r.value).toBe('complete');
    expect(r.retries).toBe(1);
    expect(calls).toBe(2);

    // 一直失效 → 抛错（由上层带诊断退出），不无限重试
    const always = async () => { throw new Error('Execution context was destroyed.'); };
    await expect(evaluateWithRetry(always, 2, noSleep)).rejects.toThrow(/context/i);
  });
});

describe('t40 · 任何终止路径都必须有输出（禁止零输出退出）', () => {
  it('产物装上 uncaughtException / unhandledRejection / SIGTERM / SIGINT 四个兜底', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    for (const ev of ['uncaughtException', 'unhandledRejection', 'SIGTERM', 'SIGINT']) {
      expect(code).toContain(`process.on('${ev}'`);
    }
    // 兜底本身必须打印到 stderr 并 exit 1
    expect(code).toContain('console.error');
    expect(code).toContain('process.exit(1)');
  });

  it('WebSocket 断了要把在途命令全部 reject（否则 promise 永挂 → 零输出）', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain("addEventListener('close'");
    expect(code).toContain('连接已关闭');
    // 还有一条总看门狗，兜住任何没覆盖到的挂死
    expect(code).toContain('总时长超过');
  });
});

/* ================================================================
   t44 回归（D-1 降级 / 用户裁定）：场景契约写进产物头与界面，干净起步给人话
   ================================================================ */

describe('t44 · 产物②的场景契约（只声明「已打开目标页」，不声明干净起步）', () => {
  it('头注释写清三件前置 + 支持的场景 + 明确不支持 about:blank 起步', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    const head = code.slice(0, code.indexOf('*/'));
    // 场景契约：支持「已打开目标页」
    expect(head).toContain('场景契约');
    expect(head).toContain('已经打开了目标页');
    // 三条前置逐条在
    expect(head).toContain('Node ≥ 22');
    expect(head).toContain('--remote-debugging-port');
    expect(head).toContain('STEP_1_VALUE');
    // 明确写出不支持的那条
    expect(head).toContain('不支持');
    expect(head).toContain('about:blank');
    // 目标页地址要出现在头里（用户照做时不用去别处找）
    expect(head).toContain('https://example.com/login');
  });

  it('全部文案里不许出现结果承诺（「已验证可跑通」「保证跑通」这类）', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).not.toContain('已验证可跑通');
    expect(code).not.toContain('保证跑通');
    // 反过来：要有「不承诺/以实际运行为准」的口径
    expect(code).toContain('不在任何环境承诺结果');
    // 产物自带的前置串也照同一口径写
    expect(ARTIFACT_PREREQ.mjs).not.toContain('已验证可跑通');
  });
});

describe('t44 · 干净 about:blank 起步必须给人话（exit 1，不是静默失败）', () => {
  it('产物里有目标页检测：全是空白标签页时打印「请先」+ 目标 URL 并以 exit 1 退出', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    // 目标页地址单独成常量，提示里能直接引用
    expect(code).toContain('const BASE_URL = "https://example.com/login";');
    // 空白标签页识别 + 可照做的提示
    expect(code).toContain('about:blank');
    expect(code).toContain('请先用同一个 Chrome 打开');
    expect(code).toContain('不在支持范围');
    // 走 exitWith（stderr + exit 1），而不是继续往下跑：xitWith( 在消息**前面**
    expect(code).toMatch(/exitWith\('当前调试端口上没有打开目标页/);
  });

  it('页面已打开目标页时不会被拦（只拦空白标签页）', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    // t47 起选择逻辑换成「同源+同路径 > 同源 > 任意非空白」的评分制 + 有界等待，
    // 不再是 t44 那句前缀匹配（前缀匹配遇到 ?projectCode= 就失配，是 A 场景失败的根因之一）
    expect(code).toContain('async function chooseTarget()');
    expect(code).toContain('pickTargetWithWait');
    expect(code).toContain('TARGET_WAIT_MS');
    // 拦下只发生在「一个可用的都没有」时
    expect(code).toContain('if (!page) {');
  });
});

/* ================================================================
   t47 回归（D-1 第四次）：target 选择 / 上下文重连 / 导航后等「新 URL + complete」
   ================================================================ */

/** 把产物里那段「target 选择 + 上下文」助手真跑起来 */
function targeting() {
  // eslint-disable-next-line no-new-func
  // 产物里 RUNTIME_HELPERS 与 RUNTIME_TARGETING 是同一份生成文件里先后内联的，
  // `waitForUrlReady` 会用到 RUNTIME_HELPERS 里的 `isContextLost` —— 测试里必须两块一起加载，
  // 否则测的就不是「发出去的那份」了。
  return new Function(`${RUNTIME_HELPERS}; ${RUNTIME_TARGETING}; return { isBlankUrl, targetScore, pickTarget, pickTargetWithWait, waitForUrlReady, evaluateWithContext };`)() as {
    isBlankUrl: (u: string) => boolean;
    targetScore: (t: { type?: string; url?: string }, baseUrl: string) => number;
    pickTarget: (list: Array<{ id?: string; type?: string; url?: string }>, baseUrl: string) => { id?: string; url?: string } | null;
    pickTargetWithWait: (
      listFn: () => Promise<Array<{ id?: string; type?: string; url?: string }>>,
      baseUrl: string,
      timeoutMs: number,
      sleepFn?: (ms: number) => Promise<void>,
    ) => Promise<{ id?: string; url?: string } | null>;
    waitForUrlReady: (
      evaluate: (expr: string) => Promise<string>,
      expectUrl: string,
      timeoutMs: number,
      sleepFn?: (ms: number) => Promise<void>,
    ) => Promise<{ ready: boolean; url: string; state: string }>;
    evaluateWithContext: (
      send: (expr: string) => Promise<string>,
      opts?: { attempts?: number; onReacquire?: () => Promise<void>; sleepFn?: (ms: number) => Promise<void> },
    ) => Promise<{ value: string; retries: number; reacquired: number }>;
  };
}

const TARGET_URL = 'http://127.0.0.1:38023/stub?projectCode=abc&env=test';

describe('t47 · target 选择（别落到 about:blank）', () => {
  it('空白标签页与目标页并存 → 选目标页；查询串不同也算命中（同源+同路径优先）', () => {
    const { pickTarget, targetScore } = targeting();
    const list = [
      { id: 'blank', type: 'page', url: 'about:blank' },
      { id: 'target', type: 'page', url: 'http://127.0.0.1:38023/stub' }, // 录制的 BASE_URL 带查询串
    ];
    expect(targetScore(list[1], TARGET_URL)).toBeGreaterThan(targetScore(list[0], TARGET_URL));
    expect(pickTarget(list, TARGET_URL)!.id).toBe('target');
    // 反过来排也一样（不依赖 /json/list 的顺序碰运气）
    expect(pickTarget([list[1], list[0]], TARGET_URL)!.id).toBe('target');
  });

  it('同源不同路径 vs 同源同路径：同路径分更高', () => {
    const { targetScore } = targeting();
    const same = { type: 'page', url: 'http://127.0.0.1:38023/stub?x=1' };
    const other = { type: 'page', url: 'http://127.0.0.1:38023/other' };
    expect(targetScore(same, TARGET_URL)).toBeGreaterThan(targetScore(other, TARGET_URL));
  });

  it('chrome:// 与 about:blank 都算「不可用」，非 page 类型直接排除', () => {
    const { isBlankUrl, pickTarget } = targeting();
    expect(isBlankUrl('about:blank')).toBe(true);
    expect(isBlankUrl('chrome://settings/')).toBe(true);
    expect(isBlankUrl('chrome://newtab')).toBe(true);
    expect(isBlankUrl('http://127.0.0.1:38023/stub')).toBe(false);
    const list = [
      { id: 'w', type: 'service_worker', url: 'http://127.0.0.1:38023/sw.js' },
      { id: 'b', type: 'page', url: 'about:blank' },
    ];
    expect(pickTarget(list, TARGET_URL)).toBe(null);
  });

  it('只有空白 target 时**有界等待**：等不到才返回 null，等到了就用它', async () => {
    const { pickTargetWithWait } = targeting();
    const noSleep = async () => {};
    let round = 0;
    // 前 3 轮只有 about:blank，第 4 轮目标页 commit 完成
    const listFn = async () => {
      round += 1;
      return round <= 3
        ? [{ id: 'b', type: 'page', url: 'about:blank' }]
        : [{ id: 'b', type: 'page', url: 'about:blank' }, { id: 't', type: 'page', url: 'http://127.0.0.1:38023/stub' }];
    };
    const hit = await pickTargetWithWait(listFn, TARGET_URL, 5000, noSleep);
    expect(hit!.id).toBe('t');
    expect(round).toBe(4);

    // 一直只有空白 → 有界返回 null（不挂死）
    const t0 = Date.now();
    const miss = await pickTargetWithWait(async () => [{ id: 'b', type: 'page', url: 'about:blank' }], TARGET_URL, 300, noSleep);
    expect(miss).toBe(null);
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('t47 · 导航后等的是「新 URL + complete」，不是旧文档的 complete', () => {
  it('旧 about:blank 也是 complete —— 必须等 URL 变成目标页才算好', async () => {
    const { waitForUrlReady } = targeting();
    const seq = [
      '{"url":"about:blank","state":"complete"}',   // 旧文档：complete，但 URL 不对 → 不能算好
      '{"url":"http://127.0.0.1:38023/stub","state":"loading"}',
      '{"url":"http://127.0.0.1:38023/stub","state":"complete"}',
    ];
    let i = 0;
    const r = await waitForUrlReady(async () => seq[Math.min(i++, seq.length - 1)], TARGET_URL, 5000, async () => {});
    expect(r.ready).toBe(true);
    expect(r.url).toContain('/stub');
    expect(i).toBeGreaterThanOrEqual(3);
  });

  it('URL 一直不变 → 有界返回 not ready，并带回当时 URL/状态供提示使用', async () => {
    const { waitForUrlReady } = targeting();
    const t0 = Date.now();
    const r = await waitForUrlReady(async () => '{"url":"about:blank","state":"complete"}', TARGET_URL, 300, async () => {});
    expect(r.ready).toBe(false);
    expect(r.url).toBe('about:blank');
    expect(r.state).toBe('complete');
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('t47 · 上下文丢失要重连', () => {
  it('Cannot find context / Execution context was destroyed → 重取上下文后重试（≤2）', async () => {
    const { evaluateWithContext } = targeting();
    let calls = 0; let reacquired = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) throw new Error('Cannot find context with specified id');
      return 'ok';
    };
    const r = await evaluateWithContext(send, {
      attempts: 2,
      onReacquire: async () => { reacquired += 1; },
      sleepFn: async () => {},
    });
    expect(r.value).toBe('ok');
    expect(r.retries).toBe(1);
    expect(reacquired).toBe(1);

    // 一直失败 → 抛（由上层带诊断退出），且不会无限重试
    let n = 0;
    await expect(evaluateWithContext(async () => { n += 1; throw new Error('Execution context was destroyed.'); },
      { attempts: 2, onReacquire: async () => {}, sleepFn: async () => {} })).rejects.toThrow(/context/i);
    expect(n).toBe(3);
  });

  it('普通业务失败不触发重连（别把「找不到元素」当上下文问题）', async () => {
    const { evaluateWithContext } = targeting();
    let reacquired = 0;
    await expect(evaluateWithContext(async () => { throw new Error('找不到元素：#account'); },
      { attempts: 2, onReacquire: async () => { reacquired += 1; }, sleepFn: async () => {} })).rejects.toThrow('找不到元素');
    expect(reacquired).toBe(0);
  });
});

describe('t47 · PM_DEBUG 打点', () => {
  it('产物里三样打点都在，并且只在 PM_DEBUG=1 时输出', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain("process.env.PM_DEBUG");
    expect(code).toContain('[pm-debug]');
    // 三样：候选列表 / 选中的 target / 每次 evaluate 的 executionContextId
    expect(code).toContain('候选');
    expect(code).toContain('选中 target');
    expect(code).toContain('executionContextId');
  });
});

/* ================================================================
   t50 回归（D-1 第五次）：Page.navigate + loadEventFired 替代「evaluate 里导航」
   ================================================================ */

describe('t50 · 导航改用 Page.navigate（不在旧上下文里执行导航）', () => {
  it('产物用 Page.navigate 发起导航，导航步不再走 evaluate(dshStep)', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain("'Page.navigate'");
    expect(code).toContain('async function navigate(url)');
    // 主循环里 navigate 步走 navigate()，而不是 client.evaluate(dshStep…)
    expect(code).toContain('const nav = await client.navigate(step.selector)');
    // 静默失败不允许：要打 frameId/loaderId/errorText
    expect(code).toContain('frameId');
    expect(code).toContain('errorText');
  });

  it('导航后重发 Page.enable + Runtime.enable（两处 enable 至少各两次）', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    const pageEnable = (code.match(/'Page\.enable'/g) || []).length;
    const rtEnable = (code.match(/'Runtime\.enable'/g) || []).length;
    expect(pageEnable).toBeGreaterThanOrEqual(2);
    expect(rtEnable).toBeGreaterThanOrEqual(2);
    expect(code).toContain('async function enableDomains(why');
    expect(code).toContain("enableDomains('导航后')");
  });

  it('导航后等 loadEventFired 并等「新的 executionContextId」', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain("waitEvent('Page.loadEventFired'");
    expect(code).toContain('async function waitNewContext(');
    expect(code).toContain('ctxSeq');
  });
});

describe('t50 · 上下文不可用时主动重取（不是干等 10 s）', () => {
  it('readyFor 的探测遇到上下文丢失 → 主动重发 enable + 重取上下文再试', async () => {
    const { waitForUrlReady } = targeting() as unknown as {
      waitForUrlReady: (
        evaluate: (expr: string) => Promise<string>,
        expectUrl: string,
        timeoutMs: number,
        sleepFn?: (ms: number) => Promise<void>,
        onLost?: () => Promise<void>,
      ) => Promise<{ ready: boolean; url: string; state: string }>;
    };
    let lost = 0;
    let probes = 0;
    const seq = [
      () => { probes += 1; throw new Error('Cannot find context with specified id'); },
      () => '{"url":"http://127.0.0.1:38023/stub","state":"complete"}',
    ];
    const t0 = Date.now();
    const r = await waitForUrlReady(
      async () => seq[Math.min(probes, seq.length - 1)](),
      'http://127.0.0.1:38023/stub?projectCode=abc&env=test',
      10000,
      async () => {},
      async () => { lost += 1; },
    );
    expect(r.ready).toBe(true);
    expect(lost).toBe(1);
    // 关键：走的是「重取后立刻重试」，不是等满 10 s
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('t50 · PM_DEBUG 把底层错误码打出来', () => {
  it('CDP 回包错误要打印 code+message（修不动时这组读数能直接定位）', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain('error.code');
    expect(code).toContain("'CDP ← error");
    // 错误对象要带上 code，供上层判断/打点
    expect(code).toContain('err.code = msg.error.code');
  });
});

/* ================================================================
   t52 回归（用户裁定）：产物② .mjs 从交付中拿掉（UI 断 + 导出断 + 代码留 P3）
   ================================================================ */

describe('t52 · 导出路径断：buildArtifacts 不再产出 .mjs', () => {
  it('默认调用只给两份（pom + spec），不含 mjs', () => {
    const arts = buildArtifacts(recordingWithoutNavigate(), ['pom', 'spec']);
    expect(arts.map((a) => a.id)).toEqual(['pom', 'spec']);
    expect(arts.some((a) => a.id === 'mjs')).toBe(false);
    expect(arts.some((a) => a.filename.endsWith('.mjs'))).toBe(false);
  });

  it('即便调用方显式要 mjs，也不会产出（不能只隐藏 UI 而 API 仍可导出）', () => {
    const arts = buildArtifacts(recordingWithoutNavigate(), ['pom', 'mjs', 'spec']);
    expect(arts.map((a) => a.id)).toEqual(['pom', 'spec']);
    expect(JSON.stringify(arts.map((a) => a.filename))).not.toContain('.mjs');
  });

  it('生成逻辑仍在（P3 重做起点），只是不进交付路径', () => {
    // buildMjsScript 本身还能产出内容 —— 保留是为了 P3，不等于「已交付」
    const mjs = buildMjsScript(recordingWithoutNavigate());
    expect(mjs.code.length).toBeGreaterThan(0);
    expect(mjs.filename.endsWith('.mjs')).toBe(true);
    // 而交付入口不再返回它
    expect(buildArtifacts(recordingWithoutNavigate(), ['pom', 'mjs', 'spec']).some((a) => a.id === 'mjs')).toBe(false);
  });
});

/**
 * ⚠️ 本组只覆盖**有录制数据**的状态（ec 非 null）。
 * 空态（用户在没录过之前看到的 mptyHint）当年漏验，t53 复包时在安装包里命中过旧文案—— 
 * 空态由 src/pages/__tests__/recorderArtifactsCopy.test.tsx 覆盖（t54 补的假绿）。
 * 改这两条时别只跑本文件：**两个状态都要跑**。
 */
describe('t52 · 界面断：ArtifactPicker 只提供两项，.mjs 0 命中', () => {
  it('渲染后只有「Java POM」与「Playwright .spec.ts」，没有 .mjs 选项/文案/代码块', async () => {
    (window as any).electronAPI = {
      wsGet: async () => ({ success: true, data: [] }),
      wsSet: async () => ({ success: true }),
      clipboardCopy: async () => ({ success: true }),
    };
    // 本文件是 .ts（不改扩展名），所以用 createElement 而不是 JSX
    const { container } = render(createElement(ArtifactPicker, { rec: recordingWithoutNavigate() }));
    // 等引用完整性检查完成 + 产物渲染
    await waitFor(() => expect(container.querySelectorAll('pre.tb-pre.dev-code[data-artifact]').length).toBe(2));

    const ids = Array.from(container.querySelectorAll('pre.tb-pre.dev-code')).map((p) => p.getAttribute('data-artifact'));
    expect(ids).toEqual(['pom', 'spec']);

    // 选项按钮：两项，且不含 .mjs
    const btns = Array.from(container.querySelectorAll('.view-switch-btn')).map((b) => (b.textContent || '').trim());
    expect(btns).toEqual(['① Java POM', '③ Playwright .spec.ts']);

    // 全文（DOM 文本）里不许出现 .mjs / 零依赖 .mjs / 回放 这类会让人以为还有第三份的字样
    const text = container.textContent || '';
    expect(text).not.toContain('.mjs');
    expect(text).not.toContain('零依赖');
    expect(container.querySelector('[data-artifact-limit="mjs"]')).toBeNull();
    expect(container.querySelector('[data-artifact-block="mjs"]')).toBeNull();

    // 两项各自带自己的前置（不暗示等价）
    const limits = Array.from(container.querySelectorAll('[data-artifact-limit]')).map((el) => (el.textContent || ''));
    expect(limits).toHaveLength(2);
    expect(limits[0]).toContain('JDK');
    expect(limits[0]).toContain('jar');
    expect(limits[1]).toContain('@playwright/test');
  });
});

describe('t52 · readyFor 兜底有界且有输出（t51 的 60s 零输出缺陷）', () => {
  it('上下文永不恢复时：重取次数有上限、立刻返回 not-ready，不拖到外部杀进程', async () => {
    const { waitForUrlReady } = targeting() as unknown as {
      waitForUrlReady: (
        evaluate: (expr: string) => Promise<string>,
        expectUrl: string,
        timeoutMs: number,
        sleepFn?: (ms: number) => Promise<void>,
        onLost?: () => Promise<void>,
      ) => Promise<{ ready: boolean; url: string; state: string; reason?: string }>;
    };
    let lost = 0;
    const t0 = Date.now();
    const r = await waitForUrlReady(
      async () => { throw new Error('Cannot find context with specified id'); },
      'http://127.0.0.1:38023/stub',
      30000,
      async () => {},
      async () => { lost += 1; },
    );
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('context-lost');
    // 额度有上限（2 次），不是无限重取
    expect(lost).toBe(2);
    // 远小于 30 s（外部超时上限），证明不会静默拖死
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('产物里导航步有总预算 + 到点必输出中文诊断并 exit 1', () => {
    const code = buildMjsScript(recordingWithoutNavigate()).code;
    expect(code).toContain('NAV_STEP_BUDGET_MS');
    expect(code).toContain('REACQUIRE_TIMEOUT_MS');
    expect(code).toContain('MAX_CONTEXT_RETRY');
    // 超时分支必须 exitWith（stderr + exit 1），且文案含「超时」与「当前 URL」
    expect(code).toMatch(/if \(navStep\.timedOut\)/);
    expect(code).toContain("'超时（' + NAV_STEP_BUDGET_MS");
    expect(code).toContain('当前 URL');
    // 重取失败也要有 reason 打到提示里，便于定位
    expect(code).toContain("'，reason=' + String(ready.reason");
  });
});
