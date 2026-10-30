'use strict';

/**
 * 测试账号的批量导入与密码新鲜度判断（纯函数，便于单测）。
 *
 * 为什么需要：
 * - 批量导入：同事给的账号常常是一张表/聊天记录，一条条录入太慢，粘贴多行直接生成。
 * - 密码新鲜度：测试环境密码被改过、或长期没换导致登录失败，界面上要能提示「已 N 天未更新」。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 解析批量文本，每行一个账号。支持 `|` 或 Tab 分隔：
 *   系统 | 角色 | 账号 | 密码 | 备注
 * 只要求前 4 列，后面可有可无；空行与 # 开头的注释行跳过。
 */
function parseAccountLines(text) {
  const rows = [];
  const bad = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const cols = line.split(/\s*[|\t]\s*/);
    if (cols.length < 4) {
      bad.push({ line: idx + 1, text: raw.trim() });
      return;
    }
    const [system, role, username, password, note = ''] = cols;
    if (!system || !role || !username || !password) {
      bad.push({ line: idx + 1, text: raw.trim() });
      return;
    }
    rows.push({ system, role, username, password, note });
  });
  return { rows, bad };
}

/** 距上次改密码多少天；时间缺失或非法返回 null */
function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const d = Math.floor((now - t) / DAY_MS);
  return d < 0 ? 0 : d;
}

/** 密码是否需要提醒更换（默认 90 天；<=0 表示关闭提醒） */
function needsRotate(iso, days = 90, now = Date.now()) {
  if (!days || days <= 0) return false;
  const d = daysSince(iso, now);
  if (d === null) return false;
  return d >= days;
}

module.exports = { DAY_MS, parseAccountLines, daysSince, needsRotate };
