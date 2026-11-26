/**
 * 生成物预览与保存（两页签共用）
 *
 * GeneratedFilesView 只负责展示 / 复制 / 「保存此文件」；保存通道 saveJavaFile 也在这里。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import React, { useState } from 'react';
import { Icons, CodeBlock } from '../ui';
import { copyPlain } from '../../utils/clipboard';
import { langFromPath } from '../../utils/codeHighlight';
import type { GeneratedFile } from '../../utils/codegen/escape';

/* ================================================================
   保存（两页签共用）
   ================================================================ */

/**
 * 保存一个生成的 Java 文件。
 *
 * **为什么不走 `file:save-text`（既有 `saveText` 桥）**：那个通道会**给文件加 UTF-8 BOM**
 * （`electron/ipc-api.js` 里 `fs.writeFileSync(path, '\uFEFF' + content)`，本来是给导出 CSV
 * 让 Excel 认编码用的）。`.java` 带 BOM 直接编译失败 —— 实测：
 * `javac` → `错误: 非法字符: '\ufeff'` + `需要 class、interface、enum 或 record`，exit 1。
 * 也就是说：界面上看着「保存成功」，用户拿到的文件却编不过，而「生成物必须能过 javac」是硬要求。
 *
 * 所以这里改成 `dialogSaveFile`（选路径）+ `fileWrite`（原样写，不加 BOM）。
 * 两个都是**既有 IPC**（[C-81] 零新增），DataGenerator 的导出也是这条组合。
 * 主进程的 `file:save-text` 属他人 inScope，本批不改，已在回执与验收文档点名。
 */
export async function saveJavaFile(
  file: GeneratedFile,
  defaultName: string,
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void,
  setSavedAt: React.Dispatch<React.SetStateAction<Record<string, string>>>,
): Promise<void> {
  const pick = await window.electronAPI.dialogSaveFile({
    defaultName: defaultName || 'Generated.java',
    filters: [{ name: 'Java 源文件', extensions: ['java'] }],
  });
  if (pick.canceled || !pick.filePath) return; // 用户取消不是错误（[C-03]）
  const r = await window.electronAPI.fileWrite({ filePath: pick.filePath, content: file.content });
  if (!r.success) {
    addToast(r.error || '保存失败', 'error');
    return;
  }
  setSavedAt((prev) => ({ ...prev, [file.path]: pick.filePath as string }));
  addToast(`已保存到 ${pick.filePath}`, 'success');
}

/* ================================================================
   生成物预览（两页签共用）
   ================================================================ */

export function GeneratedFilesView({
  files,
  defaultSaveName,
  onSave,
}: {
  files: GeneratedFile[];
  defaultSaveName: string;
  onSave: (file: GeneratedFile, defaultName: string) => void;
}) {
  const [idx, setIdx] = useState(0);
  const safeIdx = Math.min(idx, Math.max(0, files.length - 1));
  const file = files[safeIdx];
  if (!file) return null;

  const base = file.path.split('/').pop() || defaultSaveName;

  return (
    <div>
      {/* 1.36.0（B5）：这里原来是一条 `.tabs` + `role=tablist` + `.tab2`（第二处 tablist）。
          合并成「代码工具」后，元素库页签里再嵌一条 tablist 就成了**同页两个 tablist 嵌套**，
          而且它们切换的是同一段代码预览 —— 不是页签，是「选择哪一个文件」。所以降级成按钮组：
          保留 `.tool-tabs`（可换行卡片容器的既有类）与 `.tab2`（按钮外观，回归脚本按文字点，
          类名不能改），去掉 `role=tablist` / `role=tab` / `aria-selected`，改用
          `aria-pressed` 表达「当前选中哪个文件」。 */}
      {files.length > 1 && (
        <div className="tool-tabs" role="group" aria-label="生成的文件（选择要预览/保存的这一个）">
          {files.map((f, i) => (
            <button
              key={f.path}
              type="button"
              aria-pressed={i === safeIdx}
              className={`tab2${i === safeIdx ? ' is-active' : ''}`}
              onClick={() => setIdx(i)}
            >
              <span>{f.path.split('/').pop()}</span>
            </button>
          ))}
        </div>
      )}

      {/* 代码块自带 `.dev-scroll`（`.dev-scroll > .dev-code` 的 max-height:none 依赖 pre 是
          它的直接子元素，包装不能交给调用方 —— 见 ui.tsx 里 CodeBlock 的注释）。
          所以这里不再包一层、也不再写内联 maxHeight。 */}
      <CodeBlock code={file.content} lang={langFromPath(file.path)} />

      {/* `.tool-inline` 自带 display:flex / align-items:center / gap:8 / flex-wrap:wrap
          （pages.css:820），原来那四行内联里只有 marginTop 是它没覆盖的 → 换 `.mt-8`。
          「撑开两侧」用既有工具类 `.flex-1`（原来那个 `spacer` 类在三份样式表里没有任何
          规则，是死类名，去掉不丢东西）。 */}
      <div className="tool-inline mt-8">
        <span className="dev-tag is-unverified">
          <Icons.bug size={13} />
          未编译验证
        </span>
        <span className="text-sm text-muted">
          生成物没有走本机 javac，能打开不等于能编译（golden 通过 ≠ 编译通过，[C-106]）。
        </span>
        <span className="flex-1" />
        <button className="btn btn-ghost btn-sm" onClick={() => void copyPlain(file.content)}>
          <Icons.copy size={13} /> 复制此文件
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => onSave(file, base)}>
          <Icons.download size={13} /> 保存此文件
        </button>
      </div>
      {/* 原来是内联 marginTop:4（不在 8 的格上）→ `.mt-8`，与全站间距口径一致 */}
      <div className="text-sm text-muted mt-8">
        {file.path}
        {files.length > 1 ? ' · 多文件请逐个保存（本版本不打包 zip）' : ''}
      </div>
    </div>
  );
}