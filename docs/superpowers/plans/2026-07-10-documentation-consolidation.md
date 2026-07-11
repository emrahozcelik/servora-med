# Servora-Med Documentation Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate Servora-Med product, architecture, schema, API, UI, and delivery-slice documentation into a single-source, implementation-ready documentation set.

**Architecture:** Active documents are separated by responsibility and cross-reference one another instead of repeating decisions. Historical inputs move under `docs/archive/inputs/` and lose SSOT status. Validation is documentation-focused: controlled vocabulary checks, contradiction scans, path checks, and manual cross-document review.

**Tech Stack:** Markdown, plain-text source inputs, `rg`, POSIX shell utilities

## Global Constraints

- Documentation only; do not create application code, migrations, dependencies, or UI components.
- `JobCard` remains the central domain object.
- Staff cannot move a JobCard directly to `COMPLETED`; manager approval remains mandatory.
- MVP tracks delivery purpose and product quantity, not price, discount, revenue, margin, invoice, payment, or commission.
- MVP delivery purposes are `SALE`, `SAMPLE`, `CONSIGNMENT`, `RETURN`, and `OTHER`.
- `CONSIGNMENT` and `RETURN` are operational classifications and do not create stock movements in MVP.
- Pilot core supports `PRODUCT_DELIVERY` and `GENERAL_TASK`; structured `SALES_MEETING` is a later slice.
- Authentication uses hashed opaque session tokens in `HttpOnly`, `Secure`, `SameSite=Lax` cookies.
- JobCard writes use optimistic concurrency with `version` and `expectedVersion`.
- UI register is `product`; UI direction is reliable, simple, and orderly.
- Accessibility target is `WCAG 2.2 Level AA`.
- User-defined tables, custom fields, form builders, and workflow builders remain outside MVP.
- Do not introduce restaurant POS concepts into active Servora-Med documents.
- Preserve existing historical inputs under `docs/archive/inputs/`; do not delete them.
- The workspace root is not a Git repository. Do not initialize Git or claim commits were created.

---

### Task 1: Establish active and archived document boundaries

**Files:**
- Create: `PRODUCT_REQUIREMENTS.md`
- Modify: `PRODUCT.md`
- Modify: `DECISIONS.md`
- Move: `SERVORA_MED_AGENT_PLAN.md` to `docs/archive/inputs/SERVORA_MED_AGENT_PLAN.md`
- Move: `ilkplan.md` to `docs/archive/inputs/ilkplan.md`
- Move: `teknoloji.md` to `docs/archive/inputs/teknoloji.md`
- Move: `gem-doc.txt` to `docs/archive/inputs/gem-doc.txt`

**Interfaces:**
- Consumes: approved decisions from `docs/superpowers/specs/2026-07-10-documentation-consolidation-design.md`, `PRODUCT.md`, and `DECISIONS.md`
- Produces: product requirements SSOT and a historical-input boundary used by all later tasks

- [x] **Step 1: Create the archive directory and move historical inputs**

Run each command separately:

```bash
mkdir -p docs/archive/inputs
mv SERVORA_MED_AGENT_PLAN.md docs/archive/inputs/SERVORA_MED_AGENT_PLAN.md
mv ilkplan.md docs/archive/inputs/ilkplan.md
mv teknoloji.md docs/archive/inputs/teknoloji.md
mv gem-doc.txt docs/archive/inputs/gem-doc.txt
```

Expected: all four source files exist only under `docs/archive/inputs/`.

- [x] **Step 2: Mark every archived input as non-authoritative**

Add this notice immediately after the first heading, or at the top when the file has no Markdown heading:

```markdown
> Archive notice: This file is a historical planning input. It is not an active source of truth. See `PRODUCT_REQUIREMENTS.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`, `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_API_DRAFT.md`, `SERVORA_MED_MVP_SLICES.md`, and `DECISIONS.md` for current decisions.
```

Expected: every archived file contains `Archive notice` exactly once.

- [x] **Step 3: Create the product requirements SSOT**

Create `PRODUCT_REQUIREMENTS.md` with these sections and no implementation details:

```text
Purpose
Users and roles
Core workflows
JobCard types and lifecycle
Product delivery requirements
Approval and revision rules
Activity and audit requirements
Mobile and desktop experience
Reports and staff profiles
Configurability boundary
MVP scope
Out of scope
Pilot success criteria
```

The delivery workflow must require `deliveryPurpose`, `deliveredAt`, customer, assignee, at least one product, and quantity greater than zero before approval submission. It must explicitly exclude prices and financial metrics.

