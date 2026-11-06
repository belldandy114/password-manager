/**
 * 禅道 store 的持久化后端。
 *
 * 为什么不是 sessionStorage：一个项目的全量 Bug 动辄上万条（含标题、模块、
 * 三个日期字段），JSON 序列化后很容易撞到 sessionStorage / localStorage 的
 * 5–10MB 配额。配额错误被 zustand 吞掉时，表现为「切个页面回来数据全没了」，
 * 很难排查。IndexedDB 没有这个限制，且读写异步、不阻塞渲染。
 *
 * 兼容策略：
 * - 无 indexedDB（单测 / 非浏览器环境）→ 退回 sessionStorage，再退回内存
 * - 从旧版本升级 → 首次读取时把 sessionStorage 里的旧值迁进 IndexedDB 并清掉
 */

const DB_NAME = 'pm-zentao';
const STORE = 'kv';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => {
    dbPromise = null; // 下次调用可重试，不缓存 rejected promise
    throw e;
  });
  return dbPromise;
}

async function idbGet(key: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbRemove(key: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const memory = new Map<string, string>();

function sessionAvailable(): boolean {
  try { return typeof sessionStorage !== 'undefined'; } catch { return false; }
}

function legacyGet(key: string): string | null {
  if (sessionAvailable()) {
    try {
      const v = sessionStorage.getItem(key);
      if (v != null) return v;
    } catch { /* 配额或权限问题，落到内存 */ }
  }
  return memory.get(key) ?? null;
}

function legacySet(key: string, value: string) {
  memory.set(key, value);
  if (sessionAvailable()) {
    try { sessionStorage.setItem(key, value); } catch { /* 内存里已有备份 */ }
  }
}

function legacyRemove(key: string) {
  memory.delete(key);
  if (sessionAvailable()) {
    try { sessionStorage.removeItem(key); } catch { /* ignore */ }
  }
}

/** zustand StateStorage 兼容的异步存储 */
export const zentaoStorage = {
  async getItem(name: string): Promise<string | null> {
    if (typeof indexedDB !== 'undefined') {
      try {
        const value = await idbGet(name);
        if (value != null) return value;
        // 旧版本数据迁移：只在 IndexedDB 为空时做一次
        if (sessionAvailable()) {
          try {
            const legacy = sessionStorage.getItem(name);
            if (legacy != null) {
              await idbSet(name, legacy);
              sessionStorage.removeItem(name);
              return legacy;
            }
          } catch { /* ignore */ }
        }
        return null;
      } catch {
        // IndexedDB 不可用（隐私模式 / 被禁用）→ 静默退回
      }
    }
    return legacyGet(name);
  },
  async setItem(name: string, value: string): Promise<void> {
    if (typeof indexedDB !== 'undefined') {
      try { await idbSet(name, value); return; } catch { /* 退回 */ }
    }
    legacySet(name, value);
  },
  async removeItem(name: string): Promise<void> {
    if (typeof indexedDB !== 'undefined') {
      try { await idbRemove(name); } catch { /* ignore */ }
    }
    legacyRemove(name);
  },
};
