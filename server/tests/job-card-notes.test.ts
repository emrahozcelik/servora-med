import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { toErrorResponse } from '../src/errors/index.js';
import { assertCanAccessNotes } from '../src/modules/job-cards/policy.js';
import type {
  ActivityInput,
  CriticalActionClaim,
  JobCardRepository,
  JobCardTransaction,
  NotePageQuery,
} from '../src/modules/job-cards/repository.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor, JobCardNoteDto, JobCardStatus } from '../src/modules/job-cards/types.js';

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const admin: JobCardActor = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' };
const baseJob: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'ACCEPTED', version: 7,
  title: 'Teslim', description: null, customerId: 'customer-1', contactId: null,
  assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
};

type CreateNoteRecord = {
  id: string; organizationId: string; jobCardId: string; authorId: string;
  authorNameSnapshot: string; authorRoleSnapshot: JobCardActor['role'];
  workflowStage: JobCardStatus; context: 'GENERAL'; relatedActivityId: string;
  note: string;
  invoiceNumber: string | null;
};

class NotesRepository {
  jobs = new Map([
    ['job-1', { ...baseJob }],
    ['job-2', { ...baseJob, id: 'job-2', title: 'İkinci teslim' }],
  ]);
  notes: JobCardNoteDto[] = [];
  activities: ActivityInput[] = [];
  completed = new Map<string, unknown>();
  processing = new Set<string>();
  claims: CriticalActionClaim[] = [];
  listCalls: Array<{ organizationId: string; jobCardId: string; page: NotePageQuery }> = [];
  realtimeEvents: unknown[] = [];
  failActivity = false;

  private tx(): JobCardTransaction {
    return {
      getJobForUpdate: async (organizationId, jobCardId) => {
        const job = this.jobs.get(jobCardId);
        return job?.organizationId === organizationId ? { ...job } : null;
      },
      getNoteAuthorSnapshot: async (organizationId, authorId) => (
        organizationId === 'org-1' && authorId === 'staff-1'
          ? { id: authorId, name: 'Ayşe Personel', role: 'STAFF', isActive: true }
          : null
      ),
      createNote: async (input: CreateNoteRecord) => {
        const note = {
          id: input.id, jobCardId: input.jobCardId, note: input.note,
          invoiceNumber: input.invoiceNumber,
          author: {
            id: input.authorId,
            name: input.authorNameSnapshot,
            role: input.authorRoleSnapshot,
            source: 'SNAPSHOT' as const,
          },
          workflowStage: input.workflowStage,
          context: input.context,
          relatedActivityId: input.relatedActivityId,
          recordVersion: 1 as const,
          createdAt: new Date(1_720_000_000_000 + this.notes.length).toISOString(),
        };
        this.notes.push(note);
        return note;
      },
      appendActivity: async (input) => {
        if (this.failActivity) throw new Error('activity failed');
        this.activities.push(input);
        return { id: `activity-${this.activities.length}`, createdAt: new Date('2026-07-19T14:30:00.000Z') };
      },
      appendRealtimeEvent: async (input) => {
        this.realtimeEvents.push(input);
        return {
        id: BigInt(this.notes.length + 1),
        organizationId: input.organizationId,
        sourceActivityId: input.sourceActivityId ?? null,
        messagingActivityId: null,
        type: input.type,
        entityType: input.entityType,
        entityId: input.entityId,
        actorUserId: input.actorUserId,
        audience: input.audience,
        resourceKeys: input.resourceKeys,
        occurredAt: input.occurredAt,
        };
      },
      listActiveManagementRecipients: async () => [],
      appendNotifications: async () => [],
      appendWebPushDeliveries: async () => [],
      getAssignee: async (organizationId: string, userId: string) => (
        organizationId === 'org-1' && userId === 'staff-1'
          ? { id: userId, organizationId, role: 'STAFF' as const, isActive: true }
          : null
      ),
    } as JobCardTransaction;
  }

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    this.claims.push(claim);
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T, realtimeEvents: [] as const };
    if (this.processing.has(key)) return { kind: 'processing' as const };
    const noteCount = this.notes.length; const activityCount = this.activities.length;
    try {
      const completed = await work(this.tx());
      this.completed.set(key, completed.response);
      return { kind: 'completed' as const, response: completed.response, realtimeEvents: completed.realtimeEvents };
    } catch (error) {
      this.notes.splice(noteCount); this.activities.splice(activityCount);
      throw error;
    }
  }

  async findJobCard(organizationId: string, jobCardId: string) {
    const job = this.jobs.get(jobCardId);
    return job?.organizationId === organizationId ? { ...job } : null;
  }

  async listNotes(organizationId: string, jobCardId: string, page: NotePageQuery) {
    this.listCalls.push({ organizationId, jobCardId, page });
    const candidates = this.notes.filter((note) => note.jobCardId === jobCardId)
      .filter((note) => !page.before
        || note.createdAt < page.before.createdAt
        || (note.createdAt === page.before.createdAt && note.id < page.before.id))
      .toReversed();
    const hasMore = candidates.length > page.limit;
    const selected = candidates.slice(0, page.limit);
    const oldest = selected.at(-1);
    return {
      items: selected.toReversed(),
      limit: page.limit,
      nextCursor: hasMore && oldest
        ? { createdAt: oldest.createdAt, id: oldest.id }
        : null,
    };
  }
}

