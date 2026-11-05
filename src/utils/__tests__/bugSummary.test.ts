import { describe, it, expect } from 'vitest';
import {
  summarize, isExcluded, bugIsFixed, summaryToText, projectToText, personsToText,
  summaryToMarkdown, summaryToCsv, summaryTo, severityRows, daysAgoDay, personOf,
  dailyNew, parseCutoff, fmtCutoff, statDayOf,
} from '../bugSummary';
import type { ZentaoBug } from '../../types';

/** 造一条汇总用的 Bug（只填对统计有影响的字段） */
const bug = (
  id: string,
  product: string,
  status: string,
  resolution = '',
  openedBy = 'zhangsan',
  assignedTo = 'lisi',
  moduleName = '登录模块',
): ZentaoBug =>
  ({
    id,
    product,
    status,
    resolution,
    openedBy,
    assignedTo,
    moduleName,
    module: '1',
    title: `bug-${id}`,
  } as unknown as ZentaoBug);

describe('bugSummary 口径', () => {
  it('已修复只看 resolution=fixed，不看状态', () => {
    expect(bugIsFixed(bug('1', '58', 'active', 'fixed'))).toBe(true);
    expect(bugIsFixed(bug('2', '58', 'closed', ''))).toBe(false);
    // 禅道里 status=closed 通常也带 resolution=fixed，要算已修复
    expect(bugIsFixed(bug('3', '58', 'closed', 'fixed'))).toBe(true);
  });

  it('总数含已关闭与待验证，修复率 = 已修复 / 总数', () => {
    const bugs = [
      bug('1', '58', 'active', ''), // 未修复
      bug('2', '58', 'resolved', 'fixed'), // 待验证
      bug('3', '58', 'closed', 'fixed'), // 已关闭
      bug('4', '58', 'closed', 'fixed'),
    ];
    const { overall } = summarize(bugs, { productIds: ['58'] });
    expect(overall.total).toBe(4);
    expect(overall.fixed).toBe(3);
    expect(overall.active).toBe(1);
    expect(overall.resolved).toBe(1);
    expect(overall.closed).toBe(2);
    expect(overall.rate).toBe(75);
  });

  it('延期/挂起等状态进 other，但仍在总数里', () => {
    const { overall } = summarize([bug('1', '58', 'postponed')], { productIds: ['58'] });
    expect(overall.total).toBe(1);
    expect(overall.other).toBe(1);
    expect(overall.active + overall.resolved + overall.closed).toBe(0);
  });

  it('修复率保留 1 位小数', () => {
    const bugs = [bug('1', '58', 'closed', 'fixed'), bug('2', '58', 'closed', 'fixed'), bug('3', '58', 'active')];
    expect(summarize(bugs, { productIds: ['58'] }).overall.rate).toBe(66.7);
  });

  it('0 条时修复率不除零', () => {
    const { overall, projects } = summarize([], { productIds: ['58'] });
    expect(overall.rate).toBe(0);
    expect(projects).toHaveLength(1);
    expect(projects[0].stat.total).toBe(0);
  });
});

