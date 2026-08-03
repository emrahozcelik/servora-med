import Fastify from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { staffConfidentialNotesRoutes } from '../src/modules/staff-confidential-notes/routes.js';
import { StaffConfidentialNotesService } from '../src/modules/staff-confidential-notes/service.js';
import type { StaffConfidentialNotesRepository } from '../src/modules/staff-confidential-notes/repository.js';

const apps: Awaited<ReturnType<typeof Fastify>>[] = [];

type CurrentUser = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'STAFF';
  mustChangePassword: boolean;
  isActive: boolean;
  version: number;
};

const UUID_STAFF = 'a0000000-0000-4000-8000-000000000003';
const UUID_ADMIN_X = 'a0000000-0000-4000-8000-000000000005';

const admin: CurrentUser = {
  id: 'admin-1', organizationId: 'org-1', name: 'Admin', email: 'admin@example.com',
  role: 'ADMIN', mustChangePassword: false, isActive: true, version: 1,
};
const staffUser: CurrentUser = { ...admin, id: UUID_STAFF, role: 'STAFF' };

class MemoryStaffConfidentialNotesRepository
implements StaffConfidentialNotesRepository {
  users: CurrentUser[] = [admin, staffUser];
  notes: Array<{ id: string; organizationId: string; staffUserId: string; authorUserId: string; body: string; createdAt: string }> = [];
  audits: Array<Record<string, unknown>> = [];
  realtimeEvents: Array<Record<string, unknown>> = [];
  processed: Array<Record<string, unknown>> = [];
  nextRealtimeId = 1n;
  subjectLookups = 0;
  listCalls = 0;

  async execute<T>(work: (tx: never) => Promise<T>) { return work({} as never); }

  async executeCriticalAction<T>(
    _claim: { organizationId: string; userId: string; clientActionId: string; operationKey: string },
    work: (tx: unknown) => Promise<{ response: T; realtimeEvents: readonly unknown[] }>,
  ) {
    const result = await work(this.transaction());
    return { kind: 'completed' as const, response: result.response, realtimeEvents: result.realtimeEvents };
  }

  async findCompletedCriticalAction<T>() { return null as T | null; }

  async findSubject(organizationId: string, userId: string) {
    this.subjectLookups += 1;
    const found = this.users.find((item) => item.organizationId === organizationId && item.id === userId);
    return found
      ? { id: found.id, organizationId: found.organizationId, role: found.role, isActive: found.isActive, hasProfile: true }
      : null;
  }

  async listNotes(organizationId: string, staffUserId: string, page: { limit: number; offset: number }) {
    this.listCalls += 1;
    const rows = this.notes
      .filter((note) => note.organizationId === organizationId && note.staffUserId === staffUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      items: rows.slice(page.offset, page.offset + page.limit).map((note) => {
        const author = this.users.find((item) => item.id === note.authorUserId);
        return { ...note, authorName: author?.name ?? 'Bilinmeyen' };
      }),
      total: rows.length,
      limit: page.limit,
      offset: page.offset,
    };
  }

  private transaction() {
    return {
      lockActor: async (organizationId: string, userId: string) => {
        const found = this.users.find((item) => item.organizationId === organizationId && item.id === userId);
        return found
          ? { id: found.id, organizationId: found.organizationId, role: found.role, isActive: found.isActive, hasProfile: true }
          : null;
      },
      findSubject: async (organizationId: string, userId: string) => {
        const found = this.users.find((item) => item.organizationId === organizationId && item.id === userId);
        return found
          ? { id: found.id, organizationId: found.organizationId, role: found.role, isActive: found.isActive, hasProfile: true }
          : null;
      },
      createNote: async (input: { id: string; organizationId: string; staffUserId: string; authorUserId: string; body: string }) => {
        const note = { ...input, createdAt: new Date('2026-08-03T10:00:00.000Z') };
        this.notes.push(note as never);
        return note;
      },
      appendAudit: async (input: Record<string, unknown>) => { this.audits.push(input); },
      appendRealtimeEvent: async (input: Record<string, unknown>) => {
        const event = { ...input, id: this.nextRealtimeId++ };
        this.realtimeEvents.push(event);
        return event;
      },
    };
  }
}

