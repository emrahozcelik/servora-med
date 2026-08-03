import { describe, expect, it } from 'vitest';

import type { SafeUser } from '../src/modules/auth/types.js';
import type { RealtimeEventRecord } from '../src/modules/realtime/types.js';
import type {
  StaffConfidentialNotesRepository,
  StaffConfidentialNotesTransaction,
  StaffUserSnapshot,
} from '../src/modules/staff-confidential-notes/repository.js';
import { StaffConfidentialNotesService } from '../src/modules/staff-confidential-notes/service.js';
import type {
  CreateStaffConfidentialNoteRecord,
  StaffConfidentialNoteAuditInput,
  StaffConfidentialNoteCriticalActionClaim,
  StaffConfidentialNoteCriticalActionResult,
  StaffConfidentialNotePage,
  StaffConfidentialNotePageQuery,
} from '../src/modules/staff-confidential-notes/types.js';
import { AppError } from '../src/errors/index.js';

const now = new Date('2026-08-03T10:00:00.000Z');

const user = (overrides: Partial<SafeUser> = {}): SafeUser => ({
  id: 'staff-1', organizationId: 'org-1', name: 'Ayşe', email: 'staff@example.com',
  role: 'STAFF', mustChangePassword: false, isActive: true, version: 1, ...overrides,
});

const admin = user({ id: 'admin-1', name: 'Admin', email: 'admin@example.com', role: 'ADMIN' });
const manager = user({ id: 'manager-1', name: 'Manager', email: 'manager@example.com', role: 'MANAGER' });
const staff = user();
const crossOrgAdmin = user({ id: 'admin-x', organizationId: 'org-2', role: 'ADMIN' });

const snapshot = (record: SafeUser): StaffUserSnapshot => ({
  id: record.id, organizationId: record.organizationId, role: record.role, isActive: record.isActive,
});

type MemoryNote = {
  id: string; organizationId: string; staffUserId: string; authorUserId: string;
  body: string; createdAt: Date;
};

