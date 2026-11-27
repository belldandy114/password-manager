'use strict';

/**
 * 启动免密（R2）纯函数模块 —— 契约 `docs/契约-设置细分-免密-卸载.md` §2.7 / D7。
 *
 * **本文件不 require('electron')**：`safeStorage`、目标目录、时间戳全部由调用方注入。
 * 理由（D7）：单测跑在 vitest（没有 Electron 运行时），而 `src/**` 的 tsconfig 是
 * `types: []`（渲染层不引 Node 类型），所以「能被单测覆盖的判定逻辑」只能落在这种
 * 纯 JS 模块里 —— 与 `electron/jmeter-args.js`、`electron/codelang-args.js` 同一套约定。
 *
 * 真源只有一个：`<DATA_DIR>/autologin.json` 是否存在 + 能否解析（D2：**不进** AppSettings）。
 * 落盘格式见 §2.7：
 *   { "v": 1, "blob": "<safeStorage 密文的 base64>", "updatedAt": "<ISO 8601>" }
 *
 * 明文禁令：本模块接收的 `blobBase64` 已经是密文，「主密码明文」永远不会进这个文件，
 * 也永远不会进任何返回值 / 日志（§2.6）。
 */

const path = require('path');

/** 落盘版本号；读到其它值 → `autologin-version-unsupported`（不删，留待升级迁移） */
const AUTOLOGIN_VERSION = 1;
const AUTOLOGIN_FILE_NAME = 'autologin.json';
/**
 * blob 体积上限 64 KB（§2.7）。DPAPI / Keychain 的密文只有几百字节，
 * 超过这个量级只可能是被人塞了别的东西，按 `write-failed` 拒绝。
 */
const MAX_BLOB_BYTES = 64 * 1024;

/** reasonCode → 中文人话（§2.2 / §2.5 / 附录 A）。措辞可微调，语义不得变。 */
const REASON_TEXT = {
  'safe-storage-unavailable': '系统未提供安全存储（DPAPI 不可用），启动免密不可用',
  'autologin-corrupt': '启动免密配置文件已损坏，已停用',
  'autologin-version-unsupported': '启动免密配置版本不受支持',
  'not-setup': '尚未初始化主密码',
  'no-credential': '未保存启动免密凭据',
  'session-locked': '本次已手动锁定，需输入主密码',
  'decrypt-failed': '启动免密凭据已失效（已自动清除）',
  'vault-corrupt': '数据损坏，无法解密（可尝试从备份恢复）',
};

/**
 * 本文件负责的三个 reasonCode（其余由 handler 侧的会话状态决定），
 * 供 qa 断言「枚举没有自造值」。
 */
const AUTOLOGIN_REASON_CODES = [
  'safe-storage-unavailable',
  'autologin-corrupt',
  'autologin-version-unsupported',
  'not-setup',
];

/** @param {string} code */
function reasonText(code) {
  return REASON_TEXT[code] || '';
}

/**
 * `<DATA_DIR>/autologin.json` 的绝对路径（与 vault.enc 同目录，§2.7）。
 * @param {string} dataDir
 * @returns {string}
 */
