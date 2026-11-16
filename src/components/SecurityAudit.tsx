import React, { useMemo } from 'react';
import type { PasswordEntry } from '../types';
import { Modal } from './Modal';
import { Icons } from './ui';
import { useStore } from '../store/useStore';
import { buildSecurityReport, PASSWORD_MAX_AGE_DAYS } from '../utils/security';

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
 *
 * ⚠️ 数据源必须统一走 `utils/security.ts`。
 * 这里以前有一份私有的 `WEAK` 集合（23 个），而 `utils/security.ts` 的 `COMMON_WEAK`
 * 有 46 个 + 键盘/字母序列检测 —— 同一个密码在「安全体检」弹窗里算弱密码、
 * 在卡片角标 / 工具栏风险计数里却不算（或反过来），两处结论互相打架。
 * 现在全部由 `buildSecurityReport` 出结论，本组件只负责分组展示。
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
    const byId = new Map(alive.map(e => [e.id, e]));
    const report = buildSecurityReport(alive);

    const nameOf = (e?: PasswordEntry) => e?.name || '（未命名）';
    const noteOf = (e?: PasswordEntry) => e?.url || '';

    // 1) 重复密码 —— 一组共用密码展开成逐条，方便点进去定位
    if (report.duplicates.length > 0) {
      const items = report.duplicates.flatMap(issue =>
        issue.entryIds.map(id => {
          const e = byId.get(id);
          return { id, name: nameOf(e), note: noteOf(e) };
        }),
      );
      out.push({
        key: 'dup', title: '重复密码', tone: 'bad',
        desc: `${report.duplicates.length} 组密码被多个条目共用，一处泄露会连带其他系统`,
        items,
      });
    }

    // 2) 弱密码 —— 判定口径来自 utils/security.ts（常见弱口令 + 长度 + 序列）
    if (report.weak.length > 0) {
      out.push({
        key: 'weak', title: '弱密码', tone: 'bad',
        desc: '长度不足 8 位、属于常见弱口令，或包含键盘/字母序列，容易被字典撞开',
        items: report.weak.map(issue => {
          const e = byId.get(issue.entryIds[0]);
          return {
            id: issue.entryIds[0],
            name: nameOf(e),
            // 用 security.ts 给出的具体原因（「极弱：常见弱密码」），比只写位数有用
            note: issue.detail || (e ? `${String(e.password || '').length} 位` : ''),
          };
        }),
      });
    }

    // 3) 空密码 —— buildSecurityReport 只给数量，这里按同一口径（password 为空）取明细
    const empty = alive.filter(e => !String(e.password || '').trim());
    if (empty.length > 0) {
      out.push({
        key: 'empty', title: '未填密码', tone: 'warn',
        desc: '这些条目没有保存密码，复制时会得到空内容',
        items: empty.map(e => ({ id: e.id, name: nameOf(e), note: noteOf(e) })),
      });
    }

    // 4) 长期未改（180 天）—— 阈值用 security.ts 的 PASSWORD_MAX_AGE_DAYS，别再写死 180
    if (report.expired.length > 0) {
      out.push({
        key: 'stale', title: `超过 ${PASSWORD_MAX_AGE_DAYS} 天未修改`, tone: 'mute',
        desc: '久未更换的密码风险更高，建议顺手改一次',
        items: report.expired.map(issue => {
          const e = byId.get(issue.entryIds[0]);
          // message 形如「「名称」密码已 200 天未修改」，取天数做角标
          const days = /(\d+)\s*天/.exec(issue.message)?.[1];
          return {
            id: issue.entryIds[0],
            name: nameOf(e),
            note: days ? `${days} 天` : (issue.detail || ''),
          };
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
                    key={`${g.key}:${it.id}`}
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
