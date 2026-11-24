/**
 * 生成物预览与保存（两页签共用）
 *
 * GeneratedFilesView 只负责展示 / 复制 / 「保存此文件」；保存通道 saveJavaFile 也在这里。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import React, { useState } from 'react';
import { Icons } from '../ui';
import { copyPlain } from '../../utils/clipboard';
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
      {files.length > 1 && (
        <div className="tabs" role="tablist" aria-label="生成的文件">
          {files.map((f, i) => (
            <button
              key={f.path}
              type="button"
              role="tab"
              aria-selected={i === safeIdx}
              className={`tab2${i === safeIdx ? ' is-active' : ''}`}
              onClick={() => setIdx(i)}
            >
              <span>{f.path.split('/').pop()}</span>
            </button>
          ))}
        </div>
      )}

      <div className="dev-scroll" style={{ maxHeight: 420 }}>
        <pre className="tb-pre">{file.content}</pre>
      </div>

      <div className="tool-inline" style={{ marginTop: 8, flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <span className="dev-tag is-unverified">
          <Icons.bug size={13} />
          未编译验证
        </span>
        <span className="text-sm text-muted">
          生成物没有走本机 javac，能打开不等于能编译（golden 通过 ≠ 编译通过，[C-106]）。
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn btn-ghost btn-sm" onClick={() => void copyPlain(file.content)}>
          <Icons.copy size={13} /> 复制此文件
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => onSave(file, base)}>
          <Icons.download size={13} /> 保存此文件
        </button>
      </div>
      <div className="text-sm text-muted" style={{ marginTop: 4 }}>
        {file.path}
        {files.length > 1 ? ' · 多文件请逐个保存（本版本不打包 zip）' : ''}
      </div>
    </div>
  );
}