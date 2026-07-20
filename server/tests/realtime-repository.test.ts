import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  PostgresRealtimeEventRepository,
  PostgresRealtimeEventTransaction,
} from '../src/modules/realtime/repository.js';

const row = {
  id: '42',
  organization_id: 'org-1',
  source_activity_id: 'activity-1',
  event_type: 'job.started',
  entity_type: 'job-card',
  entity_id: 'job-1',
  actor_user_id: 'staff-1',
  audience_roles: ['ADMIN', 'MANAGER'],
  audience_user_ids: ['staff-1'],
  resource_keys: ['job-board', 'job-detail:job-1', 'job-list'],
  created_at: new Date('2026-07-19T14:30:00.000Z'),
};

describe('Postgres realtime repository', () => {
  it('appends an event and maps bigint IDs', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const tx = new PostgresRealtimeEventTransaction({ query } as never);

    const event = await tx.append({
      organizationId: 'org-1',
      sourceActivityId: 'activity-1',
      type: 'job.started',
      entityType: 'job-card',
      entityId: 'job-1',
      actorUserId: 'staff-1',
      audience: { roles: ['ADMIN', 'MANAGER'], userIds: ['staff-1'] },
      resourceKeys: ['job-board', 'job-detail:job-1', 'job-list'],
      occurredAt: new Date('2026-07-19T14:30:00.000Z'),
    });

    expect(event.id).toBe(42n);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO realtime_events'),
      expect.arrayContaining(['activity-1', 'job.started']),
    );
  });

  it('filters replay by organization, role, or explicit user ID', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [row] });
    const repository = new PostgresRealtimeEventRepository(
      { query } as never,
    );

    await repository.replayVisible(
      { organizationId: 'org-1', userId: 'staff-1', role: 'STAFF' },
      40n,
      501,
    );

    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toContain('organization_id = $1');
    expect(sql).toContain('$2 = ANY(audience_roles)');
    expect(sql).toContain('$3 = ANY(audience_user_ids)');
    expect(sql).toContain('id > $4');
    expect(sql).toContain('ORDER BY id ASC');
    expect(values).toEqual(['org-1', 'STAFF', 'staff-1', '40', 501]);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('Postgres realtime repository (PostgreSQL)', () => {
  it('serializes event insertion order for the same organization', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `realtime_conc_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      for (const migration of [
        '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
        '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
        '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
        '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
        '011_create_realtime_events.sql',
      ]) {
        const path = fileURLToPath(
          new URL(`../src/db/migrations/${migration}`, import.meta.url),
        );
        await pool.query(await readFile(path, 'utf8'));
      }

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Realtime conc') RETURNING id`,
      )).rows[0]!.id;
      const actorId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Staff', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const jobCardId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'İş', $2, $2) RETURNING id`,
        [organizationId, actorId],
      )).rows[0]!.id;

      async function insertActivity(): Promise<string> {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO job_card_activity_logs
             (organization_id, job_card_id, actor_id, event_type)
           VALUES ($1, $2, $3, 'JOB_STARTED') RETURNING id`,
          [organizationId, jobCardId, actorId],
        )).rows[0]!.id;
      }

      const activityId1 = await insertActivity();
      const activityId2 = await insertActivity();

      const eventInput1 = {
        organizationId,
        sourceActivityId: activityId1,
        type: 'job.started' as const,
        entityType: 'job-card' as const,
        entityId: jobCardId,
        actorUserId: actorId,
        audience: { roles: ['ADMIN', 'MANAGER'] as const, userIds: [actorId] },
        resourceKeys: ['job-board'],
        occurredAt: new Date('2026-07-19T14:30:00.000Z'),
      };
      const eventInput2 = {
        ...eventInput1,
        sourceActivityId: activityId2,
      };

      const client1 = await pool.connect();
      const client2 = await pool.connect();
      try {
        const client2Pid = (await client2.query<{ pid: number }>(
          'SELECT pg_backend_pid() AS pid',
        )).rows[0]!.pid;
        await client1.query('BEGIN');
        await client2.query('BEGIN');

        const tx1 = new PostgresRealtimeEventTransaction(client1);
        const tx2 = new PostgresRealtimeEventTransaction(client2);

        const event1 = await tx1.append(eventInput1);
        let event2Settled = false;
        const event2Promise = tx2.append(eventInput2).finally(() => {
          event2Settled = true;
        });

        let lockObserved = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const activity = await adminPool.query<{
            wait_event_type: string | null;
          }>(
            'SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',
            [client2Pid],
          );
          if (activity.rows[0]?.wait_event_type === 'Lock') {
            lockObserved = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }

        expect(lockObserved).toBe(true);
        expect(event2Settled).toBe(false);

        await client1.query('COMMIT');
        const event2 = await event2Promise;
        await client2.query('COMMIT');

        expect(event1.id).toBeLessThan(event2.id);

        const allEvents = await pool.query<{ id: string }>(
          'SELECT id FROM realtime_events WHERE organization_id=$1 ORDER BY id ASC',
          [organizationId],
        );
        expect(allEvents.rows.map((value) => BigInt(value.id))).toEqual([
          event1.id,
          event2.id,
        ]);
      } finally {
        client1.release();
        client2.release();
      }
    } finally {
      if (pool) await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });

  it('rejects a duplicate source_activity_id and rolls back cleanly', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `realtime_repo_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({
        connectionString: databaseUrl,
        options: `-c search_path=${schema},public`,
      });
      for (const migration of [
        '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
        '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
        '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
        '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
        '011_create_realtime_events.sql',
      ]) {
        const path = fileURLToPath(
          new URL(`../src/db/migrations/${migration}`, import.meta.url),
        );
        await pool.query(await readFile(path, 'utf8'));
      }

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Realtime repo') RETURNING id`,
      )).rows[0]!.id;
      const actorId = (await pool.query<{ id: string }>(
        `INSERT INTO users (organization_id, name, email, password_hash, role)
         VALUES ($1, 'Staff', $2, 'unused-test-hash', 'STAFF') RETURNING id`,
        [organizationId, `${randomUUID()}@test.local`],
      )).rows[0]!.id;
      const jobCardId = (await pool.query<{ id: string }>(
        `INSERT INTO job_cards (organization_id, type, title, assigned_to, created_by)
         VALUES ($1, 'GENERAL_TASK', 'İş', $2, $2) RETURNING id`,
        [organizationId, actorId],
      )).rows[0]!.id;
      const activityId = (await pool.query<{ id: string }>(
        `INSERT INTO job_card_activity_logs
           (organization_id, job_card_id, actor_id, event_type)
         VALUES ($1, $2, $3, 'JOB_STARTED') RETURNING id`,
        [organizationId, jobCardId, actorId],
      )).rows[0]!.id;

      const sameInput = {
        organizationId,
        sourceActivityId: activityId,
        type: 'job.started' as const,
        entityType: 'job-card' as const,
        entityId: jobCardId,
        actorUserId: actorId,
        audience: {
          roles: ['ADMIN', 'MANAGER'] as const,
          userIds: [actorId],
        },
        resourceKeys: ['job-board', `job-detail:${jobCardId}`, 'job-list'],
        occurredAt: new Date('2026-07-19T14:30:00.000Z'),
      };

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx = new PostgresRealtimeEventTransaction(client);
        const first = await tx.append(sameInput);
        expect(first.sourceActivityId).toBe(activityId);
        await expect(tx.append(sameInput)).rejects.toMatchObject({ code: '23505' });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const persisted = await pool.query(
        'SELECT COUNT(*)::int AS count FROM realtime_events WHERE source_activity_id=$1',
        [activityId],
      );
      expect(persisted.rows[0]!.count).toBe(0);
    } finally {
      if (pool) await pool.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
