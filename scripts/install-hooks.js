/**
 * install-hooks.js —— 把 preflight 装成 git pre-push 钩子
 *
 * 目的：本机 token 没有 workflow scope，CI 门禁暂时加不进去（见 ci-quality-gate.md），
 * 先用本地钩子保证「typecheck + 单测不过就不许推送」。
 *
 * 用法：npm run hooks:install        安装/覆盖
 *      npm run hooks:install -- --off 卸载
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const hookPath = path.join(ROOT, '.git', 'hooks', 'pre-push');
const off = process.argv.includes('--off');

if (!fs.existsSync(path.join(ROOT, '.git'))) {
  console.error('不是 git 仓库，跳过');
  process.exit(0);
}

if (off) {
  if (fs.existsSync(hookPath)) fs.unlinkSync(hookPath);
  console.log('已移除 pre-push 钩子');
  process.exit(0);
}

// 已有别人的钩子就别覆盖，避免把用户自己的脚本搞丢
if (fs.existsSync(hookPath) && !fs.readFileSync(hookPath, 'utf8').includes('preflight.js')) {
  console.error('已存在自定义 pre-push 钩子，未覆盖：' + hookPath);
  console.error('如果确认要换成门禁钩子，先手动备份再删掉它。');
  process.exit(1);
}

const script = `#!/bin/sh
# 由 scripts/install-hooks.js 生成：推送前跑 typecheck + 单测
echo "▶ pre-push: 质量门禁（typecheck + 单测）"
node scripts/preflight.js || {
  echo "✗ 门禁未通过，已阻止推送。加 --no-verify 可跳过（不建议）。"
  exit 1
}
`;
fs.mkdirSync(path.dirname(hookPath), { recursive: true });
fs.writeFileSync(hookPath, script, { mode: 0o755 });
try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows 上无所谓 */ }
console.log('已安装 pre-push 钩子：' + hookPath);
console.log('卸载：npm run hooks:install -- --off');