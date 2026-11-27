# Staff time proposal on a declined or released assignment (JOB-012)

- **Status:** Accepted product contract (owner, 2026-11-24, PR review of the
  declined-offer guidance: "personel alternatif zaman önersin"; Q1–Q4 answered
  with the recommended defaults). Extends [JOB-010](assignment-acceptance-sla.md).
  Q1 is amended by JOB-013 (2026-11-27, RESCUE-002); see § JOB-013 below.
- **Scope:** `PRODUCT_DELIVERY` and `SALES_MEETING` jobs in the JOB-010
  acceptance window (flag on). Customer time stays management-only: Staff only
  *propose*; management confirms. Management may still set any other time.

## Decisions

| # | Question | Decision |
|---|---|---|
| Q1 | When is a proposal asked for? | **Required** when the Staff answer's reason is `SCHEDULE_CONFLICT`; not accepted for any other reason. *Amended by JOB-013:* required with the suggestion `RESCHEDULE_SELF`, forbidden with every other suggestion, whatever the reason; the original rule remains only for a request without a suggestion. |
| Q2 | What does management confirmation do? | The job moves to the proposed time **and is accepted for the proposing Staff member** in the same transaction (no second Staff acceptance). |
| Q3 | Which checks apply? | The proposed start must be in the future and the proposed interval must not conflict with the Staff member's calendar. Sunday / outside 08:00–19:00 are advisory warnings only (human-choice rule). |
| Q4 | Which answers carry it? | Both `DECLINE_ASSIGNMENT` and `RELEASE_ASSIGNMENT`. |

## Data (migration `073_assignment_offer_time_proposal.sql`)

On `job_card_assignment_offers`:

- `proposed_scheduled_at TIMESTAMPTZ NULL` — the Staff proposal, stored on the
  offer the answer closed.
- `proposal_accepted_at TIMESTAMPTZ NULL`, `proposal_accepted_by UUID NULL` —
  set once, when management confirms.
- `CHECK (proposed_scheduled_at IS NULL OR (state IN ('DECLINED','RELEASED') AND close_reason = 'SCHEDULE_CONFLICT'))`
  (replaced by migration 076, see § JOB-013)
- `CHECK ((proposal_accepted_at IS NULL) = (proposal_accepted_by IS NULL))`
- `CHECK (proposal_accepted_at IS NULL OR proposed_scheduled_at IS NOT NULL)`
- `opened_reason` vocabulary gains `PROPOSAL_ACCEPTED`. The widened CHECK keeps
  the complete current vocabulary (`JOB_ASSIGNMENT_OFFER_OPENED_REASONS` in
  `server/src/modules/job-cards/types.ts`, including `SALE_APPROVAL`).
- Forward-only, run once, fails clearly; no backfill. `schema-check` / expected
  schema artifacts are updated to the new head.

