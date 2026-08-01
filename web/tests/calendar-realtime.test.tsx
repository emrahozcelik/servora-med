/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurrentUser } from '../src/services/api';
import { RealtimeProvider, type RealtimeEventSource } from '../src/realtime/RealtimeProvider';

const calendarApi = vi.hoisted(() => ({
  listCalendar: vi.fn(),
  listCalendarAssignees: vi.fn(),
  getCalendarEvent: vi.fn(),
  createManualEvent: vi.fn(),
  patchManualEvent: vi.fn(),
  cancelManualEvent: vi.fn(),
}));

vi.mock('../src/services/calendar-api', () => calendarApi);
vi.mock('../src/jobs/jobs-api', () => ({ patchJobCard: vi.fn() }));

import { CalendarPage } from '../src/calendar/CalendarPage';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class FakeEventSource implements RealtimeEventSource {
  readonly listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: EventListener) { this.listeners.get(type)?.delete(listener); }
  close() {}
  emit(type: string, data: string) {
    this.listeners.get(type)?.forEach((listener) => listener(new MessageEvent(type, { data })));
  }
}

const manager = {
  id: 'manager-1', organizationId: 'org-1', name: 'Murat', email: 'manager@example.test', role: 'MANAGER',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
} as CurrentUser;

function change(id: string, resourceKeys: string[]) {
  return JSON.stringify({
    id, type: 'job.updated', entity: { type: 'job-card', id: 'job-1' }, resourceKeys,
    occurredAt: '2026-07-20T10:00:00.000Z',
  });
}

describe('Calendar realtime integration', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    calendarApi.listCalendar.mockResolvedValue([]);
    calendarApi.listCalendarAssignees.mockResolvedValue([]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('refreshes listCalendar when a real servora.change carries the calendar key', async () => {
    const source = new FakeEventSource();
    await act(async () => {
      root.render(
        <RealtimeProvider eventSourceFactory={() => source}>
          <MemoryRouter><CalendarPage user={manager} /></MemoryRouter>
        </RealtimeProvider>,
      );
      await Promise.resolve();
    });
    expect(calendarApi.listCalendar).toHaveBeenCalledTimes(1);

    await act(async () => {
      source.emit('servora.change', change('1', ['calendar']));
      await Promise.resolve();
    });

    expect(calendarApi.listCalendar).toHaveBeenCalledTimes(2);
  });
});
