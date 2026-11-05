import { describe, it, expect } from 'vitest';
import { jsonToYaml, yamlToJson, autoConvert } from '../../utils/yaml';

describe('jsonToYaml', () => {
  it('对象转成 YAML 缩进 2', () => {
    const r = jsonToYaml('{"a":1,"b":{"c":[1,2]}}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.text).toContain('a: 1');
      expect(r.text).toContain('c:');
      expect(r.text).toContain('- 1');
    }
  });

  it('长字符串不被折行（lineWidth: -1）', () => {
    const long = 'x'.repeat(200);
    const r = jsonToYaml(JSON.stringify({ s: long }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain(long);
  });

  it('非法 JSON 给出错误而不是抛异常', () => {
    const r = jsonToYaml('{oops}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/不是合法 JSON/);
  });

  it('空输入提示', () => {
    expect(jsonToYaml('   ').ok).toBe(false);
  });
});

describe('yamlToJson', () => {
  it('基本 YAML 转 JSON', () => {
    const r = yamlToJson('a: 1\nb:\n  - x\n  - y\n');
    expect(r.ok).toBe(true);
    if (r.ok) {
      const obj = JSON.parse(r.text);
      expect(obj.a).toBe(1);
      expect(obj.b).toEqual(['x', 'y']);
    }
  });

  it('缩进可配置', () => {
    const r = yamlToJson('a: 1', 4);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('    "a"');
  });

  it('{: 语法错误} 报错友好', () => {
    const r = yamlToJson('a: [1, 2');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/不是合法 YAML/);
  });
});

describe('autoConvert', () => {
  it('JSON 自动转 YAML', () => {
    const r = autoConvert('{"k":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain('k: 1');
  });

  it('YAML 自动转 JSON', () => {
    const r = autoConvert('k: 1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.parse(r.text)).toEqual({ k: 1 });
  });
});