import { describe, it, expect } from 'vitest';
import { safeName, resolveInside, uniqueName, formatSize, canMoveInto } from '../../../electron/cases-paths';

describe('safeName', () => {
  it('去掉 Windows 非法字符', () => {
    expect(safeName('登<录>:回归?.xmind').name).toBe('登录回归.xmind');
  });
  it('去掉末尾的点和空格', () => {
    expect(safeName('  登录回归.  ').name).toBe('登录回归');
  });
  it('拒绝空、点、双点', () => {
    expect(safeName('').error).toBeTruthy();
    expect(safeName('   ').error).toBeTruthy();
    expect(safeName('.').error).toBeTruthy();
    expect(safeName('..').error).toBeTruthy();
  });
  it('超长名称报错', () => {
    expect(safeName('a'.repeat(121)).error).toContain('太长');
  });
  it('中文与括号原样保留', () => {
    expect(safeName('登录-回归(2).xmind').name).toBe('登录-回归(2).xmind');
  });
});

describe('resolveInside', () => {
  const root = 'D:\\cases\\Test_Cases';
  it('库内相对路径正常', () => {
    const r = resolveInside(root, '支付系统/登录.xmind');
    expect(r.error).toBeUndefined();
    expect(r.target).toBe('D:\\cases\\Test_Cases\\支付系统\\登录.xmind');
  });
  it('空 rel 就是根目录', () => {
    expect(resolveInside(root, '').target).toBe(root);
  });
  it('拒绝 ../ 穿越', () => {
    expect(resolveInside(root, '../secret.txt').error).toBeTruthy();
    expect(resolveInside(root, '支付系统/../../x').error).toBeTruthy();
  });
  it('拒绝绝对路径', () => {
    expect(resolveInside(root, 'C:\\Windows\\win.ini').error).toBeTruthy();
  });
});

describe('uniqueName', () => {
  it('不冲突时原样返回', () => {
    expect(uniqueName(['a.xmind'], 'b.xmind')).toBe('b.xmind');
  });
  it('冲突时加 (2)，且保留扩展名', () => {
    expect(uniqueName(['登录.xmind'], '登录.xmind')).toBe('登录(2).xmind');
  });
  it('多级递增', () => {
    expect(uniqueName(['a.csv', 'a(2).csv'], 'a.csv')).toBe('a(3).csv');
  });
  it('大小写不敏感（Windows）', () => {
    expect(uniqueName(['Login.CSV'], 'login.csv')).toBe('login(2).csv');
  });
  it('目录（无扩展名）加到末尾', () => {
    expect(uniqueName(['支付系统'], '支付系统')).toBe('支付系统(2)');
  });
  it('多点文件名只认最后一个扩展名', () => {
    expect(uniqueName(['a.b.csv'], 'a.b.csv')).toBe('a.b(2).csv');
  });
});

describe('formatSize', () => {
  it('按量级切换单位', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
  it('非法值给占位', () => {
    expect(formatSize(NaN)).toBe('—');
    expect(formatSize(-1)).toBe('—');
  });
});

describe('canMoveInto（移动的层级规则）', () => {
  it('文件可以放进任意一级（根 / 系统 / 模块）', () => {
    expect(canMoveInto(false, '').ok).toBe(true);
    expect(canMoveInto(false, '支付系统').ok).toBe(true);
    expect(canMoveInto(false, '支付系统/登录模块').ok).toBe(true);
  });
  it('文件夹只能放到根或系统这一级', () => {
    expect(canMoveInto(true, '').ok).toBe(true);
    expect(canMoveInto(true, '支付系统').ok).toBe(true);
  });
  it('文件夹放进模块会被拒绝（否则出现第三级）', () => {
    const r = canMoveInto(true, '支付系统/登录模块');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('最多两级');
  });
});
