import { dump, load } from 'js-yaml';

/**
 * YAML ↔ JSON 转换（工具箱「YAML / JSON」工具）
 *
 * 用 js-yaml 而不是手写解析器：YAML 的缩进、锚点、多行标量、类型推断坑太多，
 * 自己写必然在「日期被转成 Date」「key 被当成数字」这类地方出错。
 */

export type YamlResult = { ok: true; text: string } | { ok: false; error: string };

/** JSON 文本 → YAML */
export function jsonToYaml(json: string): YamlResult {
  const src = String(json || '').trim();
  if (!src) return { ok: false, error: '请输入 JSON' };
  let value: unknown;
  try {
    value = JSON.parse(src);
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${(e as Error).message}` };
  }
  try {
    // lineWidth: -1 关掉自动折行，不然长字符串会被切成多行，和用户预期不一致
    return { ok: true, text: dump(value, { indent: 2, lineWidth: -1, noRefs: true }) };
  } catch (e) {
    return { ok: false, error: `转 YAML 失败：${(e as Error).message}` };
  }
}

/** YAML 文本 → JSON（带缩进美化） */
export function yamlToJson(yaml: string, indent = 2): YamlResult {
  const src = String(yaml || '');
  if (!src.trim()) return { ok: false, error: '请输入 YAML' };
  let value: unknown;
  try {
    // JSON_SCHEMA 关掉 YAML 1.1 的隐式类型（yes/no/on/off、日期），避免值被悄悄改写
    value = load(src, { schema: undefined });
  } catch (e) {
    return { ok: false, error: `不是合法 YAML：${(e as Error).message}` };
  }
  try {
    return { ok: true, text: JSON.stringify(value, null, Math.max(0, Math.min(8, indent))) };
  } catch (e) {
    return { ok: false, error: `转 JSON 失败：${(e as Error).message}` };
  }
}

/** 自动判断：看起来像 YAML 就转 JSON，否则 JSON 转 YAML */
export function autoConvert(text: string, indent = 2): YamlResult {
  const src = String(text || '').trim();
  if (!src) return { ok: false, error: '请输入内容' };
  try {
    JSON.parse(src);
    return jsonToYaml(src);
  } catch {
    return yamlToJson(src, indent);
  }
}