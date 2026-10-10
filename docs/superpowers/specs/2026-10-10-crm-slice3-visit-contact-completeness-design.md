# CRM Slice 3 — Visit Contact Capture & Customer Completeness

Date: 2026-10-10
Baseline: `71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa` (origin/main, tree `044817ea22ad68344e4094634b2e6e57dfb0cb0f`)
Status: approved for implementation (questions 1–3 answered by product owner on 2026-10-10)

## 1. Objective

1. Capture the person actually met during a customer visit (SALES_MEETING).
2. Surface missing customer/contact information as an advisory completeness projection.
3. Offer a non-blocking customer enrichment action after a visit is submitted for manager approval.

No merge, no production deployment, no production migration in this task.

## 2. Discovery findings (current behavior, verified at baseline)

### 2.1 Contact semantics on JobCard

- `job_cards.contact_id` exists since migration `004_crm_contacts.sql:46`, FK
  `(organization_id, contact_id) -> contacts (organization_id, id)`.
- UI label for SALES_MEETING is **"Görüşülecek kişi"** (`web/src/JobDetail.tsx:578`) —
  the *planned* contact, selected at creation/planning time.
- Create path allows `contactId` for SALES_MEETING and GENERAL_TASK, forced `null`
  for PRODUCT_DELIVERY (`server/src/modules/job-cards/create-input.ts:136-154`).
- Generic edit path (`EDIT_JOB_FIELDS`) can change `contactId`
  (`server/src/modules/job-cards/service.ts:2320-2415`).
- Reference validation (`service.ts:2784-2799`): contact must exist in the same
  organization (`CONTACT_NOT_FOUND` 404), belong to the job's customer
  (`CONTACT_NOT_IN_CUSTOMER` 409) and be active (`CONTACT_INACTIVE` 409).
- **Conclusion:** `job_cards.contact_id` has the incompatible meaning "planned
  contact". Overwriting it with the actually-met person would destroy historical
  meaning. STOP-and-propose applied; the approved minimal representation is a new
  column on the meeting result (section 4).

### 2.2 Meeting result

- `job_card_meeting_details` (migration `007_sales_meeting.sql`), PK `job_card_id`,
  holds `meeting_at`, `outcome` (4 values), `meeting_summary` (<= 4000, non-blank),
  `next_follow_up_at` (legacy); `unsuccessful_reason_code` added by migration 042.
- No contact reference exists in the meeting result.

### 2.3 Meeting-result mutation contract (the extension point)

`PATCH /job-cards/:id/meeting-details` (`server/src/modules/job-cards/routes.ts:34`,
`service.ts:2119-2235`):

- Action-scoped authorization `EDIT_MEETING_RESULT` via `assertCanEditMeetingResult`:
  only statuses IN_PROGRESS / REVISION_REQUESTED; STAFF must own the job
  (`policy.ts:110-115,218-219,229-248`); other STAFF get 404 concealment
  (`service.ts:2141-2143`).
- `executeCriticalAction` idempotency: `clientActionId` + request hash
  (`MEETING_DETAILS_UPDATE:${jobCardId}`), replay returns original response,
  in-flight returns `ACTION_IN_PROGRESS` 409 (`service.ts:2131-2138,2228-2230`).
- `expectedVersion` = JobCard version, conflict -> 409 `VERSION_CONFLICT`
  (`service.ts:2145-2151,2193-2204`).
- Post-merge candidate validation; no-change -> 400 `MEETING_DETAILS_UNCHANGED`
  (`service.ts:2153-2187`).
- Audit: `MEETING_DETAILS_UPDATED` with `changedFields`
  (`service.ts:2205-2212`); realtime invalidation published.
- Request hash covers explicit patch fields
  (`critical-action-request-hash.ts:151-175`).

### 2.4 SUBMIT_FOR_APPROVAL

