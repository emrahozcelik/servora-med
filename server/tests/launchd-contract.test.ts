import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const launchdDir = fileURLToPath(new URL('../../ops/launchd', import.meta.url));

describe('launchd pilot templates', () => {
  const plists = readdirSync(launchdDir).filter((name) => name.endsWith('.plist.example'));
  const wrappers = [
    'start-api.sh.example',
    'run-backup.sh.example',
  ];

  it('ships API, backup, and Caddy LaunchDaemon examples', () => {
    expect(plists).toEqual(expect.arrayContaining([
      'com.servora-med.api.plist.example',
      'com.servora-med.backup.plist.example',
      'com.servora-med.caddy.plist.example',
    ]));
  });

  it.each(plists)('%s uses absolute program path, service identity, and no secret literals', (name) => {
    const raw = readFileSync(path.join(launchdDir, name), 'utf8');
    const body = raw.replace(/<!--[\s\S]*?-->/g, '');
    expect(raw).toMatch(/<\?xml version="1\.0"/);
    expect(raw).toMatch(/<!DOCTYPE plist/);
    expect(body).toMatch(/<key>ProgramArguments<\/key>/);
    expect(body).toMatch(/<string>\/[^<]+<\/string>/);
    expect(body).toMatch(/<key>UserName<\/key>\s*<string>servora-med<\/string>/);
    expect(body).toMatch(/<key>GroupName<\/key>\s*<string>servora-med<\/string>/);
    expect(body).not.toMatch(/<key>UserName<\/key>\s*<string>root<\/string>/);
    expect(body).not.toMatch(/<key>GroupName<\/key>\s*<string>wheel<\/string>/);
    expect(body).not.toMatch(/password|DATABASE_URL|BOOTSTRAP_ADMIN|gho_/i);
    expect(body).not.toMatch(/<string>\.\/|npm run |node dist/i);
  });

  it('API template restarts at boot and stays alive as servora-med', () => {
    const body = readFileSync(path.join(launchdDir, 'com.servora-med.api.plist.example'), 'utf8');
    expect(body).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(body).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(body).toMatch(/\/usr\/local\/libexec\/servora-med\/start-api\.sh/);
    expect(body).toMatch(/<string>servora-med<\/string>/);
  });

  it('backup template uses calendar interval and absolute wrapper', () => {
    const body = readFileSync(path.join(launchdDir, 'com.servora-med.backup.plist.example'), 'utf8');
    expect(body).toMatch(/<key>StartCalendarInterval<\/key>/);
    expect(body).toMatch(/\/usr\/local\/libexec\/servora-med\/run-backup\.sh/);
  });

  it('Caddy template is boot-time KeepAlive as servora-med', () => {
    const body = readFileSync(path.join(launchdDir, 'com.servora-med.caddy.plist.example'), 'utf8');
    expect(body).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(body).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(body).toMatch(/caddy/);
  });

  it.each(wrappers)('%s is bash -n clean and uses absolute paths with set -Eeuo pipefail', (name) => {
    const file = path.join(launchdDir, name);
    const body = readFileSync(file, 'utf8');
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
    expect(body).toMatch(/^#!/);
    expect(body).toMatch(/set -Eeuo pipefail/);
    expect(body).toMatch(/exec /);
    expect(body).not.toMatch(/echo .*PASSWORD|echo .*DATABASE_URL/i);
  });

  it('backup wrapper requires absolute PG binaries under minimal PATH', () => {
    const wrapper = path.join(launchdDir, 'run-backup.sh.example');
    const dir = mkdtempSync(path.join(tmpdir(), 'servora-backup-wrap-'));
    const envFile = path.join(dir, 'backup.env');
    const fakeDump = path.join(dir, 'pg_dump');
    const fakeRestore = path.join(dir, 'pg_restore');
    const fakePsql = path.join(dir, 'psql');
    const fakeBackup = path.join(dir, 'backup-postgres.sh');

    writeFileSync(fakeDump, '#!/bin/sh\necho dump-ok\n');
    writeFileSync(fakeRestore, '#!/bin/sh\necho restore-ok\n');
    writeFileSync(fakePsql, '#!/bin/sh\necho psql-ok\n');
    writeFileSync(
      fakeBackup,
      '#!/usr/bin/env bash\nset -Eeuo pipefail\ntest -x "$PG_DUMP_BIN"\ntest -x "$PG_RESTORE_BIN"\ntest -x "$PSQL_BIN"\necho backup-ok\n',
    );
    chmodSync(fakeDump, 0o755);
    chmodSync(fakeRestore, 0o755);
    chmodSync(fakePsql, 0o755);
    chmodSync(fakeBackup, 0o755);

    writeFileSync(
      envFile,
      [
        `PG_DUMP_BIN=${fakeDump}`,
        `PG_RESTORE_BIN=${fakeRestore}`,
        `PSQL_BIN=${fakePsql}`,
        'PGHOST=127.0.0.1',
        'PGPORT=5432',
        'PGUSER=servora',
        'PGDATABASE=servora_med',
        'BACKUP_DIR=/tmp',
        'OPS_LOG=/tmp/ops.log',
      ].join('\n'),
    );

    // Patch absolute constants in a disposable copy of the wrapper.
    const runnable = path.join(dir, 'run-backup.sh');
    const original = readFileSync(wrapper, 'utf8')
      .replace('/etc/servora-med/servora-med-backup.env', envFile)
      .replace('/opt/servora-med/current/ops/scripts/backup-postgres.sh', fakeBackup);
    writeFileSync(runnable, original);
    chmodSync(runnable, 0o755);

    const out = execFileSync('bash', [runnable], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: dir,
      },
    });
    expect(out).toMatch(/backup-ok/);

    // Controlled failure when absolute PG_DUMP_BIN is missing.
    writeFileSync(
      envFile,
      [
        'PG_DUMP_BIN=pg_dump',
        `PG_RESTORE_BIN=${fakeRestore}`,
        `PSQL_BIN=${fakePsql}`,
      ].join('\n'),
    );
    try {
      execFileSync('bash', [runnable], {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect.unreachable('relative PG_DUMP_BIN must fail');
    } catch (error) {
      const err = error as { status?: number; stderr?: string };
      expect(err.status).not.toBe(0);
      expect(String(err.stderr ?? '')).toMatch(/PG_DUMP_BIN must be an absolute path/);
    }
  });
});
