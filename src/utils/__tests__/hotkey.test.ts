import { describe, it, expect } from 'vitest';
import { accelFromKeyEvent, accelLabel, isImeClash, sameAccel, type KeyLike } from '../hotkey';

const k = (patch: Partial<KeyLike>): KeyLike => ({
  code: 'KeyP', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...patch,
});

describe('accelFromKeyEvent', () => {
  it('字母：Ctrl+Shift+P', () => {
    expect(accelFromKeyEvent(k({ code: 'KeyP', ctrlKey: true, shiftKey: true }))).toBe('CommandOrControl+Shift+P');
  });

  it('空格：Ctrl+空格', () => {
    expect(accelFromKeyEvent(k({ code: 'Space', ctrlKey: true }))).toBe('CommandOrControl+Space');
  });

  it('数字与功能键', () => {
    expect(accelFromKeyEvent(k({ code: 'Digit1', ctrlKey: true }))).toBe('CommandOrControl+1');
    expect(accelFromKeyEvent(k({ code: 'F8', ctrlKey: true }))).toBe('CommandOrControl+F8');
  });

  it('Alt 与方向键', () => {
    expect(accelFromKeyEvent(k({ code: 'ArrowUp', altKey: true }))).toBe('Alt+Up');
  });

  it('不接受的按法返回 null', () => {
    expect(accelFromKeyEvent(k({ ctrlKey: true, code: 'ControlLeft' }))).toBeNull(); // 只按修饰键
    expect(accelFromKeyEvent(k({ code: 'KeyP' }))).toBeNull();                       // 没修饰键
    expect(accelFromKeyEvent(k({ code: 'KeyP', shiftKey: true }))).toBeNull();       // 只有 Shift
    expect(accelFromKeyEvent(k({ code: 'Unknown', ctrlKey: true }))).toBeNull();     // 不认识的键
  });
});

describe('accelLabel', () => {
  it('转成中文展示名', () => {
    expect(accelLabel('CommandOrControl+Space')).toBe('Ctrl+空格');
    expect(accelLabel('CommandOrControl+Shift+P')).toBe('Ctrl+Shift+P');
    expect(accelLabel('')).toBe('');
  });
});

describe('isImeClash / sameAccel', () => {
  it('识别输入法冲突键', () => {
    expect(isImeClash('CommandOrControl+Space')).toBe(true);
    expect(isImeClash('CommandOrControl+Shift+Space')).toBe(false);
  });

  it('判断两个键是否相同（忽略大小写与空格）', () => {
    expect(sameAccel('CommandOrControl+Space', 'commandorcontrol+space ')).toBe(true);
    expect(sameAccel('Ctrl+K', 'Ctrl+J')).toBe(false);
  });
});
