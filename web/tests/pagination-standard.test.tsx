/** @vitest-environment jsdom */
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_LIST_PAGE_SIZE,
  lastListPageOffset,
  listOffsetForPage,
  listPageCount,
  listPageNumber,
  listPageSize,
  normalizeListOffset,
} from '../src/ui/pagination';
import { ServoraListPagination } from '../src/ui/antd/ServoraPagination';
import { stubDesktopMatchMedia } from './antd-match-media';

stubDesktopMatchMedia();

describe('SERVORA-MED pagination standard v1', () => {
  it('defaults to six and rejects malformed, fractional, or unsafe offsets', () => {
    expect(DEFAULT_LIST_PAGE_SIZE).toBe(6);
    expect(listPageSize(0)).toBe(6);
    expect(listPageSize(6)).toBe(6);
    expect(normalizeListOffset(0)).toBe(0);
    expect(normalizeListOffset(5)).toBe(0);
    expect(normalizeListOffset(7)).toBe(6);
    expect(normalizeListOffset(50)).toBe(48);
    for (const value of [NaN, -1, 1.5, Infinity, 9007199254740992]) {
      expect(normalizeListOffset(value)).toBe(0);
    }
  });

  it('provides bounded last-page recovery and never creates an out-of-range page index', () => {
    expect(lastListPageOffset(0)).toBe(0);
    expect(lastListPageOffset(1)).toBe(0);
    expect(lastListPageOffset(6)).toBe(0);
    expect(lastListPageOffset(7)).toBe(6);
    expect(lastListPageOffset(13)).toBe(12);
    expect(listPageCount(13)).toBe(3);
    expect(listPageNumber(600, 13)).toBe(3);
    expect(listOffsetForPage(9, 13)).toBe(12);
    expect(listOffsetForPage(-1, 13)).toBe(0);
    expect(listOffsetForPage(2, 13)).toBe(6);
  });

  it('renders the Ant-controlled simple pager in Turkish without a page-size changer', () => {
    const html = renderToStaticMarkup(<ServoraListPagination
      total={13} offset={6} label="Müşteri sayfaları" itemName="müşteri" onOffsetChange={() => {}}
    />);
    expect(html).toContain('Müşteri sayfaları');
    expect(html).toContain('Sayfa 2 / 3');
    expect(html).toContain('Toplam 13 müşteri');
    expect(html).toContain('aria-label="Önceki sayfa"');
    expect(html).toContain('aria-label="Sonraki sayfa"');
    expect(html).not.toContain('pagination-options');
  });

  it('mounts and pages in jsdom, keeping arrow labels and offsets correct', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onOffsetChange = vi.fn();
    function Harness() {
      const [offset, setOffset] = useState(0);
      return <ServoraListPagination
        total={13} offset={offset} label="Müşteri sayfaları" itemName="müşteri"
        onOffsetChange={(next) => { setOffset(next); onOffsetChange(next); }}
      />;
    }
    try {
      await act(async () => root.render(<Harness />));
      const next = container.querySelector<HTMLElement>('[class*="pagination-next"]');
      const prev = container.querySelector<HTMLElement>('[class*="pagination-prev"]');
      expect(next).not.toBeNull();
      expect(prev).not.toBeNull();
      expect(next?.querySelector('button')?.getAttribute('aria-label')).toBe('Sonraki sayfa');
      expect(prev?.querySelector('button')?.getAttribute('aria-label')).toBe('Önceki sayfa');
      expect(next?.getAttribute('role')).toBe('button');
      expect(next?.tabIndex).toBe(0);
      expect(prev?.tabIndex).toBe(-1);
      await act(async () => {
        next!.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      });
      expect(onOffsetChange).toHaveBeenLastCalledWith(6);
      expect(container.textContent).toContain('Sayfa 2 / 3');
      const prevAfter = container.querySelector<HTMLElement>('[class*="pagination-prev"]');
      expect(prevAfter?.tabIndex).toBe(0);
      await act(async () => {
        prevAfter!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(onOffsetChange).toHaveBeenLastCalledWith(0);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('does not show unnecessary pager controls for empty or single-page lists', () => {
    expect(renderToStaticMarkup(<ServoraListPagination total={0} offset={0} label="Liste" itemName="kayıt" onOffsetChange={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<ServoraListPagination total={6} offset={0} label="Liste" itemName="kayıt" onOffsetChange={() => {}} />)).toBe('');
  });
});
