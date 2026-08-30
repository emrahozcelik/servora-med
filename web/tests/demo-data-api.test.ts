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
    datasetId: dataset.id,
    datasetKey: dataset.datasetKey,
    seedVersion: dataset.seedVersion,
    planHash: 'a'.repeat(64),
    affectedCounts,
    retained: { auditActorDetaches: 1 },
    completedAt: '2026-08-24T10:05:00.000Z',
    ...overrides,
  };
}

function previewResponse(overrides: Record<string, unknown> = {}) {
  return {
    dataset,
    organization: { id: 'org-1', name: 'Organization One' },
    affectedCounts,
    blockers: [],
    safeToPurge: true,
    planHash: 'a'.repeat(64),
    ...overrides,
  };
}

describe('demo data API contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses typed preview counts, blockers, safety and plan hash', () => {
    const result = parseDemoDatasetPreview(previewResponse({
      blockers: [{
        code: 'DEMO_USER_TO_BUSINESS_JOB',
        message: 'Demo personel gerçek JobCard\'a atanmış.',
        sourceType: 'USER', sourceId: 'staff-1', relatedType: 'JOB_CARD', relatedId: 'job-1',
      }],
      safeToPurge: false,
    }));

    expect(result.safeToPurge).toBe(false);
    expect(result.affectedCounts.jobCards).toBe(1);
    expect(result.blockers[0]?.code).toBe('DEMO_USER_TO_BUSINESS_JOB');
    expect(result.planHash).toBe('a'.repeat(64));
    expect(result.dataset.status).toBe('ACTIVE');
  });

  it('parses a completed technical receipt without a retained dataset tombstone', () => {
    const result = parseDemoDatasetPurgeResponse(purgeResponse(), approvedIdentity);

    expect(result.status).toBe('COMPLETED');
    expect(result.datasetId).toBe(dataset.id);
    expect(result.affectedCounts.jobCards).toBe(1);
    expect(result.retained).toEqual({ auditActorDetaches: 1 });
    expect(result).not.toHaveProperty('dataset');
  });

  it('rejects a receipt for a different dataset', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse({
      datasetId: '33333333-3333-4333-8333-333333333333',
    }), approvedIdentity)).toThrowError(/datasetId/);
  });

  it('rejects a receipt for a different approved plan', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse(), {
      ...approvedIdentity,
      planHash: 'b'.repeat(64),
    })).toThrowError(/planHash/);
  });

  it('rejects the legacy dataset tombstone receipt shape', () => {
    expect(() => parseDemoDatasetPurgeResponse({
      operationId: '22222222-2222-4222-8222-222222222222',
      status: 'COMPLETED',
      dataset: { ...dataset, status: 'PURGED' },
      datasetKey: dataset.datasetKey,
      seedVersion: dataset.seedVersion,
      planHash: 'a'.repeat(64),
      affectedCounts,
      retained: { auditActorDetaches: 1 },
      completedAt: '2026-08-24T10:05:00.000Z',
    }, approvedIdentity)).toThrowError(/datasetId/);
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

  it('rejects receipt identity fields that disagree with the approval snapshot', () => {
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse({ datasetKey: 'other-demo' }), approvedIdentity))
      .toThrowError(/datasetKey/);
    expect(() => parseDemoDatasetPurgeResponse(purgeResponse({ seedVersion: 'other-seed' }), approvedIdentity))
      .toThrowError(/seedVersion/);
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
      retained: { auditActorDetaches: -1 },
    }), approvedIdentity)).toThrowError(/retained\.auditActorDetaches/);
  });

  it('rejects a preview whose safety flag disagrees with its blockers', () => {
    expect(() => parseDemoDatasetPreview(previewResponse({
      blockers: [{
        code: 'DEMO_USER_TO_BUSINESS_JOB', message: 'Blocked', sourceType: 'USER',
        sourceId: 'staff-1', relatedType: 'JOB_CARD', relatedId: 'job-1',
      }],
      safeToPurge: true,
    }))).toThrowError(/safeToPurge/);
  });

  it('rejects a preview returned for a different dataset than requested', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(previewResponse({
      dataset: { ...dataset, id: '33333333-3333-4333-8333-333333333333' },
    })), { status: 200 })));

    await expect(previewDemoDataset(dataset.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('does not accept a PURGED dataset from the active detail endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...dataset,
      status: 'PURGED',
    }), { status: 200 })));

    await expect(getDemoDataset(dataset.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
