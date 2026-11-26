import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';

import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresMigrationStore } from '../src/db/index.js';
import { runMigrations } from '../src/db/migrate-runner.js';
import { runOperatorCli } from '../src/db/operator-cli.js';
import { hashPassword, verifyPassword } from '../src/modules/auth/crypto.js';

/**
 * MOD-002 host CLI acceptance (docs/features/operator-module-pilot.md section 4
 * and the section 12 `runOperatorCli(argv, io, pool)` interface): grant,
 * reset-password, revoke, list and reset-after-restore against a real
 * PostgreSQL schema with fake stdio.
 *
 * Assumed exit-code convention: 0 on success, non-zero on any refusal/failure.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../src/db/migrations', import.meta.url));

const PASSWORD = 'Operator-Pass#2026';
const NEW_PASSWORD = 'Operator-New#2027';

let schema = '';
let adminPool: Pool;
let pool: Pool;

beforeAll(async () => {
  if (!databaseUrl) return;
  adminPool = new Pool({ connectionString: databaseUrl });
  schema = `opcli_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  await runMigrations({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
    store: new PostgresMigrationStore(pool),
  });
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

beforeEach(async () => {
  if (!databaseUrl) return;
  await pool.query(`DROP TRIGGER IF EXISTS op_cli_force_audit_failure ON operator_audit_events`);
  await pool.query(
    `TRUNCATE operator_audit_events, operator_sessions, operator_account_capabilities,
       installation_module_state, operator_accounts RESTART IDENTITY CASCADE`,
  );
});

// ---------------------------------------------------------------- helpers

type CliResult = { code: number; stdout: string; stderr: string };

async function cli(argv: string[], stdinText: string | null = null, isTTY = false): Promise<CliResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sink = (target: string[]) => new Writable({
    write(chunk, _encoding, callback) { target.push(chunk.toString()); callback(); },
  });
  const code = await runOperatorCli(argv, {
    stdin: Readable.from(stdinText === null ? [] : [stdinText]),
    stdout: sink(stdout),
    stderr: sink(stderr),
    isTTY,
  }, pool);
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

function grantArgs(email: string, name = 'Operator One', extra: string[] = ['--password-stdin']): string[] {
  return ['grant', '--email', email, '--name', name, ...extra];
}

type AccountRow = {
  id: string; email: string; name: string; password_hash: string; is_active: boolean; version: number;
};

async function account(email: string): Promise<AccountRow | null> {
  const result = await pool.query<AccountRow>(
    `SELECT id, email, name, password_hash, is_active, version
       FROM operator_accounts WHERE lower(email) = lower($1)`, [email]);
  return result.rows[0] ?? null;
}

async function accountCount(): Promise<number> {
  return Number((await pool.query(`SELECT count(*)::int AS n FROM operator_accounts`)).rows[0].n);
}

async function capabilities(id: string): Promise<string[]> {
  const result = await pool.query<{ capability: string }>(
    `SELECT capability FROM operator_account_capabilities WHERE operator_id = $1 ORDER BY capability`, [id]);
  return result.rows.map((r) => r.capability);
}

type AuditRow = {
  event_type: string; actor_kind: string; operator_id: string | null;
  target_operator_id: string | null; old_value: unknown; new_value: unknown;
};

async function audit(eventType?: string): Promise<AuditRow[]> {
  return (await pool.query<AuditRow>(
    `SELECT event_type, actor_kind, operator_id, target_operator_id, old_value, new_value
       FROM operator_audit_events
      WHERE ($1::text IS NULL OR event_type = $1)
      ORDER BY occurred_at, id`, [eventType ?? null])).rows;
}

async function auditCount(): Promise<number> {
  return Number((await pool.query(`SELECT count(*)::int AS n FROM operator_audit_events`)).rows[0].n);
}

/** A live session row for the account (the HTTP layer is covered elsewhere). */
async function seedSession(operatorId: string, tokenHash = randomUUID().replaceAll('-', '')): Promise<void> {
  await pool.query(
    `INSERT INTO operator_sessions (operator_id, token_hash, created_at, expires_at)
     VALUES ($1, $2, now(), now() + interval '2 hours')`, [operatorId, tokenHash]);
}

