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
const IMPORT_FIELD_ALIASES = {
name: ['name', '名称', '标题', 'title'],
url: ['url', '网址', '地址', '链接', 'link', 'login_uri', 'website'],
username: ['username', '账号', '用户名', '账户', 'user', 'account', 'login', 'login_username'],
password: ['password', '密码', 'pwd', 'pass', 'login_password'],
notes: ['notes', '备注', '说明', 'note', 'remark', 'comment'],
tags: ['tags', '标签', 'tag', 'folder'],
envType: ['envtype', '环境类型', '环境', 'env'],
totp: ['totp', 'login_totp', 'otpauth', 'otp'],
favorite: ['favorite', 'starred'],
createdAt: ['createdat', '创建时间'],
updatedAt: ['updatedat', '修改时间'],
};

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
    ...(/^(true|1|yes|是)$/i.test(pick('favorite')) ? { favorite: true } : {}),
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
};
