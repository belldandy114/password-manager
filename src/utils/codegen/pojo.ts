/**
 * 1.3 JSON 响应体 → Java POJO（Lombok）（契约 §3.5 / [C-94]–[C-96]）。
 *
 * 纯函数：JSON 文本进、Java 源码出；不读文件、不碰 IPC、不含时间戳/随机数（[C-85]）。
 *
 * 几条**写死**的口径（实现前定的，不是实现时顺手决定的）：
 *
 * 1. **整数一律 `Long`**（[C-94]）。任务书里问过「Integer/Long 按取值范围选，写明阈值」——
 *    契约 v6 把这一条写死成 `Long`，所以**没有阈值**：全部 Long。理由是可复现：同一个字段
 *    这次采样到 5、下次采样到 5_000_000_000，若按阈值推断就会生成两种类型，golden 天天变红。
 *    Integer 的溢出与 null 安全问题由包装类型 Long 一并解决。
 * 2. **小数默认 `BigDecimal`**，`useBigDecimal:false` 时才用 `Double`（[C-94]）。取舍：
 *    BigDecimal 不丢精度（金额/汇率），代价是不能直接和字面量比大小；接口里明确是浮点
 *    测量值（耗时、百分比）时给调用方留了 Double 的口子。
 * 3. **`null` → `Object`**（[C-94]），并压一条告警：全 null 的字段无法判断真实类型，
 *    猜一个（比如 String）会让后续赋值静默失败。
 * 4. **同名字段多类型 → 按 `Long < BigDecimal < Double < String < Object` 取最宽**（[C-95]）。
 *    这决定了 `{"code": 200}` 与 `{"code":"OK"}` 混用时的结果是 `String` 而不是 `Object`：
 *    能把数字读成字符串，反过来不行。该决定在 golden `json-type-conflict` 里逐字体现。
 * 5. **嵌套对象 → 同文件静态内部类**（不是独立文件）。理由：一个响应体对应一个类，拆成多文件
 *    会让「另存为」变成多选文件；静态内部类保持单文件、单次保存。
 * 6. `snake_case` 的 JSON 键 → Java `camelCase` 字段 + `@JsonProperty("<原名>")`（[C-96]）。
 *    **只做这一条注解**：不做 `@JsonIgnoreProperties` / `@JsonFormat` / `@NotNull` 之类的
 *    通用 Jackson 映射与校验注解（任务书明确不做；字段名改了不加注解就取不到值，属必需项）。
 * 7. 日期字符串保持 `String`：契约 [C-94] 的类型表里没有 `LocalDate`，不擅自映射。
 *
 * 依赖方向：[C-107] 允许 `pojo.ts → escape.ts`，反向禁止。
 */

import {
  javaIdentifier, javaString, pascalCase, camelCase,
  type GenOk, type GenFail,
} from './escape';

export interface PojoInput {
  /** 必填，根类名（会经 pascalCase + javaIdentifier 归一） */
  rootName: string;
  /** 缺省 `model`（归一成合法包名） */
  packageName?: string;
  /** 必填，JSON 文本 */
  json: string;
  /** 必填：true → 类上 `@Data`；false → 生成 getter/setter（[C-96]，两种都有 golden） */
  lombok: boolean;
  /** 缺省 true：小数用 BigDecimal；false 用 Double */
  useBigDecimal?: boolean;
  /** 本批只接受 'java'（[C-82]） */
  lang?: 'java';
}

/* ================================================================
   内部类型模型
   ================================================================ */

type ScalarKind = 'long' | 'decimal' | 'double' | 'boolean' | 'string' | 'object';

type Shape =
  | { kind: 'scalar'; scalar: ScalarKind }
  | { kind: 'list'; elem: Shape }
  | { kind: 'class'; fields: Map<string, Shape> };

/** [C-95] 的兼容序：数值 → 字符串 → Object，取最宽；boolean 不在序里（见 mergeShapes） */
const WIDEN_RANK: Record<ScalarKind, number> = {
  long: 0,
  decimal: 1,
  double: 2,
  string: 3,
  boolean: -1,
  object: 9,
};

const TYPE_LABEL: Record<ScalarKind, string> = {
  long: 'Long',
  decimal: 'BigDecimal',
  double: 'Double',
  boolean: 'Boolean',
  string: 'String',
  object: 'Object',
};

interface Ctx {
  warnings: string[];
  useBigDecimal: boolean;
}

/* ================================================================
   推断（[C-94]）+ 合并（[C-95]）
   ================================================================ */