function autologinPath(dataDir) {
  return path.join(String(dataDir || ''), AUTOLOGIN_FILE_NAME);
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * blob 是否「像一个 base64 密文」（不做真正的解码校验 —— 解不开属于 `decrypt-failed`）。
 * @param {unknown} s
 * @returns {boolean}
 */
function isBlobLike(s) {
  if (typeof s !== 'string') return false;
  if (!s || s.length > MAX_BLOB_BYTES) return false;
  return BASE64_RE.test(s);
}

/**
 * 解析 autologin.json 的**文本内容**（不读盘，纯函数）。
 *
 * 返回值（三态，handler 直接照用）：
 *   - `{ ok: true, enabled: true, blob, updatedAt, version }`
 *   - `{ ok: false, enabled: false, reasonCode: 'autologin-corrupt' }`             → auto-unlock 时自清（E5）
 *   - `{ ok: false, enabled: false, reasonCode: 'autologin-version-unsupported' }` → **不删**（§2.7）
 *
 * @param {unknown} raw 文件文本
 */
function parseAutologin(raw) {
  const fail = (reasonCode) => ({
    ok: false,
    enabled: false,
    reasonCode,
    reason: reasonText(reasonCode),
  });

  if (typeof raw !== 'string' || raw.trim() === '') return fail('autologin-corrupt');

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return fail('autologin-corrupt');
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return fail('autologin-corrupt');

  // 版本先判：读到不认识的版本应当「停用但保留」，不能当损坏删掉（否则降级一次就丢凭据）
  if (obj.v !== AUTOLOGIN_VERSION) return fail('autologin-version-unsupported');

  const blob = typeof obj.blob === 'string' ? obj.blob.trim() : '';
  if (!blob) return fail('autologin-corrupt');
  /**
   * 超限**先判**：`isBlobLike()` 自己也会挡超限，但它挡下来的语义是「不是有效 base64」，
   * 于是「超过 64 KB 上限」这件事就永远说不出口（t8 修的死代码）。
   * reasonCode 仍是 `autologin-corrupt`（不新增枚举：枚举是 8 值契约，加一个会连带改
   * .d.ts 与 REASON_TEXT 长度断言），只在 `reason` 里把真相说清楚。
   */
  if (blob.length > MAX_BLOB_BYTES) {
    return {
      ok: false,
      enabled: false,
      reasonCode: 'autologin-corrupt',
      reason: `${reasonText('autologin-corrupt')}（凭据超过 64 KB 上限，已按超限拒绝）`,
    };
  }
  if (!isBlobLike(blob)) return fail('autologin-corrupt');

  return {
    ok: true,
    enabled: true,
    blob,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : '',
    version: AUTOLOGIN_VERSION,
  };
}

/**
 * 生成落盘文本（§2.7 写入规则）。
 *
 * 只允许这三个字段：`password` / `masterPassword` / `hint` / `salt` / `hash` / 用户名 /
 * 机器名**一律禁止**写入 —— DPAPI 已绑定 OS 用户，不需要任何额外标识，多写就是泄露面。
 *
 * @param {string} blobBase64 `safeStorage.encryptString(pw).toString('base64')`
 * @param {string} [nowISO] ISO 8601 时间戳（调用方注入，便于单测）
 * @returns {string} 待 `writeFileAtomic` 的 JSON 文本
 */
function serializeAutologin(blobBase64, nowISO) {
  const blob = typeof blobBase64 === 'string' ? blobBase64.trim() : '';
  if (!blob) throw new Error('blob 不是有效的 base64 密文');
  // 长度**先于** isBlobLike：否则超限串会被字符集判定抢先报成「不是有效 base64」，超限文案永不可达（t8）
  if (blob.length > MAX_BLOB_BYTES) throw new Error('blob 超过 64 KB 上限');
  if (!isBlobLike(blob)) throw new Error('blob 不是有效的 base64 密文');
  const at = typeof nowISO === 'string' && nowISO ? nowISO : new Date().toISOString();
  return JSON.stringify({ v: AUTOLOGIN_VERSION, blob, updatedAt: at }, null, 2);
}

/**
 * 本次进程内「能不能尝试自动解锁」（E4 / E6）：安全存储可用 **且** 没被手动锁定抑制。
 * @param {{ available?: boolean, suppressed?: boolean }} state
 * @returns {boolean}
 */
function isAutoUnlockUsable(state) {
  const s = state || {};
  return !!s.available && !s.suppressed;
}

/**
 * 状态查询的组装逻辑（§2.2）。**不解密**：启动期每多一次 DPAPI 调用就多一段黑屏。
 *
 * `enabled` = 文件存在 && 可解析 && v===1 && blob 为非空 base64。
 * 任何读取异常都归成 `success:true + enabled:false + reasonCode`（禁止让启动态卡在错误弹窗）。
 * 文件不存在不是错误 —— 只是「没开」，此时不编 reasonCode（`not-setup` 由 handler 侧
 * 依据「有没有 vault 文件」决定，见 §2.2 的「未初始化时可选返回」）。
 *
 * @param {{ exists?: boolean, raw?: string|null, available?: boolean }} input
 */
function buildAutoUnlockStatus(input) {
  const i = input || {};
  const available = !!i.available;
  const exists = !!i.exists && typeof i.raw === 'string';

  if (!exists) {
    const out = { enabled: false, available };
    if (!available) {
      out.reasonCode = 'safe-storage-unavailable';
      out.reason = reasonText('safe-storage-unavailable');
    }
    return out;
  }
  const parsed = parseAutologin(i.raw);
  if (!parsed.ok) {
    return {
      enabled: false,
      available,
      reasonCode: parsed.reasonCode,
      reason: parsed.reason,
    };
  }
  const out = { enabled: true, available };
  if (parsed.updatedAt) out.updatedAt = parsed.updatedAt;
  // 文件在、能解，但系统现在没安全存储（E6）：开关要能显示「已开但当前不可用」
  if (!available) {
    out.reasonCode = 'safe-storage-unavailable';
    out.reason = reasonText('safe-storage-unavailable');
  }
  return out;
}

module.exports = {
  AUTOLOGIN_VERSION,
  AUTOLOGIN_FILE_NAME,
  AUTOLOGIN_REASON_CODES,
  MAX_BLOB_BYTES,
  REASON_TEXT,
  reasonText,
  autologinPath,
  isBlobLike,
  parseAutologin,
  serializeAutologin,
  isAutoUnlockUsable,
  buildAutoUnlockStatus,
};
