/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meetingLocalValue, MeetingDetailsSection } from '../src/jobs/MeetingDetails';
import type { JobCard, MeetingDetails } from '../src/jobs/jobs-api';
import { ApiError, type CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let uuidSeq = 0;
const user: CurrentUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF', mustChangePassword: false, isActive: true, version: 1 };
const job = { id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS', version: 3,
  title: 'Görüşme', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1', createdBy: 'staff-1',
  priority: 'normal', dueDate: '2026-07-15', assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null, workflowContext } satisfies JobCard;
const details: MeetingDetails = {
  jobCardId: 'job-1', meetingAt: null, outcome: null, unsuccessfulReason: null,
  meetingSummary: null, nextFollowUpAt: null, jobCardVersion: 3,
};
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}
async function settle() { await act(async () => { await Promise.resolve(); }); }

describe('MeetingDetailsSection', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    uuidSeq = 0; Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => `save-${++uuidSeq}`) }); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });

  it('defaults a null meeting time once to the current local minute', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-07-16T12:34:45.000Z');
    vi.setSystemTime(now);
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details}
      user={user} mutationPending={false} onSave={vi.fn()} />));
    const input = container.querySelector('#meeting-actual-at') as HTMLInputElement;
    expect(input.value).toBe(meetingLocalValue(null, now));

    change(input, '2026-07-16T18:20');
    vi.setSystemTime(new Date('2026-07-16T14:00:00.000Z'));
    await act(async () => root.render(<MeetingDetailsSection job={job} details={{ ...details }}
      user={user} mutationPending={false} onSave={vi.fn()} />));
    expect(input.value).toBe('2026-07-16T18:20');
  });

  it('uses a persisted meeting time instead of the current time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:34:45.000Z'));
    const persisted = { ...details, meetingAt: '2026-07-15T09:20:00.000Z' };
    await act(async () => root.render(<MeetingDetailsSection job={job} details={persisted}
      user={user} mutationPending={false} onSave={vi.fn()} />));
    expect((container.querySelector('#meeting-actual-at') as HTMLInputElement).value)
      .toBe(meetingLocalValue(persisted.meetingAt));
  });

  it('does not request a save when persisted result values are unchanged', async () => {
    const persisted = {
      ...details, meetingAt: '2026-07-15T09:20:00.000Z', outcome: 'POSITIVE' as const,
      meetingSummary: 'Olumlu görüşme.',
    };
    const onSave = vi.fn();
    await act(async () => root.render(<MeetingDetailsSection job={job} details={persisted}
      user={user} mutationPending={false} onSave={onSave} />));

    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); await Promise.resolve(); });
    await settle();

    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('Görüşme sonucunda kaydedilecek bir değişiklik yok.');
  });

  it('saves canonical result fields and keeps the legacy follow-up time out of the primary workflow', async () => {
    const onSave = vi.fn(async (input) => ({ ...details, ...input, jobCardVersion: 4 }));
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details} user={user} mutationPending={false} onSave={onSave} />));
    change(container.querySelector('#meeting-actual-at')!, '2026-07-15T12:30');
    change(container.querySelector('#meeting-outcome')!, 'FOLLOW_UP_REQUIRED');
    expect(container.querySelector('#meeting-unsuccessful-reason')).not.toBeNull();
    change(container.querySelector('#meeting-unsuccessful-reason')!, 'REQUESTED_LATER');
    change(container.querySelector('#meeting-summary')!, '  Ürün sunumu yapıldı.  ');
    expect(container.querySelector('#meeting-follow-up-at')).toBeNull();
    expect(container.textContent).toContain('Takip işi planı, işi kontrole gönderirken oluşturulur.');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      clientActionId: 'save-1', expectedVersion: 3, outcome: 'FOLLOW_UP_REQUIRED',
      unsuccessfulReason: 'REQUESTED_LATER',
      meetingSummary: 'Ürün sunumu yapıldı.', nextFollowUpAt: null,
    }));
    expect(new Date(onSave.mock.calls[0]![0].meetingAt as string).toString()).not.toBe('Invalid Date');
  });

  it('keeps the original version and body across canonical refresh, then allows a fresh edit after success', async () => {
    const onSave = vi.fn().mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi', true))
      .mockResolvedValueOnce({ ...details, meetingAt: '2026-07-15T12:30:00.000Z', jobCardVersion: 4 })
      .mockResolvedValueOnce({ ...details, meetingAt: '2026-07-16T12:30:00.000Z', jobCardVersion: 6 });
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details} user={user} mutationPending={false} onSave={onSave} />));
    change(container.querySelector('#meeting-actual-at')!, '2026-07-15T12:30');
    change(container.querySelector('#meeting-summary')!, 'Özgün özet');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave.mock.calls[0]![0]).toMatchObject({ expectedVersion: 3, meetingSummary: 'Özgün özet' });
    // Ambiguous failure: original attempt is retained while truth refreshes under it.
    await act(async () => root.render(<MeetingDetailsSection job={{ ...job, version: 4 }} details={{ ...details, jobCardVersion: 4 }} user={user} mutationPending={false} onSave={onSave} />));
    expect(container.querySelector('[data-original-retry]')).toBeTruthy();
    expect(container.querySelector('form fieldset')).toHaveProperty('disabled', true);
    // Edits are blocked while the result is uncertain; only the original attempt can be retried.
    change(container.querySelector('#meeting-summary')!, 'Değiştirilemez özet');
    await act(async () => (container.querySelector('[data-original-retry]') as HTMLButtonElement).click());
    expect(onSave.mock.calls[1]![0]).toMatchObject({
      clientActionId: onSave.mock.calls[0]![0].clientActionId, expectedVersion: 3, meetingSummary: 'Özgün özet',
    });
    await settle();
    // After reconciliation the form is editable again; a new intent gets a new key and canonical version.
    await act(async () => root.render(<MeetingDetailsSection job={{ ...job, version: 4 }} details={{ ...details, jobCardVersion: 4, meetingSummary: 'Özgün özet' }} user={user} mutationPending={false} onSave={onSave} />));
    expect(container.querySelector('[data-original-retry]')).toBeNull();
    change(container.querySelector('#meeting-actual-at')!, '2026-07-16T12:30');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave.mock.calls[2]![0].clientActionId).not.toBe(onSave.mock.calls[0]![0].clientActionId);
    expect(onSave.mock.calls[2]![0].expectedVersion).toBe(4);
  });

  it('shows the unsuccessful reason selector only for the follow-up-required outcome', async () => {
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details} user={user}
      mutationPending={false} onSave={vi.fn()} />));
    expect(container.querySelector('#meeting-unsuccessful-reason')).toBeNull();

    change(container.querySelector('#meeting-outcome')!, 'NO_DECISION');
    expect(container.querySelector('#meeting-unsuccessful-reason')).toBeNull();

    change(container.querySelector('#meeting-outcome')!, 'FOLLOW_UP_REQUIRED');
    expect(container.querySelector('#meeting-unsuccessful-reason')).not.toBeNull();
  });

  it('accepts exactly 4,000 astral Unicode code points without a UTF-16 maxlength', async () => {
    const onSave = vi.fn(async (input) => ({ ...details, ...input, jobCardVersion: 4 }));
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details}
      user={user} mutationPending={false} onSave={onSave} />));
    const summary = container.querySelector('#meeting-summary') as HTMLTextAreaElement;
    expect(summary.maxLength).toBe(-1);
    change(summary, '😀'.repeat(4_000));
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      meetingSummary: '😀'.repeat(4_000),
    }));
  });

  it('rejects more than 4,000 Unicode code points with an associated field error', async () => {
    const onSave = vi.fn();
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details}
      user={user} mutationPending={false} onSave={onSave} />));
    const summary = container.querySelector('#meeting-summary') as HTMLTextAreaElement;
    change(summary, '😀'.repeat(4_001));
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).not.toHaveBeenCalled();
    expect(summary.getAttribute('aria-invalid')).toBe('true');
    expect(summary.getAttribute('aria-describedby')).toBe('meeting-summary-error');
    expect(container.querySelector('#meeting-summary-error')?.textContent).toContain('4.000');
    expect(container.querySelector('[role="alert"]')).toBe(document.activeElement);
  });

  it('maps only canonical MEETING_NOT_READY field errors to associated controls', async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError(
      400,
      'MEETING_NOT_READY',
      'Görüşme bilgilerini tamamlayın.',
      false,
      { fieldErrors: {
        meetingAt: 'Gerçekleşme zamanı zorunludur.',
        outcome: 'Sonuç zorunludur.',
        meetingSummary: 'Özet zorunludur.',
        nextFollowUpAt: 'Takip zamanı geçersizdir.',
        hiddenRelation: 'Gizli bilgi',
      } },
    ));
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details}
      user={user} mutationPending={false} onSave={onSave} />));
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());

    for (const [controlId, errorId] of [
      ['meeting-actual-at', 'meeting-actual-at-error'],
      ['meeting-outcome', 'meeting-outcome-error'],
      ['meeting-summary', 'meeting-summary-error'],
    ]) {
      const control = container.querySelector(`#${controlId}`);
      expect(control?.getAttribute('aria-invalid')).toBe('true');
      expect(control?.getAttribute('aria-describedby')).toContain(errorId);
      expect(container.querySelector(`#${errorId}`)?.textContent).not.toBe('');
    }
    expect(container.textContent).not.toContain('Gizli bilgi');
    expect(container.querySelector('[role="alert"]')).toBe(document.activeElement);
  });

  it('describes local date-time inputs with the device IANA timezone', async () => {
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details}
      user={user} mutationPending={false} onSave={vi.fn()} />));
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(container.querySelector('#meeting-timezone-help')?.textContent)
      .toBe(`Saat dilimi: ${timezone}`);
    expect(container.querySelector('#meeting-actual-at')?.getAttribute('aria-describedby'))
      .toContain('meeting-timezone-help');
  });

  it('uses semantic read-only results in review-locked states', async () => {
    await act(async () => root.render(<MeetingDetailsSection job={{ ...job, status: 'WAITING_APPROVAL' }}
      details={{ ...details, outcome: 'POSITIVE', meetingSummary: 'Olumlu görüşme.' }} user={user}
      mutationPending={false} onSave={vi.fn()} />));
    expect(container.querySelector('form')).toBeNull(); expect(container.querySelector('dl')).not.toBeNull();
    expect(container.textContent).toContain('Olumlu');
  });

  it('obeys the canonical edit capability instead of deriving NEW as editable', async () => {
    await act(async () => root.render(<MeetingDetailsSection job={{ ...job, status: 'NEW' }}
      details={{ ...details, outcome: 'POSITIVE', meetingSummary: 'Önceden kayıtlı.' }} user={user}
      canEdit={false} mutationPending={false} onSave={vi.fn()} />));
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('dl')).not.toBeNull();
  });

  it('freezes the attempt on status-0 INVALID_RESPONSE from a committed success response', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz yanıt alındı.', false))
      .mockResolvedValueOnce({ ...details, meetingAt: '2026-07-15T12:30:00.000Z', jobCardVersion: 4 });
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details} user={user} mutationPending={false} onSave={onSave} />));
    change(container.querySelector('#meeting-actual-at')!, '2026-07-15T12:30');
    change(container.querySelector('#meeting-summary')!, 'Özgün özet');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-original-retry]')).toBeTruthy();
    expect(container.querySelector('form fieldset')).toHaveProperty('disabled', true);

    await act(async () => (container.querySelector('[data-original-retry]') as HTMLButtonElement).click());
    expect(onSave.mock.calls[1]![0]).toMatchObject({
      clientActionId: onSave.mock.calls[0]![0].clientActionId,
      expectedVersion: onSave.mock.calls[0]![0].expectedVersion,
      meetingSummary: 'Özgün özet',
    });
    await settle();
    expect(container.querySelector('[data-original-retry]')).toBeNull();
  });
});

