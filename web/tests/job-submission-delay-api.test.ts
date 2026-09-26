import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchOverdueIncidents,
  fetchSubmissionDelay,
  parsePersistedJobCardListItem,
  sendSubmissionReminder,
} from '../src/jobs/jobs-api';

afterEach(() => vi.unstubAllGlobals());

const related = (id: string, name: string) => ({ id, name });

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const listItem = {
  id: 'job-1', type: 'PRODUCT_DELIVERY', status: 'IN_PROGRESS', version: 7,
  engagementKind: null,
  title: 'Klinik teslimi', priority: 'urgent', dueDate: '2026-07-20',
  scheduledAt: '2026-07-20T09:00:00.000Z',
  createdAt: '2026-07-10T10:00:00.000Z', updatedAt: '2026-07-13T10:00:00.000Z',
  staffCompletedAt: null, customer: related('c1', 'ABC Klinik'),
  contact: related('ct1', 'Dr. Deniz'), assignee: related('s1', 'Ayşe Personel'),
  deliveryItemCount: 2,
  allowedCommands: ['SUBMIT_FOR_APPROVAL', 'CANCEL'],
};

const breachedAt = '2026-07-13T07:30:00.000Z';

const openSignal = {
  delayType: 'LATE_SUBMISSION',
  episodeNo: 1,
  deadlineAt: '2026-07-13T07:30:00.000Z',
  breachedAt,
  elapsedSeconds: 8_040,
  accountableStaff: { id: 's1', name: 'Ayşe Personel' },
};

const incident = {
  id: 'incident-1',
  delayType: 'LATE_SUBMISSION',
  episodeNo: 1,
  scheduleRevisionNo: 1,
  deadlineAt: '2026-07-13T07:30:00.000Z',
  breachedAt,
  accountableRole: 'STAFF',
  accountableSource: 'ASSIGNMENT_AT_BREACH',
  accountableUser: { id: 's1', name: 'Ayşe Personel' },
  source: 'SCANNER',
  recordedAt: '2026-07-13T07:31:00.000Z',
  recoveredAt: '2026-07-13T09:30:00.000Z',
  recoveryActor: { id: 's1', name: 'Ayşe Personel' },
  totalDelaySeconds: 7_200,
  managerReminder: {
    sentAt: '2026-07-13T08:30:00.000Z',
    actor: { id: 'm1', name: 'Murat Yönetici' },
    target: { id: 's1', name: 'Ayşe Personel' },
  },
  postReminderDelaySeconds: 3_600,
};

describe('OVR-4 submission-delay transport', () => {
  it('returns null when the server reports no open delay', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ open: null })));
    await expect(fetchSubmissionDelay('job-1')).resolves.toBeNull();
  });

  it('parses the open signal exactly as the server measured it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ open: openSignal }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchSubmissionDelay('job-1')).resolves.toEqual(openSignal);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards/job-1/submission-delay',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it('refuses a delay type this endpoint does not own', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      json({ open: { ...openSignal, delayType: 'LATE_START' } }),
    ));
    await expect(fetchSubmissionDelay('job-1')).rejects.toThrowError(/delayType/);
  });

  it('refuses an open signal without the server-measured elapsed seconds', async () => {
    const { elapsedSeconds: _dropped, ...withoutElapsed } = openSignal;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ open: withoutElapsed })));
    await expect(fetchSubmissionDelay('job-1')).rejects.toThrowError(/elapsedSeconds/);
  });

  it('refuses an envelope that carries more than the open field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ open: null, total: 1 })));
    await expect(fetchSubmissionDelay('job-1')).rejects.toThrowError(/submissionDelay/);
  });

  it('parses the management history and keeps unmeasurable values null', async () => {
    // A pre-OVR-4 episode: still open, and no manager ever reminded.
    const legacyOpen = {
      ...incident,
      id: 'incident-0',
      recoveredAt: null,
      recoveryActor: null,
      totalDelaySeconds: null,
      managerReminder: null,
      postReminderDelaySeconds: null,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [incident, legacyOpen], total: 2, limit: 25, offset: 0,
    })));

    const page = await fetchOverdueIncidents('job-1');
    expect(page.total).toBe(2);
    expect(page.items[0]).toEqual(incident);
    expect(page.items[1]!.totalDelaySeconds).toBeNull();
    expect(page.items[1]!.managerReminder).toBeNull();
    expect(page.items[1]!.postReminderDelaySeconds).toBeNull();
    expect(page.items[1]!.recoveredAt).toBeNull();
  });

  it('accepts a reminder receipt whose actor name is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [{
        ...incident,
        managerReminder: { ...incident.managerReminder, actor: { id: 'm1', name: null } },
      }],
      total: 1, limit: 25, offset: 0,
    })));
    const page = await fetchOverdueIncidents('job-1');
    expect(page.items[0]!.managerReminder!.actor).toEqual({ id: 'm1', name: null });
  });

  it('posts the client action id and validates the durable receipt', async () => {
    const receipt = {
      jobCardId: 'job-1', incidentId: 'incident-1', reminderId: 'reminder-1',
      sentAt: '2026-07-13T08:30:00.000Z', targetUserId: 's1',
    };
    const fetchMock = vi.fn().mockResolvedValue(json(receipt));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendSubmissionReminder('job-1', 'action-1')).resolves.toEqual(receipt);
    const [path, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(path).toBe('/api/job-cards/job-1/submission-reminder');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ clientActionId: 'action-1' });
  });

  it('surfaces the fail-closed server refusal instead of inventing a receipt', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Bu iş için açık bir onaya gönderme gecikmesi bulunmuyor.',
      code: 'NO_OPEN_SUBMISSION_DELAY',
    }, 409)));
    await expect(sendSubmissionReminder('job-1', 'action-1')).rejects.toMatchObject({
      status: 409, code: 'NO_OPEN_SUBMISSION_DELAY',
    });
  });

  it('refuses a receipt missing an identity field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1', incidentId: 'incident-1',
      sentAt: '2026-07-13T08:30:00.000Z', targetUserId: 's1',
    })));
    await expect(sendSubmissionReminder('job-1', 'action-1')).rejects.toThrowError(/reminderId/);
  });

  it('carries the derived delay snapshot only on the surface that sends it', () => {
    const withDelay = parsePersistedJobCardListItem({
      ...listItem,
      submissionDelay: { breachedAt, elapsedSeconds: 8_040 },
    });
    expect(withDelay.submissionDelay).toEqual({ breachedAt, elapsedSeconds: 8_040 });

    // Absent means "this surface does not evaluate submission delays"...
    expect(parsePersistedJobCardListItem(listItem).submissionDelay).toBeUndefined();
    // ...which is a different statement from the explicit "no open delay".
    expect(parsePersistedJobCardListItem({ ...listItem, submissionDelay: null }).submissionDelay).toBeNull();
  });

  it('refuses a snapshot whose elapsed value is not a whole non-negative count', () => {
    expect(() => parsePersistedJobCardListItem({
      ...listItem,
      submissionDelay: { breachedAt, elapsedSeconds: -1 },
    })).toThrowError(/elapsedSeconds/);
    expect(() => parsePersistedJobCardListItem({
      ...listItem,
      submissionDelay: { breachedAt: 'yesterday', elapsedSeconds: 10 },
    })).toThrowError(/breachedAt/);
  });
});
