/**
 * 体检命中明细表
 *
 * 原 AuditTab 里那段「空态 + .dev-scroll 表格」的 JSX，整体搬出来；props 与原作用域一一对应。
 *
 * 来源：t52 把 `src/pages/CodeAudit.tsx`（798 行）按 `docs/拆分-渲染层.md` §3.2 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { Empty, Icons } from '../ui';
import { SEVERITY_TEXT } from './scanModel';
import type { ScanFinding } from './scanModel';

export function FindingsTable({
  findings,
  onReveal,
}: {
  findings: ScanFinding[];
  onReveal: (f: ScanFinding) => void;
}) {
  return (
              findings.length === 0
                ? (
                  <Empty
                    compact
                    icon={<Icons.check size={20} />}
                    title="这次没有命中"
                    desc="勾选的规则一条都没命中。注意这是启发式检查：没命中不等于没问题。"
                    hint="可以少勾几条规则再扫一次，看是不是规则被筛掉了。"
                  />
                )
                : (
                  <div className="dev-scroll" style={{ maxHeight: 460 }}>
                    <table className="tbl" style={{ tableLayout: 'fixed', width: '100%' }}>
                      <caption style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
                        体检命中明细：规则 / 文件 / 行 / 命中原文 / 严重度
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col" style={{ width: 170 }}>规则</th>
                          <th scope="col">文件</th>
                          <th scope="col" style={{ width: 56 }}>行</th>
                          <th scope="col" style={{ width: 260 }}>命中原文</th>
                          <th scope="col" style={{ width: 64 }}>严重度</th>
                          <th scope="col" style={{ width: 92 }}>结论</th>
                          <th scope="col" style={{ width: 64 }} />
                        </tr>
                      </thead>
                      <tbody>
                        {findings.map((f, i) => (
                          <tr key={`${f.ruleId}-${f.file}-${f.line}-${i}`}>
                            <td title={f.title} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</td>
                            <td title={f.file} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.file}</td>
                            <td>{f.line}</td>
                            <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <code title={f.snippet}>{f.snippet || '—'}</code>
                            </td>
                            <td>{SEVERITY_TEXT[f.severity] || f.severity}</td>
                            <td><span className="dev-tag is-heur">启发式</span></td>
                            <td>
                              <button className="btn btn-ghost btn-sm" onClick={() => void onReveal(f)} aria-label={`定位 ${f.file} 第 ${f.line} 行`}>
                                <Icons.link size={13} /> 定位
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