import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { assertCanAccessNotes } from '../src/modules/job-cards/policy.js';
import type {
  ActivityInput,
  CriticalActionClaim,
  JobCardRepository,
  JobCardTransaction,
  PageQuery,
} from '../src/modules/job-cards/repository.js';
import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCard, JobCardActor, JobCardNoteDto, JobCardStatus } from '../src/modules/job-cards/types.js';

const staff: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const manager: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const admin: JobCardActor = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' };
const baseJob: JobCard = {
  id: 'job-1', organizationId: 'org-1', type: 'PRODUCT_DELIVERY', status: 'NEW', version: 7,
  title: 'Teslim', description: null, customerId: 'customer-1', contactId: null,
  assignedTo: 'staff-1', createdBy: 'staff-1', priority: 'normal', dueDate: null,
};

type CreateNoteRecord = {
  organizationId: string; jobCardId: string; authorId: string; note: string;
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
  listCalls: Array<{ organizationId: string; jobCardId: string; page: PageQuery }> = [];
  failActivity = false;

  private tx(): JobCardTransaction {
    return {
      getJobForUpdate: async (organizationId, jobCardId) => {
        const job = this.jobs.get(jobCardId);
        return job?.organizationId === organizationId ? { ...job } : null;
      },
      createNote: async (input: CreateNoteRecord) => {
        const note = {
          id: `note-${this.notes.length + 1}`, jobCardId: input.jobCardId, note: input.note,
          author: { id: input.authorId, name: input.authorId === 'staff-1' ? 'Ayşe Personel' : 'Yönetici' },
          createdAt: new Date(1_720_000_000_000 + this.notes.length).toISOString(),
        };
        this.notes.push(note);
        return note;
      },
      appendActivity: async (input) => {
        if (this.failActivity) throw new Error('activity failed');
        this.activities.push(input);
      },
    } as JobCardTransaction;
  }

  async executeCriticalAction<T>(claim: CriticalActionClaim, work: (tx: JobCardTransaction) => Promise<T>) {
    this.claims.push(claim);
    const key = `${claim.organizationId}:${claim.userId}:${claim.clientActionId}:${claim.operationKey}`;
    if (this.completed.has(key)) return { kind: 'replay' as const, response: this.completed.get(key) as T };
    if (this.processing.has(key)) return { kind: 'processing' as const };
    const noteCount = this.notes.length; const activityCount = this.activities.length;
    try {
      const response = await work(this.tx());
      this.completed.set(key, response);
      return { kind: 'completed' as const, response };
    } catch (error) {
      this.notes.splice(noteCount); this.activities.splice(activityCount);
      throw error;
    }
  }

  async findJobCard(organizationId: string, jobCardId: string) {
    const job = this.jobs.get(jobCardId);
    return job?.organizationId === organizationId ? { ...job } : null;
  }

  async listNotes(organizationId: string, jobCardId: string, page: PageQuery) {
    this.listCalls.push({ organizationId, jobCardId, page });
    const items = this.notes.filter((note) => note.jobCardId === jobCardId).reverse()
      .slice(page.offset, page.offset + page.limit);
    return {
      items, total: this.notes.filter((note) => note.jobCardId === jobCardId).length,
      limit: page.limit, offset: page.offset,
    };
  }
}

describe('JobCard note policy', () => {
  it.each([
    'NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL',
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
});

describe('append-only JobCard notes service', () => {
  it.each(['NEW', 'PLANNED', 'WAITING_APPROVAL', 'COMPLETED', 'CANCELLED'] as const)(
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

  it.each(['IN_PROGRESS', 'REVISION_REQUESTED'] as const)(
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
    'keeps %s note creation unchanged in PLANNED',
    async (type) => {
      const repository = new NotesRepository();
      repository.jobs.set('job-1', { ...baseJob, type, status: 'PLANNED' });
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

  it('adds one note and NOTE_ADDED metadata atomically without version bump or note text', async () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    const result = await service.addNote(staff, 'job-1', { clientActionId: 'add-1', note: ' Klinik arandı ' });

    expect(result).toEqual({
      id: 'note-1', jobCardId: 'job-1', note: 'Klinik arandı',
      author: { id: 'staff-1', name: 'Ayşe Personel' },
      createdAt: new Date(1_720_000_000_000).toISOString(),
    });
    expect(repository.jobs.get('job-1')!.version).toBe(7);
    expect(repository.activities).toEqual([expect.objectContaining({
      event: 'NOTE_ADDED', metadata: { noteId: 'note-1' },
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
    expect(second).toMatchObject({ id: 'note-2', jobCardId: 'job-2' });
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

  it('enforces hidden Staff visibility for read/append and pages newest-first', async () => {
    const repository = new NotesRepository(); const service = new JobCardService(repository as never);
    await service.addNote(staff, 'job-1', { clientActionId: 'n1', note: 'Bir' });
    await service.addNote(staff, 'job-1', { clientActionId: 'n2', note: 'İki' });
    await expect(service.listNotes(staff, 'job-1', { limit: 1, offset: 0 })).resolves.toMatchObject({
      items: [{ note: 'İki' }], total: 2, limit: 1, offset: 0,
    });
    expect(repository.listCalls[0]).toEqual({
      organizationId: 'org-1', jobCardId: 'job-1', page: { limit: 1, offset: 0 },
    });
    await expect(service.listNotes({ ...staff, id: 'staff-2' }, 'job-1', { limit: 25, offset: 0 }))
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

describe('Postgres JobCard note reads', () => {
  it('returns a deterministic organization-scoped canonical page with author names', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const pool = { query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('COUNT(*)')) return { rows: [{ total: 4 }] };
      return { rows: [{
        id: 'note-1', job_card_id: 'job-1', note: 'Not', author_id: 'staff-1',
        author_name: 'Ayşe Personel', created_at: new Date('2026-07-13T12:00:00Z'),
      }] };
    } };
    const result = await new PostgresJobCardRepository(pool as never)
      .listNotes('org-1', 'job-1', { limit: 2, offset: 1 });

    expect(result).toEqual({
      items: [{ id: 'note-1', jobCardId: 'job-1', note: 'Not',
        author: { id: 'staff-1', name: 'Ayşe Personel' }, createdAt: '2026-07-13T12:00:00.000Z' }],
      total: 4, limit: 2, offset: 1,
    });
    expect(calls[0]!.sql).toContain('organization_id=$1 AND job_card_id=$2');
    expect(calls[1]!.sql).toContain('JOIN users u');
    expect(calls[1]!.sql).toContain('u.organization_id = n.organization_id AND u.id = n.author_id');
    expect(calls[1]!.sql).toContain('ORDER BY n.created_at DESC, n.id DESC');
    expect(calls[1]!.sql).toContain('LIMIT $3 OFFSET $4');
    expect(calls[1]!.values).toEqual(['org-1', 'job-1', 2, 1]);
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
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'PRODUCT_DELIVERY', 'Teslim', $2, $2) RETURNING id`,
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
    } finally {
      await scopedPool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
