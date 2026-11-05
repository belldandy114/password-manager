import { describe, it, expect } from 'vitest';
import { validateIdCard, idCardCheckCode } from '../../utils/idCard';

describe('idCardCheckCode', () => {
  it('已知合法号码的校验位', () => {
    // 11010519491231002X 是经典测试号码
    expect(idCardCheckCode('11010519491231002')).toBe('X');
    expect(idCardCheckCode('44052418800101001')).toBe('4');
  });
});

describe('validateIdCard', () => {
  it('正确号码通过并给出生日/性别', () => {
    const r = validateIdCard('11010519491231002X');
    expect(r.valid).toBe(true);
    expect(r.birthday).toBe('1949-12-31');
    expect(r.gender).toBe('女');
    expect(r.region).toBe('110105');
  });

  it('校验位错要判不合法（以前会误判为合法）', () => {
    const r = validateIdCard('110105194912310021');
    expect(r.valid).toBe(false);
    expect(r.checksumOk).toBe(false);
    expect(r.error).toMatch(/校验位/);
  });

  it('位数不对给出格式错误', () => {
    const r = validateIdCard('12345');
    expect(r.valid).toBe(false);
    expect(r.formatOk).toBe(false);
  });

  it('生日不存在要拦下', () => {
    // 2 月 30 日：先凑出合法校验位
    const first17 = '11010519900230001';
    const full = first17 + idCardCheckCode(first17);
    const r = validateIdCard(full);
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/出生日期/);
  });

  it('小写 x 等价于大写 X', () => {
    expect(validateIdCard('11010519491231002x').valid).toBe(true);
  });
});