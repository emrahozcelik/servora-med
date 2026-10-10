# CRM Slice 2 — scoped STAFF customer enrichment

Base: f2de980db4db46db5650f07938f3a729e577c2bd.

## Discovery and architecture

Existing CRM reads are organization-wide. STAFF creation is already supported;
generic customer PATCH and Contact writers remain ADMIN/MANAGER-only. Customer
updates use expectedVersion and value-free field-name audits. The canonical
ACTIVE_JOB_CARD_STATUSES list owns active status policy. Existing JobCard contact
references require an active contact belonging to the selected customer.

Use one customer-scoped resolver for direct assignment and current active job
assignment. Customer FOR UPDATE plus job FOR SHARE NOWAIT protects authorization
through commit without adding a blocking inverse lock cycle. Busy job witnesses
fail closed with VERSION_CONFLICT. Client jobId/organization/eligibility flags
are never accepted. See CRM-S2-001 in DECISIONS.md.

## Implemented slice

- GET /api/customers/:customerId/enrichment returns canEnrich/canCreateContact.
- POST /api/customers/:customerId/enrichment accepts a partial five-field
  whitelist plus expectedVersion and preserves omitted fields.
- POST /api/customers/:customerId/enrichment/contacts accepts name and optional
  title/phone/email plus expectedVersion; atomic customer version consumption
  prevents stale/lost-response duplicate creation. It never changes primary.
- STAFF sees only a server-confirmed focused form. Existing PhoneInput preserves
  historical free text. Save/cancel, pending, focus restoration, explicit
  conflict reload and scoped contact creation reuse the existing CRM surfaces.
- No generic permission expansion, migration, new dependency or JobCard mutation
  endpoint. Existing permitted JobCard contact selection is preserved.

## Acceptance coverage

- PostgreSQL/real HTTP: direct active/prospect assignment, every canonical active
  job status, another STAFF's customer, same-org enforcement, inactive/terminal/
  invalidated/historical/reassigned/creator-only/tampered targets, forbidden keys,
  generic endpoint denial, nullable/legacy normalization and unchanged managers.
- Deterministic real row-lock tests: concurrent customer reassignment, busy job
  reassignment, witness held through commit, one winner for equal versions.
- SQL verifies before/after customer/contact rows and audits, scoped contact
  primary preservation, lost-response retry and audit-failure rollback.
- Existing JobCard selection accepts scoped-created active contacts and rejects
  another customer's/inactive contacts and PRODUCT_DELIVERY associations.
- Frontend tests: server-denied read-only despite assignment projection, whitelist,
  cancel/open focus, one frozen pending request, conflict draft/reload, revoked
  permissions and scoped contacts bound to the returned customer version.
- Real Fastify/Vite/Chrome via local Playwright MCP and Chrome DevTools MCP uses
  disposable PostgreSQL 17 and synthetic records. Desktop/390px before/after
  screenshots, actual network payloads and SQL snapshots are retained externally.

Focused CRM/JobCard regression: 214 tests passed. Isolated SQL security suite:
50 passed. Focused frontend/client: 35 passed. Full frontend before the final pending
control refinement: 2,565 passed. Build checks passed. Final exact-head local CI,
its exact counts/hash and PR identity must be recorded in the PR after commit;
all 27 mandatory gates must PASS before this slice is declared complete.
The four separately contracted R2/DR acceptance tests remain opt-in SKIPPED.

Evidence location (operator-local, local-operator-attested):
.worktrees/crm-staff-enrichment-evidence-20261010.
No production access, merge or deployment is part of this slice.