- SALES_MEETING readiness (`submission-policy.ts:98-201`): customer eligible and
  active, assignee active STAFF, valid `meetingAt`, valid `outcome`, non-blank
  summary, `unsuccessfulReason` when FOLLOW_UP_REQUIRED, valid `nextFollowUpAt`.
- No contact / completeness requirement. Completeness must NOT become a submit gate.

### 2.5 CRM Slice 2 (already merged, #363)

- `canEnrichCustomer` (`crm/enrichment-policy.ts`): STAFF + same org + customer not
  inactive + (customer assigned to actor OR actor owns a JobCard for the customer
  with status in `ACTIVE_JOB_CARD_STATUSES` = NEW/ACCEPTED/IN_PROGRESS/
  WAITING_APPROVAL/REVISION_REQUESTED). WAITING_APPROVAL is included, so the
  submitter keeps enrichment capability after submission.
- `GET /customers/:id/enrichment` -> `{ canEnrich, canCreateContact }`
  (`crm/service.ts:245-262`), server-confirmed capability; enrichment witness is
  locked `FOR SHARE NOWAIT` (`crm/repository.ts:105-117`).
- `POST /customers/:id/enrichment` — STAFF-only customer field enrichment
  (`phone, email, city, district, address`) with `expectedVersion`, audit
  `STAFF_ENRICHMENT`, `editablePhone` policy.
- `POST /customers/:id/enrichment/contacts` — STAFF-only scoped contact creation,
  consumes the customer version (stale retry -> `VERSION_CONFLICT`, preventing
  duplicate creation), creates `isActive=true, isPrimary=false`, audit
  `CONTACT_CREATED` with `STAFF_ENRICHMENT` metadata
  (`crm/service.ts:219-243`).
- Contact reads: `GET /customers/:id/contacts?status=active` is org-scoped
  (`crm/repository.ts:417+`); `GET /customers/:id` returns `contacts` + `version`.
- Contact deletion/inactivation guards (`crm/repository.ts:281-296`) currently only
  consider `job_cards.contact_id`.

### 2.6 Phone normalization contract

`normalizeTurkishPhone` (`crm/types.ts`): trims, strips TR separators, resolves
`+90…`/`0…`/10-digit national forms to canonical `+90XXXXXXXXXX`; any other
non-empty text returns `null`. This is the existing definition used to distinguish
a usable phone from arbitrary text. Historical values are never modified by this
slice.

### 2.7 Frontend

- `MeetingDetailsSection` (`web/src/jobs/MeetingDetails.tsx`) owns the meeting-result
  form with: draft preservation during realtime refresh (frozen attempt +
  deferred canonical reconciliation), ambiguous-retry ("Özgün isteği tekrar dene"),
  server field errors, and a read-only branch for non-editable statuses.
- `JobDetail` orchestrator (`web/src/JobDetail.tsx`): `saveMeeting` performs
  patch + `refreshTruth()` + realtime drain (`:1596-1628`); `recordContent`
  renders the meeting section when `VIEW_MEETING_RESULT` is allowed (`:2164-2183`);
  realtime invalidation via `useRealtimeInvalidation` (`:1409`).
- CTA placement: main column below the meeting result (recordContent), STAFF-only.
- Slice 2 UI: reusable `CustomerEnrichmentForm` (`web/src/CustomerEnrichmentForm.tsx`),
  client functions in `web/src/services/crm-api.ts` (`getCustomer`,
  `getCustomerEnrichmentScope`, `enrichCustomer`, `createEnrichmentContact`).

## 3. Approved decisions (product owner, 2026-10-10)

1. **Met-contact representation:** new nullable column
   `job_card_meeting_details.met_contact_id` (migration 056). `job_cards.contact_id`
   keeps the planned-contact meaning and is never overwritten. Planned and met
   contact may be equal or different; neither is a warning. `null` means
   "not recorded yet", never "visit failed". Server-side authorization required;
   history untouched.
