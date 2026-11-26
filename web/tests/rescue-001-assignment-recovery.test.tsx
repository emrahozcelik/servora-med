/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const routerMocks = vi.hoisted(() => ({
  attentionLoaders: {
    loadChangeRequests: vi.fn(),
    loadAssignmentOffers: vi.fn(),
    loadUnacceptedPastStart: vi.fn(),
  },
}));

vi.mock('../src/jobs/JobWorkspace', async () => {
  const actual = await vi.importActual<typeof import('../src/jobs/JobWorkspace')>('../src/jobs/JobWorkspace');
  return {
    JobWorkspace: (props: Parameters<typeof actual.JobWorkspace>[0]) => (
      <actual.JobWorkspace {...props} attentionLoaders={routerMocks.attentionLoaders} />
    ),
  };
});

vi.mock('../src/overview/OverviewPage', () => ({
  OverviewPage: () => <div data-page="overview" />,
}));

import { AppRouter } from '../src/AppRouter';
import { JobDetailScreen } from '../src/JobDetail';
import { AssignmentOfferSection } from '../src/jobs/AssignmentOffer';
import { JobAttentionPanel } from '../src/jobs/JobAttentionPanel';
import { parseJobSearch } from '../src/jobs/job-search';
import type {
  AssignmentOffer,
  AssignmentOfferNeedingActionItem,
  JobCard,
  JobCardListItem,
  OpenChangeRequestItem,
  UnacceptedPastStartItem,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { buildNavigationModel, resolveHomePath } from '../src/shell/navigation-model';
import { withoutSaleCapability, workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function managerUser(overviewDashboard: boolean): CurrentUser {
  return {
    id: 'manager-1',
    organizationId: 'org-1',
    name: 'Murat Yönetici',
    email: 'manager@rescue001.local',
    role: 'MANAGER',
    mustChangePassword: false,
    isActive: true,
    version: 1,
    capabilities: { overviewDashboard, calendar: false, messaging: false },
    support: { displayLabel: 'Destek', email: null, helpUrl: null },
  };
}

function makeChangeRequest(index: number): OpenChangeRequestItem {
  return {
    changeRequestId: `cr-${index}`,
    jobCardId: `cr-job-${index}`,
    jobTitle: `Öneri İşi ${index}`,
    jobType: 'PRODUCT_DELIVERY',
    jobStatus: 'ACCEPTED',
    reasonCode: 'CUSTOMER_POSTPONED',
    reasonText: `Açıklama ${index}`,
    requestedAt: `2026-11-26T0${index}:00:00.000Z`,
    requestedBy: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'cust-1', name: 'Klinik' },
    jobPath: `/jobs/cr-job-${index}`,
  };
}

function makeOnLeaveOfferItem(index: number): AssignmentOfferNeedingActionItem {
  return {
    jobCardId: `offer-job-${index}`,
    jobTitle: `Reddedilen Atama ${index}`,
    jobType: 'PRODUCT_DELIVERY',
    offerId: `offer-${index}`,
    state: 'DECLINED',
    closeReason: 'ON_LEAVE',
    closeText: `Gizli izin metni ${index}`,
    acceptanceDueAt: `2026-11-26T1${index}:00:00.000Z`,
    urgentReason: null,
    scheduledAt: `2026-11-26T1${index}:30:00.000Z`,
    proposedScheduledAt: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'cust-1', name: 'Klinik' },
    jobPath: `/jobs/offer-job-${index}`,
  };
}

function makeScheduleConflictOfferItem(index: number): AssignmentOfferNeedingActionItem {
  return {
    jobCardId: `offer-job-${index}`,
    jobTitle: `Reddedilen Atama ${index}`,
    jobType: 'PRODUCT_DELIVERY',
    offerId: `offer-${index}`,
    state: 'DECLINED',
    closeReason: 'SCHEDULE_CONFLICT',
    closeText: `Gizli çakışma metni ${index}`,
    acceptanceDueAt: `2026-11-26T1${index}:00:00.000Z`,
    urgentReason: null,
    scheduledAt: `2026-11-26T1${index}:30:00.000Z`,
    proposedScheduledAt: '2026-11-27T10:00:00.000Z',
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'cust-1', name: 'Klinik' },
    jobPath: `/jobs/offer-job-${index}`,
  };
}