describe('bugSummary 按项目/按模块', () => {
  const bugs = [
    bug('1', '58', 'active', '', 'a', 'b', '登录/密码登录'),
    bug('2', '58', 'closed', 'fixed', 'a', 'b', '登录/密码登录'),
    bug('3', '58', 'resolved', 'fixed', 'a', 'b', '订单'),
    bug('4', '59', 'active', '', 'a', 'b', '首页'),
  ];

  it('按 product 分桶，模块按名字分组', () => {
    const { projects } = summarize(bugs, { productIds: ['58', '59'] });
    expect(projects.map(p => p.id)).toEqual(['58', '59']);
    const p58 = projects[0];
    expect(p58.stat.total).toBe(3);
    expect(p58.modules.map(m => m.name).sort()).toEqual(['登录/密码登录', '订单']);
    expect(p58.modules[0].total).toBe(2);
  });

  it('模块之和 = 项目总数（不会漏计）', () => {
    const { projects } = summarize(bugs, { productIds: ['58', '59'] });
    for (const p of projects) {
      expect(p.modules.reduce((s, m) => s + m.total, 0)).toBe(p.stat.total);
      expect(p.modules.reduce((s, m) => s + m.active, 0)).toBe(p.stat.active);
      expect(p.modules.reduce((s, m) => s + m.resolved, 0)).toBe(p.stat.resolved);
    }
  });

  it('项目行之和 = 总计', () => {
    const { projects, overall } = summarize(bugs, { productIds: ['58', '59'] });
    expect(projects.reduce((s, p) => s + p.stat.total, 0)).toBe(overall.total);
    expect(projects.reduce((s, p) => s + p.stat.fixed, 0)).toBe(overall.fixed);
  });

  it('选中但 0 条的项目也占一行（按选择顺序）', () => {
    const { projects } = summarize([bug('1', '58', 'active')], { productIds: ['99', '58'] });
    expect(projects.map(p => p.id)).toEqual(['99', '58']);
    expect(projects[0].stat.total).toBe(0);
  });

  it('模块名缺失时依次退化：模块<id> → 未指定模块', () => {
    const withId = { ...bug('1', '58', 'active'), moduleName: '', module: '77' } as ZentaoBug;
    const noId = { ...bug('2', '58', 'active'), moduleName: '', module: '0' } as ZentaoBug;
    const { projects } = summarize([withId, noId], { productIds: ['58'] });
    // 两边都排序再比，避免依赖中文的码位顺序
    expect(projects[0].modules.map(m => m.name).sort()).toEqual(['模块77', '未指定模块'].sort());
  });

  it('项目名优先用外部传入的名字表', () => {
    const { projects } = summarize([bug('1', '58', 'active')], {
      productIds: ['58'],
      productNames: { 58: '示例系统-管理后台V2.0' },
    });
    expect(projects[0].name).toBe('示例系统-管理后台V2.0');
  });
});

describe('bugSummary 排除人员（只看指派人，且只影响人员表）', () => {
  const bugs = [
    bug('1', '58', 'active', '', '张三', 'lisi'), // 张三只是提交人 → 不该被排除
    bug('2', '58', 'active', '', 'zhangsan', '张三'), // 张三是指派人 → 排除
    bug('3', '58', 'active', '', 'zhangsan', 'lisi'),
  ];

  it('只按「当前指派人」匹配，提交人不参与', () => {
    const exclude = new Set(['张三']);
    expect(isExcluded(bugs[0], exclude)).toBe(false);
    expect(isExcluded(bugs[1], exclude)).toBe(true);
    expect(isExcluded(bugs[2], exclude)).toBe(false);
  });

  it('排除后总数与模块数字不变，只是从人员表里去掉', () => {
    const all = summarize(bugs, { productIds: ['58'] });
    const ex = summarize(bugs, { productIds: ['58'], exclude: ['张三'] });

    expect(ex.overall.total).toBe(all.overall.total);
    expect(ex.overall.total).toBe(3);
    expect(ex.projects[0].stat.total).toBe(3);
    expect(ex.projects[0].modules.reduce((s, m) => s + m.total, 0)).toBe(3);

    expect(ex.persons.map(p => p.name)).toEqual(['lisi']);
    expect(ex.persons[0].total).toBe(2);
    expect(ex.skipped).toBe(1);
    expect(ex.projects[0].skipped).toBe(1);
  });

  it('已关闭的不挂在任何人名下，也不算「未指派」', () => {
    const rows = [...bugs, bug('4', '58', 'closed', 'fixed', 'zhangsan', 'lisi')];
    const r = summarize(rows, { productIds: ['58'] });
    expect(r.persons.map(p => p.name)).toEqual(['lisi', '张三']);
    expect(r.persons[0].total).toBe(2); // 不含已关闭那条
    expect(r.overall.closed).toBe(1);
    expect(r.unassigned).toBe(0);
    // 人员之和 + 未指派 + 已排除 = 未关闭数
    expect(r.persons.reduce((s, p) => s + p.total, 0) + r.unassigned + r.skipped)
      .toBe(r.overall.total - r.overall.closed);
  });

  it('排除名单里的空串/空格不生效', () => {
    const { persons } = summarize(bugs, { productIds: ['58'], exclude: ['  ', ''] });
    expect(persons.reduce((s, p) => s + p.total, 0)).toBe(3);
  });
});

