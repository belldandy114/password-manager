import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { useStore } from '../store/useStore';
import { useToast } from '../hooks/useToast';
import { ToastContainer } from '../components/Toast';
import type { ConflictStrategy } from '../types';

/** 目标字段：导入时要填到条目上的字段（顺序即界面顺序） */
const TARGET_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'name', label: '名称' },
  { key: 'url', label: '网址' },
  { key: 'username', label: '账号' },
  { key: 'password', label: '密码' },
  { key: 'notes', label: '备注' },
  { key: 'tags', label: '标签' },
  { key: 'envType', label: '环境类型' },
  { key: 'totpSecret', label: '两步验证密钥' },
  { key: 'favorite', label: '收藏' },
];

/**
 * 源字段中文名。主进程的 normalizeImportRecords 已经把各种导出文件的表头
 * （含中文表头、Bitwarden/1Password 的 login_uri 等）统一成这套内部字段名，
 * 所以界面上直接按内部名给中文对照，用户看到的是「名称（name）」而不是光秃秃的 name。
 */
const SOURCE_LABELS: Record<string, string> = {
  name: '名称',
  url: '网址',
  username: '账号',
  password: '密码',
  notes: '备注',
  tags: '标签',
  envType: '环境类型',
  totpSecret: '两步验证密钥',
  favorite: '收藏',
  id: '条目标识',
  createdAt: '创建时间',
  updatedAt: '修改时间',
};

/** 源字段下拉项文案：中文（原始字段名），没有中文对照就只显示原名 */
function sourceOptionLabel(key: string): string {
  const label = SOURCE_LABELS[key];
  return label ? `${label}（${key}）` : key;
}

const SOURCE_ORDER = Object.keys(SOURCE_LABELS);

/** 按中文名/内部名的顺序排源字段，让「名称、网址、账号…」排在前面对齐目标字段 */
function sortSourceKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ia = SOURCE_ORDER.indexOf(a);
    const ib = SOURCE_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}

