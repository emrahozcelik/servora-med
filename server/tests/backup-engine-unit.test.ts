import { mkdtemp, mkdir, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createWorkspace,
  inspectWorkspace,
  removeWorkspace,
  workspacePathsFor,
} from '../src/modules/backup/workspace.js';
import {
  parseToolVersion,
  resolveBinary,
  runBinary,
  scrubDiagnostics,
} from '../src/modules/backup/process.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'servora-br2-unit-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('backup workspace primitives', () => {
  it('derives contained paths from validated run ids only', () => {
    const runId = randomUUID();
    const paths = workspacePathsFor(root, runId);
    expect(paths.workspacePath).toBe(path.resolve(root, runId));
    expect(paths.payloadPath).toBe(path.join(paths.workspacePath, 'payload'));
    expect(paths.packagePath).toBe(path.join(paths.workspacePath, 'package'));

    expect(() => workspacePathsFor(root, '../escape')).toThrow();
    expect(() => workspacePathsFor(root, '')).toThrow();
    expect(() => workspacePathsFor(root, `${runId}/../${randomUUID()}`)).toThrow();
  });

  it('creates a restrictive isolated workspace and refuses reuse', async () => {
    const runId = randomUUID();
    const paths = await createWorkspace(root, runId);
    const workspaceStat = await stat(paths.workspacePath);
    expect(workspaceStat.isDirectory()).toBe(true);

    const inspection = await inspectWorkspace(root, runId);
    expect(inspection.exists).toBe(true);
    expect(inspection.payloadMembers).toEqual([]);
    expect(inspection.packageFile).toBeNull();

    await expect(createWorkspace(root, runId)).rejects.toThrow();
  });

  it('inspect reports package file and payload members', async () => {
    const runId = randomUUID();
    const paths = await createWorkspace(root, runId);
    await writeFile(path.join(paths.payloadPath, 'manifest.json'), '{}');
    await writeFile(path.join(paths.packagePath, `${runId}.sbk.tar`), 'x');
    const inspection = await inspectWorkspace(root, runId);
    expect(inspection.payloadMembers).toEqual(['manifest.json']);
    expect(inspection.packageFile).toBe(`${runId}.sbk.tar`);
  });

  it('removes exactly one run workspace and never neighbors', async () => {
    const keep = randomUUID();
    const drop = randomUUID();
    await createWorkspace(root, keep);
    const dropPaths = await createWorkspace(root, drop);
    await writeFile(path.join(dropPaths.payloadPath, 'database.dump'), 'partial');

    await removeWorkspace(root, drop);
    expect((await inspectWorkspace(root, drop)).exists).toBe(false);
    expect((await inspectWorkspace(root, keep)).exists).toBe(true);

    await expect(removeWorkspace(root, '../outside')).rejects.toThrow();
    await removeWorkspace(root, keep);
  });

  it('workspace directories use 0700 permissions', async () => {
    const runId = randomUUID();
    const paths = await createWorkspace(root, runId);
    expect((await stat(paths.workspacePath)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.payloadPath)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.packagePath)).mode & 0o777).toBe(0o700);
  });
});

describe('backup process helpers', () => {
  it('parses tool versions across output styles', () => {
    expect(parseToolVersion('pg_dump (PostgreSQL) 16.13 (Homebrew)', 'pg_dump')).toMatchObject({ major: 16, minor: 13 });
    expect(parseToolVersion('pg_dump (PostgreSQL) 17.5', 'pg_dump')).toMatchObject({ major: 17, minor: 5 });
    expect(() => parseToolVersion('no version here', 'pg_dump')).toThrow();
  });

  it('resolves binaries with env override and PATH fallback', () => {
    expect(resolveBinary(undefined, 'pg_dump')).toBe('pg_dump');
    expect(resolveBinary('  ', 'pg_dump')).toBe('pg_dump');
    expect(resolveBinary('/usr/lib/postgresql/17/bin/pg_dump', 'pg_dump'))
      .toBe('/usr/lib/postgresql/17/bin/pg_dump');
  });

  it('runs binaries argv-safe without a shell and reports failures', async () => {
    const listed = await runBinary(process.execPath, ['-e', 'console.log("ok")']);
    expect(listed.stdout.trim()).toBe('ok');

    await expect(runBinary(process.execPath, ['-e', 'process.exit(3)'])).rejects
      .toMatchObject({ name: 'ProcessError' });
    await expect(runBinary('/nonexistent/binary-xyz', ['--version'], { timeoutMs: 1_000 }))
      .rejects.toThrow();
  });

  it('scrubs credential-shaped diagnostics', () => {
    const scrubbed = scrubDiagnostics(
      'connect postgresql://servora:supersecret@127.0.0.1:5432/db failed\npassword=supersecret',
    );
    expect(scrubbed).not.toContain('supersecret');
    expect(scrubbed).toContain('<redacted-url>');
    expect(scrubbed).toContain('<redacted>');
  });

  it('unwritable workspace parent is reported by creation failure', async () => {
    const readOnly = path.join(root, 'readonly-parent');
    await mkdir(readOnly, { recursive: true, mode: 0o700 });
    await chmod(readOnly, 0o500);
    try {
      await expect(createWorkspace(readOnly, randomUUID())).rejects.toThrow();
    } finally {
      await chmod(readOnly, 0o700);
      await rm(readOnly, { recursive: true, force: true });
    }
  });
});
