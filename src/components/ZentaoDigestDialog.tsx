import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from './Modal';
import { useCollection } from '../hooks/useCollection';
import type {
  ZentaoConfig, ZentaoDigestGroup, ZentaoDigestProgress, ZentaoDigestTarget, ZentaoProject,
} from '../types';
import {
  buildDigest, DEFAULT_DIGEST_OPTIONS, mergeDigest,
  type DigestOptions,
} from '../utils/weeklyDigest';
import {
  keepKnownProductIds, loadDigestPrefs, presetRange, resolveRange, saveDigestPrefs,
  type DigestPrefs, type RangePreset,
} from '../utils/digestPrefs';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 编辑器里已有的草稿：非空时默认走「合并」，不会把你手写的内容冲掉 */
  existing?: string;
  /**
   * 生成完成：markdown 正文 + 建议文件名 + 一句结果说明（合并了几个章节）。
   * `saveNow` 为 true 表示点的是「生成并保存」，直接把结果落到周报目录。
   */
  onGenerated: (markdown: string, name: string, note?: string, saveNow?: boolean) => void;
}

interface Sel {
  /** 这家公司下勾了哪些项目；空数组 = 这家公司不计入（公司是否生效只由它决定） */
  productIds: string[];
}

const labelOf = (c: ZentaoConfig) => String(c.company || c.account || c.baseUrl || '未命名');

/** 上次的统计口径（时间预设名、勾过的项目、按谁统计、排版选项） */

/** 缓存有效期：同一批项目 5 分钟内不重复拉全量 */
const CACHE_TTL = 5 * 60 * 1000;

