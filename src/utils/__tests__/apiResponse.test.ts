import { describe, it, expect } from 'vitest';
import { responseNamePrefix, isJsonBody, responseSaveTarget } from '../apiResponse';

describe('apiResponse.responseNamePrefix 文件名前缀', () => {
  it('优先用请求名称', () => {
    expect(responseNamePrefix({ name: '查询用户列表', url: 'http://h/x' })).toBe('查询用户列表');
  });

  it('没名字时退回 URL 路径', () => {
    // 路径里的 / 属于非法文件名字符，会被换成下划线
    expect(responseNamePrefix({ name: '', url: 'http://h/admin-api/user/list' })).toBe('admin-api_user_list');
  });

  it('非法字符全部换成下划线（Windows 不让存）', () => {
    const r = responseNamePrefix({ name: 'a/b\\c:d*e?f"g<h>i|j k', url: '' });
    expect(r).not.toMatch(/[\\/:*?"<>|\s]/);
    expect(r).toContain('a_b');
  });

  it('首尾下划线被去掉，全非法时兜底 response', () => {
    expect(responseNamePrefix({ name: '///', url: '' })).toBe('response');
    expect(responseNamePrefix({ name: '   ', url: '' })).toBe('response');
  });

  it('过长会被截断到 40 字符', () => {
    const long = 'x'.repeat(120);
    expect(responseNamePrefix({ name: long, url: '' }).length).toBe(40);
  });
});

describe('apiResponse.isJsonBody', () => {
  it('合法 JSON 才算', () => {
    expect(isJsonBody('{"a":1}')).toBe(true);
    expect(isJsonBody('[1,2]')).toBe(true);
    expect(isJsonBody('"str"')).toBe(true);
  });

  it('HTML 错误页 / 空串 / 普通文本都不算', () => {
    expect(isJsonBody('<html>502 Bad Gateway</html>')).toBe(false);
    expect(isJsonBody('')).toBe(false);
    expect(isJsonBody('ok')).toBe(false);
  });
});

describe('apiResponse.responseSaveTarget', () => {
  it('JSON 响应存 .json，并带上状态码', () => {
    expect(responseSaveTarget({ name: '列表', url: '' }, { status: 200, body: '{"total":1}' }))
      .toEqual({ fileName: '列表-200.json', ext: 'json' });
  });

  it('非 JSON 存 .txt（避免误导）', () => {
    expect(responseSaveTarget({ name: '', url: 'http://h/a/b' }, { status: 502, body: '<html>err</html>' }))
      .toEqual({ fileName: 'a_b-502.txt', ext: 'txt' });
  });
});
