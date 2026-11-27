import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import type { InstallationModuleKey } from '../src/modules/installation-modules/registry.js';
import {
  PostgresModuleStateReader,
  readModuleCapabilities,
  readModuleEnabledOrFalse,
  staticModuleStateReader,
} from '../src/modules/installation-modules/state.js';
import {
  legacyModuleValues,
  takeOverInstallationModules,
} from '../src/modules/installation-modules/takeover.js';

const migrationsDirectory = fileURLToPath(new URL('../src/db/migrations', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;
const schema = `modstate_${randomUUID().replaceAll('-', '')}`;
let admin: Pool | null = null;
let pool: Pool | null = null;

beforeAll(async () => {
  if (!databaseUrl) return;
  admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  await runMigrations({ migrationsDirectory, store: new PostgresMigrationStore(pool) });
});

afterAll(async () => {
  await pool?.end();
  await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin?.end();
});

async function reset() {
  await pool!.query('DELETE FROM operator_audit_events');
  await pool!.query('DELETE FROM installation_module_state');
}

describe('installation module pure helpers (R0)', () => {
  it('staticModuleStateReader supports boolean and partial map forms', async () => {
    const allOn = staticModuleStateReader(true);
    expect(await allOn.read('OVERVIEW')).toMatchObject({ key: 'OVERVIEW', enabled: true, source: 'ENV_TAKEOVER' });

    const allOff = staticModuleStateReader(false);
    expect(await allOff.read('OVERVIEW')).toMatchObject({ key: 'OVERVIEW', enabled: false, source: 'ENV_TAKEOVER' });

    const mappedOn = staticModuleStateReader({ OVERVIEW: true });
    expect(await mappedOn.read('OVERVIEW')).toMatchObject({ key: 'OVERVIEW', enabled: true });
    expect(await mappedOn.read('CALENDAR' as InstallationModuleKey)).toBeNull();

    const emptyMap = staticModuleStateReader({});
    expect(await emptyMap.read('OVERVIEW')).toBeNull();
  });

  it('readModuleCapabilities projects each registry module and fails closed on missing rows', async () => {
    const logged: string[] = [];
    const logger = { error: (_fields: object, message: string) => { logged.push(message); } };

    expect(await readModuleCapabilities(staticModuleStateReader({ OVERVIEW: true, MESSAGING: false }), logger)).toEqual({
      overviewDashboard: true,
      messaging: false,
    });
    expect(await readModuleCapabilities(staticModuleStateReader({}), logger)).toEqual({
      overviewDashboard: false,
      messaging: false,
    });
    expect(logged).toHaveLength(2);
  });

  it('legacyModuleValues extracts capabilities for modules with legacyEnvKey', () => {
    expect(legacyModuleValues(undefined)).toEqual({ OVERVIEW: false, MESSAGING: false });
    expect(legacyModuleValues({
      overviewDashboard: true,
      calendar: true,
      messaging: false,
      backup: false,
      demoDatasetCreation: false,
    })).toEqual({ OVERVIEW: true, MESSAGING: false });
  });
});

describe.skipIf(!databaseUrl)('installation module takeover (MOD-002)', () => {
  it('takes the env value over once and writes one system audit event', async () => {
    await reset();
    const at = new Date('2026-11-26T10:00:00.000Z');
    await takeOverInstallationModules(pool!, { OVERVIEW: true, MESSAGING: false }, () => at);
    const row = await new PostgresModuleStateReader(pool!).read('OVERVIEW');
    expect(row).toMatchObject({ enabled: true, version: 1, source: 'ENV_TAKEOVER', updatedByOperatorId: null });

    // Restart with a different env value: no effect, no second event.
    await takeOverInstallationModules(pool!, { OVERVIEW: false, MESSAGING: true });
    expect((await new PostgresModuleStateReader(pool!).read('OVERVIEW'))?.enabled).toBe(true);
    const events = await pool!.query(
      "SELECT actor_kind, operator_id, module_key, new_value, occurred_at FROM operator_audit_events WHERE event_type = 'MODULE_STATE_TAKEN_OVER' ORDER BY module_key",
    );
    expect(events.rows).toHaveLength(2);
    expect(events.rows.find((r) => r.module_key === 'OVERVIEW')).toMatchObject({
      actor_kind: 'SYSTEM', operator_id: null, module_key: 'OVERVIEW',
      new_value: { enabled: true, source: 'ENV_TAKEOVER' }, occurred_at: at,
    });
  });

  it('takes an unset env (false) over as disabled on an empty database', async () => {
    await reset();
    await takeOverInstallationModules(pool!, { OVERVIEW: false, MESSAGING: false });
    expect((await new PostgresModuleStateReader(pool!).read('OVERVIEW'))?.enabled).toBe(false);
  });

  it('concurrent startups produce exactly one row and one event', async () => {
    await reset();
    await Promise.all([
      takeOverInstallationModules(pool!, { OVERVIEW: true, MESSAGING: false }),
      takeOverInstallationModules(pool!, { OVERVIEW: true, MESSAGING: false }),
      takeOverInstallationModules(pool!, { OVERVIEW: true, MESSAGING: false }),
    ]);
    expect((await pool!.query('SELECT 1 FROM installation_module_state')).rowCount).toBe(2);
    expect((await pool!.query(
      "SELECT 1 FROM operator_audit_events WHERE event_type = 'MODULE_STATE_TAKEN_OVER'",
    )).rowCount).toBe(2);
  });

  it('fails closed when the row is missing but a takeover event exists', async () => {
    await reset();
    await takeOverInstallationModules(pool!, { OVERVIEW: true, MESSAGING: false });
    await pool!.query('DELETE FROM installation_module_state');
    await expect(takeOverInstallationModules(pool!, { OVERVIEW: true, MESSAGING: false })).rejects.toThrow(/controlled recovery/);
    expect((await pool!.query('SELECT 1 FROM installation_module_state')).rowCount).toBe(0);
  });

  it('fails closed when a non-registry module key exists in installation_module_state', async () => {
    await reset();
    await pool!.query(
      `INSERT INTO installation_module_state (module_key, enabled, version, source, updated_at)
       VALUES ('CALENDAR', true, 1, 'ENV_TAKEOVER', now())`,
    );
    await expect(takeOverInstallationModules(pool!, { OVERVIEW: true, MESSAGING: false })).rejects.toThrow(
      /outside the registry: CALENDAR; controlled recovery required/,
    );
    expect((await pool!.query('SELECT module_key FROM installation_module_state')).rows).toEqual([
      { module_key: 'CALENDAR' },
    ]);
  });

  it('fails startup when a legacyEnvKey module is missing from legacy input', async () => {
    await reset();
    await expect(takeOverInstallationModules(pool!, {})).rejects.toThrow(/Missing legacy value/);
    expect((await pool!.query('SELECT 1 FROM installation_module_state')).rowCount).toBe(0);
  });

  it('reports a missing row or a read failure as capability off and logs it', async () => {
    await reset();
    const logged: string[] = [];
    const logger = { error: (_fields: object, message: string) => { logged.push(message); } };
    expect(await readModuleEnabledOrFalse(new PostgresModuleStateReader(pool!), 'OVERVIEW', logger)).toBe(false);
    const failing = { read: async () => { throw new Error('db down'); } };
    expect(await readModuleEnabledOrFalse(failing, 'OVERVIEW', logger)).toBe(false);
    expect(logged).toHaveLength(2);
  });
});
