import { describe, expect, it, vi } from 'vitest';

import { getJobCardBoard, listJobCards, type JobCardBoardFilters } from '../src/jobs/jobs-api';
import {
  applyJobFilterChanges, applyStatusFilter, boardLaneStatus, canonicalJobSearchParams, enterBoard,
  followUpJobsSearch, jobMembership, listJobsByStatus, overdueJobsSearch, parseJobSearch,
  selectListMode, statusQuickSearch, supportsBoard,
  type JobViewMode,
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
    expect(applyJobFilterChanges(params, {}, 'list').toString()).toBe('status=NEW&type=GENERAL_TASK');
  });

  it('preserves a Sales Meeting deep link and resets offset when type changes', () => {
    const params = new URLSearchParams('type=SALES_MEETING&status=NEW&offset=25');
    expect(parseJobSearch(params)).toMatchObject({
      type: 'SALES_MEETING', status: 'NEW', offset: 25,
    });
    expect(applyJobFilterChanges(new URLSearchParams('type=GENERAL_TASK&offset=50'), {
      type: 'SALES_MEETING',
    }, 'list').toString()).toBe('type=SALES_MEETING');
  });

  it('canonicalizes repeated Sales Meeting type parameters by dropping the scalar', () => {
    const params = new URLSearchParams('type=SALES_MEETING&type=GENERAL_TASK&offset=25');
    expect(parseJobSearch(params)).toEqual({ status: 'active', view: 'list', offset: 25 });
    expect(canonicalJobSearchParams(params).toString()).toBe('offset=25');
  });

  it('parses the exact supported filters and keeps terminal membership list-only', () => {
    const uuidA = '11111111-1111-4111-8111-111111111111';
    const uuidB = '22222222-2222-4222-8222-222222222222';
    expect(parseJobSearch(new URLSearchParams(
      `q=%20klinik%20&status=closed&type=PRODUCT_DELIVERY&assignedTo=${uuidA}&customerId=${uuidB}&priority=urgent&dueAfter=2026-07-01&dueBefore=2026-07-31&view=list&offset=25`,
    ))).toEqual({ q: 'klinik', status: 'closed', type: 'PRODUCT_DELIVERY', assignedTo: uuidA,
      customerId: uuidB, priority: 'urgent', dueAfter: '2026-07-01', dueBefore: '2026-07-31',
      view: 'list', offset: 25 });
    expect(parseJobSearch(new URLSearchParams('view=board&status=COMPLETED&offset=50')))
      .toEqual({ status: 'COMPLETED', view: 'list', offset: 50 });
  });

  it('represents an active-status membership with its matching board lane', () => {
    const parsed = parseJobSearch(new URLSearchParams('view=board&status=WAITING_APPROVAL'));
    expect(parsed).toEqual({ status: 'WAITING_APPROVAL', view: 'board', offset: 0 });
    expect(boardLaneStatus(parsed)).toBe('WAITING_APPROVAL');
    expect(canonicalJobSearchParams(new URLSearchParams('view=board&status=WAITING_APPROVAL')).toString())
      .toBe('status=WAITING_APPROVAL&view=board');
  });

  it('canonicalizes the closed aggregate to list view even when the URL requests board', () => {
    const params = new URLSearchParams('view=board&status=closed');

    expect(parseJobSearch(params)).toEqual({ status: 'closed', view: 'list', offset: 0 });
    expect(canonicalJobSearchParams(params).toString()).toBe('status=closed');
  });

  it('keeps the explicit invalidated filter in list mode and preserves the Tümü aggregate', () => {
    const params = new URLSearchParams('view=board&status=INVALIDATED&offset=50');
    expect(parseJobSearch(params)).toEqual({ status: 'INVALIDATED', view: 'list', offset: 50 });
    expect(canonicalJobSearchParams(params).toString()).toBe('status=INVALIDATED&offset=50');
    expect(parseJobSearch(new URLSearchParams('status=all'))).toEqual({
      status: 'all', view: 'list', offset: 0,
    });
  });

  it('resets offset when filters change and omits default values', () => {
    const current = new URLSearchParams('status=closed&view=list&offset=50&priority=urgent');
    expect(applyJobFilterChanges(current, { priority: 'normal', status: 'active' }, 'list').toString())
      .toBe('priority=normal');
  });

  it('resets offset when the JobCard type changes', () => {
    const current = new URLSearchParams('type=PRODUCT_DELIVERY&offset=50');
    expect(applyJobFilterChanges(current, { type: 'GENERAL_TASK' }, 'list').toString())
      .toBe('type=GENERAL_TASK');
  });

  it('enters board preserving membership and refuses board on list-only memberships', () => {
    expect(enterBoard(new URLSearchParams('q=klinik&priority=urgent&offset=50')).toString())
      .toBe('q=klinik&priority=urgent&view=board');
    expect(enterBoard(new URLSearchParams('q=klinik&followUp=only')).toString())
      .toBe('q=klinik&followUp=only&view=board');
    // Biten (closed aggregate) is list-only: the board is not offered and the
    // membership survives instead of silently sliding to the active board.
    expect(enterBoard(new URLSearchParams('status=closed')).toString()).toBe('status=closed');
  });

  it('selects a status with canonical defaults, reset pagination and view preservation', () => {
    // Terminal status is list-only.
    expect(applyStatusFilter(new URLSearchParams('view=board&q=klinik&priority=urgent'), 'COMPLETED', 'list').toString())
      .toBe('q=klinik&status=COMPLETED&priority=urgent');
    expect(applyStatusFilter(new URLSearchParams('status=closed&offset=75'), 'NEW', 'list').toString())
      .toBe('status=NEW');
    // Aktif is board-capable: returning to it from the board keeps the board.
    expect(applyStatusFilter(new URLSearchParams('view=board'), 'active', 'list').toString())
      .toBe('view=board');
    expect(applyStatusFilter(new URLSearchParams(), 'active', 'board').toString()).toBe('view=board');
  });

  it('explicit list selection changes only the mode and keeps the membership', () => {
    const board = new URLSearchParams('q=klinik&view=board&priority=urgent');
    const list = selectListMode(board);
    expect(list.toString()).toBe('q=klinik&priority=urgent');
    expect(parseJobSearch(list).view).toBe('list');
    expect(board.get('view')).toBe('board');
    expect(selectListMode(list).toString()).toBe(list.toString());
  });

  it('builds the canonical overdue query with server-owned overdue=true', () => {
    const params = new URLSearchParams(
      'q=klinik&status=WAITING_APPROVAL&dueBefore=2026-07-31&dueAfter=2026-07-01&offset=25',
    );
    expect(overdueJobsSearch(params).toString()).toBe('q=klinik&overdue=true');
    // No browser clock or timezone input can change the result.
    expect(overdueJobsSearch(new URLSearchParams()).toString()).toBe('overdue=true');
  });

  it('parses overdue=true state and drops malformed values', () => {
    expect(parseJobSearch(new URLSearchParams('overdue=true'))).toEqual({
      overdue: true, status: 'active', view: 'list', offset: 0,
    });
    expect(parseJobSearch(new URLSearchParams('overdue=false'))).toEqual({
      status: 'active', view: 'list', offset: 0,
    });
    expect(canonicalJobSearchParams(new URLSearchParams('overdue=false')).toString()).toBe('');
    expect(canonicalJobSearchParams(new URLSearchParams('overdue=true')).toString())
      .toBe('overdue=true');
  });

  it('selecting a status drops overdue and status quick searches clear date ranges', () => {
    const overdue = new URLSearchParams('q=klinik&overdue=true&offset=25');
    expect(applyStatusFilter(overdue, 'WAITING_APPROVAL', 'list').toString())
      .toBe('q=klinik&status=WAITING_APPROVAL');
    expect(statusQuickSearch(overdue, 'active', 'list').toString()).toBe('q=klinik');
    expect(statusQuickSearch(overdue, 'closed', 'list').toString()).toBe('q=klinik&status=closed');
  });

  it('applies narrowing filters within the overdue membership (P1: no silent exit)', () => {
    const overdue = new URLSearchParams('overdue=true&offset=25');
    expect(applyJobFilterChanges(overdue, { q: 'klinik' }, 'list').toString())
      .toBe('q=klinik&overdue=true');
    expect(applyJobFilterChanges(overdue, { priority: 'high' }, 'list').toString())
      .toBe('priority=high&overdue=true');
    const assignedTo = '11111111-1111-4111-8111-111111111111';
    const customerId = '22222222-2222-4222-8222-222222222222';
    expect(applyJobFilterChanges(overdue, {
      type: 'GENERAL_TASK', assignedTo, customerId, dueAfter: '2026-09-01',
    }, 'list').toString()).toBe(
      `type=GENERAL_TASK&assignedTo=${assignedTo}&customerId=${customerId}&overdue=true`,
    );
    // Pagination resets on apply, but the membership (and its list view) stays.
    expect(parseJobSearch(applyJobFilterChanges(overdue, { q: 'implant' }, 'list'))).toMatchObject({
      overdue: true, view: 'list', offset: 0,
    });
  });

  it('canonicalizes overdue to a list-only active query without date bounds', () => {
    const params = new URLSearchParams(
      'overdue=true&view=board&status=closed&dueBefore=2026-08-01&dueAfter=2026-07-01',
    );
    expect(parseJobSearch(params)).toEqual({ overdue: true, status: 'active', view: 'list', offset: 0 });
    expect(canonicalJobSearchParams(params).toString()).toBe('overdue=true');
  });

  it('preserves pagination for the overdue query', () => {
    expect(parseJobSearch(new URLSearchParams('overdue=true&offset=25')))
      .toEqual({ overdue: true, status: 'active', view: 'list', offset: 25 });
    expect(canonicalJobSearchParams(new URLSearchParams('overdue=true&offset=25')).toString())
      .toBe('overdue=true&offset=25');
  });

  it('keeps the overdue membership when board is requested (list-only)', () => {
    expect(enterBoard(new URLSearchParams('q=klinik&overdue=true&offset=25')).toString())
      .toBe('q=klinik&overdue=true');
  });

  it('leaves the board for a plain status list (lane and closed-count links)', () => {
    expect(listJobsByStatus(new URLSearchParams('view=board&q=klinik'), 'IN_PROGRESS').toString())
      .toBe('q=klinik&status=IN_PROGRESS');
    expect(listJobsByStatus(new URLSearchParams('view=board'), 'COMPLETED').toString())
      .toBe('status=COMPLETED');
    expect(listJobsByStatus(new URLSearchParams('view=board&overdue=true'), 'COMPLETED').toString())
      .toBe('status=COMPLETED');
  });
});

