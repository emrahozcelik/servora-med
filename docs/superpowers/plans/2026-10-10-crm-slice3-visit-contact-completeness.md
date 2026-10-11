# CRM Slice 3 — Visit Contact Capture & Customer Completeness: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the actually-met contact on a SALES_MEETING visit result, add an advisory customer-completeness projection, and offer a capability-gated enrichment CTA after SUBMIT_FOR_APPROVAL.

**Architecture:** Extend the existing action-scoped meeting-details PATCH contract with a new nullable `met_contact_id` on `job_card_meeting_details` (migration 056). Add one canonical completeness projection endpoint. Reuse the Slice 2 enrichment endpoints/forms from a new JobDetail CTA component. No changes to `job_cards.contact_id`, `EDIT_JOB_FIELDS`, submit policy, or Slice 2 authorization.

**Tech Stack:** Fastify + `pg` + PostgreSQL 17, React/Vite + Ant Design, Vitest (+ real-Postgres integration tests), Playwright/Chrome DevTools MCP for acceptance, `ops/local-ci/run.sh` for the 27-check pipeline.

**Spec:** `docs/superpowers/specs/2026-10-10-crm-slice3-visit-contact-completeness-design.md`

## Global Constraints

- Baseline `71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa`; worktree `.worktrees/crm-slice3-20261010`; branch `feat/crm-slice3-visit-contact-completeness`.
- Node 22 (`/opt/homebrew/opt/node@22/bin`). PostgreSQL 17 required for tests; `TEST_DATABASE_URL` explicit, loopback, password-bearing, isolated DB name.
- `job_cards.contact_id` keeps the planned-contact meaning; never overwritten. `met_contact_id = NULL` means "not recorded yet", not "visit failed".
- No submit gate. No widening of `EDIT_JOB_FIELDS`. No STAFF generic contact CRUD. No primary-contact mutation. No forced redirect.
- Audit, `clientActionId`, request hash, `expectedVersion`, and realtime contracts must be preserved exactly as they exist.
- Usable phone := `normalizeTurkishPhone(value) !== null`. Historical phone values are never modified.
- Turkish user-facing copy; English identifiers/commits.
- Never fake verification; report exact commands and counts.

---

### Task 1: Migration 056 + catalog/env-example contracts

**Files:**
- Create: `server/src/db/migrations/056_meeting_met_contact.sql`
- Modify: `server/.env.example` (HEALTH_SCHEMA_VERSION), the second env example enforced by `ops/ci/verify-env-examples.sh`
- Test: `server/tests/sales-meeting-schema.test.ts`, `server/tests/schema-check.test.ts`, `server/tests/migration-catalog.test.ts` (add 056 / update expected head+count only where asserted)

**Interfaces:**
- Produces: column `job_card_meeting_details.met_contact_id UUID NULL`, FK `job_card_meeting_details_organization_met_contact_fk (organization_id, met_contact_id) -> contacts (organization_id, id)`, index `job_card_meeting_details_organization_met_contact_idx`.

Migration content (verbatim):

```sql
-- CRM Slice 3: person actually met during a SALES_MEETING visit.
-- Additive nullable reference to contacts; job_cards.contact_id keeps the
-- planned-contact meaning. NULL means "not recorded yet".
ALTER TABLE job_card_meeting_details
  ADD COLUMN met_contact_id UUID,
  ADD CONSTRAINT job_card_meeting_details_organization_met_contact_fk
    FOREIGN KEY (organization_id, met_contact_id)
    REFERENCES contacts (organization_id, id);

CREATE INDEX job_card_meeting_details_organization_met_contact_idx
  ON job_card_meeting_details (organization_id, met_contact_id);
```

- [ ] Step 1: `ops/ci/verify-env-examples.sh`'ın LATEST_MIGRATION'ı nasıl hesapladığını oku; iki örnek dosyayı `HEALTH_SCHEMA_VERSION=056_meeting_met_contact` yap.
- [ ] Step 2: Migration dosyasını oluştur; test migration listelerine `056_meeting_met_contact.sql` ekle (meeting/crm/schema testleri); head/count assertion'larını güncelle.
- [ ] Step 3: `cd server && npm run build && npm run schema:check` (disposable test DB ile) — catalog head 056, COMPATIBLE.
- [ ] Step 4: Focused: `npx vitest run tests/sales-meeting-schema.test.ts tests/schema-check.test.ts tests/migration-catalog.test.ts`
- [ ] Step 5: Commit — `feat(crm): add met_contact_id to meeting details (migration 056)`