class MemoryStaffConfidentialNotesRepository
implements StaffConfidentialNotesRepository {
  users: SafeUser[] = [admin, manager, staff];
  notes: MemoryNote[] = [];
  audits: StaffConfidentialNoteAuditInput[] = [];
  realtimeEvents: RealtimeEventRecord[] = [];
  processed: Array<{ claim: StaffConfidentialNoteCriticalActionClaim; status: 'completed' | 'processing'; response: unknown }> = [];
  published: RealtimeEventRecord[] = [];
  nextRealtimeId = 1n;
  actorLocked = false;

  private claimKey(claim: StaffConfidentialNoteCriticalActionClaim) {
    return `${claim.organizationId}|${claim.userId}|${claim.clientActionId}|${claim.operationKey}`;
  }

  async execute<T>(work: (tx: StaffConfidentialNotesTransaction) => Promise<T>) {
    return work(this.transaction());
  }

  async executeCriticalAction<T>(
    claim: StaffConfidentialNoteCriticalActionClaim,
    work: (tx: StaffConfidentialNotesTransaction) => Promise<{ response: T; realtimeEvents: readonly RealtimeEventRecord[] }>,
  ): Promise<StaffConfidentialNoteCriticalActionResult<T>> {
    const key = this.claimKey(claim);
    const existing = this.processed.find((entry) => this.claimKey(entry.claim) === key);
    if (existing) {
      if (existing.status === 'completed') {
        return { kind: 'replay', response: existing.response as T, realtimeEvents: [] };
      }
      return { kind: 'processing' };
    }
    this.processed.push({ claim, status: 'processing', response: null });
    const result = await work(this.transaction());
    const entry = this.processed.find((item) => this.claimKey(item.claim) === key)!;
    entry.status = 'completed';
    entry.response = result.response;
    return { kind: 'completed', response: result.response, realtimeEvents: result.realtimeEvents };
  }

  async findCompletedCriticalAction<T>(claim: StaffConfidentialNoteCriticalActionClaim) {
    const entry = this.processed.find((item) => this.claimKey(item.claim) === this.claimKey(claim));
    return entry?.status === 'completed' ? (entry.response as T) : null;
  }

  async findSubject(organizationId: string, userId: string) {
    const found = this.users.find((item) => item.organizationId === organizationId && item.id === userId);
    return found ? snapshot(found) : null;
  }

  async listNotes(organizationId: string, staffUserId: string, page: StaffConfidentialNotePageQuery): Promise<StaffConfidentialNotePage> {
    const rows = this.notes
      .filter((note) => note.organizationId === organizationId && note.staffUserId === staffUserId)
      .sort((a, b) => (b.createdAt.getTime() - a.createdAt.getTime()) || b.id.localeCompare(a.id));
    return {
      items: rows.slice(page.offset, page.offset + page.limit).map((note) => {
        const author = this.users.find((item) => item.id === note.authorUserId);
        return {
          id: note.id, organizationId: note.organizationId, staffUserId: note.staffUserId,
          authorUserId: note.authorUserId, authorName: author?.name ?? 'Bilinmeyen',
          body: note.body, createdAt: note.createdAt.toISOString(),
        };
      }),
      total: rows.length,
      limit: page.limit,
      offset: page.offset,
    };
  }

  private transaction(): StaffConfidentialNotesTransaction {
    return {
      lockActor: async (organizationId, userId) => {
        if (this.actorLocked) return null;
        const found = this.users.find((item) => item.organizationId === organizationId && item.id === userId);
        return found ? snapshot(found) : null;
      },
      findSubject: async (organizationId, userId) => {
        const found = this.users.find((item) => item.organizationId === organizationId && item.id === userId);
        return found ? snapshot(found) : null;
      },
      createNote: async (input: CreateStaffConfidentialNoteRecord) => {
        const note: MemoryNote = {
          ...input,
          createdAt: new Date(now.getTime() + this.notes.length),
        };
        this.notes.push(note);
        return note;
      },
      appendAudit: async (input) => { this.audits.push(input); },
      appendRealtimeEvent: async (input) => {
        const event: RealtimeEventRecord = {
          id: this.nextRealtimeId++,
          organizationId: input.organizationId,
          sourceActivityId: null,
          messagingActivityId: null,
          type: input.type,
          entityType: input.entityType,
          entityId: input.entityId,
          actorUserId: input.actorUserId,
          audience: input.audience,
          resourceKeys: input.resourceKeys,
          occurredAt: input.occurredAt,
        };
        this.realtimeEvents.push(event);
        return event;
      },
    };
  }
}

function setup() {
  const repository = new MemoryStaffConfidentialNotesRepository();
  const service = new StaffConfidentialNotesService(repository, {
    publish: (event) => repository.published.push(event),
  }, () => now);
  return { repository, service };
}

async function expectForbidden(promise: Promise<unknown>) {
  try {
    await promise;
    expect.unreachable('expected FORBIDDEN');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('FORBIDDEN');
    expect((error as AppError).statusCode).toBe(403);
  }
}

