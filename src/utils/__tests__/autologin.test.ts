import { describe, it, expect } from 'vitest';
import {
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
} from '../../../electron/autologin.js';
import * as autologinModule from '../../../electron/autologin.js';

/**
 * 启动免密（R2）纯函数层 —— 契约 `docs/契约-设置细分-免密-卸载.md` §2.7 / §2.8 / D7，
 * 判据见 `docs/验收-设置细分-免密-卸载.md` 的 AC-AU-02 / AC-AU-10 / AC-AU-11 / AC-AU-12 / AC-AU-16。
 *
 * 这条测试**不起 Electron 运行时**：`electron/autologin.js` 不 require('electron')（D7），
 * safeStorage 只在 handler 层调用；本文件只喂字符串 + 替身，所以能在 vitest 的 node 环境里跑。
 * 也不用 Buffer / fs / path（`tsconfig` 是 `types: []`，测试跟着走注入式替身）。
 */

/** 合法的 base64 密文样本（内容无意义：只是字符集合法、非空、体积在 64KB 内） */
const CIPHER_B64 = 'AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA';
const NOW = '2026-12-01T02:03:04.000Z';

/**
 * 「超 64KB 的**合法 base64**」：字符集完全合法（全 'A'），只有长度越界。
 * 用它才能把「超限」与「base64 语法错」两种拒绝理由分开 —— 若实现把长度判断放回
 * `isBlobLike()` 之后，这个输入会被报成「不是有效的 base64 密文」，断言立刻变红（t8 的回归锁）。
 */
const OVERSIZE_B64 = 'A'.repeat(MAX_BLOB_BYTES + 1);
/** 「非 base64 的短串」：长度没问题，只有字符集不合法 */
const SHORT_BAD_B64 = '!!!not-base64!!!';

/** 取一段「必然抛错」的调用抛出的文案（用于比较两种拒绝理由是否可区分） */
function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error('期望抛错，实际没有抛');
}

/** 落盘文本工厂：给定字段拼成 autologin.json 的文本 */
function fileText(patch: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, blob: CIPHER_B64, updatedAt: NOW, ...patch });
}

/**
 * 断言「解析失败」并返回**已收窄**的结果。
 * （`ok` 是字面量布尔，但 `expect(...)` 不做类型收窄，所以统一走这个 helper，
 * 避免在联合类型上直接摸 `reasonCode` 触发 TS2339。）
 */
function expectParseFail(raw: unknown) {
  const r = parseAutologin(raw);
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('期望解析失败，实际成功');
  return r;
}

/** 断言「解析成功」并返回已收窄的成功分支 */
function expectParseOk(raw: unknown) {
  const r = parseAutologin(raw);
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`期望解析成功，实际失败：${r.reasonCode}`);
  return r;
}

