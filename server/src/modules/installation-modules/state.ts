import type { Pool } from 'pg';

import {
  INSTALLATION_MODULES,
  type InstallationModuleKey,
  type ModuleCapabilityField,
} from './registry.js';

export const MODULE_STATE_SOURCES = ['ENV_TAKEOVER', 'OPERATOR', 'FRESH_INSTALL'] as const;
export type ModuleStateSource = (typeof MODULE_STATE_SOURCES)[number];

export type ModuleStateRow = Readonly<{
  key: InstallationModuleKey;
  enabled: boolean;
  version: number;
  source: ModuleStateSource;
  updatedAt: Date;
  updatedByOperatorId: string | null;
}>;

export type ModuleStateDbRow = {
  module_key: InstallationModuleKey;
  enabled: boolean;
  version: number;
  source: ModuleStateSource;
  updated_at: Date;
  updated_by_operator_id: string | null;
};

export const MODULE_STATE_COLUMNS =
  'module_key, enabled, version, source, updated_at, updated_by_operator_id';

export function mapModuleStateRow(row: ModuleStateDbRow): ModuleStateRow {
  return {
    key: row.module_key,
    enabled: row.enabled,
    version: row.version,
    source: row.source,
    updatedAt: row.updated_at,
    updatedByOperatorId: row.updated_by_operator_id,
  };
}

export type ModuleStateLogger = { error(fields: object, message: string): void };

/**
 * Single read port for runtime module state. `read` resolves `null` for a
 * missing row and THROWS on a database failure; both are fail-closed states
 * for the caller (503 / capability off). There is no env fallback.
 */
export interface ModuleStateReader {
  read(key: InstallationModuleKey): Promise<ModuleStateRow | null>;
}

/** One primary-key read per call, no cache (contract §7). */
export class PostgresModuleStateReader implements ModuleStateReader {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async read(key: InstallationModuleKey): Promise<ModuleStateRow | null> {
    const result = await this.pool.query<ModuleStateDbRow>(
      `SELECT ${MODULE_STATE_COLUMNS} FROM installation_module_state WHERE module_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? mapModuleStateRow(row) : null;
  }
}

/**
 * Reader for `buildApp` without a database pool (in-memory unit tests only):
 * a boolean reports that fixed state for every module; a map reports listed
 * keys and returns `null` (missing row, fail closed) for unlisted keys.
 */
export function staticModuleStateReader(
  enabled: boolean | Partial<Record<InstallationModuleKey, boolean>>,
): ModuleStateReader {
  return {
    read: async (key) => {
      const value = typeof enabled === 'boolean' ? enabled : enabled[key];
      if (typeof value !== 'boolean') return null;
      return {
        key,
        enabled: value,
        version: 1,
        source: 'ENV_TAKEOVER',
        updatedAt: new Date(0),
        updatedByOperatorId: null,
      };
    },
  };
}

/**
 * Capability projection: read failure or a missing row is reported as `false`
 * and logged (contract §7); the caller never falls back to env.
 */
export async function readModuleEnabledOrFalse(
  reader: ModuleStateReader,
  key: InstallationModuleKey,
  logger: ModuleStateLogger,
): Promise<boolean> {
  try {
    const row = await reader.read(key);
    if (!row) {
      logger.error({ module: key }, 'Installation module state row is missing');
      return false;
    }
    return row.enabled;
  } catch (error) {
    logger.error({ err: error, module: key }, 'Installation module state read failed');
    return false;
  }
}

/**
 * Reads runtime enabled state for every registry module, keyed by each
 * module's `capability` field. Missing rows and read failures fail closed.
 */
export async function readModuleCapabilities(
  reader: ModuleStateReader,
  logger: ModuleStateLogger,
): Promise<Partial<Record<ModuleCapabilityField, boolean>>> {
  const result: Partial<Record<ModuleCapabilityField, boolean>> = {};
  for (const module of INSTALLATION_MODULES) {
    result[module.capability] = await readModuleEnabledOrFalse(reader, module.key, logger);
  }
  return result;
}