describe('bugSummary 复制文本', () => {
  const bugs = [
    bug('1', '58', 'active', '', 'zhangsan', 'lisi', '登录/密码登录'),
    bug('2', '58', 'closed', 'fixed', 'zhangsan', 'lisi', '登录/密码登录'),
  ];

  it('不传时间时也能生成（不抛异常）', () => {
    const { projects, overall } = summarize(bugs, { productIds: ['58'] });
    const text = summaryToText(projects, overall);
    expect(text).toContain('【缺陷汇总】');
    expect(text).toContain('合计 缺陷 2');
  });

  it('含合计、项目行、模块行、排除说明', () => {
    const { projects, overall } = summarize(bugs, { productIds: ['58'] });
    const text = summaryToText(projects, overall, {
      at: '2026-11-05T10:30:00',
      exclude: ['张三'],
    });
    expect(text).toContain('合计 缺陷 2 · 已修复 1（50%）· 未修复 1 · 待验证 0 · 已关闭 1');
    expect(text).toContain('1. 项目 58');
    expect(text).toContain('模块 1 个：');
    expect(text).toContain('- 登录/密码登录：2 个（未修复 1、待验证 0）');
    expect(text).toContain('人员分布已排除（只看开发者）');
    expect(text).toContain('张三');
  });

  it('withModules=false 时不带模块明细', () => {
    const { projects, overall } = summarize(bugs, { productIds: ['58'] });
    const text = summaryToText(projects, overall, { withModules: false });
    expect(text).not.toContain('模块 1 个：');
  });

  it('projectToText 只含一个项目，标题项目数为 1', () => {
    const { projects } = summarize(bugs, { productIds: ['58'] });
    const text = projectToText(projects[0]);
    expect(text).toContain('1 个项目');
    expect(text).toContain('模块 1 个：');
  });
});

describe('bugSummary 人员分布', () => {
  const bugs = [
    bug('1', '58', 'active', '', 'a', 'lisi'),
    bug('2', '58', 'resolved', 'fixed', '', 'lisi'),
    bug('3', '58', 'active', '', 'a', 'wangwu'),
  ];

  it('按指派人聚合：总数 / 未修复 / 待验证 / 已修复，降序', () => {
    const { persons } = summarize(bugs, { productIds: ['58'] });
    expect(persons[0]).toMatchObject({ name: 'lisi', total: 2, active: 1, resolved: 1, fixed: 1, share: 66.7 });
    expect(persons[1]).toMatchObject({ name: 'wangwu', total: 1, active: 1, fixed: 0, share: 33.3 });
  });

  it('未关闭但没指派人的记「未指派」，等式成立', () => {
    const withNone = [...bugs, bug('4', '58', 'active', '', 'a', '')];
    const { persons, unassigned, overall } = summarize(withNone, { productIds: ['58'] });
    expect(unassigned).toBe(1);
    expect(persons.reduce((s, p) => s + p.total, 0) + unassigned).toBe(overall.total);
  });

  it('每个项目也有自己的指派分布与未指派', () => {
    const multi = [
      bug('1', '58', 'active', '', 'a', 'lisi'),
      bug('2', '59', 'active', '', 'a', 'wangwu'),
      bug('3', '59', 'active', '', 'a', ''),
    ];
    const { projects } = summarize(multi, { productIds: ['58', '59'] });
    expect(projects[0].persons.map(p => p.name)).toEqual(['lisi']);
    expect(projects[0].unassigned).toBe(0);
    expect(projects[1].persons.map(p => p.name)).toEqual(['wangwu']);
    expect(projects[1].unassigned).toBe(1);
  });

  it('排除某人只是把他从人员表里去掉，其他照旧', () => {
    const { persons, overall, skipped } = summarize(bugs, { productIds: ['58'], exclude: ['lisi'] });
    expect(persons.map(p => p.name)).toEqual(['wangwu']);
    expect(persons[0].total).toBe(1);
    expect(skipped).toBe(2); // lisi 名下的 2 条
    expect(overall.total).toBe(3); // 总数不受影响
  });
});

