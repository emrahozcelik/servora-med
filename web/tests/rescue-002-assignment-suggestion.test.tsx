/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailScreen } from '../src/JobDetail';
import { AssignmentOfferSection } from '../src/jobs/AssignmentOffer';
import { JobTimeline } from '../src/jobs/JobTimeline';
import { isoInstantToLocalDateTime, localDateTimeToIso } from '../src/jobs/scheduling';
import type {
  AssignmentOffer,
  JobCard,
  JobCardActivity,
  JobLifecycleFacts,
  MeetingDetails,
  Paginated,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { withoutSaleCapability, workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * RESCUE-002: the Staff decline/release form gets a mandatory typed suggested
 * solution, and the time proposal is tied to RESCHEDULE_SELF. The manager
 * panel and timeline present the recorded suggestion.
 */

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe Personel', email: 'a@x', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};
const manager: CurrentUser = {
  ...staff, id: 'manager-1', name: 'Mehmet Yönetici', role: 'MANAGER', email: 'm@x',
};

const lifecycle: JobLifecycleFacts = {
  createdAt: '2026-11-21T08:00:00.000Z', acceptedAt: null, acceptedBy: null,
  startedAt: null, submittedAt: null, submittedBy: null, submissionNote: null,
  approvedAt: null, approvedBy: null, approvalNote: null,
  revisionRequestedAt: null, revisionRequestedBy: null, revisionReason: null,
  cancelledAt: null, cancelledBy: null, cancelReason: null, cancelledFromStatus: null,
};

const offer: AssignmentOffer = {
  id: 'offer-1',
  state: 'OPEN',
  openedAt: '2026-11-21T11:00:00.000Z',
  acceptanceDueAt: '2026-11-21T12:00:00.000Z',
  urgentReason: 'SHORT_NOTICE',
  assignee: { id: 'staff-1', name: 'Ayşe Personel' },
  closedAt: null,
  closeReason: null,
  closeText: null,
  suggestedSolution: null,
  proposedScheduledAt: null,
  proposedScheduledEndsAt: null,
  proposalAcceptedAt: null,
};

function closedOffer(overrides: Partial<AssignmentOffer> = {}): AssignmentOffer {
  return {
    ...offer,
    state: 'DECLINED',
    urgentReason: null,
    closedAt: '2026-11-21T11:20:00.000Z',
    closeReason: 'OUT_OF_TOWN',
    closeText: 'Şehir dışında bir kongredeyim.',
    suggestedSolution: 'REASSIGN',
    ...overrides,
  };
}

function futureProposal(reason: AssignmentOffer['closeReason']): AssignmentOffer {
  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setSeconds(0, 0);
  return closedOffer({
    closeReason: reason,
    closeText: null,
    suggestedSolution: 'RESCHEDULE_SELF',
    proposedScheduledAt: start.toISOString(),
    proposedScheduledEndsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    proposalAcceptedAt: null,
  });
}

function jobCard(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', organizationTimezone: 'Europe/Istanbul',
    type: 'PRODUCT_DELIVERY', status: 'NEW', version: 3,
    title: 'Klinik teslimi', description: null, customerId: 'c1', contactId: null,
    assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal', dueDate: null,
    scheduledAt: '2026-11-21T11:00:00.000Z', scheduledEndsAt: '2026-11-21T12:00:00.000Z',
    engagementKind: null,
    assignee: { id: 'staff-1', name: 'Ayşe Personel' },
    customer: { id: 'c1', name: 'ABC Klinik' }, contact: null,
    workflowContext: {
      ...workflowContext,
      allowedCommands: ['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT'],
      allowedActions: ['VIEW_NOTES'],
      lifecycle,
    },
    followUpContext: null,
    followUpProposal: null,
    earlyStartAuthorization: null,
    submitLocationComparison: null,
    changeRequest: null,
    assignmentOffer: offer,
    hasOpenOverdueIncident: false,
    correctionDueAt: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function futureLocal(days: number): string {
  return isoInstantToLocalDateTime(new Date(Date.now() + days * 86_400_000).toISOString());
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(host: ParentNode, name: string) {
  return Array.from(host.querySelectorAll('button'))
    .find((button) => button.textContent?.trim() === name) ?? null;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function selectValue(element: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function chooseSuggestion(host: ParentNode, code: string) {
  const input = host.querySelector<HTMLInputElement>(
    `input[name="assignment-suggested-solution"][value="${code}"]`,
  );
  expect(input).not.toBeNull();
  await act(async () => input!.click());
}

describe('RESCUE-002 staff decline suggestion', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const meetingDetails: MeetingDetails = {
    jobCardId: 'job-1', meetingAt: null, outcome: null, unsuccessfulReason: null,
    meetingSummary: null, nextFollowUpAt: null, metContactId: null, metContact: null,
    jobCardVersion: 3,
  };

  function mockDetailFetch(card: JobCard) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const path = url.split('?')[0] ?? url;
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        throw new Error(`Unexpected write: ${url}`);
      }
      if (url.endsWith('/delivery-items')) return json({ items: [] });
      if (url.startsWith('/api/staff?')) return json([]);
      if (url.includes('/meeting-details')) return json({ ...meetingDetails, jobCardVersion: card.version });
      if (url.includes('/notes?')) return json({ items: [], total: 0, limit: 25, offset: 0, nextCursor: null });
      if (url.includes('/activity?')) return json({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (url.includes('/overdue-incidents')) return json({ items: [], total: 0, limit: 25, offset: 0 });
      if (url.includes('/follow-ups')) return json({ items: [], total: 0, limit: 25, offset: 0 });
      if (path.endsWith(`/api/job-cards/${card.id}`)) return json(card);
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  async function renderScreen(
    card: JobCard,
    fetchMock: ReturnType<typeof mockDetailFetch>,
    user: CurrentUser = staff,
  ) {
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={user} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function dialog() {
    return host.querySelector('[role="dialog"]') as HTMLElement | null;
  }

  function reasonSelect() {
    return dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement;
  }

  it('shows all eight reason codes in the locked display order', async () => {
    const card = jobCard();
    await renderScreen(card, mockDetailFetch(card));

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    const labels = Array.from(reasonSelect().options)
      .filter((option) => option.value !== '')
      .map((option) => option.textContent);

    expect(labels).toEqual([
      'Plan çakışması',
      'İzinli / müsait değilim',
      'Şehir dışındayım',
      'Konum çok uzak',
      'Müşteri erteledi',
      'Ürün veya kayıt bilgisi hatalı',
      'Stok veya ekipman eksik',
      'Diğer',
    ]);
    expect(Array.from(reasonSelect().options).filter((option) => option.value !== ''))
      .toHaveLength(8);
  });

  it('shows the five suggested solutions in the contract order', async () => {
    const card = jobCard();
    await renderScreen(card, mockDetailFetch(card));

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    const labels = Array.from(dialog()!.querySelectorAll('input[name="assignment-suggested-solution"]'))
      .map((input) => input.closest('label')?.textContent?.trim());

    expect(labels).toEqual([
      'Başka bir zamanda kendim yapabilirim',
      'Başka bir personele verilsin',
      'İş bilgileri düzeltilsin',
      'İptal edilmesini öneriyorum',
      'Yönetici karar versin',
    ]);
  });

  it('blocks a decline until a suggested solution is chosen and then sends it', async () => {
    const card = jobCard();
    const fetchMock = mockDetailFetch(card);
    await renderScreen(card, fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    await act(async () => selectValue(reasonSelect(), 'WRONG_PRODUCT'));
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Klinik yanlış ürün istedi.',
    ));

    const declineCalls = () => fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/decline'));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    expect(dialog()?.querySelector('#assignment-suggested-solution-error')?.textContent)
      .toBe('Çözüm önerisi zorunludur.');
    expect(dialog()?.querySelector('input[name="assignment-suggested-solution"]')?.getAttribute('aria-invalid'))
      .toBe('true');
    expect(declineCalls()).toHaveLength(0);

    await chooseSuggestion(dialog()!, 'REASSIGN');
    expect(dialog()?.querySelector('#assignment-suggested-solution-error')).toBeNull();
    fetchMock.mockResolvedValueOnce(json(jobCard({ version: 4 })));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    expect(declineCalls()).toHaveLength(1);
    expect(String(declineCalls()[0]![0]))
      .toBe('/api/job-cards/job-1/decline?includeSaleCapability=true');
    const body = JSON.parse(String((declineCalls()[0]![1] as RequestInit).body));
    expect(body).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 3,
      reasonCode: 'WRONG_PRODUCT',
      reasonText: 'Klinik yanlış ürün istedi.',
      suggestedSolution: 'REASSIGN',
    });
    // A non-reschedule suggestion forbids the time field in the body.
    expect(body).not.toHaveProperty('proposedScheduledAt');
  });

  it('requires and sends the proposed time only for RESCHEDULE_SELF', async () => {
    const card = jobCard();
    const fetchMock = mockDetailFetch(card);
    await renderScreen(card, fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    await act(async () => selectValue(reasonSelect(), 'SCHEDULE_CONFLICT'));
    await chooseSuggestion(dialog()!, 'RESCHEDULE_SELF');
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Sabah başka teslim var.',
    ));

    const declineCalls = () => fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/decline'));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    expect(dialog()?.querySelector('#assignment-proposed-at-error')?.textContent)
      .toBe('Önerilen zaman zorunludur.');
    expect(declineCalls()).toHaveLength(0);

    // Switching to another suggestion hides and clears the time.
    await act(async () => setNativeValue(
      dialog()!.querySelector('#assignment-proposed-at') as HTMLInputElement,
      futureLocal(2),
    ));
    await chooseSuggestion(dialog()!, 'MANAGEMENT_DECIDES');
    expect(dialog()?.querySelector('#assignment-proposed-at')).toBeNull();

    await chooseSuggestion(dialog()!, 'RESCHEDULE_SELF');
    const proposedLocal = futureLocal(3);
    await act(async () => setNativeValue(
      dialog()!.querySelector('#assignment-proposed-at') as HTMLInputElement,
      proposedLocal,
    ));
    fetchMock.mockResolvedValueOnce(json(jobCard({ version: 4 })));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    expect(declineCalls()).toHaveLength(1);
    expect(JSON.parse(String((declineCalls()[0]![1] as RequestInit).body))).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 3,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Sabah başka teslim var.',
      suggestedSolution: 'RESCHEDULE_SELF',
      proposedScheduledAt: localDateTimeToIso(proposedLocal),
    });
  });

  it('sends the suggestion through release as well', async () => {
    const accepted = jobCard({
      status: 'ACCEPTED',
      version: 4,
      workflowContext: {
        ...workflowContext,
        allowedCommands: ['START', 'RELEASE_ASSIGNMENT'],
        allowedActions: ['VIEW_NOTES'],
        lifecycle: {
          ...lifecycle,
          acceptedAt: '2026-11-21T11:20:00.000Z',
          acceptedBy: { id: 'staff-1', name: 'Ayşe Personel' },
        },
      },
    });
    const fetchMock = mockDetailFetch(accepted);
    await renderScreen(accepted, fetchMock);

    await act(async () => buttonByText(host, 'Görevi geri bırak')!.click());
    await act(async () => selectValue(reasonSelect(), 'OUT_OF_TOWN'));
    await chooseSuggestion(dialog()!, 'CORRECT_DETAILS');
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Adres bilgisi eksik.',
    ));
    fetchMock.mockResolvedValueOnce(json(jobCard({ version: 5 })));
    await act(async () => buttonByText(dialog()!, 'Görevi geri bırak')!.click());
    await settle();
    await settle();

    const releaseCall = fetchMock.mock.calls
      .find(([url]) => String(url).includes('/release'));
    expect(JSON.parse(String((releaseCall![1] as RequestInit).body))).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 4,
      reasonCode: 'OUT_OF_TOWN',
      reasonText: 'Adres bilgisi eksik.',
      suggestedSolution: 'CORRECT_DETAILS',
    });
  });

  it('maps the server suggested-solution field error back onto the radio group', async () => {
    const card = jobCard();
    const fetchMock = mockDetailFetch(card);
    await renderScreen(card, fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    await act(async () => selectValue(reasonSelect(), 'OTHER'));
    await chooseSuggestion(dialog()!, 'MANAGEMENT_DECIDES');
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Yetişemedim.',
    ));
    fetchMock.mockResolvedValueOnce(json({
      error: 'İstek geçersiz.',
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { suggestedSolution: 'Çözüm önerisi zorunludur.' } },
    }, 400));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('#assignment-suggested-solution-error')?.textContent)
      .toBe('Çözüm önerisi zorunludur.');
  });
});