describe('MeetingDetailsSection post-retry canonical reconciliation', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    uuidSeq = 0; Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => `recon-${++uuidSeq}`) }); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); });
  function summaryValue() {
    return (container.querySelector('#meeting-summary') as HTMLTextAreaElement).value;
  }
  async function renderSection(onSave: (input: never) => Promise<MeetingDetails>, jobVersion: number, canonical: MeetingDetails) {
    await act(async () => root.render(<MeetingDetailsSection job={{ ...job, version: jobVersion }}
      details={canonical} user={user} mutationPending={false} onSave={onSave as never} />));
  }
  async function submitDraft(summary: string) {
    change(container.querySelector('#meeting-summary')!, summary);
    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); await Promise.resolve(); });
    await settle();
  }
  async function clickOriginalRetry() {
    await act(async () => { (container.querySelector('[data-original-retry]') as HTMLButtonElement).click(); });
    await settle();
  }

  it('RECON-A: ambiguous -> B -> exact retry success -> B reconciled, then C wins', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true))
      .mockResolvedValueOnce({ ...details, meetingSummary: 'Özgün özet', jobCardVersion: 4 });
    await renderSection(onSave, 3, details);
    await submitDraft('Özgün özet');
    expect(container.querySelector('[data-original-retry]')).toBeTruthy();

    // Canonical B arrives while the attempt is unresolved (e.g. realtime refresh).
    await renderSection(onSave, 4, { ...details, meetingSummary: 'Eşzamanlı özet', jobCardVersion: 4 });
    expect(summaryValue()).toBe('Özgün özet');
    expect(container.querySelector('form fieldset')).toHaveProperty('disabled', true);
    expect(container.querySelector('[data-original-retry]')).toBeTruthy();

    await clickOriginalRetry();
    expect(onSave).toHaveBeenCalledTimes(2);
    // Exact original retry: same reference, same id, same version, same payload.
    expect(onSave.mock.calls[1]![0]).toBe(onSave.mock.calls[0]![0]);
    expect(onSave.mock.calls[1]![0]).toMatchObject({
      clientActionId: 'recon-1', expectedVersion: 3, meetingSummary: 'Özgün özet',
    });
    // Deferred canonical B becomes visible after resolution.
    expect(summaryValue()).toBe('Eşzamanlı özet');
    expect(container.querySelector('[data-original-retry]')).toBeNull();

    // A newer canonical C (parent refreshTruth after onSave) must win; no snapback to B.
    await renderSection(onSave, 5, { ...details, meetingSummary: 'Taze özet', jobCardVersion: 5 });
    expect(summaryValue()).toBe('Taze özet');
  });

  it('RECON-B: ambiguous -> B -> definitive rejection -> B reconciled and editing restored', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true))
      .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'Görüşme özeti geçersiz.', false));
    await renderSection(onSave, 3, details);
    await submitDraft('Özgün özet');
    await renderSection(onSave, 4, { ...details, meetingSummary: 'Eşzamanlı özet', jobCardVersion: 4 });
    expect(summaryValue()).toBe('Özgün özet');

    await clickOriginalRetry();
    expect(onSave).toHaveBeenCalledTimes(2);
    // Frozen attempt resolved: retry affordance gone, editing available, B applied.
    expect(container.querySelector('[data-original-retry]')).toBeNull();
    expect(container.querySelector('form fieldset')).toHaveProperty('disabled', false);
    expect(summaryValue()).toBe('Eşzamanlı özet');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Görüşme özeti geçersiz.');
  });

  it('RECON-C: definitive rejection without deferred canonical preserves the user draft', async () => {
    const onSave = vi.fn()
      .mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Görüşme özeti geçersiz.', false));
    await renderSection(onSave, 3, details);
    await submitDraft('Kullanıcı taslağı');

    // No canonical update arrived while the attempt existed: X must survive.
    expect(container.querySelector('[data-original-retry]')).toBeNull();
    expect(container.querySelector('form fieldset')).toHaveProperty('disabled', false);
    expect(summaryValue()).toBe('Kullanıcı taslağı');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Görüşme özeti geçersiz.');
  });

  it('RECON-D: latest deferred canonical wins (B then C while ambiguous)', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true))
      .mockResolvedValueOnce({ ...details, meetingSummary: 'Özgün özet', jobCardVersion: 4 });
    await renderSection(onSave, 3, details);
    await submitDraft('Özgün özet');
    await renderSection(onSave, 4, { ...details, meetingSummary: 'B özeti', jobCardVersion: 4 });
    await renderSection(onSave, 5, { ...details, meetingSummary: 'C özeti', jobCardVersion: 5 });

    await clickOriginalRetry();
    expect(summaryValue()).toBe('C özeti');
  });

  it('RECON-E: ordinary canonical update without an attempt still syncs immediately', async () => {
    const onSave = vi.fn();
    await renderSection(onSave, 3, details);
    await renderSection(onSave, 4, { ...details, meetingSummary: 'Doğrudan özet', jobCardVersion: 4 });
    expect(summaryValue()).toBe('Doğrudan özet');
  });
});
