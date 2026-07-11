# Servora-Med Slice 00 Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a greenfield, testable Fastify/TypeScript server and React/Vite web shell with configuration validation, generic health, PostgreSQL migration infrastructure, safe logging defaults, and operational documentation.

**Architecture:** Server boot is split into configuration, database, migrations, app construction, health module, and process entry point. Web is a minimal accessible product shell, not a feature screen. Production behavior is implemented test-first; package and TypeScript configuration are setup prerequisites.

**Tech Stack:** Node.js 22.12+, Fastify 5, PostgreSQL driver 8, TypeScript 5.9, Vitest 4, React 19, Vite 8

## Global Constraints

- Documentation and identifiers are English; user-facing copy may be Turkish.
- Do not copy Servora-POS restaurant domain code or migrations.
- Do not implement auth, roles, JobCard, WebSocket, stock, accounting, or attachments.
- Do not add UI libraries, routers, state libraries, ORMs, schema libraries, or animation dependencies.
- Use Node.js `>=22.12.0`, required by the selected Vite toolchain.
- Every production function is introduced after a focused failing test.
- Configuration and package manifests are setup prerequisites and may precede behavioral tests.
- Root is not a Git repository; do not initialize Git or claim commits.

---

### Task 1: Create package and compiler foundations

**Files:**
- Create: `.gitignore`
- Create: `server/package.json`
- Create: `server/tsconfig.json`
- Create: `server/vitest.config.ts`
- Create: `server/.env.example`
- Create: `server/scripts/copy-migrations.mjs`
- Create: `web/package.json`
- Create: `web/tsconfig.json`
- Create: `web/tsconfig.node.json`
- Create: `web/vite.config.ts`
- Create: `web/index.html`

**Interfaces:**
- Produces server scripts `dev`, `build`, `start`, `migrate`, and `test`
- Produces web scripts `dev`, `build`, `preview`, and `test`

- [x] **Step 1: Add minimal package manifests**

Server runtime dependencies: `fastify@5.10.0`, `pg@8.22.0`. Server development dependencies: `@types/node@22.20.1`, `@types/pg@8.20.0`, `tsx@4.23.0`, `typescript@5.9.3`, `vitest@4.1.10`.

Web runtime dependencies: `react@19.2.7`, `react-dom@19.2.7`. Web development dependencies: `@types/node@22.20.1`, `@types/react@19.2.17`, `@types/react-dom@19.2.3`, `@vitejs/plugin-react@6.0.3`, `typescript@5.9.3`, `vite@8.1.4`, `vitest@4.1.10`.

- [x] **Step 2: Add strict TypeScript and Vitest configuration**

Server compiles `src/` to `dist/` with NodeNext modules and strict mode. Web uses bundler resolution, React JSX, no emit, and a Node project reference for Vite config. Vitest runs server tests in Node and web render tests in Node.

- [x] **Step 3: Add environment example and migration copy script**

Required environment values:

```text
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgresql://servora:servora@localhost:5432/servora_med
LOG_LEVEL=info
```

The build copies `src/db/migrations/` to `dist/db/migrations/` without adding a domain migration.

- [x] **Step 4: Install dependencies**

Run separately:

```bash
cd server && npm install
cd web && npm install
```

Expected: `server/package-lock.json` and `web/package-lock.json` are generated with no install error.

---

### Task 2: Implement configuration validation with TDD

