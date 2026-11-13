/**
 * 接口回归的定时调度。
 *
 * 为什么放在渲染层而不是主进程：跑回归要用「变量替换 / 提取 / 断言」那一整套，
 * 实现只有一份（utils/apiRunner + apiAssert + apiVars）。搬到主进程就得用 JS 再写一遍，
 * 两边迟早不一致——那种不一致最难查（手动跑通过、定时跑说失败）。
 *
 * 代价是**只在应用打开时执行**。为此做了两件事补偿：
 * 1. 启动时立刻 tick 一次，错过的会在解锁后马上补跑；
 * 2. 关窗口到托盘不影响（渲染层还活着），只是浏览器会把定时器降频。
 *
 * tick 用 `isDue()` 判断（和界面上「立即运行」共用同一份规则，见 utils/regression）。
 */
import { useEffect, useRef } from 'react';
import type { ApiRequest } from '../types';
import { runRequests } from '../utils/apiRunner';
import {
  isDue, pruneRuns, type RegressionRun, type RegressionSet,
} from '../utils/regression';

/** 检查频率：30 秒一次足够（最小间隔档位是 15 分钟） */
const TICK_MS = 30_000;

/** 跑完一次后广播，页面监听它刷新「上次运行」 */
export const REGRESSION_RAN_EVENT = 'regression:ran';

export function useRegressionScheduler(enabled: boolean) {
  const busy = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;

    const tick = async () => {
      if (!alive || busy.current) return;
      busy.current = true;
      try {
        const setsRes = await window.electronAPI.wsGet('regressionSets');
        if (!setsRes?.success) return; // 未解锁 / 库损坏：下一轮再试
        const sets = (setsRes.data || []) as RegressionSet[];
        const due = sets.filter(s => isDue(s));
        if (due.length === 0) return;

        const reqRes = await window.electronAPI.wsGet('apiRequests');
        const requests = (reqRes?.success ? reqRes.data : []) as ApiRequest[];

        for (const set of due) {
          if (!alive) break;
          const list = set.requestIds
            .map(id => requests.find(r => r.id === id))
            .filter((x): x is ApiRequest => !!x);
          // 集合里的请求都被删了：跳过，但不动它的开关（用户可能只是临时删了）
          if (list.length === 0) continue;

          const steps = await runRequests(list, {
            autoSession: true,
            send: (payload) => window.electronAPI.apiSend(payload),
          });
          if (!alive) break;

          const at = new Date().toISOString();
          const run: RegressionRun = {
            id: `run-${Date.now()}`, setId: set.id, setName: set.name, at,
            trigger: 'schedule', steps,
          };

          // 重新读一次再写，避免把用户刚在界面上的改动覆盖掉
          const [runsRes, freshRes] = await Promise.all([
            window.electronAPI.wsGet('regressionRuns'),
            window.electronAPI.wsGet('regressionSets'),
          ]);
          const runs = (runsRes?.success ? runsRes.data : []) as RegressionRun[];
          await window.electronAPI.wsSet('regressionRuns', pruneRuns([run, ...runs], 20));

          const fresh = (freshRes?.success ? freshRes.data : []) as RegressionSet[];
          await window.electronAPI.wsSet('regressionSets', fresh.map(s => (s.id === set.id
            ? { ...s, lastRunAt: at, lastRunId: run.id, lastStatus: (steps.every(t => t.ok) ? 'pass' : 'fail') as 'pass' | 'fail' }
            : s)));

          window.dispatchEvent(new CustomEvent(REGRESSION_RAN_EVENT, { detail: { setId: set.id, at } }));

          // 只在有失败时弹通知：每 15 分钟弹一次「全部通过」会把人烦死
          const failed = steps.filter(t => !t.ok);
          if (failed.length > 0) {
            try {
              await window.electronAPI.appNotify?.({
                title: `接口回归：${set.name} 有 ${failed.length} 条失败`,
                body: failed.slice(0, 3).map(f => f.name || f.url).join('、')
                  + (failed.length > 3 ? ` 等 ${failed.length} 条` : ''),
                page: 'apiClient',
              });
            } catch { /* 通知发不出去不影响回归本身 */ }
          }
        }
      } catch {
        // 定时任务不能因为一次异常就停掉：吞掉，下一轮继续
      } finally {
        busy.current = false;
      }
    };

    void tick();
    const timer = setInterval(() => { void tick(); }, TICK_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled]);
}
