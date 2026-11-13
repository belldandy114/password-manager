import { describe, it, expect } from 'vitest';
import { mergeSqlViews, plainNotes } from '../notesMerge';

describe('mergeSqlViews（SQL 片段并入测试笔记后的搜索视图）', () => {
  it('notes 里 kind=sql 的条目会作为片段出现', () => {
    const notes = [
      { id: 'n1', title: '查用户', content: 'SELECT * FROM t_user', tags: ['造数'], kind: 'sql' },
      { id: 'n2', title: '排查记录', content: '## 现象', tags: [], kind: 'note' },
    ];
    expect(mergeSqlViews(notes, [])).toEqual([
      { id: 'n1', title: '查用户', sql: 'SELECT * FROM t_user', tags: ['造数'] },
    ]);
    expect(plainNotes(notes).map(n => n.id)).toEqual(['n2']);
  });

  it('迁移前只在旧 snippets 集合里的片段仍能搜到', () => {
    const out = mergeSqlViews([], [
      { id: 's1', title: '清理订单', sql: 'DELETE FROM t_order', tags: ['清理'] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].sql).toBe('DELETE FROM t_order');
  });

  it('同一条片段在两个来源都存在时只出一条（按标题+正文去重）', () => {
    const out = mergeSqlViews(
      [{ id: 'n1', title: '查用户', content: 'SELECT 1', kind: 'sql', tags: [] }],
      [{ id: 's1', title: '查用户', sql: 'SELECT 1', tags: [] }],
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('n1');
  });

  it('老笔记没有 kind 字段，一律算普通笔记', () => {
    const notes = [{ id: 'old', title: '老笔记', content: '正文' }];
    expect(mergeSqlViews(notes, [])).toEqual([]);
    expect(plainNotes(notes)).toHaveLength(1);
  });

  it('标题或正文缺失时给兜底文案，不抛异常', () => {
    const out = mergeSqlViews([{ kind: 'sql' }], [{}]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBeTruthy();
  });
});
