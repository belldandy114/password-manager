import { describe, it, expect } from 'vitest';
import type { ZentaoBug, ZentaoDigestGroup } from '../../types';
import {
  buildDigest, cnIndex, defaultRange, mondayOf, ymd, mergeDigest,
  DEFAULT_DIGEST_OPTIONS, type DigestOptions,
} from '../weeklyDigest';

const opt = (patch: Partial<DigestOptions> = {}): DigestOptions => ({
  ...DEFAULT_DIGEST_OPTIONS,
  from: '2026-11-02',
  to: '2026-11-06',
  ...patch,
});

/** 造一条 Bug；默认「已关闭 + resolution=fixed」，最接近真实周报的主体 */
function bug(patch: Partial<ZentaoBug> & { id: string }): ZentaoBug {
  return {
    title: `缺陷 ${patch.id}`,
    status: 'closed',
    resolution: 'fixed',
    product: '58',
    productName: '资产管理系统',
    moduleName: '添置资产',
    openedDate: '2026-09-01 10:00',
    ...patch,
  };
}

function group(bugs: ZentaoBug[], patch: Partial<ZentaoDigestGroup> = {}): ZentaoDigestGroup {
  return {
    instanceId: 'inst-a',
    name: '南博',
    baseUrl: 'http://172.16.1.90:8181/zentao',
    ok: true,
    error: '',
    bugs,
    modules: {},
    productIds: ['58'],
    ...patch,
  };
}

describe('cnIndex', () => {
  it('1~10', () => {
    expect(cnIndex(1)).toBe('一');
    expect(cnIndex(9)).toBe('九');
    expect(cnIndex(10)).toBe('十');
  });
  it('11 以上不出现「一十」', () => {
    expect(cnIndex(11)).toBe('十一');
    expect(cnIndex(20)).toBe('二十');
    expect(cnIndex(23)).toBe('二十三');
  });
});

describe('日期工具', () => {
  it('周一为一周起点（周日要回到 6 天前）', () => {
    // 2026-11-08 是周日
    expect(ymd(mondayOf(new Date(2026, 10, 8)))).toBe('2026-11-02');
    expect(ymd(mondayOf(new Date(2026, 10, 2)))).toBe('2026-11-02');
  });
  it('defaultRange 从本周一到今天', () => {
    expect(defaultRange(new Date(2026, 10, 6))).toEqual({ from: '2026-11-02', to: '2026-11-06' });
  });
});

describe('buildDigest 主体句式', () => {
  it('与现有周报一致：累计缺陷 / 已关闭 / 已修复 / 待修复 / 已解决待验证 / 修复率', () => {
    const bugs = [
      bug({ id: '1' }),
      bug({ id: '2' }),
      bug({ id: '3', status: 'closed', resolution: '' }),  // 关闭但非 fixed（如不予解决）
      bug({ id: '4', status: 'active', resolution: '' }),
      bug({ id: '5', status: 'resolved', resolution: 'fixed' }),
    ];
    const { markdown, projects } = buildDigest([group(bugs)], opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }));
    const p = projects[0];
    expect(p.total).toBe(5);
    expect(p.fixed).toBe(3);     // 1、2、5
    expect(p.closed).toBe(3);    // 1、2、3
    expect(p.active).toBe(1);    // 4
    expect(p.resolved).toBe(1);  // 5
    expect(p.rate).toBe(60);     // 3/5

    expect(markdown).toContain('**一、资产管理系统**');
    expect(markdown).toContain(
      '累计缺陷 5 个，已关闭 3 个、已修复 3 个、待修复 1 个，另有 1 个已解决待验证，修复率 60%。模块分布如下：',
    );
  });

  it('没有「已解决待验证」时不写这半句（避免出现 0 个已解决待验证）', () => {
    const { markdown } = buildDigest(
      [group([bug({ id: '1' })])],
      opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }),
    );
    expect(markdown).toContain('待修复 0 个，修复率 100%。');
    expect(markdown).not.toContain('另有');
  });

  it('模块行按数量降序，且只写非 0 的分项', () => {
    const bugs = [
      bug({ id: '1', moduleName: '资产台账' }),
      bug({ id: '2', moduleName: '添置资产' }),
      bug({ id: '3', moduleName: '添置资产' }),
      bug({ id: '4', moduleName: '添置资产', status: 'active', resolution: '' }),
    ];
    const { markdown } = buildDigest(
      [group(bugs)],
      opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }),
    );
    const lines = markdown.split('\n');
    expect(lines.some(l => l.startsWith('（1）添置资产：共 3 个'))).toBe(true);
    // 添置资产：2 关闭 + 1 待修复 → 待修复在前、已关闭在后，没有「待验证 0 个」
    expect(markdown).toContain('（1）添置资产：共 3 个，待修复 1 个、已关闭 2 个');
    expect(markdown).toContain('（2）资产台账：共 1 个，已关闭 1 个');
    expect(markdown).not.toContain('待验证 0 个');
  });

  it('模块路径只取第一段（周报里写的是顶层模块）', () => {
    const { markdown } = buildDigest(
      [group([bug({ id: '1', moduleName: '添置资产/列表/新增' })])],
      opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }),
    );
    expect(markdown).toContain('（1）添置资产：共 1 个');
    expect(markdown).not.toContain('添置资产/列表');
  });

  it('没有模块名时归到「未指定模块」', () => {
    const { markdown } = buildDigest(
      [group([bug({ id: '1', moduleName: '' })])],
      opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }),
    );
    expect(markdown).toContain('（1）未指定模块：共 1 个');
  });
});

