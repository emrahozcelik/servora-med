import { randomUUID } from 'node:crypto';

import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import { NOOP_REALTIME_EVENT_PUBLISHER, type RealtimeEventPublisher } from '../realtime/event-bus.js';
import type { RealtimeEventRecord } from '../realtime/types.js';
import { presentNote, type StaffConfidentialNotesRepository } from './repository.js';
import type {
  CreateStaffConfidentialNoteInput,
  StaffConfidentialNoteDto,
  StaffConfidentialNotePage,
  StaffConfidentialNotePageQuery,
} from './types.js';

const forbidden = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
const actorNotActive = () => new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
const userNotFound = () => new AppError('USER_NOT_FOUND', 404, 'Kullanıcı bulunamadı.');
const profileNotFound = () => new AppError('STAFF_PROFILE_NOT_FOUND', 404, 'Personel profili bulunamadı.');
const actionInProgress = () => new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');

function validation(field: string) {
  return new AppError('VALIDATION_ERROR', 400, `${field} geçersizdir.`, {
    fieldErrors: { [field]: `${field} geçersizdir.` },
  });
}

const codePointLength = (value: string) => Array.from(value).length;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function boundedTrimmedString(
  value: unknown,
  field: string,
  min: number,
  max: number,
) {
  if (typeof value !== 'string') throw validation(field);
  const trimmed = value.trim();
  const length = codePointLength(trimmed);
  if (length < min || length > max) throw validation(field);
  return trimmed;
}

export function requireActionId(value: unknown) {
  return boundedTrimmedString(value, 'clientActionId', 1, 255);
}

export function staffUserIdValue(value: unknown) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw userNotFound();
  }
  return value.trim();
}

export function requireAdminOrManager(actor: SafeUser) {
  if (actor.role !== 'ADMIN' && actor.role !== 'MANAGER') throw forbidden();
}

export class StaffConfidentialNotesService {
  constructor(
    private readonly repository: StaffConfidentialNotesRepository,
    private readonly realtimePublisher: RealtimeEventPublisher = NOOP_REALTIME_EVENT_PUBLISHER,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private publishRealtime(events: readonly RealtimeEventRecord[]) {
    for (const event of events) {
      this.realtimePublisher.publish(event);
    }
  }

  async createNote(
    actor: SafeUser,
    staffUserId: string,
    input: CreateStaffConfidentialNoteInput,
  ): Promise<StaffConfidentialNoteDto> {
    requireAdminOrManager(actor);
    const normalizedStaffUserId = staffUserIdValue(staffUserId);
    const clientActionId = requireActionId(input.clientActionId);
    const body = boundedTrimmedString(input.body, 'body', 1, 4_000);

    const result = await this.repository.executeCriticalAction<StaffConfidentialNoteDto>(
      {
        organizationId: actor.organizationId,
        userId: actor.id,
        clientActionId,
        operationKey: `STAFF_CONFIDENTIAL_NOTE_CREATE:${normalizedStaffUserId}`,
      },
      async (transaction) => {
        const actorSnapshot = await transaction.lockActor(actor.organizationId, actor.id);
        if (!actorSnapshot?.isActive) throw actorNotActive();
        const subject = await transaction.findSubject(actor.organizationId, normalizedStaffUserId);
        if (!subject) throw userNotFound();
        if (subject.role !== 'STAFF' || !subject.hasProfile) throw profileNotFound();

        const noteId = randomUUID();
        const createdAt = this.now();
        const note = await transaction.createNote({
          id: noteId,
          organizationId: actor.organizationId,
          staffUserId: normalizedStaffUserId,
          authorUserId: actor.id,
          body,
        });
        await transaction.appendAudit({
          organizationId: actor.organizationId,
          actorUserId: actor.id,
          subjectType: 'STAFF_CONFIDENTIAL_NOTE',
          subjectId: noteId,
          eventType: 'STAFF_CONFIDENTIAL_NOTE_CREATED',
          oldValue: null,
          newValue: null,
          metadata: { staffUserId: normalizedStaffUserId },
        });
        const realtimeEvent = await transaction.appendRealtimeEvent({
          organizationId: actor.organizationId,
          type: 'confidential-note.created',
          entityType: 'confidential-note',
          entityId: noteId,
          actorUserId: actor.id,
          audience: {
            roles: ['ADMIN', 'MANAGER'] as const,
            userIds: [],
          },
          resourceKeys: [`staff-confidential-notes:${normalizedStaffUserId}`],
          occurredAt: createdAt,
        });
        return { response: presentNote(note, actor.name), realtimeEvents: [realtimeEvent] };
      },
    );

    if (result.kind === 'processing') throw actionInProgress();
    if (result.kind === 'completed') this.publishRealtime(result.realtimeEvents);
    return result.response;
  }

  async listNotes(
    actor: SafeUser,
    staffUserId: string,
    page: StaffConfidentialNotePageQuery,
  ): Promise<StaffConfidentialNotePage> {
    requireAdminOrManager(actor);
    const normalizedStaffUserId = staffUserIdValue(staffUserId);
    const subject = await this.repository.findSubject(actor.organizationId, normalizedStaffUserId);
    if (!subject) throw userNotFound();
    if (subject.role !== 'STAFF' || !subject.hasProfile) throw profileNotFound();
    return this.repository.listNotes(actor.organizationId, normalizedStaffUserId, page);
  }
}
