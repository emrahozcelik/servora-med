import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getDemoDataset,
  parseDemoDatasetPreview,
  parseDemoDatasetPurgeResponse,
  previewDemoDataset,
  purgeDemoDataset,
} from '../src/services/demo-data-api';

const dataset = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'org-1',
  datasetKey: 'servora-demo',
  seedVersion: 'r1',
  status: 'ACTIVE',
  createdAt: '2026-08-24T10:00:00.000Z',
  createdBy: 'admin-1',
  purgedAt: null,
};

const affectedCounts = {
  users: 1, staffProfiles: 1, customers: 1, contacts: 1, products: 1, jobCards: 1,
  deliveryItems: 0, notes: 0, confidentialNotes: 0, activities: 1, followUps: 0,
  calendarEvents: 0, conversations: 0, messages: 0, notifications: 0, reminders: 0,
  realtimeEvents: 0,
};

const approvedIdentity = {
  datasetId: dataset.id,
  datasetKey: dataset.datasetKey,
  seedVersion: dataset.seedVersion,
  planHash: 'a'.repeat(64),
};

function purgeResponse(overrides: Record<string, unknown> = {}) {
  return {
    operationId: '22222222-2222-4222-8222-222222222222',
    status: 'COMPLETED',
    dataset: {
      ...dataset,
      status: 'PURGED',
      purgedAt: '2026-08-24T10:05:00.000Z',
    },
    datasetKey: dataset.datasetKey,
    seedVersion: dataset.seedVersion,
    planHash: 'a'.repeat(64),
    affectedCounts,
    retained: { auditActorDetaches: 1, datasetCreatorDetached: true },
    completedAt: '2026-08-24T10:05:00.000Z',
    ...overrides,
  };
}

describe('demo data API contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses typed preview counts, blockers, safety and plan hash', () => {
    const result = parseDemoDatasetPreview({
      dataset,
      organization: { id: 'org-1', name: 'Organization One' },
      affectedCounts: {
        users: 1, staffProfiles: 1, customers: 1, contacts: 1, products: 1, jobCards: 1,
        deliveryItems: 0, notes: 0, confidentialNotes: 0, activities: 1, followUps: 0,
        calendarEvents: 0, conversations: 0, messages: 0, notifications: 0, reminders: 0,
        realtimeEvents: 0,
      },
      blockers: [{
        code: 'DEMO_USER_TO_BUSINESS_JOB',
        message: 'Demo personel gerçek JobCard\'a atanmış.',
        sourceType: 'USER', sourceId: 'staff-1', relatedType: 'JOB_CARD', relatedId: 'job-1',
      }],
      safeToPurge: false,
      planHash: 'a'.repeat(64),
    });

    expect(result.safeToPurge).toBe(false);
    expect(result.affectedCounts.jobCards).toBe(1);
    expect(result.blockers[0]?.code).toBe('DEMO_USER_TO_BUSINESS_JOB');
    expect(result.planHash).toBe('a'.repeat(64));
  });

  it('parses a completed purge receipt for the approved dataset and plan', () => {
    const result = parseDemoDatasetPurgeResponse(purgeResponse(), approvedIdentity);

    expect(result.status).toBe('COMPLETED');
    expect(result.dataset.status).toBe('PURGED');
    expect(result.dataset.purgedAt).toBe('2026-08-24T10:05:00.000Z');
    expect(result.affectedCounts.jobCards).toBe(1);
  });

  it('rejects a purge receipt for a different dataset', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse(), {
      ...approvedIdentity,
      datasetId: '33333333-3333-4333-8333-333333333333',
    })).toThrowError(/dataset\.id/);
  });

  it('rejects a purge receipt for a different approved plan', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse(), {
      ...approvedIdentity,
      planHash: 'b'.repeat(64),
    })).toThrowError(/planHash/);
  });

  it('rejects a completed purge receipt whose dataset is still active', () => {
    expect(() => parseDemoDatasetPurgeResponse(
      purgeResponse({ dataset }),
      approvedIdentity,
    )).toThrowError(/dataset\.status/);
  });

  it('rejects a purged dataset receipt without a purge timestamp', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse({
      dataset: { ...dataset, status: 'PURGED', purgedAt: null },
    }), approvedIdentity)).toThrowError(/purgedAt/);
  });

  it('posts the approved plan and client action exactly once', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(purgeResponse()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    await purgeDemoDataset(dataset.id, {
      clientActionId: '44444444-4444-4444-8444-444444444444',
      planHash: 'a'.repeat(64),
    }, {
      datasetKey: dataset.datasetKey,
      seedVersion: dataset.seedVersion,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/demo-datasets/${dataset.id}/purge`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientActionId: '44444444-4444-4444-8444-444444444444',
          planHash: 'a'.repeat(64),
        }),
        credentials: 'include',
      },
    );
  });

  it('rejects receipt identity fields that disagree with the dataset tombstone', () => {
    expect(() => parseDemoDatasetPurgeResponse(
      purgeResponse({ datasetKey: 'other-demo' }),
      approvedIdentity,
    )).toThrowError(/datasetKey/);
  });

  it('rejects a receipt whose internally consistent identity differs from the approval snapshot', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse({
      dataset: { ...dataset, datasetKey: 'other-demo', status: 'PURGED', purgedAt: '2026-08-24T10:05:00.000Z' },
      datasetKey: 'other-demo',
    }), approvedIdentity)).toThrowError(/dataset\.datasetKey/);
  });

  it('rejects a purge receipt whose operation is not completed', () => {
    expect(() => parseDemoDatasetPurgeResponse(
      purgeResponse({ status: 'PROCESSING' }),
      approvedIdentity,
    )).toThrowError(/status/);
  });

  it('rejects negative and fractional affected counts in a purge receipt', () => {
    for (const invalidCount of [-1, 1.5]) {
      expect(() => parseDemoDatasetPurgeResponse(purgeResponse({
        affectedCounts: { ...affectedCounts, users: invalidCount },
      }), approvedIdentity)).toThrowError(/affectedCounts\.users/);
    }
  });

  it('rejects an invalid retained audit detach count', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse({
      retained: { auditActorDetaches: -1, datasetCreatorDetached: false },
    }), approvedIdentity)).toThrowError(/retained\.auditActorDetaches/);
  });

  it('rejects a preview whose safety flag disagrees with its blockers', () => {
    expect(() => parseDemoDatasetPreview({
      dataset,
      organization: { id: 'org-1', name: 'Organization One' },
      affectedCounts,
      blockers: [{
        code: 'DEMO_USER_TO_BUSINESS_JOB',
        message: 'Blocked',
        sourceType: 'USER',
        sourceId: 'staff-1',
        relatedType: 'JOB_CARD',
        relatedId: 'job-1',
      }],
      safeToPurge: true,
      planHash: 'a'.repeat(64),
    })).toThrowError(/safeToPurge/);
  });

  it('rejects a preview returned for a different dataset than requested', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      dataset: { ...dataset, id: '33333333-3333-4333-8333-333333333333' },
      organization: { id: 'org-1', name: 'Organization One' },
      affectedCounts,
      blockers: [],
      safeToPurge: true,
      planHash: 'a'.repeat(64),
    }), { status: 200 })));

    await expect(previewDemoDataset(dataset.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('rejects a reconciled dataset whose identity or tombstone state is invalid', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...dataset,
        id: '33333333-3333-4333-8333-333333333333',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ...dataset,
        status: 'PURGED',
        purgedAt: null,
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getDemoDataset(dataset.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(getDemoDataset(dataset.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