function inferValue(v: unknown, path: string, ctx: Ctx): Shape {
  if (v === null || v === undefined) {
    ctx.warnings.push(`字段 ${path} 全为 null，推断为 Object`);
    return { kind: 'scalar', scalar: 'object' };
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { kind: 'scalar', scalar: 'long' };
    return { kind: 'scalar', scalar: ctx.useBigDecimal ? 'decimal' : 'double' };
  }
  if (typeof v === 'boolean') return { kind: 'scalar', scalar: 'boolean' };
  if (typeof v === 'string') return { kind: 'scalar', scalar: 'string' };
  if (Array.isArray(v)) {
    if (!v.length) return { kind: 'list', elem: { kind: 'scalar', scalar: 'object' } };
    let elem = inferValue(v[0], `${path}[]`, ctx);
    for (let i = 1; i < v.length; i++) {
      elem = mergeShapes(elem, inferValue(v[i], `${path}[]`, ctx), `${path}[]`, ctx);
    }
    return { kind: 'list', elem };
  }
  const fields = new Map<string, Shape>();
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    fields.set(k, inferValue(val, path ? `${path}.${k}` : k, ctx));
  }
  return { kind: 'class', fields };
}

function mergeShapes(a: Shape, b: Shape, path: string, ctx: Ctx): Shape {
  if (a.kind === 'class' && b.kind === 'class') {
    const fields = new Map(a.fields);
    for (const [k, shape] of b.fields) {
      const prev = fields.get(k);
      fields.set(k, prev ? mergeShapes(prev, shape, path ? `${path}.${k}` : k, ctx) : shape);
    }
    return { kind: 'class', fields };
  }
  if (a.kind === 'list' && b.kind === 'list') {
    return { kind: 'list', elem: mergeShapes(a.elem, b.elem, `${path}[]`, ctx) };
  }
  if (a.kind !== 'scalar' || b.kind !== 'scalar') {
    // 同一键一处数组、一处标量（或对象）：没有合法 Java 类型能同时装下
    ctx.warnings.push(`字段 ${path} 出现多种类型（${labelOf(a)}/${labelOf(b)}），已合并为 Object`);
    return { kind: 'scalar', scalar: 'object' };
  }
  if (a.scalar === b.scalar) return a;
  if (a.scalar === 'boolean' || b.scalar === 'boolean') {
    // boolean 与任何其它标量都不兼容（布尔不是「更窄的数字」）
    ctx.warnings.push(
      `字段 ${path} 出现多种类型（${TYPE_LABEL[a.scalar]}/${TYPE_LABEL[b.scalar]}），已合并为 Object`,
    );
    return { kind: 'scalar', scalar: 'object' };
  }
  const wider = WIDEN_RANK[a.scalar] >= WIDEN_RANK[b.scalar] ? a.scalar : b.scalar;
  ctx.warnings.push(
    `字段 ${path} 出现多种类型（${TYPE_LABEL[a.scalar]}/${TYPE_LABEL[b.scalar]}），已合并为 ${TYPE_LABEL[wider]}`,
  );
  return { kind: 'scalar', scalar: wider };
}

function labelOf(s: Shape): string {
  if (s.kind === 'list') return `List<${labelOf(s.elem)}>`;
  if (s.kind === 'class') return 'Object';
  return TYPE_LABEL[s.scalar];
}

/* ================================================================
   类计划：命名 + 冲突改写（[C-95]）
   ================================================================ */

interface FieldPlan {
  /** JSON 里的原始键名 */
  key: string;
  /** Java 字段名 */
  javaName: string;
  shape: Shape;
  /** 名字被改写过 → 需要 @JsonProperty([C-96]) */
  renamed: boolean;
}

interface ClassPlan {
  name: string;
  fields: FieldPlan[];
  children: ClassPlan[];
}

interface PlanCtx extends Ctx {
  used: Set<string>;
  /** Shape（对象引用）→ 类计划；同一 Shape 只对应一个类 */
  byShape: Map<Shape, ClassPlan>;
}

function planClasses(shape: Shape, wantedName: string, p: PlanCtx): ClassPlan {
  let name = wantedName;
  if (p.used.has(name)) {
    let n = 2;
    while (p.used.has(`${wantedName}${n}`)) n++;
    const fixed = `${wantedName}${n}`;
    p.warnings.push(`嵌套类命名冲突：${wantedName}，已改为 ${fixed}`);
    name = fixed;
  }
  p.used.add(name);

  const plan: ClassPlan = { name, fields: [], children: [] };
  p.byShape.set(shape, plan);
  if (shape.kind !== 'class') return plan;

  for (const [key, fieldShape] of shape.fields) {
    const javaName = javaIdentifier(camelCase(key), 'field');
    const renamed = javaName !== key;
    if (renamed) p.warnings.push(`字段名被改为合法 Java 标识符：${key} → ${javaName}`);
    plan.fields.push({ key, javaName, shape: fieldShape, renamed });

    const nested = fieldShape.kind === 'class'
      ? fieldShape
      : fieldShape.kind === 'list' && fieldShape.elem.kind === 'class'
        ? fieldShape.elem
        : null;
    if (nested) plan.children.push(planClasses(nested, name + pascalCase(key), p));
  }
  return plan;
}

function javaTypeOf(shape: Shape, byShape: Map<Shape, ClassPlan>): string {
  if (shape.kind === 'list') return `List<${javaTypeOf(shape.elem, byShape)}>`;
  if (shape.kind === 'class') return byShape.get(shape)?.name ?? 'Object';
  return TYPE_LABEL[shape.scalar];
}

