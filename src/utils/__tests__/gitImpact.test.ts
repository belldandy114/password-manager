import { describe, it, expect } from 'vitest';

import {
  gitImpact,
  isDefiniteVia,
  NO_CASE_MAP_NOTICE,
  type CaseMapLike,
} from '../gitImpact';

/**
 * `gitImpact` 单测（契约 §4.1 / 模块 6 的推理部分）。
 *
 * 这些用例真正要守住的是**语义不能反过来**：
 * - 台账空 → 「算不出来」，不是「没影响」；
 * - 对不上 → 「对不上」，不是「没影响」；
 * - 文件名猜出来的 → 标成启发式，不能和「就是这个脚本」长得一样。
 */

const map = (caseNo: string, ref: string, kind: 'file' | 'method' = 'file', caseTitle?: string): CaseMapLike => ({
  caseNo,
  ...(caseTitle ? { caseTitle } : {}),
  target: { kind, ref },
});

describe('gitImpact：按脚本路径命中（确定）', () => {
  it('改动文件与 target.ref 完全一致 → 命中，via=path', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/LoginTest.java'],
      caseMaps: [map('TC-001', 'src/test/java/LoginTest.java', 'file', '登录成功')],
    });
    expect(r.status).toBe('ok');
    expect(r.affected).toHaveLength(1);
    expect(r.affected[0]).toMatchObject({
      caseNo: 'TC-001',
      script: 'src/test/java/LoginTest.java',
      kind: 'file',
      via: 'path',
      matchedFiles: ['src/test/java/LoginTest.java'],
    });
    expect(r.affected[0].reason).toContain('脚本路径命中');
    expect(isDefiniteVia(r.affected[0].via)).toBe(true);
  });

  it('一方是另一方的路径后缀也能命中（root 层级不同）', () => {
    const r = gitImpact({
      changedFiles: ['password-manager/src/test/java/LoginTest.java'],
      caseMaps: [map('TC-002', 'src/test/java/LoginTest.java')],
    });
    expect(r.affected.map((a) => a.caseNo)).toEqual(['TC-002']);
  });

  it('反斜杠与大小写不影响比对（Windows 路径）', () => {
    const r = gitImpact({
      changedFiles: ['SRC\\Test\\Java\\LOGINTEST.java'],
      caseMaps: [map('TC-003', 'src/test/java/LoginTest.java')],
    });
    expect(r.affected).toHaveLength(1);
  });
});

describe('gitImpact：按方法名命中（确定）', () => {
  it('kind=method 的 文件#方法 → 文件被改动即命中，via=method', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/LoginTest.java'],
      caseMaps: [map('TC-010', 'src/test/java/LoginTest.java#testLogin', 'method')],
    });
    expect(r.affected[0].via).toBe('method');
    expect(r.affected[0].reason).toContain('#testLogin');
    expect(isDefiniteVia(r.affected[0].via)).toBe(true);
  });
});

describe('gitImpact：按文件名子串命中（启发式，必须标出来）', () => {
  it('只有文件名对得上 → via=filename 且理由里写「启发式」', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/com/demo/legacy/LoginTest.java'],
      caseMaps: [map('TC-020', 'test/java/LoginTest.java')],
    });
    expect(r.affected).toHaveLength(1);
    expect(r.affected[0].via).toBe('filename');
    expect(r.affected[0].reason).toContain('启发式');
    expect(isDefiniteVia(r.affected[0].via)).toBe(false);
    expect(r.suggestion).toContain('启发式');
  });
});

describe('gitImpact：台账为空 ≠ 没有影响', () => {
  it('caseMaps 为空 → status=empty-maps + 固定文案，绝不返回「0 个受影响」', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/LoginTest.java'],
      caseMaps: [],
    });
    expect(r.status).toBe('empty-maps');
    expect(r.notice).toBe(NO_CASE_MAP_NOTICE);
    expect(r.notice).toBe('无映射数据，无法计算影响面');
    expect(r.suggestion).toContain(NO_CASE_MAP_NOTICE);
    expect(r.affected).toEqual([]);
    // 改动文件照实列出来（供人工确认），但不冒充「已算过」
    expect(r.unmapped).toEqual(['src/test/java/LoginTest.java']);
  });

  it('台账为空且没有任何改动 → 仍然是 empty-maps（先解决没有映射这件事）', () => {
    const r = gitImpact({ changedFiles: [], caseMaps: [] });
    expect(r.status).toBe('empty-maps');
    expect(r.notice).toBe(NO_CASE_MAP_NOTICE);
  });

  it('台账里有条目但全是空 ref → 视同没有可用映射', () => {
    const r = gitImpact({
      changedFiles: ['a/b.java'],
      caseMaps: [{ caseNo: 'X', target: { kind: 'file', ref: '   ' } }],
    });
    expect(r.status).toBe('empty-maps');
  });
});

