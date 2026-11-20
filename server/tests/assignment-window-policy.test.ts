import { describe, expect, it } from 'vitest';

import { getAllowedLifecycleCommands } from '../src/modules/job-cards/policy.js';
import {
  JOB_CARD_STATUSES,
  JOB_CARD_TYPES,
  TERMINAL_JOB_CARD_STATUSES,
  type JobCardActor,
  type JobCardStatus,
  type JobCardType,
  type JobPermissionSubject,
} from '../src/modules/job-cards/types.js';

/**
 * JOB-010 release 2b — pure policy contract
 * (`docs/features/assignment-acceptance-sla.md`, "Release 2b technical
 * contract" plus §3–§9 and decision D1).
 *
 * The 14:00–15:00 job assigned at 12:00 convention:
 *   scheduledAt        14:00
 *   scheduledEndsAt    15:00
 *   openedAt           12:00
 *   acceptanceDueAt    13:00 = max(scheduledAt - 60 min, openedAt + 10 min)
 * so 12:59:59.999 is before the deadline and 13:00 is already late
 * (a reservation with `reservedAt < acceptanceDueAt` is on time, equality is
 * late).
 *
 * The policy receives the window as a permission fact on the subject. The
 * contract does not fix the field name; these tests assume
 * `assignmentOffer: { state, acceptanceDueAt, assigneeUserId } | null`, the
 * latest offer for the job. An absent fact means "no offer recorded", i.e. a
 * job outside the window.
 */

const ORGANIZATION_ID = 'org-1';
const STAFF_ID = 'staff-1';
const OTHER_STAFF_ID = 'staff-2';
const MANAGER_ID = 'manager-1';
const ADMIN_ID = 'admin-1';

const staff: JobCardActor = { id: STAFF_ID, organizationId: ORGANIZATION_ID, role: 'STAFF' };
const otherStaff: JobCardActor = { id: OTHER_STAFF_ID, organizationId: ORGANIZATION_ID, role: 'STAFF' };
const manager: JobCardActor = { id: MANAGER_ID, organizationId: ORGANIZATION_ID, role: 'MANAGER' };
const admin: JobCardActor = { id: ADMIN_ID, organizationId: ORGANIZATION_ID, role: 'ADMIN' };

const SCHEDULED_AT = '2026-12-01T14:00:00.000Z';
const SCHEDULED_ENDS_AT = '2026-12-01T15:00:00.000Z';
const DUE_AT = '2026-12-01T13:00:00.000Z';
const BEFORE_DUE = new Date('2026-12-01T12:59:59.999Z');
const AT_DUE = new Date(DUE_AT);
const AFTER_DUE = new Date('2026-12-01T13:00:00.001Z');
/** Inside the planned interval and past the 30-minute early-START tolerance. */
const DURING_JOB = new Date('2026-12-01T13:40:00.000Z');

/** Flag on/off are the only two service states; absent means false. */
const FLAG_ON = { assignmentWindowEnabled: true };
const FLAG_OFF = { assignmentWindowEnabled: false };

const ACTIVE_STATUSES = JOB_CARD_STATUSES.filter(
  (status) => !(TERMINAL_JOB_CARD_STATUSES as readonly JobCardStatus[]).includes(status),
);

type OfferState = 'OPEN' | 'ACCEPTED' | 'DECLINED' | 'RELEASED' | 'EXPIRED' | 'WITHDRAWN';

type OfferOverrides = Partial<{
  state: OfferState;
  acceptanceDueAt: string;
  assigneeUserId: string;
}>;

function offer(overrides: OfferOverrides = {}) {
  return {
    state: 'OPEN' as OfferState,
    acceptanceDueAt: DUE_AT,
    assigneeUserId: STAFF_ID,
    ...overrides,
  };
}

function subject(overrides: Partial<JobPermissionSubject> = {}): JobPermissionSubject {
  return {
    organizationId: ORGANIZATION_ID,
    type: 'SALES_MEETING',
    status: 'NEW',
    assignedTo: STAFF_ID,
    scheduledAt: SCHEDULED_AT,
    assignmentOffer: null,
    ...overrides,
  };
}

function allowed(
  actor: JobCardActor,
  job: JobPermissionSubject,
  requestTime: Date = BEFORE_DUE,
  flags: { assignmentWindowEnabled: boolean } = FLAG_ON,
) {
  return getAllowedLifecycleCommands(actor, job, requestTime, flags);
}

