import { describe, expect, it } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import { DemoDatasetService } from '../src/modules/demo-data/service.js';
import type {
  DemoDatasetImpactCounts,
  DemoDatasetPreviewData,
  DemoDatasetRepository,
} from '../src/modules/demo-data/types.js';

const admin: SafeUser = {
  id: 'admin-1',
  organizationId: 'org-1',
  name: 'Admin',
  email: 'admin@example.com',
  role: 'ADMIN',
  mustChangePassword: false,
  isActive: true,
  version: 1,
};

const counts: DemoDatasetImpactCounts = {
  users: 2,
  staffProfiles: 1,
  customers: 1,
  contacts: 1,
  products: 1,
  jobCards: 1,
  deliveryItems: 0,
  notes: 0,
  confidentialNotes: 0,
  activities: 1,
  followUps: 0,
  calendarEvents: 0,
  conversations: 0,
  messages: 0,
  notifications: 0,
  reminders: 0,
  realtimeEvents: 0,
};

const previewData: DemoDatasetPreviewData = {
  dataset: {
    id: 'dataset-1',
    organizationId: 'org-1',
    datasetKey: 'servora-demo',
    seedVersion: 'r1',
    status: 'ACTIVE',
    createdAt: new Date('2026-08-24T10:00:00.000Z'),
    createdBy: 'admin-1',
    purgedAt: null,
  },
  organizationName: 'Demo Organization',
  affectedCounts: counts,
  blockers: [],
  planKeys: ['CUSTOMER:customer-1', 'JOB_CARD:job-1'],
};

class MemoryDemoDatasetRepository implements DemoDatasetRepository {
  constructor(private readonly data: DemoDatasetPreviewData = previewData) {}
  async listDatasets() { return [this.data.dataset]; }
  async findDataset() { return this.data.dataset; }
  async getPreviewData(): Promise<DemoDatasetPreviewData | null> { return this.data; }
  async purge(): Promise<never> { throw new Error('not used in preview tests'); }
}

describe('DemoDatasetService', () => {
  it('returns a stable planHash for an unchanged demo graph', async () => {
    const service = new DemoDatasetService(new MemoryDemoDatasetRepository());

    const first = await service.preview(admin, 'dataset-1');
    const second = await service.preview(admin, 'dataset-1');

    expect(first).toMatchObject({
      safeToPurge: true,
      affectedCounts: counts,
      blockers: [],
    });
    expect(first.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.planHash).toBe(first.planHash);
  });

  it('canonicalizes count field order before hashing', async () => {
    const reorderedCounts = Object.fromEntries(
      Object.entries(counts).reverse(),
    ) as DemoDatasetImpactCounts;
    const result = await new DemoDatasetService(new MemoryDemoDatasetRepository({
      ...previewData,
      affectedCounts: reorderedCounts,
    })).preview(admin, 'dataset-1');
    const baseline = await new DemoDatasetService(new MemoryDemoDatasetRepository()).preview(admin, 'dataset-1');

    expect(result.planHash).toBe(baseline.planHash);
  });

  it('changes the planHash when graph identities change but counts stay the same', async () => {
    const replacement: DemoDatasetPreviewData = {
      ...previewData,
      planKeys: ['CUSTOMER:customer-1', 'JOB_CARD:job-2'],
    };
    const baseline = await new DemoDatasetService(new MemoryDemoDatasetRepository()).preview(admin, 'dataset-1');
    const result = await new DemoDatasetService(new MemoryDemoDatasetRepository(replacement)).preview(admin, 'dataset-1');

    expect(result.affectedCounts).toEqual(baseline.affectedCounts);
    expect(result.blockers).toEqual(baseline.blockers);
    expect(result.planHash).not.toBe(baseline.planHash);
  });

  it.each(['MANAGER', 'STAFF'] as const)('denies %s before repository access', async (role) => {
    const repository = new MemoryDemoDatasetRepository();
    const service = new DemoDatasetService(repository);
    const actor = { ...admin, role };

    await expect(service.preview(actor, 'dataset-1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it.each(['MANAGER', 'STAFF'] as const)('denies %s before purge repository access', async (role) => {
    const service = new DemoDatasetService(new MemoryDemoDatasetRepository());
    const actor = { ...admin, role };

    await expect(service.purge(actor, 'dataset-1', {
      clientActionId: '33333333-3333-4333-8333-333333333333',
      planHash: 'a'.repeat(64),
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('blocks a mixed graph and changes the planHash', async () => {
    const mixed: DemoDatasetPreviewData = {
      ...previewData,
      blockers: [{
        code: 'DEMO_TO_BUSINESS_JOB',
        message: 'Demo personel gerçek iş kaydına bağlı.',
        sourceType: 'USER',
        sourceId: 'staff-1',
        relatedType: 'JOB_CARD',
        relatedId: 'business-job-1',
      }],
    };
    const service = new DemoDatasetService(new MemoryDemoDatasetRepository(mixed));
    const baseline = await new DemoDatasetService(new MemoryDemoDatasetRepository()).preview(admin, 'dataset-1');

    const result = await service.preview(admin, 'dataset-1');

    expect(result.safeToPurge).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.planHash).not.toBe(baseline.planHash);
  });

  it('does not change the planHash when only a blocker message is localized differently', async () => {
    const first = await new DemoDatasetService(new MemoryDemoDatasetRepository({
      ...previewData,
      blockers: [{
        code: 'DEMO_TO_BUSINESS_JOB',
        message: 'Demo personel gerçek işe bağlı.',
        sourceType: 'USER',
        sourceId: 'staff-1',
        relatedType: 'JOB_CARD',
        relatedId: 'business-job-1',
      }],
    })).preview(admin, 'dataset-1');
    const second = await new DemoDatasetService(new MemoryDemoDatasetRepository({
      ...previewData,
      blockers: [{
        code: 'DEMO_TO_BUSINESS_JOB',
        message: 'Demo personel bir BUSINESS JobCard kaydına bağlı.',
        sourceType: 'USER',
        sourceId: 'staff-1',
        relatedType: 'JOB_CARD',
        relatedId: 'business-job-1',
      }],
    })).preview(admin, 'dataset-1');

    expect(second.planHash).toBe(first.planHash);
  });
});
