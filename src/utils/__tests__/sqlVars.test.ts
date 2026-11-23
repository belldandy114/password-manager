// SQL 片段「变量填充」的纯函数回归。
//
// 判据来自 docs/agents/sql-snippets-page.md §3「变量」一行 + §8 第一条后续建议：
//   - `{{名字}}` 才算变量，空值留空则保留原样（不把 SQL 改成 `... = 1` 这种残缺语句）
//   - 变量按**出现顺序去重**（弹窗里输入框的顺序要和 SQL 里读到的顺序一致）
//   - 「变量说明」字段（`{{orderNo}} = 订单号；{{today}} = 今天`）要能解析成输入框下的释义
//   - 变量 token 的形状必须与接口调试的 apiVars **一致**，否则同一个 `{{a-b}}` 在两边行为不同
import { describe, it, expect } from 'vitest';
import {
  extractVars, fillVars, parseVarHint,
  mergeVarHint, dateVarKind, dateVarValue,
  sanitizeVarName, wrapSelection, upsertVarHint,
} from '../sqlVars';
import { applyVars } from '../apiVars';

describe('SQL 变量：提取', () => {
  it('按出现顺序返回变量名（select *from {{table}} where {{id}}=1 → table, id）', () => {
    expect(extractVars('select *from {{table}} where {{id}}=1')).toEqual(['table', 'id']);
  });

  it('重复出现的变量只算一个，顺序按首次出现', () => {
    expect(extractVars('{{b}} {{a}} {{b}} {{a}}')).toEqual(['b', 'a']);
  });

  it('不是 {{名字}} 的形态都不算变量（空花括号 / 中文名 / 单花括号）', () => {
    expect(extractVars('{{}} { {x} } {{中文名}} {{  }}')).toEqual([]);
  });

  it('允许两侧空格与点、横线、下划线', () => {
    expect(extractVars('{{ table }} {{a-b}} {{c.d}} {{e_f}}')).toEqual(['table', 'a-b', 'c.d', 'e_f']);
  });

  it('正文为空 / null 时返回空数组，不抛错', () => {
    expect(extractVars('')).toEqual([]);
    expect(extractVars(undefined as unknown as string)).toEqual([]);
  });
});

describe('SQL 变量：替换', () => {
  it('全部出现处都替换（同一变量出现两次都换）', () => {
    expect(fillVars('{{a}} + {{a}}', { a: '1' })).toBe('1 + 1');
  });

  it('留空 / 未填的变量保留原样（含两侧空格），不产出残缺 SQL', () => {
    const sql = 'select *from {{table}} where {{ id }}={{id}}';
    expect(fillVars(sql, { table: '33', id: '' })).toBe('select *from 33 where {{ id }}={{id}}');
    expect(fillVars(sql, {})).toBe(sql);
  });

  it('值里带 {{ }} 不会被二次替换（单遍替换）', () => {
    expect(fillVars('{{a}} {{b}}', { a: '{{b}}', b: 'X' })).toBe('{{b}} X');
  });

  it('值里的引号 / 分号 / 换行原样写入（SQL 由使用者负责转义）', () => {
    expect(fillVars('{{v}}', { v: "O'Reilly; --" })).toBe("O'Reilly; --");
  });
});

describe('SQL 变量：变量说明解析', () => {
  it('解析「{{名字}} = 说明」，支持全角冒号、顿号/分号/换行分隔', () => {
    const hint = '{{orderNo}} = 订单号；{{today}}：今天\n{{table}}=表名';
    expect(parseVarHint(hint)).toEqual({ orderNo: '订单号', today: '今天', table: '表名' });
  });

  it('没有 = / 冒号的行、非法 token、空说明都忽略', () => {
    expect(parseVarHint('随便写点什么\n{{a}}\n{{b}} =\n{{c}} = 有说明'))
      .toEqual({ c: '有说明' });
  });

  it('空 / null 输入返回空对象', () => {
    expect(parseVarHint('')).toEqual({});
    expect(parseVarHint(undefined as unknown as string)).toEqual({});
  });
});

describe('SQL 变量：与接口调试同一套 token 规则（防两套规则漂移）', () => {
  it('同一个 token 在 fillVars 与 applyVars 里都被认出来', () => {
    const text = 'a={{a-b}} b={{c.d}} c={{e_f}} d={{表名}}';
    const names = extractVars(text);
    expect(names).toEqual(['a-b', 'c.d', 'e_f']);
    // apiVars 的口径是「KEY=VALUE 每行一个」，这里只验 token 形状一致
    expect(applyVars(text, 'a-b=1\nc.d=2\ne_f=3')).toBe('a=1 b=2 c=3 d={{表名}}');
  });
});

/* ==================================================================
   第二批（docs/agents/sql-copy-vars-next.md §3.A / §3.B）
   ================================================================== */

