/**
 * ② Playwright codegen 脚本 → 候选元素（1.36.0 / B6）。
 *
 * codegen 产出的是「动作行」：`await page.getByRole('button', { name: '登录' }).click();`。
 * 元素库只存**定位**，所以每行要剥掉动作尾巴（`.click()` / `.fill('x')` …），再按定位器种类分流：
 *
 * | 链 | kind | 把握度 | 为什么 |
 * |---|---|---|---|
 * | `getByRole('button', { name })` | `role` | exact | 角色 + 可访问名，语义稳定（[C-28]） |
 * | `getByText('x')` | `text` | exact | 就是可见文本类型本身 |
 * | `locator('#id')` / `locator('.cls')` | `css` | 按 css 判 | id/属性 exact，class/结构 guess |
 * | `filter({ hasText })` / `nth()` / `or()` / `and()` | `pw` | guess | 元素库只有 4+1 种定位器，这种链只能原样存 |
 * | `getByPlaceholder` / `getByLabel` / `getByTestId` | `pw` | guess | 没有对应 kind；原样存给生成器转 Java |
 *
 * **不静默降级**：凡是被迫用 `pw` 收下的，一律 `guess` + 一句 reason（预览表里单独一列显示）。
 */

import type { ElementPasteCandidate, PasteConfidence } from './types';
import { nameHint } from './types';

/** 动作尾巴（元素库只存定位，不存动作） */
const TAIL_ACTION = /\.(click|dblclick|fill|type|press|hover|check|uncheck|selectOption|setInputFiles|tap|focus|blur|clear|scrollIntoViewIfNeeded|waitFor|screenshot|evaluate|count|innerText|textContent|getAttribute|isVisible|isEnabled|inputValue|dispatchEvent|dragTo|selectText|setChecked)\(/;

/** 从一行里取 `page.` 起、剥掉动作尾巴的链 */
function chainOfLine(line: string): string {
  const at = line.indexOf('page.');
  if (at < 0) return '';
  let chain = line.slice(at).trim();
  const tail = chain.match(TAIL_ACTION);
  if (tail && typeof tail.index === 'number') chain = chain.slice(0, tail.index);
  return chain.replace(/;\s*$/, '').trim();
}

/** 取第一个参数（字符串字面量） */
function firstArg(chain: string, method: string): string {
  const i = chain.indexOf(`${method}(`);
  if (i < 0) return '';
  const rest = chain.slice(i + method.length + 1);
  const m = rest.match(/^\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/);
  return m ? m[2].replace(/\\(['"\\])/g, '$1') : '';
}

/** `{ name: '登录' }` 里的 name */
function optionName(chain: string): string {
  const m = chain.match(/\bname\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/);
  return m ? m[2] : '';
}

/** css 的把握度（与 parseRecorder 同一口径，避免两处判断不一致） */
function cssConfidence(css: string): { confidence: PasteConfidence; reason: string } {
  const s = String(css ?? '').trim();
  if (!s) return { confidence: 'unknown', reason: '空选择器' };
  if (/:[a-z-]+\(|:(nth|first|last)/i.test(s)) {
    return { confidence: 'guess', reason: 'css 带结构性伪类，列表顺序一变就指错行' };
  }
  if (/^#[\w-]+$/.test(s)) return { confidence: 'exact', reason: '按 id 定位' };
  if (/^\[[^\]]+="[^"]*"\]$/.test(s)) return { confidence: 'exact', reason: '按属性精确定位' };
  if (/^\.[\w-]+$/.test(s) || /^[a-z][\w-]*\.[\w-]+/i.test(s)) {
    return { confidence: 'guess', reason: '按 class 定位，样式改名或同类多行时会失配' };
  }
  if (/^[a-z][\w-]*$/i.test(s)) return { confidence: 'guess', reason: '只有标签名，页面上通常不止一个' };
  return { confidence: 'exact', reason: 'codegen 记录的 css 选择器（含 id/属性组合，通常唯一）' };
}

/** 名字建议：优先 hasText → placeholder → 可见文本 → 角色名 → css */
function suggestName(chain: string): string {
  const hasText = chain.match(/has(?:Not)?Text\s*:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/);
  if (hasText && hasText[2].trim()) return nameHint(hasText[2]);
  const ph = firstArg(chain, 'getByPlaceholder');
  if (ph) return nameHint(ph);
  const text = firstArg(chain, 'getByText');
  if (text) return nameHint(text);
  const roleName = optionName(chain);
  if (roleName) return nameHint(roleName);
  const css = firstArg(chain, 'locator');
  if (css) return nameHint(css);
  return '未命名元素';
}

/** 解析一行 codegen 代码 → 候选（不是定位行就返回 null） */
function candidateOfLine(line: string): ElementPasteCandidate | null {
  const chain = chainOfLine(line);
  if (!chain) return null;
  if (!/\.(getBy[A-Za-z]+|locator)\(/.test(chain)) return null;

  const name = suggestName(chain);

  // 只能原样存的链（元素库没有对应 kind）→ pw / guess
  const pwReason = (() => {
    if (/\.(filter|nth|or|and|first|last)\(/.test(chain)) {
      return '这是「定位器 + 过滤/多候选」的整条链，元素库只能原样存成 Playwright 链';
    }
    for (const m of ['getByPlaceholder', 'getByLabel', 'getByTestId', 'getByAltText', 'getByTitle']) {
      if (chain.includes(`${m}(`)) return `codegen 用的是 ${m}()，元素库没有这种定位器类型，只能原样存成 Playwright 链`;
    }
    return '';
  })();
  if (pwReason) {
    return { name, locator: chain, kind: 'pw', confidence: 'guess', reason: `Playwright codegen：${pwReason}`, source: 'playwright-js' };
  }

  if (chain.includes('getByRole(')) {
    const role = firstArg(chain, 'getByRole');
    const nameOpt = optionName(chain);
    if (role) {
      return {
        name, locator: role.toLowerCase(), kind: 'role', ...(nameOpt ? { role: nameOpt } : {}),
        confidence: nameOpt ? 'exact' : 'guess',
        reason: nameOpt ? 'Playwright codegen：角色 + 可访问名，语义稳定' : 'Playwright codegen：只有角色名，没有可访问名',
        source: 'playwright-js',
      };
    }
  }
  if (chain.includes('getByText(')) {
    const v = firstArg(chain, 'getByText');
    if (v) return { name: nameHint(v), locator: v, kind: 'text', confidence: 'exact', reason: 'Playwright codegen：getByText，就是可见文本类型', source: 'playwright-js' };
  }
  const css = firstArg(chain, 'locator');
  if (css) {
    const c = cssConfidence(css);
    return { name, locator: css, kind: 'css', confidence: c.confidence, reason: `Playwright codegen：${c.reason}`, source: 'playwright-js' };
  }
  return null;
}

/**
 * 解析 Playwright codegen 脚本（可多行）。
 * 认不出定位行 → 空数组（调用方显示「无法识别」并写 0 条）。
 */
export function parsePlaywright(text: string): ElementPasteCandidate[] {
  const out: ElementPasteCandidate[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('page.')) continue;
    const c = candidateOfLine(line);
    if (!c) continue;
    const key = `${c.kind}|${c.locator}`;
    if (seen.has(key)) continue; // 同一个元素被连点两次时只留一条
    seen.add(key);
    out.push(c);
  }
  return out;
}
