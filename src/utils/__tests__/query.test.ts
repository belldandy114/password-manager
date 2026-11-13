import { describe, it, expect } from 'vitest';
import { parseQuery, scoreTarget } from '../query';

describe('parseQuery', () => {
  it('纯文本原样进 text 并转小写', () => {
    const q = parseQuery('  Login Page ');
    expect(q.text).toBe('login page');
    expect(q.syntax).toBe(false);
  });

  it('@ 前缀限定类别', () => {
    const q = parseQuery('@note 登录');
    expect(q.kinds).toEqual(['note']);
    expect(q.text).toBe('登录');
    expect(q.syntax).toBe(true);
  });

  it('@api 是 @request 的别名，@url 是 @entry 的别名', () => {
    expect(parseQuery('@api').kinds).toEqual(['request']);
    expect(parseQuery('@url').kinds).toEqual(['entry']);
  });

  it('tag: 可写多次，值为小写', () => {
    const q = parseQuery('tag:内网 tag:生产');
    expect(q.tags).toEqual(['内网', '生产']);
    expect(q.text).toBe('');
  });

  it('env:/name:/url:/user: 各自落到对应字段', () => {
    const q = parseQuery('env:prod name:登录 url:api user:admin');
    expect(q.envs).toEqual(['prod']);
    expect(q.name).toBe('登录');
    expect(q.url).toBe('api');
    expect(q.user).toBe('admin');
  });

  it('键与值之间没有值时不吞词（tag: 单独出现视为自由文本）', () => {
    const q = parseQuery('tag:');
    expect(q.tags).toEqual([]);
    expect(q.text).toBe('tag:');
    expect(q.syntax).toBe(false);
  });

  it('大小写不敏感的键', () => {
    const q = parseQuery('TAG:内网');
    expect(q.tags).toEqual(['内网']);
  });

  it('空字符串不产生任何约束', () => {
    const q = parseQuery('   ');
    expect(q).toEqual({ text: '', kinds: [], tags: [], envs: [], name: '', url: '', user: '', dataType: '', syntax: false });
  });

  it('@data / @tdg 只看测试数据类型', () => {
    expect(parseQuery('@data').kinds).toEqual(['data']);
    expect(parseQuery('@tdg 正则').text).toBe('正则');
  });

  it('data:xxx 同时限定类别与具体类型', () => {
    const q = parseQuery('data:身份证');
    expect(q.kinds).toEqual(['data']);
    expect(q.dataType).toBe('身份证');
    expect(q.text).toBe('');
    expect(q.syntax).toBe(true);
  });
});

describe('scoreTarget', () => {
  const entry = {
    kind: 'entry' as const,
    title: '内网登录',
    sub: 'admin · https://a.example.com',
    tags: ['内网', '生产'],
    env: 'production',
    url: 'https://a.example.com/login',
    user: 'admin',
  };

  it('类别不符直接淘汰', () => {
    expect(scoreTarget(entry, parseQuery('@note'))).toBe(-1);
  });

  it('标签取交集：少一个就不算命中', () => {
    expect(scoreTarget(entry, parseQuery('tag:内网'))).toBeGreaterThanOrEqual(0);
    expect(scoreTarget(entry, parseQuery('tag:内网 tag:测试'))).toBe(-1);
  });

  it('环境按前缀匹配', () => {
    expect(scoreTarget(entry, parseQuery('env:prod'))).toBeGreaterThanOrEqual(0);
    expect(scoreTarget(entry, parseQuery('env:test'))).toBe(-1);
  });

  it('字段限定只匹配该字段', () => {
    expect(scoreTarget(entry, parseQuery('url:login'))).toBeGreaterThanOrEqual(0);
    // 「admin」在 user 上有，但 name: 限定后标题里没有 → 淘汰
    expect(scoreTarget(entry, parseQuery('name:admin'))).toBe(-1);
  });

  it('命中标题比命中副标题得分高', () => {
    const a = scoreTarget(entry, parseQuery('内网'));
    const b = scoreTarget(entry, parseQuery('admin'));
    expect(a).toBeGreaterThan(b);
  });

  it('没有约束时得 0 分而不是淘汰', () => {
    expect(scoreTarget(entry, parseQuery(''))).toBe(0);
  });

  it('语法与自由文本可以叠加', () => {
    expect(scoreTarget(entry, parseQuery('tag:内网 登录'))).toBeGreaterThan(0);
    expect(scoreTarget(entry, parseQuery('tag:内网 不存在'))).toBe(-1);
  });

  it('data: 精确定位某个测试数据类型，其它类别一律淘汰', () => {
    const phone = { kind: 'data' as const, title: '测试数据 · 手机号', sub: '中国大陆 11 位', dataType: 'phone' };
    expect(scoreTarget(phone, parseQuery('data:phone'))).toBeGreaterThan(0);
    expect(scoreTarget(phone, parseQuery('data:手机号'))).toBeGreaterThan(0);
    expect(scoreTarget(phone, parseQuery('data:身份证'))).toBe(-1);
    expect(scoreTarget(entry, parseQuery('data:phone'))).toBe(-1);
    expect(scoreTarget(phone, parseQuery('@data'))).toBe(0);
  });
});
