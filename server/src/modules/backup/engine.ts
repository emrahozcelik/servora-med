import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

import {
  parseToolVersion,
  resolveBinary,
  runBinary,
  tail,
  type ParsedToolVersion,
} from './process.js';
import type { BackupRepository } from './repository.js';
import type { BackupService } from './service.js';
import type {
  BackupFailureCode,
  BackupOrigin,
  BackupRetentionClass,
  BackupScope,
} from './types.js';
import { filesArchiveRequiredFor } from './types.js';
import { createWorkspace, removeWorkspace, workspacePathsFor } from './workspace.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MIN_FREE_BYTES = 512 * 1024 * 1024;

export type BackupManifestV1 = {
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

export type LocalBackupResult =
  | {
    outcome: 'packaged';
    runId: string;
    workspacePath: string;
    packagePath: string;
    packageBytes: number;
    manifest: BackupManifestV1;
  }
  | {
    outcome: 'failed';
    runId: string;
    failureCode: BackupFailureCode;
    failureSummary: string;
    diagnostics: string | null;
  };

class EngineFailure extends Error {
  constructor(
    readonly failureCode: BackupFailureCode,
    readonly summary: string,
    readonly diagnostics: string | null = null,
  ) {
    super(summary);
    this.name = 'EngineFailure';
  }
}

/** Streaming SHA-256: components are hashed through a read stream so a
 * multi-gigabyte dump never lands in memory. */
export async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return parsed.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

const ARCHIVE_DUMP_VERSION_PATTERN = /^\s*;\s*Dump Version:\s*(\S+)\s*$/;
const ARCHIVE_TOOL_VERSION_PATTERN = /^\s*;\s*Dumped by pg_dump version:\s*(.+?)\s*$/;

/** Read the produced custom archive's own header through `pg_restore -l`.
 * The header distinguishes the ARCHIVE FORMAT version ("Dump Version:
 * 1.15-0") from the PRODUCER tool version ("Dumped by pg_dump version:
 * 16.13"); both are recorded, never conflated. */
async function readArchiveMetadata(pgRestoreBin: string, dumpPath: string) {
  const listing = await runBinary(pgRestoreBin, ['-l', dumpPath], { timeoutMs: 30_000 });
  let dumpVersion: string | null = null;
  let dumpToolVersion: string | null = null;
  for (const line of listing.stdout.split('\n')) {
    const formatMatch = ARCHIVE_DUMP_VERSION_PATTERN.exec(line);
    if (formatMatch) dumpVersion = formatMatch[1]!;
    const toolMatch = ARCHIVE_TOOL_VERSION_PATTERN.exec(line);
    if (toolMatch) dumpToolVersion = toolMatch[1]!;
    if (dumpVersion && dumpToolVersion) break;
  }
  if (!dumpVersion || !dumpToolVersion) {
    throw new Error('archive header did not expose dump/tool versions');
  }
  return { dumpVersion, dumpToolVersion };
}

function pgConnectionEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C.UTF-8',
    PGHOST: url.hostname || '127.0.0.1',
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
  if (url.port) env.PGPORT = url.port;
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  // The password travels ONLY in the child process environment: never on
  // argv, never on disk, never in logs or persisted metadata.
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}

export type LocalBackupEngineOptions = {
  repository: BackupRepository;
  service: BackupService;
  pool: Pool;
  databaseUrl: string;
  tempRoot: string;
  filesRoot: string | null;
  now?: () => Date;
  application?: { applicationVersion: string; gitCommit: string | null };
};

type PreflightMetadata = {
  serverVersion: string;
  pgDumpVersion: ParsedToolVersion;
  schemaVersion: string;
};

/**
 * BR2 LOCAL BACKUP ENGINE.
 *
 * PostgreSQL source → isolated workspace → pg_dump (-Fc) → optional files
 * archive (tar+zstd) → manifest V1 → checksums.sha256 → plaintext package
 * (<run-id>.sbk.tar). Stops at the PACKAGE phase: the run stays RUNNING,
 * never SUCCESS, with no verified_at and no canonical sha256. Encryption,
 * upload, remote verification, and the state-machine CLEANUP phase belong to
 * BR3/BR4/BR5.
 *
 * Phase-state changes go exclusively through the BR1 state-machine service
 * primitives; the engine never updates run fields directly.
 */
export class LocalBackupEngine {
  private readonly now: () => Date;
  private readonly application: { applicationVersion: string; gitCommit: string | null };

  constructor(private readonly options: LocalBackupEngineOptions) {
    this.now = options.now ?? (() => new Date());
    this.application = options.application
      ?? { applicationVersion: readPackageVersion(), gitCommit: null };
  }