describe('JobCard note policy', () => {
  it.each([
    'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL',
    'REVISION_REQUESTED', 'COMPLETED', 'CANCELLED',
  ] as const)('allows notes in %s for own Staff and same-organization Manager/Admin', (status) => {
    const job = { ...baseJob, status };
    expect(() => assertCanAccessNotes(staff, job)).not.toThrow();
    expect(() => assertCanAccessNotes(manager, job)).not.toThrow();
    expect(() => assertCanAccessNotes(admin, job)).not.toThrow();
  });

  it('rejects another Staff assignment and cross-organization actors', () => {
    expect(() => assertCanAccessNotes({ ...staff, id: 'staff-2' }, baseJob))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
    expect(() => assertCanAccessNotes({ ...manager, organizationId: 'org-2' }, baseJob))
      .toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it.each(['NEW', 'ACCEPTED', 'WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'] as const)(
    'allows Sales Meeting note access in assignment/review/terminal %s',
    (status) => {
      const job = { ...baseJob, type: 'SALES_MEETING' as const, status };
      expect(() => assertCanAccessNotes(staff, job)).not.toThrow();
      expect(() => assertCanAccessNotes(manager, job)).not.toThrow();
    },
  );
});

describe('append-only JobCard notes service', () => {
  it.each(['NEW', 'ACCEPTED', 'WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'] as const)(
    'allows Sales Meeting note reads in assignment/review/terminal %s',
    async (status) => {
      const repository = new NotesRepository();
      repository.jobs.set('job-1', { ...baseJob, type: 'SALES_MEETING', status });
      await expect(new JobCardService(repository as never).listNotes(staff, 'job-1', {
        limit: 25, before: null,
      })).resolves.toMatchObject({ items: [], limit: 25, nextCursor: null });
    },
  );

  it.each(['WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'] as const)(
    'rejects Sales Meeting note creation in %s with the exact edit contract',
    async (status) => {
      const repository = new NotesRepository();
      repository.jobs.set('job-1', { ...baseJob, type: 'SALES_MEETING', status });
      await expect(new JobCardService(repository as never).addNote(staff, 'job-1', {
        clientActionId: `meeting-note-${status}`, note: 'Not',
      })).rejects.toMatchObject({
        code: 'JOB_NOT_EDITABLE', statusCode: 409,
        message: 'JobCard bu durumda düzenlenemez.',
      });
      expect(repository.notes).toHaveLength(0);
      expect(repository.activities).toHaveLength(0);
    },
  );

  it.each(['ACCEPTED', 'IN_PROGRESS', 'REVISION_REQUESTED'] as const)(
    'allows Sales Meeting note creation in %s',
    async (status) => {
      const repository = new NotesRepository();
      repository.jobs.set('job-1', { ...baseJob, type: 'SALES_MEETING', status });
      await expect(new JobCardService(repository as never).addNote(staff, 'job-1', {
        clientActionId: `meeting-note-${status}`, note: 'Görüşme notu',
      })).resolves.toMatchObject({ note: 'Görüşme notu' });
    },
  );

  it.each(['PRODUCT_DELIVERY', 'GENERAL_TASK'] as const)(
    'keeps %s note creation unchanged in ACCEPTED',
    async (type) => {
      const repository = new NotesRepository();
      repository.jobs.set('job-1', { ...baseJob, type, status: 'ACCEPTED' });
      await expect(new JobCardService(repository as never).addNote(staff, 'job-1', {
        clientActionId: `other-note-${type}`, note: 'Operasyon notu',
      })).resolves.toMatchObject({ note: 'Operasyon notu' });
    },
  );

  it.each([1, 4_000])('accepts and trims a %i-code-point note', async (length) => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', {
      clientActionId: `note-${length}`, note: ` ${'😀'.repeat(length)} `,
    });
    expect(result.note).toBe('😀'.repeat(length));
    expect(repository.jobs.get('job-1')!.version).toBe(7);
  });

  it('uses the central JS-trim/code-point policy and validates before claiming', async () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    await expect(service.addNote(staff, 'job-1', { clientActionId: 'too-long', note: '😀'.repeat(4_001) }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.addNote(staff, 'job-1', { clientActionId: 'blank', note: '\u00A0\u2028' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.addNote(staff, 'job-1', { clientActionId: 'zero-width', note: '\u200B' }))
      .resolves.toMatchObject({ note: '\u200B' });
    await expect(service.addNote(staff, 'job-1', { clientActionId: '😀'.repeat(256), note: 'Not' }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.claims).toHaveLength(1);
  });

  it('adds one version 1 note with frozen author, stage, context, and activity relation', async () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', { clientActionId: 'add-1', note: ' Klinik arandı ' });

    expect(result).toEqual({
      id: expect.any(String), jobCardId: 'job-1', note: 'Klinik arandı',
      invoiceNumber: null,
      author: { id: 'staff-1', name: 'Ayşe Personel', role: 'STAFF', source: 'SNAPSHOT' },
      workflowStage: 'ACCEPTED', context: 'GENERAL',
      relatedActivityId: 'activity-1', recordVersion: 1,
      createdAt: new Date(1_720_000_000_000).toISOString(),
    });
    expect(repository.jobs.get('job-1')!.version).toBe(7);
    expect(repository.activities).toEqual([expect.objectContaining({
      event: 'NOTE_ADDED', metadata: { noteId: result.id },
    })]);
    expect(JSON.stringify(repository.activities)).not.toContain('Klinik arandı');
    expect(repository.claims[0]!.operationKey).toBe('JOB_NOTE_ADD:job-1');
  });

  it('replays the same action without a second note/activity and isolates the same action by JobCard', async () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    const input = { clientActionId: 'shared-action', note: 'Not' };
    const first = await service.addNote(staff, 'job-1', input);
    await expect(service.addNote(staff, 'job-1', input)).resolves.toEqual(first);
    const second = await service.addNote(staff, 'job-2', input);
    expect(second).toMatchObject({ id: expect.any(String), jobCardId: 'job-2' });
    await expect(service.addNote(staff, 'job-2', input)).resolves.toEqual(second);
    expect(repository.notes).toHaveLength(2); expect(repository.activities).toHaveLength(2);
  });

  it('returns ACTION_IN_PROGRESS and lets different actions execute independently', async () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    repository.processing.add('org-1:staff-1:busy:JOB_NOTE_ADD:job-1');
    await expect(service.addNote(staff, 'job-1', { clientActionId: 'busy', note: 'Not' }))
      .rejects.toMatchObject({ code: 'ACTION_IN_PROGRESS', statusCode: 409 });

    await Promise.all([
      service.addNote(staff, 'job-1', { clientActionId: 'different-1', note: 'Bir' }),
      service.addNote(staff, 'job-1', { clientActionId: 'different-2', note: 'İki' }),
    ]);
    expect(repository.notes).toHaveLength(2); expect(repository.activities).toHaveLength(2);
  });

  it('rolls back the note and action side effects when activity append fails', async () => {
    const repository = new NotesRepository(); repository.failActivity = true;
    const service = new JobCardService(repository as never);
    await expect(service.addNote(staff, 'job-1', { clientActionId: 'rollback', note: 'Not' }))
      .rejects.toThrow('activity failed');
    expect(repository.notes).toHaveLength(0); expect(repository.activities).toHaveLength(0);
    expect(repository.completed.size).toBe(0);
  });

  it('enforces hidden Staff visibility for read/append and returns the latest page ascending', async () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    await service.addNote(staff, 'job-1', { clientActionId: 'n1', note: 'Bir' });
    await service.addNote(staff, 'job-1', { clientActionId: 'n2', note: 'İki' });
    await expect(service.listNotes(staff, 'job-1', { limit: 1, before: null })).resolves.toMatchObject({
      items: [{ note: 'İki' }], limit: 1,
      nextCursor: { createdAt: expect.any(String), id: expect.any(String) },
    });
    expect(repository.listCalls[0]).toEqual({
      organizationId: 'org-1', jobCardId: 'job-1', page: { limit: 1, before: null },
    });
    await expect(service.listNotes({ ...staff, id: 'staff-2' }, 'job-1', {
      limit: 25, before: null,
    }))
      .rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
    await expect(service.addNote({ ...staff, id: 'staff-2' }, 'job-1', {
      clientActionId: 'hidden', note: 'Not',
    })).rejects.toMatchObject({ code: 'JOB_CARD_NOT_FOUND', statusCode: 404 });
  });

  it('exposes no note update/delete surface', () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    expect('updateNote' in service).toBe(false); expect('deleteNote' in service).toBe(false);
    expect('updateNote' in repository).toBe(false); expect('deleteNote' in repository).toBe(false);
  });
});

