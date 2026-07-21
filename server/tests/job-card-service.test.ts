import { describe, expect, it, vi } from 'vitest';

import type {
  CriticalActionClaim,
  CriticalActionWorkResult,
  JobCardRepository,
  JobCardTransaction,
  ActiveManagementRecipient,
} from '../src/modules/job-cards/repository.js';
import type { NotificationAppendInput } from '../src/modules/notifications/types.js';
import type { RealtimeEventPublisher } from '../src/modules/realtime/event-bus.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActivityEvent, JobCardActor } from '../src/modules/job-cards/types.js';
import type { AppendJobActionLocationInput } from '../src/modules/job-cards/location-types.js';

type Activity = { event: JobCardActivityEvent; jobCardId: string; actorId: string; clientActionId: string };

class MemoryJobCardRepository implements JobCardRepository {
  job: JobCard = {
    id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED',
    version: 1, title: 'Klinik teslimi', customerId: 'customer-1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
    description: null, scheduledAt: '2026-07-16T11:30:00.000Z',
  };
  activities: Activity[] = [];
  realtimeEvents: RealtimeEventRecord[] = [];
  notificationAppends: NotificationAppendInput[] = [];
  nextCriticalResult: 'completed' | 'replay' = 'completed';
  completed = new Map<string, unknown>();
  processing = new Set<string>();
  failActivity = false;
  failLocation = false;
  beforeCriticalWork?: () => void;
  locationAppends: AppendJobActionLocationInput[] = [];

  async findCompletedCriticalAction<T>(claim: CriticalActionClaim): Promise<T | null> {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    return (this.completed.get(key) as T | undefined) ?? null;
  }

  async findJobCard(organizationId: string, id: string) {
    return this.job.organizationId === organizationId && this.job.id === id ? { ...this.job } : null;
  }

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<CriticalActionWorkResult<T>>) {
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T, realtimeEvents: [] as const };
    if (this.processing.has(key)) return { kind: 'processing' as const };
    this.processing.add(key);
    const jobBefore = { ...this.job };
    const activityCount = this.activities.length;
    const locationCount = this.locationAppends.length;
    const tx: JobCardTransaction = {
      getJobForUpdate: async (organizationId, id) =>
        this.job.organizationId === organizationId && this.job.id === id ? { ...this.job } : null,
      getJobDetail: async (organizationId, id) =>
        this.job.organizationId === organizationId && this.job.id === id
          ? {
              ...this.job,
              assignee: { id: this.job.assignedTo, name: 'Staff One' },
              customer: this.job.customerId ? { id: this.job.customerId, name: 'Demo Klinik' } : null,
              contact: null,
              lifecycle: {
                createdAt: '2026-07-13T10:00:00.000Z',
                acceptedAt: '2026-07-13T10:05:00.000Z',
                acceptedBy: { id: 'staff-1', name: 'Staff One' },
                startedAt: null, submittedAt: null, submittedBy: null,
                submissionNote: null, approvedAt: null, approvedBy: null, approvalNote: null,
                revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
                cancelledAt: null, cancelledBy: null, cancelReason: null,
                cancelledFromStatus: null,
              },
            }
          : null,
      transitionWithVersion: async (input) => {
        if (this.job.id !== input.jobCardId || this.job.version !== input.expectedVersion) return null;
        this.job = { ...this.job, status: input.status, version: this.job.version + 1 };
        return { ...this.job };
      },
      createMeetingDetails: async () => { throw new Error('unused'); },
      createNote: async (input) => ({
        id: 'note-1',
        jobCardId: input.jobCardId,
        note: input.note,
        author: { id: input.authorId, name: 'Staff One' },
        createdAt: '2026-07-19T14:30:00.000Z',
      }),
      appendActivity: async (input) => {
        if (this.failActivity) throw new Error('activity failed');
        this.activities.push({ event: input.event, jobCardId: input.jobCardId, actorId: input.actorId, clientActionId: input.clientActionId });
        return { id: `activity-${this.activities.length}`, createdAt: new Date('2026-07-19T14:30:00.000Z') };
      },
      appendJobActionLocation: async (location) => {
        if (this.failLocation) throw new Error('location failed');
        this.locationAppends.push(location);
        return { ...location, id: `location-${this.locationAppends.length}`, createdAt: new Date() };
      },
      appendRealtimeEvent: async (input) => {
        const record: RealtimeEventRecord = { ...input, id: BigInt(this.realtimeEvents.length + 1) };
        this.realtimeEvents.push(record);
        return record;
      },
      listActiveManagementRecipients: async (): Promise<readonly ActiveManagementRecipient[]> => [
        { id: 'manager-1', role: 'MANAGER', isActive: true },
        { id: 'admin-1', role: 'ADMIN', isActive: true },
        { id: 'inactive-manager', role: 'MANAGER', isActive: false },
      ],
      appendNotifications: async (input) => {
        this.notificationAppends.push(input);
        return [];
      },
      getAssignee: async () => ({
        id: 'staff-1', organizationId: 'org-1', role: 'STAFF' as const, isActive: true,
      }),
      getSubmissionCustomer: async () => ({
        id: 'customer-1', organizationId: 'org-1', status: 'active' as const,
      }),
      getSubmissionMeetingDetails: async () => null,
      getSubmissionDeliveryItems: async () => [],
    };
    try {
      this.beforeCriticalWork?.();
      const workResult = await work(tx);
      this.completed.set(key, workResult.response);
      if (this.nextCriticalResult === 'replay') {
        return { kind: 'replay' as const, response: workResult.response, realtimeEvents: [] as const };
      }
      return { kind: 'completed' as const, response: workResult.response, realtimeEvents: workResult.realtimeEvents };
    } catch (error) {
      this.job = jobBefore;
      this.activities.splice(activityCount);
      this.locationAppends.splice(locationCount);
      throw error;
    } finally { this.processing.delete(key); }
  }
}

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const input = { expectedVersion: 1, clientActionId: 'action-1' };