describe('RESCUE-002 manager and timeline presentation', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    })));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderOffer(job: JobCard, user: CurrentUser = manager) {
    await act(async () => root.render(<AssignmentOfferSection job={job} user={user} />));
  }

  it('shows the Staff suggestion to management for a new-client row', async () => {
    await renderOffer(jobCard({ assignmentOffer: closedOffer() }));

    const block = host.querySelector('[data-assignment-offer-recovery="DECLINED"]');
    expect(block?.textContent).toContain('Personelin önerisi: Başka bir personele verilsin');
    expect(block?.querySelector('[data-assignment-offer-suggested-solution="REASSIGN"]'))
      .not.toBeNull();
    expect(block?.textContent).toContain('Şehir dışında');
  });

  it('shows nothing new for a legacy row whose suggestion is null', async () => {
    await renderOffer(jobCard({
      assignmentOffer: closedOffer({ suggestedSolution: null }),
    }));

    const block = host.querySelector('[data-assignment-offer-recovery="DECLINED"]');
    expect(block).not.toBeNull();
    expect(block?.querySelector('[data-assignment-offer-suggested-solution]')).toBeNull();
    expect(block?.textContent).not.toContain('Personelin önerisi');
  });

  it.each([
    ['OUT_OF_TOWN', 'Şehir dışında'],
    ['CUSTOMER_POSTPONED', 'Müşteri erteledi'],
    ['WRONG_PRODUCT', 'Ürün veya kayıt bilgisi hatalı'],
  ] as const)('offers the proposal confirmation for a %s reschedule-self proposal', async (reason) => {
    await renderOffer(jobCard({ assignmentOffer: futureProposal(reason) }));

    expect(host.textContent).toContain('Personelin önerisi: Başka bir zamanda kendim yapabilirim');
    expect(buttonByText(host, 'Önerilen zamanı onayla')).not.toBeNull();
    expect(host.querySelector('[data-assignment-offer-action="accept-proposal"]')).not.toBeNull();
  });

  it('presents the suggestion in the job timeline', async () => {
    const activity: JobCardActivity = {
      id: 'declined', jobCardId: 'job-1', eventType: 'JOB_ASSIGNMENT_DECLINED',
      actor: { id: 'staff-1', name: 'Ayşe Personel' },
      details: {
        kind: 'ASSIGNMENT_DECISION', decision: 'DECLINED',
        reasonCode: 'OUT_OF_TOWN', reasonText: 'Kongredeyim.',
        suggestedSolution: 'REASSIGN', proposedScheduledAt: null,
      },
      createdAt: '2026-11-21T11:20:00.000Z',
    };
    const page: Paginated<JobCardActivity> = { items: [activity], total: 1, limit: 50, offset: 0 };
    await act(async () => root.render(<JobTimeline jobId="job-1" load={vi.fn().mockResolvedValue(page)} />));
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector('[data-activity-id="declined"] .activity-timeline-detail')?.textContent)
      .toBe('Şehir dışında · “Kongredeyim.” · Personelin önerisi: Başka bir personele verilsin');
  });
});
