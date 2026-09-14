/**
 * TEST-ENV build-freshness probe.
 *
 * The repository has tests that intentionally execute `server/dist` artifacts,
 * so build output is part of the test contract. A stale `dist/` must not be able
 * to produce a false green.
 *
 * Freshness is expressed with timestamps only — no hashing infrastructure. The
 * remedy is always `npm run build`, which rewrites every emitted artifact.
 *
 * Side-effect free apart from read-only `stat`/`readdir`; never writes.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { REQUIRED_BUILD_ARTIFACTS, type BuildFreshnessInput } from './test-env-contract.js';

async function listFiles(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { recursive: true })) as string[];
  } catch {
    return [];
  }
}

async function newestMtimeMs(
  root: string,
  accept: (relativePath: string) => boolean,
): Promise<number | null> {
  let newest: number | null = null;
  for (const relative of await listFiles(root)) {
    if (!accept(relative)) continue;
    try {
      const stats = await stat(path.join(root, relative));
      if (!stats.isFile()) continue;
      if (newest === null || stats.mtimeMs > newest) newest = stats.mtimeMs;
    } catch {
      // An unreadable entry cannot contribute to freshness.
    }
  }
  return newest;
}

/**
 * Collect the three freshness observations the contract classifies:
 * missing artifacts, the oldest required artifact, and the newest source input.
 *
 * Source inputs are every `src/**\/*.ts` plus the migration SQL files, because
 * `tsc` re-emits the whole tree and `copy-migrations.mjs` re-copies the catalog.
 */
export async function probeBuild(
  cwd: string,
  requiredArtifacts: readonly string[] = REQUIRED_BUILD_ARTIFACTS,
): Promise<BuildFreshnessInput> {
  const missingArtifacts: string[] = [];
  const artifactMtimes: number[] = [];

  for (const relative of requiredArtifacts) {
    const absolute = path.join(cwd, relative);
    let stats;
    try {
      stats = await stat(absolute);
    } catch {
      missingArtifacts.push(relative);
      continue;
    }
    if (stats.isDirectory()) {
      const entries = await listFiles(absolute);
      if (entries.length === 0) {
        missingArtifacts.push(relative);
        continue;
      }
      for (const entry of entries) {
        try {
          const entryStats = await stat(path.join(absolute, entry));
          if (entryStats.isFile()) artifactMtimes.push(entryStats.mtimeMs);
        } catch {
          // ignore unreadable entries
        }
      }
    } else {
      artifactMtimes.push(stats.mtimeMs);
    }
  }

  const newestSourceMtimeMs = await newestMtimeMs(
    path.join(cwd, 'src'),
    (relative) => relative.endsWith('.ts') || relative.endsWith('.sql'),
  );

  return {
    missingArtifacts,
    oldestArtifactMtimeMs: artifactMtimes.length > 0 ? Math.min(...artifactMtimes) : null,
    newestSourceMtimeMs,
  };
}
