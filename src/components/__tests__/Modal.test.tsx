// @vitest-environment jsdom
// 回归：Modal 打开期间父组件因输入重渲染时，焦点不能被抢走。
// 1.24.7 的真实 bug：onClose 是内联箭头，effect 每次渲染重建 → 每敲一个字焦点被拉回第一个按钮，
// 表现为「编辑笔记输入一下就跳出编辑、光标消失」。
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from '../Modal';

afterEach(() => cleanup());

function Harness() {
  const [value, setValue] = useState('');
  return (
    <Modal open onClose={() => {}} title="编辑">
      <input
        aria-label="标题"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    </Modal>
  );
}

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe('Modal', () => {
  it('输入触发父组件重渲染后，焦点仍在输入框', async () => {
    const { getByLabelText } = render(<Harness />);
    const input = getByLabelText('标题') as HTMLInputElement;
    // 等 Modal 挂载后的 raf 聚焦跑完：表单弹窗应直接聚焦第一个输入框
    await act(async () => { await nextFrame(); });
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'a' } });
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(document.activeElement).toBe(input);
  });
});
