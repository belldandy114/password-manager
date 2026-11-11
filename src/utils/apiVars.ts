/**
 * 接口调试的变量替换与提取。
 *
 * 拆出来的原因：这几条规则既被单次发送用，也被批量运行（变量池）用，
 * 放在页面文件里没法单独测；而且路径解析的边界（`[0]`、缺字段、值是对象）
 * 一旦写错只会表现成「变量没替换」，很难在界面上看出来。
 */

/** KEY=VALUE 每行一个 → 对象 */
export function parseVarLines(vars: string): Record<string, string> {
  const map: Record<string, string> = {};
  (vars || '').split('\n').forEach(line => {
    const idx = line.indexOf('=');
    if (idx > 0) map[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  });
  return map;
}

/** 把 {{var}} 替换成变量表里的值；没定义的保持原样（方便看出拼错） */
export function applyVars(text: string, vars: string): string {
  const map = parseVarLines(vars);
  return (text || '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => (map[k] !== undefined ? map[k] : m));
}

/**
 * 按路径从响应 JSON 里取值：`data.token`、`data.list[0].id`。
 * 取不到返回 undefined（不抛错）；取到的不是标量就 JSON.stringify。
 */
export function readJsonPath(obj: unknown, path: string): string | undefined {
  const raw = String(path || '').trim();
  if (!raw) return undefined;
  const parts = raw.replace(/\[(\w+)\]/g, '.$1').split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === undefined || cur === null) return undefined;
  return typeof cur === 'object' ? JSON.stringify(cur) : String(cur);
}

/**
 * 批量运行的变量池：用例/请求自己的变量做底，上游提取出来的值覆盖同名键。
 * 返回值仍是 `KEY=VALUE\n…` 文本，直接喂给 applyVars。
 */
export function mergeVarPool(base: string, pool: Record<string, string>): string {
  const map = { ...parseVarLines(base), ...pool };
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n');
}