2. **Completeness contact-phone rule (reachability):**
   - no active contact -> `ACTIVE_CONTACT_MISSING` only (never also `CONTACT_PHONE_MISSING`);
   - active contacts exist but none has a *usable* phone -> `CONTACT_PHONE_MISSING`;
   - at least one active contact with a usable phone -> no `CONTACT_PHONE_MISSING`;
   - absence of a primary contact alone is not a missing item;
   - inactive contacts are excluded;
   - "usable" reuses the existing `normalizeTurkishPhone` contract; historical
     free-text values are never auto-modified.
3. **CTA drawer scope:** reuse `CustomerEnrichmentForm` for customer fields; when
   `canCreateContact`, offer a compact "Yeni ilgili kişi ekle" section (Slice 2
   scoped endpoint, never auto-primary); when `CONTACT_PHONE_MISSING`, show the
   active contacts lacking a usable phone (display only — no contact editing);
   missing-info guidance refreshes after a successful save; the drawer never
   auto-closes without user confirmation. No general contact CRUD; no submit gate.

## 4. Data model change — migration 056

File: `server/src/db/migrations/056_meeting_met_contact.sql` (next number after 055).

```sql
ALTER TABLE job_card_meeting_details
  ADD COLUMN met_contact_id UUID,
  ADD CONSTRAINT job_card_meeting_details_organization_met_contact_fk
    FOREIGN KEY (organization_id, met_contact_id)
    REFERENCES contacts (organization_id, id);

CREATE INDEX job_card_meeting_details_organization_met_contact_idx
  ON job_card_meeting_details (organization_id, met_contact_id);
```

Compatibility: additive nullable column, no backfill, no rewrite of existing rows;
old clients are unaffected (response field additive; PATCH field optional); the FK
prevents dangling references; production migration requires separate approval.

Referential integrity: permanent contact deletion stays blocked by the FK
(`23503` -> `CONTACT_HAS_OPERATION_HISTORY` 409, same as `job_cards.contact_id`);
`contactHasAnyJobs` is extended to also consider `met_contact_id` references so the
clean 409 message is produced without relying on the FK error. Deactivation is NOT
blocked by met-references: the visit is historical and the relationship must be
preserved (approved decision 1).

## 5. Server contract changes

### 5.1 Meeting details (extend, do not fork)

- `meeting-details-input.ts`: `PATCH_FIELDS` + `MUTATION_FIELDS` + parser accepts
  `metContactId?: string | null` (null/absent = not recorded; string must be UUID).
- `types.ts` (job-cards): `MEETING_DETAIL_FIELDS` + `metContactId`;
  `PatchMeetingDetailsInput` + `metContactId?: string | null`;
  `MeetingDetails` DTO + `metContactId: string | null` and
  `metContact: { id, name, title: string | null } | null` (read projection).
- `critical-action-request-hash.ts`: `MEETING_PATCH_FIELDS` + `metContactId`.
- `service.ts patchMeetingDetails`: merge candidate; when `metContactId !== null`
  validate inside the same transaction via the existing row lock:
  `getContactForUpdate` (extended to also return `name`, `title`) ->
  `CONTACT_NOT_FOUND` 404 (unknown/cross-org), `CONTACT_NOT_IN_CUSTOMER` 409
  (contact of another customer, including `job.customerId === null`),
  `CONTACT_INACTIVE` 409. The patch response returns the locked identity.
- Repository: `MeetingDetailsRecord` + `met_contact_id`; `updateMeetingDetails`
  writes it; `findMeetingDetails` LEFT JOINs contacts to project
  `metContact {id,name,title}` (inactive contacts still resolve for display).
- Submission policy: unchanged; `metContactId` is not a readiness requirement.
- AUDIT: `MEETING_DETAILS_UPDATED.changedFields` naturally includes `metContactId`.
- Web types/parser (`jobs-api.ts`): `MeetingDetails`, `PatchMeetingDetailsInput`,
  `parseMeetingDetails`, `MeetingDetailField`, activity `MEETING_DETAILS`
  changedFields — extended with `metContactId`.

### 5.2 Customer completeness projection (new, canonical)

