import { describe, it, expect } from 'vitest';
import {
  SETTINGS_TAB_KEY,
  SETTINGS_TABS,
  SETTINGS_TAB_IDS,
  LEGACY_TAB_MAP,
  normalizeSettingsTab,
} from '../settingsTab';
import type { SettingsTab } from '../settingsTab';
import * as settingsTabModule from '../settingsTab';

/**
 * 设置页 7 tab 的唯一真源 —— 契约 `docs/契约-设置细分-免密-卸载.md` §1.1 / §1.2 / §1.3 / D1，
 * 判据见 `docs/验收-设置细分-免密-卸载.md` 的 AC-TAB-01 / AC-TAB-03 / AC-TAB-04 / AC-TAB-05 / AC-TAB-06。
 *
 * 这条单测存在的唯一理由：**历史 localStorage id 漏映射一条 = 老用户打开设置页白屏**，
 * 而 Settings.tsx 有 2500 行且 import React，测不了。所以把归一化下沉成纯函数（D1）后在这里兜。
 */

/** 契约 §1.1 的 7 个 id，顺序即 rail 顺序（不改源码，只在测试里复述一遍用于对表） */
const CONTRACT_IDS: SettingsTab[] = ['security', 'appearance', 'interaction', 'data', 'tasks', 'about', 'danger'];

/** 契约 §1.1 允许的 7 个图标键（全部来自 src/components/ui.tsx 的 Icons） */
const CONTRACT_ICONS = ['lock', 'tool', 'key', 'db', 'clock', 'note', 'trash'];

/**
 * 契约 §1.3 的 28 条必测输入（逐字照抄契约）+ 额外的脏值。
 * 用 `unknown` 装，因为脏数据本来就是「不是 tab id 的东西」。
 */
const CONTRACT_INPUTS: unknown[] = [
  null, undefined, '', '   ',
  'general', 'browser', 'shortcuts', 'security', 'data', 'appearance', 'tasks', 'about',
  'interaction', 'danger', 'update', 'backup', 'password', 'hotkey', 'tray', 'theme', 'uninstall',
  'Appearance', '  DANGER ', 'unknown-xyz', '__proto__', 'constructor', '0', '[object Object]',
];

const normalize = (raw: unknown) => normalizeSettingsTab(raw as string | null | undefined);

describe('settingsTab §1.1：id 全集与顺序（rail 与内容区同源）', () => {
  it('SETTINGS_TAB_IDS 恰为 7 个，且顺序 = 契约 §1.1', () => {
    expect(SETTINGS_TAB_IDS.length).toBe(7);
    expect([...SETTINGS_TAB_IDS]).toEqual(CONTRACT_IDS);
  });

  it('SETTINGS_TABS 与 SETTINGS_TAB_IDS 同源（nav 与 switch 不能各写一份）', () => {
    expect(SETTINGS_TABS.map(t => t.id)).toEqual([...SETTINGS_TAB_IDS]);
  });

  it('7 个 tab 的 label / hint / icon 都非空，icon 只取 7 个允许键，label 不重复', () => {
    expect(SETTINGS_TABS.length).toBe(7);
    for (const t of SETTINGS_TABS) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.hint.trim().length).toBeGreaterThan(0);
      expect(CONTRACT_ICONS).toContain(t.icon);
    }
    const labels = SETTINGS_TABS.map(t => t.label);
    expect(new Set(labels).size).toBe(7);
  });

  it('localStorage 键名不换（老用户的值直接复用）', () => {
    expect(SETTINGS_TAB_KEY).toBe('pm.settings.tab');
  });
});

describe('settingsTab §1.2：LEGACY_TAB_MAP 全量映射（漏一条 = 白屏）', () => {
  it('表是 19 键，且是 null 原型对象（原型链攻击面的防御真的生效）', () => {
    expect(Object.keys(LEGACY_TAB_MAP).length).toBe(19);
    // 下面三条是「防御生效」的正面证据：不是碰巧查不到，而是根本没有原型链
    expect(Object.getPrototypeOf(LEGACY_TAB_MAP)).toBeNull();
    expect('constructor' in LEGACY_TAB_MAP).toBe(false);
    expect('__proto__' in LEGACY_TAB_MAP).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(LEGACY_TAB_MAP, 'constructor')).toBe(false);
  });

  it('表里的值必须全部 ∈ §1.1 的 7 个 id（不许映射到不存在的 tab）', () => {
    for (const [key, value] of Object.entries(LEGACY_TAB_MAP)) {
      expect(CONTRACT_IDS).toContain(value);
      expect(key.trim()).toBe(key);
    }
  });

  it('v1.35 及更早的 6 个历史 id 各自落到契约指定 tab', () => {
    expect(normalize('general')).toBe('appearance');
    expect(normalize('browser')).toBe('interaction');
    expect(normalize('shortcuts')).toBe('interaction');
    expect(normalize('security')).toBe('security');
    expect(normalize('tasks')).toBe('tasks');
    expect(normalize('data')).toBe('data');
  });

  it('历史别名（update / backup / password / hotkey / hotkeys / tray / theme / background）全覆盖', () => {
    expect(normalize('update')).toBe('about');
    expect(normalize('backup')).toBe('data');
    expect(normalize('password')).toBe('security');
    expect(normalize('hotkey')).toBe('interaction');
    expect(normalize('hotkeys')).toBe('interaction');
    expect(normalize('tray')).toBe('interaction');
    expect(normalize('theme')).toBe('appearance');
    expect(normalize('background')).toBe('appearance');
  });

  it('本次新增的 danger / interaction / uninstall 三条也能落位（深链直接用）', () => {
    expect(normalize('danger')).toBe('danger');
    expect(normalize('interaction')).toBe('interaction');
    expect(normalize('uninstall')).toBe('danger');
  });

  it('v1.36 的 5 tab 全体原样可用（security/data/appearance/tasks/about）', () => {
    for (const id of ['security', 'data', 'appearance', 'tasks', 'about']) {
      expect(normalize(id)).toBe(id);
    }
  });

  // 每个键单独一条 it：漏一条就是一个老用户白屏，逐键红才看得出漏了哪条
  for (const [legacy, target] of Object.entries(LEGACY_TAB_MAP)) {
    it(`映射表逐键：'${legacy}' → '${target}'`, () => {
      expect(normalize(legacy)).toBe(target);
      expect(LEGACY_TAB_MAP[legacy]).toBe(target);
    });
  }
});