describe('gitImpact：对不上 ≠ 没影响', () => {
  it('台账非空但一条都对不上 → affected 空，但建议里明确「不要据此认为没有回归风险」', () => {
    const r = gitImpact({
      changedFiles: ['src/main/java/Unrelated.java'],
      caseMaps: [map('TC-030', 'src/test/java/LoginTest.java')],
    });
    expect(r.status).toBe('ok');
    expect(r.affected).toEqual([]);
    expect(r.unmapped).toEqual(['src/main/java/Unrelated.java']);
    expect(r.suggestion).toContain('不要据此认为没有回归风险');
    expect(r.suggestion).toContain('对不上');
  });

  it('没有改动文件 → status=no-changes，建议换范围再看', () => {
    const r = gitImpact({ changedFiles: [], caseMaps: [map('TC-040', 'a/B.java')] });
    expect(r.status).toBe('no-changes');
    expect(r.suggestion).toContain('没有改动文件');
  });
});

describe('gitImpact：聚合与 unmapped 互斥', () => {
  it('多个改动文件命中同一脚本 → 合成一条，matchedFiles 记全，via 取更强', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/LoginTest.java', 'other/LoginTest.java'],
      caseMaps: [map('TC-050', 'src/test/java/LoginTest.java')],
    });
    expect(r.affected).toHaveLength(1);
    expect(r.affected[0].matchedFiles).toHaveLength(2);
    expect(r.affected[0].via).toBe('path'); // 一条 path + 一条 filename → 取 path
    expect(r.unmapped).toEqual([]);
  });

  it('同一脚本既被路径命中又被文件名命中 → 可信度按「确定」算', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/LoginTest.java', 'x/y/LoginTest.java'],
      caseMaps: [map('TC-051', 'src/test/java/LoginTest.java')],
    });
    expect(r.affected[0].via).toBe('path');
    expect(r.suggestion).not.toContain('启发式');
  });

  it('命中的文件不进 unmapped，没命中的才进', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/LoginTest.java', 'docs/readme.md'],
      caseMaps: [map('TC-060', 'src/test/java/LoginTest.java')],
    });
    expect(r.unmapped).toEqual(['docs/readme.md']);
    expect(r.suggestion).toContain('1 个改动文件没有对应脚本');
  });

  it('空路径 / 空字符串被忽略，不会造出假的 unmapped', () => {
    const r = gitImpact({
      changedFiles: ['', '   ', { path: '' }, 'src/test/java/LoginTest.java'],
      caseMaps: [map('TC-070', 'src/test/java/LoginTest.java')],
    });
    expect(r.affected).toHaveLength(1);
    expect(r.unmapped).toEqual([]);
  });
});

describe('gitImpact：建议必须能照着做', () => {
  it('受影响超过 5 个时只点名前 5 个并给出总数', () => {
    const maps = Array.from({ length: 7 }, (_, i) => map(`TC-1${i}`, `src/T${i}.java`));
    const files = maps.map((m) => m.target.ref);
    const r = gitImpact({ changedFiles: files, caseMaps: maps });
    expect(r.affected).toHaveLength(7);
    expect(r.suggestion).toContain('等 7 个');
    expect((r.suggestion.match(/TC-1\d/g) || []).length).toBe(5);
  });

  it('受影响列表按可信度稳定排序（确定的在前）', () => {
    const r = gitImpact({
      changedFiles: ['src/test/java/LoginTest.java', 'zzz/OtherTest.java'],
      caseMaps: [
        map('TC-901', 'test/java/OtherTest.java'),            // 只能按文件名猜
        map('TC-902', 'src/test/java/LoginTest.java'),        // 路径精确
      ],
    });
    expect(r.affected.map((a) => a.caseNo)).toEqual(['TC-902', 'TC-901']);
  });

  it('输入缺失/非数组时按空处理，不抛异常', () => {
    expect(() => gitImpact({} as never)).not.toThrow();
    expect(gitImpact({} as never).status).toBe('empty-maps');
  });
});