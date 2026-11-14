/**
 * 工具箱「文本对比」的纯计算部分：归一化 + 逐行 LCS 差异。
 * 从 Toolbox.tsx 抽出来是为了能单测 —— 归一化规则以前写死在组件里，
 * 改了缩进 / 换行符会不会误报全篇，只能靠肉眼点，回归过一次。
 */

export interface DiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface DiffNormalizeOptions {
  /** 忽略行首尾空白、把行内连续空白压成一个空格 */
  ignoreWs?: boolean;
  /** 忽略大小写 */
  ignoreCase?: boolean;
}

/** 统一换行（CRLF / CR → LF）后再按选项归一化，避免整篇误报差异 */
export function normalizeForDiff(text: string, opts: DiffNormalizeOptions = {}): string {
  let out = text.replace(/\r\n?/g, '\n');
  if (opts.ignoreWs) {
    // 末尾多一个换行 / 几行空白是编辑器常态，属于「空白差异」，不该报删除行
    out = out.split('\n').map(line => line.trim().replace(/[ \t]+/g, ' ')).join('\n').replace(/\n+$/, '');
  }
  if (opts.ignoreCase) out = out.toLowerCase();
  return out;
}

/** 逐行 LCS 差异；行数乘积超过阈值时给一条提示，避免 O(n*m) 内存爆炸 */
export function diffLines(a: string, b: string): DiffLine[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length, m = B.length;
  if (n * m > 2_250_000) {
    return [{ type: 'same', text: `文本过大（${n} 行 × ${m} 行），请缩小对比范围` }];
  }
  // 归一化后两边完全相同是最常见的情况（尤其开了忽略空白/大小写）；
  // 直接返回，别为一眼就能判等的两段文本建 n*m 的 DP 表。
  if (a === b) return A.map(text => ({ type: 'same' as const, text }));
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'same', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i] }); i++; }
    else { out.push({ type: 'add', text: B[j] }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

/** 每行同时留两份：`norm` 用于比较，`raw` 用于展示（缩进 / 大小写 / 行内空白都不改） */
interface ComparableLine {
  norm: string;
  raw: string;
}

function comparableLines(text: string, opts: DiffNormalizeOptions): ComparableLine[] {
  // 只统一换行符；其余原样保留。CRLF 里的 \r 是行分隔符的一部分，不该出现在展示文本里。
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  let lines: ComparableLine[] = rawLines.map(raw => ({
    raw,
    norm: opts.ignoreWs ? raw.trim().replace(/[ \t]+/g, ' ') : raw,
  }));
  if (opts.ignoreWs) {
    // 对齐 normalizeForDiff 的 .replace(/\n+$/, '')：丢末尾空白行，但至少留 1 行，
    // 保证行数组与归一化字符串 split('\n') 的长度一致。
    while (lines.length > 1 && lines[lines.length - 1].norm === '') lines.pop();
  }
  if (opts.ignoreCase) lines = lines.map(l => ({ raw: l.raw, norm: l.norm.toLowerCase() }));
  return lines;
}

/**
 * 工具箱用：按归一化值比较，但结果里展示用户输入的原文。
 *
 * 旧的 `diffLines(normalizeForDiff(a), normalizeForDiff(b))` 会把缩进、行内空白、
 * 大小写一起改掉再显示，开了「忽略空白差异」后整段结果看着像被重新排版过。
 * 现在 LCS 只拿 `norm` 判等，`text` 一律取 `raw`；相同的行取左侧原文（原始文本）
 * 作为基准，新增行取右侧、删除行取左侧。
 */
export function diffTexts(a: string, b: string, opts: DiffNormalizeOptions = {}): DiffLine[] {
  const A = comparableLines(a, opts);
  const B = comparableLines(b, opts);
  const n = A.length, m = B.length;
  if (n * m > 2_250_000) {
    return [{ type: 'same', text: `文本过大（${n} 行 × ${m} 行），请缩小对比范围` }];
  }
  // 归一化后逐行相等是最常见路径（尤其开着忽略选项），别建 n*m 的 DP 表
  if (n === m && A.every((l, i) => l.norm === B[i].norm)) {
    return A.map(l => ({ type: 'same' as const, text: l.raw }));
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i].norm === B[j].norm ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].norm === B[j].norm) { out.push({ type: 'same', text: A[i].raw }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: A[i].raw }); i++; }
    else { out.push({ type: 'add', text: B[j].raw }); j++; }
  }
  while (i < n) out.push({ type: 'del', text: A[i++].raw });
  while (j < m) out.push({ type: 'add', text: B[j++].raw });
  return out;
}