describe('JobCardService critical command foundation', () => {
  it('starts a JobCard, increments version, and appends one canonical activity', async () => {
    const repository = new MemoryJobCardRepository();
    const result = await new JobCardService(repository).start(staff, 'job-1', input);
    expect(result).toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect(repository.activities).toEqual([{ event: 'JOB_STARTED', jobCardId: 'job-1', actorId: 'staff-1', clientActionId: 'action-1' }]);
  });

  it('replays the original response without another mutation or event', async () => {
    const repository = new MemoryJobCardRepository();
    const service = new JobCardService(repository);
    const first = await service.start(staff, 'job-1', input);
    const duplicate = await service.start(staff, 'job-1', input);
    expect(duplicate).toEqual(first);
    expect(repository.job.version).toBe(2);
    expect(repository.activities).toHaveLength(1);
  });

  it('returns ACTION_IN_PROGRESS for a live duplicate claim', async () => {
    const repository = new MemoryJobCardRepository();
    repository.processing.add('org-1:staff-1:action-1:JOB_START:job-1');
    await expect(new JobCardService(repository).start(staff, 'job-1', input)).rejects.toMatchObject({
      code: 'ACTION_IN_PROGRESS', statusCode: 409,
    });
  });

  it('returns VERSION_CONFLICT without mutation or activity for stale input', async () => {
    const repository = new MemoryJobCardRepository();
    await expect(new JobCardService(repository).start(staff, 'job-1', { ...input, expectedVersion: 9 }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT', statusCode: 409 });
    expect(repository.job).toMatchObject({ status: 'ACCEPTED', version: 1 });
    expect(repository.activities).toHaveLength(0);
  });

  it('rolls back the mutation if activity append fails', async () => {
    const repository = new MemoryJobCardRepository(); repository.failActivity = true;
    await expect(new JobCardService(repository).start(staff, 'job-1', input)).rejects.toThrow('activity failed');
    expect(repository.job).toMatchObject({ status: 'ACCEPTED', version: 1 });
    expect(repository.activities).toHaveLength(0);
  });

  it('rejects cross-organization access without revealing the JobCard', async () => {
    const repository = new MemoryJobCardRepository();
    await expect(new JobCardService(repository).start({ ...staff, organizationId: 'org-2' }, 'job-1', input))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
  });
});

describe('JobCardService action-scoped start location', () => {
  const captured = {
    outcome: 'captured' as const,
    latitude: 39.92077,
    longitude: 32.85411,
    accuracyMeters: 24,
    capturedAt: '2026-07-21T09:15:30+03:00',
  };

  function enabledService(repository = new MemoryJobCardRepository()) {
    const reverse = vi.fn().mockResolvedValue({
      neighborhood: 'Kızılay',
      district: 'Çankaya',
      city: 'Ankara',
      approximateLabel: 'Kızılay, Çankaya / Ankara',
    });
    const service = new JobCardService(repository, undefined, undefined, {
      enabled: true,
      reverseGeocoder: { reverse },
    });
    return { repository, reverse, service };
  }

  it('preflights, geocodes, and appends the captured outcome beside JOB_STARTED', async () => {
    const { repository, reverse, service } = enabledService();
    await service.start(staff, 'job-1', { ...input, locationCapture: captured });

    expect(reverse).toHaveBeenCalledOnce();
    expect(repository.locationAppends).toEqual([
      expect.objectContaining({
        jobCardId: 'job-1',
        activityId: 'activity-1',
        actorUserId: 'staff-1',
        action: 'JOB_STARTED',
        capture: expect.objectContaining({
          outcome: 'CAPTURED',
          geocodingStatus: 'RESOLVED',
          approximateLabel: 'Kızılay, Çankaya / Ankara',
        }),
      }),
    ]);
    const publicRealtimeEnvelope = JSON.stringify(
      repository.realtimeEvents,
      (_key, value) => typeof value === 'bigint' ? value.toString() : value,
    );
    expect(publicRealtimeEnvelope).not.toContain('39.92077');
    expect(publicRealtimeEnvelope).not.toContain('Kızılay');
    expect(publicRealtimeEnvelope).not.toContain('accuracyMeters');
  });

  it('persists unavailable capture without provider I/O', async () => {
    const { repository, reverse, service } = enabledService();
    await service.start(staff, 'job-1', {
      ...input,
      locationCapture: { outcome: 'unavailable', reason: 'PERMISSION_DENIED' },
    });

    expect(reverse).not.toHaveBeenCalled();
    expect(repository.locationAppends[0]?.capture)
      .toEqual({ outcome: 'UNAVAILABLE', reason: 'PERMISSION_DENIED' });
  });

  it('does not call provider for malformed, stale, unauthorized, or ineligible requests', async () => {
    const scenarios: Array<{ actor: JobCardActor; version: number; status?: JobCard['status']; capture: unknown }> = [
      { actor: staff, version: 1, capture: { ...captured, latitude: 91 } },
      { actor: staff, version: 9, capture: captured },
      { actor: { ...staff, id: 'staff-2' }, version: 1, capture: captured },
      { actor: { ...staff, role: 'MANAGER' }, version: 1, capture: captured },
      { actor: staff, version: 1, status: 'IN_PROGRESS', capture: captured },
      { actor: { ...staff, organizationId: 'org-2' }, version: 1, capture: captured },
    ];

    for (const scenario of scenarios) {
      const { repository, reverse, service } = enabledService();
      if (scenario.status) repository.job = { ...repository.job, status: scenario.status };
      await expect(service.start(scenario.actor, 'job-1', {
        expectedVersion: scenario.version,
        clientActionId: `action-${scenario.actor.id}-${scenario.version}`,
        locationCapture: scenario.capture,
      })).rejects.toBeDefined();
      expect(reverse).not.toHaveBeenCalled();
      expect(repository.locationAppends).toEqual([]);
    }
  });

  it('returns a completed replay before calling provider again', async () => {
    const { repository, reverse, service } = enabledService();
    const request = { ...input, locationCapture: captured };
    const first = await service.start(staff, 'job-1', request);
    const replay = await service.start(staff, 'job-1', request);

    expect(replay).toEqual(first);
    expect(reverse).toHaveBeenCalledOnce();
    expect(repository.locationAppends).toHaveLength(1);
  });

  it('keeps the legacy path location-free while the capability is disabled', async () => {
    const repository = new MemoryJobCardRepository();
    const reverse = vi.fn();
    const service = new JobCardService(repository, undefined, undefined, {
      enabled: false,
      reverseGeocoder: { reverse },
    });
    await service.start(staff, 'job-1', { ...input, locationCapture: captured });

    expect(reverse).not.toHaveBeenCalled();
    expect(repository.locationAppends).toEqual([]);
  });

  it('continues start with FAILED geocoding and skips low-accuracy address lookup', async () => {
    const failed = enabledService();
    failed.reverse.mockRejectedValueOnce(new Error('provider timeout'));
    await failed.service.start(staff, 'job-1', { ...input, locationCapture: captured });
    expect(failed.repository.locationAppends[0]?.capture)
      .toMatchObject({ outcome: 'CAPTURED', geocodingStatus: 'FAILED' });

    const lowAccuracy = enabledService();
    await lowAccuracy.service.start(staff, 'job-1', {
      ...input,
      clientActionId: 'low-accuracy',
      locationCapture: { ...captured, accuracyMeters: 1_001 },
    });
    expect(lowAccuracy.reverse).not.toHaveBeenCalled();
    expect(lowAccuracy.repository.locationAppends[0]?.capture)
      .toMatchObject({ outcome: 'CAPTURED', geocodingStatus: 'NOT_REQUESTED' });
  });

  it('bounds a hanging reverse geocoder and continues the start command', async () => {
    const repository = new MemoryJobCardRepository();
    const reverse = vi.fn(() => new Promise<never>(() => undefined));
    const service = new JobCardService(repository, undefined, undefined, {
      enabled: true,
      reverseGeocoder: { reverse },
      reverseGeocoderTimeoutMs: 1,
    });

    await service.start(staff, 'job-1', { ...input, locationCapture: captured });

    expect(reverse).toHaveBeenCalledOnce();
    expect(repository.locationAppends[0]?.capture)
      .toMatchObject({ outcome: 'CAPTURED', geocodingStatus: 'FAILED' });
  });

  it('rolls back transition and activity when location append fails', async () => {
    const { repository, service } = enabledService();
    repository.failLocation = true;

    await expect(service.start(staff, 'job-1', { ...input, locationCapture: captured }))
      .rejects.toThrow('location failed');
    expect(repository.job).toMatchObject({ status: 'ACCEPTED', version: 1 });
    expect(repository.activities).toEqual([]);
    expect(repository.locationAppends).toEqual([]);
  });

  it('may call provider after preflight but commits nothing on a transaction race', async () => {
    const { repository, reverse, service } = enabledService();
    repository.beforeCriticalWork = () => {
      repository.job = { ...repository.job, version: 2, status: 'IN_PROGRESS' };
    };

    await expect(service.start(staff, 'job-1', { ...input, locationCapture: captured }))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(reverse).toHaveBeenCalledOnce();
    expect(repository.activities).toEqual([]);
    expect(repository.locationAppends).toEqual([]);
  });
});

describe('JobCardService realtime event emission', () => {
  function withPublisher() {
    const repository = new MemoryJobCardRepository();
    const published: RealtimeEventRecord[] = [];
    const publisher: RealtimeEventPublisher = {
      publish(event) {
        published.push(event);
      },
    };
    const service = new JobCardService(
      repository,
      () => new Date('2026-07-19T14:30:00.000Z'),
      publisher,
    );
    return { repository, published, service };
  }

  it('persists and publishes a covered event after successful commit', async () => {
    const { repository, published, service } = withPublisher();
    await service.start(staff, 'job-1', input);

    expect(repository.realtimeEvents).toHaveLength(1);
    expect(repository.realtimeEvents[0]).toMatchObject({
      type: 'job.started',
      entityId: 'job-1',
      sourceActivityId: 'activity-1',
    });
    expect(published).toEqual(repository.realtimeEvents);
  });

  it('does not publish an idempotent replay', async () => {
    const { repository, published, service } = withPublisher();
    repository.nextCriticalResult = 'replay';

    await service.start(staff, 'job-1', input);

    expect(published).toEqual([]);
  });

  it('does not persist or publish excluded note events', async () => {
    const { repository, published, service } = withPublisher();
    await service.addNote(staff, 'job-1', {
      clientActionId: 'note-action',
      note: 'Kapıya bırakıldı.',
    });

    expect(repository.realtimeEvents).toEqual([]);
    expect(published).toEqual([]);
  });

  it('persists notification drafts before publishing an approval submission event', async () => {
    const { repository, published, service } = withPublisher();
    repository.job = {
      ...repository.job,
      type: 'GENERAL_TASK',
      customerId: null,
    };

    await service.start(staff, 'job-1', input);
    await service.submitForApproval(staff, 'job-1', {
      expectedVersion: 2,
      clientActionId: 'submit-action',
      note: 'Görev tamamlandı.',
    });

    expect(repository.notificationAppends).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        sourceRealtimeEventId: 2n,
        drafts: expect.arrayContaining([
          expect.objectContaining({
            recipientUserId: 'admin-1',
            kind: 'job.awaiting_approval',
          }),
          expect.objectContaining({
            recipientUserId: 'manager-1',
            kind: 'job.awaiting_approval',
          }),
        ]),
      }),
    ]);
    const submitted = published.find((event) => event.type === 'job.submitted_for_approval');
    expect(submitted?.resourceKeys).toContain('notifications');
  });
});
