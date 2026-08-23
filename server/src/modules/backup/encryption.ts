import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { link, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import {
  parseToolVersion,
  resolveBinary,
  runBinary,
  scrubDiagnostics,
  tail,
  type ParsedToolVersion,
} from './process.js';
import type { BackupRepository } from './repository.js';
import type { BackupService } from './service.js';
import { removeWorkspace, workspacePathsFor } from './workspace.js';

/**
 * BR3 LOCAL ENCRYPTION ENGINE.
 *
 * BR2 plaintext package (<run-id>.sbk.tar, phase PACKAGE) → official age CLI
 * with ONE native post-quantum hybrid recipient (ML-KEM-768 + X25519) →
 * binary ciphertext <run-id>.sbk.age + streaming local SHA-256.
 *
 * The run advances PACKAGE → ENCRYPT and stops there: no UPLOAD, no
 * REMOTE_VERIFY, no CLEANUP, never SUCCESS. `localCiphertextSha256` is the
 * LOCAL EXPECTED value handed to BR4 — it is NOT the canonical
 * remote-verified `backup_runs.sha256` and is never persisted as such.
 *
 * Encryption is authenticated (age) but does NOT establish producer
 * authenticity; there are no signatures in V1 (BR0 S1 guarantee matrix).
 * The private identity has no production path: only the PUBLIC recipient
 * is ever configured (BR0 architecture §10).
 */

export const HYBRID_RECIPIENT_PREFIX = 'age1pq1';

// Bech32 data charset (lowercase, without the reserved '1', 'b', 'i', 'o').
const BECH32_DATA_PATTERN = /^[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$/;

// Native hybrid recipients are ~1,959 characters (ML-KEM-768 + X25519
// material); classic X25519 recipients are always 62. The window rejects a
// prefix-coincident classic/plugin encoding without pinning the exact
// upstream length.
const MIN_HYBRID_RECIPIENT_LENGTH = 1_000;
const MAX_HYBRID_RECIPIENT_LENGTH = 4_096;

// Native HybridRecipient requires age >= 1.3.0; any other major fails
// closed pending a compatibility review. There is NO classic-X25519
// fallback (BR3 decision, DECISIONS.md OPS-003).
export const SUPPORTED_AGE_MINIMUM = { major: 1, minor: 3 } as const;

const MAX_STDERR_CHARS = 8_192;

export type HybridRecipientRejection =
  | 'EMPTY'
  | 'WRONG_PREFIX'
  | 'INVALID_CHARSET'
  | 'LENGTH_OUT_OF_RANGE';

export type HybridRecipientValidation =
  | { ok: true; recipient: string }
  | { ok: false; reason: HybridRecipientRejection };

/**
 * Recipient policy: ONLY native age post-quantum hybrid recipients are
 * accepted. Classic X25519, SSH recipients, plugin recipients, tagged
 * recipient types, passphrases, private identities pasted into the
 * recipient slot, and multi-recipient values are all rejected — no
 * automatic downgrade exists.
 */
export function validateHybridRecipient(value: string | null | undefined): HybridRecipientValidation {
  const trimmed = value?.trim() ?? '';
  if (trimmed.length === 0) return { ok: false, reason: 'EMPTY' };
  if (!trimmed.startsWith(HYBRID_RECIPIENT_PREFIX)) return { ok: false, reason: 'WRONG_PREFIX' };
  const data = trimmed.slice(HYBRID_RECIPIENT_PREFIX.length);
  if (
    data.length === 0
    || trimmed.includes('\n')
    || trimmed.includes('\r')
    || !BECH32_DATA_PATTERN.test(data)
  ) {
    return { ok: false, reason: 'INVALID_CHARSET' };
  }
  if (trimmed.length < MIN_HYBRID_RECIPIENT_LENGTH || trimmed.length > MAX_HYBRID_RECIPIENT_LENGTH) {
    return { ok: false, reason: 'LENGTH_OUT_OF_RANGE' };
  }
  return { ok: true, recipient: trimmed };
}

export function ageVersionSupported(version: { major: number; minor: number }): boolean {
  return version.major === SUPPORTED_AGE_MINIMUM.major && version.minor >= SUPPORTED_AGE_MINIMUM.minor;
}

class EncryptionFailure extends Error {
  constructor(
    readonly summary: string,
    readonly diagnostics: string | null = null,
    /** Collision-class failures preserve the whole workspace (including the
     * ambiguous pre-existing artifact) for BR5 crash recovery. */
    readonly preserveWorkspace = false,
  ) {
    super(summary);
    this.name = 'EncryptionFailure';
  }
}

export type LocalEncryptionResult =
  | {
    outcome: 'encrypted';
    runId: string;
    encryptedPath: string;
    ciphertextBytes: number;
    /** LOCAL EXPECTED ciphertext hash for the BR4 handoff. Never written to
     * backup_runs.sha256 (that value is remote-verification-owned). */
    localCiphertextSha256: string;
    ageVersion: string;
    recipientType: 'MLKEM768_X25519';
  }
  | {
    outcome: 'failed';
    runId: string;
    failureCode: 'ENCRYPTION_FAILED';
    failureSummary: string;
    diagnostics: string | null;
  };

export type LocalEncryptionEngineOptions = {
  repository: BackupRepository;
  service: BackupService;
  tempRoot: string;
  /** Public hybrid recipient (BACKUP_ENCRYPTION_RECIPIENT). The private
   * identity has no supported production configuration path. */
  recipient: string | null;
};

export class LocalEncryptionEngine {
  constructor(private readonly options: LocalEncryptionEngineOptions) {}

  async encryptLocalBackup(runId: string): Promise<LocalEncryptionResult> {
    const { repository, service, tempRoot, recipient } = this.options;

    const run = await repository.findRunById(runId);
    if (!run) throw new Error(`backup run not found: ${runId}`);
    if (run.status !== 'RUNNING' || run.phase !== 'PACKAGE') {
      throw new Error(
        `backup run ${runId} is not at PACKAGE (status=${run.status}, phase=${run.phase ?? 'null'})`,
      );
    }

    try {
      const paths = workspacePathsFor(tempRoot, runId);
      const packagePath = path.join(paths.packagePath, `${runId}.sbk.tar`);
      const packageStat = await stat(packagePath).catch(() => null);
      if (!packageStat?.isFile()) {
        throw new EncryptionFailure('Şifrelenecek yerel yedek paketi bulunamadı.');
      }

      // Fail closed on ANY pre-existing output: a final artifact means the
      // run already has a BR3 handoff (re-encryption would casually create a
      // second ciphertext variant); a partial means an interrupted execution.
      // Reclamation ownership belongs to BR5.
      const finalPath = path.join(paths.packagePath, `${runId}.sbk.age`);
      const partialPath = `${finalPath}.partial`;
      for (const [label, target] of [['final', finalPath], ['partial', partialPath]] as const) {
        if (await stat(target).catch(() => null)) {
          throw new EncryptionFailure(
            `Şifreli çıktı (${label}) zaten mevcut; belirsiz durum bilinçli olarak korunuyor.`,
            null,
            true,
          );
        }
      }

      const { ageBin, version } = await this.resolveAgeVersion();
      const hybrid = this.requireHybridRecipient(recipient);

      // PACKAGE → ENCRYPT skips no phase, so the files-archive flag is not
      // consulted by the transition validator for this step.
      await service.advancePhase(runId, 'ENCRYPT', false);

      const written = await this.runAgeEncryption(ageBin, hybrid, packagePath, partialPath);
      if (written.bytes === 0) {
        throw new EncryptionFailure('Şifreli çıktı boş üretildi.');
      }
      // Atomic no-overwrite publication: hard-link the completed partial to
      // the final name (fails EEXIST instead of replacing), then drop the
      // partial. An interrupted process can never expose a half-written
      // final artifact.
      try {
        await link(partialPath, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new EncryptionFailure(
            'Şifreli çıktı (final) zaten mevcut; belirsiz durum bilinçli olarak korunuyor.',
            null,
            true,
          );
        }
        throw error;
      }
      await unlink(partialPath).catch(() => undefined);
      const finalStat = await stat(finalPath);
      if (finalStat.size !== written.bytes) {
        throw new EncryptionFailure('Şifreli çıktı beklenmeyen boyutta.');
      }

      return {
        outcome: 'encrypted',
        runId,
        encryptedPath: finalPath,
        ciphertextBytes: finalStat.size,
        localCiphertextSha256: written.sha256,
        ageVersion: version.raw,
        recipientType: 'MLKEM768_X25519',
      };
    } catch (error) {
      const failure = error instanceof EncryptionFailure
        ? error
        : new EncryptionFailure(
          'Yedek şifreleme beklenmeyen bir hatayla kesildi.',
          error instanceof Error ? tail(String(error.message ?? '')) : null,
        );
      await service.markFailed(runId, 'ENCRYPTION_FAILED', failure.summary);
      // LOCAL FAILURE CLEANUP: best-effort removal of THIS run's workspace
      // (plaintext package + partial ciphertext) for ordinary handled
      // failures. Collision-class failures preserve everything. The
      // CLEANUP_FAILED warning is intentionally not used: no verified remote
      // artifact exists at this stage (that is its BR4+ precondition).
      if (!failure.preserveWorkspace) {
        await removeWorkspace(tempRoot, runId).catch(() => undefined);
      }
      return {
        outcome: 'failed',
        runId,
        failureCode: 'ENCRYPTION_FAILED',
        failureSummary: failure.summary,
        diagnostics: failure.diagnostics,
      };
    }
  }

  private async resolveAgeVersion(): Promise<{ ageBin: string; version: ParsedToolVersion }> {
    const ageBin = resolveBinary(process.env.AGE_BIN, 'age');
    let version: ParsedToolVersion;
    try {
      const output = await runBinary(ageBin, ['--version'], { timeoutMs: 5_000 });
      version = parseToolVersion(output.stdout, 'age');
    } catch {
      throw new EncryptionFailure('age şifreleme aracı kullanılamıyor (AGE_BIN).');
    }
    if (!ageVersionSupported(version)) {
      throw new EncryptionFailure(
        `age sürümü desteklenmiyor (${version.raw}); native hibrit recipient için age >= 1.3.0 gerekir.`,
      );
    }
    return { ageBin, version };
  }

  private requireHybridRecipient(value: string | null): string {
    const validation = validateHybridRecipient(value);
    if (validation.ok) return validation.recipient;
    switch (validation.reason) {
      case 'EMPTY':
        throw new EncryptionFailure('Yedek şifreleme recipient yapılandırılmamış.');
      case 'WRONG_PREFIX':
        throw new EncryptionFailure(
          'Şifreleme recipient türü desteklenmiyor; yalnız native age hibrit recipient (age1pq1…) kabul edilir.',
        );
      case 'LENGTH_OUT_OF_RANGE':
        throw new EncryptionFailure('Şifreleme recipient uzunluğu native hibrit biçimle uyuşmuyor.');
      default:
        throw new EncryptionFailure('Şifreleme recipient biçimi geçersiz.');
    }
  }

  /**
   * Stream `age --encrypt` stdout simultaneously into an exclusive 0600
   * partial file and a SHA-256 hash — the ciphertext never lands in memory
   * and backpressure is carried by pipe. argv-only invocation (shell:false):
   * the recipient is public and travels as a single argv element.
   */
  private runAgeEncryption(
    ageBin: string,
    recipient: string,
    packagePath: string,
    partialPath: string,
  ): Promise<{ sha256: string; bytes: number }> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let child: ReturnType<typeof spawn> | null = null;
      let exited = false;
      let exitCode: number | null = null;
      let flushed = false;
      let stderrTail = '';

      const fail = (summary: string, diagnostics: string | null = null, preserve = false) => {
        if (settled) return;
        settled = true;
        child?.kill('SIGTERM');
        reject(new EncryptionFailure(summary, diagnostics, preserve));
      };
      const settle = () => {
        if (settled || !exited || !flushed) return;
        settled = true;
        if (exitCode !== 0) {
          reject(new EncryptionFailure(
            'age şifrelemesi başarısız sonlandı.',
            stderrTail.length > 0 ? scrubDiagnostics(stderrTail) : null,
          ));
          return;
        }
        resolve({ sha256: hash.digest('hex'), bytes });
      };

      const hash = createHash('sha256');
      let bytes = 0;

      open(partialPath, 'wx', 0o600).then((handle) => {
        const output = handle.createWriteStream();
        child = spawn(
          ageBin,
          ['--encrypt', '--recipient', recipient, packagePath],
          { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
        );

        child.stdout!.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          hash.update(chunk);
        });
        child.stdout!.on('error', (error) => fail('Şifreli çıktı akışı kesildi.', tail(String(error.message ?? ''))));
        child.stdout!.pipe(output);

        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (chunk: string) => {
          stderrTail = tail(`${stderrTail}${chunk}`.slice(-2 * MAX_STDERR_CHARS));
        });

        child.on('error', (error) => {
          exited = true;
          exitCode = null;
          fail('age süreci başlatılamadı.', tail(String(error.message ?? '')));
        });
        child.on('close', (code) => {
          exited = true;
          exitCode = code;
          settle();
        });

        output.on('error', (error) => {
          fail('Şifreli çıktı dosyası yazılamadı.', tail(String(error.message ?? '')));
        });
        output.on('finish', () => {
          flushed = true;
          settle();
        });
      }).catch((error: NodeJS.ErrnoException) => {
        if (error?.code === 'EEXIST') {
          reject(new EncryptionFailure(
            'Şifreli çıktı (partial) zaten mevcut; belirsiz durum bilinçli olarak korunuyor.',
            null,
            true,
          ));
          return;
        }
        reject(new EncryptionFailure(
          'Şifreli çıktı dosyası oluşturulamadı.',
          tail(String(error?.message ?? '')),
        ));
      });
    });
  }
}
