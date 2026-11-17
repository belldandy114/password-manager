/**
 * 「按 id 补漏」的纯逻辑：生成候选 id + 并发探测。
 *
 * 抽成独立文件是为了能单测 —— ipc-zentao.js 里混着 IPC、登录、缓存，测不动。
 * 背景见 docs/agents/history-1.x.md：禅道 products 列表接口在部分版本会漏掉产品
 * （status=all / browseType=all 被静默忽略），但 `GET products/{id}` 单查不受影响。
 */

/**
 * 生成要探测的候选 id。
 *
 * 顺序有讲究：**先尾部的连续 id，再中间断档**。
 * 新产品总是拿到最大的 id（实测漏掉的 69 就在 maxId+1），尾部命中率最高，
 * 万一断档太多被封顶截断，也不能把尾部挤掉。
 *
 * @param {Array<string|number>} ids 接口已经返回的 id
 * @param {{cap?:number, tail?:number, gapLimit?:number}} opts
 * @returns {{candidates:string[], maxId:number, gaps:number, capped:boolean}}
 *          gaps = -1 表示断档超过 gapLimit、中间段未扫
 */
function buildProbeCandidates(ids, opts = {}) {
  const cap = Number(opts.cap) || 120;
  const tail = Number(opts.tail) || 30;
  const gapLimit = Number(opts.gapLimit) || 200;

  const list = Array.isArray(ids) ? ids : [];
  const known = new Set(list.map(String));
  const nums = list.map(Number).filter(n => Number.isInteger(n) && n > 0);
  if (!nums.length) return { candidates: [], maxId: 0, gaps: 0, capped: false };

  const maxId = Math.max(...nums);
  const candidates = [];

  // ① 尾部：maxId+1 .. maxId+tail（新产品最可能在这里）
  for (let i = maxId + 1; i <= maxId + tail && candidates.length < cap; i++) {
    candidates.push(String(i));
  }

  // ② 中间断档：只有断档数量可控时才扫，否则说明实例太大，扫了也没意义还拖慢
  const gaps = [];
  for (let i = 1; i < maxId; i++) {
    if (!known.has(String(i))) gaps.push(String(i));
    if (gaps.length > gapLimit) break;
  }
  const capped = gaps.length > gapLimit;
  if (!capped) {
    for (const g of gaps) {
      if (candidates.length >= cap) break;
      candidates.push(g);
    }
  }

  return { candidates, maxId, gaps: capped ? -1 : gaps.length, capped };
}

/**
 * 并发探测候选 id。fetchOne(id) 命中返回记录、不命中返回 null 或抛错。
 *
 * - 并发数默认 6：太快容易被禅道限流，太慢用户等不住（120 个约 1~2 秒）
 * - 单独统计 403：用来区分「不存在」和「有但无权限」，后者补不进来不是代码问题
 * - 返回值多给一个 `misses`：**明确返回 null 的 id**（= 服务端 404/已删除）。
 *   调用方只该缓存这些结论；抛错（超时、403、5xx）的不能当成「不存在」，否则会被长期误判。
 *
 * @param {string[]} candidates
 * @param {(id:string)=>Promise<any>} fetchOne
 * @param {{concurrency?:number}} opts
 * @returns {Promise<{found:any[], denied:number, misses:string[], errors:string[]}>}
 */
async function probeByIds(candidates, fetchOne, opts = {}) {
  const concurrency = Number(opts.concurrency) || 6;
  const list = Array.isArray(candidates) ? candidates : [];
  const found = [];
  const misses = [];
  const errors = [];
  let denied = 0;
  let cursor = 0;

  const worker = async () => {
    while (cursor < list.length) {
      const id = list[cursor++];
      try {
        const v = await fetchOne(id);
        if (v) found.push(v);
        else misses.push(id);
      } catch (e) {
        errors.push(id);
        if (/403|forbidden|denied|权限/i.test(String((e && e.message) || ''))) denied++;
      }
    }
  };

  const n = Math.min(concurrency, list.length);
  await Promise.all(Array.from({ length: n }, worker));

  found.sort((a, b) => Number(a.id) - Number(b.id));
  return { found, denied, misses, errors };
}

module.exports = { buildProbeCandidates, probeByIds };
