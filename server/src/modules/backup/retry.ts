import type { BackupFailureCode } from './types.js';

export const BACKUP_RETRY_MAX_ATTEMPTS = 3;
export const BACKUP_RETRY_BASE_DELAY_MS = 1_000;
export const BACKUP_RETRY_MAX_DELAY_MS = 30_000;

const RETRYABLE_FAILURES: ReadonlySet<BackupFailureCode> = new Set([
  'PREFLIGHT_DATABASE_UNAVAILABLE',
  'PREFLIGHT_STORAGE_UNAVAILABLE',
  'PREFLIGHT_LOW_DISK',
  'R2_UPLOAD_FAILED',
  'R2_VERIFY_FAILED',
]);

export function isRetryableBackupFailure(code: BackupFailureCode | string): boolean {
  return RETRYABLE_FAILURES.has(code as BackupFailureCode);
}

export function retryDelayMs(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('retry attempt must be positive');
  return Math.min(
    BACKUP_RETRY_MAX_DELAY_MS,
    BACKUP_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)),
  );
}
