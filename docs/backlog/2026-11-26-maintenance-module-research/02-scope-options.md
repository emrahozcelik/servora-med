# Maintenance / Bakım module — scope options

Status: **research note, not a decision.** Nothing here authorizes implementation.
Base: `origin/main` @ `89bf6b1` (worktree clean). All `path:line` references are
against that commit unless another ref is named.
Author: research worker (run `20261126-141130-deepseek-39d1`).
Related: [core modules architecture research, 2026-11-25](../2026-11-25-core-modules-architecture-research.md)
(finding V11, §5 step 6 "Bakım: önce kapsam ve sınır kararı", §5a "gelecek modüller …
doluluğa aynı katkı yoluyla bağlanır"), DECISIONS.md MOD-001, MOD-002, SCH-001.

---

## Summary

1. Servora-Med today has **no device/installed-base concept at all**: 61 `CREATE TABLE`
   statements across `server/src/db/migrations/`, none matching
   device/asset/equipment/machine. A clinic is one `customers` row with one `address`
   (`002_delivery_tracer.sql:4-31`, address at `:15`).
2. A serial number **already exists** on delivery lines (`002_delivery_tracer.sql:151`,
   `job-cards/types.ts:810`) and travels through the API
   (`job-cards/handlers.ts:168`, `critical-action-request-hash.ts:452`), but **no web
   screen writes or shows it** (`web/src/JobDetail.tsx:1310-1326`;
   `web/src/DeliveryCreate.tsx:37`). In practice the installed base will start from an
   empty serial column.
3. The owner's hypothesis holds with one refinement: **assignment, lifecycle, approval,
   occupancy and audit stay in JobCard** (duplicating them is forbidden by AGENTS.md §2.1
   and §7), while **device identity, service history, warranty and plans are
   module-owned**. The *visit itself* is still a JobCard; only its service facts are the
   module's.
4. The strongest external driver is regulatory, not commercial: the Turkish technical
   service regulation requires a per-device service report with serial number, ÜTS
   barcode, technician signature and clinic-counterpart signature, retained **10 years**
   (RG 26/5/2023-32202, MADDE 10; guide TCS-KLVZ-09), and warranty certificates of at
   least 2 years since 01.01.2025 (MADDE 25/A-25/B).
5. Recommended first slice: **Cut A — device registry (installed base) + per-device
   history, seeded from approved `PRODUCT_DELIVERY` lines**, plus one small core
   prerequisite (serial/lot/expiry inputs on the delivery line). No new job type, no
   occupancy change, no PDF, no Warehouse/Accounting dependency.
6. Preventive plans and corrective service calls are clearly core to the business but
   come **after** the registry, and Cut C forces a real core decision (how a maintenance
   visit enters staff occupancy, SCH-001 item 1).
7. Spare parts belong to Warehouse (MOD-001 item 2), contracts/SLA to Accounting (MOD-001 item 3),
   and calibration execution to a different TİTCK authorization regime. All three are
   out of this module's first three cuts.
8. Rough size: Cut A ≈ S, Cut B ≈ M, Cut C ≈ M–L. Each is one vertical slice.

---

## 1. Method and evidence levels

- **Observed** = read in the repository at `89bf6b1`.
- **External** = read on the web on 2026-11-26 (see §11 for URLs, access date and
  publication date where visible). Regulation text was read directly from
  `resmigazete.gov.tr` / `mevzuat.gov.tr`; TİTCK guides and a TİTCK training deck are
  secondary readings of the same rules.
- **Inference / recommendation** = my judgement, labelled as such.
- **UNVERIFIED** = could not be proven from code or a primary source in this run.

No production database was read. No build, test, migration or state-changing git
command was run.

---

## 2. What already exists and bounds any scope

### 2.1 JobCard owns the work lifecycle (do not rebuild it)

| Fact | Evidence |
| --- | --- |
| 5 types, 8 statuses | `server/src/modules/job-cards/types.ts:11-30` |
| Explicit command set; no free-text status | `job-cards/types.ts:815-825` (`LifecycleCommand`); `PRODUCT_REQUIREMENTS.md:127-130` |
| Staff accept/decline/release, management re-offers | JOB-010 (`DECISIONS.md:3162-3288`), `assignment-offer-policy.ts:35` |
| Manager approval mandatory, revision mandatory-reason | `PRODUCT_REQUIREMENTS.md:289-298` |
| Staff scoping: a Staff user only reaches own jobs | `job-cards/policy.ts:37-40` (`actorCanReachJob`) |
| Every critical mutation writes activity in the same transaction | `PRODUCT_REQUIREMENTS.md:299-317`; `AGENTS.md` §3 |
| Idempotency + `expectedVersion` on every command | ARC-001 (`DECISIONS.md:391-397`) |
| Staff occupancy is a **core** rule, one SQL definition | SCH-001 (`DECISIONS.md:3692-3717`), `job-cards/occupancy.ts:1-90` |
| Geo evidence at START/SUBMIT | `job-cards/location-types.ts:1-52`, `013_create_job_action_locations.sql` |

**Consequence (inference).** A parallel `maintenance_visits` lifecycle with its own
states, its own approval and its own audit would have to re-implement all of the above
and would then drift. AGENTS.md §2.1 ("do not duplicate state, schemas, constants,
permissions, or business logic") and §7 rule it out for a first implementation, not on
taste but on cost.

### 2.2 The delivery line model — and the serial that exists but is never typed

`job_card_delivery_items` (`002_delivery_tracer.sql:137-159`) stores:
`product_id`, `delivery_purpose` (SALE/SAMPLE/CONSIGNMENT/RETURN/OTHER), `delivered_at`,
`quantity`, `unit`, product name/sku/model snapshots, **`lot_no` (150), `serial_no`
(151)**, `expiry_date`, `delivery_note`.

- Submission readiness does **not** require serial/lot/expiry
  (`PRODUCT_REQUIREMENTS.md:265-273`), and `PRODUCT_REQUIREMENTS.md:287` states they are
  optional with no product-level tracking flag.
- DOM-004 keeps the catalog informational and forbids inventing tracking policy
  (`DECISIONS.md:549-552`, `PRODUCT_REQUIREMENTS.md:409-414`).
- API: the delivery input allowlist includes `serialNo` (`job-cards/handlers.ts:168`),
  the request hash normalizes it (`critical-action-request-hash.ts:452`), the DTO
  exposes it (`job-cards/types.ts:797-813`), and the web API layer types it
  (`web/src/jobs/jobs-api.ts:548,603,1376`).
- **Web UI: nothing.** The delivery create form collects only product + quantity and one
  purpose for the card (`web/src/DeliveryCreate.tsx:37,116,378-389`); the sale-approval
  delivery section collects product + quantity + purpose
  (`web/src/jobs/sale-approval-delivery.ts:47,56,103-107`); the job detail shows product,
  SKU, purpose, quantity and delivered time only (`web/src/JobDetail.tsx:1310-1326`).
  `grep -rn "serialNo" web/src --include=*.tsx` returns nothing.

**Consequence (inference, high impact).** Any "device = product + serial" registry starts
from a column that the application has never asked a human to fill. Serials are almost
certainly empty for historical deliveries (UNVERIFIED — no DB access). A registry that
*requires* a serial would therefore have zero seed data and would fail on day one.

### 2.3 Customer / site model — one address, no branches

- `customers`: `customer_type` (`clinic|hospital|dealer|company|other`), `city`,
  `district`, `address` (single TEXT), `assigned_staff_user_id`, `status`
  (`002_delivery_tracer.sql:4-31`; DTO `server/src/modules/crm/types.ts:12-28`).
- `contacts`: person-level only, no address (`004_crm_contacts.sql:17-31`).
- ARC-003 fixes Customer as aggregate root with **at most one** responsible Staff user and
  a shared lock order `users → customers → contacts → job_cards`
  (`DECISIONS.md:509-522`).
- No `customer_sites`, `branches` or `locations` table exists in any migration.

**Answer to "does a clinic have multiple sites?": no — not in the data model.**
A hospital (`customer_type='hospital'`) or a polyclinic can physically have several
buildings/departments, and the Turkish service report explicitly requires "the health
provider **and the related unit** and the provider's address" (TCS-KLVZ-09, report
content item b). The minimal correct answer for this module is therefore a free-text
`location_label` ("2. kat, Röntgen odası") on the device, **not** a new sites table —
adding a sites entity would change the CRM aggregate and belongs to a CRM decision.

### 2.4 Module plumbing, gating and what "module" costs

- Registry is a compile-time union with **one** entry and a typed CHECK
  (`installation-modules/registry.ts:7-24`; `installation_module_state.module_key CHECK
  IN ('OVERVIEW')`, `074_installation_operator_and_module_state.sql`).
- MOD-002 item 7: only Overview moves now; **every other module keeps its env key until
  its own slice and contract** (`DECISIONS.md:3778-3779`). Fail-closed on unreadable
  state, `503` (`DECISIONS.md:3774-3775`).
- Nav is capability-gated in one SSOT (`web/src/shell/navigation-model.ts:89-102`), and
  the mobile bottom bar has at most 3 direct links + create + menu (UI-004,
  `navigation-model.ts:54,121-131`) — a Maintenance entry would land in the menu
  panel, not the bottom bar.
- No attachments/photos anywhere: file upload is explicitly out of pilot scope
  (`PRODUCT_REQUIREMENTS.md:424`); the only object storage is the backup R2 adapter
  (`server/src/modules/backup/r2.ts`).
- PDF generation already exists as a dependency: `pdfmake 0.3.11`
  (`server/package.json:43`), used by weekly reports (`server/src/modules/weekly-reports/pdf/`).

### 2.5 Everything a new job **type** would have to touch

This is the concrete price of "make maintenance a JobCard type" (inference: this list is
the reason to avoid it in slice 1):

| Decision point | Evidence |
| --- | --- |
| Submission readiness dispatch (falls through to "meeting" today) | `submission-policy.ts:387-392` |
| Lifecycle command dispatch (last branch = "waiting approval") | `policy.ts:146-148` |
| Staff occupancy type filter | `occupancy.ts:70` |
| Canonical duration + "planned interval type" | `job-card-duration.ts:5-11,42-44` |
| Assignment offers (only 2 types) | `assignment-offer-policy.ts:35` |
| Creatable types | `job-cards/service.ts:1852,3079` |
| DB `job_cards_type_check` | re-declared in `007_sales_meeting.sql:3`, `051_weekly_report_foundation.sql:18`, `057_sale_from_visit.sql:6` |
| Reports groupings / productive-work filters | `reports/repository.ts:886-905,1705-1760` |

PR **#513** (`origin/refactor/job-card-exhaustive-dispatch`, OPEN) converts the first two
rows into compile-time `never` failures (`policy.ts:54,159-164`;
`submission-policy.ts:388-396` on that branch). That makes forgetting a case impossible —
it does **not** reduce the number of places that must be decided. V11 in the 2026-11-25
research is exactly this finding.

---

## 3. What "maintenance" means for a Turkish dental/medical distributor

External evidence (all accessed 2026-11-26; see §11):

| # | Observation | Source |
| --- | --- | --- |
| E1 | Turkish dental distributors sell "satış sonrası hizmet": own technical service team, periodic maintenance agreements, fault repair, spare-part supply, calibration organized through TİTCK-authorized bodies, loaner device during repair, remote diagnosis first. | Net Dental (netdisdeposu.com), Dentem (dentem.com.tr/servis, "Son güncelleme: 9 Kasım 2026"), Alpay Diş Deposu (alpaydis.com.tr) |
| E2 | Dealers abroad model the same business as: every sold machine = a customer record with serial, site, warranty and contract, plus every visit since installation; preventive plans per calendar/meter; warranty repairs; SLA per customer; parts used per job. | FieldEx after-sales page (published 2026-10-16, updated 19 Oct 2026); Servatio (2026 guide, published 2026-05-20) |
| E3 | Service contracts are a separate commercial product (quoted → signed → active → renewing), bound **per machine**, not per customer, with price. | Servatio blog 2026-05-20 |
| E4 | Turkish technical service activity is a **licensed** activity: `Teknik servis faaliyet belgesi`, `teknik müdür`, `teknik personel`, device groups A/B/C, authorization by TİTCK; compliance deadline 01.01.2026. | RG 26/5/2023-32202 (`resmigazete.gov.tr/eskiler/2023/05/20230526-8.htm`), MADDE 4-10, Geçici MADDE 1(2); TİTCK sector document 04.04.2024 |
| E5 | The technician must issue a **technical service report** with: service provider identity; health provider + **related unit** + address; device name/brand/model/**serial**/**ÜTS barcode**/nameplate no; work performed; **technician name + signature**; **accompanying clinic staff name + signature**; date; report number; **spare parts used**; **measuring tools used**; a decision that the device is fit for use; a decision whether the work affects safety/performance. | TCS-KLVZ-09 guide (`titck.gov.tr/…/TCS-KLVZ-09 Teknik Servis Klavuzu…pdf`), report content list; RG 26/5/2023-32202 MADDE 10(8) |
| E6 | Records of service activities must be kept **at least 10 years** by both the technical service and the health provider. | RG 26/5/2023-32202, MADDE 10(10) and MADDE 11(5) |
| E7 | Warranty certificate is mandatory for devices that need technical service; warranty runs from the invoice date after acceptance, **minimum 2 years** (or the manufacturer's stated unit), and repair time is added to the warranty. | RG 26/5/2023-32202 amending the Sales/Advertising Regulation, MADDE 25/A-25/B (in force 01.01.2025); `mevzuat.gov.tr` 7.5.19666 |
| E8 | Health providers must keep their own device inventory documents and their own record of every technical service action on their devices (10 years). | RG 26/5/2023-32202, MADDE 11(2),(5) |
| E9 | Test/control/**calibration** is a *separately authorized* activity: technical services **cannot** perform it; a distributor typically brokers it through an authorized body and keeps the certificate. | TİTCK training deck (`TbbiCihazlardaGarantiveTeknikServisSrelerinelikinMevzuat…pdf`, 2024-11-28) "Teknik servislerde kısıtlanan faaliyetler"; TİTCK "Test, Kontrol ve Kalibrasyon" regulation page |
| E10 | Public hospital procurement asks for periodic maintenance at manufacturer-defined intervals with manufacturer checklists (e.g. autoclaves, 2 visits/year) and a signed service form. | Bozok University hospital tender spec (2026-10-27); Selçuk University compressor maintenance instruction (checks monthly, annual contract, form signed by both sides) |

**Inference.** The market shape is exactly the FieldEx/Servatio shape — installed base
first, then plans and calls — but in Turkey the *report document* is not a nice-to-have:
it is the artifact the regulation describes, and it is what the clinic keeps for 10
years. That argues for treat‑the-report‑as-a-first-class-output, and against treating a
"maintenance visit" as a free-text note on a task.

**Inference.** E9 draws a hard line: a Maintenance module may *store* calibration
certificate references; it must not present itself as performing calibration.

---

## 4. Capability evaluation

Legend: **S** ≈ one migration + module CRUD + one screen + tests; **M** ≈ adds a
worker/PDF/transactional cross-module write or a core decision; **L** ≈ several slices.
"Reg." = regulatory pull (E# from §3).

| # | Capability | What it is in a distributor | Who uses it | Data it needs | Warehouse / Accounting dependency | Reg. | Size | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | **Installed base / device registry** | One row per physical machine at a clinic: product, serial, ÜTS barcode, location/unit, install date, status | Admin (data quality), service coordinator, sales rep (read) | product, customer, serial, dates, provenance to the delivery | none (must not store quantity/stock/price) | E5,E7,E8 (report/inventory fields) | S | **CORE — first slice** |
| 2 | **Installation / commissioning visit** | The visit where a delivered device is installed, configured, handed over and the warranty starts | technician (Staff), coordinator | link to the `PRODUCT_DELIVERY`, checklist, dates, signatures | none | E4 ("kurulum" is a technical service activity), E5 | S–M | **CORE — second slice** |
| 3 | **Periodic / preventive maintenance plans** | Per-device interval + next-due date; generate or suggest visits | coordinator, manager | interval, last/next due, plan active flag | none | E10, E4 ("düzenli bakım programları oluşturulmalı") | M | **CORE — third slice** (needs occupancy decision) |
| 4 | **Corrective service calls** | Fault report → triage → technician visit → resolution | clinic calls the rep; coordinator logs; technician executes | fault text/code, device, priority, resolution | none | E4 MADDE 10(7), E5, 30-day usage-error report (MADDE 10(13)) | M | **CORE — third slice** (same slice as 3 or right after) |
| 5 | **Warranty tracking** | Start (invoice/acceptance), end, in/out-of-warranty | Admin, coordinator, sales | warranty dates + source | *date* only; the invoice itself is Accounting | E7 | S | **CORE fields now, logic later** |
| 6 | **Service report (checklist, measurements, photos, signature, PDF)** | The legal artifact handed to the clinic | technician produces, clinic signs, coordinator files | visit facts + report number + signatures | none for text; **photos need new storage** | E5, E6 | M (text+PDF) / L (+photos) | **CORE without photos; photos deferred** |
| 7 | **Calibration records** | Reference to a certificate issued by an authorized body, valid-until | Admin | certificate no, issuer, date, valid-until | none | E9 forbids self-performance; separate regime | S | **Store reference only, never a workflow** |
| 8 | **Spare parts used** | Which part was replaced on which device | technician | part no/description, quantity text, device, visit | **yes — a parts catalog with balances is Warehouse** (MOD-001 item 2) | E5 requires parts *on the report* | S (text) / L (catalog) | **Text on the report now; catalog → Warehouse** |
| 9 | **Service contracts / SLAs** | Paid coverage with response promises, renewal dates, value | manager, Accounting | contract terms, price, renewal, SLA clocks | **yes — Accounting** (MOD-001 item 3) | E3 (commercial) | M | **OUT of this module; Accounting A0** |

Two cross-cutting observations:

- **Everything above needs #1.** Warranty, plans, calls and reports are all keyed on "which
  physical unit". So #1 is not "one of nine options"; it is the substrate.
- **Nothing above needs stock.** The only Warehouse-entangled item is spare parts, and even
  there the *report text* is legally required while the *balance* is not.

---

## 5. Scope cuts

### Cut A (recommended first slice) — Installed base + device history

**Intent.** Answer, in one screen: *which machines does this clinic have, with which
serial, since when, what did we do to them, and is the warranty still valid?*

**In**

- Module-owned `maintenance_devices` (one row per physical unit per organization):
  `customer_id`, `product_id` + name/sku/model snapshots, `serial_no` (nullable),
  `uts_barcode_no`, `nameplate_no`, `location_label`, `installed_on`,
  `status` (`ACTIVE` / `IN_SERVICE` / `RETIRED`), warranty `started_on` / `ends_on`,
  `source_kind` (`DELIVERY_SEED` / `MANUAL`), immutable provenance
  (`source_delivery_job_id`, `source_delivery_item_id`), `version`, timestamps, actor.
- **Seed action** ("Teslimatlerden cihaz oluştur"): scan **COMPLETED** `PRODUCT_DELIVERY`
  lines with `delivery_purpose='SALE'`, propose device rows, human confirms. Idempotent by
  a partial unique key on `source_delivery_item_id`.
- Device detail page: identity, customer, warranty badge, **history** = linked JobCards
  (delivery / later visits) + manually appended service notes.
- Customer detail: a compact "Cihazlar" panel (count + list link).
- Role rules: Admin/Manager mutate, Staff read — mirroring DOM-004's catalog pattern
  (`DECISIONS.md:554-557`), because Staff are the ones standing in the clinic.
- Module lives behind a legacy env key first (MOD-002 item 7, `DECISIONS.md:3778-3779`).

**Out (deliberately)**

- Any quantity, stock, cost, price, contract, or location-in-warehouse field.
- Plans, due dates, workers, notifications.
- PDF, attachments, photos, signatures.
- New JobCard type; any change to `job_cards`, submission, approval or occupancy.
- A customer-sites/branches table (see §2.3).

**Prerequisites**

- **P1 (core, small):** expose `lotNo` / `serialNo` / `expiryDate` on the delivery line
  forms — the columns and API already accept them
  (`job-cards/handlers.ts:168`, `web/src/jobs/jobs-api.ts:603`). Without P1 every new
  device is serial-less.
- **P2:** a decision on provenance honesty — a device seeded from an item whose
  `serial_no` is `NULL` must be created as "serial missing" and shown as such, never
  filled by guesswork.
- **P3:** lock order extension in the ARC-003 sense (`DECISIONS.md:517`) if the seed
  transaction reads `job_cards` while writing `maintenance_devices`; read-only seeding
  avoids it.

**Depends on:** `products`, `customers`, `job_cards` (read only).
**Does not pre-empt:** Warehouse (no movement, no balance, no lot identity ownership) and
Accounting (no money, no invoice).

**Acceptance sketch (for the later contract):** seeding twice creates no duplicates;
a `NULL`-serial line yields a device flagged "seri no eksik"; deactivating a product does
not rewrite device snapshots; Staff keep organization-wide read like the CRM/catalog
pattern (`DECISIONS.md:528`) while mutations stay Admin/Manager-only; invalidating a
source delivery does not delete the device and is visible on it.

---

### Cut B — Service visit record + report PDF (+ commissioning)

**Intent.** Record what was actually done to a device, in the shape the regulation and the
clinic expect, and produce a printable report.

**In**

- Module-owned `maintenance_visit_details`, **one row per JobCard** (`job_card_id` UNIQUE):
  `device_id`, `visit_kind` (`INSTALLATION` / `PREVENTIVE` / `CORRECTIVE` / `INSPECTION`),
  `reported_fault`, `work_performed`, `resolution`, `suitability_decision`
  (`SAFE_TO_USE` / `NOT_SAFE_TO_USE`), `spare_parts_note` (text), `measured_tools_note`,
  `next_due_on`, technician + `technician_name_snapshot`, `accompanying_staff_name` +
  title, `report_no`.
- The **work** is an existing JobCard (`GENERAL_TASK`; customer derived from the device and
  validated against `job_cards.customer_id`, cf. `service.ts:8599`). Assignment, approval,
  occupancy and audit are untouched.
- Service report **PDF** with the E5 field list, rendered from the module table + JobCard
  facts, using the existing `pdfmake` dependency.
- Checklist: **fixed in code per `visit_kind`**, not a user-defined form builder
  (UI-002, `DECISIONS.md:112`).
- Warranty "in/out" derived from dates, never stored as mutable state.

**Out**

- Photos and file attachments (needs object-storage + retention + backup decisions; today
  files are out of scope, `PRODUCT_REQUIREMENTS.md:424`).
- Digital signature capture (canvas image) — see open question 7.
- Calibration workflow (store the certificate reference only).
- Any auto-creation of visits.

**Prerequisites**

- Deciding **which JobCard type carries a visit** (GENERAL_TASK now vs a new type later).
  Choosing a new type pulls in every row of §2.5 plus V11/PR #513.
- Deciding whether the submission is *gated* on visit details. Gating means a
  type-specific submission contribution — the pattern proposed in
  `2026-11-25-…-research.md` §3b A — which is a **core** change, not a module change.
- Contract update to `docs/features/` + DECISIONS record (a new module with its own
  audit and data).

**Depends on:** Cut A. **Size:** M.

---

### Cut C — Preventive plans, due dates and corrective intake

**Intent.** Stop relying on memory: know which device is due, and turn a phone call into a
planned, occupied, approved visit.

**In**

- `maintenance_plans`: per device, `interval_months`, `last_done_on`, `next_due_on`,
  `is_active`; "due" list; explicit "ziyaret oluştur" action that creates a JobCard.
- Optional scheduled worker that *proposes* due visits (never silently completes work) —
  following the existing worker pattern (`assignment-offer-expiry-worker.ts`,
  `overdue-reminder-worker.ts`) and AGENTS.md §7 (claim idempotency before side effects).
- Corrective intake: fault report on a device → prioritised visit; repeat-failure hint
  (same device, same fault within N days).
- Notifications reuse the existing notification module.

**Out**

- SLA clocks and response-time penalties (commercial → Accounting).
- Recurring plan templates marketplace / per-brand interval libraries.
- Any automatic completion, any auto-approval.

**Prerequisites — the real one:**

- **Occupancy.** SCH-001 item 1 fixes occupancy to "active on-site jobs
  (`SALES_MEETING`, `PRODUCT_DELIVERY`)" (`DECISIONS.md:3694-3702`) and the single reader
  filters exactly those two types (`occupancy.ts:70`). A maintenance visit that occupies a
  technician therefore requires either (a) a new type added to the core filter + conflict
  source (`source: 'JOB' | 'MANUAL'` at `occupancy.ts:23-24`), or (b) a module table that
  contributes to core occupancy — the path §5a of the 2026-11-25 research already
  anticipates ("Bakım randevuları … aynı katkı yoluyla bağlanır"). Either is a **decision
  with a DECISIONS record**, not an implementation detail.
- Whether maintenance work should appear in staff performance reports (currently
  `PRODUCT_DELIVERY`/`SALES_MEETING` shapes, `reports/repository.ts:886-905`).

**Depends on:** Cut A + the occupancy decision. **Size:** M–L.

---

### Excluded (with reasons, not just "later")

| Excluded | Why | Where it belongs |
| --- | --- | --- |
| Service contracts, SLA, renewal value | Price, invoicing and receivables are Accounting's; a contract with money is a commercial document | Accounting A0 (MOD-001 item 3, `DECISIONS.md:2032-2040`) |
| Spare-parts catalog with stock/balances | "The same operational stock quantity must not be managed as independent authoritative state in two systems" | Warehouse (MOD-001 item 2, `DECISIONS.md:2022-2031`) |
| Calibration execution/authorization | Separate TİTCK regime; technical services cannot perform test/control/calibration (E9) | Outside the product; store the certificate reference only |
| Photo/file attachments | No file storage except backup R2; retention + backup + access rules needed | Separate infrastructure decision |
| Customer self-service portal | There is no customer identity in the product — roles are `ADMIN`, `MANAGER`, `STAFF` only (`server/src/modules/auth/types.ts:1`) | Not planned |
| New delivery purpose `MAINTENANCE` | DOM-001 fixes the five purposes and a visit has no quantity (`DECISIONS.md:349-351`) | Do not do this |

---

### Comparison

| | Cut A | Cut B | Cut C |
| --- | --- | --- | --- |
| New module tables | 1 (+history notes) | +1 | +1..2 |
| Core files touched | delivery form only (P1) | possibly submission policy | occupancy + duration + reports |
| New job type | no | no (or optional) | no |
| Warehouse dependency | none | none | none |
| Accounting dependency | none | none | none |
| PDF | no | yes | reuses B |
| Worker/notifications | no | no | yes |
| Regulatory pull | indirect (E5/E7/E8 fields) | **direct** (E5/E6) | indirect (E10) |
| Size | S | M | M–L |
| User value on day one | "what does this clinic have?" | "what did we do, and here is the signed report" | "nothing is forgotten" |

---

## 6. Recommended first slice and why

**Recommendation: Cut A, with P1.** It is the smallest thing that (a) does not exist at
all today, (b) every later capability needs, and (c) cannot be done wrongly by a later
module replacing it.

Why not Cut B first: the report has no subject without the registry, and its data would
have to be invented per visit. Why not Cut C first: it schedules work against a device that
does not exist yet and forces the occupancy decision before the module has proven it needs
one.

Why Cut A is genuinely valuable, not plumbing:

- A dental distributor's commercial asset **is** the installed base. Today Servora-Med can
  tell you every delivery ever made (`reports/routes.ts:41`, `reports/repository.ts:886-905`)
  but cannot tell you whether the CBCT at a clinic is the one delivered in 2023, whether
  it is still under warranty, or when anyone last touched it.
- It converts already-approved records into the new asset, so a customer with years of
  delivery history gets value without re-entering data — **conditional on P1 and on the
  serial backfill being accepted as incomplete**.
- It is the natural place to stop and ask the owner the open questions below before the module
  takes on scheduling, money or stock.

What Cut A must **not** do, to keep Warehouse/Accounting unpreempted:

1. No `quantity`, `stock_status`, `warehouse_id`, `cost`, `price`, `contract_id`.
2. No lot/serial ownership claim: the module stores the serial **as observed on the
   installed unit**; if Warehouse later introduces a unit/lot table, this registry must
   become a consumer keyed by serial or FK (MOD-001 item 2 "single stock source of truth").
3. No device state that duplicates JobCard state ("in service" is an *asset* status,
   distinct from job status; it must never be derived from a job status).
4. The module never writes core tables.

---

## 7. Seeding the registry from existing data (question 4)

**Available seed (observed):**

```sql
-- candidate only; not executed, not a migration
SELECT j.id            AS delivery_job_id,
       di.id           AS delivery_item_id,
       j.customer_id,
       di.product_id,
       di.serial_no,
       di.lot_no,
       di.delivered_at,
       j.manager_approved_at
FROM job_card_delivery_items di
JOIN job_cards j ON j.organization_id = di.organization_id AND j.id = di.job_card_id
WHERE j.type = 'PRODUCT_DELIVERY'
  AND j.status = 'COMPLETED'          -- approved work only, cf. DOM-006
  AND di.delivery_purpose = 'SALE'    -- a sold device, not a sample/consignment
ORDER BY j.customer_id, di.delivered_at;
```

Columns and their homes: `serial_no` `002_delivery_tracer.sql:151`; `lot_no` `:150`;
`delivered_at` `:144`; purpose CHECK `:142-143`; job → customer `:64`; approval time from ARC-001/JOB-004 fields.

Refinements (inference):

- Sale-driven deliveries carry `delivery_source_sale_id`
  (`071_sale_standalone_and_delivery_link.sql:22-32`), so the seed can prefer those and
  additionally link a device to a `SALE` line later.
- **Idempotency key** must be `(organization_id, source_delivery_item_id)` unique, so the
  seed can run repeatedly (AGENTS.md §7).
- **Invalidation**: an ADMIN may invalidate a terminal historical card
  (`job-cards/routes.ts:87`, `service.ts:1623-1660`), so a device whose provenance was
  later invalidated must be *flagged*, never deleted. A device is a physical fact; the
  paper that produced it can be wrong.
- **Serial-less seed**: today's most likely case. Device rows must be creatable with
  `serial_no = NULL`, `serial_missing` surfaced in UI, and a "complete the serial" task
  list for the Admin.

**Is there a serial anywhere else today?** No. `serial_no` exists only on
`job_card_delivery_items`; there is no product-level serial/IMEI/asset table, and
DOM-004 forbids a product-level tracking flag (`DECISIONS.md:549-552`).

---

## 8. Testing the owner's hypothesis

> "Assignment, lifecycle and approval stay in JobCard; device service history lives in
> the Maintenance module."

| Part | Verdict | Evidence / refinement |
| --- | --- | --- |
| Assignment + acceptance stay in JobCard | **Hold** | Re-implementing JOB-010 offers, deadlines, decline/release and expiry worker is a second policy engine (`assignment-offer-policy.ts`, `DECISIONS.md:3162-3288`) |
| Lifecycle (start/submit/approve/revision/invalidate) stays in JobCard | **Hold** | One state machine, one audit vocabulary, one idempotency mechanism (`types.ts:11-30`, ARC-001) |
| Approval stays in JobCard | **Hold, with a caveat** | Approval of *work* is JobCard's. Approval of *service content* (a report the clinic signed) is not a JobCard concept — if the org needs "the coordinator reviews the report before it is printed", that is a module workflow or an approval note, not a second approval gate |
| Occupancy stays in JobCard | **Hold, and it is a blocker for Cut C** | `occupancy.ts:70` only counts two types; SCH-001 makes this a core rule, so a maintenance visit needs an explicit decision |
| Device service history lives in Maintenance | **Hold** | Nothing in the core is device-shaped; a device FK on `job_cards` would repeat the V6 problem (core tables carrying module dictionaries, `2026-11-25-…-research.md` V6) |
| …but the *visit* itself | **Refine** | The visit is a JobCard (or, if the owner insists on a module-owned visit, that is a second lifecycle and must be justified against AGENTS.md §2.1). Only its service facts are module-owned |

**Refined statement I would put in the eventual decision record:** JobCard owns *work*
(assignment, lifecycle, approval, occupancy, audit). Maintenance owns *assets and service
facts* (device identity, provenance, warranty, visit details, reports, plans) and reads
core tables, never writes them.

---

## 9. Constraints any cut must respect (checklist for the contract author)

1. **No core→module FK.** Module tables may reference `customers`, `products`, `job_cards`,
   `users`; the reverse is forbidden (V6).
2. **Offboarding.** `people/offboarding.ts` already writes many tables (V5 in the
   2026-11-25 research counts ~21; examples at `:580,605,652,672,682,804`) and V5 calls
   every new module a breakage risk. A `technician_user_id` needs an explicit rule:
   transfer open visits to a successor, keep the historical name snapshot, never block
   offboarding.
3. **Customer delete.** `crm/service.ts:374-386` blocks delete when jobs exist and maps FK
   violations (`23503`) to `CUSTOMER_HAS_OPERATION_HISTORY`
   (`service.ts:399-407`). A device FK will hit that path; the message must stay truthful.
4. **Restore + module state.** MOD-002 restore semantics (`DECISIONS.md:3776-3777`) and the
   fail-closed `503` (`DECISIONS.md:3774-3775`) apply if the module is registered.
5. **Backup.** New tables enter the existing encrypted backup/restore; no new store.
6. **Idempotency + audit in one transaction** for every mutation that creates business
   facts (device create-from-delivery, visit detail create, report issue) — AGENTS.md §7,
   ARC-001.
7. **10-year retention** (E6) means: no hard delete of devices or visit details, ever;
   status-based retirement only.
8. **Turkish UI, English code** (AGENTS.md §14); WCAG 2.2 AA is a completion criterion
   (`PRODUCT.md:80`), and UI-003 requires rendered evidence at mobile and desktop widths
   (`DECISIONS.md:123-142`).
9. **No `organization_settings` bag** for checklist/interval configuration (UI-002,
   `DECISIONS.md:112`); typed columns or fixed in-code lists.
10. **Do not** extend `delivery_purpose` with a maintenance value (DOM-001).

---

## 10. Sizing and sequencing against other modules

| Step | Content | Gate |
| --- | --- | --- |
| 0 | Decision record: module boundary, device identity + provenance, serial ownership vs Warehouse, retention | owner + this note |
| 1 | **Cut A** + P1 (delivery serial fields) | step 0 |
| 2 | **Cut B** (visit details + PDF + commissioning) | step 1; decision on visit carrier (GENERAL_TASK vs new type) |
| 3 | Occupancy decision for maintenance visits (DECISIONS record; extend `occupancy.ts`) | step 0/2 |
| 4 | **Cut C** (plans + due list + corrective intake) | step 3 |
| — | Module panel registration (MOD-002 extension: registry union, CHECK, capability, nav) | independent, small, after Cut A proves the boundary |
| — | Spare parts | only with Warehouse |
| — | Contracts/SLA | only with Accounting A0 |

Warehouse and Accounting do not block Cut A or Cut B. Cut C is blocked only by the
occupancy decision, not by Warehouse.

---

## Open questions for the owner

1. **Legal role.** Is the company the *importer/manufacturer* (so it must issue warranty
   certificates and register technical-service commitments in ÜTS) or only a dealer
   working under someone else's warranty? This changes whether warranty data is
   mandatory in the product or just useful.
2. **Does the company perform technical service itself** (own `teknik servis faaliyet
   belgesi` + `teknik müdür` + technical personnel), or does it subcontract to an
   authorized service? If subcontracted, the report is produced by the subcontractor and
   the module's job is only to *record* it.
3. **Are devices serial-tracked today**, and where? (Excel, ERP, the manufacturer's portal,
   or nowhere.) This decides whether Cut A can seed from deliveries or must start as a
   manual entry exercise.
4. **Who are the technicians?** Existing Staff users with the same mobile app, a separate
   technician group inside the same Staff role, or a role the product does not have? (The
   role set is fixed at `ADMIN|MANAGER|STAFF`, `auth/types.ts:1`, and JOB-010/SCH-001 lean
   on exactly those.)
5. **Is maintenance billable today** (annual contracts, per-call invoicing)? A "yes" pulls
   Accounting into scope earlier and changes Cut C's shape.
6. **Do clinics need per-department locations** (e.g. a hospital with radiology,
   sterilisation, and three operatories)? If yes, is a free-text label enough for V1?
7. **Signature:** is a printed PDF signed with a wet signature acceptable, or must the
   signature be captured digitally in the app (which forces a storage/imaging decision)?
8. **Should maintenance work count in staff occupancy and performance reports**, or is it a
   separate workload with its own KPIs? (Occupancy is a core rule, SCH-001.)
9. **Does the module need to be switchable from the operator panel at launch**, or is an env
   key acceptable for the first slice (MOD-002 item 7 pattern)?
10. **10-year retention:** is a database record enough, or must the signed report *document*
    be archived (PDF/scan) for the full period?

---

## Unverified items

- **Serial coverage in production data.** Proven: no UI writes `serial_no`. Not proven:
  that no serials were ever inserted by import/seed scripts or direct SQL. I had no
  database access.
- **Applicability of the technical-service regulation to this company's device groups**
  (A/B/C classification per device). I read the regulation and guides; I did not confirm
  which of the company's products need technical service at all (MADDE 25/A excludes
  devices that do not).
- **A statutory preventive-maintenance interval** for dental chairs/units. I found only
  manufacturer-IFU and public-procurement requirements (E10), not a national fixed
  interval. Do not encode one as law.
- **E9's "technical services cannot perform test/control/calibration"** comes from a TİTCK
  *training deck* (2024-11-28) and TİTCK's separate regulation page, not from a single
  article I read verbatim. Treat as directionally correct, confirm before product copy
  states it.
- **Device counts, delivery volumes, clinic sizes** — no data access.
- **Whether `GENERAL_TASK` is an acceptable carrier** for a maintenance visit in the
  owner's mental model (it has no planned-interval requirement and no canonical duration,
  `job-card-duration.ts:42-44`), or whether the module should wait for a real
  `MAINTENANCE_VISIT` type. This is a product decision, not a fact.
- **PR #513 / weekly-report-submission line numbers.** I cited `origin/main` line numbers;
  after either merge the cited dispatch lines move (`policy.ts:146-148` →
  `policy.ts:159-164` on #513, `submission-policy.ts:387-392` → `388-396`). Re-check before
  quoting in a contract.

---

## 11. External sources (accessed 2026-11-26)

| Source | URL | Date on page |
| --- | --- | --- |
| Teknik Servis Yönetmeliği, RG 26/5/2023-32202 (full text) | https://www.resmigazete.gov.tr/eskiler/2023/05/20230526-8.htm | published 2023-05-26 |
| TİTCK guide TCS-KLVZ-09 (technical service report content) | https://www.titck.gov.tr/storage/Archive/2026/contentFile/TCS-KLVZ-09%20Teknik%20Servis%20Klavuzu_de2371d9-c0d5-4f0f-b0f2-40159be4bc07.pdf | guide dated 21/8/2024 |
| TİTCK, warranty & technical service legislation deck | https://titck.gov.tr/storage/Archive/2024/dynamicModulesAttachment/TbbiCihazlardaGarantiveTeknikServisSrelerinelikinMevzuat_2c848d9c-f150-46a6-a263-d3cb02f215da.pdf | 2024-11-28 |
| TİTCK clinical engineering / test-control-calibration page | https://www.titck.gov.tr/faaliyetalanlari/tibbicihaz/klinik-muhendislik | accessed 2026-11-26 |
| Sales/Advertising Regulation (warranty MADDE 25/A-25/B) | https://www.mevzuat.gov.tr/MevzuatMetin/yonetmelik/7.5.19666.pdf | consolidated text |
| TİTCK medical device sector document (01.01.2026 authorization deadline) | https://www.titck.gov.tr/storage/Archive/2024/contentFile/TIBB%C4%B0%20C%C4%B0HAZ%20SEKT%C3%96R%C3%9C%20STRATEJ%C4%B0%20BELGES%C4%B0%2004.04.2024_9efccd67-9113-41a2-9592-52c2acfaff76.pdf | 2024-04-04 |
| FieldEx after-sales for equipment distributors | https://www.fieldex.com/en/solutions/after-sales-service | published 2026-10-16, updated 2026-10-19 |
| Servatio (medical/dental equipment dealer service software) | https://servatio.io/ ; https://servatio.io/blog/service-contract-management-software | blog 2026-05-20 |
| Dentem technical service (local practice: remote first, calibration via authorized body, loaner) | https://dentem.com.tr/servis | "Son güncelleme: 9 Kasım 2026" |
| Net Dental (local practice: installation, maintenance, calibration, repair) | https://www.netdisdeposu.com/ | accessed 2026-11-26 |
| Public hospital periodic-maintenance tender spec (6-month interval, manufacturer checklists) | https://hastane.bozok.edu.tr/duyuru/otoklav-cihazlarinin-1-yillik-bakim-onarimi,tr-3099.aspx | 2026-10-27 |
| University compressor maintenance instruction (annual contract, jointly signed form) | https://webadmin.selcuk.edu.tr/uploads//contents/dis_hekimligi/icerik/61703/73-TY.TL.73.-HAVA%20KOMPRES%C3%96RLER%C4%B0%20BAKIM%20TAL%C4%B0MATI_639093390081084413.pdf | revised 2024-06-03 |

No company or customer name from this repository was used in any search.

---

## Appendix — file index for the reviewer

| Path | What it shows |
| --- | --- |
| `server/src/modules/job-cards/types.ts:11-30` | type + status vocabularies |
| `server/src/modules/job-cards/types.ts:797-813` | delivery line DTO incl. `serialNo` |
| `server/src/db/migrations/002_delivery_tracer.sql:4-31,137-159` | customer single address; delivery line columns |
| `server/src/db/migrations/071_sale_standalone_and_delivery_link.sql:22-32` | sale → delivery link |
| `web/src/JobDetail.tsx:1310-1326` | delivery UI without serial |
| `web/src/DeliveryCreate.tsx:37,116,378-389` | create form: product + quantity + one purpose |
| `server/src/modules/job-cards/policy.ts:146-148` | V11 lifecycle fall-through (origin/main) |
| `server/src/modules/job-cards/submission-policy.ts:387-392` | V11 submission fall-through |
| `server/src/modules/job-cards/occupancy.ts:70` | occupancy type filter (core rule) |
| `server/src/modules/job-cards/job-card-duration.ts:5-11,42-44` | canonical durations / planned-interval types |
| `server/src/modules/job-cards/assignment-offer-policy.ts:35` | offer-eligible types |
| `server/src/modules/installation-modules/registry.ts:7-24` | module registry, one entry |
| `web/src/shell/navigation-model.ts:89-102` | capability-gated nav |
| `server/src/modules/crm/service.ts:374-386,399-407` | customer delete guard / FK mapping |
| `server/src/modules/people/offboarding.ts:580,605,652,672,682,804` | offboarding's cross-table writes (V5) |
| `server/package.json:43` | `pdfmake` already a dependency |
| `DECISIONS.md:2022-2031,2032-2040` | Warehouse / Accounting ownership |
| `DECISIONS.md:3692-3717` | SCH-001 occupancy is core |
| `DECISIONS.md:3774-3779` | MOD-002 fail-closed + "only Overview moves" |
