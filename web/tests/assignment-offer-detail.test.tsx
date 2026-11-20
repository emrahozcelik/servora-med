/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel, JobDetailScreen } from '../src/JobDetail';
import {
  AssignmentOfferSection,
} from '../src/jobs/AssignmentOffer';
import type {
  AssignmentOffer,
  JobCard,
  JobLifecycleFacts,
  LifecycleCommand,
  MeetingDetails,
} from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { withoutSaleCapability, workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
};

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
    ...overrides,
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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

describe('assignment offer detail surface', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function renderSection(job: JobCard, user: CurrentUser = staff, onChanged = vi.fn()) {
    await act(async () => root.render(
      <AssignmentOfferSection job={job} user={user} onChanged={onChanged} />,
    ));
  }

  it('shows the server deadline and the urgent badge to the assignee', async () => {
    await renderSection(jobCard());
    const section = host.querySelector('[data-assignment-offer="OPEN"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain('Kabul için son');
    expect(section?.querySelector('time')?.getAttribute('dateTime'))
      .toBe('2026-11-21T12:00:00.000Z');
    expect(section?.querySelector('[data-assignment-offer-urgent]')?.textContent)
      .toContain('Kısa süre');
  });

  it('shows the same deadline and badge to management', async () => {
    await renderSection(jobCard({ assignmentOffer: { ...offer, urgentReason: 'START_PASSED' } }), manager);
    const section = host.querySelector('[data-assignment-offer="OPEN"]');
    expect(section?.textContent).toContain('Kabul için son');
    expect(section?.textContent).toContain('Başlangıç geçti');
  });

  it('renders nothing without an offer, for a non-assignee, and never computes urgency', async () => {
    await renderSection(jobCard({ assignmentOffer: null }));
    expect(host.textContent).toBe('');

    await renderSection(jobCard(), { ...staff, id: 'staff-2' });
    expect(host.textContent).toBe('');

    await renderSection(jobCard({ assignmentOffer: { ...offer, urgentReason: null } }), staff);
    expect(host.querySelector('[data-assignment-offer-urgent]')).toBeNull();
  });

  it.each([
    ['DECLINED', true],
    ['RELEASED', true],
    ['EXPIRED', true],
    ['WITHDRAWN', true],
    ['ACCEPTED', false],
    ['OPEN', false],
  ] as const)('offers management re-offer for a %s offer only when recovery is expected', async (state, visible) => {
    await renderSection(
      jobCard({ assignmentOffer: { ...offer, state } }),
      manager,
    );
    expect(buttonByText(host, 'Yeniden teklif et') !== null).toBe(visible);
  });

  it('hides re-offer when the job is no longer NEW', async () => {
    await renderSection(jobCard({
      status: 'ACCEPTED',
      assignmentOffer: { ...offer, state: 'DECLINED' },
    }), manager);
    expect(buttonByText(host, 'Yeniden teklif et')).toBeNull();
  });

  it('re-offers, asks for the acknowledgement on 409 and retries with it', async () => {
    const onChanged = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        error: 'Başlangıç saati geçti.', code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED',
      }, 409))
      .mockResolvedValueOnce(json({
        jobCardId: 'job-1', offerId: 'offer-2',
        acceptanceDueAt: '2026-11-21T12:10:00.000Z', urgentReason: 'START_PASSED',
      }, 201));
    vi.stubGlobal('fetch', fetchMock);
    await renderSection(
      jobCard({
        status: 'NEW',
        assignmentOffer: { ...offer, state: 'EXPIRED' },
      }),
      manager,
      onChanged,
    );

    await act(async () => buttonByText(host, 'Yeniden teklif et')!.click());
    await settle();
    expect(host.querySelector('[data-past-start-acknowledgement="true"]')).not.toBeNull();
    expect(host.textContent).toContain('Planlanan başlangıç saati geçti');

    // The acknowledgement needs a code and a mandatory text.
    const form = host.querySelector('form.past-start-acknowledgement-form') as HTMLFormElement;
    await act(async () => form.requestSubmit());
    expect(host.textContent).toContain('Başlangıcın neden geçtiğini açıklayan bir neden seçin.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => selectValue(
      host.querySelector('#past-start-ack-code') as HTMLSelectElement,
      'CUSTOMER_CONFIRMED_LATER_TIME',
    ));
    await act(async () => form.requestSubmit());
    expect(host.textContent).toContain('Onayı açıklayan metin zorunludur.');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => setNativeValue(
      host.querySelector('#past-start-ack-text') as HTMLTextAreaElement,
      '  Klinik 14:30 dedi.  ',
    ));
    await act(async () => form.requestSubmit());
    await settle();
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe('/api/job-cards/job-1/assignment-offers/reoffer');
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 3,
      pastStartAcknowledgement: {
        code: 'CUSTOMER_CONFIRMED_LATER_TIME',
        text: 'Klinik 14:30 dedi.',
      },
    });
    expect(host.querySelector('[data-past-start-acknowledgement="true"]')).toBeNull();
    expect(host.textContent).toContain('Yeni atama teklifi açıldı');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('maps a rejected re-offer to a clear Turkish message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({
      error: 'Aralık çok kısa.', code: 'ASSIGNMENT_WINDOW_TOO_SHORT',
    }, 409)));
    await renderSection(jobCard({ assignmentOffer: { ...offer, state: 'DECLINED' } }), manager);

    await act(async () => buttonByText(host, 'Yeniden teklif et')!.click());
    await settle();

    expect(host.textContent).toContain('Planlanan zaman aralığı atama için çok kısa.');
    expect(host.querySelector('[data-past-start-acknowledgement="true"]')).toBeNull();
  });
});