### Task 2: Meeting-details types, parser, request hash (TDD)

**Files:**
- Modify: `server/src/modules/job-cards/types.ts` (`MEETING_DETAIL_FIELDS`, `MeetingDetails`, `PatchMeetingDetailsInput`, record/candidate shapes), `server/src/modules/job-cards/meeting-details-input.ts`, `server/src/modules/job-cards/critical-action-request-hash.ts`
- Test: `server/tests/sales-meeting-input.test.ts`, `server/tests/meeting-details-request-hash.test.ts` (create if absent — check first)

**Interfaces:**
- Produces:
  - `MEETING_DETAIL_FIELDS = ['meetingAt','outcome','unsuccessfulReason','meetingSummary','nextFollowUpAt','metContactId']`
  - `PatchMeetingDetailsInput` + `metContactId?: string | null`
  - `MeetingDetails` + `metContactId: string | null`, `metContact: { id: string; name: string; title: string | null } | null`
  - parser: absent → undefined; `null` → null; string → must match existing `UUID_PATTERN` via `uuidString`; anything else → `VALIDATION_ERROR` field `metContactId`.
  - request hash: `MEETING_PATCH_FIELDS` includes `metContactId` (presence semantics identical to other fields).

- [ ] Step 1: Failing tests: parse null / uuid / invalid string; mutation-only `metContactId` payload accepted; hash differs when `metContactId` present vs absent; hash identical for reordered payloads.
- [ ] Step 2: Run to see failures.
- [ ] Step 3: Implement types + parser + hash changes; update `MeetingDetailsCandidate`/`MeetingDetailsRecord` and every literal construction site (`mapMeetingDetails`, patch merge) so `metContactId: string | null` is always present.
- [ ] Step 4: Focused tests pass; `cd server && npm run build`.
- [ ] Step 5: Commit — `feat(crm): extend meeting details contract with metContactId`

### Task 3: Repository — lock read, write, projection

**Files:**
- Modify: `server/src/modules/job-cards/repository.ts`
- Test: covered by Task 4 integration tests

**Interfaces:**
- `getContactForUpdate` returns `{ id, customerId, isActive, name, title }` (SELECT adds `name, title`).
- `updateMeetingDetails` writes `met_contact_id` (`$8`).
- `findMeetingDetails` returns `MeetingDetailsCandidate & { metContact: { id, name, title } | null }` via `LEFT JOIN contacts` on `(organization_id, met_contact_id)`; inactive contacts still resolve.
- `getSubmissionMeetingDetails` returns candidate incl. `metContactId` (no join).

- [ ] Step 1: Implement SQL changes; keep `mapMeetingDetails` shared and add an optional identity mapper.
- [ ] Step 2: `cd server && npm run build`.
- [ ] Step 3: Commit — `feat(crm): persist and project meeting met contact`

### Task 4: Service validation + integration security suite

**Files:**
- Modify: `server/src/modules/job-cards/service.ts` (`meetingDetailsResponse`, `patchMeetingDetails` merge + validation)
- Modify: `server/src/modules/crm/repository.ts` (`contactHasAnyJobs` includes met references)
- Test: Create `server/tests/meeting-met-contact-postgres.test.ts`, `server/tests/meeting-met-contact-idempotency-postgres.test.ts`; extend contact guard tests in `server/tests/crm-enrichment-postgres.test.ts` (or nearest existing contact-delete suite)

**Interfaces:**
- patch validation inside the existing transaction: when merged `metContactId !== null`: missing/cross-org → 404 `CONTACT_NOT_FOUND`; `contact.customerId !== job.customerId` (or `job.customerId === null`) → 409 `CONTACT_NOT_IN_CUSTOMER`; `!isActive` → 409 `CONTACT_INACTIVE`. Reuses `getContactForUpdate`.
- Response identity built from the locked contact; clearing to null returns `metContact: null`.

Test matrix (each asserts DB values before/after; unauthorized paths assert zero mutation):

