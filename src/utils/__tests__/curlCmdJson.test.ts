import { describe, it, expect } from 'vitest';
import { parseCurl } from '../../../src/utils/curl';

/**
 * 真实样本：Chrome「Copy as cURL (cmd)」复制一个 **JSON** 请求。
 * 注意 `--data-raw` 里 JSON 的双引号被写成了 `^\^"`（cmd 转义 + 引号转义叠加），
 * 以前分词后会在正文里残留 `^` 和 `\"`，发出去服务端直接解析失败。
 */
const REAL_JSON_CMD_CURL = [
  'curl --url ^"https://testapi.example.com/admin-api/assetsys/formal-asset-info/page^" ^',
  '  -H ^"Accept: application/json, text/plain, */*^" ^',
  '  -H ^"Authorization: Bearer abc123^" ^',
  '  -H ^"Content-Type: application/json^" ^',
  '  -H ^"tenant-id: 1^" ^',
  '  -H ^"sec-ch-ua: ^\\^"Chromium^\\^";v=^\\^"152^\\^", ^\\^"Not?A_Brand^\\^";v=^\\^"24^\\^", ^\\^"Google Chrome^\\^";v=^\\^"152^\\^"^" ^',
  '  --data-raw ^"^{^\\^"pageNo^\\^":1,^\\^"pageSize^\\^":30,^\\^"assetCode^\\^":^\\^"5555555555000020^\\^",^\\^"isBatchAssets^\\^":2^}^"',
].join('\n');

describe('curl: cmd 写法的 JSON 请求体', () => {
  it('正文里不再残留 ^ 与 \\"，并且是合法 JSON', () => {
    const r = parseCurl(REAL_JSON_CMD_CURL);
    if (!r.ok) throw new Error(r.error);
    expect(r.request.bodyType).toBe('json');
    expect(r.request.body).not.toContain('^');
    expect(r.request.body).not.toContain('\\"');
    expect(JSON.parse(r.request.body)).toEqual({
      pageNo: 1,
      pageSize: 30,
      assetCode: '5555555555000020',
      isBatchAssets: 2,
    });
  });

  it('地址与请求头里的 ^ 也都被清掉', () => {
    const r = parseCurl(REAL_JSON_CMD_CURL);
    if (!r.ok) throw new Error(r.error);
    expect(r.request.url).toBe('https://testapi.example.com/admin-api/assetsys/formal-asset-info/page');
    expect(r.request.headers).not.toContain('^');
    expect(r.request.headers).toMatch(/tenant-id: 1/);
    // sec-ch-ua 这种「值里再嵌一层引号」的头，要还原成正常引号
    expect(r.request.headers).toContain('"Chromium";v="152"');
  });
});

describe('curl: JSON 字符串里本身带引号时不能被过度还原', () => {
  it('保留 \\" 才算合法 JSON 的情况优先保住', () => {
    // 目标正文：{"msg":"say \"hi\""}
    const cmd = [
      `curl 'https://a/b'`,
      `  -H 'Content-Type: application/json'`,
      `  --data-raw '{"msg":"say \\"hi\\""}'`,
    ].join('\n');
    const r = parseCurl(cmd);
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(r.request.body)).toEqual({ msg: 'say "hi"' });
  });
});
