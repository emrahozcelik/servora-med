/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingDetailsSection } from '../src/jobs/MeetingDetails';
import type { JobCard, MeetingDetails } from '../src/jobs/jobs-api';
import type { CurrentUser } from '../src/services/api';
import { workflowContext } from './fixtures/job-workflow';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const user: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'a@x', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
};
const job = {
  id: 'job-1', organizationId: 'org-1', type: 'SALES_MEETING', status: 'IN_PROGRESS', version: 3,
  title: 'Görüşme', description: null, customerId: 'c1', contactId: null, assignedTo: 'staff-1',
  createdBy: 'staff-1', priority: 'normal', dueDate: '2026-07-15',
  assignee: { id: 'staff-1', name: 'Ayşe' }, customer: { id: 'c1', name: 'Klinik' },
  contact: null, workflowContext,
  hasOpenOverdueIncident: false,
  correctionDueAt: null,
} satisfies JobCard;
const details: MeetingDetails = {
  jobCardId: 'job-1', meetingAt: '2026-07-15T09:20:00.000Z', outcome: null, unsuccessfulReason: null,
  meetingSummary: null, nextFollowUpAt: '2026-07-20T09:00:00.000Z', metContactId: null, metContact: null,
  jobCardVersion: 3,
};

function change(element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype
    : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
}

describe('not-held Sales Meeting (JOB-010 release 2a)', () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function render(onSave = vi.fn()) {
    await act(async () => root.render(
      <MeetingDetailsSection
        job={job}
        details={details}
        user={user}
        mutationPending={false}
        onSave={onSave}
      />,
    ));
  }

  function label() {
    return container.querySelector('label[for="meeting-actual-at"]')?.textContent ?? '';
  }

  it('keeps the meeting time required-looking by default', async () => {
    await render();
    expect(label()).toBe('Gerçekleşme zamanı');
    expect(container.querySelector('#meeting-time-optional-help')).toBeNull();
    expect(container.querySelector('#meeting-actual-at')?.hasAttribute('required')).toBe(true);
  });

  it('marks the time optional only for FOLLOW_UP_REQUIRED with an unsuccessful reason', async () => {
    await render();
    change(container.querySelector('#meeting-outcome')!, 'FOLLOW_UP_REQUIRED');
    expect(label()).toBe('Gerçekleşme zamanı');
    expect(container.querySelector('#meeting-time-optional-help')).toBeNull();

    change(container.querySelector('#meeting-unsuccessful-reason')!, 'CONTACT_NOT_AVAILABLE');
    expect(label()).toBe('Gerçekleşme zamanı (isteğe bağlı)');
    expect(container.querySelector('#meeting-time-optional-help')?.textContent)
      .toContain('Görüşme gerçekleşmediyse bu alanı boş bırakabilirsiniz.');
    expect(container.querySelector('#meeting-actual-at')?.hasAttribute('required')).toBe(false);

    change(container.querySelector('#meeting-outcome')!, 'POSITIVE');
    expect(label()).toBe('Gerçekleşme zamanı');
    expect(container.querySelector('#meeting-time-optional-help')).toBeNull();
  });

  it('submits a not-held visit with no meeting time and no follow-up time', async () => {
    const onSave = vi.fn().mockResolvedValue({ ...details, outcome: 'FOLLOW_UP_REQUIRED' });
    await render(onSave);
    change(container.querySelector('#meeting-outcome')!, 'FOLLOW_UP_REQUIRED');
    change(container.querySelector('#meeting-unsuccessful-reason')!, 'CONTACT_NOT_AVAILABLE');
    change(container.querySelector('#meeting-actual-at')!, '');
    change(container.querySelector('#meeting-summary')!, 'İlgili kişi yerinde değildi.');

    await act(async () => (container.querySelector('form') as HTMLFormElement).requestSubmit());

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      meetingAt: null,
      outcome: 'FOLLOW_UP_REQUIRED',
      unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
      // DB CHECK 007 forbids a follow-up time without a meeting time.
      nextFollowUpAt: null,
    }));
  });
});
