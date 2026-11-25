/**
 * 候选卡片组 —— 一个录制步骤的全部定位器候选（`04-视觉方向.md` §1.3 的右栏）。
 *
 * **锚点是验收的分母，不是装饰**（`03-验收方案.md` §5.1 AC-1 / §5.2 AC-4）：
 * - 每张卡带 `data-strategy` / `data-count` / `data-precise` / `data-recommended`；
 * - `data-recommended="true"` **每个步骤最多一张**，且只给 `count === 1` 的那张
 *   （判据原文：「任一 `data-recommended="true"` 的 `data-count ≠ 1` 即失败」）；
 * - 一个步骤没有任何唯一命中时，**一张 recommended 都不给**——AC-1 的分母是「推荐条数 = 6」，
 *   0 条推荐必须能让断言**判失败**，不能靠「没渲染」蒙成空真。
 *
 * 视觉：卡片本体借既有 `.dev-list-item`（flex + hover + 选中态都在 `redesign.css:9124-9190`），
 * 本文件**零新增样式**；结论用 `.dev-tag` 的四个现成修饰（`.is-ok` / `.is-heur` / `.is-fail` /
 * `.is-unknown`），灰度下靠「符号 + 文案」区分（AC-18）。
 */

import { useMemo } from 'react';

import {
  pickRecommended,
  type RecordedStep,
  type UiCandidate,
} from '../../utils/record/recorderModel';

/** 动作 → 中文（与 `UiStepAction` 对齐；`session-ended` 不是步骤，不在这里） */
export const ACTION_LABEL: Record<string, string> = {
  navigate: '打开',
  click: '点击',
  fill: '输入',
  select: '选择',
  press: '按键',
  assert: '断言',
};

/** 单个候选的结论（四种，判据顺序与 `conclusionOf` 一致：命中 0 → 多命中 → 唯一 → 近似） */
export function candidateTag(c: UiCandidate): { tone: string; mark: string; text: string } {
  if (c.count === null) return { tone: 'is-unknown', mark: '~', text: '无法计数' };
  if (c.count === 0) return { tone: 'is-fail', mark: '✗', text: '命中 0（不可落库）' };
  if (c.count > 1) return { tone: 'is-heur', mark: '⚠', text: `命中 ${c.count} 个（不唯一）` };
  if (c.precise) return { tone: 'is-ok', mark: '✓', text: '唯一命中' };
  return { tone: 'is-unknown', mark: '~', text: '近似，不参与通过' };
}

interface Props {
  rec: RecordedStep;
  /** 1 起（显示用；`step.index` 也是 0 起，两者差 1 是这里唯一的换算） */
  stepNo: number;
  /** 改选候选（下标）；`-1` 表示「不用定位器」 */
  onChoose: (candidateIndex: number) => void;
}

export function CandidateCard({ rec, stepNo, onChoose }: Props) {
  const candidates = rec.candidates || [];
  // 推荐位**每次重算**，不缓存到步骤里：用户改选候选之后，推荐位仍然只认「唯一命中 + 策略优先级」
  const recommendedIndex = useMemo(() => pickRecommended(candidates), [candidates]);
  const hasRecommendation = recommendedIndex >= 0;

  return (
    <div
      className="rec-cand-group"
      data-step-id={rec.step.id}
      data-step-no={stepNo}
      data-recommended-missing={hasRecommendation ? 'false' : 'true'}
    >
      <div className="rec-cand-head">
        <span className="dev-list-name">
          第 {stepNo} 步 · {ACTION_LABEL[rec.step.action] || rec.step.action}
          {rec.target.tag ? ` <${rec.target.tag}>` : ''}
        </span>
        {hasRecommendation ? null : (
          <span className="dev-tag is-fail" title="该步骤没有任何唯一命中的定位器，落库时会被默认排除">
            <span aria-hidden="true">✗</span>无唯一命中
          </span>
        )}
      </div>

      {candidates.length === 0 ? (
        <div className="text-sm text-muted">页内没有给出候选（该步骤不可落库，也不送校验）</div>
      ) : (
        candidates.map((c, i) => {
          const tag = candidateTag(c);
          const isRecommended = i === recommendedIndex;
          return (
            <button
              key={`${c.strategy}-${i}`}
              type="button"
              className={`rec-cand dev-list-item${i === rec.chosen ? ' is-on' : ''}`}
              data-strategy={c.strategy}
              // `data-count` 必须是整数字符串；算不出来时留空串（不是 0，0 是「查过了没命中」）
              data-count={c.count === null ? '' : String(c.count)}
              data-precise={c.precise ? 'true' : 'false'}
              data-recommended={isRecommended ? 'true' : 'false'}
              aria-pressed={i === rec.chosen}
              title={`${c.strategy}：${c.selector}`}
              onClick={() => onChoose(i)}
            >
              <span className="dev-list-name" title={c.selector}>{c.selector}</span>
              <span className="dev-list-count">{c.count === null ? '—' : c.count}</span>
              <span className={`dev-tag ${tag.tone}`}>
                <span aria-hidden="true">{tag.mark}</span>
                {tag.text}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
