import { describe, expect, it } from 'vitest';

import { createHash } from 'node:crypto';

import {
  jobCardCreateRequestHash,
  lifecycleRequestHash,
  meetingDetailsUpdateRequestHash,
  deliveryItemCreateRequestHash,
} from '../src/modules/job-cards/critical-action-request-hash.js';
import { normalizeExpiryDate } from '../src/modules/job-cards/delivery-input.js';
import { jobCardInvalidationRequestHash } from '../src/modules/job-cards/invalidation-input.js';

// Deterministic fixed-input digest captured from the exact base commit
// (1c0afb7) BEFORE the shared hash primitive refactor. The invalidation
// request identity must remain byte-compatible.
const INVALIDATION_COMPAT_VECTOR = {
  jobCardId: 'compat-vector-job-1',
  expectedVersion: 7,
  reasonCode: 'OTHER',
  note: 'Sabit uyumluluk vektörü',
};
const INVALIDATION_COMPAT_DIGEST = '7e7d83d4971f9ecfcd84a88c9041461a96cc869bbbbfb21afb8459ed7add4f09';

describe('JobCard critical-action request identity', () => {
  it('keeps the invalidation digest byte-compatible with the pre-refactor implementation', () => {
    const digest = jobCardInvalidationRequestHash(
      INVALIDATION_COMPAT_VECTOR.jobCardId,
      {
        clientActionId: 'unused-in-hash',
        expectedVersion: INVALIDATION_COMPAT_VECTOR.expectedVersion,
        reasonCode: INVALIDATION_COMPAT_VECTOR.reasonCode as never,
        note: INVALIDATION_COMPAT_VECTOR.note,
      },
    );
    const reference = createHash('sha256').update(JSON.stringify({
      operation: 'JOB_CARD_INVALIDATE:v1',
      jobCardId: INVALIDATION_COMPAT_VECTOR.jobCardId,
      expectedVersion: INVALIDATION_COMPAT_VECTOR.expectedVersion,
      reasonCode: INVALIDATION_COMPAT_VECTOR.reasonCode,
      note: INVALIDATION_COMPAT_VECTOR.note,
    })).digest('hex');
    expect(digest).toBe(INVALIDATION_COMPAT_DIGEST);
    expect(digest).toBe(reference);
  });

  it('lifecycle: same normalized identity hashes identically, different content does not', () => {
    const base = {
      command: 'CANCEL', jobCardId: 'job-1', expectedVersion: 3,
      note: null, revisionReason: null, cancelReason: 'Zamanlama değişti',
    };
    expect(lifecycleRequestHash(base)).toBe(lifecycleRequestHash({ ...base }));
    expect(lifecycleRequestHash(base))
      .not.toBe(lifecycleRequestHash({ ...base, cancelReason: 'Ürün tedarik edilemedi' }));
    expect(lifecycleRequestHash(base))
      .not.toBe(lifecycleRequestHash({ ...base, expectedVersion: 4 }));
    expect(lifecycleRequestHash(base))
      .not.toBe(lifecycleRequestHash({ ...base, command: 'REQUEST_REVISION' }));
    expect(lifecycleRequestHash(base))
      .not.toBe(lifecycleRequestHash({ ...base, jobCardId: 'job-2' }));
  });

  it('lifecycle: proposal absence vs explicit proposal vs auto-scheduled differ', () => {
    const base = {
      command: 'SUBMIT_FOR_APPROVAL', jobCardId: 'job-1', expectedVersion: 1,
      note: 'Not', revisionReason: null, cancelReason: null,
    };
    expect(lifecycleRequestHash(base)).not.toBe(lifecycleRequestHash({
      ...base,
      followUpProposal: { scheduledAt: '2026-09-20T10:00:00.000Z', type: 'SALES_MEETING', assignedTo: 'staff-1', followUpInstructions: 'Arayın' },
    }));
    expect(lifecycleRequestHash({
      ...base,
      followUpProposal: { type: 'SALES_MEETING', assignedTo: 'staff-1', followUpInstructions: 'Arayın' },
    })).not.toBe(lifecycleRequestHash({
      ...base,
      followUpProposal: { scheduledAt: '2026-09-20T10:00:00.000Z', type: 'SALES_MEETING', assignedTo: 'staff-1', followUpInstructions: 'Arayın' },
    }));
    // Semantically equivalent proposals normalize identically.
    expect(lifecycleRequestHash({
      ...base,
      followUpProposal: { scheduledAt: '2026-09-20T13:00:00.000Z', type: 'SALES_MEETING', assignedTo: 'staff-1', followUpInstructions: 'Arayın' },
    })).toBe(lifecycleRequestHash({
      ...base,
      followUpProposal: { scheduledAt: '2026-09-20T16:00:00.000+03:00', type: 'SALES_MEETING', assignedTo: 'staff-1', followUpInstructions: 'Arayın' },
    }));
  });

  it('lifecycle: location capture core participates; provider fields do not', () => {
    const base = {
      command: 'START', jobCardId: 'job-1', expectedVersion: 1,
      note: null, revisionReason: null, cancelReason: null,
    };
    const captured = {
      outcome: 'CAPTURED' as const, latitude: 41.0082, longitude: 28.9784,
      accuracyMeters: 12, capturedAt: new Date('2026-09-08T10:00:00.000Z'),
    };
    expect(lifecycleRequestHash({ ...base, locationCapture: null }))
      .not.toBe(lifecycleRequestHash({ ...base, locationCapture: captured }));
    expect(lifecycleRequestHash({ ...base, locationCapture: captured }))
      .not.toBe(lifecycleRequestHash({
        ...base, locationCapture: { ...captured, latitude: 39.9334 },
      }));
    // Geocoding enrichment must not change request identity.
    expect(lifecycleRequestHash({ ...base, locationCapture: captured })).toBe(
      lifecycleRequestHash({
        ...base,
        locationCapture: { ...captured, geocodingStatus: 'SUCCESS', city: 'İstanbul' },
      } as never),
    );
    expect(lifecycleRequestHash({
      ...base,
      locationCapture: { outcome: 'UNAVAILABLE', reason: 'PERMISSION_DENIED' },
    })).not.toBe(lifecycleRequestHash({
      ...base,
      locationCapture: { outcome: 'UNAVAILABLE', reason: 'TIMEOUT' },
    }));
  });

  it('create: every semantic field participates in the identity', () => {
    const base = {
      type: 'PRODUCT_DELIVERY', title: 'Teslim', description: null,
      customerId: 'c-1', contactId: null, assignedTo: 'staff-1',
      priority: 'normal', dueDate: null, scheduledAt: '2026-09-20T10:00:00.000Z',
      scheduledEndsAt: '2026-09-20T10:30:00.000Z', engagementKind: null,
      overrideReason: null,
    };
    expect(jobCardCreateRequestHash(base)).toBe(jobCardCreateRequestHash({ ...base }));
    for (const changed of [
      { title: 'Teslim 2' }, { scheduledAt: '2026-09-21T10:00:00.000Z' },
      { assignedTo: 'staff-2' }, { customerId: 'c-2' },
      { priority: 'high' }, { overrideReason: 'Müşteri talebi' },
      { description: 'Açıklama' },
    ]) {
      expect(jobCardCreateRequestHash(base))
        .not.toBe(jobCardCreateRequestHash({ ...base, ...changed }));
    }
  });

  it('meeting patch: field presence is semantic', () => {
    const omitted = {
      clientActionId: 'unused', expectedVersion: 2,
    } as never;
    const explicitNull = {
      clientActionId: 'unused', expectedVersion: 2, meetingSummary: null,
    } as never;
    expect(meetingDetailsUpdateRequestHash('job-1', omitted))
      .not.toBe(meetingDetailsUpdateRequestHash('job-1', explicitNull));
    expect(meetingDetailsUpdateRequestHash('job-1', omitted))
      .toBe(meetingDetailsUpdateRequestHash('job-1', omitted));
  });

  it('delivery expiry dates use one validated canonical date-only representation', () => {
    expect(normalizeExpiryDate('2026-9-1')).toBe('2026-09-01');
    expect(normalizeExpiryDate('2026-09-01')).toBe('2026-09-01');
    expect(normalizeExpiryDate(null)).toBeNull();
    expect(normalizeExpiryDate(undefined)).toBeNull();
    for (const value of ['0000-01-01', '2026-2-29', '2026-13-01', '2026-04-31', '2026-09-01T00:00:00Z']) {
      expect(() => normalizeExpiryDate(value)).toThrowError('Teslim ürünü bilgileri geçersiz.');
    }
    expect(normalizeExpiryDate('2028-2-29')).toBe('2028-02-29');
  });

  it('delivery expiry equivalents share identity while different dates do not', () => {
    const base = {
      expectedVersion: 4, productId: 'product-1', deliveryPurpose: 'SALE',
      deliveredAt: null, quantity: 2, lotNo: null, serialNo: null, deliveryNote: null,
    };
    expect(deliveryItemCreateRequestHash('job-1', { ...base, expiryDate: '2026-9-1' }))
      .toBe(deliveryItemCreateRequestHash('job-1', { ...base, expiryDate: '2026-09-01' }));
    expect(deliveryItemCreateRequestHash('job-1', { ...base, expiryDate: '2026-09-01' }))
      .not.toBe(deliveryItemCreateRequestHash('job-1', { ...base, expiryDate: '2026-09-02' }));
    const canonical = deliveryItemCreateRequestHash('job-1', { ...base, expiryDate: '2026-09-01' });
    expect(canonical).not.toBe(deliveryItemCreateRequestHash('job-1', {
      ...base, expiryDate: '2026-09-01', quantity: 3,
    }));
    expect(canonical).not.toBe(deliveryItemCreateRequestHash('job-1', {
      ...base, expiryDate: '2026-09-01', expectedVersion: 5,
    }));
  });

  it('approval follow-up hashes normalized defaults and equivalent values identically', () => {
    const base = {
      command: 'APPROVE', jobCardId: 'job-1', expectedVersion: 2,
      note: null, revisionReason: null, cancelReason: null,
    };
    const proposal = {
      type: 'SALES_MEETING' as const, assignedTo: 'staff-1',
      followUpInstructions: ' Arayın ', scheduledAt: '2026-09-20T13:00:00.000Z',
    };
    expect(lifecycleRequestHash({ ...base, approveFollowUp: { ...proposal } }))
      .toBe(lifecycleRequestHash({ ...base, approveFollowUp: {
        ...proposal, followUpInstructions: 'Arayın', priority: 'normal', dueDate: null,
      } }));
    expect(lifecycleRequestHash({ ...base, approveFollowUp: { ...proposal, dueDate: undefined } }))
      .toBe(lifecycleRequestHash({ ...base, approveFollowUp: { ...proposal, dueDate: null } }));
    expect(lifecycleRequestHash({ ...base, approveFollowUp: { ...proposal, scheduledAt: '2026-09-20T16:00:00.000+03:00' } }))
      .toBe(lifecycleRequestHash({ ...base, approveFollowUp: proposal }));
    expect(lifecycleRequestHash({ ...base, approveFollowUp: proposal }))
      .not.toBe(lifecycleRequestHash({ ...base, approveFollowUp: { ...proposal, overrideReason: 'farklı' } }));
  });
});
