/**
 * `.jtl` 指标的截断文案（1.36.0 从 `components/resulthub/model.ts` 搬来）
 *
 * 只留 `.jtl` 这一段：Allure 的 `Allure*` 类型与 `TRUNCATED_TEXT` 随结果中心一起下线。
 * 不依赖 React，也不碰 IPC。
 */

export const JTL_TRUNCATED_TEXT: Record<string, string> = { rows: '行数超过上限', labels: '接口维度超过上限' };
