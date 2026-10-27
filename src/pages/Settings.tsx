import React, { useState, useEffect, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { Modal } from '../components/Modal';
import type { KeybindingId, AppSettings, ThemeMode, BackupFile, AccentColor } from '../types';
import { applyTheme, applyAccent, ACCENTS } from '../utils/theme';

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

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'security', label: '安全', icon: '🔒' },
  { id: 'general', label: '通用', icon: '⚙️' },
  { id: 'browser', label: '浏览器', icon: '🌐' },
  { id: 'shortcuts', label: '快捷键', icon: '⌨️' },
];

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
  const [backups, setBackups] = useState<BackupFile[]>([]);
  const [backupDir, setBackupDir] = useState('');
  const [updateInfo, setUpdateInfo] = useState<{ current: string; latest: string; hasUpdate: boolean; url: string } | null>(null);
  const [checking, setChecking] = useState(false);

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
  }, []);

  useEffect(() => {
    if (activeTab === 'security') refreshBackups();
  }, [activeTab, refreshBackups]);

  const handleSave = async () => {
    const prefs = {
      clipboardClearDelay: Math.max(5, Math.min(300, clipboardClearDelay)),
      passwordAutoHideDelay: Math.max(3, Math.min(120, passwordAutoHideDelay)),
      autoLockDelay: Math.max(1, Math.min(60, autoLockDelay)),
      defaultViewMode,
      minimizeToTray,
      closeToTray,
      browserPaths,
      theme: settings.theme,
      keybindings: localKeybindings,
    };
    updateSettings(prefs);
    await window.electronAPI.settingsSave(prefs);
    addToast('设置已保存', 'success');
  };

  // Tray behaviours take effect immediately (no need to hit 保存设置) — the main process
  // creates/destroys the tray icon on settings:save.
  const applyTraySetting = async (patch: { minimizeToTray?: boolean; closeToTray?: boolean }) => {
    updateSettings(patch);
    await window.electronAPI.settingsSave(patch);
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
                  每次修改数据时，若当天尚无备份则自动保存一份加密副本，保留最近 7 份
                </div>
              </div>
              <button className="btn btn-sm btn-secondary" onClick={() => window.electronAPI.backupOpenFolder()}>
                打开备份目录
              </button>
            </div>
            <div className="backup-list">
              {backups.length === 0 ? (
                <div className="text-sm text-muted">暂无备份（首次修改数据后自动生成）</div>
              ) : (
                backups.map(b => (
                  <div key={b.name} className="backup-item">
                    <span className="backup-name">{b.name}</span>
                    <span className="text-sm text-muted">{(b.size / 1024).toFixed(1)} KB</span>
                  </div>
                ))
              )}
              {backupDir && <div className="backup-dir text-sm text-muted" title={backupDir}>{backupDir}</div>}
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
                <div className="setting-desc">登录 Windows 后自动启动（可配合「最小化到托盘」使用）</div>
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
              </div>
              <div className="setting-control" style={{ display: 'flex', gap: 8 }}>
                {updateInfo?.hasUpdate && updateInfo.url && (
                  <button className="btn btn-sm btn-primary" onClick={() => window.electronAPI.browserOpen({ browser: 'default', url: updateInfo.url })}>
                    去下载
                  </button>
                )}
                <button className="btn btn-sm btn-secondary" onClick={checkUpdate} disabled={checking}>
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
      <div className="settings-page">
        <h2 style={{ marginBottom: 0, padding: '24px 24px 0' }}>设置</h2>

        {/* Tab bar */}
        <div className="settings-tabs">
          {TABS.map(tab => (
            <div
              key={tab.id}
              className={`settings-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <span className="settings-tab-icon">{tab.icon}</span>
              <span>{tab.label}</span>
            </div>
          ))}
        </div>

        {/* Tab content */}
        {renderTabContent()}

        <button className="btn btn-primary" onClick={handleSave} style={{ marginTop: 16, marginLeft: 24 }}>
          保存设置
        </button>
      </div>

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
    </div>
  );
}
