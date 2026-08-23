import { lstat, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { resolveBinary, runBinary } from '../process.js';

export class RestoreFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreFilesError';
  }
}

export function validateFilesArchiveMemberName(name: string): { normalized: string; directory: boolean } {
  const directory = name.endsWith('/');
  const stripped = name.replace(/^\.\//, '').replace(/\/$/, '');
  if (!stripped) return { normalized: '', directory: true };
  if (stripped.startsWith('/') || stripped.includes('\\')) throw new RestoreFilesError('files archive contains an absolute path');
  const segments = stripped.split('/');
  if (segments.some((segment) => segment === '' || segment === '..' || segment === '.')) {
    throw new RestoreFilesError('files archive contains traversal');
  }
  const resolved = path.resolve('/safe-root', ...segments);
  if (resolved !== path.join('/safe-root', stripped) || !resolved.startsWith('/safe-root/')) {
    throw new RestoreFilesError('files archive path escapes its root');
  }
  return { normalized: stripped, directory };
}

async function ensureNoSymlink(root: string, current = root): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(current, entry.name);
    const info = await lstat(entryPath);
    if (info.isSymbolicLink() || info.isBlockDevice() || info.isCharacterDevice() || info.isFIFO() || info.isSocket()) {
      throw new RestoreFilesError('files restore produced an unsafe filesystem entry');
    }
    if (info.isDirectory()) await ensureNoSymlink(root, entryPath);
  }
}

/** Restore FULL_DATA files into one new, empty, operator-selected root. */
export async function restoreFullDataArchive(
  compressedArchivePath: string,
  targetRoot: string,
  workspaceRoot: string,
  signal?: AbortSignal,
  forbiddenRoots: readonly string[] = [],
): Promise<void> {
  const resolvedTarget = path.resolve(targetRoot);
  const resolvedWorkspace = path.resolve(workspaceRoot);
  if (resolvedTarget === resolvedWorkspace || resolvedTarget.startsWith(`${resolvedWorkspace}${path.sep}`)) {
    throw new RestoreFilesError('files target must be outside the restore workspace');
  }
  for (const forbidden of [process.cwd(), ...forbiddenRoots].map((value) => path.resolve(value))) {
    if (resolvedTarget === forbidden || resolvedTarget.startsWith(`${forbidden}${path.sep}`)) {
      throw new RestoreFilesError('files target must be outside repository and configured production roots');
    }
  }
  if (await lstat(resolvedTarget).catch(() => null)) {
    throw new RestoreFilesError('FULL_DATA target root must not already exist');
  }
  await mkdir(resolvedTarget, { recursive: true, mode: 0o700 });
  const tarPath = path.join(workspaceRoot, 'files.tar');
  const zstdBin = resolveBinary(process.env.ZSTD_BIN, 'zstd');
  const tarBin = resolveBinary(process.env.TAR_BIN, 'tar');
  try {
    await runBinary(zstdBin, ['-q', '-d', '-f', '-o', tarPath, compressedArchivePath], { timeoutMs: 6 * 60 * 60 * 1_000, signal });
    const listing = await runBinary(tarBin, ['-tf', tarPath], { timeoutMs: 60_000, signal });
    const names = listing.stdout.split(/\r?\n/).filter(Boolean);
    const seen = new Set<string>();
    for (const name of names) {
      const parsed = validateFilesArchiveMemberName(name);
      if (!parsed.normalized) continue;
      if (seen.has(parsed.normalized)) throw new RestoreFilesError('files archive contains duplicate entries');
      seen.add(parsed.normalized);
    }
    const verbose = await runBinary(tarBin, ['-tvf', tarPath], { timeoutMs: 60_000, signal });
    for (const line of verbose.stdout.split(/\r?\n/).filter(Boolean)) {
      const type = line[0];
      if (type !== '-' && type !== 'd') throw new RestoreFilesError('files archive contains a link or special entry');
    }
    await runBinary(tarBin, [
      '-xpf', tarPath,
      '-C', resolvedTarget,
      '--no-same-owner',
      '--no-same-permissions',
    ], { timeoutMs: 6 * 60 * 60 * 1_000, signal });
    await ensureNoSymlink(resolvedTarget);
  } catch (error) {
    throw error instanceof RestoreFilesError ? error : new RestoreFilesError('FULL_DATA archive extraction failed');
  }
}