  async buildLocalBackup(runId: string): Promise<LocalBackupResult> {
    const { repository, service, tempRoot, filesRoot, databaseUrl } = this.options;

    let run = await repository.findRunById(runId);
    if (!run) throw new Error(`backup run not found: ${runId}`);
    if (run.status === 'QUEUED') {
      run = await service.startRun(runId);
    }
    if (run.status !== 'RUNNING' || run.phase !== 'PREFLIGHT') {
      throw new Error(
        `backup run ${runId} is not at PREFLIGHT (status=${run.status}, phase=${run.phase ?? 'null'})`,
      );
    }

    let workspaceTouched = false;
    try {
      const preflight = await this.preflight(run.scope, filesRoot);

      const existing = await stat(workspacePathsFor(tempRoot, runId).workspacePath).catch(() => null);
      if (existing) {
        // Fail-closed workspace preflight (BR0 table: "temp directory
        // writable → PREFLIGHT_LOW_DISK") until BR5 owns stale-workspace
        // recovery. Deliberately NOT PREFLIGHT_STORAGE_UNAVAILABLE — that
        // code belongs to remote storage (BR4).
        throw new EngineFailure(
          'PREFLIGHT_LOW_DISK',
          'Geçici yedek dizini bu çalışma için kullanılamıyor (mevcut çalışma dizini var).',
        );
      }

      await service.advancePhase(runId, 'DATABASE_DUMP', false);
      const paths = await createWorkspace(tempRoot, runId);
      workspaceTouched = true;

      const pgDumpBin = resolveBinary(process.env.PG_DUMP_BIN, 'pg_dump');
      try {
        await runBinary(
          pgDumpBin,
          ['-Fc', '--no-owner', '--no-acl', '--file', path.join(paths.payloadPath, 'database.dump')],
          { env: pgConnectionEnv(databaseUrl) },
        );
      } catch (error) {
        throw new EngineFailure(
          'PG_DUMP_FAILED',
          'Veritabanı yedeği (pg_dump) başarısız oldu.',
          error instanceof Error ? tail(error.message) : null,
        );
      }

      const filesArchiveRequired = filesArchiveRequiredFor(run.scope, filesRoot !== null);
      let filesComponent: { file: 'files.tar.zst'; bytes: number; sha256: string } | null = null;
      if (filesArchiveRequired) {
        await service.advancePhase(runId, 'FILES_ARCHIVE', true);
        filesComponent = await this.archiveFiles(paths.payloadPath, filesRoot!);
      }

      // MANIFEST phase: compute component integrity metadata and write the
      // self-describing manifest. Component hashes are derived in this phase
      // BY CONTRACT; the CHECKSUM phase only materializes checksums.sha256
      // from the already-computed values (BR0 phase order preserved).
      await service.advancePhase(runId, 'MANIFEST', filesArchiveRequired);
      let archiveMetadata: { dumpVersion: string; dumpToolVersion: string };
      try {
        archiveMetadata = await readArchiveMetadata(
          resolveBinary(process.env.PG_RESTORE_BIN, 'pg_restore'),
          path.join(paths.payloadPath, 'database.dump'),
        );
      } catch (error) {
        throw new EngineFailure(
          'MANIFEST_FAILED',
          'Arşiv sürüm bilgisi okunamadı.',
          error instanceof Error ? tail(error.message) : null,
        );
      }
      const databaseComponent = await this.component(paths.payloadPath, 'database.dump') as {
        file: 'database.dump';
        bytes: number;
        sha256: string;
      };
      const manifest: BackupManifestV1 = {
        format: 'servora-backup',
        formatVersion: 1,
        backupId: run.id,
        createdAt: this.now().toISOString(),
        application: this.application,
        backupScope: run.scope,
        origin: run.origin,
        retentionClass: run.retentionClass,
        database: {
          engine: 'postgresql',
          serverVersion: preflight.serverVersion,
          dumpVersion: archiveMetadata.dumpVersion,
          dumpToolVersion: archiveMetadata.dumpToolVersion,
          schemaVersion: preflight.schemaVersion,
        },
        contents: { database: databaseComponent, files: filesComponent },
        checksums: { file: 'checksums.sha256' },
      };
      try {
        await writeFile(
          path.join(paths.payloadPath, 'manifest.json'),
          JSON.stringify(manifest),
          { mode: 0o600 },
        );
      } catch {
        throw new EngineFailure('MANIFEST_FAILED', 'Yedek manifesti yazılamadı.');
      }

      // CHECKSUM phase: two spaces, newline-terminated sidecar. Failures in
      // this phase map to their own stable code (CHECKSUM_FAILED) — the
      // manifest already exists at this point.
      await service.advancePhase(runId, 'CHECKSUM', filesArchiveRequired);
      const lines = [`${databaseComponent.sha256}  database.dump`];
      if (filesComponent) lines.push(`${filesComponent.sha256}  files.tar.zst`);
      try {
        await writeFile(
          path.join(paths.payloadPath, 'checksums.sha256'),
          `${lines.join('\n')}\n`,
          { mode: 0o600 },
        );
      } catch {
        throw new EngineFailure('CHECKSUM_FAILED', 'Bileşen checksum dosyası yazılamadı.');
      }

      // PACKAGE phase: re-validate components against the manifest (tamper
      // guard — sizes AND hashes re-checked), then build the plaintext
      // package consumed by BR3.
      await service.advancePhase(runId, 'PACKAGE', filesArchiveRequired);
      await validateManifestComponents(paths.payloadPath, manifest);
      const packagePath = path.join(paths.packagePath, `${run.id}.sbk.tar`);
      const tarBin = resolveBinary(process.env.TAR_BIN, 'tar');
      const members = ['manifest.json', 'database.dump'];
      if (filesComponent) members.push('files.tar.zst');
      members.push('checksums.sha256');
      try {
        await runBinary(tarBin, ['-c', '-f', packagePath, '-C', paths.payloadPath, ...members]);
      } catch (error) {
        throw new EngineFailure(
          'PACKAGE_FAILED',
          'Yerel yedek paketi oluşturulamadı.',
          error instanceof Error ? tail(error.message) : null,
        );
      }

      const packageStat = await stat(packagePath);
      return {
        outcome: 'packaged',
        runId: run.id,
        workspacePath: paths.workspacePath,
        packagePath,
        packageBytes: packageStat.size,
        manifest,
      };
    } catch (error) {
      const failure = error instanceof EngineFailure
        ? error
        : new EngineFailure(
          'MANIFEST_FAILED',
          'Yedek üretimi beklenmeyen bir hatayla kesildi.',
          error instanceof Error ? tail(String(error.message ?? '')) : null,
        );
      await service.markFailed(runId, failure.failureCode, failure.summary);
      // LOCAL FAILURE CLEANUP (deliberately distinct from the state-machine
      // CLEANUP phase): best-effort removal of THIS run's partial workspace.
      // The original deterministic failure is never replaced or downgraded,
      // and the CLEANUP_FAILED warning is NOT used (no verified remote
      // artifact exists at this stage).
      if (workspaceTouched) {
        await removeWorkspace(tempRoot, runId).catch(() => undefined);
      }
      return {
        outcome: 'failed',
        runId,
        failureCode: failure.failureCode,
        failureSummary: failure.summary,
        diagnostics: failure.diagnostics,
      };
    }
  }

