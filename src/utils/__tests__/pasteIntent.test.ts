import { describe, it, expect } from 'vitest';
import { detectPaste } from '../pasteIntent';

const LOG = [
  '2026-11-13 14:20:31 INFO  应用启动完成',
  '2026-11-13 14:20:32 ERROR java.lang.NullPointerException: user is null',
  '\tat com.foo.UserService.load(UserService.java:42)',
].join('\n');

describe('detectPaste / url', () => {
  it('带协议的地址', () => {
    expect(detectPaste('https://zentao.example.com/bug-browse-58.html').kind).toBe('url');
  });

  it('裸域名加端口与路径', () => {
    expect(detectPaste('192.0.2.10:8080/health').kind).toBe('url');
    expect(detectPaste('demo.example.com').kind).toBe('url');
  });

  it('一句话里夹着地址不算', () => {
    expect(detectPaste('看这个 https://example.com 有问题').kind).toBe('unknown');
  });
});

describe('detectPaste / json', () => {
  it('对象与数组', () => {
    expect(detectPaste('{"a":1,"b":[2,3]}').kind).toBe('json');
    expect(detectPaste('[{"id":1},{"id":2}]').kind).toBe('json');
  });

  it('看起来像但解析失败的不算', () => {
    expect(detectPaste('{a:1, b:2}').kind).toBe('unknown');
  });

  it('普通数字不当作 JSON', () => {
    expect(detectPaste('12345').kind).toBe('unknown');
  });
});

describe('detectPaste / sql', () => {
  it('常见语句', () => {
    expect(detectPaste('select id, name from student where id = 1').kind).toBe('sql');
    expect(detectPaste('INSERT INTO t (a) VALUES (1)').kind).toBe('sql');
    expect(detectPaste('WITH x AS (SELECT 1) SELECT * FROM x').kind).toBe('sql');
  });

  it('带前导注释也能识别', () => {
    expect(detectPaste('-- 查学生\nselect * from student').kind).toBe('sql');
  });

  it('以 select 开头的英文句子不算（单词边界）', () => {
    expect(detectPaste('selected files are ready').kind).toBe('unknown');
  });
});

describe('detectPaste / log', () => {
  it('多行带时间戳与级别', () => {
    expect(detectPaste(LOG).kind).toBe('log');
  });

  it('多行带异常与堆栈（没有时间戳）', () => {
    const t = ['TypeError: x is not a function', '    at foo (a.js:1:1)', '    at bar (b.js:2:2)'].join('\n');
    expect(detectPaste(t).kind).toBe('log');
  });

  it('只有一行 ERROR 不算日志', () => {
    expect(detectPaste('ERROR 数据库连接失败').kind).toBe('unknown');
  });

  it('普通多行文本不算', () => {
    expect(detectPaste('第一行\n第二行\n第三行').kind).toBe('unknown');
  });
});

describe('detectPaste / 其它', () => {
  it('JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abc123DEF';
    expect(detectPaste(jwt).kind).toBe('jwt');
  });

  it('空内容', () => {
    const r = detectPaste('   ');
    expect(r.kind).toBe('unknown');
    expect(r.chars).toBe(0);
  });

  it('给出摘要与行数', () => {
    const r = detectPaste(LOG);
    expect(r.lines).toBe(3);
    expect(r.chars).toBeGreaterThan(50);
    expect(r.preview).toContain('NullPointerException');
  });
});
