# Local server test environment (fail-closed)

`npm test` in `server/` refuses to start Vitest unless the environment satisfies
the canonical full-server test contract. The goal is narrow and deliberate:

> A wrong local test environment must never produce a misleading product-test
> result, and must never silently mask an assertion.

A stale database, a missing build, a PostgreSQL 16 toolchain or a
password-less connection string used to surface as confusing product-test
failures — or worse, as a green run that never executed the assertion it
claimed to. Those paths are now closed **before** Vitest is spawned.

## Canonical contract

| Element | Requirement |
| --- | --- |
| `NODE_ENV` | forced to `test` by the runner |
| `TEST_DATABASE_URL` | required, explicit, password-bearing, loopback, isolated database name |
| PostgreSQL **server** major | exactly `17` |
| `psql` / `pg_dump` / `pg_restore` | major `17` when resolvable |
| Database schema | exact repository migration head |
| Build artifacts | present and fresh (`dist/db/migrate.js`, `dist/db/schema-check.js`, `dist/db/migrations`) |
| Silent environment skip | forbidden |

## Running the suite

```bash
cd server

# canonical: build first, then test
npm run build && npm test -- --run
```

`TEST_DATABASE_URL` may live in `server/.env` (the test script loads it with
`--env-file-if-exists=.env`) or be supplied explicitly in the shell. There is no
fallback: if it is absent the run stops with `TEST_ENV_TEST_DATABASE_URL_REQUIRED`.

Use placeholders like this in any local notes or environment file — never commit
real credentials:

```text
TEST_DATABASE_URL=postgresql://<test-user>:<test-password>@127.0.0.1:5432/servora_med_test_<suffix>
```

## Provisioning a test database (agents and humans)

When `TEST_DATABASE_URL` is missing, do not invent a role, database or password,
and do not report the server suite as "not run" before trying this. In the
worktree you are testing:

```bash
cd server
grep -q '^TEST_DATABASE_URL=' .env 2>/dev/null && echo "already configured"
npm run build
npm run test:db -- provision --suffix <suffix> --write-env
npm test -- --run
```

- `<suffix>`: 1–40 lowercase letters, digits or underscores naming this
  worktree or task, for example `job009_20261120`. One suffix per worktree.
- `provision` connects to the **loopback** PostgreSQL 17 as the local admin
  (`TEST_DB_ADMIN_URL`, default `postgresql://127.0.0.1:5432/postgres` as the OS
  user), creates `servora_med_test_<suffix>` if missing and migrates it to the
  repository head with `dist/db/migrate.js`. It never drops, truncates or resets
  an existing database, and it refuses non-loopback hosts and the protected or
  shared names.
- Every test database is owned by one shared login role,
  `servora_med_test_runner`. It is a superuser for parity with CI, which runs the
  suite as the service superuser (some tests use `DISABLE TRIGGER ALL`,
  `pg_terminate_backend` or create roles and databases). It exists only on the
  local loopback development cluster.
- The role password is generated on first use and stored outside the repository
  in `~/.config/servora-med/test-db-runner.secret` (or under `$XDG_CONFIG_HOME`),
  mode `600`. It is never printed; diagnostics show a redacted URL.
- `--write-env` appends `TEST_DATABASE_URL` to the gitignored `server/.env` only
  when the key is absent. If the key already names another database, the
  command stops before creating anything (`TEST_DB_ENV_CONFLICT`); edit the line
  yourself if this worktree should switch databases.
- Re-running `provision` for the same suffix is safe: it only applies pending
  migrations, which is also the remedy for `TEST_ENV_SCHEMA_NOT_COMPATIBLE`
  after a branch adds a migration.

Housekeeping, local only:

```bash
npm run test:db -- list                        # isolated test databases, owner, size
npm run test:db -- drop --suffix <suffix> --yes  # drop one; fails while connections are open
```

Report the server suite as **not run** only when provisioning itself fails, and
quote the `TEST_DB_*` code it printed.

Known local differences from CI (observed 2026-11-20; report them, do not
"fix" product code for them):

