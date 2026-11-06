import { describe, it, expect } from 'vitest';
import { isSensitiveLabel } from '../clipboard';

describe('isSensitiveLabel', () => {
  it('密码、验证码、动态码、密钥等标签判定为敏感', () => {
    for (const label of ['密码', '两步验证码', '动态码', 'API Key', 'secret', 'token', '密钥']) {
      expect(isSensitiveLabel(label)).toBe(true);
    }
  });

  it('普通文本标签不触发自动清空', () => {
    for (const label of ['账号', '标题', 'URL', '备注', '全部信息', '汇报文本']) {
      expect(isSensitiveLabel(label)).toBe(false);
    }
  });
});
