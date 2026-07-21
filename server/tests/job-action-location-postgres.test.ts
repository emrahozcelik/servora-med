import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrations = [
  '001_auth_foundation.sql',
  '002_delivery_tracer.sql',
  '003_people.sql',
  '004_crm_contacts.sql',
  '005_product_catalog.sql',
  '006_jobcard_workspace.sql',
  '007_sales_meeting.sql',
  '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql',
  '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql',
  '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql',
] as const;

async function applyMigrations(pool: Pool) {
  for (const migration of migrations) {
    const path = fileURLToPath(
      new URL(`../src/db/migrations/${migration}`, import.meta.url),
    );
    await pool.query(await readFile(path, 'utf8'));
  }
}

async function withMigratedDatabase(run: (pool: Pool) => Promise<void>) {
  const adminPool = new Pool({ connectionString: databaseUrl });
  const schema = `job_action_locations_${randomUUID().replaceAll('-', '')}`;
  let pool: Pool | null = null;

  try {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
    });
    await applyMigrations(pool);
    await run(pool);
  } finally {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  }
}

async function createOrganization(pool: Pool, name = 'Location test') {
  return (await pool.query<{ id: string }>(
    `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
    [name],
  )).rows[0]!.id;
}

async function createUser(pool: Pool, organizationId: string, role = 'STAFF') {
  return (await pool.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role)
     VALUES ($1, 'Field Staff', $2, 'unused-test-hash', $3)
     RETURNING id`,
    [organizationId, `${randomUUID()}@test.local`, role],
  )).rows[0]!.id;
}

async function createStartedJob(
  pool: Pool,
  organizationId: string,
  actorUserId: string,
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        started_at)
     VALUES ($1, 'GENERAL_TASK', 'IN_PROGRESS', 'Location test job', $2, $2,
             '2026-07-21T12:00:00.000Z')
     RETURNING id`,
    [organizationId, actorUserId],
  )).rows[0]!.id;
}

async function createAcceptedJob(
  pool: Pool,
  organizationId: string,
  actorUserId: string,
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (organization_id, type, status, title, assigned_to, created_by,
        accepted_at, accepted_by)
     VALUES ($1, 'GENERAL_TASK', 'ACCEPTED', 'Location start integration',
             $2, $2, '2026-07-21T11:55:00.000Z', $2)
     RETURNING id`,
    [organizationId, actorUserId],
  )).rows[0]!.id;
}