- CI sets `DATABASE_URL` to the same test database. A few tests call
  `loadConfig()` and fail with `DATABASE_URL is required` when it is unset. In a
  worktree whose `server/.env` has no `DATABASE_URL`, run
  `DATABASE_URL="$TEST_DATABASE_URL" npm test -- --run` (with the value exported
  from `.env`). Never point it at the development database `servora_med`.
- A default Homebrew cluster trusts loopback connections (`pg_hba.conf`
  `trust`), so passwords are not checked locally. The wrong-password case in
  `tests/db-auth-contract.test.ts` therefore fails locally and passes in CI.

| Code | Remedy |
| --- | --- |
| `TEST_DB_ADMIN_UNAVAILABLE` | Start the local PostgreSQL 17 server, or set `TEST_DB_ADMIN_URL` to a loopback superuser connection. |
| `TEST_DB_POSTGRES_MAJOR_MISMATCH` | The admin connection reached a non-17 server; point it at PostgreSQL 17. |
| `TEST_DB_BUILD_MISSING` | Run `npm run build`. |
| `TEST_DB_SUFFIX_INVALID` | Use 1–40 lowercase letters, digits or underscores. |
| `TEST_DB_RUNNER_SECRET_MISSING` / `TEST_DB_RUNNER_AUTH_FAILED` | The role exists but the secret file is missing or does not match. Ask the machine owner; do not create another role. |
| `TEST_DB_ENV_CONFLICT` | `server/.env` already names another test database; resolve it explicitly. |
| `TEST_DB_MIGRATION_FAILED` | Read the migration output; the database is kept for inspection. |

## Database identity

The database name is parsed structurally from the URL path, not substring
matched, so `servora_med_test` is never confused with `servora_med`.

| Name | Local (`CI` unset) | `CI=true` |
| --- | --- | --- |
| `servora_med`, `servora_med_staging` | refused | refused |
| `servora_med_test` (shared, long-lived) | refused | allowed (ephemeral service-owned) |
| `servora_med_test_<non-empty-suffix>` | allowed | allowed |

Locally, each worktree must pick its own suffix, for example
`servora_med_test_wd1`. This is what prevents two worktrees from silently
sharing one persistent database — the original wrong-database defect. The
suffix does not have to be globally unique; it only has to be explicit.

CI owns and destroys its own `servora_med_test` service, so the shared name
remains valid there.

## Credentials

A non-empty username **and** a non-empty password are required, mirroring the
enforced CI authentication contract. A URL such as
`postgresql://emrah@127.0.0.1:5432/...` is not canonical parity and is refused.
Passwords are never printed: diagnostics show a redacted URL
(`postgresql://user@host:port/db`).

## PostgreSQL 17

Canonical full-server test mode requires PostgreSQL **17** on both the server and
the client tools. `16` is not "close enough": accepting a 16/16 combination would
let a non-parity environment report a green run.

To satisfy this, run a PostgreSQL 17 server and expose the 17 client tools. The
existing binary overrides are honoured:

```text
PSQL_BIN=/opt/homebrew/opt/postgresql@17/bin/psql
PG_DUMP_BIN=/opt/homebrew/opt/postgresql@17/bin/pg_dump
PG_RESTORE_BIN=/opt/homebrew/opt/postgresql@17/bin/pg_restore
```

Do not add a 17 toolchain to `PATH` globally and do not start/stop system
services as part of a test run. If a tool is not resolvable the preflight reports
a note and the tests that need it are **skipped**, never passed.

## Schema head

The preflight compares the applied migrations in `TEST_DATABASE_URL` against the
repository migration catalog using the same compatibility primitives the release
uses. Only `COMPATIBLE` continues. `BEHIND`, `EMPTY`, `AHEAD`, `DIVERGED`, a
missing `schema_migrations` table and an unreachable database are all hard
failures.

The preflight is **read-only**. It never migrates, resets, truncates or drops
anything, so a stale database produces one clear failure instead of dozens of
missing-table failures inside unrelated test files. Migrating the test database
remains a separate, explicit operator action.

### Migration history ordering

