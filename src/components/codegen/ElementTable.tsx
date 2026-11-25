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
                        desc="点「加元素」加一行：名称 + 定位器 + 类型（css / xpath / 文本 / 角色）。"
                        hint="kind=role 的元素必须填 role 名称（可访问名），否则保存会被拦下来。"
                      />
                    )
                    : (
                      <div className="dev-scroll is-short mt-8">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th scope="col" style={{ width: 140 }}>名称</th>
                              <th scope="col">定位器</th>
                              <th scope="col" style={{ width: 132 }}>类型</th>
                              <th scope="col" style={{ width: 140 }}>role 名称</th>
                              <th scope="col" style={{ width: 132 }}>来源</th>
                              <th scope="col" style={{ width: 132 }}>上次校验</th>
                              <th scope="col" style={{ width: 44 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {elements.map((el, i) => {
                              const meta = metaOf ? metaOf(el) : undefined;
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
                                    placeholder='#user 或 //div[@id="app"] 或 登录'
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
                                  {el.kind === 'role'
                                    ? (
                                      <input
                                        value={el.role || ''}
                                        onChange={(e) => onPatch(i, { role: e.target.value })}
                                        placeholder="登录"
                                        maxLength={40}
                                        aria-label={`第 ${i + 1} 个元素的 role 名称`}
                                      />
                                    )
                                    : <span className="text-sm text-muted">—</span>}
                                </td>
                                {/* 来源 / 上次校验：只读文本（派生数据，不可编辑） */}
                                <td className="text-sm text-muted" data-col="source" title={meta?.sourceTitle || meta?.source || ''}>
                                  {meta ? meta.source : '—'}
                                </td>
                                <td className="text-sm text-muted" data-col="last-check" title={meta?.lastCheckTitle || meta?.lastCheck || ''}>
                                  {meta ? meta.lastCheck : '—'}
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