  /** BR2 local preflight subset: temp root, pg_dump, database, disk headroom,
   * and files-archive prerequisites. Age/R2 checks deliberately absent —
   * BR2 must not fail because BR3/BR4 are unconfigured. */
  private async preflight(scope: BackupScope, filesRoot: string | null): Promise<PreflightMetadata> {
    const { mkdir, rm, statfs, writeFile } = await import('node:fs/promises');

    try {
      await mkdir(this.options.tempRoot, { recursive: true });
      const probe = path.join(this.options.tempRoot, `.preflight-probe-${process.pid}`);
      await writeFile(probe, 'ok', { mode: 0o600 });
      await rm(probe, { force: true });
      const usage = await statfs(this.options.tempRoot).catch(() => null);
      if (usage && BigInt(usage.bsize) * BigInt(usage.bavail) < MIN_FREE_BYTES) {
        throw new EngineFailure('PREFLIGHT_LOW_DISK', 'Yedekleme için disk alanı yetersiz.');
      }
    } catch (error) {
      if (error instanceof EngineFailure) throw error;
      throw new EngineFailure(
        'PREFLIGHT_LOW_DISK',
        'Yedekleme geçici dizini kullanılamıyor veya yazılabilir değil.',
      );
    }

    const pgDumpBin = resolveBinary(process.env.PG_DUMP_BIN, 'pg_dump');
    let pgDumpVersion: ParsedToolVersion;
    try {
      const version = await runBinary(pgDumpBin, ['--version'], { timeoutMs: 5_000 });
      pgDumpVersion = parseToolVersion(version.stdout, 'pg_dump');
    } catch {
      throw new EngineFailure('PREFLIGHT_PG_DUMP_UNAVAILABLE', 'pg_dump aracı kullanılamıyor.');
    }

    let serverVersion: string;
    let schemaVersion: string;
    try {
      const server = await this.options.pool.query<{ server_version: string }>('SHOW server_version');
      serverVersion = server.rows[0]!.server_version;
      const schema = await this.options.pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      schemaVersion = schema.rows[0]?.version ?? 'unknown';
    } catch {
      throw new EngineFailure(
        'PREFLIGHT_DATABASE_UNAVAILABLE',
        'Yedeklenecek veritabanına şu anda bağlanılamadı.',
      );
    }

    // PostgreSQL-supported direction: a pg_dump older than the server major
    // version cannot dump that server. Newer pg_dump against older server OK.
    const serverMajor = Number(serverVersion.split('.')[0]);
    if (Number.isFinite(serverMajor) && pgDumpVersion.major < serverMajor) {
      throw new EngineFailure(
        'PREFLIGHT_PG_DUMP_UNAVAILABLE',
        'pg_dump sürümü sunucu sürümüyle uyumsuz.',
      );
    }

    if (filesArchiveRequiredFor(scope, filesRoot !== null)) {
      // Local files-archive prerequisites use their OWN preflight code:
      // PREFLIGHT_STORAGE_UNAVAILABLE is reserved for remote storage (BR4).
      try {
        const rootStat = await stat(filesRoot!);
        if (!rootStat.isDirectory()) throw new Error('not a directory');
        await readdir(filesRoot!);
      } catch {
        throw new EngineFailure(
          'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE',
          'Kalıcı dosya kökü kullanılamıyor.',
        );
      }
      for (const [envKey, fallback, label] of [
        ['TAR_BIN', 'tar', 'tar'],
        ['ZSTD_BIN', 'zstd', 'zstd'],
      ] as const) {
        try {
          await runBinary(resolveBinary(process.env[envKey], fallback), ['--version'], { timeoutMs: 5_000 });
        } catch {
          throw new EngineFailure(
            'PREFLIGHT_FILES_ARCHIVE_UNAVAILABLE',
            `Dosya arşivi için ${label} aracı kullanılamıyor.`,
          );
        }
      }
    }

    return { serverVersion, pgDumpVersion, schemaVersion };
  }

