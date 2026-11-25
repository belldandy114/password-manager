/**
 * 产物**两选**（Java POM / Playwright *.spec.ts）—— **本片只交付组件，挂载由接线片做**。
 *
 * 与 S4b 的 `AbilityBar` 同一处境：`src/pages/Recorder.tsx` 不在本片 inScope，所以这里给出可直接挂的
 * 组件与 props 契约，录制页那一行由后续接线片补（`<ArtifactPicker rec={rec} />`）。
 *
 * 五条写死的口径：
 *
 * 1. **所有产物都来自 `recordScript.ts` 的 `buildArtifacts()`**（= 同一个 `stepsToCalls` 中间表示）。
 *    本组件**不拼一行产物代码**，否则 AC-20 的「同源」在这里就断了。
 * 2. **预览必须是既有 `<CodeBlock>`**（`06-队长裁定.md` J-3：复用 `codeHighlight.ts`，
 *    **不新写着色器、不覆写 `HIGHLIGHT_FOLD_LINES = 400`**）。所以这里**不传 `maxLines`**。
 * 3. **AC-16 的锚点在 `<pre>` 上**：`.tb-pre.dev-code[data-artifact="pom|spec"]`。
 *    `CodeBlock` 不接受额外属性、而 `src/components/ui.tsx` 不在本片 inScope，所以 `data-artifact`
 *    由 `ArtifactCode` 在挂载后写到那个 `<pre>` 上（唯一一处 DOM 属性补丁，注释写清原因）。
 * 4. **复制的是原文**（`art.code`），不是 `innerHTML`、不是 `textContent`——AC-16 的复制判据。
 *    走既有 `copyPlain()`（内部带 `execCommand` 兜底，窗口未聚焦时 `navigator.clipboard` 会抛）。
 * 5. **三档前置与告警逐份可见**：缺 `valueRef`、缺选项序号这类生成期告警不能只躺在返回值里
 *    （`[C-83]` 口径）。
 *
 * 视觉：全部复用既有类（`.view-switch-btn` / `.tool-inline` / `.dev-tag` / `.dev-banner` /
 * `.dev-scroll` / `.tb-pre.dev-code`），零新增样式、零色值字面量、不用浮层（无 `<datalist>`）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { CodeBlock, Empty, Icons } from '../ui';
import { copyPlain } from '../../utils/clipboard';
import { callIpc } from '../../utils/ipc';
import { scanElementRefs } from '../../utils/record/recorderModel';
import type { ElementRefPageLike, UiRecording } from '../../utils/record/recorderModel';
import { buildArtifacts, type ArtifactId, type ScriptArtifact } from '../../utils/record/recordScript';

/**
 * 两选按钮（顺序固定：① POM → ③ .spec.ts，与 01-方案 的编号一致；② .mjs 本期未交付，见下）。
 *
 * `limit` 是**逐份的限制说明**，不是装饰：两份产物各自的前置并不相同
 * （04 文案约束：不许让人以为两份等价，更不许写「已验证可跑通」这种结果承诺）。
 */
const PICKS: Array<{ id: ArtifactId; label: string; short: string; limit: string }> = [
  {
    id: 'pom',
    label: '① Java POM',
    short: '骨架',
    limit: '需 JDK 17+（javac）与 playwright Java jar（如 playwright-1.49.0.jar）；只保证「可编译」，不含驱动逻辑',
  },
  {
    id: 'spec',
    label: '③ Playwright .spec.ts',
    short: '用例',
    limit: '需 @playwright/test 与已下载的浏览器（本机三包全缺 → 记「未验证」）',
  },
];

export interface ArtifactPickerProps {
  /** 要导出的录制；`null` 时显示空态（录制页在「没有报告」时传 null） */
  rec: UiRecording | null;
  /** 空态文案（录制页可以换成自己的引导语） */
  emptyHint?: string;
  /** 默认选中哪几种（默认三种全选；允许一次只导一种） */
  defaultPicked?: ArtifactId[];
}

/**
 * 把 `data-artifact` 写到 `CodeBlock` 渲染出的那个 `<pre>` 上（AC-16 的锚点要求它挂在 `pre`）。
 *
 * 为什么用 effect 而不是给 `CodeBlock` 加 prop：`src/components/ui.tsx` 不在本片 inScope，
 * 而手写 `<pre>` 会同时丢掉行号槽、折叠条与 `.dev-scroll` 的直接父子关系（见 `ui.tsx:258-276`
 * 的三条理由）。这里只补一个数据属性，不碰任何 DOM 结构、样式或文本。
 */