describe('JOB-010 release 2b — assignment window policy', () => {
  describe('flag off is exactly the release 2a behavior', () => {
    it('keeps Staff ACCEPT_ASSIGNMENT and CANCEL and never offers decline or release', () => {
      // The 2a sets are pinned verbatim so the flag cannot widen or narrow
      // anything while it is off.
      expect(allowed(staff, subject(), BEFORE_DUE, FLAG_OFF))
        .toEqual(['ACCEPT_ASSIGNMENT', 'CANCEL']);
      expect(allowed(staff, subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }), DURING_JOB, FLAG_OFF))
        .toEqual(['START', 'CANCEL']);
      expect(allowed(manager, subject(), BEFORE_DUE, FLAG_OFF)).toEqual(['CANCEL']);
      expect(allowed(admin, subject({ status: 'ACCEPTED' }), BEFORE_DUE, FLAG_OFF))
        .toEqual(['CANCEL']);
    });

    it('ignores an offer fact and an absent flags argument entirely', () => {
      const windowJob = subject({ assignmentOffer: offer() });

      // Third argument only (the 2a signature): assignment-window rules stay inert.
      expect(getAllowedLifecycleCommands(staff, windowJob, BEFORE_DUE))
        .toEqual(['ACCEPT_ASSIGNMENT', 'CANCEL']);
      expect(getAllowedLifecycleCommands(staff, windowJob, AFTER_DUE))
        .toEqual(['ACCEPT_ASSIGNMENT', 'CANCEL']);
      expect(getAllowedLifecycleCommands(
        staff,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
        DURING_JOB,
      )).toEqual(['START', 'CANCEL']);
    });

    it('never allows decline or release with the flag off even on a matching offer', () => {
      for (const requestTime of [BEFORE_DUE, AT_DUE, AFTER_DUE]) {
        const commands = allowed(staff, subject({ assignmentOffer: offer() }), requestTime, FLAG_OFF);
        expect(commands).not.toContain('DECLINE_ASSIGNMENT');
        expect(commands).not.toContain('RELEASE_ASSIGNMENT');
        expect(commands).toContain('CANCEL');
      }
      const accepted = allowed(
        staff,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
        BEFORE_DUE,
        FLAG_OFF,
      );
      expect(accepted).not.toContain('RELEASE_ASSIGNMENT');
      expect(accepted).toContain('CANCEL');
    });
  });

  describe('decision D1: Staff CANCEL is removed for every type and status', () => {
    it('removes Staff CANCEL on every JobCard type and active status', () => {
      for (const type of JOB_CARD_TYPES) {
        for (const status of ACTIVE_STATUSES) {
          const job = subject({ type, status });
          const commands = allowed(staff, job);
          expect(commands, `${type}/${status}`).not.toContain('CANCEL');
        }
      }
    });

    it('keeps every other Staff command that was available before the flag', () => {
      // Only CANCEL disappears; the remaining 2a/2b command set is unchanged.
      expect(allowed(staff, subject({ status: 'IN_PROGRESS' })))
        .toEqual(['SUBMIT_FOR_APPROVAL']);
      expect(allowed(staff, subject({ status: 'REVISION_REQUESTED' })))
        .toEqual(['RESUME']);
      expect(allowed(staff, subject({ status: 'WAITING_APPROVAL' })))
        .toEqual(['WITHDRAW_FROM_APPROVAL']);
      expect(allowed(staff, subject({ status: 'COMPLETED' }))).toEqual([]);
      expect(allowed(staff, subject({ status: 'CANCELLED' }))).toEqual([]);
    });

    it('keeps reasoned cancellation for MANAGER and ADMIN in every active status and type', () => {
      for (const actor of [manager, admin]) {
        for (const type of JOB_CARD_TYPES) {
          for (const status of ACTIVE_STATUSES) {
            expect(allowed(actor, subject({ type, status })), `${actor.role}/${type}/${status}`)
              .toContain('CANCEL');
          }
        }
      }
    });

    it('still conceals a job from a Staff member who is not the assignee', () => {
      expect(allowed(otherStaff, subject({ assignmentOffer: offer() }))).toEqual([]);
      expect(allowed(
        otherStaff,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
      )).toEqual([]);
    });
  });

  describe('ACCEPT_ASSIGNMENT requires an OPEN, unexpired offer for a job in the window', () => {
    it('allows acceptance only before the deadline on a live OPEN offer', () => {
      expect(allowed(staff, subject({ assignmentOffer: offer() }), BEFORE_DUE))
        .toContain('ACCEPT_ASSIGNMENT');
      // The equality boundary is late: reservedAt < acceptanceDueAt is on time.
      expect(allowed(staff, subject({ assignmentOffer: offer() }), AT_DUE))
        .not.toContain('ACCEPT_ASSIGNMENT');
      expect(allowed(staff, subject({ assignmentOffer: offer() }), AFTER_DUE))
        .not.toContain('ACCEPT_ASSIGNMENT');
    });

    it('refuses acceptance when the latest offer is no longer OPEN', () => {
      for (const state of ['ACCEPTED', 'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN'] as const) {
        expect(allowed(staff, subject({ assignmentOffer: offer({ state }) })))
          .not.toContain('ACCEPT_ASSIGNMENT');
      }
    });

    it('refuses acceptance when the OPEN offer belongs to another assignee', () => {
      expect(allowed(staff, subject({ assignmentOffer: offer({ assigneeUserId: OTHER_STAFF_ID }) })))
        .not.toContain('ACCEPT_ASSIGNMENT');
    });

    it('is unchanged for a job outside the window (no offer recorded)', () => {
      // No offer: not in the window, acceptance keeps the release 1 rule and
      // is not gated by scheduledAt.
      expect(allowed(staff, subject({ scheduledAt: null }))).toContain('ACCEPT_ASSIGNMENT');
      expect(allowed(staff, subject({ type: 'GENERAL_TASK', scheduledAt: null })))
        .toContain('ACCEPT_ASSIGNMENT');
      expect(allowed(staff, subject({ status: 'NEW', assignmentOffer: null }), AFTER_DUE))
        .toContain('ACCEPT_ASSIGNMENT');
      expect(allowed(staff, subject({ assignmentOffer: undefined })))
        .toContain('ACCEPT_ASSIGNMENT');
    });

    it('stays a Staff-only, window-consistent command', () => {
      expect(allowed(manager, subject({ assignmentOffer: offer() }))).not.toContain('ACCEPT_ASSIGNMENT');
      expect(allowed(admin, subject({ assignmentOffer: offer() }))).not.toContain('ACCEPT_ASSIGNMENT');
      // A job without a planned instant can never be in the window (§2), even
      // if a stale offer fact reaches the policy.
      expect(allowed(staff, subject({ scheduledAt: null, assignmentOffer: offer() })))
        .not.toContain('ACCEPT_ASSIGNMENT');
      // Only PRODUCT_DELIVERY / SALES_MEETING are window types (§2, Q8).
      for (const type of ['GENERAL_TASK', 'WEEKLY_REPORT', 'SALE'] as const) {
        expect(allowed(staff, subject({ type, assignmentOffer: offer() })))
          .not.toContain('ACCEPT_ASSIGNMENT');
      }
    });
  });

  describe('DECLINE_ASSIGNMENT is the assigned Staff answer in NEW', () => {
    it('is offered to the assigned Staff member before the deadline', () => {
      expect(allowed(staff, subject({ status: 'NEW', assignmentOffer: offer() }), BEFORE_DUE))
        .toContain('DECLINE_ASSIGNMENT');
    });

    it('is refused at and after the deadline', () => {
      expect(allowed(staff, subject({ assignmentOffer: offer() }), AT_DUE))
        .not.toContain('DECLINE_ASSIGNMENT');
      expect(allowed(staff, subject({ assignmentOffer: offer() }), AFTER_DUE))
        .not.toContain('DECLINE_ASSIGNMENT');
    });

    it('requires an OPEN offer for the acting assignee', () => {
      for (const state of ['ACCEPTED', 'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN'] as const) {
        expect(allowed(staff, subject({ assignmentOffer: offer({ state }) })))
          .not.toContain('DECLINE_ASSIGNMENT');
      }
      expect(allowed(staff, subject({ assignmentOffer: offer({ assigneeUserId: OTHER_STAFF_ID }) })))
        .not.toContain('DECLINE_ASSIGNMENT');
      expect(allowed(staff, subject({ assignmentOffer: null })))
        .not.toContain('DECLINE_ASSIGNMENT');
    });

    it('is NEW-only and Staff-only', () => {
      expect(allowed(
        staff,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
      )).not.toContain('DECLINE_ASSIGNMENT');
      expect(allowed(staff, subject({ status: 'IN_PROGRESS', assignmentOffer: offer() })))
        .not.toContain('DECLINE_ASSIGNMENT');
      expect(allowed(manager, subject({ assignmentOffer: offer() })))
        .not.toContain('DECLINE_ASSIGNMENT');
      expect(allowed(admin, subject({ assignmentOffer: offer() })))
        .not.toContain('DECLINE_ASSIGNMENT');
      expect(allowed(otherStaff, subject({ assignmentOffer: offer() }))).toEqual([]);
    });

    it('only exists for the window types with a planned instant', () => {
      for (const type of ['GENERAL_TASK', 'WEEKLY_REPORT', 'SALE'] as const) {
        expect(allowed(staff, subject({ type, assignmentOffer: offer() })))
          .not.toContain('DECLINE_ASSIGNMENT');
      }
      expect(allowed(staff, subject({ scheduledAt: null, assignmentOffer: offer() })))
        .not.toContain('DECLINE_ASSIGNMENT');
    });
  });

  describe('RELEASE_ASSIGNMENT hands an ACCEPTED job back', () => {
    it('is offered to the assigned Staff member with an ACCEPTED offer for them', () => {
      const commands = allowed(
        staff,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
        DURING_JOB,
      );
      expect(commands).toContain('RELEASE_ASSIGNMENT');
      expect(commands).toContain('START');
      expect(commands).not.toContain('CANCEL');
    });

    it('requires the latest offer to be ACCEPTED for the acting member', () => {
      for (const state of ['OPEN', 'DECLINED', 'RELEASED', 'EXPIRED', 'WITHDRAWN'] as const) {
        expect(allowed(staff, subject({ status: 'ACCEPTED', assignmentOffer: offer({ state }) })))
          .not.toContain('RELEASE_ASSIGNMENT');
      }
      expect(allowed(
        staff,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED', assigneeUserId: OTHER_STAFF_ID }) }),
      )).not.toContain('RELEASE_ASSIGNMENT');
      expect(allowed(staff, subject({ status: 'ACCEPTED', assignmentOffer: null })))
        .not.toContain('RELEASE_ASSIGNMENT');
    });

    it('is ACCEPTED-only and Staff-only', () => {
      expect(allowed(staff, subject({ status: 'NEW', assignmentOffer: offer({ state: 'ACCEPTED' }) })))
        .not.toContain('RELEASE_ASSIGNMENT');
      for (const status of ['IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'] as const) {
        expect(allowed(
          staff,
          subject({ status, assignmentOffer: offer({ state: 'ACCEPTED' }) }),
        )).not.toContain('RELEASE_ASSIGNMENT');
      }
      expect(allowed(
        manager,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
      )).not.toContain('RELEASE_ASSIGNMENT');
      expect(allowed(
        admin,
        subject({ status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
      )).not.toContain('RELEASE_ASSIGNMENT');
    });

    it('never exists outside the window types', () => {
      for (const type of ['GENERAL_TASK', 'WEEKLY_REPORT', 'SALE'] as const) {
        expect(allowed(
          staff,
          subject({ type, status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
        )).not.toContain('RELEASE_ASSIGNMENT');
      }
    });
  });

  describe('terminal jobs stay closed to every command', () => {
    it('returns no command for terminal statuses with a live offer', () => {
      for (const status of TERMINAL_JOB_CARD_STATUSES) {
        expect(allowed(staff, subject({ status, assignmentOffer: offer() }))).toEqual([]);
        expect(allowed(manager, subject({ status, assignmentOffer: offer() }))).toEqual([]);
      }
    });
  });

  describe('the window covers every JobCard type in one place', () => {
    it('keeps the new Staff answers scoped to PRODUCT_DELIVERY and SALES_MEETING', () => {
      const windowTypes: JobCardType[] = ['PRODUCT_DELIVERY', 'SALES_MEETING'];
      for (const type of windowTypes) {
        expect(allowed(staff, subject({ type, assignmentOffer: offer() })))
          .toContain('DECLINE_ASSIGNMENT');
        expect(allowed(
          staff,
          subject({ type, status: 'ACCEPTED', assignmentOffer: offer({ state: 'ACCEPTED' }) }),
        )).toContain('RELEASE_ASSIGNMENT');
      }
    });
  });
});
