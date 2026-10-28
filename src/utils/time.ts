/**
 * 时间显示统一走本地时区。
 *
 * ⚠️ 别再用 `iso.slice(11, 16)` —— 那是 UTC 的小时，北京时间会少 8 小时
 * （禅道「· 03:20 拉取」其实就是 11:20 拉的）。
 */

/** ISO 字符串 → 本地 HH:mm */
export function formatHm(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** ISO 字符串 → 本地 YYYY-MM-DD HH:mm */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 相对时间：今天只显示 HH:mm，昨天/更早显示 MM-DD HH:mm */
export function formatRecent(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const p = (n: number) => String(n).padStart(2, '0');
  return sameDay
    ? `${p(d.getHours())}:${p(d.getMinutes())}`
    : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
