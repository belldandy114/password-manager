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

/** 一键清除的落盘键：记住「清除时看到的那批事项」的签名 */
const LS_DISMISSED = 'pm.notices.dismissed';

function readDismissedSig(): string {
  try {
    const d = JSON.parse(localStorage.getItem(LS_DISMISSED) || 'null');
    return (d && typeof d.sig === 'string') ? d.sig : '';
  } catch { return ''; }
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

  /* ---------- 一键清除（1.24.4） ----------
   * 聚合是实时的，单纯把列表藏起来下次打开又会回来。按「事项集合的签名」记：
   * 清除时存下当时那批 key，下次打开只要集合没变就不再显示；
   * 出现任何新事项（签名变了）自动恢复展示，不会漏掉新提醒。
   */
  const [dismissedSig, setDismissedSig] = useState(readDismissedSig);
  const itemsSig = useMemo(() => items.map(i => i.key).join('|'), [items]);
  const clearedCount = useMemo(
    () => (dismissedSig && dismissedSig === itemsSig ? items.length : 0),
    [dismissedSig, itemsSig, items.length],
  );
  const visible = useMemo(
    () => (dismissedSig && dismissedSig === itemsSig ? [] : items),
    [dismissedSig, itemsSig, items],
  );

  const clearAll = () => {
    try { localStorage.setItem(LS_DISMISSED, JSON.stringify({ sig: itemsSig, at: Date.now() })); } catch { /* 忽略 */ }
    setDismissedSig(itemsSig);
  };
  const restore = () => {
    try { localStorage.removeItem(LS_DISMISSED); } catch { /* 忽略 */ }
    setDismissedSig('');
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
        // 一键清除后的空态：不是「没有提醒」，而是「这批你已经清掉了」
        if (clearedCount > 0) {
          return (
            <div className="notice-empty">
              <Icons.check size={16} />
              <div>
                <div>已清除 {clearedCount} 条提醒</div>
                <div className="notice-sub">状态没变化就不再打扰；出现新事项会自动恢复显示</div>
                <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={restore}>恢复显示</button>
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
              <div>{checked ? '暂时没有需要处理的' : off ? '提醒还没开启' : '禅道还没检查过'}</div>
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
            <span className="notice-sub">共 {visible.length} 项 · 清除后状态不变就不再显示</span>
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
