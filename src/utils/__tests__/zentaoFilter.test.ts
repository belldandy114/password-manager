import { describe, it, expect } from 'vitest';
import { accountOf, pickWho, filterMineBugs } from '../../../electron/zentao-filter.js';

const bug = (id: string, opened: string, assigned: string) => ({
  id,
  openedBy: { account: opened, realname: opened },
  assignedTo: { account: assigned, realname: assigned },
});

describe('zentao-filter.accountOf', () => {
  it('支持 {account} 对象与裸字符串，大小写与空格不敏感', () => {
    expect(accountOf({ account: ' ZhangSan ' })).toBe('zhangsan');
    expect(accountOf(' LiSi ')).toBe('lisi');
    expect(accountOf(null)).toBe('');
    expect(accountOf({})).toBe('');
  });
});

describe('zentao-filter.pickWho 按视图取人', () => {
  it('我提交的看 openedBy，待我验证看 assignedTo', () => {
    const b = bug('1', 'me', 'other');
    expect(accountOf(pickWho(b, 'opened'))).toBe('me');
    expect(accountOf(pickWho(b, 'verify'))).toBe('other');
  });
});

describe('zentao-filter.filterMineBugs 本地账号过滤', () => {
  const rows = [
    bug('1', 'zhangsan', 'lisi'),
    bug('2', 'lisi', 'zhangsan'),
    bug('3', 'zhangsan', 'zhangsan'),
    bug('4', 'wangwu', ''),
  ];

  it('我提交的：只留 openedBy 是我的', () => {
    const r = filterMineBugs(rows, 'zhangsan', 'opened');
    expect(r.rows.map((b: any) => b.id)).toEqual(['1', '3']);
    expect(r.filtered).toBe(true);
    expect(r.dropped).toBe(2);
  });

  it('待我验证：只留 assignedTo 是我的', () => {
    const r = filterMineBugs(rows, 'zhangsan', 'verify');
    expect(r.rows.map((b: any) => b.id)).toEqual(['2', '3']);
  });

  it('账号大小写/空格不同也能匹配', () => {
    expect(filterMineBugs(rows, ' ZhangSan ', 'opened').rows.length).toBe(2);
  });

  it('返回里完全没有账号字段时不强行过滤（避免误杀成 0 条）', () => {
    const noAcc = [{ id: '1' }, { id: '2' }] as any[];
    const r = filterMineBugs(noAcc, 'zhangsan', 'opened');
    expect(r.filtered).toBe(false);
    expect(r.rows.length).toBe(2);
    expect(r.withAccount).toBe(0);
  });

  it('账号为空时不过滤', () => {
    const r = filterMineBugs(rows, '', 'opened');
    expect(r.filtered).toBe(false);
    expect(r.rows.length).toBe(4);
  });

  it('空列表安全', () => {
    expect(filterMineBugs([], 'zhangsan', 'opened')).toEqual({ rows: [], filtered: false, withAccount: 0, dropped: 0 });
    expect(filterMineBugs(null as unknown as any[], 'x', 'opened').rows).toEqual([]);
  });
});