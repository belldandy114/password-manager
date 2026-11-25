/**
 * 本机能力灯（S5 / W3-t23）：5 盏灯 × 四态 + 展开证据 + 面板级 `↻`。
 *
 * **只做展示**：探测在 `record:probe`（S3）、页面数据流在 `Recorder.tsx`（S4b）。
 * 本组件按 S4b 留在 `Recorder.tsx:68-76` 的 props 契约对接，一个字段都不多要
 * （`stubbed` 是**可选**的 J-9 桩标识，S4b 不传时按 `detail` 文本回退识别）。
 *
 * 六条写死的口径（都能被机械判定，依据 `docs/可行性-UI录制器/04-视觉方向.md` §3–§5）：
 *
 * 1. **灯号 ↘ id 的映射与顺序固定**：`1=chrome 2=node 3=jdk-jar 4=playwright 5=workspace`
 *    （`electron/record-probe.js:31` 的 `ABILITY_IDS`）。AC-14b 的「灯 1 红 → 开始录制禁用」
 *    指的是灯 1 = 浏览器；`Recorder.tsx:194` 也是按 `id === 'chrome'` 取的。
 *    顺序不能跟着 `abilities` 数组走 —— 主进程返回缺项时灯号会整体前移，5 盏灯就错位了。
 * 2. **锚点**：`.rec-lamp[data-lamp="1".."5"][data-state="green|yellow|red|grey"]`
 *    （`03-验收方案.md` §5.3 / §8 的 DOM 锚点表）。
 * 3. **字符前缀互异**：`.rec-lamp` 的 `textContent` 首字符必须是 `✓ / ⚠ / ✗ / —` 之一，
 *    四态**两两不同**（AC-14d / AC-18 就是读这个字符，灰度截图只作旁证）。
 *    ⚠️ 符号必须是 `.dev-tag` 的**第一个子节点**，且**不能写 `● ✓` 这种双字符前缀**
 *    —— 那会让四态的首字符都变成 `●`，AC-14d 直接判失败。`04-视觉方向.md` §3.1 表里的
 *    「`● ✓`」按本批验收口径落成「`✓`」（填充感由 `.dev-tag` 左侧 3px 语义条承担）。
 * 4. **不只靠颜色**：每一态同时有「字符 + `@tabler/icons-react` 图标 + 中文文案」三个通道；
 *    图标 `aria-hidden`，结论由可见文案承担（读屏不会读「绿色圆圈」）。
 * 5. **不做逐灯 `↻`**：5 盏灯必须是**同一时刻的快照**（`record:probe` 只有一个 `probedAt`，
 *    60 s 缓存也只有一个 key）。刷新只有面板头那一处，见 `04-视觉方向.md` §4.3。
 * 6. **灯 5「未选工程目录」是 `grey` 不是 `red`**（队长裁定 J-6）：这是主进程的口径
 *    （`record-probe.js:389`），本组件**不重新判**，只按后端给的 `state` 渲染；
 *    `abilities` 里缺这一块时同样落 `grey`（未探测），绝不兜底成 `red`。
 *
 * 视觉：类名全部落在 `04-视觉方向.md` §9.2 的映射表里 —— `.pnl` / `.pnl-head` / `.pnl-meta`
 * （玻璃已登记）、`.dev-tag` / `.dev-banner`（**刻意不登记**，透明底）、`pre.tb-pre`
 * （`--glass-input-soft`）、`.btn-secondary` / `.ibtn`（`--glass-control`）、
 * `.rec-lamp*` / `.rec-cmd` / `.rec-row`（本批新增，全部透明、不进玻璃登记表）。
 * **零新增 `--glass-*` token、零模糊/变形类属性（backdrop 四件套）、零优先级声明、零色值字面量。**
 * （同理不在源码里写出那个 6 字优先级指令：`check-debt-budget` 对全文件裸匹配，
 *   本仓已经有「注释里的字样把预算顶红」的先例，别在 tsx 里再埋一次。）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconAlertTriangle, IconCircleCheck, IconCircleX, IconHelpCircle, IconRefresh,
} from '@tabler/icons-react';

import { BusyProgress, Panel } from '../ui';
import { copyText } from '../toolbox/shell';
import type { RecordAbility } from '../../types';

/** 四态（后端 `record:probe` 的 `state` 四值，`record-probe.js:33`） */
export type AbilityState = RecordAbility['state'];

/**
 * 与 `Recorder.tsx:68-76` 的 `AbilityBarProps` **结构等价**（那边把 props 交给本组件，
 * 本组件多出一个可选的 `stubbed`；结构化类型下直接展开即可）。
 */
export interface AbilityBarProps {
  abilities: RecordAbility[];
  /** ISO 时间；`record:probe` 的 `probedAt`（60 s 缓存只有一个时间戳） */
  probedAt: string;
  /** `↻` 进行中：按钮 `disabled` + `aria-busy` + 进度条 */
  busy: boolean;
  /** 重新探测：`record:probe({ force: true })` */
  onReprobe: () => void;
  /** J-9 探针注入口生效时由调用方透传；不传则按 `detail` 里的「桩数据」回退识别 */
  stubbed?: boolean;
}

