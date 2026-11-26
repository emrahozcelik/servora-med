# 06 — First Warehouse/Stock slice: W0 (module plumbing) + W1 (data ownership end-to-end)

> **Historical research — superseded for implementation by the owner-approved [README §§A–E](README.md).** R0/MOD-003 has merged (#520); do not repeat migration 075. The old W1 excludes receipts, assumes the assignee vehicle, reuses stale balances after enable, derives non-posting reasons and automatically reverses invalidated deliveries. Those proposals and dependent acceptance tests are superseded. Apply the revised readiness, physical-source, receipt, reconciliation and correction contracts instead. Retain this document as evidence, not as an executable implementation plan.


- **Date:** 2026-11-26
- **Status:** **PROPOSAL.** Not a decision. Nothing here is implemented and nothing here authorizes
  implementation. `AGENTS.md` §13 still forbids a full Warehouse module without explicit owner
  approval; this document exists so that approval can be given (or refused) against a concrete,
  small slice instead of a topic.
- **Repository state:** worktree `warehouse-module-research-0e4def`, HEAD `89bf6b1`
  (`Merge pull request #511 … feat/operator-module-pilot`). Read-only investigation: no build, test,
  migration, server or git write was executed.
- **Inputs:** `01-codebase-touchpoints.md`, `02-domain-model-options.md`,
  `03-jobcard-integration.md`, `04-regulation-and-industry.md`, `05-erp-integration-mode.md`
  (all in this folder, written by sibling researchers; **read, not edited**), plus `AGENTS.md`,
  `DECISIONS.md`, `docs/features/operator-module-pilot.md`,
  `docs/backlog/2026-11-25-core-modules-architecture-research.md`.
- **Evidence labels used below:**
  - `[CODE]` observed implementation today, cited `path:line` — re-verified by me unless marked
    *(inherited)*.
  - `[ACCEPTED]` accepted decision, cited `DECISIONS.md:line`.
  - `[PROPOSAL]` mine. Every proposal needs owner acceptance.
  - `[INHERITED]` a sibling-document claim I did not re-verify myself; treated as context only.
  - `[UNVERIFIED]` could not be verified in this run.

---

## Özet (TR)

- **Bu belge bir dilim önerisidir, karar değildir.** Depo/Stok modülünün ilk uçtan uca dilimi
  ("W1") ve onun ön koşulu olan modül kaydı genelleştirmesi ("W0") tanımlanır.
- **W0 ayrı ve küçük bir Core dilimidir:** `installation-modules/registry.ts` tek modüle kilitli
  (`registry.ts:7-15`), `installation_module_state.module_key CHECK (module_key IN ('OVERVIEW'))`
  (`074:59`), takeover imzası tek boolean (`takeover.ts:20-24`). Mesajlaşma ve takvim modülleri de
  aynı genişlemeyi beklediği için W0 onların da ön koşuludur.
- **W1'in kanıtı tek cümle:** yönetici onayı **tek transaction içinde** bir `ISSUE` hareketi yazar,
  ADMIN geçersizleştirmesi aynı transaction içinde **telafi hareketi** yazar; Core hiçbir stok
  bakiyesi tutmaz (MOD-001).
- **W1'e girenler:** modül anahtarı/capability, depo+araç konumları, açılış sayımı, depo↔araç
  transferi, onayda stok çıkışı, geçersizleştirmede telafi, bakiye + hareket listesi + "gönderilmemiş"
  listesi. **Girmeyenler:** iade, konsinye hareketi, lot/seri bakiyesi, SKT bloğu/FEFO, rezervasyon,
  kısmi teslim, ERP modu, ÜTS, değerleme, realtime, modül raporu, demo stok.
- **On sekiz çelişki/sapma çözüldü** (X1–X18: miktar alanı, `RETURN`/`CONSIGNMENT`, SKT zorlaması,
  offboarding, ters kayıt, denetim tablosu, konum seçimi, dilim sırası, "0 mı sayılmadı mı" …) — her
  biri gerekçeli öneri olarak §4'te; hiçbiri sessizce karara bağlanmadı.
- **Onay kapısı (stok yetersizliği) koşullu çalışır:** stok yalnızca **sayılmış** bir konumda
  zorunlu tutulur. Modül açık ama araç hiç sayılmamışsa onay **geçer** ve satır "gönderilmemiş"
  listesinde görünür; aksi hâlde modülü açmak tüm saha onaylarını kırar.
- **İki veri bütünlüğü koruması.** (1) **Çift düşüm (G3b):** mal, sayımdan **önce** teslim edilip
  sayımdan **sonra** onaylanırsa sayım o malı zaten dışlamıştır; onay hareket yazmaz
  (`DELIVERED_BEFORE_COUNT`), `delivered_at` yalnızca karşılaştırma anahtarıdır, hareketin
  `occurred_at` değeri onay anı kalır (X11). (2) **"Gönderilmemiş" listesi sınırlıdır:** yalnızca
  modülün **ilk açılışından sonra** onaylanan satırlar (ilk `enabled=true` operatör denetim kaydı)
  ve sayfalı; modül öncesi yılların geçmişi listeye hiç girmez.
- **Modül kapalıyken** onay normal çalışır, hareket yazılmaz; yeniden açılışta **geri doldurma yok**.
  Bu, kesim tarihi gerektirmeyen yapısal bir kuraldır (hareket yalnızca onay anında doğar).
- **Kalıcı kullanıcı silme** depo referansları yüzünden bugün **500** üretir (genel SQLSTATE eşlemesi
  yok, `errors/index.ts:48-53`); W1 bu üç referansı `inspectUserDeletion`'a eklemek zorundadır.
- **Tahmini büyüklük:** W0 ≈ 1 migration + ~12 dosya + ~450 satır; W1 ≈ 1 migration + ~12 yeni sunucu
  dosyası + ~6 web dosyası + ~14 test dosyası, toplam ~4.500 satır (etiketli tahmin, §9).

---

## 1. Verified baseline (what this proposal stands on)

Everything in this table was re-read at HEAD `89bf6b1`. Where a sibling document made the same claim,
the claim is marked *(inherited)* and I confirm it independently.

### 1.1 Core facts the slice depends on

| # | Fact | Evidence | Kind |
| --- | --- | --- | --- |
| F1 | No stock/depot/warehouse concept exists in application code | case-insensitive word search for stock, warehouse, depot, vehicle over `server/src` and `web/src` → `rg` exit 1, zero matches | [CODE] |
| F2 | No stock table exists in any migration; the word appears only as the reason code `MISSING_STOCK_OR_EQUIPMENT` | `rg -i stock server/src/db/migrations` → only `064:57`, `065:90`, `065:124` | [CODE] |
| F3 | Delivery lines already carry `delivery_purpose`, `quantity NUMERIC(12,3)`, `unit`, `lot_no`, `serial_no`, `expiry_date`, product snapshots | `server/src/db/migrations/002_delivery_tracer.sql:137-167` | [CODE] |
| F4 | `processed_actions` receipt: `UNIQUE (organization_id, user_id, client_action_id, operation_key)`, `status`, `response_body`; `request_hash` is part of the live contract and a mismatch is `CLIENT_ACTION_REUSED` | `002_delivery_tracer.sql:196-216`; `db/critical-action.ts:154-172` | [CODE] |
| F5 | `users` gains `UNIQUE (organization_id, id)` in migration 002, which is what every composite FK uses | `002_delivery_tracer.sql:2` | [CODE] |
| F6 | Approval is one transaction: `transitionWithVersion` sets `status`, bumps `version`, sets `manager_approved_at/by` in one statement | `job-cards/service.ts:7447-7456`; `job-cards/repository.ts:3510-3540` | [CODE] |
| F7 | `APPROVE` is the only command whose target is `COMPLETED`; operation key `JOB_APPROVE` | `job-cards/service.ts:6230-6258` | [CODE] |
| F8 | Delivery lines are frozen in `WAITING_APPROVAL`: item add/patch/remove all require `assertCanEdit` → `EDIT_JOB_FIELDS`, which is not granted in `WAITING_APPROVAL` or terminal states | `job-cards/policy.ts:160,380-381`; `service.ts:4532-4660` | [CODE] |
| F9 | `getSubmissionDeliveryItems` already reads the card's items `FOR UPDATE` on the caller's transaction | `job-cards/repository.ts:5224-5231` (interface `:1131`) | [CODE] |
| F10 | `JOB_INVALIDATE:<id>` is ADMIN-only, `clientActionId`-idempotent, refuses an already-invalidated card, and does not touch delivery items | `job-cards/service.ts:1623-1700`; `policy.ts:21-23`; `service.ts:1669-1671` | [CODE] |
| F11 | A 4xx business rejection inside the lifecycle finalize marks the intent `FAILED` with `failure_code = error.code`; the same `clientActionId` then replays `409` with that code but a generic message | `job-cards/repository.ts:5744-5746, 5820-5841, 360-364`; `service.ts:7252-7281` | [CODE] |
| F12 | `runCriticalAction` is the neutral receipt helper (claim → work in one tx → replay), maps `40P01`/`40001` to retryable `409 ACTION_IN_PROGRESS` | `db/critical-action.ts:138-220, 56-72` | [CODE] |
| F13 | Sale approval creates a `NEW` planned delivery card inside the same transaction as the sale's `COMPLETED`; no stock implication exists | `job-cards/service.ts:2814-2937`, called at `:7745` inside `runLifecycle` | [CODE] |
| F14 | At most one delivery per sale, ever; the slot is never reused | `071_sale_standalone_and_delivery_link.sql:26-43` | [CODE] |
| F15 | Product hard delete exists and blocks on `job_card_delivery_items` / `job_card_sale_items` only; every other FK is caught generically as SQLSTATE `23503` → same `PRODUCT_HAS_OPERATION_HISTORY` 409 | `products/routes.ts:19`; `products/service.ts:215-249`; `products/repository.ts:90-99` | [CODE] |
| F16 | The API draft still says "There is no physical delete or Product `DELETE` endpoint" — **drift**, recorded, not fixed here | `SERVORA_MED_API_DRAFT.md:489-490` vs `products/routes.ts:19` | [CODE] |
| F17 | Delivery quantity input is a whole integer 1–999 999 999; fractional historical rows stay readable and are never rounded | `job-cards/delivery-input.ts:22-38`; `DECISIONS.md:3458-3489` | [CODE]/[ACCEPTED] |
| F18 | Sale quantities are integer-forced by CHECK | `058_sale_integer_quantity.sql:18-23` | [CODE] |

### 1.2 Module plumbing (MOD-002) facts

| # | Fact | Evidence | Kind |
| --- | --- | --- | --- |
| M1 | Registry descriptor is a compile-time single-module literal type: `key: 'OVERVIEW'`, `capability: 'overviewDashboard'`, `legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED'`; the file states it is deliberately minimal (no prerequisites, graph, worker hooks, menu metadata, dynamic loading) | `installation-modules/registry.ts:1-30` | [CODE] |
| M2 | `installation_module_state.module_key` CHECK is `IN ('OVERVIEW')`; `source` CHECK is `('ENV_TAKEOVER','OPERATOR')`; `source`/actor pairing CHECK | `074_installation_operator_and_module_state.sql:51-65` (CHECK at `:59`, `:62`, `:64`) | [CODE] |
| M3 | `operator_audit_events.module_key` CHECK is `module_key IS NULL OR module_key IN ('OVERVIEW')`; event-type CHECK includes `MODULE_STATE_TAKEN_OVER`, `MODULE_STATE_CHANGED` | `074:80-99` (`:81`, `:87`) | [CODE] |
| M4 | Takeover takes `legacy: { overviewDashboard: boolean }` and indexes it by `module.capability`; `INSERT … ON CONFLICT DO NOTHING RETURNING` decides the winner; a missing row with an existing takeover event throws | `installation-modules/takeover.ts:20-65` | [CODE] |
| M5 | Takeover runs in the API process only, after schema verification, before `listen`; failure stops startup | `server/src/index.ts:320-329` | [CODE] |
| M6 | Read port: one primary-key read, no cache; `null` on missing row; throws on DB failure; `readModuleEnabledOrFalse` returns `false` + logs | `installation-modules/state.ts:42-63, 86-101` | [CODE] |
| M7 | Routes are registered unconditionally; the module gates inside the service: disabled → existing `404`; missing row or read failure → `503 MODULE_STATE_UNAVAILABLE`; no env fallback | `overview/service.ts:14-25, 91-101`; `app.ts:361-379` | [CODE] |
| M8 | Capability projection happens per request in `/api/auth/login` and `/api/auth/me`; `AuthenticatedCapabilities` has five required flags (`overviewDashboard`, `calendar`, `messaging`, `backup`, `demoDatasetCreation`) plus one optional (`duplicateCustomerComparison`); two are additionally role-scoped in `authenticatedUser` | `auth/handlers.ts:29-40`; `capabilities/types.ts:1-8`; `capabilities/service.ts:7-13, 24-47` | [CODE] |
| M9 | Operator toggle: lock account/session → `MODULE_MANAGEMENT` → lock state row `FOR UPDATE` → version compare → update + `MODULE_STATE_CHANGED` in one tx; same value + current version = 200, no audit | `operator/service.ts:127-160`; `operator/repository.ts:239-294` | [CODE] |
| M10 | Accepted runtime semantics: disabled → the module's own page answers `404`; unreadable → `503`; capability `false`; no env fallback; open sessions pick the change up via focus/visibility revalidation | `docs/features/operator-module-pilot.md` §7, OP6/OP12; `DECISIONS.md:3735-3788` §5 | [ACCEPTED] |
| M11 | Web capability parsing is explicit per flag with `=== true`; nav is capability-filtered and omits absent entries; route access is a single predicate; capability-off routes redirect to `/jobs` | `web/src/services/api.ts:19-26, 183-190`; `shell/navigation-model.ts:88-110`; `shell/route-access.ts:18-67`; `AppRouter.tsx:403-408` | [CODE] |
| M12 | Mobile bottom nav holds at most 3 direct links (5 slots incl. create + Menü) | `shell/navigation-model.ts:53-55, 104-110` | [CODE] |
| M13 | Operator module page copy is generic, derived from `module.label` ("… sayfası … görünür olacak"), with no "data is kept" sentence on disable | `web/src/operator/OperatorModulesPage.tsx:47-60` | [CODE] |

### 1.3 Data-lifecycle facts (offboarding / delete / restore / demo)

| # | Fact | Evidence | Kind |
| --- | --- | --- | --- |
| L1 | Offboarding is ADMIN-only, plan-hash + `clientActionId` idempotent, one transaction, deactivates the `users` row and never deletes it | `people/offboarding.ts:329-483`, `:438-461` | [CODE] |
| L2 | Offboarding mutates a hand-enumerated table list; there is no module extension point | `people/offboarding.ts:526-706` | [CODE] |
| L3 | Weekly reports already block offboarding with a structured 409 — the precedent for "a module may block" | `people/offboarding.ts:1050-1072` | [CODE] |
| L4 | Permanent delete is gated by a hand-written `EXISTS` union: business history vs active responsibilities | `people/repository.ts:157-305`; `people/service.ts:285-343` | [CODE] |
| L5 | There is **no** global SQLSTATE mapping: an unhandled `23503` becomes `500 INTERNAL_ERROR` | `errors/index.ts:48-53`; `app.ts:243-249` | [CODE] |
| L6 | Technical audit actors may be detached to a snapshot only for a closed allowlist of user-lifecycle events | `people/repository.ts:425-437` | [CODE] |
| L7 | Restore validates a hardcoded 13-relation list plus counts/orphan checks; module tables are dumped (whole-DB `pg_dump`) but not verified | `backup/restore/postgres.ts:11-25, 281-336` (loop at `:289`) | [CODE] |
| L8 | Restore refuses a dump whose `schema_migrations` ledger is not exactly the release catalog | `backup/restore/postgres.ts:163-196` | [CODE] |
| L9 | Post-restore the operator access reset runs; **module state is left exactly as the backup returned it** | `operator/restore-reset.ts:1-56` (comment `:9-11`) | [CODE] |
| L10 | Demo purge is a hand-written lock/delete plan with exact-id assertions and a closed 9-table history union; the analyzer is hand-enumerated and documents a past `FK 23503` incident | `demo-data/repository.ts:133-186, 764-803`; `demo-data/analyzer.ts:387-889`, comment `:558-569` | [CODE] |
| L11 | Demo data creation inserts DEMO users into a BUSINESS organization (mixed installation is real) | `demo-data/repository.ts:1040-1062` | [CODE] |
| L12 | A fresh install with `demoDataset` marks **every** user DEMO | `auth/setup.ts:152-164` | [CODE] |
| L13 | `audit_events` is a closed subject/event CHECK list, rewritten by migrations, `actor_user_id NOT NULL` FK to `users` | `060_crm_duplicate_review_decisions.sql:90-121`; `003_people.sql:31-53` | [CODE] |

### 1.4 What the accepted decisions already fix

| # | Rule | Evidence |
| --- | --- | --- |
| D1 | Core never produces stock balances, ledger entries or financial documents | `DECISIONS.md:2019-2020` (MOD-001 §1) |
| D2 | Warehouse owns depots, vehicle stock, quantities, reservations, movements, transfers, returns, corrections, lot/serial/expiry, and the movement↔source-operation link | `DECISIONS.md:2022-2025` |
| D3 | The single stock authority is set explicitly per deployment/integration mode; no tables now | `DECISIONS.md:2026-2031` |
| D4 | `CONSIGNMENT` and `RETURN` do not create stock movements | `DECISIONS.md:347-352` (DOM-001) |
| D5 | Catalog `unit` is informational; reference price has no stock/valuation meaning | `DECISIONS.md:547-552` (DOM-004) |
| D6 | No generic event bus / global outbox without a concrete producer and consumer | `DECISIONS.md:2041-2050` (MOD-001 §4) |
| D7 | Idempotency is mandatory for a named JobCard command list; **ordinary reference-data updates do not use response-caching idempotency** | `DECISIONS.md:379-411` (ARC-001) |
| D8 | Module state fail-closed: unreadable → `503`, capability off, no env fallback | `DECISIONS.md:3774-3777` (MOD-002 §5) |

---

## 2. W0 — module registry generalization (Core prerequisite, own slice)

### 2.1 Why W0 must be separate

Three independent facts force it:

1. A second module cannot exist at all: the CHECK at `074:59` rejects the INSERT, and the CHECK at
   `074:87` rejects its audit event. Both fail at commit, loudly — which is good, but it means
   "add WAREHOUSE" is a **Core migration**, not a module migration.
2. The descriptor type is a single-module literal union (`registry.ts:7-15`), so `legacyEnvKey` has
   no way to express "this module has no env source". WAREHOUSE has no `WAREHOUSE_ENABLED` today
   (verified: `config.ts:907-919` lists five capability flags, none of them warehouse).
3. Messaging and Calendar are the next two modules in the accepted order
   (`docs/backlog/2026-11-25-core-modules-architecture-research.md:227-228`, §5 steps 2–3). If
   WAREHOUSE widens the registry in a warehouse-shaped way, those two slices inherit the shape. Doing
   the widening once, module-agnostically, is cheaper than doing it three times.

W0 therefore contains **no stock concept**. Its acceptance test is "a second module key can be
enabled, disabled, taken over, and appears in `/api/auth/me`" — provable with a test-only descriptor
if the owner wants to defer WAREHOUSE entirely.

### 2.2 W0 contract

| # | Change | Shape | Why not smaller |
| --- | --- | --- | --- |
| W0-1 | Descriptor typing | `key: InstallationModuleKey` (derived from `INSTALLATION_MODULES`), `capability: ModuleCapability` (a union of `'overviewDashboard'` and `'warehouse'`), `legacyEnvKey: string` or `null` | Deriving `key` from the array (as `InstallationModuleKey` already does at `registry.ts:26`) is what makes the array the single source; `null` is the only way to say "no env source" |
| W0-2 | Takeover signature | `legacy: Partial<Record<InstallationModuleKey, boolean>>`; a module with `legacyEnvKey === null` inserts `enabled = false` with `source = 'FRESH_INSTALL'` and writes `MODULE_STATE_INITIALIZED`; a missing row with **either** takeover or initialize event still fails startup | Keeps the damaged-restore detection (`takeover.ts:40-50`) working for every module; see §2.3 for the alternative |
| W0-3 | Migration `075_*` | drop/recreate five CHECKs (no data rewrite): `installation_module_state_module_key_check`, `operator_audit_events_module_key_check`, `installation_module_state_source_check` (+ `'FRESH_INSTALL'`), `operator_audit_events_event_type_check` (+ `MODULE_STATE_INITIALIZED`), and `operator_audit_events_module_value_check` (add `MODULE_STATE_INITIALIZED` to the list of events whose `new_value` **must** carry a boolean `enabled` — today that list is only `TAKEN_OVER`/`CHANGED`, `074:107-119`) | One migration, five CHECKs, no data change. Without the fifth, an initialized row could be written without the `enabled` field that §5.9's window predicate reads |
| W0-4 | Capability projection | `AuthenticatedCapabilities.warehouse: boolean`; `DEFAULT_CAPABILITIES.warehouse = false`; replace `withOverviewDashboard` with `withModuleCapabilities(capabilities, { overviewDashboard, warehouse })`; two primary-key reads per `/me` | Two reads per auth call is the accepted cost (`state.ts:51`); a `readAll()` port is YAGNI until a third module lands |
| W0-5 | Pool-less test reader | `staticModuleStateReader` keeps its `boolean` signature and gains an optional per-key map (`staticModuleStateReader({ warehouse: true })`) | Existing call sites (`overview-service.test.ts`, `overview-routes.test.ts`, `operator-cli.ts:239`) must not be rewritten |
| W0-6 | Config | `config.capabilities.warehouse` is a static `false` (the DB row overrides it at runtime), documented as "no env source" | `config.capabilities` is typed as the full capability object (`config.ts:907-919`), so the field must exist to compile |
| W0-7 | Web | `paths.warehouse*`, a `warehouse` route id in `shell/route-identity.ts`, a capability-gated nav entry (sidebar + Menü, **not** in the 3-slot mobile `direct` list), a `route-access.ts` rule, a lazy screen, `capabilities.warehouse` parsing in `services/api.ts` | Every one of these has a stated SSOT; skipping one breaks breadcrumbs, context-return validation, or the mobile nav |
| W0-8 | Operator copy | add one sentence to the disable confirmation: "Veriler silinmez." (`OperatorModulesPage.tsx:47-60`) | True for every module, one line, and it is the sentence a warehouse operator needs before flipping a module off mid-season |
| W0-9 | CI/ops coupling | bump `HEALTH_SCHEMA_VERSION` in **both** env examples (`ops/examples/servora-med.env.example:31`, `ops/examples/servora-med-staging.env.example:34`); the gate at `ops/ci/verify-env-examples.sh:26-50` fails otherwise | Mechanical, but it fails the PR if forgotten |
| W0-10 | Module-event lookup index | add `operator_audit_events (module_key, occurred_at) WHERE module_key IS NOT NULL` (partial). Today only two module-scoped indexes exist: login (`074:123-125`) and takeover (`074:128-130`), neither of which serves "earliest enable of module X" | W1 needs the first-enable instant on every unposted request (§5.9). A sequential scan of a table that also holds every operator login is the wrong shape for a page-load query. The index is module-agnostic, so Messaging/Calendar reuse it |

**Explicitly not in W0:** dependency graph, prerequisites, worker hooks, menu metadata, dynamic
loading, per-module migration chains (`registry.ts:1-6` and
`2026-11-25-core-modules-architecture-research.md:214-217` both forbid them). A `copy` field, an
icon field, or a `requiresSetup` flag is a later, separate decision.

### 2.3 Fresh-install default and the `source` vocabulary

The question: a module with no legacy env key has no value to take over. Three options:

| Option | Mechanics | Problem |
| --- | --- | --- |
| (a) No row until the operator enables | `updateModuleEnabled` inserts on first enable | Loses the "missing row = damaged state" signal for that module; the operator's first enable becomes a special path; `STATE_MISSING` (`operator/service.ts:153`) would have to become "create" for one module and "error" for another |
| (b) Reuse `ENV_TAKEOVER` with `enabled=false` | Zero migration beyond the key CHECKs; audit event says `MODULE_STATE_TAKEN_OVER` | The audit trail asserts a takeover that never happened. Small lie, permanent |
| (c) **`'FRESH_INSTALL'` source + `MODULE_STATE_INITIALIZED` event** *(recommended)* | One extra CHECK value and one extra event type in the same W0 migration | Two vocabulary additions for one honest fact |

Recommendation: **(c)**. The whole point of MOD-002's audit trail is that "why is this module on/off"
is answerable from records; option (b) makes the first question about a warehouse module produce a
false answer.

Alternative if the owner wants the absolute minimum: (b), with the mismatch documented in the module
contract. Cost of being wrong: an operator reading the audit log believes WAREHOUSE inherited a
setting from an env key that never existed.

### 2.4 W0 files touched

| Layer | File | Change |
| --- | --- | --- |
| Server | `modules/installation-modules/registry.ts` | descriptor types, second entry |
| Server | `modules/installation-modules/state.ts` | static reader map |
| Server | `modules/installation-modules/takeover.ts` | `Partial<Record<…>>`, fresh-install branch |
| Server | `modules/operator/service.ts` | none expected (iterates `INSTALLATION_MODULES`, `:127-133`) |
| Server | `modules/capabilities/{types,service}.ts` | `warehouse`, `withModuleCapabilities` |
| Server | `modules/auth/handlers.ts` | two-key projection |
| Server | `config.ts` | static `warehouse: false` |
| Server | `index.ts` | takeover call site |
| Server | `app.ts` | fallback reader, warehouse route registration (W1) |
| DB | `db/migrations/075_*` | five CHECKs + the module-event lookup index |
| Ops | two env examples | `HEALTH_SCHEMA_VERSION` |
| Web | `services/api.ts`, `paths.ts`, `shell/{navigation-model,route-access,route-identity}.ts`, `AppRouter.tsx`, `operator/OperatorModulesPage.tsx` | capability + nav + copy |
| Tests | 4 files | takeover (multi-module, fresh-install, damaged restore), operator toggle for a second key, capability projection, nav omission |

### 2.5 W0 acceptance

| # | Given / When / Then |
| --- | --- |
| W0-A1 | Given a DB at 074 and a release at 075, when the API starts, then `installation_module_state` has one row per registry module; the WAREHOUSE row is `enabled=false, source='FRESH_INSTALL'`, and exactly one `MODULE_STATE_INITIALIZED` event exists |
| W0-A2 | Given two concurrent startups on an empty state table, when both run takeover, then exactly one row and one event per module exist (the `ON CONFLICT` winner rule at `takeover.ts:31-38` extends unchanged) |
| W0-A3 | Given a WAREHOUSE row deleted while a `MODULE_STATE_INITIALIZED` event remains, when the API starts, then startup fails (no silent re-derivation) |
| W0-A4 | Given the operator enables WAREHOUSE with the current version, when `/api/auth/me` is called, then `capabilities.warehouse === true` without a restart; disabling returns `false` and the nav entry disappears |
| W0-A5 | Given a stale `expectedVersion`, when the operator toggles, then `409 MODULE_VERSION_CONFLICT` and no audit event |
| W0-A6 | Given a pool-less `buildApp` in a unit test, when `moduleStateReader` is not supplied, then `warehouse` is `false` and nothing throws |

---

## 3. W1 — the slice

### 3.1 One-line statement

**W1:** an operator enables the Warehouse module; an ADMIN defines one depot and a vehicle per field
staff member; a manager posts an opening count and loads the van with a depot→vehicle transfer; a
manager approves a `PRODUCT_DELIVERY` and the approval transaction writes exactly one `ISSUE` per
eligible line from the assignee's vehicle; an ADMIN invalidation of that completed card writes one
`REVERSAL` per original movement in the same transaction; every number is explainable from the
app's own balance board, movement list and "gönderilmemiş" (unposted) list.

Two merge steps, one slice:

- **W1a — the module owns data, no Core behaviour change:** migration, locations, opening count,
  transfer, balance board, movement list.
- **W1b — the boundary is proven:** posting port inside `approve`, reversal inside `invalidate`,
  unposted list, permanent-delete blockers, product-delete message.

W1a can ship and be reviewed on its own; nothing in Core changes behaviour until W1b.

### 3.2 What W1 contains

| Capability | Command / read | Actor | New table rows | Core touched |
| --- | --- | --- | --- | --- |
| Module on/off | operator `PUT /api/operator/modules/WAREHOUSE` | installation operator | `installation_module_state`, `operator_audit_events` | W0 only |
| Locations | `POST/PATCH /api/warehouse/locations`, `GET /api/warehouse/locations` | ADMIN writes; all read (STAFF: own vehicle + depots) | `stock_locations` + `warehouse_audit_events` | none |
| Opening count / correction | `POST /api/warehouse/counts` (`isOpening`, `reasonCode`) | MANAGER, ADMIN | `stock_counts`, `stock_count_lines`, `stock_movements` (`OPENING`/`COUNT_ADJUSTMENT`), `stock_balances` | none |
| Transfer | `POST /api/warehouse/transfers` | MANAGER, ADMIN | `stock_transfers`, 2× `stock_movements`, `stock_balances` | none |
| Balance board | `GET /api/warehouse/balances?locationId&productId&includeZero` | all authenticated (scoped) | read only | none |
| Movement list | `GET /api/warehouse/movements?locationId&productId&kind&from&to` | all authenticated (scoped) | read only | none |
| Issue at approval | implicit in `POST /api/job-cards/:id/approve` | MANAGER/ADMIN (existing rule) | `stock_movements` (`ISSUE`), `stock_balances` | `job-cards/service.ts` (one call site), `app.ts` (wiring) |
| Reversal at invalidation | implicit in `POST /api/job-cards/:id/invalidate` | ADMIN (existing rule) | `stock_movements` (`REVERSAL`), `stock_balances` | `job-cards/service.ts` (one call site) |
| Unposted list | `GET /api/warehouse/unposted?reason&limit&cursor` — window starts at the module's first enable, response is paged (§5.9) | MANAGER, ADMIN | read only (anti-join over Core) | none |
| Permanent-delete guard | implicit in `DELETE /api/users/:id` | ADMIN | none | `people/repository.ts` (3 `EXISTS`) |

### 3.3 The posting ladder — where the gate actually bites

This is the most consequential design decision in W1 and it **modifies** the sibling recommendation
(03 §4 recommends an unconditional hard gate). The rule is evaluated per delivery line, inside the
approval transaction, after the module state is read on the same transaction:

| # | Condition | Approval | Movement | Visible where |
| --- | --- | --- | --- | --- |
| G0 | Module state unreadable (missing row / DB error) | **503**, card stays `WAITING_APPROVAL` | none | error + service log (fail closed, D8) |
| G1 | Module disabled | succeeds | none | not visible while off (the module's routes answer `404`, capability is false); after re-enable the line appears under its *then*-current reason |
| G2 | Module enabled; assignee has no vehicle location | succeeds | none | unposted list, reason `NO_VEHICLE_LOCATION` |
| G3 | Enabled; vehicle exists; the *location* has never been counted (no `stock_counts` header) | succeeds | none | unposted list, reason `LOCATION_NOT_COUNTED` |
| G3a | Location counted, but no `stock_count_lines` row for **this product** at it | succeeds | none | unposted list, reason `PRODUCT_NOT_COUNTED` |
| G3b | Product counted, and the latest count of that product at that location has `occurred_at >= delivered_at` | succeeds | none | unposted list, reason `DELIVERED_BEFORE_COUNT` |
| G4 | Otherwise (product counted and delivered after its latest count); balance ≥ quantity | succeeds | one `ISSUE` per line | movement list |
| G5 | Otherwise; balance < quantity | **409 `INSUFFICIENT_STOCK`** with per-line shortfall | none | approve dialog error |
| G6 | Line purpose is `CONSIGNMENT` or `RETURN` | succeeds | none | unposted list, reason `PURPOSE_EXCLUDED` |
| G7 | Card `data_class = 'DEMO'` | succeeds | none | not listed (demo purges as today) |
| G8 | Line quantity is not a whole integer (legacy row) | succeeds | none | unposted list, reason `LEGACY_FRACTION` |

Evaluation order (this is part of the contract, because several rows are true at once): G0 once per
transaction → G1 → G7 (card-level, first) → G6 → G8 (line-level filters that do not depend on stock)
→ G2 → G3 → G3a → G3b → G4/G5. A `CONSIGNMENT` line is therefore never gated by a stock balance, and
a DEMO card never resolves a vehicle at all.

Why the ladder and not one unconditional gate:

1. **G2/G3 are configuration states, not stock facts.** With an unconditional gate, enabling the
   module on an installation where nobody has created a vehicle yet would block *every* delivery
   approval until an ADMIN does setup — a module enablement that breaks field work is unacceptable
   and is exactly the "module becomes a Core dependency" failure 03 A20 forbids.
2. **"0" must never mean "never counted"** (03 §13 D5 raises this). G3/G3a remove the ambiguity at the
   source: without a count the module refuses to *claim* a balance, so it neither blocks nor posts.
   The distinction is answerable from data, not from message wording: `stock_counts` header = "this
   location was counted"; `stock_count_lines` row for a product = "this product was counted at this
   location, and its 0 means empty" (02 §7.4 stores zero-difference lines with
   `movement_id = NULL`). G3a exists because W1 allows subset counts: a counted location with an
   uncounted product must not produce a false `INSUFFICIENT_STOCK`.
3. **The gate still bites where it matters.** G5 is a real 409, so no approved delivery can take a
   counted location negative.
4. **The gap is visible, not silent.** G2/G3/G3a/G3b/G6/G8 all surface in the unposted list, which is
   a derived anti-join, so it cannot drift from reality. The reason shown is the *current*
   explanation (why this line would not post now), never a stored historical label — that is what
   keeps the list a derivation instead of a second state machine.

**G3b — the double-deduction guard.**

A delivery is handed over at `delivered_at` but posted at approval. If a count lands **between** the
two, the count already observed the shelf *without* those goods, and an approval-time `ISSUE` would
deduct them a second time:

| Instant | Event | Balance after |
| --- | --- | --- |
| T0 | opening count: 10 in the van | 10 |
| T1 | 3 units handed to the clinic (`delivered_at`) | 10 (nothing posted yet) |
| T2 | recount physically counts 7 → `COUNT_ADJUSTMENT −3` | 7 |
| T3 | manager approves the delivery | **4 without G3b**, 7 with it |

The same shape happens with the *opening* count: goods delivered before enablement, an opening count
that excludes them, an approval afterwards. The mirror case is safe: a count that comes **after** an
approval sees a system balance that already excludes the goods, so the difference is zero — only
count-then-approve is dangerous.

G3b is one predicate: the latest `stock_count_lines` row for `(location_id, product_id)` joined to
`stock_counts.occurred_at`; if that instant is at or after the line's `delivered_at`, the count
already excluded the goods and the approval posts nothing.

**`delivered_at` is a comparison key only.** The movement's `occurred_at` stays the approval instant
(§X11): the ledger remains posting-dated, needs no cutoff, and inherits none of `delivered_at`'s data
quality. `delivered_at` is read to answer one boolean question and is never copied into the movement.

**Coverage decision: per product, not per location.** The comparison uses the latest count *line* of
that product, because W1 allows subset counts; the location header alone cannot prove the product was
on the shelf. That is also why G3a exists. One indexed lookup serves G3a and G3b together (the count
header is a separate `EXISTS` for G3). The folder `README.md` summarizes this as "the location's last
count"; the precise rule is the product's last count line, and the difference shows only when counts
are partial — e.g. a location counted at T4 for product A says nothing about product B, whose own
last count was T2, so a B delivery at T3 must still post.

**`NULL` and future `delivered_at`:**

- `NULL` is unreachable for an approvable card: submission requires a valid date on every line
  (`submission-policy.ts:70-80`), and the column is nullable only for *planned* lines
  (`009_job_acceptance_and_scheduling.sql:43-45`). If it occurs anyway, the comparison cannot fire,
  so G4/G5 apply and the module logs the anomaly.
- A **future** date is accepted by Core with no bound (`parseDeliveredAt`, `service.ts:522-533`), so a
  typo can place `delivered_at` after the count instant. The comparison then says "not delivered
  before the count" and the line posts. G3b cannot rescue a wrong date — which is why the count screen
  must show the vehicle's open (not yet approved) delivery lines with their `delivered_at` and flag
  any date after the count instant (see the count-screen requirement below). Bounding `delivered_at`
  is a Core rule change, not W1.

**Rejected alternative: rely on the count screen alone.** Showing open deliveries while counting is
useful and is kept, but as the *primary* mechanism it makes correctness depend on a human reading a
list correctly at every count; G3b is one indexed comparison that cannot be forgotten. The screen
remains the only defence against a wrong date, so the two are complementary, not alternatives.

Count-screen requirement (W1a UI, not testable server-side): while posting a count for location L, the
screen lists every line of a `PRODUCT_DELIVERY` card assigned to L's vehicle that is not yet approved
(`NEW`/`ACCEPTED`/`IN_PROGRESS`/`WAITING_APPROVAL`/`REVISION_REQUESTED`) and carries a non-null
`delivered_at`, showing product, quantity and the date, and flagging any date after the count instant
as `kontrol edin`. That is the only place a wrong date can be caught before it becomes a ledger
difference; the same read is what G3b automates when the date is right.

Cost of being wrong: if a count is back-dated past a delivery that had not physically left, G3b skips
a deduction that should have happened. The balance is then too high until the next count, and the line
is visible in the unposted list with `DELIVERED_BEFORE_COUNT`, so the discrepancy is explainable
rather than silent. Neither 02 nor 03 considered the count-then-approve ordering; this is a gap in
both documents, not a conflict between them.

Cost of the ladder as a whole: an operator who enables the module and never sets up a vehicle sees a
fully working app, an empty stock screen and a populated unposted list — a training problem, not a
data-integrity problem, and strictly better than the alternative failure mode (all approvals blocked).
The unconditional gate is 03 §4's recommendation and stays defensible if the owner accepts "enable
only after setup" as an operational rule; it is a one-branch change.

### 3.4 Where the port sits in `approve`

Verified call path: `approve()` (`service.ts:6230`) → `runLifecycle()` (`:7225`) →
`reserveLifecycleIntent` (committed tx, `repository.ts:5570-5696`) → `finalizeLifecycleIntent`
(`repository.ts:5697-5863`) → work callback → `tx.transitionWithVersion` (`service.ts:7447`).

**One call, one seam, before the transition** *(differs from 03 §9.4/§11.3, which proposes two calls:
`precheck` + `post`)*:

```
approve → reserve (committed) → finalize tx:
  lock users → references → job_cards → read delivery items FOR UPDATE
  → warehouse.postApprovedDelivery(client, …)      ← single port call
        reads installation_module_state on the SAME client
        resolves location, locks/updates balances in sorted (location, product) order
        inserts one ISSUE per eligible line
        throws 409 INSUFFICIENT_STOCK (with shortfall) / 503 on state failure
  → transitionWithVersion(APPROVE) → COMPLETED + manager_approved_at
  → follow-up / sale-delivery / realtime as today
  → COMMIT
```

Why one call and not two:

- **One authority.** A read-only `precheck` followed by a `post` can disagree (two readers, two
  moments). One function that both decides and writes cannot.
- **The rejection rolls back the version bump either way.** Because approval is one transaction, a
  post-transition `409` would also leave `version` unchanged. The ordering is therefore about *cost
  and clarity*, not correctness — worth stating plainly because both 02 §9.2 and 03 §2.3 present
  "before the mutation" as a correctness rule. It is a cheapness rule.
- **Shortfall detail is built from the failed guard, not from a stale read.** The conditional update
  is the truth; when it returns `rowCount = 0`, the port re-reads that balance inside the same
  transaction to render "needed / on hand". This removes the "precheck said 1, update said 0" class
  of confusing message.

Ordering constraint that *is* correctness: the movement rows must be written in one sorted order —
`ensure-zero INSERT … ON CONFLICT DO NOTHING` **and** the conditional `UPDATE` for the same keys in
the same `(location_id, product_id)` sequence. Two statements in different orders on the same key set
is a textbook deadlock, and `runCriticalAction`/`finalizeLifecycleIntent` only *report* that
(`409 ACTION_IN_PROGRESS`), they do not prevent it.

**Module state must be read on the caller's client, not through the pool.** `PostgresModuleStateReader`
takes `Pick<Pool,'query'>` (`state.ts:52-63`), and a `PoolClient` satisfies it structurally — so the
port can construct a reader on the transaction client. Using the pool instead means (a) a second
connection acquisition while the transaction holds one (pool `max` defaults to 20,
`db/index.ts:92`), which is a saturation deadlock, and (b) a snapshot that is not the transaction's.

**Not call sites** (checked, because they are the easy mistakes): `createSaleApprovalDelivery`
(`service.ts:2814`) only creates a `NEW` planned card — it must not post (A19);
`applyPairApprove` (`:7099`) completes a `SALES_MEETING` and a `SALE`, never a `PRODUCT_DELIVERY`
(03 B15); `SUBMIT_FOR_APPROVAL`, `REQUEST_REVISION`, `WITHDRAW_FROM_APPROVAL` and `CANCEL` never post
(nothing was posted before the approval).

### 3.5 Where the reversal sits in `invalidate`

Verified: `invalidate()` (`service.ts:1623`) → ADMIN check → `executeCriticalAction` →
`tx.invalidateWithVersion` (`:1686`) → overdue closure → … → commit. **One call after
`invalidateWithVersion`, before commit**, receiving `{ organizationId, jobCardId, reasonCode,
invalidatedAt, actorUserId }`:

| Case | Behaviour |
| --- | --- |
| Delivery was posted | one `REVERSAL` per original `ISSUE`, `reversal_of_movement_id` set, `source_id` = original movement id, `source_job_card_id` copied from the original, `occurred_at` = invalidation instant |
| Delivery was never posted (G1/G2/G3/G6/G8) | `{ reversed: 0 }`, no rows |
| Delivery was `DEMO` | `{ reversed: 0 }` |
| Card already `INVALIDATED` | `409 JOB_ALREADY_INVALIDATED` before the port is reached (`:1669-1671`) |
| Same reversal attempted twice | blocked by `UNIQUE (organization_id, reversal_of_movement_id) WHERE movement_kind='REVERSAL'` → `409`, nothing written |

Reversal never edits the original, never reverses partially, and never becomes a `RETURN` purpose
(DOM-001/DOM-006 untouched).

### 3.6 Explicitly OUT of W1

Direct answers to the obvious "is X in?" questions, because the candidate slice in this task's brief
listed them:

- **Transfers: IN**, single-step, both directions between any two locations. They are not optional
  padding: without a depot→vehicle move, a depot and a vehicle are two disconnected counts and
  "single source of truth" cannot be tested; without vehicle→depot, a departing rep's stock could
  only be written off.
- **Returns: OUT.** Customer returns need an inspection/restock/scrap decision (W3).
- **Lot/serial/expiry balances: OUT** (attributes are carried, enforcement is W4).
- **Reservations: OUT** (a second quantity and a release matrix; SALE-002 forbids the bookkeeping).
- **ERP mode: OUT** (M0+M1 only; the module state *is* M1 in this release).
- **ÜTS: OUT** (no notification state, no identity fields beyond what the delivery line already has).
- **In-transit transfer state, valuation, realtime, module report, demo stock: OUT.**

| Out | Why | Earliest slice |
| --- | --- | --- |
| Customer returns (`RETURN_IN`) | Needs an inspection/restock/scrap decision and a supersession of DOM-001 if it is ever inferred from a delivery purpose | W3 |
| `CONSIGNMENT` stock (consignment location) | DOM-001 says consignment creates no movement; a consignment location is a new location type and a policy conversation | W4 (owner decision) |
| Lot-level / serial-level balances, tracking policy per product, serial uniqueness | `PRODUCT_REQUIREMENTS.md:285` keeps lot/serial/expiry optional and policy-free; enforcing them is a new product rule | W4 |
| Expiry (SKT) blocking, FEFO, expiry alerts | Same; also needs a picking UI | W4 |
| Reservations, partial delivery, remaining quantity | `DECISIONS.md:2154-2157` forbids remaining-quantity tracking; a release matrix is a second quantity to reconcile | W5 |
| ERP modes M2/M3, `stock_authority`, `location.authority` | `05` recommends M0+M1 only; a mode without an adapter is dead configuration | W6 |
| ÜTS notification state, ÜTS identity fields, web service client | `04` §8 Q6: fields + manual status only, and not before a real integration spike | W6 |
| Dispatch-note / e-İrsaliye generation | Accounting boundary (MOD-001 §3); W1 only stores an optional `document_no` on a transfer | never in WH |
| Stock valuation, cost, FIFO/average | `DECISIONS.md:549-552` (reference price has no financial meaning) and `DECISIONS.md:2019-2020`; no accepted costing model exists | never in WH |
| Realtime events, notifications, low-stock alerts | `01` H-list proposal; the `011`/`017`/`018`/`023` per-module FK columns on `realtime_events` *(inherited)* are Core churn for no W1 consumer | W3 |
| Module stock report | Core reports must not learn stock (DOM-006:685); a module report needs its own snapshot pattern | W3 |
| Demo stock | Production-only module (see §5.6); demo-aware tables would bump the purge-plan schema (`demo-data/types.ts:7`) | only on explicit request |
| Negative-stock ALLOW mode | One unrepresentable state (CHECK + conditional update) is worth keeping | owner decision |
| In-transit transfer state | `04` Q8 recommends single-step; a state column can be added later | later |
| Multi-session count drafts | A count is posted as one command | later |

### 3.7 Slice order

| Slice | Content | Depends on | Proves |
| --- | --- | --- | --- |
| **W0** | Registry generalization, WAREHOUSE key, capability, migration 075, nav gate, fresh-install source | owner approval | "a second module can exist" |
| **W1a** | Migration 076 (ledger tables), locations, opening count/correction, transfer, board, movement list | W0 | "the module owns stock data correctly" |
| **W1b** | Posting port in `approve`, reversal in `invalidate`, unposted list, delete blockers, product-delete message | W1a | "Core consumes module truth transactionally" |
| **W2** | Receipt (`RECEIPT` with document reference), transfer note/reason, delivery-screen stock advisory, per-line unposted decisions (`POSTED`/`NOT_POSTED`) | W1b | "a blocked approval is cheap to clear" |
| **W3** | Returns (`RETURN_IN`), standalone corrections, exception list, module report, realtime/no stock alerts | W1b + DOM-001 decision | "corrections and inbound goods" |
| **W4** | Lot/serial/expiry enforcement, tracking policy, SKT block, FEFO | W3 + product-policy decision | "regulated traceability" |
| **W5** | Reservations / partial delivery / remaining quantity | SALE-002 amendment | "double-promising is prevented" |
| **W6** | M2-R then M2-W ERP mode, ÜTS status fields | W3 + 05 triggers | "external authority" |

Order rationale: 02 §12 puts transfers (its W3) before the delivery issue (its W4) and starts with a
pure-infrastructure W1. I re-order because (i) the research order
(`2026-11-25-core-modules-architecture-research.md:94-99`) and this brief both ask for **one stock
movement end to end** as the first proof, and infrastructure alone proves nothing about ownership;
(ii) the delivery issue is the only Core-*consuming* operation, so it is the seam that must be
validated first; (iii) the transfer must come with the ledger anyway because without it a depot and a
vehicle are two disconnected counts and "single source of truth" is untestable.

---

## 4. Conflicts between research documents

Resolved as recommendations. Nothing below changes an accepted document; where a supersession is
needed it is named.

| # | Topic | Doc A says | Doc B says | Recommendation | Owner decision? |
| --- | --- | --- | --- | --- | --- |
| X1 | Stock quantity domain | 02 D8/§11, 04 Q1: whole integers | 05 Q7: `NUMERIC(12,3)` "because delivery items already use it" | **Integer** (`quantity_delta INTEGER`). DELIVERY-QTY-001 already forces whole units on input (`job-cards/delivery-input.ts:22-38`); SALE is integer-CHECKed (`058:18-23`); a fractional column would need a unit-conversion layer and a new accepted decision (`DECISIONS.md:3486-3489`). Legacy fractional delivery rows are handled by G8, not by widening the ledger. Widening `INTEGER → NUMERIC(14,3)` later is lossless | Yes (one line in the W1 decision) |
| X2 | `RETURN` delivery purpose | 02 OQ3, 03 §7: outbound `ISSUE` (a replacement handed to the customer) | 04 Q9: reuse `delivery_purpose='RETURN'` as the *return* source (inbound); 05 Q11: return becomes an inbound movement | **Neither in W1.** DOM-001 (`DECISIONS.md:351`) is explicit and W1 does not need the question answered: `RETURN` lines are excluded (G6). Then, with an explicit supersession sentence, adopt 02/03's reading (outbound issue) and model customer returns as `RETURN_IN` (W3). 04 Q9 and 05 Q11 both require rewriting DOM-001 and would double-count against the replacement delivery | Yes (needed before W3, not W1) |
| X3 | `CONSIGNMENT` | DOM-001: no movement | 04 §7 req 7 + Q7: consignment location in V1; 05 Q11: consignment = transfer to a consignment location | **Excluded from W1** (G6). If consignment is ever tracked it is a transfer to a `CONSIGNMENT_AT_CUSTOMER` location *and* an explicit DOM-001 amendment — a delivery-purpose-driven transfer still "creates a stock movement" for a `CONSIGNMENT` delivery | Yes (before W4) |
| X4 | Lot/serial/expiry | 02 D7/§7.5: attributes only, no lot balances, V1.1 | 04 §7 req 3/5/15: per-(product, depot, lot, serial, expiry) stock items, expiry block mandatory in V1 | **Split.** W1 stores `lot_no`/`serial_no`/`expiry_date` on the movement as copied attributes (cheap, one column each, matches the delivery line). *Enforcement* (mandatory lot, serial uniqueness, expiry block, FEFO) is W4 and needs a product tracking policy. Capturing identity without enforcing it is honest; enforcing it from an optional free-text field is not | Yes (04 calls expiry blocking mandatory) |
| X5 | Offboarding with stock in a vehicle | 02 §10.2: block with `VEHICLE_STOCK_NOT_EMPTY` + deactivate the location through a port | 03 §8/D4: change nothing; the `users` row survives; the module offers a transfer | **Third option:** offboarding does not block and Core writes nothing; the module *derives* usability from `users.is_active` (an inactive owner's vehicle cannot be a transfer destination, can be a source), shows it as an exception, and permanent delete is blocked (§5.5). No Core→module write, no cross-module lock, no race (02 admits its own read-then-act window) | Yes (behaviour) |
| X6 | Reversal on invalidation | 03 D2/OQ2: automatic, inside `invalidate` | 02 §12 W6: exception list + explicit `STOCK_REVERSE` | **Automatic** (03). `invalidate` is already an ADMIN "correct history" command with a reason code; a balance that stays wrong until a human notices is a data-integrity hole. The exchange is one extra Core call site, and it is the caller's own transaction — no new coupling class | Yes (03 flags it) |
| X7 | Insufficient-stock gate | 03 §4: unconditional hard gate (409) | 01 OQ2/earlier 03 draft: allow negative; 02 OQ2: block | **Block, but only inside the counted perimeter** (§3.3 ladder). 02's `CHECK (quantity >= 0)` + conditional update makes negative stock unrepresentable, so "allow" would need a schema change; but an unconditional gate turns module enablement into a Core outage. The ladder keeps the invariant and removes the trap | Yes (modifies 03) |
| X8 | Source location choice | 02 OQ4(b): the approving manager chooses in the approve dialog, defaulting to the vehicle | 03 D3: the assignee's vehicle only; override in the module's own panel | **03 for W1** (assignee's vehicle). 02's option needs an opaque module id in a Core request body — a module concept in a Core contract, and 03's "Core needs no `stockLocation` field" is the stronger boundary. The module-side override is W2 | No (lead may accept) |
| X9 | Config audit destination | 02 §9.4: location/settings changes go to Core `audit_events` (new subject/event values) | 01 H6: module-owned `warehouse_audit_events` | **Module table.** `audit_events` is a closed CHECK rewritten by migrations (`060:90-121`), `actor_user_id NOT NULL` (`003:35`), and has **no read surface today** — so the "one searchable surface" benefit is hypothetical while the CHECK churn is certain. Movements are their own audit; config changes get one module table. (05 §7 D3's claim that `audit_events` is people-scoped is factually wrong — `060` includes `CUSTOMER`, `PRODUCT`, `JOB_CARD`, `DEMO_DATASET`; corrected here) | No (lead may accept) |
| X10 | `warehouse_settings` / authority mode in the first migration | 02 §8.1: typed singleton with `stock_authority CHECK IN ('SERVORA')` | 05 §6.1/§6.2: M0+M1 only; typed settings later; 05 Q2 wants `location.authority` now | **No settings table, no authority column in W1.** "Module enabled" *is* M1 for this release, recorded by the module state row and its operator audit (which is an explicit per-deployment record, satisfying MOD-001's "set explicitly"). The 02 column with one legal value is dead configuration. 05's "expensive later" premise is weak for a defaulted column: `ADD COLUMN … DEFAULT 'SERVORA'` is metadata-only in PostgreSQL 11+ | No (05 Q1/Q2 become W6) |
| X11 | Movement timestamp | 01 OQ2: `delivered_at` (business time, used by reports) | 03 §1.2/§5.2: approval instant | **Approval instant.** 03's two arguments hold: back-dating re-opens the enablement/cutoff question, and `delivered_at` is unconstrained (accepts any parseable timestamp with no bound, `service.ts:522-533`). The business date stays one join away (`source_id` → item). `delivered_at` keeps exactly one other use: the G3b comparison (§3.3), where it decides *whether* a line posts, never *when* — so this decision is unchanged by the double-deduction guard | No |
| X12 | Slice order | 02 §12: W1 = infrastructure, W3 = transfers, W4 = delivery issue | research §5 step 5 + this brief: one movement end-to-end first | **Research order**, re-cut as W0 / W1a / W1b (§3.7) | Yes (order approval) |
| X13 | Demo data | 02 §9.2: DEMO delivery posts nothing; manual commands BUSINESS-only | 01 H8: module supplies a purge-plan fragment; 03 C5: register the FK *or prove* it cannot happen | **Prove it cannot happen** (§5.6), with a test. No analyzer, no plan-schema bump in W1 | No |
| X14 | Restore validation shape | 01 H7: `RestoreValidationPort` with `requiredRelations` + `validateRestoredData` | 03 §5.3/02 §8.4: reconciliation query; 05 silent | **Small validator registry** (§5.7): array of `{ relations, validate(pool) }` in the restore module, one warehouse entry. A port with an interface per module is more machinery than one consumer needs | No |
| X15 | Product delete with stock history | 03 C6/01 H4: a product-reference port so the pre-check knows about stock | 01 §1: the generic `23503` path already yields the right code | **Message fix only in W1** ("… teslimat, satış veya stok hareketi …"): the code is already correct (`products/service.ts:238-248`), the pre-check is an optimisation, and a port with one consumer is speculative. Revisit when a second module references products | No |
| X16 | Two-step transfer (in-transit) | 04 §7 req 4: dispatch + receive, in-transit visible | 02 D4: no in-transit; 04 Q8: single step for V1 | **Single step** (02 + 04's own Q8). A partial transfer state doubles the command surface and needs a resolution rule for "van never arrived" | No |
| X17 | "0" versus "never counted" (03 §13 D5) | 03 D5: a product counted at 0 has no balance row, so it is indistinguishable from a never-counted product; only the message quality suffers | 02 §7.4: zero-difference count lines **are** stored (with `movement_id = NULL`), so per-product count evidence exists | **Resolved by the ladder + 02's line storage:** `stock_counts` header = "this location was counted"; `stock_count_lines` row for a product = "counted, and 0 means empty". So G3 can say `LOCATION_NOT_COUNTED` truthfully, G5 only fires on a counted location, and no extra column is needed. This is a data answer, not a wording fix | No |
| X18 | Enablement cutoff | 03 §5.2/D6: no cutoff is needed once movements are posting-dated; 02 never introduces one | this brief asks for the cutoff definition | **No posting cutoff, and no stored watermark.** `occurred_at` = approval instant, and nothing walks history, so every movement is post-enablement. The unposted list is *bounded* by a window derived from the operator audit's first enable (§5.9) — derived, not stored, so it rewinds with the state on restore and cannot go stale | No |

Also noted, not tabulated: 03 §11.3 proposes a new `listDeliveryLinesForApproval` repository method;
W1 can reuse `getSubmissionDeliveryItems` (`repository.ts:5224-5231`), which already reads the same
rows `FOR UPDATE` on the caller's transaction. One fewer near-duplicate read.

---

## 5. Contracts W1 needs

### 5.1 (a) Module registry — see §2

W0 owns it. Summary of what W1 consumes: `InstallationModuleKey` includes `'WAREHOUSE'`;
`AuthenticatedCapabilities.warehouse`; routes registered unconditionally and gated in the service;
`404` when disabled, `503 MODULE_STATE_UNAVAILABLE` when unreadable; no env key.

### 5.2 (b) Enable / disable / re-enable

| Situation | Rule `[PROPOSAL]` | Why |
| --- | --- | --- |
| Enable | Nothing is posted, nothing is back-filled, no movement is created. Approved deliveries from **before** the enable instant never enter the unposted list (§5.9); those approved after it do | Posting happens only inside an approval; there is no code path that walks history. This is structural, not a policy someone must remember (03 §5.1) |
| Enable when goods had already left before the opening count | The opening count already excludes them, so their later approval posts nothing (G3b) | Without G3b the opening count and the approval would both deduct the same units (§3.3) |
| Enable with stock already counted elsewhere (re-install) | Impossible by construction: balances are module tables; a fresh enable has none | — |
| Disable while deliveries are `WAITING_APPROVAL` | The approval **succeeds**, writes no movement. Nothing is shown while off (routes `404`); after re-enable the line appears under its then-current reason | MOD-002 §5 fail-closed is about *granting module capability*; it does not make a module a precondition of a Core command. A disable that blocks all field approvals would let an installation setting stop the business |
| Disable with stock on hand | Data is retained, balances stay authoritative, the module's screens disappear. The operator confirmation says "Veriler silinmez." | 01 risk 11; the disable is an explicit operator act, and re-enable must show the same numbers |
| Approve while disabled | Commits normally, no movement, no module row | Same as above |
| Invalidate while disabled | The Core invalidation commits; the port is a no-op (`reversed: 0`); the stale movement (if any) stays until the module is re-enabled and a correction is posted | The reversal needs the module's tables and state; writing module rows while the module is off contradicts "off means no new module rows" |
| Re-enable | Nothing is posted automatically. The window stays at the **first** enable, so deliveries approved during the disabled period are still listed and each is decided explicitly in W2 (`POSTED` / `NOT_POSTED`) | 03 §5.4; a drained backlog would be indistinguishable from a back-fill, and a moving window would hide the gap the moment the module came back |
| State unreadable at approval | `503`, card stays `WAITING_APPROVAL` | G0; the one case where the module *does* block, because the module may be enabled and the ledger is then incomplete (MOD-001's single-authority claim) |

The one deliberate asymmetry: **a known-disabled module never blocks Core; an unknown module state
does.** That is the difference between "the operator decided" and "nobody knows".

### 5.3 (c) Idempotency

| Command | `clientActionId` | `operationKey` | Request-hash identity | Independent business key |
| --- | --- | --- | --- | --- |
| Create / update / deactivate location | **No** (reference data, ARC-001 §"ordinary reference-data updates") | — | — | `UNIQUE (organization_id, code)`; `expectedVersion` |
| Post count | **Required** | `STOCK_COUNT_POST` | `is_opening`, `reason_code`, location, sorted lines | `UNIQUE (organization_id, id)` + `(count_id, product_id)` |
| Transfer | **Required** | `STOCK_TRANSFER` | from, to, `document_no`, note, sorted lines | exactly one `TRANSFER_OUT` + one `TRANSFER_IN` per group (partial unique index) |
| Issue at delivery approval | **No own key** | — (rides `JOB_APPROVE:<id>`) | — | `UNIQUE (organization_id, source_id, movement_kind) WHERE source_type='JOB_CARD_DELIVERY'` |
| Reversal at invalidation | **No own key** | — (rides `JOB_INVALIDATE:<id>`) | — | `UNIQUE (organization_id, reversal_of_movement_id) WHERE movement_kind='REVERSAL'` |

Implementation notes that matter:

1. **Reuse, do not re-implement.** `runCriticalAction(pool, claim, work)` (`db/critical-action.ts:138-220`)
   gives claim → work → replay → `409 ACTION_IN_PROGRESS` on `40P01`/`40001`. Warehouse must not
   write its own receipt logic.
2. **Request hash discipline** copies `job-cards/critical-action-request-hash.ts:17-40` verbatim:
   hash normalized intent with an operation version tag (`STOCK_TRANSFER:v1`), never
   `clientActionId`, never time, never generated ids. A raw-body hash re-creates the
   `CLIENT_ACTION_REUSED` false-positive class.
3. **The delivery movement has no receipt of its own, on purpose.** Two receipts for one business
   fact would allow the movement to commit while the approval failed (02 §9.2). The JobCard receipt
   is the command receipt: on a replay of `JOB_APPROVE` the stored response is returned at
   `service.ts:7239-7249` **before** the work callback runs, so no second movement can even be
   attempted. The unique index is the second, receipt-independent guard for a repair job, a manual
   SQL fix, or a future unposted-decision command.
4. **A rejected approval burns the key.** A 4xx inside the finalize marks the intent `FAILED` with
   `failure_code = 'INSUFFICIENT_STOCK'` (`repository.ts:5820-5841`); the same `clientActionId` then
   returns `409 INSUFFICIENT_STOCK` with the generic message ("yeni bir işlem anahtarıyla tekrar
   deneyin", `repository.ts:360-364`). After fixing the stock the manager re-approves with a **new**
   key and the same `expectedVersion` (the version never moved). The UI must not retry the same key
   after a 409. This is existing Core behaviour; W1 must not fight it, and the acceptance test for
   "insufficient stock leaves no version bump" must assert exactly this.
5. **Movement row uniqueness is not idempotency.** It guarantees at-most-once *per source*; it does
   not replay a response. That is why both layers exist.

### 5.4 (d) Audit and the vocabulary-extension pattern

| Change | Recorded in | Same transaction |
| --- | --- | --- |
| Count posted / transfer / issue / reversal | `stock_movements` (+ `stock_counts`/`stock_transfers` header) | yes |
| Location created / renamed / deactivated / reactivated | `warehouse_audit_events` | yes |
| Location code collision, rejected transfer, insufficient stock | **not audited** (a rejected command writes nothing; the receipt does not exist either) | — |
| Module enabled/disabled | `operator_audit_events` (W0) | yes |

`warehouse_audit_events` *(PROPOSAL)*: `id`, `organization_id`, `actor_user_id` (FK, `RESTRICT`),
`event_type` (closed CHECK: `STOCK_LOCATION_CREATED`, `STOCK_LOCATION_UPDATED`), `subject_type`,
`subject_id`, `old_value JSONB`, `new_value JSONB`, `occurred_at`. No read endpoint in W1 (Core's
`audit_events` has none either); it exists so "who closed this depot" is answerable.

**The vocabulary-extension pattern** (this is the part other modules should copy):

1. Each module owns its own closed CHECK list, in its own migrations.
2. Adding an event type = one `DROP CONSTRAINT` + `ADD CONSTRAINT` in that module's next migration.
   Cost is paid by the module that grows.
3. Core's `audit_events` and `job_card_activity_logs` are never extended for module facts.
   Evidence for why: `job_card_activity_logs`' event CHECK has already been rewritten in 13
   migrations, and `audit_events`' CHECKs were created in `003` and rewritten in `005`, `038`, `041`,
   `060` and `061`. *(The `job_card_activity_logs` count is inherited from 01 §9; `005:15-24`,
   `038:11-16`, `060:90-121` and `061:52-74` verified directly.)*
4. A movement row is already an audit record; do not duplicate it into an audit table (that is how a
   ledger turns into two truths).

Alternative if the owner wants the minimum: drop `warehouse_audit_events` from W1 and accept that
location changes are explainable only by `updated_at` + `version`. I recommend keeping it: it is one
small table, and the first question a pilot asks after a bad week is "who changed the depot list".

### 5.5 (e) Offboarding and permanent delete

| Situation | Behaviour | Mechanism |
| --- | --- | --- |
| Staff never touched stock | No vehicle row exists (lazy creation), nothing blocks | 02 D1 |
| Offboarding a rep whose vehicle holds stock | **Does not block.** The `users` row is deactivated, not deleted (`offboarding.ts:438-461`); the vehicle, its balance and its movements survive | no Core change |
| Using a departed rep's vehicle | The module treats it as **source-only**: it cannot be a transfer destination (`409 WAREHOUSE_LOCATION_OWNER_INACTIVE`) and is listed as an exception on the board. Derived from `users.is_active` at read time — no Core write, no stale flag | join on `users.is_active` |
| Returning its stock | A manager transfers vehicle→depot (allowed) or counts it (allowed) | W1 transfer / count |
| Permanent delete of a user who ever owned a location, posted a movement, or wrote a warehouse audit row | `409 USER_PERMANENT_DELETE_BLOCKED` with `HAS_BUSINESS_HISTORY` | three `EXISTS` clauses added to `inspectUserDeletion` (`people/repository.ts:157-305`): location owner, movement actor, warehouse audit actor |
| Permanent delete when only the *audit* clause is missing | would be the same 409 — but without that third clause the FK raises `23503` and the API answers **500** (`errors/index.ts:48-53`) | this is why all three are mandatory, not just the first two |

Why block permanent delete but not offboarding: delete is an ADMIN erasure of a *pristine* user
(`people/service.ts:285-343` is already deliberately narrow); a user who ever held a company van's
stock is not pristine. Offboarding is the normal path and must work even with the module off
(`2026-11-25-core-modules-architecture-research.md:200-207`).

Cost if wrong: an ADMIN who wants to hard-delete a rep who once had an empty vehicle must first
remove the location — an intentional, auditable act, not a silent one.

### 5.6 (f) Demo data purge

**Rule (W1): the Warehouse module is production-only. No warehouse row can reference a demo dataset.**
Four enforceable clauses `[PROPOSAL]`:

1. `stock_locations.owner_user_id` must reference a `data_class='BUSINESS'` user
   (`409 WAREHOUSE_DEMO_NOT_SUPPORTED`).
2. Every warehouse command rejects an actor whose `users.data_class = 'DEMO'` (same 409). This is
   necessary because demo users are real login-capable rows in a BUSINESS installation
   (`demo-data/repository.ts:1040-1062`), and a fresh demo install marks *all* users DEMO
   (`auth/setup.ts:152-164`).
3. Manual commands accept only `data_class='BUSINESS'` products.
4. A `data_class='DEMO'` delivery posts nothing and still approves (G7).

Consequence: the analyzer and purge plan need **no change** in W1 — not because the tables are
registered, but because no reference can exist. That is stronger than a registration: a registration
that is never exercised rots.

The test that makes this credible (`A15`): create a demo dataset, approve a demo delivery, try every
warehouse command as a demo user, then run the purge — it must succeed with no `FK 23503`.

If the owner later wants stocked demo data (a sales demo showing a van), that is a plan-schema bump
(`demo-data/types.ts:7` is `2`), `data_class`/`demo_dataset_id` on three tables, analyzer edges, purge
order and counts DTO — a slice of its own, not a W1 detail.

### 5.7 (g) Restore validation

Two additions, one per concern:

| Check | Shape | Where |
| --- | --- | --- |
| Relation existence | add the 7 warehouse tables to the required list | `backup/restore/postgres.ts:11-25` via a registry (§X14) |
| `balance = Σ movements`, both directions | `FULL OUTER JOIN` over `stock_balances` vs `SUM(quantity_delta) GROUP BY (location_id, product_id)`; expected zero rows (query in 02 §8.4) | same validator |

Why these two and not more:

- **Relation existence is nearly tautological** after `075`/`076`, because restore already refuses a
  dump whose migration ledger is not the release catalog (`postgres.ts:163-196`). It still catches a
  partial `pg_restore` that left one table empty/absent.
- **The reconciliation is the substantive one.** It catches a bug in the balance writer, a manual SQL
  edit, and a restore that produced an internally inconsistent snapshot. It is cheap (one aggregate
  per key) and it is the only way to prove the "cache is reconstructible" claim in 02 §3.2.
- **`quantity >= 0` is already a CHECK**, so a negative balance cannot survive a restore — no extra
  check needed.
- **Do not rebuild.** A "repair balances from movements" command is a W3+ admin tool, not a restore
  step; auto-repair during restore would hide the defect that caused the drift.

Module-state reconciliation after a restore: **none.** Module state and stock both rewind to the
backup instant (`restore-reset.ts:9-11`). The two resulting combinations are both valid and both
documented: `enabled=true` with zero balances (freshly enabled, nothing counted) and `enabled=false`
with balances (module off, data retained). An operator who thinks a restore "should" have turned the
module on is looking at a backup, not a defect.

### 5.8 (h) Three more contracts W1 cannot avoid

| Concern | Contract | Evidence |
| --- | --- | --- |
| Lock order | `users → customers → contacts → products → job_cards → stock_locations → stock_balances`, stock rows last, sorted `(location_id, product_id)`; a warehouse command that must read a JobCard takes the JobCard lock first | extends `DECISIONS.md:495-533` (ARC-003) and 02 §9.3; must be written into ARC-003 before code |
| Read scoping | STAFF reads own vehicle + all depots; MANAGER/ADMIN read all. Enforced in the service, not the query builder | Arc-002 organization scope; `AGENTS.md` §5 |
| Read consistency | The balance board and the movement list must come from one `REPEATABLE READ READ ONLY` snapshot when composed together (board + totals), following `reports/read-snapshot.ts:18-41` | otherwise "toplam" and "liste" can disagree |

### 5.9 (i) The unposted list is bounded — window, reasons, paging

The list answers "which approved deliveries did the module not post, and why". Without a bound it
would answer that question for the installation's entire history: a company with years of deliveries
would open it to thousands of rows nobody should post.

**Window.** Only lines whose card was approved **at or after the module's first enable** are in scope:

| Element | Choice | Why |
| --- | --- | --- |
| Source of the instant | `MIN(occurred_at)` over `operator_audit_events` rows for `module_key = 'WAREHOUSE'` whose `new_value ->> 'enabled' = 'true'`, across `MODULE_STATE_CHANGED` / `MODULE_STATE_TAKEN_OVER` / `MODULE_STATE_INITIALIZED` | The enable instant is already recorded **in the same transaction** as the state change (`operator/repository.ts:274-292`), with the acting operator. `new_value` is CHECKed to carry a boolean `enabled` for these event types (`074:107-119`; W0-3 adds `INITIALIZED` to that list), so the predicate is type-safe |
| Why not a module-owned `enabled_since` | rejected | It would be a second source of truth that can disagree with `installation_module_state`. Keeping it in sync needs either a Core→module call inside the operator mutation (new coupling) or a lazy write at the first request (wrong instant) |
| Why not `installation_module_state.updated_at` | rejected | It is the *last* change. If the last change was a disable, it is the disable instant, not the enable |
| Predicate | `job_cards.manager_approved_at >= windowStart` | Approval is the posting moment (§X11); a delivery approved before the window is never a candidate, whatever its `delivered_at` |
| Exactly at the instant | `>=` | timestamps are microsecond `TIMESTAMPTZ`; an exact tie is practically impossible, and inclusive is the honest reading of "after it was on" |
| Window absent (`enabledSince` null) | the list is **empty**, and the response says `enabledSince: null` so the screen can render a distinct warning instead of an empty state | Fail-safe direction: no window means no work queue. While the module is *enabled*, this is a damaged state (the operator mutation writes the state row and the audit event in one transaction, `operator/repository.ts:274-292`), so it must be visible as an anomaly, not as "nothing to do". On a fresh, never-enabled module the endpoint is unreachable anyway (module off → `404`) |
| Restore | both tables rewind together | `operator_audit_events` and `installation_module_state` live in the same database and therefore in the same `pg_dump`; a rewind cannot desynchronise the window from the state. If the backup predates the first enable, both are absent and the list is empty until the next enable |
| Long disable after the first enable | stays in the window | Those deliveries are exactly the undecided ones the operator must see; the escape is W2's explicit `NOT_POSTED` decision, not a moving window — a moving window would hide an unexplained balance gap the moment the module is re-enabled |

**Read dependencies this adds.** The module remains a reader, never a writer, of Core tables. W1
reads exactly five: `job_cards` and `job_card_delivery_items` (the unposted anti-join and the posting
snapshot), `users` (`is_active` for vehicle usability, `data_class` for the demo rule), `products`
(name/unit/active/`data_class` for manual commands) and `operator_audit_events` (the enable window,
installation-level). All are organization-scoped except the last. That list is the complete
Core→module read surface for W1; a sixth read needs a line in this table.

**Payload bound.** Even inside the window the response is paged:

```
GET /api/warehouse/unposted?reason=<optional>&limit=<default 50, max 200>&cursor=<opaque>
→ {
    enabledSince: string | null,
    total: number,                  // in-window lines with no ISSUE movement
    countsByReason: { [reason]: number },
    items: [{ jobCardId, deliveryItemId, productId, productNameSnapshot, quantity,
              deliveredAt, managerApprovedAt, assigneeUserId, reason }]  // newest first
  }
```

- `reason` filters to one of `NO_VEHICLE_LOCATION`, `LOCATION_NOT_COUNTED`, `PRODUCT_NOT_COUNTED`,
  `DELIVERED_BEFORE_COUNT`, `PURPOSE_EXCLUDED`, `LEGACY_FRACTION`. No `MODULE_OFF` reason exists:
  while the module is off its routes answer `404`, so "module off" can never be an observable list
  row (G1).
- Cursor order is `(manager_approved_at DESC, job_card_id, delivery_item_id)` so paging is stable
  while new approvals arrive.
- The screen shows `enabledSince` as a sentence ("Yalnızca … tarihinden sonra onaylanan teslimatlar")
  and the pre-window exclusion as copy, so an empty list is not mistaken for "nothing was ever
  missed".
- `countsByReason` is the cheap honest signal: after the window fix, structurally unpostable lines
  (`DELIVERED_BEFORE_COUNT`, `PURPOSE_EXCLUDED`, `LEGACY_FRACTION`) still accumulate inside it, and
  they must be countable even when the operator does not page through them. W2's `NOT_POSTED`
  decision is how they leave the list.

Index note: the window predicate uses `job_cards_organization_type_status_idx`
(`002_delivery_tracer.sql:131`) for `type/status` and filters `manager_approved_at` on the resulting
rows; the returned set is bounded by the window and the page. If profiling shows the pre-window scan
is hot on a large installation, a Core partial index on `(organization_id, manager_approved_at)
WHERE type = 'PRODUCT_DELIVERY' AND status = 'COMPLETED'` is the escape hatch — **UNVERIFIED**, no
measurement was run.

---

## 6. Data model deltas vs `02` (summary, not DDL)

W1 needs **7 tables**. `02` §8 owns the shapes; this is the delta list a reviewer should accept or
reject *before* DDL review.

| Table | In 02? | Delta in this proposal | Why |
| --- | --- | --- | --- |
| `stock_locations` | yes | none | — |
| `stock_movements` | yes | + `purpose_snapshot VARCHAR(20)` (null except delivery kinds); REVERSAL may carry `source_job_card_id` | the movement list must answer "why did 3 leave?" without a Core join; 02's CHECK forces `source_job_card_id IS NULL` on REVERSAL, which silently unhooks a reversal from the card it corrects |
| `stock_balances` | yes | none | — |
| `stock_transfers` | yes | + `document_no VARCHAR(50)` nullable | 04 §7 req 20 / Q4: store the dispatch-note reference, warn when empty, do not block |
| `stock_counts` | yes | + `reason_code VARCHAR(30)` with `CHECK (is_opening OR reason_code IS NOT NULL)` | 04 Q10: a correction is a reportable, reasoned event, not a casual edit |
| `stock_count_lines` | yes | none | zero-difference lines are kept (evidence of a count) |
| `warehouse_audit_events` | **no** | new, 9 columns | §5.4 |
| `warehouse_settings` | yes | **dropped from W1** | §X10 |

Two service-enforced invariants that DDL cannot express (both need tests, 02 §8.5 says the same for
its pair):

1. `stock_movements.movement_group_id = stock_transfers.id` / `= stock_counts.id` for the matching
   kinds.
2. A reversal of a delivery-linked movement copies `source_job_card_id` from the original.

A third follows from G3b and belongs in the module contract rather than in DDL:

3. A count's `occurred_at` is the instant the shelf was observed and is never edited afterwards.
   Counts are immutable rows (like movements), and G3b trusts `occurred_at` as the coverage instant.
   The count screen must therefore label the field as "sayım anı" and default it to now — not to
   `created_at`, which the operator cannot influence.

---

## 7. Acceptance tests

Legend: **[R]** = required by this brief; level `PG` = PostgreSQL-backed server test, `UNIT` =
service-level test with a fake repository, `WEB` = web test.

The brief's "module off ⇒ API 503 and capability false, data retained" is **split deliberately**:
the accepted pilot contract already fixes `404` for *disabled* and `503` for *unreadable*
(`docs/features/operator-module-pilot.md` §7, OP6/OP12, and `overview/service.ts:14-25, 91-101`).
A7 and A8 test both halves. Using `503` for a deliberate disable would make a permanent operator
decision look like a transient outage and would contradict the module that already shipped.

**Reported drift, not silently resolved:** the folder `README.md` (§6 item 1) repeats the brief's
"kapalıyken API `503` döner". That conflicts with the accepted pilot contract quoted above. This
document follows the accepted contract (`404` when disabled); if the owner prefers `503` for a
deliberate disable, A7 changes and the operator-module pilot contract must change with it — the two
cannot disagree, and the choice belongs in one decision, not in two documents.

| # | Given / When / Then | Level |
| --- | --- | --- |
| **A1 [R]** repeated command → no second movement (count) | Given an enabled module and a posted count with `clientActionId` X, when the same request is replayed, then exactly the same number of `OPENING` movements exist, the response body is identical, and no new `processed_actions` row or movement group appears | PG |
| **A2 [R]** repeated command → no second movement (approval) | Given a `WAITING_APPROVAL` business delivery with 2 lines from a counted vehicle, when the manager approves and the identical `JOB_APPROVE` is replayed, then exactly 2 `ISSUE` movements exist, the replay returns the stored response (`service.ts:7239-7249`), and the balance moved once | PG |
| **A3 [R]** enabling does not auto-deduct old deliveries | Given a module first enabled at T1 and then disabled, with 3 deliveries approved **before** T1 and 2 approved **after** T1 during the disabled period, when the operator enables it again, then `stock_movements` is empty; `/api/warehouse/unposted` returns `enabledSince` = T1 and exactly the 2 in-window lines (the 3 pre-T1 ones never appear, even with `limit=200` and `reason` unset); `total` counts only in-window lines; and no scheduled job exists that could post anything | PG |
| A3b | Given an enabled module whose enable events were removed (damaged state), when `/api/warehouse/unposted` is called, then `enabledSince` is `null`, `total` is `0`, `items` is empty, no error is raised, and the screen renders the anomaly warning rather than an empty state | PG |
| A3c | Given 500 in-window unposted lines, when the endpoint is called without `limit`, then at most 50 items are returned with a stable cursor, `total` is 500, `countsByReason` sums to 500, and paging visits every line exactly once while a new approval arrives mid-pagination | PG |
| **A4 [R]** offboarding keeps history | Given a rep with 5 units in the van, when ADMIN offboards them, then the user is inactive, the location and 5-unit balance remain, every movement still has its `actor_user_id`, the location can be a transfer source but not a destination, and `DELETE /api/users/:id` → `409 USER_PERMANENT_DELETE_BLOCKED` / `HAS_BUSINESS_HISTORY` (never 500) | PG |
| **A5 [R]** insufficient stock | Given a counted vehicle with 0 and a line of 3, when the manager approves, then `409 INSUFFICIENT_STOCK` with `{productId, needed, onHand}` in `details`, the card stays `WAITING_APPROVAL` at the **same version**, and no movement/balance row changed; replaying the same key returns `409 INSUFFICIENT_STOCK` with the generic message and still no movement; re-approving with a new key after a transfer succeeds | PG |
| **A6 [R]** invalidation reversal exactly once | Given an approved delivery with 2 posted movements, when ADMIN invalidates it (`DUPLICATE`), then 2 `REVERSAL` rows exist, each with `reversal_of_movement_id` + `source_job_card_id`, originals byte-identical, balances back to pre-approval, and `occurred_at` = the invalidation instant; a second invalidation returns `409 JOB_ALREADY_INVALIDATED` and adds nothing; a direct second `REVERSAL` insert for the same target violates the partial unique index | PG |
| **A7 [R]** module off ⇒ 404 + capability false + data retained | Given balances exist and the operator disables the module, when a client calls any `/api/warehouse/*` route, then `404 NOT_FOUND`, `/api/auth/me` reports `warehouse:false`, the nav entry is gone, and the rows are still in the database; re-enabling restores the exact numbers and the unposted list covers the disabled window | PG + WEB |
| **A8 [R]** module state unreadable ⇒ 503 | Given the state read throws (or the row is missing), when any warehouse route is called then `503 MODULE_STATE_UNAVAILABLE`, and when a delivery approval is attempted then `503`, the card stays `WAITING_APPROVAL`, no movement exists | PG |
| **A9 [R]** restore detects an inconsistent balance | Given a restored database where one `stock_balances.quantity` was changed by hand, when `validateRestoredDatabase` runs, then it fails with `RESTORE_INTEGRITY_FAILED` and names the reconciliation (no silent pass) | PG |
| **A10 [R]** concurrency: last unit | Given one counted vehicle holding exactly 1 unit and two `WAITING_APPROVAL` deliveries for that product from that same vehicle, when both approvals run concurrently, then exactly one posts, the other gets `409 INSUFFICIENT_STOCK` (or `409 ACTION_IN_PROGRESS` if `40P01`), the balance ends at 0 and is never negative, and a replay of the loser after a transfer succeeds. Second variant: two multi-line transfers over the same two products in opposite line order must not deadlock (proves the sorted-lock rule) | PG |
| A11 | Given a vehicle with 3 units and a depot with 10, when a manager transfers 2 to the van, then exactly 2 movements share one `movement_group_id`, the total is unchanged, and a partial transfer is impossible | PG |
| A12 | Given `from_location_id = to_location_id`, when a transfer is posted, then `400` and nothing written | PG |
| A13 | Given a location code `" merkez "` exists as `MERKEZ`, when another ADMIN creates `merkez`, then `409` and one row | PG |
| A14 | Given a count with all zero differences, when posted, then zero movements but one `stock_counts` row and N `stock_count_lines` rows exist, and the location is henceforth "counted" (G3 no longer applies) | PG |
| A15 | Given a demo dataset and a demo delivery, when the demo manager approves it, then the approval succeeds with 0 movements; every warehouse command as a demo user → `409 WAREHOUSE_DEMO_NOT_SUPPORTED`; the purge then completes with no `FK 23503` | PG |
| A16 | Given an uncounted vehicle, when a delivery is approved, then approval succeeds, 0 movements, and the unposted line carries `LOCATION_NOT_COUNTED` (not `INSUFFICIENT_STOCK`) | PG |
| A17 | Given a legacy fractional delivery line, when the card is approved, then approval succeeds, the line is skipped, and the unposted list shows `LEGACY_FRACTION` (never rounded, never rejected) | PG |
| A18 | Given a product referenced only by a stock movement, when an ADMIN deletes it, then `409 PRODUCT_HAS_OPERATION_HISTORY` whose message names stock history, and the product still exists | PG |
| A19 | Given a `SALE` approved with "Teslim işi aç", when the sale completes, then the created delivery is `NEW` with planned lines and zero movements; movements appear only when that delivery is later approved | PG |
| A20 | Given the module enabled and a `CONSIGNMENT`/`RETURN` line, when approved, then no movement and the unposted reason is `PURPOSE_EXCLUDED` | PG |
| A21 | Given an inactive owner's vehicle, when a manager tries to transfer *into* it, then `409 WAREHOUSE_LOCATION_OWNER_INACTIVE`; transferring *out* of it succeeds | PG |
| A22 | Given the performance of the board at N locations × M products (seed 50 × 200), when the board loads, then the request issues a bounded number of queries and p95 stays under the existing page budget | PG (measurement, not correctness) |
| **A23 [R]** double deduction across a count (G3b) | Given a counted vehicle holding 10 of a product, when 3 units are handed over (`delivered_at` = T1), a recount at T2 > T1 counts 7 and posts `COUNT_ADJUSTMENT −3`, and the delivery is then approved at T3 > T2, then the approval succeeds with **no** `ISSUE`, the balance stays 7, exactly two movements exist (`OPENING` +10, `COUNT_ADJUSTMENT −3`), and the line appears in `/api/warehouse/unposted` with `DELIVERED_BEFORE_COUNT`. Variants that must also pass: (a) the same with an *opening* count instead of a recount, (b) a delivery delivered **after** the latest count must still post (G4), (c) a line whose product was never counted must return `PRODUCT_NOT_COUNTED` and **not** `INSUFFICIENT_STOCK` (G3a), (d) a NULL `delivered_at` (seeded directly, since submission forbids it) must fall through to G4/G5 and log, (e) a future `delivered_at` must fall through to G4/G5 (the comparison cannot fire) | PG |

Test-file sketch (naming only, not created): `warehouse-locations-postgres.test.ts`,
`warehouse-count-postgres.test.ts`, `warehouse-transfer-postgres.test.ts`,
`warehouse-approval-posting-postgres.test.ts`, `warehouse-invalidation-reversal-postgres.test.ts`,
`warehouse-module-gate-postgres.test.ts`, `warehouse-demo-isolation-postgres.test.ts`,
`warehouse-offboarding-delete-postgres.test.ts`, `warehouse-restore-validation-postgres.test.ts`,
`warehouse-concurrency-postgres.test.ts`, `warehouse-unposted-postgres.test.ts`,
`warehouse-service.test.ts` (unit), `warehouse-routes.test.ts` (unit), `warehouse-nav.test.ts` (web).

---

## 8. Decisions required before W0/W1 can start

Only **B0–B8** block. Everything else is a later-slice question (§11).

| # | Decision | Options | Recommendation | Blocks |
| --- | --- | --- | --- | --- |
| B0 | Authorize a Warehouse module slice at all (`AGENTS.md` §13) | authorize W0+W1 / defer / refuse | **Authorize W0+W1 only**, with W2+ re-approved per slice | everything |
| B1 | Storage shape | A ledger-only / **B ledger + same-tx balance** / C voucher documents | **B** + immutable headers for transfer and count only (02 §3.2, §4) | migration 076 |
| B2 | Quantity domain | **INTEGER** / `NUMERIC(12,3)` | **INTEGER**, with G8 for legacy fractional rows (§X1) | migration, port signature |
| B3 | Which delivery purposes post | SALE only / **SALE+SAMPLE+OTHER** / all five | **SALE+SAMPLE+OTHER**; `CONSIGNMENT`/`RETURN` excluded (DOM-001 untouched, §X2/X3) | posting rule, acceptance A20 |
| B4 | Gate scope | unconditional 409 / **counted-perimeter ladder** | **Ladder** (§3.3): disablement and missing setup must never block Core approvals; the gate bites only where a balance is claimed | approve behaviour, A5/A16 |
| B5 | Invalidation reversal | **automatic in the transaction** / exception list | **Automatic** (§X6) | second Core call site, A6 |
| B6 | Offboarding / delete model | block offboarding (02) / nothing (03) / **derive + block permanent delete** | **Derive + block delete** (§5.5) | `people/repository.ts` change, A4 |
| B7 | Config audit destination | Core `audit_events` / **module table** | **Module table** (§X9), with the module-local CHECK pattern | migration, `warehouse_audit_events` |
| B8 | Fresh-install module state | no row / reuse `ENV_TAKEOVER` / **`FRESH_INSTALL` + `MODULE_STATE_INITIALIZED`** | **`FRESH_INSTALL`** (§2.3) | migration 075, takeover |

Deliberately *not* blocking: lot/expiry enforcement (W4), consignment (W4), returns (W3), ERP mode
(W6), reservations (W5), demo stock (never), reservations/partial delivery (W5), `location.authority`
(W6), product-reference port (W3+), reports (W3).

---

## 9. Size estimate per slice

**Estimate only.** Basis: the MOD-002 operator pilot (1 migration, 6 server files, 4 web files,
20 acceptance scenarios, one PR) for the plumbing rows; the SALE/delivery features for the business
rows. Confidence is low for W1 and medium for W0 — nothing was compiled or measured.

| Slice | Migrations | New server files | Edited server files | New/edited web files | Test files | Est. net LOC | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W0 | 1 (075, 5 CHECKs + 1 index) | 0 | 8 | 7 | 4 | ~470 | Medium |
| W1a | 1 (076, 7 tables) | ~10 | 2 (`app.ts`, `config.ts`) | 4 | 8 | ~3,000 | Low |
| W1b | 0 | ~2 (port, unposted read) | 3 (`job-cards/service.ts`, `people/repository.ts`, `products/service.ts` message) | 2 (+1 Core page panel deferred to W2) | 6 | ~1,650 | Low |
| W2 | 0–1 | ~3 | 1 | 3 | 6 | ~1,500 | Low |
| W3 | 1 (returns/corrections + event types) | ~4 | 1 | 4 | 8 | ~2,200 | Low |
| W4 | 1 (lots/serials/policies) | ~5 | 1 | 5 | 8 | ~2,800 | Low |

W1 total (a+b): 1 migration, ~12 new server files, 5 edited server files, 6 web files, 14 test files,
roughly **4,650 net lines** including tests. The +150 over the first draft is the double-deduction
guard, the enable window and paging (§3.3, §5.9); W0 grew by one index. For comparison,
`job-cards/service.ts` alone is 9,489 lines (`wc -l`), so W1 is about half of one existing Core
service — plausible for a module, not small.

If the owner wants a smaller first merge: ship **W1a only** (~3,000 lines, zero Core behaviour
change), then decide on W1b with the module already visible.

---

## 10. Risks

| # | Risk | Impact | Mitigation in this proposal |
| --- | --- | --- | --- |
| R1 | W1 becomes a Core dependency by accident (a stock error blocks approvals) | field work stops | the ladder (§3.3): only G0/G5 can block |
| R2 | A wrong vehicle yields wrong balances with no signal | stock quietly wrong | G3/G3a ("not counted") never post, unposted list, board shows "last counted" |
| R3 | Two-tables-drift (ledger vs balance) | wrong balances | same-transaction writer, single conditional-update primitive, restore reconciliation, `CHECK (quantity >= 0)` |
| R4 | `delivered_at` is unbounded (future or very old dates) and now carries **one posting decision** (G3b) in addition to being a reporting date | a wrong date can defeat the double-deduction guard (a future date never compares "before the count") | `occurred_at` stays the approval instant so the ledger never inherits the date; the count screen shows open delivery dates; bounding `delivered_at` remains a separate Core decision (§3.3) |
| R5 | Silent failure at product/user delete (500 instead of 409) | confusing admin errors | §5.5 three `EXISTS`; §X15 message fix |
| R6 | Registry widening becomes module-specific | the next two modules pay again | W0 is module-agnostic and tested with a second key (§2) |
| R7 | Scope creep into lot/expiry/ERP under "it's just one field" | the slice never ships | §3.6 out-list, §11 questions 12–13 |
| R8 | Legacy fractional delivery rows make the integer ledger wrong | a bad first impression | G8 skip + list, plus a pre-implementation data question (§12) |
| R9 | Double deduction when a count lands between delivery and approval | balance too low by the delivered quantity, silently, until the next count | G3b (§3.3) + A23; the skipped line stays visible as `DELIVERED_BEFORE_COUNT` |
| R10 | The unposted list becomes a second, unbounded backlog | nobody trusts or works the list | window at the first enable (§5.9), paging, `countsByReason`; W2's `NOT_POSTED` decision clears explained lines |

---

## 11. Open questions for the owner

Merged and de-duplicated from 01 Q1–Q10, 02 Q1–Q10, 03 OQ1–OQ8, 04 Q1–Q10 and 05 Q1–Q11. Each has
options and a recommendation; none is decided here.

1. **Storage shape (B1).** (a) ledger only; (b) ledger + same-transaction balance *(recommended)*;
   (c) voucher documents with draft/post/cancel. — *Recommend (b) + immutable headers for transfer
   and count only: the negative-stock guard becomes one `UPDATE … WHERE quantity + delta >= 0`, reads
   are O(1), and the balance is provably reconstructible by the restore reconciliation.*
2. **Quantity domain (B2).** (a) integer *(recommended)*; (b) `NUMERIC(12,3)`; (c) decimal with unit
   conversion. — *Recommend (a); (c) needs a measured-goods decision (`DECISIONS.md:3486-3489`).*
3. **Negative stock.** (a) block everywhere *(recommended)*; (b) per-location `BLOCK|ALLOW`;
   (c) allow on vehicles only. — *Recommend (a); a blocked approval is visible and fixable with a
   transfer, a negative balance silently destroys trust in every number.*
4. **`RETURN` and `CONSIGNMENT` (X2/X3).** (a) excluded from stock in W1, DOM-001 unchanged
   *(recommended)*; (b) `RETURN` posts an outbound issue after an explicit supersession; (c) both
   modelled now with a consignment location. — *Recommend (a) now, (b) in W3 with a decision record,
   (c) only with a real consignment customer.*
5. **Source location.** (a) assignee's vehicle, override in the module panel *(recommended for W1)*;
   (b) manager picks in the approve dialog (needs a module id in a Core body); (c) default depot.
   — *Recommend (a); (b) is W2 if the pilot shows direct depot shipments are common.*
6. **Gate scope (B4).** (a) counted-perimeter ladder *(recommended)*; (b) unconditional 409.
   — *Recommend (a); (b) makes "enable the module" a switch that can stop every delivery approval.*
7. **Invalidation reversal (B5).** (a) automatic in the transaction *(recommended)*; (b) exception
   list + explicit `STOCK_REVERSE`. — *Recommend (a); (b) is the smaller Core diff and the larger
   data-integrity hole.*
8. **Offboarding (B6).** (a) derive usability + block permanent delete *(recommended)*; (b) block
   offboarding until empty; (c) auto-transfer inside offboarding. — *Recommend (a); (c) adds a second
   intent and a cross-module write inside one command.*
9. **Who may count and transfer.** (a) MANAGER + ADMIN *(recommended)*; (b) ADMIN only;
   (c) any staff. — *Recommend (a): if a manager cannot clear a shortfall, the gate holds field work
   hostage. ADMIN keeps location CRUD.*
10. **Config audit (B7).** (a) module table *(recommended)*; (b) extend Core `audit_events`.
    — *Recommend (a); Core's CHECK is hand-maintained and has no read surface today.*
11. **Fresh-install state (B8).** (a) `FRESH_INSTALL` + `MODULE_STATE_INITIALIZED` *(recommended)*;
    (b) reuse `ENV_TAKEOVER` and skip the audit; (c) no row until first enable. — *Recommend (a).*
12. **Lot / serial / expiry.** (a) attributes on the movement only *(recommended)*; (b) enforce per
    product with a tracking policy; (c) lot-level balances now. — *Recommend (a) in W1, (b) in W4:
    `PRODUCT_REQUIREMENTS.md:285` keeps them optional and policy-free, and the operator's ÜTS process
    is manual regardless.*
13. **ERP mode and stock authority.** (a) M0+M1 only in V1, authority = "module enabled"
    *(recommended)*; (b) a typed settings table with `stock_authority` now; (c) per-location
    `authority` from day one. — *Recommend (a); (c) is a defaulted column later, not a migration
    under load.*
14. **Demo stock.** (a) production-only module, no demo rows *(recommended)*; (b) demo-aware tables +
    purge-plan schema v3. — *Recommend (a); (b) is a slice of its own.*
15. **Nav placement.** (a) new top-level "Depo / Stok" entry, capability-gated, desktop sidebar +
    Menü only *(recommended)*; (b) a tab inside `/products`. — *Recommend (a); the 3-slot mobile
    `direct` list must not change (`navigation-model.ts:53-55`).*
16. **Reservations / partial delivery.** (a) none in V1 *(recommended)*; (b) reserve on approved
    sales; (c) reserve on scheduled deliveries. — *Recommend (a); SALE-002 §6
    (`DECISIONS.md:2154-2157`) forbids the remaining-quantity bookkeeping a reservation needs.*
17. **Two-step transfer.** (a) single step *(recommended)*; (b) dispatch + receive with in-transit.
    — *Recommend (a); (b) is a state column and a resolution rule for a van that never arrives.*
18. **Product-reference port.** (a) message-only fix in W1 *(recommended)*; (b) a registered
    product-reference port now. — *Recommend (a); today the generic `23503` path already returns the
    right code (`products/service.ts:238-248`).*
19. **Long disable after the first enable.** The window starts at the first enable, so deliveries
    approved during a later disabled period stay in the unposted list. (a) keep them *(recommended)*:
    they are undecided facts and W2's `NOT_POSTED` decision clears them; (b) move the window to the
    latest enable, so a re-enable starts clean but the previous gap disappears from the list;
    (c) keep them, plus an explicit "arşiv" toggle that hides decided/explained lines. — *Recommend
    (a); (b) hides an unexplained balance gap exactly when the operator looks for it, and (c) is W2
    scope.*
20. **Bounding `delivered_at` in Core.** A future date defeats G3b (§3.3). (a) leave Core alone and
    rely on the count screen *(recommended for W1)*; (b) reject a `delivered_at` after the request
    instant in Core; (c) warn in the UI only. — *Recommend (a) for W1; (b) is a Core product rule that
    affects every delivery, not a warehouse detail, and should be decided with JOB/DOM evidence.*

---

## 12. Unverified / gaps

- **Not run (by task rule):** `npm run build`, `npm test`, migrations, servers, `psql`, the CI gate.
  Every claim about behaviour is from reading source at `89bf6b1`.
- **Legacy fractional delivery quantities: UNVERIFIED.** Whether any deployment holds a
  `job_card_delivery_items.quantity` with a fractional part is a data question I could not run.
  If yes, G8 is exercised on day one; if no, G8 is dead code and should still be tested with a
  seeded row. Owner should run, read-only:
  `SELECT count(*) FROM job_card_delivery_items WHERE quantity <> trunc(quantity);` (requires an
  authorized read of a real database — **not** executed here).
- **How often a count lands between delivery and approval (G3b) is UNVERIFIED.** No data was read.
  The guard is cheap and always evaluated, so the frequency only affects how often the skip is
  exercised; A23 seeds the case rather than waiting for it.
- **The first-enable window assumes the WAREHOUSE module never becomes env-takeover-enabled.**
  W1's fresh-install row is created disabled (§2.3), so the first enable is always an operator action
  with a `MODULE_STATE_CHANGED` event. If a later slice gives the module an env key, the window must
  also accept `MODULE_STATE_TAKEN_OVER` with `new_value.enabled = true` — already included in the
  `MIN(occurred_at)` predicate (§5.9), but the reason for its inclusion would change.
- **The unposted query's cost on a large installation is a structural argument, not a measurement.**
  The window predicate rides `job_cards_organization_type_status_idx` (`002:131`) and filters
  `manager_approved_at` afterwards; A22/A3c exercise correctness of paging, not latency.
- **PostgreSQL fast-default claim** (`ADD COLUMN … DEFAULT` is metadata-only since PG 11) is stated
  from general knowledge, not re-fetched from the manual in this run.
- **No benchmark.** A22's "p95 under budget" is an acceptance idea, not a measurement; 02 §Unverified
  says the same about read cost.
- **Pool-saturation reasoning** (§3.4: a pool read inside a transaction is a second acquisition) is
  structural, not observed. `max` default 20 verified at `db/index.ts:92`.
- **`getSubmissionDeliveryItems` reuse** is verified as a signature and a `FOR UPDATE` read, but not
  proven to be callable from the approve path without a lock-order violation; a reviewer must confirm
  that the item locks (taken after the `job_cards` lock) do not invert against any other path. The
  safest fallback is the read-only variant 03 §11.3 proposes.
- **Messaging/Calendar module-registry work "in flight"** is from this task's brief, not from a
  document in this worktree. The only in-repo evidence is the ordering in
  `2026-11-25-core-modules-architecture-research.md:227-228`.
- **Turkish legal items** (dispatch-note obligation for a rep's car, ÜTS scope) are 04's findings and
  its own UNVERIFIED list; nothing here re-verifies them, and W1 deliberately stores the document
  number without enforcing it.
- **`docs/README.md`** has no entry for this research folder; adding one is a separate docs change
  (this task may write exactly one file).
- **Line numbers** drift with the branch. The quoted text is the durable part.
