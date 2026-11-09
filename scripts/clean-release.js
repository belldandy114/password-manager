'use strict';

/**
 * clean-release.js —— 清理 release/ 里堆积的历史安装包。
 *
 * 每个版本会留下两份 exe（中文名 + 英文资产名），长期发版能堆到 1 GB+。
 * 默认 dry-run 只列清单；确认后加 --apply 才删除。
 *
 *   node scripts/clean-release.js            # 看会删什么
 *   node scripts/clean-release.js --apply   # 真删（保留当前版本 + 最近 6 个文件）
 *   node scripts/clean-release.js --keep 10 --apply
 *
 * ⚠️ 本机有文件级删除拦截：fs.unlinkSync 通常会被转到回收站，目录会干净但磁盘空间
 *    不一定立刻释放；要真正释放请清空回收站（Windows 用 cmd rd /s /q）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'release');
const current = require(path.join(ROOT, 'package.json')).version;
const apply = process.argv.includes('--apply');
const keepArg = process.argv.find(a => a.startsWith('--keep='));
const keep = keepArg ? Math.max(1, Number(keepArg.split('=')[1]) || 6) : 6;

if (!fs.existsSync(DIR)) {
  console.log('release/ 不存在，无需清理');
  process.exit(0);
}

const all = fs.readdirSync(DIR)
  .filter(f => /\.exe$/i.test(f))
  .map(f => {
    const p = path.join(DIR, f);
    const st = fs.statSync(p);
    return { f, p, mtime: st.mtimeMs, mb: st.size / 1048576 };
  })
  .sort((a, b) => b.mtime - a.mtime);

const protectedNow = all.filter(x => x.f.includes(current));
const deletable = all.filter(x => !x.f.includes(current));
const doomed = deletable.slice(Math.max(0, keep - protectedNow.length));

console.log(`release/ 共 ${all.length} 个 exe，合计 ${(all.reduce((s, x) => s + x.mb, 0) / 1024).toFixed(2)} GB`);
console.log(`当前版本 ${current} 的 ${protectedNow.length} 个文件始终保留；保留最近 ${keep} 个文件`);
if (!doomed.length) {
  console.log('没有需要清理的旧包');
  process.exit(0);
}
for (const x of doomed) console.log(`  ${apply ? '删除' : '将删除'}  ${x.f}  ${x.mb.toFixed(1)} MB`);
if (!apply) {
  console.log('\n这是 dry-run。确认无误后加 --apply 才会真正删除。');
  process.exit(0);
}
let n = 0;
for (const x of doomed) {
  try { fs.unlinkSync(x.p); n++; } catch (e) { console.warn(`  删除失败 ${x.f}: ${e.message}`); }
}
console.log(`\n已删除 ${n}/${doomed.length} 个旧包（本机可能进回收站，磁盘空间需另行核对）`);
