import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const runbookPath = fileURLToPath(
  new URL('../../docs/operations/local-macos-cloudflare-tunnel.md', import.meta.url),
);
const envExamplePath = fileURLToPath(
  new URL('../../ops/examples/servora-med.env.example', import.meta.url),
);
const backupEnvPath = fileURLToPath(
  new URL('../../ops/examples/servora-med-backup.env.example', import.meta.url),
);

describe('macOS pilot runtime contracts', () => {
  const runbook = readFileSync(runbookPath, 'utf8');
  const envExample = readFileSync(envExamplePath, 'utf8');
  const backupEnv = readFileSync(backupEnvPath, 'utf8');

  it('uses servora-postgres with brew --sudo-service-user (not bare sudo brew services)', () => {
    expect(runbook).toMatch(/servora-postgres/);
    expect(runbook).toMatch(/--sudo-service-user=servora-postgres/);
    expect(runbook).toMatch(/start postgresql@16/);
    // Forbidden canonical forms
    expect(runbook).not.toMatch(/^\s*sudo brew services start postgresql@16\s*$/m);
    expect(runbook).not.toMatch(/UniqueID 550|PrimaryGroupID 550/);
  });

  it('documents ensure-macos-service-identity for both service users', () => {
    expect(runbook).toMatch(/ensure-macos-service-identity\.sh/);
    expect(runbook).toMatch(/servora-med/);
    expect(runbook).toMatch(/servora-postgres/);
  });

  it('requires password-bearing DATABASE_URL as canonical app auth', () => {
    // Placeholder password component required (not user@host without password).
    expect(envExample).toMatch(
      /DATABASE_URL=postgresql:\/\/servora:<APP_DB_PASSWORD>@127\.0\.0\.1:5432\/servora_med/,
    );
    expect(envExample).not.toMatch(
      /^DATABASE_URL=postgresql:\/\/servora@127\.0\.0\.1:5432\/servora_med\s*$/m,
    );
    expect(runbook).toMatch(/password-bearing DATABASE_URL/);
    expect(runbook).toMatch(/root:servora-med.*0640|mode 0640/);
  });

  it('backup env documents matching password material without committing secrets', () => {
    expect(backupEnv).toMatch(/PGPASSWORD=<APP_DB_PASSWORD>/);
    expect(backupEnv).not.toMatch(/PGPASSWORD=[^<\n]{8,}/);
  });

  it('documents data directory ownership for servora-postgres', () => {
    expect(runbook).toMatch(/servora-postgres:servora-postgres/);
    expect(runbook).toMatch(/postgresql@16/);
  });
});