  private async component(
    payloadPath: string,
    file: 'database.dump' | 'files.tar.zst',
  ): Promise<{ file: 'database.dump' | 'files.tar.zst'; bytes: number; sha256: string }> {
    try {
      const filePath = path.join(payloadPath, file);
      const fileStat = await stat(filePath);
      const sha256 = await hashFile(filePath);
      if (!SHA256_HEX.test(sha256)) {
        throw new Error('invalid digest');
      }
      return { file, bytes: fileStat.size, sha256 };
    } catch {
      throw new EngineFailure('MANIFEST_FAILED', 'Bileşen checksum verisi üretilemedi.');
    }
  }

  private async archiveFiles(payloadPath: string, filesRoot: string) {
    const tarBin = resolveBinary(process.env.TAR_BIN, 'tar');
    const zstdBin = resolveBinary(process.env.ZSTD_BIN, 'zstd');
    const intermediate = path.join(payloadPath, 'files.tar');
    const target = path.join(payloadPath, 'files.tar.zst');
    try {
      // Symlinks are archived AS symlinks (tar is not told to dereference):
      // nothing outside the configured root is ever read.
      await runBinary(tarBin, ['-c', '-f', intermediate, '-C', filesRoot, '.']);
      await runBinary(zstdBin, ['-q', '-f', '-o', target, intermediate]);
    } catch (error) {
      throw new EngineFailure(
        'FILES_ARCHIVE_FAILED',
        'Kalıcı dosyalar arşivi oluşturulamadı.',
        error instanceof Error ? tail(error.message) : null,
      );
    } finally {
      await unlink(intermediate).catch(() => undefined);
    }
    return {
      file: 'files.tar.zst' as const,
      bytes: (await stat(target)).size,
      sha256: await hashFile(target),
    };
  }

}

/** Tamper guard run before packaging: every manifest component must still
 * exist with exactly the recorded size AND hash, and the metadata files must
 * be present. Exported for direct negative testing. */
export async function validateManifestComponents(
  payloadPath: string,
  manifest: BackupManifestV1,
): Promise<void> {
  const expected = [
    manifest.contents.database,
    ...(manifest.contents.files ? [manifest.contents.files] : []),
  ];
  for (const component of expected) {
    const filePath = path.join(payloadPath, component.file);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      throw new EngineFailure('PACKAGE_FAILED', 'Paket bileşeni eksik.');
    }
    if (fileStat.size !== component.bytes) {
      throw new EngineFailure('PACKAGE_FAILED', 'Paket bileşeni manifest ile uyuşmuyor.');
    }
    const sha256 = await hashFile(filePath);
    if (sha256 !== component.sha256) {
      throw new EngineFailure('PACKAGE_FAILED', 'Paket bileşeni doğrulama ile uyuşmuyor.');
    }
  }
  for (const metadataFile of ['manifest.json', 'checksums.sha256']) {
    const exists = await stat(path.join(payloadPath, metadataFile)).catch(() => null);
    if (!exists?.isFile()) {
      throw new EngineFailure('PACKAGE_FAILED', 'Paket meta verisi eksik.');
    }
  }
}
