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

/** An open LATE_SUBMISSION obligation: breached 07:30, 8 040 s (2 sa 14 dk) elapsed. */
const breachedAt = '2026-07-13T07:30:00.000Z';
const delayedItem: JobCardListItem = {
  id: 'job-delay', type: 'GENERAL_TASK', status: 'IN_PROGRESS', version: 3,
  engagementKind: null,
  title: 'Klinik kurulum', priority: 'high', dueDate: null, scheduledAt: null,
  createdAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-13T10:00:00.000Z',
  staffCompletedAt: null, customer: { id: 'customer-1', name: 'ABC Klinik' },
  contact: null, assignee: { id: staff.id, name: staff.name }, deliveryItemCount: 0,
  allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
  submissionDelay: { breachedAt, elapsedSeconds: 8_040 },
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

describe('OVR-4 submission-delay row signal', () => {
  it('renders the server-measured magnitude for an open submission obligation', () => {
    const html = renderList({ kind: 'ready', page: page([delayedItem]) });
    expect(html).toContain('data-job-submission-delay-signal="true"');
    expect(html).toContain('Onaya gönderme gecikti · 2 saat 14 dakika');
  });

  it('renders the approved Turkish magnitudes through the shared duration vocabulary', () => {
    const cases: Array<[number, string]> = [
      [30, 'Onaya gönderme gecikti · 1 dakikadan az'],
      [60, 'Onaya gönderme gecikti · 1 dakika'],
      [3_600, 'Onaya gönderme gecikti · 1 saat'],
      [11_700, 'Onaya gönderme gecikti · 3 saat 15 dakika'],
      [86_400, 'Onaya gönderme gecikti · 1 gün'],
      [273_600, 'Onaya gönderme gecikti · 3 gün 4 saat'],
    ];
    for (const [elapsedSeconds, expected] of cases) {
      const html = renderList({
        kind: 'ready',
        page: page([{ ...delayedItem, submissionDelay: { breachedAt, elapsedSeconds } }]),
      });
      expect(html).toContain(expected);
    }
  });

  it('never signals on a surface that does not evaluate submission delays', () => {
    const { submissionDelay: _delay, ...withoutSnapshot } = delayedItem;
    const html = renderList({ kind: 'ready', page: page([withoutSnapshot]) });
    expect(html).not.toContain('data-job-submission-delay-signal');
    expect(html).not.toContain('Onaya gönderme gecikti');
  });

  it('does not signal when the server reports no open delay', () => {
    const html = renderList({
      kind: 'ready',
      page: page([{ ...delayedItem, submissionDelay: null }]),
    });
    expect(html).not.toContain('data-job-submission-delay-signal');
    expect(html).not.toContain('Onaya gönderme gecikti');
  });

  it('stays orthogonal to the due-date lateness signal instead of replacing it', () => {
    const html = renderList({
      kind: 'ready',
      page: page([{
        ...delayedItem,
        dueDate: '2026-07-12',
        overdueSince: '2026-07-12T21:00:00.000Z',
        latenessSeconds: 54_000,
      }]),
    });
    expect(html).toContain('data-job-overdue-signal="true"');
    expect(html).toContain('15 saat gecikti');
    expect(html).toContain('data-job-submission-delay-signal="true"');
    expect(html).toContain('Onaya gönderme gecikti · 2 saat 14 dakika');
  });

  it('shows the signal to the Staff member who owes the submission', () => {
    const html = renderList({ kind: 'ready', page: page([delayedItem]) }, staff);
    expect(html).toContain('Onaya gönderme gecikti · 2 saat 14 dakika');
  });

  it('preserves the existing status and priority signals alongside it', () => {
    const html = renderList({ kind: 'ready', page: page([delayedItem]) });
    expect(html).toContain('data-job-row-signals="true"');
    expect(html).toContain('status-chip');
    expect(html).toContain('priority-chip');
  });
});