describe('模块长尾合并', () => {
  const many = Array.from({ length: 6 }, (_, i) =>
    bug({ id: String(i + 1), moduleName: `模块${i + 1}` }));

  it('超过阈值时把尾巴合并成「其他（A、B等）」', () => {
    const { markdown } = buildDigest(
      [group(many)],
      opt({ mergeModulesOver: 3, includeWeekly: false, includeSummary: false, includeNextWeek: false }),
    );
    expect(markdown).toContain('（1）模块1：共 1 个');
    expect(markdown).toContain('（2）模块2：共 1 个');
    // 第 3 行是「其他」，装下模块3~6
    expect(markdown).toContain('（3）其他（模块3、模块4、模块5等）：共 4 个');
    expect(markdown).not.toContain('（4）模块4');
  });

  it('阈值为 0 表示不合并', () => {
    const { markdown } = buildDigest(
      [group(many)],
      opt({ mergeModulesOver: 0, includeWeekly: false, includeSummary: false, includeNextWeek: false }),
    );
    expect(markdown).toContain('（6）模块6');
    expect(markdown).not.toContain('其他（');
  });
});

describe('本周增量', () => {
  it('按 openedDate / resolvedDate / closedDate 分别落在窗口内才算', () => {
    const bugs = [
      bug({ id: '1', openedDate: '2026-11-03 09:00' }),                       // 本周新建
      bug({ id: '2', openedDate: '2026-09-01 09:00', resolvedDate: '2026-11-04 10:00' }),
      bug({ id: '3', openedDate: '2026-09-01 09:00', closedDate: '2026-11-05 10:00' }),
      bug({ id: '4', openedDate: '2026-10-01 09:00' }),                       // 窗口外
    ];
    const { projects } = buildDigest(
      [group(bugs)],
      opt({ includeWeekly: true, includeSummary: false, includeNextWeek: false }),
    );
    expect(projects[0].weekNew).toBe(1);
    expect(projects[0].weekResolved).toBe(1);
    expect(projects[0].weekClosed).toBe(1);
  });

  it('三个增量都是 0 时不输出那一句', () => {
    const { markdown } = buildDigest(
      [group([bug({ id: '1', openedDate: '2026-01-01 09:00' })])],
      opt({ includeWeekly: true, includeSummary: false, includeNextWeek: false }),
    );
    expect(markdown).not.toContain('本周新增');
  });
});

