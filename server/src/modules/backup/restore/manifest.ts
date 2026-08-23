import {
  BACKUP_ORIGINS,
  BACKUP_RETENTION_CLASSES,
  BACKUP_SCOPES,
  type BackupOrigin,
  type BackupRetentionClass,
  type BackupScope,
} from '../types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export type RestoreManifestV1 = {
  format: 'servora-backup';
  formatVersion: 1;
  backupId: string;
  createdAt: string;
  application: { applicationVersion: string; gitCommit: string | null };
  backupScope: BackupScope;
  origin: BackupOrigin;
  retentionClass: BackupRetentionClass;
  database: {
    engine: 'postgresql';
    serverVersion: string;
    dumpVersion: string;
    dumpToolVersion: string;
    schemaVersion: string;
  };
  contents: {
    database: { file: 'database.dump'; bytes: number; sha256: string };
    files: { file: 'files.tar.zst'; bytes: number; sha256: string } | null;
  };
  checksums: { file: 'checksums.sha256' };
};

export class RestoreManifestError extends Error {
  constructor(
    message: string,
    readonly code: 'RESTORE_MANIFEST_INVALID' | 'RESTORE_FORMAT_UNSUPPORTED' = 'RESTORE_MANIFEST_INVALID',
  ) {
    super(message);
    this.name = 'RestoreManifestError';
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RestoreManifestError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new RestoreManifestError(`${label} must be a non-empty safe string`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new RestoreManifestError(`${label} is unsupported`);
  }
  return value as T;
}

function bytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RestoreManifestError(`${label} must be a safe non-negative integer`);
  }
  return value as number;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256.test(value) || value !== value.toLowerCase()) {
    throw new RestoreManifestError(`${label} must be lowercase SHA-256`);
  }
  return value;
}

function component<T extends 'database.dump' | 'files.tar.zst'>(
  value: unknown,
  expectedFile: T,
  label: string,
): { file: T; bytes: number; sha256: string } {
  const row = object(value, label);
  if (row.file !== expectedFile) throw new RestoreManifestError(`${label}.file is invalid`);
  const componentBytes = bytes(row.bytes, `${label}.bytes`);
  if (componentBytes <= 0) throw new RestoreManifestError(`${label}.bytes must be positive`);
  return {
    file: expectedFile,
    bytes: componentBytes,
    sha256: sha(row.sha256, `${label}.sha256`),
  };
}

/**
 * Parse the BR2 package manifest without carrying unknown values into the
 * restore pipeline.  A future format is rejected before any archive or
 * database operation is attempted.
 */
export function parseRestoreManifest(value: unknown): RestoreManifestV1 {
  const row = object(value, 'manifest');
  if (row.format !== 'servora-backup') throw new RestoreManifestError('manifest format is invalid');
  if (typeof row.formatVersion !== 'number' || !Number.isInteger(row.formatVersion)) {
    throw new RestoreManifestError('manifest formatVersion is invalid');
  }
  if (row.formatVersion > 1) {
    throw new RestoreManifestError('manifest formatVersion is newer than this restore tool', 'RESTORE_FORMAT_UNSUPPORTED');
  }
  if (row.formatVersion !== 1) throw new RestoreManifestError('manifest formatVersion is unsupported');

  if (typeof row.backupId !== 'string' || !UUID.test(row.backupId)) {
    throw new RestoreManifestError('manifest backupId must be a UUID');
  }
  const createdAt = text(row.createdAt, 'manifest.createdAt');
  if (Number.isNaN(Date.parse(createdAt))) throw new RestoreManifestError('manifest.createdAt is invalid');

  const application = object(row.application, 'manifest.application');
  const gitCommit = application.gitCommit;
  if (gitCommit !== null && (typeof gitCommit !== 'string' || gitCommit.length === 0)) {
    throw new RestoreManifestError('manifest.application.gitCommit is invalid');
  }

  const database = object(row.database, 'manifest.database');
  if (database.engine !== 'postgresql') throw new RestoreManifestError('manifest database engine is unsupported');
  const contents = object(row.contents, 'manifest.contents');
  const checksums = object(row.checksums, 'manifest.checksums');
  if (checksums.file !== 'checksums.sha256') throw new RestoreManifestError('manifest checksums.file is invalid');

  const files = contents.files === null
    ? null
    : component(contents.files, 'files.tar.zst', 'manifest.contents.files');

  return {
    format: 'servora-backup',
    formatVersion: 1,
    backupId: row.backupId.toLowerCase(),
    createdAt,
    application: {
      applicationVersion: text(application.applicationVersion, 'manifest.application.applicationVersion'),
      gitCommit,
    },
    backupScope: enumValue(row.backupScope, BACKUP_SCOPES, 'manifest.backupScope'),
    origin: enumValue(row.origin, BACKUP_ORIGINS, 'manifest.origin'),
    retentionClass: enumValue(row.retentionClass, BACKUP_RETENTION_CLASSES, 'manifest.retentionClass'),
    database: {
      engine: 'postgresql',
      serverVersion: text(database.serverVersion, 'manifest.database.serverVersion'),
      dumpVersion: text(database.dumpVersion, 'manifest.database.dumpVersion'),
      dumpToolVersion: text(database.dumpToolVersion, 'manifest.database.dumpToolVersion'),
      schemaVersion: text(database.schemaVersion, 'manifest.database.schemaVersion'),
    },
    contents: {
      database: component(contents.database, 'database.dump', 'manifest.contents.database'),
      files,
    },
    checksums: { file: 'checksums.sha256' },
  };
}
