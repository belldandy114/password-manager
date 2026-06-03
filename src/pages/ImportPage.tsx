import React, { useState, useRef } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import type { ConflictStrategy } from '../types';

export function ImportPage() {
  const { toasts, addToast, removeToast } = useToast();
  const [step, setStep] = useState<'select' | 'preview' | 'done' | 'enc-password'>('select');
  const [filePath, setFilePath] = useState('');
  const [records, setRecords] = useState<any[]>([]);
  const [mappedEntries, setMappedEntries] = useState<any[]>([]);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>('skip');
  const [envType, setEnvType] = useState('production');
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({
    name: 'name',
    url: 'url',
    username: 'username',
    password: 'password',
    notes: 'notes',
  });
  const [isBookmark, setIsBookmark] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importPassword, setImportPassword] = useState('');

  const availableFields = ['name', 'url', 'username', 'password', 'notes', 'tags', 'envType'];

  const handleDownloadTemplate = async () => {
    const result = await window.electronAPI.importDownloadTemplate();
    if (result.success) {
      addToast('模板已保存', 'success');
    }
  };

  // Detect field mapping
  const detectMapping = (keys: string[]) => {
    const lower = keys.map(k => k.toLowerCase());
    const mapping: Record<string, string> = {};
    const mapTo = (patterns: string[], field: string) => {
      for (const p of patterns) {
        const idx = lower.indexOf(p);
        if (idx >= 0) return keys[idx];
      }
      return '';
    };
    mapping.name = mapTo(['name', 'title', '名称', '网站名', 'site'], 'name');
    mapping.url = mapTo(['url', 'link', 'href', 'website', '地址', '网址'], 'url');
    mapping.username = mapTo(['username', 'user', 'email', 'account', '账号', '用户名', '邮箱', '用户'], 'username');
    mapping.password = mapTo(['password', 'pass', 'pwd', '密码', '口令'], 'password');
    mapping.notes = mapTo(['notes', 'note', 'remark', '备注', 'description', 'desc'], 'notes');
    return mapping;
  };

  const processFile = async (filePath: string) => {
    setFilePath(filePath);
    const ext = filePath.toLowerCase().split('.').pop();

    if (ext === 'enc') {
      setStep('enc-password');
      return;
    }

    if (ext === 'html' || ext === 'htm') {
      setIsBookmark(true);
      try {
        const result = await window.electronAPI.importCsvJson({ filePath });
        if (result.success && Array.isArray(result.data)) {
          setMappedEntries(result.data);
          setStep('preview');
        } else {
          addToast('解析书签文件失败', 'error');
        }
      } catch (e: any) {
        addToast(`解析失败: ${e.message}`, 'error');
      }
      return;
    }

    setIsBookmark(false);
    try {
      const result = await window.electronAPI.importCsvJson({ filePath });
      if (result.success && result.data) {
        const records = result.data;
        if (records.length === 0) {
          addToast('文件中没有数据', 'error');
          return;
        }
        setRecords(records);
        const keys = Object.keys(records[0]);
        setFieldMapping(detectMapping(keys));
        setStep('preview');
      } else {
        addToast(result.error || '读取失败', 'error');
      }
    } catch (e: any) {
      addToast(`读取失败: ${e.message}`, 'error');
    }
  };

  const doImportEncrypted = async () => {
    if (!importPassword) { addToast('请输入加密密码', 'error'); return; }
    try {
      const result = await window.electronAPI.importEncrypted({ filePath, importPassword });
      if (result.success && result.data) {
        const entries = result.data;
        if (entries.length === 0) {
          addToast('文件中没有数据', 'error');
          return;
        }
        setRecords(entries);
        const keys = Object.keys(entries[0]);
        setFieldMapping(detectMapping(keys));
        setImportPassword('');
        setStep('preview');
      } else {
        addToast(result.error || '解密失败', 'error');
      }
    } catch (e: any) {
      addToast(`解密失败: ${e.message}`, 'error');
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const droppedPath = (files[0] as any).path;
      if (droppedPath) processFile(droppedPath);
    }
  };

  const handleSelectFile = async () => {
    const result = await window.electronAPI.dialogOpenFile({
      filters: [
        { name: '支持的文件', extensions: ['enc', 'csv', 'json', 'xlsx', 'xls', 'html', 'txt'] },
        { name: '加密备份 (.enc)', extensions: ['enc'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'CSV', extensions: ['csv'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'HTML (浏览器书签)', extensions: ['html', 'htm'] },
        { name: '所有文件', extensions: ['*'] },
      ]
    });
    if (result.canceled || !result.filePath) return;

    processFile(result.filePath);
  };

  const handleConfirmImport = async () => {
    let entries = isBookmark ? mappedEntries : records.map(r => {
      const entry: any = { id: crypto.randomUUID(), tags: [], envType, createdAt: new Date().toISOString() };
      for (const [field, srcKey] of Object.entries(fieldMapping)) {
        if (srcKey && r[srcKey] !== undefined) {
          if (field === 'tags') {
            entry.tags = String(r[srcKey]).split(';').map((t: string) => t.trim()).filter(Boolean);
          } else {
            entry[field] = r[srcKey];
          }
        }
      }
      if (!entry.name) entry.name = entry.url || '未命名';
      return entry;
    });

    // Filter out entries without URLs for bookmarks
    if (isBookmark) {
      entries = entries.filter(e => e.url && e.url !== '');
    }

    const result = await window.electronAPI.importConfirm({ entries, conflictStrategy });
    if (result.success && result.data) {
      useStore.getState().setVaultData(result.data);
      const count = result.importedCount ?? entries.length;
      if (count === 0) {
        addToast('所有网址已存在，跳过导入', 'info');
      } else {
        addToast(`成功导入 ${count} 个网址`, 'success');
      }
      setStep('done');
    } else {
      addToast(result.error || '导入失败', 'error');
    }
  };

  return (
    <>
      <div className="toolbar">
        <h3 style={{ margin: 0 }}>导入数据</h3>
      </div>
      <div className="content-area">
        <ToastContainer toasts={toasts} onRemove={removeToast} />
        <div className="import-section">

        {step === 'select' && (
          <>
            <p className="text-sm text-muted" style={{ marginBottom: 20 }}>
              支持 Excel、CSV、JSON、加密备份和浏览器书签文件
            </p>
            <div className={`file-drop${dragging ? ' drag-over' : ''}`}
              onClick={handleSelectFile}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" style={{ marginBottom: 12, opacity: 0.4 }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              <h3>点击选择文件或拖入文件</h3>
              <p className="text-sm text-muted">支持 Excel、CSV、JSON、加密备份 (ENC) 和浏览器书签文件</p>
            </div>
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button className="btn btn-secondary" onClick={handleDownloadTemplate} style={{ fontSize: 13 }}>
                📥 下载导入模板
              </button>
            </div>
          </>
        )}

        {step === 'enc-password' && (
          <div className="settings-section">
            <h3>加密备份导入</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
              此文件是加密备份，需要输入导出时设置的密码才能解密
            </p>
            <div className="form-group">
              <label>解密密码</label>
              <input type="password" value={importPassword}
                onChange={e => setImportPassword(e.target.value)}
                placeholder="输入加密备份的密码"
                onKeyDown={e => { if (e.key === 'Enter') doImportEncrypted(); }} />
            </div>
            <div className="flex gap-8 mt-16">
              <button className="btn btn-secondary" onClick={() => { setStep('select'); setRecords([]); setFilePath(''); setImportPassword(''); }}>返回</button>
              <button className="btn btn-primary" onClick={doImportEncrypted}>解密并导入</button>
            </div>
          </div>
        )}

        {step === 'preview' && !isBookmark && (
          <>
            <h3 style={{ marginBottom: 12 }}>字段映射</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
              将文件字段映射到网址管理器字段 ({records.length} 条记录)
            </p>
            {isBookmark ? null : availableFields.map(field => {
              const fieldLabels: Record<string, string> = {
                name: '名称', url: '网址', username: '账号', password: '密码', notes: '备注', tags: '标签', envType: '环境类型'
              };
              const fileKeys = records.length > 0 ? Object.keys(records[0]) : [];
              return (
                <div key={field} className="field-mapping">
                  <span className="text-sm">{fieldLabels[field]}</span>
                  <span>←</span>
                  <select value={fieldMapping[field] || ''} onChange={e => setFieldMapping(prev => ({ ...prev, [field]: e.target.value }))}>
                    <option value="">- 不导入 -</option>
                    {fileKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
              );
            })}

            <div className="form-group">
              <label>环境类型（未匹配时默认）</label>
              <select value={envType} onChange={e => setEnvType(e.target.value)}>
                <option value="production">正式</option>
                <option value="testing">测试</option>
                <option value="development">开发</option>
                <option value="staging">预发布</option>
              </select>
            </div>
          </>
        )}

        {step === 'preview' && isBookmark && (
          <>
            <h3 style={{ marginBottom: 12 }}>浏览器书签</h3>
            <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
              检测到 {mappedEntries.length} 个书签，环境类型默认为"正式"
            </p>
          </>
        )}

        {step === 'preview' && (
          <>
            <div className="form-group">
              <label>冲突处理策略</label>
              <select value={conflictStrategy} onChange={e => setConflictStrategy(e.target.value as ConflictStrategy)}>
                <option value="skip">跳过重复（依据URL）</option>
                <option value="overwrite">覆盖更新</option>
                <option value="duplicate">重复新增</option>
              </select>
            </div>
            <div className="flex gap-8 mt-16">
              <button className="btn btn-secondary" onClick={() => { setStep('select'); setRecords([]); setFilePath(''); setImportPassword(''); }}>返回</button>
              <button className="btn btn-primary" onClick={handleConfirmImport}>确认导入</button>
            </div>
          </>
        )}

        {step === 'done' && (
          <div className="empty-state">
            <svg viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="1.5" width="64" height="64">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
              <polyline points="22 4 12 14.01 9 11.01"/>
            </svg>
            <h3 style={{ color: 'var(--success)' }}>导入完成</h3>
            <p>数据已成功导入到网址管理器</p>
            <button className="btn btn-primary mt-16" onClick={() => { setStep('select'); setRecords([]); setFilePath(''); setImportPassword(''); }}>继续导入</button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
