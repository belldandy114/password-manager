/**
 * 全局快捷键的键盘事件 → Electron 加速键转换。
 * 单独放一份是为了能单测（Settings 里的捕获逻辑很脆，写错一个 code 名就崩）。
 */

/** 只取需要的字段，方便单测构造 */
export interface KeyLike {
  code: string;
  key?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** 非字母数字键的 code → Electron 键名 */
const CODE_MAP: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/**
 * 生成 Electron 加速键（`CommandOrControl+Shift+P` 这种）。
 * 返回 null 表示这个按法不支持：单个修饰键、没带修饰键、或不认识的键。
 */
export function accelFromKeyEvent(e: KeyLike): string | null {
  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  // 必须带 Ctrl/Alt：全局裸键（包括只加 Shift 的）容易和输入、系统快捷键打架
  if (!mods.length) return null;
  if (mods.length === 1 && mods[0] === 'Shift') return null;

  const code = e.code || '';
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) key = code;
  else if (CODE_MAP[code]) key = CODE_MAP[code];
  else return null;

  return [...mods, key].join('+');
}

/** 加速键 → 给用户看的名字：`Ctrl+空格` / `Ctrl+Shift+P` */
export function accelLabel(accel: string): string {
  return String(accel || '')
    .replace(/CommandOrControl|Control|Command/g, 'Ctrl')
    .replace(/Space/g, '空格');
}

/** 是否是输入法常用的「Ctrl+空格 切中英文」，抢了它要提醒用户 */
export function isImeClash(accel: string): boolean {
  return /^CommandOrControl\+Space$/i.test(String(accel || '').trim());
}

/** 两个键是不是同一个组合（大小写不敏感） */
export function sameAccel(a: string, b: string): boolean {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}