describe('多实例', () => {
  const a = group([bug({ id: '1', product: '58', productName: '资产管理系统' })], { instanceId: 'a', name: '南博' });
  const b = group([bug({ id: '1', product: '58', productName: '资产管理系统' })], { instanceId: 'b', name: '博思' });

  it('不同实例里同 id 的产品不会被合并，标题补公司名', () => {
    const { projects, markdown } = buildDigest([a, b], opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }));
    expect(projects).toHaveLength(2);
    expect(markdown).toContain('资产管理系统（南博）');
    expect(markdown).toContain('资产管理系统（博思）');
  });

  it('按公司分组时，公司是一级、项目是二级', () => {
    const { markdown } = buildDigest([a, b], opt({ layout: 'byCompany', includeWeekly: false, includeSummary: false, includeNextWeek: false }));
    expect(markdown).toMatch(/\*\*一、[^*]+\*\*/);
    expect(markdown).toContain('1、资产管理系统');
  });

  it('失败的实例不出现在正文里', () => {
    const bad = { ...group([], { instanceId: 'c', name: '挂了' }), ok: false, error: '连不上' };
    const { projects } = buildDigest([a, bad], opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }));
    expect(projects).toHaveLength(1);
  });

  it('总数为 0 的产品不出章节', () => {
    const { markdown } = buildDigest([group([])], opt({ includeWeekly: false, includeSummary: false, includeNextWeek: false }));
    expect(markdown.trim()).toBe('');
  });

  it('总结段和下周计划也用带公司名的标题，避免「资产管理系统、资产管理系统」', () => {
    const { markdown } = buildDigest([a, b], opt({ includeWeekly: false, includeSummary: true, includeNextWeek: true }));
    expect(markdown).toContain('本周完成资产管理系统（南博）、资产管理系统（博思）的测试与缺陷跟踪');
    expect(markdown).toContain('一、资产管理系统（南博）');
    expect(markdown).toContain('二、资产管理系统（博思）');
    // 不能出现两个一模一样的「一、资产管理系统」
    expect((markdown.match(/一、资产管理系统\*\*/g) || [])).toHaveLength(0);
  });

  it('已解决待验证为 0 时，总结段不写这半句', () => {
    const { markdown } = buildDigest([group([bug({ id: '1' })])], opt({ includeWeekly: false, includeSummary: true, includeNextWeek: false }));
    expect(markdown).not.toContain('已解决待验证');
  });
});

describe('可选段落', () => {
  const g = group([bug({ id: '1' }), bug({ id: '2', moduleName: '资产台账' })]);

  it('总结段包含各项目的主要模块', () => {
    const { markdown } = buildDigest([g], opt({ includeSummary: true, includeNextWeek: false, includeWeekly: false }));
    expect(markdown).toContain('本周完成资产管理系统的测试与缺陷跟踪');
    expect(markdown).toContain('修复率 100%');
    expect(markdown).toContain('整体测试与修复工作按计划推进');
  });

  it('下周计划用中文序号，且带两条默认建议', () => {
    const { markdown } = buildDigest([g], opt({ includeSummary: false, includeNextWeek: true, includeWeekly: false }));
    expect(markdown).toContain('下周工作计划');
    expect(markdown).toContain('一、资产管理系统');
    expect(markdown).toContain('1、回归测试开发已修复的缺陷');
  });

  it('三个开关都关掉时只留正文', () => {
    const { markdown } = buildDigest([g], opt({ includeSummary: false, includeNextWeek: false, includeWeekly: false }));
    expect(markdown).not.toContain('本周新增');
    expect(markdown).not.toContain('下周工作计划');
    expect(markdown).not.toContain('整体测试与修复工作按计划推进');
  });
});