describe('SQL 变量：说明一键生成（mergeVarHint）', () => {
  it('已有释义原样保留，缺的按正文顺序追加「{{name}} = 」，全角分号分隔', () => {
    const hint = '{{id}} = 主键';
    const merged = mergeVarHint(hint, ['t', 'id']);
    expect(merged).toBe('{{id}} = 主键；{{t}} = ');
    // 已有释义没被改：解析结果里 id 还是「主键」，且原文一字不改地作为前缀
    expect(parseVarHint(merged)).toEqual({ id: '主键' });
    expect(merged.startsWith(hint)).toBe(true);
  });

  it('已有释义一个字都不改（全角冒号 / 换行 / 前后空白都保留）', () => {
    const hint = '  {{a}}：甲\n{{b}} = 乙  ';
    expect(mergeVarHint(hint, ['a', 'b', 'c'])).toBe(`${hint}；{{c}} = `);
  });

  it('幂等：连点两次文本完全不变', () => {
    const once = mergeVarHint('{{id}} = 主键', ['t', 'id']);
    expect(mergeVarHint(once, ['t', 'id'])).toBe(once);
    const fromEmpty = mergeVarHint('', ['a', 'b']);
    expect(mergeVarHint(fromEmpty, ['a', 'b'])).toBe(fromEmpty);
  });

  it('说明为空 / 全空白：不加前导分号，也不残留空白', () => {
    expect(mergeVarHint('', ['a', 'b'])).toBe('{{a}} = ；{{b}} = ');
    expect(mergeVarHint('   ', ['a', 'b'])).toBe('{{a}} = ；{{b}} = ');
  });

  it('末尾已有分隔符：不再补一个「；」；末尾空白不改写', () => {
    expect(mergeVarHint('{{a}} = A；', ['b'])).toBe('{{a}} = A；{{b}} = ');
    expect(mergeVarHint('{{a}} = A；  ', ['b'])).toBe('{{a}} = A；  {{b}} = ');
  });

  it('没有变量：返回原文（不 trim、不动空白）', () => {
    expect(mergeVarHint('  {{id}} = 主键  ', [])).toBe('  {{id}} = 主键  ');
    expect(mergeVarHint('随便写点什么', undefined as unknown as string[])).toBe('随便写点什么');
  });

  it('裸 token（无释义）也算「已提到」：跳过，不产出重复条目', () => {
    // 队长裁定（§8）：判据 = extractVars(hint) 出现过就跳过
    expect(mergeVarHint('{{t}}', ['t'])).toBe('{{t}}');
    expect(mergeVarHint('{{t}}', ['t', 'id'])).toBe('{{t}}；{{id}} = ');
  });

  it('空 / null 说明都能处理，不抛错', () => {
    expect(mergeVarHint(undefined as unknown as string, ['a'])).toBe('{{a}} = ');
  });
});

describe('SQL 变量：常用日期变量（dateVarKind / dateVarValue）', () => {
  /** 2026-03-01 09:05:06 本地时间（跨月用例的锚点） */
  const FIXED = new Date(2026, 2, 1, 9, 5, 6);

  it('识别：today / now / today±Nd；其它一律不猜', () => {
    expect(dateVarKind('today')).toBe('date');
    expect(dateVarKind('now')).toBe('datetime');
    expect(dateVarKind('today-7d')).toBe('date');
    expect(dateVarKind('today+1d')).toBe('date');
    expect(dateVarKind('today+0d')).toBe('date');
    for (const name of ['TODAY', 'Today', 'tody', 'today-d', 'today+1', 'now-1d', 'today+1w', '', '  ']) {
      expect(dateVarKind(name)).toBeNull();
    }
    expect(dateVarKind(undefined as unknown as string)).toBeNull();
  });

  it('固定 now=2026-03-01 09:05:06：today / now / today-7d / today+1d', () => {
    expect(dateVarValue('today', FIXED)).toBe('2026-03-01');
    expect(dateVarValue('now', FIXED)).toBe('2026-03-01 09:05:06');
    expect(dateVarValue('today-7d', FIXED)).toBe('2026-02-22');
    expect(dateVarValue('today+1d', FIXED)).toBe('2026-03-02');
    expect(dateVarValue('today+0d', FIXED)).toBe('2026-03-01');
    expect(dateVarValue('orderNo', FIXED)).toBe('');
  });

  it('跨月 / 跨年：1 月 1 日往前一天回到去年 12 月 31 日', () => {
    const jan1 = new Date(2026, 0, 1, 0, 0, 0);
    expect(dateVarValue('today-1d', jan1)).toBe('2025-12-31');
    expect(dateVarValue('today+31d', jan1)).toBe('2026-02-01');
  });

  it('闰年：2028-03-01 往前一天是 2 月 29 日', () => {
    expect(dateVarValue('today-1d', new Date(2028, 2, 1, 12, 0, 0))).toBe('2028-02-29');
  });

  it('本地时区：不按 UTC 取日期（toISOString 会差一天）', () => {
    // 东半球用本地 00:30、西半球用本地 23:30 —— 两边都必须与 UTC 日期不同
    const west = FIXED.getTimezoneOffset() > 0;
    const d = new Date(2026, 2, 1, west ? 23 : 0, 30, 0);
    expect(dateVarValue('today', d)).toBe('2026-03-01');
    if (d.getTimezoneOffset() !== 0) {
      // 反证：这条断言只有在「确实没用 toISOString().slice(0,10)」时才成立
      expect(d.toISOString().slice(0, 10)).not.toBe('2026-03-01');
    }
  });

  it('补零：2026-01-05 07:08:09 的 now 形式', () => {
    expect(dateVarValue('now', new Date(2026, 0, 5, 7, 8, 9))).toBe('2026-01-05 07:08:09');
  });

  it('坏入参：Invalid Date 与不认识的变量都返回空串', () => {
    expect(dateVarValue('today', new Date('bad'))).toBe('');
    expect(dateVarValue('now', new Date('bad'))).toBe('');
    expect(dateVarValue('', FIXED)).toBe('');
  });
});

