import { randomUUID } from 'node:crypto';

import { AppError } from '../../errors/index.js';
import { assertCanAccessNotes, assertCanAddNote } from './policy.js';
import type { JobCardRepository, NotePageQuery } from './repository.js';
import type { JobCard, JobCardActor } from './types.js';
import { boundedTrimmedString, requireActionId } from './validation.js';
import { appendStandaloneNoteProjection } from './note-realtime-projection.js';

export type CreateNoteInput = { clientActionId: string; note: string };

export class JobCardNotesService {
  constructor(private readonly repository: JobCardRepository) {}

  async listNotes(actor: JobCardActor, jobCardId: string, page: NotePageQuery) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    this.assertVisible(actor, job);
    return this.repository.listNotes(actor.organizationId, jobCardId, page);
  }

  async addNote(
    actor: JobCardActor,
    jobCardId: string,
    input: CreateNoteInput,
  ) {
    const clientActionId = requireActionId(input.clientActionId);
    const note = boundedTrimmedString(input.note, 'note', 1, 4_000);
    return this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId, userId: actor.id, clientActionId,
        operationKey: `JOB_NOTE_ADD:${jobCardId}`,
      },
      async (transaction) => {
        const job = await transaction.getJobForUpdate(actor.organizationId, jobCardId);
        this.assertVisible(actor, job);
        assertCanAddNote(actor, job);
        const author = await transaction.getNoteAuthorSnapshot(
          actor.organizationId,
          actor.id,
        );
        if (!author?.isActive) {
          throw new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz bulunmuyor.');
        }
        const noteId = randomUUID();
        const activity = await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'NOTE_ADDED', clientActionId, metadata: { noteId },
        });
        const created = await transaction.createNote({
          id: noteId,
          organizationId: actor.organizationId,
          jobCardId,
          authorId: actor.id,
          authorNameSnapshot: author.name,
          authorRoleSnapshot: author.role,
          workflowStage: job.status,
          context: 'GENERAL',
          relatedActivityId: activity.id,
          note,
        });
        const realtimeEvent = await appendStandaloneNoteProjection(transaction, {
          organizationId: actor.organizationId,
          jobCardId,
          actorId: actor.id,
          assigneeId: job.assignedTo,
          activity,
        });
        return { response: created, realtimeEvents: [realtimeEvent] };
      },
    );
  }

  private assertVisible(actor: JobCardActor, job: JobCard | null): asserts job is JobCard {
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    assertCanAccessNotes(actor, job);
  }
}