describe('按创建人筛选', () => {
  const g = group([
    bug({ id: '1', openedBy: 'zhangsan' }),
    bug({ id: '2', openedBy: 'zhangsan' }),
    bug({ id: '3', openedBy: 'lisi' }),
    bug({ id: '4', openedBy: 'lisi', status: 'active', resolution: '' }),
  ]);
  const base = { includeSummary: false, includeNextWeek: false, includeWeekly: false };

  it('留空时统计全部', () => {
    const { projects } = buildDigest([g], opt({ ...base, openedBy: {} }));
    expect(projects[0].total).toBe(4);
    expect(projects[0].active).toBe(1);
  });

  it('单选一个人只统计这个人的缺陷', () => {
    const { projects } = buildDigest([g], opt({ ...base, openedBy: { 'inst-a': ['zhangsan'] } }));
    expect(projects[0].total).toBe(2);
    expect(projects[0].active).toBe(0);
    expect(projects[0].rate).toBe(100);
  });

  it('多选是并集（不是交集）', () => {
    const { projects } = buildDigest([g], opt({ ...base, openedBy: { 'inst-a': ['zhangsan', 'lisi'] } }));
    expect(projects[0].total).toBe(4);
  });

  it('正文开头写明统计范围，方便事后核对', () => {
    const { markdown } = buildDigest([g], opt({ ...base, openedBy: { 'inst-a': ['zhangsan', 'lisi'] } }));
    expect(markdown.startsWith('统计范围：创建人 南博：zhangsan、lisi（2026-11-02 至 2026-11-06）')).toBe(true);
  });

  it('不筛选时不写范围行，格式与你现有周报完全一致', () => {
    const { markdown } = buildDigest([g], opt({ ...base, openedBy: {} }));
    expect(markdown.startsWith('**一、')).toBe(true);
  });

  it('筛到没人时返回空结果（调用方据此提示换人）', () => {
    const { projects, markdown } = buildDigest([g], opt({ ...base, openedBy: { 'inst-a': ['wangwu'] } }));
    expect(projects).toHaveLength(0);
    expect(markdown.trim()).toBe('');
  });

  it('按公司分开：只筛甲公司的人，不影响乙公司', () => {
    const a = group([bug({ id: '1', openedBy: '张三' }), bug({ id: '2', openedBy: '李四' })]);
    const b = group(
      [bug({ id: '3', openedBy: '张三' }), bug({ id: '4', openedBy: '张三' })],
      { instanceId: 'inst-b', name: '乙公司' },
    );
    const { projects, markdown } = buildDigest([a, b], opt({ ...base, openedBy: { 'inst-a': ['张三'] } }));
    const pa = projects.find(p => p.instanceId === 'inst-a');
    const pb = projects.find(p => p.instanceId === 'inst-b');
    expect(pa?.total).toBe(1);
    // 乙公司没筛人，全部保留 —— 这正是「分公司」的意义
    expect(pb?.total).toBe(2);
    expect(markdown).toContain('统计范围：创建人 南博：张三');
    expect(markdown).not.toContain('乙公司：');
  });

  it('同一家在两家公司都有的人，可以只挑其中一家', () => {
    const a = group([bug({ id: '1', openedBy: '张三' })]);
    const b = group([bug({ id: '2', openedBy: '张三' })], { instanceId: 'inst-b', name: '乙公司' });
    const { projects } = buildDigest([a, b], opt({ ...base, openedBy: { 'inst-b': ['张三'] } }));
    expect(projects).toHaveLength(2);
    // 只筛了乙公司，甲公司的数据一条都不少
    expect(projects.find(p => p.instanceId === 'inst-a')?.total).toBe(1);
    expect(projects.find(p => p.instanceId === 'inst-b')?.total).toBe(1);
  });

  it('创建人筛选与本周增量叠加时不串味', () => {
    const g2 = group([
      bug({ id: '1', openedBy: 'zhangsan', openedDate: '2026-11-03 09:00' }),
      bug({ id: '2', openedBy: 'lisi', openedDate: '2026-11-03 09:00' }),
    ]);
    const { projects } = buildDigest([g2], opt({ includeWeekly: true, openedBy: { 'inst-a': ['lisi'] } }));
    expect(projects[0].total).toBe(1);
    expect(projects[0].weekNew).toBe(1);
  });
});