/* ================================================================
   输出（LF + 恰好一个末尾换行 + 无行尾空格，[C-102]）
   ================================================================ */

function getterFor(name: string, type: string): string[] {
  const cap = name[0].toUpperCase() + name.slice(1);
  return [`    public ${type} get${cap}() {`, `        return ${name};`, '    }'];
}

function setterFor(name: string, type: string): string[] {
  const cap = name[0].toUpperCase() + name.slice(1);
  return [`    public void set${cap}(${type} ${name}) {`, `        this.${name} = ${name};`, '    }'];
}

function emitClass(plan: ClassPlan, indent: string, lombok: boolean, byShape: Map<Shape, ClassPlan>, isRoot: boolean): string[] {
  const header: string[] = [];
  if (lombok) header.push(`${indent}@Data`);
  header.push(`${indent}public ${isRoot ? '' : 'static '}class ${plan.name} {`);

  // 成员按「块」组装：字段块 / 每个字段的 getter+setter 块 / 每个子类块；块之间空一行，
  // 类末尾不留空行（`{` 之后紧跟 `}` 的空类是合法且干净的写法）。
  const blocks: string[][] = [];

  if (plan.fields.length) {
    const fieldBlock: string[] = [];
    for (const f of plan.fields) {
      if (f.renamed) fieldBlock.push(`${indent}    @JsonProperty(${javaString(f.key)})`);
      fieldBlock.push(`${indent}    private ${javaTypeOf(f.shape, byShape)} ${f.javaName};`);
    }
    blocks.push(fieldBlock);
  }

  if (!lombok) {
    for (const f of plan.fields) {
      const type = javaTypeOf(f.shape, byShape);
      blocks.push([...getterFor(f.javaName, type), ...setterFor(f.javaName, type)]);
    }
  }

  for (const child of plan.children) {
    blocks.push(emitClass(child, indent + '    ', lombok, byShape, false));
  }

  const lines = [...header];
  blocks.forEach((block, i) => {
    if (i > 0) lines.push('');
    lines.push(...block);
  });
  lines.push(`${indent}}`);
  return lines;
}

/** package 名：允许 `a.b` 形式，逐段归一后再拼；缺省 model */
function normalizePackage(packageName: string | undefined): string {
  const raw = String(packageName ?? '').trim() || 'model';
  const segs = raw.split('.').map((seg) => {
    const s = javaIdentifier(seg.toLowerCase(), 'pkg');
    return s.startsWith('$') ? '_' + s.slice(1) : s;
  });
  return segs.filter(Boolean).join('.') || 'model';
}

/* ================================================================
   入口
   ================================================================ */

export function generatePojo(input: PojoInput): GenOk | GenFail {
  if (input.lang && input.lang !== 'java') {
    return { ok: false, error: '暂只支持 Java（lang=java）' };
  }
  const raw = String(input.json ?? '').trim();
  if (!raw) return { ok: false, error: 'JSON 为空：粘贴一段响应体再生成' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, error: '根节点必须是对象或数组：标量（数字 / 字符串 / 布尔）无法生成 POJO' };
  }

  const ctx: PlanCtx = {
    warnings: [],
    useBigDecimal: input.useBigDecimal !== false,
    used: new Set<string>(),
    byShape: new Map(),
  };

  let rootShape: Shape;
  if (Array.isArray(parsed)) {
    if (!parsed.length) return { ok: false, error: '根节点是空数组：无法推断元素结构' };
    ctx.warnings.push('根节点是数组，已按元素合并结果推断结构');
    rootShape = inferValue(parsed[0], '[]', ctx);
    for (let i = 1; i < parsed.length; i++) {
      rootShape = mergeShapes(rootShape, inferValue(parsed[i], '[]', ctx), '[]', ctx);
    }
  } else {
    rootShape = inferValue(parsed, '', ctx);
  }

  const rootName = javaIdentifier(pascalCase(input.rootName), 'Root');
  const rootPlan = planClasses(rootShape, rootName, ctx);
  const body = emitClass(rootPlan, '', input.lombok, ctx.byShape, true);

  const needsJson = body.some(l => l.includes('@JsonProperty'));
  const needsBigDecimal = body.some(l => l.includes('private BigDecimal '));
  const needsList = body.some(l => l.includes('List<'));

  const out: string[] = [`package ${normalizePackage(input.packageName)};`, ''];
  const imports: string[] = [];
  if (needsJson) imports.push('import com.fasterxml.jackson.annotation.JsonProperty;');
  if (needsBigDecimal) imports.push('import java.math.BigDecimal;');
  if (needsList) imports.push('import java.util.List;');
  if (imports.length) out.push(...imports, '');
  out.push(...body);

  const content = out.map(l => l.replace(/[ \t]+$/, '')).join('\n') + '\n';
  return {
    ok: true,
    files: [{ path: `${rootPlan.name}.java`, content }],
    warnings: ctx.warnings,
  };
}