describe('bugSummary 人员分布文案', () => {
  const s = summarize(
    [
      bug('1', '58', 'active', '', 'a', '张三'),
      bug('2', '58', 'active', '', 'a', '张三'),
      bug('3', '58', 'active', '', 'a', '李四'),
      bug('4', '58', 'active', '', 'a', ''),
      bug('5', '58', 'closed', 'fixed', '', '张三'),
    ],
    { productIds: ['58'] },
  );

  it('就是「人员指派共 N 个：某某 X 个」这一行，并注明未指派 / 已关闭不计', () => {
    expect(personsToText(s.persons, { unassigned: s.unassigned, closedCount: s.overall.closed }))
      .toBe('人员指派共 3 个：张三 2 个、李四 1 个（未指派 1 个，已关闭 1 个不计）');
  });

  it('带上排除说明', () => {
    expect(personsToText([{
      name: '李四', total: 1, fixed: 0, active: 1, resolved: 0, closed: 0, other: 0, share: 100,
      recentNew: 1, recentFixed: 0,
    }], {
      exclude: ['张三', '李四'],
      skipped: 23,
    })).toBe('人员指派共 1 个：李四 1 个（已排除 张三、李四 名下 23 个）');
  });

  it('可以只取前 N 人（末尾补总人数）', () => {
    expect(personsToText(s.persons, { limit: 1 })).toBe('人员指派共 3 个：张三 2 个 等 2 人');
  });

  it('没有人时也不出空串', () => {
    expect(personsToText([], { unassigned: 5 })).toBe('人员指派共 0 个：暂无（未指派 5 个）');
    expect(personsToText([])).toBe('人员指派共 0 个：暂无');
  });

  it('复制汇总末尾会带这一行，单个项目也带自己的那一行', () => {
    const all = summaryToText(s.projects, s.overall, {
      persons: s.persons,
      unassigned: s.unassigned,
      skipped: s.skipped,
    });
    expect(all).toContain('人员指派共 3 个：张三 2 个、李四 1 个');

    const one = projectToText(s.projects[0]);
    expect(one).toContain('人员指派共 3 个：张三 2 个、李四 1 个');

    // withPersons=false 时这一段不出现（有些场合只要项目数字）
    const noPerson = summaryToText(s.projects, s.overall, { persons: s.persons, withPersons: false });
    expect(noPerson).not.toContain('人员指派共');
  });
});

describe('bugSummary 未关闭口径与近 7 天', () => {
  const now = new Date('2026-11-05T10:00:00');
  const bugs = [
    // 未关闭 + 已解决（算未关闭里的「已修复」）
    { ...bug('1', '58', 'resolved', 'fixed'), openedDate: '2026-11-03 09:00', resolvedDate: '2026-11-04 10:00' },
    // 未关闭 + 还在修
    { ...bug('2', '58', 'active'), openedDate: '2026-10-01 09:00' },
    // 已关闭（进不了未关闭分母）
    { ...bug('3', '58', 'closed', 'fixed'), openedDate: '2026-09-01 09:00', resolvedDate: '2026-09-10 09:00', closedDate: '2026-09-12 09:00' },
  ] as ZentaoBug[];

  it('未关闭修复率只拿未关闭的做分母', () => {
    const { overall } = summarize(bugs, { productIds: ['58'], now });
    expect(overall.total).toBe(3);
    expect(overall.open).toBe(2);
    expect(overall.fixedOpen).toBe(1);
    expect(overall.openRate).toBe(50);
    expect(overall.rate).toBe(66.7); // 全量口径仍是 2/3
  });

  it('近 7 天新增 / 修复按日期算（不含更早的）', () => {
    const { overall } = summarize(bugs, { productIds: ['58'], now });
    expect(overall.recentNew).toBe(1); // 只有 11-03 那条
    expect(overall.recentFixed).toBe(1); // 只有 11-04 那条
  });

  it('时间窗只统计窗口内提交的缺陷', () => {
    const { overall } = summarize(bugs, { productIds: ['58'], now, since: '2026-10-15' });
    expect(overall.total).toBe(1);
    expect(overall.active).toBe(0);
    expect(overall.resolved).toBe(1);
  });

  it('没写 openedDate 时退回 date 字段', () => {
    const { overall } = summarize([bug('9', '58', 'active')], { productIds: ['58'], now });
    expect(overall.recentNew).toBe(0); // bug() 的 date 是 undefined
  });

  it('daysAgoDay 返回本地日期', () => {
    expect(daysAgoDay(7, new Date('2026-11-05T10:00:00'))).toBe('2026-10-29');
    expect(daysAgoDay(0, new Date('2026-11-05T23:59:00'))).toBe('2026-11-05');
  });

  it('personOf：已关闭 / 空指派人都不算人名', () => {
    expect(personOf(bug('1', '58', 'active', '', 'a', 'lisi'))).toBe('lisi');
    expect(personOf(bug('2', '58', 'closed', '', 'a', 'lisi'))).toBe('');
    expect(personOf(bug('3', '58', 'active', '', 'a', ''))).toBe('');
    expect(personOf(bug('4', '58', 'active', '', 'a', 'closed'))).toBe('');
  });
});