async function expectAppError(promise: Promise<unknown>, code: string, statusCode: number) {
  try {
    await promise;
    expect.unreachable(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    expect((error as AppError).statusCode).toBe(statusCode);
  }
}

describe('StaffConfidentialNotesService authorization', () => {
  it('allows ADMIN to create a note', async () => {
    const { repository, service } = setup();
    const note = await service.createNote(admin, staff.id, { clientActionId: 'action-1', body: '  Gizli değerlendirme  ' });
    expect(note.body).toBe('Gizli değerlendirme');
    expect(note.staffUserId).toBe(staff.id);
    expect(note.authorUserId).toBe(admin.id);
    expect(note.createdAt).toBe(now.toISOString());
    expect(repository.notes).toHaveLength(1);
  });

  it('allows MANAGER to create a note', async () => {
    const { service } = setup();
    const note = await service.createNote(manager, staff.id, { clientActionId: 'action-1', body: 'Yönetici notu' });
    expect(note.authorUserId).toBe(manager.id);
  });

  it('denies STAFF create with 403', async () => {
    const { repository, service } = setup();
    await expectForbidden(service.createNote(staff, staff.id, { clientActionId: 'action-1', body: 'girişim' }));
    expect(repository.notes).toHaveLength(0);
    expect(repository.audits).toHaveLength(0);
  });

  it('denies STAFF list with 403', async () => {
    const { service } = setup();
    await expectForbidden(service.listNotes(staff, staff.id, { limit: 20, offset: 0 }));
  });

  it('does not let STAFF infer existence for any subject', async () => {
    const { service } = setup();
    await expectForbidden(service.createNote(staff, 'missing-user', { clientActionId: 'a', body: 'x' }));
    await expectForbidden(service.listNotes(staff, 'missing-user', { limit: 20, offset: 0 }));
  });

  it('rejects a cross-org subject with 404 without disclosing existence', async () => {
    const { repository, service } = setup();
    repository.users.push(crossOrgAdmin);
    await expectAppError(
      service.createNote(crossOrgAdmin, staff.id, { clientActionId: 'action-1', body: 'sızma' }),
      'USER_NOT_FOUND', 404,
    );
    await expectAppError(
      service.listNotes(crossOrgAdmin, staff.id, { limit: 20, offset: 0 }),
      'USER_NOT_FOUND', 404,
    );
    expect(repository.notes).toHaveLength(0);
  });

  it('rejects a non-STAFF subject with 404', async () => {
    const { service } = setup();
    await expectAppError(
      service.createNote(admin, manager.id, { clientActionId: 'action-1', body: 'x' }),
      'STAFF_PROFILE_NOT_FOUND', 404,
    );
  });

  it('rejects an inactive actor with canonical FORBIDDEN', async () => {
    const { repository, service } = setup();
    const inactiveAdmin = { ...admin, isActive: false };
    const index = repository.users.findIndex((item) => item.id === inactiveAdmin.id);
    repository.users[index] = inactiveAdmin;
    await expectForbidden(
      service.createNote(inactiveAdmin, staff.id, { clientActionId: 'action-1', body: 'x' }),
    );
  });

  it('treats a vanished actor row as FORBIDDEN', async () => {
    const { repository, service } = setup();
    repository.actorLocked = true;
    await expectForbidden(
      service.createNote(admin, staff.id, { clientActionId: 'action-1', body: 'x' }),
    );
  });
});

describe('StaffConfidentialNotesService body validation', () => {
  it('rejects an empty or whitespace-only body', async () => {
    const { repository, service } = setup();
    await expectAppError(
      service.createNote(admin, staff.id, { clientActionId: 'action-1', body: '   ' }),
      'VALIDATION_ERROR', 400,
    );
    expect(repository.notes).toHaveLength(0);
  });

  it('rejects an oversized body', async () => {
    const { service } = setup();
    await expectAppError(
      service.createNote(admin, staff.id, { clientActionId: 'action-1', body: 'x'.repeat(4001) }),
      'VALIDATION_ERROR', 400,
    );
  });

  it('accepts a body at the 4000 codepoint boundary', async () => {
    const { service } = setup();
    const note = await service.createNote(admin, staff.id, { clientActionId: 'action-1', body: 'ç'.repeat(4000) });
    expect(note.body).toHaveLength(4000);
  });

  it('rejects an empty clientActionId', async () => {
    const { service } = setup();
    await expectAppError(
      service.createNote(admin, staff.id, { clientActionId: '', body: 'x' }),
      'VALIDATION_ERROR', 400,
    );
  });
});

describe('StaffConfidentialNotesService pagination', () => {
  it('returns a stable, total-preserving page', async () => {
    const { repository, service } = setup();
    for (let index = 0; index < 5; index += 1) {
      await service.createNote(admin, staff.id, { clientActionId: `action-${index}`, body: `not-${index}` });
    }
    const first = await service.listNotes(admin, staff.id, { limit: 2, offset: 0 });
    expect(first.total).toBe(5);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]!.body).toBe('not-4');
    const second = await service.listNotes(admin, staff.id, { limit: 2, offset: 2 });
    expect(second.items.map((item) => item.body)).toEqual(['not-2', 'not-1']);
    const last = await service.listNotes(admin, staff.id, { limit: 2, offset: 4 });
    expect(last.items.map((item) => item.body)).toEqual(['not-0']);
  });

  it('keeps per-staff isolation across pages', async () => {
    const { repository, service } = setup();
    const secondStaff = user({ id: 'staff-2', email: 's2@example.com' });
    repository.users.push(secondStaff);
    await service.createNote(admin, staff.id, { clientActionId: 'a', body: 'staff-1 note' });
    await service.createNote(admin, secondStaff.id, { clientActionId: 'b', body: 'staff-2 note' });
    const page = await service.listNotes(admin, staff.id, { limit: 20, offset: 0 });
    expect(page.total).toBe(1);
    expect(page.items[0]!.body).toBe('staff-1 note');
  });
});

