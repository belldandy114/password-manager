import React, { useEffect, useMemo, useState } from 'react';
import { Modal } from './Modal';
import { Icons } from './ui';
import { useEnvProbeStore } from '../store/envProbeStore';
import type { NotifyStatus } from '../types';

/**
 * 提醒中心：把散在各处的「现在有什么需要处理」收在一处。
 *
 * 不做通知历史（那需要一套写入/已读模型），而是**打开时实时聚合**现有状态：
 * - 禅道：超期未动的待验证 / 待处理、上次检查发现的新 Bug
 * - 环境矩阵：最近一次巡检里不可达的地址
 * - 备份：最近一份备份距今多久
 *
 * 好处是零存储、不会和页面上的数字对不上；代价是看不到「前天那条提醒」。
 */
interface Item {
  key: string;
  tone: 'bad' | 'warn' | 'info';
  group: string;
  title: string;
  detail?: string;
  page?: string;
}

const DAY = 86400000;

/**
 * 一键清除的落盘键（1.25.0 重做）。
 *
 * 旧实现按「整批事项的签名」记：清除时存下当时那批 key 拼成的字符串，
 * 下次打开只有**签名完全相等**才隐藏。问题有两个：
 *   1. 只要多出/少掉任何一条（比如某个环境恢复可达、禅道多了一个新 Bug），
 *      签名就变了 → 之前清掉的全部**重新冒出来**，用户以为「清除没生效」；
 *   2. 反过来，如果事项集合恰好没变，用户永远看不到它们，也没法单独恢复某一条。
 *
 * 现在改成**按单条 key 记已读**：清除时把当前所有 key 记进 dismissed 集合，
 * 之后每条独立判断 —— 清掉的不再回来，新出现的照常显示。
 * 集合上限 500 条（超出丢最旧的），避免 localStorage 无限增长。
 */
const LS_DISMISSED = 'pm.notices.dismissed.v2';
const DISMISSED_MAX = 500;

interface DismissedState {
  /** 已清除的事项 key → 清除时间戳 */
  keys: Record<string, number>;
}

function readDismissed(): DismissedState {
  try {
    const raw = localStorage.getItem(LS_DISMISSED);
    if (!raw) return { keys: {} };
    const d = JSON.parse(raw);
    if (d && typeof d === 'object' && d.keys && typeof d.keys === 'object') {
      return { keys: d.keys as Record<string, number> };
    }
  } catch { /* 损坏就当没清除过 */ }
  return { keys: {} };
}

function writeDismissed(state: DismissedState) {
  try {
    // 超出上限时按时间戳丢最旧的
    const entries = Object.entries(state.keys);
    if (entries.length > DISMISSED_MAX) {
      entries.sort((a, b) => a[1] - b[1]);
      const keep = entries.slice(entries.length - DISMISSED_MAX);
      state = { keys: Object.fromEntries(keep) };
    }
    localStorage.setItem(LS_DISMISSED, JSON.stringify(state));
  } catch { /* 配额满不影响本次会话 */ }
}

function daysSince(iso: string): number | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / DAY);
}

