import { describe, it, expect } from 'vitest';
import {
  kindOfDirFile,
  kindDecidedByName,
  planDirKinds,
  countDirKinds,
  SQL_KEYWORD_RE,
} from '../noteKind';

describe('kindOfDirFile（目录模式：文件名 + 正文特征判类型）', () => {
  it('文件名以 .sql.md 结尾 → SQL 片段（不看正文）', () => {
    expect(kindOfDirFile('查用户.sql.md')).toBe('sql');
    expect(kindOfDirFile('清理订单.SQL.MD')).toBe('sql');
    expect(kindOfDirFile('片段.sql')).toBe('sql');
  });

  it('文件名判不出来、正文以 -- 开头且含语句关键字 → SQL 片段', () => {
    expect(kindOfDirFile('查用户.md', '-- 查活跃用户\nSELECT * FROM t_user WHERE status = 1;')).toBe('sql');
    expect(kindOfDirFile('清理.md', '-- 清理\nDELETE FROM t_order WHERE id < 100')).toBe('sql');
  });

  it('正文以 /* 开头且含语句关键字 → SQL 片段', () => {
    expect(kindOfDirFile('统计.md', '/* 每日统计 */\nINSERT INTO t_stat VALUES (1);')).toBe('sql');
  });

  it('普通 Markdown 笔记 → note', () => {
    expect(kindOfDirFile('排查.md', '## 现象\n\n登录偶发 500')).toBe('note');
    expect(kindOfDirFile('排查.md', '')).toBe('note');
    expect(kindOfDirFile('排查.md')).toBe('note');
  });

  it('正文里出现 SELECT 但开头不是注释 → 仍是笔记（避免误判）', () => {
    expect(kindOfDirFile('排查.md', '## 结论\n\n这条 SQL 是 SELECT * FROM t_user，慢在没索引')).toBe('note');
  });

  it('注释开头但没有语句关键字 → 仍是笔记', () => {
    expect(kindOfDirFile('随手记.md', '-- 今天想到的点子\n明天再试')).toBe('note');
  });

  it('带 BOM 的正文也能识别（Windows 记事本另存的文件）', () => {
    expect(kindOfDirFile('查用户.md', '\uFEFF-- 查用户\nSELECT 1')).toBe('sql');
  });

  it('关键字必须是完整单词：SELECTED / CREATED_AT 不算语句', () => {
    expect(kindOfDirFile('a.md', '-- 说明\nSELECTED 是形容词')).toBe('note');
    expect(kindOfDirFile('a.md', '-- 说明\nCREATED_AT 是字段名')).toBe('note');
  });

  it('大小写不敏感', () => {
    expect(kindOfDirFile('a.md', '-- x\nselect 1')).toBe('sql');
  });

  it('空文件名 / 非字符串输入不抛异常', () => {
    expect(kindOfDirFile('', '')).toBe('note');
    expect(kindOfDirFile(undefined as unknown as string, undefined)).toBe('note');
  });
});

describe('kindDecidedByName（文件名能否单独定类型）', () => {
  it('.sql.md / .sql 结尾返回 true', () => {
    expect(kindDecidedByName('a.sql.md')).toBe(true);
    expect(kindDecidedByName('a.sql')).toBe(true);
  });

  it('普通 .md / .txt 返回 false', () => {
    expect(kindDecidedByName('a.md')).toBe(false);
    expect(kindDecidedByName('a.markdown')).toBe(false);
    expect(kindDecidedByName('a.txt')).toBe(false);
    expect(kindDecidedByName('')).toBe(false);
  });
});

describe('planDirKinds（按需读正文，最多读 N 个）', () => {
  it('文件名能定的不读正文，其余进 toRead', () => {
    const plan = planDirKinds(['a.sql.md', 'b.md', 'c.md'], {}, 20);
    expect(plan.kinds['a.sql.md']).toBe('sql');
    expect(plan.toRead).toEqual(['b.md', 'c.md']);
    // 未读正文的先按 note 占位，不会从「全部」里消失
    expect(plan.kinds['b.md']).toBe('note');
  });

  it('已读过正文的直接分类，不再进 toRead', () => {
    const plan = planDirKinds(
      ['a.md', 'b.md'],
      { 'a.md': '-- 查\nSELECT 1', 'b.md': '## 现象' },
      20,
    );
    expect(plan.kinds).toEqual({ 'a.md': 'sql', 'b.md': 'note' });
    expect(plan.toRead).toEqual([]);
  });

  it('超过 maxBodyReads 的其余文件默认 note，不读正文', () => {
    const names = ['1.md', '2.md', '3.md', '4.md', '5.md'];
    const plan = planDirKinds(names, {}, 2);
    expect(plan.toRead).toEqual(['1.md', '2.md']);
    expect(Object.keys(plan.kinds)).toHaveLength(5);
    expect(plan.kinds['5.md']).toBe('note');
  });

  it('maxBodyReads=0 时一个正文都不读', () => {
    const plan = planDirKinds(['a.md', 'b.sql.md'], {}, 0);
    expect(plan.toRead).toEqual([]);
    expect(plan.kinds).toEqual({ 'a.md': 'note', 'b.sql.md': 'sql' });
  });

  it('空列表 / 空名字不抛异常', () => {
    expect(planDirKinds([], {})).toEqual({ kinds: {}, toRead: [] });
    expect(planDirKinds(['', 'a.md'], {}, 5).toRead).toEqual(['a.md']);
  });

  it('第二次调用（正文已读回）得到最终分类且不再要求读盘', () => {
    const names = ['a.md', 'b.md'];
    const first = planDirKinds(names, {}, 20);
    const bodies: Record<string, string> = {};
    for (const n of first.toRead) bodies[n] = n === 'a.md' ? '-- x\nUPDATE t SET a=1' : '正文';
    const second = planDirKinds(names, bodies, 20);
    expect(second.toRead).toEqual([]);
    expect(second.kinds).toEqual({ 'a.md': 'sql', 'b.md': 'note' });
  });
});

describe('countDirKinds（筛选条计数）', () => {
  it('分别统计 all / note / sql', () => {
    expect(countDirKinds({ a: 'note', b: 'sql', c: 'note' })).toEqual({ all: 3, note: 2, sql: 1 });
  });

  it('空对象给全 0，不出现 NaN', () => {
    expect(countDirKinds({})).toEqual({ all: 0, note: 0, sql: 0 });
  });
});

describe('SQL_KEYWORD_RE', () => {
  it('覆盖常见语句关键字', () => {
    for (const kw of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP']) {
      expect(SQL_KEYWORD_RE.test(`x ${kw} y`)).toBe(true);
    }
  });

  it('不匹配普通英文单词', () => {
    expect(SQL_KEYWORD_RE.test('selection')).toBe(false);
    expect(SQL_KEYWORD_RE.test('dropped')).toBe(false);
  });
});
