import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

/**
 * 工具箱外壳的共享能力：
 *
 * - `useToolState(key, initial)`：把工具输入存进 sessionStorage（按工具 id 分命名空间），
 *   切到别的页签再切回来，内容还在（A3）。
 * - `useToolResult(text)`：把「当前工具的主要结果」登记给外壳，外壳统一提供
 *   「复制结果 / 导出 txt」（A4）。工具不需要自己摆一组按钮。
 */

interface ToolShellCtx {
  toolId: string;
  setResult: (text: string) => void;
  /** 从别处跳进来时带过来的初始文本（接口调试 → 工具箱联动） */
  seed: string;
}

const Ctx = createContext<ToolShellCtx>({ toolId: 'toolbox', setResult: () => {}, seed: '' });

export function ToolShellProvider({
  toolId,
  onResult,
  seed,
  children,
}: {
  toolId: string;
  onResult: (text: string) => void;
  seed?: string;
  children: React.ReactNode;
}) {
  const value = React.useMemo<ToolShellCtx>(
    () => ({ toolId, setResult: onResult, seed: seed || '' }),
    [toolId, onResult, seed],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useToolShell() {
  return useContext(Ctx);
}

const NS = 'pm.toolbox.';

/** sessionStorage 持久化的工具状态 */
export function useToolState<T>(key: string, initial: T): [T, (v: T) => void] {
  const { toolId } = useToolShell();
  const storageKey = `${NS}${toolId}.${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch {
      /* ignore */
    }
    return initial;
  });

  const set = (v: T) => {
    setValue(v);
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(v));
    } catch {
      /* ignore */
    }
  };

  return [value, set];
}

/** 把结果交给外壳（自动去抖，避免每次按键都 setState） */
export function useToolResult(text: string) {
  const { setResult } = useToolShell();
  const lastRef = useRef<string>('');
  useEffect(() => {
    if (lastRef.current === text) return;
    lastRef.current = text;
    const t = setTimeout(() => setResult(text), 120);
    return () => clearTimeout(t);
  }, [text, setResult]);
}

/** 复制到剪贴板（带失败兜底：窗口未聚焦时 clipboard 会抛错） */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** 通用小节标题 */
export function ToolBlock({ title, children, extra }: { title?: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <section className="tb-block">
      {(title || extra) && (
        <header className="tb-block-head">
          <span className="tb-block-title">{title}</span>
          <span className="tb-block-spacer" />
          {extra}
        </header>
      )}
      {children}
    </section>
  );
}