The proposed **interval** is derived, never stored: `[proposed, proposed + D)`
where `D` is the job's persisted planned duration (`scheduled_ends_at -
scheduled_at`), or the canonical duration for the type (60 min
`SALES_MEETING`, 30 min `PRODUCT_DELIVERY`) when either is null.

## API

### Staff answer — `POST /api/job-cards/:id/decline`, `POST /api/job-cards/:id/release`

Body gains `proposedScheduledAt?: string | null` (canonical ISO instant).

- `reasonCode = SCHEDULE_CONFLICT`: `proposedScheduledAt` is **required** →
  missing/null → `400 VALIDATION_ERROR` with `fieldErrors.proposedScheduledAt`.
- Any other `reasonCode`: it must be absent or null → otherwise `400` with
  `fieldErrors.proposedScheduledAt`.
- `proposedScheduledAt <= requestTime` → `400` `fieldErrors.proposedScheduledAt`
  ("Önerilen zaman gelecekte olmalı."). `requestTime` is the 049 reservation
  instant, checked after the replay lookup, so a completed answer still replays
  after its proposal has passed.
- The derived interval conflicting with the Staff member's occupancy (the same
  core occupancy reader as reschedule, excluding this job; checked whether or
  not the Calendar module is enabled, manual entries counted only while it is,
  DECISIONS.md SCH-001) → `409 CALENDAR_CONFLICT` with the existing
  Staff-projected conflict shape.
- The value is part of the command's request hash. It is stored on the offer the
  answer closes. Nothing else about decline/release changes.

### Management confirmation — `POST /api/job-cards/:id/assignment-offers/accept-proposal`

Body `{ clientActionId, expectedVersion, offerId }`. MANAGER/ADMIN only (STAFF
`403` before lookup). Flag off → `409 ASSIGNMENT_WINDOW_DISABLED`.
Idempotent like re-offer (`executeCriticalAction`, request hash of
`jobCardId, expectedVersion, offerId`, assignee-before-job lock order).

Preconditions (else `409 ASSIGNMENT_PROPOSAL_NOT_AVAILABLE`, nothing written):
job `NEW`, type `PRODUCT_DELIVERY` / `SALES_MEETING`; the job's **latest** offer
has id `offerId`, state `DECLINED` or `RELEASED`, a `proposed_scheduled_at`,
`proposal_accepted_at IS NULL`; `offer.assignee_user_id = job.assigned_to`; the
assignee is an active STAFF user. Version mismatch → `409 VERSION_CONFLICT`.
`proposed_scheduled_at <= requestTime` → `409 ASSIGNMENT_PROPOSAL_EXPIRED`.
Occupancy conflict for the derived interval (SCH-001, independent of the
Calendar module) → `409 CALENDAR_CONFLICT`.

Effects, one transaction:

1. Reschedule to the derived interval exactly as a management reschedule does:
   version +1, schedule revision (`source = 'RESCHEDULE'`), early-start
   authorization voided (`RESCHEDULED`), `JOB_FIELDS_UPDATED` activity with
   `scheduledAt` / `scheduledEndsAt`, calendar realtime and the existing
   "rescheduled" notification to the assignee.
2. The declined/released offer gets `proposal_accepted_at = requestTime`,
   `proposal_accepted_by = actor`.
3. A new offer: `opened_reason = 'PROPOSAL_ACCEPTED'`, `opened_by = actor`,
   addressed to the assignee, created directly in state `ACCEPTED` with
   `closed_at = requestTime`, `closed_by = assignee` (the proposer accepted by
   proposing). Its `acceptance_due_at` follows the existing ACCEPTED-offer
   constraints. `JOB_ASSIGNMENT_OFFER_OPENED` is **not** emitted for it and no
   offer reminder/expiry is scheduled.
4. Job `NEW → ACCEPTED`, `accepted_at = requestTime`, `accepted_by = assignee`;
   `JOB_ACCEPTED` activity (actor = management, metadata
   `{ via: 'TIME_PROPOSAL', offerId: <new offer>, proposalOfferId, proposerId }`).
   The OVR-2 acceptance basis is the new planned interval (no `LATE_START` for a
   future start).

Response `200 { jobCardId, offerId, scheduledAt, scheduledEndsAt }`, where
`offerId` is the new `PROPOSAL_ACCEPTED` offer (the confirmed one is
`proposalOfferId` in the `JOB_ACCEPTED` metadata).

### Reads

- Job detail `assignmentOffer` gains `proposedScheduledAt: string | null` and
  `proposedScheduledEndsAt: string | null` (derived interval), and
  `proposalAcceptedAt: string | null`. Same readers as today.
- `ASSIGNMENT_DECISION` activity details gain `proposedScheduledAt: string |
  null`, under the same reader scope as `reasonCode` / `reasonText`
  (management and the answering Staff member; other Staff readers get `null`).
- `GET /api/job-cards/assignment-offers/needs-action` items gain
  `proposedScheduledAt: string | null`.

## Web

- **Staff answer dialog** (decline and release): when the selected reason is
  "Plan çakışması" a required `datetime-local` field "Önerdiğiniz zaman"
  appears with the existing quick presets and the advisory Sunday/past hints;
  help text: "Yönetici onaylarsa iş bu zamana taşınır ve sizin için kabul
  edilmiş olur." Client checks required + future; server `fieldErrors` and
  `CALENDAR_CONFLICT` show inline. Other reasons show no field.
- **Management guidance** (job detail, PR #502 block): when the latest closed
  offer has a pending proposal, show "Personelin önerdiği zaman: <date>
  <start>–<end>" and make **"Önerilen zamanı onayla"** the primary action with a
  confirmation ("İş <interval> zamanına taşınır ve <name> için kabul edilmiş
  olur."). "Yeni zaman belirle", "Sorumlu personeli değiştir" and "Aynı zamanla
  yeniden teklif et" stay as secondary actions. A proposal whose start has passed
  shows "Önerilen zaman geçti" and no confirm button. `ASSIGNMENT_PROPOSAL_*`,
  `CALENDAR_CONFLICT` and `VERSION_CONFLICT` refresh the card and explain.
- **Timeline:** the decline/release detail appends "Önerilen: <date time>".
- **Needs-action list** (overview): the row shows the proposal.

## Acceptance scenarios

1. Decline with `SCHEDULE_CONFLICT` and a free future time → `NEW`, offer
   `DECLINED` with the proposal stored; job time unchanged.
2. Decline with `SCHEDULE_CONFLICT` and no time → `400`; with a past time →
   `400`; with a time conflicting with the Staff calendar → `409 CALENDAR_CONFLICT`.
   Nothing written in any case.
3. Decline with `ON_LEAVE` plus a time → `400`.
4. Release (from `ACCEPTED`) with `SCHEDULE_CONFLICT` + time → `NEW`, offer
   `RELEASED` with the proposal; the OVR-2 release order is unchanged.
5. Manager confirms → one transaction: interval moved (duration kept), schedule
   revision, `JOB_FIELDS_UPDATED`, old offer marked accepted, new `ACCEPTED`
   offer `PROPOSAL_ACCEPTED`, job `ACCEPTED` by the proposer, `JOB_ACCEPTED`.
6. Replay with the same `clientActionId` → same result, no second effect;
   different body same key → `409` idempotency conflict.
7. Confirm twice (new key) → second `409 ASSIGNMENT_PROPOSAL_NOT_AVAILABLE`.
8. Confirm after reassignment, after a management reschedule, or after a re-offer
   (latest offer changed) → `409 ASSIGNMENT_PROPOSAL_NOT_AVAILABLE`.
9. Confirm when the proposed start has passed → `409 ASSIGNMENT_PROPOSAL_EXPIRED`.
10. Confirm when the Staff calendar now conflicts → `409 CALENDAR_CONFLICT`.
11. STAFF calling confirm → `403`; flag off → `409 ASSIGNMENT_WINDOW_DISABLED`.
12. A later Staff assignee reading the activity sees the decision without reason
    text or proposal.
13. Management may ignore the proposal and reschedule freely; the existing
    reschedule path is unchanged.

## JOB-013 — typed suggestion (RESCUE-002, 2026-11-27)

### Vocabulary

Decline/release reasons gain `OUT_OF_TOWN` ("Şehir dışındayım"),
`CUSTOMER_POSTPONED` and `WRONG_PRODUCT` (same literals and labels as the
change-request codes). Display order: `SCHEDULE_CONFLICT`, `ON_LEAVE`,
`OUT_OF_TOWN`, `TOO_FAR`, `CUSTOMER_POSTPONED`, `WRONG_PRODUCT`,
`MISSING_STOCK_OR_EQUIPMENT`, `OTHER`.

Suggested solutions:

| Code | Label |
|---|---|
| `RESCHEDULE_SELF` | Başka bir zamanda kendim yapabilirim |
| `REASSIGN` | Başka bir personele verilsin |
| `CORRECT_DETAILS` | İş bilgileri düzeltilsin |
| `CANCEL_REQUEST` | İptal edilmesini öneriyorum |
| `MANAGEMENT_DECIDES` | Yönetici karar versin |

A suggestion never authorizes a mutation. `CANCEL_REQUEST` is a request to
management; Staff never cancel (JOB-010 D1).

### API

Decline and release bodies gain `suggestedSolution?: string | null`.

- **With a suggestion:** it must be one of the five codes (else `400
  VALIDATION_ERROR`, `fieldErrors.suggestedSolution`); any of the eight
  reasons is allowed. `proposedScheduledAt` is required with
  `RESCHEDULE_SELF` ("Önerilen zaman zorunludur.") and forbidden with every
  other suggestion ("Önerilen zaman yalnızca \"Başka bir zamanda kendim
  yapabilirim\" seçildiğinde verilebilir."). The future, occupancy and replay
  rules above apply unchanged.
- **Without a suggestion** (absent or null, earlier client): the original Q1
  rules apply and only the five original reasons are accepted; a new reason
  returns `400` with `fieldErrors.suggestedSolution` ("Çözüm önerisi
  zorunludur."). Nothing is inferred or stored as a suggestion.
- The request hash includes `suggestedSolution` only when it is non-null, so
  an earlier client's body hashes as before.
- The detail offer view and the decline/release activity details gain
  `suggestedSolution` (null when none), reader-scoped like `reasonCode`.
- The management confirmation command is unchanged; it accepts any latest
  offer that carries a proposal.

### Data (migration `076`)

- `close_reason` CHECKs (`close_reason_check` and the `DECLINED`/`RELEASED`
  branch of `closure_check`) gain the three reasons.
- `suggested_solution TEXT NULL`, CHECK in the five codes, and only on
  `DECLINED` / `RELEASED`.
- `proposed_scheduled_at IS NULL OR (state IN ('DECLINED','RELEASED') AND
  (suggested_solution = 'RESCHEDULE_SELF' OR (suggested_solution IS NULL AND
  close_reason = 'SCHEDULE_CONFLICT')) IS TRUE)`. `IS TRUE` keeps the check
  null-safe: without it a null suggestion with another reason evaluates to
  NULL and PostgreSQL would accept the row.
- `suggested_solution IS DISTINCT FROM 'RESCHEDULE_SELF' OR
  proposed_scheduled_at IS NOT NULL`.
- Additive and forward-only, no backfill; existing rows keep a null
  suggestion.

### Web

The Staff form asks for the reason, then the suggestion (mandatory), then the
time only for `RESCHEDULE_SELF`, and the explanation. Management sees
"Personelin önerisi: <label>" beside the reason; rows without a suggestion
look as before. Recovery action ordering is unchanged (RESCUE-003).

### Acceptance scenarios (JOB-013)

14. Decline or release with `OUT_OF_TOWN` + `RESCHEDULE_SELF` + a free future
    time → proposal stored; management confirmation accepts it as in scenario 5.
15. `SCHEDULE_CONFLICT` + `REASSIGN` with no time → accepted, no proposal.
16. `RESCHEDULE_SELF` without a time, or a time with any other suggestion → `400`.
17. A new reason without a suggestion → `400`; an earlier client's
    `SCHEDULE_CONFLICT` + time without a suggestion → accepted as before.
18. Same key with a different suggestion → idempotency conflict.

## Out of scope

Staff choosing the customer time directly, multiple proposals per answer,
automatic confirmation without management, a single manager recovery form and
suggestion-based action ordering (RESCUE-003), releasing declined staff time
(RESCUE-004).