export function ImportPage() {
  const { toasts, addToast, removeToast } = useToast();
  const [step, setStep] = useState<'select' | 'preview' | 'done' | 'enc-password'>('select');
  const [filePath, setFilePath] = useState('');
  const [fileName, setFileName] = useState('');
  const [records, setRecords] = useState<any[]>([]);
  const [mappedEntries, setMappedEntries] = useState<any[]>([]);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategy>('skip');
  const entries = useStore(s => s.entries);
  const [envType, setEnvType] = useState('production');
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({
    name: 'name',
    url: 'url',
    username: 'username',
    password: 'password',
    notes: 'notes',
  });
  const [isBookmark, setIsBookmark] = useState(false);
  const [rawMode, setRawMode] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importPassword, setImportPassword] = useState('');
  const dragDepthRef = useRef(0);

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
    mapping.tags = mapTo(['tags', 'tag', 'folder', '标签'], 'tags');
    mapping.envType = mapTo(['envtype', 'env', '环境类型', '环境'], 'envType');
    mapping.totpSecret = mapTo(['totpsecret', 'totp', 'otp', 'otpauth'], 'totpSecret');
    mapping.favorite = mapTo(['favorite', 'starred', '收藏'], 'favorite');
    return mapping;
  };

  const resetToSelect = () => {
    setStep('select');
    setRecords([]);
    setMappedEntries([]);
    setFilePath('');
    setFileName('');
    setImportPassword('');
    setIsBookmark(false);
    setRawMode(false);
  };

  const handleDownloadTemplate = async () => {
    const result = await window.electronAPI.importDownloadTemplate();
    if (result.success) {
      addToast('模板已保存', 'success');
    }
  };

  const processFile = async (path: string) => {
    setFilePath(path);
    setFileName(path.split(/[\\/]/).pop() || path);
    const ext = (path.toLowerCase().split('.').pop() || '').replace(/[^a-z0-9]/g, '');

    if (ext === 'enc') {
      setStep('enc-password');
      return;
    }

    if (ext === 'html' || ext === 'htm') {
      setIsBookmark(true);
      try {
        const result = await window.electronAPI.importCsvJson({ filePath: path });
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
      const result = await window.electronAPI.importCsvJson({ filePath: path });
      if (result.success && result.data) {
        const rows = result.data;
        if (rows.length === 0) {
          addToast('文件中没有可导入的数据', 'error');
          return;
        }
        setRecords(rows);
        setRawMode(!!result.raw);
        const keys = Object.keys(rows[0]);
        setFieldMapping(detectMapping(keys));
        setStep('preview');
      } else {
        addToast(result.error || '读取失败', 'error');
      }
    } catch (e: any) {
      addToast(`读取失败: ${e.message}`, 'error');
    }
  };

  /** 拖入的 File → 真实路径（Electron 32+ 需 webUtils，File.path 已不存在） */
  const resolveDroppedPath = (file: File): string => {
    const viaWebUtils = window.electronAPI.filePathFor?.(file);
    if (viaWebUtils) return viaWebUtils;
    // 老版本 Electron / 浏览器环境下的兜底
    return (file as any).path || '';
  };

  const handleDropFiles = useCallback((files: File[]) => {
    if (!files.length) return;
    if (files.length > 1) addToast('一次只能导入一个文件，已取第一个', 'info');
    const path = resolveDroppedPath(files[0]);
    if (!path) {
      addToast('无法读取文件路径，请点击此区域选择文件', 'error');
      return;
    }
    void processFile(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 整页接收拖放：拖到页面任何位置都算，避免用户拖偏了没反应
  useEffect(() => {
    if (step !== 'select') return;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (e: DragEvent) => {
      // dragleave 会在子元素间反复触发，用计数避免闪烁
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0 || e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files || []);
      if (files.length) handleDropFiles(files);
    };
    document.addEventListener('dragenter', onDragEnter);
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
    };
  }, [step, handleDropFiles]);

  /** 把解析出来的原始记录按当前字段映射拼成条目（预览统计与实际导入共用同一套逻辑） */
  const buildEntries = useCallback((rows: any[]) => rows.map(r => {
    const entry: any = { id: crypto.randomUUID(), tags: [], envType, createdAt: new Date().toISOString() };
    for (const [field, srcKey] of Object.entries(fieldMapping)) {
      if (srcKey && r[srcKey] !== undefined && r[srcKey] !== null && String(r[srcKey]).trim() !== '') {
        if (field === 'tags') {
          entry.tags = String(r[srcKey]).split(/[;,、|]/).map((t: string) => t.trim()).filter(Boolean);
        } else if (field === 'favorite') {
          entry.favorite = /^(true|1|yes|是)$/i.test(String(r[srcKey]));
        } else if (field === 'envType') {
          entry.envType = String(r[srcKey]);
        } else {
          entry[field] = r[srcKey];
        }
      }
    }
    if (!entry.name) entry.name = entry.url || '未命名';
    return entry;
  }), [fieldMapping, envType]);

  /** 待导入条目：书签走独立分支，其余按字段映射生成 */
  const pendingEntries = useMemo(() => {
    if (isBookmark) return mappedEntries.filter(e => e && e.url);
    if (records.length === 0) return [];
    return buildEntries(records);
  }, [isBookmark, mappedEntries, records, buildEntries]);

  /** 预计重复条数：与现有数据按 url + 用户名比对 */
  const dupCount = useMemo(() => {
    if (pendingEntries.length === 0) return 0;
    const key = (e: any) => {
      const url = String(e && e.url || '').trim().toLowerCase().replace(/\/+$/, '');
      const user = String(e && e.username || '').trim().toLowerCase();
      const name = String(e && e.name || '').trim().toLowerCase();
      return url ? `${url}||${user}` : `name||${name}||${user}`;
    };
    const known = new Set(entries.map(key));
    return pendingEntries.filter(e => known.has(key(e))).length;
  }, [pendingEntries, entries]);

  const doImportEncrypted = async () => {
    if (!importPassword) { addToast('请输入加密密码', 'error'); return; }
    try {
      const result = await window.electronAPI.importEncrypted({ filePath, importPassword });
      if (result.success && result.data) {
        const rows = result.data;
        if (rows.length === 0) {
          addToast('文件中没有数据', 'error');
          return;
        }
        setRecords(rows);
        const keys = Object.keys(rows[0]);
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

  const handleSelectFile = async () => {
    const result = await window.electronAPI.dialogOpenFile({
      filters: [
        { name: '支持的文件', extensions: ['enc', 'csv', 'json', 'xlsx', 'xls', 'html', 'txt'] },
        { name: '加密备份 (.enc)', extensions: ['enc'] },
        { name: 'Excel', extensions: ['xlsx', 'xls'] },
        { name: 'CSV', extensions: ['csv', 'txt'] },
        { name: 'JSON', extensions: ['json'] },
        { name: 'HTML (浏览器书签)', extensions: ['html', 'htm'] },
        { name: '所有文件', extensions: ['*'] },
      ]
    });
    if (result.canceled || !result.filePath) return;
    processFile(result.filePath);
  };

  const handleConfirmImport = async () => {
    const rows = isBookmark ? pendingEntries : buildEntries(records);
    if (rows.length === 0) {
      addToast('没有可导入的数据，请检查字段映射', 'error');
      return;
    }
    const result = await window.electronAPI.importConfirm({ entries: rows, conflictStrategy });
    if (result.success && result.data) {
      useStore.getState().setVaultData(result.data);
      const count = result.importedCount ?? rows.length;
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

  const sourceKeys = useMemo(
    () => (records.length > 0 ? sortSourceKeys(Object.keys(records[0])) : []),
    [records],
  );

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
              onClick={handleSelectFile}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" width="48" height="48" style={{ marginBottom: 12, opacity: 0.4 }}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              <h3>{dragging ? '松开即可开始导入' : '点击选择文件或拖入文件'}</h3>
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
                onKeyDown={e => { if (e.key === 'Enter') doImportEncrypted(); }} aria-label="解密密码" />
            </div>
            <div className="flex gap-8 mt-16">
              <button className="btn btn-secondary" onClick={resetToSelect}>返回</button>
              <button className="btn btn-primary" onClick={doImportEncrypted}>解密并导入</button>
            </div>
          </div>
        )}

        {step === 'preview' && !isBookmark && (
          <>
            <div className="import-head">
              <h3>字段映射</h3>
              <span className="text-sm text-muted">{fileName} · {records.length} 条记录</span>
            </div>
            <p className="text-sm text-muted" style={{ marginBottom: 16 }}>
              左侧是本应用的字段，右侧是文件里的列。已按列名自动匹配，需要时再手动调整。
            </p>
            {rawMode && (
              <div className="import-tip">
                没能自动识别列名，请手动指定「文件里的哪一列」对应到左侧字段。
              </div>
            )}
            <div className="field-mapping-list">
              {TARGET_FIELDS.map(({ key, label }) => {
                const matched = !!fieldMapping[key];
                return (
                  <div key={key} className="field-mapping">
                    <span className="fm-target">
                      {label}
                      {matched && <span className="fm-auto">自动</span>}
                    </span>
                    <span className="fm-arrow">←</span>
                    <select
                      aria-label={`${label} 对应的文件列`}
                      value={fieldMapping[key] || ''}
                      onChange={e => setFieldMapping(prev => ({ ...prev, [key]: e.target.value }))}
                    >
                      <option value="">- 不导入 -</option>
                      {sourceKeys.map(k => (
                        <option key={k} value={k}>{sourceOptionLabel(k)}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>

            <div className="form-group">
              <label>环境类型（未匹配时默认）</label>
              <select value={envType} onChange={e => setEnvType(e.target.value)} aria-label="环境类型（未匹配时默认）">
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
              检测到 {mappedEntries.length} 个书签，环境类型默认为“正式”
            </p>
          </>
        )}

        {step === 'preview' && (
          <>
            <div className="form-group">
              <label>冲突处理策略</label>
              <select value={conflictStrategy} onChange={e => setConflictStrategy(e.target.value as ConflictStrategy)} aria-label="冲突处理策略">
                <option value="skip">跳过重复（网址 + 账号相同）</option>
                <option value="overwrite">覆盖更新（用导入内容覆盖已有条目）</option>
                <option value="duplicate">全部新增（保留重复）</option>
              </select>
              <div className="pg-sub" style={{ marginTop: 6 }}>
                {dupCount > 0
                  ? `检测到 ${dupCount} 条与现有数据重复（共 ${pendingEntries.length} 条待导入）`
                  : `这 ${pendingEntries.length} 条都是新数据，不会产生重复`}
              </div>
            </div>
            <div className="flex gap-8 mt-16">
              <button className="btn btn-secondary" onClick={resetToSelect}>返回</button>
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
            <p>数据已成功导入到测试中台</p>
            <button className="btn btn-primary mt-16" onClick={resetToSelect}>继续导入</button>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
