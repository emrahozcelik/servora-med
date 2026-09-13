import { AppError } from '../../errors/index.js';
import { assertWorkingDay } from '../job-cards/working-day-policy.js';
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
    // WORKING-DAY V1 (§21): the request parser knows the syntax but not the
    // organization timezone, so enforcement lives here, against the
    // authoritative `organizations.timezone`. The submitted event timezone is
    // display provenance only and must not shift the Sunday boundary.
    assertWorkingDay({
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      timezone: await this.repository.getOrganizationTimezone(actor.organizationId),
    });
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
    const merged = preserveManualEventDuration(current, input);
    // WORKING-DAY V1 (§22): validate the MERGED effective interval, so a
    // startsAt-only move into Sunday, an endsAt-only extension into Sunday and a
    // both-field move into Sunday are all rejected. Only a patch that actually
    // carries a scheduling field can change the occupied interval; a title-,
    // description-, assignee- or timezone-only patch therefore leaves the
    // occupied interval untouched and never newly rejects a legacy Sunday record
    // (§10/§11). The derived endsAt is used only for validation, never for the
    // request hash.
    const scheduleTouched = input.startsAt !== undefined || input.endsAt !== undefined;
    const effectiveEndsAt = merged.endsAt ?? current.endsAt;
    if (scheduleTouched && effectiveEndsAt !== null) {
      assertWorkingDay({
        startsAt: new Date(merged.startsAt ?? current.startsAt),
        endsAt: new Date(effectiveEndsAt),
        timezone: await this.repository.getOrganizationTimezone(actor.organizationId),
      });
    }
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