- `GET /customers/:customerId/completeness` (CRM module) ->
  `{ missingInfo: MissingInfoCode[] }` with
  `MissingInfoCode = 'CUSTOMER_PHONE_MISSING' | 'ACTIVE_CONTACT_MISSING' | 'CONTACT_PHONE_MISSING'`.
- Single service function `getCustomerCompleteness(actor, customerId)` backed by one
  repository query; read visibility follows existing customer reads (org member,
  404 concealment for unknown customer). Codes are ordered canonically; the
  projection identifies missing field codes only.
- Rules (approved):
  - `CUSTOMER_PHONE_MISSING`: customer phone is null/blank OR not usable
    (`normalizeTurkishPhone` returns null).
  - `ACTIVE_CONTACT_MISSING`: no active contact.
  - `CONTACT_PHONE_MISSING`: active contacts exist and none has a usable phone.

### 5.3 Authorization matrix (new operations)

| Operation | ADMIN | MANAGER | assigned STAFF | other STAFF |
|---|---|---|---|---|
| PATCH meeting details incl. `metContactId` | allowed in IN_PROGRESS/REVISION_REQUESTED | allowed in IN_PROGRESS/REVISION_REQUESTED | allowed in IN_PROGRESS/REVISION_REQUESTED on own job | 404 (concealed) |
| GET completeness | allowed (org) | allowed (org) | allowed (org) | allowed (org) |
| CTA enrichment drawer (Slice 2 endpoints) | n/a (capability false) | n/a (capability false) | capability-gated by `canEnrichCustomer` | 403 fail-closed |

No widening of `EDIT_JOB_FIELDS`, no STAFF contact CRUD, no job-contact changes.

## 6. Frontend changes

### 6.1 Visit contact capture (`MeetingDetails.tsx`)

- New field "Görüşülen kişi" (optional) in the editable branch:
  - options = active contacts of the job's customer, loaded via `getCustomer`
    (one fetch: contacts + version); loading / empty / error+retry states;
  - the currently persisted `metContact` is kept visible even if it is no longer
    among active contacts (historical display, marked pasif, not selectable as a
    new choice);
  - inline "Yeni ilgili kişi ekle" (compact drawer): reuses
    `createEnrichmentContact` with the current customer `version`; on success the
    contact is appended, selected, and the form draft is preserved; never primary;
  - selection/save flows through the existing `onSave(input)` path
    (clientActionId + expectedVersion + ambiguous retry + deferred canonical all
    preserved); `metContactId` participates in the no-change check and in the
    deferred-canonical reconciliation;
  - read-only branch displays "Görüşülen kişi" (name, or "Belirtilmedi").
- `hasMeetingResult` in `JobDetail.tsx` includes `metContactId`.

### 6.2 Completeness CTA (`JobCustomerCompletenessAction`)

- Rendered only when: `job.type === 'SALES_MEETING'`, `job.status === 'WAITING_APPROVAL'`,
  `user.role === 'STAFF'`, `job.customerId !== null`.
- Fetches `getCustomerEnrichmentScope` + completeness in parallel; explicit loading;
  hidden (fail-closed) when capability is false or `missingInfo` is empty; on fetch
  error show a retry affordance, never break the JobCard.
- Shows "Müşteri bilgilerini tamamla" plus specific guidance mapped from codes
  (Turkish labels). Guidance refreshes after a successful save; the drawer stays
  open unless the user closes it; when everything is resolved the CTA disappears
  after the next refresh.
- Drawer reuses `CustomerEnrichmentForm`; save -> `enrichCustomer` with
  `expectedVersion`; `VERSION_CONFLICT` -> reload customer + completeness and show
  the existing conflict message pattern; `FORBIDDEN` (capability revoked after
  load) -> fail-closed message, JobCard stays readable, CTA hidden on refresh.
- Conditional contact section per approved decision 3.

### 6.3 Non-goals (explicit)

