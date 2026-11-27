/**
 * 元素表（名称 / 定位器 / 类型 / role 名称 / 来源 / 上次校验）
 *
 * 原 ElementLibTab 里那段 .dev-scroll + .tbl 的 JSX，整体搬出来；props 与原作用域一一对应。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 *
 * 1.34.0（S6）新增两列 **来源 / 上次校验**：两列都是**派生只读**数据（由调用方按 `uiRecordings`
 * 算好传进来），不写回 `pomPages`——元素上没有 `source` / `lastCheck` 字段，也不该有
 * （`cleanPageForWrite()` 是字段白名单，加字段就会被洗）。没有派生数据时显示 `—`。
 *
 * 1.36.0（B6，裁定 Z10 / §18.3）**口径变了一半**：
 * - 「来源」列优先读元素**自带**的 `source`（`paste` / `manual` / `recorder`），老元素（没有该字段）
 *   才回退到派生文案。理由：B7 删掉录制器后 `uiRecordings` 不再有新写入方，只靠派生的话新数据
 *   这一列会**永远是空**——收敛过程中亲手造出一个恒空列。
 * - 「上次校验」列 B6 保持派生口径（B8 加了 `checkedAt / hitCount` 才改字段），但 **`pw` 例外**：
 *   pw 链应用内验不了，固定显示「未校验（pw 链需在 Playwright 中验证）」，**绝不显示命中数字**
 *   （Z9：转不出时兜底成 `page.locator("body")` 必然命中 1，拿它冒充「校验通过」就是假阳性）。
 */

import { Empty, Icons } from '../ui';
import type { PomLocatorKind } from '../../utils/codegen/pageobject';
import { KINDS } from './pomModel';
import type { PomElementRow } from './pomModel';

/** 两列的展示数据（由 `ElementLibTab` 从录制派生；纯展示，不入库） */
export interface ElementMeta {
  /** 「来源」列：引用它的录制与步骤（多条时折叠成「… 等 N 处」） */
  source: string;
  /** `title`：完整来源清单，一行一条 */
  sourceTitle?: string;
  /** 「上次校验」列：最近一次元素级校验的时间与通过数 */
  lastCheck: string;
  /** `title`：校验口径说明 */
  lastCheckTitle?: string;
}

/** 元素自带的来源字段 → 中文（裁定 Z10：B6 只加 `source` 这一个字段） */
const SOURCE_LABEL: Record<NonNullable<PomElementRow['source']>, string> = {
  paste: '粘贴导入',
  manual: '手工添加',
  recorder: '录制器',
};

/**
 * 定位器输入框的占位文案（1.37.0 / S3，契约 [A0-8] 与方案 §1.3 的 10 行表）。
 *
 * 为什么要按 kind 切换：原来是一句「#user 或 //div[@id="app"] 或 登录」把三种语法塞进一个框，
 * 扩到 10 种定位方式之后这句话既说不全也说不准——用户看到 `label 文本` 时最需要的提示是
 * 「这里填 label 的文本」，不是「这里也能填 css」。
 *
 * 文案纪律：**不写示例值以外的格式约定**（格式约定在「校验提示」里，见 `validatePage`），
 * 免得同一个约束在两个地方各说一遍、还可能说岔。
 */
const LOCATOR_PLACEHOLDER: Record<PomLocatorKind, string> = {
  css: '#user 或 .btn-primary 或 [data-x="1"]',
  xpath: '//div[@id="app"]/button[1]（不要写 xpath= 前缀）',
  text: '登录（子串、忽略大小写）',
  role: 'button（ARIA 角色名，如 button / textbox / menuitem）',
  pw: "page.getByRole('button', { name: '登录' })",
  label: '用户名（与控件关联的 label 文本）',
  placeholder: '请输入用户名',
  alttext: '公司 Logo',
  title: '悬停提示文案',
  testid: 'login-submit（data-testid 的值）',
};

/**
 * 试跑命中的口径（1.36.0 / B8）：**0 / 1 / >1 是三件事，不许合并成一句「未命中」**。
 * 注意这里只用于「已经跑过」的元素 —— 「未执行（skip）」与「需要登录」压根不写 `hitCount`，
 * 所以不会走到这里（Z9：不许把 skip 显示成 0 命中）。
 */
function settledLabel(hitCount: number): string {
  if (hitCount === 0) return '未命中';
  if (hitCount === 1) return '命中 1';
  return `命中 ${hitCount} 个`;
}

