/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobTimeline } from '../src/jobs/JobTimeline';
import { ApiError } from '../src/services/api';
import type { JobCardActivity, Paginated } from '../src/jobs/jobs-api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function page(items: JobCardActivity[]): Paginated<JobCardActivity> {
  return { items, total: items.length, limit: 50, offset: 0 };
}

describe('safe JobCard timeline', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  });

  it('renders actor names and known details without raw audit fields', async () => {
    const activity: JobCardActivity = {
      id: 'a1', jobCardId: 'job-1', eventType: 'JOB_STARTED',
      actor: { id: 'staff-1', name: 'Ayşe Personel' },
      details: { kind: 'STATUS_TRANSITION', fromStatus: 'PLANNED', toStatus: 'IN_PROGRESS', reason: null },
      createdAt: '2026-07-14T08:00:00.000Z',
    };
    await act(async () => root.render(<JobTimeline jobId="job-1" load={vi.fn().mockResolvedValue(page([activity]))} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('İş başlatıldı');
    expect(host.textContent).toContain('Ayşe Personel');
    expect(host.textContent).toContain('Planlandı → Uygulanıyor');
    expect(host.textContent).not.toMatch(/JOB_STARTED|oldValue|metadata|clientActionId/);
  });

  it('uses a safe unknown-event fallback and only emits a non-sensitive development diagnostic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const activity: JobCardActivity = {
      id: 'a2', jobCardId: 'job-1', eventType: 'FUTURE_EVENT', actor: null,
      details: { kind: 'NONE' }, createdAt: '2026-07-14T08:00:00.000Z',
    };
    await act(async () => root.render(<JobTimeline jobId="job-1" load={vi.fn().mockResolvedValue(page([activity]))} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('İş kaydında bir işlem yapıldı');
    expect(host.textContent).not.toContain('FUTURE_EVENT');
    if (import.meta.env.DEV) expect(warn).toHaveBeenCalledWith('Unknown JobCard activity event', { eventType: 'FUTURE_EVENT' });
  });

  it('presents safe meeting field names without values', async () => {
    const activity: JobCardActivity = { id: 'a3', jobCardId: 'job-1',
      eventType: 'MEETING_DETAILS_UPDATED', actor: { id: 'staff-1', name: 'Ayşe' },
      details: { kind: 'MEETING_DETAILS', changedFields: ['outcome', 'meetingSummary'] },
      createdAt: '2026-07-14T08:00:00.000Z' };
    await act(async () => root.render(<JobTimeline jobId="job-1"
      load={vi.fn().mockResolvedValue(page([activity]))} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('Görüşme sonucu güncellendi');
    expect(host.textContent).toContain('Sonuç, Görüşme özeti');
    expect(host.textContent).not.toContain('meetingSummary');
  });

  it('keeps timeline failures local and retryable', async () => {
    const load = vi.fn().mockRejectedValueOnce(new ApiError(503, 'TEMPORARY', 'Geçmiş yüklenemedi.', true)).mockResolvedValueOnce(page([]));
    await act(async () => root.render(<JobTimeline jobId="job-1" load={load} />));
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('Geçmiş yüklenemedi.');
    await act(async () => { (host.querySelector('button') as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Henüz işlem geçmişi yok');
  });

  it('returns to and reloads the first page when its refresh key changes', async () => {
    const activity: JobCardActivity = { id: 'a1', jobCardId: 'job-1', eventType: 'JOB_CREATED', actor: null,
      details: { kind: 'NONE' }, createdAt: '2026-07-14T08:00:00.000Z' };
    const load = vi.fn().mockImplementation(async (_jobId: string, query: { limit: number; offset: number }) => ({
      items: [activity], total: 75, limit: query.limit, offset: query.offset,
    }));
    await act(async () => { root.render(<JobTimeline jobId="job-1" refreshKey={0} load={load} />); await Promise.resolve(); });
    const next = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Sonraki')!;
    await act(async () => { next.click(); await Promise.resolve(); });
    expect(load).toHaveBeenLastCalledWith('job-1', { limit: 50, offset: 50 });

    await act(async () => { root.render(<JobTimeline jobId="job-1" refreshKey={1} load={load} />); await Promise.resolve(); await Promise.resolve(); });
    expect(load).toHaveBeenLastCalledWith('job-1', { limit: 50, offset: 0 });
  });

  it('labels newest-first history and shows only safe lifecycle reasons', async () => {
    const activities: JobCardActivity[] = [
      {
        id: 'a1', jobCardId: 'job-1', eventType: 'JOB_CANCELLED',
        actor: { id: 'm1', name: 'Yönetici' },
        details: {
          kind: 'STATUS_TRANSITION', fromStatus: 'IN_PROGRESS', toStatus: 'CANCELLED',
          reason: 'Müşteri teslimatı iptal etti',
        },
        createdAt: '2026-07-14T09:00:00.000Z',
      },
      {
        id: 'a2', jobCardId: 'job-1', eventType: 'JOB_STARTED',
        actor: { id: 's1', name: 'Ayşe Personel' },
        details: {
          kind: 'STATUS_TRANSITION', fromStatus: 'PLANNED', toStatus: 'IN_PROGRESS',
          reason: null,
        },
        createdAt: '2026-07-14T08:00:00.000Z',
      },
    ];
    await act(async () => {
      root.render(<JobTimeline
        jobId="job-1"
        load={vi.fn().mockResolvedValue(page(activities))}
      />);
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector('.timeline-order-note')?.textContent).toBe('En yeni işlem üstte');
    expect(host.querySelector('.servora-activity-timeline')).not.toBeNull();
    expect(Array.from(host.querySelectorAll<HTMLElement>('[data-activity-id]'))
      .map((entry) => entry.dataset.activityId)).toEqual(['a1', 'a2']);
    expect(host.querySelector('time[datetime="2026-07-14T09:00:00.000Z"]')).not.toBeNull();
    expect(host.textContent).toContain('Neden: Müşteri teslimatı iptal etti');
    expect(host.querySelectorAll('.timeline-reason')).toHaveLength(1);
    expect(host.textContent).toContain('Uygulanıyor → İptal edildi');
    expect(host.textContent).toContain('Planlandı → Uygulanıyor');
    expect(host.textContent).toContain('İş iptal edildi');
    expect(host.textContent).toContain('İş başlatıldı');
    expect(host.textContent).not.toMatch(/oldValue|metadata|clientActionId/);
  });

  it('labels JOB_ACCEPTED and historical JOB_PLANNED transitions safely', async () => {
    const activities: JobCardActivity[] = [
      {
        id: 'a1', jobCardId: 'job-1', eventType: 'JOB_ACCEPTED',
        actor: { id: 's1', name: 'Ayşe Personel' },
        details: {
          kind: 'STATUS_TRANSITION', fromStatus: 'NEW', toStatus: 'ACCEPTED', reason: null,
        },
        createdAt: '2026-07-14T09:00:00.000Z',
      },
      {
        id: 'a2', jobCardId: 'job-1', eventType: 'JOB_PLANNED',
        actor: { id: 'm1', name: 'Yönetici' },
        details: {
          kind: 'STATUS_TRANSITION', fromStatus: 'NEW', toStatus: 'PLANNED', reason: null,
        },
        createdAt: '2026-07-14T08:00:00.000Z',
      },
    ];
    await act(async () => {
      root.render(<JobTimeline
        jobId="job-1"
        load={vi.fn().mockResolvedValue(page(activities))}
      />);
    });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain('İş kabul edildi');
    expect(host.textContent).toContain('Atandı → Kabul edildi');
    expect(host.textContent).toContain('İş planlandı');
    expect(host.textContent).toContain('Atandı → Planlandı');
  });

  it('shares approved process language for control lifecycle events', async () => {
    const events: Array<{ eventType: JobCardActivity['eventType']; label: string }> = [
      { eventType: 'JOB_SUBMITTED_FOR_APPROVAL', label: 'Kontrole gönderildi' },
      { eventType: 'JOB_APPROVED', label: 'Kontrol tamamlandı' },
      { eventType: 'JOB_REVISION_REQUESTED', label: 'Düzeltme için geri gönderildi' },
      { eventType: 'JOB_APPROVAL_WITHDRAWN', label: 'Kontrolden geri çekildi' },
    ];
    for (const { eventType, label } of events) {
      await act(async () => {
        root.render(<JobTimeline
          jobId="job-1"
          load={vi.fn().mockResolvedValue(page([{
            id: eventType, jobCardId: 'job-1', eventType, actor: null,
            details: {
              kind: 'STATUS_TRANSITION',
              fromStatus: 'IN_PROGRESS',
              toStatus: 'WAITING_APPROVAL',
              reason: null,
            },
            createdAt: '2026-07-14T08:00:00.000Z',
          }]))}
        />);
      });
      await act(async () => { await Promise.resolve(); });
      expect(host.textContent).toContain(label);
      expect(host.textContent).not.toContain('Onaya gönderildi');
      expect(host.textContent).not.toContain('Yönetici onayladı');
      expect(host.textContent).not.toContain('Onaydan geri çekildi');
    }
  });
});
