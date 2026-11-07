import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { Icons } from './ui';
import { applyTheme } from '../utils/theme';
import { guessUrlFromInput } from '../utils/urlInput';

export type Kind = 'page' | 'action' | 'entry' | 'snippet' | 'note' | 'account' | 'request' | 'checklist' | 'env';

interface Cmd {
  id: string;
  title: string;
  sub?: string;
  kind: Kind;
  run: () => void;
}

export const KIND_LABEL: Record<Kind, string> = {
  page: '页面', action: '操作', entry: '网址', snippet: '片段', note: '笔记', account: '账号',
  request: '请求', checklist: '用例', env: '环境',
};

export const PAGES: { page: string; label: string }[] = [
  { page: 'passwordManager', label: '网址管理' },
  { page: 'accounts', label: '测试账号' },
  { page: 'weeklyReport', label: '周报' },
  { page: 'snippets', label: 'SQL 片段' },
  { page: 'notes', label: '测试笔记' },
  { page: 'zentao', label: '缺陷管理' },
  { page: 'dataGenerator', label: '测试数据' },
  { page: 'toolbox', label: '工具箱' },
];

// 工具箱里的每个工具都能被搜到（Ctrl+K → 输入 base64 / jwt / 二维码…）
export const TOOLBOX_TOOLS: Array<{ id: string; label: string; kw: string }> = [
  { id: 'timestamp', label: '时间戳换算', kw: 'timestamp unix 日期' },
  { id: 'timeline', label: '时间轴 / 耗时', kw: '耗时 间隔 时间轴' },
  { id: 'timezone', label: '时区换算', kw: 'timezone utc' },
  { id: 'cron', label: 'Cron 解析', kw: 'crontab 定时 表达式' },
  { id: 'encode', label: '编码转换', kw: 'base64 url html hex gbk unicode' },
  { id: 'hash', label: '哈希 / HMAC', kw: 'md5 sha hmac 摘要 文件校验' },
  { id: 'sign', label: '签名计算', kw: 'sign 签名 md5 secret' },
  { id: 'jwt', label: 'JWT 生成', kw: 'jwt token hs256' },
  { id: 'aes', label: 'AES 加解密', kw: 'aes gcm 加密' },
  { id: 'regex', label: '正则测试', kw: 'regexp 正则' },
  { id: 'regexExtract', label: '正则提取', kw: 'regex 提取' },
  { id: 'diff', label: '文本对比', kw: 'diff 对比' },
  { id: 'jsonRepair', label: 'JSON 转化 / 提取', kw: 'json 格式化 修复 路径' },
  { id: 'jsonDiff', label: 'JSON 结构对比', kw: 'json diff 对比' },
  { id: 'yaml', label: 'YAML ↔ JSON', kw: 'yaml 配置' },
  { id: 'urlParams', label: 'URL 参数拆解', kw: 'url query 参数' },
  { id: 'sql', label: 'SQL 参数化', kw: 'sql 占位 参数' },
  { id: 'idGen', label: 'ID / 流水号', kw: 'uuid 订单号 雪花 traceid' },
  { id: 'validate', label: '数据校验', kw: '身份证 银行卡 手机号 校验' },
  { id: 'media', label: '图片 / 二维码', kw: 'qrcode 二维码 base64 图片' },
];

export const PAGES_MORE: { page: string; label: string }[] = [
  { page: 'apiClient', label: '接口调试' },
  { page: 'perfTest', label: '压力测试' },
  { page: 'codeLab', label: '代码调试' },
  { page: 'settings', label: '设置' },
];
PAGES.push(...PAGES_MORE);

/**
 * 全局命令面板（Ctrl+K）：一处搜页面 / 网址 / 片段 / 笔记 / 账号。
 * 只在打开时读一次扩展数据，避免常驻内存。
 */
