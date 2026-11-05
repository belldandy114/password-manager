import { describe, it, expect } from 'vitest';
// main 进程的 csv.js 是 CommonJS，Vite 会做 CJS → ESM 互操作
import { parseCsv, normalizeImportRecords, extractTotpSecret, IMPORT_FIELD_ALIASES } from '../../../electron/csv.js';

describe('csv.parseCsv', () => {
  it('普通行按逗号切分', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('引号里的逗号/换行不当分隔符（以前 split(",") 会把密码拆坏）', () => {
    const rows = parseCsv('name,password\nx,"p,a\"\"ss"');
    expect(rows[1]).toEqual(['x', 'p,a"ss']);
    const multi = parseCsv('a,"line1\nline2"');
    expect(multi[0][1]).toBe('line1\nline2');
  });

  it('CRLF 与 BOM 都能处理（Excel 导出常带 BOM）', () => {
    const rows = parseCsv('\uFEFFa,b\r\n1,2\r\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('空行被丢掉，尾行不丢', () => {
    const rows = parseCsv('a,b\n\n1,2\n');
    expect(rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n1,2')).toHaveLength(2);
  });

  it('空字符串返回空数组', () => {
    expect(parseCsv('')).toEqual([]);
  });
});

describe('csv.normalizeImportRecords', () => {
  it('中文表头（本应用导出）能识别', () => {
    const out = normalizeImportRecords([{
      名称: '某系统', 网址: 'https://a.com', 账号: 'u1', 密码: 'p1', 备注: 'n', 标签: '测试,内网',
    }]);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('某系统');
    expect(out[0].username).toBe('u1');
    expect(out[0].tags).toEqual(['测试', '内网']);
    expect(out[0].envType).toBe('production');
  });

  it('Chrome / Bitwarden / 1Password 的表头也能吃', () => {
    const chrome = normalizeImportRecords([{ name: 'C', url: 'https://c.com', username: 'cu', password: 'cp', note: 'cn' }]);
    expect(chrome[0].url).toBe('https://c.com');
    const bw = normalizeImportRecords([{ name: 'B', login_uri: 'https://b.com', login_username: 'bu', login_password: 'bp', folder: '工作' }]);
    expect(bw[0].username).toBe('bu');
    expect(bw[0].tags).toEqual(['工作']);
    const op = normalizeImportRecords([{ Title: 'O', Url: 'https://o.com', Username: 'ou', Password: 'op' }]);
    expect(op[0].name).toBe('O');
  });

  it('没有名称也没有网址的记录会被丢掉（避免导入一堆空条目）', () => {
    expect(normalizeImportRecords([{ username: 'x' }])).toHaveLength(0);
  });

  it('环境别名归一化（正式/生产/prod → production）', () => {
    const out = normalizeImportRecords([
      { name: 'a', 环境: '测试' },
      { name: 'b', envType: 'PROD' },
      { name: 'c', 环境: '预发布' },
    ]);
    expect(out.map(e => e.envType)).toEqual(['testing', 'production', 'staging']);
  });

  it('Excel 日期序列号转 ISO（45678 这种数字）', () => {
    const out = normalizeImportRecords([{ name: 'a', createdAt: '45678' }]);
    expect(out[0].createdAt).toMatch(/^20\d\d-/);
  });

  it('otpauth 链接里抽出 Base32 secret', () => {
    expect(extractTotpSecret('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&issuer=y')).toBe('JBSWY3DPEHPK3PXP');
    expect(extractTotpSecret('jbswy3dpehpk3pxp')).toBe('JBSWY3DPEHPK3PXP');
    expect(extractTotpSecret('not-a-secret!')).toBe('');
  });

  it('别名表覆盖导出用到的全部字段（新增字段别忘补别名）', () => {
    for (const key of ['name', 'url', 'username', 'password', 'notes', 'tags', 'envType', 'totp', 'favorite']) {
      expect(Array.isArray(IMPORT_FIELD_ALIASES[key])).toBe(true);
      expect(IMPORT_FIELD_ALIASES[key].length).toBeGreaterThan(0);
    }
  });

  it('非数组输入返回空数组，不抛异常', () => {
    expect(normalizeImportRecords(null)).toEqual([]);
    expect(normalizeImportRecords('x')).toEqual([]);
  });
});