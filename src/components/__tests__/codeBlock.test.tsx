// @vitest-environment jsdom
//
// CodeBlock 渲染测试（评审 C11 的缺口：tokenizer 有 27 条单测，但组件本身的行号 / 折叠横幅 /
// 展开·收起 / aria-expanded 全靠人工截图）。
//
// 规范照 src/components/__tests__/ui.test.tsx：jsdom + @testing-library/react，只断言 DOM 与文案，
// 不断言布局尺寸（jsdom 没有 layout，行号列宽对不对只能靠真窗口探针，见 t6 回执）。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import { CodeBlock } from '../ui';
import { HIGHLIGHT_FOLD_LINES } from '../../utils/codeHighlight';

// vitest 没开 globals（vite.config.ts 只设了 environment），RTL 的自动 cleanup 不会挂上，
// 不显式清就会跨用例累 DOM —— `getByRole` 会报「找到多个」（同 notesCopy.test.tsx 的处理）。
afterEach(cleanup);

/** 造 n 行代码（Java 方言，每行都有可上色的关键字，顺带覆盖 token 渲染） */
const javaLines = (n: number): string => Array.from({ length: n }, () => 'public void open() { }').join('\n');

describe('CodeBlock：行号', () => {
  it('每行一个 dev-code-line 容器，行号数等于行数、且从 1 连续编号', () => {
    const { container } = render(<CodeBlock code={javaLines(3)} lang="java" />);
    const lines = container.querySelectorAll('.dev-code-line');
    const nums = [...container.querySelectorAll('.dev-code-ln')].map((el) => el.textContent);
    expect(lines).toHaveLength(3);
    expect(nums).toEqual(['1', '2', '3']);
  });

  it('行容器是 span 不是 div（<pre> 的内容模型是 phrasing content）', () => {
    const { container } = render(<CodeBlock code={javaLines(2)} lang="java" />);
    const pre = container.querySelector('pre.dev-code');
    expect(pre).toBeTruthy();
    expect(pre?.className).toBe('tb-pre dev-code');
    // pre 里不能出现 div
    expect(pre?.querySelectorAll('div')).toHaveLength(0);
    // 代码块自带 .dev-scroll 包装（`.dev-scroll > .dev-code` 的 max-height:none 依赖这层直接父子）
    expect(pre?.parentElement?.className).toBe('dev-scroll');
  });

  it('showLineNumbers=false：行槽仍占位（每行仍有 dev-code-line，行号内容为空）', () => {
    const { container } = render(<CodeBlock code={javaLines(2)} lang="java" showLineNumbers={false} />);
    const lines = container.querySelectorAll('.dev-code-line');
    const nums = [...container.querySelectorAll('.dev-code-ln')];
    expect(lines).toHaveLength(2); // 左槽不能少：CSS 是固定 4ch 1fr 两列网格
    expect(nums).toHaveLength(2);
    expect(nums.map((el) => el.textContent)).toEqual(['', '']);
    expect(nums[0].getAttribute('aria-hidden')).toBe('true');
  });

  it('token 类名只来自契约那 7 个（这里是关键字），且渲染无内联 style', () => {
    const { container } = render(<CodeBlock code={'public class A { }'} lang="java" />);
    expect(container.querySelector('.dev-code .tok-kw')?.textContent).toBe('public');
    const styled = [...container.querySelectorAll('.dev-code, .dev-code-line, .dev-code-ln, .dev-code [class*="tok-"]')]
      .filter((el) => el.getAttribute('style'));
    expect(styled).toHaveLength(0);
  });
});

describe('CodeBlock：折叠 / 展开 / 收起', () => {
  it('未超阈值时不渲染折叠条', () => {
    const { container } = render(<CodeBlock code={javaLines(3)} lang="java" maxLines={3} />);
    expect(container.querySelector('.dev-banner')).toBeNull();
    expect(container.querySelectorAll('.dev-code-line')).toHaveLength(3);
  });

  it('超阈值时横幅写清「已显示前 N 行（共 M 行）」，只渲染 N 行，aria-expanded=false', () => {
    const { container } = render(<CodeBlock code={javaLines(5)} lang="java" maxLines={3} />);
    expect(container.querySelectorAll('.dev-code-line')).toHaveLength(3);
    const banner = container.querySelector('.dev-banner.is-info');
    expect(banner).toBeTruthy();
    expect(banner?.textContent).toContain('已显示前 3 行（共 5 行）');
    const btn = screen.getByRole('button', { name: '展开全部' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
  });

  it('点「展开全部」→ 行数变 M、文案变「已全部展开」、aria-expanded=true、按钮变「收起」', () => {
    const { container } = render(<CodeBlock code={javaLines(5)} lang="java" maxLines={3} />);
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    expect(container.querySelectorAll('.dev-code-line')).toHaveLength(5);
    expect(container.querySelector('.dev-banner.is-info')?.textContent).toContain('已全部展开（共 5 行）');
    const btn = screen.getByRole('button', { name: '收起' });
    expect(btn.getAttribute('aria-expanded')).toBe('true');
  });

  it('再点「收起」→ 回到 maxLines 行、横幅文案复原、aria-expanded=false（不是单向操作）', () => {
    const { container } = render(<CodeBlock code={javaLines(5)} lang="java" maxLines={3} />);
    fireEvent.click(screen.getByRole('button', { name: '展开全部' }));
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    expect(container.querySelectorAll('.dev-code-line')).toHaveLength(3);
    const banner = container.querySelector('.dev-banner.is-info');
    expect(banner?.textContent).toContain('已显示前 3 行（共 5 行）');
    expect(screen.getByRole('button', { name: '展开全部' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('默认阈值就是 HIGHLIGHT_FOLD_LINES：401 行输入渲染 400 行 + 提示「共 401 行」', () => {
    const { container } = render(<CodeBlock code={javaLines(HIGHLIGHT_FOLD_LINES + 1)} lang="java" />);
    expect(HIGHLIGHT_FOLD_LINES).toBe(400);
    expect(container.querySelectorAll('.dev-code-line')).toHaveLength(400);
    expect(container.querySelector('.dev-banner.is-info')?.textContent)
      .toContain(`已显示前 400 行（共 401 行）`);
  });
});

describe('CodeBlock：退化输入', () => {
  it('空内容不渲染任何行，也不渲染折叠条（不抛错）', () => {
    const { container } = render(<CodeBlock code="" lang="java" />);
    expect(container.querySelectorAll('.dev-code-line')).toHaveLength(0);
    expect(container.querySelector('.dev-banner')).toBeNull();
  });

  it('未知语言按纯文本渲染：行数正确、没有 tok-* 类名', () => {
    const { container } = render(<CodeBlock code={'a = 1\nb = 2'} lang="kotlin" />);
    expect(container.querySelectorAll('.dev-code-line')).toHaveLength(2);
    expect(container.querySelectorAll('.dev-code [class*="tok-"]')).toHaveLength(0);
  });
});