describe('合并进已有草稿（生成一次后再补充）', () => {
  const oldDoc = [
    '**一、资产管理系统**',
    '',
    '累计缺陷 5 个，已关闭 3 个、已修复 4 个、待修复 1 个，修复率 80%。模块分布如下：',
    '',
    '（1）添置资产：共 5 个，待修复 1 个、已关闭 3 个',
    '',
    '本周完成资产管理系统的测试与缺陷跟踪。整体测试与修复工作按计划推进。',
    '',
    '下周工作计划',
    '一、资产管理系统',
    '1、回归测试开发已修复的缺陷',
  ].join('\n');

  const newDoc = [
    '**一、资产管理系统**',
    '',
    '累计缺陷 7 个，已关闭 5 个、已修复 6 个、待修复 1 个，修复率 85.7%。模块分布如下：',
    '',
    '（1）添置资产：共 7 个，待修复 1 个、已关闭 5 个',
    '',
    '本周完成资产管理系统的测试与缺陷跟踪。整体测试与修复工作按计划推进。',
    '',
    '下周工作计划',
    '一、资产管理系统',
    '1、回归测试开发已修复的缺陷',
  ].join('\n');

  it('空草稿时直接用新内容', () => {
    const { markdown, stats } = mergeDigest('', newDoc);
    expect(stats).toEqual({ updated: 0, added: 0 });
    expect(markdown).toContain('累计缺陷 7 个');
  });

  it('同名项目整段换成新数字，不会出现两份', () => {
    const { markdown, stats } = mergeDigest(oldDoc, newDoc);
    expect(stats).toEqual({ updated: 1, added: 0 });
    expect(markdown).toContain('累计缺陷 7 个');
    expect(markdown).not.toContain('累计缺陷 5 个');
    expect((markdown.match(/\*\*一、资产管理系统\*\*/g) || []).length).toBe(1);
  });

  it('手写的段落原样保留（这是「合并」而不是「覆盖」的关键）', () => {
    const withNote = oldDoc.replace(
      '本周完成资产管理系统的测试与缺陷跟踪。',
      '本周完成资产管理系统的测试与缺陷跟踪。另外配合产品做了一轮需求评审。',
    );
    const { markdown } = mergeDigest(withNote, newDoc);
    expect(markdown).toContain('另外配合产品做了一轮需求评审');
  });

  it('新项目追加到后面，序号自动重排', () => {
    const withExtra = `${newDoc.replace('**一、资产管理系统**', '**一、资产管理系统**')}\n\n**二、学工平台**\n\n累计缺陷 2 个，已关闭 2 个、已修复 2 个、待修复 0 个，修复率 100%。模块分布如下：\n\n（1）成绩管理：共 2 个，已关闭 2 个`;
    const { markdown, stats } = mergeDigest(oldDoc, withExtra);
    expect(stats.added).toBe(1);
    expect(markdown).toContain('**一、资产管理系统**');
    expect(markdown).toContain('**二、学工平台**');
  });

  it('老草稿里被删掉的项目会保留（不会因为这次没勾选就消失）', () => {
    const onlyOne = '**一、学工平台**\n\n累计缺陷 2 个。\n\n本周完成学工平台。';
    const { markdown, stats } = mergeDigest(oldDoc, onlyOne);
    expect(stats.updated).toBe(0);
    expect(stats.added).toBe(1);
    expect(markdown).toContain('**一、资产管理系统**');
    expect(markdown).toContain('**二、学工平台**');
  });

  it('结尾的总结段 / 下周计划只保留一份', () => {
    const { markdown } = mergeDigest(oldDoc, newDoc);
    expect((markdown.match(/下周工作计划/g) || []).length).toBe(1);
    expect((markdown.match(/整体测试与修复工作按计划推进/g) || []).length).toBe(1);
  });

  it('统计范围行以新的为准，不会两行叠在一起', () => {
    const a = `统计范围：创建人 张三（2026-11-02 至 2026-11-06）\n\n${oldDoc}`;
    const b = `统计范围：创建人 李四（2026-11-02 至 2026-11-06）\n\n${newDoc}`;
    const { markdown } = mergeDigest(a, b);
    expect(markdown).toContain('创建人 李四');
    expect(markdown).not.toContain('创建人 张三');
    expect((markdown.match(/统计范围：/g) || []).length).toBe(1);
  });

  it('老草稿里没有可识别的项目章节时，新章节插到最前、原文不丢', () => {
    const plain = '这周主要是回归测试，另外参加了两个会议。';
    const { markdown, stats } = mergeDigest(plain, newDoc);
    expect(stats.added).toBe(1);
    expect(markdown.startsWith('**一、资产管理系统**')).toBe(true);
    expect(markdown).toContain('这周主要是回归测试');
  });

  it('合并结果再合并一次是幂等的（不会越并越长）', () => {
    const once = mergeDigest(oldDoc, newDoc).markdown;
    const twice = mergeDigest(once, newDoc).markdown;
    expect(twice.trim()).toBe(once.trim());
  });
});
