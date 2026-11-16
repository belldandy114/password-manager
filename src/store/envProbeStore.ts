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
  /** 历史是否已从加密库读过（避免页面挂载时用空数组覆盖库里的数据） */
  historyLoaded: boolean;
  run: (targets: EnvProbeTarget[], timeoutMs: number, sig?: string) => Promise<boolean>;
  viewRecord: (id: string) => void;
  clear: () => void;
  clearHistory: () => void;
  /** 从加密库加载历史（页面挂载时调；只加载一次） */
  loadHistory: () => Promise<void>;
}

const MAX_HISTORY = 12;

/** 历史在 vault 里的集合名（1.25.0 从 localStorage 迁过来） */
const VAULT_KEY = 'envProbes' as const;

/**
 * 巡检状态放在 store 里，而不是页面的 useState：
 * 页面切走组件会卸载，但巡检请求还在跑，结果也要留着——否则用户切回来
 * 只能看到一个空表，还以为是「切页就停了」。
 *
 * **1.25.0 起 history 迁进加密库**：
 * 以前整份 store（含 12 次完整结果）都 persist 到 localStorage，等于把内网地址、
 * 系统名、失败原因明文写在磁盘上 —— 而 vault 本身是 AES-256-GCM 加密的，
 * 这个旁路把加密的意义抵消了一大半。
 *
 * 现在的分工：
 * - `results / summary / at / sig`（当前这一次）仍留在 localStorage：
 *   用户要的是「关掉应用再打开也能看到上次的数字」，而且这些数据在页面上本来就看得见。
 * - `history`（12 次完整结果）走 vault 集合 `envProbes`，跟着加密库走。
 *
 * 时序注意：zustand persist 的 rehydrate 是同步的（localStorage），但 vault 读取是异步的。
 * 所以 `historyLoaded` 标记「库里的历史读过了没有」——没读过之前**不要**把空数组写回库，
 * 否则页面一挂载就会把历史清空。
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
      historyLoaded: false,

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
          // 落盘到加密库：失败只记错误，不影响这次巡检结果（结果已经在界面上）
          void saveHistoryToVault(history);
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

      clearHistory: () => {
        set({ history: [] });
        void saveHistoryToVault([]);
      },

      /**
       * 从加密库读历史。
       *
       * 首次调用时顺带做一次迁移：localStorage 里还有旧 history、而库里是空的，
       * 就把旧的搬进库并清掉 localStorage 里的 history（当前 results 保留）。
       * 迁移只做一次，靠 `pm.env.probe.migrated` 标记，避免用户清空历史后
       * 下次启动又被旧数据填回来。
       */
      loadHistory: async () => {
        if (get().historyLoaded) return;
        let fromVault: EnvProbeRecord[] = [];
        let readOk = false;
        try {
          const r = await window.electronAPI.wsGet(VAULT_KEY);
          // 注意区分「读成功但为空」和「读失败」：
          // success === false 是未解锁 / 库损坏，此时**不能**当成「库里没有历史」，
          // 否则会把 localStorage 的旧数据写进库、还标上「已迁移」，
          // 等库恢复后真实历史就被这份旧快照顶掉了。
          if (r && r.success) {
            readOk = true;
            if (Array.isArray(r.data)) fromVault = r.data as EnvProbeRecord[];
          }
        } catch {
          readOk = false;
        }
        // 读不到：保持 localStorage 里的旧数据，下次挂载再试
        if (!readOk) return;

        const legacy = get().history;
        const migrated = readMigratedFlag();
        if (fromVault.length === 0 && legacy.length > 0 && !migrated) {
          // 首次迁移：把 localStorage 里的旧历史搬进库
          const ok = await saveHistoryToVault(legacy);
          if (ok) {
            writeMigratedFlag();
            clearLegacyHistory();
          }
          set({ history: legacy.slice(0, MAX_HISTORY), historyLoaded: true });
          return;
        }

        // 库里已有数据（或用户已经清空过）：以库为准
        set({ history: fromVault.slice(0, MAX_HISTORY), historyLoaded: true });
        if (!migrated) {
          // 库里是空的、localStorage 也是空的：标记迁移完成，避免以后被旧数据填回来
          writeMigratedFlag();
          clearLegacyHistory();
        }
      },
    }),
    {
      name: 'pm.env.probe',
      // 用 localStorage 而不是 sessionStorage：用户要的是「巡检一次后一直显示」，
      // 关掉应用再打开也要能看到上一次的数字与时间（sessionStorage 一关就没了）。
      storage: createJSONStorage(() => localStorage),
      // history 不再进 localStorage（改存加密库）；historyLoaded 是运行时标记，也不存
      partialize: (st) => ({
        results: st.results,
        summary: st.summary,
        currentId: st.currentId,
        at: st.at,
        sig: st.sig,
      }),
    },
  ),
);

/* ---------------- 加密库读写 ---------------- */

/** 把历史写进 vault 集合；返回是否成功（失败不抛，调用方按需提示） */
async function saveHistoryToVault(history: EnvProbeRecord[]): Promise<boolean> {
  try {
    const r = await window.electronAPI.wsSet(VAULT_KEY, history.slice(0, MAX_HISTORY));
    return !!r && r.success !== false;
  } catch {
    return false;
  }
}

/* ---------------- 迁移标记 ---------------- */

const MIGRATED_KEY = 'pm.env.probe.migrated';

function readMigratedFlag(): boolean {
  try { return localStorage.getItem(MIGRATED_KEY) === '1'; } catch { return false; }
}

function writeMigratedFlag(): void {
  try { localStorage.setItem(MIGRATED_KEY, '1'); } catch { /* 隐私模式下写不了，下次再迁 */ }
}

/**
 * 清掉 localStorage 里残留的 history。
 *
 * zustand persist 把整份 state 序列化在 `pm.env.probe` 这个键里，
 * 直接删键会把当前 results 一起删掉，所以这里只把 JSON 里的 history 字段去掉再写回。
 */
function clearLegacyHistory(): void {
  try {
    const raw = localStorage.getItem('pm.env.probe');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> } | null;
    if (!parsed || typeof parsed !== 'object' || !parsed.state) return;
    if (!('history' in parsed.state)) return;
    delete parsed.state.history;
    localStorage.setItem('pm.env.probe', JSON.stringify(parsed));
  } catch { /* 解析失败就留着，不影响功能 */ }
}

/** 2026-11-10 15:42（历史卡片与报告头共用同一口径） */
export function formatAt(at: number | null): string {
  if (!at) return '';
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
