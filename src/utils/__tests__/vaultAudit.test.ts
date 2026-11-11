import { describe, it, expect } from 'vitest';
import { auditVault } from '../../../electron/vault-audit.js';

/**
 * 库自检是「只读体检」：报什么、不报什么都要稳定，
 * 否则用户会习惯性忽略报告，真正丢数据的那条也被一起忽略掉。
 */
const healthy = () => ({
  schemaVersion: 2,
  entries: [
    { id: 'a', name: 'A', url: 'https://a.example.com', tags: ['工作'], createdAt: '2024-01-01T00:00:00.000Z' },
    { id: 'b', name: 'B', url: '', tags: [] },
  ],
  tags: ['工作'],
  history: { a: [{ password: 'old' }] },
  notes: [],
  accounts: [],
  environments: [],
  snippets: [],
  apiRequests: [],
});

const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map(i => i.code);

describe('vault-audit.auditVault 库自检', () => {
  it('健康的库不报任何问题', () => {
    const r = auditVault(healthy());
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.stats.entries).toBe(2);
    expect(r.counts.error).toBe(0);
  });

  it('空库 / 脏输入不抛异常', () => {
    for (const bad of [undefined, null, 'x', 0, []]) {
      const r = auditVault(bad);
      expect(r.ok).toBe(true);
      expect(Array.isArray(r.issues)).toBe(true);
    }
  });

  it('缺 id 与 id 重复都算 error', () => {
    const r = auditVault({
      entries: [{ name: '无 id' }, { id: 'x', name: '一' }, { id: 'x', name: '二' }],
      tags: [],
    });
    expect(codes(r)).toContain('entry-missing-id');
    expect(codes(r)).toContain('entry-duplicate-id');
    expect(r.ok).toBe(false);
  });

  it('网址不是 http(s) 时给 warn（不是 error）', () => {
    const r = auditVault({ entries: [{ id: 'a', name: 'A', url: 'ftp://files' }], tags: [] });
    expect(codes(r)).toContain('entry-bad-url');
    expect(r.ok).toBe(true);
  });

  it('没有协议头的网址不算问题（打开时会自动补 https://）', () => {
    const r = auditVault({
      entries: [
        { id: 'a', name: 'A', url: 'example.com/login' },
        { id: 'b', name: 'B', url: '10.0.0.1:8080' },
        { id: 'c', name: 'C', url: 'https://ok.example.com' },
      ],
      tags: [],
    });
    expect(codes(r)).not.toContain('entry-bad-url');
  });

  it('条目引用了标签表里没有的标签 → warn', () => {
    const r = auditVault({ entries: [{ id: 'a', name: 'A', tags: ['不存在'] }], tags: ['工作'] });
    expect(codes(r)).toContain('tag-dangling');
    expect(r.issues.find(i => i.code === 'tag-dangling')?.samples[0]).toContain('不存在');
  });

  it('附件文件丢失 → error', () => {
    const r = auditVault(
      { entries: [{ id: 'a', name: 'A', attachments: [{ id: 'gone' }, { id: 'here' }] }], tags: [] },
      { attachmentExists: (id) => id === 'here' },
    );
    expect(codes(r)).toContain('attachment-missing');
    expect(r.ok).toBe(false);
  });

  it('不传 attachmentExists 时跳过附件检查', () => {
    const r = auditVault({
      entries: [{ id: 'a', name: 'A', attachments: [{ id: 'gone' }] }],
      tags: [],
    });
    expect(codes(r)).not.toContain('attachment-missing');
  });

  it('笔记里引用的图片丢了 → error', () => {
    const r = auditVault(
      { entries: [], tags: [], notes: [{ id: 'n', title: '笔记', content: '![](pm-att:missing)' }] },
      { attachmentExists: () => false },
    );
    expect(codes(r)).toContain('note-attachment-missing');
    expect(r.ok).toBe(false);
  });

  it('历史记录挂在已删除条目上 → warn，且能列出是谁', () => {
    const r = auditVault({ entries: [], tags: [], history: { dead: [{ password: 'p' }] } });
    expect(codes(r)).toContain('history-orphan');
    expect(r.issues.find(i => i.code === 'history-orphan')?.samples).toEqual(['dead']);
  });

  it('未使用标签与重复标签分别是 info 与 warn', () => {
    const r = auditVault({ entries: [], tags: ['闲置', '工作', '工作'] });
    const unused = r.issues.find(i => i.code === 'tag-unused');
    const dup = r.issues.find(i => i.code === 'tag-duplicate');
    expect(unused?.level).toBe('info');
    expect(dup?.level).toBe('warn');
    expect(r.ok).toBe(true);
  });

  it('问题按 error → warn → info 排序', () => {
    const r = auditVault({
      entries: [{ name: '', url: 'ftp://x' }, { id: 'a', name: 'A', tags: ['悬空'] }],
      tags: ['闲置'],
    });
    const levels = r.issues.map(i => i.level);
    const order = { error: 0, warn: 1, info: 2 } as Record<string, number>;
    for (let i = 1; i < levels.length; i++) {
      expect(order[levels[i]]).toBeGreaterThanOrEqual(order[levels[i - 1]]);
    }
  });

  it('时间戳解析不了 → warn', () => {
    const r = auditVault({ entries: [{ id: 'a', name: 'A', createdAt: '不是时间' }], tags: [] });
    expect(codes(r)).toContain('entry-bad-time');
  });
});
