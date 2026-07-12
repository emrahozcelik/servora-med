import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { JobDetailPanel, runStaffJobCommand } from '../src/JobDetail';
import { ApiError, type DeliveryItem, type JobCard } from '../src/services/api';

const job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2,
  title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null };
const item: DeliveryItem = { id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1', deliveryPurpose: 'SAMPLE',
  deliveredAt: '2026-07-11T10:00:00.000Z', quantity: 2, unit: 'adet', productNameSnapshot: 'İmplant Seti',
  productSkuSnapshot: 'S1', productModelSnapshot: null, lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null };

describe('Staff JobCard detail', () => {
  it('renders immutable delivery facts and the next valid command', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={job} items={[item]} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('ABC Klinik ürün teslimi');
    expect(html).toContain('Sürüm 2');
    expect(html).toContain('İmplant Seti');
    expect(html).toContain('Numune');
    expect(html).toContain('2 adet');
    expect(html).toContain('İşi başlat');
  });

  it('shows submit only after the backend status is IN_PROGRESS', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={{ ...job, status: 'IN_PROGRESS', version: 3 }} items={[item]} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('Onaya gönder');
    expect(html).not.toContain('İşi başlat');
  });

  it('uses the current backend version for start and submit', async () => {
    const start = vi.fn().mockResolvedValue({ ...job, status: 'IN_PROGRESS', version: 3 });
    const submit = vi.fn().mockResolvedValue({ ...job, status: 'WAITING_APPROVAL', version: 4 });
    const refresh = vi.fn();
    await runStaffJobCommand(job, 'start', { start, submit, refresh, createActionId: () => 'action-1' });
    await runStaffJobCommand({ ...job, status: 'IN_PROGRESS', version: 3 }, 'submit', { start, submit, refresh, createActionId: () => 'action-2' });
    expect(start).toHaveBeenCalledWith('job-1', { clientActionId: 'action-1', expectedVersion: 2 });
    expect(submit).toHaveBeenCalledWith('job-1', { clientActionId: 'action-2', expectedVersion: 3 });
  });

  it('refetches and explains a stale-version conflict', async () => {
    const refreshed = { ...job, status: 'IN_PROGRESS' as const, version: 3 };
    const refresh = vi.fn().mockResolvedValue(refreshed);
    const result = await runStaffJobCommand(job, 'start', {
      start: vi.fn().mockRejectedValue(new ApiError(409, 'VERSION_CONFLICT', 'Kart güncellendi.')),
      submit: vi.fn(), refresh, createActionId: () => 'action-1',
    });
    expect(result).toEqual({ kind: 'conflict', job: refreshed });
    expect(refresh).toHaveBeenCalledWith('job-1');
  });
});
