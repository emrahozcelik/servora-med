/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

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
    expect(html).not.toContain('pagination-options');
  });

  it('does not show unnecessary pager controls for empty or single-page lists', () => {
    expect(renderToStaticMarkup(<ServoraListPagination total={0} offset={0} label="Liste" itemName="kayıt" onOffsetChange={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<ServoraListPagination total={6} offset={0} label="Liste" itemName="kayıt" onOffsetChange={() => {}} />)).toBe('');
  });
});