function makeUnacceptedItem(index: number): UnacceptedPastStartItem {
  return {
    jobCardId: `unacc-job-${index}`,
    title: `Kabul Bekleyen İş ${index}`,
    type: 'SALES_MEETING',
    jobPath: `/jobs/unacc-job-${index}`,
    assignee: { id: 'staff-2', name: 'Mehmet Personel', active: true },
    scheduledAt: `2026-11-26T0${index}:30:00.000Z`,
    elapsedSeconds: 3600,
    hasOpenChangeRequest: false,
  };
}

function makeJobListItem(id: string, title: string): JobCardListItem {
  return {
    id,
    type: 'PRODUCT_DELIVERY',
    status: 'NEW',
    version: 2,
    title,
    priority: 'normal',
    dueDate: null,
    scheduledAt: '2026-11-26T14:30:00.000Z',
    scheduledEndsAt: '2026-11-26T15:00:00.000Z',
    engagementKind: null,
    createdAt: '2026-11-26T08:00:00.000Z',
    updatedAt: '2026-11-26T08:30:00.000Z',
    staffCompletedAt: null,
    customer: { id: 'cust-1', name: 'Klinik' },
    contact: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    deliveryItemCount: 1,
    allowedCommands: ['CANCEL'],
  };
}

function LocationProbe() {
  const { pathname } = useLocation();
  return <output data-location>{pathname}</output>;
}

