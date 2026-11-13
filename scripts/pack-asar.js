/**
 * pack-asar.js — 把当前构建产物组装成 app.asar（不依赖 electron-builder）
 *
 * 为什么需要它：本机的安全删除钩子会拦截 electron-builder 清理
 * release/win-unpacked 的动作（>50 文件），导致打包中断；而且手工组包时
 * 容易误把上一轮的旧 dist 打进去。这个脚本把整套动作固化并加断言。
 *
 * 用法：npm run pack:asar
 * 前置：npm run build:renderer
 */
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const ROOT = path.resolve(__dirname, '..');
const STAGE = path.join(ROOT, '.asar-stage');
const RES = path.join(ROOT, 'release', 'win-unpacked', 'resources');
const OUT = path.join(RES, 'app.asar');
const UNPACKED = path.join(RES, 'app.asar.unpacked');
const NM = path.join(ROOT, 'node_modules');

const IGNORE = new Set(['*.md', 'LICENSE*', 'coverage', '.github', 'test', 'tests']);
function ignoreFn(_src, _name) { return false; }
function copyDir(src, dst) {
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (s) => {
      const base = path.basename(s);
      for (const pat of IGNORE) {
        if (pat === '*.md' && base.endsWith('.md')) return false;
        if (pat === 'LICENSE*' && base.startsWith('LICENSE')) return false;
        if ((pat === 'coverage' || pat === '.github' || pat === 'test' || pat === 'tests') && base === pat) return false;
      }
      return true;
    },
  });
}

/** 递归收集运行时依赖闭包（主进程唯一外部依赖是 xlsx） */
function dependencyClosure(start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    const pj = path.join(NM, name, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try {
      const deps = JSON.parse(fs.readFileSync(pj, 'utf8')).dependencies || {};
      stack.push(...Object.keys(deps));
    } catch { /* 坏掉的 package.json 不阻塞 */ }
  }
  return [...seen].sort();
}

function cssHash(dir) {
  const assets = path.join(dir, 'dist', 'assets');
  if (!fs.existsSync(assets)) return [];
  return fs.readdirSync(assets).filter(f => f.endsWith('.css')).sort();
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html 不存在，请先跑 npm run build:renderer');
  }
  if (!fs.existsSync(RES)) {
    throw new Error(`resources 目录不存在：${RES}，需要先有一份 win-unpacked`);
  }

  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });

  // 1) 应用文件
  for (const d of ['dist', 'electron']) {
    const src = path.join(ROOT, d);
    if (fs.existsSync(src)) copyDir(src, path.join(STAGE, d));
  }
  for (const f of ['package.json', '图标.png', '图标.ico']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(STAGE, f));
  }
  fs.mkdirSync(path.join(STAGE, 'buildResources'), { recursive: true });
  for (const f of ['icon.png', 'icon.ico']) {
    fs.copyFileSync(path.join(ROOT, 'buildResources', f), path.join(STAGE, 'buildResources', f));
  }

  // 2) 只带运行时依赖（渲染层依赖已全部打进 dist bundle）
  const deps = dependencyClosure('xlsx');
  for (const name of deps) {
    const src = path.join(NM, name);
    if (fs.existsSync(src)) copyDir(src, path.join(STAGE, 'node_modules', name));
  }
  console.log('运行时依赖:', deps.join(', '));

  // 3) 断言：stage 里的 CSS 必须与 dist 完全一致（防旧产物竞态）
  const a = cssHash(ROOT), b = cssHash(STAGE);
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`CSS hash 不一致：dist=${a.join(',')} stage=${b.join(',')}`);
  }
  console.log('CSS hash 校验通过:', a.join(', '));

  // 4) 生成 asar
  await asar.createPackage(STAGE, OUT);
  console.log('asar 已生成:', (fs.statSync(OUT).size / 1024 / 1024).toFixed(1) + ' MB');

  // 5) asarUnpack 项：生产模式实际从这里加载图标
  fs.rmSync(UNPACKED, { recursive: true, force: true });
  fs.mkdirSync(UNPACKED, { recursive: true });
  for (const f of ['图标.png', '图标.ico']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(UNPACKED, f));
  }
  fs.mkdirSync(path.join(UNPACKED, 'buildResources'), { recursive: true });
  for (const f of ['icon.png', 'icon.ico']) {
    fs.copyFileSync(path.join(ROOT, 'buildResources', f), path.join(UNPACKED, 'buildResources', f));
  }
  console.log('app.asar.unpacked 已同步');

  fs.rmSync(STAGE, { recursive: true, force: true });
  console.log('✓ 完成');
}

main().catch(e => {
  console.error('✗ 打包失败:', e.message);
  try { fs.rmSync(STAGE, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