export function CommandPalette({
  open, onClose, onNavigate, onLock,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (page: string) => void;
  onLock: () => void;
}) {
  const entries = useStore(s => s.entries);
  const openToolboxTool = useStore(s => s.openToolboxTool);
  const setSearchQuery = useStore(s => s.setSearchQuery);
  const setPmSubPage = useStore(s => s.setPmSubPage);
  const signalNewEntry = useStore(s => s.signalNewEntry);
  const signalCmd = useStore(s => s.signalCmd);
  const settings = useStore(s => s.settings);
  const updateSettings = useStore(s => s.updateSettings);

  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [extra, setExtra] = useState<{
    snippets: any[]; notes: any[]; accounts: any[];
    apiRequests: any[]; checklists: any[]; environments: any[];
  }>({ snippets: [], notes: [], accounts: [], apiRequests: [], checklists: [], environments: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setIdx(0);
    setTimeout(() => inputRef.current?.focus(), 30);
    (async () => {
      const [sn, nt, ac, rq, ck, ev] = await Promise.all([
        window.electronAPI.wsGet('snippets'),
        window.electronAPI.wsGet('notes'),
        window.electronAPI.wsGet('accounts'),
        window.electronAPI.wsGet('apiRequests'),
        window.electronAPI.wsGet('checklists'),
        window.electronAPI.wsGet('environments'),
      ]);
      const pick = (r: any) => (r && r.success ? r.data || [] : []);
      setExtra({
        snippets: pick(sn),
        notes: pick(nt),
        accounts: pick(ac),
        apiRequests: pick(rq),
        checklists: pick(ck),
        environments: pick(ev),
      });
    })();
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const base: Cmd[] = [
      ...PAGES.map(p => ({
        id: `page:${p.page}`,
        title: p.label,
        sub: '打开页面',
        kind: 'page' as Kind,
        run: () => onNavigate(p.page),
      })),
      // 工具箱里的具体工具：搜「base64 / jwt / 二维码」直接落到那个工具
      ...TOOLBOX_TOOLS.map((t) => ({
        id: `toolbox:${t.id}`,
        title: t.label,
        sub: `工具箱 · ${t.kw}`,
        kind: 'action' as Kind,
        run: () => { openToolboxTool(t.id); onNavigate('toolbox'); },
      })),
      {
        id: 'action:new-entry',
        title: '新建网址',
        sub: '相当于 Ctrl+N',
        kind: 'action',
        run: () => { onNavigate('passwordManager'); setPmSubPage('dashboard'); signalNewEntry(); },
      },
      { id: 'action:lock', title: '锁定密码库', sub: '立即锁屏', kind: 'action', run: onLock },
      {
        id: 'action:zt-refresh',
        title: '刷新：我的 Bug',
        sub: '重新拉缺陷管理「我的 Bug」',
        kind: 'action',
        run: () => { onNavigate('zentao'); signalCmd('zentao:refresh-mine'); },
      },
      {
        id: 'action:weekly-draft',
        title: '生成周报草稿',
        sub: '用禅道「我的 Bug」生成本周草稿',
        kind: 'action',
        run: () => { onNavigate('weeklyReport'); signalCmd('weekly:draft'); },
      },
      {
        id: 'action:theme',
        title: settings.theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        sub: '立即切换界面配色',
        kind: 'action',
        run: () => {
          const next = settings.theme === 'dark' ? 'light' : 'dark';
          applyTheme(next);
          updateSettings({ theme: next });
          window.electronAPI.settingsSave({ theme: next });
        },
      },
      { id: 'action:zentao', title: '缺陷管理：我的 Bug', sub: '打开缺陷管理页', kind: 'action', run: () => onNavigate('zentao') },
      { id: 'action:api', title: '发一个接口请求', sub: '打开接口调试', kind: 'action', run: () => onNavigate('apiClient') },
    ];

    const fromEntries: Cmd[] = entries.slice(0, 400).map(e => ({
      id: `entry:${e.id}`,
      title: e.name,
      sub: [e.username, e.url].filter(Boolean).join(' · '),
      kind: 'entry' as Kind,
      run: () => {
        onNavigate('passwordManager');
        setPmSubPage('dashboard');
        setSearchQuery(e.name);
      },
    }));

    const fromSnippets: Cmd[] = extra.snippets.slice(0, 200).map((s: any) => ({
      id: `snippet:${s.id}`,
      title: s.title || '（无标题片段）',
      sub: (s.tags || []).join(' '),
      kind: 'snippet' as Kind,
      run: () => onNavigate('snippets'),
    }));

    const fromNotes: Cmd[] = extra.notes.slice(0, 200).map((n: any) => ({
      id: `note:${n.id}`,
      title: n.title || '（无标题笔记）',
      sub: '',
      kind: 'note' as Kind,
      run: () => onNavigate('notes'),
    }));

    const fromAccounts: Cmd[] = extra.accounts.slice(0, 200).map((a: any) => ({
      id: `account:${a.id}`,
      title: `${a.system || '未分组'} · ${a.username || ''}`,
      sub: a.role || '',
      kind: 'account' as Kind,
      run: () => onNavigate('accounts'),
    }));

    const fromRequests: Cmd[] = extra.apiRequests.slice(0, 200).map((r: any) => ({
      id: `request:${r.id}`,
      title: (r.name && r.name !== '未命名') ? r.name : `${r.method || 'GET'} ${String(r.url || '').replace(/^https?:\/\//, '')}`.slice(0, 70),
      sub: `${r.method || 'GET'} ${String(r.url || '').replace(/^https?:\/\//, '').slice(0, 60)}`,
      kind: 'request' as Kind,
      // 深链：跳接口调试并把这条请求填进编辑器
      run: () => { onNavigate('apiClient'); signalCmd(`api:open:${r.id}`); },
    }));

    const fromChecklists: Cmd[] = extra.checklists.slice(0, 200).map((c: any) => ({
      id: `checklist:${c.id}`,
      title: c.title || '（无标题用例）',
      sub: (c.items || []).length ? `${c.items.length} 项` : '',
      kind: 'checklist' as Kind,
      run: () => onNavigate('checklists'),
    }));

    const fromEnvs: Cmd[] = extra.environments.slice(0, 200).map((e: any) => ({
      id: `env:${e.id}`,
      title: `${e.system || '未命名'} · ${e.env || ''}`.trim(),
      sub: String(e.url || '').slice(0, 70),
      kind: 'env' as Kind,
      run: () => onNavigate('environments'),
    }));

    return [
      ...base, ...fromEntries, ...fromSnippets, ...fromNotes, ...fromAccounts,
      ...fromRequests, ...fromChecklists, ...fromEnvs,
    ];
  }, [entries, extra, onNavigate, onLock, setSearchQuery, setPmSubPage, signalNewEntry, signalCmd, settings.theme, updateSettings]);

  const filtered = useMemo(() => {
    const key = q.trim().toLowerCase();
    if (!key) {
      // 没输入时只列页面与操作，保持清爽
      return cmds.filter(c => c.kind === 'page' || c.kind === 'action').slice(0, 40);
    }
    return cmds
      .filter(c => `${c.title} ${c.sub || ''}`.toLowerCase().includes(key))
      .slice(0, 60);
  }, [cmds, q]);

  useEffect(() => { setIdx(0); }, [q]);

  // 焦点不在输入框（点过列表）时 Esc 也要能关
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const runAt = (i: number) => {
    const c = filtered[i];
    if (!c) return;
    onClose();
    setTimeout(() => c.run(), 0);
  };

  /** 搜不到时按 Enter：把查询词当网址，直接开「新增网址」并预填 */
  const createFromQuery = () => {
    const text = q.trim();
    if (!text) return;
    onClose();
    setTimeout(() => {
      onNavigate('passwordManager');
      setPmSubPage('dashboard');
      const guess = guessUrlFromInput(text);
      signalNewEntry(guess ? { url: guess.url, name: guess.name } : { name: text });
    }, 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered.length === 0 && q.trim()) createFromQuery();
      else runAt(idx);
    }
  };

  return (
    <>
      <div className="cmdk-mask" onClick={onClose} />
      <div className="cmdk" role="dialog" aria-label="命令面板">
        <div className="cmdk-search">
          <Icons.search size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索页面、网址、片段、笔记…"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="cmdk-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmdk-empty">
              <div>没有匹配项</div>
              {q.trim() && (
                <button type="button" className="cmdk-create" onClick={createFromQuery} title="回车亦可">
                  <Icons.plus size={13} />
                  用「{q.trim().length > 40 ? `${q.trim().slice(0, 40)}…` : q.trim()}」新建网址
                </button>
              )}
            </div>
          ) : filtered.map((c, i) => (
            <div
              key={c.id}
              className={`cmdk-item${i === idx ? ' is-active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => runAt(i)}
            >
              <span className={`cmdk-kind is-${c.kind}`}>{KIND_LABEL[c.kind]}</span>
              <span className="cmdk-title">{c.title}</span>
              {c.sub && <span className="cmdk-sub">{c.sub}</span>}
            </div>
          ))}
        </div>
        <div className="cmdk-foot">
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
          <span>{filtered.length} 项</span>
        </div>
      </div>
    </>
  );
}
