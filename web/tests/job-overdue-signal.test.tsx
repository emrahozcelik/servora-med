/** @vitest-environment jsdom */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { JobList, type JobListState } from '../src/jobs/JobList';
import type { JobCardListItem, LifecycleCommand, Paginated } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

const staff: CurrentUser = {
  id: '11111111-1111-4111-8111-111111111111', organizationId: 'org-1', name: 'Ayşe Personel',
  email: 'ayse@example.com', role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = { ...staff, id: '22222222-2222-4222-8222-222222222222', name: 'Murat Yönetici', role: 'MANAGER' };

/** An overdue row: due 2026-07-13, request instant 2026-07-14T12:00:00Z (Europe/Istanbul). */
const overdueItem: JobCardListItem = {
  id: 'job-overdue', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 3,
  engagementKind: null,
  title: 'ABC Klinik teslimi', priority: 'high', dueDate: '2026-07-13',
  scheduledAt: null,
  createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-14T11:00:00.000Z',
  staffCompletedAt: null, customer: { id: 'customer-1', name: 'ABC Klinik' },
  contact: null, assignee: { id: staff.id, name: staff.name }, deliveryItemCount: 0,
  allowedCommands: ['START', 'CANCEL'],
  overdueSince: '2026-07-13T21:00:00.000Z',
  latenessSeconds: 54_000,
};

function page(items: JobCardListItem[]): Paginated<JobCardListItem> {
  return { items, total: items.length, limit: 25, offset: 0 };
}

function renderList(state: JobListState, user = manager) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <JobList
        state={state}
        user={user}
        hasFilters={false}
        onRetry={() => {}}
        onOffsetChange={() => {}}
        onCommand={(_intent: { name: LifecycleCommand; jobId: string; expectedVersion: number }) => {}}
      />
    </MemoryRouter>,
  );
}

describe('OVR-1 overdue row signal', () => {
  it('renders the derived lateness magnitude on an overdue row', () => {
    const html = renderList({ kind: 'ready', page: page([overdueItem]) });
    expect(html).toContain('data-job-overdue-signal="true"');
    expect(html).toContain('15 saat gecikti');
  });

  it('renders the approved Turkish copy for different magnitudes', () => {
    const cases: Array<[number, string]> = [
      [2_520, '42 dakika gecikti'],
      [3_600, '1 saat gecikti'],
      [11_700, '3 saat 15 dakika gecikti'],
      [86_400, '1 gün gecikti'],
      [273_600, '3 gün 4 saat gecikti'],
      [1_119_600, '12 gün 23 saat gecikti'],
      [42, '1 dakikadan az gecikti'],
    ];
    for (const [latenessSeconds, expected] of cases) {
      const html = renderList({
        kind: 'ready',
        page: page([{ ...overdueItem, latenessSeconds }]),
      });
      expect(html).toContain(expected);
    }
  });

  it('never signals lateness on a surface that does not evaluate it', () => {
    const { overdueSince: _since, latenessSeconds: _lateness, ...withoutSnapshot } = overdueItem;
    const html = renderList({ kind: 'ready', page: page([withoutSnapshot]) });
    expect(html).not.toContain('data-job-overdue-signal');
    expect(html).not.toContain('gecikti');
  });

  it('does not signal at the exact first instant of lateness', () => {
    const html = renderList({
      kind: 'ready',
      page: page([{ ...overdueItem, latenessSeconds: 0 }]),
    });
    expect(html).not.toContain('data-job-overdue-signal');
    expect(html).not.toContain('gecikti');
  });

  it('never invents a historical badge for terminal work', () => {
    for (const status of ['COMPLETED', 'CANCELLED', 'INVALIDATED'] as const) {
      const html = renderList({
        kind: 'ready',
        page: page([{ ...overdueItem, status, latenessSeconds: undefined, overdueSince: undefined }]),
      });
      expect(html).not.toContain('data-job-overdue-signal');
      expect(html).not.toContain('gecikti');
    }
  });

  it('preserves the existing status and priority signals alongside the lateness signal', () => {
    const html = renderList({ kind: 'ready', page: page([overdueItem]) });
    expect(html).toContain('data-job-row-signals="true"');
    expect(html).toContain('status-chip');
    expect(html).toContain('priority-chip');
  });

  it('shows the signal to a Staff member viewing their own overdue job', () => {
    const html = renderList({ kind: 'ready', page: page([overdueItem]) }, staff);
    expect(html).toContain('15 saat gecikti');
  });
});
