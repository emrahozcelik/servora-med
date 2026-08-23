import { lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PAYLOAD_DIRNAME = 'payload';
export const PACKAGE_DIRNAME = 'package';

export type WorkspacePaths = {
  workspacePath: string;
  payloadPath: string;
  packagePath: string;
};

export type WorkspaceInspection = WorkspacePaths & {
  exists: boolean;
  payloadMembers: string[];
  packageFile: string | null;
};

export type WorkspaceReclamationRepository = {
  findRunById(id: string): Promise<{
    status: string;
    verifiedAt: Date | null;
  } | null>;
};

/**
 * Workspace location for a run. The run id is validated as a UUID and the
 * resolved path must stay strictly beneath the configured temp root — no
 * user-supplied path segments ever reach the filesystem layer.
 */
export function workspacePathsFor(tempRoot: string, runId: string): WorkspacePaths {
  const trimmed = runId.trim();
  if (!UUID_PATTERN.test(trimmed)) {
    throw new Error('workspace run id must be a uuid');
  }
  const root = path.resolve(tempRoot);
  const workspacePath = path.resolve(root, trimmed);
  if (workspacePath !== path.join(root, trimmed)) {
    throw new Error('workspace path escapes temp root');
  }
  return {
    workspacePath,
    payloadPath: path.join(workspacePath, PAYLOAD_DIRNAME),
    packagePath: path.join(workspacePath, PACKAGE_DIRNAME),
  };
}

/** Create an isolated, restrictive (0700) workspace for one run. Refuses to
 * reuse an existing workspace (no cross-attempt sharing). */
export async function createWorkspace(tempRoot: string, runId: string): Promise<WorkspacePaths> {
  const paths = workspacePathsFor(tempRoot, runId);
  const existing = await stat(paths.workspacePath).catch(() => null);
  if (existing) {
    throw new Error(`workspace already exists for run ${runId}`);
  }
  await mkdir(paths.payloadPath, { recursive: true, mode: 0o700 });
  await mkdir(paths.packagePath, { mode: 0o700 });
  return paths;
}

/** Best-effort removal of ONE run's workspace. Containment is re-asserted so
 * a malformed run id can never point the recursive delete outside the temp
 * root or at another run's directory. */
export async function removeWorkspace(tempRoot: string, runId: string): Promise<void> {
  const paths = workspacePathsFor(tempRoot, runId);
  const existing = await lstat(paths.workspacePath).catch(() => null);
  if (!existing) return;
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw new Error(`refusing to remove non-directory workspace for run ${runId}`);
  }
  await assertNoSymlinkTree(paths.workspacePath);
  await rm(paths.workspacePath, { recursive: true, force: true });
}

async function assertNoSymlinkTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`workspace contains a symbolic link: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      await assertNoSymlinkTree(path.join(root, entry.name));
    }
  }
}

/**
 * Reclaims only UUID-named workspaces whose durable run is terminal. Active,
 * queued, unknown, symlinked, and unverified rows are left untouched. This is
 * intentionally conservative: a stale directory is cheaper than deleting a
 * workspace that a still-live worker may own.
 */
export async function reclaimTerminalWorkspaces(
  tempRoot: string,
  repository: WorkspaceReclamationRepository,
): Promise<{ removed: string[]; skipped: string[] }> {
  const root = path.resolve(tempRoot);
  const rootStat = await lstat(root).catch(() => null);
  if (!rootStat) return { removed: [], skipped: [] };
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('backup temp root must be a real directory');
  }
  const rootReal = await realpath(root);
  const removed: string[] = [];
  const skipped: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!UUID_PATTERN.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      skipped.push(entry.name);
      continue;
    }
    const candidateReal = await realpath(candidate).catch(() => null);
    if (!candidateReal) {
      skipped.push(entry.name);
      continue;
    }
    const relative = path.relative(rootReal, candidateReal);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      skipped.push(entry.name);
      continue;
    }
    const run = await repository.findRunById(entry.name);
    if (!run || !['FAILED', 'CANCELLED', 'SUCCESS'].includes(run.status)
      || (run.status === 'SUCCESS' && !run.verifiedAt)) {
      skipped.push(entry.name);
      continue;
    }
    try {
      await assertNoSymlinkTree(candidate);
      await rm(candidate, { recursive: true, force: true });
      removed.push(entry.name);
    } catch {
      skipped.push(entry.name);
    }
  }
  return { removed, skipped };
}

export async function inspectWorkspace(tempRoot: string, runId: string): Promise<WorkspaceInspection> {
  const paths = workspacePathsFor(tempRoot, runId);
  const workspaceStat = await stat(paths.workspacePath).catch(() => null);
  if (!workspaceStat?.isDirectory()) {
    return { ...paths, exists: false, payloadMembers: [], packageFile: null };
  }
  const members = await readdir(paths.payloadPath).catch(() => [] as string[]);
  const packageEntries = await readdir(paths.packagePath).catch(() => [] as string[]);
  const packageFile = packageEntries.find((name) => name.endsWith('.sbk.tar')) ?? null;
  return { ...paths, exists: true, payloadMembers: members.sort(), packageFile };
}