/* ==================================================================
   选中一段文字 → 变成 {{变量}}（第三批：编辑弹窗「转化为变量」）
   判据：用户给的流程 —— 选中 → 点按钮 → 弹窗填名称/说明 → 确定后
   ① SQL 里那段被 {{名字}} 替换；② 变量说明里出现 `{{名字}} = 说明`。
   ================================================================== */

describe('SQL 变量：选中文字转变量', () => {
  it('sanitizeVarName：非法字符折成一个下划线，首尾下划线去掉', () => {
    expect(sanitizeVarName('id')).toBe('id');
    expect(sanitizeVarName('  orderId  ')).toBe('orderId');
    expect(sanitizeVarName('order id')).toBe('order_id');
    expect(sanitizeVarName('id = 1')).toBe('id_1');
    expect(sanitizeVarName('id;')).toBe('id');
    expect(sanitizeVarName('{{id}}')).toBe('id');
    expect(sanitizeVarName('a-b.c_d')).toBe('a-b.c_d');
  });

  it('sanitizeVarName：纯中文 / 纯符号 → 空串（要求用户自己起名，不瞎猜）', () => {
    expect(sanitizeVarName('中文')).toBe('');
    expect(sanitizeVarName('***')).toBe('');
    expect(sanitizeVarName('')).toBe('');
    expect(sanitizeVarName(undefined as unknown as string)).toBe('');
  });

  it('wrapSelection：只替换选中的那一段，光标落在插入的 token 之后', () => {
    const sql = 'select * from t_order where id = 1';
    const start = sql.indexOf('id = 1');
    const r = wrapSelection(sql, start, start + 2, 'orderId');
    expect(r).not.toBeNull();
    expect(r!.text).toBe('select * from t_order where {{orderId}} = 1');
    expect(r!.caret).toBe(start + '{{orderId}}'.length);
  });

  it('wrapSelection：选中的是整段表达式时整段被包起来', () => {
    const sql = "where created_at >= '2026-01-01'";
    const s = sql.indexOf("'2026-01-01'");
    const r = wrapSelection(sql, s, s + "'2026-01-01'".length, 'from');
    expect(r!.text).toBe('where created_at >= {{from}}');
  });

  it('wrapSelection：空选区 / 越界 / 反向选区一律返回 null（不改文本）', () => {
    expect(wrapSelection('select 1', 3, 3, 'x')).toBeNull();
    expect(wrapSelection('select 1', 5, 2, 'x')).toBeNull();
    expect(wrapSelection('select 1', -1, 2, 'x')).toBeNull();
    expect(wrapSelection('select 1', 0, 99, 'x')).toBeNull();
    expect(wrapSelection('select 1', 0, 2, '')).toBeNull();
  });

  it('upsertVarHint：说明为空时追加 `{{名字}} = `，已有条目原样保留', () => {
    expect(upsertVarHint('', 'table', '表名')).toBe('{{table}} = 表名');
    expect(upsertVarHint('{{id}} = 主键', 'table', '表名')).toBe('{{id}} = 主键；{{table}} = 表名');
    expect(upsertVarHint('{{id}} = 主键', 'table', '')).toBe('{{id}} = 主键；{{table}} = ');
  });

  it('upsertVarHint：同名时改释义而不是重复追加（含裸 token 升级）', () => {
    expect(upsertVarHint('{{id}} = 主键', 'id', '订单主键')).toBe('{{id}} = 订单主键');
    expect(upsertVarHint('{{id}}', 'id', '主键')).toBe('{{id}} = 主键');
    expect(upsertVarHint('{{id}}：旧释义', 'id', '新释义')).toBe('{{id}}：新释义');
  });

  it('upsertVarHint：同名但说明留空 → 不动已有释义（不把用户写的擦掉）', () => {
    expect(upsertVarHint('{{id}} = 主键', 'id', '')).toBe('{{id}} = 主键');
  });

  it('upsertVarHint：别的条目（含换行 / 全角分号）逐字保留', () => {
    const hint = '{{a}} = A\n{{b}} = B；{{c}} = C';
    expect(upsertVarHint(hint, 'b', 'BB')).toBe('{{a}} = A\n{{b}} = BB；{{c}} = C');
    expect(upsertVarHint(hint, 'd', 'D')).toBe(`${hint}；{{d}} = D`);
  });
});