- [x] **Step 4: Align strategic product context and decision links**

Update `PRODUCT.md` only where needed so it points to `PRODUCT_REQUIREMENTS.md` for functional scope and `DECISIONS.md` for durable decisions. Do not duplicate schema columns or endpoint paths.

Add a documentation index to the top of `DECISIONS.md` linking the active SSOT files.

- [x] **Step 5: Verify document boundaries**

Run:

```bash
rg --files -g 'SERVORA_MED_AGENT_PLAN.md' -g 'ilkplan.md' -g 'teknoloji.md' -g 'gem-doc.txt'
rg -n 'Archive notice' docs/archive/inputs
rg -n '^## ' PRODUCT_REQUIREMENTS.md
```

Expected: the first command returns only archive paths; the second returns four notices; the third returns all required product sections.

---

### Task 2: Make architecture and decisions authoritative

**Files:**
- Modify: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Modify: `DECISIONS.md`
- Reference: `PRODUCT_REQUIREMENTS.md`

**Interfaces:**
- Consumes: product scope from Task 1
- Produces: architecture boundaries consumed by schema, API, and slice documents

- [x] **Step 1: Replace the architecture SSOT declaration**

Declare this responsibility split:

```text
Product scope: PRODUCT_REQUIREMENTS.md
Architecture: SERVORA_MED_ARCHITECTURE_PLAN.md
Schema: SERVORA_MED_SCHEMA_DRAFT.md
API: SERVORA_MED_API_DRAFT.md
Delivery order: SERVORA_MED_MVP_SLICES.md
UI strategy: PRODUCT.md and DECISIONS.md
Agent discipline: AGENTS.md
Historical inputs: docs/archive/inputs/
```

Remove `SERVORA_MED_AGENT_PLAN.md` as an active decision source.

- [x] **Step 2: Record the approved architecture decisions**

Architecture must state:

- Single-organization V1 with `organization_id` as an ownership boundary, not SaaS multi-tenancy
- Global case-insensitive login email uniqueness
- Hashed opaque session token in secure cookie
- Named JobCard command endpoints
- Separate JobCard creation and delivery-item creation paths
- Idempotency only for critical business commands
- JobCard optimistic concurrency using `version`
- Immutable `WAITING_APPROVAL` commercial fields for staff and manager
- Immutable `COMPLETED` and `CANCELLED` in MVP
- No WebSocket until polling is proven insufficient
- Configurable views never modify canonical domain rules

- [x] **Step 3: Remove speculative architecture hooks**

Remove active-MVP claims for:

```text
track_lot
track_serial
track_expiry
stock_movements
attachments table
QUOTE_FOLLOW_UP enum readiness
COLLECTION_FOLLOW_UP enum readiness
admin override
optional PIN login
```

Future capability may be described in prose only when it does not create a current schema or implementation obligation.

- [x] **Step 4: Add missing durable decisions**

Add decision records for:

- Delivery purpose and quantity without financial tracking
- Structured `SALES_MEETING` deferral
- JobCard concurrency and idempotency boundary
- Secure session storage
- Single-organization ownership boundary
- Canonical activity event vocabulary

Each record must contain date, status, context, decision, and consequences.

- [x] **Step 5: Verify architecture vocabulary**

Run:

```bash
rg -n 'SERVORA_MED_AGENT_PLAN|Bearer token|sessionStorage|admin override|optional PIN|QUOTE_FOLLOW_UP|COLLECTION_FOLLOW_UP' SERVORA_MED_ARCHITECTURE_PLAN.md
rg -n 'token_hash|HttpOnly|version|expectedVersion|single.organization|ownership boundary' SERVORA_MED_ARCHITECTURE_PLAN.md DECISIONS.md
```

Expected: the first command returns no active architecture decisions; the second finds every approved replacement concept.

---

### Task 3: Correct and simplify the schema draft

**Files:**
- Modify: `SERVORA_MED_SCHEMA_DRAFT.md`
- Reference: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Reference: `DECISIONS.md`

**Interfaces:**
- Consumes: ownership, auth, delivery, activity, and concurrency decisions from Task 2
- Produces: exact Phase 0 schema contract consumed by the API draft

- [x] **Step 1: Replace enum and event vocabularies**

Define:

```text
job_card_type: PRODUCT_DELIVERY | GENERAL_TASK
delivery_purpose: SALE | SAMPLE | CONSIGNMENT | RETURN | OTHER
```

