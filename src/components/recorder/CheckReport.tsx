/**
 * 校验报告（`04-视觉方向.md` §1.4；锚点见 `03-验收方案.md` §5.1 AC-2 / AC-3）。
 *
 * 三条写死的口径：
 * 1. **根类 `.rec-report` + `.rec-report tbody tr[data-step-id]` + `td[data-col="count"]`**：
 *    AC-2 的判据是「`tbody tr` 行数 = 该会话步骤数、每行命中数是整数」——所以**每个步骤一行**，
 *    没有定位器的步骤也占一行（命中数写 0 并在结论列说明原因），不许为了好看少一行。
 * 2. **命中数只写纯数字**（`/^\d+$/`）：不写「3 个」、不加千分位、不用 `—` 占位。
 * 3. **两个落库入口都在这里**（AC-3 的两个方向）：`[data-act="record-save"]` 只写唯一命中的元素，
 *    `[data-act="record-save-anyway"]` 才带「命中 0 / 多命中」。两者的二次确认在页面里做，
 *    本组件只负责「渲染结论 + 报数 + 发事件」。
 *
 * 视觉：全部复用既有类（`.pnl` / `.tbl` / `.dev-scroll` / `.dev-tag` / `.dev-banner` / `.rec-row`），
 * 本文件零新增样式、零色值字面量。
 */

import { Panel } from '../ui';
import { conclusionOf, type CheckRow } from '../../utils/record/recorderModel';
import { ACTION_LABEL } from './CandidateCard';

interface Props {
  rows: CheckRow[];
  /** 校验时刻（ISO）；显示成 HH:MM:SS */
  at: string;
  /** 会话已结束 → 「重新校验」不可用（`record:validate` 会回「会话已结束」） */
  sessionEnded: boolean;
  saving: boolean;
  /** 上一次保存的结果（成功才给；失败由页面 toast） */
  savedMessage: string;
  onSave: () => void;
  onSaveAnyway: () => void;
  onRevalidate: () => void;
}

/** 汇总：唯一命中 / 多命中 / 命中 0 / 近似或超时 */
function summarize(rows: CheckRow[]) {
  let ok = 0;
  let heur = 0;
  let fail = 0;
  let other = 0;
  for (const r of rows) {
    const tone = conclusionOf(r).tone;
    if (tone === 'is-ok') ok += 1;
    else if (tone === 'is-heur') heur += 1;
    else if (tone === 'is-fail') fail += 1;
    else other += 1;
  }
  return { ok, heur, fail, other };
}

export function CheckReport({
  rows, at, sessionEnded, saving, savedMessage, onSave, onSaveAnyway, onRevalidate,
}: Props) {
  const { ok, heur, fail, other } = summarize(rows);
  const meta = `${rows.length} 步 · 唯一命中 ${ok} · 多命中 ${heur} · 命中 0 ${fail} · 近似/超时 ${other}`;
  const clock = at ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : '';
  // 「仍要保存」只在这两类行上才有意义：命中 0 / 多命中（超时与没定位器的行根本没法用，不给写）
  const forceable = rows.filter((r) => !r.recommended && !r.invalid && !!r.strategy && !!r.selector).length;

  return (
    <Panel
      title="校验报告"
      meta={clock ? `${meta} · 校验于 ${clock}` : meta}
      tools={(
        <span className="text-sm text-muted">
          应用内只校验元素级命中数，通过 ≠ CI 通过
        </span>
      )}
    >
      <div className="rec-row" style={{ marginBottom: 10 }}>
        <button
          type="button"
          className="btn btn-primary"
          data-act="record-save"
          // **不因「没有唯一命中」而 disabled**：点了要给出可读原因（点了没反应比写不进去更难查），
          // 也让 S7 的脚本永远能点到这个锚点（disabled 元素的 click 在 Playwright 里会直接超时）
          disabled={saving}
          title={`把 ${ok} 个唯一命中的元素与这份录制一起保存到本地库`}
          onClick={onSave}
        >
          {saving ? '保存中…' : `保存到元素库（${ok}）`}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          data-act="record-save-anyway"
          disabled={saving}
          title={forceable === 0
            ? '当前没有「命中 0 / 多命中」的定位器需要强制写入'
            : `强制写入 ${forceable} 个不可用定位器（会二次确认）`}
          onClick={onSaveAnyway}
        >
          仍要保存（{forceable}）
        </button>
        <span className="text-sm text-muted">
          默认只写唯一命中的元素；命中 0 / 多命中的定位器生成产物时一定失败，所以默认不写。
        </span>
        {savedMessage ? (
          <span className="dev-tag is-ok" role="status">
            <span aria-hidden="true">✓</span>{savedMessage}
          </span>
        ) : null}
      </div>

      <div className="dev-banner is-warn">
        <span aria-hidden="true">⚠</span>
        <span>
          role / text 定位器一律「近似」，不参与「已通过」判定；判定口径是**当页命中数**，
          不是「用例通过」。
        </span>
        <span className="dev-banner-act">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={sessionEnded || saving}
            title={sessionEnded
              ? '会话已结束：停止后再校验会回「会话已结束」，要重跑请重新录制'
              : '对当前步骤重新跑一次元素级校验'}
            onClick={onRevalidate}
          >
            重新校验
          </button>
        </span>
      </div>

      <div className="rec-report">
        <div className="dev-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 56 }}>步骤</th>
                <th style={{ width: 72 }}>动作</th>
                <th>定位器</th>
                <th style={{ width: 72 }}>命中数</th>
                <th style={{ width: 64 }}>毫秒</th>
                <th style={{ width: 190 }}>结论</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const c = conclusionOf(r);
                return (
                  <tr
                    key={r.stepId || `${r.stepIndex}`}
                    data-step-id={r.stepId}
                    data-step-index={r.stepIndex}
                    // 刻意**不叫** `data-recommended`：那个锚点（AC-1 / AC-4）的语义是「候选里的唯一命中」，
                    // 只属于 `.rec-cand`。报告行的语义是「默认可落库」，两个概念共用一个属性名会让
                    // S7 的脚本读错对象（AC-4 判「该元素 data-recommended=true 即失败」，而一行
                    // count=1 的步骤天然「可落库」——它不是候选，不该被那条判据扫到）。
                    data-savable={r.recommended ? 'true' : 'false'}
                  >
                    <td className="cell-mono">{r.stepIndex + 1}</td>
                    <td>{ACTION_LABEL[r.action] || r.action}</td>
                    <td className="cell-mono" title={r.selector || undefined}>
                      {r.selector || '—'}
                    </td>
                    {/* AC-2：这一格必须是纯整数；没有命中结果时写 0（写 `—` 会被判「命中数列非整数」） */}
                    <td data-col="count">{r.count}</td>
                    <td className="cell-mono">{r.ms}</td>
                    <td>
                      <span className={`dev-tag ${c.tone}`}>
                        <span aria-hidden="true">{c.mark}</span>
                        {c.text}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}