async function liveSessions(operatorId: string): Promise<number> {
  return Number((await pool.query(
    `SELECT count(*)::int AS n FROM operator_sessions
      WHERE operator_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [operatorId])).rows[0].n);
}

/**
 * Inserts an OPERATOR_LOGIN_SUCCEEDED event directly (the HTTP login is covered in
 * operator-pilot-postgres.test.ts). The contract does not say whether this event type
 * carries target_operator_id, so retry without it if a CHECK refuses it.
 */
async function insertLoginEvent(operatorId: string, at: Date): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO operator_audit_events (actor_kind, operator_id, event_type, target_operator_id, occurred_at)
       VALUES ('OPERATOR', $1, 'OPERATOR_LOGIN_SUCCEEDED', $1, $2)`, [operatorId, at]);
  } catch (error) {
    if ((error as { code?: string }).code !== '23514') throw error;
    await pool.query(
      `INSERT INTO operator_audit_events (actor_kind, operator_id, event_type, occurred_at)
       VALUES ('OPERATOR', $1, 'OPERATOR_LOGIN_SUCCEEDED', $2)`, [operatorId, at]);
  }
}

async function grantOk(email: string, name = 'Operator One', password = PASSWORD): Promise<AccountRow> {
  const result = await cli(grantArgs(email, name), `${password}\n`);
  expect(result.code, result.stderr).toBe(0);
  return (await account(email))!;
}

function expectNoSecretOutput(result: CliResult, ...secrets: string[]) {
  for (const secret of secrets) {
    expect(result.stdout).not.toContain(secret);
    expect(result.stderr).not.toContain(secret);
  }
  expect(result.stdout + result.stderr).not.toMatch(/scrypt\$/);
}

// ---------------------------------------------------------------- grant

describe.skipIf(!databaseUrl)('operator CLI: grant', { timeout: 60_000 }, () => {
  it('creates an active account with MODULE_MANAGEMENT, a hashed password and a HOST_CLI audit event', async () => {
    const result = await cli(grantArgs('  Op.One@Example.COM ', 'Operator One'), `${PASSWORD}\n`);

    expect(result.code, result.stderr).toBe(0);
    const row = (await account('op.one@example.com'))!;
    expect(row.email).toBe('op.one@example.com'); // normalized
    expect(row.name).toBe('Operator One');
    expect(row.is_active).toBe(true);
    expect(row.password_hash).not.toContain(PASSWORD);
    expect(row.password_hash).toMatch(/^scrypt\$v2\$/); // the shared V2 writer
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(true);
    expect(await capabilities(row.id)).toEqual(['MODULE_MANAGEMENT']);
    expectNoSecretOutput(result, PASSWORD);

    const events = await audit();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: 'OPERATOR_GRANTED', actor_kind: 'HOST_CLI', operator_id: null, target_operator_id: row.id,
    });
  });

  it('accepts the password from stdin with or without a trailing newline', async () => {
    await cli(grantArgs('nl@example.com'), `${PASSWORD}\n`);
    await cli(grantArgs('bare@example.com'), PASSWORD);

    for (const email of ['nl@example.com', 'bare@example.com']) {
      const row = (await account(email))!;
      expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(true);
    }
  });

  it('on an already active account it fails with a conflict and changes nothing', async () => {
    const original = await grantOk('dup@example.com');
    const events = await auditCount();

    const result = await cli(grantArgs('DUP@example.com', 'Other Name'), `${NEW_PASSWORD}\n`);

    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(await accountCount()).toBe(1);
    expect(await account('dup@example.com')).toEqual(original); // hash, name, version untouched
    expect(await auditCount()).toBe(events);
    expectNoSecretOutput(result, NEW_PASSWORD, PASSWORD);
  });

  it('reactivates an inactive account with a new password, keeping the identity and keeping old sessions dead', async () => {
    const original = await grantOk('back@example.com');
    await seedSession(original.id);
    expect((await cli(['revoke', '--email', 'back@example.com'])).code).toBe(0);

    const result = await cli(grantArgs('back@example.com'), `${NEW_PASSWORD}\n`);

    expect(result.code, result.stderr).toBe(0);
    const row = (await account('back@example.com'))!;
    expect(row.id).toBe(original.id);
    expect(row.is_active).toBe(true);
    expect(row.password_hash).not.toBe(original.password_hash);
    expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(false);
    expect(await capabilities(row.id)).toEqual(['MODULE_MANAGEMENT']);
    expect(await liveSessions(row.id)).toBe(0);
    expect(await audit('OPERATOR_GRANTED')).toHaveLength(2);
  });

  it('reactivation always requires a new password and never reuses the old one', async () => {
    const original = await grantOk('needs-pw@example.com');
    expect((await cli(['revoke', '--email', 'needs-pw@example.com'])).code).toBe(0);
    const events = await auditCount();

    const result = await cli(grantArgs('needs-pw@example.com', 'Operator One', []), null, false);

    expect(result.code).not.toBe(0);
    const row = (await account('needs-pw@example.com'))!;
    expect(row.is_active).toBe(false);
    expect(row.password_hash).toBe(original.password_hash);
    expect(await auditCount()).toBe(events);
  });

  it.each([
    ['missing --email', ['grant', '--name', 'Op', '--password-stdin']],
    ['missing --name', ['grant', '--email', 'a@example.com', '--password-stdin']],
    ['malformed email', ['grant', '--email', 'not-an-email', '--name', 'Op', '--password-stdin']],
    ['empty name', ['grant', '--email', 'a@example.com', '--name', '  ', '--password-stdin']],
  ])('rejects %s and writes nothing', async (_label, argv) => {
    const result = await cli(argv, `${PASSWORD}\n`);

    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(await accountCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('rejects an empty stdin password and writes nothing', async () => {
    for (const stdin of [null, '', '\n']) {
      const result = await cli(grantArgs('empty@example.com'), stdin);
      expect(result.code).not.toBe(0);
    }
    expect(await accountCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('the account and its audit event commit together: a failing audit insert leaves no account', async () => {
    await pool.query(`
      CREATE OR REPLACE FUNCTION op_cli_force_audit_failure() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'forced operator audit failure'; END;
      $$ LANGUAGE plpgsql`);
    await pool.query(`
      CREATE TRIGGER op_cli_force_audit_failure BEFORE INSERT ON operator_audit_events
      FOR EACH ROW EXECUTE FUNCTION op_cli_force_audit_failure()`);

    const result = await cli(grantArgs('atomic@example.com'), `${PASSWORD}\n`);

    expect(result.code).not.toBe(0);
    expect(await accountCount()).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_account_capabilities`)).rows[0].n).toBe(0);
  });
});

// ---------------------------------------------------------------- password channel

describe.skipIf(!databaseUrl)('operator CLI: the password never comes from argv or env', { timeout: 60_000 }, () => {
  const ENV_KEYS = ['OPERATOR_PASSWORD', 'SERVORA_OPERATOR_PASSWORD', 'PASSWORD', 'BOOTSTRAP_ADMIN_PASSWORD'];
  const saved = new Map<string, string | undefined>();
  beforeEach(() => { for (const key of ENV_KEYS) saved.set(key, process.env[key]); });
  afterEach(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it.each([
    ['--password <value>', ['--password', PASSWORD]],
    ['--password=<value>', [`--password=${PASSWORD}`]],
    ['-p <value>', ['-p', PASSWORD]],
    ['--password-stdin with a positional value', ['--password-stdin', PASSWORD]],
  ])('grant refuses a password on argv (%s)', async (_label, extra) => {
    const stdinAvailable = extra.includes('--password-stdin') ? '\n' : null;
    const result = await cli(
      ['grant', '--email', 'argv@example.com', '--name', 'Argv', ...extra], stdinAvailable);

    expect(result.code).not.toBe(0);
    expect(await accountCount()).toBe(0);
    expect(await auditCount()).toBe(0);
    expectNoSecretOutput(result, PASSWORD);
  });

  it('reset-password refuses a password on argv and keeps the credential and sessions', async () => {
    const row = await grantOk('argv-reset@example.com');
    await seedSession(row.id);

    const result = await cli(['reset-password', '--email', 'argv-reset@example.com', '--password', NEW_PASSWORD]);

    expect(result.code).not.toBe(0);
    expect((await account('argv-reset@example.com'))!.password_hash).toBe(row.password_hash);
    expect(await liveSessions(row.id)).toBe(1);
    expectNoSecretOutput(result, NEW_PASSWORD);
  });

  it('environment variables are never read as a password source', async () => {
    for (const key of ENV_KEYS) process.env[key] = PASSWORD;

    const result = await cli(grantArgs('env@example.com', 'Env', []), null, false);

    expect(result.code).not.toBe(0);
    expect(await accountCount()).toBe(0);
    expectNoSecretOutput(result, PASSWORD);
  });

  it('without a TTY and without --password-stdin no password is generated or printed', async () => {
    const result = await cli(grantArgs('nontty@example.com', 'No Tty', []), null, false);

    expect(result.code).not.toBe(0);
    expect(await accountCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('on an interactive TTY an empty answer generates a password that is printed exactly once', async () => {
    // Contract: "A generated password is offered only on an interactive TTY and
    // printed once there." The offer mechanism is not specified; this encodes the
    // assumption that an empty answer at the prompt accepts the generated password.
    const result = await cli(grantArgs('tty@example.com', 'Tty Op', []), '\n', true);

    expect(result.code, result.stderr).toBe(0);
    const row = (await account('tty@example.com'))!;
    expect(row.is_active).toBe(true);
    const candidates = result.stdout.split(/\s+/).map((t) => t.replace(/^["'`]+|["'`.,;:]+$/g, ''))
      .filter((token) => token.length >= 12);
    const matching: string[] = [];
    for (const token of candidates) {
      if (await verifyPassword(token, row.password_hash)) matching.push(token);
    }
    expect(matching).toHaveLength(1);
    expect(result.stdout.split(matching[0]!).length - 1).toBe(1); // printed once
    expect(result.stderr).not.toContain(matching[0]!);
    expect((await audit('OPERATOR_GRANTED'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- reset-password

describe.skipIf(!databaseUrl)('operator CLI: reset-password', { timeout: 60_000 }, () => {
  it('sets a new password, revokes every session and audits as HOST_CLI', async () => {
    const row = await grantOk('reset@example.com');
    await seedSession(row.id);
    await seedSession(row.id);

    const result = await cli(['reset-password', '--email', 'RESET@example.com', '--password-stdin'], `${NEW_PASSWORD}\n`);

    expect(result.code, result.stderr).toBe(0);
    const updated = (await account('reset@example.com'))!;
    expect(updated.id).toBe(row.id);
    expect(updated.is_active).toBe(true);
    expect(await verifyPassword(NEW_PASSWORD, updated.password_hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, updated.password_hash)).toBe(false);
    expect(await liveSessions(row.id)).toBe(0);
    const revoked = await pool.query(`SELECT count(*)::int AS n FROM operator_sessions WHERE revoked_at IS NOT NULL`);
    expect(revoked.rows[0].n).toBe(2);
    const events = await audit('OPERATOR_PASSWORD_RESET');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_kind: 'HOST_CLI', operator_id: null, target_operator_id: row.id });
    expectNoSecretOutput(result, NEW_PASSWORD, PASSWORD);
  });

  it('does not touch other accounts', async () => {
    const target = await grantOk('target@example.com');
    const bystander = await grantOk('bystander@example.com');
    await seedSession(target.id);
    await seedSession(bystander.id);

    await cli(['reset-password', '--email', 'target@example.com', '--password-stdin'], `${NEW_PASSWORD}\n`);

    expect(await account('bystander@example.com')).toEqual(bystander);
    expect(await liveSessions(bystander.id)).toBe(1);
  });

  it('fails for an unknown email without writing anything', async () => {
    const result = await cli(['reset-password', '--email', 'ghost@example.com', '--password-stdin'], `${NEW_PASSWORD}\n`);

    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(await accountCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('fails without --email or without a password and keeps the old credential', async () => {
    const row = await grantOk('keep@example.com');
    await seedSession(row.id);
    const events = await auditCount();

    expect((await cli(['reset-password', '--password-stdin'], `${NEW_PASSWORD}\n`)).code).not.toBe(0);
    expect((await cli(['reset-password', '--email', 'keep@example.com', '--password-stdin'], '\n')).code).not.toBe(0);
    expect((await cli(['reset-password', '--email', 'keep@example.com'], null, false)).code).not.toBe(0);

    expect((await account('keep@example.com'))!.password_hash).toBe(row.password_hash);
    expect(await liveSessions(row.id)).toBe(1);
    expect(await auditCount()).toBe(events);
  });
});

// ---------------------------------------------------------------- revoke

describe.skipIf(!databaseUrl)('operator CLI: revoke', { timeout: 60_000 }, () => {
  it('deactivates the account, revokes its sessions and audits as HOST_CLI', async () => {
    const row = await grantOk('gone@example.com');
    await seedSession(row.id);
    const bystander = await grantOk('stays@example.com');
    await seedSession(bystander.id);

    const result = await cli(['revoke', '--email', 'Gone@Example.com']);

    expect(result.code, result.stderr).toBe(0);
    expect((await account('gone@example.com'))!.is_active).toBe(false);
    expect(await liveSessions(row.id)).toBe(0);
    expect((await account('stays@example.com'))!.is_active).toBe(true);
    expect(await liveSessions(bystander.id)).toBe(1);
    const events = await audit('OPERATOR_REVOKED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_kind: 'HOST_CLI', operator_id: null, target_operator_id: row.id });
    // The account row is kept (audit foreign keys are RESTRICT): revoke never deletes.
    expect(await accountCount()).toBe(2);
  });

  it('fails for an unknown email without writing anything', async () => {
    const result = await cli(['revoke', '--email', 'ghost@example.com']);

    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(await auditCount()).toBe(0);
  });

  it('requires --email', async () => {
    await grantOk('x@example.com');
    const events = await auditCount();

    expect((await cli(['revoke'])).code).not.toBe(0);
    expect((await account('x@example.com'))!.is_active).toBe(true);
    expect(await auditCount()).toBe(events);
  });
});

// ---------------------------------------------------------------- list

describe.skipIf(!databaseUrl)('operator CLI: list', { timeout: 60_000 }, () => {
  it('prints email, name, active state and capabilities without secrets, and is read-only', async () => {
    const a = await grantOk('alpha@example.com', 'Alpha Operator');
    await grantOk('beta@example.com', 'Beta Operator');
    expect((await cli(['revoke', '--email', 'beta@example.com'])).code).toBe(0);
    await seedSession(a.id, 'live-session-token-hash');
    const accountsBefore = (await pool.query(`SELECT * FROM operator_accounts ORDER BY email`)).rows;
    const eventsBefore = await auditCount();

    const result = await cli(['list']);

    expect(result.code, result.stderr).toBe(0);
    const alphaLine = result.stdout.split('\n').find((line) => line.includes('alpha@example.com'))!;
    const betaLine = result.stdout.split('\n').find((line) => line.includes('beta@example.com'))!;
    expect(alphaLine).toBeDefined();
    expect(betaLine).toBeDefined();
    expect(alphaLine).toContain('Alpha Operator');
    expect(alphaLine).toContain('MODULE_MANAGEMENT');
    expect(betaLine).toContain('Beta Operator');
    expectNoSecretOutput(result, PASSWORD, 'live-session-token-hash');
    expect(result.stdout).not.toContain(a.password_hash);
    // Read-only: no account, session or audit change.
    expect((await pool.query(`SELECT * FROM operator_accounts ORDER BY email`)).rows).toEqual(accountsBefore);
    expect(await auditCount()).toBe(eventsBefore);
  });

  it('shows the last successful login derived from the audit table, per account', async () => {
    const withLogin = await grantOk('login@example.com');
    await grantOk('never@example.com');
    for (const at of [new Date('2026-03-01T08:00:00.000Z'), new Date('2026-04-15T10:30:00.000Z')]) {
      await insertLoginEvent(withLogin.id, at);
    }

    const result = await cli(['list']);

    expect(result.code, result.stderr).toBe(0);
    const loginLine = result.stdout.split('\n').find((line) => line.includes('login@example.com'))!;
    const neverLine = result.stdout.split('\n').find((line) => line.includes('never@example.com'))!;
    expect(loginLine).toMatch(/2026-04-15|15[./]04[./]2026/); // most recent, not the earlier one
    expect(loginLine).not.toMatch(/2026-03-01|01[./]03[./]2026/);
    expect(neverLine).not.toMatch(/2026-0[34]/);
  });

  it('succeeds with no operators', async () => {
    const result = await cli(['list']);

    expect(result.code, result.stderr).toBe(0);
    expect(await auditCount()).toBe(0);
  });
});

// ---------------------------------------------------------------- reset-after-restore

describe.skipIf(!databaseUrl)('operator CLI: reset-after-restore', { timeout: 60_000 }, () => {
  it('deactivates every account, revokes every session and audits with the SYSTEM actor', async () => {
    const a = await grantOk('a@example.com');
    const b = await grantOk('b@example.com');
    await seedSession(a.id);
    await seedSession(b.id);

    const result = await cli(['reset-after-restore']);

    expect(result.code, result.stderr).toBe(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM operator_accounts WHERE is_active`)).rows[0].n).toBe(0);
    expect(await liveSessions(a.id) + await liveSessions(b.id)).toBe(0);
    const events = await audit('OPERATOR_ACCESS_RESET_BY_RESTORE');
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) expect(event).toMatchObject({ actor_kind: 'SYSTEM', operator_id: null });
    expectNoSecretOutput(result, PASSWORD);
  });

  it('works with no operators and does not create accounts', async () => {
    const result = await cli(['reset-after-restore']);

    expect(result.code, result.stderr).toBe(0);
    expect(await accountCount()).toBe(0);
  });

  it('re-granting afterwards needs a fresh password (old credential stays dead)', async () => {
    const original = await grantOk('again@example.com');
    await cli(['reset-after-restore']);

    const result = await cli(grantArgs('again@example.com'), `${NEW_PASSWORD}\n`);

    expect(result.code, result.stderr).toBe(0);
    const row = (await account('again@example.com'))!;
    expect(row.id).toBe(original.id);
    expect(row.is_active).toBe(true);
    expect(await verifyPassword(NEW_PASSWORD, row.password_hash)).toBe(true);
    expect(await verifyPassword(PASSWORD, row.password_hash)).toBe(false);
  });
});

// ---------------------------------------------------------------- dispatcher

describe.skipIf(!databaseUrl)('operator CLI: dispatcher', { timeout: 60_000 }, () => {
  it.each([
    ['no command', []],
    ['unknown command', ['frobnicate']],
    ['delete (accounts are never deleted)', ['delete', '--email', 'a@example.com']],
  ])('%s exits non-zero with a message and writes nothing', async (_label, argv) => {
    const result = await cli(argv);

    expect(result.code).not.toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(await accountCount()).toBe(0);
    expect(await auditCount()).toBe(0);
  });

  it('leaves the caller-owned pool open for the next command', async () => {
    await grantOk('pool@example.com');

    expect((await cli(['list'])).code).toBe(0);
    expect((await pool.query('SELECT 1 AS ok')).rows[0].ok).toBe(1);
  });

  it('a pre-hashed fixture credential verifies with the same crypto the CLI used', async () => {
    // Guards the verification helper used above against false greens.
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(NEW_PASSWORD, hash)).toBe(false);
  });
});
