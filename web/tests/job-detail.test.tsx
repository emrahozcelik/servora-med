import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { availableLifecycleCommands, JobDetailPanel, runStaffJobCommand } from '../src/JobDetail';
import { ApiError, type DeliveryItem, type JobCard } from '../src/services/api';

const job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 2,
  title: 'ABC Klinik ürün teslimi', description: null, customerId: 'c1', contactId: null, assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
  assignee: { id: 's1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'ABC Klinik' }, contact: null };
const item: DeliveryItem = { id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1', deliveryPurpose: 'SAMPLE',
  deliveredAt: '2026-07-11T10:00:00.000Z', quantity: 2, unit: 'adet', productNameSnapshot: 'İmplant Seti',
  productSkuSnapshot: 'S1', productModelSnapshot: null, lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null };
const generalTask: JobCard = {
  ...job, type: 'GENERAL_TASK', title: 'Teklif dönüşünü takip et',
  description: 'Doktorun kararını öğren ve sonucu karta yaz.', priority: 'high',
  dueDate: '2026-07-20', customerId: 'c1', contactId: 'contact-1',
  assignee: { id: 's1', name: 'Ayşe Personel' },
  customer: { id: 'c1', name: 'Demo Dental Klinik' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' },
};

describe('Staff JobCard detail', () => {
  it('exposes the exact Staff and management lifecycle actions by status', () => {
    expect(availableLifecycleCommands({ ...job, status: 'NEW' }, 'STAFF')).toEqual(['plan', 'start']);
    expect(availableLifecycleCommands({ ...job, status: 'PLANNED' }, 'STAFF')).toEqual(['start']);
    expect(availableLifecycleCommands({ ...job, status: 'IN_PROGRESS' }, 'STAFF')).toEqual(['submit']);
    expect(availableLifecycleCommands({ ...job, status: 'REVISION_REQUESTED' }, 'STAFF')).toEqual(['resume']);
    expect(availableLifecycleCommands({ ...job, status: 'WAITING_APPROVAL' }, 'STAFF'))
      .toEqual(['withdraw', 'cancel']);
    expect(availableLifecycleCommands({ ...job, status: 'WAITING_APPROVAL' }, 'MANAGER')).toEqual(['approve', 'revise']);
    expect(availableLifecycleCommands({ ...job, status: 'NEW' }, 'ADMIN')).toEqual(['plan', 'start', 'cancel']);
    expect(availableLifecycleCommands({ ...job, status: 'COMPLETED' }, 'ADMIN')).toEqual([]);
    expect(availableLifecycleCommands({ ...job, status: 'CANCELLED' }, 'ADMIN')).toEqual([]);
  });
  it('renders immutable delivery facts and the next valid command', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={job} items={[item]} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('ABC Klinik ürün teslimi');
    expect(html).not.toContain('Sürüm 2');
    expect(html).toContain('İmplant Seti');
    expect(html).toContain('Numune');
    expect(html).toContain('2 adet');
    expect(html).toContain('İşi başlat');
    expect(html).toContain('Planla');
  });

  it('renders quantity without a fabricated unit when the Product unit is null', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={job} items={[{ ...item, quantity: 3, unit: null }]} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('<dd>3</dd>');
    expect(html).not.toContain('3 adet');
    expect(html).not.toContain('3 null');
  });

  it('renders shared General Task facts and no Product Delivery section', () => {
    const html = renderToStaticMarkup(<JobDetailPanel job={generalTask} items={[]} pending={false}
      message="" onBack={() => {}} onCommand={() => {}}><section>Notlar ve zaman çizelgesi</section></JobDetailPanel>);

    expect(html).toContain('Genel görev');
    expect(html).toContain('Teklif dönüşünü takip et');
    expect(html).toContain('Doktorun kararını öğren ve sonucu karta yaz.');
    expect(html).toContain('Ayşe Personel');
    expect(html).toContain('Demo Dental Klinik');
    expect(html).toContain('Dr. Deniz');
    expect(html).toContain('Yüksek');
    expect(html).toContain('2026-07-20');
    expect(html).toContain('Notlar ve zaman çizelgesi');
    expect(html).not.toContain('Teslim bilgileri');
    expect(html).not.toContain('Ürün teslimi');
  });

  it('uses exactly one structured subresource for each canonical type', () => {
    const source = readFileSync(`${process.cwd()}/src/JobDetail.tsx`, 'utf8');

    expect(source).toContain("if (job.type === 'PRODUCT_DELIVERY') return { kind: job.type");
    expect(source).toContain("if (job.type === 'GENERAL_TASK') return { kind: job.type");
    expect(source).toContain("['NEW', 'PLANNED'].includes(job.status) ? null : await getMeetingDetails(jobId)");
    expect(source).toContain("{job.type === 'PRODUCT_DELIVERY' && <section className=\"delivery-lines\"");
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
