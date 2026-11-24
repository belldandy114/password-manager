/**
 * 页签②：元素库 → Playwright POM
 *
 * pomPages 集合的增删改查 + 生成 Page Object；元素表本身在 ElementTable.tsx。
 *
 * 来源：t41 把 `src/pages/CodeGen.tsx`（1098 行）按 `docs/拆分-渲染层.md` §3.1 拆开。
 * **纯搬运**：逻辑、文案、IPC 调用一字未改；除本文件头与 import 外，剩下的行都来自原文件对应行段。
 */

import { useState, useEffect } from 'react';
import { Page, Panel, Empty, Field, BusyProgress, Icons } from '../ui';
import { useCollection } from '../../hooks/useCollection';
import { generatePageObject } from '../../utils/codegen/pageobject';
import type { GeneratedFile } from '../../utils/codegen/escape';
import { ElementTable } from './ElementTable';
import { saveJavaFile, GeneratedFilesView } from './GeneratedFiles';
import { blankPage, validatePage, trimPagesForWrite, MAX_PAGES, MAX_ELEMENTS } from './pomModel';
import type { PomWritePlan } from './pomModel';
import type { PomPage, PomElementRow } from './pomModel';

/* ================================================================
   页签②：元素库 → POM
   ================================================================ */

export function ElementLibTab({
  addToast,
  ask,
}: {
  addToast: (msg: string, type?: 'info' | 'success' | 'error') => void;
  ask: (opts: { title: string; message?: string; confirmText?: string; onOk: () => void }) => void;
}) {
  const { items, save, loading } = useCollection<PomPage>('pomPages');
  const [activeId, setActiveId] = useState('');
  const [draft, setDraft] = useState<PomPage | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [genErr, setGenErr] = useState('');
  const [savedAt, setSavedAt] = useState<Record<string, string>>({});
  /** 上限裁剪提示（[C-25]：不许静默丢） */
  const [trimWarn, setTrimWarn] = useState('');
  /** 裁剪结果统一处理：横幅常显 + toast 一次，两处写入共用 */
  const noteTrim = (plan: PomWritePlan) => {
    if (!plan.dropped) return;
    setTrimWarn(plan.notice);
    addToast(plan.notice, 'info');
  };

  /**
   * 首次读完库后自动选中第一条。
   *
   * 判据是「**还没有草稿**」，不是「activeId 不在 items 里」——后者会把刚点「新建页面」
   * 得到的那份未保存草稿当成「已被删除」再清空（新建时 items 里当然没有它），
   * 表现是点了新建什么都不出来。删除页面的清理在 removePage 里显式做。
   */
  useEffect(() => {
    if (loading || draft) return;
    const first = items[0];
    if (!first) return;
    setActiveId(first.id);
    setDraft({ ...first, elements: first.elements.map((e) => ({ ...e })) });
  }, [loading, items, draft]);

  const select = (p: PomPage) => {
    setActiveId(p.id);
    setDraft({ ...p, elements: p.elements.map((e) => ({ ...e })) });
    setErr('');
    setFiles([]);
    setGenErr('');
  };

  const createPage = () => {
    if (items.length >= MAX_PAGES) {
      addToast(`最多 ${MAX_PAGES} 个页面，先删几个再建`, 'error');
      return;
    }
    const p = blankPage();
    setActiveId(p.id);
    setDraft(p);
    setErr('');
    setFiles([]);
  };

  const patchDraft = (patch: Partial<PomPage>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  const patchElement = (index: number, patch: Partial<PomElementRow>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const elements = prev.elements.map((el, i) => (i === index ? { ...el, ...patch } : el));
      return { ...prev, elements };
    });
  };

  const addElement = () => {
    if (!draft) return;
    if (draft.elements.length >= MAX_ELEMENTS) {
      addToast(`单个页面最多 ${MAX_ELEMENTS} 个元素`, 'error');
      return;
    }
    patchDraft({ elements: [...draft.elements, { name: '', locator: '', kind: 'css', role: '' }] });
  };

  const removeElement = (index: number) => {
    if (!draft) return;
    patchDraft({ elements: draft.elements.filter((_, i) => i !== index) });
  };

  const savePage = async () => {
    if (!draft) return;
    const message = validatePage(draft, items);
    if (message) {
      setErr(message);
      addToast(message, 'error');
      return;
    }
    setErr('');
    setBusy(true);
    try {
      const clean: PomPage = {
        ...draft,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        className: (draft.className || '').trim(),
        note: (draft.note || '').trim(),
        elements: draft.elements.map((el) => ({
          name: el.name.trim(),
          locator: el.locator, // [C-27]：定位器原样存，转义只在生成器里做
          kind: el.kind,
          ...(el.kind === 'role' ? { role: String(el.role ?? '').trim() } : {}),
          ...(el.note ? { note: el.note } : {}),
        })),
        updatedAt: new Date().toISOString(),
      };
      const exists = items.some((p) => p.id === clean.id);
      const next = exists ? items.map((p) => (p.id === clean.id ? clean : p)) : [clean, ...items];
      // [C-24]/[C-25]：ws:set 之前按上限裁剪；keepId=刚保存的这条，保证它不会被当"最旧"清掉
      const plan = trimPagesForWrite(next, clean.id);
      const r = await save(plan.items);
      noteTrim(plan);
      if (!r.success) {
        setErr(r.error || '保存失败');
        addToast(r.error || '保存失败', 'error');
        return;
      }
      setDraft(clean);
      setActiveId(clean.id);
      addToast(exists ? '页面已更新' : '页面已保存到加密库', 'success');
    } finally {
      setBusy(false);
    }
  };

  const removePage = (p: PomPage) => {
    ask({
      title: '删除元素库页面',
      message: `确定删除「${p.name || '未命名页面'}」？只删这份元素表，不影响已生成的 Java 文件。`,
      confirmText: '删除',
      onOk: () => {
        void (async () => {
          const plan = trimPagesForWrite(items.filter((x) => x.id !== p.id));
          const r = await save(plan.items);
          noteTrim(plan);
          if (!r.success) {
            addToast(r.error || '删除失败', 'error');
            return;
          }
          if (activeId === p.id) {
            setDraft(null);
            setActiveId('');
          }
          addToast('已删除', 'success');
        })();
      },
    });
  };

  const generate = async () => {
    if (!draft) return;
    const message = validatePage(draft, items);
    if (message) {
      setErr(message);
      addToast(message, 'error');
      return;
    }
    setBusy(true);
    setGenErr('');
    setFiles([]);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const res = generatePageObject({
        className: (draft.className || '').trim() || draft.name.trim(),
        packageName: 'pages',
        baseUrl: draft.baseUrl.trim(),
        pageName: draft.name.trim(),
        elements: draft.elements.map((el) => ({
          name: el.name.trim(),
          locator: el.locator,
          kind: el.kind,
          ...(el.kind === 'role' ? { roleName: String(el.role ?? '').trim() } : {}),
        })),
      });
      if (!res.ok) {
        setGenErr(res.error);
        return;
      }
      setFiles(res.files);
      if (res.warnings.length) addToast(`已生成，但有 ${res.warnings.length} 条告警`, 'info');
      else addToast('已生成 Page Object', 'success');
    } catch (e) {
      setGenErr('生成失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async (file: GeneratedFile, defaultName: string) => {
    await saveJavaFile(file, defaultName, addToast, setSavedAt);
  };

  return (
    <div className="split">
      {/* ---- 左：页面列表（普通列表 .dev-list*，不复用数据生成器的两行类型卡 .tdg-type） ---- */}
      <Panel
        title="页面"
        meta={loading ? '加载中…' : `${items.length}/${MAX_PAGES}`}
        flush
        tools={
          <button className="btn btn-secondary btn-sm" onClick={createPage} disabled={loading}>
            <Icons.plus size={13} /> 新建页面
          </button>
        }
      >
        <div className="dev-list">
          {loading && <div className="text-sm text-muted">正在读加密库…</div>}
          {!loading && items.length === 0 && (
            <div className="text-sm text-muted">
              还没有元素库页面。点上面「新建页面」，填页面名与地址，再加元素。
            </div>
          )}
          {!loading && items.map((p) => {
            const on = p.id === activeId;
            return (
              /* 行容器**不交互**：原来给 div 挂 role=button + tabIndex + onClick，里面再嵌删除
                 button，等于「交互控件内嵌交互控件」（ARIA 不允许，读屏用户会遇到两个焦点、
                 也分不清哪个代表"选中"）。现在行只是布局容器，选中由名称按钮承担，
                 删除键是它的**兄弟节点**；选中语义用 aria-current（不是 aria-pressed ——
                 那是"开关按下"的意思，列表选中不是这东西）。 */
              <div key={p.id} className={`dev-list-item${on ? ' is-on' : ''}`}>
                <button
                  type="button"
                  className="dev-list-name"
                  aria-current={on ? 'true' : undefined}
                  title={p.name}
                  onClick={() => select(p)}
                  /* 唯一保留的内联：只重置浏览器给 <button> 的默认外观（灰底 + 2px outset 边框 +
                     居中），排版仍由 `.dev-list-name` 负责。CSS 里没有可复用的「裸按钮」类，
                     而 src/styles/ 不在本批 inScope —— 回执「本批不做清单」里已写明补法。 */
                  style={{ background: 'none', border: 0, textAlign: 'left' }}
                >
                  {p.name || '未命名页面'}
                </button>
                <span className="dev-list-count">{p.elements.length} 个元素</span>
                <button
                  className="btn btn-ghost btn-sm dev-list-del"
                  onClick={() => removePage(p)}
                  title="删除这个页面"
                  aria-label={`删除页面 ${p.name}`}
                >
                  <Icons.trash size={13} />
                </button>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* ---- 右：编辑 + 生成 ---- */}
      <div>
        {!draft
          ? (
            <Panel title="元素表">
              <Empty
                icon={<Icons.db size={22} />}
                title="左侧没有可编辑的页面"
                desc={items.length ? '选一个页面，或新建一个。' : '元素库存在加密库里，跟着库走 —— 先新建一个页面。'}
                hint="页面名 + 地址 + 元素表（name / locator / kind），保存后才写进 vault。"
              />
            </Panel>
          )
          : (
            <>
              <Panel
                title="页面基础信息"
                meta={draft.name || '未命名'}
                tools={
                  <div className="tool-inline">
                    <button className="btn btn-secondary btn-sm" onClick={() => void savePage()} disabled={busy}>
                      <Icons.check size={13} /> 保存页面
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => void generate()} disabled={busy}>
                      <Icons.tool size={13} /> 生成 POM
                    </button>
                  </div>
                }
              >
                {busy && <BusyProgress active label="处理中…" />}
                {/* [C-25]：裁剪必须让用户看见，不许静默丢；提示会一直留到下次保存 */}
                {trimWarn && (
                  <div className="dev-banner is-warn" role="status"><Icons.clock size={14} /><div className="text-sm">{trimWarn}</div></div>
                )}
                <div className="grid2">
                  <Field label="页面名" hint="页面内唯一；也是 Java 类名的种子">
                    <input
                      value={draft.name}
                      onChange={(e) => patchDraft({ name: e.target.value })}
                      placeholder="登录页"
                      maxLength={80}
                    />
                  </Field>
                  <Field label="页面地址（baseUrl）">
                    <input
                      value={draft.baseUrl}
                      onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                      placeholder="https://example.com/login"
                      maxLength={500}
                    />
                  </Field>
                  <Field label="Java 类名（可选）" hint="留空则由页面名生成；建议给英文名">
                    <input
                      value={draft.className || ''}
                      onChange={(e) => patchDraft({ className: e.target.value })}
                      placeholder="LoginPage"
                      maxLength={80}
                    />
                  </Field>
                  <Field label="备注（可选）">
                    <input
                      value={draft.note || ''}
                      onChange={(e) => patchDraft({ note: e.target.value })}
                      placeholder="这个页面是干什么的"
                      maxLength={200}
                    />
                  </Field>
                </div>

                {err && (
                  <div className="dev-banner is-error mt-8" role="alert">
                    <Icons.bug size={14} />
                    <div className="text-sm">{err}</div>
                  </div>
                )}

                <div className="tool-inline mt-16">
                  <span className="dev-tag is-unknown">
                    <Icons.list size={13} />
                    {draft.elements.length}/{MAX_ELEMENTS} 个元素
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={addElement}
                    disabled={draft.elements.length >= MAX_ELEMENTS}
                    title={draft.elements.length >= MAX_ELEMENTS ? `单个页面最多 ${MAX_ELEMENTS} 个元素` : '加一行'}
                  >
                    <Icons.plus size={13} /> 加元素
                  </button>
                </div>

                {/* 大表必须套 .dev-scroll：.pnl 是 overflow:hidden，不套会把右侧列裁掉 */}
                <ElementTable
                  elements={draft.elements}
                  onPatch={patchElement}
                  onRemove={removeElement}
                />

                {genErr && (
                  <div className="dev-banner is-error mt-8" role="alert">
                    <Icons.bug size={14} />
                    <div className="text-sm">{genErr}</div>
                  </div>
                )}
              </Panel>

              {files.length > 0 && (
                <Panel title="生成的 Page Object" meta={`${files.length} 个文件`}>
                  <div className="dev-banner is-info">
                    <Icons.check size={14} />
                    <div className="text-sm">
                      生成只到预览为止，保存要你自己点（会弹系统保存框）。元素定位器里的引号 / 反斜杠已按 Java 规则转义。
                    </div>
                  </div>
                  <GeneratedFilesView
                    files={files}
                    defaultSaveName={`${(draft.className || draft.name || 'Page').trim()}.java`}
                    onSave={(f, n) => void saveFile(f, n)}
                  />
                  {Object.keys(savedAt).length > 0 && (
                    <div className="text-sm text-muted mt-8">
                      已保存：{Object.entries(savedAt).map(([p, abs]) => `${p.split('/').pop()} → ${abs}`).join('；')}
                    </div>
                  )}
                </Panel>
              )}
            </>
          )}
      </div>
    </div>
  );
}