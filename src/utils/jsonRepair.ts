// ================================================================
// JSON 修复引擎 — 5 阶段管道
// 1. 预处理 → 2. 结构推断(可选) → 3. Tokenizer → 4. Fixer → 5. 验证 + 格式化
// ================================================================

// ---- 配置 ----
export interface JsonRepairOptions {
  fixSingleQuote: boolean;    // 单引号 → 双引号
  fixUnquotedKeys: boolean;   // 无引号键名 → 双引号
  removeComments: boolean;    // 移除注释
  trailingComma: 'remove' | 'keep' | 'error';
  missingComma: boolean;      // 自动补全缺失逗号
  closeBrackets: boolean;     // 自动补全缺失括号
  inferStructure: boolean;    // 非 JSON → 尝试推断
  maxDepth: number;           // 最大嵌套深度
  formatMode: 'beautify' | 'minify';
  indentSize: number;         // 缩进空格数
  sortKeys: boolean;          // 是否按键排序
}

const DEFAULTS: JsonRepairOptions = {
  fixSingleQuote: true,
  fixUnquotedKeys: true,
  removeComments: true,
  trailingComma: 'remove',
  missingComma: false,
  closeBrackets: true,
  inferStructure: true,
  maxDepth: 100,
  formatMode: 'beautify',
  indentSize: 2,
  sortKeys: false,
};

// ---- 结果类型 ----
export interface RepairResult {
  success: boolean;
  json?: string;
  error?: {
    type: string;
    message: string;
    position: number;
    suggestion: string;
    quickFix?: string;
  };
  warnings: { type: string; message: string; position?: number }[];
  diff?: { offset: number; original: string; fixed: string }[];
}

// ---- Token 类型 ----
type TokenType =
  | 'LBRACE' | 'RBRACE' | 'LBRACKET' | 'RBRACKET'
  | 'COMMA' | 'COLON'
  | 'STRING_DOUBLE' | 'STRING_SINGLE'
  | 'UNQUOTED_STRING'
  | 'NUMBER'
  | 'KEYWORD'      // true / false / null
  | 'COMMENT_LINE'
  | 'COMMENT_BLOCK'
  | 'EOF';

interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

// ================================================================
// 1. 预处理
// ================================================================
function preprocess(input: string): string {
  let s = input;

  // 移除 BOM
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);

  // 移除零宽字符
  s = s.replace(/[\u200B-\u200D\uFEFF]/g, '');

  // 不可打印控制符（保留 \n \t \r 等合法转义）
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, (c) =>
    '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );

  // 全角符号转换
  s = s.replace(/，/g, ',').replace(/：/g, ':');
  s = s.replace(/“/g, '"').replace(/”/g, '"');
  s = s.replace(/‘/g, "'").replace(/’/g, "'");
  s = s.replace(/｛/g, '{').replace(/｝/g, '}');
  s = s.replace(/\[/g, '[').replace(/］/g, ']');

  // 统一换行
  s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  return s;
}

