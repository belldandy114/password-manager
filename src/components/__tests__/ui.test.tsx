// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchBox, Empty, Pill, BusyProgress } from '../ui';

describe('SearchBox', () => {
  it('输入触发 onChange，受控值可更新', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchBox value="" onChange={onChange} placeholder="搜点什么" />);
    const input = screen.getByPlaceholderText('搜点什么') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc' } });
    expect(onChange).toHaveBeenCalledWith('abc');
    rerender(<SearchBox value="abc" onChange={onChange} placeholder="搜点什么" />);
    expect(input.value).toBe('abc');
  });

  it('始终带放大镜图标容器', () => {
    const { container } = render(<SearchBox value="" onChange={() => {}} />);
    expect(container.querySelector('.search-ico')).toBeTruthy();
  });
});

describe('Empty', () => {
  it('渲染标题、描述与下一步引导', () => {
    render(<Empty title="还没有数据" desc="先添加一条" hint={<>按 <kbd>Ctrl+K</kbd> 搜索</>} />);
    expect(screen.getByText('还没有数据')).toBeTruthy();
    expect(screen.getByText('先添加一条')).toBeTruthy();
    expect(screen.getByText('Ctrl+K')).toBeTruthy();
  });
});

describe('Pill 与 BusyProgress', () => {
  it('Pill 应用 tone 类名', () => {
    const { container } = render(<Pill tone="info">共 3 条</Pill>);
    expect(container.querySelector('.pill-info')?.textContent).toContain('共 3 条');
  });

  it('BusyProgress 非激活时不渲染，激活时显示状态文字', () => {
    const { container, rerender } = render(<BusyProgress active={false} label="加载中" />);
    expect(container.querySelector('.busy-progress')).toBeNull();
    rerender(<BusyProgress active label="加载中" />);
    expect(screen.getByText('加载中')).toBeTruthy();
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });
});
