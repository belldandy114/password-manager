/**
 * 元素表（名称 / 定位器 / 类型 / role 名称）
 *
 * 原 ElementLibTab 里那段 .dev-scroll + .tbl 的 JSX，整体搬出来；props 与原作用域一一对应。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { Empty, Icons } from '../ui';
import type { PomLocatorKind } from '../../utils/codegen/pageobject';
import { KINDS } from './pomModel';
import type { PomElementRow } from './pomModel';

export function ElementTable({
  elements,
  onPatch,
  onRemove,
}: {
  elements: PomElementRow[];
  onPatch: (index: number, patch: Partial<PomElementRow>) => void;
  onRemove: (index: number) => void;
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
                              <th scope="col" style={{ width: 44 }} />
                            </tr>
                          </thead>
                          <tbody>
                            {elements.map((el, i) => (
                              <tr key={i}>
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
                                <td>
                                  <button
                                    className="btn btn-ghost btn-sm"
                                    onClick={() => onRemove(i)}
                                    title="删除这一行"
                                    aria-label={`删除第 ${i + 1} 个元素`}
                                  >
                                    <Icons.trash size={13} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )
  );
}