The migration store, startup/schema-check guard, health readiness and deployment
probe read history in canonical `version ASC` order. Zero-padded identifiers are
validated against the contiguous repository catalog. Exact history and a valid
prefix are evaluated consistently even when `applied_at` timestamps interleave.
Missing-middle, alternate-branch, duplicate-number, invalid and future versions
remain incompatible; the deployment probe emits a classification that its caller
must enforce, while startup/schema-check and readiness refuse incompatible state.

Neither sorted versions nor `applied_at` prove the actual historical execution or
commit order. The current schema has no independent trustworthy sequence record.
The PostgreSQL reader regression suite verifies membership/prefix compatibility
and read-only behavior, including a pre-056 release catalog refusing a 056 DB; it
does not certify historical execution order. Adding such a record requires a
separate design and migration approval.

This four-reader acceptance scope excludes restore/recovery. The separate
`ops/scripts/production-recovery.sh` and backup restore adapter still have
timestamp-based history/head reads. Their ordering must be assessed in the
separately approved 056 forward-recovery work; this test is not restore evidence.

## Build freshness

Some tests execute `server/dist` directly, so build output is part of the test
contract. The preflight requires the three artifacts above and fails if they are
missing or older than their source inputs. The remedy is always:

```bash
npm run build
```

`npm run build && npm test -- --run` is the canonical command for this reason.

## Skip honesty

An unexecuted test is not a passing test. When tooling or a privilege is absent,
the affected assertion reports as **SKIPPED**, never as passed — a bare `return`
inside a test body is not an acceptable substitute.

## Failure codes

| Code | Remedy |
| --- | --- |
| `TEST_ENV_TEST_DATABASE_URL_REQUIRED` | Set `TEST_DATABASE_URL` explicitly (no `DATABASE_URL` fallback). |
| `TEST_ENV_TEST_DATABASE_URL_MALFORMED` | Use a `postgresql://` or `postgres://` URL. |
| `TEST_ENV_TEST_DATABASE_NAME_REQUIRED` | Include an explicit database name in the URL path. |
| `TEST_ENV_TEST_DATABASE_URL_USERNAME_REQUIRED` | Add a username to the URL. |
| `TEST_ENV_TEST_DATABASE_URL_PASSWORD_REQUIRED` | Add a password to the URL. |
| `TEST_ENV_PROTECTED_DATABASE_NAME` | Never target `servora_med` or `servora_med_staging`. |
| `TEST_ENV_SHARED_TEST_DATABASE_NAME` | Use an isolated name: `servora_med_test_<suffix>`. |
| `TEST_ENV_NON_LOOPBACK_HOST` | Point at `localhost`, `127.0.0.1` or `::1`. |
| `TEST_ENV_DATABASE_UNAVAILABLE` | The database is unreachable — start PostgreSQL 17 and check the URL. |
| `TEST_ENV_POSTGRES_MAJOR_MISMATCH` | Run a PostgreSQL **17** server; a 16 server is refused. |
| `TEST_ENV_TOOL_MAJOR_MISMATCH` | Point `PSQL_BIN` / `PG_DUMP_BIN` / `PG_RESTORE_BIN` at major 17. |
| `TEST_ENV_MIGRATION_CATALOG_INVALID` | The repository migration catalog is empty or unreadable. |
| `TEST_ENV_SCHEMA_HISTORY_MISSING` | The database has no `schema_migrations`; apply migrations explicitly. |
| `TEST_ENV_SCHEMA_NOT_COMPATIBLE` | Apply the repository migration head to the test database. |
| `TEST_ENV_BUILD_MISSING` | Run `npm run build`. |
| `TEST_ENV_BUILD_STALE` | Run `npm run build`. |

## What this does not do

This contract closes **masking**. The preflight itself does not provision
anything: a clean checkout with no test database fails clearly rather than
creating one automatically. Provisioning is the separate, explicit
`npm run test:db -- provision` step described above; it is never invoked by
`npm test`.

## Related

- [staging-database-runbook.md](./staging-database-runbook.md) — staging bootstrap and migration head verification.
- [staging-contract.md](./staging-contract.md) — staging environment contract.
- [production-deployment.md](./production-deployment.md) — production deploy and health checks.