export function NoticeCenter({
  open, onClose, onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: string) => void;
}) {
  const [zt, setZt] = useState<NotifyStatus | null>(null);
  const [backupAt, setBackupAt] = useState('');
  const [loading, setLoading] = useState(false);
  const results = useEnvProbeStore(s => s.results);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const r = await window.electronAPI.zentaoNotifyStatus();
        let status = r?.data || null;
        if (alive && status) setZt(status);

        // 打开时自动补一次：提醒中心读的是「上次定时检查」的结果，
        // 昨天没开应用的话今天看到的就是昨天的数据。
        // 只在已配置、已解锁、且距上次检查超过 10 分钟时才触发（纯读请求，安全）。
        const at = status?.lastCheck?.at ? Date.parse(status.lastCheck.at) : 0;
        const outdated = !at || Date.now() - at > 10 * 60 * 1000;
        if (status?.configured && status?.unlocked && outdated) {
          await window.electronAPI.zentaoNotifyNow();
          const r2 = await window.electronAPI.zentaoNotifyStatus();
          if (alive && r2?.data) setZt(r2.data);
        }
      } catch { /* 忽略 */ }
      try {
        const b = await window.electronAPI.backupList();
        if (alive && b?.success && Array.isArray(b.data) && b.data.length) {
          setBackupAt(String((b.data[0] as { mtime?: string }).mtime || ''));
        } else if (alive) {
          setBackupAt('');
        }
      } catch { /* 忽略 */ }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];

    // 1. 禅道超期
    const rows = zt?.lastCheck?.staleRows;
    (rows?.verify || []).slice(0, 6).forEach((b) => {
      out.push({
        key: `verify-${b.id}`, tone: 'warn', group: '禅道',
        title: `#${b.id} 待验证已 ${b.days} 天`,
        detail: b.title, page: 'zentao',
      });
    });
    (rows?.handle || []).slice(0, 6).forEach((b) => {
      out.push({
        key: `handle-${b.id}`, tone: 'bad', group: '禅道',
        title: `#${b.id} 未处理已 ${b.days} 天`,
        detail: b.title, page: 'zentao',
      });
    });

    // 2. 上次检查发现的新 Bug
    const fresh = zt?.lastCheck?.fresh || 0;
    if (fresh > 0) {
      out.push({
        key: 'zt-fresh', tone: 'info', group: '禅道',
        title: `上次检查发现 ${fresh} 个新 Bug`,
        detail: zt?.lastCheck?.at ? `检查于 ${zt.lastCheck.at.slice(0, 16).replace('T', ' ')}` : '',
        page: 'zentao',
      });
    }
    if (zt && !zt.configured) {
      out.push({
        key: 'zt-cfg', tone: 'warn', group: '禅道',
        title: '还没保存禅道账号', detail: '保存后才会定时检查新 Bug 与超期', page: 'zentao',
      });
    }

    // 3. 环境不可达
    const down = Object.values(results || {}).filter(r => r && r.ok === false);
    down.slice(0, 6).forEach((r) => {
      out.push({
        key: `env-${r.id || r.url}`, tone: 'bad', group: '环境',
        title: `不可达：${String(r.url || '').replace(/^https?:\/\//, '')}`,
        detail: r.error || (r.status ? `HTTP ${r.status}` : undefined),
        page: 'environments',
      });
    });
    if (down.length > 6) {
      out.push({
        key: 'env-more', tone: 'bad', group: '环境',
        title: `还有 ${down.length - 6} 个地址不可达`, page: 'environments',
      });
    }

    // 4. 备份
    const bd = backupAt ? daysSince(backupAt) : null;
    if (bd !== null && bd >= 2) {
      out.push({
        key: 'backup', tone: 'warn', group: '备份',
        title: `最近一份备份是 ${bd} 天前`, detail: '建议在设置里点一次「立即备份」', page: 'settings',
      });
    }

    return out;
  }, [zt, results, backupAt]);

  /* ---------- 一键清除（1.25.0 重做） ----------
   * 按单条 key 记已读：清掉的不再回来，新出现的照常显示。
   * 旧实现按整批签名判断，任何一条变动都会让清掉的全部复活（用户以为清除没生效）。
   */
  const [dismissed, setDismissed] = useState<DismissedState>(readDismissed);
  /** 当前这批里被清除过的条数（用于空态文案） */
  const clearedCount = useMemo(
    () => items.filter(i => dismissed.keys[i.key]).length,
    [items, dismissed],
  );
  const visible = useMemo(
    () => items.filter(i => !dismissed.keys[i.key]),
    [items, dismissed],
  );

  /** 全部清除：把当前所有 key 记进已读集合 */
  const clearAll = () => {
    if (!items.length) return;
    const now = Date.now();
    const next: DismissedState = { keys: { ...dismissed.keys } };
    for (const it of items) next.keys[it.key] = now;
    writeDismissed(next);
    setDismissed(next);
  };

  /** 恢复显示：清空已读集合（所有清除过的都回来） */
  const restore = () => {
    try { localStorage.removeItem(LS_DISMISSED); } catch { /* 忽略 */ }
    setDismissed({ keys: {} });
  };

  const go = (page?: string) => {
    if (!page) return;
    onClose();
    setTimeout(() => onNavigate(page), 0);
  };

  const groups = useMemo(() => {
    const map = new Map<string, Item[]>();
    visible.forEach((it) => {
      const arr = map.get(it.group) || [];
      arr.push(it);
      map.set(it.group, arr);
    });
    return Array.from(map.entries());
  }, [visible]);

  return (
    <Modal open={open} onClose={onClose} title={visible.length ? `提醒（${visible.length}）` : '提醒'}>
      {loading && !items.length ? (
        <div className="notice-empty">正在汇总…</div>
      ) : visible.length === 0 ? (() => {
        // 一键清除后的空态：用户要求「清除之后消息中心为空，不存在任何内容」。
        // 所以这里只留一句「暂无提醒」+ 一个恢复入口，不再堆「已清除 N 条」的说明文字。
        if (clearedCount > 0) {
          return (
            <div className="notice-empty">
              <Icons.check size={16} />
              <div>
                <div>暂无提醒</div>
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={restore}>恢复已清除的提醒</button>
              </div>
            </div>
          );
        }
        const checked = !!(zt && zt.lastCheck);
        const off = !!(zt && !zt.enabled && !zt.staleOn);
        return (
          <div className="notice-empty">
            <Icons.check size={16} />
            <div>
              <div>{checked ? '暂无提醒' : off ? '提醒还没开启' : '禅道还没检查过'}</div>
              <div className="notice-sub">
                {checked
                  ? '超期缺陷、不可达环境、久未备份都会出现在这里'
                  : off
                    ? '去「设置 › 定时任务」打开「新 Bug 检查」或「超期提醒」，这里才会有数据'
                    : '去「设置 › 定时任务」点一次「检查一次」，之后这里才会有超期数据'}
              </div>
            </div>
          </div>
        );
      })() : (
        <div className="notice-list">
          <div className="notice-toolbar">
            <span className="notice-sub">共 {visible.length} 项</span>
            <button className="btn btn-ghost btn-sm" onClick={clearAll}>全部清除</button>
          </div>
          {groups.map(([group, list]) => (
            <div key={group} className="notice-group">
              <div className="notice-group-head">{group}</div>
              {list.map((it) => (
                <button
                  key={it.key}
                  className={`notice-item is-${it.tone}`}
                  onClick={() => go(it.page)}
                  disabled={!it.page}
                >
                  <span className="notice-dot" />
                  <span className="notice-body">
                    <span className="notice-title">{it.title}</span>
                    {it.detail && <span className="notice-detail">{it.detail}</span>}
                  </span>
                  {it.page && <Icons.chevron size={13} />}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="notice-foot">
        只汇总当前状态，不保留提醒历史；禅道数据来自上次定时检查，可在设置 › 定时任务里点「检查一次」刷新。
      </div>
    </Modal>
  );
}
