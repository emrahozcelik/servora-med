import { AppError } from '../../errors/index.js';
import { assertCanAccessNotes, assertCanAddNote } from './policy.js';
import type { JobCardRepository, PageQuery } from './repository.js';
import type { JobCard, JobCardActor } from './types.js';
import { boundedTrimmedString, requireActionId } from './validation.js';

export type CreateNoteInput = { clientActionId: string; note: string };

export class JobCardNotesService {
  constructor(private readonly repository: JobCardRepository) {}

  async listNotes(actor: JobCardActor, jobCardId: string, page: PageQuery) {
    const job = await this.repository.findJobCard(actor.organizationId, jobCardId);
    this.assertVisible(actor, job);
    return this.repository.listNotes(actor.organizationId, jobCardId, page);
  }

  async addNote(actor: JobCardActor, jobCardId: string, input: CreateNoteInput) {
    const clientActionId = requireActionId(input.clientActionId);
    const note = boundedTrimmedString(input.note, 'note', 1, 4_000);
    const result = await this.repository.executeCriticalAction(
      {
        organizationId: actor.organizationId, userId: actor.id, clientActionId,
        operationKey: `JOB_NOTE_ADD:${jobCardId}`,
      },
      async (transaction) => {
        const job = await transaction.getJobForUpdate(actor.organizationId, jobCardId);
        this.assertVisible(actor, job);
        assertCanAddNote(actor, job);
        const created = await transaction.createNote({
          organizationId: actor.organizationId, jobCardId, authorId: actor.id, note,
        });
        await transaction.appendActivity({
          organizationId: actor.organizationId, jobCardId, actorId: actor.id,
          event: 'NOTE_ADDED', clientActionId, metadata: { noteId: created.id },
        });
        return created;
      },
    );
    if (result.kind === 'processing') {
      throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
    }
    return result.response;
  }

  private assertVisible(actor: JobCardActor, job: JobCard | null): asserts job is JobCard {
    if (!job || (actor.role === 'STAFF' && job.assignedTo !== actor.id)) {
      throw new AppError('JOB_CARD_NOT_FOUND', 404, 'JobCard bulunamadı.');
    }
    assertCanAccessNotes(actor, job);
  }
}