async function createActivity(
  pool: Pool,
  organizationId: string,
  jobCardId: string,
  actorUserId: string,
  eventType = 'JOB_STARTED',
) {
  return (await pool.query<{ id: string }>(
    `INSERT INTO job_card_activity_logs
       (organization_id, job_card_id, actor_id, event_type)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [organizationId, jobCardId, actorUserId, eventType],
  )).rows[0]!.id;
}

describe.skipIf(!databaseUrl)('013 job action locations PostgreSQL migration', () => {
  it('atomically starts, stores location, emits realtime, and replays without geocoding', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createAcceptedJob(pool, organizationId, actorUserId);
      let reverseCalls = 0;
      const service = new JobCardService(
        new PostgresJobCardRepository(pool),
        () => new Date('2026-07-21T12:00:00.000Z'),
        undefined,
        {
          enabled: true,
          reverseGeocoder: {
            reverse: async () => {
              reverseCalls += 1;
              return {
                neighborhood: 'Kızılay', district: 'Çankaya', city: 'Ankara',
                approximateLabel: 'Kızılay, Çankaya / Ankara',
              };
            },
          },
        },
      );
      const actor = { id: actorUserId, organizationId, role: 'STAFF' as const };
      const request = {
        clientActionId: randomUUID(),
        expectedVersion: 1,
        locationCapture: {
          outcome: 'captured' as const,
          latitude: 39.92077,
          longitude: 32.85411,
          accuracyMeters: 24,
          capturedAt: '2026-07-21T11:59:58.000Z',
        },
      };

      const first = await service.start(actor, jobCardId, request);
      const replay = await service.start(actor, jobCardId, request);

      expect(replay).toEqual(first);
      expect(reverseCalls).toBe(1);
      const persisted = await pool.query<{
        status: string;
        version: number;
        activityCount: number;
        locationCount: number;
        realtimeCount: number;
        actionCount: number;
        approximateLabel: string;
      }>(
        `SELECT j.status, j.version,
           (SELECT COUNT(*)::int FROM job_card_activity_logs a
             WHERE a.organization_id = j.organization_id AND a.job_card_id = j.id
               AND a.event_type = 'JOB_STARTED') AS "activityCount",
           (SELECT COUNT(*)::int FROM job_action_locations l
             WHERE l.organization_id = j.organization_id AND l.job_card_id = j.id) AS "locationCount",
           (SELECT COUNT(*)::int FROM realtime_events r
             WHERE r.organization_id = j.organization_id AND r.entity_id = j.id
               AND r.event_type = 'job.started') AS "realtimeCount",
           (SELECT COUNT(*)::int FROM processed_actions p
             WHERE p.organization_id = j.organization_id AND p.user_id = $3
               AND p.client_action_id = $2) AS "actionCount",
           (SELECT l.approximate_label FROM job_action_locations l
             WHERE l.organization_id = j.organization_id AND l.job_card_id = j.id) AS "approximateLabel"
         FROM job_cards j WHERE j.organization_id = $1 AND j.id = $4`,
        [organizationId, request.clientActionId, actorUserId, jobCardId],
      );
      expect(persisted.rows[0]).toEqual({
        status: 'IN_PROGRESS', version: 2, activityCount: 1, locationCount: 1,
        realtimeCount: 1, actionCount: 1,
        approximateLabel: 'Kızılay, Çankaya / Ankara',
      });
    });
  });

  it('stores a captured location for its JOB_STARTED activity', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const activityId = await createActivity(
        pool,
        organizationId,
        jobCardId,
        actorUserId,
      );

      const capturedAt = new Date('2026-07-21T12:00:00.000Z');
      const inserted = await pool.query<{
        activityId: string;
        latitude: string;
        longitude: string;
        accuracyMeters: string;
        capturedAt: Date;
      }>(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, latitude, longitude, accuracy_meters, captured_at,
            geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'CAPTURED',
                 39.920770, 32.854110, 32.500, $5, 'NOT_REQUESTED')
         RETURNING activity_id AS "activityId", latitude::text AS latitude,
                   longitude::text AS longitude,
                   accuracy_meters::text AS "accuracyMeters",
                   captured_at AS "capturedAt"`,
        [organizationId, jobCardId, activityId, actorUserId, capturedAt],
      );

      expect(inserted.rows[0]).toEqual({
        activityId,
        latitude: '39.920770',
        longitude: '32.854110',
        accuracyMeters: '32.500',
        capturedAt,
      });
    });
  });

  it('enforces the captured and unavailable field sets', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const activities = await Promise.all(Array.from({ length: 4 }, () =>
        createActivity(pool, organizationId, jobCardId, actorUserId)));

      const insert = (activityId: string, values: string) => pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, failure_reason, latitude, longitude,
            accuracy_meters, captured_at, geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', ${values})`,
        [organizationId, jobCardId, activityId, actorUserId],
      );

      await expect(insert(
        activities[0]!,
        `'CAPTURED', NULL, NULL, 32.854110, 32.500,
         '2026-07-21T12:00:00.000Z', 'NOT_REQUESTED'`,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(insert(
        activities[1]!,
        `'CAPTURED', 'UNKNOWN', 39.920770, 32.854110, 32.500,
         '2026-07-21T12:00:00.000Z', 'NOT_REQUESTED'`,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(insert(
        activities[2]!,
        `'UNAVAILABLE', NULL, NULL, NULL, NULL, NULL, 'NOT_REQUESTED'`,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(insert(
        activities[3]!,
        `'UNAVAILABLE', 'TIMEOUT', 39.920770, 32.854110, 32.500,
         NULL, 'NOT_REQUESTED'`,
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects a location actor that does not own the linked activity', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const activityActorId = await createUser(pool, organizationId);
      const otherActorId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, activityActorId);
      const activityId = await createActivity(
        pool,
        organizationId,
        jobCardId,
        activityActorId,
      );

      await expect(pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, failure_reason, geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'UNAVAILABLE', 'TIMEOUT',
                 'NOT_REQUESTED')`,
        [organizationId, jobCardId, activityId, otherActorId],
      )).rejects.toMatchObject({ code: '23503' });
    });
  });

  it('allows only one location outcome for a start activity', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const activityId = await createActivity(
        pool,
        organizationId,
        jobCardId,
        actorUserId,
      );
      const insert = () => pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, failure_reason, geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'UNAVAILABLE', 'TIMEOUT',
                 'NOT_REQUESTED')`,
        [organizationId, jobCardId, activityId, actorUserId],
      );

      await insert();
      await expect(insert()).rejects.toMatchObject({ code: '23505' });
    });
  });

  it('enforces the action vocabulary and captured numeric bounds', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const activities = await Promise.all([
        createActivity(pool, organizationId, jobCardId, actorUserId),
        createActivity(pool, organizationId, jobCardId, actorUserId),
        createActivity(pool, organizationId, jobCardId, actorUserId),
        createActivity(pool, organizationId, jobCardId, actorUserId),
        createActivity(pool, organizationId, jobCardId, actorUserId),
      ]);
      const acceptedActivityId = await createActivity(
        pool,
        organizationId,
        jobCardId,
        actorUserId,
        'JOB_ACCEPTED',
      );

      const captured = (
        activityId: string,
        latitude: number,
        longitude: number,
        accuracyMeters: number,
        geocodingStatus = 'NOT_REQUESTED',
      ) => pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, latitude, longitude, accuracy_meters, captured_at,
            geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'CAPTURED', $5, $6, $7,
                 '2026-07-21T12:00:00.000Z', $8)`,
        [
          organizationId,
          jobCardId,
          activityId,
          actorUserId,
          latitude,
          longitude,
          accuracyMeters,
          geocodingStatus,
        ],
      );

      await expect(captured(
        activities[0]!,
        90.000001,
        32.854110,
        32.5,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(captured(
        activities[1]!,
        39.920770,
        -180.000001,
        32.5,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(captured(
        activities[2]!,
        39.920770,
        32.854110,
        0,
      )).rejects.toMatchObject({ code: '23514' });
      await expect(captured(
        activities[3]!,
        39.920770,
        32.854110,
        32.5,
        'UNKNOWN',
      )).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, failure_reason, geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'UNAVAILABLE', 'NETWORK_ERROR',
                 'NOT_REQUESTED')`,
        [organizationId, jobCardId, activities[4], actorUserId],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, failure_reason, geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_ACCEPTED', 'UNAVAILABLE', 'TIMEOUT',
                 'NOT_REQUESTED')`,
        [organizationId, jobCardId, acceptedActivityId, actorUserId],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('keeps derived address fields consistent with geocoding status', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const activities = await Promise.all(Array.from({ length: 3 }, () =>
        createActivity(pool, organizationId, jobCardId, actorUserId)));

      await expect(pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, failure_reason, geocoding_status, approximate_label)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'UNAVAILABLE', 'TIMEOUT',
                 'NOT_REQUESTED', 'Unexpected address')`,
        [organizationId, jobCardId, activities[0], actorUserId],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, latitude, longitude, accuracy_meters, captured_at,
            geocoding_status, city)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'CAPTURED', 39.920770,
                 32.854110, 32.500, '2026-07-21T12:00:00.000Z', 'FAILED',
                 'Ankara')`,
        [organizationId, jobCardId, activities[1], actorUserId],
      )).rejects.toMatchObject({ code: '23514' });
      await expect(pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, latitude, longitude, accuracy_meters, captured_at,
            geocoding_status)
         VALUES ($1, $2, $3, $4, 'JOB_STARTED', 'CAPTURED', 39.920770,
                 32.854110, 32.500, '2026-07-21T12:00:00.000Z', 'RESOLVED')`,
        [organizationId, jobCardId, activities[2], actorUserId],
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects cross-organization, wrong-job, and non-start activity links', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationOne = await createOrganization(pool, 'Location one');
      const organizationTwo = await createOrganization(pool, 'Location two');
      const actorOne = await createUser(pool, organizationOne);
      const actorTwo = await createUser(pool, organizationTwo);
      const jobOne = await createStartedJob(pool, organizationOne, actorOne);
      const otherJob = await createStartedJob(pool, organizationOne, actorOne);
      const activityOne = await createActivity(
        pool,
        organizationOne,
        jobOne,
        actorOne,
      );
      const acceptedActivity = await createActivity(
        pool,
        organizationOne,
        jobOne,
        actorOne,
        'JOB_ACCEPTED',
      );
      await createStartedJob(pool, organizationTwo, actorTwo);

      const unavailable = (
        organizationId: string,
        jobCardId: string,
        activityId: string,
        actorUserId: string,
        action = 'JOB_STARTED',
      ) => pool.query(
        `INSERT INTO job_action_locations
           (organization_id, job_card_id, activity_id, actor_user_id, action,
            capture_outcome, failure_reason, geocoding_status)
         VALUES ($1, $2, $3, $4, $5, 'UNAVAILABLE', 'TIMEOUT',
                 'NOT_REQUESTED')`,
        [organizationId, jobCardId, activityId, actorUserId, action],
      );

      await expect(unavailable(
        organizationTwo,
        jobOne,
        activityOne,
        actorTwo,
      )).rejects.toMatchObject({ code: '23503' });
      await expect(unavailable(
        organizationOne,
        otherJob,
        activityOne,
        actorOne,
      )).rejects.toMatchObject({ code: '23503' });
      await expect(unavailable(
        organizationOne,
        jobOne,
        acceptedActivity,
        actorOne,
        'JOB_ACCEPTED',
      )).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('indexes activity uniqueness and authorized JobCard history lookup', async () => {
    await withMigratedDatabase(async (pool) => {
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'job_action_locations'`,
      );

      expect(indexes.rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining([
          'job_action_locations_activity_unique',
          'job_action_locations_job_time_idx',
        ]),
      );
    });
  });

  it('appends a captured outcome through the JobCard transaction port', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const activityId = await createActivity(
        pool,
        organizationId,
        jobCardId,
        actorUserId,
      );
      const repository = new PostgresJobCardRepository(pool);
      const capturedAt = new Date('2026-07-21T12:00:00.000Z');

      const result = await repository.executeCriticalAction({
        organizationId,
        userId: actorUserId,
        clientActionId: randomUUID(),
        operationKey: 'JOB_CARD_START',
      }, async (transaction) => {
        const location = await transaction.appendJobActionLocation({
          organizationId,
          jobCardId,
          activityId,
          actorUserId,
          action: 'JOB_STARTED',
          capture: {
            outcome: 'CAPTURED',
            latitude: 39.92077,
            longitude: 32.85411,
            accuracyMeters: 32.5,
            capturedAt,
            geocodingStatus: 'RESOLVED',
            neighborhood: 'Kızılay',
            district: 'Çankaya',
            city: 'Ankara',
            approximateLabel: 'Kızılay Mahallesi, Çankaya / Ankara',
          },
        });
        return { response: location, realtimeEvents: [] };
      });

      expect(result).toMatchObject({
        kind: 'completed',
        response: {
          organizationId,
          jobCardId,
          activityId,
          actorUserId,
          action: 'JOB_STARTED',
          capture: {
            outcome: 'CAPTURED',
            latitude: 39.92077,
            longitude: 32.85411,
            accuracyMeters: 32.5,
            capturedAt,
            geocodingStatus: 'RESOLVED',
            neighborhood: 'Kızılay',
            district: 'Çankaya',
            city: 'Ankara',
            approximateLabel: 'Kızılay Mahallesi, Çankaya / Ankara',
          },
        },
      });
    });
  });

  it('appends an unavailable outcome through the JobCard transaction port', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const activityId = await createActivity(
        pool,
        organizationId,
        jobCardId,
        actorUserId,
      );
      const repository = new PostgresJobCardRepository(pool);

      const result = await repository.executeCriticalAction({
        organizationId,
        userId: actorUserId,
        clientActionId: randomUUID(),
        operationKey: 'JOB_CARD_START',
      }, async (transaction) => {
        const location = await transaction.appendJobActionLocation({
          organizationId,
          jobCardId,
          activityId,
          actorUserId,
          action: 'JOB_STARTED',
          capture: { outcome: 'UNAVAILABLE', reason: 'TIMEOUT' },
        });
        return { response: location, realtimeEvents: [] };
      });

      expect(result).toMatchObject({
        kind: 'completed',
        response: {
          organizationId,
          jobCardId,
          activityId,
          actorUserId,
          action: 'JOB_STARTED',
          capture: { outcome: 'UNAVAILABLE', reason: 'TIMEOUT' },
        },
      });
    });
  });

  it('rolls back the activity, location, and action claim together', async () => {
    await withMigratedDatabase(async (pool) => {
      const organizationId = await createOrganization(pool);
      const actorUserId = await createUser(pool, organizationId);
      const jobCardId = await createStartedJob(pool, organizationId, actorUserId);
      const repository = new PostgresJobCardRepository(pool);
      const clientActionId = randomUUID();

      await expect(repository.executeCriticalAction({
        organizationId,
        userId: actorUserId,
        clientActionId,
        operationKey: 'JOB_CARD_START',
      }, async (transaction) => {
        const activity = await transaction.appendActivity({
          organizationId,
          jobCardId,
          actorId: actorUserId,
          event: 'JOB_STARTED',
          clientActionId,
        });
        await transaction.appendJobActionLocation({
          organizationId,
          jobCardId,
          activityId: activity.id,
          actorUserId,
          action: 'JOB_STARTED',
          capture: { outcome: 'UNAVAILABLE', reason: 'TIMEOUT' },
        });
        throw new Error('force location transaction rollback');
      })).rejects.toThrow('force location transaction rollback');

      const persisted = await pool.query<{
        activityCount: number;
        locationCount: number;
        actionCount: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM job_card_activity_logs
             WHERE organization_id = $1 AND job_card_id = $2
               AND client_action_id = $3) AS "activityCount",
           (SELECT COUNT(*)::int FROM job_action_locations
             WHERE organization_id = $1 AND job_card_id = $2) AS "locationCount",
           (SELECT COUNT(*)::int FROM processed_actions
             WHERE organization_id = $1 AND user_id = $4
               AND client_action_id = $3) AS "actionCount"`,
        [organizationId, jobCardId, clientActionId, actorUserId],
      );
      expect(persisted.rows[0]).toEqual({
        activityCount: 0,
        locationCount: 0,
        actionCount: 0,
      });
    });
  });
});
