import { mkdir, readdir, rm, stat } from 'node:fs/promises';
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
  await rm(paths.workspacePath, { recursive: true, force: true });
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
