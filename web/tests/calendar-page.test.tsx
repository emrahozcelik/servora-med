/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CalendarPage } from '../src/calendar/CalendarPage';
import type { CurrentUser } from '../src/services/api';

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
vi.mock('../src/realtime/RealtimeProvider', () => ({
  useRealtimeInvalidation: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const manager: CurrentUser = {
  id: 'manager-1',
  organizationId: 'org-1',
  name: 'Murat Yönetici',
  email: 'manager@example.test',
  role: 'MANAGER',
  mustChangePassword: false,
  isActive: true,
  version: 1,
  capabilities: { overviewDashboard: true, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};
const event = {
  id: 'event-1',
  source: 'MANUAL' as const,
  title: 'Klinik hazırlığı',
  description: null,
  startsAt: '2026-07-29T09:00:00.000Z',
  endsAt: '2026-07-29T10:00:00.000Z',
  timezone: 'Europe/Istanbul',
  assignedUser: { id: 'staff-1', name: 'Ayşe Personel' },
  version: 1,
  status: 'ACTIVE' as const,
  createdBy: { id: 'manager-1', name: 'Murat Yönetici' },
  updatedBy: { id: 'manager-1', name: 'Murat Yönetici' },
  canEdit: true,
  canCancel: true,
};

describe('CalendarPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    calendarApi.listCalendar.mockResolvedValue([event]);
    calendarApi.listCalendarAssignees.mockResolvedValue([
      { id: 'staff-1', name: 'Ayşe Personel' },
      { id: 'staff-2', name: 'Bora Personel' },
    ]);
    calendarApi.getCalendarEvent.mockResolvedValue(event);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function render(path = '/calendar') {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <CalendarPage user={manager} />
        </MemoryRouter>,
      );
    });
    await act(async () => {});
  }

  it('loads the authorized team view without inventing a Manager self-assignment', async () => {
    await render();
    expect(calendarApi.listCalendar).toHaveBeenCalledWith(expect.objectContaining({
      assignedTo: '',
    }));
    const filter = container.querySelector<HTMLSelectElement>('.calendar-toolbar select')!;
    expect(filter.value).toBe('');
    expect(filter.textContent).toContain('Tüm yetkili personel');
    expect(filter.textContent).toContain('Ayşe Personel');

    const create = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Yeni plan'))!;
    await act(async () => create.click());
    const assignee = container.querySelector<HTMLSelectElement>('.calendar-form select')!;
    expect(assignee.value).toBe('staff-1');
  });

  it('highlights the exact event selected by a notification deep link', async () => {
    await render('/calendar?event=event-1');
    const selected = container.querySelector<HTMLElement>('.calendar-event--selected');
    expect(selected?.getAttribute('aria-current')).toBe('true');
    expect(selected?.textContent).toContain('Klinik hazırlığı');
  });
});