describe('assignment offer command buttons', () => {
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

  async function renderPanel(card: JobCard, user: CurrentUser, commands: LifecycleCommand[]) {
    const withCommands = {
      ...card,
      workflowContext: { ...card.workflowContext, allowedCommands: commands },
    };
    await act(async () => root.render(
      <JobDetailPanel
        job={withCommands}
        items={[]}
        user={user}
        pending={false}
        message=""
        onCommand={() => {}}
      />,
    ));
  }

  it('renders decline from allowedCommands for the assigned Staff member', async () => {
    await renderPanel(jobCard(), staff, ['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT']);
    expect(buttonByText(host, 'Görevi reddet')).not.toBeNull();
    expect(buttonByText(host, 'Görevi geri bırak')).toBeNull();
  });

  it('renders release from allowedCommands for the assigned Staff member', async () => {
    await renderPanel(
      jobCard({ status: 'ACCEPTED', workflowContext: { ...workflowContext, lifecycle } }),
      staff,
      ['START', 'RELEASE_ASSIGNMENT'],
    );
    expect(buttonByText(host, 'Görevi geri bırak')).not.toBeNull();
    expect(buttonByText(host, 'Görevi reddet')).toBeNull();
  });

  it('never offers the assignment answers to management or another Staff member', async () => {
    await renderPanel(jobCard(), manager, ['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT']);
    expect(buttonByText(host, 'Görevi reddet')).toBeNull();

    await renderPanel(jobCard(), { ...staff, id: 'staff-2' }, ['ACCEPT_ASSIGNMENT', 'DECLINE_ASSIGNMENT']);
    expect(buttonByText(host, 'Görevi reddet')).toBeNull();
  });
});

describe('decline and release dialogs', () => {
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

  function mockDetailFetch(card: JobCard, patchResponses: Response[] = []) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const path = url.split('?')[0] ?? url;
      if (init?.method === 'PATCH' && path.endsWith(`/api/job-cards/${card.id}`)) {
        const next = patchResponses.shift();
        if (!next) throw new Error('Unexpected PATCH');
        return next;
      }
      if (url.endsWith('/delivery-items')) return json({ items: [] });
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
    fetch: ReturnType<typeof mockDetailFetch>,
    user: CurrentUser = staff,
  ) {
    vi.stubGlobal('fetch', fetch);
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={user} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function dialog() {
    return host.querySelector('[role="dialog"]') as HTMLElement | null;
  }

  it('declines with a mandatory reason code and text', async () => {
    const fetchMock = mockDetailFetch(jobCard());
    await renderScreen(jobCard(), fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('#assignment-reason-code')).not.toBeNull();
    expect(dialog()?.querySelector('textarea')?.getAttribute('required')).not.toBeNull();

    // The code is required: no request leaves the browser without it.
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Aynı saatte başka teslim var.',
    ));
    const confirm = buttonByText(dialog()!, 'Görevi reddet');
    expect(confirm).not.toBeNull();
    await act(async () => confirm!.click());
    expect(host.textContent).toContain('Görevi reddetme nedenini seçin.');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/decline'))).toBe(false);

    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'SCHEDULE_CONFLICT',
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      '  Aynı saatte başka teslim var.  ',
    ));
    fetchMock.mockResolvedValueOnce(json(jobCard({ version: 4 })));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    const declineCall = fetchMock.mock.calls
      .find(([url]) => String(url).includes('/decline'));
    expect(declineCall).toBeDefined();
    expect(String(declineCall![0])).toBe('/api/job-cards/job-1/decline?includeSaleCapability=true');
    expect(JSON.parse(String((declineCall![1] as RequestInit).body))).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 3,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka teslim var.',
    });
    expect(dialog()).toBeNull();
    expect(host.textContent).toContain('Görev reddedildi. Yönetici bilgilendirildi.');
  });

  it('releases an accepted job through the release command', async () => {
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
    expect(dialog()).not.toBeNull();
    expect(buttonByText(dialog()!, 'Görevi geri bırak')).not.toBeNull();

    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'MISSING_STOCK_OR_EQUIPMENT',
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Eldiven stoğu kalmadı.',
    ));
    fetchMock.mockResolvedValueOnce(json(jobCard({ version: 5 })));
    await act(async () => buttonByText(dialog()!, 'Görevi geri bırak')!.click());
    await settle();
    await settle();

    const releaseCall = fetchMock.mock.calls
      .find(([url]) => String(url).includes('/release'));
    expect(String(releaseCall?.[0])).toBe('/api/job-cards/job-1/release?includeSaleCapability=true');
    expect(JSON.parse(String((releaseCall![1] as RequestInit).body))).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 4,
      reasonCode: 'MISSING_STOCK_OR_EQUIPMENT',
      reasonText: 'Eldiven stoğu kalmadı.',
    });
    expect(host.textContent).toContain('Görev geri bırakıldı. Yönetici bilgilendirildi.');
  });

  it('closes the stale dialog and reloads when the acceptance window has closed', async () => {
    const fetchMock = mockDetailFetch(jobCard());
    await renderScreen(jobCard(), fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'OTHER',
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Yetişemedim.',
    ));
    fetchMock.mockResolvedValueOnce(json({
      error: 'Kabul süresi doldu.', code: 'ACCEPTANCE_WINDOW_CLOSED',
    }, 409));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    expect(host.textContent).toContain('Kabul süresi doldu. İş yöneticinin listesine düştü');
    // The stale offer is reloaded instead of leaving dead buttons behind.
    const detailCalls = fetchMock.mock.calls.filter(([url]) =>
      (String(url).split('?')[0] ?? '').endsWith('/api/job-cards/job-1'));
    expect(detailCalls).toHaveLength(2);
  });
});

