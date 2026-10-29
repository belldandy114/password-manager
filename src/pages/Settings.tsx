import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { callIpc } from '../utils/ipc';
import { ToastContainer } from '../components/Toast';
import { Modal } from '../components/Modal';
import { Page, PageHead, Icons } from '../components/ui';
import type { KeybindingId, AppSettings, ThemeMode, BackupFile, AccentColor, NotifyStatus, AuditEntry, DataLocationInfo } from '../types';
import { applyTheme, applyAccent, ACCENTS } from '../utils/theme';
import { formatDateTime } from '../utils/time';

interface BrowserInfo {
  id: string;
  name: string;
}

interface KeybindingDef {
  id: KeybindingId;
  label: string;
  desc: string;
}

const KEYBINDING_DEFS: KeybindingDef[] = [
  { id: 'newEntry', label: '新增网址', desc: '快速添加新的密码记录' },
  { id: 'search', label: '搜索', desc: '聚焦到搜索输入框' },
  { id: 'settings', label: '打开设置', desc: '跳转到设置页面' },
  { id: 'lock', label: '锁定应用', desc: '立即锁定测试工具' },
  { id: 'trash', label: '回收站', desc: '打开回收站页面' },
  { id: 'import', label: '导入数据', desc: '打开导入页面' },
  { id: 'export', label: '导出数据', desc: '打开导出页面' },
];

type SettingsTab = 'security' | 'general' | 'browser' | 'shortcuts';

const TABS: { id: SettingsTab; label: string; icon: string; hint: string }[] = [
  { id: 'security', label: '安全', icon: '🔒', hint: '主密码 / 自动锁定 / 备份' },
  { id: 'general', label: '通用', icon: '⚙️', hint: '主题 / 剪贴板 / 启动行为' },
  { id: 'browser', label: '浏览器', icon: '🌐', hint: '路径与默认浏览器' },
  { id: 'shortcuts', label: '快捷键', icon: '⌨️', hint: '自定义按键' },
];