1. assigned STAFF selects active contact → 200, version+1, `met_contact_id` set, exactly one `MEETING_DETAILS_UPDATED` activity with `metContactId` in changedFields.
2. contact of another customer → 409 `CONTACT_NOT_IN_CUSTOMER`; `met_contact_id` unchanged.
3. cross-org contact → 404 `CONTACT_NOT_FOUND`; unchanged.
4. inactive contact → 409 `CONTACT_INACTIVE`; unchanged.
5. unassigned STAFF → 404; reassigned STAFF → 404; unchanged.
6. WAITING_APPROVAL / COMPLETED / CANCELLED / INVALIDATED → editing rejected (existing codes); unchanged.
7. stale expectedVersion → 409 `VERSION_CONFLICT`; unchanged.
8. concurrent patch (two connections) → exactly one winner; loser 409 or `ACTION_IN_PROGRESS`.
9. idempotency: same clientActionId+payload replay → same response, one activity; same id+different payload → conflict error; concurrent duplicate → `ACTION_IN_PROGRESS`.
10. clear met contact (`null`) → 200, audit changedFields includes `metContactId`; unchanged-guard still 400 when nothing changes.
11. SUBMIT_FOR_APPROVAL with `metContactId = null` and missing completeness → still succeeds (no new readiness item).
12. manager patch regression unchanged.
13. contact delete while referenced as met → 409 clean message; deactivate → allowed, history preserved (read still resolves name).

- [ ] Step 1: Write tests (real Postgres schema harness pattern from `sales-meeting-postgres.test.ts`; reuse lifecycle setup helpers from existing suites).
- [ ] Step 2: Implement service guard + response; repository guard extension.
- [ ] Step 3: `cd server && npm run build && npx vitest run tests/meeting-met-contact-postgres.test.ts tests/meeting-met-contact-idempotency-postgres.test.ts`
- [ ] Step 4: Commit — `feat(crm): validate and audit met-contact capture on visits`

### Task 5: Completeness projection endpoint (TDD)

**Files:**
- Modify: `server/src/modules/crm/types.ts` (`MISSING_INFO_CODES`, `MissingInfoCode`), `server/src/modules/crm/repository.ts`, `server/src/modules/crm/service.ts`, `server/src/modules/crm/routes.ts`, `server/src/modules/crm/handlers.ts`
- Test: Create `server/tests/crm-completeness-postgres.test.ts`

**Interfaces:**
- `GET /customers/:customerId/completeness` → `200 { missingInfo: MissingInfoCode[] }`; unknown customer → 404 `CUSTOMER_NOT_FOUND`; org scoping identical to other customer reads.
- Canonical order: `CUSTOMER_PHONE_MISSING`, `ACTIVE_CONTACT_MISSING`, `CONTACT_PHONE_MISSING` (only applicable codes).
- Rules (approved): customer phone null/blank/not usable → CUSTOMER_PHONE_MISSING; zero active contacts → ACTIVE_CONTACT_MISSING only; active contacts exist and none usable → CONTACT_PHONE_MISSING; primary absence alone never a code.
- Implemented as one SQL query + shared `hasUsablePhone` helper reusing `normalizeTurkishPhone` (checked in JS after a narrow SELECT, or SQL-side predicate kept identical; choose the JS variant over one narrow row set for exact contract reuse).

- [ ] Step 1: Failing tests covering the full rule matrix + org scoping + historical free text (`0232 555 12 34` usable; `bilinmiyor` not usable; blank/null not usable).
- [ ] Step 2: Implement repository/service/handler/route.
- [ ] Step 3: Focused tests pass; build.
- [ ] Step 4: Commit — `feat(crm): canonical customer completeness projection`

### Task 6: Web API layer

**Files:**
- Modify: `web/src/jobs/jobs-api.ts` (MeetingDetails, PatchMeetingDetailsInput, parseMeetingDetails, MeetingDetailField, activity `MEETING_DETAILS` union), `web/src/services/crm-api.ts` (`MissingInfoCode`, `getCustomerCompleteness`)
- Test: `web/tests/crm-client.test.ts` and existing meeting parse tests extended

**Interfaces:**
- `parseMeetingDetails` accepts `metContactId` (nullable string) and `metContact` (nullable `{id,name,title}`).
- `getCustomerCompleteness(customerId) => Promise<{ missingInfo: MissingInfoCode[] }>` with strict parse (reject unknown codes).

- [ ] Step 1: Failing parser tests (with/without metContact; unknown missingInfo code rejected).
- [ ] Step 2: Implement; `cd web && npm run build`.
- [ ] Step 3: Commit — `feat(web): parse met contact and completeness contracts`