function stubMatchMedia(desktop: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: desktop,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

function declinedJob(offerOverrides: Partial<AssignmentOffer> = {}): JobCard {
  const offer: AssignmentOffer = {
    id: 'offer-1',
    state: 'DECLINED',
    openedAt: '2026-11-26T08:00:00.000Z',
    acceptanceDueAt: '2026-11-26T10:00:00.000Z',
    urgentReason: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    closedAt: '2026-11-26T08:30:00.000Z',
    closeReason: 'ON_LEAVE',
    closeText: 'Yıllık izindeyim.',
    proposedScheduledAt: null,
    proposedScheduledEndsAt: null,
    proposalAcceptedAt: null,
    ...offerOverrides,
  };
  return {
    id: 'job-1',
    organizationId: 'org-1',
    organizationTimezone: 'Europe/Istanbul',
    type: 'PRODUCT_DELIVERY',
    status: 'NEW',
    version: 2,
    title: 'Klinik implant teslimi',
    description: null,
    customerId: 'c1',
    contactId: null,
    assignedTo: 'staff-1',
    createdBy: 'manager-1',
    priority: 'normal',
    dueDate: null,
    scheduledAt: '2026-11-26T11:00:00.000Z',
    scheduledEndsAt: '2026-11-26T11:30:00.000Z',
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Diş Kliniği' },
    contact: null,
    workflowContext: {
      ...workflowContext,
      allowedCommands: ['CANCEL'],
      allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES', 'ADD_NOTE'],
      lifecycle: {
        ...workflowContext.lifecycle,
        startedAt: null,
      },
    },
    followUpContext: null,
    followUpProposal: null,
    earlyStartAuthorization: null,
    submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: offer,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockDetailFetch(card: JobCard) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = withoutSaleCapability(String(input));
    const path = url.split('?')[0] ?? url;
    if (url.endsWith('/delivery-items')) return json({ items: [] });
    if (url.startsWith('/api/staff?')) return json([]);
    if (url.includes('/notes?')) return json({ items: [], total: 0, limit: 25, offset: 0, nextCursor: null });
    if (url.includes('/activity?')) return json({ items: [], total: 0, limit: 50, offset: 0 });
    if (url.includes('/submission-lateness')) return json({ open: null });
    if (url.includes('/overdue-incidents')) return json({ items: [], total: 0, limit: 25, offset: 0 });
    if (url.includes('/follow-ups')) return json({ items: [], total: 0, limit: 25, offset: 0 });
    if (path.endsWith(`/api/job-cards/${card.id}`)) return json(card);
    throw new Error(`Unexpected request: ${url}`);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('RESCUE-001 web characterization (R05 & R02)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia(true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn(async () => json({
      items: [makeJobListItem('offer-job-4', 'Reddedilen Atama 4')],
      total: 1,
      limit: 25,
      offset: 0,
    })));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('R05: JobAttentionPanel caps groups at 3 compact rows (omitting close reason/text/proposal) and its overflow link loops back to /jobs when Overview is off', async () => {
    const crPage = [1, 2, 3].map(makeChangeRequest);
    const offerPage = [
      makeOnLeaveOfferItem(1),
      makeScheduleConflictOfferItem(2),
      makeOnLeaveOfferItem(3),
    ];
    const unaccPage = [1, 2, 3].map(makeUnacceptedItem);

    const loadChangeRequests = vi.fn().mockResolvedValue({ items: crPage, total: 5, limit: 3, offset: 0 });
    const loadAssignmentOffers = vi.fn().mockResolvedValue({ items: offerPage, total: 5, limit: 3, offset: 0 });
    const loadUnacceptedPastStart = vi.fn().mockResolvedValue({ items: unaccPage, total: 4, limit: 3, offset: 0 });

    await act(async () => {
      root.render(
        <MemoryRouter>
          <JobAttentionPanel
            user={managerUser(false)}
            loadChangeRequests={loadChangeRequests}
            loadAssignmentOffers={loadAssignmentOffers}
            loadUnacceptedPastStart={loadUnacceptedPastStart}
          />
        </MemoryRouter>,
      );
    });
    await act(async () => { await Promise.resolve(); });

    // Only first 3 rows per group are requested and rendered (total = 14 across 5+5+4).
    expect(loadChangeRequests).toHaveBeenCalledWith({ limit: 3, offset: 0 });
    expect(loadAssignmentOffers).toHaveBeenCalledWith({ limit: 3, offset: 0 });
    expect(loadUnacceptedPastStart).toHaveBeenCalledWith({ limit: 3, offset: 0 });
    expect(container.querySelector('.job-attention-count')?.textContent).toBe('14 kayıt');

    const groups = container.querySelectorAll('[data-job-attention-group="true"]');
    expect(groups).toHaveLength(3);
    expect(groups[0]?.querySelectorAll('[data-job-attention-row="true"]')).toHaveLength(3);
    expect(groups[1]?.querySelectorAll('[data-job-attention-row="true"]')).toHaveLength(3);
    expect(groups[2]?.querySelectorAll('[data-job-attention-row="true"]')).toHaveLength(3);

    // Compact offer rows show state + acceptanceDueAt:
    // - ON_LEAVE row omits closeReason ('İzinli') and closeText
    // - SCHEDULE_CONFLICT row omits closeReason ('Plan çakışması'), closeText, and proposedScheduledAt ('27 Kas')
    const offerGroupText = groups[1]?.textContent ?? '';
    expect(offerGroupText).toContain('Reddedildi');
    expect(offerGroupText).not.toContain('İzinli');
    expect(offerGroupText).not.toContain('Gizli izin metni');
    expect(offerGroupText).not.toContain('Plan çakışması');
    expect(offerGroupText).not.toContain('Gizli çakışma metni');
    expect(offerGroupText).not.toContain('27 Kas');

    routerMocks.attentionLoaders.loadChangeRequests.mockResolvedValue({ items: crPage, total: 5, limit: 3, offset: 0 });
    routerMocks.attentionLoaders.loadAssignmentOffers.mockResolvedValue({ items: offerPage, total: 5, limit: 3, offset: 0 });
    routerMocks.attentionLoaders.loadUnacceptedPastStart.mockResolvedValue({ items: unaccPage, total: 4, limit: 3, offset: 0 });

    // Positive control: when Overview is ON, clicking the overflow link reaches /overview.
    const onUser = managerUser(true);
    expect(buildNavigationModel(onUser).destinations.some((d) => d.id === 'overview')).toBe(true);
    await act(async () => {
      root.render(
        <MemoryRouter key="router-overview-on" initialEntries={['/jobs']}>
          <LocationProbe />
          <AppRouter
            user={onUser}
            notice=""
            onDeliveryCreated={() => {}}
            onSessionEnded={() => {}}
          />
        </MemoryRouter>,
      );
    });
    await act(async () => { await vi.dynamicImportSettled(); });
    await settle();

    const onOverflowLink = container.querySelector<HTMLAnchorElement>('.job-attention-overview-link a');
    expect(onOverflowLink?.getAttribute('href')).toBe('/overview');
    await act(async () => { onOverflowLink!.click(); });
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(container.querySelector('[data-location]')?.textContent).toBe('/overview');
    expect(container.querySelector('[data-page="overview"]')).not.toBeNull();

    // Overview OFF: direct /overview route redirects to /jobs.
    const offUser = managerUser(false);
    expect(buildNavigationModel(offUser).destinations.some((d) => d.id === 'overview')).toBe(false);
    expect(resolveHomePath(offUser)).toBe('/jobs');

    await act(async () => {
      root.render(
        <MemoryRouter key="router-overview-off-direct" initialEntries={['/overview']}>
          <LocationProbe />
          <AppRouter
            user={offUser}
            notice=""
            onDeliveryCreated={() => {}}
            onSessionEnded={() => {}}
          />
        </MemoryRouter>,
      );
    });
    await act(async () => { await vi.dynamicImportSettled(); });
    await settle();
    expect(container.querySelector('[data-location]')?.textContent).toBe('/jobs');
    expect(container.querySelector('[data-page="overview"]')).toBeNull();

    // Overview OFF on /jobs: clicking "Tümünü Genel bakışta gör" redirects straight back to /jobs,
    // leaving the intervention queue continuation (items 4+) unreachable as a queue.
    const offOverflowLink = container.querySelector<HTMLAnchorElement>('.job-attention-overview-link a');
    expect(offOverflowLink?.getAttribute('href')).toBe('/overview');
    await act(async () => { offOverflowLink!.click(); });
    await act(async () => { await vi.dynamicImportSettled(); });
    await settle();
    expect(container.querySelector('[data-location]')?.textContent).toBe('/jobs');
    expect(container.querySelector('[data-page="overview"]')).toBeNull();
    expect(container.querySelectorAll('[data-job-attention-row="true"]')).toHaveLength(9);

    // Individual known jobs (e.g. item #4) remain reachable only via the general /jobs list/search,
    // while parseJobSearch offers no intervention-queue filter.
    expect(container.querySelector('a[href="/jobs/offer-job-4"]')?.textContent)
      .toContain('Reddedilen Atama 4');
    const search = parseJobSearch(new URLSearchParams(
      'assignmentOffer=DECLINED&changeRequest=OPEN&unaccepted=true',
    ));
    expect(Object.keys(search)).toEqual(['view', 'offset', 'status']);
  });

  it('R02: JobDetailScreen renders reason-ordered manager recovery actions after DECLINE and wires clicks to existing editors', async () => {
    const manager = managerUser(true);

    // 1) Component check for remaining non-schedule reasons and SCHEDULE_CONFLICT edge cases.
    for (const closeReason of ['TOO_FAR', 'MISSING_STOCK_OR_EQUIPMENT', 'OTHER'] as const) {
      await act(async () => {
        root.render(
          <AssignmentOfferSection
            job={declinedJob({ closeReason })}
            user={manager}
            onReassign={vi.fn()}
          />,
        );
      });
      const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>(
        '[data-assignment-offer-recovery="DECLINED"] [data-assignment-offer-action]',
      ));
      expect(buttons.map((b) => b.textContent?.trim())).toEqual([
        'Sorumlu personeli değiştir',
        'Yeni zaman belirle',
        'Aynı zamanla yeniden teklif et',
      ]);
      expect(buttons[0]?.className).toContain('primary-button');
    }

    await act(async () => {
      root.render(
        <AssignmentOfferSection
          job={declinedJob({ closeReason: 'SCHEDULE_CONFLICT', proposedScheduledAt: null })}
          user={manager}
          onReassign={vi.fn()}
        />,
      );
    });
    expect(Array.from(container.querySelectorAll<HTMLButtonElement>(
      '[data-assignment-offer-recovery="DECLINED"] [data-assignment-offer-action]',
    )).map((b) => b.textContent?.trim())).toEqual([
      'Yeni zaman belirle',
      'Sorumlu personeli değiştir',
      'Aynı zamanla yeniden teklif et',
    ]);

    await act(async () => {
      root.render(
        <AssignmentOfferSection
          job={declinedJob({
            closeReason: 'SCHEDULE_CONFLICT',
            proposedScheduledAt: '2020-01-01T10:00:00.000Z',
            proposedScheduledEndsAt: '2020-01-01T10:30:00.000Z',
          })}
          user={manager}
          onReassign={vi.fn()}
        />,
      );
    });
    expect(container.querySelector('[data-assignment-offer-action="accept-proposal"]')).toBeNull();
    expect(container.querySelector('[data-assignment-offer-proposal-expired="true"]')?.textContent)
      .toContain('Önerilen zaman geçti');

    // 2) Full JobDetailScreen integration (ON_LEAVE): verifies real button order,
    // clicking "Sorumlu personeli değiştir" opens the shared DeliveryAssigneeEditForm,
    // and "İşi iptal et" sits separately in the İşlemler decision panel.
    const onLeaveCard = declinedJob({ closeReason: 'ON_LEAVE' });
    vi.stubGlobal('fetch', mockDetailFetch(onLeaveCard));
    await act(async () => {
      root.render(
        <JobDetailScreen
          jobId={onLeaveCard.id}
          user={manager}
          onBack={() => {}}
          onChanged={() => {}}
        />,
      );
    });
    await settle();

    const recoveryBlock = container.querySelector('[data-assignment-offer-recovery="DECLINED"]');
    expect(recoveryBlock).not.toBeNull();
    const screenButtons = Array.from(recoveryBlock!.querySelectorAll<HTMLButtonElement>(
      '[data-assignment-offer-action]',
    ));
    expect(screenButtons.map((b) => b.textContent?.trim())).toEqual([
      'Sorumlu personeli değiştir',
      'Yeni zaman belirle',
      'Aynı zamanla yeniden teklif et',
    ]);
    expect(screenButtons[0]?.className).toContain('primary-button');
    expect(recoveryBlock!.textContent).not.toContain('İşi iptal et');
    expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim()))
      .toContain('İşi iptal et');

    await act(async () => {
      recoveryBlock!.querySelector<HTMLButtonElement>('[data-assignment-offer-action="reassign"]')!.click();
    });
    await settle();
    expect(container.querySelector('.delivery-assignee-details')).not.toBeNull();
    expect(container.textContent).toContain('Sorumlu personel düzenleme alanı açıldı.');

    // 3) Full JobDetailScreen integration (SCHEDULE_CONFLICT with future proposal):
    // verifies "Önerilen zamanı onayla" is primary first and clicking "Yeni zaman belirle"
    // opens and focuses the real #job-scheduled-at planned-time editor.
    const futureStart = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const futureEnd = new Date(Date.parse(futureStart) + 30 * 60_000).toISOString();
    const proposalCard = declinedJob({
      closeReason: 'SCHEDULE_CONFLICT',
      proposedScheduledAt: futureStart,
      proposedScheduledEndsAt: futureEnd,
    });
    vi.stubGlobal('fetch', mockDetailFetch(proposalCard));
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    });

    await act(async () => {
      root.render(
        <JobDetailScreen
          key="proposal-card"
          jobId={proposalCard.id}
          user={manager}
          onBack={() => {}}
          onChanged={() => {}}
        />,
      );
    });
    await settle();

    const proposalButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(
      '[data-assignment-offer-recovery="DECLINED"] [data-assignment-offer-action]',
    ));
    expect(proposalButtons.map((b) => b.textContent?.trim())).toEqual([
      'Önerilen zamanı onayla',
      'Yeni zaman belirle',
      'Sorumlu personeli değiştir',
      'Aynı zamanla yeniden teklif et',
    ]);
    expect(proposalButtons[0]?.className).toContain('primary-button');
    expect(proposalButtons.slice(1).every((b) => b.className.includes('secondary-button'))).toBe(true);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-assignment-offer-action="new-time"]')!.click();
    });
    await settle();
    expect(container.querySelector('#job-scheduled-at')).not.toBeNull();
    expect(document.activeElement?.id).toBe('job-scheduled-at');
  });
});
