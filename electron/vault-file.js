'use strict';

/**
 * 密码库文件（.enc）格式与结构自检。
 *
 * 文件格式：base64( salt(32) + iv(16) + tag(16) + ciphertext(≥1) )
 * —— 见 main.js 的 encrypt()。这里只做「结构」校验，不需要密码：
 * 长度/编码不对就说明文件被截断、损坏或根本不是密码库文件。
 *
 * 为什么需要它：备份恢复是「直接写回主库」的动作。旧版只校验文件名，
 * 如果备份文件本身是半截的，恢复会先把主库覆盖掉，才发现解不开 —— 白跑一次恢复。
 * 现在恢复前先过这一关，不合格就一行都不动。
 */

const ALGO = 'aes-256-gcm';
const SALT_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
/** 头部字节 + 至少 1 字节密文 */
const MIN_BYTES = SALT_LENGTH + IV_LENGTH + TAG_LENGTH + 1;

/**
 * @param {string} text 文件内容（base64 文本）
 * @returns {{ ok: boolean, bytes: number, error?: string }}
 */
function inspectVaultFile(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, bytes: 0, error: '文件是空的' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0) {
    return { ok: false, bytes: 0, error: '不是有效的 base64（文件被截断或选错了文件）' };
  }
  const buf = Buffer.from(raw, 'base64');
  if (buf.length < MIN_BYTES) {
    return { ok: false, bytes: buf.length, error: `密文过短（${buf.length} 字节，至少需要 ${MIN_BYTES}）` };
  }
  return { ok: true, bytes: buf.length };
}

module.exports = { ALGO, SALT_LENGTH, IV_LENGTH, TAG_LENGTH, MIN_BYTES, inspectVaultFile };