/** `2026-11-28T02:03:04.000Z` → `11-28 02:03`（本地时间；空值显示 `—`） */
function shortTime(iso?: string): string {
  if (!iso) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

export function ElementTable({
  elements,
  onPatch,
  onRemove,
  metaOf,
}: {
  elements: PomElementRow[];
  onPatch: (index: number, patch: Partial<PomElementRow>) => void;
  onRemove: (index: number) => void;
  /** 派生列取值；不传则两列显示 `—`（其它调用方不受影响） */
  metaOf?: (el: PomElementRow) => ElementMeta;
}) {
  return (
                  elements.length === 0
                    ? (
                      <Empty
                        compact
                        icon={<Icons.inbox size={20} />}
                        title="还没有元素"
                        desc="点「加元素」加一行：名称 + 定位器 + 类型（css / xpath / 文本 / 角色 / Playwright 链 / label / placeholder / alt / title / data-testid）。"
                        hint="类型选「角色（role）」时必须填可访问名，否则保存会被拦下来。"
                      />
                    )
                    : (
                      <div className="dev-scroll is-short mt-8">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th scope="col" style={{ width: 140 }}>名称</th>
                              {/*
                                定位器列显式给 240px（1.37.0 / S3）：`.tbl` 是 `table-layout: fixed`，
                                唯一没有 width 的那一列会吃掉「剩余宽度」——剩余为负时它就被压到 0，
                                输入框只剩 22px（实测 900 / 1280 档），等于这一格没法编辑。
                                fixed 布局下单元格 min-width 不参与列宽分配（写了是死声明），
                                所以下限只能写在这里。总宽超出容器由 `.dev-scroll` 横向滚动兜住。
                              */}
                              <th scope="col" style={{ width: 240 }}>定位器</th>
                              {/* 类型列 132 → 168（1.37.0 / S3 唯一的宽度增量）：
                                  最长的一项是既有的「Playwright 链（原样存）」，132px 下已被截断；
                                  再叠加 5 个新 kind 之后必须能给全文案。实测口径见方案 §1.6。 */}
                              <th scope="col" style={{ width: 168 }}>类型</th>
                              {/*
                                「可访问名」列**常驻**（非 role 行显示 —），不按 kind 增删：
                                列的出入会让整表横向跳动，而 .pnl 是 overflow:hidden，
                                跳动最坏会重现「操作列被裁」。语义依据 [A0-2]：只有 role 需要第二输入。
                              */}
                              <th
                                scope="col"
                                style={{ width: 140 }}
                                title="仅「角色（role）」类型需要：ARIA 角色对应的可访问名，最多 40 个字符"
                              >
                                可访问名
                              </th>
                              <th scope="col" style={{ width: 132 }}>来源</th>
                              <th scope="col" style={{ width: 132 }}>上次校验</th>
                              {/*
                                删除列保持 44（t22：**不改列宽合计**，七列仍是 140+240+168+140+132+132+44 = 996）。
                                实测过的行级溢出来源（不是列宽）：`.tbl td` 左右内边距各 16px，44px 的列内容盒只剩 12px，
                                而删除按钮实测 33px 宽 → 右沿 16+33=49 > 44，**每一行**因此比表格宽 5px
                                （10/10 行 `scrollWidth 1001 > clientWidth 996`，四档视口一致）。
                                修法放在样式里：给这一个操作格收紧横向内边距（redesign.css 末尾 `.dev-scroll > .tbl
                                tbody tr:has(select) > td:last-child { padding-inline: 4px }`，4+33+4=41 ≤ 44），
                                行级滚动仍归容器 `.dev-scroll`；**没有**用 overflow:hidden 去裁。
                              */}
                              <th scope="col" style={{ width: 44 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {elements.map((el, i) => {
                              const meta = metaOf ? metaOf(el) : undefined;
                              // 1.36.0（B6）：自带 source 优先；老元素（无该字段）回退派生
                              const ownSource = el.source ? SOURCE_LABEL[el.source] : '';
                              const sourceText = ownSource || (meta ? meta.source : '—');
                              const sourceTitle = ownSource
                                ? `元素自带的来源：${ownSource}${meta && meta.sourceTitle ? `\n历史录制引用：${meta.sourceTitle}` : ''}`
                                : (meta?.sourceTitle || meta?.source || '');
                              // 1.36.0（B8）：先读元素自带的试跑结果（`hitCount/checkedAt` 有写入方了：
                              // 元素库「试跑」回填 → cleanPageForWrite 白名单）。没有字段时逐级回退：
                              // pw → 固定「未校验（pw 链需在 Playwright 中验证）」；其余 → uiRecordings 派生。
                              const hasTrial = typeof el.hitCount === 'number';
                              const trialText = hasTrial
                                ? `${settledLabel(el.hitCount as number)} · ${shortTime(el.checkedAt)}`
                                : '';
                              const lastCheckText = hasTrial
                                ? trialText
                                : el.kind === 'pw'
                                  ? '未校验（pw 链需在 Playwright 中验证）'
                                  : (meta ? meta.lastCheck : '—');
                              const lastCheckTitle = hasTrial
                                ? `上次试跑：命中 ${el.hitCount} 个；时间 ${el.checkedAt || '未知'}`
                                : el.kind === 'pw'
                                  ? 'pw 链只能在 Playwright 里真跑才知道命中；应用内的浏览器定位只认 css/xpath/text/role'
                                  : (meta?.lastCheckTitle || meta?.lastCheck || '');
                              return (
                              <tr key={el.id || i}>
                                <td>
                                  <input
                                    value={el.name}
                                    onChange={(e) => onPatch(i, { name: e.target.value })}
                                    placeholder="用户名"
                                    maxLength={60}
                                    aria-label={`第 ${i + 1} 个元素的名称`}
                                  />
                                </td>
                                <td>
                                  <input
                                    value={el.locator}
                                    onChange={(e) => onPatch(i, { locator: e.target.value })}
                                    placeholder={LOCATOR_PLACEHOLDER[el.kind] || LOCATOR_PLACEHOLDER.css}
                                    maxLength={500}
                                    aria-label={`第 ${i + 1} 个元素的定位器`}
                                  />
                                </td>
                                <td>
                                  <select
                                    value={el.kind}
                                    onChange={(e) => onPatch(i, { kind: e.target.value as PomLocatorKind })}
                                    aria-label={`第 ${i + 1} 个元素的类型`}
                                  >
                                    {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
                                  </select>
                                </td>
                                <td>
                                  {/*
                                    1.37.0（S3）：只有 `kind='role'` 才渲染输入框，其余行显示 `—`。
                                    「可访问名」是 ARIA 角色 + name 的第二个维度（[A0-2]），
                                    给其它 9 种也开一个输入 = 造出「同一语义两种字段名」的历史坑。
                                  */}
                                  {el.kind === 'role'
                                    ? (
                                      <input
                                        value={el.role || ''}
                                        onChange={(e) => onPatch(i, { role: e.target.value })}
                                        placeholder="登录"
                                        maxLength={40}
                                        title="role 名称最多 40 个字符"
                                        aria-label={`第 ${i + 1} 个元素的可访问名（仅 role 类型）`}
                                      />
                                    )
                                    : <span className="text-sm text-muted">—</span>}
                                </td>
                                {/* 来源 / 上次校验：只读文本（来源可来自元素自带字段，上次校验仍是派生）。
                                    t22：这两格是**不受控文本**，`.tbl td` 没有 overflow 约束。
                                    t20 曾在此处加 `overflow:hidden + ellipsis + nowrap`（各 7 行）当兜底，
                                    实测的结论是：**那个 nowrap 才是病根** —— 把本来会折行的长文案
                                    （「未校验（pw 链需在 Playwright 中验证）」）压成一行，于是要么被裁
                                    （关键解释变成只能 hover 读到），要么 max-content 撑出列宽
                                    （`scrollWidth 263 > clientWidth 132`，四档都报）。
                                    t22 改为**允许换行**（样式在 redesign.css 末尾的 `td[data-col]` 规则里，
                                    行高与相邻格一致，不多占一行）：状态词与完整解释都是可见文本，不裁切、
                                    不靠 hover；全文仍额外放 `title` 供复制/扫读。 */}
                                <td className="text-sm text-muted" data-col="source" title={sourceTitle}>
                                  {sourceText}
                                </td>
                                <td className="text-sm text-muted" data-col="last-check" title={lastCheckTitle}>
                                  {lastCheckText}
                                </td>
                                <td>
                                  {/*
                                    删除按钮先把话说明白（RA3-01）：被录制引用的元素点了会被拦下，
                                    `title` 里提前写清楚「谁在用」，比点完弹一句「不允许」少一次往返。
                                    判定只看派生列 `meta.source`（有引用时不是「手工添加」），不额外查库。
                                  */}
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => onRemove(i)}
                                    title={
                                      meta && meta.source && meta.source !== '手工添加' && meta.source !== '—'
                                        ? `删除这一行（会被拦下：${meta.source || ''} 还在引用它）`
                                        : '删除这一行'
                                    }
                                    aria-label={`删除第 ${i + 1} 个元素`}
                                  >
                                    <Icons.trash size={13} />
                                  </button>
                                </td>
                              </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )
  );
}