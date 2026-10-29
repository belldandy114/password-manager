import { describe, it, expect } from 'vitest';
import { ztDecodeEntities, ztStripTags, ztTableRows } from '../../../electron/zentao-parse.js';

/**
 * 禅道 dtable 解析：数据被塞在 HTML 属性里，且不是合法 JSON。
 * 这里按「真实响应长什么样」造样本，重点覆盖：
 *   1. 字符串里出现 ] 和 \" 时括号配平不能数错；
 *   2. 任何畸形输入都返回 []，绝不抛异常；
 *   3. &amp; 必须最后解码。
 */
/** 真实页面里属性内的引号全是 &quot;，data 部分也一样 —— 不编码就匹配不到属性值 */
const attr = (s: string) => s.replace(/"/g, '&quot;');
const wrap = (dataJson: string) =>
  `<div class="dtable" zui-create-dtable="{&quot;cols&quot;:[{&quot;name&quot;:&quot;id&quot;}],&quot;data&quot;:${attr(dataJson)},&quot;config&quot;:{&quot;checkable&quot;:function(){return true;}}}"></div>`;

describe('ztDecodeEntities', () => {
  it('常见实体都能还原', () => {
    expect(ztDecodeEntities('&quot;a&quot; &lt;b&gt; &#039;c&#039; &#x27;d&#x27; &#39;')).toBe(`"a" <b> 'c' 'd' '`);
    expect(ztDecodeEntities('a&#x2F;b')).toBe('a/b');
  });

  it('&amp; 最后解码，不会二次解码成尖括号', () => {
    expect(ztDecodeEntities('&amp;lt;')).toBe('&lt;');
    expect(ztDecodeEntities('&amp;')).toBe('&');
  });

  it('空值不抛异常', () => {
    expect(ztDecodeEntities(null)).toBe('');
    expect(ztDecodeEntities(undefined)).toBe('');
  });
});

describe('ztStripTags', () => {
  it('去标签、压空白、去首尾', () => {
    expect(ztStripTags('  <p>标题&nbsp;一</p>  <b>二</b> ')).toBe('标题 一 二');
    expect(ztStripTags('多\n行\t\t文本')).toBe('多 行 文本');
  });

  it('纯文本原样返回', () => {
    expect(ztStripTags('普通标题')).toBe('普通标题');
  });
});

describe('ztTableRows', () => {
  it('能取到 data 数组', () => {
    const html = wrap('[{"id":1,"title":"Bug A"},{"id":2,"title":"Bug B"}]');
    const rows = ztTableRows(html);
    expect(rows).toHaveLength(2);
    expect((rows[0] as { title: string }).title).toBe('Bug A');
  });

  it('字符串里含 ]、" 时不会提前结束（括号配平 + 引号状态机）', () => {
    const html = wrap('[{"id":1,"title":"含 [中括号] 和 \\"引号\\" 的标题"}]');
    const rows = ztTableRows(html);
    expect(rows).toHaveLength(1);
    expect((rows[0] as { title: string }).title).toBe('含 [中括号] 和 "引号" 的标题');
  });

  it('嵌套数组/对象也能解析', () => {
    const html = wrap('[{"id":1,"tags":[{"name":"a"},{"name":"b"}]}]');
    const rows = ztTableRows(html) as { tags: { name: string }[] }[];
    expect(rows[0].tags.map(t => t.name)).toEqual(['a', 'b']);
  });

  it('没有 dtable 属性 → []', () => {
    expect(ztTableRows('<div>普通页面</div>')).toEqual([]);
    expect(ztTableRows('')).toEqual([]);
    expect(ztTableRows(null as unknown as string)).toEqual([]);
  });

  it('有属性但没有 "data": → []', () => {
    expect(ztTableRows('<div zui-create-dtable="{}"></div>')).toEqual([]);
  });

  it('data 后面不是数组 → []', () => {
    expect(ztTableRows('<div zui-create-dtable="{&quot;data&quot;:{}}"></div>')).toEqual([]);
  });

  it('括号不平衡 / JSON 非法 → []（不抛异常）', () => {
    const broken = '<div zui-create-dtable="{&quot;data&quot;:[{&quot;id&quot;:1}"></div>';
    expect(ztTableRows(broken)).toEqual([]);
    const badJson = '<div zui-create-dtable="{&quot;data&quot;:[{id:1,}]}"></div>';
    expect(ztTableRows(badJson)).toEqual([]);
  });

  it('空数组返回 []（不是 null）', () => {
    expect(ztTableRows(wrap('[]'))).toEqual([]);
  });
});
