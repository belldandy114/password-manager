/**
 * AutoUnlockCard.tsx —— 设置 → 安全 → **启动免密**卡（1.37.0，契约 §2.3 / §2.6 / §2.9）
 *
 * 三条不可越界的约定：
 * 1. **渲染层拿不到明文**：主密码只在「开启」这一步作为入参传给 `auth:enable-auto-unlock`，
 *    用完立刻从 state 清掉；不做任何本地持久化（不写 localStorage/sessionStorage）。
 * 2. **真源是 `autologin.json`**（契约 D2）：本卡片的开关状态一律来自 `auth:auto-unlock-status`，
 *    **不**写进 AppSettings（那会造成「设置说开、文件已删」的双真源漂移）。
 * 3. 开关只在 `available === true` 时可用；`safeStorage` 不可用时置灰并说明原因（契约 E6）。
 *
 * 启动态的 reason（`session-locked` / `decrypt-failed` …）来自 `auth:auto-unlock`，由 App.tsx
 * 调 `noteAutoUnlockResult()` 记到模块内存里，本卡片挂载时读出来显示 —— 这样文案只有一份，
 * 也不会为了展示而多调一次解密接口。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../hooks/useToast';
import { formatDateTime } from '../../utils/time';
import type { AutoUnlockReasonCode, AutoUnlockStatus } from '../../types';

/**
 * reasonCode → 人话（契约 §2.2 的 status 三种 + §2.5 的启动态 reason，一个都不许落空）。
 * 文案是「人可读」层，措辞可调，语义不得变。
 */
export const AUTO_UNLOCK_REASON_TEXT: Record<AutoUnlockReasonCode, string> = {
  'safe-storage-unavailable': '系统未提供安全存储（DPAPI 不可用），启动免密不可用',
  'autologin-corrupt': '启动免密配置文件已损坏，已自动停用',
  'autologin-version-unsupported': '启动免密配置版本不受支持，已停用（文件保留，等升级迁移）',
  'not-setup': '尚未初始化主密码，先设置主密码再开启启动免密',
  'no-credential': '未保存启动免密凭据，本次需要输入主密码',
  'session-locked': '本次已手动锁定，需输入主密码才能进入',
  'decrypt-failed': '启动免密凭据已失效（已自动清除），请重新开启',
  'vault-corrupt': '数据损坏，无法解密（可尝试从备份恢复）',
};

/** 开启失败的错误码 → 人话（契约 §2.3 错误码表；`error` 字段优先，这里只是兜底） */
const ENABLE_ERROR_TEXT: Record<string, string> = {
  locked: '请先解锁应用再开启启动免密',
  'not-setup': '尚未初始化主密码',
  'invalid-argument': '请先输入主密码',
  'wrong-password': '主密码不正确',
  'rate-limited': '尝试次数过多，请 30 秒后再试',
  'safe-storage-unavailable': '系统未提供安全存储（DPAPI 不可用），无法安全保存主密码',
  'write-failed': '写入启动免密配置失败，请重试',
  'delete-failed': '关闭启动免密失败，请重试',
};

/**
 * 上一次启动自动解锁的结果（**只存内存**，进程重启即归零）。
 * App.tsx 在启动时序里写，本卡片挂载时读 —— 避免为了展示文案再调一次 `auth:auto-unlock`。
 */
let lastStartupReason: AutoUnlockReasonCode | null = null;

/** App.tsx 启动时序调用：把这次自动解锁的 reasonCode 记下来给设置页展示 */
export function noteAutoUnlockResult(code?: AutoUnlockReasonCode | null): void {
  lastStartupReason = code || null;
}

/** 本卡片读取上次启动的 reasonCode（没有则 null） */
export function lastAutoUnlockReason(): AutoUnlockReasonCode | null {
  return lastStartupReason;
}

