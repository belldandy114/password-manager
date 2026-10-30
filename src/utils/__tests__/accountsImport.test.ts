import { describe, it, expect } from 'vitest';
import { parseAccountLines, daysSince, needsRotate } from '../../../electron/accounts-import.js';

describe('accounts-import：批量导入解析', () => {
  it('按 | 分隔解析，顺手去空白', () => {
    const r = parseAccountLines('资产系统 | 管理员 | admin | 123456 | 生产别用\n学工 | 教师 | t1 | p1');
    expect(r.rows.length).toBe(2);
    expect(r.rows[0]).toEqual({ system: '资产系统', role: '管理员', username: 'admin', password: '123456', note: '生产别用' });
    expect(r.rows[1].note).toBe('');
    expect(r.bad).toEqual([]);
  });

  it('Tab 分隔也支持（从 Excel 直接复制）', () => {
    const r = parseAccountLines('系统A\t角色A\tuser\tpwd');
    expect(r.rows).toEqual([{ system: '系统A', role: '角色A', username: 'user', password: 'pwd', note: '' }]);
  });

  it('空行与 # 注释跳过；列数不足进 bad 并带上行号', () => {
    const r = parseAccountLines('\n# 这是注释\n只有两列|x\n系统|角色|账号|密码\n');
    expect(r.rows.length).toBe(1);
    expect(r.bad.length).toBe(1);
    expect(r.bad[0].line).toBe(3);
  });

  it('字段为空的整行跳过（避免导入脏数据）', () => {
    const r = parseAccountLines('系统||账号|密码');
    expect(r.rows.length).toBe(0);
    expect(r.bad.length).toBe(1);
  });
});

describe('accounts-import：密码新鲜度', () => {
  const now = new Date('2026-10-30T00:00:00Z').getTime();

  it('算出距今天数', () => {
    expect(daysSince('2026-10-20T00:00:00Z', now)).toBe(10);
    expect(daysSince('', now)).toBe(null);
    expect(daysSince('not-a-date', now)).toBe(null);
  });

  it('超过阈值才提示（默认 90 天；0 表示关闭）', () => {
    expect(needsRotate('2026-10-01T00:00:00Z', 90, now)).toBe(false);
    expect(needsRotate('2026-05-01T00:00:00Z', 90, now)).toBe(true);
    expect(needsRotate('2020-01-01T00:00:00Z', 0, now)).toBe(false);
  });

  it('未来时间不出现负数', () => {
    expect(daysSince('2027-01-01T00:00:00Z', now)).toBe(0);
  });
});
