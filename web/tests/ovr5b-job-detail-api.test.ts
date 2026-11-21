import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getJobCard,
  patchJobCard,
  requestJobCardRevision,
} from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

afterEach(() => vi.unstubAllGlobals());

const related = (id: string, name: string) => ({ id, name });

const job = {
  id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
  type: 'GENERAL_TASK', status: 'REVISION_REQUESTED', version: 4,
  engagementKind: null,
  title: 'Teklif dönüşünü takip et', description: null, customerId: null, contactId: null,
  assignedTo: 's1', createdBy: 'm1', priority: 'normal', dueDate: '2026-11-30',
  scheduledAt: null,
  assignee: related('s1', 'Ayşe Personel'), customer: null, contact: null,
  workflowContext,
  followUpContext: null,
  followUpProposal: null,
  earlyStartAuthorization: null,
  submitLocationComparison: null,
  changeRequest: null,
  assignmentOffer: null,
  hasOpenOverdueIncident: true,
  correctionDueAt: '2026-11-24T10:00:00.000Z',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('OVR-5 detail DTO fields', () => {
  it('parses the open-lateness flag and the correction deadline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(job)));
    const parsed = await getJobCard('job-1');
    expect(parsed.hasOpenOverdueIncident).toBe(true);
    expect(parsed.correctionDueAt).toBe('2026-11-24T10:00:00.000Z');
  });

  it('falls back to false/null for a previous backend and accepts explicit nulls', async () => {
    const { hasOpenOverdueIncident: _flag, correctionDueAt: _deadline, ...withoutFields } = job;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(withoutFields)));
    await expect(getJobCard('job-1')).resolves.toMatchObject({
      hasOpenOverdueIncident: false,
      correctionDueAt: null,
    });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      ...job,
      hasOpenOverdueIncident: false,
      correctionDueAt: null,
    })));
    await expect(getJobCard('job-1')).resolves.toMatchObject({
      hasOpenOverdueIncident: false,
      correctionDueAt: null,
    });
  });

  it.each([
    ['non-boolean flag', { hasOpenOverdueIncident: 'true' }],
    ['non-canonical correction instant', { correctionDueAt: '2026-11-24T10:00:00Z' }],
    ['empty correction instant', { correctionDueAt: '' }],
  ])('rejects a detail with %s', async (_name, candidate) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ ...job, ...candidate })));
    await expect(getJobCard('job-1')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      status: 0,
    });
  });
});

describe('OVR-5 writers body contract', () => {
  it('sends correctionDueAt with a revision request and omits it when absent', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ ...job }))
      .mockResolvedValueOnce(json({ ...job }));
    vi.stubGlobal('fetch', fetchMock);

    await requestJobCardRevision('job-1', {
      clientActionId: 'attempt-1',
      expectedVersion: 4,
      revisionReason: 'Lot numarasını doğrulayın.',
      correctionDueAt: '2026-11-25T09:00:00.000Z',
    });
    const withCorrection = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(withCorrection).toMatchObject({
      clientActionId: 'attempt-1',
      revisionReason: 'Lot numarasını doğrulayın.',
      correctionDueAt: '2026-11-25T09:00:00.000Z',
    });

    await requestJobCardRevision('job-1', {
      clientActionId: 'attempt-2',
      expectedVersion: 4,
      revisionReason: 'Lot numarasını doğrulayın.',
    });
    const withoutCorrection = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body));
    expect(withoutCorrection).not.toHaveProperty('correctionDueAt');
  });

  it('sends deadlineExtensionReason and changeRequestResolution in one patch body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ ...job, version: 5 }));
    vi.stubGlobal('fetch', fetchMock);

    await patchJobCard('job-1', {
      expectedVersion: 4,
      dueDate: '2026-12-05',
      deadlineExtensionReason: 'Müşteri yeni teslim tarihini onayladı.',
      changeRequestResolution: {
        changeRequestId: 'request-1',
        resolution: 'RESCHEDULED',
      },
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({
      expectedVersion: 4,
      dueDate: '2026-12-05',
      deadlineExtensionReason: 'Müşteri yeni teslim tarihini onayladı.',
      changeRequestResolution: {
        changeRequestId: 'request-1',
        resolution: 'RESCHEDULED',
      },
    });
  });
});
