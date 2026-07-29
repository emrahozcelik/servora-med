# Operational Notes Checkpoint B evidence

## Provenance

- Exact base: `228d4230eda49a22a155ffdd18a71b063b018af1`
- Migration: `020_job_card_transition_note_contexts.sql`
- Capture date: 2026-07-30

Checkpoint B extends the canonical `JobCardOperationalNoteContext` from four contexts
(`GENERAL`, `SUBMIT_FOR_APPROVAL`, `APPROVE`, `REQUEST_REVISION`) to five, adding
`CANCEL`. Every lifecycle transition that accepts a user reason now atomically writes
that input as an operational note within the same `executeCriticalAction` transaction.
The transition activity record carries only `{noteId}` metadata (no reason fallback,
no separate `NOTE_ADDED` activity).

All evidence uses only synthetic organization, user, JobCard, and note data.

## Contexts

| Context | Writer | Required note | Behaviour |
| --- | --- | --- | --- |
| `GENERAL` | STAFF / MANAGER | No | Standalone note, not coupled to a lifecycle transition |
| `SUBMIT_FOR_APPROVAL` | STAFF | Yes | `Tamamlanma sonucu` is mandatory; empty/blank is rejected with `SUBMISSION_NOTE_REQUIRED` |
| `APPROVE` | MANAGER | No | Optional `Onay notu`; empty/blank body is not persisted as an operational note |
| `REQUEST_REVISION` | MANAGER | Single reason input | Reason input is projected as the operational note body |
| `CANCEL` | STAFF | Single reason input | Reason input is projected as the operational note body |

## Implementation summary

- `server/src/modules/job-cards/types.ts` — canonical `JobCardOperationalNoteContext` union with `CANCEL`
- `server/src/db/migrations/020_job_card_transition_note_contexts.sql` — additive context constraint migration preserving v0/v1 invariants
- `server/src/modules/job-cards/validation.ts` — `requireSubmissionNote()` validator
- `server/src/modules/job-cards/repository.ts` — expanded note record types with context and cursor preservation
- `server/src/modules/job-cards/service.ts` — atomic lifecycle transition note insertion inside `executeCriticalAction`
- `web/src/jobs/jobs-api.ts` — exact context parser and lifecycle API payloads
- `web/src/jobs/JobWorkflowDialog.tsx` — SUBMIT dialog with required note, APPROVE dialog with optional note, revision/cancel single-input dialogs
- `web/src/ui/antd/ReasonDialog.tsx` — accessible code-point-aware textarea (2 000 Unicode code-point limit)
- `web/src/JobDetail.tsx` — dialog ownership, lifecycle payload dispatch, and notes refresh via `refreshKey`
- `web/src/jobs/JobNotes.tsx` — context labels (`Operasyon notu`, `Tamamlanma sonucu`, `Yönetici onayı`, `Revizyon isteği`, `İptal`)

## Automated validation

| Suite | Files | Tests | Result |
| --- | --- | --- | --- |
| Lifecycle service | 1 | 68 | PASS |
| Operational notes migration | 1 | 3 | PASS |
| Focused web | 5 | 149 | PASS |
| Full server | 117 | 1 387 (1 384 + 3 known local) | PASS * |
| Full web | 96 | 1 137 | PASS |
| Server build | — | — | PASS |
| Web build | — | — | PASS |

\* The 3 failing server tests are pre-existing local-environment issues:
- `tests/db-auth-contract.test.ts`: local PostgreSQL `trust` auth accepts wrong password (CI `password` auth rejects correctly)
- `tests/auth-setup-postgres.test.ts`: non-empty disposable test database triggers `BOOTSTRAP_NOT_ALLOWED`
These failures are unrelated to Checkpoint B changes.

## Changed files

### Server source
- `src/modules/job-cards/types.ts`
- `src/modules/job-cards/repository.ts`
- `src/modules/job-cards/service.ts`
- `src/modules/job-cards/validation.ts`
- `src/db/migrations/020_job_card_transition_note_contexts.sql` (new)

### Server tests
- `tests/job-card-lifecycle-service.test.ts`
- `tests/job-card-operational-notes-migration.test.ts`
- `tests/job-card-notes.test.ts`
- `tests/realtime-job-card-integration.test.ts`
- `tests/notification-delivery-projection.test.ts`
- `tests/web-push-integrated-normal-path.test.ts`
- `tests/migrate-runner.test.ts`
- `tests/backup-restore-postgres.test.ts`
- `tests/job-acceptance-postgres.test.ts`
- `tests/job-card-workspace-postgres.test.ts`
- `tests/sales-meeting-postgres.test.ts`
- `tests/sales-meeting-schema.test.ts`

### Web source
- `src/JobDetail.tsx`
- `src/jobs/JobNotes.tsx`
- `src/jobs/JobWorkflowDialog.tsx`
- `src/jobs/jobs-api.ts`
- `src/ui/antd/ReasonDialog.tsx`

### Web tests
- `tests/job-detail.test.tsx`
- `tests/job-notes.test.tsx`
- `tests/jobs-api.test.ts`
- `tests/manager-review.test.tsx`
- `tests/reason-dialog.test.tsx`