describe('optional invoice number on job notes', () => {
  const invoiceJob = (type: JobCard['type']) => ({ ...baseJob, type });

  it('accepts and trims an invoice number for SALES_MEETING', async () => {
    const repository = new NotesRepository();
    repository.jobs.set('job-1', invoiceJob('SALES_MEETING'));
    const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', {
      clientActionId: 'inv-1', note: 'Görüşme notu', invoiceNumber: ' FT-2026-00124 ',
    });
    expect(result.invoiceNumber).toBe('FT-2026-00124');
    expect(repository.notes[0]!.invoiceNumber).toBe('FT-2026-00124');
  });

  it('accepts and persists an invoice number for PRODUCT_DELIVERY', async () => {
    const repository = new NotesRepository();
    const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', {
      clientActionId: 'inv-2', note: 'Teslim notu', invoiceNumber: 'INV/2026/889',
    });
    expect(result.invoiceNumber).toBe('INV/2026/889');
    expect(repository.notes[0]!.invoiceNumber).toBe('INV/2026/889');
  });

  it('stores null when a supported job omits the invoice number', async () => {
    const repository = new NotesRepository();
    repository.jobs.set('job-1', invoiceJob('SALES_MEETING'));
    const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', {
      clientActionId: 'inv-3', note: 'Not',
    });
    expect(result.invoiceNumber).toBeNull();
    expect(repository.notes[0]!.invoiceNumber).toBeNull();
  });

  it('normalizes a whitespace-only invoice number to null', async () => {
    const repository = new NotesRepository();
    const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', {
      clientActionId: 'inv-4', note: 'Not', invoiceNumber: '  \u00A0\u2028 ',
    });
    expect(result.invoiceNumber).toBeNull();
  });

  it('keeps GENERAL_TASK creation without an invoice number unchanged', async () => {
    const repository = new NotesRepository();
    repository.jobs.set('job-1', invoiceJob('GENERAL_TASK'));
    const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', {
      clientActionId: 'inv-5', note: 'Genel not',
    });
    expect(result).toMatchObject({ note: 'Genel not', invoiceNumber: null });
  });

  it('rejects a non-empty invoice number for GENERAL_TASK without any side effects', async () => {
    const repository = new NotesRepository();
    repository.jobs.set('job-1', invoiceJob('GENERAL_TASK'));
    const service = new JobCardService(repository as never);
    await expect(service.addNote(staff, 'job-1', {
      clientActionId: 'inv-6', note: 'Genel not', invoiceNumber: 'FT-1',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
    expect(repository.notes).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
    expect(repository.completed.size).toBe(0);
  });

  it('rejects an invoice number over 100 characters without mutation', async () => {
    const repository = new NotesRepository();
    const service = new JobCardService(repository as never);
    await expect(service.addNote(staff, 'job-1', {
      clientActionId: 'inv-7', note: 'Not', invoiceNumber: 'a'.repeat(101),
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(repository.notes).toHaveLength(0);
    expect(repository.activities).toHaveLength(0);
  });

  it('preserves punctuation and casing exactly after trimming', async () => {
    const repository = new NotesRepository();
    const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', {
      clientActionId: 'inv-8', note: 'Not', invoiceNumber: ' 2026-08-00017 ',
    });
    expect(result.invoiceNumber).toBe('2026-08-00017');
  });

  it('does not expose an invoice value on legacy record-version 0 notes', async () => {
    const repository = new NotesRepository();
    const service = new JobCardService(repository as never);
    const first = await service.addNote(staff, 'job-1', {
      clientActionId: 'legacy-note', note: 'Eski not',
    });
    const legacy: JobCardNoteDto = {
      ...first, recordVersion: 0,
      author: { id: 'staff-1', name: 'Ayşe Personel', role: null, source: 'LEGACY_CURRENT' },
      workflowStage: null, context: null, relatedActivityId: null,
    };
    expect(legacy.invoiceNumber).toBeNull();
  });

  it('preserves invoice metadata on an identical action replay', async () => {
    const repository = new NotesRepository();
    const service = new JobCardService(repository as never);
    const input = {
      clientActionId: 'replay-inv', note: 'Not', invoiceNumber: 'FT-2026-00124',
    };
    const first = await service.addNote(staff, 'job-1', input);
    await expect(service.addNote(staff, 'job-1', input)).resolves.toEqual(first);
    expect(repository.notes).toHaveLength(1);
    expect(repository.notes[0]!.invoiceNumber).toBe('FT-2026-00124');
  });

  it('keeps the note body, realtime payload and audit metadata free of the raw invoice number', async () => {
    const repository = new NotesRepository();
    const service = new JobCardService(repository as never);
    await service.addNote(staff, 'job-1', {
      clientActionId: 'inv-privacy', note: 'Teslim', invoiceNumber: 'FT-SECRET-2026',
    });
    expect(JSON.stringify(repository.activities)).not.toContain('FT-SECRET-2026');
    expect(repository.realtimeEvents).toHaveLength(1);
    expect(JSON.stringify(repository.realtimeEvents)).not.toContain('FT-SECRET-2026');
  });
});

describe('Postgres JobCard note reads', () => {
  it('returns the latest page ascending with a stable compound older cursor', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = { query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [
        {
          id: '00000000-0000-4000-8000-000000000003',
          job_card_id: 'job-1',
          note: 'En yeni',
          author_id: 'staff-1',
          author_name: 'Ayşe Personel',
          author_name_snapshot: 'Ayşe Personel',
          author_role_snapshot: 'STAFF',
          workflow_stage: 'IN_PROGRESS',
          context: 'GENERAL',
          related_activity_id: 'activity-3',
          record_version: 1,
          created_at: new Date('2026-07-13T12:02:00Z'),
          cursor_created_at: '2026-07-13T12:02:00.123900Z',
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          job_card_id: 'job-1',
          note: 'Orta',
          author_id: 'staff-1',
          author_name: 'Ayşe Personel',
          author_name_snapshot: 'Ayşe Personel',
          author_role_snapshot: 'STAFF',
          workflow_stage: 'IN_PROGRESS',
          context: 'GENERAL',
          related_activity_id: 'activity-2',
          record_version: 1,
          created_at: new Date('2026-07-13T12:01:00.123Z'),
          cursor_created_at: '2026-07-13T12:01:00.123900Z',
        },
        {
          id: '00000000-0000-4000-8000-000000000001',
          job_card_id: 'job-1',
          note: 'Daha eski cursor satırı',
          author_id: 'staff-1',
          author_name: 'Ayşe Personel',
          author_name_snapshot: null,
          author_role_snapshot: null,
          workflow_stage: null,
          context: null,
          related_activity_id: null,
          record_version: 0,
          created_at: new Date('2026-07-13T12:00:00Z'),
          cursor_created_at: '2026-07-13T12:00:00.123100Z',
        },
      ] };
    } };
    const result = await new PostgresJobCardRepository(pool as never)
      .listNotes('org-1', 'job-1', { limit: 2, before: null } as never);

    expect(result.items.map((note) => note.note)).toEqual(['Orta', 'En yeni']);
    expect(result.nextCursor).toEqual({
      createdAt: '2026-07-13T12:01:00.123900Z',
      id: '00000000-0000-4000-8000-000000000002',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('u.organization_id = n.organization_id AND u.id = n.author_id');
    expect(calls[0]!.sql).toContain('ORDER BY n.created_at DESC, n.id DESC');
    expect(calls[0]!.sql).toContain('AS cursor_created_at');
    expect(calls[0]!.sql).not.toContain('OFFSET');
    expect(calls[0]!.values).toEqual(['org-1', 'job-1', 3]);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('Postgres JobCard note atomicity', () => {
  it('rolls back note/activity/action together and replays one completed append', async () => {
    const adminPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const schema = `job_card_notes_${randomUUID().replaceAll('-', '')}`;
    let scopedPool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      scopedPool = new Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema},public`,
      });
      for (const migration of [
        '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
        '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
        '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
        '009_job_acceptance_and_scheduling.sql',
        '010_entity_delete_audit.sql',
        '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
        '013_create_job_action_locations.sql', '014_create_web_push.sql',
        '015_job_card_engagement_kind.sql',
        '016_google_reverse_geocoding.sql',
        '017_calendar.sql',
        '018_messaging.sql',
        '019_job_card_operational_note_context.sql',
        '020_job_card_transition_note_contexts.sql',
        '021_job_card_note_added_notification_kind.sql',
        '022_job_card_follow_up_links.sql',
        '023_staff_confidential_notes.sql',
        '024_job_card_notes_invoice_number.sql',
      ]) {
        const path = fileURLToPath(new URL(`../src/db/migrations/${migration}`, import.meta.url));
        await scopedPool.query(await readFile(path, 'utf8'));
      }
      const organization = await scopedPool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Notes test') RETURNING id`,
      );
      const organizationId = organization.rows[0]!.id;
      const user = await scopedPool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Ayşe Personel', $2, 'test-hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      );
      const userId = user.rows[0]!.id;
      const job = await scopedPool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           accepted_at, accepted_by
         )
         VALUES ($1, 'PRODUCT_DELIVERY', 'ACCEPTED', 'Teslim', $2, $2, NOW(), $2)
         RETURNING id`,
        [organizationId, userId],
      );
      const jobCardId = job.rows[0]!.id;
      const databasePool = scopedPool;
      const failingPool = {
        connect: async () => {
          const client = await databasePool.connect();
          return {
            query: async (sql: string, values?: unknown[]) => {
              if (sql.includes('INSERT INTO job_card_activity_logs')) throw new Error('activity failed');
              return client.query(sql, values);
            },
            release: () => client.release(),
          };
        },
      };
      const actor = { id: userId, organizationId, role: 'STAFF' as const };
      const failedService = new JobCardService(new PostgresJobCardRepository(failingPool as never));
      await expect(failedService.addNote(actor, jobCardId, {
        clientActionId: 'rollback', note: 'Geri alınmalı',
      })).rejects.toThrow('activity failed');
      await expect(databasePool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_notes) AS notes,
           (SELECT COUNT(*)::int FROM job_card_activity_logs) AS activities,
           (SELECT COUNT(*)::int FROM processed_actions) AS actions`,
      )).resolves.toMatchObject({ rows: [{ notes: 0, activities: 0, actions: 0 }] });

      const noteFailingPool = {
        connect: async () => {
          const client = await databasePool.connect();
          return {
            query: async (sql: string, values?: unknown[]) => {
              if (sql.includes('INSERT INTO job_card_notes')) throw new Error('note failed');
              return client.query(sql, values);
            },
            release: () => client.release(),
          };
        },
      };
      const noteFailingService = new JobCardService(
        new PostgresJobCardRepository(noteFailingPool as never),
      );
      await expect(noteFailingService.addNote(actor, jobCardId, {
        clientActionId: 'note-rollback', note: 'Activity geri alınmalı',
      })).rejects.toThrow('note failed');
      await expect(databasePool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_notes) AS notes,
           (SELECT COUNT(*)::int FROM job_card_activity_logs) AS activities,
           (SELECT COUNT(*)::int FROM processed_actions) AS actions`,
      )).resolves.toMatchObject({ rows: [{ notes: 0, activities: 0, actions: 0 }] });

      const service = new JobCardService(new PostgresJobCardRepository(databasePool));
      const input = { clientActionId: 'replay', note: 'Tek kez kaydedilir' };
      const first = await service.addNote(actor, jobCardId, input);
      await expect(service.addNote(actor, jobCardId, input)).resolves.toEqual(first);
      const persisted = await databasePool.query<{
        notes: number; activities: number; actions: number; version: number; metadata: unknown;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_notes) AS notes,
           (SELECT COUNT(*)::int FROM job_card_activity_logs WHERE event_type='NOTE_ADDED') AS activities,
           (SELECT COUNT(*)::int FROM processed_actions WHERE status='completed') AS actions,
           (SELECT version FROM job_cards WHERE id=$1) AS version,
           (SELECT metadata FROM job_card_activity_logs WHERE event_type='NOTE_ADDED') AS metadata`,
        [jobCardId],
      );
      expect(persisted.rows[0]).toEqual({
        notes: 1, activities: 1, actions: 1, version: 1, metadata: { noteId: first.id },
      });
      expect(JSON.stringify(persisted.rows[0]!.metadata)).not.toContain(input.note);

      const sameTimestamp = '2025-01-01T12:00:00.000Z';
      const seededIds = [
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
      ];
      for (const [index, noteId] of seededIds.entries()) {
        const activity = await databasePool.query<{ id: string }>(
          `INSERT INTO job_card_activity_logs (
             organization_id, job_card_id, actor_id, event_type, metadata, created_at
           ) VALUES ($1, $2, $3, 'NOTE_ADDED', $4, $5) RETURNING id`,
          [organizationId, jobCardId, userId, { noteId }, sameTimestamp],
        );
        await databasePool.query(
          `INSERT INTO job_card_notes (
             id, organization_id, job_card_id, author_id, note,
             author_name_snapshot, author_role_snapshot, workflow_stage,
             context, related_activity_id, record_version, created_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             'Ayşe Personel', 'STAFF', 'ACCEPTED',
             'GENERAL', $6, 1, $7
           )`,
          [
            noteId,
            organizationId,
            jobCardId,
            userId,
            `Seed ${index + 1}`,
            activity.rows[0]!.id,
            sameTimestamp,
          ],
        );
      }

      const repository = new PostgresJobCardRepository(databasePool);
      const initialPage = await repository.listNotes(
        organizationId,
        jobCardId,
        { limit: 2, before: null },
      );
      expect(initialPage.items.map((note) => note.id)).toEqual([
        seededIds[2],
        first.id,
      ]);
      expect(initialPage.nextCursor).toEqual({
        createdAt: '2025-01-01T12:00:00.000000Z',
        id: seededIds[2],
      });

      await service.addNote(actor, jobCardId, {
        clientActionId: 'concurrent-new', note: 'Concurrent live-tail note',
      });
      const olderPage = await repository.listNotes(
        organizationId,
        jobCardId,
        { limit: 2, before: initialPage.nextCursor },
      );
      expect(olderPage.items.map((note) => note.id)).toEqual(seededIds.slice(0, 2));
      expect(new Set([
        ...initialPage.items.map((note) => note.id),
        ...olderPage.items.map((note) => note.id),
      ]).size).toBe(4);

      const cursorJob = await databasePool.query<{ id: string }>(
        `INSERT INTO job_cards (
           organization_id, type, status, title, assigned_to, created_by,
           accepted_at, accepted_by
         )
         VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'Cursor integrity', $2, $2, NOW(), $2)
         RETURNING id`,
        [organizationId, userId],
      );
      const cursorJobCardId = cursorJob.rows[0]!.id;
      const cursorIds = [
        '00000000-0000-4000-8000-000000000101',
        '00000000-0000-4000-8000-000000000102',
        '00000000-0000-4000-8000-000000000103',
      ];
      const cursorTimestamps = [
        '2026-07-29T12:00:00.123100Z',
        '2026-07-29T12:00:00.123500Z',
        '2026-07-29T12:00:00.123900Z',
      ];
      const insertVersionOneNote = async (
        noteId: string,
        note: string,
        createdAt: string,
      ) => {
        const activity = await databasePool.query<{ id: string }>(
          `INSERT INTO job_card_activity_logs (
             organization_id, job_card_id, actor_id, event_type, metadata, created_at
           ) VALUES ($1, $2, $3, 'NOTE_ADDED', $4, $5) RETURNING id`,
          [organizationId, cursorJobCardId, userId, { noteId }, createdAt],
        );
        await databasePool.query(
          `INSERT INTO job_card_notes (
             id, organization_id, job_card_id, author_id, note,
             author_name_snapshot, author_role_snapshot, workflow_stage,
             context, related_activity_id, record_version, created_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             'Ayşe Personel', 'STAFF', 'ACCEPTED',
             'GENERAL', $6, 1, $7
           )`,
          [
            noteId,
            organizationId,
            cursorJobCardId,
            userId,
            note,
            activity.rows[0]!.id,
            createdAt,
          ],
        );
      };
      for (const [index, noteId] of cursorIds.entries()) {
        await insertVersionOneNote(noteId, `Microsecond ${index + 1}`, cursorTimestamps[index]!);
      }

      const cursorService = new JobCardService(
        new PostgresJobCardRepository(databasePool),
      );
      const app = Fastify({ logger: false });
      let authenticatedUserId = userId;
      app.setErrorHandler((error, _request, reply) => {
        const response = toErrorResponse(error);
        reply.code(response.statusCode).send(response.body);
      });
      const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
        request.currentUser = {
          id: authenticatedUserId,
          organizationId,
          role: 'STAFF',
          name: 'Ayşe Personel',
          email: 'ayse@test.local',
          mustChangePassword: false,
        };
      };
      await app.register(jobCardRoutes, {
        prefix: '/api/job-cards',
        service: cursorService,
        authenticate,
      });
      try {
        const chronological = await app.inject({
          method: 'GET',
          url: `/api/job-cards/${cursorJobCardId}/notes?limit=3`,
        });
        expect(chronological.statusCode).toBe(200);
        expect(chronological.json().items.map((note: { id: string }) => note.id))
          .toEqual(cursorIds);

        const firstCursorPage = await app.inject({
          method: 'GET',
          url: `/api/job-cards/${cursorJobCardId}/notes?limit=1`,
        });
        expect(firstCursorPage.statusCode).toBe(200);
        const firstCursorBody = firstCursorPage.json();
        expect(firstCursorBody.items.map((note: { id: string }) => note.id))
          .toEqual([cursorIds[2]]);
        expect(firstCursorBody.nextCursor).toEqual({
          createdAt: cursorTimestamps[2],
          id: cursorIds[2],
        });
        expect(firstCursorBody.nextCursor.createdAt)
          .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

        await insertVersionOneNote(
          '00000000-0000-4000-8000-000000000104',
          'Concurrent newer',
          '2026-07-29T12:00:01.000100Z',
        );

        const traversedIds = [firstCursorBody.items[0].id];
        let cursor = firstCursorBody.nextCursor;
        while (cursor) {
          const pageResponse = await app.inject({
            method: 'GET',
            url: `/api/job-cards/${cursorJobCardId}/notes?limit=1`
              + `&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}`
              + `&beforeId=${cursor.id}`,
          });
          expect(pageResponse.statusCode).toBe(200);
          const body = pageResponse.json();
          traversedIds.push(...body.items.map((note: { id: string }) => note.id));
          cursor = body.nextCursor;
        }
        expect(traversedIds).toEqual(cursorIds.toReversed());
        expect(new Set(traversedIds).size).toBe(cursorIds.length);

        const unassignedStaff = await databasePool.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, 'Atanmamış Personel', $2, 'test-hash', 'STAFF') RETURNING id`,
          [organizationId, `${randomUUID()}@test.local`],
        );
        authenticatedUserId = unassignedStaff.rows[0]!.id;
        const unauthorized = await app.inject({
          method: 'GET',
          url: `/api/job-cards/${cursorJobCardId}/notes`,
        });
        expect(unauthorized.statusCode).toBe(404);
        expect(unauthorized.json()).toMatchObject({ code: 'JOB_CARD_NOT_FOUND' });
      } finally {
        await app.close();
      }
    } finally {
      await scopedPool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
