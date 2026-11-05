import React, { useMemo } from 'react';
import type { PasswordEntry } from '../types';
import { Modal } from './Modal';
import { Icons } from './ui';
import { useStore } from '../store/useStore';

const WEAK = new Set([
  '123456', '12345678', '123456789', '1234567890', 'password', 'passw0rd', 'p@ssword',
  'admin', 'admin123', 'root', 'qwerty', 'qwerty123', 'abc123', '111111', '000000',
  '888888', '666666', 'iloveyou', 'test123', 'test', '123123', 'a123456', '1qaz2wsx',
]);

const DAY = 24 * 3600 * 1000;

interface Issue {
  key: string;
  title: string;
  desc: string;
  tone: 'bad' | 'warn' | 'mute';
  items: { id: string; name: string; note: string }[];
}

/**
 * 安全体检：重复密码 / 弱密码 / 长期未改 / 空密码。
 * 只在打开时对内存里的 entries 做一次统计，不改任何数据。
 */
export function SecurityAudit({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick?: (name: string) => void;
}) {
  const entries = useStore(s => s.entries);

  const groups = useMemo<Issue[]>(() => {
    const out: Issue[] = [];
    const alive = entries.filter(e => e && e.id);

    // 1) 重复密码
    const byPwd = new Map<string, PasswordEntry[]>();
    alive.forEach(e => {
      const p = String(e.password || '');
      if (!p) return;
      const list = byPwd.get(p) || [];
      list.push(e);
      byPwd.set(p, list);
    });
    const dup = [...byPwd.values()].filter(list => list.length > 1).flat();
    if (dup.length > 0) {
      out.push({
        key: 'dup', title: '重复密码', tone: 'bad',
        desc: `${new Set(dup.map(e => e.password)).size} 组密码被多个条目共用，一处泄露会连带其他系统`,
        items: dup.map(e => ({ id: e.id, name: e.name || '（未命名）', note: e.url || '' })),
      });
    }

    // 2) 弱密码
    const weak = alive.filter(e => {
      const p = String(e.password || '');
      return p.length > 0 && (p.length < 8 || WEAK.has(p.toLowerCase()));
    });
    if (weak.length > 0) {
      out.push({
        key: 'weak', title: '弱密码', tone: 'bad',
        desc: '长度不足 8 位，或属于常见弱口令，容易被字典撞开',
        items: weak.map(e => ({ id: e.id, name: e.name || '（未命名）', note: `${String(e.password).length} 位` })),
      });
    }

    // 3) 空密码
    const empty = alive.filter(e => !String(e.password || '').trim());
    if (empty.length > 0) {
      out.push({
        key: 'empty', title: '未填密码', tone: 'warn',
        desc: '这些条目没有保存密码，复制时会得到空内容',
        items: empty.map(e => ({ id: e.id, name: e.name || '（未命名）', note: e.url || '' })),
      });
    }

    // 4) 长期未改（180 天）
    const stale = alive.filter(e => {
      const t = e.passwordUpdatedAt || e.updatedAt || e.createdAt;
      if (!t) return false;
      const ts = new Date(t).getTime();
      return Number.isFinite(ts) && Date.now() - ts > 180 * DAY;
    });
    if (stale.length > 0) {
      out.push({
        key: 'stale', title: '超过 180 天未修改', tone: 'mute',
        desc: '久未更换的密码风险更高，建议顺手改一次',
        items: stale.map(e => {
          const t = e.passwordUpdatedAt || e.updatedAt || e.createdAt;
          const days = Math.floor((Date.now() - new Date(t).getTime()) / DAY);
          return { id: e.id, name: e.name || '（未命名）', note: `${days} 天` };
        }),
      });
    }

    return out;
  }, [entries]);

  const total = groups.reduce((s, g) => s + g.items.length, 0);

  return (
    <Modal open={open} onClose={onClose} title="安全体检" footer={<button className="btn btn-secondary" onClick={onClose}>关闭</button>}>
      {total === 0 ? (
        <div className="audit-ok">
          <Icons.check size={22} />
          <div>
            <div className="audit-ok-title">没有发现问题</div>
            <div className="pg-sub" style={{ marginTop: 4 }}>
              共检查 {entries.length} 条：无重复、无弱密码、无空密码、近半年都更新过。
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="audit-summary">
            共检查 {entries.length} 条，发现 <strong>{total}</strong> 处值得处理
          </div>
          {groups.map(g => (
            <div className="audit-group" key={g.key}>
              <div className="audit-group-head">
                <span className={`audit-tag is-${g.tone}`}>{g.title}</span>
                <span className="audit-count">{g.items.length} 条</span>
                <span className="audit-group-desc">{g.desc}</span>
              </div>
              <div className="audit-items">
                {g.items.map(it => (
                  <button
                    key={it.id}
                    className="audit-item"
                    onClick={() => { onPick?.(it.name); onClose(); }}
                    title="定位到该条目"
                  >
                    <span className="audit-item-name">{it.name}</span>
                    {it.note && <span className="audit-item-note">{it.note}</span>}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </>
      )}
    </Modal>
  );
}
