import { describe, expect, it } from 'vitest';

import type { CalendarRepository } from '../src/modules/calendar/repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type {
  CalendarActor,
  CalendarEvent,
  CalendarQuery,
  CalendarUser,
  ManualEventCancelInput,
  ManualEventCreateInput,
  ManualEventPatchInput,
} from '../src/modules/calendar/types.js';

const staff: CalendarActor = {
  id: '11111111-1111-4111-8111-111111111111',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'STAFF',
};
const otherId = '22222222-2222-4222-8222-222222222222';
const query: CalendarQuery = {
  from: '2026-07-26T00:00:00.000Z',
  to: '2026-07-27T00:00:00.000Z',
  assignedTo: null,
};
const manual: CalendarEvent = {
  id: '33333333-3333-4333-8333-333333333333',
  source: 'MANUAL',
  title: 'Klinik hazırlığı',
  description: null,
  startsAt: '2026-07-26T09:00:00.000Z',
  endsAt: '2026-07-26T10:00:00.000Z',
  timezone: 'Europe/Istanbul',
  assignedUser: { id: staff.id, name: 'Sentetik Personel' },
  version: 1,
  status: 'ACTIVE',
  createdBy: { id: staff.id, name: 'Sentetik Personel' },
  updatedBy: { id: staff.id, name: 'Sentetik Personel' },
  canEdit: false,
  canCancel: false,
};

class MemoryCalendarRepository implements CalendarRepository {
  lastQuery: CalendarQuery | null = null;
  users: CalendarUser[] = [{
    id: staff.id,
    organizationId: staff.organizationId,
    name: 'Sentetik Personel',
    role: 'STAFF',
    isActive: true,
  }, {
    id: otherId,
    organizationId: staff.organizationId,
    name: 'Diğer Personel',
    role: 'STAFF',
    isActive: true,
  }];

  async list(_actor: CalendarActor, value: CalendarQuery) {
    this.lastQuery = value;
    return [manual];
  }
  async listAssignableUsers() { return this.users; }
  async getAssignableUser(_actor: CalendarActor, userId: string) {
    return this.users.find((user) => user.id === userId) ?? null;
  }
  async getCalendarUser(_actor: CalendarActor, userId: string) {
    return this.users.find((user) => user.id === userId) ?? null;
  }
  async getManualEvent() { return manual; }
  async createManual(_actor: CalendarActor, _input: ManualEventCreateInput) {
    return manual;
  }
  async patchManual(
    _actor: CalendarActor,
    _eventId: string,
    _input: ManualEventPatchInput,
  ) { return { ...manual, version: 2 }; }
  async cancelManual(
    _actor: CalendarActor,
    _eventId: string,
    _input: ManualEventCancelInput,
  ) { return { ...manual, status: 'CANCELLED' as const, version: 2 }; }
}

describe('CalendarService', () => {
  it('fails closed without querying when calendar is disabled', async () => {
    const repository = new MemoryCalendarRepository();
    await expect(
      new CalendarService(false, repository).list(staff, query),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
    expect(repository.lastQuery).toBeNull();
  });

  it('forces Staff list scope to the authenticated user', async () => {
    const repository = new MemoryCalendarRepository();
    const result = await new CalendarService(true, repository).list(
      staff,
      { ...query, assignedTo: otherId },
    );
    expect(repository.lastQuery?.assignedTo).toBe(staff.id);
    expect(result.items[0]).toMatchObject({ canEdit: true, canCancel: true });
  });

  it('rejects Staff assignment to another user', async () => {
    const repository = new MemoryCalendarRepository();
    await expect(new CalendarService(true, repository).create(staff, {
      clientActionId: 'create-1',
      assignedUserId: otherId,
      title: 'Yetkisiz plan',
      description: null,
      startsAt: '2026-07-26T09:00:00.000Z',
      endsAt: '2026-07-26T10:00:00.000Z',
      timezone: 'Europe/Istanbul',
    })).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
  });

  it('allows management to use an active organization Staff scope', async () => {
    const repository = new MemoryCalendarRepository();
    const manager = { ...staff, id: '44444444-4444-4444-8444-444444444444', role: 'MANAGER' as const };
    const result = await new CalendarService(true, repository).list(
      manager,
      { ...query, assignedTo: otherId },
    );
    expect(repository.lastQuery?.assignedTo).toBe(otherId);
    expect(result.items).toHaveLength(1);
  });

  it('authorizes a deep-linked manual event through the same assignee scope', async () => {
    const repository = new MemoryCalendarRepository();
    await expect(new CalendarService(true, repository).detail(
      staff,
      manual.id,
    )).resolves.toMatchObject({
      id: manual.id,
      source: 'MANUAL',
      canEdit: true,
    });
  });
});