describe('past-start acknowledgement retry on the schedule edit', () => {
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

  function mockFetch(card: JobCard, patchResponses: Response[]) {
    return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = withoutSaleCapability(String(input));
      const path = url.split('?')[0] ?? url;
      if (init?.method === 'PATCH' && path.endsWith(`/api/job-cards/${card.id}`)) {
        const next = patchResponses.shift();
        if (!next) throw new Error('Unexpected PATCH');
        return next;
      }
      if (url.endsWith('/delivery-items')) return json({ items: [] });
      if (url.includes('/notes?')) return json({ items: [], total: 0, limit: 25, offset: 0, nextCursor: null });
      if (url.includes('/activity?')) return json({ items: [], total: 0, limit: 50, offset: 0 });
      if (url.includes('/submission-lateness')) return json({ open: null });
      if (path.endsWith(`/api/job-cards/${card.id}`)) return json(card);
      throw new Error(`Unexpected request: ${url}`);
    });
  }

  it('asks for the acknowledgement on 409 and replays the same schedule with it', async () => {
    const card = jobCard({
      workflowContext: {
        ...workflowContext,
        allowedCommands: ['CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
        lifecycle,
      },
    });
    const patched = { ...card, version: 4, scheduledAt: '2026-11-21T12:30:00.000Z' };
    const fetchMock = mockFetch(card, [
      json({ error: 'Başlangıç saati geçti.', code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED' }, 409),
      json(patched),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={manager} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const input = host.querySelector('#job-scheduled-at') as HTMLInputElement;
    expect(input).not.toBeNull();
    await act(async () => setNativeValue(input, '2026-11-21T15:30'));
    const submit = buttonByText(host, 'Planlanan zamanı kaydet');
    expect(submit).not.toBeNull();
    await act(async () => submit!.click());
    await settle();
    await settle();

    // Nothing was written: the server asked for the explicit acknowledgement.
    const form = host.querySelector('form.past-start-acknowledgement-form') as HTMLFormElement;
    expect(form).not.toBeNull();
    expect(host.textContent).toContain('Başlangıç saati geçti. Kaydetmek için müşteri onayı gerekiyor.');
    const patchCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patchCalls()).toHaveLength(1);

    await act(async () => selectValue(
      host.querySelector('#past-start-ack-code') as HTMLSelectElement,
      'CUSTOMER_WAITING',
    ));
    await act(async () => setNativeValue(
      host.querySelector('#past-start-ack-text') as HTMLTextAreaElement,
      '  Klinik resepsiyonu müşteriyi bekliyor.  ',
    ));
    await act(async () => form.requestSubmit());
    await settle();
    await settle();

    expect(patchCalls()).toHaveLength(2);
    expect(JSON.parse(String((patchCalls()[1]![1] as RequestInit).body))).toEqual({
      expectedVersion: 3,
      scheduledAt: expect.any(String),
      pastStartAcknowledgement: {
        code: 'CUSTOMER_WAITING',
        text: 'Klinik resepsiyonu müşteriyi bekliyor.',
      },
    });
    expect(host.querySelector('[data-past-start-acknowledgement="true"]')).toBeNull();
    expect(host.textContent).toContain('Planlanan zaman güncellendi.');
  });
});