describe('StaffConfidentialNotesService idempotency', () => {
  it('replays deep-equal response with one row, one audit, one realtime event', async () => {
    const { repository, service } = setup();
    const first = await service.createNote(admin, staff.id, { clientActionId: 'action-replay', body: 'ilk not' });
    const second = await service.createNote(admin, staff.id, { clientActionId: 'action-replay', body: 'ilk not' });
    expect(second).toEqual(first);
    expect(repository.notes).toHaveLength(1);
    expect(repository.audits).toHaveLength(1);
    expect(repository.realtimeEvents).toHaveLength(1);
    expect(repository.published).toHaveLength(1);
  });

  it('does not recalculate timestamps on replay', async () => {
    const { repository, service } = setup();
    const first = await service.createNote(admin, staff.id, { clientActionId: 'action-ts', body: 'zaman damgası' });
    expect(first.createdAt).toBe(now.toISOString());
    const second = await service.createNote(admin, staff.id, { clientActionId: 'action-ts', body: 'farklı gövde' });
    expect(second).toEqual(first);
    expect(repository.notes[0]!.body).toBe('zaman damgası');
  });

  it('returns the original response when replay carries a different body', async () => {
    const { service } = setup();
    const first = await service.createNote(admin, staff.id, { clientActionId: 'action-diff', body: 'özgün' });
    const second = await service.createNote(admin, staff.id, { clientActionId: 'action-diff', body: 'değişmiş' });
    expect(second.body).toBe('özgün');
    expect(second.id).toBe(first.id);
  });

  it('does not emit a second realtime invalidation on replay', async () => {
    const { repository, service } = setup();
    await service.createNote(admin, staff.id, { clientActionId: 'action-rt', body: 'x' });
    await service.createNote(admin, staff.id, { clientActionId: 'action-rt', body: 'x' });
    expect(repository.realtimeEvents).toHaveLength(1);
    expect(repository.published).toHaveLength(1);
  });

  it('scopes the idempotency key per staff member', async () => {
    const { repository, service } = setup();
    const secondStaff = user({ id: 'staff-2', email: 's2@example.com' });
    repository.users.push(secondStaff);
    const first = await service.createNote(admin, staff.id, { clientActionId: 'action-shared', body: 'staff-1' });
    const second = await service.createNote(admin, secondStaff.id, { clientActionId: 'action-shared', body: 'staff-2' });
    expect(second.id).not.toBe(first.id);
  });
});

describe('StaffConfidentialNotesService audit and realtime payload', () => {
  it('keeps the note body out of audit and realtime payloads', async () => {
    const { repository, service } = setup();
    await service.createNote(admin, staff.id, { clientActionId: 'action-audit', body: 'HİÇBİR YERE SIZMAMALI' });
    const audit = repository.audits[0]!;
    expect(audit.subjectType).toBe('STAFF_CONFIDENTIAL_NOTE');
    expect(audit.eventType).toBe('STAFF_CONFIDENTIAL_NOTE_CREATED');
    expect(audit.subjectId).toBe(repository.notes[0]!.id);
    expect(audit.metadata).toEqual({ staffUserId: staff.id });
    expect(audit.oldValue).toBeNull();
    expect(audit.newValue).toBeNull();
    expect(JSON.stringify(audit)).not.toContain('HİÇBİR YERE SIZMAMALI');

    const event = repository.realtimeEvents[0]!;
    expect(event.type).toBe('confidential-note.created');
    expect(event.entityType).toBe('confidential-note');
    expect(event.entityId).toBe(repository.notes[0]!.id);
    expect(event.audience).toEqual({ roles: ['ADMIN', 'MANAGER'], userIds: [] });
    expect(event.resourceKeys).toEqual([`staff-confidential-notes:${staff.id}`]);
    expect(JSON.stringify({ ...event, id: event.id.toString() })).not.toContain('HİÇBİR YERE SIZMAMALI');
  });
});
