/**
 * 禅道测试配置：只从环境变量读，仓库里不保存任何真实地址/账号/密码。
 *
 * 之前这些脚本把 baseUrl / account / password 直接写在源码里，
 * 而仓库是公开的 —— 等于把内网地址和账号密码一起公布了。
 *
 * 用法（PowerShell，仅本机临时设置）：
 *   $env:ZT_BASEURL  = 'http://<你的禅道>/zentao'
 *   $env:ZT_ACCOUNT  = '<账号>'
 *   $env:ZT_PASSWORD = '<密码>'
 *   node scripts/ui-round2-test.js
 *
 * 未配置时脚本里的禅道相关断言会自己跳过或报错，不会静默使用别人的账号。
 */
const base = process.env.ZT_BASEURL || '';

module.exports = {
  base,
  baseUrl: base,
  account: process.env.ZT_ACCOUNT || '',
  password: process.env.ZT_PASSWORD || '',
  ready: Boolean(base && process.env.ZT_ACCOUNT && process.env.ZT_PASSWORD),
};
