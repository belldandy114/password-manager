/**
 * 改动文件 ∩ 用例映射 → 受影响脚本（契约 §4.1 的 `src/utils/gitImpact.ts`，模块 6 的推理部分）。
 *
 * 三个不能含糊的地方（都是「猜出来的结论比没有结论更糟」）：
 *
 * 1. **台账为空时必须说「算不出来」**。`caseMaps` 是空的时候返回 `affected: []` 会被读成
 *    「本次改动不影响任何脚本」—— 这和「压根没有映射数据」是**相反**的含义，用户会据此跳过回归。
 *    所以这里返回 `status: 'empty-maps'` + 固定文案 `NO_CASE_MAP_NOTICE`。
 * 2. **匹配规则只有三种，命中哪一种要写出来**：脚本路径（确定）、方法级映射所在文件（确定）、
 *    文件名子串（**启发式**）。界面据此打 `.dev-tag.is-ok` / `.dev-tag.is-heur`——
 *    「大概相关」和「就是这个脚本」不能长得一样。
 * 3. **判不出来的一律进 `unmapped`**，不塞进 `affected` 凑数；`affected` 为空也要明说
 *    「对不上」而不是「没影响」。
 *
 * 纯函数：不读盘、不碰 IPC、不含时间戳。
 */

/** 改动文件（`git:diff` 的 `files[]`，也接受纯路径字符串） */
export interface ChangeFile {
  path: string;
  status?: string;
  additions?: number;
  deletions?: number;
}

/** `caseMaps` 集合里与本模块相关的最小形状（不 import 页面类型，避免循环依赖） */
export interface CaseMapLike {
  caseNo: string;
  caseTitle?: string;
  target: { kind: 'file' | 'method'; ref: string };
}

/** 命中方式：前两种是确定匹配，`filename` 是启发式 */
export type ImpactVia = 'path' | 'method' | 'filename';

export interface AffectedScript {
  /** `target.ref` 原文（`文件` 或 `文件#方法`） */
  script: string;
  caseNo: string;
  caseTitle?: string;
  kind: 'file' | 'method';
  via: ImpactVia;
  /** 用户可读的命中理由（含命中的具体文件/片段） */
  reason: string;
  /** 命中这个脚本的所有改动文件（可能多个） */
  matchedFiles: string[];
}

export type ImpactStatus = 'ok' | 'empty-maps' | 'no-changes';

export interface GitImpactResult {
  status: ImpactStatus;
  affected: AffectedScript[];
  /** 改动文件里**没有任何映射**的那些（原样路径，供人工确认） */
  unmapped: string[];
  /** 一句话建议：必须含「具体先跑哪些」，不是一个空话 */
  suggestion: string;
  /** `status==='empty-maps'` 时给出固定文案，界面必须常显 */
  notice?: string;
}

/** 台账为空时的固定文案（[C-36] 同款口径：界面只显示这一句，不自行改写） */
export const NO_CASE_MAP_NOTICE = '无映射数据，无法计算影响面';

/** 命中方式的可信度：确定 / 启发式（界面据此选 `.dev-tag.is-ok` 或 `.dev-tag.is-heur`） */
export function isDefiniteVia(via: ImpactVia): boolean {
  return via === 'path' || via === 'method';
}

const VIA_RANK: Record<ImpactVia, number> = { path: 3, method: 3, filename: 1 };