/**
 * 灯号 → `record:probe` 的 `id`。**顺序即灯 1..5**，不要改成按数组下标取。
 * `name` 是灯行标题（后端 `label` 更长，见 `record-probe.js:79-85` 的 `LABELS`，
 * 这里取短名是为了窄档一行放得下，后端 `label` 仍用于 `aria-label`）。
 */
const LAMPS: ReadonlyArray<{ no: number; id: RecordAbility['id']; name: string }> = [
  { no: 1, id: 'chrome', name: '浏览器' },
  { no: 2, id: 'node', name: 'Node.js' },
  { no: 3, id: 'jdk-jar', name: 'JDK + jar' },
  { no: 4, id: 'playwright', name: '@playwright/test' },
  { no: 5, id: 'workspace', name: '工程目录' },
];

/**
 * 四态视觉表：`glyph` 是 AC-14d 的判据字符（**互异且必须排第一个**），
 * `cls` 复用 `.dev-tag` 既有修饰（`redesign.css:8818-8832`），零新增选择器、零新增 token。
 */
const STATE_VIEW: Record<AbilityState, {
  glyph: string; text: string; cls: string; Icon: typeof IconCircleCheck;
}> = {
  green: { glyph: '✓', text: '可用', cls: 'is-ok', Icon: IconCircleCheck },
  yellow: { glyph: '⚠', text: '降级可用', cls: 'is-heur', Icon: IconAlertTriangle },
  red: { glyph: '✗', text: '不可用', cls: 'is-fail', Icon: IconCircleX },
  grey: { glyph: '—', text: '未探测', cls: 'is-unverified', Icon: IconHelpCircle },
};

/** 证据区最多展示的行数（`04-视觉方向.md` §4.2：超出的必须说清省略了多少行，不许静默截断） */
const MAX_OUT_LINES = 20;

/** 复制反馈持续时间 */
const COPIED_MS = 1600;

/** 灯 1 是否红（= 页面该把「开始录制」禁用）；S4b 可用它替代自己那段内联判断 */
export function recordBlocked(abilities: RecordAbility[]): boolean {
  const chrome = abilities.find((a) => a.id === 'chrome');
  return chrome?.state === 'red';
}