describe('settingsTab §1.3：脏值与原型链攻击面一律回 security', () => {
  it('null / undefined / 空串 / 纯空白 → security', () => {
    expect(normalize(null)).toBe('security');
    expect(normalize(undefined)).toBe('security');
    expect(normalize('')).toBe('security');
    expect(normalize('   ')).toBe('security');
    expect(normalize('\t\n')).toBe('security');
  });

  it('非字符串（对象 / 数字 / 数组 / 布尔 / 函数）→ security，不抛异常', () => {
    for (const raw of [{}, { id: 'danger' }, 42, 0, [], ['danger'], true, false, () => 'danger']) {
      expect(() => normalize(raw)).not.toThrow();
      expect(normalize(raw)).toBe('security');
    }
  });

  it("'[object Object]' / '0' / 未知 id → security（兜底值唯一）", () => {
    expect(normalize('[object Object]')).toBe('security');
    expect(normalize('0')).toBe('security');
    expect(normalize('unknown-xyz')).toBe('security');
    expect(normalize('security2')).toBe('security');
    expect(normalize('danger ')).toBe('danger'); // 这个是合法的（trim 后命中）
  });

  it('__proto__ / constructor / toString / valueOf / hasOwnProperty → security（原型链不得命中）', () => {
    for (const raw of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'prototype']) {
      expect(normalize(raw)).toBe('security');
    }
    // 顺带把「表本身不会被这些键命中」也钉住
    expect(Object.prototype.hasOwnProperty.call(LEGACY_TAB_MAP, '__proto__')).toBe(false);
    expect(LEGACY_TAB_MAP['__proto__']).toBeUndefined();
    expect(LEGACY_TAB_MAP['constructor']).toBeUndefined();
  });

  it('大小写与首尾空白不影响归位（"  DANGER " / "Appearance" / "  GENERAL  "）', () => {
    expect(normalize('  DANGER ')).toBe('danger');
    expect(normalize('Appearance')).toBe('appearance');
    expect(normalize('  GENERAL  ')).toBe('appearance');
    expect(normalize('ShOrTcUtS')).toBe('interaction');
    expect(normalize('\tTASKS\n')).toBe('tasks');
  });
});

describe('settingsTab §1.3：幂等 / 值域 / 副作用', () => {
  it('幂等：f(f(x)) === f(x) 对 §1.3 的 28 条输入 + 额外脏值全部成立', () => {
    const extraDirty: unknown[] = ['__proto__', 'constructor', 'Appearance', '  DANGER ', '[object Object]', '0', 42, null];
    for (const raw of [...CONTRACT_INPUTS, ...extraDirty]) {
      const once = normalize(raw);
      expect(normalize(once)).toBe(once);
    }
  });

  it('值域封闭：任意输入的结果都 ∈ 7 个 id', () => {
    const inputs: unknown[] = [...CONTRACT_INPUTS, 'hasOwnProperty', 'lambda', '  about  ', 'DANGER', '-1'];
    for (const raw of inputs) {
      expect(CONTRACT_IDS).toContain(normalize(raw));
    }
  });

  it('28 条契约输入逐条可判定（每条都能给出一个合法 tab，没有一条返回空）', () => {
    expect(CONTRACT_INPUTS.length).toBe(28);
    for (const raw of CONTRACT_INPUTS) {
      const out = normalize(raw);
      expect(typeof out).toBe('string');
      expect(CONTRACT_IDS).toContain(out);
    }
  });

  it('无副作用：连续调用同一输入结果恒定（不读写 localStorage、不依赖调用次数）', () => {
    expect(normalize('general')).toBe(normalize('general'));
    expect(normalize('__proto__')).toBe(normalize('__proto__'));
    expect(normalize('unknown-xyz')).toBe(normalize('unknown-xyz'));
  });
});

describe('settingsTab：模块边界（D1 的下沉约束）', () => {
  it('纯 TS：导出面 5 个值（类型不占运行时），值里没有任何 React/Node 对象', () => {
    const names = Object.keys(settingsTabModule).filter(k => k !== 'default').sort();
    expect(names).toEqual([
      'LEGACY_TAB_MAP',
      'SETTINGS_TABS',
      'SETTINGS_TAB_IDS',
      'SETTINGS_TAB_KEY',
      'normalizeSettingsTab',
    ]);
    // 图标只存键名（字符串），不是 React 节点 —— 下沉失败的话这里会是 object
    for (const t of SETTINGS_TABS) expect(typeof t.icon).toBe('string');
  });
});
