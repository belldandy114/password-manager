/**
 * UninstallCard.tsx —— 设置 → 危险区 → **卸载软件**卡（1.37.0，契约 §3.1 / §3.3 / §3.5）
 *
 * 三条硬约束（越界即契约不通过）：
 * 1. **不自己拼路径**：数据目录绝对路径与体积一律用 `app:uninstall-info` 的返回值回显；
 *    渲染层不做路径比较（`tsconfig` 是 `types: []`，引 `path` 会直接编译失败）。
 * 2. **两层确认**（契约 §3.5）：第一层三选（仅卸载 / 卸载并删除数据 / 取消），
 *    第二层**必须回显 `dataDir` 绝对路径 + 体积 + breakdown 前 3 项**才能执行删除。
 * 3. `removeData === true` 时把回显用的那个字符串**原样**作为 `dataDirAck` 传回
 *    （防「弹框期间数据目录被迁移」的路径竞态）；渲染层不判断 ack 对不对，那是主进程职责。
 *
 * 卸载进行中按钮禁用；主进程侧还有 `busy` 守卫，这里只是不让人重复点。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Modal } from '../Modal';
import { useToast } from '../../hooks/useToast';
import type { UninstallInfo, UninstallResult } from '../../types';

/** 体积显示：18.0 MB / 860 KB / 12 B */
function fmtSize(n: number | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 错误码 → 人话（契约附录 A；`error` 字段优先，这里只是兜底） */
const UNINSTALL_ERROR_TEXT: Record<string, string> = {
  locked: '请先解锁应用',
  'info-failed': '读取卸载信息失败',
  'invalid-argument': '参数不合法，请重试',
  'ack-mismatch': '数据目录已变化，请重新确认',
  busy: '卸载已在进行中',
  'no-uninstaller': '未找到卸载程序，请到系统「设置 → 应用」里卸载',
  'spawn-failed': '启动卸载程序失败，请到系统「设置 → 应用」里卸载',
  'delete-failed': '删除数据失败，请重试或手工删除',
  internal: '操作失败，请重试',
};

/** 第一层选择 */
type Stage = 'idle' | 'choose' | 'confirm';

export function UninstallCard() {
  const { addToast } = useToast();
  const [info, setInfo] = useState<UninstallInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<Stage>('idle');
  const [result, setResult] = useState<UninstallResult | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await window.electronAPI.appUninstallInfo();
      if (r.success && r.data) {
        setInfo(r.data);
        setError('');
      } else {
        setError(UNINSTALL_ERROR_TEXT[r.code || ''] || r.error || '读取卸载信息失败');
      }
    } catch {
      setError('读取卸载信息失败');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  /** 启动成功过就不再允许重复点（主进程的 uninstallInFlight 会一直为 true） */
  const launched = !!result?.launched;
  const disabled = busy || launched;

  const runUninstall = async (removeData: boolean) => {
    if (!info) return;
    setBusy(true);
    setError('');
    try {
      // removeData 为真时，ack 必须是**回显用的那个字符串**原样传回（契约 §3.5）
      const r = await window.electronAPI.appUninstall(removeData ? { removeData: true, dataDirAck: info.dataDir } : { removeData: false });
      if (!r.success) {
        setError(UNINSTALL_ERROR_TEXT[r.code || ''] || r.error || '卸载失败');
        if (r.code === 'ack-mismatch') await refresh();
        setStage(r.code === 'busy' ? 'idle' : 'idle');
        return;
      }
      const data = r.data || null;
      setResult(data);
      setStage('idle');
      if (data?.message) addToast(data.message, 'success');
      else addToast(data?.launched ? '卸载程序已启动，请按提示完成卸载' : '已按选择处理本地数据', 'success');
    } catch {
      setError('卸载失败，请重试');
      setStage('idle');
    } finally {
      setBusy(false);
    }
  };

  const breakdown = (info?.dataBreakdown || []).slice(0, 3);
  const isDev = info?.mode === 'dev';
  const unsupported = info ? !info.supported : false;

  return (
    <div className="settings-section un-card" data-un-card="1" data-un-mode={info?.mode || ''} data-un-supported={info ? (info.supported ? '1' : '0') : ''}>
      <h3>卸载软件</h3>
      <div className="setting-row">
        <div style={{ minWidth: 0 }}>
          <div className="setting-label">卸载{info?.productName || '本应用'}</div>
          <div className="setting-desc">
            卸载程序前会问一次是否同时删除本地数据。数据目录与体积来自主进程实测，不是界面上拼的。
          </div>
          <div className="un-meta">
            <span className="un-meta-k">数据目录</span>
            <span className="un-path" data-un-datadir="1" title={info?.dataDir || ''}>{info?.dataDir || '读取中…'}</span>
          </div>
          <div className="un-meta">
            <span className="un-meta-k">占用体积</span>
            <span data-un-datasize="1">
              {fmtSize(info?.dataSize)}
              {info?.dataSizeError ? `（${info.dataSizeError}，为下限值）` : ''}
            </span>
          </div>
          {breakdown.length > 0 && (
            <div className="un-breakdown" data-un-breakdown="1">
              {breakdown.map(b => (
                <span className="un-chip" key={b.dir}>{b.dir} · {fmtSize(b.size)}</span>
              ))}
            </div>
          )}
          {isDev && (
            <div className="un-note" data-un-dev="1">
              当前为源码运行（dev 模式）：不会启动卸载程序，源码目录请自行删除。
            </div>
          )}
          {unsupported && !isDev && (
            <div className="un-note" data-un-unsupported="1">
              未找到卸载程序，请到系统「设置 → 应用」里卸载；本地数据仍可按下面的选择处理。
            </div>
          )}
        </div>
        <div className="setting-control">
          <button
            className="btn btn-sm btn-danger"
            data-un-open="1"
            disabled={disabled || !info}
            onClick={() => { setResult(null); setError(''); setStage('choose'); }}
          >
            {launched ? '已启动卸载' : '卸载软件'}
          </button>
        </div>
      </div>

      {result && (
        <div className="un-result" data-un-result="1">
          {result.message
            || (result.launched
              ? '卸载程序已启动，请按它的提示完成卸载。'
              : '未启动卸载程序；本地数据已按你的选择处理。')}
          {result.removedData && <span className="un-result-sub">（已删除本地受管数据：{fmtSize(result.dataSizeBefore)}）</span>}
        </div>
      )}
      {error && <div className="au-error" data-un-error="1" role="alert">{error}</div>}

      {/* ---------- 第一层：是否同时删除本地数据（三选） ---------- */}
      <Modal
        open={stage === 'choose'}
        onClose={() => !busy && setStage('idle')}
        title="卸载软件"
        footer={
          <>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setStage('idle')}>取消</button>
            <button className="btn btn-secondary" data-un-only="1" disabled={busy} onClick={() => void runUninstall(false)}>
              仅卸载程序
            </button>
            <button className="btn btn-danger" data-un-withdata="1" disabled={busy} onClick={() => setStage('confirm')}>
              卸载并删除数据
            </button>
          </>
        }
      >
        <p className="un-ask">卸载 {info?.productName || '本应用'} 时，要不要一起删掉本地缓存数据？</p>
        <div className="un-ask-list">
          <div><b>仅卸载程序</b>：只卸载应用，密码库、备份、附件都留在数据目录里，重装后可继续用。</div>
          <div><b>卸载并删除数据</b>：先删本地数据再启动卸载程序，删除后<b>无法恢复</b>（下一步会再确认一次）。</div>
        </div>
      </Modal>

      {/* ---------- 第二层：回显绝对路径 + 体积，必须再点一次确认 ---------- */}
      <Modal
        open={stage === 'confirm'}
        onClose={() => !busy && setStage('choose')}
        title="确认删除本地数据？"
        footer={
          <>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setStage('choose')}>返回</button>
            <button className="btn btn-danger" data-un-confirm="1" disabled={busy} onClick={() => void runUninstall(true)}>
              {busy ? '删除中…' : '确认删除并卸载'}
            </button>
          </>
        }
      >
        <p className="un-ask">下面这个目录里的<b>受管数据</b>会被删除，然后启动卸载程序。删除后无法恢复。</p>
        <div className="un-echo" data-un-echo="1">
          <div className="un-meta">
            <span className="un-meta-k">将删除的数据目录</span>
            {/* 绝对路径必须来自 app:uninstall-info 的返回值，渲染层不拼 */}
            <span className="un-path" data-un-echo-path="1">{info?.dataDir || '（未知）'}</span>
          </div>
          <div className="un-meta">
            <span className="un-meta-k">合计体积</span>
            <span data-un-echo-size="1">{fmtSize(info?.dataSize)}</span>
          </div>
          {breakdown.length > 0 && (
            <div className="un-breakdown">
              {breakdown.map(b => (
                <span className="un-chip" key={`echo-${b.dir}`}>{b.dir} · {fmtSize(b.size)}</span>
              ))}
            </div>
          )}
        </div>
        <div className="un-note">
          只删受管清单内的文件（密码库 / 备份 / 附件 / 日志等），不会递归删除整个目录；
          自定义附件目录如果不在数据目录下，不会被删除。
        </div>
      </Modal>
    </div>
  );
}
