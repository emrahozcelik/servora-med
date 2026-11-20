/**
 * Development-only managed demo dataset command.
 *
 *   npm run demo:dev -- list   --admin-email <admin@example.com>
 *   npm run demo:dev -- create --admin-email <admin@example.com>
 *   npm run demo:dev -- purge  --admin-email <admin@example.com> --dataset <id> --yes
 *
 * It drives the existing `DemoDatasetService` (Admin-only, D4 lifecycle,
 * transactional fail-closed purge) as a named active Admin of the local
 * development organization. It adds no new demo content or lifecycle rule, and
 * creation still requires DEMO_DATA_CREATION_ENABLED=true.
 *
 * Refused unless NODE_ENV=development and DATABASE_URL is a loopback,
 * non-staging, non-test database (see `./demo-dev-guard.ts`).
 */

import { randomUUID } from 'node:crypto';

import { loadConfig } from '../config.js';
import { AppError } from '../errors/index.js';
import type { SafeUser } from '../modules/auth/types.js';
import { PostgresDemoDatasetRepository } from '../modules/demo-data/repository.js';
import { DemoDatasetService } from '../modules/demo-data/service.js';
import { DemoDevError, assertLocalDevelopmentTarget, parseDemoDevArgs } from './demo-dev-guard.js';
import { closeDatabase, createDatabase } from './index.js';

async function findAdmin(
  pool: ReturnType<typeof createDatabase>['pool'],
  email: string,
): Promise<SafeUser> {
  const result = await pool.query<{
    id: string; organization_id: string; name: string; email: string; role: SafeUser['role'];
    must_change_password: boolean; is_active: boolean; version: number;
  }>(
    `SELECT id, organization_id, name, email, role, must_change_password, is_active, version
       FROM users WHERE lower(email) = $1 LIMIT 1`,
    [email],
  );
  const row = result.rows[0];
  if (!row || row.role !== 'ADMIN' || !row.is_active) {
    throw new DemoDevError('DEMO_DEV_ADMIN_REQUIRED', `No active Admin user with email ${email} exists in this database.`);
  }
  return {
    id: row.id, organizationId: row.organization_id, name: row.name, email: row.email,
    role: row.role, mustChangePassword: row.must_change_password, isActive: row.is_active, version: row.version,
  };
}

async function main() {
  const args = parseDemoDevArgs(process.argv.slice(2));
  // Checked on the raw environment before loadConfig(): an unset NODE_ENV
  // defaults to development there, but this command requires it explicitly.
  const target = assertLocalDevelopmentTarget({
    nodeEnv: process.env.NODE_ENV?.trim() ?? '',
    databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
  });
  const config = loadConfig();
  if (args.command === 'create' && !config.demoDataCreationEnabled) {
    throw new DemoDevError(
      'DEMO_DEV_CREATION_DISABLED',
      'Set DEMO_DATA_CREATION_ENABLED=true in the development server/.env to create a demo dataset.',
    );
  }

  const database = createDatabase(config.databaseUrl);
  try {
    const admin = await findAdmin(database.pool, args.adminEmail);
    const service = new DemoDatasetService(
      new PostgresDemoDatasetRepository(database.pool),
      () => config.demoDataCreationEnabled,
    );
    console.info(`Target: ${target.databaseName} (NODE_ENV=development), organization ${admin.organizationId}.`);

    if (args.command === 'list') {
      const datasets = await service.list(admin);
      if (datasets.length === 0) console.info('No demo datasets.');
      for (const dataset of datasets) {
        console.info(`${dataset.id}\t${dataset.status}\tcreated ${dataset.createdAt}`);
      }
      return;
    }

    if (args.command === 'create') {
      const result = await service.create(admin, { clientActionId: randomUUID() });
      console.info(`Created demo dataset ${result.dataset.id}.`);
      console.info(JSON.stringify(result.counts));
      return;
    }

    const preview = await service.preview(admin, args.datasetId);
    console.info(`Purge preview for ${preview.dataset.id}: ${JSON.stringify(preview.affectedCounts)}`);
    if (!preview.safeToPurge) {
      for (const blocker of preview.blockers) console.error(`${blocker.code}: ${blocker.message}`);
      throw new DemoDevError('DEMO_DEV_PURGE_BLOCKED', 'The purge plan has blockers; nothing was deleted.');
    }
    const result = await service.purge(admin, args.datasetId, {
      clientActionId: randomUUID(),
      planHash: preview.planHash,
    });
    console.info(`Purged demo dataset ${result.datasetId} (${result.status}).`);
  } finally {
    await closeDatabase(database);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof DemoDevError || error instanceof AppError) {
    console.error(`${error.code}: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
