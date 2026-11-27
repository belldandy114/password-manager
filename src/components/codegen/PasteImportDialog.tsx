/**
 * 粘贴导入元素（1.36.0 / B6-B，渲染层契约 §6.2）。
 *
 * 三种输入格式（自动识别，也可手动改选解析器）：
 * 1. **DevTools Recorder 导出的 JSON** —— `steps[].selectors`；
 * 2. **Playwright codegen 脚本** —— `getByRole/getByText/locator` 链；
 * 3. **Elements 面板复制的 HTML** —— 按 id / aria-label / class 推定 css。
 *
 * 三条硬规矩（契约 §6.2，破一条这功能就变成「悄悄写库」）：
 * - **不写库**：本组件只把勾选的行交回 `onImport`，写入由父组件走
 *   `cleanPageForWrite → trimPagesForWrite → 唯一一次 wsSet('pomPages')`；
 * - **不弹第二个确认框**：预览表本身就是确认；
 * - **认不出就写 0 条**：固定文案 + 导入按钮禁用，不猜、不降级成「随便加几行」。
 *
 * 预览表 6 列（表头逐字，顺序固定）：☑ / 名称 / 类型 / 定位器 / 来源判定 / 依据+重复。
 * 「来源判定」用 `.dev-tag`：`确定`=is-ok、`推定`=is-warn、`无法识别`=is-unknown（压玻璃都 ≥3:1）。
 */

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { Icons } from '../ui';
import { KINDS, blankElement } from './pomModel';
import type { PomElementRow } from './pomModel';
import {
  detectElementPaste, parseBySource,
  type ElementPasteCandidate, type PasteSource,
} from '../../utils/codegen/elementPaste';

/** 解析器下拉的取值（`auto` = 自动识别，其余 = 手动指定） */
type SourceChoice = 'auto' | PasteSource;

const SOURCE_LABEL: Record<PasteSource, string> = {
  'recorder-json': 'DevTools Recorder JSON',
  'playwright-js': 'Playwright codegen 脚本',
  html: 'Elements HTML',
};

const CONFIDENCE_TEXT = { exact: '确定', guess: '推定', unknown: '无法识别' } as const;
const CONFIDENCE_CLS = { exact: 'is-ok', guess: 'is-warn', unknown: 'is-unknown' } as const;

/** 预览表里的一行：候选 + 用户的勾选与改名 */
interface Row {
  c: ElementPasteCandidate;
  name: string;
  checked: boolean;
  /** 与当前页已有元素 `kind+locator` 相同 → 默认不勾，并标出来 */
  duplicate: boolean;
}

