import { AppError } from '../../errors/index.js';
import type { CalendarRepository } from './repository.js';
import {
  manualEventCancelRequestHash,
  manualEventCreateRequestHash,
  manualEventPatchRequestHash,
} from './request-hash.js';
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

/**
 * Duration-preserving manual-event patch semantics. A manual calendar event
 * owns a user-planned interval: when a patch moves only the start, the
 * persisted end is delta-shifted by the same amount so the interval duration
 * survives rescheduling. Explicit ends are always respected; unrelated
 * patches leave scheduling untouched. Pure elapsed-time arithmetic, matching
 * the persisted-instant semantics of calendar_events.
 */
export function preserveManualEventDuration(
  current: Pick<CalendarEvent, 'startsAt' | 'endsAt'>,
  input: ManualEventPatchInput,
): ManualEventPatchInput {
  if (input.startsAt === undefined || input.endsAt !== undefined) return input;
  if (current.endsAt === null) return input;
  const previousStart = Date.parse(current.startsAt);
  const previousEnd = Date.parse(current.endsAt);
  const nextStart = Date.parse(input.startsAt);
  if (
    Number.isNaN(previousStart) || Number.isNaN(previousEnd)
    || Number.isNaN(nextStart) || previousEnd <= previousStart
  ) {
    return input;
  }
  return {
    ...input,
    endsAt: new Date(previousEnd + (nextStart - previousStart)).toISOString(),
  };
}

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
    // WORKING-DAY contract reconciliation: a manual calendar event is an
    // explicit human choice, so an organization-local Sunday is allowed. The
    // submitted event timezone stays display provenance only — it neither
    // creates nor lifts a Sunday constraint, because no such constraint applies
    // to this write path.
    return this.present(
      actor,
      await this.repository.createManual(
        actor, input, this.now(), manualEventCreateRequestHash(input),
      ),
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
    // Request identity binds the caller's ORIGINAL patch: field presence is
    // semantic, and preserveManualEventDuration below derives endsAt from
    // persisted state, which must never participate in the hash.
    const requestHash = manualEventPatchRequestHash(eventId, input);
    // CAL-REPLAY-BEFORE-STATE-VALIDATION: a completed exact replay is not a
    // new mutation. Resolve it here, after existence/authorization but before
    // any mutable business validation, so a later state change (for example a
    // stretched duration) cannot wrongly reject the historical request.
    // Authentication, organization isolation, actor access and event
    // identity/scope above are never bypassed, and the transactional writer
    // below re-resolves identity inside its claim for concurrent requests.
    const replay = await this.repository.resolveCompletedAction(
      actor, input.clientActionId, 'UPDATED', requestHash,
    );
    if (replay) return this.present(actor, replay);
    const merged = preserveManualEventDuration(current, input);
    // WORKING-DAY contract reconciliation: a manual reschedule onto the
    // organization-local Sunday is honoured verbatim — no rejection, no silent
    // re-dating. `preserveManualEventDuration` still delta-shifts a
    // startsAt-only move so the human's interval duration survives; the derived
    // endsAt is used for the write only, never for the request hash.
    return this.present(
      actor,
      await this.repository.patchManual(
        actor,
        eventId,
        merged,
        this.now(),
        requestHash,
      ),
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
      await this.repository.cancelManual(
        actor, eventId, input, this.now(), manualEventCancelRequestHash(eventId, input),
      ),
    );
  }
}
