'use strict';

/**
 * 工具类纯逻辑 + IPC：密码生成、TOTP。
 *
 * 这两块都只依赖 crypto，不碰密码库状态，所以从 main.js 的 setupIpcHandlers() 里搬出来，
 * 顺手让它们可以被单测覆盖（TOTP 有 RFC 6238 官方向量，密码生成有「每类至少一个字符」的约束）。
 */

const crypto = require('crypto');
const { ipcMain } = require('electron');

/** RFC 4648 base32 解码（TOTP 密钥常用格式，忽略非字母数字与分隔符） */
function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP：返回 digits 位数字字符串；密钥无效返回 null */
function totpAt(secret, atMs, digits = 6, period = 30) {
  const key = base32Decode(secret);
  if (!key.length) return null;
  const counter = BigInt(Math.floor(atMs / 1000 / period));
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24)
    | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8)
    | hmac[offset + 3];
  return String(bin % (10 ** digits)).padStart(digits, '0');
}

const AMBIGUOUS = 'Il1O0o';

/**
 * 生成随机密码。规则：
 * - 长度夹在 6~128；
 * - 每种勾选的字符集**至少出现一次**（否则用户会发现密码里没有符号）；
 * - 用 crypto.randomInt + Fisher–Yates 洗牌，保证保底字符不在开头。
 * @returns {{ ok: boolean, password?: string, error?: string }}
 */
function generatePassword(opts = {}) {
  const length = Math.min(128, Math.max(6, Number(opts.length) || 16));
  const clean = (s) => (opts.excludeAmbiguous ? s.split('').filter(c => !AMBIGUOUS.includes(c)).join('') : s);
  const sets = [];
  if (opts.lower !== false) sets.push(clean('abcdefghijklmnopqrstuvwxyz'));
  if (opts.upper !== false) sets.push(clean('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
  if (opts.digits !== false) sets.push(clean('0123456789'));
  if (opts.symbols) sets.push(clean('!@#$%^&*()-_=+[]{};:,.?/'));

  const usable = sets.filter(s => s.length > 0);
  if (usable.length === 0) return { ok: false, error: '请至少选择一种字符类型' };

  const chars = [];
  for (const set of usable) chars.push(set[crypto.randomInt(set.length)]);
  const all = usable.join('');
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return { ok: true, password: chars.join('') };
}

function registerToolsIpc() {
  ipcMain.handle('password:generate', (_event, opts = {}) => {
    const r = generatePassword(opts);
    if (!r.ok) return { success: false, error: r.error };
    return { success: true, data: r.password };
  });

  ipcMain.handle('totp:code', (_event, { secret, digits = 6, period = 30 } = {}) => {
    if (!secret) return { success: false, error: '未配置密钥' };
    const now = Date.now();
    const code = totpAt(secret, now, digits, period);
    if (!code) return { success: false, error: '密钥格式无效' };
    const remain = period - Math.floor((now / 1000) % period);
    return { success: true, data: { code, remain, period } };
  });
}

module.exports = { base32Decode, totpAt, generatePassword, registerToolsIpc };
