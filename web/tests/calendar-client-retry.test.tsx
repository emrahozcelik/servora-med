/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventForm, EventItem } from '../src/calendar/CalendarPage';
import type { ManualCalendarEvent } from '../src/services/calendar-api';
import { ApiError, type CurrentUser } from '../src/services/api';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const calendarApi = vi.hoisted(() => ({
  createManualEvent: vi.fn(),
  patchManualEvent: vi.fn(),
  cancelManualEvent: vi.fn(),
}));
vi.mock('../src/services/calendar-api', async (original) => ({
  ...(await original<typeof import('../src/services/calendar-api')>()),
  ...calendarApi,
}));

const staff: CurrentUser = {
  id: 'staff-1', organizationId: 'org-1', name: 'Sezer Dener', email: 's@test.local',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1,
};
const assignee = { id: 'staff-1', name: 'Sezer Dener' };

const manualEvent = (overrides: Partial<ManualCalendarEvent> = {}): ManualCalendarEvent => ({
  id: 'event-1',
  source: 'MANUAL',
  title: 'Klinik ziyareti',
  startsAt: '2026-09-15T10:00:00.000Z',
  endsAt: '2026-09-15T11:00:00.000Z',
  timezone: 'Europe/Istanbul',
  assignedUser: assignee,
  version: 3,
  canEdit: true,
  canCancel: true,
  description: 'Rutin ziyaret',
  status: 'ACTIVE',
  createdBy: assignee,
  updatedBy: assignee,
  ...overrides,
});

const ambiguousFailure = () => new ApiError(0, 'NETWORK_ERROR', 'Sunucuya ulaşılamadı.', true);

function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

let uuidSeq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(node);
  });
}

function renderCreateForm(onSaved: () => void = () => {}) {
  return mount(
    <EventForm
      user={staff}
      assignees={[assignee]}
      event={null}
      defaultAssigneeId={assignee.id}
      onSaved={onSaved}
      onClose={() => {}}
    />,
  );
}

function fillTitleAndSubmit() {
  const form = container!.querySelector('.calendar-form') as HTMLFormElement;
  const title = form.querySelector('input[maxlength]') as HTMLInputElement;
  change(title, 'Klinik ziyareti');
  return act(async () => {
    form.requestSubmit();
  });
}

