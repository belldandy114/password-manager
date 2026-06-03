import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import { ConfirmDialog } from '../components/ConfirmDialog';

export function ExportPage() {
  const { toasts, addToast, removeToast } = useToast();
  const [exportType, setExportType] = useState<'encrypted' | 'plain'>('encrypted');
  const [format, setFormat] = useState<'csv' | 'json' | 'xlsx'>('json');
  const [includePasswords, setIncludePasswords] = useState(false);
  const [exportFilter, setExportFilter] = useState('all');
  const [exportPassword, setExportPassword] = useState('');
  const [showPasswordConfirm, setShowPasswordConfirm] = useState(false);
  const [showSecurityWarning, setShowSecurityWarning] = useState(false);

  const handleEncryptedExport = async () => {
    if (!exportPassword) { addToast('请设置导出密码', 'error'); return; }
    if (exportPassword.length < 6) { addToast('导出密码至少6位', 'error'); return; }
    setShowPasswordConfirm(true);
  };

  const doEncryptedExport = async () => {
    const result = await window.electronAPI.exportEncrypted({
      exportPassword,
      filter: exportFilter,
    });
    if (result.success && result.data) {
      const saveResult = await window.electronAPI.dialogSaveFile({
        defaultName: `password-manager-backup-${new Date().toISOString().slice(0, 10)}.enc`,
        filters: [{ name: '加密备份', extensions: ['enc'] }],
      });
      if (!saveResult.canceled && saveResult.filePath) {
        await window.electronAPI.fileWrite({
          filePath: saveResult.filePath,
          content: result.data,
          encoding: 'base64',
        });
        addToast('加密备份导出成功', 'success');
      }
    } else {
      addToast('导出失败', 'error');
    }
    setShowPasswordConfirm(false);
    setExportPassword('');
  };

  const handlePlainExport = () => {
    if (includePasswords) {
      setShowSecurityWarning(true);
    } else {
      doPlainExport();
    }
  };

  const doPlainExport = async () => {
    const result = await window.electronAPI.exportPlain({
      format,
      includePasswords,
      filter: exportFilter,
    });
    if (result.success && result.data) {
      const ext = format === 'xlsx' ? 'xlsx' : format;
      const saveResult = await window.electronAPI.dialogSaveFile({
        defaultName: `password-manager-export-${new Date().toISOString().slice(0, 10)}.${ext}`,
        filters: [
          { name: format === 'json' ? 'JSON' : format === 'csv' ? 'CSV' : 'Excel', extensions: [ext] },
        ],
      });
      if (!saveResult.canceled && saveResult.filePath) {
        if (format === 'xlsx') {
          await window.electronAPI.fileWrite({
            filePath: saveResult.filePath,
            content: result.data,
            encoding: 'base64',
          });
        } else {
          await window.electronAPI.fileWrite({
            filePath: saveResult.filePath,
            content: result.data,
          });
        }
        addToast(`明文${format.toUpperCase()}导出成功 (${result.count} 条)`, 'success');
      }
    } else {
      addToast('导出失败', 'error');
    }
    setShowSecurityWarning(false);
  };

  return (
    <>
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>导出数据</h3>
      </div>
      <div className="content-area">
        <ToastContainer toasts={toasts} onRemove={removeToast} />
        <div className="export-section export-wide">

        <div className="settings-section">
          <h3>导出方式</h3>
          <div className="setting-row">
            <div>
              <div className="setting-label">导出类型</div>
              <div className="setting-desc">加密备份或明文导出</div>
            </div>
            <div className="setting-control">
              <select value={exportType} onChange={e => setExportType(e.target.value as any)}>
                <option value="encrypted">🔒 加密备份 (AES-256)</option>
                <option value="plain">📄 明文导出</option>
              </select>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3>导出范围</h3>
          <div className="setting-row">
            <div>
              <div className="setting-label">筛选范围</div>
              <div className="setting-desc">选择要导出的网址范围</div>
            </div>
            <div className="setting-control">
              <select value={exportFilter} onChange={e => setExportFilter(e.target.value)}>
                <option value="all">全部网址</option>
                <option value="production">仅正式环境</option>
                <option value="testing">仅测试环境</option>
                {useStore.getState().tags.map(t => (
                  <option key={t} value={`tag:${t}`}>标签: {t}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {exportType === 'encrypted' ? (
          <div className="settings-section">
            <h3>加密设置</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 12 }}>
              导出的文件将使用 AES-256 加密，需要设置导出密码
            </p>
            <div className="form-group">
              <label>导出密码</label>
              <input type="password" value={exportPassword}
                onChange={e => setExportPassword(e.target.value)}
                placeholder="设置加密导出密码" />
              <div className="input-hint">导入时需要提供此密码解密</div>
            </div>
            <button className="btn btn-primary" onClick={handleEncryptedExport}>
              导出加密备份
            </button>
          </div>
        ) : (
          <div className="settings-section">
            <h3>明文导出设置</h3>
            <div className="setting-row">
              <div>
                <div className="setting-label">导出格式</div>
                <div className="setting-desc">选择文件格式</div>
              </div>
              <div className="setting-control">
                <select value={format} onChange={e => setFormat(e.target.value as any)}>
                  <option value="json">JSON</option>
                  <option value="csv">CSV</option>
                  <option value="xlsx">Excel (XLSX)</option>
                </select>
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div className="setting-label">包含密码</div>
                <div className="setting-desc">密码将以明文形式包含在导出文件中</div>
              </div>
              <div className="setting-control">
                <input type="checkbox" checked={includePasswords}
                  onChange={e => setIncludePasswords(e.target.checked)} />
              </div>
            </div>
            <div style={{ marginTop: 12, padding: 12, background: 'var(--bg-input)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--warning)' }}>
              <p className="text-sm" style={{ color: 'var(--warning)' }}>
                ⚠️ 明文导出存在安全风险，导出的文件包含未加密的敏感信息。请确保：
              </p>
              <ul style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, paddingLeft: 20 }}>
                <li>不要在非安全环境传输文件</li>
                <li>使用后及时删除导出的文件</li>
                <li>如果包含密码，文件泄露可能导致账号被盗</li>
              </ul>
            </div>
            <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={handlePlainExport}>
              导出 {format === 'xlsx' ? 'Excel' : format.toUpperCase()}
            </button>
          </div>
        )}
      </div>

      {/* Password confirm for encrypted export */}
      <ConfirmDialog
        open={showPasswordConfirm}
        title="确认导出加密备份"
        message={`将使用设置的密码导出加密备份文件，请牢记导出密码。导入时需要此密码解密。`}
        confirmText="确认导出"
        variant="primary"
        onConfirm={doEncryptedExport}
        onCancel={() => setShowPasswordConfirm(false)}
      />

      {/* Security warning for plain export with passwords */}
      <ConfirmDialog
        open={showSecurityWarning}
        title="⚠️ 安全风险警告"
        message="明文导出包含未加密的账号密码信息，文件泄露可能导致严重安全风险！请确认你了解并承担此风险。"
        confirmText="我已了解风险，继续导出"
        variant="danger"
        onConfirm={doPlainExport}
        onCancel={() => setShowSecurityWarning(false)}
      />
    </div>
    </>
  );
}
