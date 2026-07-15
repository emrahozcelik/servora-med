/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingDetailsSection } from '../src/jobs/MeetingDetails';
import type { JobCard, MeetingDetails } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const user: CurrentUser = { id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF', mustChangePassword: false, isActive: true, version: 1 };
const job = { id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS', version: 3,
  title: 'Görüşme', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1', createdBy: 'staff-1',
  priority: 'normal', dueDate: '2026-07-15', assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' }, contact: null } satisfies JobCard;
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
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

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

  it('uses semantic read-only results in review-locked states', async () => {
    await act(async () => root.render(<MeetingDetailsSection job={{ ...job, status: 'WAITING_APPROVAL' }}
      details={{ ...details, outcome: 'POSITIVE', meetingSummary: 'Olumlu görüşme.' }} user={user}
      mutationPending={false} onSave={vi.fn()} />));
    expect(container.querySelector('form')).toBeNull(); expect(container.querySelector('dl')).not.toBeNull();
    expect(container.textContent).toContain('Olumlu');
  });
});
