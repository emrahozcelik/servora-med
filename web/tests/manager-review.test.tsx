/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel, JobDetailScreen, ReasonDialog, runManagerJobCommand } from '../src/JobDetail';
import { ApiError, type CurrentUser } from '../src/services/api';
import type { DeliveryItem, JobCard } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const job: JobCard = { id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'WAITING_APPROVAL', version: 4,
  title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null, assignedTo: 's1', createdBy: 's1', priority: 'normal', dueDate: null,
  assignee: { id: 's1', name: 'Ayşe Personel' }, customer: { id: 'c1', name: 'Klinik' }, contact: null };
const item: DeliveryItem = { id: 'i1', organizationId: 'org-1', jobCardId: 'job-1', productId: 'p1', deliveryPurpose: 'SALE',
  deliveredAt: '2026-07-11T10:00:00Z', quantity: 2, unit: 'adet', productNameSnapshot: 'İmplant seti', productSkuSnapshot: null,
  productModelSnapshot: null, lotNo: null, serialNo: null, expiryDate: null, deliveryNote: null };
const manager: CurrentUser = { id: 'manager-1', organizationId: 'org-1', name: 'Yönetici', email: 'manager@test.local',
  role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1 };
const page = { items: [], total: 0, limit: 25, offset: 0 };

afterEach(() => vi.unstubAllGlobals());

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

  it('never requests delivery items for a General Task, including conflict truth reload', async () => {
    const initialTask = {
      ...job, type: 'GENERAL_TASK' as const, status: 'NEW' as const, title: 'Klinik dönüşünü takip et',
      description: 'Sonucu karta yaz.', priority: 'high' as const, dueDate: '2026-07-20',
      contactId: 'contact-1', contact: { id: 'contact-1', name: 'Dr. Ayşe' },
    };
    const refreshedTask = { ...initialTask, status: 'PLANNED' as const, version: 5 };
    let detailReads = 0;
    let deliveryReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) {
        deliveryReads += 1;
        return Response.json({ items: [] });
      }
      if (url.includes('/notes?')) return Response.json(page);
      if (url.includes('/activity?')) return Response.json({ ...page, limit: 50 });
      if (url.endsWith('/start') && init?.method === 'POST') {
        return Response.json({ error: 'İş güncellendi.', code: 'VERSION_CONFLICT' }, { status: 409 });
      }
      if (url.endsWith('/api/job-cards/job-1')) {
        detailReads += 1;
        return Response.json(detailReads === 1 ? initialTask : refreshedTask);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />);
        await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(host.textContent).toContain('Genel görev');
      expect(host.textContent).not.toContain('Teslim bilgileri');
      const start = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'İşi başlat')!;
      await act(async () => {
        start.click();
        await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(detailReads).toBe(2);
      expect(deliveryReads).toBe(0);
      expect(host.textContent).toContain('En güncel durum gösteriliyor');
    } finally {
      await act(async () => root.unmount()); host.remove();
    }
  });

  it.each([
    ['revision', job, 'Düzeltme iste', 'Düzeltme nedeni', '/request-revision', 'REVISION_REQUESTED'],
    ['cancel', { ...job, status: 'NEW' as const }, 'İşi iptal et', 'İptal nedeni', '/cancel', 'CANCELLED'],
  ])('focuses the success message after a successful %s changes lifecycle actions', async (
    _kind, initialJob, triggerName, reasonLabel, endpoint, nextStatus,
  ) => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) return Response.json({ items: [item] });
      if (url.includes('/notes?')) return Response.json(page);
      if (url.includes('/activity?')) return Response.json({ ...page, limit: 50 });
      if (url.endsWith(endpoint) && init?.method === 'POST') {
        return Response.json({ ...initialJob, status: nextStatus, version: initialJob.version + 1 });
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(initialJob);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<JobDetailScreen jobId="job-1" user={manager} onBack={() => {}} onChanged={() => {}} />); await Promise.resolve(); });
      const trigger = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === triggerName)!;
      await act(async () => trigger.click());
      const textarea = host.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, `${reasonLabel} açıklaması`);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        textarea.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const feedback = host.querySelector<HTMLElement>('[role="status"]')!;
      expect(feedback.tabIndex).toBe(-1);
      expect(document.activeElement).toBe(feedback);
    } finally {
      await act(async () => root.unmount()); host.remove();
    }
  });
});
