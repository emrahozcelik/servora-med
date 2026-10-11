import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MigrationCatalog } from '../../src/db/migration-catalog.js';

/** Synthetic operator-installed catalog fixture; not production authenticity evidence. */
export function createRecoveryReleaseFixture(root: string, sha: string, entries: MigrationCatalog['entries']) {
  const release = path.join(root, sha);
  const directory = path.join(release, 'server/dist/db/migrations');
  mkdirSync(directory, { recursive: true });
  const lines: string[] = [];
  for (const entry of entries) {
    const bytes = readFileSync(entry.path); writeFileSync(path.join(directory, entry.filename), bytes);
    lines.push(`f ./server/dist/db/migrations/${entry.filename} ${createHash('sha256').update(bytes).digest('hex')}`);
  }
  for (const name of ['.servora-release-content.sha256', '.servora-release-artifact.sha256']) {
    writeFileSync(path.join(release, name), name.includes('content') ? lines.join('\n') + '\n' : 'b'.repeat(64) + '\n');
    chmodSync(path.join(release, name), 0o600);
  }
  return directory;
}