/** 归一：反斜杠→斜杠、去前导 `./`、小写（Windows 上路径大小写不敏感，比对用） */
function normPath(p: string): string {
  return String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

/** `文件#方法` → 文件部分（没有 `#` 就原样）；返回空串表示这条 ref 不可用 */
function filePartOf(ref: string): string {
  const s = String(ref ?? '').trim();
  if (!s) return '';
  const i = s.indexOf('#');
  return i >= 0 ? s.slice(0, i).trim() : s;
}

function baseNameOf(p: string): string {
  const s = String(p ?? '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 一条映射 vs 一个改动文件：命中就返回 via + 理由，否则 null */
function matchOne(map: CaseMapLike, changed: string): { via: ImpactVia; reason: string } | null {
  const ref = String(map.target?.ref ?? '');
  const filePart = filePartOf(ref);
  if (!filePart) return null;

  const cf = normPath(changed);
  const rf = normPath(filePart);
  if (!cf || !rf) return null;

  // ① 脚本路径命中：完全一致，或一方是另一方的路径后缀（root 不同层时常见）
  if (cf === rf || cf.endsWith(`/${rf}`) || rf.endsWith(`/${cf}`)) {
    return map.target.kind === 'method'
      ? { via: 'method', reason: `方法级映射 ${ref} 所在文件被改动` }
      : { via: 'path', reason: `脚本路径命中：${filePart}` };
  }

  // ② 文件名子串（启发式）：只在上面没命中时才试，且 basename 至少 3 个字符
  const base = baseNameOf(filePart);
  if (base.length >= 3 && cf.includes(base.toLowerCase())) {
    return { via: 'filename', reason: `按文件名子串匹配（启发式）：${base} 出现在 ${changed} 里` };
  }
  return null;
}

/**
 * 算受影响脚本。
 *
 * @param input.changedFiles `git:diff` 的 files（或纯路径数组）
 * @param input.caseMaps     `caseMaps` 集合（可为空——空就是「算不出来」，不是「没影响」）
 */
export function gitImpact(input: {
  changedFiles?: Array<string | ChangeFile>;
  caseMaps?: CaseMapLike[];
}): GitImpactResult {
  const rawFiles = Array.isArray(input?.changedFiles) ? input.changedFiles : [];
  const maps = (Array.isArray(input?.caseMaps) ? input.caseMaps : []).filter(
    (m) => m && m.target && typeof m.target.ref === 'string' && m.target.ref.trim() !== '',
  );
  const changed = rawFiles
    .map((f) => (typeof f === 'string' ? f : String(f?.path ?? '')))
    .map((p) => String(p ?? ''))
    .filter((p) => p.trim() !== '');

  // 台账为空：**必须**明说算不出来。即使有改动文件也不猜。
  if (!maps.length) {
    return {
      status: 'empty-maps',
      affected: [],
      unmapped: changed,
      suggestion: `${NO_CASE_MAP_NOTICE}：先去「资产台账 → 用例映射」导入或新增映射，再回来算影响面。`,
      notice: NO_CASE_MAP_NOTICE,
    };
  }

  if (!changed.length) {
    return {
      status: 'no-changes',
      affected: [],
      unmapped: [],
      suggestion: '当前范围没有改动文件：不需要跑任何脚本。换一个 diff 范围（已暂存 / 未暂存 / HEAD）再看看。',
    };
  }

  // 聚合：同一个脚本可能被多个改动文件命中
  const byScript = new Map<string, AffectedScript>();
  const matchedFiles = new Set<string>();

  for (const file of changed) {
    for (const map of maps) {
      const hit = matchOne(map, file);
      if (!hit) continue;
      matchedFiles.add(file);
      const key = `${map.caseNo}::${map.target.kind}::${map.target.ref}`;
      const prev = byScript.get(key);
      if (!prev) {
        byScript.set(key, {
          script: map.target.ref,
          caseNo: map.caseNo,
          ...(map.caseTitle ? { caseTitle: map.caseTitle } : {}),
          kind: map.target.kind,
          via: hit.via,
          reason: hit.reason,
          matchedFiles: [file],
        });
      } else {
        if (!prev.matchedFiles.includes(file)) prev.matchedFiles.push(file);
        // 可信度取「更强」的那个：确定 > 启发式
        if (VIA_RANK[hit.via] > VIA_RANK[prev.via]) {
          prev.via = hit.via;
          prev.reason = hit.reason;
        }
      }
    }
  }

  const affected = [...byScript.values()].sort((a, b) => {
    // 先按可信度，再按用例编号，保证列表稳定
    const d = VIA_RANK[b.via] - VIA_RANK[a.via];
    return d !== 0 ? d : a.caseNo.localeCompare(b.caseNo);
  });
  const unmapped = changed.filter((f) => !matchedFiles.has(f));

  const heuristic = affected.filter((a) => !isDefiniteVia(a.via));
  const head = affected.slice(0, 5).map((a) => `${a.caseNo}（${a.script}）`);

  let suggestion: string;
  if (!affected.length) {
    // 台账有、改动有，但一条都对不上：这是「对不上」，不是「没影响」
    suggestion = `改动文件与已登记的 ${maps.length} 条映射都对不上：先确认映射是否漏登记，**不要据此认为没有回归风险**。`;
  } else {
    suggestion = `建议先跑：${head.join('、')}${affected.length > head.length ? ` 等 ${affected.length} 个` : ''}。`;
    if (heuristic.length) {
      suggestion += `其中 ${heuristic.length} 个是按文件名推测的（启发式），跑之前先确认是不是你要的脚本。`;
    }
    if (unmapped.length) {
      suggestion += `另有 ${unmapped.length} 个改动文件没有对应脚本，需人工确认。`;
    }
  }

  return { status: 'ok', affected, unmapped, suggestion };
}