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
const staff: CurrentUser = { ...manager, id: 's1', name: 'Ayşe Personel', role: 'STAFF' };
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

  it('warns that waiting cancellation is terminal and disables blank confirmation', async () => {
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => root.render(<ReasonDialog kind="cancel" pending={false}
        onClose={() => {}} onConfirm={() => {}} />));
      expect(host.textContent).toContain('iptal edilen iş yeniden açılamaz');
      expect(host.querySelector('textarea')?.required).toBe(true);
      const confirm = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'İşi iptal et')!;
      expect(confirm.disabled).toBe(true);
      const textarea = host.querySelector('textarea')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '  Neden  ');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(confirm.disabled).toBe(false);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it('shows assigned Staff withdrawal and cancellation actions while waiting', () => {
    const meeting = { ...job, type: 'SALES_MEETING' as const, assignedTo: staff.id,
      assignee: { id: staff.id, name: staff.name } };
    const html = renderToStaticMarkup(<JobDetailPanel job={meeting} items={[]} viewerRole="STAFF"
      viewerId={staff.id} pending={false} message="" onBack={() => {}} onCommand={() => {}} />);
    expect(html).toContain('Onaydan geri çek ve düzenle');
    expect(html).toContain('İşi iptal et');
  });

  it('opens the edit form only after a waiting Staff meeting is withdrawn', async () => {
    const meeting = {
      ...job, type: 'SALES_MEETING' as const, assignedTo: staff.id,
      assignee: { id: staff.id, name: staff.name }, dueDate: '2026-07-20',
    };
    const details = {
      jobCardId: meeting.id, meetingAt: '2026-07-16T10:00:00.000Z', outcome: 'NO_DECISION',
      meetingSummary: 'İlk görüşme', nextFollowUpAt: null, jobCardVersion: meeting.version,
    };
    const customer = {
      id: 'c1', organizationId: 'org-1', name: 'Klinik', customerType: 'clinic',
      taxNumber: null, phone: null, email: null, city: null, district: null, address: null,
      assignedStaffUserId: null, assignedStaffName: null, status: 'active', version: 1,
      primaryContact: null,
    };
    const requests: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET'; requests.push({ url, method });
      if (url.endsWith('/withdraw-from-approval') && method === 'POST') {
        return Response.json({ ...meeting, status: 'IN_PROGRESS', version: 5 });
      }
      if (url.endsWith('/meeting-details')) return Response.json(details);
      if (url.includes('/notes?')) return Response.json(page);
      if (url.includes('/activity?')) return Response.json({ ...page, limit: 50 });
      if (url.startsWith('/api/customers?')) {
        return Response.json({ items: [customer], total: 1, limit: 200, offset: 0 });
      }
      if (url.includes('/api/customers/c1/contacts?')) {
        return Response.json({ items: [], total: 0, limit: 200, offset: 0 });
      }
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(meeting);
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => {
        root.render(<JobDetailScreen jobId="job-1" user={staff} onBack={() => {}} onChanged={() => {}} />);
        await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(host.querySelector('#meeting-edit-title')).toBeNull();
      const edit = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Onaydan geri çek ve düzenle')!;
      await act(async () => {
        edit.click(); await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(requests.some((request) => request.method === 'POST'
        && request.url.endsWith('/withdraw-from-approval'))).toBe(true);
      expect(host.querySelector('#meeting-edit-title')).not.toBeNull();
      expect((host.querySelector('#meeting-edit-title') as HTMLInputElement).value).toBe(meeting.title);
    } finally { await act(async () => root.unmount()); host.remove(); }
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

  it('loads only meeting details for Sales Meeting and retries one version mismatch', async () => {
    const meeting = { ...job, type: 'SALES_MEETING' as const, status: 'IN_PROGRESS' as const,
      title: 'Satış görüşmesi', dueDate: '2026-07-20' };
    let jobReads = 0; let meetingReads = 0; let deliveryReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/delivery-items')) { deliveryReads += 1; return Response.json({ items: [] }); }
      if (url.endsWith('/meeting-details')) {
        meetingReads += 1; return Response.json({ jobCardId: 'job-1', meetingAt: null,
          outcome: null, meetingSummary: null, nextFollowUpAt: null,
          jobCardVersion: meetingReads === 1 ? meeting.version - 1 : meeting.version });
      }
      if (url.includes('/notes?')) return Response.json(page);
      if (url.includes('/activity?')) return Response.json({ ...page, limit: 50 });
      if (url.endsWith('/api/job-cards/job-1')) { jobReads += 1; return Response.json(meeting); }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => { root.render(<JobDetailScreen jobId="job-1" user={manager}
        onBack={() => {}} onChanged={() => {}} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(jobReads).toBe(2); expect(meetingReads).toBe(2); expect(deliveryReads).toBe(0);
      expect(host.textContent).toContain('Görüşme sonucu');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it.each(['NEW', 'PLANNED'] as const)(
    'does not request or render result and notes for a %s Sales Meeting',
    async (status) => {
      const meeting = { ...job, type: 'SALES_MEETING' as const, status,
        title: 'Planlanan görüşme', dueDate: '2026-07-20' };
      let meetingReads = 0; let noteReads = 0;
      vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith('/meeting-details')) { meetingReads += 1; throw new Error('unexpected'); }
        if (url.includes('/notes?')) { noteReads += 1; throw new Error('unexpected'); }
        if (url.includes('/activity?')) return Response.json({ ...page, limit: 50 });
        if (url.endsWith('/api/job-cards/job-1')) return Response.json(meeting);
        throw new Error(`Unexpected request: ${url}`);
      }));
      const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
      try {
        await act(async () => { root.render(<JobDetailScreen jobId="job-1" user={staff}
          onBack={() => {}} onChanged={() => {}} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
        expect(meetingReads).toBe(0); expect(noteReads).toBe(0);
        expect(host.textContent).not.toContain('Görüşme sonucu');
        expect(host.textContent).not.toContain('Notlar');
      } finally { await act(async () => root.unmount()); host.remove(); }
    },
  );

  it('projects submit readiness errors into the meeting form and focuses the summary', async () => {
    const meeting = { ...job, type: 'SALES_MEETING' as const, status: 'IN_PROGRESS' as const,
      title: 'Satış görüşmesi', dueDate: '2026-07-20' };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) return Response.json({
        jobCardId: 'job-1', meetingAt: null, outcome: null, meetingSummary: null,
        nextFollowUpAt: null, jobCardVersion: meeting.version,
      });
      if (url.includes('/notes?')) return Response.json(page);
      if (url.includes('/activity?')) return Response.json({ ...page, limit: 50 });
      if (url.endsWith('/submit-for-approval') && init?.method === 'POST') return Response.json({
        error: 'Satış görüşmesi yapılandırılmış sonuç bilgileri tamamlanmalıdır.',
        code: 'MEETING_NOT_READY',
        details: { fieldErrors: {
          meetingAt: 'Gerçekleşme zamanı zorunludur.', outcome: 'Sonuç zorunludur.',
          meetingSummary: 'Özet zorunludur.', nextFollowUpAt: 'Takip zamanı geçersizdir.',
          hiddenRelation: 'Gizli bilgi',
        } },
      }, { status: 400 });
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(meeting);
      throw new Error(`Unexpected request: ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => { root.render(<JobDetailScreen jobId="job-1" user={staff}
        onBack={() => {}} onChanged={() => {}} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      const submit = Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent === 'Onaya gönder')!;
      await act(async () => { submit.click(); await new Promise((resolve) => setTimeout(resolve, 0)); });

      const alert = host.querySelector<HTMLElement>('[role="alert"]')!;
      expect(alert).toBe(document.activeElement);
      expect(alert.textContent).toContain('yapılandırılmış sonuç bilgileri');
      for (const [controlId, errorId] of [
        ['meeting-actual-at', 'meeting-actual-at-error'],
        ['meeting-outcome', 'meeting-outcome-error'],
        ['meeting-summary', 'meeting-summary-error'],
        ['meeting-follow-up-at', 'meeting-follow-up-at-error'],
      ]) {
        const control = host.querySelector(`#${controlId}`);
        expect(control?.getAttribute('aria-invalid')).toBe('true');
        expect(control?.getAttribute('aria-describedby')).toContain(errorId);
      }
      expect(host.textContent).not.toContain('Gizli bilgi');
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it('stops after the second meeting version mismatch and offers an explicit retry', async () => {
    const meeting = { ...job, type: 'SALES_MEETING' as const, status: 'IN_PROGRESS' as const,
      title: 'Satış görüşmesi', dueDate: '2026-07-20' };
    let jobReads = 0; let meetingReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/meeting-details')) { meetingReads += 1; return Response.json({
        jobCardId: 'job-1', meetingAt: null, outcome: null, meetingSummary: null,
        nextFollowUpAt: null, jobCardVersion: meeting.version - 1,
      }); }
      if (url.endsWith('/api/job-cards/job-1')) { jobReads += 1; return Response.json(meeting); }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    try {
      await act(async () => { root.render(<JobDetailScreen jobId="job-1" user={manager}
        onBack={() => {}} onChanged={() => {}} />); await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(jobReads).toBe(2); expect(meetingReads).toBe(2);
      expect(host.textContent).toContain('İş ve görüşme bilgileri eşleşmedi');
      expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === 'Tekrar dene')).toBe(true);
    } finally { await act(async () => root.unmount()); host.remove(); }
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
