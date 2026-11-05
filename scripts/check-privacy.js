'use strict';

/**
 * check-privacy.js —— 提交/推送前扫一遍「不该进公开仓库」的东西
 *
 * 起因：这个仓库是公开的，之前有几次把**真实姓名、禅道账号、内网地址**写进了
 * 注释、测试数据和文档（2026-11-05 又漏了一次）。光靠人记不住，这里做成门禁。
 *
 * 两层规则：
 *   1. 通用规则（写死在脚本里，仓库里不含任何真实信息）：
 *      - 内网 IP：10.x / 172.16-31.x / 192.168.x
 *      - 禅道真实地址片段、公司域名之类可以随时往 GENERIC 里加
 *   2. 本机名单（可选）：scripts/privacy-blocklist.local.js
 *      导出 { names: ['真实姓名', ...], accounts: ['账号', ...] }
 *      **这个文件被 .gitignore 忽略**，真实姓名只存在本机。
 *      没这个文件也能跑，只是只做通用检查。
 *
 * 用法：
 *   node scripts/check-privacy.js            # 扫 git 已跟踪的文件
 *   node scripts/check-privacy.js --all      # 连同未跟踪的新文件一起扫
 *   node scripts/check-privacy.js --staged   # 只扫已暂存的改动（给 pre-commit 用）
 *
 * 退出码：0 = 干净，1 = 发现疑似敏感信息。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const scanStaged = argv.includes('--staged');
const scanAll = argv.includes('--all');

/** 二进制/锁文件不扫 */
const SKIP_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.exe', '.dll', '.node',
  '.zip', '.gz', '.7z', '.mp3', '.mp4', '.woff', '.woff2', '.ttf', '.asar', '.map']);
const SKIP_FILE = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

const GENERIC = [
  { re: /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, why: '内网地址（172.16-31.x.x）' },
  { re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/, why: '内网地址（192.168.x.x）' },
  { re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, why: '内网地址（10.x.x.x）' },
];

/**
 * 教科书里的示例地址，出现在占位符 / 工具默认值里是正常的，不算泄漏。
 * 只放「大家都这么写」的那几个，别把真实内网段加进来。
 */
const EXEMPT_IPS = new Set([
  '192.168.1.1', '192.168.0.1', '192.168.1.100',
  '10.0.0.1', '10.0.0.0', '10.1.1.1',
  '172.16.0.1', '172.16.0.0', '172.18.0.1',
]);

/** 本机真实名单：只在本机存在，绝不进仓库 */
function loadBlocklist() {
  const p = path.join(__dirname, 'privacy-blocklist.local.js');
  if (!fs.existsSync(p)) return { names: [], accounts: [], source: '' };
  try {
    const m = require(p);
    return {
      names: (m.names || []).filter(Boolean),
      accounts: (m.accounts || []).filter(Boolean),
      source: path.basename(p),
    };
  } catch (e) {
    console.warn(`! 名单文件读不了（${e.message}），本次只做通用检查`);
    return { names: [], accounts: [], source: '' };
  }
}

function listFiles() {
  let out = '';
  try {
    if (scanStaged) {
      out = execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { cwd: ROOT, encoding: 'utf8' });
    } else {
      out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
      if (scanAll) {
        // 未跟踪但没被忽略的新文件：提交前最容易被忘掉的就是它们
        const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
        out += '\n' + untracked;
      }
    }
  } catch {
    out = '';
  }
  return Array.from(new Set(out.split('\n').map(s => s.trim()).filter(Boolean)));
}

const bl = loadBlocklist();
const rules = [
  ...GENERIC,
  ...bl.names.map(n => ({ re: new RegExp(escapeRe(n), 'g'), why: `真实姓名「${n}」（本机名单）` })),
  ...bl.accounts.map(a => ({ re: new RegExp(`\\b${escapeRe(a)}\\b`, 'g'), why: `真实账号「${a}」（本机名单）` })),
];

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const hits = [];
for (const rel of listFiles()) {
  const ext = path.extname(rel).toLowerCase();
  if (SKIP_EXT.has(ext) || SKIP_FILE.has(path.basename(rel))) continue;
  const abs = path.join(ROOT, rel);
  let text;
  try {
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue; // 二进制
    text = buf.toString('utf8');
  } catch { continue; }

  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const r of rules) {
      r.re.lastIndex = 0;
      if (!r.re.test(line)) continue;
      // 示例地址放行（占位符 / 工具默认值里出现是正常的）
      if (r.why.startsWith('内网地址')) {
        const ips = line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [];
        if (ips.length && ips.every(ip => EXEMPT_IPS.has(ip))) continue;
      }
      hits.push({ file: rel, line: i + 1, why: r.why, text: line.trim().slice(0, 120) });
    }
  });
}

console.log('敏感信息检查（真实姓名 / 账号 / 内网地址）');
console.log('─'.repeat(60));
console.log(`本机名单：${bl.source ? `${bl.source}（${bl.names.length} 个姓名 / ${bl.accounts.length} 个账号）` : '无（只有通用规则）'}`);
console.log(`扫描范围：${scanStaged ? '已暂存改动' : scanAll ? '已跟踪 + 未跟踪' : '已跟踪文件'}`);

if (!hits.length) {
  console.log('✓ 没发现问题');
  process.exit(0);
}

console.log(`\n✗ 发现 ${hits.length} 处疑似敏感信息：\n`);
for (const h of hits.slice(0, 40)) {
  console.log(`  ${h.file}:${h.line}  ${h.why}`);
  console.log(`    ${h.text}`);
}
if (hits.length > 40) console.log(`  …… 还有 ${hits.length - 40} 处`);

console.log('\n处理办法：');
console.log('  1) 换成占位名（张三 / 李四 / zhangsan 之类），别用真实姓名；');
console.log('  2) 内网地址换成文档保留地址（192.0.2.10 / example.com）；');
console.log('  3) 真实名单请放 scripts/privacy-blocklist.local.js（已被 .gitignore 忽略）。');
process.exit(1);
