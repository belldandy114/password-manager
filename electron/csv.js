/**
 * CSV / 导入记录解析（纯函数，无 Electron 依赖）
 *
 * 从 main.js 抽出来的原因：这堆逻辑最容易出错（引号、逗号、BOM、Excel 日期序列号、
 * 各浏览器导出的表头别名），但以前只能靠跑整个应用来验证。抽成模块后可直接单测。
 */

// RFC 4180 parser: quoted fields, "" as an escaped quote, commas and newlines inside
// quotes. The previous implementation used split(',') which silently mangled any
// password containing a comma or quote.
function parseCsv(text) {
const rows = [];
let row = [];
let field = '';
let inQuotes = false;
const s = String(text).replace(/^\uFEFF/, '');

for (let i = 0; i < s.length; i++) {
  const ch = s[i];
  if (inQuotes) {
    if (ch === '"') {
      if (s[i + 1] === '"') { field += '"'; i++; }
      else inQuotes = false;
    } else {
      field += ch;
    }
  } else if (ch === '"') {
    inQuotes = true;
  } else if (ch === ',') {
    row.push(field); field = '';
  } else if (ch === '\n') {
    row.push(field); field = '';
    rows.push(row); row = [];
  } else if (ch !== '\r') {
    field += ch;
  }
}
if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

// Column aliases: exports use Chinese headers, JSON backups use the internal names.
// Also covers Chrome / Edge (`name,url,username,password,note`), Bitwarden
// (`folder,favorite,type,name,login_uri,login_username,login_password,login_totp`)
// and 1Password (`Title,Url,Username,Password,OTPAuth,...`) exports.
//
// ⚠️ 新增导出字段必须同时加进这里（以及下面的 CSV_FIELDS）：导出端写得出、导入端认不得，
// 用户就会「导出成功、导入后数据没了」，而且没有任何报错。
const IMPORT_FIELD_ALIASES = {
name: ['name', '名称', '标题', 'title'],
url: ['url', '网址', '地址', '链接', 'link', 'login_uri', 'website'],
username: ['username', '账号', '用户名', '账户', 'user', 'account', 'login', 'login_username'],
password: ['password', '密码', 'pwd', 'pass', 'login_password'],
notes: ['notes', '备注', '说明', 'note', 'remark', 'comment'],
tags: ['tags', '标签', 'tag', 'folder'],
envType: ['envtype', '环境类型', '环境', 'env'],
totp: ['totp', 'login_totp', 'otpauth', 'otp', 'totpsecret', '两步验证密钥', '两步验证', '动态口令密钥'],
favorite: ['favorite', 'starred', '收藏', '置顶'],
createdAt: ['createdat', '创建时间'],
updatedAt: ['updatedat', '修改时间'],
passwordUpdatedAt: ['passwordupdatedat', '密码修改时间', '密码更新时间'],
customFields: ['customfields', '自定义字段', '自定义项'],
accounts: ['accounts', '其他账号', '其他角色账号', '多角色账号'],
attachments: ['attachments', '附件'],
};

/**
 * 导出用的列清单（顺序即列顺序）。
 *
 * 放在 csv.js 而不是 ipc-vault-io.js 的原因：导出端（ipc-vault-io）与导入端（本文件）
 * 必须共用同一份字段定义，否则「导出写了、导入不认」这类问题会反复出现。
 * 本文件是纯函数模块（无 Electron 依赖），导出端 require 它即可。
 */
const CSV_FIELDS = [
  'name', 'envType', 'url', 'username', 'password', 'notes', 'tags',
  'totpSecret', 'favorite', 'passwordUpdatedAt',
  'customFields', 'accounts', 'attachments',
  'createdAt', 'updatedAt',
];

const CSV_HEADERS = {
  name: '名称', envType: '环境类型', url: '网址', username: '账号',
  password: '密码', notes: '备注', tags: '标签',
  totpSecret: '两步验证密钥', favorite: '收藏', passwordUpdatedAt: '密码修改时间',
  customFields: '自定义字段', accounts: '其他账号', attachments: '附件',
  createdAt: '创建时间', updatedAt: '修改时间',
};

/**
 * 结构化字段（数组里装的是对象）必须走 JSON。
 *
 * 为什么不用 `k=v;k=v`：这些值天然会包含 `;` `=` `,` 和引号（密码、备注、URL 查询串），
 * 拼装端要么自己转义要么丢数据；而 CSV 本身还有一层 `""` 引号转义 —— 两层转义叠在一起，
 * 手写解析几乎必然出错。JSON 只有一层（CSV 的引号转义），导入端 JSON.parse 原样还原，
 * 且天然支持嵌套（attachments 里的 mime/kind 这类可选字段不会丢）。
 */
const JSON_FIELDS = ['customFields', 'accounts', 'attachments'];

/** 把条目字段转成单元格字符串（CSV / XLSX 共用同一套规则，避免两条路径行为不一致） */
function serializeField(key, v) {
  if (JSON_FIELDS.includes(key)) {
    if (!Array.isArray(v) || v.length === 0) return '';
    return JSON.stringify(v);
  }
  if (key === 'favorite') return v ? 'true' : '';
  if (Array.isArray(v)) return v.join(';');
  return v == null ? '' : String(v);
}

/**
 * `includePasswords: false` 时把凭据类字段一并清空。
 *
 * 以前只清 `password`，因为别的字段根本没导出；现在 TOTP 密钥、多角色账号密码、
 * 标记为 secret 的自定义字段都会进文件 —— 只清 password 等于「说不含密码，实际全在里面」。
 */
function stripSecrets(entry) {
  const out = { ...entry, password: undefined };
  if (out.totpSecret) out.totpSecret = '';
  if (Array.isArray(out.accounts)) {
    out.accounts = out.accounts.map(a => ({ ...a, password: '' }));
  }
  if (Array.isArray(out.customFields)) {
    out.customFields = out.customFields.map(f => (f && f.secret ? { ...f, value: '' } : f));
  }
  return out;
}

/**
 * 把导出的 JSON 字符串列解析回数组。
 * 解析失败返回 undefined（**忽略该字段，不让整行失败**）：用户手改过的 CSV 里
 * 这一列可能是随便写的文字，为此丢掉整条记录不值得。
 */
function parseJsonField(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return undefined;
  // 兼容 Excel 把 JSON 里的双引号写成两个双引号的情况（sheet_to_json 一般已还原）
  const candidates = [s, s.replace(/""/g, '"')];
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (Array.isArray(v)) return v;
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

/** 从 otpauth:// 链接或纯密钥里取出 Base32 secret */
function extractTotpSecret(raw) {
const value = String(raw || '').trim();
if (!value) return '';
const m = value.match(/[?&]secret=([A-Za-z2-7]+)/i);
if (m) return m[1].toUpperCase();
if (/^[A-Za-z2-7\s]{16,}$/.test(value)) return value.replace(/\s/g, '').toUpperCase();
return '';
}

const ENV_ALIASES = {
production: 'production', prod: 'production', '正式': 'production', '生产': 'production',
testing: 'testing', test: 'testing', '测试': 'testing',
development: 'development', dev: 'development', '开发': 'development',
staging: 'staging', '预发布': 'staging', '预发': 'staging',
};

function normalizeImportRecords(records) {
if (!Array.isArray(records)) return [];

// Excel writes dates as serial numbers (days since 1899-12-30); CSV users type text.
const toIso = (v) => {
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const raw = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(raw) && Number(raw) > 20000 && Number(raw) < 100000) {
    const ms = Date.UTC(1899, 11, 30) + Number(raw) * 86400000;
    return new Date(ms).toISOString();
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
};

return records.map(raw => {
  if (!raw || typeof raw !== 'object') return null;
  const flat = {};
  for (const [k, v] of Object.entries(raw)) {
    flat[String(k).trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
  }
  const pick = (key) => {
    for (const alias of IMPORT_FIELD_ALIASES[key]) {
      const v = flat[alias];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return '';
  };

  const tagsRaw = flat.tags !== undefined ? String(flat.tags) : pick('tags');
  const tags = tagsRaw
    ? tagsRaw.split(/[;,、|]/).map(t => t.trim()).filter(Boolean)
    : [];

  const envRaw = pick('envType');
  const envType = envRaw ? (ENV_ALIASES[envRaw.toLowerCase()] || ENV_ALIASES[envRaw] || envRaw) : 'production';

  const name = pick('name');
  const url = pick('url');
  if (!name && !url) return null;

  const customFields = parseJsonField(pick('customFields'));
  const accounts = parseJsonField(pick('accounts'));
  const attachments = parseJsonField(pick('attachments'));

  return {
    // Keep original ids/timestamps when re-importing an exported JSON file.
    ...(raw.id ? { id: String(raw.id) } : {}),
    name,
    url,
    username: pick('username'),
    password: pick('password'),
    notes: pick('notes'),
    envType,
    tags,
    ...(extractTotpSecret(pick('totp')) ? { totpSecret: extractTotpSecret(pick('totp')) } : {}),
    ...(/^(true|1|yes|是|★)$/i.test(pick('favorite')) ? { favorite: true } : {}),
    ...(toIso(pick('passwordUpdatedAt')) ? { passwordUpdatedAt: toIso(pick('passwordUpdatedAt')) } : {}),
    ...(customFields ? { customFields } : {}),
    ...(accounts ? { accounts } : {}),
    ...(attachments ? { attachments } : {}),
    ...(toIso(pick('createdAt')) ? { createdAt: toIso(pick('createdAt')) } : {}),
    ...(toIso(pick('updatedAt')) ? { updatedAt: toIso(pick('updatedAt')) } : {}),
  };
}).filter(Boolean);
}
module.exports = {
  parseCsv,
  IMPORT_FIELD_ALIASES,
  ENV_ALIASES,
  extractTotpSecret,
  normalizeImportRecords,
  CSV_FIELDS,
  CSV_HEADERS,
  JSON_FIELDS,
  serializeField,
  stripSecrets,
  parseJsonField,
};
