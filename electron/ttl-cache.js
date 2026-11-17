/**
 * 极小的「短时缓存 + 并发合并」工具，给禅道项目列表这类「拉一次很贵、短时间内会被连点/重复请求」
 * 的接口用。抽成独立模块是为了能单测 —— ipc-zentao.js 里混着 electron/登录/磁盘缓存，测不动。
 *
 * 两个能力：
 *  ① TTL：同一 key 在 ttl 内重复调用直接返回上次结果，不发请求。
 *  ② single-flight：**并发** 的同一 key 调用合并成一次真实请求，后来者等同一个 Promise。
 *     这条比 TTL 更关键：2026-11-17 的日志里两次拉取相隔 1.3 秒，都完整扫了 56 个 id ——
 *     因为第一次还没跑完（probe 要 2~4 秒），第二次进不来缓存，只能再扫一遍。
 *
 * 语义刻意保持简单：**固定 TTL（不滑动）**。滑动窗口会让「一直有人点」的 key 永远不过期，
 * 反而不容易看到禅道上新建的产品。
 */

/**
 * @param {{ttl?:number, max?:number, now?:()=>number}} opts
 *        ttl: 毫秒；0 或省略 = 不按时间过期（仅靠 max/delete 淘汰）
 *        max: 最多保留多少个 key（LRU 淘汰），默认 64
 *        now: 注入时钟，单测用
 */
function createTtlCache(opts = {}) {
  const ttl = Math.max(0, Number(opts.ttl) || 0);
  const max = Math.max(1, Number(opts.max) || 64);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  /** key → { at, value }；Map 的插入顺序就是 LRU 顺序（命中不刷新，写入才置后） */
  const store = new Map();
  /** key → Promise；正在跑的真实请求 */
  const inflight = new Map();
  const stats = { hit: 0, miss: 0, coalesced: 0 };

  function alive(key) {
    const e = store.get(key);
    if (!e) return null;
    if (ttl > 0 && now() - e.at >= ttl) {
      store.delete(key);
      return null;
    }
    return e;
  }

  function setValue(key, value) {
    if (store.has(key)) store.delete(key);
    store.set(key, { at: now(), value });
    while (store.size > max) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
    return value;
  }

  /**
   * @param {string} key
   * @param {() => Promise<any>} fn 真正干活的函数（只在缓存未命中且没有并发同请求时调用）
   * @param {{fresh?:boolean}} [o] fresh=true 跳过读取缓存（「刷新」按钮用），但仍会合并并发请求
   * @returns {Promise<{value:any, cached:boolean, shared:boolean, age:number}>}
   *          cached=true 命中缓存；shared=true 复用了别人正在跑的请求
   */
  async function wrap(key, fn, o = {}) {
    if (!o.fresh) {
      const e = alive(key);
      if (e) {
        stats.hit++;
        return { value: e.value, cached: true, shared: false, age: now() - e.at };
      }
    }
    const running = inflight.get(key);
    if (running) {
      stats.coalesced++;
      return { value: await running, cached: false, shared: true, age: 0 };
    }
    stats.miss++;
    // 注意：finally 里就摘掉 inflight，caller 拿到值后自己 setValue；
    // 这样「运行中抛错」不会留下一个永远 reject 的僵尸 Promise。
    const task = Promise.resolve().then(fn).finally(() => inflight.delete(key));
    inflight.set(key, task);
    const value = await task;
    setValue(key, value);
    return { value, cached: false, shared: false, age: 0 };
  }

  return {
    wrap,
    /** 只读，不触发请求；过期返回 undefined */
    peek(key) {
      const e = alive(key);
      return e ? e.value : undefined;
    },
    /** 上次写入距今多少毫秒；没有则 -1 */
    age(key) {
      const e = alive(key);
      return e ? now() - e.at : -1;
    },
    set: setValue,
    delete(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
      inflight.clear();
    },
    isRunning(key) {
      return inflight.has(key);
    },
    size() {
      return store.size;
    },
    stats() {
      return { ...stats, size: store.size, running: inflight.size };
    },
  };
}

module.exports = { createTtlCache };
