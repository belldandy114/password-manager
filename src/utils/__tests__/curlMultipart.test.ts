import { describe, it, expect } from 'vitest';
import { parseCurl, parseMultipartBody, buildCurl } from '../../../src/utils/curl';

/** 真实样本：Chrome「Copy as cURL (cmd)」上传文件（multipart）时的输出，含 ^" 转义 */
const REAL_CMD_CURL = [
  'curl --url ^"https://testapi.example.com/admin-api/assetsys/warehouse-documents/entry-asset^" ^',
  '  -H ^"Accept: application/json, text/plain, */*^" ^',
  '  -H ^"Authorization: Bearer abc123^" ^',
  '  -H ^"Content-Type: multipart/form-data; boundary=----WebKitFormBoundaryHpRhxBSGB8i5CKBn^" ^',
  '  -H ^"tenant-id: 1^" ^',
  '  --data-raw ^"------WebKitFormBoundaryHpRhxBSGB8i5CKBn^',
  '',
  'Content-Disposition: form-data; name=^\\^"id^\\^"^',
  '',
  '^',
  '',
  '01a8134f6eecd8be4b50140e908c7111^',
  '',
  '------WebKitFormBoundaryHpRhxBSGB8i5CKBn^',
  '',
  'Content-Disposition: form-data; name=^\\^"code^\\^"^',
  '',
  '^',
  '',
  'TZID-261030-06907^',
  '',
  '------WebKitFormBoundaryHpRhxBSGB8i5CKBn^',
  '',
  'Content-Disposition: form-data; name=^\\^"isApparatus^\\^"^',
  '',
  '^',
  '',
  'true^',
  '',
  '------WebKitFormBoundaryHpRhxBSGB8i5CKBn^',
  '',
  'Content-Disposition: form-data; name=^\\^"files^\\^"; filename=^\\^"4mb.jpg^\\^"^',
  '',
  'Content-Type: image/jpeg^',
  '',
  '^',
  '',
  '^',
  '',
  '------WebKitFormBoundaryHpRhxBSGB8i5CKBn--^',
  '',
  '^"',
].join('\n');

describe('curl: multipart 上传（Chrome Copy as cURL）', () => {
  it('把整个 multipart 正文拆成表单字段（不再是「原文」一大坨）', () => {
    const r = parseCurl(REAL_CMD_CURL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.bodyType).toBe('multipart');
    const lines = r.request.body.split('\n');
    expect(lines).toContain('id=01a8134f6eecd8be4b50140e908c7111');
    expect(lines).toContain('code=TZID-261030-06907');
    expect(lines).toContain('isApparatus=true');
    // 文件字段：cURL 里没有文件内容，只能给出 @文件名 让用户重新选
    expect(lines).toContain('files=@4mb.jpg');
    // 不应把 boundary 或 Content-Disposition 残留在正文里
    expect(r.request.body).not.toContain('WebKitFormBoundary');
    expect(r.request.body).not.toContain('Content-Disposition');
  });

  it('给出「拆了几个字段 / 有文件需要重选」的说明', () => {
    const r = parseCurl(REAL_CMD_CURL);
    if (!r.ok) throw new Error('parse failed');
    expect(r.warnings && r.warnings.length).toBeGreaterThan(0);
    const text = (r.warnings || []).join(' ');
    expect(text).toContain('文件字段');
    expect(text).toContain('4mb.jpg');
  });

  it('Content-Type 头仍然保留（发送时由主进程按 FormData 重新生成 boundary）', () => {
    const r = parseCurl(REAL_CMD_CURL);
    if (!r.ok) return;
    expect(r.request.headers).toMatch(/multipart\/form-data/i);
    expect(r.request.url).toBe('https://testapi.example.com/admin-api/assetsys/warehouse-documents/entry-asset');
  });
});

describe('curl: parseMultipartBody 单独测试', () => {
  const B = 'X9';
  const body = [
    '--X9',
    'Content-Disposition: form-data; name="a"',
    '',
    '1',
    '--X9',
    'Content-Disposition: form-data; name="b"',
    '',
    'hello world',
    '--X9',
    'Content-Disposition: form-data; name="f"; filename="x.png"',
    'Content-Type: image/png',
    '',
    '',
    '--X9--',
  ].join('\r\n');

  it('拆出文本字段与文件字段', () => {
    const r = parseMultipartBody(body, B);
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: 'hello world' },
    ]);
    expect(r.files).toEqual([{ key: 'f', filename: 'x.png', contentType: 'image/png' }]);
  });

  it('boundary 不匹配时安全返回 ok=false（调用方会保留原文并提示）', () => {
    expect(parseMultipartBody(body, 'OTHER').ok).toBe(false);
    expect(parseMultipartBody('', B).ok).toBe(false);
  });
});

describe('curl: 普通请求不受影响', () => {
  it('JSON 请求仍然是 json 类型、无警告', () => {
    const r = parseCurl(`curl 'https://a/b' -H 'Content-Type: application/json' --data-raw '{"a":1}'`);
    if (!r.ok) throw new Error('parse failed');
    expect(r.request.bodyType).toBe('json');
    expect(r.warnings).toBeUndefined();
  });

  it('-F 形式的 multipart 仍然按表单行处理，不会被正文解析逻辑干扰', () => {
    const r = parseCurl(`curl 'https://a/b' -F 'file=@C:\\tmp\\a.png' -F 'desc=hi'`);
    if (!r.ok) throw new Error('parse failed');
    expect(r.request.bodyType).toBe('multipart');
    expect(r.request.body.split('\n').sort()).toEqual(['desc=hi', 'file=@C:\\tmp\\a.png'].sort());
  });

  it('buildCurl 对 multipart 仍生成 -F（可再次复制出去）', () => {
    const out = buildCurl({
      method: 'POST',
      url: 'https://a/b',
      headers: '',
      body: 'id=1\nfiles=@a.jpg',
      bodyType: 'multipart',
    } as never);
    expect(out).toContain("'id=1'");
    expect(out).toContain('files=@a.jpg');
  });
});