Use the canonical activity events from decision UI-001's neighboring domain decisions:

```text
JOB_CREATED
JOB_ASSIGNED
JOB_PLANNED
JOB_STARTED
JOB_SUBMITTED_FOR_APPROVAL
JOB_APPROVED
JOB_REVISION_REQUESTED
JOB_RESUMED
JOB_CANCELLED
JOB_FIELDS_UPDATED
DELIVERY_ITEM_ADDED
DELIVERY_ITEM_UPDATED
DELIVERY_ITEM_REMOVED
NOTE_ADDED
```

Remove generic `status_changed` and lowercase duplicate lifecycle events.

- [x] **Step 2: Correct users and sessions**

Replace `UNIQUE (organization_id, email)` with a global case-insensitive uniqueness rule such as a unique index on `lower(email)`. Replace `sessions.token` with `sessions.token_hash`; document expiry, revoke, and raw-token non-persistence.

- [x] **Step 3: Simplify staff, customer, and product tables**

Remove:

```text
staff_profiles.monthly_target
staff_profiles.is_active
customers.is_active
products.track_lot
products.track_serial
products.track_expiry
backup_log table
```

Keep customer lifecycle solely in `customers.status`. Keep lot, serial, and expiry optional on delivery items without product-level requirement flags.

- [x] **Step 4: Add delivery and concurrency fields**

Add to `job_cards`:

```text
version INTEGER NOT NULL DEFAULT 1
```

Add to `job_card_delivery_items`:

```text
delivery_purpose VARCHAR(20) NOT NULL
delivered_at TIMESTAMPTZ NOT NULL
```

Clarify that price, discount, total, inventory movement, invoice, and payment fields do not exist in MVP.

- [x] **Step 5: Strengthen ownership invariants and seed policy**

Document that JobCard, customer, contact, product, delivery item, and assigned user must share `organization_id`. Use service validation and composite constraints where practical.

Replace `002_seed_data` migration with:

```text
npm run db:seed:dev
production admin bootstrap CLI or environment-controlled one-shot command
```

Group migrations by executable slice dependencies rather than one monolithic schema or one file per table.

- [x] **Step 6: Verify schema removals and additions**

Run:

```bash
rg -n 'monthly_target|backup_log|sessions\.token\b|UNIQUE \(organization_id, email\)|status_changed|QUOTE_FOLLOW_UP|COLLECTION_FOLLOW_UP' SERVORA_MED_SCHEMA_DRAFT.md
rg -n 'delivery_purpose|delivered_at|token_hash|lower\(email\)|version INTEGER|SALE.*SAMPLE.*CONSIGNMENT.*RETURN.*OTHER' SERVORA_MED_SCHEMA_DRAFT.md
```

Expected: the first command has no active schema matches; the second finds every required replacement.

---

### Task 4: Make the API draft singular and concurrency-safe

**Files:**
- Modify: `SERVORA_MED_API_DRAFT.md`
- Reference: `SERVORA_MED_SCHEMA_DRAFT.md`

**Interfaces:**
- Consumes: DTO fields and invariants from Task 3
- Produces: one implementable REST contract consumed by the slice plan

- [x] **Step 1: Replace bearer auth with cookie auth**

Document secure session cookie behavior, CSRF posture, expiry, logout revoke, and credentialed CORS. Login response must not expose the raw session token in JSON.

- [x] **Step 2: Narrow idempotency**

Require `clientActionId` for JobCard creation, delivery-item creation, submit, approve, revision request, and cancellation. Do not require processed-action response caching for ordinary profile, customer, contact, or product field updates.

- [x] **Step 3: Remove dual write paths**

Remove `deliveryItems` from `POST /api/job-cards`. Keep delivery items under `POST /api/job-cards/:jobCardId/delivery-items`.

- [x] **Step 4: Keep only named lifecycle commands**

Remove generic `POST /api/job-cards/:jobCardId/transitions`. Keep exactly:

```text
plan
start
submit-for-approval
approve
request-revision
resume
cancel
```

Every JobCard patch and lifecycle command carries `expectedVersion`. A stale version returns:

```json
{
  "error": "İş kartı başka bir kullanıcı tarafından güncellendi.",
  "code": "VERSION_CONFLICT"
}
```

- [x] **Step 5: Correct delivery DTOs and approval invariants**

Delivery-item creation requires `productId`, positive `quantity`, `deliveryPurpose`, and `deliveredAt`. Submit for approval requires customer, assignee, and at least one valid delivery item. No financial fields are accepted or returned.

