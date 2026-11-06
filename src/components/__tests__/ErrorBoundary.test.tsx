// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

function Boom(): never {
  throw new Error('测试异常');
}

describe('ErrorBoundary', () => {
  it('子组件抛错时显示降级页而不是白屏', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText('页面出错了')).toBeTruthy();
    expect(screen.getByText('测试异常')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新加载' })).toBeTruthy();
    spy.mockRestore();
  });

  it('无异常时透传 children', () => {
    render(<ErrorBoundary><div>正常内容</div></ErrorBoundary>);
    expect(screen.getByText('正常内容')).toBeTruthy();
  });
});