/** 按行裁剪证据输出：返回可见文本 + 省略行数 */
function clipOut(out: string): { text: string; omitted: number } {
  const lines = String(out || '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= MAX_OUT_LINES) return { text: lines.join('\n'), omitted: 0 };
  return { text: lines.slice(0, MAX_OUT_LINES).join('\n'), omitted: lines.length - MAX_OUT_LINES };
}

/** `probedAt` → 本地时间文案；空/非法一律「尚未探测」 */
function probedLabelOf(probedAt: string): string {
  if (!probedAt) return '尚未探测';
  const d = new Date(probedAt);
  if (Number.isNaN(d.getTime())) return '尚未探测';
  return `探测于 ${d.toLocaleTimeString('zh-CN', { hour12: false })}`;
}

export function AbilityBar({
  abilities, probedAt, busy, onReprobe, stubbed,
}: AbilityBarProps) {
  /** 展开的是哪一盏（单开：5 盏同时展开会把面板拉成一屏长文；展开的那盏独占一整行） */
  const [openNo, setOpenNo] = useState<number | null>(null);
  /** 刚复制过哪一条（`${no}:${kind}`），用于把按钮文案临时改成「已复制」 */
  const [copied, setCopied] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  const flash = useCallback((key: string) => {
    setCopied(key);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(''), COPIED_MS);
  }, []);

  const copy = useCallback(async (text: string, key: string) => {
    const ok = await copyText(text);
    flash(ok ? key : `${key}!`);
  }, [flash]);

  const byId = useMemo(() => {
    const map = new Map<string, RecordAbility>();
    abilities.forEach((a) => map.set(a.id, a));
    return map;
  }, [abilities]);

  const blocked = recordBlocked(abilities);
  /**
   * J-9：桩数据必须**在界面上显式标识**（否则「5 盏灯全绿」可能来自一份 JSON 文件）。
   * `record:probe` 生效时返回 `stubbed: true`，且每个 ability 的 `detail` 会带「桩数据」字样
   * （`record-probe.js:424-439`），两条通道任一条命中都算。
   */
  const isStub = stubbed === true || abilities.some((a) => String(a.detail || '').includes('桩数据'));

  const meta = (
    <>
      <span data-probed-at={probedAt || ''}>{probedLabelOf(probedAt)}</span>
      {blocked ? <span> · 灯 1 红：开始录制已禁用</span> : null}
      {isStub ? <span> · 桩数据</span> : null}
    </>
  );

  return (
    <Panel
      title="本机能力"
      meta={meta}
      tools={(
        <button
          type="button"
          className="ibtn"
          // AC-14c 的锚点：点它必须让 data-state 由红/黄转绿，且 probedAt 变大
          data-act="record-probe-refresh"
          disabled={busy}
          aria-busy={busy || undefined}
          title="重新探测本机能力（结果缓存 60 秒，点它强制重探）"
          aria-label="重新探测本机能力"
          onClick={onReprobe}
        >
          <IconRefresh size={14} aria-hidden="true" />
        </button>
      )}
    >
      {isStub ? (
        <div className="dev-banner is-warn" data-stub="1">
          <IconAlertTriangle size={14} aria-hidden="true" />
          <span>
            使用桩数据（PM_RECORD_PROBE_STUB）：这 5 盏灯不是真实探测结果，只用于构造反例。
          </span>
        </div>
      ) : null}

      <div className="rec-lamps" role="list" data-probed-at={probedAt || ''}>
        {LAMPS.map((lamp) => {
          const ability = byId.get(lamp.id);
          // 缺这块时落 grey（未探测）：**绝不**兜底成 red —— 那会把「没探到」说成「坏了」
          const state: AbilityState = ability?.state || 'grey';
          const view = STATE_VIEW[state];
          const open = openNo === lamp.no;
          const detail = ability?.detail || '尚未探测：点右上角 ↻ 重新探测';
          const fixHint = ability?.fixHint || '';
          const evidence = ability?.evidence || [];
          const evId = `rec-lamp-ev-${lamp.no}`;
          const fixKey = `${lamp.no}:fix`;

          return (
            <div
              key={lamp.id}
              className={`rec-lamp${open ? ' is-open' : ''}`}
              role="listitem"
              data-lamp={lamp.no}
              data-state={state}
            >
              <button
                type="button"
                className="rec-lamp-toggle"
                aria-expanded={open}
                aria-controls={evId}
                aria-label={`${lamp.name}：${view.text}。${detail}`}
                title={detail}
                onClick={() => setOpenNo(open ? null : lamp.no)}
              >
                {/* ⚠️ 字符必须是本行第一个文本节点（AC-14d 读 textContent[0]） */}
                <span className={`dev-tag ${view.cls}`}>
                  <span aria-hidden="true">{view.glyph}</span>
                  <view.Icon size={13} aria-hidden="true" />
                  {view.text}
                </span>
                <span className="rec-lamp-name">{lamp.name}</span>
                <span className="rec-lamp-detail">{detail}</span>
                <span className="rec-lamp-arrow" aria-hidden="true">{open ? '▾' : '▸'}</span>
              </button>

              {open ? (
                <div className="rec-lamp-ev" id={evId} role="region" aria-label={`${lamp.name} 的探测证据`}>
                  {ability?.label ? (
                    <div className="text-sm text-muted">{ability.label}</div>
                  ) : null}

                  {evidence.length === 0 ? (
                    <div className="text-sm text-muted">
                      没有探测证据：这一项还没被探测过（点右上角 ↻ 重新探测）。
                    </div>
                  ) : evidence.map((e, i) => {
                    const out = clipOut(e.out);
                    const cmdKey = `${lamp.no}:cmd:${i}`;
                    return (
                      <div key={cmdKey}>
                        <div className="rec-row">
                          <code className="rec-cmd" title={e.cmd}>{e.cmd}</code>
                          <button
                            type="button"
                            className="btn btn-sm btn-secondary"
                            data-act="record-lamp-copy-cmd"
                            onClick={() => { void copy(e.cmd, cmdKey); }}
                          >
                            {copied === cmdKey ? '已复制' : '复制命令'}
                          </button>
                        </div>
                        <pre className="tb-pre">{out.text || '（无输出）'}</pre>
                        {out.omitted > 0 ? (
                          <div className="text-sm text-muted">
                            已省略 {out.omitted} 行：复制命令重跑一次可以拿到完整输出。
                          </div>
                        ) : null}
                      </div>
                    );
                  })}

                  {/* 「怎么修」：后端给的 fixHint + 一个可带走的复制动作（不臆造下载链接） */}
                  <div className="dev-banner is-warn">
                    <IconAlertTriangle size={14} aria-hidden="true" />
                    <span>{fixHint || '这一项没有额外的修复提示；按上面的探测输出判断。'}</span>
                    <span className="dev-banner-act">
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        data-act="record-lamp-copy-fix"
                        onClick={() => {
                          const lines = [
                            `修复步骤（${lamp.name} · ${view.text}）`,
                            `1. ${fixHint || '按探测输出判断'}`,
                            `2. 修好后点「本机能力」右上角的 ↻ 重新探测（探测结果缓存 60 秒，点它会强制重探）`,
                            ...(evidence.length > 0 ? [`探测命令：${evidence[0].cmd}`] : []),
                          ];
                          void copy(lines.join('\n'), fixKey);
                        }}
                      >
                        {copied === fixKey ? '已复制' : '复制修复步骤'}
                      </button>
                    </span>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <BusyProgress active={busy} label="正在重新探测本机能力…" />
    </Panel>
  );
}

export default AbilityBar;