export function AutoUnlockCard() {
  const { addToast } = useToast();
  const [status, setStatus] = useState<AutoUnlockStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  /** 开启流程：必须先输一次主密码（契约 D4：防「有人趁解锁态走开改开关」） */
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [startupReason] = useState<AutoUnlockReasonCode | null>(() => lastAutoUnlockReason());
  const passwordRef = useRef<HTMLInputElement>(null);

  const enabled = !!status?.enabled;
  const available = status ? status.available !== false : false;

  const refresh = useCallback(async () => {
    try {
      const r = await window.electronAPI.authAutoUnlockStatus();
      if (r.success && r.data) {
        setStatus(r.data);
        setLoadError('');
      } else {
        setLoadError(r.error || '读取启动免密状态失败');
      }
    } catch {
      setLoadError('读取启动免密状态失败');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (asking) passwordRef.current?.focus(); }, [asking]);

  const disable = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await window.electronAPI.authDisableAutoUnlock();
      if (r.success) {
        addToast('已关闭启动免密', 'success');
        await refresh();
      } else {
        setError(ENABLE_ERROR_TEXT[r.code || ''] || r.error || '关闭启动免密失败');
      }
    } catch {
      setError('关闭启动免密失败');
    } finally {
      setBusy(false);
    }
  };

  const enable = async () => {
    if (!password.trim()) { setError(ENABLE_ERROR_TEXT['invalid-argument']); passwordRef.current?.focus(); return; }
    setBusy(true);
    setError('');
    try {
      // 明文只在这里作为入参用一次，返回后立刻清空 state（不落盘、不进日志）
      const r = await window.electronAPI.authEnableAutoUnlock({ password });
      setPassword('');
      if (r.success) {
        setAsking(false);
        addToast('已开启启动免密', 'success');
        await refresh();
      } else {
        setError(ENABLE_ERROR_TEXT[r.code || ''] || r.error || '开启启动免密失败');
        if (r.code === 'locked' || r.code === 'safe-storage-unavailable') setAsking(false);
      }
    } catch {
      setPassword('');
      setError('开启启动免密失败');
    } finally {
      setBusy(false);
    }
  };

  const reasonText = status?.reasonCode ? AUTO_UNLOCK_REASON_TEXT[status.reasonCode] : '';
  const startupReasonText = startupReason ? AUTO_UNLOCK_REASON_TEXT[startupReason] : '';

  return (
    <div className="settings-section au-card" data-au-card="1" data-au-enabled={enabled ? '1' : '0'} data-au-available={available ? '1' : '0'}>
      <h3>启动免密</h3>
      <div className="setting-row">
        <div style={{ minWidth: 0 }}>
          <div className="setting-label">开机自动解锁</div>
          <div className="setting-desc">
            用系统安全存储（Windows DPAPI）保存主密码密文，下次启动直接进入主界面，不必再输主密码。
          </div>
          {/* 代价必须常显，不能只写进 title（关键信息不得只靠 hover） */}
          <div className="au-cost" data-au-cost="1">
            ⚠ 代价：任何能登录本机这个账号的人，都能打开本应用看到里面的密码。公共/共享电脑不要开启。
          </div>
          {enabled && status?.updatedAt && (
            <div className="text-sm text-muted au-updated" data-au-updated="1">
              开启时间：{formatDateTime(status.updatedAt)}
            </div>
          )}
        </div>
        <div className="setting-control">
          <label className="switch">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || !available || asking}
              onChange={() => {
                if (busy || !available || asking) return;
                setError('');
                if (enabled) void disable();
                else { setPassword(''); setAsking(true); }
              }}
              aria-label="开机自动解锁"
              data-au-switch="1"
            />
            <span className="switch-slider" />
          </label>
        </div>
      </div>

      {!available && status && (
        <div className="au-reason" data-au-unavailable="1" role="status">
          {AUTO_UNLOCK_REASON_TEXT['safe-storage-unavailable']}（开关已置灰）
        </div>
      )}
      {available && reasonText && status?.reasonCode && status.reasonCode !== 'not-setup' && (
        <div className="au-reason" data-au-reason={status.reasonCode} role="status">{reasonText}</div>
      )}
      {startupReasonText && (
        <div className="au-reason" data-au-startup-reason={startupReason || ''} role="status">
          上次启动：{startupReasonText}
        </div>
      )}

      {asking && (
        <div className="au-form" data-au-form="1">
          <div className="setting-label">输入主密码以开启启动免密</div>
          <div className="au-form-row">
            <input
              ref={passwordRef}
              type="password"
              value={password}
              placeholder="当前主密码"
              aria-label="当前主密码"
              data-au-password="1"
              disabled={busy}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void enable(); }}
            />
            <button className="btn btn-sm btn-primary" data-au-confirm="1" disabled={busy} onClick={() => void enable()}>
              {busy ? '开启中…' : '开启'}
            </button>
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => { setAsking(false); setPassword(''); setError(''); }}>
              取消
            </button>
          </div>
          <div className="text-sm text-muted au-form-note">
            主密码只用于这一步校验：密文由系统安全存储加密后落盘，明文不留在渲染层、不写日志。
          </div>
        </div>
      )}

      {error && <div className="au-error" data-au-error="1" role="alert">{error}</div>}
      {loadError && <div className="au-error" data-au-load-error="1" role="alert">{loadError}</div>}
    </div>
  );
}