// ================================================================
// 2. 结构推断（默认启用）
// ================================================================
function inferStructure(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return input;

  // JSON 片段: "key": value 或 'key': value（无外层 {}）
  if (
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    /^["']\w+["']\s*:/.test(trimmed)
  ) {
    return `{${trimmed}}`;
  }

  // URL 参数风格: a=1&b=2
  if (/^[\w.%-]+=[\w.%-]+(&[\w.%-]+=[\w.%-]+)*$/.test(trimmed)) {
    const obj: Record<string, string> = {};
    trimmed.split('&').forEach(pair => {
      const [k, v] = pair.split('=');
      obj[decodeURIComponent(k)] = decodeURIComponent(v || '');
    });
    return JSON.stringify(obj);
  }

  // 赋值式: key=value, key = value（多行或单行）
  if (/^[\w.%-]+\s*=/.test(trimmed) && !trimmed.includes('&')) {
    const obj: Record<string, string> = {};
    trimmed.split('\n').forEach(line => {
      if (!line.trim()) return;
      const idx = line.indexOf('=');
      if (idx > 0) {
        obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });
    if (Object.keys(obj).length > 0) return JSON.stringify(obj);
  }

  // 多行键值对: key: value / key:value
  if (/^[\w\s-]+:/.test(trimmed)) {
    const obj: Record<string, string> = {};
    trimmed.split('\n').forEach(line => {
      if (!line.trim()) return;
      const idx = line.indexOf(':');
      if (idx > 0) {
        obj[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
      }
    });
    if (Object.keys(obj).length > 0) return JSON.stringify(obj);
  }

  // 单行无引号键值: key value（仅一个值）
  if (/^[\w.%-]+\s+[^\s]/.test(trimmed) && !trimmed.includes('\n')) {
    const parts = trimmed.split(/\s+/);
    if (parts.length === 2) {
      return JSON.stringify({ [parts[0]]: parts[1] });
    }
  }

  // 兜底：不加推断，原样返回
  return trimmed;
}

// ================================================================
// 3. Tokenizer（宽松词法分析）
// ================================================================
function tokenize(input: string): { tokens: Token[]; warnings: RepairResult['warnings'] } {
  const tokens: Token[] = [];
  const warnings: RepairResult['warnings'] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];

    // 结构符号
    if (ch === '{') { tokens.push({ type: 'LBRACE', value: '{', pos: i }); i++; continue; }
    if (ch === '}') { tokens.push({ type: 'RBRACE', value: '}', pos: i }); i++; continue; }
    if (ch === '[') { tokens.push({ type: 'LBRACKET', value: '[', pos: i }); i++; continue; }
    if (ch === ']') { tokens.push({ type: 'RBRACKET', value: ']', pos: i }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'COMMA', value: ',', pos: i }); i++; continue; }
    if (ch === ':') { tokens.push({ type: 'COLON', value: ':', pos: i }); i++; continue; }

    // 双引号字符串
    if (ch === '"') {
      let j = i + 1;
      let escaped = false;
      while (j < len) {
        if (escaped) { escaped = false; j++; continue; }
        if (input[j] === '\\') { escaped = true; j++; continue; }
        if (input[j] === '"') { j++; break; }
        j++;
      }
      tokens.push({ type: 'STRING_DOUBLE', value: input.slice(i, j), pos: i });
      if (j >= len) warnings.push({ type: 'UNCLOSED_STRING', message: `双引号字符串未闭合 (位置 ${i})`, position: i });
      i = j;
      continue;
    }

    // 单引号字符串
    if (ch === "'") {
      let j = i + 1;
      let escaped = false;
      while (j < len) {
        if (escaped) { escaped = false; j++; continue; }
        if (input[j] === '\\') { escaped = true; j++; continue; }
        if (input[j] === "'") { j++; break; }
        j++;
      }
      tokens.push({ type: 'STRING_SINGLE', value: input.slice(i, j), pos: i });
      if (j >= len) warnings.push({ type: 'UNCLOSED_STRING', message: `单引号字符串未闭合 (位置 ${i})`, position: i });
      i = j;
      continue;
    }

    // 行注释 //
    if (ch === '/' && input[i + 1] === '/') {
      let j = i + 2;
      while (j < len && input[j] !== '\n') j++;
      tokens.push({ type: 'COMMENT_LINE', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // 块注释 /* */
    if (ch === '/' && input[i + 1] === '*') {
      let j = i + 2;
      while (j < len - 1 && !(input[j] === '*' && input[j + 1] === '/')) j++;
      if (j < len - 1) j += 2;
      tokens.push({ type: 'COMMENT_BLOCK', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // 数字
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(input[i + 1]))) {
      let j = i + 1;
      while (j < len && /[0-9.eE+\-]/.test(input[j])) j++;
      tokens.push({ type: 'NUMBER', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // 关键字 true/false/null
    const kw = input.slice(i, i + 5);
    if (kw.startsWith('true') && !/[a-zA-Z0-9_]/.test(input[i + 4] || '')) {
      tokens.push({ type: 'KEYWORD', value: 'true', pos: i }); i += 4; continue;
    }
    if (kw.startsWith('false') && !/[a-zA-Z0-9_]/.test(input[i + 5] || '')) {
      tokens.push({ type: 'KEYWORD', value: 'false', pos: i }); i += 5; continue;
    }
    if (kw.startsWith('null') && !/[a-zA-Z0-9_]/.test(input[i + 4] || '')) {
      tokens.push({ type: 'KEYWORD', value: 'null', pos: i }); i += 4; continue;
    }

    // 无引号字符串（字母开头，可能为键名或值）
    if (/[a-zA-Z_$]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_$]/.test(input[j])) j++;
      tokens.push({ type: 'UNQUOTED_STRING', value: input.slice(i, j), pos: i });
      i = j;
      continue;
    }

    // 其他字符（空白、不可见等）— 跳过
    i++;
  }

  tokens.push({ type: 'EOF', value: '', pos: len });
  return { tokens, warnings };
}

// ================================================================
// 4. Fixer（状态机修复）
// ================================================================
interface FixerCtx {
  depth: number;
  expect: 'key' | 'value' | 'colon' | 'comma' | 'close' | 'any';
  container: 'object' | 'array' | 'none';
  stack: { type: 'object' | 'array' }[];
}

function fixTokens(tokens: Token[], opts: JsonRepairOptions): { result: string; warnings: RepairResult['warnings'] } {
  const warnings: RepairResult['warnings'] = [];
  let filtered = [...tokens];

  // 4a. 剔除注释
  if (opts.removeComments) {
    filtered = filtered.filter(t => t.type !== 'COMMENT_LINE' && t.type !== 'COMMENT_BLOCK');
  }

  // 4b. 遍历修复
  const out: string[] = [];
  const ctx: FixerCtx = { depth: 0, expect: 'any', container: 'none', stack: [] };
  let idx = 0;

  function peek(): Token | null {
    return idx < filtered.length ? filtered[idx] : null;
  }

  function consume(): Token | null {
    return idx < filtered.length ? filtered[idx++] : null;
  }

  function emit(s: string) { out.push(s); }

  function fixStr(t: Token): string {
    if (t.type === 'STRING_DOUBLE') return t.value;
    if (t.type === 'STRING_SINGLE') {
      if (!opts.fixSingleQuote) return t.value;
      const inner = t.value.slice(1, -1);
      const escaped = inner.replace(/"/g, '\\"').replace(/\\(?!["\\/bfnrtu])/g, '\\\\');
      return `"${escaped}"`;
    }
    return t.value;
  }

  while (idx < filtered.length) {
    const t = filtered[idx];

    if (t.type === 'EOF') break;

    // 深度检查
    if (ctx.depth > opts.maxDepth) {
      warnings.push({ type: 'MAX_DEPTH', message: `超出最大嵌套深度 ${opts.maxDepth}` });
      break;
    }

    // 左大括号
    if (t.type === 'LBRACE') {
      ctx.stack.push({ type: 'object' });
      ctx.depth++;
      ctx.expect = 'key';
      ctx.container = 'object';
      consume();
      emit('{');
      continue;
    }

    // 左中括号
    if (t.type === 'LBRACKET') {
      ctx.stack.push({ type: 'array' });
      ctx.depth++;
      ctx.expect = 'value';
      ctx.container = 'array';
      consume();
      emit('[');
      continue;
    }

    // 右大括号
    if (t.type === 'RBRACE') {
      // 尾部逗号处理
      const last = out[out.length - 1];
      if (last === ',') out[out.length - 1] = '';
      ctx.stack.pop();
      ctx.depth--;
      ctx.expect = 'close';
      ctx.container = ctx.stack.length > 0 ? ctx.stack[ctx.stack.length - 1].type : 'none';
      consume();
      emit('}');
      if (ctx.stack.length > 0) ctx.expect = 'comma';
      continue;
    }

    // 右中括号
    if (t.type === 'RBRACKET') {
      const last = out[out.length - 1];
      if (last === ',') out[out.length - 1] = '';
      ctx.stack.pop();
      ctx.depth--;
      ctx.expect = 'close';
      ctx.container = ctx.stack.length > 0 ? ctx.stack[ctx.stack.length - 1].type : 'none';
      consume();
      emit(']');
      if (ctx.stack.length > 0) ctx.expect = 'comma';
      continue;
    }

    // 逗号
    if (t.type === 'COMMA') {
      if (opts.trailingComma === 'remove') {
        const next = filtered[idx + 1];
        if (next && (next.type === 'RBRACE' || next.type === 'RBRACKET')) {
          warnings.push({ type: 'TRAILING_COMMA', message: `移除尾部逗号 (位置 ${t.pos})`, position: t.pos });
          consume();
          continue;
        }
      }
      ctx.expect = (ctx.container === 'object') ? 'key' : 'value';
      consume();
      emit(',');
      continue;
    }

    // 冒号
    if (t.type === 'COLON') {
      ctx.expect = 'value';
      consume();
      emit(':');
      continue;
    }

    // 字符串或值
    if (t.type === 'STRING_DOUBLE' || t.type === 'STRING_SINGLE' || t.type === 'UNQUOTED_STRING' || t.type === 'NUMBER' || t.type === 'KEYWORD') {
      if (ctx.expect === 'comma') {
        if (opts.missingComma) {
          warnings.push({ type: 'MISSING_COMMA', message: `自动插入逗号 (位置 ${t.pos})`, position: t.pos });
          emit(',');
          ctx.expect = (ctx.container === 'object') ? 'key' : 'value';
        }
      }

      // 无引号键名修复
      if (ctx.container === 'object' && ctx.expect === 'key' && t.type === 'UNQUOTED_STRING') {
        if (opts.fixUnquotedKeys) {
          emit(`"${t.value}"`);
          consume();
          // 后跟冒号？如果没有，补一个
          const next = filtered[idx];
          if (next && next.type === 'COLON') {
            consume();
            emit(':');
            ctx.expect = 'value';
          } else {
            warnings.push({ type: 'MISSING_COLON', message: `键 "${t.value}" 后补充分号 (位置 ${t.pos})`, position: t.pos });
            emit(':');
            ctx.expect = 'value';
          }
          continue;
        }
      }

      // 单引号修复
      if (t.type === 'STRING_SINGLE' && opts.fixSingleQuote) {
        emit(fixStr(t));
        consume();
        ctx.expect = (ctx.container === 'object') ? 'comma' : 'comma';
        continue;
      }

      // 无引号字符串 → 如果是值且不是关键字，包装为双引号
      if (t.type === 'UNQUOTED_STRING' && ctx.expect === 'value') {
        // 尝试判断：如果是关键字、数字 则不包装
        if (t.value === 'true' || t.value === 'false' || t.value === 'null' || !isNaN(Number(t.value))) {
          emit(t.value);
        } else {
          emit(`"${t.value}"`);
        }
        consume();
        ctx.expect = 'comma';
        continue;
      }

      // 普通值
      if (t.type === 'STRING_SINGLE') {
        emit(fixStr(t));
      } else {
        emit(t.value);
      }
      consume();
      ctx.expect = (ctx.container === 'object') ? 'comma' : 'comma';
      if (ctx.container === 'object' && ctx.expect === 'comma') ctx.expect = 'comma';
      continue;
    }

    // 未知 token
    consume();
  }

  // 4c. 自动补全缺失括号
  if (opts.closeBrackets) {
    while (ctx.stack.length > 0) {
      const frame = ctx.stack.pop()!;
      warnings.push({ type: 'UNCLOSED_BRACKET', message: `自动补全缺失的 ${frame.type === 'object' ? '}' : ']'}` });
      emit(frame.type === 'object' ? '}' : ']');
    }
  }

  let result = out.join('');

  // 4d. 值域修正（常见拼写错误）
  result = result.replace(/\bture\b/g, 'true');
  result = result.replace(/\bfasle\b/g, 'false');
  result = result.replace(/\bflase\b/g, 'false');
  result = result.replace(/\bundefine[d]?\b/g, 'null');
  result = result.replace(/\bNaN\b/g, 'null');
  result = result.replace(/,\s*,/g, ','); // 多余逗号

  return { result, warnings };
}

// ================================================================
// 5. 格式化输出
// ================================================================
function format(value: unknown, opts: JsonRepairOptions): string {
  if (opts.formatMode === 'minify') {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, null, opts.indentSize);
}

// 排序 replacer
function sortKeysReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    Object.keys(value).sort().forEach(k => { sorted[k] = value[k as keyof typeof value]; });
    return sorted;
  }
  return value;
}

// ================================================================
// 主入口
// ================================================================
export function repairJson(input: string, partialOpts?: Partial<JsonRepairOptions>): RepairResult {
  const opts = { ...DEFAULTS, ...partialOpts };
  const warnings: RepairResult['warnings'] = [];

  try {
    // 阶段 1: 预处理
    let cleaned = preprocess(input);

    // 阶段 2: 结构推断（可选）
    if (opts.inferStructure) {
      const inferred = inferStructure(cleaned);
      if (inferred !== cleaned) {
        warnings.push({ type: 'INFERRED', message: '输入已从非 JSON 格式推断为 JSON 结构' });
        cleaned = inferred;
      }
    }

    // 阶段 3+4: Tokenize + Fix
    const { tokens, warnings: tokenWarnings } = tokenize(cleaned);
    warnings.push(...tokenWarnings);

    const { result: fixed, warnings: fixWarnings } = fixTokens(tokens, opts);
    warnings.push(...fixWarnings);

    // 阶段 5: 标准解析器验证
    try {
      let parsed: unknown;
      if (opts.sortKeys) {
        parsed = JSON.parse(fixed, sortKeysReplacer);
      } else {
        parsed = JSON.parse(fixed);
      }
      const formatted = format(parsed, opts);

      return {
        success: true,
        json: formatted,
        warnings,
        diff: warnings.length > 0
          ? [{ offset: 0, original: input, fixed: formatted }]
          : undefined,
      };
    } catch (parseErr: unknown) {
      const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      // 提取位置信息
      const posMatch = msg.match(/position\s+(\d+)/i) || msg.match(/at\s+(\d+)/i);
      const position = posMatch ? parseInt(posMatch[1]) : 0;

      // 尝试 quickFix
      let quickFix: string | undefined;
      if (msg.includes('Unexpected token') || msg.includes('expected')){
        try {
          // 最后一次修复尝试：用更宽松的方式重试
          const retry = fixTokens(tokenize(cleaned.replace(/['"]/g, '"')).tokens, { ...opts, fixSingleQuote: true, fixUnquotedKeys: true }).result;
          JSON.parse(retry);
          quickFix = format(JSON.parse(retry), opts);
        } catch { /* ignore */ }
      }

      return {
        success: false,
        error: {
          type: 'PARSE_ERROR',
          message: msg,
          position,
          suggestion: `在第 ${position} 个字符附近存在语法错误`,
          quickFix,
        },
        warnings,
      };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        type: 'FATAL',
        message: `修复引擎异常: ${msg}`,
        position: 0,
        suggestion: '请检查输入内容',
      },
      warnings,
    };
  }
}