async function buildNotesApp(repository: MemoryStaffConfidentialNotesRepository, current: CurrentUser) {
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    request.currentUser = current as never;
  };
  const service = new StaffConfidentialNotesService(repository as never);
  const app = Fastify();
  await app.register(staffConfidentialNotesRoutes, {
    prefix: '/api',
    service,
    authenticate,
  });
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('Staff confidential notes routes', () => {
  it('creates a note with 201 for an admin', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, admin);
    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${UUID_STAFF}/confidential-notes`,
      payload: { clientActionId: 'route-action-1', body: 'gizli not' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.staffUserId).toBe(UUID_STAFF);
    expect(body.authorUserId).toBe('admin-1');
    expect(body.body).toBe('gizli not');
    expect(body.id).toBeTruthy();
  });

  it('lists notes with 200 and paginated shape', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    repository.notes.push(
      { id: 'n-1', organizationId: 'org-1', staffUserId: UUID_STAFF, authorUserId: 'admin-1', body: 'bir', createdAt: '2026-08-03T10:00:00.000Z' },
      { id: 'n-2', organizationId: 'org-1', staffUserId: UUID_STAFF, authorUserId: 'admin-1', body: 'iki', createdAt: '2026-08-03T10:00:01.000Z' },
    );
    const app = await buildNotesApp(repository, admin);
    const response = await app.inject({ method: 'GET', url: `/api/staff/${UUID_STAFF}/confidential-notes?limit=1&offset=1` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [{ id: 'n-1', organizationId: 'org-1', staffUserId: UUID_STAFF, authorUserId: 'admin-1', authorName: 'Admin', body: 'bir', createdAt: '2026-08-03T10:00:00.000Z' }],
      total: 2,
      limit: 1,
      offset: 1,
    });
  });

  it('rejects unknown create fields with 400', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, admin);
    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${UUID_STAFF}/confidential-notes`,
      payload: { clientActionId: 'a', body: 'x', extra: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a non-object body with 400', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, admin);
    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${UUID_STAFF}/confidential-notes`,
      headers: { 'content-type': 'application/json' },
      payload: 'not-an-object',
    });
    expect(response.statusCode).toBe(400);
  });

  // Malformed JSON (syntax error) is rejected by Fastify's JSON parser before any
  // handler or role logic runs, so it is explicitly outside the STAFF-403 contract.
  it('rejects malformed JSON at the Fastify parser level for any actor', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, staffUser);
    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${UUID_STAFF}/confidential-notes`,
      headers: { 'content-type': 'application/json' },
      payload: '{broken json',
    });
    expect(response.statusCode).toBe(400);
    expect(repository.subjectLookups).toBe(0);
  });

  it('rejects an empty or oversized body with 400', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, admin);
    for (const body of ['   ', 'x'.repeat(4001)]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/staff/${UUID_STAFF}/confidential-notes`,
        payload: { clientActionId: 'a', body },
      });
      expect(response.statusCode, JSON.stringify(body).slice(0, 20)).toBe(400);
    }
  });

  it('rejects unknown list query parameters with 400', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, admin);
    const response = await app.inject({ method: 'GET', url: `/api/staff/${UUID_STAFF}/confidential-notes?before=2026-01-01` });
    expect(response.statusCode).toBe(400);
  });

  it('validates limit and offset bounds', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, admin);
    for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=abc', 'offset=-2', 'offset=x']) {
      const response = await app.inject({ method: 'GET', url: `/api/staff/${UUID_STAFF}/confidential-notes?${query}` });
      expect(response.statusCode, query).toBe(400);
    }
  });

  it('denies staff actors with 403 before any subject lookup', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, staffUser);
    const create = await app.inject({
      method: 'POST',
      url: `/api/staff/${UUID_STAFF}/confidential-notes`,
      payload: { clientActionId: 'a', body: 'x' },
    });
    expect(create.statusCode).toBe(403);
    const list = await app.inject({ method: 'GET', url: `/api/staff/${UUID_STAFF}/confidential-notes` });
    expect(list.statusCode).toBe(403);
    expect(repository.notes).toHaveLength(0);
    expect(repository.subjectLookups).toBe(0);
  });

  it('denies STAFF with 403 before semantic body validation', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, staffUser);
    const payloads = [
      { clientActionId: 'a', body: '   ' },
      { clientActionId: 'a', body: 'x', extra: true },
      { clientActionId: '', body: 'x' },
      { clientActionId: 'x'.repeat(256), body: 'x' },
    ];
    for (const payload of payloads) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/staff/${UUID_STAFF}/confidential-notes`,
        payload,
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(403);
    }
    expect(repository.notes).toHaveLength(0);
    expect(repository.audits).toHaveLength(0);
    expect(repository.processed).toHaveLength(0);
    expect(repository.subjectLookups).toBe(0);
  });

  it('denies STAFF with 403 before query validation', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, staffUser);
    for (const query of ['?before=2026-01-01', '?limit=0', '?limit=101', '?offset=-2']) {
      const response = await app.inject({ method: 'GET', url: `/api/staff/${UUID_STAFF}/confidential-notes${query}` });
      expect(response.statusCode, query).toBe(403);
    }
    expect(repository.subjectLookups).toBe(0);
    expect(repository.listCalls).toBe(0);
  });

  it('returns 404 USER_NOT_FOUND for a malformed staff userId without reaching the repository', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, admin);
    const create = await app.inject({
      method: 'POST',
      url: '/api/staff/not-a-uuid/confidential-notes',
      payload: { clientActionId: 'a', body: 'x' },
    });
    expect(create.statusCode).toBe(404);
    expect(create.json().code).toBe('USER_NOT_FOUND');
    const list = await app.inject({ method: 'GET', url: '/api/staff/not-a-uuid/confidential-notes' });
    expect(list.statusCode).toBe(404);
    expect(list.json().code).toBe('USER_NOT_FOUND');
    expect(repository.subjectLookups).toBe(0);
    expect(repository.listCalls).toBe(0);
  });

  it('keeps STAFF authorization ahead of userId validation', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const app = await buildNotesApp(repository, staffUser);
    const response = await app.inject({
      method: 'POST',
      url: '/api/staff/not-a-uuid/confidential-notes',
      payload: { clientActionId: 'a', body: 'x' },
    });
    expect(response.statusCode).toBe(403);
    expect(repository.subjectLookups).toBe(0);
  });

  it('returns 404 for a subject outside the actor organization', async () => {
    const repository = new MemoryStaffConfidentialNotesRepository();
    const crossOrgAdmin: CurrentUser = { ...admin, id: UUID_ADMIN_X, organizationId: 'org-2' };
    repository.users.push(crossOrgAdmin);
    const app = await buildNotesApp(repository, crossOrgAdmin);
    const response = await app.inject({
      method: 'POST',
      url: `/api/staff/${UUID_STAFF}/confidential-notes`,
      payload: { clientActionId: 'a', body: 'x' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe('USER_NOT_FOUND');
  });
});
