import { stat } from 'node:fs/promises';
import path from 'node:path';

import { ageVersionSupported } from '../encryption.js';
import { parseToolVersion, resolveBinary, runBinary } from '../process.js';

export class RestoreDecryptionError extends Error {
  constructor(message: string, readonly code = 'RESTORE_FORMAT_UNSUPPORTED') {
    super(message);
    this.name = 'RestoreDecryptionError';
  }
}

export type OperatorIdentityOptions = { identityPath?: string | null };

/** Explicit operator-held identity only; producer/public recipient settings are never consulted. */
export function resolveOperatorIdentity(options: OperatorIdentityOptions): string {
  const candidate = options.identityPath?.trim()
    || process.env.SERVORA_BACKUP_AGE_IDENTITY?.trim()
    || process.env.AGE_IDENTITY_FILE?.trim();
  if (!candidate || candidate.includes('\n') || candidate.includes('\r') || candidate.includes('\0')) {
    throw new RestoreDecryptionError('an explicit operator age identity file is required');
  }
  if (!path.isAbsolute(candidate)) throw new RestoreDecryptionError('age identity file must be absolute');
  const resolved = path.resolve(candidate);
  return resolved;
}

export async function decryptAgeArchive(input: {
  ciphertextPath: string;
  plaintextPath: string;
  identityPath: string;
  ageBin?: string;
  signal?: AbortSignal;
}): Promise<void> {
  const identity = await stat(input.identityPath).catch(() => null);
  if (!identity?.isFile()) throw new RestoreDecryptionError('age identity file is unavailable');
  if ((identity.mode & 0o077) !== 0) throw new RestoreDecryptionError('age identity file permissions are too broad');
  const ageBin = resolveBinary(input.ageBin ?? process.env.AGE_BIN, 'age');
  let version;
  try {
    const output = await runBinary(ageBin, ['--version'], { timeoutMs: 5_000, signal: input.signal });
    version = parseToolVersion(output.stdout, 'age');
  } catch {
    throw new RestoreDecryptionError('age CLI is unavailable');
  }
  if (!ageVersionSupported(version)) {
    throw new RestoreDecryptionError('age CLI is older than the native hybrid restore policy');
  }
  try {
    await runBinary(ageBin, [
      '--decrypt',
      '--identity', input.identityPath,
      '--output', input.plaintextPath,
      input.ciphertextPath,
    ], { timeoutMs: 6 * 60 * 60 * 1_000, signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new RestoreDecryptionError('age decryption failed');
  }
  const plaintext = await stat(input.plaintextPath).catch(() => null);
  if (!plaintext?.isFile() || plaintext.size === 0) {
    throw new RestoreDecryptionError('age produced an empty plaintext package');
  }
}
