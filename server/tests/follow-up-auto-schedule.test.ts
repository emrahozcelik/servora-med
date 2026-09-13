import { describe, expect, it } from 'vitest';

import type { JobCardTransaction } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { generateFollowUpSlotCandidates } from '../src/modules/job-cards/follow-up-auto-scheduler.js';
import { resolveFollowUpSearchHorizonAt } from '../src/modules/job-cards/follow-up-auto-scheduler.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';

const REQUEST_TIME = new Date('2026-08-01T09:00:00.000Z');
const MEETING_AT = '2026-08-01T09:30:00.000Z';
// Floor = max(meetingAt, requestTime) + 15 minutes = 2026-08-01T09:45:00Z.
// Suggested +7-day target from the 09:30 source schedule = 2026-08-08T09:30Z.
const FIRST_GRID_AT = '2026-08-08T09:30:00.000Z';
const FLOOR_AT = new Date('2026-08-01T09:45:00.000Z');

const actor: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const assignee = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const, isActive: true };

type Interval = { startsAt: string; endsAt: string };
type ActiveJob = {
  id: string; title: string; scheduledAt: string; type: JobCard['type'];
  status: string; assignedTo: string; assigneeName: string;
};
type Visit = {
  id: string; type: JobCard['type']; title: string; occurredAt: string;
  staffName: string; resultSummary: string | null;
};

function makeJob(): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'COMPLETED',
    version: 1, title: 'Ziyaret', description: null, customerId: 'customer-1',
    contactId: null, assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal',
    dueDate: null, scheduledAt: MEETING_AT, scheduledEndsAt: '2026-08-01T10:30:00.000Z',
    engagementKind: null, sourceJobCardId: null, followUpInstructions: null,
    followUpProposedAt: null, followUpProposedType: null, followUpProposedAssignee: null,
    followUpProposalInstructions: null, followUpProposalOrigin: null, followUpProposedBy: null,
  };
}

function visit(id: string, occurredAt: string): Visit {
  return {
    id, type: 'SALES_MEETING', title: `Ziyaret ${id}`, occurredAt,
    staffName: 'Staff One', resultSummary: null,
  };
}

function activeJob(id: string, scheduledAt: string): ActiveJob {
  return {
    id, title: `Is ${id}`, scheduledAt, type: 'SALES_MEETING',
    status: 'ACCEPTED', assignedTo: 'staff-1', assigneeName: 'Staff One',
  };
}

class CountingTransaction {
  counts: Record<string, number> = {};
  ranges: Record<string, [string, string][]> = {};
  constructor(
    private readonly activeJobs: ActiveJob[] = [],
    private readonly recentVisits: Visit[] = [],
    private readonly intervals: Interval[] = [],
  ) {}

  private record(name: string, from: Date, to: Date) {
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    (this.ranges[name] ??= []).push([from.toISOString(), to.toISOString()]);
  }

  asTx(): JobCardTransaction {
    return {
      getCustomerForUpdate: async () => ({ id: 'customer-1', status: 'active' }),
      getOrganizationTimezone: async () => {
        this.counts.getOrganizationTimezone = (this.counts.getOrganizationTimezone ?? 0) + 1;
        return 'UTC';
      },
      listActiveOnSiteJobs: async (_o, _c, from, to) => {
        this.record('listActiveOnSiteJobs', from, to);
        return this.activeJobs;
      },
      listRecentOnSiteVisits: async (_o, _c, from, to) => {
        this.record('listRecentOnSiteVisits', from, to);
        return this.recentVisits;
      },
      listAssigneeCalendarIntervals: async (_o, _a, from, to, _e) => {
        this.record('listAssigneeCalendarIntervals', from, to);
        return this.intervals;
      },
    } as unknown as JobCardTransaction;
  }
}

type Proposal = { scheduledAt: Date; type: string; assignedTo: string };

async function autoSchedule(
  tx: CountingTransaction,
  preferredAt?: Date,
): Promise<Proposal> {
  const service = new JobCardService({} as never, () => REQUEST_TIME);
  return (service as unknown as {
    autoScheduleFollowUpProposal(
      tx: JobCardTransaction,
      actor: JobCardActor,
      job: JobCard,
      requestTime: Date,
      meetingAt: string | null,
      lockCustomer: boolean,
      input: { type: 'SALES_MEETING'; assignedTo: string; followUpInstructions: string },
      preferredAt?: Date,
      lockedAssignees?: ReadonlyMap<string, typeof assignee>,
    ): Promise<Proposal>;
  }).autoScheduleFollowUpProposal(
    tx.asTx(), actor, makeJob(), REQUEST_TIME, MEETING_AT, false,
    { type: 'SALES_MEETING', assignedTo: 'staff-1', followUpInstructions: 'Ara' },
    preferredAt, new Map([['staff-1', assignee]]),
  );
}