### Task 7: Visit contact capture UI (`MeetingDetails.tsx`)

**Files:**
- Modify: `web/src/jobs/MeetingDetails.tsx`, `web/src/JobDetail.tsx` (`hasMeetingResult`)
- Test: Create `web/tests/meeting-met-contact.test.tsx` (patterns from `meeting-details.test.tsx`)

**Behavior:**
- Editable branch: "Görüşülen kişi" select loaded from `getCustomer(job.customerId)` (active only); loading/empty/error+retry; persisted inactive/missing selection shown as disabled option (historical); inline "Yeni ilgili kişi ekle" compact drawer using `createEnrichmentContact` (expectedVersion = current customer version, never primary), appends + selects + preserves the meeting draft; save path unchanged (clientActionId/expectedVersion/ambiguity/deferred canonical extended with `metContactId`); no-change guard includes it.
- Read-only branch: "Görüşülen kişi" row (name or "Belirtilmedi").

- [ ] Step 1: Failing tests (list/select/save payload; inactive excluded; inline create; draft preserved on realtime refresh incl. metContactId; read-only row).
- [ ] Step 2: Implement; focused vitest.
- [ ] Step 3: Commit — `feat(web): capture met contact in visit result form`

### Task 8: Completeness CTA (`JobCustomerCompletenessAction`)

**Files:**
- Create: `web/src/jobs/CustomerCompletenessAction.tsx` (+ styles consistent with existing classes)
- Modify: `web/src/JobDetail.tsx` (render under meeting result for WAITING_APPROVAL STAFF)
- Test: Create `web/tests/customer-completeness-cta.test.tsx`

**Behavior (approved decision 3):**
- Shows only for SALES_MEETING + WAITING_APPROVAL + STAFF + customer set + capability true + non-empty `missingInfo`; loading state; fail-closed hidden on capability false/fetch error (retry affordance); never blocks JobCard.
- Guidance: Turkish label per code. Drawer: `CustomerEnrichmentForm` + conditional compact "Yeni ilgili kişi ekle" (canCreateContact) + list of active contacts lacking usable phone when CONTACT_PHONE_MISSING (display only).
- Save → `enrichCustomer` (expectedVersion); conflict → reload + message; 403 → fail-closed message; drawer never auto-closes; guidance refreshes after save.

- [ ] Step 1: Failing tests (hidden/visible matrix, guidance labels, drawer save refresh, 403 fail-closed, no auto-close).
- [ ] Step 2: Implement; focused vitest.
- [ ] Step 3: Commit — `feat(web): post-submit customer completeness CTA`

### Task 9: Focused verification + full local CI

- [ ] Step 1: `cd server && npm run build && npx vitest run` (subset via TEST_DATABASE_URL isolated DB); `cd web && npm run build && npx vitest run`; both lints.
- [ ] Step 2: `ops/local-ci/run.sh --sha <HEAD>` — all 27 checks; verify evidence; record counts + manifest SHA-256; keep R2/DR SKIPPED classifications untouched.
- [ ] Step 3: Commit any fixups.

### Task 10: Browser acceptance (10 scenarios) + PR

- [ ] Step 1: Disposable PG17 + API + Vite (as PR #360 procedure); synthetic users/customers/contacts/meeting job.
- [ ] Step 2: Scenarios: select existing contact; create+select scoped contact; save; submit for approval; stay on JobCard + guidance; open CTA drawer; complete customer field; refreshed completeness; revocation + conflict/retry + realtime; desktop + 390px; console/network clean.
- [ ] Step 3: Evidence to `/tmp/` (outside repo), cleanup processes/container/temp env.
- [ ] Step 4: Push branch; `gh pr create` with discovery findings, rules/matrix, tests, evidence, SHA/tree, CI manifest, limitations. No merge/deploy.

## Self-Review Notes

- Spec §2 findings are the plan's discovery record; §3 decisions map to Tasks 1/4/7/8; §4→T1, §5.1→T2/T3/T4, §5.2→T5, §6→T6/T7/T8, §7→T4/T5/T6/T7/T8, §8→T9/T10.
- Type name consistency: `metContactId` (string|null) everywhere; `metContact` identity only in read DTOs; `MissingInfoCode` shared name in server+web.
- No placeholders other than files whose existence must be re-verified at execution time (`meeting-details-request-hash.test.ts`, contact-guard suite name) — executor greps first.
