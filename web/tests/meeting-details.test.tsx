/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { meetingLocalValue, MeetingDetailsSection } from '../src/jobs/MeetingDetails';
import type { JobCard, MeetingDetails } from '../src/jobs/jobs-api';
import { ApiError, type CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const user: CurrentUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF', mustChangePassword: false, isActive: true, version: 1 };
const job = { id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS', version: 3,
  title: 'Görüşme', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1', createdBy: 'staff-1',
  priority: 'normal', dueDate: '2026-07-15', assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null, workflowContext } satisfies JobCard;
const details: MeetingDetails = { jobCardId: 'job-1', meetingAt: null, outcome: null, meetingSummary: null, nextFollowUpAt: null, jobCardVersion: 3 };
function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('MeetingDetailsSection', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => 'save-1') }); });
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

    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());

    expect(onSave).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('Görüşme sonucunda kaydedilecek bir değişiklik yok.');
  });

  it('saves canonical result fields and keeps follow-up optional with linked guidance', async () => {
    const onSave = vi.fn(async (input) => ({ ...details, ...input, jobCardVersion: 4 }));
    await act(async () => root.render(<MeetingDetailsSection job={job} details={details} user={user} mutationPending={false} onSave={onSave} />));
    change(container.querySelector('#meeting-actual-at')!, '2026-07-15T12:30');
    change(container.querySelector('#meeting-outcome')!, 'FOLLOW_UP_REQUIRED');
    change(container.querySelector('#meeting-summary')!, '  Ürün sunumu yapıldı.  ');
    const followUp = container.querySelector('#meeting-follow-up-at') as HTMLInputElement;
    expect(container.textContent).toContain('Takip zamanı eklemeniz önerilir');
    expect(followUp.required).toBe(false); expect(followUp.hasAttribute('aria-required')).toBe(false);
    expect(followUp.getAttribute('aria-describedby')).toBe('meeting-follow-up-help');
    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      clientActionId: 'save-1', expectedVersion: 3, outcome: 'FOLLOW_UP_REQUIRED',
      meetingSummary: 'Ürün sunumu yapıldı.', nextFollowUpAt: null,
    }));
    expect(new Date(onSave.mock.calls[0]![0].meetingAt as string).toString()).not.toBe('Invalid Date');
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
      ['meeting-follow-up-at', 'meeting-follow-up-at-error'],
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
});