export function ZentaoDigestDialog({ open, onClose, existing, onGenerated }: Props) {
  const { items: configs } = useCollection<ZentaoConfig>('integrations');

  /**
   * 上次用过的配置（只在本机 localStorage）。
   * 组件常驻挂载（靠 open 控制显隐），所以这里只在首次挂载读一次；
   * 之后 state 本身就是最新的，保存也走同一份 state。
   */
  const savedPrefs = useMemo<DigestPrefs | null>(() => loadDigestPrefs(), []);

  const [sel, setSel] = useState<Record<string, Sel>>({});
  const [projects, setProjects] = useState<Record<string, ZentaoProject[]>>({});
  const [query, setQuery] = useState<Record<string, string>>({});
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [projectError, setProjectError] = useState<Record<string, string>>({});

  /**
   * 时间口径只记「预设名」：存死日期会让下周打开时算出上周的数据，
   * 属于不会报错的错。只有用户手改过日期（custom）才记具体值。
   */
  const initRange = useMemo(() => resolveRange(savedPrefs), [savedPrefs]);
  const [rangeKind, setRangeKind] = useState<RangePreset>(savedPrefs?.range || 'thisWeek');
  const [from, setFrom] = useState(initRange.from);
  const [to, setTo] = useState(initRange.to);

  const [opts, setOpts] = useState<DigestOptions>({
    ...DEFAULT_DIGEST_OPTIONS,
    ...(savedPrefs?.opts || {}),
    from: initRange.from,
    to: initRange.to,
    openedBy: savedPrefs?.openedBy || {},
  });

  /** 写入方式：草稿里已经有内容时默认「合并」，不会冲掉手写段落 */
  const [writeMode, setWriteMode] = useState<'replace' | 'merge'>('replace');
  useEffect(() => {
    if (!open) return;
    setWriteMode(existing && existing.trim() ? 'merge' : 'replace');
  }, [open, existing]);

  /** 创建人筛选：候选来自一次全量拉取，也可以手输账号 */
  const [people, setPeople] = useState<Record<string, { name: string; account: string; count: number }[]>>({});
  const [pickedPeople, setPickedPeople] = useState<Record<string, string[]>>(savedPrefs?.openedBy || {});
  const [peopleInput, setPeopleInput] = useState('');
  const [peopleLoading, setPeopleLoading] = useState(false);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ZentaoDigestProgress | null>(null);
  const [error, setError] = useState('');
  const [warn, setWarn] = useState('');

  /** 全量结果缓存：「读取候选」拉过之后，「生成草稿」直接复用 */
  const cacheRef = useRef<{
    key: string; at: number;
    groups: ZentaoDigestGroup[];
    failed: { instanceId: string; name: string; error: string }[];
  } | null>(null);

  /** 有地址/账号/密码的才算可用实例 */
  const usable = useMemo(
    () => configs.filter(c => c && c.baseUrl && c.account && c.password),
    [configs],
  );

  // 打开时按「上次勾过的项目」还原；项目列表拿到后再过滤掉已删除的项目
  useEffect(() => {
    if (!open) return;
    setSel(prev => {
      const next: Record<string, Sel> = {};
      for (const c of usable) {
        next[c.id] = prev[c.id] || { productIds: savedPrefs?.productIds?.[c.id] || [] };
      }
      return next;
    });
  }, [open, usable, savedPrefs]);

  // 每次重新打开都丢掉上一次的全量缓存与候选人，避免「昨天的人名还挂着」
  useEffect(() => {
    if (!open) return;
    cacheRef.current = null;
    setPeople({});
  }, [open]);

  useEffect(() => {
    if (!open || usable.length === 0) return;
    let alive = true;
    (async () => {
      setLoadingProjects(true);
      const errs: Record<string, string> = {};
      await Promise.all(usable.map(async c => {
        try {
          const r = await window.electronAPI.zentaoProjects(c);
          if (!alive) return;
          if (r && r.success && Array.isArray(r.data)) {
            const list = r.data as ZentaoProject[];
            setProjects(prev => ({ ...prev, [c.id]: list }));
            // 项目**不预选**：一个禅道动辄 30+ 个项目，全选等于每次都把无关项目算进去。
            // 这里只做两件事：保证条目存在；把「上次勾过但已被删除」的产品 id 剔掉
            // （否则会拿着不存在的 id 去请求，看起来像点了生成没反应）。
            setSel(prev => {
              const cur = prev[c.id]?.productIds || [];
              const known = new Set(list.map(p => String(p.id)));
              const keep = cur.filter(id => known.has(id));
              if (keep.length === cur.length) return prev;
              return { ...prev, [c.id]: { productIds: keep } };
            });
          } else {
            errs[c.id] = (r && r.error) || '拉取项目失败';
          }
        } catch (e) {
          errs[c.id] = e instanceof Error ? e.message : String(e);
        }
      }));
      if (!alive) return;
      setProjectError(errs);
      setLoadingProjects(false);
    })();
    return () => { alive = false; };
  }, [open, usable]);

  // 主进程逐家拉取时的进度
  useEffect(() => {
    if (!open) return;
    const off = window.electronAPI.onZentaoDigestProgress?.(setProgress);
    return () => { if (off) off(); };
  }, [open]);

  /**
   * 点公司这一行**只展开/收起项目列表**，不碰任何勾选。
   * （前两版都栽在这：第一版点公司名等于点它的 checkbox，第二版又做成「点公司自动全选」，
   *   使用者手动去掉的项目被恢复，反馈两次。现在勾选只有前面的复选框能改。）
   */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  /**
   * 公司前面的复选框 = 这家公司的「一键全选 / 一键清空」。
   * 公司算不算统计，完全由它下面勾了几个项目决定 —— 没有「选中但空着」这种中间态。
   */
  const toggleInstance = useCallback((id: string) => {
    setSel(prev => {
      const cur = prev[id]?.productIds || [];
      const all = (projects[id] || []).map(p => String(p.id));
      // 全部选满时点一下 = 清空，其它情况（含只选了一部分）= 全选
      const isAll = all.length > 0 && all.every(p => cur.includes(p));
      return { ...prev, [id]: { productIds: isAll ? [] : all } };
    });
  }, [projects]);

  const toggleProduct = (id: string, pid: string) => {
    setSel(prev => {
      const cur = prev[id]?.productIds || [];
      const has = cur.includes(pid);
      return { ...prev, [id]: { productIds: has ? cur.filter(x => x !== pid) : [...cur, pid] } };
    });
  };

  /** 项目显示成「项目集 / 项目名」，重名项目靠项目集区分 */
  const projLabel = useCallback((p: ZentaoProject) => {
    const name = p.name || `产品 ${p.id}`;
    return p.programName ? `${p.programName} / ${name}` : name;
  }, []);

  /** 搜索后只显示匹配项；「全选」也只作用于当前可见项，符合直觉 */
  const visibleOf = useCallback((id: string) => {
    const list = projects[id] || [];
    const q = String(query[id] || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(p => projLabel(p).toLowerCase().includes(q));
  }, [projects, query, projLabel]);

  const toggleAllProducts = (id: string) => {
    const vis = visibleOf(id).map(p => String(p.id));
    if (!vis.length) return;
    setSel(prev => {
      const cur = prev[id]?.productIds || [];
      const isAll = vis.every(p => cur.includes(p));
      const next = isAll ? cur.filter(p => !vis.includes(p)) : Array.from(new Set([...cur, ...vis]));
      return { ...prev, [id]: { productIds: next } };
    });
  };

  /** 只有勾了项目的公司才参与统计（公司没有独立开关了） */
  const chosen = useMemo(
    () => usable.filter(c => (sel[c.id]?.productIds || []).length > 0),
    [usable, sel],
  );

  const hasExisting = !!(existing && existing.trim());

  const buildTargets = useCallback((): ZentaoDigestTarget[] => chosen.map(c => {
    // 空就是空：以前空数组会兜底成「全部项目」，导致点了「全不选」生成出来还是全部
    return { id: c.id, name: labelOf(c), cfg: c, productIds: sel[c.id]?.productIds || [] };
  }), [chosen, sel]);

  /** 拉全量（带缓存）：候选读取和生成草稿共用同一次请求 */
  const fetchGroups = useCallback(async (force = false) => {
    const targets = buildTargets();
    const key = JSON.stringify(targets.map(t => [t.id, [...t.productIds].sort()]));
    const hit = cacheRef.current;
    if (!force && hit && hit.key === key && Date.now() - hit.at < CACHE_TTL) return hit;

    const r = await window.electronAPI.zentaoSummaryMulti(targets);
    if (!r || !r.success) throw new Error((r && r.error) || '拉取失败');
    const data = { key, at: Date.now(), groups: r.groups || [], failed: r.failed || [] };
    cacheRef.current = data;
    return data;
  }, [buildTargets]);

  const loadPeople = async () => {
    setError(''); setWarn('');
    if (!chosen.length) { setError('先勾几个项目，再读取创建人'); return; }
    setPeopleLoading(true);
    try {
      const { groups } = await fetchGroups();
      // 按公司分开聚合：不同公司的人本来就不是同一批，混在一起选容易串
      const byInstance: Record<string, { name: string; account: string; count: number }[]> = {};
      let total = 0;
      for (const g of groups) {
        const map = new Map<string, { name: string; account: string; count: number }>();
        for (const b of g.bugs || []) {
          const account = String(b.openedByAccount || '').trim();
          const name = String(b.openedBy || '').trim() || account;
          if (!name) continue;
          const cur = map.get(name) || { name, account, count: 0 };
          cur.count += 1;
          if (!cur.account && account) cur.account = account;
          map.set(name, cur);
        }
        if (map.size) {
          byInstance[g.instanceId] = [...map.values()]
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
          total += map.size;
        }
      }
      if (!total) {
        setError('没有读到创建人信息，可以直接在输入框里填禅道账号');
        return;
      }
      setPeople(byInstance);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPeopleLoading(false);
    }
  };

  const addPerson = () => {
    // 支持逗号 / 顿号 / 空格一次加多个；手输的算给当前所有选中的公司
    const parts = peopleInput.split(/[,，、;；\s]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return;
    setPickedPeople(prev => {
      const next = { ...prev };
      for (const c of chosen) {
        next[c.id] = Array.from(new Set([...(next[c.id] || []), ...parts]));
      }
      return next;
    });
    setPeopleInput('');
  };

  const togglePerson = (instanceId: string, name: string) => {
    setPickedPeople(prev => {
      const cur = prev[instanceId] || [];
      return { ...prev, [instanceId]: cur.includes(name) ? cur.filter(x => x !== name) : [...cur, name] };
    });
  };

  /** 按公司分组的候选 + 手输的人（手输的没有计数） */
  const peopleGroups = useMemo(() => {
    const ids = Array.from(new Set([...Object.keys(people), ...Object.keys(pickedPeople)]));
    return ids.map(id => {
      const cand = people[id] || [];
      const picked = pickedPeople[id] || [];
      const extra = picked
        .filter(n => !cand.some(c => c.name === n))
        .map(name => ({ name, account: '', count: 0 }));
      const cfg = usable.find(c => c.id === id);
      return { id, name: cfg ? labelOf(cfg) : id, list: [...cand, ...extra] };
    }).filter(g => g.list.length > 0);
  }, [people, pickedPeople, usable]);

  const pickedCount = useMemo(
    () => Object.values(pickedPeople).reduce((n, arr) => n + (arr?.length || 0), 0),
    [pickedPeople],
  );

  const applyPreset = (kind: Exclude<RangePreset, 'custom'>) => {
    const r = presetRange(kind);
    setRangeKind(kind);
    setFrom(r.from);
    setTo(r.to);
  };

  /** 手改日期 = 自定义口径，下次打开原样带回来 */
  const changeDate = (which: 'from' | 'to', v: string) => {
    setRangeKind('custom');
    if (which === 'from') setFrom(v); else setTo(v);
  };

  /**
   * 把当前选择存下来，下次打开直接带出来。
   * 使用者每周只关心固定的几个项目，之前每次都要重新勾一遍。
   */
  const persistPrefs = useCallback(() => {
    saveDigestPrefs({
      range: rangeKind,
      from,
      to,
      productIds: Object.fromEntries(
        Object.entries(sel).map(([k, v]) => [k, v.productIds]).filter(([, ids]) => (ids as string[]).length > 0),
      ),
      openedBy: Object.fromEntries(
        Object.entries(pickedPeople).filter(([, arr]) => (arr || []).length > 0),
      ),
      opts: {
        layout: opts.layout,
        includeWeekly: opts.includeWeekly,
        mergeModulesOver: opts.mergeModulesOver,
        includeSummary: opts.includeSummary,
        includeNextWeek: opts.includeNextWeek,
      },
    });
  }, [rangeKind, from, to, sel, pickedPeople, opts]);

  /** 关闭前也记一次：勾好但没点生成的选择同样值得记住 */
  const handleClose = useCallback(() => {
    if (!busy) persistPrefs();
    onClose();
  }, [busy, persistPrefs, onClose]);

  const generate = useCallback(async (saveNow = false) => {
    setError('');
    setWarn('');
    if (!chosen.length) { setError('还没有勾选任何项目，先在下面的列表里勾几个'); return; }
    if (!from || !to) { setError('请选择起止日期'); return; }
    if (from > to) { setError('开始日期不能晚于结束日期'); return; }

    const targets = buildTargets();

    setBusy(true);
    setProgress(null);
    try {
      const data = await fetchGroups();
      const { groups, failed } = data;
      if (!groups.some(g => g.ok)) {
        setError(failed.length
          ? `全部失败：${failed.map(f => `${f.name}（${f.error}）`).join('；')}`
          : '没有拉到任何数据');
        return;
      }

      const result = buildDigest(groups, { ...opts, from, to, openedBy: pickedPeople });
      if (!result.projects.length) {
        const who = Object.values(pickedPeople).flat();
        setError(who.length
          ? `所选创建人（${who.join('、')}）在这些项目里没有缺陷，换个创建人或时间范围试试`
          : '选中的项目里没有缺陷数据，换个时间范围或项目试试');
        return;
      }

      // 合并模式：只替换同名项目章节，你手写的总结 / 下周计划 / 额外段落原样保留
      let markdown = result.markdown;
      let note = '';
      if (writeMode === 'merge' && existing && existing.trim()) {
        const merged = mergeDigest(existing, markdown);
        markdown = merged.markdown;
        note = merged.stats.added
          ? `已合并到原草稿：更新 ${merged.stats.updated} 个章节、新增 ${merged.stats.added} 个`
          : `已合并到原草稿：更新 ${merged.stats.updated} 个章节`;
      }

      if (failed.length) {
        setWarn(`已跳过 ${failed.length} 家公司（${failed.map(f => f.name).join('、')}）：${failed[0].error}`);
      }
      // 生成成功 = 这套配置确实可用，值得记住
      persistPrefs();
      onGenerated(markdown, `${to}.md`, note, saveNow);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }, [chosen, from, to, opts, pickedPeople, buildTargets, fetchGroups, onGenerated, writeMode, existing, persistPrefs]);

  const setOpt = <K extends keyof DigestOptions>(k: K, v: DigestOptions[K]) =>
    setOpts(prev => ({ ...prev, [k]: v }));

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="从禅道生成周报草稿"
      className="digest-modal"
      footer={
        <>
          <button className="btn btn-secondary btn-sm" onClick={handleClose} disabled={busy}>取消</button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => generate(true)}
            disabled={busy || loadingProjects}
            title="生成后直接存成文件到周报目录（同名会先问你要不要覆盖）"
          >
            生成并保存
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={() => generate(false)}
            disabled={busy || loadingProjects}
          >
            {busy ? '正在拉取…' : '生成草稿'}
          </button>
        </>
      }
    >
      <div className="digest-body">
        {/* ---- 时间范围 ---- */}
        <div className="digest-section">
          <div className="field-label">
            统计范围
            {rangeKind !== 'custom' && (
              <span className="text-muted digest-label-note">
                每次打开按当天重算{rangeKind === 'lastWeek' ? '（上周）' : ''}
              </span>
            )}
          </div>
          <div className="digest-row">
            <input
              type="date" value={from} onChange={e => changeDate('from', e.target.value)}
              disabled={busy} className="digest-date" aria-label="开始日期" />
            <span className="text-muted">至</span>
            <input
              type="date" value={to} onChange={e => changeDate('to', e.target.value)}
              disabled={busy} className="digest-date" aria-label="结束日期" />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => applyPreset('thisWeek')} disabled={busy}>本周</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => applyPreset('lastWeek')} disabled={busy}>上周</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => applyPreset('thisWeekToFriday')} disabled={busy}>本周一至周五</button>
          </div>
          <div className="pg-sub">
            主体数字是「累计口径」（和你现有周报一致）；勾选下面的「本周增量」会额外补一句本周新增/解决/关闭。
          </div>
        </div>

        {/* ---- 公司与项目 ---- */}
        <div className="digest-section">
          <div className="field-label">
            公司与项目
            {loadingProjects && <span className="text-muted" style={{ marginLeft: 8, fontWeight: 400 }}>正在读取项目列表…</span>}
          </div>

          {usable.length === 0 && (
            <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400 }}>
              还没有可用的禅道账号。请先到「缺陷管理」页添加并保存一套配置。
            </div>
          )}

          <div className="digest-instances">
            {usable.map(c => {
              const s = sel[c.id] || { productIds: [] };
              const list = projects[c.id] || [];
              const vis = visibleOf(c.id);
              const picked = s.productIds.length;
              const on = picked > 0;   // 公司是否生效 = 它下面有没有勾项目
              const visAll = vis.length > 0 && vis.every(p => s.productIds.includes(String(p.id)));
              const narrowed = vis.length !== list.length;
              return (
                <div key={c.id} className={`digest-inst${on ? ' is-on' : ''}`}>
                  <div
                    className="digest-inst-head"
                    title="点击展开 / 收起项目列表"
                    onClick={() => toggleCollapse(c.id)}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onClick={e => e.stopPropagation()}
                      onChange={() => toggleInstance(c.id)}
                      title={on ? '清空这家公司的项目' : '全选这家公司的项目'}
                    />
                    <span className="digest-inst-name">{labelOf(c)}</span>
                    <span className="text-muted digest-inst-meta">
                      {projectError[c.id]
                        ? `读取失败：${projectError[c.id]}`
                        : list.length ? `${picked}/${list.length} 个项目` : '—'}
                    </span>
                    {list.length > 0 && (
                      <button
                        type="button"
                        className="digest-all"
                        onClick={e => { e.stopPropagation(); toggleAllProducts(c.id); }}
                      >
                        {visAll ? '全不选' : '全选'}
                      </button>
                    )}
                    {list.length > 0 && (
                      <span className="digest-fold" aria-hidden="true">{collapsed[c.id] ? '▸' : '▾'}</span>
                    )}
                  </div>

                  {list.length > 0 && !collapsed[c.id] && (
                    <>
                      {list.length > 6 && (
                        <div className="digest-inst-tools">
                          <input
                            className="digest-search"
                            type="text"
                            value={query[c.id] || ''}
                            placeholder={`在 ${list.length} 个项目里搜索…`}
                            onChange={e => setQuery(prev => ({ ...prev, [c.id]: e.target.value }))}
                            onClick={e => e.stopPropagation()}
                          />
                          {narrowed && (
                            <span className="text-muted digest-search-hint">
                              匹配 {vis.length} 个
                              <button
                                type="button"
                                className="digest-link"
                                onClick={() => setQuery(prev => ({ ...prev, [c.id]: '' }))}
                              >
                                清除
                              </button>
                            </span>
                          )}
                        </div>
                      )}
                      <div className="digest-products">
                        {vis.length === 0 && (
                          <div className="text-muted digest-empty">没有匹配的项目</div>
                        )}
                        {vis.map(p => (
                          <label key={p.id} className="digest-prod" title={projLabel(p)}>
                            <input
                              type="checkbox"
                              checked={s.productIds.includes(String(p.id))}
                              onChange={() => toggleProduct(c.id, String(p.id))}
                            />
                            <span>{projLabel(p)}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ---- 创建人 ---- */}
        <div className="digest-section">
          <div className="field-label">
            创建人
            <span className="text-muted digest-label-note">按公司分开选，留空 = 该公司全部</span>
            {pickedCount > 0 && (
              <button type="button" className="digest-link digest-label-note" onClick={() => setPickedPeople({})}>
                清空选择
              </button>
            )}
          </div>
          <div className="digest-row">
            <input
              className="digest-search digest-people-input"
              type="text"
              value={peopleInput}
              placeholder="输入禅道账号或姓名，回车添加（可用逗号分隔多个）"
              disabled={busy}
              onChange={e => setPeopleInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); addPerson(); }
              }}
              onBlur={() => { if (peopleInput.trim()) addPerson(); }} aria-label="输入禅道账号或姓名，回车添加" />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={loadPeople}
              disabled={busy || peopleLoading || loadingProjects}
            >
              {peopleLoading ? '读取中…' : '读取候选'}
            </button>
          </div>
          {peopleGroups.map(g => (
            <div key={g.id} className="digest-people-group">
              <span className="digest-people-corp">{g.name}</span>
              <div className="digest-chips">
                {g.list.map(p => {
                  const on = (pickedPeople[g.id] || []).includes(p.name);
                  return (
                    <button
                      type="button"
                      key={p.name}
                      className={`digest-chip${on ? ' is-on' : ''}`}
                      onClick={() => togglePerson(g.id, p.name)}
                      title={[p.account ? `账号 ${p.account}` : '', p.count ? `${p.count} 个缺陷` : '手动添加']
                        .filter(Boolean).join(' · ')}
                    >
                      {p.name}{p.count ? ` · ${p.count}` : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="pg-sub">
            「读取候选」会先拉一次全量数据（每家公司几秒），之后点「生成草稿」直接用这份结果，不会重复请求。
          </div>
        </div>

        {/* ---- 写入方式 ---- */}
        <div className="digest-section">
          <div className="field-label">
            写入方式
            {!hasExisting && <span className="text-muted digest-label-note">当前草稿是空的</span>}
          </div>
          <div className="digest-write">
            <label className="digest-opt digest-opt-check">
              <input
                type="radio" name="digest-write" checked={writeMode === 'replace'}
                onChange={() => setWriteMode('replace')} disabled={busy}
              />
              <span>覆盖整篇</span>
            </label>
            <label className="digest-opt digest-opt-check">
              <input
                type="radio" name="digest-write" checked={writeMode === 'merge'}
                onChange={() => setWriteMode('merge')} disabled={busy || !hasExisting}
              />
              <span>合并到现有草稿</span>
            </label>
          </div>
          <div className="pg-sub">
            {writeMode === 'merge'
              ? '同名项目章节换成新数字、新项目追加到末尾；结尾总结、下周计划和你自己加的段落都不会动。'
              : '用这次生成的内容替换编辑器里的全部文字。'}
          </div>
        </div>

        {/* ---- 排版选项 ---- */}
        <div className="digest-section">
          <div className="field-label">排版</div>
          <div className="digest-opts">
            <label className="digest-opt">
              <span>分组方式</span>
              <select
                value={opts.layout}
                onChange={e => setOpt('layout', e.target.value as DigestOptions['layout'])}
                disabled={busy}
              >
                <option value="byProject">按项目平铺（一、二、三…）</option>
                <option value="byCompany">先公司，再项目</option>
              </select>
            </label>
            <label className="digest-opt">
              <span>模块超过</span>
              <input
                type="number" min={0} max={60}
                value={opts.mergeModulesOver}
                onChange={e => setOpt('mergeModulesOver', Math.max(0, Number(e.target.value) || 0))}
                disabled={busy}
              />
              <span>个时合并长尾（0 = 不合并）</span>
            </label>
            <label className="digest-opt digest-opt-check">
              <input type="checkbox" checked={opts.includeWeekly} onChange={e => setOpt('includeWeekly', e.target.checked)} disabled={busy} />
              <span>补一句本周新增 / 解决 / 关闭</span>
            </label>
            <label className="digest-opt digest-opt-check">
              <input type="checkbox" checked={opts.includeSummary} onChange={e => setOpt('includeSummary', e.target.checked)} disabled={busy} />
              <span>生成结尾总结段</span>
            </label>
            <label className="digest-opt digest-opt-check">
              <input type="checkbox" checked={opts.includeNextWeek} onChange={e => setOpt('includeNextWeek', e.target.checked)} disabled={busy} />
              <span>留「下周工作计划」骨架</span>
            </label>
          </div>
        </div>

        {busy && (
          <div className="pill" style={{ padding: '8px 12px', borderRadius: 8, fontWeight: 400 }}>
            {progress ? `正在拉取 ${progress.index}/${progress.total}：${progress.name}` : '正在连接禅道…'}
          </div>
        )}
        {error && (
          <div className="pill pill-bad" style={{ padding: '8px 12px', borderRadius: 8, whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {error}
          </div>
        )}
        {warn && (
          <div className="pill pill-warn" style={{ padding: '8px 12px', borderRadius: 8, whiteSpace: 'pre-wrap', fontWeight: 400 }}>
            {warn}
          </div>
        )}
        <div className="pg-sub">
          生成的只是草稿：「测试了哪些报表」「参加了什么会议」这类只有你知道的事写不进去，请补在对应段落里再保存。
        </div>
      </div>
    </Modal>
  );
}
