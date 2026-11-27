import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { callIpc } from '../utils/ipc';
import { ToastContainer } from '../components/Toast';
import { Modal } from '../components/Modal';
import { Page, PageHead, Icons } from '../components/ui';
import type { KeybindingId, AppSettings, ThemeMode, BackupFile, AccentColor, Density, NotifyStatus, AuditEntry, DataLocationInfo, HotkeyInfo, VaultAuditReport, RestoreDrillResult, ElDepsResult } from '../types';
import { accelFromKeyEvent, accelLabel, isImeClash, sameAccel } from '../utils/hotkey';
import { DEFAULT_KEYBINDINGS, findConflicts } from '../utils/keybindings';
import { applyTheme, applyAccent, applyDensity, ACCENTS } from '../utils/theme';
import { logWarn } from '../utils/log';
import { formatDateTime, formatHm } from '../utils/time';
import { runEnvProbeOnce } from '../utils/envSchedule';
import { useEnvProbeStore, formatAt } from '../store/envProbeStore';
import { nextRunAt, type RegressionSet } from '../utils/regression';
import { REGRESSION_RAN_EVENT } from '../hooks/useRegressionScheduler';
import { useConfirm } from '../components/confirm';
// 1.37.0（S2）：设置页 tab 的真源下沉到 utils/settingsTab.ts（契约 D1），这里只引用
import { SETTINGS_TABS, SETTINGS_TAB_KEY, normalizeSettingsTab } from '../utils/settingsTab';
import type { SettingsTab } from '../utils/settingsTab';
// 1.37.0（S3/S4）：两张新卡只做引用，卡内实现各自独立（契约 KEEP-L2 / D9）
import { AutoUnlockCard } from '../components/settings/AutoUnlockCard';
import { UninstallCard } from '../components/settings/UninstallCard';
// 1.36.0（B8）：试跑工作目录的键与元素库共用一份定义（定义在元素库里，设置页只引用）
import { EL_WORK_DIR_KEY } from '../components/codegen/pomModel';

/**
 * 1.36.0（B8）「遗留数据」的四个集合：1.36 起都没有写入方了
 * （周报 / 录制器 / 覆盖统计 / 用例映射已下线）。
 * **只清这四个**：`pomPages`（元素库）与 `scanRuns`（代码体检历史）还有活的写入方，永不清。
 */
const LEGACY_KEYS = ['uiRecordings', 'allureRuns', 'coverageRuns', 'caseMaps'] as const;

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
  { id: 'lock', label: '锁定应用', desc: '立即锁定测试中台' },
  { id: 'trash', label: '回收站', desc: '打开回收站页面' },
  { id: 'import', label: '导入数据', desc: '打开导入页面' },
  { id: 'export', label: '导出数据', desc: '打开导出页面' },
];

/** 可改的三个全局键：搜索小窗 / 主窗口显隐 / 随手记小窗 */
type HotkeySlot = 'search' | 'toggle' | 'quicknote';

/*
 * 1.37.0（S2）：TABS / LEGACY_TAB_MAP / SETTINGS_TAB_KEY / normalizeSettingsTab 已整体搬到
 * `src/utils/settingsTab.ts`（契约 D1：Settings.tsx 2500 行且 import React，无法单测；
 * 「历史 localStorage id 漏一条就白屏」只能靠纯函数单测兜）。
 * 契约 §1.1 的 7 个 tab、顺序、文案、图标键都在那里是唯一真源，**禁止在页面里再写一份**。
 */