describe('JobCard API filter contract', () => {
  it('accepts and serializes overdue=true on listJobCards', async () => {
    let captured = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      captured = String(url);
      return new Response(JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }), { status: 200 });
    }));
    try {
      const page = await listJobCards({ overdue: true });
      expect(page).toEqual({ items: [], total: 0, limit: 25, offset: 0 });
      expect(captured).toBe('/api/job-cards?overdue=true');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cannot represent overdue on board filters', () => {
    const board: JobCardBoardFilters = {};
    // @ts-expect-error overdue is list-only and not representable on board filters
    const invalid: JobCardBoardFilters = { overdue: true };
    void invalid;
    expect(board).toEqual({});
  });

  it('serializes followUp=only on list and board transports', async () => {
    const urls: string[] = [];
    const column = { items: [], count: 0 };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify(
        url.includes('/board')
          ? {
              columns: {
                NEW: column, ACCEPTED: column, IN_PROGRESS: column,
                WAITING_APPROVAL: column, REVISION_REQUESTED: column,
              },
              closedCounts: { COMPLETED: 0, CANCELLED: 0 },
            }
          : { items: [], total: 0, limit: 25, offset: 0 },
      ), { status: 200 });
    }));
    try {
      await listJobCards({ followUp: 'only' });
      await getJobCardBoard({ followUp: 'only' });
      expect(urls).toEqual(['/api/job-cards?followUp=only', '/api/job-cards/board?followUp=only']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('follow-up workspace query state', () => {
  it('parses followUp=only and drops malformed values', () => {
    expect(parseJobSearch(new URLSearchParams('followUp=only'))).toMatchObject({ followUp: 'only' });
    for (const value of ['true', 'false', 'exclude', '1', 'ONLY', '']) {
      expect(parseJobSearch(new URLSearchParams(`followUp=${value}`))).not.toHaveProperty('followUp');
      expect(canonicalJobSearchParams(new URLSearchParams(`followUp=${value}`)).toString()).toBe('');
    }
    expect(parseJobSearch(new URLSearchParams('followUp=only&followUp=only')))
      .not.toHaveProperty('followUp');
  });

  it('serializes followUp=only canonically and preserves pagination and board', () => {
    expect(canonicalJobSearchParams(new URLSearchParams('followUp=only')).toString())
      .toBe('followUp=only');
    expect(canonicalJobSearchParams(new URLSearchParams('followUp=only&offset=25')).toString())
      .toBe('followUp=only&offset=25');
    expect(enterBoard(new URLSearchParams('q=klinik&followUp=only')).toString())
      .toBe('q=klinik&followUp=only&view=board');
    expect(parseJobSearch(new URLSearchParams('followUp=only&view=board')))
      .toMatchObject({ followUp: 'only', view: 'board' });
  });

  it('builds the Takip işleri quick view from a clean state and preserves narrowing filters', () => {
    expect(followUpJobsSearch(new URLSearchParams(), 'list').toString()).toBe('followUp=only');
    expect(followUpJobsSearch(new URLSearchParams('q=klinik&type=GENERAL_TASK&priority=high'), 'list').toString())
      .toBe('q=klinik&type=GENERAL_TASK&priority=high&followUp=only');
    // From the board the membership transition keeps the board (Takip is board-capable).
    expect(followUpJobsSearch(new URLSearchParams(
      'q=klinik&status=WAITING_APPROVAL&view=board&offset=25&dueBefore=2026-07-31&dueAfter=2026-07-01',
    ), 'list').toString()).toBe('q=klinik&followUp=only&view=board');
    expect(followUpJobsSearch(new URLSearchParams('view=board&q=klinik'), 'list').toString())
      .toBe('q=klinik&followUp=only&view=board');
    expect(followUpJobsSearch(new URLSearchParams('view=board&q=klinik'), 'board').toString())
      .toBe('q=klinik&followUp=only&view=board');
  });

  it('clears followUp when entering named quick views but composes with filter status changes', () => {
    expect(statusQuickSearch(new URLSearchParams('q=klinik&followUp=only'), 'active', 'list').toString())
      .toBe('q=klinik');
    expect(statusQuickSearch(new URLSearchParams('followUp=only'), 'closed', 'list').toString())
      .toBe('status=closed');
    expect(overdueJobsSearch(new URLSearchParams('q=klinik&followUp=only')).toString())
      .toBe('q=klinik&overdue=true');
    // Status narrows within Takip rather than silently exiting its membership.
    expect(applyStatusFilter(new URLSearchParams('followUp=only'), 'closed', 'list').toString())
      .toBe('status=closed&followUp=only');
  });

  it('preserves followUp on filter changes and removes it on reset', () => {
    expect(applyJobFilterChanges(new URLSearchParams('followUp=only'), { q: 'klinik' }, 'list').toString())
      .toBe('q=klinik&followUp=only');
    expect(applyJobFilterChanges(
      new URLSearchParams('q=klinik&followUp=only'), { followUp: undefined }, 'list',
    ).toString()).toBe('q=klinik');
  });
});

describe('membership / view-mode transition matrix (Jobs control surface)', () => {
  it('Board → Geciken coerces to list and keeps the URL truthful', () => {
    const board = new URLSearchParams('view=board&q=klinik');
    expect(overdueJobsSearch(board).toString()).toBe('q=klinik&overdue=true');
    expect(parseJobSearch(overdueJobsSearch(board)).view).toBe('list');
  });

  it('Geciken → Aktif restores the board preference when one exists', () => {
    const overdue = new URLSearchParams('overdue=true');
    expect(statusQuickSearch(overdue, 'active', 'board').toString()).toBe('view=board');
    expect(statusQuickSearch(overdue, 'active', 'list').toString()).toBe('');
  });

  it('Board → Biten coerces to list; Biten → Aktif restores the board preference', () => {
    const board = new URLSearchParams('view=board&q=klinik');
    expect(statusQuickSearch(board, 'closed', 'board').toString()).toBe('q=klinik&status=closed');
    expect(statusQuickSearch(new URLSearchParams('status=closed'), 'active', 'board').toString())
      .toBe('view=board');
    expect(statusQuickSearch(new URLSearchParams('status=closed'), 'active', 'list').toString())
      .toBe('');
  });

  it('Board → Takip → Onay → Düzeltme preserves board and truthful membership', () => {
    const board = new URLSearchParams('view=board&q=klinik');
    expect(followUpJobsSearch(board, 'board').toString()).toBe('q=klinik&followUp=only&view=board');
    expect(statusQuickSearch(board, 'WAITING_APPROVAL', 'board').toString())
      .toBe('q=klinik&status=WAITING_APPROVAL&view=board');
    expect(statusQuickSearch(
      new URLSearchParams('q=klinik&status=WAITING_APPROVAL'), 'REVISION_REQUESTED', 'board',
    ).toString()).toBe('q=klinik&status=REVISION_REQUESTED&view=board');
  });

  it('narrowing never changes the effective mode on a board-capable membership', () => {
    expect(applyJobFilterChanges(new URLSearchParams('status=active'), { q: 'klinik' }, 'list').toString())
      .toBe('q=klinik');
    expect(applyJobFilterChanges(new URLSearchParams('view=board'), { q: 'klinik' }, 'board').toString())
      .toBe('q=klinik&view=board');
    // Date bounds keep the Aktif membership current without exiting its view.
    expect(applyJobFilterChanges(
      new URLSearchParams('dueBefore=2026-07-31'), { type: 'GENERAL_TASK' }, 'list',
    ).toString()).toBe('type=GENERAL_TASK&dueBefore=2026-07-31');
  });

  it('exposes membership and board eligibility for the control surface', () => {
    expect(jobMembership(parseJobSearch(new URLSearchParams('overdue=true')))).toEqual({ kind: 'overdue' });
    expect(jobMembership(parseJobSearch(new URLSearchParams('followUp=only')))).toEqual({ kind: 'followUp' });
    expect(jobMembership(parseJobSearch(new URLSearchParams('status=closed'))))
      .toEqual({ kind: 'closed' });
    expect(jobMembership(parseJobSearch(new URLSearchParams('status=NEW'))))
      .toEqual({ kind: 'active' });
    expect(supportsBoard(parseJobSearch(new URLSearchParams('followUp=only')))).toBe(true);
    expect(supportsBoard(parseJobSearch(new URLSearchParams()))).toBe(true);
    expect(supportsBoard(parseJobSearch(new URLSearchParams('status=closed')))).toBe(false);
    expect(supportsBoard(parseJobSearch(new URLSearchParams('overdue=true')))).toBe(false);
    expect(supportsBoard(parseJobSearch(new URLSearchParams('status=WAITING_APPROVAL')))).toBe(true);
  });

  it('filter sheet clear returns to the canonical Aktif membership', () => {
    const current = new URLSearchParams('overdue=true&q=klinik&status=closed&priority=high');
    const cleared = applyJobFilterChanges(current, {
      q: undefined, type: undefined, assignedTo: undefined, customerId: undefined,
      priority: undefined, dueAfter: undefined, dueBefore: undefined, followUp: undefined,
      overdue: undefined,
      status: 'active',
    }, 'list');
    expect(cleared.toString()).toBe('');
  });
});