**Files:**
- Create: `server/tests/config.test.ts`
- Create: `server/src/config.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- `AppConfig`: nodeEnv, host, port, databaseUrl, logLevel

- [x] **Step 1: Write failing configuration tests**

Tests prove valid parsing, required `DATABASE_URL`, integer port bounds, accepted environments, and default values.

- [x] **Step 2: Run RED**

```bash
cd server && npm test -- --run tests/config.test.ts
```

Expected: failure because `src/config.ts` does not exist.

- [x] **Step 3: Implement the smallest parser**

Use local functions, no validation dependency. Reject missing database URL, invalid environment, invalid port, and empty host/log level with clear startup errors.

- [x] **Step 4: Run GREEN**

```bash
cd server && npm test -- --run tests/config.test.ts
```

Expected: all configuration tests pass.

---

### Task 3: Implement error mapping and generic health with TDD

**Files:**
- Create: `server/tests/errors.test.ts`
- Create: `server/tests/app.test.ts`
- Create: `server/src/errors/index.ts`
- Create: `server/src/modules/health/service.ts`
- Create: `server/src/modules/health/handlers.ts`
- Create: `server/src/modules/health/routes.ts`
- Create: `server/src/app.ts`

**Interfaces:**
- Produces: `AppError`, `toErrorResponse(error)`, `buildApp(config)`
- Health: `GET /api/health` returns only `{ status: 'ok' }`

- [x] **Step 1: Write failing error-mapping test**

Test canonical application error output and safe fallback output without stack or internal message exposure.

- [x] **Step 2: Run error RED, implement minimal mapper, run GREEN**

```bash
cd server && npm test -- --run tests/errors.test.ts
```

- [x] **Step 3: Write failing health route test**

Construct the app with test config, inject `GET /api/health`, and assert status 200 plus exact generic body.

- [x] **Step 4: Run health RED**

```bash
cd server && npm test -- --run tests/app.test.ts
```

Expected: failure because app and health module do not exist.

- [x] **Step 5: Implement app and health module**

Fastify logger redacts authorization, cookie, set-cookie, password, currentPassword, newPassword, token, and sessionToken paths. Register the health module under `/api/health` and the safe error handler. Do not register CORS, rate limits, static serving, or domain routes in Slice 00.

- [x] **Step 6: Run health GREEN**

```bash
cd server && npm test -- --run tests/app.test.ts
```

Expected: generic health test passes with no database access.

---

### Task 4: Implement PostgreSQL migration runner with TDD

**Files:**
- Create: `server/tests/migrate-runner.test.ts`
- Create: `server/src/db/index.ts`
- Create: `server/src/db/migrate-runner.ts`
- Create: `server/src/db/migrate.ts`
- Create: `server/src/db/migrations/.gitkeep`

**Interfaces:**
- Produces: `createDatabase(databaseUrl)`, `runMigrations(options)`, `closeDatabase()`
- Runner reads sorted `.sql` files, skips recorded versions, and applies each new file transactionally

- [x] **Step 1: Write failing migration-runner test**

Use a temporary real directory and an in-memory test implementation of the narrow database interface. Assert lexical order, skip behavior, transactional apply call, and empty-directory behavior.

- [x] **Step 2: Run migration RED**

```bash
cd server && npm test -- --run tests/migrate-runner.test.ts
```

Expected: failure because the runner does not exist.

- [x] **Step 3: Implement minimal database adapter and runner**

The PostgreSQL adapter creates `schema_migrations`, lists versions, and applies one migration with `BEGIN`, migration SQL, version insert, `COMMIT`, and rollback on error. The runner owns deterministic file discovery and logging.

- [x] **Step 4: Run migration GREEN**

```bash
cd server && npm test -- --run tests/migrate-runner.test.ts
```

Expected: runner tests pass without requiring a live PostgreSQL instance.

---

### Task 5: Implement process entry and accessible web shell with TDD

**Files:**
- Create: `server/src/index.ts`
- Create: `web/tests/App.test.tsx`
- Create: `web/src/App.tsx`
- Create: `web/src/main.tsx`
- Create: `web/src/styles.css`

**Interfaces:**
- Server entry runs migrations before listening and closes Fastify/database on termination
- Web `App` renders one main landmark, one level-one heading, and scaffold status copy

- [x] **Step 1: Add server entry**

This file is process wiring: load config, create database, run migrations, build app, listen, register `SIGINT` and `SIGTERM`, and fail startup with a non-zero exit code. No domain behavior is added.

- [x] **Step 2: Write failing web render test**

Use `react-dom/server` to render `<App />`. Assert the main landmark, product heading, and setup status copy.

- [x] **Step 3: Run web RED**

```bash
cd web && npm test -- --run tests/App.test.tsx
```

Expected: failure because `src/App.tsx` does not exist.

- [x] **Step 4: Implement the smallest accessible shell**

Render a light-first app shell with Turkish user-facing copy, semantic landmarks, visible text, and no fake dashboard data. CSS uses seed design direction without claiming final color/font tokens.

- [x] **Step 5: Run web GREEN**

```bash
cd web && npm test -- --run tests/App.test.tsx
```

Expected: render test passes.

---

### Task 6: Document and verify Slice 00

**Files:**
- Create: `README.md`
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `DESIGN.md`
- Modify: `docs/superpowers/plans/2026-07-10-slice-00-scaffold.md`

**Interfaces:**
- Produces operational setup/run/migrate/test documentation and verified completion record

- [x] **Step 1: Write operational README**

Document prerequisites, environment setup, database creation assumption, install, development commands, migration command, build/test commands, and the deliberate absence of auth/domain behavior.

- [x] **Step 2: Align version floor and design seed status**

Update architecture Node floor from 22+ to 22.12+. Keep `DESIGN.md` marked as seed; do not run scan mode until shared UI tokens/components exist.

- [x] **Step 3: Run full verification**

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm test -- --run
cd web && npm run build
```

Expected: all commands exit 0 with no test failures.

- [x] **Step 4: Run scope and secret scan**

Search new `server/` and `web/` files for restaurant terms, raw credentials, token logging, and forbidden domain modules. Inspect expected `.env.example` placeholders manually.

- [x] **Step 5: Record verification results**

Mark plan steps complete and append exact command outcomes. Do not create a Git commit because the workspace is not a repository.

## Validation Results

Completed on 2026-07-11.

- Passed: `cd server && npm run build`
- Passed: `cd server && npm test -- --run`, 4 files and 15 tests
- Passed: `cd web && npm test -- --run`, 1 file and 1 test
- Passed: `cd web && npm run build`
- Passed: `cd server && npm audit --omit=dev`, 0 vulnerabilities
- Passed: `cd web && npm audit --omit=dev`, 0 vulnerabilities
- Passed: application source/test scope scan found no restaurant or deferred-domain terms
- Passed: secret-bearing direct log-call scan found no matches
- Passed: lockfile, redaction, startup validation, and build-artifact checks
- Not run: live PostgreSQL migration command because no local database service or `DATABASE_URL` was placed in task scope; migration file ordering and transaction/rollback behavior are covered by tests
- Not run: Git diff or commit because the workspace root is not a Git repository