/* 历史 id 映射与归一化函数见 src/utils/settingsTab.ts（契约 §1.2 / §1.3，纯函数可单测） */
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

  /* ---- 自定义背景（1.30.0） ---- */
  const [bgInfo, setBgInfo] = useState<{ dataUrl: string; width: number; height: number; original?: { width: number; height: number } } | null>(null);
  const [bgBusy, setBgBusy] = useState(false);
  const bgSaveTimer = useRef<number | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await window.electronAPI.bgGet();
      if (r.success && r.data && r.data.configured && r.data.dataUrl) {
        setBgInfo({
          dataUrl: r.data.dataUrl,
          width: r.data.width || 0,
          height: r.data.height || 0,
          original: r.data.original,
        });
      } else {
        setBgInfo(null);
      }
    })();
  }, []);

  /** 滑块拖动时先更新界面，停 300ms 再落盘 */
  const patchBg = async (patch: Partial<AppSettings>) => {
    updateSettings(patch);
    if (bgSaveTimer.current) window.clearTimeout(bgSaveTimer.current);
    bgSaveTimer.current = window.setTimeout(() => {
      void window.electronAPI.settingsSave(patch);
    }, 300);
  };

  const chooseBackground = async () => {
    setBgBusy(true);
    const r = await window.electronAPI.bgChoose();
    setBgBusy(false);
    if (!r.success) {
      if (!r.canceled) addToast(r.error || '选择失败', 'error');
      return;
    }
    const d = r.data;
    if (!d || !d.dataUrl) return;
    setBgInfo({ dataUrl: d.dataUrl, width: d.width || 0, height: d.height || 0, original: d.original });
    const next: Partial<AppSettings> = { backgroundImage: d.name || '', backgroundAccent: '' };
    if (settings.backgroundOpacity === undefined) next.backgroundOpacity = 0.32;
    if (settings.backgroundBlur === undefined) next.backgroundBlur = 8;
    if (settings.backgroundDim === undefined) next.backgroundDim = 0.42;
    if (settings.backgroundAutoAccent === undefined) next.backgroundAutoAccent = true;
    updateSettings(next);
    addToast('背景已更新', 'success');
  };

  const clearBackground = async () => {
    const r = await window.electronAPI.bgClear();
    if (!r.success) { addToast(r.error || '移除失败', 'error'); return; }
    setBgInfo(null);
    updateSettings({ backgroundImage: '', backgroundAccent: '' });
    addToast('已恢复默认背景', 'success');
  };

  const { toasts, addToast, removeToast } = useToast();
  // 1.36.0（B8）：清空登录状态 / 清理遗留数据都要二次确认（原生 confirm 与应用样式不一致）
  const { ask, confirmNode } = useConfirm();

  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    try { return normalizeSettingsTab(localStorage.getItem(SETTINGS_TAB_KEY)); } catch { return 'security'; }
  });
  const [knownBrowsers, setKnownBrowsers] = useState<BrowserInfo[]>([]);
  const [browserPaths, setBrowserPaths] = useState<Record<string, string>>(settings.browserPaths || {});
  const [clipboardClearDelay, setClipboardClearDelay] = useState(settings.clipboardClearDelay);
  // 敏感复制历史（内存级，默认关闭）
  const [clipHistoryOn, setClipHistoryOn] = useState(settings.clipboardHistory === true);
  const [clipItems, setClipItems] = useState<{ text: string; at: string }[]>([]);
  // 全局快捷键：实际生效的键位 + 正在改的那一个 + 冲突提示
  const [hkInfo, setHkInfo] = useState<HotkeyInfo | null>(null);
  const [capturingHotkey, setCapturingHotkey] = useState<HotkeySlot | null>(null);
  const [hkError, setHkError] = useState<{ slot: HotkeySlot; msg: string } | null>(null);
  const [hkSaved, setHkSaved] = useState<{ slot: HotkeySlot; msg: string } | null>(null);
  const hkCaptureRef = useRef<HTMLDivElement>(null);
  const [passwordAutoHideDelay, setPasswordAutoHideDelay] = useState(settings.passwordAutoHideDelay);
  const [autoLockDelay, setAutoLockDelay] = useState(settings.autoLockDelay);
  const [defaultViewMode, setDefaultViewMode] = useState(settings.defaultViewMode);
  const [minimizeToTray, setMinimizeToTray] = useState(settings.minimizeToTray);
  const [closeToTray, setCloseToTray] = useState(settings.closeToTray);
  const [contentProtection, setContentProtection] = useState(settings.contentProtection);
  const [launchAtLogin, setLaunchAtLogin] = useState(settings.launchAtLogin);
  // 启动时静默检查更新（默认开启；关掉后只有手动点才联网）
  const [updateCheckOnStart, setUpdateCheckOnStart] = useState(settings.updateCheckOnStart !== false);
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
  // 定时任务面板的本地草稿（点「保存设置」才写进 settings）
  const [envInterval, setEnvInterval] = useState(settings.envProbeInterval ?? 0);
  const [envNotify, setEnvNotify] = useState(settings.envProbeNotifyOnFlip !== false);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeMsg, setProbeMsg] = useState('');
  const envProbeAt = useEnvProbeStore(s => s.at);
  const envProbeSummary = useEnvProbeStore(s => s.summary);
  /**
   * 接口回归（1.25.0）：定时任务面板第 5 张卡。
   * 只读展示 —— 回归集的增删改在「接口调试」页，这里改会出现两套配置入口。
   */
  const [regSets, setRegSets] = useState<RegressionSet[]>([]);
  /** 待确认恢复的备份文件名（空=不显示确认框） */
  const [restoreName, setRestoreName] = useState('');
  const [restoring, setRestoring] = useState(false);
  /** 库自检报告（只读体检，不自动修） */
  const [auditReport, setAuditReport] = useState<VaultAuditReport | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  /** 恢复演练结果（按备份文件名索引，避免一次演练覆盖另一次） */
  const [drill, setDrill] = useState<{ name: string; result: RestoreDrillResult } | null>(null);
  const [drillBusy, setDrillBusy] = useState('');
  /* ------------------------------------------------------------------
     1.36.0（B8）：Playwright 试跑目录 / 登录状态 / 遗留数据
     ------------------------------------------------------------------ */
  /** 工作目录：**只存 localStorage**（不进 vault、不进备份、不进导出，方案 §12.7） */
  const [elDir, setElDir] = useState<string>(() => {
    try { return localStorage.getItem(EL_WORK_DIR_KEY) || ''; } catch { return ''; }
  });
  const [elDeps, setElDeps] = useState<ElDepsResult | null>(null);
  const [elBusy, setElBusy] = useState('');
  /** 遗留数据：四个集合的条数（操作前后对比用，也是「有没有东西可清」的判据） */
  const [legacyCounts, setLegacyCounts] = useState<Record<string, number> | null>(null);
  const [legacyBusy, setLegacyBusy] = useState('');
  /** 导出成功后才能清理（本会话内的凭据；刷新页面就要求重新导出一次，这是有意的） */
  const [legacyExportedAt, setLegacyExportedAt] = useState('');
  /** 运行日志查看器（只读最近若干行，出问题时不用去翻目录） */
  const [logOpen, setLogOpen] = useState(false);
  const [logText, setLogText] = useState('');
  const [logPath, setLogPath] = useState('');
  const [logBusy, setLogBusy] = useState(false);
  /** 数据目录信息（路径 / 体积 / 备份份数） */
  const [dataInfo, setDataInfo] = useState<DataLocationInfo | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  /** 应用版本号：主进程没有单独的 version IPC，jmeter:defaults 里带了 appVersion */
  const [appVersion, setAppVersion] = useState('');
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string; hasUpdate: boolean; url: string; downloadUrl?: string; assetName?: string; digest?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  // 应用内更新：下载进度 / 已下载文件
  const [downloading, setDownloading] = useState(false);
  const [downloadedVerified, setDownloadedVerified] = useState(true);
  // 多线程分段下载：更快，但会把 exe 拆成多个分片，部分杀软会误判（默认关闭）
  const [multiThread, setMultiThread] = useState(false);
  // 更新下载源与周期检查：以主进程的 settings 为准（store 里可能还没带这两个新字段）
  const [mirrorUrl, setMirrorUrl] = useState('');
  const [mirrorDirty, setMirrorDirty] = useState(false);
  const [updateInterval, setUpdateInterval] = useState(0);
  const [progress, setProgress] = useState({ received: 0, total: 0, speed: 0, threads: 1, link: '' });
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
      link: p.link || '',
    }));
    return off;
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const r = await window.electronAPI.auditList?.(30);
      if (r && r.success) setAudit(r.data || []);
    } catch (e) { logWarn('Settings.loadAudit', e); }
  }, []);

  const refreshClipHistory = useCallback(async () => {
    try {
      const r = await window.electronAPI.clipboardHistory?.();
      if (r?.success && r.data) setClipItems(r.data.items || []);
    } catch { /* 读不到就显示空 */ }
  }, []);

  const refreshHotkeys = useCallback(async () => {
    try {
      const r = await window.electronAPI.hotkeyInfo?.();
      if (r?.success && r.data) setHkInfo(r.data);
    } catch { /* 拿不到就用默认文案 */ }
  }, []);

  useEffect(() => { void refreshHotkeys(); }, [refreshHotkeys]);

  useEffect(() => {
    if (clipHistoryOn) void refreshClipHistory();
    else setClipItems([]);
  }, [clipHistoryOn, refreshClipHistory]);

  const refreshNotifyStatus = useCallback(async () => {
    try {
      const r = await window.electronAPI.zentaoNotifyStatus?.();
      if (r && r.success) setNotifyStatus(r.data || null);
    } catch (e) { logWarn('Settings.refreshNotifyStatus', e); }
  }, []);

  useEffect(() => {
    refreshNotifyStatus();
    loadAudit();
    void (async () => {
      try {
        const s = await window.electronAPI.settingsGet();
        setMirrorUrl(s.updateMirrorUrl || '');
        setUpdateInterval(Number(s.updateCheckIntervalHours) || 0);
      } catch { /* 拿不到就用默认值 */ }
    })();
  }, [refreshNotifyStatus, loadAudit]);

  /**
   * 读回归集（定时任务面板第 5 张卡）。
   * 未解锁 / 读失败就当空列表：这张卡是只读展示，不该因为读不到而报错。
   * 定时任务跑完会广播 REGRESSION_RAN_EVENT，监听它刷新「上次结果」。
   */
  const loadRegSets = useCallback(async () => {
    try {
      const r = await window.electronAPI.wsGet('regressionSets');
      setRegSets(r && r.success && Array.isArray(r.data) ? (r.data as RegressionSet[]) : []);
    } catch {
      setRegSets([]);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'tasks') return;
    void loadRegSets();
    const onRan = () => { void loadRegSets(); };
    window.addEventListener(REGRESSION_RAN_EVENT, onRan);
    return () => window.removeEventListener(REGRESSION_RAN_EVENT, onRan);
  }, [activeTab, loadRegSets]);

  const regEnabledCount = useMemo(() => regSets.filter(s => s.enabled).length, [regSets]);
  const regFailCount = useMemo(
    () => regSets.filter(s => s.enabled && s.lastStatus === 'fail').length,
    [regSets],
  );

  /** 保存自定义更新源：只接受干净的 http(s) 前缀，留空恢复「只走 GitHub」 */
  const saveMirrorUrl = async () => {
    const v = mirrorUrl.trim();
    if (v && !/^https?:\/\/[^\s"'<>]+$/i.test(v)) {
      addToast('更新源要填 http(s) 开头的完整地址（不要带空格或引号）', 'error');
      return;
    }
    const r = await callIpc(() => window.electronAPI.settingsSave({ updateMirrorUrl: v }));
    if (!r.ok) { addToast(`保存失败：${r.error}`, 'error'); return; }
    setMirrorDirty(false);
    addToast(v ? '已保存更新源，下次下载会优先走它' : '已恢复为只走官方 GitHub', 'success');
  };

  /** 周期检查更新：0 = 只启动查一次（默认），>0 时主进程按小时重复 */
  const saveUpdateInterval = async (hours: number) => {
    setUpdateInterval(hours);
    const r = await callIpc(() => window.electronAPI.settingsSave({ updateCheckIntervalHours: hours }));
    if (!r.ok) { addToast(`保存失败：${r.error}`, 'error'); return; }
    addToast(hours ? `已开启每 ${hours} 小时检查一次更新` : '已关闭周期检查（仅启动时检查）', 'success');
  };

  const downloadUpdate = async (mirror = false) => {
    const url = updateInfo?.downloadUrl;
    if (!url) { addToast('这个版本没有可用的安装包，请到发布页手动下载', 'error'); return; }
    setDownloading(true);
    setDlError('');
    setProgress({ received: 0, total: 0, speed: 0, threads: 1, link: '' });
    const res = await window.electronAPI.updateDownload(url, mirror, {
      expectedSha256: updateInfo?.digest || '',
      threads: mirror || multiThread,
    });
    setDownloading(false);
    if (res.success && res.data) {
      setDownloadedFile(res.data.file);
      setDownloadedVerified(!!res.data.verified);
      setCanMirror(false);
      setDlError('');
      setViaMirror(!!mirror);
      const shaTip = res.data.verified
        ? ' · SHA-256 已校验'
        : ' · ⚠️ 官方未提供摘要，未校验';
      addToast(`下载完成，点「安装并重启」即可更新（${res.data.via || 'GitHub'}${res.data.threads && res.data.threads > 1 ? ` · ${res.data.threads} 线程加速` : ''}${shaTip}）`, res.data.verified ? 'success' : 'info');
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

  // 备份列表（进入「数据与备份」页时刷新）
  const refreshBackups = useCallback(async () => {
    const res = await window.electronAPI.backupList();
    if (res.success) {
      setBackups(res.data);
      setBackupDir(res.dir);
      // backup:list 已经带了最近一份的时间，以前没接上 → 「上次备份」永远显示「还没有备份」
      setBackupLastAt(res.lastAt || '');
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
    if (activeTab === 'data') refreshBackups();
  }, [activeTab, refreshBackups]);

  // 记住上次停留的 tab：老 id 已在 normalizeSettingsTab 里映射过
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_TAB_KEY, activeTab); } catch { /* 隐私模式写不了，忽略 */ }
  }, [activeTab]);

  /**
   * 统一保存设置：先更新内存（界面立即生效），再落盘。
   * 以前一半字段「改动即存」、一半要等底部「保存设置」，用户分不清哪次改动丢了。
   */
  const persist = async (patch: Partial<AppSettings>, okMsg = ''): Promise<boolean> => {
    updateSettings(patch);
    const r = await callIpc(() => window.electronAPI.settingsSave(patch));
    if (!r.ok) { addToast(`保存失败：${r.error}`, 'error'); return false; }
    if (okMsg) addToast(okMsg, 'success');
    return true;
  };

  const saveDirSetting = async (key: 'notesDir', dir: string) => {
    const ok = await persist({ [key]: dir } as Partial<AppSettings>, dir ? '目录已更新' : '已改回默认位置');
    if (!ok) return;
    // 双写旧键：笔记页/附件页反查仍有读 localStorage 的兜底路径，
    // 只清 settings 会让「改回加密库」在下一次进入页面时被旧目录拉回去。
    // 1.36.0（B2）：周报目录区块已随周报页下线删除，这里只剩 notesDir 一支
    // （`settings.weeklyDir` 字段与 `ipc-entries.js` 白名单**保留**，方案 §11.2 明示）。
    try {
      if (dir) localStorage.setItem('pm.notes.dir', dir);
      else localStorage.removeItem('pm.notes.dir');
    } catch { /* 隐私模式下写不了，忽略 */ }
  };

  const pickNotesDir = async () => {
    const r = await window.electronAPI.notesPickDir();
    if (!r.success || !r.data) return;
    await saveDirSetting('notesDir', r.data);
  };

  /** 切换附件目录：主进程先把已有附件复制过去，成功才切换（不用重启） */
  const changeAttachDir = async () => {
    const p = await window.electronAPI.attachmentPickDir();
    if (!p.success || !p.data?.dir) return;
    const r = await window.electronAPI.attachmentSetDir({ dir: p.data.dir });
    if (!r.success || !r.data) { addToast(r.error || '切换附件目录失败', 'error'); return; }
    addToast(`附件目录已切换，复制 ${r.data.copied} 个附件`, 'success');
    void refreshBackups();
  };

  const resetAttachDir = async () => {
    const r = await window.electronAPI.attachmentSetDir({ dir: '' });
    if (!r.success || !r.data) { addToast(r.error || '改回默认目录失败', 'error'); return; }
    addToast(r.data.copied
      ? `已改回默认，补回 ${r.data.copied} 个附件`
      : '已改回默认目录（附件已在默认位置）', 'success');
    void refreshBackups();
  };

  /** 选异地备份目录（可直接选 OneDrive / 坚果云 的同步文件夹） */
  const pickMirrorDir = async () => {
    const r = await window.electronAPI.backupMirrorPick();
    if (!r.success || !r.data) return;
    setMirrorDir(r.data);
    await persist({ backupMirrorDir: r.data }, '已启用异地备份目录');
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
    const attTip = r.data.attachments?.copied ? `，附件 ${r.data.attachments.copied} 个` : '';
    if (m.skipped) addToast(`已备份到本地${attTip}；未配置异地目录`, 'info');
    else if (m.ok) addToast(`已同时写入异地目录${attTip}`, 'success');
    else addToast(`本地已备份${attTip}，异地写入失败：${m.error || '未知原因'}`, 'error');
    await refreshBackups();
  };

  /** 库自检：只读体检，报告里的问题由用户自己决定怎么处理 */
  const runVaultAudit = async () => {
    setAuditBusy(true);
    const r = await window.electronAPI.vaultAudit();
    setAuditBusy(false);
    if (!r.success || !r.data) {
      addToast(r.error || '自检失败', 'error');
      return;
    }
    setAuditReport(r.data);
    const { error, warn } = r.data.counts;
    if (error === 0 && warn === 0) addToast('自检通过，没发现问题', 'success');
    else addToast(`自检完成：${error} 项错误 / ${warn} 项警告`, error ? 'error' : 'info');
  };

  /* ------------------------------------------------------------------
     1.36.0（B8）：三组控件的手柄
     ① 选工作目录（`el:pick-dir`）→ 存 localStorage → 探两盏灯（`el:deps`）
     ② 清空登录状态（`el:profile-clear`，删 `<目录>/.pm-profile`）
     ③ 遗留数据：先导出（`file:save-text`）成功，才允许清理（`ws:set` 四个集合清空）
     ------------------------------------------------------------------ */

  /** ① 选目录：选完立刻探灯，缺 node / playwright 时当场说清楚，别等试跑才报错 */
  const pickElDir = async () => {
    const r = await window.electronAPI.elPickDir();
    if (!r.success || !r.data) {
      if (r.error) addToast(r.error, 'error');
      return;
    }
    const dir = r.data;
    try { localStorage.setItem(EL_WORK_DIR_KEY, dir); } catch { /* 隐私模式写不了，本次会话仍可用 */ }
    setElDir(dir);
    await refreshElDeps(dir);
    addToast('Playwright 工作目录已设置（只存在本机 localStorage，不进备份）', 'success');
  };

  /** 探两盏灯；返回 `ready` 便于调用方决定要不要继续 */
  const refreshElDeps = async (dir: string): Promise<boolean> => {
    setElBusy('deps');
    const r = await window.electronAPI.elDeps({ dir });
    setElBusy('');
    if (!r.success || !r.data) {
      setElDeps(null);
      addToast(r.error || '探测试跑依赖失败', 'error');
      return false;
    }
    setElDeps(r.data);
    return r.data.ready;
  };

  /** ② 清空登录状态：二次确认，删的是 `<工作目录>/.pm-profile` */
  const clearElProfile = () => {
    if (!elDir) { addToast('先选 Playwright 工作目录', 'error'); return; }
    ask({
      title: '清空登录状态',
      message: `将删除「${elDir}\\.pm-profile」里的登录 cookie（页面数据与截图不受影响）。下次试跑要重新登录。`,
      confirmText: '清空',
      onOk: () => {
        void (async () => {
          setElBusy('profile');
          const r = await window.electronAPI.elProfileClear({ dir: elDir });
          setElBusy('');
          if (!r.success || !r.data) { addToast(r.error || '清空登录状态失败', 'error'); return; }
          addToast(`已清空登录状态（${String(r.data)}）`, 'success');
        })();
      },
    });
  };

  /** ③ 读四个遗留集合的条数（导出前/清理后各读一次，贴进回执做对比） */
  const readLegacyCounts = useCallback(async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const key of LEGACY_KEYS) {
      const r = await window.electronAPI.wsGet(key);
      out[key] = Array.isArray(r.data) ? r.data.length : 0;
    }
    setLegacyCounts(out);
    return out;
  }, []);

  useEffect(() => {
    // 进「数据与备份」页时顺手读一次条数：有东西才显示「可清理 N 条」
    if (activeTab !== 'data') return;
    void readLegacyCounts();
  }, [activeTab, readLegacyCounts]);

  /**
   * ③ 导出遗留数据：四个集合 + `schemaVersion` + 导出时间 → JSON，走**既有** `file:save-text`。
   *
   * `schemaVersion` 取自既有 `vaultAudit` 通道（渲染层拿不到主进程的常量，也不该为此新增常量通道）；
   * 已经体检过就复用 `auditReport`，没有才现查一次。
   */
  const exportLegacyData = async () => {
    setLegacyBusy('export');
    try {
      const collections: Record<string, unknown[]> = {};
      for (const key of LEGACY_KEYS) {
        const r = await window.electronAPI.wsGet(key);
        collections[key] = Array.isArray(r.data) ? r.data : [];
      }
      let schemaVersion = auditReport?.schemaVersion ?? null;
      if (schemaVersion === null) {
        const a = await window.electronAPI.vaultAudit();
        schemaVersion = a.success && a.data ? a.data.schemaVersion : null;
      }
      const payload = {
        kind: 'pm-legacy-collections',
        schemaVersion,
        exportedAt: new Date().toISOString(),
        note: '这四个集合在 1.36.0 起没有写入方（周报 / 录制器 / 覆盖统计 / 用例映射已下线），导出留档后可由用户自行清理。',
        collections,
      };
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const r = await window.electronAPI.saveText(
        JSON.stringify(payload, null, 2),
        `遗留数据-${stamp}.json`,
        [{ name: 'JSON', extensions: ['json'] }],
      );
      if (!r.success) {
        addToast(r.error || '导出失败（取消保存也算失败，取消后不能清理）', 'error');
        setLegacyExportedAt('');
        return;
      }
      const total = LEGACY_KEYS.reduce((n, k) => n + collections[k].length, 0);
      setLegacyExportedAt(new Date().toISOString());
      addToast(`已导出 ${total} 条遗留数据${r.data?.file ? `：${r.data.file}` : ''}`, 'success');
    } finally {
      setLegacyBusy('');
    }
  };

  /** ③ 清理：**必须先导出成功**；只清四个集合，`pomPages` / `scanRuns` 永不清 */
  const clearLegacyData = () => {
    if (!legacyExportedAt) { addToast('先导出一次再清理：导出文件是唯一的后悔药', 'error'); return; }
    ask({
      title: '清理遗留数据',
      message: `将清空 ${LEGACY_KEYS.join(' / ')} 四个集合（元素库 pomPages 与体检历史 scanRuns 不动）。
清理前请确认刚才导出的 JSON 已经存好 —— 这一步不可撤销。`,
      confirmText: '清理',
      onOk: () => {
        void (async () => {
          setLegacyBusy('clear');
          const cleared: string[] = [];
          for (const key of LEGACY_KEYS) {
            const r = await window.electronAPI.wsSet(key, []);
            if (!r.success) { addToast(`清理 ${key} 失败：${r.error || '未知原因'}`, 'error'); setLegacyBusy(''); return; }
            cleared.push(key);
          }
          const after = await readLegacyCounts();
          setLegacyBusy('');
          setLegacyExportedAt('');
          addToast(`已清理 ${cleared.length} 个集合（现 ${LEGACY_KEYS.map((k) => `${k}=${after[k]}`).join(' / ')}）`, 'success');
        })();
      },
    });
  };

  /** 恢复演练：拿一份备份试解 + 体检，不碰正式库 */
  const runRestoreDrill = async (name: string) => {    setDrillBusy(name);
    const r = await window.electronAPI.vaultRestoreDrill(name);
    setDrillBusy('');
    if (!r.success || !r.data) {
      addToast(r.error || '演练失败', 'error');
      return;
    }
    setDrill({ name, result: r.data });
    if (r.data.ok) addToast('演练通过：这份备份能解开，数据也完整', 'success');
    else addToast(`演练未通过：${r.data.error || '备份有问题'}`, 'error');
  };

  /** 导出诊断包（日志 + 环境 + 自检，不含密码与条目内容） */
  const exportDiagnostic = async () => {
    const r = await window.electronAPI.logExportDiagnostic();
    if (r.canceled) return;
    if (!r.success || !r.data) {
      addToast(r.error || '导出失败', 'error');
      return;
    }
    addToast('诊断包已导出', 'success');
  };

  /** 打开运行日志查看器：只读最近 400 行，不落任何东西 */
  const openLogViewer = async () => {
    setLogOpen(true);
    setLogBusy(true);
    try {
      const r = await window.electronAPI.logTail(400);
      if (r.success && r.data) {
        setLogText(r.data.text || '（日志还是空的）');
        setLogPath(r.data.path || '');
      } else {
        setLogText('读不到日志文件');
        setLogPath('');
      }
    } finally {
      setLogBusy(false);
    }
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
      // 超期提醒的两项直接从 settings 读回：保存时若缺字段，主进程归一化会按默认值(false/3)覆盖
      zentaoStaleOn: !!settings.zentaoStaleOn,
      zentaoStaleDays: Math.max(1, Math.min(60, Number(settings.zentaoStaleDays) || 3)),
      envProbeInterval: Math.max(0, Math.min(720, envInterval)),
      envProbeNotifyOnFlip: envNotify,
      backupKeep: Math.max(1, Math.min(60, backupKeep)),
      backupMirrorDir: mirrorDir,
      theme: settings.theme,
      keybindings: localKeybindings,
    };
    // 走统一保存：和「改动即存」的开关是同一条路径，避免两套机制给出不同结果
    const ok = await persist(prefs);
    if (ok) addToast('设置已保存', 'success');
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
    const next = { ...browserPaths, [id]: result.filePath } as Record<string, string>;
    setBrowserPaths(next);
    await persist({ browserPaths: next });
  };

  const handleChangePassword = async () => {
    if (!oldPwd) { addToast('请输入当前密码', 'error'); return; }
    if (newPwd.length < 8) { addToast('新密码至少8位', 'error'); return; }
    if (newPwd !== newPwd2) { addToast('两次密码不一致', 'error'); return; }
    const result = await window.electronAPI.authChangePassword({ oldPassword: oldPwd, newPassword: newPwd });
    if (result.success) {
      // 1.25.0：主进程会把所有附件用新密码重新加密，并回报统计。
      // 有失败时必须明确告诉用户「哪些附件打不开了」，不能只说「已修改」。
      const att = result.attachments;
      const warning = result.warning;
      if (att && att.failed > 0) {
        addToast(
          `主密码已修改，但有 ${att.failed} / ${att.total} 个附件未能重新加密，这些附件将无法打开。${warning || ''}`,
          'error',
        );
      } else if (att && att.total > 0) {
        addToast(`主密码已修改，${att.ok} 个附件已用新密码重新加密`, 'success');
      } else {
        addToast('主密码已修改', 'success');
      }
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

  // --- 全局快捷键：捕获与生效 ---
  const startHotkeyCapture = useCallback((slot: HotkeySlot) => {
    setHkError(null);
    setHkSaved(null);
    setCapturingHotkey(slot);
    // 捕获靠 keydown，得让容器拿到焦点
    requestAnimationFrame(() => hkCaptureRef.current?.focus());
  }, []);

  /** 交给主进程去注册；注册成功才落盘，失败会回滚并带回原因 */
  const applyHotkey = useCallback(async (slot: HotkeySlot, accel: string) => {
    // 只发改的这个：另一个键由主进程从设置里取，避免把「兜底键」当成用户自定义值写死
    const next = slot === 'search' ? { search: accel } : slot === 'toggle' ? { toggle: accel } : { quicknote: accel };
    const others = [hkInfo?.searchAccel, hkInfo?.toggleAccel, hkInfo?.quicknoteAccel]
      .filter((v, i, arr) => !!v && arr.indexOf(v) === i)
      .filter(v => {
        if (slot === 'search') return v !== hkInfo?.searchAccel;
        if (slot === 'toggle') return v !== hkInfo?.toggleAccel;
        return v !== hkInfo?.quicknoteAccel;
      });
    // 先用本地判断挡掉「两个键撞车」，省一轮 IPC（也避免把可用状态打乱）
    if (others.some(v => v && sameAccel(accel, v))) {
      setHkError({ slot, msg: '这个组合已经用在另一个快捷键上了，换一个' });
      return;
    }
    try {
      const r = await window.electronAPI.hotkeyApply(next);
      if (r?.info) setHkInfo(r.info);
      // 随手记键是「非关键键」：撞车只废它自己，不会让搜索/窗口键一起回滚
      const slotRes = slot === 'search' ? r?.data?.search : slot === 'toggle' ? r?.data?.toggle : r?.data?.quicknote;
      const okThis = slot === 'quicknote' ? !!slotRes?.ok : !!r?.success;
      if (okThis) {
        setHkError(null);
        setHkSaved({ slot, msg: `已生效：${accelLabel(accel)}` });
      } else {
        setHkError({
          slot,
          msg: slotRes?.reason === 'same'
            ? '这个组合已经用在另一个快捷键上了，换一个'
            : '这个组合被其它程序（或另一个「测试中台」实例）占用了，换一个试试',
        });
      }
    } catch (e) {
      setHkError({ slot, msg: '设置失败：' + (e instanceof Error ? e.message : String(e)) });
    }
  }, [hkInfo]);

  const onHotkeyKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!capturingHotkey) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') { setCapturingHotkey(null); return; }
    const accel = accelFromKeyEvent(e.nativeEvent);
    if (!accel) {
      setHkError({ slot: capturingHotkey, msg: '请用 Ctrl / Alt 加一个字母、数字或 F1–F24' });
      return;
    }
    const slot = capturingHotkey;
    setCapturingHotkey(null);
    void applyHotkey(slot, accel);
  }, [capturingHotkey, applyHotkey]);

  /** 恢复默认：把默认加速键再发一次，主进程会顺手清掉设置里的自定义值 */
  const resetHotkey = useCallback(async (slot: HotkeySlot) => {
    const accel = slot === 'search'
      ? hkInfo?.searchDefaultAccel
      : slot === 'toggle' ? hkInfo?.toggleDefaultAccel : hkInfo?.quicknoteDefaultAccel;
    if (!accel) return;
    setHkSaved(null);
    await applyHotkey(slot, accel);
  }, [hkInfo, applyHotkey]);


  useEffect(() => {
    void (async () => {
      try {
        const d = await window.electronAPI.jmeterDefaults();
        if (d?.success && d.data?.appVersion) setAppVersion(d.data.appVersion);
      } catch { /* 拿不到就显示「读取中…」 */ }
    })();
  }, []);

  const renderTabContent = () => {
    /**
     * security 分区的 JSX 抽成一段：`case 'security'` 与 `default:` **共用同一段**
     * （契约 §1.4 第 2 条：禁止两处拷贝导致漂移）。7 个 case 每个都 return，
     * `default:` 只是二道保险 —— **绝不** return null（那就是白屏）。
     */
    const renderSecurityPane = () => (
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
                <input type="number" value={autoLockDelay} onChange={e => setAutoLockDelay(Number(e.target.value))} onBlur={() => void persist({ autoLockDelay: Math.max(1, Math.min(60, Number(autoLockDelay) || 5)) })} min={1} max={60} aria-label="自动锁定分钟数" />
                <span className="text-sm text-muted">分钟</span>
              </div>
            </div>
            <h3 style={{ marginTop: 24 }}>剪贴板</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">复制密码后清空延迟 (秒)</div>
                <div className="setting-desc">复制密码后，剪贴板自动清空的时间 (5-300秒)</div>
              </div>
              <div className="setting-control">
                <input type="number" value={clipboardClearDelay} onChange={e => setClipboardClearDelay(Number(e.target.value))} onBlur={() => void persist({ clipboardClearDelay: Math.max(5, Math.min(300, Number(clipboardClearDelay) || 30)) })} min={5} max={300} aria-label="剪贴板清空延迟秒数" />
                <span className="text-sm text-muted">秒</span>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">记录最近复制（最多 30 条）</div>
                <div className="setting-desc">
                  只记密码 / 验证码这类敏感内容，用当前主密码加密后存在本机数据目录，锁屏只清内存、
                  下次解锁自动读回；点「清空」才真正删除文件。改主密码时会用新密码重写一次。
                  默认关闭：开启后本机其它程序理论上可通过剪贴板读取到这些历史。
                </div>
                {clipHistoryOn && clipItems.length > 0 && (
                  <div className="clip-history">
                    {clipItems.map((it, i) => (
                      <div key={`${it.at}-${i}`} className="clip-history-item">
                        <span className="clip-history-text" title="内容不显示，点右侧按钮可直接复制">
                          {'•'.repeat(Math.min(12, Math.max(4, it.text.length)))}
                          <span className="clip-history-len">{it.text.length} 位</span>
                        </span>
                        {/* 必须走 formatHm：it.at 是 toISOString() 的 UTC，slice(11,16) 会少 8 小时 */}
              <span className="clip-history-time">{formatHm(it.at)}</span>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={async () => {
                            await window.electronAPI.clipboardCopy({ text: it.text, delay: settings.clipboardClearDelay * 1000 });
                            addToast('已复制（仍会按设置自动清空）', 'success');
                          }}
                        >
                          <Icons.copy size={12} /> 复制
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {clipHistoryOn && clipItems.length === 0 && (
                  <div className="setting-desc" style={{ marginTop: 4 }}>还没有记录：复制一次密码或验证码后回来刷新。</div>
                )}
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {clipHistoryOn && clipItems.length > 0 && (
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={async () => {
                      await window.electronAPI.clipboardHistoryClear();
                      setClipItems([]);
                      addToast('已清空复制历史', 'success');
                    }}
                  >
                    清空
                  </button>
                )}
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={clipHistoryOn}
                    onChange={async e => {
                      const val = e.target.checked;
                      setClipHistoryOn(val);
                      const r = await callIpc(() => window.electronAPI.settingsSave({ clipboardHistory: val }));
                      if (!r.ok) { addToast(`保存失败：${r.error}`, 'error'); return; }
                      addToast(val ? '已开启复制历史（仅内存）' : '已关闭复制历史', 'success');
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
            {/* ============ 1.37.0（S3）：启动免密（契约 §2） ============
                卡片是独立组件（契约 D9），Settings.tsx 只做引用；
                开关真源是 autologin.json，不在 AppSettings 里（D2）。 */}
            <AutoUnlockCard />

            <h3 style={{ marginTop: 24 }}>密码显示</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">密码自动隐藏 (秒)</div>
                <div className="setting-desc">明文密码显示后自动恢复掩码的时间 (3-120秒)</div>
              </div>
              <div className="setting-control">
                <input type="number" value={passwordAutoHideDelay} onChange={e => setPasswordAutoHideDelay(Number(e.target.value))} onBlur={() => void persist({ passwordAutoHideDelay: Math.max(3, Math.min(120, Number(passwordAutoHideDelay) || 10)) })} min={3} max={120} aria-label="密码自动隐藏秒数" />
                <span className="text-sm text-muted">秒</span>
              </div>
            </div>
            {/* 1.37.0（S2）：防截屏按契约 §1.1 归到「交互」分区（原来的「隐私保护」整块搬走），
                不在安全分区留重复入口。 */}
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

    switch (activeTab) {
      case 'security':
        return renderSecurityPane();

      case 'data':
        return (
          <div className="settings-section">
            <h3>备份与恢复</h3>
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
                  onBlur={() => void persist({ backupKeep: Math.max(1, Math.min(60, Number(backupKeep) || 7)) })}
                  style={{ width: 70 }} aria-label="备份保留份数" />
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
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => void runRestoreDrill(b.name)}
                      disabled={!!drillBusy}
                      title="用当前主密码试解一次并体检，不会改动正式库"
                    >
                      {drillBusy === b.name ? '演练中…' : '演练'}
                    </button>
                    <button className="btn btn-sm btn-ghost" onClick={() => setRestoreName(b.name)}>
                      恢复
                    </button>
                  </div>
                ))
              )}
              {backupDir && <div className="backup-dir text-sm text-muted" title={backupDir}>{backupDir}</div>}
            </div>

            {/* 恢复演练结果：只显示最近一次，避免一屏堆满 */}
            {drill && (
              <div className={`vault-drill ${drill.result.ok ? 'is-ok' : 'is-bad'}`}>
                <div className="vault-drill-head">
                  <strong>{drill.name}</strong>
                  <span>{drill.result.ok ? '演练通过' : `演练未通过（${drill.result.stage}）`}</span>
                  <button className="btn btn-sm btn-ghost" onClick={() => setDrill(null)}>关闭</button>
                </div>
                <div className="vault-drill-body">
                  {drill.result.error || (
                    <>
                      能解开，{drill.result.bytes ? `${(drill.result.bytes / 1024).toFixed(1)} KB，` : ''}
                      体检 {drill.result.report?.ok ? '无错误' : `有 ${drill.result.report?.counts.error || 0} 项错误`}
                      {drill.result.report ? `（${drill.result.report.stats.entries} 条记录）` : ''}
                    </>
                  )}
                </div>
              </div>
            )}
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
                {/* 1.37.0（S2）：「改回默认数据目录」按契约 §1.1 归到「危险区」（danger 分区），
                    这里只保留「打开目录 / 迁移到其他盘」这两个非破坏性动作。 */}
              </div>
            </div>
            <div className="text-sm text-muted" style={{ marginTop: 6 }}>
              迁移只复制不删除，原目录会原样保留；确认新目录可用后可自行删除旧文件。
            </div>
            <h3 style={{ marginTop: 24 }}>库自检</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">体检当前密码库</div>
                <div className="setting-desc">
                  检查结构、悬空标签、丢失的附件、孤儿历史。只读，不会改动任何数据。
                </div>
              </div>
              <div className="setting-control">
                <button className="btn btn-sm btn-secondary" onClick={() => void runVaultAudit()} disabled={auditBusy}>
                  {auditBusy ? '体检中…' : '开始自检'}
                </button>
              </div>
            </div>
            {auditReport && (
              <div className="vault-audit">
                <div className="vault-audit-sum">
                  <span className={`vault-audit-pill ${auditReport.counts.error ? 'is-bad' : 'is-ok'}`}>
                    {auditReport.counts.error} 错误
                  </span>
                  <span className={`vault-audit-pill ${auditReport.counts.warn ? 'is-warn' : 'is-ok'}`}>
                    {auditReport.counts.warn} 警告
                  </span>
                  <span className="vault-audit-pill">{auditReport.counts.info} 提示</span>
                  <span className="text-sm text-muted">
                    结构 v{auditReport.schemaVersion} · {auditReport.stats.entries} 条记录 · {auditReport.stats.tags} 个标签
                  </span>
                </div>
                {auditReport.issues.length === 0 ? (
                  <div className="text-sm text-muted">没发现问题。</div>
                ) : (
                  <ul className="vault-audit-list">
                    {auditReport.issues.map(it => (
                      <li key={it.code} className={`vault-audit-item is-${it.level}`}>
                        <div className="vault-audit-msg">{it.message}</div>
                        {it.samples.length > 0 && (
                          <div className="vault-audit-samples">{it.samples.join('、')}{it.count > it.samples.length ? ' …' : ''}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <h3 style={{ marginTop: 24 }}>存储位置</h3>
            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">附件存放目录</div>
                <div className="setting-desc" style={{ wordBreak: 'break-all' }} title={dataInfo?.attachDir || ''}>
                  {dataInfo?.attachDir || '读取中…'}
                  {dataInfo?.attachIsCustom ? '（自定义）' : '（默认）'}
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  截图、证书、密钥都存在这里；随手记和测试笔记里粘的图片也走这个目录。
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-secondary" onClick={() => void changeAttachDir()}>
                  更改目录
                </button>
                {dataInfo?.attachIsCustom && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void resetAttachDir()}>
                    改回默认
                  </button>
                )}
                <button className="btn btn-sm btn-ghost" onClick={() => void window.electronAPI.attachmentReveal()}>
                  打开目录
                </button>
              </div>
            </div>

            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">测试笔记目录</div>
                <div className="setting-desc" style={{ wordBreak: 'break-all' }}>
                  {settings.notesDir || '未启用（笔记存在加密库里）'}
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  选了目录后，笔记一篇一个 .md 文件存在那里，方便用其它编辑器打开。
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-secondary" onClick={() => void pickNotesDir()}>
                  选择目录
                </button>
                {settings.notesDir && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void window.electronAPI.notesReveal(settings.notesDir || '')}>
                    打开
                  </button>
                )}
                {settings.notesDir && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void saveDirSetting('notesDir', '')}>
                    改回加密库
                  </button>
                )}
              </div>
            </div>

            {/* 1.36.0（B2）：原「周报目录」setting-row 随周报页下线删除。
                `settings.weeklyDir` 字段与 `ipc-entries.js` 的 settings 白名单保留（老库不迁移、回滚零风险）。 */}
            <div className="text-sm text-muted" style={{ marginTop: 6 }}>
              目录切换只复制、不删除原文件；附件目录改完立即生效，不需要重启。
            </div>

            {/* ============ 1.36.0（B8）：Playwright 试跑 ============ */}
            <h3 style={{ marginTop: 24 }}>Playwright 试跑</h3>
            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">Playwright 工作目录</div>
                <div className="setting-desc" style={{ wordBreak: 'break-all' }}>
                  {elDir || '还没选：元素库的「试跑」需要它才能打开浏览器'}
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  用于存放浏览器登录状态（<code>.pm-profile</code>）与试跑截图。这个目录含登录 cookie，
                  <b>别拷给别人</b>；它只存在本机 localStorage，<b>不进加密库、不进备份、不进导出</b>。
                </div>
                {elDeps && (
                  <div className="el-deps" style={{ marginTop: 6 }}>
                    {elDeps.lamps.map((l) => (
                      <span key={l.id} className={`dev-tag ${l.state === 'green' ? 'is-ok' : 'is-error'}`} title={l.detail}>
                        {l.state === 'green' ? '✓' : '✗'} {l.label}
                        {l.fixHint ? `：${l.fixHint}` : ''}
                      </span>
                    ))}
                    <span className="text-sm text-muted">
                      {elDeps.ready ? '依赖齐了，可以在元素库里试跑' : '依赖不齐：试跑会直接报错，先按上面的提示装好'}
                    </span>
                  </div>
                )}
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-sm btn-secondary" onClick={() => void pickElDir()} disabled={!!elBusy}>
                  {elBusy === 'deps' ? '探测中…' : '选择目录'}
                </button>
                {elDir && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void refreshElDeps(elDir)} disabled={!!elBusy}>
                    重新探测依赖
                  </button>
                )}
              </div>
            </div>

            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">清空登录状态</div>
                <div className="setting-desc" style={{ wordBreak: 'break-all' }}>
                  删掉 <code>{elDir ? `${elDir}\\.pm-profile` : '<工作目录>\\.pm-profile'}</code> 里的 cookie
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  换账号 / 试跑卡在登录页时用。页面数据与已生成的截图不受影响，下次试跑要重新登录。
                </div>
              </div>
              <div className="setting-control">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={clearElProfile}
                  disabled={!elDir || !!elBusy}
                  title={elDir ? '删除该目录下的 .pm-profile' : '先选工作目录'}
                >
                  {elBusy === 'profile' ? '清理中…' : '清空登录状态'}
                </button>
              </div>
            </div>

            {/* 1.37.0（S2）：「遗留数据导出 / 清理」按契约 §1.1 整块搬到「危险区」，
                数据分区只留备份 / 目录 / 自检这些日常操作。 */}
          </div>
        );

      case 'appearance':
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
                }} aria-label="主题">
                  <option value="dark">深色主题</option>
                  <option value="light">浅色主题</option>
                  <option value="system">跟随系统</option>
                </select>
              </div>
            </div>

            <div className="setting-row">
              <div>
                <div className="setting-label">界面密度</div>
                <div className="setting-desc">紧凑适合小屏多行，宽松适合演示与阅读</div>
              </div>
              <div className="setting-control">
                <select value={settings.density || 'standard'} onChange={e => {
                  const val = e.target.value as Density;
                  updateSettings({ density: val });
                  applyDensity(val);
                  window.electronAPI.settingsSave({ density: val });
                }} aria-label="界面密度">
                  <option value="compact">紧凑</option>
                  <option value="standard">标准</option>
                  <option value="cozy">宽松</option>
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
                    className={`accent-dot ${(settings.accent || 'teal') === key ? 'active' : ''}`}
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
                <select
                  value={defaultViewMode}
                  onChange={e => {
                    const val = e.target.value as AppSettings['defaultViewMode'];
                    setDefaultViewMode(val);
                    void persist({ defaultViewMode: val });
                  }}
                  aria-label="默认视图"
                >
                  <option value="card">卡片视图</option>
                  <option value="list">列表视图</option>
                  <option value="system">按系统视图</option>
                </select>
              </div>
            </div>
            <h3>背景</h3>
            <div className="setting-row setting-row--bg">
              <div>
                <div className="setting-label">背景图片</div>
                <div className="setting-desc">
                  选一张图片铺满窗口（等比裁剪，不变形）。会自动压缩到最长边 2560 像素，原图不会被修改。
                </div>
                {bgInfo && (
                  <div className="setting-desc">
                    {bgInfo.width}×{bgInfo.height}
                    {bgInfo.original && (bgInfo.original.width !== bgInfo.width || bgInfo.original.height !== bgInfo.height)
                      ? `（原图 ${bgInfo.original.width}×${bgInfo.original.height}，已压缩）`
                      : ''}
                    {bgInfo.width > 0 && bgInfo.width < 1400 && (
                      <span className="bg-warn"> · 分辨率偏低，铺满窗口会有点糊</span>
                    )}
                  </div>
                )}
              </div>
              <div className="setting-control bg-control">
                {bgInfo ? (
                  <span className="bg-thumb" style={{ backgroundImage: `url("${bgInfo.dataUrl}")` }} title="当前背景" />
                ) : (
                  <span className="bg-thumb is-empty" title="还没有设置背景" />
                )}
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => void chooseBackground()}
                  disabled={bgBusy}
                >{bgBusy ? '处理中…' : bgInfo ? '更换图片' : '选择图片'}</button>
                {bgInfo && (
                  <button className="btn btn-ghost btn-sm" onClick={() => void clearBackground()}>移除</button>
                )}
              </div>
            </div>

            {bgInfo && (
              <>
                <div className="setting-row">
                  <div>
                    <div className="setting-label">图片不透明度</div>
                    <div className="setting-desc">调低会让背景更淡，卡片上的字更清楚</div>
                  </div>
                  <div className="setting-control bg-slider">
                    <input
                      type="range"
                      min={0}
                      max={80}
                      value={Math.round((settings.backgroundOpacity ?? 0.32) * 100)}
                      onChange={e => void patchBg({ backgroundOpacity: Number(e.target.value) / 100 })}
                      aria-label="背景不透明度"
                    />
                    <span className="bg-value">{Math.round((settings.backgroundOpacity ?? 0.32) * 100)}%</span>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-label">背景模糊</div>
                    <div className="setting-desc">模糊一点不容易和文字打架，分辨率低的图也更好看</div>
                  </div>
                  <div className="setting-control bg-slider">
                    <input
                      type="range"
                      min={0}
                      max={20}
                      value={Math.round(settings.backgroundBlur ?? 8)}
                      onChange={e => void patchBg({ backgroundBlur: Number(e.target.value) })}
                      aria-label="背景模糊"
                    />
                    <span className="bg-value">{Math.round(settings.backgroundBlur ?? 8)}px</span>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-label">压暗</div>
                    <div className="setting-desc">深色主题压暗、浅色主题压亮，保证背景上的文字可读</div>
                  </div>
                  <div className="setting-control bg-slider">
                    <input
                      type="range"
                      min={0}
                      max={80}
                      value={Math.round((settings.backgroundDim ?? 0.42) * 100)}
                      onChange={e => void patchBg({ backgroundDim: Number(e.target.value) / 100 })}
                      aria-label="背景压暗"
                    />
                    <span className="bg-value">{Math.round((settings.backgroundDim ?? 0.42) * 100)}%</span>
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <div className="setting-label">用图片主色做强调色</div>
                    <div className="setting-desc">
                      自动从图片里取主色替换按钮/选中态颜色；取到的颜色会压暗到白字可读
                    </div>
                  </div>
                  <div className="setting-control bg-accent-ctl">
                    {settings.backgroundAccent && (
                      <span
                        className="bg-accent-dot"
                        style={{ background: settings.backgroundAccent }}
                        title={settings.backgroundAccent}
                      />
                    )}
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={settings.backgroundAutoAccent !== false}
                        onChange={e => void patchBg({ backgroundAutoAccent: e.target.checked })}
                        aria-label="用图片主色做强调色"
                      />
                      <span className="switch-slider" />
                    </label>
                  </div>
                </div>
              </>
            )}
          </div>
        );

      case 'interaction':
        return (
          <div className="settings-section">
            {/* 1.37.0（S2）：外观分区只留「显示 / 背景」（契约 §1.1：主题 / 背景 / 玻璃）；
                托盘、浏览器路径、快捷键、防截屏、开机自启按契约归到「交互」。 */}
            <h3>防截屏</h3>
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

            <h3 style={{ marginTop: 24 }}>窗口与启动</h3>
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
            <div className="setting-desc" style={{ padding: '4px 0 0' }}>
              托盘图标单击可恢复窗口；全局快捷键 <kbd>{hkInfo?.toggle || 'Ctrl+Shift+P'}</kbd> 显示/隐藏窗口，
              <kbd>{hkInfo?.search || 'Ctrl+空格'}</kbd> 直接搜索（隐藏状态下按下即弹出搜索框，可在「快捷键」里改）。
            </div>
            <h3 style={{ marginTop: 24 }}>浏览器路径</h3>
            {knownBrowsers.map(b => (
              <div key={b.id} className="setting-row">
                <div>
                  <div className="setting-label">{b.name} 路径</div>
                  <div className="setting-desc">留空则自动检测常见安装位置</div>
                </div>
                <div className="setting-control browser-path-control">
                  <input
                    type="text"
                    value={browserPaths[b.id] || ''}
                    onChange={e => setBrowserPaths(prev => ({ ...prev, [b.id]: e.target.value } as Record<string, string>))}
                    onBlur={() => void persist({ browserPaths })}
                    placeholder={`设置 ${b.name} 的路径，留空自动检测`} />
                  <button className="btn btn-sm btn-secondary" onClick={() => handleSelectBrowserPath(b.id)}>浏览</button>
                </div>
              </div>
            ))}
            <h3 style={{ marginTop: 24 }}>全局快捷键</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
              系统级生效（应用在后台也有效）。点右侧键位即可重新设置，改完立即生效；被其它程序占用时会直接提示。
            </p>
            <div
              ref={hkCaptureRef}
              onKeyDown={onHotkeyKeyDown}
              tabIndex={-1}
              style={{ outline: 'none' }}
            >
              {([
                {
                  slot: 'search' as const,
                  label: '打开搜索',
                  desc: '任何时候按一下就能搜网址、笔记 / SQL 片段、测试数据类型和页面',
                  shown: hkInfo?.search || hkInfo?.searchDefault || 'Ctrl+空格',
                  isDefault: hkInfo ? hkInfo.searchIsDefault : true,
                },
                {
                  slot: 'toggle' as const,
                  label: '显示 / 隐藏窗口',
                  desc: '从任何界面把窗口叫出来，再按一次收回去',
                  shown: hkInfo?.toggle || hkInfo?.toggleDefault || 'Ctrl+Shift+P',
                  isDefault: hkInfo ? hkInfo.toggleIsDefault : true,
                },
                {
                  slot: 'quicknote' as const,
                  label: '随手记小窗',
                  desc: '不弹主窗口，直接写一条笔记进「测试笔记」；支持粘截图',
                  shown: hkInfo?.quicknote || hkInfo?.quicknoteDefault || 'Ctrl+Shift+N',
                  isDefault: hkInfo ? hkInfo.quicknoteIsDefault : true,
                },
              ]).map(row => {
                const editing = capturingHotkey === row.slot;
                return (
                  <div key={row.slot} className={`setting-row shortcut-row ${editing ? 'capturing' : ''}`}>
                    <div>
                      <div className="setting-label">{row.label}</div>
                      <div className="setting-desc">{row.desc}</div>
                      {hkError?.slot === row.slot && <div className="hotkey-msg is-error">{hkError.msg}</div>}
                      {hkSaved?.slot === row.slot && <div className="hotkey-msg is-ok">{hkSaved.msg}</div>}
                    </div>
                    <div className="shortcut-key-wrapper">
                      {editing ? (
                        <span className="shortcut-key shortcut-key-capturing">按下新快捷键…（Esc 取消）</span>
                      ) : (
                        <span
                          className="shortcut-key"
                          onClick={() => startHotkeyCapture(row.slot)}
                          title="点击修改快捷键"
                        >
                          <kbd>{row.shown}</kbd>
                          <svg className="shortcut-edit-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
                            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>
                          </svg>
                        </span>
                      )}
                      {!row.isDefault && !editing && (
                        <button className="btn btn-ghost btn-sm" onClick={() => void resetHotkey(row.slot)}>
                          恢复默认
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {(hkInfo?.searchOk === false || hkInfo?.toggleOk === false || hkInfo?.quicknoteOk === false) && (
              <div className="hotkey-msg is-error">
                有快捷键没注册成功，现在按了没反应。常见原因是同时开了两个「测试中台」，
                或者该组合已被别的程序占用——换一个组合即可。
              </div>
            )}
            {isImeClash(hkInfo?.searchAccel || '') && (
              <div className="shortcut-note" style={{ marginTop: 8 }}>
                提示：<kbd>Ctrl+空格</kbd> 被本应用占用后，输入法的「Ctrl+空格 切中英文」会失效（可继续用 Shift 切换）。
                想留输入法的话，把搜索键改成 <kbd>Ctrl+Shift+空格</kbd> 之类即可。
              </div>
            )}

            <h3 style={{ marginTop: 28 }}>应用内快捷键</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 12 }}>
              只在应用窗口内生效。点击快捷键组合即可修改，修改后点击页面底部的「保存设置」生效。
            </p>
            {(() => {
              const conflicts = findConflicts(localKeybindings);
              const list = Object.values(conflicts).flat();
              if (list.length === 0) return null;
              return (
                <div className="hotkey-msg is-error">
                  有两个动作绑了同一个组合：{list.map((id) => KEYBINDING_DEFS.find((d) => d.id === id)?.label || id).join('、')}
                  。保存后只有排在前面的那个会响应，请换一个。
                </div>
              );
            })()}
            <div style={{ marginBottom: 4 }}>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setLocalKeybindings({ ...DEFAULT_KEYBINDINGS })}
                title="把 7 个应用内快捷键恢复成出厂值（仍需点「保存设置」）"
              >
                恢复默认快捷键
              </button>
            </div>
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
          </div>
        );

      case 'tasks':
        return (
          <div className="settings-section task-tab">
            <h3>定时任务</h3>
            <p className="task-note">
              这些检查都在应用运行期间执行，关掉应用就停了（本工具不常驻后台）。间隔填 0 表示关闭。
            </p>
            <div className="task-card">
              <div className="task-head">
                <span className="task-name">环境矩阵巡检</span>
                <span className={`task-badge${envInterval > 0 ? ' is-on' : ''}`}>
                  {envInterval > 0 ? `每 ${envInterval} 分钟` : '未启用'}
                </span>
              </div>
              <div className="task-desc">
                对所有环境地址发起一次探测，记录可达性与耗时。
                {envProbeAt ? ` 上次 ${formatAt(envProbeAt)}` : ' 还没巡检过'}
                {envProbeSummary ? ` · ${envProbeSummary.ok}/${envProbeSummary.total} 可达 · 平均 ${envProbeSummary.avgMs} ms` : ''}
              </div>
              <div className="task-controls">
                <label className="task-inline">
                  间隔
                  <input
                    type="number"
                    min={0}
                    max={720}
                    value={envInterval}
                    onChange={e => setEnvInterval(Math.max(0, Math.min(720, Number(e.target.value) || 0)))}
                    onBlur={() => void persist({ envProbeInterval: Math.max(0, Math.min(720, Number(envInterval) || 0)) })}
                    aria-label="环境巡检间隔分钟数"
                  />
                  分钟
                </label>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={envNotify}
                    onChange={e => {
                      const val = e.target.checked;
                      setEnvNotify(val);
                      void persist({ envProbeNotifyOnFlip: val });
                    }}
                    aria-label="环境状态翻转时发系统通知"
                  />
                  <span className="switch-slider" />
                </label>
                <span className="text-sm text-muted">只在「可达→不可达 / 变慢」时通知</span>
                <button
                  className="btn btn-sm btn-secondary"
                  disabled={probeBusy}
                  onClick={async () => {
                    setProbeBusy(true);
                    setProbeMsg('');
                    const r = await runEnvProbeOnce(false);
                    setProbeBusy(false);
                    if (!r.ok) setProbeMsg(r.error || '巡检失败');
                    else setProbeMsg(`巡检完成：${r.total} 条地址${r.flips.length ? `，${r.flips.length} 条有变化` : '，没有变化'}`);
                  }}
                >
                  {probeBusy ? '巡检中…' : '立即巡检'}
                </button>
              </div>
              {probeMsg && <div className="task-msg">{probeMsg}</div>}
            </div>
            <div className="task-card">
              <div className="task-head">
                <span className="task-name">禅道新 Bug 检查</span>
                <span className={`task-badge${settings.zentaoNotify ? ' is-on' : ''}`}>
                  {settings.zentaoNotify ? `每 ${zentaoNotifyInterval} 分钟` : '未启用'}
                </span>
              </div>
              <div className="task-desc">
                {notifyStatus
                  ? [
                    notifyStatus.configured ? '账号已保存' : '⚠ 还没在缺陷管理页保存账号',
                    notifyStatus.unlocked ? '已解锁' : '未解锁时不检查',
                    notifyStatus.lastCheck
                      ? `上次 ${formatDateTime(notifyStatus.lastCheck.at)} · ${notifyStatus.lastCheck.ok
                        ? `成功，${notifyStatus.lastCheck.total} 条，新增 ${notifyStatus.lastCheck.fresh ?? 0} 条`
                        : `失败：${notifyStatus.lastCheck.error || '未知原因'}`}`
                      : '还没检查过',
                    notifyStatus.lastCheck?.stale
                      ? `超期：待验证 ${notifyStatus.lastCheck.stale.verify} · 待处理 ${notifyStatus.lastCheck.stale.handle}`
                      : '',
                  ].filter(Boolean).join(' · ')
                  : '用来确认禅道配置是否可用'}
              </div>
              <div className="task-controls">
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
                <span className="text-sm text-muted">新 Bug 提醒（有新的指派给我就弹系统通知）</span>
                <label className="task-inline">
                  间隔
                  <input
                    type="number"
                    min={2}
                    max={120}
                    value={zentaoNotifyInterval}
                    onChange={e => setZentaoNotifyInterval(Number(e.target.value))}
                    onBlur={() => void persist({ zentaoNotifyInterval: Math.max(2, Math.min(120, Number(zentaoNotifyInterval) || 10)) })}
                    aria-label="禅道检查间隔分钟数"
                  />
                  分钟
                </label>
                <button
                  className="btn btn-sm btn-secondary"
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
              <div className="task-controls task-controls-sub">
                <label className="task-inline">
                  <input
                    type="checkbox"
                    checked={!!settings.zentaoStaleOn}
                    onChange={async e => {
                      const on = e.target.checked;
                      // 必须写盘：主进程的定时检查读的是 settings.json，只更新 store 它看不到
                      updateSettings({ zentaoStaleOn: on });
                      await window.electronAPI.settingsSave({ zentaoStaleOn: on });
                      addToast(on ? '已开启超期提醒' : '已关闭超期提醒', 'success');
                    }}
                    aria-label="启用超期未动提醒"
                  />
                  超期提醒
                </label>
                <label className="task-inline">
                  超过
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={Number(settings.zentaoStaleDays) || 3}
                    onChange={e => updateSettings({ zentaoStaleDays: Math.max(1, Math.min(60, Number(e.target.value) || 3)) })}
                    onBlur={async e => {
                      const days = Math.max(1, Math.min(60, Number(e.target.value) || 3));
                      updateSettings({ zentaoStaleDays: days });
                      await window.electronAPI.settingsSave({ zentaoStaleDays: days });
                    }}
                    aria-label="超期天数"
                  />
                  天没动就提醒
                </label>
                <span className="task-hint">
                  待验证（已解决等我回归）与指派给我仍未处理，按本地状态快照算；同一状态只提醒一次。检查频率与上面的「间隔」一致
                </span>
              </div>
            </div>
            <div className="task-card">
              <div className="task-head">
                <span className="task-name">接口回归</span>
                <span className={`task-badge${regEnabledCount > 0 ? ' is-on' : ''}`}>
                  {regEnabledCount > 0 ? `${regEnabledCount} 个回归集在跑` : '未配置'}
                </span>
              </div>
              <div className="task-desc">
                {regSets.length === 0
                  ? '还没有回归集。在「接口调试」里把几条请求存成回归集，勾上定时后这里会显示上次结果与下次到期时间。'
                  : `共 ${regSets.length} 个回归集，其中 ${regEnabledCount} 个开了定时。`}
                {regFailCount > 0 ? ` 上次有 ${regFailCount} 个失败。` : ''}
              </div>
              {regSets.length > 0 && (
                <div className="task-reg-list">
                  {regSets.map(s => {
                    const due = nextRunAt(s);
                    const status = s.lastStatus === 'pass' ? 'ok' : s.lastStatus === 'fail' ? 'bad' : 'mute';
                    const statusText = s.lastStatus === 'pass' ? '通过' : s.lastStatus === 'fail' ? '失败' : '未跑';
                    return (
                      <div className="task-reg-row" key={s.id}>
                        <span className="task-reg-name" title={s.name}>{s.name}</span>
                        <span className={`task-reg-status is-${status}`}>{statusText}</span>
                        <span className="task-reg-when">
                          {s.lastRunAt ? `上次 ${formatDateTime(s.lastRunAt)}` : '还没跑过'}
                        </span>
                        <span className="task-reg-due">
                          {!s.enabled || !s.intervalMin
                            ? '不定时'
                            : due === null
                              ? '—'
                              : due <= Date.now()
                                ? '已到期'
                                : `下次 ${formatDateTime(new Date(due).toISOString())}`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="task-controls">
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => useStore.getState().requestNavigate('apiClient')}
                >
                  去接口调试
                </button>
                <span className="task-hint">回归集的增删改在「接口调试」页，这里只读展示</span>
              </div>
            </div>
            <div className="task-hint">
              间隔与开关改完自动保存（输入完点一下别处即可）。
            </div>
          </div>
        );

      case 'about':
        return (
          <div className="settings-section">
            <h3>版本与日志</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">运行日志</div>
                <div className="setting-desc">
                  出问题时把这里的日志发给开发者，比截图更能说明原因（不记录密码和请求体）。
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => void openLogViewer()}>
                  查看日志
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={async () => {
                    const r = await window.electronAPI.logOpen();
                    if (!r.success) addToast(r.error || '打开失败', 'error');
                  }}
                >
                  打开日志目录
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => void exportDiagnostic()}>
                  导出诊断包
                </button>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">版本号</div>
                <div className="setting-desc">当前安装的版本；有新版本时会在应用内顶部提示</div>
              </div>
              <div className="setting-control">
                <code>{appVersion || updateInfo?.current || '读取中…'}</code>
              </div>
            </div>
            <h3 style={{ marginTop: 24 }}>更新</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">启动时检查更新</div>
                <div className="setting-desc">
                  启动后静默检查一次，有新版本会在应用内顶部提示（同一版本只提示一次）。
                  关掉后只有点「检查更新」才会联网。
                </div>
              </div>
              <div className="setting-control">
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={updateCheckOnStart}
                    onChange={async e => {
                      const val = e.target.checked;
                      setUpdateCheckOnStart(val);
                      const r = await callIpc(() => window.electronAPI.settingsSave({ updateCheckOnStart: val }));
                      if (!r.ok) { addToast(`保存失败：${r.error}`, 'error'); return; }
                      addToast(val ? '已开启启动检查更新' : '已关闭启动检查更新', 'success');
                    }}
                  />
                  <span className="switch-slider" />
                </label>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">周期检查更新</div>
                <div className="setting-desc">
                  默认只在启动后检查一次；应用长期不关时开启这里也能收到新版本提示（同一版本只提示一次）。
                </div>
              </div>
              <div className="setting-control">
                <select value={updateInterval} onChange={e => void saveUpdateInterval(Number(e.target.value))} title="检查间隔">
                  <option value={0}>仅启动时</option>
                  <option value={6}>每 6 小时</option>
                  <option value={12}>每 12 小时</option>
                  <option value={24}>每天</option>
                  <option value={168}>每周</option>
                </select>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">更新下载源</div>
                <div className="setting-desc">
                  连 GitHub 慢时可填国内可直连的镜像前缀（形如 https://mirror.example.com），
                  官方下载地址会接在它后面；留空则只走 GitHub。下载后仍按官方摘要做 SHA-256 校验。
                </div>
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  type="url"
                  value={mirrorUrl}
                  placeholder="留空 = 只走 GitHub"
                  onChange={e => { setMirrorUrl(e.target.value); setMirrorDirty(true); }}
                  style={{ width: 260 }} aria-label="留空 = 只走 GitHub" />
                <button className="btn btn-sm btn-secondary" onClick={() => void saveMirrorUrl()} disabled={!mirrorDirty}>
                  保存
                </button>
              </div>
            </div>
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
                    <span className="dl-meta-dim" title="走代理还是直连由系统代理设置决定；直连很慢时检查 VPN 分流规则是否放行 github.com 与 *.githubusercontent.com">
                      {progress.link ? (progress.link === '直连' ? '直连 · 检查 VPN 分流' : progress.link) : '链路检测中…'}
                    </span>
                    <span className="dl-meta-dim">{progress.threads > 1 ? `${progress.threads} 线程` : '单连接'}</span>
                    {progress.speed > 0 && progress.speed < 150 * 1024 && !viaMirror && (
                      <button className="btn btn-sm btn-ghost" onClick={() => downloadUpdate(true)} title="改用 6 分片并行下载">
                        太慢？多线程加速
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
                    已下载：{downloadedFile.split('\\').pop()}{viaMirror ? '（多线程加速）' : ''}
                    {!downloadedVerified && (
                      <div style={{ marginTop: 6, color: 'var(--danger, #e5484d)' }}>
                        ⚠️ 官方未提供 SHA-256 摘要，这个安装包没有校验，请确认来源后再安装
                      </div>
                    )}
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
                  <button className="btn btn-sm btn-secondary" onClick={() => downloadUpdate(true)} disabled={downloading} title="改用 6 分片并行下载，速度通常有明显提升">
                    加速重试
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

      case 'danger':
        return (
          <div className="settings-section">
            {/* 1.37.0（S4）：卸载入口（契约 §3.5）。卡片内自己调 app:uninstall-info / app:uninstall，
                两层确认 + 绝对路径/体积回显 + dataDirAck 回传都在卡内实现，页面只做引用。 */}
            <UninstallCard />

            {/* 1.37.0（S2）：「遗留数据」与「恢复默认数据目录」按契约 §1.1 从数据分区搬到危险区 */}
            <h3 style={{ marginTop: 24 }}>遗留数据</h3>
            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">导出 / 清理遗留数据</div>
                <div className="setting-desc">
                  {legacyCounts
                    ? LEGACY_KEYS.map((k) => `${k}=${legacyCounts[k] ?? 0}`).join(' / ')
                    : '读取中…'}
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  这四个集合在 1.36.0 起没有写入方了（周报 / 录制器 / 覆盖统计 / 用例映射已下线）。
                  <b>必须先导出成功才能清理</b>；元素库（<code>pomPages</code>）与体检历史（<code>scanRuns</code>）永不清。
                </div>
                {legacyExportedAt && (
                  <div className="text-sm" style={{ marginTop: 4 }} data-legacy-exported="1">
                    ✓ 已导出（{formatDateTime(legacyExportedAt)}），现在可以清理了
                  </div>
                )}
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-sm btn-secondary"
                  onClick={() => void exportLegacyData()}
                  disabled={!!legacyBusy}
                >
                  {legacyBusy === 'export' ? '导出中…' : '导出遗留数据'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={clearLegacyData}
                  disabled={!legacyExportedAt || !!legacyBusy}
                  title={legacyExportedAt ? '清空那四个集合' : '先导出一次再清理'}
                >
                  {legacyBusy === 'clear' ? '清理中…' : '清理遗留数据'}
                </button>
              </div>
            </div>

            <h3 style={{ marginTop: 24 }}>数据目录</h3>
            <div className="setting-row">
              <div style={{ minWidth: 0 }}>
                <div className="setting-label">恢复默认数据目录</div>
                <div className="setting-desc" style={{ wordBreak: 'break-all' }}>
                  当前：{dataInfo?.dataDir || '读取中…'}{dataInfo?.isCustom ? '（自定义）' : '（默认）'}
                </div>
                <div className="text-sm text-muted" style={{ marginTop: 4 }}>
                  只改「下次启动从哪读数据」的指针，不移动、不删除任何文件；自定义目录里的数据需要你自己处理。
                </div>
              </div>
              <div className="setting-control">
                <button
                  className="btn btn-sm btn-ghost"
                  data-danger-reset-location="1"
                  disabled={!dataInfo?.isCustom}
                  title={dataInfo?.isCustom ? '重启后回到默认目录' : '当前已经是默认目录'}
                  onClick={async () => {
                    const r = await window.electronAPI.dataResetLocation();
                    if (!r.success) { addToast(r.error || '操作失败', 'error'); return; }
                    addToast('已改回默认目录，重启应用后生效', 'success');
                    refreshBackups();
                  }}
                >
                  改回默认目录
                </button>
              </div>
            </div>
          </div>
        );

      default: {
        // 归一化（契约 §1.3）保证 activeTab 只可能是 7 个合法值之一；这里是**二道保险**。
        // 与 case 'security' 共用同一段 JSX（不是拷贝），且绝不 return null —— 那就是白屏（契约 §1.4）。
        console.warn('[settings] 未知 tab 已回落 security:', activeTab);
        return renderSecurityPane();
      }
    }
  };

  return (
    <div className="content-area">
      {confirmNode}
      <ToastContainer toasts={toasts} onRemove={removeToast} />
      <Page>
        <PageHead
          icon={<Icons.tool size={16} />}
          title="设置"
          desc="安全 / 外观 / 交互 / 数据与备份 / 定时任务 / 关于与更新 / 危险区；大部分改动会自动保存，也可点右下角统一保存"
        />

        {/* 左侧竖排菜单 + 右侧内容：以前是顶部横排 tab + 600px 居中窄栏，右边大片留白 */}
        <div className="set-shell">
          <nav className="set-rail" aria-label="设置分组">
            {SETTINGS_TABS.map(tab => {
              // 图标只存键名（utils/settingsTab.ts 是纯 TS，不认 JSX），节点在这里渲染
              const TabIcon = Icons[tab.icon];
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`set-nav${activeTab === tab.id ? ' is-active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  title={tab.hint}
                  data-settings-tab={tab.id}
                >
                  <span className="set-nav-icon"><TabIcon size={14} /></span>
                  <span className="set-nav-text">
                    <b>{tab.label}</b>
                    <i>{tab.hint}</i>
                  </span>
                </button>
              );
            })}
          </nav>

          <div className="set-main">
            {renderTabContent()}
            <div className="set-foot">
              <span className="set-foot-hint">大部分设置改完自动保存；快捷键等草稿项点右侧按钮写入</span>
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
          <input type="password" value={swPassword} onChange={e => setSwPassword(e.target.value)} placeholder="输入当前主密码" autoFocus aria-label="主密码（验证身份）" />
        </div>
        <div className="form-group">
          <label>安全词</label>
          <input type="text" value={securityWord} onChange={e => setSecurityWord(e.target.value)} placeholder="设置安全词，用于重置主密码" aria-label="安全词" />
          <div className="input-hint">忘记主密码时，可通过安全词重置。请牢记此安全词</div>
        </div>
        <div className="form-group">
          <label>确认安全词</label>
          <input type="text" value={securityWord2} onChange={e => setSecurityWord2(e.target.value)} placeholder="再次输入安全词" aria-label="确认安全词" />
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
          <input type="password" value={oldPwd} onChange={e => setOldPwd(e.target.value)} placeholder="输入当前主密码" aria-label="当前密码" />
        </div>
        <div className="form-group">
          <label>新密码</label>
          <input type="password" value={newPwd} onChange={e => setNewPwd(e.target.value)} placeholder="至少8位，含大小写字母、数字和符号" aria-label="新密码" />
        </div>
        <div className="form-group">
          <label>确认新密码</label>
          <input type="password" value={newPwd2} onChange={e => setNewPwd2(e.target.value)} placeholder="再次输入新密码" aria-label="确认新密码" />
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
                const att = r.attachments;
                addToast(att?.found
                  ? `已恢复，补回 ${att.copied} 个附件；请用这份备份对应的主密码重新解锁`
                  : '已恢复，请用这份备份对应的主密码重新解锁', 'success');
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

      {/* 运行日志查看器：只读最近 400 行，出问题不用去翻目录 */}
      <Modal
        open={logOpen}
        onClose={() => setLogOpen(false)}
        title="运行日志"
        className="log-modal"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => void openLogViewer()} disabled={logBusy}>
              {logBusy ? '读取中…' : '刷新'}
            </button>
            <button className="btn btn-primary" onClick={() => setLogOpen(false)}>关闭</button>
          </>
        }
      >
        {logPath && <div className="log-modal-path">{logPath}</div>}
        <pre className="log-modal-body" tabIndex={0} aria-label="日志内容">
          {logBusy ? '读取中…' : logText}
        </pre>
        <p className="text-sm text-muted" style={{ marginBottom: 0 }}>
          只显示最近 400 行，不记录密码和请求体。要完整日志或发给别人，用「导出诊断包」。
        </p>
      </Modal>
    </div>
  );
}



