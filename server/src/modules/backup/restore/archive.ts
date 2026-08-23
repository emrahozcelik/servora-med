import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

import { resolveBinary, runBinary, scrubDiagnostics, tail } from '../process.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_MEMBER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQUIRED_MEMBERS = new Set(['manifest.json', 'database.dump', 'checksums.sha256']);

export type PackageMember = 'manifest.json' | 'database.dump' | 'files.tar.zst' | 'checksums.sha256';

export class RestoreArchiveError extends Error {
  constructor(message: string, readonly code = 'RESTORE_MANIFEST_INVALID') {
    super(message);
    this.name = 'RestoreArchiveError';
  }
}

function allowedMember(name: string): name is PackageMember {
  return name === 'manifest.json'
    || name === 'database.dump'
    || name === 'files.tar.zst'
    || name === 'checksums.sha256';
}

/** Parse the BR2 sidecar (one lowercase SHA-256, two spaces, flat filename). */
export function parseChecksumSidecar(
  content: string,
  filesIncluded: boolean,
): Record<string, string> {
  if (!content.endsWith('\n')) throw new RestoreArchiveError('checksum sidecar must end with newline');
  const expected = new Set(['database.dump', ...(filesIncluded ? ['files.tar.zst'] : [])]);
  const result: Record<string, string> = {};
  for (const line of content.split('\n').slice(0, -1)) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(line);
    if (!match || !SHA256.test(match[1]!)) {
      throw new RestoreArchiveError('checksum sidecar line is invalid');
    }
    const filename = match[2]!;
    if (!expected.has(filename) || filename in result) {
      throw new RestoreArchiveError('checksum sidecar contains an unexpected or duplicate member');
    }
    result[filename] = match[1]!;
  }
  if (Object.keys(result).length !== expected.size || [...expected].some((name) => !(name in result))) {
    throw new RestoreArchiveError('checksum sidecar is missing a component');
  }
  return result;
}

export function validateArchiveMemberName(name: string): void {
  if (!name || name.startsWith('/') || name.startsWith('\\') || name.includes('\\')) {
    throw new RestoreArchiveError('archive contains an absolute or platform-unsafe path');
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new RestoreArchiveError('archive contains traversal or empty path segments');
  }
  if (!SAFE_MEMBER.test(name) || !allowedMember(name)) {
    throw new RestoreArchiveError(`archive contains an unexpected member: ${name}`);
  }
}

export type ArchiveInspection = { members: PackageMember[] };

/**
 * List and inspect every tar entry before any extraction.  The verbose listing
 * is intentionally checked as well: symlinks, hardlinks, devices, fifos and
 * directories are never materialized from an untrusted package.
 */
export async function inspectPackageArchive(
  archivePath: string,
  tarBin = resolveBinary(process.env.TAR_BIN, 'tar'),
  signal?: AbortSignal,
): Promise<ArchiveInspection> {
  const archiveStat = await stat(archivePath).catch(() => null);
  if (!archiveStat?.isFile()) throw new RestoreArchiveError('encrypted plaintext package is not a regular file');

  const listing = await runBinary(tarBin, ['-tf', archivePath], { timeoutMs: 60_000, signal });
  const names = listing.stdout.split(/\r?\n/).filter((name) => name.length > 0);
  const seen = new Set<string>();
  for (const name of names) {
    validateArchiveMemberName(name);
    if (seen.has(name)) throw new RestoreArchiveError('archive contains a duplicate member');
    seen.add(name);
  }
  const verbose = await runBinary(tarBin, ['-tvf', archivePath], { timeoutMs: 60_000, signal });
  for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
    const type = line[0];
    if (type !== '-') throw new RestoreArchiveError('archive contains a non-regular entry');
  }
  for (const required of REQUIRED_MEMBERS) {
    if (!seen.has(required)) throw new RestoreArchiveError(`archive is missing ${required}`);
  }
  const files = seen.has('files.tar.zst');
  if (seen.size !== REQUIRED_MEMBERS.size + (files ? 1 : 0)) {
    throw new RestoreArchiveError('archive contains an unexpected member');
  }
  return { members: [...seen] as PackageMember[] };
}

/** Extract one allowlisted regular file to a fresh 0600 path without a shell. */
export async function extractPackageMember(
  archivePath: string,
  member: PackageMember,
  destination: string,
  tarBin = resolveBinary(process.env.TAR_BIN, 'tar'),
  signal?: AbortSignal,
  maxBytes?: number,
): Promise<void> {
  validateArchiveMemberName(member);
  const child = spawn(tarBin, ['-xOf', archivePath, member], {
    shell: false,
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-500);
  });
  const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  let writtenBytes = 0;
  const limiter = maxBytes === undefined ? null : new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      writtenBytes += chunk.byteLength;
      if (writtenBytes > maxBytes) {
        callback(new RestoreArchiveError('archive member exceeds its manifest byte bound'));
      } else {
        callback(null, chunk);
      }
    },
  });
  try {
    await Promise.all([
      limiter ? pipeline(child.stdout!, limiter, output) : pipeline(child.stdout!, output),
      (async () => {
        const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
        if (code !== 0) {
          throw new RestoreArchiveError(
            `archive member extraction failed (${code ?? signal ?? 'unknown'}) ${scrubDiagnostics(tail(stderr))}`,
          );
        }
      })(),
    ]);
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }
}