function ArtifactCode({ art }: { art: ScriptArtifact }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pre = boxRef.current ? boxRef.current.querySelector('pre.tb-pre.dev-code') : null;
    if (pre) pre.setAttribute('data-artifact', art.id);
  }, [art.id, art.code]);
  return (
    <div ref={boxRef}>
      {/* `maxLines` 刻意不传：走 `HIGHLIGHT_FOLD_LINES = 400`（J-3 明令不得覆写） */}
      <CodeBlock code={art.code} lang={art.lang} />
    </div>
  );
}

export function ArtifactPicker({ rec, emptyHint, defaultPicked }: ArtifactPickerProps) {
  const [picked, setPicked] = useState<ArtifactId[]>(
    () => {
      const allow = PICKS.map((p) => p.id);
      const asked = Array.isArray(defaultPicked) ? defaultPicked.filter((id) => allow.indexOf(id) >= 0) : [];
      return asked.length ? asked : allow;
    },
  );
  const [copied, setCopied] = useState('');

  /**
   * 元素库快照：`null` = **还没查**。
   *
   * 三条约束（都来自 t38 的口径）：
   * 1. **懒加载**：没有录制（`rec === null`）时一次 IPC 都不发——录制页刚进来时产物区是空态，
   *    不该为「还没打开」的东西付这次 `ws:get('pomPages')` 成本；
   * 2. **只查一次**：`startedRef` 挡住重复请求，`pages` 用引用 memo 给下游（不每次渲染重扫）；
   * 3. **不新增 props**：`Recorder.tsx` 不在本片 inScope，拿不到外部传进来的 pages；
   *    自己读是唯一能让闸门在生产里真活着的方式（传 props 的话没人传就又是一段死代码）。
   */
  const [pages, setPages] = useState<ElementRefPageLike[] | null>(null);
  const startedRef = useRef(false);
  useEffect(() => {
    if (!rec || startedRef.current) return;
    startedRef.current = true;
    let alive = true;
    void (async () => {
      const r = await callIpc(() => window.electronAPI.wsGet('pomPages'));
      if (!alive) return;
      setPages(r.ok && Array.isArray(r.data) ? (r.data as ElementRefPageLike[]) : []);
    })();
    return () => { alive = false; };
  }, [rec]);

  /**
   * 生成前兜底（RA3-01 第 3 处调用点）：扫**这一步要导出的这份录制**有没有断链引用。
   *
   * ⚠️ 扫的是 `rec.steps`（`UiStep[]`），不是生成出来的调用序列 —— t32 补的起始导航是
   * `ScriptCall{preamble:true}`、**没有 `elementId`**，所以它永远进不了 `dangling`，
   * 不会让每次生成都误报一条。
   */
  const dangling = useMemo(
    () => (rec && pages ? scanElementRefs([rec], pages).dangling : []),
    [rec, pages],
  );
  const blocked = dangling.length > 0;
  /** 引用还没查完之前不许生成（否则第一次渲染会先产出一份可能断链的脚本，再被拦下来） */
  const ready = !rec || pages !== null;

    // 关键：两份产物由**同一份** rec 一次性生成（内部共同经过 stepsToCalls），不在这里分头拼
  const artifacts = useMemo(
    () => (rec && ready && !blocked ? buildArtifacts(rec, PICKS.map((p) => p.id)) : []),
    [rec, ready, blocked],
  );
  const shown = artifacts.filter((a) => picked.indexOf(a.id) >= 0);
  const byId = useMemo(() => {
    const map = new Map<ArtifactId, ScriptArtifact>();
    artifacts.forEach((a) => map.set(a.id, a));
    return map;
  }, [artifacts]);

  const toggle = (id: ArtifactId) => {
    setPicked((prev) => (prev.indexOf(id) >= 0 ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const copyCode = async (art: ScriptArtifact) => {
    // 复制**原文**：`art.code` 就是产物源码本身（不是 innerHTML / textContent 的再加工）
    await copyPlain(art.code);
    setCopied(`已复制 ${art.filename}（${art.code.length} 字符）`);
  };

  const copyCommand = async (art: ScriptArtifact) => {
    await copyPlain(art.runCommand);
    setCopied(`已复制运行命令：${art.runCommand}`);
  };

  if (!rec) {
    return (
      <Empty
        icon={<Icons.tool size={22} />}
        title="还没有可导出的录制"
        desc={emptyHint || '先在「录制」页签录几步、停止并校验，这里就能导出两份产物。'}
        hint="两份产物由同一份录制生成：步骤与定位器逐条一致（AC-20）。"
      />
    );
  }

  return (
    <div>
      {/*
        引用完整性兜底（RA3-01 第 3 处调用点）。放在选择器之前：生成被拦时，三选按钮也不该
        看起来「可以点但没反应」——先把原因摆出来，再决定去补元素还是改录制。
      */}
      {!ready ? (
        <div className="dev-banner is-info" data-reffetch="pending">
          <Icons.search size={14} />
          <span className="text-sm">正在检查引用完整性（元素库里的元素是否都还在）…</span>
        </div>
      ) : null}
      {blocked ? (
        <div className="dev-banner is-error" data-ref-block="artifact" role="alert">
          <Icons.bug size={14} />
          <div className="text-sm">
            <div>
              <b>有 {dangling.length} 个步骤引用的元素已不存在，已禁止生成产物</b>
            </div>
            {/* 内联只重置 <ul> 的默认缩进：src/styles/** 不在本片 inScope，无现成可复用类 */}
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {dangling.slice(0, 8).map((d) => (
                <li key={`${d.recordingId}:${d.stepIndex}:${d.elementId}`}>
                  {rec.name || '这份录制'} 第 {d.stepIndex + 1} 步 → 元素 {d.elementId}
                </li>
              ))}
              {dangling.length > 8 ? <li>…等 {dangling.length} 处</li> : null}
            </ul>
            <div className="text-muted">
              这份录制里的步骤指向了元素库里已经没有的元素：直接导出会得到一份必然断链的脚本，
              比现在报错更浪费。请先在「代码生成 · 元素库」里补回这些元素，或回「录制」里改掉这些步骤。
            </div>
          </div>
        </div>
      ) : null}
      {/* 三选（可多选）：`.view-switch-btn` 是既有分段控件，`.is-on` 表示选中 */}
      <div className="tool-inline">
        {PICKS.map((p) => {
          const art = byId.get(p.id);
          const on = picked.indexOf(p.id) >= 0;
          return (
            <button
              key={p.id}
              type="button"
              className={`view-switch-btn${on ? ' is-on' : ''}`}
              aria-pressed={on}
              title={art ? `${art.filename}（${p.short}）—— ${p.limit}` : `${p.label} —— ${p.limit}`}
              onClick={() => toggle(p.id)}
            >
              {p.label}
            </button>
          );
        })}
        <span className="flex-1" />
        <span className="text-sm text-muted">
          可多选；两份产物由同一份录制生成（步骤与定位器逐条一致），但各自的**前置不同**，见下一行
        </span>
      </div>

      {/*
          两份产物的**限制说明逐条列出**：POM 要 JDK + playwright jar（只保证可编译）、spec 要 @playwright/test，
          不写清用户会以为两份可以随便挑一份跑。② 零依赖 .mjs 本期**未交付**（AC-10a 六轮未通过 → P3），不在此列出。
        措辞只写前置与场景，不写「已验证可跑通」（`04` 文案硬约束）。
      */}
      <ul className="text-sm text-muted mt-8" data-artifact-limits>
        {PICKS.map((p) => (
          <li key={p.id} data-artifact-limit={p.id}>
            {p.label} —— {p.limit}
          </li>
        ))}
      </ul>

      {copied ? (
        <div className="dev-tag is-ok mt-8" role="status">
          <Icons.check size={13} />
          {copied}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <div className="dev-banner is-info mt-8">
          <Icons.list size={14} />
          <div className="text-sm">至少选一种产物才有预览。</div>
        </div>
      ) : null}

      {shown.map((art) => (
        <section key={art.id} className="mt-16" data-artifact-block={art.id}>
          <div className="tool-inline">
            <span className="dev-tag is-unknown" title={art.filename}>
              {art.filename}
            </span>
            <span className="text-sm text-muted">{art.prereq}</span>
            <span className="flex-1" />
            {art.ok ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-act="copy-run"
                  data-artifact={art.id}
                  title={`复制运行命令：${art.runCommand}`}
                  onClick={() => void copyCommand(art)}
                >
                  <Icons.terminal size={13} /> 复制运行命令
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  data-act="copy-artifact"
                  data-artifact={art.id}
                  title="复制这份产物的原文（不是高亮后的 HTML）"
                  onClick={() => void copyCode(art)}
                >
                  <Icons.copy size={13} /> 复制代码
                </button>
              </>
            ) : null}
          </div>

          {!art.ok ? (
            <div className="dev-banner is-error mt-8" role="alert">
              <Icons.bug size={14} />
              <div className="text-sm">生成失败：{art.error || '未知原因'}</div>
            </div>
          ) : (
            <>
              {art.warnings.length > 0 ? (
                <div className="dev-banner is-warn mt-8">
                  <Icons.clock size={14} />
                  <div className="text-sm">
                    {art.warnings.length} 条生成期告警：{art.warnings.join('；')}
                  </div>
                </div>
              ) : null}
              <ArtifactCode art={art} />
              <div className="text-sm text-muted mt-8">
                运行：<code>{art.runCommand}</code>
                {art.id === 'pom' ? '（POM 是骨架，由你的测试类 import；这条命令只验证它编得过）' : ''}
              </div>
            </>
          )}
        </section>
      ))}
    </div>
  );
}
