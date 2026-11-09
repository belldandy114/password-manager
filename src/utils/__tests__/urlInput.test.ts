import { describe, it, expect } from 'vitest';
import { guessUrlFromInput, nameLooksLikeHost } from '../urlInput';

describe('guessUrlFromInput', () => {
  it('带协议的完整网址原样返回', () => {
    expect(guessUrlFromInput('https://example.com/login?q=1')).toEqual({
      url: 'https://example.com/login?q=1',
      name: 'example.com',
    });
  });

  it('没有协议时补 https://', () => {
    expect(guessUrlFromInput('taobao.com')).toEqual({
      url: 'https://taobao.com',
      name: 'taobao.com',
    });
  });

  it('去掉 www. 作为名称', () => {
    expect(guessUrlFromInput('www.baidu.com')?.name).toBe('baidu.com');
  });

  it('网址前面的中文当作名称', () => {
    expect(guessUrlFromInput('阿里云后台 https://ecs.console.aliyun.com')).toEqual({
      url: 'https://ecs.console.aliyun.com',
      name: '阿里云后台',
    });
  });

  it('接受带端口和路径的写法', () => {
    expect(guessUrlFromInput('http://192.0.2.10:8080/admin')?.url).toBe('http://192.0.2.10:8080/admin');
  });

  it('纯中文搜索词不当网址', () => {
    expect(guessUrlFromInput('测试账号')).toBeNull();
  });

  it('空输入返回 null', () => {
    expect(guessUrlFromInput('   ')).toBeNull();
  });

  it('没有点号的一串字符不当网址', () => {
    expect(guessUrlFromInput('localhost')).toBeNull();
  });
});

describe('nameLooksLikeHost', () => {
  it('名称等于域名时判定为 true', () => {
    expect(nameLooksLikeHost('example.com', 'https://example.com')).toBe(true);
  });

  it('中文名称判定为 false', () => {
    expect(nameLooksLikeHost('阿里云', 'https://example.com')).toBe(false);
  });
});
