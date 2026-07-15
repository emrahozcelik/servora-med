import { describe, expect, it } from 'vitest';

import {
  canonicalJobSearchParams, enterBoard, forceMobileList, parseJobSearch, selectStatus,
  updateJobSearch,
} from '../src/jobs/job-search';

describe('canonical JobCard URL state', () => {
  it('resolves missing defaults without requiring default query keys', () => {
    expect(parseJobSearch(new URLSearchParams())).toEqual({ status: 'active', view: 'list', offset: 0 });
  });

  it('drops unknown, repeated, unsupported, malformed, and default values', () => {
    const parsed = parseJobSearch(new URLSearchParams(
      'unknown=x&q=%20%20&type=UNKNOWN&priority=critical&assignedTo=nope&customerId=nope&dueBefore=2026-02-30&status=active&status=closed&view=grid&offset=-1',
    ));
    expect(parsed).toEqual({ status: 'active', view: 'list', offset: 0 });
  });

  it('preserves a General Task filter through canonical deep-link parsing', () => {
    const params = new URLSearchParams('type=GENERAL_TASK&status=NEW&offset=25');

    expect(parseJobSearch(params)).toMatchObject({
      type: 'GENERAL_TASK', status: 'NEW', offset: 25,
    });
    expect(updateJobSearch(params, {}).toString()).toBe('status=NEW&type=GENERAL_TASK');
  });

  it('preserves a Sales Meeting deep link and resets offset when type changes', () => {
    const params = new URLSearchParams('type=SALES_MEETING&status=NEW&offset=25');
    expect(parseJobSearch(params)).toMatchObject({
      type: 'SALES_MEETING', status: 'NEW', offset: 25,
    });
    expect(updateJobSearch(new URLSearchParams('type=GENERAL_TASK&offset=50'), {
      type: 'SALES_MEETING',
    }).toString()).toBe('type=SALES_MEETING');
  });

  it('canonicalizes repeated Sales Meeting type parameters by dropping the scalar', () => {
    const params = new URLSearchParams('type=SALES_MEETING&type=GENERAL_TASK&offset=25');
    expect(parseJobSearch(params)).toEqual({ status: 'active', view: 'list', offset: 25 });
    expect(canonicalJobSearchParams(params).toString()).toBe('offset=25');
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

  it('resets offset when the JobCard type changes', () => {
    const current = new URLSearchParams('type=PRODUCT_DELIVERY&offset=50');
    expect(updateJobSearch(current, { type: 'GENERAL_TASK' }).toString())
      .toBe('type=GENERAL_TASK');
  });

  it('enters board by removing status/offset while retaining canonical non-status filters', () => {
    const next = enterBoard(new URLSearchParams('q=klinik&status=closed&priority=urgent&offset=50&unknown=x'));
    expect(next.toString()).toBe('q=klinik&priority=urgent&view=board');
  });

  it('selects a board status by explicitly forcing list and offset zero', () => {
    const next = selectStatus(new URLSearchParams('view=board&q=klinik&priority=urgent'), 'COMPLETED');
    expect(next.toString()).toBe('q=klinik&status=COMPLETED&priority=urgent&view=list&offset=0');
    expect(selectStatus(new URLSearchParams('status=closed&offset=75'), 'NEW').toString())
      .toBe('status=NEW&view=list&offset=0');
  });

  it('mobile force-list changes only view and desktop growth has no auto-restore helper', () => {
    const board = new URLSearchParams('q=klinik&view=board&priority=urgent');
    const mobile = forceMobileList(board);
    expect(mobile.toString()).toBe('q=klinik&priority=urgent&view=list');
    expect(forceMobileList(mobile).toString()).toBe(mobile.toString());
    expect(board.get('view')).toBe('board');
  });
});
