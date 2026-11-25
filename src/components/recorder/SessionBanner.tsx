/**
 * 录制会话条 —— 现在有没有在录、录了几步、什么时候开始、有没有被截断。
 *
 * 三处「不许静默」的落点（契约 `[C-09]`）：
 * 1. **事件到顶**（单会话 5000）：必须显式说「后续动作未记录」，不许只在返回值里躺一个 `truncated`；
 * 2. **丢弃计数**（`dropped`）：主进程洗载荷时丢掉的条数，界面要给出来；
 * 3. **会话已结束**（锁定 / 关窗 / 别人 stop 过）：说清「是它自己结束的」，别让用户以为还能继续录。
 *
 * 视觉：`.dev-banner` 的三个现成修饰（`is-info` / `is-warn` / `is-error`）+ `.dev-banner-act`，
 * 零新增样式；时间用 `toLocaleTimeString`（本地时间，和用户看时钟的方式一致）。
 */

interface Props {
  sessionId: string;
  startedAt: string;
  stepCount: number;
  browser?: string;
  port?: number;
  ended?: boolean;
  truncated?: boolean;
  dropped?: number;
}

function clockOf(iso: string): string {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleTimeString('zh-CN', { hour12: false });
}

export function SessionBanner({
  sessionId, startedAt, stepCount, browser, port, ended, truncated, dropped,
}: Props) {
  const clock = clockOf(startedAt);
  // 截断优先于「已结束」：截断是**数据缺失**，用户必须知道最终报告少了几步
  const tone = truncated ? 'is-error' : ended ? 'is-info' : 'is-warn';
  const state = ended ? '录制已结束' : '录制中';

  return (
    <div className={`dev-banner ${tone}`} data-session-id={sessionId}>
      <span aria-hidden="true">{truncated ? '✗' : ended ? '○' : '●'}</span>
      <span>
        <b>{state}</b>
        {` · 已录 ${stepCount} 步`}
        {clock ? ` · ${clock} 开始` : ''}
        {browser ? ` · ${browser}` : ''}
        {port ? ` · 调试端口 ${port}（仅 127.0.0.1）` : ''}
      </span>
      {truncated ? (
        <span className="dev-banner-act">
          <span className="dev-tag is-fail">
            <span aria-hidden="true">✗</span>
            {`事件已达上限，后续动作未记录${typeof dropped === 'number' && dropped > 0 ? `（丢弃 ${dropped} 条）` : ''}`}
          </span>
        </span>
      ) : null}
      {!truncated && typeof dropped === 'number' && dropped > 0 ? (
        <span className="dev-banner-act">
          <span className="dev-tag is-heur">
            <span aria-hidden="true">⚠</span>
            {`有 ${dropped} 条事件因不合规被丢弃`}
          </span>
        </span>
      ) : null}
    </div>
  );
}