describe('autoScheduleFollowUpProposal lazy selection', () => {
  it('selects the first free grid candidate with a fixed bounded snapshot', async () => {
    const tx = new CountingTransaction();
    const proposal = await autoSchedule(tx);

    expect(proposal.scheduledAt.toISOString()).toBe(FIRST_GRID_AT);
    expect(tx.counts).toMatchObject({
      getOrganizationTimezone: 1,
      listActiveOnSiteJobs: 1,
      listRecentOnSiteVisits: 1,
      listAssigneeCalendarIntervals: 1,
    });
    // Snapshot lower bound stays anchored to the first candidate (exact old
    // semantics); the upper bound is the constant floor-anchored envelope.
    expect(tx.ranges.listActiveOnSiteJobs?.[0]?.[0]).toBe('2026-07-24T18:30:00.000Z');
    expect(tx.ranges.listActiveOnSiteJobs?.[0]?.[1]).toBe('2026-09-15T01:45:00.000Z');
    expect(tx.ranges.listAssigneeCalendarIntervals?.[0]).toEqual([
      FIRST_GRID_AT,
      '2026-08-31T10:45:00.000Z',
    ]);
  });

  it('keeps the envelope a safe superset of the legacy first/last bounds', async () => {
    const tx = new CountingTransaction();
    await autoSchedule(tx);

    const legacy = generateFollowUpSlotCandidates({
      earliestAllowedAt: new Date(FIRST_GRID_AT),
      horizonAnchorAt: FLOOR_AT,
      type: 'SALES_MEETING',
      timezone: 'UTC',
    });
    const legacyFirst = legacy[0]!;
    const legacyLast = legacy[legacy.length - 1]!;
    const pad = 14 * 24 * 60 * 60 * 1000 + 15 * 60 * 60 * 1000;
    const [from, to] = tx.ranges.listActiveOnSiteJobs?.[0] ?? [];
    expect(from).toBe(new Date(legacyFirst.startsAt.valueOf() - pad).toISOString());
    expect(new Date(to!).valueOf()).toBeGreaterThanOrEqual(
      legacyLast.endsAt.valueOf() + pad,
    );
    const horizonAt = resolveFollowUpSearchHorizonAt(FLOOR_AT, 'UTC');
    expect(new Date(to!).valueOf()).toBe(horizonAt.valueOf() + 60 * 60 * 1000 + pad);
  });

  it('advances past an assignee-blocked first candidate', async () => {
    const tx = new CountingTransaction([], [], [{
      startsAt: '2026-08-08T10:00:00.000Z',
      endsAt: '2026-08-08T11:00:00.000Z',
    }]);
    const proposal = await autoSchedule(tx);

    expect(proposal.scheduledAt.toISOString()).toBe('2026-08-08T11:00:00.000Z');
  });

  it('advances past a customer-CONFLICT first candidate without extra snapshot reads', async () => {
    const tx = new CountingTransaction([activeJob('other-1', '2026-08-08T10:00:00.000Z')]);
    const proposal = await autoSchedule(tx);

    expect(proposal.scheduledAt.toISOString()).toBe('2026-08-09T00:00:00.000Z');
    expect(tx.counts).toMatchObject({
      listActiveOnSiteJobs: 1,
      listRecentOnSiteVisits: 1,
      listAssigneeCalendarIntervals: 1,
    });
  });

  it('accepts a WARNING candidate instead of skipping it', async () => {
    const tx = new CountingTransaction([], [visit('v-1', '2026-08-07T09:30:00.000Z')]);
    const proposal = await autoSchedule(tx);

    expect(proposal.scheduledAt.toISOString()).toBe(FIRST_GRID_AT);
  });

  it('advances past frequency-exceeded candidates to the first allowed date', async () => {
    // Three visits on 08-05..08-07 exceed the 14-day frequency cap for every
    // candidate up to 08-18; 08-19 is the first date with a clean window.
    const tx = new CountingTransaction([], [
      visit('v-1', '2026-08-05T09:30:00.000Z'),
      visit('v-2', '2026-08-06T09:30:00.000Z'),
      visit('v-3', '2026-08-07T09:30:00.000Z'),
    ]);
    const proposal = await autoSchedule(tx);

    expect(proposal.scheduledAt.toISOString()).toBe('2026-08-19T00:00:00.000Z');
    expect(tx.counts).toMatchObject({
      listActiveOnSiteJobs: 1,
      listRecentOnSiteVisits: 1,
      listAssigneeCalendarIntervals: 1,
    });
  });

  it('honours a persisted SYSTEM target as the effective start', async () => {
    const tx = new CountingTransaction();
    const proposal = await autoSchedule(tx, new Date('2026-08-10T10:00:00.000Z'));

    expect(proposal.scheduledAt.toISOString()).toBe('2026-08-10T10:00:00.000Z');
  });

  it('performs no snapshot reads when the target is beyond the horizon', async () => {
    const tx = new CountingTransaction();
    await expect(autoSchedule(tx, new Date('2026-12-01T10:00:00.000Z')))
      .rejects.toMatchObject({ code: 'FOLLOW_UP_PROPOSAL_INVALID', statusCode: 409 });
    expect(tx.counts.listActiveOnSiteJobs ?? 0).toBe(0);
    expect(tx.counts.listRecentOnSiteVisits ?? 0).toBe(0);
    expect(tx.counts.listAssigneeCalendarIntervals ?? 0).toBe(0);
  });

  it('reports fully blocked horizons with the existing conflict error', async () => {
    const tx = new CountingTransaction([], [], [{
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-09-10T00:00:00.000Z',
    }]);
    await expect(autoSchedule(tx))
      .rejects.toMatchObject({ code: 'FOLLOW_UP_PROPOSAL_INVALID', statusCode: 409 });
  });
});
