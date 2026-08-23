import { lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type RestoreWorkspace = {
  root: string;
  ciphertextPath: string;
  plaintextPath: string;
  manifestPath: string;
  checksumPath: string;
  databaseDumpPath: string;
  filesArchivePath: string;
};

export class RestoreWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreWorkspaceError';
  }
}

function contained(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ensureDirectory(pathname: string): Promise<void> {
  const existing = await lstat(pathname).catch(() => null);
  if (existing?.isSymbolicLink()) throw new RestoreWorkspaceError('restore workspace root must not be a symlink');
  await mkdir(pathname, { recursive: true, mode: 0o700 });
  const checked = await lstat(pathname);
  if (!checked.isDirectory() || checked.isSymbolicLink()) {
    throw new RestoreWorkspaceError('restore workspace root is not a private directory');
  }
}

export async function createRestoreWorkspace(options: {
  root?: string;
  forbiddenRoots?: readonly string[];
} = {}): Promise<RestoreWorkspace> {
  const base = path.resolve(options.root ?? process.env.RESTORE_WORKSPACE_ROOT ?? path.join(os.tmpdir(), 'servora-med-restore'));
  const forbidden = [process.cwd(), ...(options.forbiddenRoots ?? [])]
    .map((value) => path.resolve(value));
  if (forbidden.some((root) => contained(base, root))) {
    throw new RestoreWorkspaceError('restore workspace must be outside repository and configured data roots');
  }
  await ensureDirectory(base);
  const root = await mkdtemp(path.join(base, 'run-'));
  await ensureDirectory(root);
  return {
    root,
    ciphertextPath: path.join(root, 'artifact.sbk.age'),
    plaintextPath: path.join(root, 'package.sbk.tar'),
    manifestPath: path.join(root, 'manifest.json'),
    checksumPath: path.join(root, 'checksums.sha256'),
    databaseDumpPath: path.join(root, 'database.dump'),
    filesArchivePath: path.join(root, 'files.tar.zst'),
  };
}

export async function removeRestoreWorkspace(root: string): Promise<void> {
  const resolved = path.resolve(root);
  const entry = await lstat(resolved).catch(() => null);
  if (!entry) return;
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new RestoreWorkspaceError('refusing to remove a non-directory restore workspace');
  }
  await rm(resolved, { recursive: true, force: false });
}
