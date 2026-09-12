/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingDetailsSection } from '../src/jobs/MeetingDetails';
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
function renderSection(onSave: (input: never) => Promise<MeetingDetails>, root: Root, container: HTMLDivElement) {
  return act(async () => root.render(<MeetingDetailsSection job={job} details={details}
    user={user} mutationPending={false} onSave={onSave as never} />));
}

describe('MeetingDetailsSection stale error lifecycle', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container);
    uuidSeq = 0; Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn(() => `stale-${++uuidSeq}`) }); });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it('STALE-1: a definitive failure displays its own error', async () => {
    const onSave = vi.fn().mockRejectedValue(new ApiError(400, 'VALIDATION_ERROR', 'Görüşme özeti geçersiz.', false));
    await renderSection(onSave, root, container);
    change(container.querySelector('#meeting-summary')!, 'Yeni özet');
    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Görüşme özeti geçersiz.');
  });

  it('STALE-2: a successful original-attempt retry removes the obsolete ambiguous error', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true))
      .mockResolvedValueOnce({ ...details, meetingSummary: 'Özgün özet', jobCardVersion: 4 });
    await renderSection(onSave, root, container);
    change(container.querySelector('#meeting-summary')!, 'Özgün özet');
    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Bağlantı kesildi.');
    expect(container.querySelector('[data-original-retry]')).toBeTruthy();

    await act(async () => { (container.querySelector('[data-original-retry]') as HTMLButtonElement).click(); });
    await settle();

    expect(onSave).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-original-retry]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Görüşme sonucu kaydedildi.');
  });

  it('STALE-4: a fresh failure after a success still displays its own error', async () => {
    const onSave = vi.fn()
      .mockRejectedValueOnce(new ApiError(0, 'NETWORK_ERROR', 'Bağlantı kesildi.', true))
      .mockResolvedValueOnce({ ...details, meetingSummary: 'Özgün özet', jobCardVersion: 4 })
      .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'Görüşme özeti geçersiz.', false));
    await renderSection(onSave, root, container);
    change(container.querySelector('#meeting-summary')!, 'Özgün özet');
    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await settle();
    await act(async () => { (container.querySelector('[data-original-retry]') as HTMLButtonElement).click(); });
    await settle();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    change(container.querySelector('#meeting-summary')!, 'Bozuk özet');
    await act(async () => { (container.querySelector('form') as HTMLFormElement).requestSubmit(); });
    await settle();

    expect(onSave).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Görüşme özeti geçersiz.');
  });
});
