import { AppError } from '../../errors/index.js';
import type { CalendarRepository } from './repository.js';
import type {
  CalendarActor,
  CalendarEvent,
  CalendarQuery,
  ManualEventCancelInput,
  ManualEventCreateInput,
  ManualEventPatchInput,
} from './types.js';

const unavailable = () => new AppError('NOT_FOUND', 404, 'Sayfa bulunamadı.');
const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');

export class CalendarService {
  constructor(
    private readonly enabled: boolean,
    private readonly repository: CalendarRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private requireEnabled() {
    if (!this.enabled) throw unavailable();
  }

  private async requireAssignable(actor: CalendarActor, userId: string) {
    if (actor.role === 'STAFF' && actor.id !== userId) throw forbidden();
    const user = await this.repository.getAssignableUser(actor, userId);
    if (!user || !user.isActive || user.role !== 'STAFF') throw forbidden();
    return user;
  }

  private async requireReadableAssignee(actor: CalendarActor, userId: string) {
    if (actor.role === 'STAFF' && actor.id !== userId) throw forbidden();
    const user = await this.repository.getCalendarUser(actor, userId);
    if (!user || user.role !== 'STAFF') throw forbidden();
    return user;
  }

  private present(actor: CalendarActor, item: CalendarEvent): CalendarEvent {
    const reachesAssignee = actor.role !== 'STAFF' || item.assignedUser.id === actor.id;
    if (item.source === 'JOB') {
      return {
        ...item,
        canEdit: reachesAssignee && ['NEW', 'ACCEPTED'].includes(item.jobStatus),
        canCancel: false,
      };
    }
    const editable = reachesAssignee && item.status === 'ACTIVE';
    return { ...item, canEdit: editable, canCancel: editable };
  }

  async list(actor: CalendarActor, query: CalendarQuery) {
    this.requireEnabled();
    const assignedTo = actor.role === 'STAFF' ? actor.id : query.assignedTo;
    if (assignedTo) await this.requireReadableAssignee(actor, assignedTo);
    const items = await this.repository.list(actor, { ...query, assignedTo });
    return { items: items.map((item) => this.present(actor, item)) };
  }

  async assignees(actor: CalendarActor) {
    this.requireEnabled();
    return { items: await this.repository.listAssignableUsers(actor) };
  }

  async detail(actor: CalendarActor, eventId: string) {
    this.requireEnabled();
    const current = await this.repository.getManualEvent(actor, eventId);
    if (!current || current.source !== 'MANUAL') throw unavailable();
    await this.requireReadableAssignee(actor, current.assignedUser.id);
    return this.present(actor, current);
  }

  async create(actor: CalendarActor, input: ManualEventCreateInput) {
    this.requireEnabled();
    await this.requireAssignable(actor, input.assignedUserId);
    return this.present(
      actor,
      await this.repository.createManual(actor, input, this.now()),
    );
  }

  async patch(
    actor: CalendarActor,
    eventId: string,
    input: ManualEventPatchInput,
  ) {
    this.requireEnabled();
    const current = await this.repository.getManualEvent(actor, eventId);
    if (!current || current.source !== 'MANUAL') throw unavailable();
    await this.requireAssignable(actor, current.assignedUser.id);
    if (input.assignedUserId) await this.requireAssignable(actor, input.assignedUserId);
    return this.present(
      actor,
      await this.repository.patchManual(actor, eventId, input, this.now()),
    );
  }

  async cancel(
    actor: CalendarActor,
    eventId: string,
    input: ManualEventCancelInput,
  ) {
    this.requireEnabled();
    const current = await this.repository.getManualEvent(actor, eventId);
    if (!current || current.source !== 'MANUAL') throw unavailable();
    await this.requireAssignable(actor, current.assignedUser.id);
    return this.present(
      actor,
      await this.repository.cancelManual(actor, eventId, input, this.now()),
    );
  }
}
