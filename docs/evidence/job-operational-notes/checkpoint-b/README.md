# Operational Notes Checkpoint B evidence

## Provenance

- Exact base: 228d4230eda49a22a155ffdd18a71b063b018af1
- Exact head: c2a0a65b6ff44afdfadc3a0e0587dab890e6b978
- Branch: feat/job-lifecycle-operational-notes-b
- PR: #80 (https://github.com/emrahozcelik/servora-med/pull/80) - OPEN, Draft
- Base: main (match: YES)
- Local/remote head match: YES
- Merge state: CLEAN
- Mergeability: MERGEABLE
- Working tree: clean
- Capture date: 2026-07-30

## Automated test evidence (2026-07-30 re-run)

| Suite | Files | Tests | Result |
| --- | --- | --- | --- |
| Lifecycle service (focused) | 1 | 68 | PASS |
| Operational notes migration (focused) | 1 | 2 pass / 1 skip | PASS |
| Full server | 117 | 1384 pass / **3 fail** | 3 FAIL (pre-existing) |
| Server build | - | - | PASS |
| Full web | 96 | 1137 | PASS |
| Web build | - | - | PASS |
| Bundle check | - | - | PASS |
| npm audit (server, high) | - | 0 vulnerabilities | PASS |

### Pre-existing local test failures (not caused by Checkpoint B)

1. db-auth-contract.test.ts: local PostgreSQL trust auth accepts wrong password (CI password auth rejects correctly)
2. auth-setup-postgres.test.ts x2: non-empty disposable test database triggers BOOTSTRAP_NOT_ALLOWED

These 3 failures are NOT classified as PASS. They are pre-existing environment-specific failures.

## Runtime acceptance evidence (2026-07-30)

### Topology
- Database: PostgreSQL 17, local, database: servora_med_checkpoint_b_v2
- Server: Fastify on http://127.0.0.1:3101
- Web: Vite (build verified)
- Actors: Admin (8888...8801), Manager (8888...8802), Staff (8888...8803)
- Organization: 11111111-1111-1111-1111-111111111111

### Scenario A - SUBMIT blank validation: PASS
- Blank/whitespace note rejected with SUBMISSION_NOTE_REQUIRED (400)
- JobCard remains IN_PROGRESS without mutation

### Scenario B - SUBMIT valid Unicode note: PASS
- Status -> WAITING_APPROVAL
- staff_completion_note matches normalized Unicode input
- One SUBMIT_FOR_APPROVAL operational note, workflow_stage=IN_PROGRESS
- Activity metadata: {noteId} only, no NOTE_ADDED

### Scenario C - APPROVE blank: PASS
- Status -> COMPLETED, no APPROVE note created
- manager_approval_note is null

### Scenario D - APPROVE nonblank Unicode: PASS
- manager_approval_note matches Unicode input
- One APPROVE note, workflow_stage=WAITING_APPROVAL
- Activity metadata: {noteId} only

### Scenario E - REQUEST_REVISION: PASS
- Status -> REVISION_REQUESTED, revision_reason matches input
- One REQUEST_REVISION note, workflow_stage=WAITING_APPROVAL
- No NOTE_ADDED, no second note field

### Scenario F - CANCEL (x2): PASS
- From IN_PROGRESS: cancelledFromStatus=IN_PROGRESS, cancel_note stage=IN_PROGRESS
- From WAITING_APPROVAL: cancelledFromStatus=WAITING_APPROVAL, cancel_note stage=WAITING_APPROVAL
- Activity metadata: {noteId} only

### Scenario G - Idempotent replay: PASS
- Same clientActionId replay returns same JobCard ID
- No duplicate transition, activity, or note
- Note count unchanged

### Scenario H - Atomic rollback: PASS (automated)
Verified in job-card-lifecycle-service.test.ts:
- Policy failure rolls back transition, activity, and note
- Activity failure rolls back transition and note
- Note insert failure rolls back transition and activity
- All preserve original job state

### Scenario I - Privacy inspection: PASS
Surfaces verified CLEAN:
- Activity metadata: only {noteId}, never note body
- Notifications: only kind/entity_type
- Realtime events: only resource_keys (channel names)
- Web Push: no deliveries
- Zero NOTE_ADDED activities in database

### Scenario J - Browser acceptance
Covered by CI: web focused tests (149), smoke:responsive, Playwright chromium

## Database assertions (direct PostgreSQL): ALL PASS
1. All transition notes have correct workflow_stage (pre-transition snapshot)
2. Zero NOTE_ADDED activities
3. All notes linked to correct activity type
4. Activity metadata: noteId only, no body
5. staff_completion_note = operational note body (all MATCH)
6. manager_approval_note = operational note body (all MATCH)
7. revision_reason = operational note body (all MATCH)
8. cancel_reason = operational note body (all MATCH)

## Known limitations
- Scenario J (browser acceptance) deferred to CI pipeline
- 3 pre-existing server test failures (local env, not Checkpoint B)
- Web push disabled (no deliveries to inspect)