function openCancelDialog() {
  const trigger = Array.from(container!.querySelectorAll('button'))
    .find((button) => button.textContent === 'İptal et' && !button.closest('[role="dialog"]'))!;
  return act(async () => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function confirmCancelDialog(reason: string) {
  const dialog = container!.querySelector('[role="dialog"]')!;
  const area = dialog.querySelector('textarea') as HTMLTextAreaElement;
  change(area, reason);
  const form = dialog.querySelector('form') as HTMLFormElement;
  return act(async () => {
    form.requestSubmit();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  uuidSeq = 0;
  Object.defineProperty(globalThis.crypto, 'randomUUID', {
    configurable: true,
    value: vi.fn(() => `action-${++uuidSeq}`),
  });
  calendarApi.createManualEvent.mockImplementation(async (input: unknown) => input);
  calendarApi.patchManualEvent.mockImplementation(async (_id: unknown, input: unknown) => input);
  calendarApi.cancelManualEvent.mockImplementation(async (_id: unknown, input: unknown) => input);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  if (container) container.remove();
  container = null;
});

describe('CAL-CLIENT-RETRY calendar action identity', () => {
  it('CAL-RETRY-1/2: retry of the same logical create reuses its action id', async () => {
    await renderCreateForm();
    await settle();
    calendarApi.createManualEvent.mockRejectedValueOnce(ambiguousFailure());
    await fillTitleAndSubmit();
    await settle();
    calendarApi.createManualEvent.mockResolvedValueOnce(manualEvent());
    await fillTitleAndSubmit();
    await settle();

    expect(calendarApi.createManualEvent).toHaveBeenCalledTimes(2);
    const first = calendarApi.createManualEvent.mock.calls[0]![0] as { clientActionId: string };
    const second = calendarApi.createManualEvent.mock.calls[1]![0] as { clientActionId: string };
    expect(first.clientActionId).toBe('action-1');
    expect(second.clientActionId).toBe('action-1');
  });

  it('CAL-RETRY-3: retry preserves the logical payload together with the stable id', async () => {
    await renderCreateForm();
    await settle();
    calendarApi.createManualEvent.mockRejectedValueOnce(ambiguousFailure());
    await fillTitleAndSubmit();
    await settle();
    calendarApi.createManualEvent.mockResolvedValueOnce(manualEvent());
    await fillTitleAndSubmit();
    await settle();

    const [first, second] = calendarApi.createManualEvent.mock.calls
      .map((call) => call[0] as Record<string, unknown>);
    const { clientActionId: _firstId, ...firstPayload } = first!;
    const { clientActionId: _secondId, ...secondPayload } = second!;
    expect(secondPayload).toEqual(firstPayload);
    expect(second!.clientActionId).toBe(first!.clientActionId);
  });

  it('CAL-RETRY-4: a new operation after success receives a fresh id', async () => {
    const firstSaved: string[] = [];
    await renderCreateForm();
    await settle();
    calendarApi.createManualEvent.mockResolvedValueOnce(manualEvent({ id: 'event-a' }));
    await fillTitleAndSubmit();
    await settle();
    firstSaved.push(
      (calendarApi.createManualEvent.mock.calls[0]![0] as { clientActionId: string }).clientActionId,
    );

    await act(async () => root!.unmount());
    root = null;
    container!.remove();
    container = null;
    await mount(
      <EventForm
        user={staff}
        assignees={[assignee]}
        event={null}
        defaultAssigneeId={assignee.id}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    calendarApi.createManualEvent.mockResolvedValueOnce(manualEvent({ id: 'event-b' }));
    await fillTitleAndSubmit();
    await settle();

    const secondId = (calendarApi.createManualEvent.mock.calls[1]![0] as { clientActionId: string })
      .clientActionId;
    expect(firstSaved[0]).toBe('action-1');
    expect(secondId).not.toBe(firstSaved[0]);
  });

  it('CAL-RETRY-5: abandoning a failed attempt does not leak its id into the next operation', async () => {
    await renderCreateForm();
    await settle();
    calendarApi.createManualEvent.mockRejectedValueOnce(ambiguousFailure());
    await fillTitleAndSubmit();
    await settle();
    const abandonedId = (calendarApi.createManualEvent.mock.calls[0]![0] as { clientActionId: string })
      .clientActionId;

    await act(async () => root!.unmount());
    root = null;
    container!.remove();
    container = null;
    await mount(
      <EventForm
        user={staff}
        assignees={[assignee]}
        event={null}
        defaultAssigneeId={assignee.id}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    calendarApi.createManualEvent.mockResolvedValueOnce(manualEvent({ id: 'event-c' }));
    await fillTitleAndSubmit();
    await settle();

    expect(calendarApi.createManualEvent).toHaveBeenCalledTimes(2);
    const freshId = (calendarApi.createManualEvent.mock.calls[1]![0] as { clientActionId: string })
      .clientActionId;
    expect(freshId).not.toBe(abandonedId);
  });

  it('CAL-RETRY-6: independent create and edit operations have independent ids', async () => {
    await renderCreateForm();
    await settle();
    calendarApi.createManualEvent.mockResolvedValueOnce(manualEvent({ id: 'event-a' }));
    await fillTitleAndSubmit();
    await settle();
    const createId = (calendarApi.createManualEvent.mock.calls[0]![0] as { clientActionId: string })
      .clientActionId;

    await act(async () => root!.unmount());
    root = null;
    container!.remove();
    container = null;
    const target = manualEvent({ id: 'event-b' });
    await mount(
      <EventForm
        user={staff}
        assignees={[assignee]}
        event={target}
        defaultAssigneeId={assignee.id}
        onSaved={() => {}}
        onClose={() => {}}
      />,
    );
    await settle();
    calendarApi.patchManualEvent.mockRejectedValueOnce(ambiguousFailure());
    await fillTitleAndSubmit();
    await settle();
    calendarApi.patchManualEvent.mockResolvedValueOnce(target);
    await fillTitleAndSubmit();
    await settle();

    expect(calendarApi.patchManualEvent).toHaveBeenCalledTimes(2);
    const patchFirst = calendarApi.patchManualEvent.mock.calls[0]![1] as { clientActionId: string };
    const patchSecond = calendarApi.patchManualEvent.mock.calls[1]![1] as { clientActionId: string };
    expect(patchFirst.clientActionId).not.toBe(createId);
    expect(patchSecond.clientActionId).toBe(patchFirst.clientActionId);
  });

  it('CAL-RETRY-2/6: cancel retry reuses its id and stays scoped to its event', async () => {
    const first = manualEvent({ id: 'event-x' });
    const second = manualEvent({ id: 'event-y' });
    await mount(
      <MemoryRouter>
        <EventItem event={first} onEdit={() => {}} onCancelled={() => {}} selected={false} />
        <EventItem event={second} onEdit={() => {}} onCancelled={() => {}} selected={false} />
      </MemoryRouter>,
    );
    await settle();

    await openCancelDialog();
    await settle();
    calendarApi.cancelManualEvent.mockRejectedValueOnce(ambiguousFailure());
    await confirmCancelDialog('Hasta gelmedi');
    await settle();
    await openCancelDialog();
    await settle();
    calendarApi.cancelManualEvent.mockResolvedValueOnce(first);
    await confirmCancelDialog('Hasta gelmedi');
    await settle();

    // Both confirms above targeted the first card's dialog.
    expect(calendarApi.cancelManualEvent).toHaveBeenCalledTimes(2);
    const cancelFirst = calendarApi.cancelManualEvent.mock.calls[0]![1] as { clientActionId: string };
    const cancelSecond = calendarApi.cancelManualEvent.mock.calls[1]![1] as { clientActionId: string };
    expect(cancelFirst.clientActionId).toBe('action-1');
    expect(cancelSecond.clientActionId).toBe('action-1');
  });
});
