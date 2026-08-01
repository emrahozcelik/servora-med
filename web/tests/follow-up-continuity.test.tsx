/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel, JobDetailScreen } from '../src/JobDetail';
import { FollowUpBreadcrumb, FollowUpChildrenPanel } from '../src/jobs/FollowUpContinuity';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';
import type { CurrentUser } from '../src/services/api';
import type { JobCard, MeetingDetails } from '../src/jobs/jobs-api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource implements RealtimeEventSource {
  readonly listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  close() {}
  emit(type: string, data: string) {
    this.listeners.get(type)?.forEach((listener) => listener(new MessageEvent(type, { data })));
  }
}

function changeEnvelope(id: string, resourceKeys: string[]) {
  return JSON.stringify({
    id, type: 'job.created', entity: { type: 'job-card', id: 'child-1' }, resourceKeys,
    occurredAt: '2026-08-01T12:00:00.000Z',
  });
}

const api = vi.hoisted(() => ({ getJobCard: vi.fn(), listFollowUps: vi.fn() }));
vi.mock('../src/jobs/jobs-api', async (original) => ({
  ...await original<typeof import('../src/jobs/jobs-api')>(),
  getJobCard: api.getJobCard, listFollowUps: api.listFollowUps,
}));

const staff: CurrentUser = {
  id: 'staff-2', organizationId: 'org-1', name: 'Bora', email: 'b@test.local', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: true },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const manager: CurrentUser = { ...staff, id: 'manager-1', role: 'MANAGER', name: 'Yönetici' };
const admin: CurrentUser = { ...manager, id: 'admin-1', role: 'ADMIN', name: 'Admin' };
const completedContext = {
  ...workflowContext,
  allowedCommands: [],
  allowedActions: [],
  submissionReadiness: null,
  lifecycle: { ...workflowContext.lifecycle, approvedAt: '2026-08-01T10:00:00.000Z' },
};
const sourceSummary = {
  sourceType: 'SALES_MEETING' as const,
  sourcePlannedAt: '2026-07-20T09:00:00.000Z',
  sourceOccurredAt: '2026-07-20T09:15:00.000Z',
  sourceCompletedAt: '2026-07-20T10:00:00.000Z',
  customer: { id: 'customer-1', name: 'Çok Uzun Klinik Adı' },
  contact: { id: 'contact-1', name: 'Dr. Deniz' },
  outcome: 'FOLLOW_UP_REQUIRED' as const,
};
const rootJob: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'GENERAL_TASK', status: 'COMPLETED', version: 3,
  title: 'Tamamlanan iş', description: null, customerId: 'customer-1', contactId: null,
  assignedTo: 'staff-2', createdBy: 'manager-1', priority: 'normal', dueDate: null,
  scheduledAt: '2026-08-01T09:00:00.000Z', engagementKind: null,
  assignee: { id: 'staff-2', name: 'Bora' }, customer: { id: 'customer-1', name: 'Klinik' },
  contact: null, workflowContext: completedContext, followUpContext: null,
};
const fullFollowUp: JobCard = {
  ...rootJob, id: 'follow-up-1', title: 'Bağlantılı takip', followUpContext: {
    sourceJobCardId: 'source-1', followUpInstructions: 'Uzun takip kapsamı\nİkinci satır',
    sourceAccess: 'FULL', sourceJobPath: '/jobs/source-1', sourceSummary,
  },
};
const restrictedFollowUp: JobCard = {
  ...fullFollowUp, followUpContext: {
    ...fullFollowUp.followUpContext!, sourceAccess: 'RESTRICTED', sourceJobPath: null,
  },
};
const meetingDetails: MeetingDetails = {
  jobCardId: 'meeting-1', meetingAt: '2026-08-01T09:15:00.000Z',
  outcome: 'FOLLOW_UP_REQUIRED', meetingSummary: 'PRIVATE_MEETING_SUMMARY_MARKER',
  nextFollowUpAt: '2026-08-10T09:00:00.000Z', jobCardVersion: 3,
};