- [x] **Step 6: Align lock and event behavior**

Document that neither staff nor manager can patch commercial fields in `WAITING_APPROVAL`. Manager can only approve or request revision. Lifecycle responses and activity use the canonical uppercase event names.

- [x] **Step 7: Verify API singularity**

Run:

```bash
rg -n '/transitions|"deliveryItems"|Authorization: Bearer|sessionStorage|status_changed' SERVORA_MED_API_DRAFT.md
rg -n 'expectedVersion|VERSION_CONFLICT|deliveryPurpose|deliveredAt|submit-for-approval|request-revision|HttpOnly' SERVORA_MED_API_DRAFT.md
```

Expected: the first command returns no active contract matches; the second finds the approved API behavior.

---

### Task 5: Rebuild slices around an early tracer bullet

**Files:**
- Modify: `SERVORA_MED_MVP_SLICES.md`
- Reference: `PRODUCT_REQUIREMENTS.md`
- Reference: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Reference: `SERVORA_MED_API_DRAFT.md`
- Reference: `PRODUCT.md`
- Reference: `DECISIONS.md`

**Interfaces:**
- Consumes: settled product, architecture, schema, API, and UI decisions
- Produces: executable delivery order with acceptance criteria

- [x] **Step 1: Replace the slice map**

Use this order:

```text
00 Scaffold and safety baseline
01 Secure auth and admin bootstrap
02 Product-delivery tracer bullet backend
03 Product-delivery tracer bullet mobile UI
04 Users and staff profiles
05 Customers and contacts
06 Product catalog
07 Notes, timeline, and Kanban/list
08 Staff profile and operational reports
09 General Task
10 Structured Sales Meeting
11 Production deployment, backup, and hardening
12 WebSocket only if polling is insufficient
```

- [x] **Step 2: Make Slice 02 independently testable**

Acceptance criteria must cover:

- Minimal reference records for one customer and product
- Product delivery with purpose, quantity, and delivered time
- Submit for approval
- Manager approval and revision request
- Canonical activity events in the same transaction
- Critical-command idempotency
- JobCard version conflict
- Cross-organization rejection
- Staff approval rejection

- [x] **Step 3: Make Slice 03 mobile and accessible**

Acceptance criteria must cover:

- Staff login and one-hand delivery flow at approximately 390 CSS px
- Manager approval and revision flow
- 44 by 44 CSS px interaction targets where applicable
- Keyboard completion without drag and drop
- Visible focus and semantic labels
- Error, loading, empty, and stale-version states
- `prefers-reduced-motion`

- [x] **Step 4: Remove premature work**

Remove active-slice requirements for token storage in `sessionStorage`, `backup_log`, product tracking flags, three active JobCard types at pilot completion, settings foundation, custom fields, and mandatory WebSocket.

- [x] **Step 5: Add exact documentation verification per slice**

For code-producing future slices, retain these minimum commands:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Add focused tests for role boundaries, state transitions, delivery invariants, idempotency, version conflicts, ownership, keyboard flow, and accessibility where relevant.

- [x] **Step 6: Verify slice terminology**

Run:

```bash
rg -n 'sessionStorage|backup_log|track_lot|track_serial|track_expiry|3 aktif tip|mandatory WebSocket' SERVORA_MED_MVP_SLICES.md
rg -n 'tracer bullet|VERSION_CONFLICT|deliveryPurpose|deliveredAt|WCAG|44.*44|keyboard|polling' SERVORA_MED_MVP_SLICES.md
```

Expected: the first command returns no active requirements; the second finds the new acceptance criteria.

---

### Task 6: Cross-document validation and final handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-07-10-documentation-consolidation-design.md`
- Modify: `docs/superpowers/plans/2026-07-10-documentation-consolidation.md`
- Validate: all active Markdown documents

**Interfaces:**
- Consumes: completed Tasks 1 through 5
- Produces: a reviewed and internally consistent documentation package

- [x] **Step 1: Scan for placeholders and unresolved alternatives**

Run:

```bash
rg -n 'TBD|TODO|implementasyonda.*seç|ikisi de geçerli|veya tek transition|opsiyonel PIN' AGENTS.md PRODUCT.md PRODUCT_REQUIREMENTS.md DECISIONS.md SERVORA_MED_ARCHITECTURE_PLAN.md SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_API_DRAFT.md SERVORA_MED_MVP_SLICES.md
```

Expected: no unresolved implementation choice. Legitimate explanatory uses of “veya” must be manually inspected.