Duplicate customer detection/merge; visit frequency policy; new JobCard types;
product delivery changes; new CRM-wide STAFF permissions; bulk contact backfill;
automatic primary reassignment; forced redirects; completeness submit gate;
reporting/dashboard changes; customer edit from the drawer.

## 7. Test plan (mandatory coverage mapping)

Server integration (real PostgreSQL, existing harness patterns
`crm-enrichment-postgres.test.ts`, `sales-meeting-postgres.test.ts`,
`crm-concurrency.test.ts`):

1. assigned STAFF selects an existing active contact -> 200, version bumped, DB
   `met_contact_id` set, audit `MEETING_DETAILS_UPDATED` once with `metContactId`.
2. contact of another customer -> 409 `CONTACT_NOT_IN_CUSTOMER`, DB unchanged.
3. cross-organization contact -> 404 `CONTACT_NOT_FOUND`, DB unchanged.
4. inactive contact -> 409 `CONTACT_INACTIVE`, DB unchanged.
5. unauthorized STAFF (not assigned) -> 404; reassigned STAFF -> 404, DB unchanged.
6. closed/invalid statuses (WAITING_APPROVAL, COMPLETED, CANCELLED, INVALIDATED)
   -> 409/not-editable semantics unchanged, DB unchanged.
7. stale `expectedVersion` -> 409 `VERSION_CONFLICT`, DB unchanged.
8. concurrent modification -> exactly one winner.
9. repeated/ambiguous requests: same clientActionId + same payload -> replay, one
   activity; same clientActionId + different payload -> conflict; concurrent
   duplicate -> `ACTION_IN_PROGRESS`; no duplicate activity.
10. audit consistency incl. clearing `metContactId` to null.
11. contact creation invariants: `createEnrichmentContact` never touches
    `met_contact_id`/primary; delete blocked while referenced as met (clean 409);
    deactivation allowed with history preserved.
12. manager/admin regressions on meeting details unchanged.
13. SUBMIT_FOR_APPROVAL succeeds with missing completeness and with
    `metContactId` null (no new gate); submit failure semantics unchanged.
14. completeness projection: null / blank / free-text / canonical phone; zero
    active contacts; active without usable phone; active with usable phone;
    inactive-only contacts; org scoping.
15. capability loss after load: enrich/create -> 403 and zero mutation.

Web tests (`web/tests`, existing vitest + testing-library patterns):

- MeetingDetails: picker lists active contacts, excludes inactive, saves
  `metContactId`, no-change guard, inline create appends+selects+preserves draft,
  historical inactive selection displayed, deferred canonical includes metContactId.
- CTA: hidden without missingInfo, hidden when capability false, guidance labels,
  drawer save refreshes guidance, contradiction/conflict error surface, fail-closed
  on 403, never auto-closes.
- Parsers: `parseMeetingDetails` with/without metContact; completeness response.

## 8. Verification plan

- Focused: `server/tests` meeting+crm suites; `web/tests` meeting+enrichment suites;
  `cd server && npm run build`; `cd web && npm run build`; lint.
- Full mandatory local CI: `ops/local-ci/run.sh --sha <HEAD>` with all 27 checks;
  record exact test counts and the final manifest SHA-256; keep R2/DR opt-in
  SKIPPED classifications.
- Browser acceptance (disposable PostgreSQL + synthetic data + real Chrome via
  Playwright MCP / Chrome DevTools MCP), 10 scenarios: select existing contact;
  create+select scoped contact; save visit contact; submit for approval; remain on
  JobCard with guidance; open enrichment via CTA; complete an allowed customer
  field; return and verify refreshed completeness; authorization revocation +
  conflict/retry + realtime refresh; desktop + 390px layouts.
- No production testing; no GitHub Actions while billing restriction remains.

## 9. Deliverable

One PR from `feat/crm-slice3-visit-contact-completeness` containing: this discovery
finding summary, business rules + authorization matrix, source changes, tests,
browser evidence, exact HEAD SHA/tree, local CI evidence manifest, known
limitations. Not merged, not deployed.
