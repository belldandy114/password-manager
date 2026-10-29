import { describe, it, expect } from 'vitest';
import { parseCurl, buildCurl, tokenizeCurl } from '../curl';

const ok = (input: string) => {
  const r = parseCurl(input);
  if (!r.ok) throw new Error(`解析失败：${r.error}`);
  return r.request;
};

describe('tokenizeCurl 引号与续行', () => {
  it('单引号整体保留（含空格与逗号）', () => {
    expect(tokenizeCurl(`curl -H 'A: b, c' 'http://x/y'`)).toEqual(['curl', '-H', 'A: b, c', 'http://x/y']);
  });

  it('双引号里的 \\" 与 \\n 转义', () => {
    expect(tokenizeCurl('curl -d "{\\"a\\":\\"b\\"}"')).toEqual(['curl', '-d', '{"a":"b"}']);
    expect(tokenizeCurl('curl -d "a\\nb"')).toEqual(['curl', '-d', 'a\nb']);
  });

  it('bash 的 \'\\\'\' 拼接能还原单引号', () => {
    expect(tokenizeCurl(`curl -d 'it'\\''s'`)).toEqual(['curl', '-d', "it's"]);
  });

  it('Chrome「Copy as cURL (cmd)」的 ^"..."^" 要去掉 ^，值首尾不能留 caret', () => {
    const src = [
      'curl ^"https://api.example.com/list^" ^',
      '  -H ^"Accept: */*^" ^',
      '  -H ^"Referer: http://172.16.0.1:30201/^" ^',
      '  -H ^"Authorization: Bearer abc^" ^',
    ].join('\n');
    const r = ok(src);
    expect(r.url).toBe('https://api.example.com/list');
    expect(r.headers).toBe('Accept: */*\nReferer: http://172.16.0.1:30201/\nAuthorization: Bearer abc');
    expect(r.headers).not.toContain('^');
  });

  it('URL 里的 ^& 要去掉 ^（cmd 转义），查询串不能被污染', () => {
    const src = 'curl ^"https://testapi.example.com/admin-api/list?pageNo=1^&pageSize=30^&id=b8fe^&type=1^"';
    const r = ok(src);
    expect(r.url).toBe('https://testapi.example.com/admin-api/list?pageNo=1&pageSize=30&id=b8fe&type=1');
    expect(r.url).not.toContain('^');
  });

  it('bash 写法里正常的 & 与 ^ 都不动', () => {
    const r = ok(`curl 'https://a/b?x=1&y=2' -H 'X: a^b'`);
    expect(r.url).toBe('https://a/b?x=1&y=2');
    expect(r.headers).toBe('X: a^b');
  });
  it('cmd 写法里 ^ 与单引号组合也正确', () => {
    const r = ok('curl ^\'https://a/b\' ^ -H ^\'Accept: */*\'');
    expect(r.url).toBe('https://a/b');
    expect(r.headers).toBe('Accept: */*');
  });
  it('反斜杠续行与 cmd 的 ^ 续行都能拼成一行', () => {
    expect(tokenizeCurl("curl 'http://a/b' \\\n  -H 'X: 1'")).toEqual(['curl', 'http://a/b', '-H', 'X: 1']);
    expect(tokenizeCurl("curl 'http://a/b' ^\n  -H 'X: 1'")).toEqual(['curl', 'http://a/b', '-H', 'X: 1']);
  });
});

describe('parseCurl 常见写法', () => {
  it('最简 GET', () => {
    const r = ok(`curl 'https://api.example.com/users'`);
    expect(r).toMatchObject({ method: 'GET', url: 'https://api.example.com/users', body: '', bodyType: 'none' });
  });

  it('POST + JSON 头 + body（自动识别 json）', () => {
    const r = ok(`curl -X POST 'https://a/b' -H 'Content-Type: application/json' --data-raw '{"a":1}'`);
    expect(r.method).toBe('POST');
    expect(r.body).toBe('{"a":1}');
    expect(r.bodyType).toBe('json');
    expect(r.headers).toBe('Content-Type: application/json');
  });

  it('有 -d 没写 -X 时按 POST', () => {
    expect(ok(`curl 'https://a/b' -d 'x=1'`).method).toBe('POST');
  });

  it('-d 没有 Content-Type 时按 form（curl 的默认语义）', () => {
    const r = ok(`curl 'https://a/b' -d 'x=1'`);
    expect(r.bodyType).toBe('form');
    expect(r.body).toBe('x=1');
  });

  it('多个 -d 用 & 连接', () => {
    expect(ok(`curl 'https://a/b' -d 'a=1' -d 'b=2'`).body).toBe('a=1&b=2');
  });

  it('--data-urlencode 归为表单', () => {
    const r = ok(`curl 'https://a/b' --data-urlencode 'q=中 文'`);
    expect(r.bodyType).toBe('form');
    expect(r.body).toBe('q=中 文');
  });

  it('-F 归为 multipart，@ 开头是文件路径', () => {
    const r = ok(`curl 'https://a/b' -F 'file=@D:/tmp/a.png' -F 'name=x'`);
    expect(r.bodyType).toBe('multipart');
    expect(r.body).toBe('file=@D:/tmp/a.png\nname=x');
  });

  it('-b 变成 Cookie 头', () => {
    const r = ok(`curl 'https://a/b' -b 'sid=abc; theme=dark'`);
    expect(r.headers).toContain('Cookie: sid=abc; theme=dark');
  });

  it('-u 变成 Basic Authorization', () => {
    const r = ok(`curl 'https://a/b' -u 'alice:secret'`);
    expect(r.headers).toContain(`Authorization: Basic ${btoa('alice:secret')}`);
  });

  it('-G 把 -d 挪到 query，不保留请求体', () => {
    const r = ok(`curl -G 'https://a/b?x=1' -d 'page=2&size=10'`);
    expect(r.method).toBe('GET');
    expect(r.url).toBe('https://a/b?x=1&page=2&size=10');
    expect(r.body).toBe('');
    expect(r.bodyType).toBe('none');
  });

  it('-G 且原地址没有 ? 时补 ?', () => {
    expect(ok(`curl -G 'https://a/b' -d 'q=1'`).url).toBe('https://a/b?q=1');
  });

  it('常用开关 -k -s -L --compressed 忽略', () => {
    const r = ok(`curl -k -s -L --compressed 'https://a/b'`);
    expect(r.url).toBe('https://a/b');
    expect(r.method).toBe('GET');
  });

  it('--url 指定地址', () => {
    expect(ok(`curl --url 'https://a/b' -X PUT`).url).toBe('https://a/b');
  });

  it('文中的 {{变量}} 原样保留', () => {
    const r = ok(`curl '{{baseUrl}}/users' -H 'Authorization: Bearer {{token}}'`);
    expect(r.url).toBe('{{baseUrl}}/users');
    expect(r.headers).toContain('Bearer {{token}}');
  });

  it('raw 请求体带自定义 Content-Type', () => {
    const r = ok(`curl 'https://a/b' -H 'Content-Type: text/xml' --data-raw '<x/>'`);
    expect(r.bodyType).toBe('raw');
    expect(r.rawContentType).toBe('text/xml');
  });

  it('urlencoded 头 → form', () => {
    const r = ok(`curl 'https://a/b' -H 'Content-Type: application/x-www-form-urlencoded' -d 'a=1'`);
    expect(r.bodyType).toBe('form');
  });
});