- [x] **Step 2: Scan controlled vocabularies across active documents**

Run:

```bash
rg -n 'PRODUCT_DELIVERY|GENERAL_TASK|SALES_MEETING|SALE|SAMPLE|CONSIGNMENT|RETURN|OTHER' PRODUCT_REQUIREMENTS.md DECISIONS.md SERVORA_MED_ARCHITECTURE_PLAN.md SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_API_DRAFT.md SERVORA_MED_MVP_SLICES.md
rg -n 'JOB_CREATED|JOB_ASSIGNED|JOB_PLANNED|JOB_STARTED|JOB_SUBMITTED_FOR_APPROVAL|JOB_APPROVED|JOB_REVISION_REQUESTED|JOB_RESUMED|JOB_CANCELLED|JOB_FIELDS_UPDATED|DELIVERY_ITEM_ADDED|DELIVERY_ITEM_UPDATED|DELIVERY_ITEM_REMOVED|NOTE_ADDED' DECISIONS.md SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_API_DRAFT.md
```

Expected: active and deferred JobCard types are described consistently; all event names use the canonical uppercase vocabulary.

- [x] **Step 3: Scan forbidden scope and legacy domain leakage**

Run:

```bash
rg -n -i 'menu_items|dining_tables|waiter|cashier|kitchen|printer_routes|stock movement.*MVP|invoice.*MVP|revenue.*MVP|native mobile.*MVP' PRODUCT_REQUIREMENTS.md DECISIONS.md SERVORA_MED_ARCHITECTURE_PLAN.md SERVORA_MED_SCHEMA_DRAFT.md SERVORA_MED_API_DRAFT.md SERVORA_MED_MVP_SLICES.md
```

Expected: matches appear only in explicit out-of-scope or anti-leakage statements, never as active features.

- [x] **Step 4: Validate links and file locations**

Run:

```bash
test -f PRODUCT.md
test -f PRODUCT_REQUIREMENTS.md
test -f DECISIONS.md
test -f SERVORA_MED_ARCHITECTURE_PLAN.md
test -f SERVORA_MED_SCHEMA_DRAFT.md
test -f SERVORA_MED_API_DRAFT.md
test -f SERVORA_MED_MVP_SLICES.md
test -f docs/archive/inputs/SERVORA_MED_AGENT_PLAN.md
test -f docs/archive/inputs/ilkplan.md
test -f docs/archive/inputs/teknoloji.md
test -f docs/archive/inputs/gem-doc.txt
```

Expected: every command exits with status 0.

- [x] **Step 5: Mark design and plan records complete**

Update the design spec status to `Implemented and documentation-validated`. Check completed plan steps with `[x]`. Record the exact verification commands and results in a final `Validation Results` section.

- [x] **Step 6: Report completion without a commit claim**

Use the required Turkish handoff structure:

```text
Tamamlananlar:
- ...

Değişen dosyalar:
- ...

Doğrulama:
- [passed/failed/not run] command

Notlar / riskler:
- Root dizin Git deposu olmadığı için commit oluşturulmadı.
```

Do not initialize Git without explicit user approval.

## Validation Results

Completed on 2026-07-10.

- Passed: historical inputs exist only under `docs/archive/inputs/` and each contains one archive notice.
- Passed: `PRODUCT_REQUIREMENTS.md` contains every planned product section.
- Passed: active architecture contains secure cookie sessions, ownership boundary, idempotency, and optimistic concurrency decisions.
- Passed: removed schema terms and fields are absent from the active schema contract.
- Passed: schema contains `delivery_purpose`, `delivered_at`, `token_hash`, global case-insensitive email uniqueness, and JobCard `version`.
- Passed: API has no generic transition route, bearer-token contract, Web Storage token, or nested delivery-item creation path.
- Passed: API contains named commands, `expectedVersion`, `VERSION_CONFLICT`, delivery purpose, and delivered time.
- Passed: slice plan contains early backend/mobile tracer bullets and accessibility acceptance criteria.
- Passed: controlled JobCard types, delivery purposes, and activity event names are consistent across active documents.
- Passed with manual classification: legacy-domain and financial-scope search results occur only in explicit exclusion statements.
- Passed with manual classification: `sessionStorage` and `status_changed` remain only in decision context explaining rejected approaches.
- Passed: every active and archived document path required by this plan exists.
- Not run: build, tests, and lint because this task changed documentation only and the Servora-Med application has not been scaffolded.
- Not run: Git diff and commit because `/Users/emrah/Documents/Servora-Med` is not a Git repository.
