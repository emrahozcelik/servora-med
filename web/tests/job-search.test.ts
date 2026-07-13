import { describe, expect, it } from 'vitest';

import {
  enterBoard, forceMobileList, parseJobSearch, selectStatus, updateJobSearch,
} from '../src/jobs/job-search';

describe('canonical JobCard URL state', () => {
  it('resolves missing defaults without requiring default query keys', () => {
    expect(parseJobSearch(new URLSearchParams())).toEqual({ status: 'active', view: 'list', offset: 0 });
  });

  it('drops unknown, repeated, unsupported, malformed, and default values', () => {
    const parsed = parseJobSearch(new URLSearchParams(
      'unknown=x&q=%20%20&type=GENERAL_TASK&priority=critical&assignedTo=nope&customerId=nope&dueBefore=2026-02-30&status=active&status=closed&view=grid&offset=-1',
    ));
    expect(parsed).toEqual({ status: 'active', view: 'list', offset: 0 });
  });

  it('parses the exact supported filters and board omits status', () => {
    const uuidA = '11111111-1111-4111-8111-111111111111';
    const uuidB = '22222222-2222-4222-8222-222222222222';
    expect(parseJobSearch(new URLSearchParams(
      `q=%20klinik%20&status=closed&type=PRODUCT_DELIVERY&assignedTo=${uuidA}&customerId=${uuidB}&priority=urgent&dueAfter=2026-07-01&dueBefore=2026-07-31&view=list&offset=25`,
    ))).toEqual({ q: 'klinik', status: 'closed', type: 'PRODUCT_DELIVERY', assignedTo: uuidA,
      customerId: uuidB, priority: 'urgent', dueAfter: '2026-07-01', dueBefore: '2026-07-31',
      view: 'list', offset: 25 });
    expect(parseJobSearch(new URLSearchParams('view=board&status=COMPLETED&offset=50')))
      .toEqual({ view: 'board', offset: 0 });
  });

  it('resets offset when filters change and omits default values', () => {
    const current = new URLSearchParams('status=closed&view=list&offset=50&priority=urgent');
    expect(updateJobSearch(current, { priority: 'normal', status: 'active' }).toString())
      .toBe('priority=normal');
  });

  it('enters board by removing status/offset while retaining canonical non-status filters', () => {
    const next = enterBoard(new URLSearchParams('q=klinik&status=closed&priority=urgent&offset=50&unknown=x'));
    expect(next.toString()).toBe('q=klinik&priority=urgent&view=board');
  });

  it('selects a board status by explicitly forcing list and offset zero', () => {
    const next = selectStatus(new URLSearchParams('view=board&q=klinik&priority=urgent'), 'COMPLETED');
    expect(next.toString()).toBe('q=klinik&status=COMPLETED&priority=urgent&view=list&offset=0');
  });

  it('mobile force-list changes only view and desktop growth has no auto-restore helper', () => {
    const board = new URLSearchParams('q=klinik&view=board&priority=urgent');
    const mobile = forceMobileList(board);
    expect(mobile.toString()).toBe('q=klinik&priority=urgent&view=list');
    expect(forceMobileList(mobile).toString()).toBe(mobile.toString());
    expect(board.get('view')).toBe('board');
  });
});
