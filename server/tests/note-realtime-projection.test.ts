import { describe, expect, it } from 'vitest';

import { appendStandaloneNoteProjection } from '../src/modules/job-cards/note-realtime-projection.js';
import type { JobCardTransaction, AppendedActivity } from '../src/modules/job-cards/repository.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import type { NotificationDraft } from '../src/modules/notifications/types.js';

type ManagementRecipient = { id: string; role: 'ADMIN' | 'MANAGER'; isActive: boolean };

function tx(overrides: {
  activeManagement?: ManagementRecipient[];
  assigneeIsActive?: boolean;
  assigneeId?: string;
} = {}) {
  const realtimeEvents: RealtimeEventRecord[] = [];
  const notificationDrafts: NotificationDraft[] = [];
  const mgmt: ManagementRecipient[] = overrides.activeManagement ?? [
    { id: 'admin-1', role: 'ADMIN', isActive: true },
    { id: 'manager-1', role: 'MANAGER', isActive: true },
    { id: 'inactive-mgr', role: 'MANAGER', isActive: false },
  ];

  return {
    realtimeEvents,
    notificationDrafts,
    transaction: {
      listActiveManagementRecipients: async () => mgmt,
      getAssignee: async () => ({
        id: overrides.assigneeId ?? 'staff-1',
        organizationId: 'org-1',
        role: 'STAFF' as const,
        isActive: overrides.assigneeIsActive ?? true,
      }),
      appendRealtimeEvent: async (input: Parameters<JobCardTransaction['appendRealtimeEvent']>[0]) => {
        const record: RealtimeEventRecord = { ...input, id: BigInt(realtimeEvents.length + 1) };
        realtimeEvents.push(record);
        return record;
      },
      appendNotifications: async (input: { drafts: readonly NotificationDraft[] }) => {
        notificationDrafts.push(...input.drafts);
        return [];
      },
    } as unknown as JobCardTransaction,
  };
}

const activity: AppendedActivity = {
  id: 'activity-1',
  createdAt: new Date('2026-07-30T12:00:00.000Z'),
};

describe('appendStandaloneNoteProjection', () => {
  it('always includes job-notes resource key and never job-detail', async () => {
    const { realtimeEvents, transaction } = tx();
    await appendStandaloneNoteProjection(transaction, {
      organizationId: 'org-1', jobCardId: 'job-1', actorId: 'staff-1',
      assigneeId: 'staff-1', activity,
    });
    expect(realtimeEvents).toHaveLength(1);
    expect(realtimeEvents[0]!.resourceKeys).toContain('job-notes:job-1');
    expect(realtimeEvents[0]!.resourceKeys).not.toContain('job-detail:job-1');
  });

  it('includes notifications resource key when eligible non-actor recipients exist', async () => {
    const { realtimeEvents, transaction } = tx();
    await appendStandaloneNoteProjection(transaction, {
      organizationId: 'org-1', jobCardId: 'job-1', actorId: 'staff-1',
      assigneeId: 'staff-1', activity,
    });
    // staff-1 is actor → excluded; admin-1 + manager-1 are active mgmt → included
    expect(realtimeEvents[0]!.resourceKeys).toContain('notifications');
  });

  it('does NOT include notifications resource key when all eligible recipients are the actor', async () => {
    const { realtimeEvents, transaction } = tx({
      // admin-1 is the only active mgmt AND the actor
      activeManagement: [{ id: 'admin-1', role: 'ADMIN', isActive: true }],
      assigneeId: 'admin-1',
    });
    await appendStandaloneNoteProjection(transaction, {
      organizationId: 'org-1', jobCardId: 'job-1', actorId: 'admin-1',
      assigneeId: 'admin-1', activity,
    });
    expect(realtimeEvents[0]!.resourceKeys).toContain('job-notes:job-1');
    expect(realtimeEvents[0]!.resourceKeys).not.toContain('notifications');
  });

  it('includes active assignee in realtime audience userIds', async () => {
    const { realtimeEvents, transaction } = tx();
    await appendStandaloneNoteProjection(transaction, {
      organizationId: 'org-1', jobCardId: 'job-1', actorId: 'manager-1',
      assigneeId: 'staff-1', activity,
    });
    expect(realtimeEvents[0]!.audience.userIds).toContain('staff-1');
  });

  it('excludes inactive assignee from realtime audience userIds', async () => {
    const { realtimeEvents, transaction } = tx({ assigneeIsActive: false });
    await appendStandaloneNoteProjection(transaction, {
      organizationId: 'org-1', jobCardId: 'job-1', actorId: 'manager-1',
      assigneeId: 'inactive-staff', activity,
    });
    expect(realtimeEvents[0]!.audience.userIds).not.toContain('inactive-staff');
    expect(realtimeEvents[0]!.audience.userIds).toEqual([]);
  });

  it('does not create Web Push deliveries for standalone notes', async () => {
    const { notificationDrafts, transaction } = tx();
    await appendStandaloneNoteProjection(transaction, {
      organizationId: 'org-1', jobCardId: 'job-1', actorId: 'admin-1',
      assigneeId: 'staff-1', activity,
    });
    // Notification drafts are created (staff-1 + manager-1, excluding admin-1 actor)
    expect(notificationDrafts.length).toBeGreaterThan(0);
    // But no Web Push delivery is appended — the projection explicitly skips it.
    // Verified by the absence of appendWebPushDeliveries calls in the mock.
  });

  it('creates correct number of notification drafts for the default matrix', async () => {
    const { notificationDrafts, transaction } = tx();
    await appendStandaloneNoteProjection(transaction, {
      organizationId: 'org-1', jobCardId: 'job-1', actorId: 'staff-1',
      assigneeId: 'staff-1', activity,
    });
    // staff-1 is actor (excluded); active mgmt: admin-1 + manager-1 → 2 drafts
    expect(notificationDrafts).toHaveLength(2);
    const ids = notificationDrafts.map((d) => d.recipientUserId).sort();
    expect(ids).toEqual(['admin-1', 'manager-1']);
    notificationDrafts.forEach((d) => {
      expect(d.kind).toBe('job.note_added');
      expect(d.entityType).toBe('job-card');
      expect(d.entityId).toBe('job-1');
    });
  });
});
