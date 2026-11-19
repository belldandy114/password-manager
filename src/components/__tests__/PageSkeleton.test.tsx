// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PageSkeleton } from '../PageSkeleton';

describe('PageSkeleton', () => {
  it('给出页头 / 概览卡 / 列表三块占位', () => {
    const { container } = render(<PageSkeleton />);
    expect(container.querySelector('.ps-head')).toBeTruthy();
    expect(container.querySelectorAll('.ps-card')).toHaveLength(3);
    expect(container.querySelectorAll('.ps-row')).toHaveLength(6);
  });

  it('对读屏只播报一次「页面加载中」，灰块本身是 aria-hidden', () => {
    const { container } = render(<PageSkeleton />);
    const root = container.querySelector('.page-skel');
    expect(root?.getAttribute('role')).toBe('status');
    expect(root?.getAttribute('aria-label')).toBe('页面加载中');
    // 结构层整体藏起来，避免把 20 多个灰块逐个念出来
    expect(container.querySelector('.pg')?.getAttribute('aria-hidden')).toBe('true');
  });
});