export function PasteImportDialog({
  open,
  onClose,
  onImport,
  existing,
  remaining,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (rows: PomElementRow[]) => void;
  /** 当前页已有的元素（只用于判重，不改任何数据） */
  existing: PomElementRow[];
  /** 还能加几条（MAX_ELEMENTS − 已有），用于超额提示 */
  remaining: number;
}) {
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<SourceChoice>('auto');
  /** 上一次识别/解析的结论（null = 还没点过「识别」） */
  const [result, setResult] = useState<{ source: PasteSource | null; reason: string } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);

  // 每次打开都从空白开始：留着上次的粘贴内容，用户会以为「已经识别过了」
  useEffect(() => {
    if (!open) return;
    setText('');
    setChoice('auto');
    setResult(null);
    setRows([]);
  }, [open]);

  const dupKey = (kind: string, locator: string) => `${kind}|${String(locator ?? '').trim()}`;
  const existingKeys = useMemo(
    () => new Set(existing.map((el) => dupKey(el.kind, el.locator))),
    [existing],
  );

  const buildRows = (candidates: ElementPasteCandidate[]): Row[] => candidates.map((c) => {
    const duplicate = existingKeys.has(dupKey(c.kind, c.locator));
    return {
      c,
      name: c.name,
      // 默认：确定的、推定的都勾；认不出的与重复的不勾（用户可手动勾）
      checked: c.confidence !== 'unknown' && !duplicate,
      duplicate,
    };
  });

  /**
   * 解析。`next` 与当前 `choice` 不同时表示用户刚改了下拉 —— 那是**只重解析、不重新识别**
   * （契约 §6.2：改选解析器不能偷偷把格式判成别的）。
   */
  const run = (next: SourceChoice = choice) => {
    if (next === 'auto') {
      const r = detectElementPaste(text);
      setResult({ source: r.source, reason: r.reason });
      setRows(buildRows(r.candidates));
      return;
    }
    const candidates = parseBySource(next, text);
    setResult({
      source: next,
      reason: candidates.length
        ? `按你选的「${SOURCE_LABEL[next]}」解析（只是重新解析，没有重新识别格式）`
        : `按你选的「${SOURCE_LABEL[next]}」解析后没有得到元素 —— 换一种格式试试`,
    });
    setRows(buildRows(candidates));
  };

  const checked = rows.filter((r) => r.checked);
  const overQuota = checked.length > remaining;

  const doImport = () => {
    if (!checked.length || overQuota) return;
    const payload = checked.map((r) => ({
      // id 走 `blankElement()` 同一条路径（[C-110] 写端必填，新建那一刻就定下来）
      ...blankElement(),
      name: r.name.trim() || r.c.name,
      locator: r.c.locator,
      kind: r.c.kind,
      ...(r.c.role ? { role: r.c.role } : {}),
      source: 'paste' as const,
    }));
    onImport(payload);
    onClose();
  };

  const footer = (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>取消</button>
      <button
        type="button"
        className="btn btn-primary btn-sm"
        onClick={doImport}
        disabled={!checked.length || overQuota}
        title={
          overQuota
            ? `这个页面还能加 ${remaining} 个元素，请少勾几行`
            : '把勾选的行并入当前页面（脏数据会先被 validatePage 拦下，不会写库）'
        }
      >
        <Icons.plus size={13} /> 导入 {checked.length} 条
      </button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title="粘贴导入元素" className="paste-import" footer={footer}>
      <div className="text-sm text-muted mb-8">
        支持三种来源：DevTools Recorder 导出的 JSON、Playwright codegen 脚本、Elements 面板复制的 HTML。
        粘进来点「识别」，确认后再导入；导入会把勾选的行并入当前页面并落库（走的就是「保存页面」那一条路径：cleanPageForWrite → trimPagesForWrite → 唯一一次 ws:set）。
      </div>

      <div className="tool-inline mb-8">
        <select
          value={choice}
          aria-label="解析器"
          onChange={(e) => {
            const next = e.target.value as SourceChoice;
            setChoice(next);
            // 改选 → 只重解析（不重新识别）；还没粘内容时不动
            if (text.trim()) run(next);
          }}
        >
          <option value="auto">自动识别</option>
          <option value="recorder-json">DevTools Recorder</option>
          <option value="playwright-js">Playwright codegen</option>
          <option value="html">Elements HTML</option>
        </select>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => run()}>
          <Icons.search size={13} /> 识别
        </button>
        <span className="dev-tag is-unknown">
          本页还能加 {Math.max(0, remaining)} 个元素
        </span>
      </div>

      <textarea
        className="paste-import-input"
        value={text}
        aria-label="要识别的粘贴内容"
        onChange={(e) => setText(e.target.value)}
        placeholder={'把 Recorder 导出的 JSON / Playwright codegen 脚本 / Elements 复制的 HTML 粘到这里'}
        rows={10}
        spellCheck={false}
      />

      {result && result.source === null && (
        <div className="dev-banner is-error mt-8" role="alert">
          <Icons.bug size={14} />
          <div className="text-sm">{result.reason}</div>
        </div>
      )}
      {result && result.source !== null && (
        <div className="dev-banner is-warn mt-8" role="status">
          <Icons.copy size={14} />
          <div className="text-sm">
            识别为「{SOURCE_LABEL[result.source]}」格式。依据：{result.reason}
          </div>
        </div>
      )}

      {result && result.source !== null && rows.length === 0 && (
        <div className="text-sm text-muted mt-8">这段内容里没有解析出可导入的元素（写 0 条）。</div>
      )}

      {rows.length > 0 && (
        <div className="dev-scroll is-short mt-8">
          <table className="tbl">
            <thead>
              <tr>
                <th scope="col" style={{ width: 36 }}>☑</th>
                <th scope="col" style={{ width: 150 }}>名称</th>
                <th scope="col" style={{ width: 132 }}>类型</th>
                <th scope="col">定位器</th>
                <th scope="col" style={{ width: 96 }}>来源判定</th>
                <th scope="col" style={{ width: 260 }}>依据</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.c.kind}|${r.c.locator}|${i}`}>
                  <td>
                    <input
                      type="checkbox"
                      checked={r.checked}
                      aria-label={`勾选第 ${i + 1} 条`}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, checked: e.target.checked } : x)))}
                    />
                  </td>
                  <td>
                    <input
                      value={r.name}
                      maxLength={60}
                      aria-label={`第 ${i + 1} 条元素名`}
                      onChange={(e) => setRows((prev) => prev.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                  </td>
                  <td className="text-sm">{KINDS.find((k) => k.id === r.c.kind)?.label || r.c.kind}</td>
                  <td className="text-sm" title={r.c.locator}>
                    {r.c.locator.length > 64 ? `${r.c.locator.slice(0, 64)}…` : r.c.locator}
                  </td>
                  <td>
                    <span className={`dev-tag ${CONFIDENCE_CLS[r.c.confidence]}`}>
                      {CONFIDENCE_TEXT[r.c.confidence]}
                    </span>
                    {r.duplicate && <span className="dev-tag is-unknown mt-8">重复（已有）</span>}
                  </td>
                  <td className="text-sm text-muted">{r.c.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
