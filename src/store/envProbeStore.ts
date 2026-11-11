import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { EnvProbeData, EnvProbeResult } from '../types';

/** 一次巡检的存档：卡片上只看汇总，点进去能回看每一行的结果 */
export interface EnvProbeRecord {
  id: string;
  at: number;
  timeoutMs: number;
  summary: EnvProbeData['summary'];
  results: Record<string, EnvProbeResult>;
}

export interface EnvProbeTarget {
  id: string;
  url: string;
}

interface EnvProbeState {
  /** 当前展示的巡检结果，按 EnvEntry.id 索引 */
  results: Record<string, EnvProbeResult>;
  summary: EnvProbeData['summary'] | null;
  /** 当前结果属于哪次巡检（历史卡片的高亮依据）；手动跑的新巡检为 null 表示「最新」 */
  currentId: string | null;
  at: number | null;
  running: boolean;
  lastError: string;
  /** 跑这次巡检时的地址指纹，用来判断结果是否已经过期 */
  sig: string;
  history: EnvProbeRecord[];
  run: (targets: EnvProbeTarget[], timeoutMs: number, sig?: string) => Promise<boolean>;
  viewRecord: (id: string) => void;
  clear: () => void;
  clearHistory: () => void;
}

const MAX_HISTORY = 12;

/**
 * 巡检状态放在 store 里，而不是页面的 useState：
 * 页面切走组件会卸载，但巡检请求还在跑，结果也要留着——否则用户切回来
 * 只能看到一个空表，还以为是「切页就停了」。
 */
export const useEnvProbeStore = create<EnvProbeState>()(
  persist(
    (set, get) => ({
      results: {},
      summary: null,
      currentId: null,
      at: null,
      running: false,
      lastError: '',
      sig: '',
      history: [],

      run: async (targets, timeoutMs, sig = '') => {
        if (!targets.length) {
          set({ lastError: '当前列表里没有可巡检的地址' });
          return false;
        }
        if (get().running) return false;
        set({ running: true, lastError: '' });
        try {
          const r = await window.electronAPI.envProbe({ targets, timeoutMs });
          if (!r.success || !r.data) {
            set({ running: false, lastError: r.error || '巡检失败' });
            return false;
          }
          const map: Record<string, EnvProbeResult> = {};
          for (const row of r.data.results) if (row.id) map[row.id] = row;
          const at = Date.now();
          const record: EnvProbeRecord = {
            id: `${at.toString(36)}`,
            at,
            timeoutMs,
            summary: r.data.summary,
            results: map,
          };
          const history = [record, ...get().history].slice(0, MAX_HISTORY);
          set({
            results: map,
            summary: r.data.summary,
            currentId: record.id,
            at,
            running: false,
            sig,
            history,
          });
          return true;
        } catch (e) {
          set({
            running: false,
            lastError: e instanceof Error ? e.message : String(e),
          });
          return false;
        }
      },

      viewRecord: (id) => {
        const rec = get().history.find((h) => h.id === id);
        if (!rec) return;
        set({
          results: rec.results,
          summary: rec.summary,
          currentId: rec.id,
          at: rec.at,
        });
      },

      clear: () => set({ results: {}, summary: null, currentId: null, at: null, lastError: '' }),

      clearHistory: () => set({ history: [] }),
    }),
    {
      name: 'pm.env.probe',
      // 用 localStorage 而不是 sessionStorage：用户要的是「巡检一次后一直显示」，
      // 关掉应用再打开也要能看到上一次的数字与时间（sessionStorage 一关就没了）。
      storage: createJSONStorage(() => localStorage),
      partialize: (st) => ({
        results: st.results,
        summary: st.summary,
        currentId: st.currentId,
        at: st.at,
        sig: st.sig,
        history: st.history,
      }),
    },
  ),
);

/** 2026-11-10 15:42（历史卡片与报告头共用同一口径） */
export function formatAt(at: number | null): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

