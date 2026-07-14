import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JobDetailPanel, ReasonDialog, runManagerJobCommand } from '../src/JobDetail';
import { ApiError } from '../src/services/api';
import type { DeliveryItem, JobCard } from '../src/jobs/jobs-api';

const job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 4,
  title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null, assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null };
const item: DeliveryItem = { id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1', deliveryPurpose: 'SALE',
  deliveredAt: '2026-07-11T10:00:00Z', quantity: 2, unit: 'adet', productNameSnapshot: 'İmplant seti', productSkuSnapshot: null,
  productModelSnapshot: null, lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null };

describe('Manager review', () => {
  it('renders explicit review actions without editable delivery fields', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={job} items={[item]} viewerRole="MANAGER" pending={false}
      message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('Onayla');
    expect(html).toContain('Düzeltme iste');
    expect(html).not.toContain('name="quantity"');
  });

  it('renders a focus-managed reason dialog with a bounded required field', () => {
    const html = renderToStaticMarkup(<ReasonDialog kind="revise" pending={false} onClose={() => {}} onConfirm={() => {}} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Düzeltme nedeni');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('Vazgeç');
  });

  it('sends approve and revision with the current backend version', async () => {
    const approve = vi.fn().mockResolvedValue({ ...job, status: 'COMPLETED', version: 5 });
    const revise = vi.fn().mockResolvedValue({ ...job, status: 'REVISION_REQUESTED', version: 5 });
    const refresh = vi.fn();
    await runManagerJobCommand(job, 'approve', '', { approve, revise, refresh, createActionId: () => 'approve-1' });
    await runManagerJobCommand(job, 'revise', 'Miktarı doğrulayın', { approve, revise, refresh, createActionId: () => 'revise-1' });
    expect(approve).toHaveBeenCalledWith('job-1', { clientActionId: 'approve-1', expectedVersion: 4 });
    expect(revise).toHaveBeenCalledWith('job-1', { clientActionId: 'revise-1', expectedVersion: 4, revisionReason: 'Miktarı doğrulayın' });
  });

  it('refetches after manager version conflict', async () => {
    const refreshed = { ...job, version: 5 };
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const result = await runManagerJobCommand(job, 'approve', '', {
      approve: vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Güncellendi')),
      revise: vi.fn(), refresh, createActionId: () => 'approve-1',
    });
    expect(result).toEqual({ kind: 'conflict', job: refreshed });
  });
});