describe('parseCurl 错误处理', () => {
  it('空内容报错', () => {
    expect(parseCurl('   ').ok).toBe(false);
  });

  it('不是 curl 的命令报错', () => {
    const r = parseCurl('wget https://a/b');
    expect(r.ok).toBe(false);
  });

  it('没有 URL 报错', () => {
    const r = parseCurl(`curl -H 'X: 1'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('URL');
  });
});

describe('buildCurl 生成可复制命令', () => {
  it('GET 不写 -X，带请求头', () => {
    const s = buildCurl({ method: 'GET', url: 'https://a/b', headers: 'X-Env: test' });
    expect(s).toBe(`curl 'https://a/b' -H 'X-Env: test'`);
  });

  it('POST JSON 自动补 Content-Type', () => {
    const s = buildCurl({ method: 'POST', url: 'https://a/b', headers: '', body: '{"a":1}', bodyType: 'json' });
    expect(s).toContain('-X POST');
    expect(s).toContain(`-H 'Content-Type: application/json'`);
    expect(s).toContain(`--data-raw '{"a":1}'`);
  });

  it('已有 Content-Type 不重复补', () => {
    const s = buildCurl({ method: 'POST', url: 'https://a/b', headers: 'content-type: text/plain', body: 'x', bodyType: 'raw' });
    expect(s.match(/content-type/gi)?.length).toBe(1);
  });

  it('单引号内容正确转义', () => {
    const s = buildCurl({ method: 'POST', url: 'https://a/b', headers: '', body: "it's", bodyType: 'raw' });
    expect(s).toContain(`'it'\\''s'`);
  });

  it('GET 不输出请求体', () => {
    const s = buildCurl({ method: 'GET', url: 'https://a/b', body: 'x=1', bodyType: 'form' });
    expect(s).not.toContain('--data-raw');
  });

  it('变量保留，不替换', () => {
    const s = buildCurl({ method: 'GET', url: '{{baseUrl}}/u', headers: 'X: {{token}}' });
    expect(s).toContain('{{baseUrl}}');
    expect(s).toContain('{{token}}');
  });
});

describe('round-trip：parse(build(x)) 回到同样内容', () => {
  it('JSON 请求往返一致', () => {
    const src = {
      method: 'POST',
      url: 'https://api.example.com/users?page=1',
      headers: 'Content-Type: application/json\nX-Trace: abc',
      body: '{"name":"张三","age":18}',
      bodyType: 'json' as const,
    };
    const back = ok(buildCurl(src));
    expect(back.method).toBe(src.method);
    expect(back.url).toBe(src.url);
    expect(back.body).toBe(src.body);
    expect(back.bodyType).toBe('json');
    const hs = back.headers.split('\n').sort();
    expect(hs).toContain('X-Trace: abc');
  });

  it('含单引号与中文的 body 往返一致', () => {
    const body = `{"note":"it's 好"}`;
    const back = ok(buildCurl({ method: 'PUT', url: 'https://a/b', headers: '', body, bodyType: 'json' }));
    expect(back.body).toBe(body);
    expect(back.method).toBe('PUT');
  });

  it('form 往返，键值里的 & 不被拆坏', () => {
    const body = 'a=1&b=2';
    const back = ok(buildCurl({ method: 'POST', url: 'https://a/b', headers: 'Content-Type: application/x-www-form-urlencoded', body, bodyType: 'form' }));
    expect(back.bodyType).toBe('form');
    expect(back.body).toBe(body);
  });
});
