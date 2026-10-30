'use strict';

/**
 * 找到打包目录里的主程序 exe。
 *
 * 1.8.0 应用改名（测试工具 → 测试中台），exe 文件名也跟着变。
 * 回归脚本不要写死名字：新名优先，旧名兜底，这样改名前后的包都能跑。
 */
const fs = require('fs');
const path = require('path');

function pickExe(dir) {
  const candidates = ['测试中台.exe', '测试工具.exe'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  // 都没有就返回新名字（错误信息里能看到期望路径）
  return path.join(dir, candidates[0]);
}

module.exports = { pickExe };
