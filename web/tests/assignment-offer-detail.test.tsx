/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JobDetailPanel, JobDetailScreen } from '../src/JobDetail';
import {
  AssignmentOfferSection,
} from '../src/jobs/AssignmentOffer';
import { isoInstantToLocalDateTime, localDateTimeToIso } from '../src/jobs/scheduling';
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
  closedAt: null,
  closeReason: null,
  closeText: null,
  proposedScheduledAt: null,
  proposedScheduledEndsAt: null,
  proposalAcceptedAt: null,
};

/** The production shape: Staff declined the offered time with a reason text. */
function closedOffer(overrides: Partial<AssignmentOffer> = {}): AssignmentOffer {
  return {
    ...offer,
    state: 'DECLINED',
    urgentReason: null,
    closedAt: '2026-11-21T11:20:00.000Z',
    closeReason: 'SCHEDULE_CONFLICT',
    closeText: 'Önümüzdeki haftaya ziyaret sağlanacak',
    ...overrides,
  };
}

/** JOB-012: a declined offer carrying a Staff time proposal awaiting management. */
function proposedOffer(overrides: Partial<AssignmentOffer> = {}): AssignmentOffer {
  const start = new Date(Date.now() + 2 * 86_400_000);
  start.setSeconds(0, 0);
  return closedOffer({
    state: 'DECLINED',
    closeReason: 'SCHEDULE_CONFLICT',
    closeText: null,
    proposedScheduledAt: start.toISOString(),
    proposedScheduledEndsAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    proposalAcceptedAt: null,
    ...overrides,
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

/** JOB-012: a device-local value in the future, for datetime-local inputs. */
function futureLocal(days: number): string {
  return isoInstantToLocalDateTime(new Date(Date.now() + days * 86_400_000).toISOString());
}

/** JOB-012: the exact interval sentence the guidance renders. */
function proposedInterval(start: string, end: string): string {
  const date = new Intl.DateTimeFormat('tr-TR', { dateStyle: 'medium' }).format(new Date(start));
  const time = new Intl.DateTimeFormat('tr-TR', { timeStyle: 'short' });
  return `${date} ${time.format(new Date(start))}–${time.format(new Date(end))}`;
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

async function openScheduleEditor(host: ParentNode) {
  await act(async () => {
    buttonByText(host, 'Değiştir')?.click();
    await Promise.resolve();
  });
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

  async function renderWithReassign(
    job: JobCard,
    user: CurrentUser,
    onReassign: (trigger: HTMLButtonElement) => void,
  ) {
    await act(async () => root.render(
      <AssignmentOfferSection job={job} user={user} onReassign={onReassign} />,
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
    expect(buttonByText(host, 'Aynı zamanla yeniden teklif et') !== null).toBe(visible);
  });

  it('hides re-offer when the job is no longer NEW', async () => {
    await renderSection(jobCard({
      status: 'ACCEPTED',
      assignmentOffer: { ...offer, state: 'DECLINED' },
    }), manager);
    expect(buttonByText(host, 'Aynı zamanla yeniden teklif et')).toBeNull();
  });

  it('explains a declined offer to management with the reason, the text and the decision time', async () => {
    await renderSection(jobCard({ assignmentOffer: closedOffer() }), manager);

    const block = host.querySelector('[data-assignment-offer-recovery="DECLINED"]');
    expect(block).not.toBeNull();
    expect(block?.querySelector('h3')?.textContent).toBe('Ayşe Personel görevi reddetti');
    expect(block?.textContent).toContain('Plan çakışması');
    expect(block?.textContent).toContain('“Önümüzdeki haftaya ziyaret sağlanacak”');
    expect(block?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-21T11:20:00.000Z');
    expect(block?.textContent).toContain('Ne yapabilirsiniz');
    // The bare status row is replaced, not stacked under the guidance.
    expect(host.querySelector('[data-assignment-offer-state]')).toBeNull();
    expect(host.textContent).not.toContain('Kabul için son');
  });

  it('keeps the bare status row for the assigned Staff member', async () => {
    await renderSection(jobCard({ assignmentOffer: closedOffer() }), staff);

    expect(host.querySelector('[data-assignment-offer-recovery]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-state="DECLINED"]')?.textContent)
      .toBe('Reddedildi');
    expect(host.textContent).toContain('Kabul için son');
    expect(host.textContent).not.toContain('Ne yapabilirsiniz');
  });

  it.each([
    ['DECLINED', 'Ayşe Personel görevi reddetti'],
    ['RELEASED', 'Ayşe Personel görevi geri bıraktı'],
    ['EXPIRED', 'Ayşe Personel teklifi süresinde yanıtlamadı'],
  ] as const)('names the %s state in the guidance headline', async (state, headline) => {
    await renderSection(jobCard({ assignmentOffer: closedOffer({ state }) }), manager);
    expect(host.querySelector('[data-assignment-offer-recovery] h3')?.textContent).toBe(headline);
  });

  it('reads a passed planned window as a passed planned time, and only that withdrawal', async () => {
    await renderSection(jobCard({
      assignmentOffer: closedOffer({ state: 'WITHDRAWN', closeReason: 'PLANNED_WINDOW_PASSED', closeText: null }),
    }), manager);
    expect(host.querySelector('[data-assignment-offer-recovery] h3')?.textContent)
      .toBe('Planlanan zaman geçti');

    // Any other withdrawal already opened a newer offer: no recovery copy.
    await renderSection(jobCard({
      assignmentOffer: closedOffer({ state: 'WITHDRAWN', closeReason: 'RESCHEDULED', closeText: null }),
    }), manager);
    expect(host.querySelector('[data-assignment-offer-recovery]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-state]')).not.toBeNull();
  });

  it.each([
    ['DECLINED', 'SCHEDULE_CONFLICT', 'Yeni zaman belirle'],
    ['DECLINED', 'ON_LEAVE', 'Sorumlu personeli değiştir'],
    ['DECLINED', 'TOO_FAR', 'Sorumlu personeli değiştir'],
    ['RELEASED', 'MISSING_STOCK_OR_EQUIPMENT', 'Sorumlu personeli değiştir'],
    ['RELEASED', 'OTHER', 'Sorumlu personeli değiştir'],
  ] as const)('orders a %s offer closed as %s', async (state, closeReason, first) => {
    await renderWithReassign(
      jobCard({ assignmentOffer: closedOffer({ state, closeReason }) }),
      manager,
      vi.fn(),
    );
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(
      '[data-assignment-offer-recovery] [data-assignment-offer-action]',
    ));
    const other = first === 'Yeni zaman belirle' ? 'Sorumlu personeli değiştir' : 'Yeni zaman belirle';
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      first,
      other,
      'Aynı zamanla yeniden teklif et',
    ]);
    expect(buttons[0]?.classList.contains('primary-button')).toBe(true);
    expect(buttons[1]?.classList.contains('secondary-button')).toBe(true);
    expect(buttons[2]?.classList.contains('secondary-button')).toBe(true);
  });

  it('puts the new time first for an expired offer and a passed window', async () => {
    for (const candidate of [
      closedOffer({ state: 'EXPIRED', closeReason: null, closeText: null }),
      closedOffer({ state: 'WITHDRAWN', closeReason: 'PLANNED_WINDOW_PASSED', closeText: null }),
    ]) {
      await renderWithReassign(jobCard({ assignmentOffer: candidate }), manager, vi.fn());
      expect(host.querySelector('[data-assignment-offer-action="new-time"]')?.className)
        .toContain('primary-button');
    }
  });

  it('shows the Staff proposal and makes confirming it the primary management action', async () => {
    const candidate = proposedOffer();
    await renderWithReassign(jobCard({ assignmentOffer: candidate }), manager, vi.fn());

    const facts = host.querySelector('[data-assignment-offer-recovery] dl');
    const term = Array.from(facts?.querySelectorAll('dt') ?? [])
      .find((node) => node.textContent === 'Personelin önerdiği zaman');
    expect(term).not.toBeUndefined();
    const interval = proposedInterval(
      candidate.proposedScheduledAt!,
      candidate.proposedScheduledEndsAt!,
    );
    expect(facts?.querySelector('[data-assignment-offer-proposal="PENDING"]')?.textContent)
      .toBe(interval);

    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>(
      '[data-assignment-offer-recovery] [data-assignment-offer-action]',
    ));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Önerilen zamanı onayla',
      'Yeni zaman belirle',
      'Sorumlu personeli değiştir',
      'Aynı zamanla yeniden teklif et',
    ]);
    expect(buttons[0]?.classList.contains('primary-button')).toBe(true);
    expect(buttons[1]?.classList.contains('secondary-button')).toBe(true);
    expect(buttons[2]?.classList.contains('secondary-button')).toBe(true);
    expect(buttons[3]?.classList.contains('secondary-button')).toBe(true);
  });

  it('confirms the proposed time through the dialog and refreshes the card', async () => {
    const onChanged = vi.fn();
    const candidate = proposedOffer();
    const receipt = {
      jobCardId: 'job-1',
      offerId: 'offer-1',
      scheduledAt: candidate.proposedScheduledAt,
      scheduledEndsAt: candidate.proposedScheduledEndsAt,
    };
    const fetchMock = vi.fn().mockResolvedValue(json(receipt));
    vi.stubGlobal('fetch', fetchMock);
    await renderSection(jobCard({ assignmentOffer: candidate }), manager, onChanged);

    const trigger = host.querySelector<HTMLButtonElement>(
      '[data-assignment-offer-action="accept-proposal"]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());

    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const interval = proposedInterval(
      candidate.proposedScheduledAt!,
      candidate.proposedScheduledEndsAt!,
    );
    expect(dialog?.textContent)
      .toContain(`İş ${interval} zamanına taşınır ve Ayşe Personel için kabul edilmiş olur.`);

    const confirm = dialog?.querySelector<HTMLButtonElement>(
      '.product-dialog-actions .primary-button',
    );
    expect(confirm?.textContent).toBe('Önerilen zamanı onayla');
    await act(async () => confirm!.click());
    await settle();
    await settle();

    expect(String(fetchMock.mock.calls[0]?.[0]))
      .toBe('/api/job-cards/job-1/assignment-offers/accept-proposal');
    expect(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body))).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 3,
      offerId: 'offer-1',
    });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-proposal-accepted="true"]')?.textContent)
      .toContain('Önerilen zaman onaylandı');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('never shows a pending proposal or its confirm control to the assigned Staff member', async () => {
    await renderSection(jobCard({ assignmentOffer: proposedOffer() }), staff);

    expect(host.querySelector('[data-assignment-offer-recovery]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-proposal]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-action="accept-proposal"]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-proposal-expired="true"]')).toBeNull();
    expect(host.textContent).not.toContain('Personelin önerdiği zaman');
  });

  it('shows no proposal outside the recovery state, even a passed one', async () => {
    const passed = new Date(Date.now() - 86_400_000).toISOString();
    await renderSection(jobCard({
      status: 'CANCELLED',
      assignmentOffer: proposedOffer({ proposedScheduledAt: passed, proposedScheduledEndsAt: passed }),
    }), manager);

    expect(host.querySelector('[data-assignment-offer-proposal]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-proposal-expired="true"]')).toBeNull();
  });

  it('hides the confirm button when the proposed start has passed', async () => {
    const candidate = proposedOffer({
      proposedScheduledAt: '2020-01-02T07:00:00.000Z',
      proposedScheduledEndsAt: '2020-01-02T07:30:00.000Z',
    });
    await renderWithReassign(jobCard({ assignmentOffer: candidate }), manager, vi.fn());

    expect(host.querySelector('[data-assignment-offer-action="accept-proposal"]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-proposal="EXPIRED"]')).not.toBeNull();
    expect(host.querySelector('[data-assignment-offer-proposal-expired="true"]')?.textContent)
      .toContain('Önerilen zaman geçti');
    // The other recovery actions stay available.
    expect(host.querySelector('[data-assignment-offer-action="new-time"]')).not.toBeNull();
  });

  it.each([
    ['ASSIGNMENT_PROPOSAL_NOT_AVAILABLE', 409, 'Personelin önerdiği zaman artık onaylanamıyor', 'Öneri artık geçerli değil.'],
    ['ASSIGNMENT_PROPOSAL_EXPIRED', 409, 'Önerilen zaman geçti. Onaylanamıyor', 'Önerilen zaman geçti.'],
    ['CALENDAR_CONFLICT', 409, 'Personelin takviminde çakışma var', 'Personelin takviminde çakışma var.'],
    ['VERSION_CONFLICT', 409, 'İş başka bir işlemle güncellendi', 'İş güncellendi.'],
  ] as const)('maps a %s rejection to a Turkish explanation and refreshes', async (code, status, expected, serverText) => {
    const onChanged = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: serverText, code }, status)));
    await renderSection(jobCard({ assignmentOffer: proposedOffer() }), manager, onChanged);

    await act(async () => host
      .querySelector<HTMLButtonElement>('[data-assignment-offer-action="accept-proposal"]')!
      .click());
    const confirm = host.querySelector<HTMLButtonElement>(
      '[role="dialog"] .product-dialog-actions .primary-button',
    );
    await act(async () => confirm!.click());
    await settle();
    await settle();

    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-proposal-error="true"]')?.textContent)
      .toContain(expected);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('says the same time will be asked again and that saving the time opens a new offer', async () => {
    await renderSection(jobCard({ assignmentOffer: closedOffer() }), manager);

    expect(host.querySelector('[data-assignment-offer-schedule-hint]')?.textContent)
      .toBe('Planlanan zamanı kaydettiğinizde Ayşe Personel kişisine yeni atama teklifi gider.');
    expect(host.textContent).toContain('Zamanı değiştirmeden aynı personele yeniden sorar.');
  });

  it('offers no new-time action or save hint when this viewer has no planned-time editor', async () => {
    const onReassign = vi.fn();
    await act(async () => root.render(
      <AssignmentOfferSection
        job={jobCard({ assignmentOffer: closedOffer() })}
        user={manager}
        onReassign={onReassign}
        canSetNewTime={false}
      />,
    ));

    expect(host.querySelector('[data-assignment-offer-action="new-time"]')).toBeNull();
    expect(host.querySelector('[data-assignment-offer-schedule-hint]')).toBeNull();
    // Reassignment becomes the primary recovery action.
    expect(host.querySelector('[data-assignment-offer-action="reassign"]')?.className)
      .toContain('primary-button');
  });

  it('focuses the existing planned-time input from the guidance', async () => {
    const scrollIntoView = vi.fn();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true, writable: true, value: scrollIntoView,
    });
    try {
      await act(async () => root.render(<>
        <AssignmentOfferSection
          job={jobCard({ assignmentOffer: closedOffer() })}
          user={manager}
        />
        <input id="job-scheduled-at" aria-label="Planlanan zaman" />
      </>));
      const trigger = host.querySelector<HTMLButtonElement>('[data-assignment-offer-action="new-time"]');
      expect(trigger).not.toBeNull();
      await act(async () => trigger!.click());
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(document.activeElement?.id).toBe('job-scheduled-at');
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('opens the existing record-edit reassignment from the guidance', async () => {
    const onReassign = vi.fn();
    await renderWithReassign(
      jobCard({ assignmentOffer: closedOffer({ closeReason: 'ON_LEAVE' }) }),
      manager,
      onReassign,
    );

    const trigger = host.querySelector<HTMLButtonElement>('[data-assignment-offer-action="reassign"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    expect(onReassign).toHaveBeenCalledTimes(1);
    expect(onReassign.mock.calls[0]?.[0]).toBe(trigger);
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

    await act(async () => buttonByText(host, 'Aynı zamanla yeniden teklif et')!.click());
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

    await act(async () => buttonByText(host, 'Aynı zamanla yeniden teklif et')!.click());
    await settle();

    expect(host.textContent).toContain('Planlanan zaman aralığı atama için çok kısa.');
    expect(host.querySelector('[data-past-start-acknowledgement="true"]')).toBeNull();
  });

  it('keeps the acknowledgement drawer open with inline error when re-offer retry fails', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        error: 'Başlangıç saati geçti.', code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED',
      }, 409))
      .mockResolvedValueOnce(json({
        error: 'Aralık çok kısa.', code: 'ASSIGNMENT_WINDOW_TOO_SHORT',
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    await renderSection(
      jobCard({
        status: 'NEW',
        assignmentOffer: { ...offer, state: 'EXPIRED' },
      }),
      manager,
    );

    await act(async () => buttonByText(host, 'Aynı zamanla yeniden teklif et')!.click());
    await settle();
    const form = host.querySelector('form.past-start-acknowledgement-form') as HTMLFormElement;
    expect(form).not.toBeNull();

    await act(async () => selectValue(
      host.querySelector('#past-start-ack-code') as HTMLSelectElement,
      'CUSTOMER_WAITING',
    ));
    await act(async () => setNativeValue(
      host.querySelector('#past-start-ack-text') as HTMLTextAreaElement,
      'Müşteri bekliyor.',
    ));
    await act(async () => form.requestSubmit());
    await settle();
    await settle();

    const drawerForm = host.querySelector('form.past-start-acknowledgement-form');
    expect(drawerForm).not.toBeNull();
    expect(drawerForm?.textContent).toContain('Planlanan zaman aralığı atama için çok kısa.');
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
    const fieldset = dialog()?.querySelector('fieldset.assignment-reason-section');
    const legend = fieldset?.querySelector('legend');
    const label = fieldset?.querySelector('label[for="assignment-reason-code"]');
    expect(legend?.classList.contains('sr-only')).toBe(true);
    expect(legend?.textContent).toBe('Atama yanıt nedeni');
    expect(label?.textContent).toBe('Neden');
    const visibleNedenLabels = Array.from(fieldset?.querySelectorAll('legend, label') ?? [])
      .filter((element) => !element.classList.contains('sr-only') && element.textContent?.trim() === 'Neden');
    expect(visibleNedenLabels).toHaveLength(1);
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
      'OTHER',
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
      reasonCode: 'OTHER',
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

    // JOB-012: release carries the same proposal field as decline.
    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'SCHEDULE_CONFLICT',
    ));
    expect(dialog()?.querySelector('#assignment-proposed-at')).not.toBeNull();

    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'MISSING_STOCK_OR_EQUIPMENT',
    ));
    expect(dialog()?.querySelector('#assignment-proposed-at')).toBeNull();
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

  it('shows the proposed time only for a schedule conflict and clears it on switching away', async () => {
    const fetchMock = mockDetailFetch(jobCard());
    await renderScreen(jobCard(), fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    const reasonSelect = () => dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement;
    const proposedInput = () => dialog()?.querySelector('#assignment-proposed-at') as HTMLInputElement | null;
    expect(proposedInput()).toBeNull();

    await act(async () => selectValue(reasonSelect(), 'SCHEDULE_CONFLICT'));
    expect(proposedInput()).not.toBeNull();
    expect(proposedInput()?.getAttribute('type')).toBe('datetime-local');
    expect(proposedInput()?.hasAttribute('required')).toBe(true);
    expect(dialog()?.querySelector('label[for="assignment-proposed-at"]')?.textContent)
      .toBe('Önerdiğiniz zaman');
    expect(dialog()?.querySelector('#assignment-proposed-at-help')?.textContent)
      .toBe('Yönetici onaylarsa iş bu zamana taşınır ve sizin için kabul edilmiş olur.');
    // The shared quick presets and advisory hints travel with the field.
    expect(dialog()?.querySelector('.schedule-quick-chips')).not.toBeNull();

    await act(async () => setNativeValue(proposedInput()!, futureLocal(2)));
    await act(async () => selectValue(reasonSelect(), 'ON_LEAVE'));
    expect(proposedInput()).toBeNull();

    await act(async () => selectValue(reasonSelect(), 'SCHEDULE_CONFLICT'));
    expect(proposedInput()?.value).toBe('');
  });

  it('requires a future proposed time before a schedule-conflict decline leaves the browser', async () => {
    const fetchMock = mockDetailFetch(jobCard());
    await renderScreen(jobCard(), fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'SCHEDULE_CONFLICT',
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Aynı saatte başka teslim var.',
    ));
    const declineCalls = () => fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/decline'));

    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    expect(dialog()?.querySelector('#assignment-proposed-at-error')?.textContent)
      .toBe('Plan çakışması için önerdiğiniz zamanı seçin.');
    expect(declineCalls()).toHaveLength(0);

    await act(async () => setNativeValue(
      dialog()!.querySelector('#assignment-proposed-at') as HTMLInputElement,
      '2020-01-02T10:00',
    ));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    expect(dialog()?.querySelector('#assignment-proposed-at-error')?.textContent)
      .toBe('Önerilen zaman gelecekte olmalı.');
    expect(declineCalls()).toHaveLength(0);

    const proposedLocal = futureLocal(3);
    await act(async () => setNativeValue(
      dialog()!.querySelector('#assignment-proposed-at') as HTMLInputElement,
      proposedLocal,
    ));
    expect(dialog()?.querySelector('#assignment-proposed-at-error')).toBeNull();
    fetchMock.mockResolvedValueOnce(json(jobCard({ version: 4 })));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    expect(declineCalls()).toHaveLength(1);
    expect(JSON.parse(String((declineCalls()[0]![1] as RequestInit).body))).toEqual({
      clientActionId: expect.any(String),
      expectedVersion: 3,
      reasonCode: 'SCHEDULE_CONFLICT',
      reasonText: 'Aynı saatte başka teslim var.',
      proposedScheduledAt: localDateTimeToIso(proposedLocal),
    });
    expect(dialog()).toBeNull();
  });

  it('keeps the dialog open and maps the server proposed-time field error inline', async () => {
    const fetchMock = mockDetailFetch(jobCard());
    await renderScreen(jobCard(), fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'SCHEDULE_CONFLICT',
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('#assignment-proposed-at') as HTMLInputElement,
      futureLocal(2),
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Aynı saatte başka teslim var.',
    ));
    fetchMock.mockResolvedValueOnce(json({
      error: 'İstek geçersiz.',
      code: 'VALIDATION_ERROR',
      details: { fieldErrors: { proposedScheduledAt: 'Önerilen zaman geçmişte olamaz.' } },
    }, 400));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('#assignment-proposed-at-error')?.textContent)
      .toBe('Önerilen zaman geçmişte olamaz.');
  });

  it('shows a staff calendar conflict inline and keeps the dialog open', async () => {
    const fetchMock = mockDetailFetch(jobCard());
    await renderScreen(jobCard(), fetchMock);

    await act(async () => buttonByText(host, 'Görevi reddet')!.click());
    await act(async () => selectValue(
      dialog()!.querySelector('#assignment-reason-code') as HTMLSelectElement,
      'SCHEDULE_CONFLICT',
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('#assignment-proposed-at') as HTMLInputElement,
      futureLocal(2),
    ));
    await act(async () => setNativeValue(
      dialog()!.querySelector('textarea') as HTMLTextAreaElement,
      'Aynı saatte başka teslim var.',
    ));
    fetchMock.mockResolvedValueOnce(json({
      error: 'Personelin takviminde çakışma var: Klinik ziyareti 09:00.',
      code: 'CALENDAR_CONFLICT',
    }, 409));
    await act(async () => buttonByText(dialog()!, 'Görevi reddet')!.click());
    await settle();
    await settle();

    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('#assignment-proposed-at-error')?.textContent)
      .toBe('Personelin takviminde çakışma var: Klinik ziyareti 09:00.');
  });

  it('opens the existing reassignment form from the declined-offer guidance', async () => {
    const card = jobCard({
      assignmentOffer: closedOffer({ closeReason: 'ON_LEAVE' }),
      workflowContext: {
        ...workflowContext,
        allowedCommands: ['CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
        lifecycle,
      },
    });
    const fetchMock = mockDetailFetch(card);
    await renderScreen(card, fetchMock, manager);

    expect(host.querySelector('[data-assignment-offer-recovery="DECLINED"]')).not.toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('[data-assignment-offer-action="reassign"]');
    expect(trigger).not.toBeNull();
    await act(async () => trigger!.click());
    await settle();

    // The shared record-edit reassignment form, not a second copy in the block.
    expect(host.querySelector('.delivery-assignee-details')).not.toBeNull();
    expect(host.textContent).toContain('Sorumlu personel düzenleme alanı açıldı.');
  });

  it('closes the stale dialog and reloads when the acceptance window has closed', async () => {    const fetchMock = mockDetailFetch(jobCard());
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

  it('tells management that saving the planned time opens a new offer to the same Staff member', async () => {
    const card = jobCard({
      workflowContext: {
        ...workflowContext,
        allowedCommands: ['CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
        lifecycle,
      },
    });
    const fetchMock = mockFetch(card, []);
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={manager} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await openScheduleEditor(host);

    const hint = host.querySelector('[data-schedule-offer-hint="true"]');
    expect(hint?.textContent)
      .toBe('Kaydettiğinizde Ayşe Personel kişisine yeni atama teklifi gider.');
    const input = host.querySelector('#job-scheduled-at') as HTMLInputElement;
    expect(input.getAttribute('aria-describedby')?.split(' '))
      .toContain('job-scheduled-at-offer-hint');

    // Staff never edits the customer time here, so the promise is not theirs.
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={staff} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('[data-schedule-offer-hint="true"]')).toBeNull();
  });

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
    await openScheduleEditor(host);

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

  it('keeps the acknowledgement drawer open with the error when schedule replay fails', async () => {
    const card = jobCard({
      workflowContext: {
        ...workflowContext,
        allowedCommands: ['CANCEL'],
        allowedActions: ['EDIT_JOB_FIELDS', 'VIEW_NOTES'],
        lifecycle,
      },
    });
    const fetchMock = mockFetch(card, [
      json({ error: 'Başlangıç saati geçti.', code: 'PAST_START_ACKNOWLEDGEMENT_REQUIRED' }, 409),
      json({ error: 'Aralık çok kısa.', code: 'ASSIGNMENT_WINDOW_TOO_SHORT' }, 409),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(<JobDetailScreen jobId={card.id} user={manager} onBack={() => {}} onChanged={() => {}} />);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await openScheduleEditor(host);

    const input = host.querySelector('#job-scheduled-at') as HTMLInputElement;
    await act(async () => setNativeValue(input, '2026-11-21T15:30'));
    await act(async () => buttonByText(host, 'Planlanan zamanı kaydet')!.click());
    await settle();
    await settle();

    const form = host.querySelector('form.past-start-acknowledgement-form') as HTMLFormElement;
    expect(form).not.toBeNull();
    await act(async () => selectValue(
      host.querySelector('#past-start-ack-code') as HTMLSelectElement,
      'CUSTOMER_WAITING',
    ));
    await act(async () => setNativeValue(
      host.querySelector('#past-start-ack-text') as HTMLTextAreaElement,
      'Müşteri bekliyor.',
    ));
    await act(async () => form.requestSubmit());
    await settle();
    await settle();

    const drawerForm = host.querySelector('form.past-start-acknowledgement-form');
    expect(drawerForm).not.toBeNull();
    expect(drawerForm?.textContent).toContain('Planlanan zaman aralığı atama için çok kısa.');
  });
});