/** 下载体积显示：1.2 MB / 860 KB */
function fmtBytes(n: number): string {
  if (!n || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 剩余时间：48 秒 / 3 分 20 秒 */
function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${Math.ceil(seconds)} 秒`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} 分${s ? ` ${s} 秒` : ''}`;
}

export function Settings() {
  const settings = useStore(s => s.settings);
  const updateSettings = useStore(s => s.updateSettings);
  const { toasts, addToast, removeToast } = useToast();

  const [activeTab, setActiveTab] = useState<SettingsTab>('security');
  const [knownBrowsers, setKnownBrowsers] = useState<BrowserInfo[]>([]);
  const [browserPaths, setBrowserPaths] = useState<Record<string, string>>(settings.browserPaths || {});
  const [clipboardClearDelay, setClipboardClearDelay] = useState(settings.clipboardClearDelay);
  const [passwordAutoHideDelay, setPasswordAutoHideDelay] = useState(settings.passwordAutoHideDelay);
  const [autoLockDelay, setAutoLockDelay] = useState(settings.autoLockDelay);
  const [defaultViewMode, setDefaultViewMode] = useState(settings.defaultViewMode);
  const [minimizeToTray, setMinimizeToTray] = useState(settings.minimizeToTray);
  const [closeToTray, setCloseToTray] = useState(settings.closeToTray);
  const [contentProtection, setContentProtection] = useState(settings.contentProtection);
  const [launchAtLogin, setLaunchAtLogin] = useState(settings.launchAtLogin);
  const [zentaoNotify, setZentaoNotify] = useState(settings.zentaoNotify);
  const [zentaoNotifyInterval, setZentaoNotifyInterval] = useState(settings.zentaoNotifyInterval);
  // 提醒运行状态（是否已配置/解锁/上次检查）
  const [notifyStatus, setNotifyStatus] = useState<NotifyStatus | null>(null);
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [backupDir, setBackupDir] = useState('');
  const [backupKeep, setBackupKeep] = useState(settings.backupKeep || 7);
  // 异地备份目录（第二目录 / 网盘同步目录）
  const [mirrorDir, setMirrorDir] = useState(settings.backupMirrorDir || '');
  const [mirrorLastAt, setMirrorLastAt] = useState('');
  const [mirrorBusy, setMirrorBusy] = useState(false);
  const [backupLastAt, setBackupLastAt] = useState('');
  /** 待确认恢复的备份文件名（空=不显示确认框） */
  const [restoreName, setRestoreName] = useState('');
  const [restoring, setRestoring] = useState(false);
  /** 数据目录信息（路径 / 体积 / 备份份数） */
  const [dataInfo, setDataInfo] = useState<DataLocationInfo | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string; hasUpdate: boolean; url: string; downloadUrl?: string; assetName?: string; digest?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  // 应用内更新：下载进度 / 已下载文件
  const [downloading, setDownloading] = useState(false);
  // 多线程分段下载：更快，但会把 exe 拆成多个分片，部分杀软会误判（默认关闭）
  const [multiThread, setMultiThread] = useState(false);
  const [progress, setProgress] = useState({ received: 0, total: 0, speed: 0, threads: 1 });
  const [downloadedFile, setDownloadedFile] = useState('');
  // 下载失败时的提示与兜底（网络访问不了 GitHub CDN 时用）
  const [dlError, setDlError] = useState('');
  const [canMirror, setCanMirror] = useState(false);
  const [viaMirror, setViaMirror] = useState(false);

  useEffect(() => {
    const off = window.electronAPI.onUpdateProgress?.((p) => setProgress({
      received: p.received || 0,
      total: p.total || 0,
      speed: p.speed || 0,
      threads: p.threads || 1,
    }));
    return off;
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const r = await window.electronAPI.auditList?.(30);
      if (r && r.success) setAudit(r.data || []);
    } catch { /* 忽略 */ }
  }, []);

  const refreshNotifyStatus = useCallback(async () => {
    try {
      const r = await window.electronAPI.zentaoNotifyStatus?.();
      if (r && r.success) setNotifyStatus(r.data || null);
    } catch { /* 忽略 */ }
  }, []);

  useEffect(() => {
    refreshNotifyStatus();
    loadAudit();
  }, [refreshNotifyStatus, loadAudit]);

  const downloadUpdate = async (mirror = false) => {
    const url = updateInfo?.downloadUrl;
    if (!url) { addToast('这个版本没有可用的安装包，请到发布页手动下载', 'error'); return; }
    setDownloading(true);
    setDlError('');
    setProgress({ received: 0, total: 0, speed: 0, threads: 1 });
    const res = await window.electronAPI.updateDownload(url, mirror, {
      expectedSha256: updateInfo?.digest || '',
      threads: multiThread,
    });
    setDownloading(false);
    if (res.success && res.data) {
      setDownloadedFile(res.data.file);
      setCanMirror(false);
      setDlError('');
      setViaMirror(!!mirror);
      const shaTip = res.data.verified
        ? ' · SHA-256 已校验'
        : (res.data.sha256 ? ` · SHA-256 ${res.data.sha256.slice(0, 12)}…` : '');
      addToast(`下载完成，点「安装并重启」即可更新（${res.data.via || 'GitHub'}${res.data.threads && res.data.threads > 1 ? ` · ${res.data.threads} 线程加速` : ''}${shaTip}）`, 'success');
    } else {
      setDlError(res.error || '下载失败');
      setCanMirror(!!res.canMirror);
    }
  };

  /** 兜底：让用户自己选已下载好的安装包 */
  const pickLocalSetup = async () => {
    const res = await window.electronAPI.updatePickFile();
    if (res.canceled) return;
    if (res.success && res.data) {
      setDownloadedFile(res.data.file);
      setDlError('');
      addToast('已选择安装包，点「安装并重启」开始更新', 'success');
    } else {
      addToast(res.error || '选择文件失败', 'error');
    }
  };

  const installUpdate = async () => {
    if (!downloadedFile) return;
    const res = await window.electronAPI.updateInstall(downloadedFile);
    if (!res.success) addToast(res.error || '启动安装失败', 'error');
    else addToast('安装程序已启动，应用会自动退出，按向导完成即可', 'success');
  };

  const checkUpdate = async () => {
    setChecking(true);
    const res = await window.electronAPI.updateCheck();
    setChecking(false);
    if (res.success && res.data) {
      setUpdateInfo(res.data);
      addToast(res.data.hasUpdate ? `发现新版本 ${res.data.latest}` : '已是最新版本', res.data.hasUpdate ? 'success' : 'info');
    } else {
      addToast('检查更新失败：' + (res.error || '网络不可用'), 'error');
    }
  };
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [newPwd2, setNewPwd2] = useState('');
  const [showSecurityWord, setShowSecurityWord] = useState(false);
  const [swPassword, setSwPassword] = useState('');
  const [securityWord, setSecurityWord] = useState('');
  const [securityWord2, setSecurityWord2] = useState('');
  const [hasSecurityWord, setHasSecurityWord] = useState(false);

  // Keybinding editing state
  const [localKeybindings, setLocalKeybindings] = useState<Record<KeybindingId, string>>(settings.keybindings);
  const [editingKeybinding, setEditingKeybinding] = useState<KeybindingId | null>(null);

  useEffect(() => {
    window.electronAPI.authHasSecurityWord().then(setHasSecurityWord);
  }, []);

  useEffect(() => {
    window.electronAPI.browserGetKnown().then(setKnownBrowsers);
  }, []);

  // 备份列表（进入安全页时刷新）
  const refreshBackups = useCallback(async () => {
    const res = await window.electronAPI.backupList();
    if (res.success) {
      setBackups(res.data);
      setBackupDir(res.dir);
    }
    // 异地备份状态（同步盘目录里最近一份的时间）
    const st = await window.electronAPI.backupStatus();
    if (st.success && st.data) {
      const mirror = st.data.mirror;
      setMirrorLastAt(mirror.lastAt || '');
      if (mirror.dir) setMirrorDir(cur => cur || mirror.dir);
    }
    const info = await window.electronAPI.dataInfo();
    if (info.success && info.data) setDataInfo(info.data);
  }, []);

  useEffect(() => {
    if (activeTab === 'security') refreshBackups();
  }, [activeTab, refreshBackups]);

  /** 选异地备份目录（可直接选 OneDrive / 坚果云 的同步文件夹） */
  const pickMirrorDir = async () => {
    const r = await window.electronAPI.backupMirrorPick();
    if (!r.success || !r.data) return;
    setMirrorDir(r.data);
    addToast('已选择异地备份目录，记得点「保存设置」', 'success');
  };

  /** 立即备份一次：本地 + 异地，并把结果说清楚 */
  const runBackupNow = async () => {
    setMirrorBusy(true);
    const r = await window.electronAPI.backupNow();
    setMirrorBusy(false);
    if (!r.success || !r.data) {
      addToast(r.error || '备份失败', 'error');
      return;
    }
    const m = r.data.mirror;
    if (m.skipped) addToast('已备份到本地；未配置异地目录', 'info');
    else if (m.ok) addToast('已同时写入异地目录', 'success');
    else addToast(`本地已备份，异地写入失败：${m.error || '未知原因'}`, 'error');
    await refreshBackups();
  };

  const handleSave = async () => {
    const prefs = {
      clipboardClearDelay: Math.max(5, Math.min(300, clipboardClearDelay)),
      passwordAutoHideDelay: Math.max(3, Math.min(120, passwordAutoHideDelay)),
      autoLockDelay: Math.max(1, Math.min(60, autoLockDelay)),
      defaultViewMode,
      minimizeToTray,
      closeToTray,
      browserPaths,
      zentaoNotify,
      zentaoNotifyInterval: Math.max(2, Math.min(120, zentaoNotifyInterval)),
      backupKeep: Math.max(1, Math.min(60, backupKeep)),
      backupMirrorDir: mirrorDir,
      theme: settings.theme,
      keybindings: localKeybindings,
    };
    updateSettings(prefs);
    const saved = await callIpc(() => window.electronAPI.settingsSave(prefs));
    if (!saved.ok) { addToast(`保存失败：${saved.error}`, 'error'); return; }
    addToast('设置已保存', 'success');
  };

  // Tray behaviours take effect immediately (no need to hit 保存设置) — the main process
  // creates/destroys the tray icon on settings:save.
  const applyTraySetting = async (patch: { minimizeToTray?: boolean; closeToTray?: boolean }) => {
    updateSettings(patch);
    const saved = await callIpc(() => window.electronAPI.settingsSave(patch));
    if (!saved.ok) { addToast(`保存失败：${saved.error}`, 'error'); return; }
    addToast('窗口设置已更新', 'success');
  };

  const handleSelectBrowserPath = async (id: string) => {
    const result = await window.electronAPI.dialogOpenFile({
      filters: [{ name: '可执行文件', extensions: ['exe'] }]
    });
    if (result.canceled || !result.filePath) return;
    setBrowserPaths(prev => ({ ...prev, [id]: result.filePath } as Record<string, string>));
  };

  const handleChangePassword = async () => {
    if (!oldPwd) { addToast('请输入当前密码', 'error'); return; }
    if (newPwd.length < 8) { addToast('新密码至少8位', 'error'); return; }
    if (newPwd !== newPwd2) { addToast('两次密码不一致', 'error'); return; }
    const result = await window.electronAPI.authChangePassword({ oldPassword: oldPwd, newPassword: newPwd });
    if (result.success) {
      addToast('主密码已修改', 'success');
      setShowChangePwd(false);
      setOldPwd('');
      setNewPwd('');
      setNewPwd2('');
    } else {
      addToast(result.error || '修改失败', 'error');
    }
  };

  const handleSetSecurityWord = async () => {
    if (!swPassword) { addToast('请输入主密码验证身份', 'error'); return; }
    if (!securityWord || securityWord.length < 2) { addToast('安全词至少2个字符', 'error'); return; }
    if (securityWord !== securityWord2) { addToast('两次安全词不一致', 'error'); return; }
    const result = await window.electronAPI.authSetSecurityWord({ password: swPassword, securityWord });
    if (result.success) {
      addToast('安全词已设置', 'success');
      setHasSecurityWord(true);
      setShowSecurityWord(false);
      setSwPassword('');
      setSecurityWord('');
      setSecurityWord2('');
    } else {
      addToast(result.error || '设置失败', 'error');
    }
  };

  // --- Keybinding capture logic ---
  const startCapture = useCallback((id: KeybindingId) => {
    setEditingKeybinding(id);
  }, []);

  const handleCaptureKey = useCallback((e: React.KeyboardEvent) => {
    if (!editingKeybinding) return;
    e.preventDefault();
    e.stopPropagation();

    // Escape cancels
    if (e.key === 'Escape') {
      setEditingKeybinding(null);
      return;
    }

    // Require at least Ctrl or Cmd
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl && e.key !== 'Escape') return;

    // Build key string
    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.shiftKey) parts.push('Shift');

    // Map key names
    let key = e.key;
    if (key === ',') key = ',';
    else if (key === 'Control' || key === 'Shift' || key === 'Meta') return;
    else key = key.length === 1 ? key.toLowerCase() : key;

    parts.push(key);
    const combo = parts.join('+');

    setLocalKeybindings(prev => ({ ...prev, [editingKeybinding]: combo }));
    setEditingKeybinding(null);
  }, [editingKeybinding]);

  // Sync localKeybindings when settings.keybindings changes from outside
  useEffect(() => {
    setLocalKeybindings(settings.keybindings);
  }, [settings.keybindings]);

  const renderTabContent = () => {
    switch (activeTab) {
      case 'security':
        return (
          <div className="settings-section">
            <h3>主密码</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">修改主密码</div>
                <div className="setting-desc">修改解锁应用的主密码</div>
              </div>
              <button className="btn btn-sm btn-secondary" onClick={() => setShowChangePwd(true)}>修改密码</button>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">安全词</div>
                <div className="setting-desc">{hasSecurityWord ? '已设置，用于忘记主密码时重置' : '未设置，设置后可通过安全词重置主密码'}</div>
              </div>
              <button className="btn btn-sm btn-secondary" onClick={() => setShowSecurityWord(true)}>
                {hasSecurityWord ? '修改安全词' : '设置安全词'}
              </button>
            </div>

            <h3 style={{ marginTop: 24 }}>自动锁定</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">自动锁定 (分钟)</div>
                <div className="setting-desc">无操作后自动锁定应用</div>
              </div>
              <div className="setting-control">
                <input type="number" value={autoLockDelay} onChange={e => setAutoLockDelay(Number(e.target.value))} min={1} max={60} />
                <span className="text-sm text-muted">分钟</span>
              </div>
            </div>

            <h3 style={{ marginTop: 24 }}>数据备份</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">自动备份</div>
                <div className="setting-desc">
                  每次修改数据时，若当天尚无备份则自动保存一份加密副本；
                  {backupLastAt ? `上次备份 ${formatDateTime(backupLastAt)}` : '还没有备份（首次修改数据后生成）'}
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="number"
                  value={backupKeep}
                  min={1}
                  max={60}
                  onChange={e => setBackupKeep(Number(e.target.value))}
                  style={{ width: 70 }}
                />
                <span className="text-sm text-muted">份</span>
                <button className="btn btn-sm btn-secondary" onClick={() => window.electronAPI.backupOpenFolder()}>
                  打开备份目录
                </button>
              </div>
            </div>
            {/* 异地备份：第二目录 / 网盘同步目录 */}
            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">异地备份（第二目录 / 网盘）</div>
                <div className="setting-desc" style={{ wordBreak: 'break-all' }}>
                  {mirrorDir
                    ? <>每天备份时同时写一份到：<code>{mirrorDir}</code>{mirrorLastAt ? `（最近 ${formatDateTime(mirrorLastAt)}）` : '（还没写过）'}</>
                    : '未启用。可以指向 OneDrive / 坚果云 等同步盘的本地文件夹，备份会同时写一份过去，硬盘坏了也还有一份。'}
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-secondary" onClick={pickMirrorDir} disabled={mirrorBusy}>
                  选择目录
                </button>
                <button className="btn btn-sm btn-secondary" onClick={runBackupNow} disabled={mirrorBusy}>
                  {mirrorBusy ? '备份中…' : '立即备份'}
                </button>
                {mirrorDir && (
                  <button className="btn btn-sm btn-ghost" onClick={() => setMirrorDir('')} title="只清空路径，不删文件">
                    停用
                  </button>
                )}
              </div>
            </div>

            <div className="backup-list">
              {backups.length === 0 ? (
                <div className="text-sm text-muted">暂无备份（首次修改数据后自动生成）</div>
              ) : (
                backups.map(b => (
                  <div key={b.name} className="backup-item">
                    <span className="backup-name">{b.name}</span>
                    <span className="text-sm text-muted">{(b.size / 1024).toFixed(1)} KB</span>
                    <span className="text-sm text-muted">{formatDateTime(b.mtime)}</span>
                    <button className="btn btn-sm btn-ghost" onClick={() => setRestoreName(b.name)}>
                      恢复
                    </button>
                  </div>
                ))
              )}
              {backupDir && <div className="backup-dir text-sm text-muted" title={backupDir}>{backupDir}</div>}
            </div>

            <h3 style={{ marginTop: 24 }}>数据目录</h3>
            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">当前数据位置</div>
                <div className="setting-desc" style={{ wordBreak: 'break-all' }} title={dataInfo?.dataDir || ''}>
                  {dataInfo?.dataDir || '读取中…'}
                  {dataInfo?.isCustom ? '（自定义）' : '（默认）'}
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  {dataInfo?.vault ? `密码库 ${(dataInfo.vault.size / 1024).toFixed(1)} KB` : '密码库尚未创建'}
                  {dataInfo?.bak ? ` · 备用副本 ${(dataInfo.bak.size / 1024).toFixed(1)} KB` : ''}
                  {dataInfo ? ` · 备份 ${dataInfo.backupCount} 份` : ''}
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-secondary" onClick={() => window.electronAPI.dataOpenFolder('data')}>
                  打开目录
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={async () => {
                    const r = await window.electronAPI.dataMigrate();
                    if (r.canceled) return;
                    if (!r.success) { addToast(r.error || '迁移失败', 'error'); return; }
                    addToast('已复制到新目录，重启应用后生效', 'success');
                    refreshBackups();
                  }}
                >
                  迁移到其他盘
                </button>
                {dataInfo?.isCustom && (
                  <button
                    className="btn btn-sm btn-ghost"
                    onClick={async () => {
                      const r = await window.electronAPI.dataResetLocation();
                      if (!r.success) { addToast(r.error || '操作失败', 'error'); return; }
                      addToast('已改回默认目录，重启应用后生效', 'success');
                      refreshBackups();
                    }}
                  >
                    改回默认
                  </button>
                )}
              </div>
            </div>
            <div className="text-sm text-muted" style={{ marginTop: 6 }}>
              迁移只复制不删除，原目录会原样保留；确认新目录可用后可自行删除旧文件。
            </div>

            <h3 style={{ marginTop: 24 }}>审计日志</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">敏感操作记录</div>
                <div className="setting-desc">
                  记录复制密码等操作（只记条目名与时间，不记密码内容），最多保留 2000 条，仅存本机
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-sm btn-secondary" onClick={loadAudit}>刷新</button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={async () => {
                    await window.electronAPI.auditClear();
                    setAudit([]);
                    addToast('审计日志已清空', 'success');
                  }}
                >
                  清空
                </button>
              </div>
            </div>
            <div className="audit-list">
              {audit.length === 0 ? (
                <div className="text-sm text-muted">暂无记录（复制过一次密码就会出现）</div>
              ) : (
                audit.map((a, i) => (
                  <div key={`${a.at}-${i}`} className="audit-row">
                    <span className="audit-time">{formatDateTime(a.at)}</span>
                    <span className="audit-action">{a.action}</span>
                    <span className="audit-detail">{a.detail || ''}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        );

      case 'general':
        return (
          <div className="settings-section">
            <h3>显示</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">主题</div>
                <div className="setting-desc">选择浅色或深色主题</div>
              </div>
              <div className="setting-control">
                <select value={settings.theme} onChange={e => {
                  const val = e.target.value as ThemeMode;
                  updateSettings({ theme: val });
                  applyTheme(val);
                  window.electronAPI.settingsSave({ theme: val });
                }}>
                  <option value="dark">深色主题</option>
                  <option value="light">浅色主题</option>
                  <option value="system">跟随系统</option>
                </select>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div className="setting-label">强调色</div>
                <div className="setting-desc">按钮、选中态等强调元素的颜色</div>
              </div>
              <div className="setting-control accent-picker">
                {(Object.keys(ACCENTS) as AccentColor[]).map(key => (
                  <button
                    key={key}
                    className={`accent-dot ${(settings.accent || 'indigo') === key ? 'active' : ''}`}
                    style={{ background: ACCENTS[key].value }}
                    title={ACCENTS[key].label}
                    onClick={() => {
                      updateSettings({ accent: key });
                      applyAccent(key);
                      window.electronAPI.settingsSave({ accent: key });
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">默认视图</div>
                <div className="setting-desc">网址的默认显示模式</div>
              </div>
              <div className="setting-control">
                <select value={defaultViewMode} onChange={e => setDefaultViewMode(e.target.value as any)}>
                  <option value="card">卡片视图</option>
                  <option value="list">列表视图</option>
                </select>
              </div>
            </div>

            <h3 style={{ marginTop: 24 }}>剪贴板</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">复制密码后清空延迟 (秒)</div>
                <div className="setting-desc">复制密码后，剪贴板自动清空的时间 (5-300秒)</div>
              </div>
              <div className="setting-control">
                <input type="number" value={clipboardClearDelay} onChange={e => setClipboardClearDelay(Number(e.target.value))} min={5} max={300} />
                <span className="text-sm text-muted">秒</span>
              </div>
            </div>

            <h3 style={{ marginTop: 24 }}>密码显示</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">密码自动隐藏 (秒)</div>
                <div className="setting-desc">明文密码显示后自动恢复掩码的时间 (3-120秒)</div>
              </div>
              <div className="setting-control">
                <input type="number" value={passwordAutoHideDelay} onChange={e => setPasswordAutoHideDelay(Number(e.target.value))} min={3} max={120} />
                <span className="text-sm text-muted">秒</span>
              </div>
            </div>

            <h3 style={{ marginTop: 24 }}>禅道提醒</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">新 Bug 提醒</div>
                <div className="setting-desc">
                  后台定时检查「我的 Bug」，有新的指派给我就弹系统通知（需先在禅道页保存过账号密码）
                </div>
              </div>
              <div className="setting-control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!zentaoNotify}
                    onChange={async e => {
                      const val = e.target.checked;
                      setZentaoNotify(val);
                      updateSettings({ zentaoNotify: val });
                      await window.electronAPI.settingsSave({ zentaoNotify: val });
                      addToast(val ? '已开启新 Bug 提醒' : '已关闭新 Bug 提醒', 'success');
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">检查间隔（分钟）</div>
                <div className="setting-desc">最少 2 分钟；改完点「保存设置」生效</div>
              </div>
              <div className="setting-control">
                <input
                  type="number"
                  value={zentaoNotifyInterval}
                  onChange={e => setZentaoNotifyInterval(Number(e.target.value))}
                  min={2}
                  max={120}
                />
                <span className="text-sm text-muted">分钟</span>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">立即检查一次</div>
                <div className="setting-desc">
                  {notifyStatus
                    ? [
                      notifyStatus.configured ? '禅道账号已保存' : '⚠ 还没在禅道页保存账号密码',
                      notifyStatus.unlocked ? '已解锁' : '未解锁（锁定状态下不检查）',
                      notifyStatus.lastCheck
                        ? `上次检查 ${formatDateTime(notifyStatus.lastCheck.at)} · ${notifyStatus.lastCheck.ok
                          ? `成功，${notifyStatus.lastCheck.total} 条，新增 ${notifyStatus.lastCheck.fresh ?? 0} 条`
                          : `失败：${notifyStatus.lastCheck.error || '未知原因'}`}`
                        : '还没检查过',
                    ].join(' · ')
                    : '手动触发，用来确认配置是否可用'}
                </div>
              </div>
              <div className="setting-control">
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    const r = await window.electronAPI.zentaoNotifyNow();
                    await refreshNotifyStatus();
                    if (r.data?.ok) addToast(`检查完成：${r.data.total} 条，新增 ${r.data.fresh ?? 0} 条`, 'success');
                    else addToast(r.data?.error || '检查未执行（确认已开启提醒并已解锁）', 'error');
                  }}
                >
                  检查一次
                </button>
              </div>
            </div>

            <h3 style={{ marginTop: 24 }}>窗口与托盘</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">最小化到托盘</div>
                <div className="setting-desc">点击最小化时隐藏到系统托盘，不再占用任务栏</div>
              </div>
              <div className="setting-control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!minimizeToTray}
                    onChange={e => {
                      const val = e.target.checked;
                      setMinimizeToTray(val);
                      applyTraySetting({ minimizeToTray: val });
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">关闭窗口时最小化到托盘</div>
                <div className="setting-desc">
                  点右上角 × 时隐藏到托盘继续后台运行；退出请用托盘菜单的「退出」
                </div>
              </div>
              <div className="setting-control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!closeToTray}
                    onChange={e => {
                      const val = e.target.checked;
                      setCloseToTray(val);
                      applyTraySetting({ closeToTray: val });
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
            <div className="setting-desc" style={{ padding: '4px 0 0' }}>
              托盘图标单击可恢复窗口；全局快捷键 <kbd>Ctrl+Shift+P</kbd> 也可随时唤起。
            </div>

            <h3 style={{ marginTop: 24 }}>隐私与系统</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">防截屏 / 录屏</div>
                <div className="setting-desc">开启后窗口内容在截图和录屏中显示为黑屏（Windows 10+）</div>
              </div>
              <div className="setting-control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!contentProtection}
                    onChange={async e => {
                      const val = e.target.checked;
                      setContentProtection(val);
                      updateSettings({ contentProtection: val });
                      await window.electronAPI.settingsSave({ contentProtection: val });
                      addToast(val ? '已开启防截屏' : '已关闭防截屏', 'success');
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">开机自动启动</div>
                <div className="setting-desc">
                  登录 Windows 后自动启动，启动时静默驻留托盘不弹窗（需同时开启「最小化到托盘」或「关闭时最小化到托盘」；
                  这样新 Bug 提醒才能持续工作）
                </div>
              </div>
              <div className="setting-control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={!!launchAtLogin}
                    onChange={async e => {
                      const val = e.target.checked;
                      setLaunchAtLogin(val);
                      updateSettings({ launchAtLogin: val });
                      await window.electronAPI.settingsSave({ launchAtLogin: val });
                      addToast(val ? '已设置开机自启' : '已取消开机自启', 'success');
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>

            <h3 style={{ marginTop: 24 }}>关于</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">检查更新</div>
                <div className="setting-desc">
                  {updateInfo
                    ? (updateInfo.hasUpdate
                      ? `发现新版本 ${updateInfo.latest}（当前 ${updateInfo.current}）`
                      : `已是最新版本（${updateInfo.current}）`)
                    : '从 GitHub Releases 检查是否有新版本'}
                </div>
                {downloading && (
                  <div className="dl-bar">
                    <div
                      className="dl-bar-fill"
                      style={{ width: progress.total ? `${Math.min(100, (progress.received / progress.total) * 100)}%` : '20%' }}
                    />
                  </div>
                )}
                {downloading && progress.received > 0 && (
                  <div className="dl-meta">
                    <span>{fmtBytes(progress.received)}{progress.total ? ` / ${fmtBytes(progress.total)}` : ''}</span>
                    <span>{progress.speed ? `${fmtBytes(progress.speed)}/s` : '测速中…'}</span>
                    {progress.total > progress.received && progress.speed > 0 && (
                      <span>剩余 {fmtEta((progress.total - progress.received) / progress.speed)}</span>
                    )}
                    <span className="dl-meta-dim">{progress.threads > 1 ? `${progress.threads} 线程` : '单连接'}</span>
                    {progress.speed > 0 && progress.speed < 150 * 1024 && !viaMirror && (
                      <button className="btn btn-sm btn-ghost" onClick={() => downloadUpdate(true)} title="当前速度偏慢，换第三方加速节点重下">
                        太慢？换镜像
                      </button>
                    )}
                  </div>
                )}
                {dlError && (
                  <div className="dl-error">
                    <div>{dlError}</div>
                    <div className="dl-error-actions">
                      {updateInfo?.url && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => window.electronAPI.browserOpen({ browser: 'default', url: updateInfo.url })}
                        >
                          浏览器下载
                        </button>
                      )}
                      <button className="btn btn-sm btn-secondary" onClick={pickLocalSetup}>选择本地安装包</button>
                    </div>
                  </div>
                )}
                {downloadedFile && (
                  <div className="setting-desc">
                    已下载：{downloadedFile.split('\\').pop()}{viaMirror ? '（来自加速镜像）' : ''}
                  </div>
                )}
                {!downloadedFile && updateInfo?.hasUpdate && (
                  <label
                    className="dl-multi"
                    title="拆成 6 段并发下载，速度更快；但「分段拼装 exe」可能触发杀软误报（Trojan/Injector），默认关闭"
                  >
                    <input type="checkbox" checked={multiThread} onChange={e => setMultiThread(e.target.checked)} />
                    <span>多线程加速（部分杀软会误报）</span>
                  </label>
                )}
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {downloadedFile ? (
                  <button className="btn btn-sm btn-primary" onClick={installUpdate}>安装并重启</button>
                ) : updateInfo?.hasUpdate && (
                  <button className="btn btn-sm btn-primary" onClick={() => downloadUpdate(false)} disabled={downloading}>
                    {downloading
                      ? (progress.total
                        ? `下载中 ${Math.floor((progress.received / progress.total) * 100)}%`
                        : `已下载 ${(progress.received / 1024 / 1024).toFixed(1)} MB`)
                      : '下载并安装'}
                  </button>
                )}
                {canMirror && !downloadedFile && (
                  <button className="btn btn-sm btn-secondary" onClick={() => downloadUpdate(true)} disabled={downloading} title="走第三方 GitHub 加速节点下载安装包">
                    加速镜像重试
                  </button>
                )}
                {!downloadedFile && (
                  <button className="btn btn-sm btn-ghost" onClick={pickLocalSetup} disabled={downloading} title="已经用浏览器下好了？选它直接安装">
                    选择安装包
                  </button>
                )}
                {updateInfo?.url && (
                  <button className="btn btn-sm btn-ghost" onClick={() => window.electronAPI.browserOpen({ browser: 'default', url: updateInfo.url })}>
                    发布页
                  </button>
                )}
                <button className="btn btn-sm btn-secondary" onClick={checkUpdate} disabled={checking || downloading}>
                  {checking ? '检查中…' : '检查更新'}
                </button>
              </div>
            </div>
          </div>
        );

      case 'browser':
        return (
          <div className="settings-section browser-tab">
            <h3>浏览器路径</h3>
            {knownBrowsers.map(b => (
              <div key={b.id} className="setting-row">
                <div>
                  <div className="setting-label">{b.name} 路径</div>
                  <div className="setting-desc">留空则自动检测常见安装位置</div>
                </div>
                <div className="setting-control browser-path-control">
                  <input type="text" value={browserPaths[b.id] || ''} onChange={e => setBrowserPaths(prev => ({ ...prev, [b.id]: e.target.value } as Record<string, string>))}
                    placeholder={`设置 ${b.name} 的路径，留空自动检测`} />
                  <button className="btn btn-sm btn-secondary" onClick={() => handleSelectBrowserPath(b.id)}>浏览</button>
                </div>
              </div>
            ))}
          </div>
        );

      case 'shortcuts':
        return (
          <div className="settings-section shortcuts-tab">
            <h3>快捷键设置</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
              点击快捷键组合即可修改。修改后点击页面底部的「保存设置」生效。
            </p>
            <div
              onKeyDown={handleCaptureKey}
              tabIndex={-1}
              style={{ outline: 'none' }}
            >
              {KEYBINDING_DEFS.map(def => {
                const isEditing = editingKeybinding === def.id;
                return (
                  <div key={def.id} className={`setting-row shortcut-row ${isEditing ? 'capturing' : ''}`}>
                    <div>
                      <div className="setting-label">{def.label}</div>
                      <div className="setting-desc">{def.desc}</div>
                    </div>
                    <div className="shortcut-key-wrapper">
                      {isEditing ? (
                        <span className="shortcut-key shortcut-key-capturing">
                          按下新快捷键...
                        </span>
                      ) : (
                        <span
                          className="shortcut-key"
                          onClick={() => startCapture(def.id)}
                          title="点击修改快捷键"
                        >
                          <kbd>{localKeybindings[def.id]}</kbd>
                          <svg className="shortcut-edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                          </svg>
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="shortcut-note">
              提示：全局快捷键 <kbd>Ctrl+Shift+P</kbd> 用于显示/隐藏应用窗口，可在系统设置中修改。
            </div>
          </div>
        );
    }
  };

  return (
    <div className="content-area">
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.tool size={16} />}
          title="设置"
          desc="安全、通用、浏览器与快捷键；改完点右下角「保存设置」生效"
        />

        {/* 左侧竖排菜单 + 右侧内容：以前是顶部横排 tab + 600px 居中窄栏，右边大片留白 */}
        <div className="set-shell">
          <nav className="set-rail" aria-label="设置分组">
            {TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                className={`set-nav${activeTab === tab.id ? ' is-active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                title={tab.hint}
              >
                <span className="set-nav-icon">{tab.icon}</span>
                <span className="set-nav-text">
                  <b>{tab.label}</b>
                  <i>{tab.hint}</i>
                </span>
              </button>
            ))}
          </nav>

          <div className="set-main">
            {renderTabContent()}
            <div className="set-foot">
              <span className="set-foot-hint">改动只在本页临时保存，点右侧按钮写入设置</span>
              <button className="btn btn-primary" onClick={handleSave}>
                保存设置
              </button>
            </div>
          </div>
        </div>
      </Page>

      {/* Security Word Modal */}
      <Modal open={showSecurityWord} onClose={() => setShowSecurityWord(false)} title={hasSecurityWord ? '修改安全词' : '设置安全词'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowSecurityWord(false)}>取消</button>
            <button className="btn btn-primary" onClick={handleSetSecurityWord}>确认</button>
          </>
        }
      >
        <div className="form-group">
          <label>主密码（验证身份）</label>
          <input type="password" value={swPassword} onChange={e => setSwPassword(e.target.value)} placeholder="输入当前主密码" autoFocus />
        </div>
        <div className="form-group">
          <label>安全词</label>
          <input type="text" value={securityWord} onChange={e => setSecurityWord(e.target.value)} placeholder="设置安全词，用于重置主密码" />
          <div className="input-hint">忘记主密码时，可通过安全词重置。请牢记此安全词</div>
        </div>
        <div className="form-group">
          <label>确认安全词</label>
          <input type="text" value={securityWord2} onChange={e => setSecurityWord2(e.target.value)} placeholder="再次输入安全词" />
        </div>
      </Modal>

      {/* Change Password Modal */}
      <Modal open={showChangePwd} onClose={() => setShowChangePwd(false)} title="修改主密码"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setShowChangePwd(false)}>取消</button>
            <button className="btn btn-primary" onClick={handleChangePassword}>确认修改</button>
          </>
        }
      >
        <div className="form-group">
          <label>当前密码</label>
          <input type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} placeholder="输入当前主密码" />
        </div>
        <div className="form-group">
          <label>新密码</label>
          <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="至少8位，含大小写字母、数字和符号" />
        </div>
        <div className="form-group">
          <label>确认新密码</label>
          <input type="password" value={newPwd2} onChange={e => setNewPwd2(e.target.value)} placeholder="再次输入新密码" />
        </div>
      </Modal>

      {/* 备份恢复确认 */}
      <Modal open={!!restoreName} onClose={() => !restoring && setRestoreName('')} title="从备份恢复"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setRestoreName('')} disabled={restoring}>取消</button>
            <button
              className="btn btn-primary"
              disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                const r = await window.electronAPI.backupRestore(restoreName);
                setRestoring(false);
                setRestoreName('');
                if (!r.success) { addToast(r.error || '恢复失败', 'error'); return; }
                addToast('已恢复，请用这份备份对应的主密码重新解锁', 'success');
                refreshBackups();
              }}
            >
              {restoring ? '恢复中…' : '确认恢复'}
            </button>
          </>
        }
      >
        <p style={{ marginTop: 0 }}>将用 <b>{restoreName}</b> 覆盖当前密码库（vault.enc）。</p>
        <p className="text-sm text-muted" style={{ marginBottom: 0 }}>
          恢复前会自动把当前库另存为 <code>vault-prerestore-*.enc</code>（最近 5 份），恢复错了还能再回来。
          恢复后应用会退回到登录页 —— 这份备份可能是旧主密码加密的，需要用当时的主密码解锁。
        </p>
      </Modal>
    </div>
  );
}
