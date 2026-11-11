import { useEffect } from 'react';
import { useEnvProbeStore } from '../store/envProbeStore';
import type { EnvEntry, EnvProbeResult } from '../types';

/**
 * 环境矩阵的定时巡检。
 *
 * 放在渲染层而不是主进程：巡检用的是 fetch，主进程里没有现成的探测链，
 * 而且结果本来就要回填到页面 store（用户切回来能看到）。代价是应用关掉就不跑了
 * —— 对一个「本机开的测试工具」来说这是可接受的取舍。
 *
 * 通知只在**状态翻转**时发：平时每 30 分钟弹一次「全都能连」只会让人把通知关掉。
 */

const PREV_KEY = 'pm.env.prevProbe';
/** 变慢的判定门槛：至少 2 秒，且比上次慢一倍 */
const SLOW_FLOOR_MS = 2000;
const DEFAULT_TIMEOUT_MS = 8000;

export interface EnvFlip {
  id: string;
  name: string;
  kind: 'fail' | 'recover' | 'slow';
  text: string;
}

type Snap = Record<string, { ok: boolean; ms: number }>;

function readPrev(): Snap {
  try {
    const raw = localStorage.getItem(PREV_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writePrev(snap: Snap): void {
  try { localStorage.setItem(PREV_KEY, JSON.stringify(snap)); } catch { /* 忽略 */ }
}

export function diffProbe(
  prev: Snap,
  next: Record<string, EnvProbeResult>,
  nameOf: (id: string) => string,
): EnvFlip[] {
  const flips: EnvFlip[] = [];
  Object.entries(next).forEach(([id, r]) => {
    const before = prev[id];
    if (!before) return;
    const name = nameOf(id);
    if (before.ok && !r.ok) {
      flips.push({ id, name, kind: 'fail', text: `${name}：连不上了${r.error ? `（${r.error}）` : ''}` });
    } else if (!before.ok && r.ok) {
      flips.push({ id, name, kind: 'recover', text: `${name}：已恢复（${r.ms} ms）` });
    } else if (before.ok && r.ok && r.ms >= Math.max(SLOW_FLOOR_MS, before.ms * 2)) {
      flips.push({ id, name, kind: 'slow', text: `${name}：变慢 ${before.ms} → ${r.ms} ms` });
    }
  });
  return flips;
}

/** 只保留 id → {ok, ms}，顺带丢掉已经不存在的条目 */
export function toSnap(results: Record<string, EnvProbeResult>): Snap {
  const out: Snap = {};
  Object.entries(results).forEach(([id, r]) => {
    if (r) out[id] = { ok: !!r.ok, ms: Number(r.ms) || 0 };
  });
  return out;
}

/** 同一时刻只允许跑一轮：定时器与「立即巡检」按钮共用这个锁 */
let probing = false;

export interface ProbeRunResult {
  ok: boolean;
  total: number;
  flips: EnvFlip[];
  error?: string;
}

/**
 * 立刻巡检一轮。定时器与设置页的「立即巡检」都走这里，避免两份实现漂移。
 * `notifyOnFlip` 为 false 时只回填结果、不弹通知。
 */
export async function runEnvProbeOnce(notifyOnFlip: boolean): Promise<ProbeRunResult> {
  if (probing) return { ok: false, total: 0, flips: [], error: '正在巡检中' };
  const store = useEnvProbeStore.getState();
  if (store.running) return { ok: false, total: 0, flips: [], error: '正在巡检中' };

  probing = true;
  try {
    // 环境条目存在 vault 的 environments 集合里（只放地址，账号密码在 entries）
    const res = await window.electronAPI.wsGet('environments');
    const list: EnvEntry[] = res && res.success && Array.isArray(res.data) ? (res.data as EnvEntry[]) : [];
    const targets = list
      .filter((e) => e && typeof e.url === 'string' && e.url.trim())
      .map((e) => ({ id: String(e.id), url: String(e.url) }));
    if (targets.length === 0) return { ok: false, total: 0, flips: [], error: '没有可巡检的地址' };

    const names: Record<string, string> = {};
    list.forEach((e) => {
      if (e && e.id != null) {
        names[String(e.id)] = [e.system, e.envType].filter(Boolean).join(' · ') || `条目 ${e.id}`;
      }
    });

    const prev = readPrev();
    const runOk = await useEnvProbeStore.getState().run(targets, DEFAULT_TIMEOUT_MS, `auto:${Date.now()}`);
    if (!runOk) {
      return { ok: false, total: targets.length, flips: [], error: useEnvProbeStore.getState().lastError || '巡检失败' };
    }

    const next = useEnvProbeStore.getState().results;
    const flips = diffProbe(prev, next, (id) => names[id] || `条目 ${id}`);
    writePrev(toSnap(next));

    if (notifyOnFlip && flips.length > 0) {
      const head = flips.slice(0, 3).map((f) => f.text);
      const body = head.join('\n') + (flips.length > 3 ? `\n…还有 ${flips.length - 3} 条` : '');
      const failing = flips.filter((f) => f.kind === 'fail').length;
      try {
        await window.electronAPI.appNotify?.({
          title: failing > 0 ? `环境巡检：${failing} 条连不上` : `环境巡检：${flips.length} 条有变化`,
          body,
          page: 'environments',
        });
      } catch { /* 通知发不出去不影响巡检 */ }
    }
    return { ok: true, total: targets.length, flips };
  } catch (err) {
    return { ok: false, total: 0, flips: [], error: String(err && (err as Error).message ? (err as Error).message : err) };
  } finally {
    probing = false;
  }
}

/**
 * 挂上定时器。`intervalMin <= 0` 表示关闭。
 * 首次挂载 4 秒后补跑一次，让用户打开应用就能看到新数字。
 */
export function useEnvAutoProbe(intervalMin: number, notifyOnFlip: boolean, enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !(intervalMin > 0)) return;

    const first = window.setTimeout(() => { void runEnvProbeOnce(notifyOnFlip); }, 4000);
    const timer = window.setInterval(
      () => { void runEnvProbeOnce(notifyOnFlip); },
      Math.max(1, intervalMin) * 60000,
    );

    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [intervalMin, notifyOnFlip, enabled]);
}
