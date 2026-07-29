# Job Lifecycle Operational Notes Implementation Plan

**Status:** Checkpoint A authorized; later checkpoints not authorized  
**Base:** `fc0f93b3f5ca4157161552fef3a30e00d34baa4c`

## Safety and preconditions

Before implementation:

1. Fetch and verify exact `origin/main`.
2. Verify PR #78 and resulting-main CI.
3. Verify no overlapping open PR.
4. Verify the next migration number.
5. Create an isolated worktree from exact main.
6. Run focused server tests with disposable PostgreSQL and focused web tests.

Never modify the main worktree, delete existing branches/worktrees, rewrite
history, or expand into Checkpoint B/C.

## Checkpoint A — Operational-note persistence and read model

### Objective

Extend the existing JobNotes owner with immutable creation context, stable
chronological cursor reads, normalized standalone-note authorization, metadata UI,
and Overview privacy repair.

### Scope

- Additive operational-note migration.
- Version 1 author name/role and workflow-stage snapshots.
- `GENERAL` context and explicit `NOTE_ADDED` activity relation.
- Explicit version 0 legacy representation.
- Latest-first transport with ascending response and compound older cursor.
- Canonical ADD_NOTE policy normalization.
- Existing JobNotes metadata UI and stable older-page prepend.
- Overview body/body-derived preview removal.
- Focused/full validation and real-runtime acceptance.
- Draft PR only.

### Non-goals

- Any lifecycle handler, mandatory transition note, or workflow redesign.
- Notifications, Web Push, or realtime note projection.
- Follow-up JobCards.
- Administrative redaction.
- Note edit/delete.
- Capability flag, dependency, or Manager team-scope change.
- Staging or production.

### Likely files

```text
server/src/db/migrations/019_job_card_operational_note_context.sql
server/src/modules/job-cards/types.ts
server/src/modules/job-cards/repository.ts
server/src/modules/job-cards/notes-service.ts
server/src/modules/job-cards/policy.ts
server/src/modules/job-cards/handlers.ts
server/src/modules/overview/types.ts
server/src/modules/overview/repository.ts
server/tests/job-card-notes.test.ts
server/tests/job-card-policy.test.ts
server/tests/job-card-routes.test.ts
server/tests/job-card-workspace-schema.test.ts
server/tests/overview-repository.test.ts
web/src/jobs/jobs-api.ts
web/src/jobs/JobNotes.tsx
web/src/services/overview-api.ts
web/src/overview/OverviewPage.tsx
web/tests/job-notes.test.tsx
web/tests/jobs-api.test.ts
web/tests/overview-api.test.ts
web/tests/overview-page.test.tsx
```

Only files proven necessary by the current repository may change.

### TDD sequence

Use vertical red-green-refactor slices:

1. Migration versioning and integrity behavior.
2. Public standalone-note creation response with snapshots/activity relation.
3. Authorization matrix.
4. Initial latest page and compound older cursor.
5. Overview bodyless response.
6. Web API parsing and version 1/legacy rendering.
7. Older-page prepend and live-tail append.
8. Runtime acceptance regressions.

Do not write all tests before implementation.

### Migration

Use `019_job_card_operational_note_context.sql` only if `018_messaging.sql`
remains the last exact-base migration.

Add:

```text
author_name_snapshot
author_role_snapshot
workflow_stage
context
related_activity_id
record_version
```

Version 0 permits only legacy missing snapshots. Version 1 requires valid canonical
role, stage, `GENERAL` context, nonblank name, and activity relationship.

Prefer a composite organization/JobCard/activity FK if the existing activity schema
can support it safely. Do not backfill guessed creation facts.

### Authorization

- Admin/Manager: all statuses in existing same-organization scope.
- Assigned Staff: `ACCEPTED`, `IN_PROGRESS`, `REVISION_REQUESTED`.
- Assigned Staff `NEW`, review, completed, cancelled: denied.
- Unassigned Staff: hidden `404`.
- Disabled actor: denied by existing authentication.

Policy remains backend-owned and is projected through existing `allowedActions`.

### Pagination

Request contract:

```text
limit
beforeCreatedAt?
beforeId?
```

Both cursor members are required together. Initial query selects latest rows with
descending transport order. Older query uses a strict compound `<` boundary.
Responses are reversed to ascending display order and include a compound
`nextCursor`/older cursor only when more records exist.

The web prepends older items. A successful append extends the current live tail,
but does not reset a viewer who is browsing older history.

### Privacy

Remove `preview` and note body selection from Overview repository, DTO, parser, UI,
and tests. If recent-note rows remain, they are generic and bodyless.

Activity metadata remains `{noteId}` only. No notification or realtime behavior is
added.

### Focused validation

```bash
cd server
TEST_DATABASE_URL=<disposable> npm test -- --run \
  tests/job-card-notes.test.ts \
  tests/job-card-policy.test.ts \
  tests/job-card-routes.test.ts \
  tests/job-card-workspace-schema.test.ts \
  tests/overview-repository.test.ts

cd ../web
npm test -- --run \
  tests/job-notes.test.tsx \
  tests/jobs-api.test.ts \
  tests/overview-api.test.ts \
  tests/overview-page.test.tsx
```

### Full validation

```bash
cd server
TEST_DATABASE_URL=<disposable> npm test -- --run
npm run build
npm audit --audit-level=high

cd ../web
npm test -- --run
npm run build
npm run bundle:check
npm run smoke:responsive
npm run audit:high

cd ..
git diff --check
rg -n 'workspace-message' web/src
```

`workspace-message` must return no matches.

### Runtime/browser scenarios

Use a disposable PostgreSQL database, all migrations, real Fastify, real Vite, and
synthetic users.

Verify:

1. Assigned Staff adds a note in `IN_PROGRESS`.
2. Manager sees frozen name, role, and stage.
3. Profile changes do not change the snapshot.
4. Disabled author remains visible.
5. Unassigned Staff read/write returns `404`.
6. Assigned Staff cannot add a standalone note in `NEW`.
7. Manager annotates a completed JobCard.
8. Initial latest page is chronological.
9. Older notes prepend without duplicate/gap.
10. Overview contains no body or preview.
11. HTML-like input renders as text.
12. 390 px, 200% text, and 400% reflow remain usable.

### Evidence

Store only synthetic evidence under:

```text
docs/evidence/job-operational-notes/checkpoint-a/
```

The README records runtime configuration, assertions, source capture SHA, and
evidence commit SHA separately.

### Commit boundary

```text
feat: enrich JobCard operational notes
```

Exit criteria:

- Focused and full validation pass.
- Real PostgreSQL migration and transaction checks pass.
- Runtime/API/browser acceptance passes.
- No Checkpoint B/C code exists.
- Working tree contains only intended evidence before the evidence commit.

## Checkpoint B — Not authorized

Future lifecycle integration uses one user input per transition. The same value is
written atomically to the existing legacy lifecycle field and the operational
transition note. Separate reason/note inputs are forbidden.

## Checkpoint C — Not authorized

Future work may add bodyless realtime invalidation and an approved generic
notification policy. It must not duplicate transition notifications.

## Optional linked follow-up JobCards — Not authorized

Requires a separate product gate, explicit link persistence, canonical JobCard
creation authorization, and no automatic note-body copying.

## Closeout

Create three explicit commits:

```text
docs: add operational notes design and implementation plan
feat: enrich JobCard operational notes
docs: add operational notes checkpoint A evidence
```

Push and open a Draft PR. Ready, merge, staging, and production remain unauthorized.