async function flush() {
  await act(async () => { await Promise.resolve(); await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('JobDetail follow-up continuity', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
    api.listFollowUps.mockResolvedValue({ items: [], total: 0, limit: 100, offset: 0 });
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

  async function renderPanel(job: JobCard, user: CurrentUser, props: {
    onCreateFollowUp?: () => void;
    meetingDetails?: MeetingDetails | null;
  } = {}) {
    await act(async () => root.render(<JobDetailPanel job={job} items={[]} user={user}
      pending={false} message="" onBack={() => {}} onCommand={() => {}}
      onCreateFollowUp={props.onCreateFollowUp} meetingDetails={props.meetingDetails ?? null} />));
  }

  it.each([admin, manager])('shows the create action for completed management role $role', async (user) => {
    await renderPanel(rootJob, user, { onCreateFollowUp: vi.fn() });
    expect(Array.from(host.querySelectorAll('button')).filter((button) => button.textContent === 'Takip işi oluştur')).toHaveLength(1);
  });

  it('hides the create action from Staff and every non-completed status', async () => {
    await renderPanel(rootJob, staff, { onCreateFollowUp: vi.fn() });
    expect(host.textContent).not.toContain('Takip işi oluştur');
    for (const status of ['NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED', 'CANCELLED'] as const) {
      await renderPanel({ ...rootJob, status }, manager, { onCreateFollowUp: vi.fn() });
      expect(host.textContent).not.toContain('Takip işi oluştur');
    }
  });

  it('composes one primary recommendation action for completed FOLLOW_UP_REQUIRED meetings', async () => {
    const meeting = { ...rootJob, id: 'meeting-1', type: 'SALES_MEETING' as const, engagementKind: 'SALES_MEETING' as const };
    await renderPanel(meeting, manager, { onCreateFollowUp: vi.fn(), meetingDetails });
    expect(host.textContent).toContain('Takip gerekli');
    expect(host.textContent).toContain('Personelin önerdiği takip zamanı');
    expect(host.textContent).toContain('kesinleşmiş bir randevu değildir');
    expect(Array.from(host.querySelectorAll('button')).filter((button) => button.textContent === 'Takip işi oluştur')).toHaveLength(1);
    expect(host.textContent).not.toContain('PRIVATE_MEETING_SUMMARY_MARKER');
  });

  it('renders the badge and safe FULL source context with the provided path', async () => {
    await renderPanel(fullFollowUp, staff);
    expect(host.querySelector('.follow-up-badge')?.textContent).toBe('Takip');
    expect(host.textContent).toContain('Önceki iş bağlamı');
    expect(host.textContent).toContain('Uzun takip kapsamı');
    expect(host.textContent).toContain('Planlanan tarih');
    expect(host.textContent).toContain('Gerçekleşme tarihi');
    expect(host.textContent).toContain('Tamamlanma tarihi');
    expect(host.querySelector('a[href="/jobs/source-1"]')?.textContent).toContain('Önceki işi aç');
  });

  it('renders RESTRICTED context without a link or forbidden private markers', async () => {
    await renderPanel(restrictedFollowUp, staff);
    expect(host.textContent).toContain('Önceki iş bağlamı');
    expect(host.querySelector('.follow-up-source-context a')).toBeNull();
    for (const marker of [
      'SOURCE_OPERATIONAL_NOTE_MARKER', 'PRIVATE_MEETING_SUMMARY_MARKER',
      'SOURCE_ACTIVITY_MARKER', 'SOURCE_STAFF_MARKER', 'DELIVERY_DETAIL_MARKER',
    ]) expect(host.textContent).not.toContain(marker);
    await renderPanel(rootJob, staff);
    expect(host.querySelector('.follow-up-badge')).toBeNull();
    expect(host.textContent).not.toContain('Önceki iş bağlamı');
  });

  it('does not request or render children/breadcrumb for Staff, but management fetches children', async () => {
    const requests: string[] = [];
    const child = {
      id: 'child-1', type: 'GENERAL_TASK', status: 'NEW', version: 1,
      title: 'Güvenli takip satırı', priority: 'normal', dueDate: null, scheduledAt: null,
      engagementKind: null, createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z', staffCompletedAt: null,
      customer: { id: 'customer-1', name: 'Klinik' }, contact: null,
      assignee: { id: 'staff-2', name: 'Bora' }, deliveryItemCount: 0,
      allowedCommands: ['ACCEPT_ASSIGNMENT'], followUp: { sourceJobCardId: 'job-1' },
      sourceOperationalNote: 'SOURCE_OPERATIONAL_NOTE_MARKER',
      meetingSummary: 'PRIVATE_MEETING_SUMMARY_MARKER',
      activityDescription: 'SOURCE_ACTIVITY_MARKER',
      sourceStaffName: 'SOURCE_STAFF_MARKER',
      deliveryDetails: 'DELIVERY_DETAIL_MARKER',
    };
    api.listFollowUps.mockResolvedValue({ items: [child], total: 1, limit: 100, offset: 0 });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); requests.push(url);
      if (url.includes('/activity?')) return Response.json({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.endsWith('/follow-ups?limit=100&offset=0')) return Response.json({ items: [child], total: 1, limit: 100, offset: 0 });
      if (url.endsWith('/api/job-cards/job-1')) return Response.json(rootJob);
      throw new Error(`Unexpected request: ${url}`);
    }));
    api.getJobCard.mockImplementation(async () => rootJob);
    await act(async () => root.render(<JobDetailScreen jobId="job-1" user={staff}
      onBack={() => {}} onChanged={() => {}} />));
    await flush();
    expect(requests.some((url) => url.includes('/follow-ups'))).toBe(false);
    expect(host.textContent).not.toContain('Takip işleri');
    expect(host.querySelector('.follow-up-breadcrumb')).toBeNull();

    await act(async () => root.render(<JobDetailScreen jobId="job-1" user={manager}
      onBack={() => {}} onChanged={() => {}} />));
    await flush();
    expect(api.listFollowUps).toHaveBeenCalledWith('job-1', { limit: 100, offset: 0 });
    expect(host.textContent).toContain('Takip işleri');
    expect(host.textContent).toContain('Güvenli takip satırı');
    for (const marker of [
      'SOURCE_OPERATIONAL_NOTE_MARKER', 'PRIVATE_MEETING_SUMMARY_MARKER',
      'SOURCE_ACTIVITY_MARKER', 'SOURCE_STAFF_MARKER', 'DELIVERY_DETAIL_MARKER',
    ]) expect(host.textContent).not.toContain(marker);
  });

  it('loads and renders management ancestors from root to current with a cycle guard boundary', async () => {
    const parent: JobCard = {
      ...fullFollowUp, id: 'source-1', title: 'Orta iş', followUpContext: {
        ...fullFollowUp.followUpContext!, sourceJobCardId: 'root-1', sourceJobPath: '/jobs/root-1',
      },
    };
    const ancestor: JobCard = { ...rootJob, id: 'root-1', title: 'Kök iş' };
    api.getJobCard.mockImplementation(async (id: string) => id === 'source-1' ? parent : ancestor);
    await act(async () => root.render(<FollowUpBreadcrumb job={fullFollowUp} />));
    await flush();
    const labels = Array.from(host.querySelectorAll('.follow-up-breadcrumb li')).map((item) => item.textContent);
    expect(labels).toEqual(['Kök iş', 'Orta iş', 'Bağlantılı takip']);
    expect(api.getJobCard).toHaveBeenCalledTimes(2);
  });

  it('shows and loads the next children page when the total exceeds the first page', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...rootJob, id: `child-${index}`, title: `Takip ${index + 1}`,
      followUp: { sourceJobCardId: rootJob.id },
    }));
    const secondPage = [{ ...rootJob, id: 'child-101', title: 'Takip 101', followUp: { sourceJobCardId: rootJob.id } }];
    api.listFollowUps
      .mockResolvedValueOnce({ items: firstPage, total: 101, limit: 100, offset: 0 })
      .mockResolvedValueOnce({ items: secondPage, total: 101, limit: 100, offset: 100 });
    await act(async () => root.render(<FollowUpChildrenPanel sourceId={rootJob.id} />));
    await flush();

    expect(host.textContent).toContain('100 / 101 takip işi gösteriliyor.');
    const more = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Daha fazla göster');
    expect(more).toBeTruthy();
    await act(async () => { (more as HTMLButtonElement).click(); await Promise.resolve(); });
    expect(api.listFollowUps).toHaveBeenNthCalledWith(2, rootJob.id, { limit: 100, offset: 100 });
    expect(host.textContent).toContain('101 / 101 takip işi gösteriliyor.');
    expect(host.textContent).toContain('Takip 101');
    expect(host.querySelector('button')).toBeNull();
  });

  describe('FollowUpChildrenPanel realtime invalidation', () => {
    const child = {
      id: 'child-1', type: 'GENERAL_TASK', status: 'NEW', version: 1,
      title: 'Realtime takip', priority: 'normal', dueDate: null, scheduledAt: null,
      engagementKind: null, createdAt: '2026-08-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z', staffCompletedAt: null,
      customer: { id: 'customer-1', name: 'Klinik' }, contact: null,
      assignee: { id: 'staff-2', name: 'Bora' }, deliveryItemCount: 0,
      allowedCommands: [], followUp: { sourceJobCardId: rootJob.id },
    };

    async function renderWithRealtime(ui: React.ReactNode) {
      const source = new FakeEventSource();
      await act(async () => root.render(
        <RealtimeProvider eventSourceFactory={() => source}>{ui}</RealtimeProvider>,
      ));
      return source;
    }

    it('refreshes the panel when job-detail:<sourceId> invalidation arrives', async () => {
      api.listFollowUps.mockResolvedValueOnce({ items: [], total: 0, limit: 100, offset: 0 })
        .mockResolvedValueOnce({ items: [child], total: 1, limit: 100, offset: 0 });
      const source = await renderWithRealtime(<FollowUpChildrenPanel sourceId={rootJob.id} />);
      await flush();
      expect(host.textContent).toContain('0 / 0 takip işi gösteriliyor.');
      await act(async () => source.emit('servora.change', changeEnvelope('1', [`job-detail:${rootJob.id}`])));
      await flush();
      expect(api.listFollowUps).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain('1 / 1 takip işi gösteriliyor.');
      expect(host.textContent).toContain('Realtime takip');
    });

    it('ignores a duplicate event cursor so no refresh loop is created', async () => {
      api.listFollowUps.mockResolvedValue({ items: [child], total: 1, limit: 100, offset: 0 });
      const source = await renderWithRealtime(<FollowUpChildrenPanel sourceId={rootJob.id} />);
      await flush();
      await act(async () => source.emit('servora.change', changeEnvelope('1', [`job-detail:${rootJob.id}`])));
      await flush();
      await act(async () => source.emit('servora.change', changeEnvelope('1', [`job-detail:${rootJob.id}`])));
      await flush();
      expect(api.listFollowUps).toHaveBeenCalledTimes(2);
      expect(host.textContent).toContain('1 / 1 takip işi gösteriliyor.');
    });

    it('does not let a slow stale response overwrite a fresh refresh', async () => {
      let resolveStale!: (page: { items: typeof child[]; total: number; limit: number; offset: number }) => void;
      api.listFollowUps.mockReturnValueOnce(new Promise((resolve) => { resolveStale = resolve; }))
        .mockResolvedValueOnce({ items: [child], total: 1, limit: 100, offset: 0 });
      const source = await renderWithRealtime(<FollowUpChildrenPanel sourceId={rootJob.id} />);
      await flush();
      await act(async () => source.emit('servora.change', changeEnvelope('2', [`job-detail:${rootJob.id}`])));
      await flush();
      expect(host.textContent).toContain('1 / 1 takip işi gösteriliyor.');
      await act(async () => resolveStale({ items: [], total: 0, limit: 100, offset: 0 }));
      await flush();
      expect(host.textContent).toContain('1 / 1 takip işi gösteriliyor.');
      expect(host.textContent).toContain('Realtime takip');
    });

    it('subscribes the panel only while the source is open', async () => {
      api.listFollowUps.mockResolvedValue({ items: [child], total: 1, limit: 100, offset: 0 });
      const source = await renderWithRealtime(<FollowUpChildrenPanel sourceId={rootJob.id} />);
      await flush();
      await act(async () => source.emit('servora.change', changeEnvelope('3', [`job-detail:${rootJob.id}`])));
      await flush();
      expect(api.listFollowUps).toHaveBeenCalledTimes(2);
      await act(async () => root.render(<RealtimeProvider eventSourceFactory={() => source}><div /></RealtimeProvider>));
      await flush();
      api.listFollowUps.mockClear();
      await act(async () => source.emit('servora.change', changeEnvelope('4', [`job-detail:${rootJob.id}`])));
      await flush();
      expect(api.listFollowUps).not.toHaveBeenCalled();
    });
  });
});