describe('bugSummary 严重程度分布', () => {
  it('按 1→4 排序并给出中文标签', () => {
    const sev = severityRows({ '3': 5, '1': 2, '2': 0, '4': 1 });
    expect(sev).toEqual([
      { key: '1', label: '致命', count: 2 },
      { key: '3', label: '一般', count: 5 },
      { key: '4', label: '轻微', count: 1 },
    ]);
  });

  it('summarize 会按项目与全局统计 severity', () => {
    const bugs = [
      { ...bug('1', '58', 'active'), severity: '1' },
      { ...bug('2', '58', 'active'), severity: '3' },
      { ...bug('3', '59', 'active'), severity: '1' },
    ] as ZentaoBug[];
    const r = summarize(bugs, { productIds: ['58', '59'] });
    expect(r.severity).toEqual({ '1': 2, '3': 1 });
    expect(r.projects[0].severity).toEqual({ '1': 1, '3': 1 });
  });
});

describe('bugSummary 导出格式', () => {
  const s = summarize(
    [
      { ...bug('1', '58', 'active', '', 'zhangsan', 'lisi', '登录/密码'), severity: '2' },
      { ...bug('2', '58', 'closed', 'fixed', 'zhangsan', 'lisi', '登录/密码'), severity: '3' },
    ] as ZentaoBug[],
    { productIds: ['58'] },
  );

  it('Markdown 有项目表、模块表、人员表', () => {
    const md = summaryToMarkdown(s.projects, s.overall, {
      persons: s.persons, unassigned: s.unassigned, skipped: s.skipped, at: '2026-11-05T10:00:00',
    });
    expect(md).toContain('| 项目 | 缺陷 | 已修复 |');
    expect(md).toContain('| **合计** | **2** |');
    expect(md).toContain('**模块明细**');
    expect(md).toContain('| 登录/密码 |');
    expect(md).toContain('**人员分布（按当前指派人）**');
    expect(md).toContain('| 人员 | 指派 |');
  });

  it('withModules=false 时 Markdown 不带模块表', () => {
    const md = summaryToMarkdown(s.projects, s.overall, { withModules: false });
    expect(md).not.toContain('**模块明细**');
  });

  it('CSV 带 BOM、首行表头、合计行、人员段', () => {
    const csv = summaryToCsv(s.projects, s.overall, { persons: s.persons, unassigned: s.unassigned });
    expect(csv.startsWith('\ufeff')).toBe(true);
    expect(csv).toContain('项目,模块,缺陷,已修复,修复率%,未修复,待验证,已关闭');
    expect(csv).toContain('（全部）');
    expect(csv).toContain('合计');
    expect(csv).toContain('人员,指派,占比%');
  });

  it('CSV 的单元格会转义逗号和引号', () => {
    const p = { ...s.projects[0], name: '项目,"甲"' };
    const csv = summaryToCsv([p], s.overall, { withModules: false, withPersons: false });
    expect(csv).toContain('"项目,""甲"""');
  });

  it('summaryTo 按格式分发', () => {
    expect(summaryTo('text', s.projects, s.overall)).toContain('【缺陷汇总】');
    expect(summaryTo('markdown', s.projects, s.overall)).toContain('| 项目 |');
    expect(summaryTo('csv', s.projects, s.overall)).toContain('项目,模块');
  });
});

