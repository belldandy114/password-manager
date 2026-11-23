import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { copyPlain } from '../utils/clipboard';
import { extractVars, fillVars, parseVarHint, dateVarKind, dateVarValue } from '../utils/sqlVars';

/**
 * 「填充变量并复制」弹窗（从 SqlSnippets.tsx 抽出来，1.32 第二批 D）。
 *
 * SQL 片段页与测试笔记页共用这一只弹窗，**纯逻辑仍全部走 utils/sqlVars.ts**
 * （extractVars / fillVars / parseVarHint），这里只做展示与两次剪贴板调用。
 *
 * 行为契约（抽取时保持逐字不变，既有 37 条用例是回归锁）：
 * - 输入框按 `{{变量}}` 首次出现顺序生成，「变量说明」里的释义显示在标签旁；
 * - 底部预览与「替换并复制」调用同一个 `fillVars` —— 预览到什么就复制什么；
 * - 留空的变量保留原样；「复制原文」是另一条独立路径，不做任何替换；
 * - 关窗即丢：`open` 变 true 时清空上次填的值，重开重新填。
 */
export interface CopyVarsModalProps {
  open: boolean;
  content: string;
  /** 「变量说明」原文（`{{a}} = 说明；…`），可缺省 */
  varHint?: string;
  /** 标题：SQL 页传「填充变量并复制 SQL」，其它页面用默认文案 */
  title?: string;
  onClose: () => void;
  /** 复制成功后的提示文案，由页面决定展示位置与措辞 */
  onCopied: (message: string) => void;
}

export function CopyVarsModal({
  open,
  content,
  varHint = '',
  title = '填充变量并复制',
  onClose,
  onCopied,
}: CopyVarsModalProps) {
  const [vals, setVals] = useState<Record<string, string>>({});
  // 关窗即丢：只在「打开」这一刻清空，输入过程中（open 一直是 true）不重置
  useEffect(() => {
    if (open) setVals({});
  }, [open]);

  /** 变量按正文首次出现顺序去重；释义来自「变量说明」字段（可缺） */
  const vars = useMemo(() => extractVars(content), [content]);
  const hints = useMemo(() => parseVarHint(varHint), [varHint]);
  /** 实时预览：与「替换并复制」走同一个 fillVars，预览什么就复制什么 */
  const preview = useMemo(() => fillVars(content, vals), [content, vals]);

  /** 原文复制：不做任何替换（有变量时也照原样出去） */
  const copyOriginal = async () => {
    await copyPlain(content);
    onCopied('已复制原文');
    onClose();
  };

  /** 替换并复制：留空的变量保留原样，提示里报告实际替换了几个，避免「以为都换了」 */
  const copyFilled = async () => {
    await copyPlain(preview);
    const filled = vars.filter(v => String(vals[v] || '').trim() !== '').length;
    onCopied(vars.length === 0
      ? '已复制（没有变量）'
      : `已复制（替换 ${filled} / ${vars.length} 个变量）`);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn btn-secondary" onClick={() => void copyOriginal()}>复制原文</button>
          <button className="btn btn-primary" onClick={() => void copyFilled()}>替换并复制</button>
        </>
      }
    >
      {open && (
        <>
          <div className="text-sm text-muted" style={{ marginBottom: 12 }}>
            {vars.length > 0
              ? `检测到 ${vars.length} 个变量，留空则保留原样。`
              : '这段内容里没有 {{变量}}，可以直接复制。'}
          </div>
          {vars.map((v, i) => {
            /* 常用日期变量（today / now / today±Nd）：输入框右侧给一键填值按钮。
               不认识的变量名不给按钮（§3.B「不猜」）。 */
            const kind = dateVarKind(v);
            const fillLabel = kind === 'datetime' ? '填现在' : '填今天';
            return (
              <div
                className="form-group"
                key={v}
                style={kind ? { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } : undefined}
              >
                <label
                  htmlFor={`copy-var-${i}`}
                  style={kind ? { flex: '0 0 100%' } : undefined}
                >
                  {`{{${v}}}`}
                  {hints[v] && (
                    <span className="text-sm text-muted" style={{ fontWeight: 400, marginLeft: 8 }}>{hints[v]}</span>
                  )}
                </label>
                {/* ⚠️ input 必须保持 .form-group 的直接子元素：
                    html[data-bg='image'] .modal .form-group > input 是玻璃底的选择器（redesign.css:8203），
                    外面再包一层 div 会让背景图模式下这个框回到不透明实底（E 片弹窗扫描会红）。
                    所以这里用行内 flex 排 label / input / button 三个直接子元素。 */}
                <input
                  id={`copy-var-${i}`}
                  aria-label={`变量 ${v}`}
                  value={vals[v] || ''}
                  onChange={e => setVals({ ...vals, [v]: e.target.value })}
                  placeholder={hints[v] ? `填值（${hints[v]}）` : '填这个变量的值'}
                  spellCheck={false}
                  data-autofocus={i === 0 ? '1' : undefined}
                  style={kind ? { flex: '1 1 220px', width: 'auto', minWidth: 0 } : undefined}
                />
                {kind && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    data-fill-var={v}
                    title={kind === 'datetime' ? '填成本机当前时间' : '填成本机当前日期'}
                    style={{ flex: '0 0 auto' }}
                    onClick={() => setVals(p => ({ ...p, [v]: dateVarValue(v, new Date()) }))}
                  >{fillLabel}</button>
                )}
              </div>
            );
          })}
          <div className="form-group">
            <label>{vars.length > 0 ? '替换结果预览' : '原文预览'}</label>
            <pre className="code2 sql-var-preview" style={{ maxHeight: 180, overflow: 'auto', margin: 0 }}>{preview}</pre>
          </div>
        </>
      )}
    </Modal>
  );
}
