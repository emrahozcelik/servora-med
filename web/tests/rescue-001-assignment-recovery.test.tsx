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
import { JobDetailPanel } from '../src/JobDetail';
import { AssignmentOfferSection } from '../src/jobs/AssignmentOffer';
import { JobAttentionPanel } from '../src/jobs/JobAttentionPanel';
import { parseJobSearch } from '../src/jobs/job-search';
import type {
  AssignmentOffer,
  AssignmentOfferNeedingActionItem,
  JobCard,
  OpenChangeRequestItem,
  UnacceptedPastStartItem,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { buildNavigationModel, resolveHomePath } from '../src/shell/navigation-model';
import { workflowContext } from './fixtures/job-workflow';

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

function makeOfferItem(index: number): AssignmentOfferNeedingActionItem {
  return {
    jobCardId: `offer-job-${index}`,
    jobTitle: `Reddedilen Atama ${index}`,
    jobType: 'PRODUCT_DELIVERY',
    offerId: `offer-${index}`,
    state: 'DECLINED',
    closeReason: 'ON_LEAVE',
    closeText: `Gizli red metni ${index}`,
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

describe('RESCUE-001 web characterization (R05 & R02)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    stubMatchMedia(true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], total: 0, limit: 25, offset: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('R05: JobAttentionPanel caps each group at 3 compact rows, omits close reason/text/proposal, and links to /overview even when Overview is off (dead end)', async () => {
    const crPage = [1, 2, 3].map(makeChangeRequest);
    const offerPage = [1, 2, 3].map(makeOfferItem);
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

    // Compact offer rows show offer state + acceptanceDueAt, NOT closeReason/closeText/proposedScheduledAt.
    const offerGroupText = groups[1]?.textContent ?? '';
    expect(offerGroupText).toContain('Reddedildi');
    expect(offerGroupText).not.toContain('İzinli');
    expect(offerGroupText).not.toContain('Gizli red metni');
    expect(offerGroupText).not.toContain('27 Kas');

    // Overflow link still points unconditionally to /overview even when overviewDashboard=false.
    const overflowLink = container.querySelector<HTMLAnchorElement>('.job-attention-overview-link a');
    expect(overflowLink?.getAttribute('href')).toBe('/overview');
    expect(overflowLink?.textContent).toBe('Tümünü Genel bakışta gör');

    // Now prove the dead end inside AppRouter with overviewDashboard=false (same pattern as overview-module-switch.test.tsx).
    const offUser = managerUser(false);
    expect(buildNavigationModel(offUser).destinations.some((d) => d.id === 'overview')).toBe(false);
    expect(resolveHomePath(offUser)).toBe('/jobs');

    routerMocks.attentionLoaders.loadChangeRequests.mockResolvedValue({ items: crPage, total: 5, limit: 3, offset: 0 });
    routerMocks.attentionLoaders.loadAssignmentOffers.mockResolvedValue({ items: offerPage, total: 5, limit: 3, offset: 0 });
    routerMocks.attentionLoaders.loadUnacceptedPastStart.mockResolvedValue({ items: unaccPage, total: 4, limit: 3, offset: 0 });

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/jobs']}>
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
    await act(async () => { await Promise.resolve(); });

    const routerOverflowLink = container.querySelector<HTMLAnchorElement>('.job-attention-overview-link a');
    expect(routerOverflowLink?.getAttribute('href')).toBe('/overview');

    await act(async () => {
      routerOverflowLink!.click();
    });
    await act(async () => { await vi.dynamicImportSettled(); });

    // Clicking "Tümünü Genel bakışta gör" routes to /overview, which immediately redirects back to /jobs!
    expect(container.querySelector('[data-location]')?.textContent).toBe('/jobs');
    expect(container.querySelector('[data-page="overview"]')).toBeNull();
    expect(container.querySelectorAll('[data-job-attention-row="true"]')).toHaveLength(9);

    // No Jobs query parameter exists to filter by declined offers, open change requests, or unaccepted past-start.
    const search = parseJobSearch(new URLSearchParams(
      'assignmentOffer=DECLINED&changeRequest=OPEN&unaccepted=true',
    ));
    expect(Object.keys(search)).toEqual(['view', 'offset', 'status']);
  });

  it('R02: renders reason-ordered manager recovery actions after DECLINE and delegates to separate editors/actions', async () => {
    const manager = managerUser(true);

    // 1) Non-schedule reasons (ON_LEAVE, TOO_FAR, MISSING_STOCK_OR_EQUIPMENT, OTHER): reassign first.
    for (const closeReason of ['ON_LEAVE', 'TOO_FAR', 'MISSING_STOCK_OR_EQUIPMENT', 'OTHER'] as const) {
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
      expect(buttons[1]?.className).toContain('secondary-button');
      expect(buttons[2]?.className).toContain('secondary-button');
    }

    // 2) SCHEDULE_CONFLICT without a proposal: new-time first.
    await act(async () => {
      root.render(
        <AssignmentOfferSection
          job={declinedJob({ closeReason: 'SCHEDULE_CONFLICT', proposedScheduledAt: null })}
          user={manager}
          onReassign={vi.fn()}
        />,
      );
    });
    const noProposalButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(
      '[data-assignment-offer-recovery="DECLINED"] [data-assignment-offer-action]',
    ));
    expect(noProposalButtons.map((b) => b.textContent?.trim())).toEqual([
      'Yeni zaman belirle',
      'Sorumlu personeli değiştir',
      'Aynı zamanla yeniden teklif et',
    ]);
    expect(noProposalButtons[0]?.className).toContain('primary-button');

    // 3) SCHEDULE_CONFLICT with valid future proposal (JOB-012): accept-proposal is primary first.
    const futureStart = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const futureEnd = new Date(Date.parse(futureStart) + 30 * 60_000).toISOString();
    await act(async () => {
      root.render(
        <AssignmentOfferSection
          job={declinedJob({
            closeReason: 'SCHEDULE_CONFLICT',
            proposedScheduledAt: futureStart,
            proposedScheduledEndsAt: futureEnd,
          })}
          user={manager}
          onReassign={vi.fn()}
        />,
      );
    });
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

    // 4) SCHEDULE_CONFLICT with expired proposal: confirm hidden, expired text shown, new-time primary.
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

    // 5) Full JobDetailPanel composition: recovery sits in AssignmentOfferSection while CANCEL stays in the decision panel.
    const onCommand = vi.fn();
    const onRecordEdit = vi.fn();
    await act(async () => {
      root.render(
        <JobDetailPanel
          job={declinedJob({ closeReason: 'ON_LEAVE' })}
          items={[]}
          user={manager}
          pending={false}
          message=""
          messageIsError={false}
          assignmentOffer={
            <AssignmentOfferSection
              job={declinedJob({ closeReason: 'ON_LEAVE' })}
              user={manager}
              onReassign={(trigger) => onRecordEdit('EDIT_JOB_FIELDS', trigger)}
            />
          }
          onCommand={onCommand}
          onRecordEdit={onRecordEdit}
        />,
      );
    });
    expect(container.querySelector('[data-assignment-offer-recovery="DECLINED"]')).not.toBeNull();
    // Separate lifecycle cancel button lives outside AssignmentOfferSection.
    const allButtons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim());
    expect(allButtons).toContain('İşi iptal et');
    expect(container.querySelector('[data-assignment-offer-recovery="DECLINED"]')?.textContent)
      .not.toContain('İşi iptal et');
  });
});
