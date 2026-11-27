import type { preHandlerHookHandler } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { InstallationModuleKey } from './registry.js';
import type { ModuleStateLogger, ModuleStateReader, ModuleStateRow } from './state.js';

export const moduleStateUnavailable = () =>
  new AppError('MODULE_STATE_UNAVAILABLE', 503, 'Modül durumu şu anda okunamıyor.');

/**
 * Runtime module gate (MOD-002 / MSG-001): disabled -> 404; missing row or
 * read failure -> 503 (fail closed, no env fallback).
 */
export async function assertModuleEnabled(
  reader: ModuleStateReader,
  key: InstallationModuleKey,
  logger: ModuleStateLogger,
): Promise<void> {
  let row: ModuleStateRow | null;
  try {
    row = await reader.read(key);
  } catch (error) {
    logger.error({ err: error, module: key }, 'Installation module state read failed');
    throw moduleStateUnavailable();
  }
  if (!row) throw moduleStateUnavailable();
  if (!row.enabled) throw new AppError('NOT_FOUND', 404, 'Sayfa bulunamadı.');
}

export function moduleGate(
  reader: ModuleStateReader,
  key: InstallationModuleKey,
): preHandlerHookHandler {
  return async (request) => {
    await assertModuleEnabled(reader, key, request.log);
  };
}
