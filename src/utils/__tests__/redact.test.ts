import { describe, it, expect } from 'vitest';
import { redactText, restoreText, countHits, maskRange } from '../../utils/redact';

const all = ['idcard', 'phone', 'bankcard', 'email', 'ip'] as const;

describe('redactText / star 风格', () => {
  it('手机号保留前三后四', () => {
    const r = redactText('联系 13800138000 值班', { kinds: [...all] });
    expect(r.text).toBe('联系 138****8000 值班');
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].kind).toBe('phone');
  });

  it('身份证优先于银行卡（18 位纯数字不会被当卡号）', () => {
    const id = '110101199001011234';
    const r = redactText(`身份证 ${id}`, { kinds: [...all] });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].kind).toBe('idcard');
    expect(r.text).toBe('身份证 1101**********1234');
  });

  it('银行卡 16~19 位只留头尾', () => {
    const r = redactText('卡号 6222020000001234', { kinds: ['bankcard'] });
    expect(r.text).toBe('卡号 6222********1234');
  });

  it('邮箱保留首字母与域名', () => {
    const r = redactText('发到 zhangsan@example.com', { kinds: ['email'] });
    expect(r.text).toBe('发到 z*******@example.com');
  });

  it('IP 保留前两段', () => {
    const r = redactText('内网 192.0.2.24 与 198.51.100.1', { kinds: ['ip'] });
    expect(r.text).toBe('内网 192.0.*.* 与 198.51.*.*');
  });

  it('未启用的规则不动原文', () => {
    const r = redactText('手机 13800138000', { kinds: ['email'] });
    expect(r.text).toBe('手机 13800138000');
    expect(r.hits).toHaveLength(0);
  });

  it('自定义词按字面量替换，超长词优先', () => {
    const r = redactText('示例科技和示例系统都上线了', {
      kinds: ['custom'],
      customWords: ['示例', '示例科技'],
    });
    expect(r.text).toBe('****和**系统都上线了');
    expect(r.hits).toHaveLength(2);
  });

  it('正则元字符的自定义词不会炸', () => {
    const r = redactText('a.b*c 与 axbxc', { kinds: ['custom'], customWords: ['a.b*c'] });
    expect(r.text).toBe('***** 与 axbxc');
  });

  it('重复脱敏是幂等的（第二次没有命中）', () => {
    const first = redactText('13800138000 / a@b.com', { kinds: [...all] });
    const second = redactText(first.text, { kinds: [...all] });
    expect(second.text).toBe(first.text);
    expect(second.hits).toHaveLength(0);
  });

  it('空文本返回空结果', () => {
    const r = redactText('', { kinds: [...all] });
    expect(r).toEqual({ text: '', hits: [], mapping: '' });
  });
});

describe('redactText / token 风格与还原', () => {
  it('占位符带类型与序号，映射可还原', () => {
    const src = '甲 13800138000，乙 13900139000，邮箱 a@b.com';
    const r = redactText(src, { kinds: ['phone', 'email'], style: 'token' });
    expect(r.text).toBe('甲 [手机号#1]，乙 [手机号#2]，邮箱 [邮箱#1]');
    expect(r.mapping).toBe('[手机号#1]=13800138000\n[手机号#2]=13900139000\n[邮箱#1]=a@b.com');
    expect(restoreText(r.text, r.mapping)).toBe(src);
  });

  it('star 风格也产出映射表（按打码后的字面量还原）', () => {
    const src = '甲 13800138000，邮箱 a@b.com';
    const r = redactText(src, { kinds: ['phone', 'email'], style: 'star' });
    expect(r.text).toBe('甲 138****8000，邮箱 a***@b.com');
    expect(r.mapping).toBe('138****8000=13800138000\na***@b.com=a@b.com');
    expect(r.hits[0].token).toBe('');
    expect(restoreText(r.text, r.mapping)).toBe(src);
  });

  it('未知占位符原样保留', () => {
    expect(restoreText('x [手机号#9] y', '[手机号#1]=13800138000')).toBe('x [手机号#9] y');
  });
});

describe('自定义打码区间', () => {
  it('只传起点时打到结尾', () => {
    expect(maskRange('13800138000', 8)).toBe('1380013****');
  });

  it('起止位含端点', () => {
    expect(maskRange('13800138000', 4, 7)).toBe('138****8000');
  });

  it('越界自动收敛，起点大于终点时至少遮一位', () => {
    expect(maskRange('abc', 0, 99)).toBe('***');
    expect(maskRange('abcdef', 5, 2)).toBe('abcd*f');
    expect(maskRange('', 1, 3)).toBe('');
  });

  it('脱敏时按区间打码且仍可还原', () => {
    const src = '联系 13800138000';
    const r = redactText(src, { kinds: ['phone'], maskFrom: 8, maskTo: 10 });
    expect(r.text).toBe('联系 1380013***0');
    expect(restoreText(r.text, r.mapping)).toBe(src);
  });

  it('区间对自定义词同样生效', () => {
    const r = redactText('示例科技', { kinds: ['custom'], customWords: ['示例科技'], maskFrom: 1, maskTo: 2 });
    expect(r.text).toBe('**科技');
  });
});

describe('countHits', () => {
  it('按类型汇总', () => {
    const r = redactText('13800138000 13900139000 a@b.com', { kinds: ['phone', 'email'] });
    const rows = countHits(r.hits);
    const phone = rows.find((x) => x.kind === 'phone');
    expect(phone?.count).toBe(2);
    expect(rows.find((x) => x.kind === 'email')?.label).toBe('邮箱');
  });
});