import { describe, expect, it } from 'vitest';

import { parseDemoDatasetPreview } from '../src/services/demo-data-api';

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

describe('demo data API contract', () => {
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
});
