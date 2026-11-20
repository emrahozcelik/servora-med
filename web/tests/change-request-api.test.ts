import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createChangeRequest,
  getJobCard,
  getSubmissionLateness,
  listOpenChangeRequests,
  resolveChangeRequest,
  type OpenChangeRequestItem,
} from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

afterEach(() => vi.unstubAllGlobals());

const related = (id: string, name: string) => ({ id, name });

const changeRequest = {
  id: 'request-1',
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Müşteri kliniği bugün kapalı, teslim yapılamadı.',
  requestedAt: '2026-11-20T09:15:00.000Z',
  requestedBy: related('s1', 'Ayşe Personel'),
};

const job = {
  id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
  type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 3,
  engagementKind: null,
  title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null,
  assignedTo: 's1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
  scheduledAt: '2026-11-20T11:00:00.000Z',
  assignee: related('s1', 'Ayşe Personel'), customer: related('c1', 'ABC Klinik'),
  contact: null,
  workflowContext,
  followUpContext: null,
  followUpProposal: null,
  earlyStartAuthorization: null,
  submitLocationComparison: null,
  changeRequest: null,
};

const listItem: OpenChangeRequestItem = {
  changeRequestId: 'request-1',
  jobCardId: 'job-1',
  jobTitle: 'Klinik teslimi',
  jobType: 'PRODUCT_DELIVERY',
  jobStatus: 'ACCEPTED',
  reasonCode: 'CUSTOMER_POSTPONED',
  reasonText: 'Müşteri kliniği bugün kapalı, teslim yapılamadı.',
  requestedAt: '2026-11-20T09:15:00.000Z',
  requestedBy: related('s1', 'Ayşe Personel'),
  customer: related('c1', 'ABC Klinik'),
  jobPath: '/jobs/job-1',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('change request detail DTO', () => {
  it('parses the open request view and the two new allowed actions', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      ...job,
      changeRequest,
      workflowContext: {
        ...workflowContext,
        allowedCommands: ['CANCEL'],
        allowedActions: ['REQUEST_CHANGE', 'RESOLVE_CHANGE_REQUEST'],
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const parsed = await getJobCard('job-1');
    expect(parsed.changeRequest).toEqual(changeRequest);
    expect(parsed.workflowContext.allowedActions).toEqual(['REQUEST_CHANGE', 'RESOLVE_CHANGE_REQUEST']);
  });

  it('keeps null and absent change requests as "no open request"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...job, changeRequest: null })));
    await expect(getJobCard('job-1')).resolves.toMatchObject({ changeRequest: null });

    // A previous backend keeps its old shape until the release is deployed.
    const { changeRequest: _omitted, ...withoutChangeRequest } = job;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(withoutChangeRequest)));
    await expect(getJobCard('job-1')).resolves.toMatchObject({ changeRequest: null });
  });

  it.each([
    ['unknown reason code', { ...changeRequest, reasonCode: 'CUSTOMER_FORGOT' }],
    ['extra key', { ...changeRequest, resolvedAt: '2026-11-20T10:00:00.000Z' }],
    ['non-canonical instant', { ...changeRequest, requestedAt: '2026-11-20T09:15:00Z' }],
    ['empty reason text', { ...changeRequest, reasonText: '' }],
    ['loose requester shape', { ...changeRequest, requestedBy: { id: 's1', name: 'Ayşe', role: 'STAFF' } }],
  ])('rejects a change request with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...job, changeRequest: candidate })));
    await expect(getJobCard('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 0 });
  });

  it('rejects an allowed action outside the contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      ...job,
      workflowContext: { ...workflowContext, allowedActions: ['REQUEST_CHANGE', 'DECLINE_ASSIGNMENT'] },
    })));
    await expect(getJobCard('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('submission lateness change-request snapshot', () => {
  const open = {
    incidentId: 'incident-1',
    delayType: 'LATE_SUBMISSION',
    episodeNo: 1,
    scheduleRevisionNo: 1,
    deadlineAt: '2026-11-20T10:00:00.000Z',
    breachedAt: '2026-11-20T10:30:00.000Z',
    elapsedSeconds: 1800,
    accountableUser: related('s1', 'Ayşe Personel'),
    accountableRole: 'STAFF',
    staffReminderSentAt: null,
    escalationSentAt: null,
    manualReminderSentAt: null,
    manualReminderCount: 0,
  };

  it('parses the open change-request instant and its null form', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      open: { ...open, changeRequestOpenSince: '2026-11-20T10:40:00.000Z' },
    })));
    await expect(getSubmissionLateness('job-1')).resolves.toMatchObject({
      open: { changeRequestOpenSince: '2026-11-20T10:40:00.000Z' },
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ open: { ...open, changeRequestOpenSince: null } })));
    await expect(getSubmissionLateness('job-1')).resolves.toMatchObject({
      open: { changeRequestOpenSince: null },
    });
  });

  it('rejects an invalid or unexpected snapshot shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      open: { ...open, changeRequestOpenSince: '20.11.2026 10:40' },
    })));
    await expect(getSubmissionLateness('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      open: { ...open, changeRequestOpenSince: null, changeRequestResolvedAt: null },
    })));
    await expect(getSubmissionLateness('job-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('change request transport', () => {
  it('posts the exact create body to the job change-request path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1',
      changeRequestId: 'request-1',
      requestedAt: '2026-11-20T09:15:00.000Z',
    }, 201));
    vi.stubGlobal('fetch', fetchMock);

    await expect(createChangeRequest('job-1', {
      clientActionId: 'action-1',
      reasonCode: 'CUSTOMER_POSTPONED',
      reasonText: 'Müşteri erteledi.',
    })).resolves.toEqual({
      jobCardId: 'job-1',
      changeRequestId: 'request-1',
      requestedAt: '2026-11-20T09:15:00.000Z',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/job-cards/job-1/change-requests', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        clientActionId: 'action-1',
        reasonCode: 'CUSTOMER_POSTPONED',
        reasonText: 'Müşteri erteledi.',
      }),
    }));
  });

  it('rejects a create receipt that is not the contract shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1',
      changeRequestId: 'request-1',
      requestedAt: '2026-11-20T09:15:00.000Z',
      state: 'OPEN',
    })));
    await expect(createChangeRequest('job-1', {
      clientActionId: 'action-1', reasonCode: 'OTHER', reasonText: 'Diğer',
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('posts a rejection note and a linked job id in the exact shape', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'REJECTED',
        resolvedAt: '2026-11-20T10:00:00.000Z',
      }))
      .mockResolvedValueOnce(json({
        jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'LINKED_JOB_CREATED',
        resolvedAt: '2026-11-20T10:05:00.000Z',
      }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveChangeRequest('job-1', 'request-1', {
      clientActionId: 'resolve-1', resolution: 'REJECTED', note: 'Teslim yine planlandı.',
    })).resolves.toMatchObject({ resolution: 'REJECTED' });
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      clientActionId: 'resolve-1', resolution: 'REJECTED', note: 'Teslim yine planlandı.',
    });

    await expect(resolveChangeRequest('job-1', 'request-1', {
      clientActionId: 'resolve-2', resolution: 'LINKED_JOB_CREATED', linkedJobCardId: 'job-2',
    })).resolves.toMatchObject({ resolution: 'LINKED_JOB_CREATED' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/job-cards/job-1/change-requests/request-1/resolve');
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      clientActionId: 'resolve-2', resolution: 'LINKED_JOB_CREATED', linkedJobCardId: 'job-2',
    });
  });

  it('rejects a resolution receipt that disagrees with the request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1', changeRequestId: 'request-1', resolution: 'CORRECTED',
      resolvedAt: '2026-11-20T10:00:00.000Z',
    })));
    await expect(resolveChangeRequest('job-1', 'request-1', {
      clientActionId: 'resolve-1', resolution: 'RESCHEDULED',
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      jobCardId: 'job-1', changeRequestId: 'other-request', resolution: 'REJECTED',
      resolvedAt: '2026-11-20T10:00:00.000Z',
    })));
    await expect(resolveChangeRequest('job-1', 'request-1', {
      clientActionId: 'resolve-1', resolution: 'REJECTED', note: 'Not',
    })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('open change request list', () => {
  it('requests the management list with pagination and parses every item field', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      items: [listItem], total: 1, limit: 25, offset: 0,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listOpenChangeRequests({ limit: 25, offset: 0 })).resolves.toEqual({
      items: [listItem], total: 1, limit: 25, offset: 0,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/job-cards/change-requests/open?limit=25&offset=0',
      expect.objectContaining({ credentials: 'include' }),
    );
  });

  it.each([
    ['unknown job type', { ...listItem, jobType: 'SURVEY' }],
    ['unknown reason', { ...listItem, reasonCode: 'CUSTOMER_FORGOT' }],
    ['extra key', { ...listItem, resolution: 'CORRECTED' }],
    ['broken instant', { ...listItem, requestedAt: '2026-11-20' }],
    ['extra requester field', { ...listItem, requestedBy: { id: 's1', name: 'Ayşe', email: 'a@x' } }],
  ])('rejects a list item with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      items: [candidate], total: 1, limit: 25, offset: 0,
    })));
    await expect(listOpenChangeRequests()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
