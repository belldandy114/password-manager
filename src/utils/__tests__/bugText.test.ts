import { describe, it, expect } from 'vitest';
import { bugToText, bugsToText, bugsToCsv } from '../bugText';
import type { ZentaoBug } from '../../types';

const bug = {
  id: '101', title: '登录失败', status: 'active', severity: '3', pri: '2',
  productName: '示例系统', assignedTo: '测试员', date: '2026-11-06',
  resolution: '', deadline: '', openedBy: '', module: '', moduleName: '',
} as unknown as ZentaoBug;

describe('bugText', () => {
  it('单条文本包含标题、ID、状态与链接', () => {
    const text = bugToText(bug, 'http://example.com/zentao/');
    expect(text).toContain('登录失败');
    expect(text).toContain('#101');
    expect(text).toContain('激活');
    expect(text).toContain('http://example.com/zentao/bug-view-101.html');
  });

  it('列表与表格两种格式', () => {
    expect(bugsToText([], '')).toBe('');
    expect(bugsToText([bug], '').split('\n\n')).toHaveLength(1);
    const md = bugsToText([bug], '', 'table');
    expect(md).toContain('| ID | 标题 |');
    expect(md).toContain('| #101 |');
  });

  it('CSV 带表头且引号包裹字段', () => {
    const csv = bugsToCsv([bug], '');
    expect(csv.split('\n')[0]).toContain('"ID"');
    expect(csv).toContain('"登录失败"');
  });
});