describe('bugSummary 统计日切分（默认 17:30）', () => {
  it('parseCutoff：正常/异常输入都能给出分钟数', () => {
    expect(parseCutoff('17:30')).toBe(17 * 60 + 30);
    expect(parseCutoff('00:00')).toBe(0);
    expect(parseCutoff('')).toBe(17 * 60 + 30);      // 空 → 默认
    expect(parseCutoff('abc')).toBe(17 * 60 + 30);   // 乱写 → 默认
    expect(fmtCutoff(parseCutoff('9:05'))).toBe('09:05');
  });

  it('17:30 之前算前一天，之后算当天', () => {
    const c = parseCutoff('17:30');
    expect(statDayOf('2026-11-05 17:29', c)).toBe('2026-11-04');
    expect(statDayOf('2026-11-05 17:30', c)).toBe('2026-11-05');
    expect(statDayOf('2026-11-05 23:59', c)).toBe('2026-11-05');
    expect(statDayOf('2026-11-06 00:10', c)).toBe('2026-11-05'); // 次日凌晨仍属前一天
    expect(statDayOf('2026-11-06 17:29', c)).toBe('2026-11-05');
    expect(statDayOf('2026-11-06 17:30', c)).toBe('2026-11-06');
  });

  it('只有日期（没有时分）时按当天算', () => {
    expect(statDayOf('2026-11-05', parseCutoff('17:30'))).toBe('2026-11-05');
    expect(statDayOf('', 0)).toBe('');
  });

  it('切分点可自定义：改成 09:00 后归属跟着变', () => {
    const c = parseCutoff('09:00');
    expect(statDayOf('2026-11-05 08:59', c)).toBe('2026-11-04');
    expect(statDayOf('2026-11-05 09:00', c)).toBe('2026-11-05');
  });

  it('dailyNew：今日 / 昨日 / 环比 / 序列', () => {
    const now = new Date('2026-11-05T15:00:00'); // 还没到 17:30 → 当前统计日是 11-04
    const mk = (id: string, t: string) => ({ ...bug(id, '58', 'active'), openedDate: t }) as ZentaoBug;
    const bugs = [
      mk('1', '2026-11-04 18:00'), // 统计日 11-04
      mk('2', '2026-11-05 09:00'), // 仍属 11-04（18:00 → 次日 17:30）
      mk('3', '2026-11-03 20:00'), // 11-03
      mk('4', '2026-11-03 21:00'), // 11-03
      mk('5', '2026-11-02 18:00'), // 11-02
    ];
    const d = dailyNew(bugs, { cutoff: '17:30', days: 4, now });
    expect(d.currentDay).toBe('2026-11-04');
    expect(d.today).toBe(2);
    expect(d.yesterday).toBe(2);
    expect(d.delta).toBe(0);
    expect(d.pct).toBe(0);
    expect(d.series.map(p => [p.day, p.count])).toEqual([
      ['2026-11-01', 0],
      ['2026-11-02', 1],
      ['2026-11-03', 2],
      ['2026-11-04', 2],
    ]);
    expect(d.avg).toBe(1); // 前 3 天 (0+1+2)/3
  });

  it('dailyNew：昨天为 0 时环比给 null（不除零）', () => {
    const now = new Date('2026-11-05T18:00:00'); // 已过 17:30 → 统计日 11-05
    const bugs = [{ ...bug('1', '58', 'active'), openedDate: '2026-11-05 18:30' }] as ZentaoBug[];
    const d = dailyNew(bugs, { cutoff: '17:30', days: 3, now });
    expect(d.currentDay).toBe('2026-11-05');
    expect(d.today).toBe(1);
    expect(d.yesterday).toBe(0);
    expect(d.delta).toBe(1);
    expect(d.pct).toBeNull();
  });

  it('dailyNew：没有提交时间的条目不参与', () => {
    const d = dailyNew([bug('1', '58', 'active')], { days: 3, now: new Date('2026-11-05T18:00:00') });
    expect(d.today).toBe(0);
    expect(d.series.every(p => p.count === 0)).toBe(true);
  });
});