describe('autologin：落盘格式（契约 §2.7）', () => {
  it('版本号与文件名是契约常量', () => {
    expect(AUTOLOGIN_VERSION).toBe(1);
    expect(AUTOLOGIN_FILE_NAME).toBe('autologin.json');
    expect(MAX_BLOB_BYTES).toBe(64 * 1024);
  });

  it('autologinPath 固定在数据目录下（与 vault.enc 同目录）', () => {
    const p = autologinPath('DATA_DIR_FIXTURE');
    expect(p.endsWith(AUTOLOGIN_FILE_NAME)).toBe(true);
    // 分隔符由 path.join 决定（Windows 是反斜杠），所以只判「前缀是该目录」而不是硬编码 '/'
    expect(p.startsWith('DATA_DIR_FIXTURE')).toBe(true);
    expect(p.length).toBe('DATA_DIR_FIXTURE'.length + 1 + AUTOLOGIN_FILE_NAME.length);
    // 空目录不编造路径（返回空串 + 文件名，由调用方保证 dir 非空）
    expect(autologinPath('')).toBe(AUTOLOGIN_FILE_NAME);
  });

  it('serialize 只写 {v, blob, updatedAt} 三个键，v 恒为 1，时间戳用注入值', () => {
    const text = serializeAutologin(CIPHER_B64, NOW);
    const obj = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(obj)).toEqual(['v', 'blob', 'updatedAt']);
    expect(obj.v).toBe(1);
    expect(obj.blob).toBe(CIPHER_B64);
    expect(obj.updatedAt).toBe(NOW);
  });

  it('落盘文本里不含任何明文/身份字段（§2.6 明文禁令的落盘侧）', () => {
    const text = serializeAutologin(CIPHER_B64, NOW);
    for (const forbidden of ['password', 'masterPassword', 'hint', 'salt', 'hash', 'username', 'machineName']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('serialize → parse 往返一致（blob 逐字、updatedAt 逐字）', () => {
    const parsed = parseAutologin(serializeAutologin(CIPHER_B64, NOW));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blob).toBe(CIPHER_B64);
    expect(parsed.updatedAt).toBe(NOW);
    expect(parsed.version).toBe(AUTOLOGIN_VERSION);
    expect(parsed.enabled).toBe(true);
  });

  it('serialize 拒绝空串与非 base64 短串：走「base64 语法」语义', () => {
    expect(() => serializeAutologin('')).toThrow(/base64/);
    expect(() => serializeAutologin('')).toThrow(/不是有效的 base64 密文/);
    expect(() => serializeAutologin(SHORT_BAD_B64)).toThrow(/^blob 不是有效的 base64 密文$/);
    // 语法错的路径**不该**提超限（提了就是把两种拒绝理由混成一种）
    expect(messageOf(() => serializeAutologin(SHORT_BAD_B64))).not.toContain('64 KB');
  });

  it('serialize 拒绝超 64KB 的**合法 base64**：走「超限」语义，且与语法错文案不同', () => {
    const oversizeMsg = messageOf(() => serializeAutologin(OVERSIZE_B64));
    const syntaxMsg = messageOf(() => serializeAutologin(SHORT_BAD_B64));

    // 输入本身是合法 base64（字符集没问题），所以只有「长度先判」才可能报出超限
    expect(OVERSIZE_B64.length).toBe(MAX_BLOB_BYTES + 1);
    expect(isBlobLike(OVERSIZE_B64)).toBe(false); // isBlobLike 仍然因长度返回 false（本体刻意未改）
    expect(oversizeMsg).toMatch(/^blob 超过 64 KB 上限$/);
    expect(syntaxMsg).toMatch(/^blob 不是有效的 base64 密文$/);
    // 两条拒绝理由必须可区分 —— 这就是「t8 修好了」不会退回去的锁
    expect(oversizeMsg).not.toBe(syntaxMsg);
    expect(oversizeMsg).not.toContain('不是有效的 base64');
    expect(oversizeMsg).toContain('64 KB');
    // 若有人把长度判断挪回 isBlobLike 之后，上面两条 toMatch/not.toContain 立刻变红
  });
});

describe('autologin：解析失败的三态与处置（§2.7 / E5 / AC-AU-11）', () => {
  it("损坏文件（'{' 非法 JSON）→ autologin-corrupt（handler 会自清）", () => {
    const r = expectParseFail('{');
    expect(r.enabled).toBe(false);
    expect(r.reasonCode).toBe('autologin-corrupt');
    expect(r.reason).toBe(REASON_TEXT['autologin-corrupt']);
  });

  it('空串 / 非字符串 / JSON 非对象（null、数组）一律 corrupt', () => {
    for (const raw of ['', '   ', null, undefined, 42, 'null', '[]', '"str"']) {
      expect(expectParseFail(raw).reasonCode).toBe('autologin-corrupt');
    }
  });

  it('v:2 → autologin-version-unsupported（**不得**归成 corrupt：那样会被自清丢掉凭据）', () => {
    const r = expectParseFail(fileText({ v: 2 }));
    expect(r.reasonCode).toBe('autologin-version-unsupported');
    expect(r.reason).toBe(REASON_TEXT['autologin-version-unsupported']);
  });

  it('版本比较是严格等值：字符串 "1" 按版本不支持处理（不是数字 1 就不是我们写的文件）', () => {
    expect(expectParseFail(fileText({ v: '1' })).reasonCode).toBe('autologin-version-unsupported');
  });

  it('blob 缺失 / 空 / 非 base64 → corrupt', () => {
    for (const patch of [{ blob: '' }, { blob: '   ' }, { blob: SHORT_BAD_B64 }, { blob: 123 }]) {
      expect(expectParseFail(fileText(patch)).reasonCode).toBe('autologin-corrupt');
    }
  });

  it('parse：超 64KB 合法 base64 与「非 base64 短串」给出**可区分**的两条 corrupt（超限先判）', () => {
    const oversize = expectParseFail(fileText({ blob: OVERSIZE_B64 }));
    const syntax = expectParseFail(fileText({ blob: SHORT_BAD_B64 }));

    // reasonCode 仍共用 autologin-corrupt（契约枚举 8 值，t8 不新增枚举）
    expect(oversize.reasonCode).toBe('autologin-corrupt');
    expect(syntax.reasonCode).toBe('autologin-corrupt');

    // 语法错：文案 === 通用损坏文案（没有超限后缀）
    expect(syntax.reason).toBe(REASON_TEXT['autologin-corrupt']);
    // 超限：同一前缀 + 超限后缀，且与语法错**不相等**
    expect(oversize.reason.startsWith(REASON_TEXT['autologin-corrupt'])).toBe(true);
    expect(oversize.reason).toContain('64 KB');
    expect(oversize.reason).toContain('超限');
    expect(oversize.reason).not.toBe(syntax.reason);
    expect(oversize.reason).not.toBe(REASON_TEXT['autologin-corrupt']);
    // 若有人把 `blob.length > MAX_BLOB_BYTES` 挪回 isBlobLike 之后，oversize.reason 会退回通用文案
    // → 上面三条（startsWith 之外的 toContain/not.toBe）立即变红
  });

  it('updatedAt 缺失不影响可解析（返回空串，状态里就不带 updatedAt）', () => {
    expect(expectParseOk(JSON.stringify({ v: 1, blob: CIPHER_B64 })).updatedAt).toBe('');
  });

  it('解析结果不携带主密码（返回值键 ⊆ {ok,enabled,blob,updatedAt,version}）', () => {
    const r = parseAutologin(fileText());
    for (const k of Object.keys(r)) {
      expect(['ok', 'enabled', 'blob', 'updatedAt', 'version']).toContain(k);
    }
    expect('password' in r).toBe(false);
  });

  it('模块导出面 = 12 个纯函数/常量，没有任何删文件的 API（「v:2 不删」由模块能力保证）', () => {
    const names = Object.keys(autologinModule).filter((k) => k !== 'default').sort();
    expect(names).toEqual([
      'AUTOLOGIN_FILE_NAME',
      'AUTOLOGIN_REASON_CODES',
      'AUTOLOGIN_VERSION',
      'MAX_BLOB_BYTES',
      'REASON_TEXT',
      'autologinPath',
      'buildAutoUnlockStatus',
      'isAutoUnlockUsable',
      'isBlobLike',
      'parseAutologin',
      'reasonText',
      'serializeAutologin',
    ]);
    // 没有 unlink / rm / write 之类的副作用入口
    for (const banned of ['unlinkSync', 'rmSync', 'writeFileSync', 'remove', 'clear']) {
      expect(names).not.toContain(banned);
    }
  });
});

describe('autologin：isBlobLike 与 reasonText', () => {
  it('isBlobLike 只做字符集/长度判定（解不开属 decrypt-failed，不在这里）', () => {
    expect(isBlobLike(CIPHER_B64)).toBe(true);
    expect(isBlobLike('AQAA')).toBe(true);
    expect(isBlobLike('AQAA+/==')).toBe(true);
    expect(isBlobLike('')).toBe(false);
    expect(isBlobLike('!!!')).toBe(false);
    expect(isBlobLike(42)).toBe(false);
    expect(isBlobLike(null)).toBe(false);
    expect(isBlobLike('A'.repeat(MAX_BLOB_BYTES + 1))).toBe(false);
  });

  it('reasonText 对 8 个 reasonCode 都有人话，未知 code 返回空串', () => {
    const codes = [
      'safe-storage-unavailable', 'autologin-corrupt', 'autologin-version-unsupported', 'not-setup',
      'no-credential', 'session-locked', 'decrypt-failed', 'vault-corrupt',
    ];
    for (const c of codes) expect(reasonText(c).length).toBeGreaterThan(4);
    expect(reasonText('made-up-code')).toBe('');
    expect(Object.keys(REASON_TEXT).length).toBe(8);
  });

  it('AUTOLOGIN_REASON_CODES = 本模块负责的 4 个，且都能翻出人话（不自造枚举）', () => {
    expect(AUTOLOGIN_REASON_CODES).toEqual([
      'safe-storage-unavailable', 'autologin-corrupt', 'autologin-version-unsupported', 'not-setup',
    ]);
    for (const c of AUTOLOGIN_REASON_CODES) expect(reasonText(c).length).toBeGreaterThan(0);
  });
});

describe('autologin：抑制位与不可用分支（E4 / E6 / AC-AU-12）', () => {
  it('isAutoUnlockUsable 只有「安全存储可用 且 未被手动锁定」才是 true', () => {
    expect(isAutoUnlockUsable({ available: true, suppressed: false })).toBe(true);
    expect(isAutoUnlockUsable({ available: true, suppressed: true })).toBe(false);
    expect(isAutoUnlockUsable({ available: false, suppressed: false })).toBe(false);
    expect(isAutoUnlockUsable({ available: false, suppressed: true })).toBe(false);
    expect(isAutoUnlockUsable({})).toBe(false);
    expect(isAutoUnlockUsable()).toBe(false);
  });

  it('status：没有文件 + 有安全存储 → enabled:false 且**不编 reasonCode**', () => {
    const s = buildAutoUnlockStatus({ exists: false, available: true });
    expect(s).toEqual({ enabled: false, available: true });
  });

  it('status：没有文件 + 无安全存储 → safe-storage-unavailable + 中文原因', () => {
    const s = buildAutoUnlockStatus({ exists: false, available: false });
    expect(s.enabled).toBe(false);
    expect(s.available).toBe(false);
    expect(s.reasonCode).toBe('safe-storage-unavailable');
    expect(s.reason).toBe(REASON_TEXT['safe-storage-unavailable']);
  });

  it('status：文件合法 → enabled:true 并带 updatedAt', () => {
    const s = buildAutoUnlockStatus({ exists: true, raw: fileText(), available: true });
    expect(s.enabled).toBe(true);
    expect(s.available).toBe(true);
    expect(s.updatedAt).toBe(NOW);
    expect(s.reasonCode).toBeUndefined();
  });

  it('status：文件在但系统当前无安全存储（E6）→ enabled:true + 不可用原因（开关显示「已开但不可用」）', () => {
    const s = buildAutoUnlockStatus({ exists: true, raw: fileText(), available: false });
    expect(s.enabled).toBe(true);
    expect(s.available).toBe(false);
    expect(s.reasonCode).toBe('safe-storage-unavailable');
    expect(s.reason).toBe(REASON_TEXT['safe-storage-unavailable']);
  });

  it('status：exists:true 但 raw 不是字符串（读盘失败）→ 按「没开」处理，不抛', () => {
    const s = buildAutoUnlockStatus({ exists: true, raw: null, available: true });
    expect(s.enabled).toBe(false);
    expect(s.reasonCode).toBeUndefined();
  });

  it('status：损坏 / 版本不支持都归成 enabled:false + 对应 reasonCode（不抛、不 success:false）', () => {
    const corrupt = buildAutoUnlockStatus({ exists: true, raw: '{', available: true });
    expect(corrupt.enabled).toBe(false);
    expect(corrupt.reasonCode).toBe('autologin-corrupt');

    const version = buildAutoUnlockStatus({ exists: true, raw: fileText({ v: 9 }), available: true });
    expect(version.enabled).toBe(false);
    expect(version.reasonCode).toBe('autologin-version-unsupported');
  });

  it('status 返回值键 ⊆ {enabled,available,reasonCode,reason,updatedAt}（§2.2 白名单）', () => {
    const samples = [
      buildAutoUnlockStatus({ exists: false, available: true }),
      buildAutoUnlockStatus({ exists: false, available: false }),
      buildAutoUnlockStatus({ exists: true, raw: fileText(), available: true }),
      buildAutoUnlockStatus({ exists: true, raw: fileText(), available: false }),
      buildAutoUnlockStatus({ exists: true, raw: '{', available: true }),
    ];
    for (const s of samples) {
      for (const k of Object.keys(s)) {
        expect(['enabled', 'available', 'reasonCode', 'reason', 'updatedAt']).toContain(k);
      }
    }
  });
});
