# Servora-Med Decisions

Bu dosya ürün ve mimari için kabul edilmiş, uzun ömürlü kararları kaydeder. Yeni kararlar mevcut kayıtları sessizce değiştirmez; değişiklik gerekiyorsa yeni bir karar eski kaydın yerini aldığını açıkça belirtir.

## Documentation Index

- Product scope: `PRODUCT_REQUIREMENTS.md`
- Product design context: `PRODUCT.md`
- Architecture: `SERVORA_MED_ARCHITECTURE_PLAN.md`
- Data model: `SERVORA_MED_SCHEMA_DRAFT.md`
- API contract: `SERVORA_MED_API_DRAFT.md`
- Delivery order: `SERVORA_MED_MVP_SLICES.md`
- Slice 07 JobCard workspace design: `docs/superpowers/specs/2026-07-13-jobcard-workspace-design.md`
- Slice 08 operational reports design: `docs/superpowers/specs/2026-07-14-operational-reports-design.md`
- Slice 09 General Task design: `docs/superpowers/specs/2026-07-14-general-task-design.md`
- Slice 10 Structured Sales Meeting design: `docs/superpowers/specs/2026-07-15-sales-meeting-design.md`
- Slice 11 production deployment design: `docs/superpowers/specs/2026-07-15-production-deployment-design.md`
- Slice 12 local pilot cutover design: `docs/superpowers/specs/2026-07-15-local-pilot-cutover-design.md`
- Job lifecycle clarity design: `docs/superpowers/specs/2026-07-17-job-lifecycle-clarity-design.md`
- Job acceptance and scheduling design: `docs/superpowers/specs/2026-07-17-job-acceptance-scheduling-design.md`
- Agent discipline: `AGENTS.md`
- Historical inputs: `docs/archive/inputs/`

## UI-001: Product UI design direction and skill usage

- **Date:** 2026-07-10
- **Status:** Accepted
- **Scope:** Servora-Med authenticated product interface

### Context

Servora-Med sahada mobil cihaz kullanan personel ile masaüstünde operasyon izleyen yöneticilere hizmet eden bir B2B ürün arayüzüdür. Arayüzün kurumsal güven vermesi gerekir; ağır ERP, oyuncak Kanban, steril hastane yazılımı veya dekoratif Apple kopyası görünümüne dönüşmemelidir.

### Decision

Servora-Med UI çalışmaları `product` register'ında yürütülecektir.

`impeccable`, UI tasarımı ve değerlendirmesi için birincil kalite çerçevesidir. Ürün bağlamı `PRODUCT.md`, ileride oluşturulacak görsel sistem ise `DESIGN.md` üzerinden yüklenecektir.

Apple Design skill, görsel tema veya birebir Apple görünümü olarak kullanılmayacaktır. Şu etkileşim ilkeleri için seçici bir referanstır:

- Dokunma anında görünür geri bildirim
- Öngörülebilir ve mekansal olarak tutarlı geçişler
- Gesture kullanan etkileşimlerde kesintiye uğratılabilir hareket
- Mobil sheet ve drawer davranışında doğrudan manipülasyon
- Hareketin yalnızca durum ve sonuç anlatması
- `prefers-reduced-motion` ve hareket dışı eşdeğer geri bildirim
- Platforma uygun dokunma ve klavye davranışı

Kanban sürükle ve bırak özelliği zorunlu olmayacaktır. Aynı durum değişikliği erişilebilir buton veya menü komutuyla yapılabilecektir. Backend state machine her durumda tek karar kaynağıdır.

### Visual direction

- Marka kişiliği: güvenilir, sade, düzenli
- Görsel strateji: sakin, düşük kromalı nötrler ve sınırlı semantik vurgu
- Renk, JobCard'ları dekoratif olarak çeşitlendirmek için kullanılmaz
- Kırmızı, turuncu ve yeşil hata, gecikme, uyarı ve başarı gibi anlamlı durumlara ayrılır
- Tipografi yoğun iş akışlarında okunabilir ve taranabilir kalır
- Mobil düzen, masaüstü Kanban'ın küçültülmüş hali olmaz
- Kartlar müşteri, durum, öncelik, tarih ve ürün miktarını kontrollü hiyerarşiyle gösterir
- Glassmorphism, gradient text, ağır blur, aşırı büyük boşluk ve dekoratif motion varsayılan değildir

### Accessibility requirements

- Hedef standart `WCAG 2.2 Level AA`dır
- Etkileşim hedefleri mümkün olduğunca en az `44 × 44 CSS px` olur
- Temel akışlar klavye ile tamamlanabilir
- Renk hiçbir zaman tek bilgi taşıyıcısı değildir
- Yüzde 200 metin büyütme ve uygun ekranlarda yüzde 400 reflow test edilir
- `prefers-reduced-motion` desteklenir
- Kritik erişilebilirlik ihlali bulunan akış tamamlanmış kabul edilmez

### Consequences

- Mevcut `DESIGN.md` bir pre-implementation seed'dir. İlk görsel UI slice'ı gerçek CSS token ve ortak bileşenleri oluşturduğunda `impeccable document` scan modu çalıştırılmalı; sonraki ekranlara geçmeden renk, tipografi, spacing, elevation, component state ve motion token'ları kesinleştirilmelidir.
- Yeni ortak bileşenler default, hover, focus, active, disabled, loading ve error durumlarını kapsamalıdır.
- Apple tarzı spring veya gesture kodu yalnızca kullanıcı doğrudan manipülasyon yaptığında ve standart web davranışı yeterli olmadığında eklenmelidir.
- Sırf bu tasarım yönü için yeni bir animation dependency eklenmez. İhtiyaç gerçek bir etkileşimle kanıtlanırsa ayrıca değerlendirilir.
- UI acceptance criteria mobil kullanım, klavye, focus, zoom, reduced motion ve hata durumlarını içermelidir.

### UI Skill Precedence

UI çalışmaları şu bağlayıcı öncelik sırasına göre yürütülür:

1. `PRODUCT_REQUIREMENTS.md`, `PRODUCT.md`, `DECISIONS.md`, `AGENTS.md` ve kabul kriterleri ürün kararlarını belirler.
2. WCAG 2.2 Level AA ve kullanıcı güvenliği, estetik veya motion önerilerinin üzerindedir.
3. `DESIGN.md` onaylanan görsel sistemin kaynağıdır; seed durumunda kod oluşunca scan modunda gerçek token'larla yenilenir.
4. Impeccable, ürün arayüzünün birincil tasarım, değerlendirme ve kalite çerçevesidir.
5. Apple Design yalnızca dokunma geri bildirimi, doğrudan manipülasyon, gesture, sheet/drawer, kesintiye uğratılabilir hareket ve mekansal tutarlılık için seçici referanstır.
6. Apple Design'ın translucency, blur, bounce, haptic, sound ve dekoratif motion önerileri otomatik olarak uygulanmaz.
7. Backend state machine, yetki, idempotency, concurrency ve activity kuralları hiçbir UI skill'i tarafından değiştirilemez.
8. Yeni animation dependency yalnızca CSS ve mevcut web platformu yetersiz kaldığında, somut bir etkileşimle gerekçelendirilerek değerlendirilebilir.
9. Skill önerisi ürün bağlamıyla çelişirse Servora-Med ürün belgeleri kazanır.

### References

- Local UI quality framework: `/Users/emrah/.agents/skills/impeccable/SKILL.md`
- Apple interaction reference: <https://github.com/emilkowalski/skills/blob/main/skills/apple-design/SKILL.md>
- Product context: `PRODUCT.md`

## UI-002: Configurability boundary

- **Date:** 2026-07-10
- **Status:** Accepted
- **Scope:** MVP and future UI configuration

### Decision

Servora-Med kontrollü kullanıcı tercihlerini ve kayıtlı görünümleri destekleyebilir. Canonical domain alanları, roller, state machine, onay kuralları, zorunlu teslim verileri, organization sınırı ve audit davranışı kullanıcı tarafından değiştirilemez.

MVP'de genel amaçlı `organization_settings` JSONB torbası, kullanıcı tanımlı tablo, özel alan sistemi, form builder veya workflow designer yapılmayacaktır.

Firma profili mevcut admin/auth kapsamı içinde; küçük kullanıcı tercihleri Kanban UI kapsamında ele alınabilir. Kalıcı kart düzenleri ve paylaşılan görünümler gerçek pilot ihtiyacı doğrulandıktan sonra tasarlanacaktır.

### Consequences

- Ürün birimleri, müşteri türleri, kart öncelikleri ve canonical status değerleri kullanıcı ayarı değildir.
- Görünen etiket veya renk ileride değişebilse bile backend canonical değerleri değişmez.
- Firma ayarı audit'i gerekirse JobCard activity tablosuna yazılmaz; ayrı bir audit tasarımı gerektirir.
- Bildirim tercihleri bildirim sistemi, logo yükleme ise dosya yönetimi kapsamı oluşmadan eklenmez.

## DOM-001: Delivery purpose without financial tracking

- **Date:** 2026-07-10
- **Status:** Accepted
- **Scope:** MVP product delivery

### Context

A product left with a customer can represent a sale, sample, consignment, return, or another operational purpose. Quantity alone cannot distinguish these outcomes. The pilot does not need accounting or revenue tracking.

### Decision

Every delivery item stores one canonical purpose: `SALE`, `SAMPLE`, `CONSIGNMENT`, `RETURN`, or `OTHER`. It also stores positive quantity and actual delivery time.

MVP does not store unit price, discount, line total, revenue, margin, commission, invoice state, or payment state. `CONSIGNMENT` and `RETURN` do not create stock movements.

### Consequences

- Staff performance and delivery reports group quantities by purpose.
- Financial and inventory side effects require separate future domain designs.
- `staff_completed_at` remains submission time; `delivered_at` is the real delivery time.

## DOM-002: Structured Sales Meeting deferral

- **Date:** 2026-07-10
- **Status:** Superseded by DOM-007 after Slice 10 verification
- **Scope:** Pilot JobCard types

### Context

`SALES_MEETING` was listed as active without a structured model for meeting time, outcome, follow-up, and summary. Treating notes as the entire model would weaken reporting and create a false completion claim.

### Decision

Pilot core supports `PRODUCT_DELIVERY` and `GENERAL_TASK`. `SALES_MEETING` is delivered in a later slice with structured meeting details.

### Consequences

- The initial JobCard enum contains only pilot-core types.
- Quick-create and pilot completion criteria do not claim Sales Meeting support.
- Meeting details are designed and tested as a separate vertical slice.

## ARC-001: JobCard concurrency and command idempotency

- **Date:** 2026-07-10
- **Status:** Accepted
- **Scope:** JobCard mutations

### Context

Idempotency prevents one command from executing twice, but it does not prevent two different clients from overwriting each other's JobCard changes.

### Decision

JobCard stores `version INTEGER NOT NULL DEFAULT 1`. Field updates and named lifecycle commands provide `expectedVersion`; a stale value returns `409 VERSION_CONFLICT` without mutation.

Processed-action idempotency is required for JobCard creation, delivery-item creation, approval submission, manager approval, revision request, and cancellation. Ordinary reference-data updates do not use response-caching idempotency by default.

JobCard critical-action keys are bound to normalized semantic request identity, including
`expectedVersion` where applicable. Reusing a key with different intent returns
`409 CLIENT_ACTION_REUSED`; historical rows without a request hash fail closed.
Operation-key namespaces remain unchanged.

An unresolved client attempt retains its original key, version and complete request.
Retryable/ambiguous failures do not authorize a new key or edited request. The lifecycle,
meeting-result and retained-key JobCard create forms freeze semantic inputs and retry
the original request until replay/reconciliation succeeds or a definitive response
resolves the attempt. Realtime refresh must not rebind its version or payload.


### Consequences

- Successful JobCard writes increment version atomically.
- Idempotency and optimistic concurrency remain separate service concerns.
- UI must reconcile and explain stale-version conflicts.

## SEC-001: Hashed opaque cookie sessions

- **Date:** 2026-07-10
- **Status:** Accepted
- **Scope:** Browser authentication

### Context

Persisting raw bearer tokens and exposing them to Web Storage increases the impact of database disclosure and frontend script compromise.

### Decision

The server issues a high-entropy opaque session token, persists only `token_hash`, and sends the raw token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Sessions expire, can be revoked, and login is rate limited. Credentialed CORS and CSRF behavior are explicit.

### Consequences

- Login JSON does not contain a session token.
- Frontend does not store auth tokens in `sessionStorage` or `localStorage`.
- Raw tokens, cookies, and hashes are redacted from logs.

## ARC-002: Single-organization ownership boundary

- **Date:** 2026-07-10
- **Status:** Accepted
- **Scope:** V1 deployment and data ownership

### Context

The schema carries `organization_id`, but V1 is one company per deployment and does not provide SaaS tenant administration. Organization-scoped email uniqueness would also make email-only login ambiguous across future organizations.

### Decision

V1 is described as single organization. `organization_id` is retained as an explicit ownership boundary. Login email is globally unique case-insensitively. Client payload cannot choose organization identity.

All related JobCard, customer, contact, product, delivery-item, and assigned-user records must share the authenticated organization.

### Consequences

- V1 is not marketed or documented as multi-tenant SaaS.
- Service tests reject cross-organization access and relationships.
- Composite constraints may reinforce ownership where they remain maintainable.

## DOM-003: Canonical JobCard activity vocabulary

- **Date:** 2026-07-10
- **Status:** Accepted; vocabulary extended by JOB-006 with `JOB_ACCEPTED`
- **Scope:** JobCard activity timeline

### Context

The earlier documents mixed a generic `status_changed` event with specific lifecycle events, leaving duplicate activity behavior ambiguous.

### Decision

Canonical events are:

```text
JOB_CREATED
JOB_ASSIGNED
JOB_PLANNED
JOB_ACCEPTED
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

Lifecycle events carry old and new status. The same command does not also create a generic status-change event.

### Consequences

- Schema, API, tests, reports, and UI timeline use the same uppercase vocabulary.
- Activity rows are append-only and written in the business transaction.
- Organization-setting audit is not mixed into JobCard activity.

## ARC-003: Customer aggregate, Contact routing, and shared lock protocol

- **Date:** 2026-07-13
- **Status:** Accepted
- **Scope:** Slice 05 CRM

### Context

Customers are organizations such as clinics or dealers, while Contacts are people such
as doctors or purchasing officers. Treating both as one record would make ownership,
primary-person defaults, JobCard history, and lifecycle rules ambiguous. CRM lifecycle
commands also share rows with People deactivation and JobCard creation, so independent
check-then-write transactions could race.

### Decision

Customer is the aggregate root and Contact is always addressed below it at
`/api/customers/:customerId/contacts/:contactId`. A Customer has at most one optional
responsible Staff user in the pilot. The first active Contact becomes primary;
`make-primary` atomically replaces it. JobCards may reference one optional active Contact
that belongs to their selected Customer.

Cross-module writes use `users -> customers -> contacts -> job_cards` lock order and
stable UUID ordering within one row type. Customer and Contact mutations use integer
versions and explicit lifecycle commands. React Router supplies stable list/detail URLs;
backend authorization remains the source of truth. Identity and login state remain owned
by the application shell: an authenticated visit to `/login` replaces that history entry
with `/jobs`, while requested Customer/Contact deep links and refreshes remain intact.

### Consequences

- There is no top-level Contact collection, generic CRM notes field, or many-to-many
  Customer/Staff assignment table in the pilot.
- Staff can read organization CRM records but mutations remain Admin/Manager-only.
- Staff deactivation clears Customer assignments in the same transaction.
- Customer detail JobCard summaries are bounded and preserve assigned-Staff visibility.
- UI route guards are navigation behavior, never an authorization boundary.
- JobCard notes, safe timeline, role-scoped list, and read-only desktop board were completed in Slice 07.

## DOM-004: Informational Product catalog boundary

- **Date:** 2026-07-13
- **Status:** Accepted
- **Scope:** Slice 06 Product Catalog

### Context

Servora-Med needs Products that field teams can find and select in operational records.
Treating the catalog as an inventory or accounting master would prematurely introduce
SKU discipline, stock units, currencies, price history, and warehouse policy that the MVP
does not use.

### Decision

Only Product name is user-required. SKU, brand, category, model, unit, and reference price
are optional informational fields. SKU is neither normalized nor unique. Unit has no
invented default. Reference price is nullable, non-negative when present, has no currency
or financial meaning, and is not copied into delivery items.

Product reliability is protected through organization ownership, Admin/Manager mutation
authority, Staff read-only access, integer optimistic versions, named activate/deactivate
commands, and safe management audit. Deactivation blocks future selection but does not
rewrite historical delivery snapshots.

### Consequences

- Migration 005 relaxes existing SKU/unit constraints instead of creating a new table.
- Delivery unit snapshots become nullable; historical values remain unchanged.
- The Product HTTP API becomes the canonical web catalog source with search and pagination.
- JobCard validates Product eligibility within its own transaction and never calls HTTP.
- The legacy `/api/reference/products` path is removed after delivery creation adopts the
  canonical paginated catalog selector; Customer reference loading is unchanged.
- Inventory, warehouse, barcode, costing, currency, price-history, invoice, and accounting
  behavior require a later separately approved design.

### Verification

Implemented and verified on 2026-07-13 through migration 005, transaction/concurrency
tests, authenticated disposable-PostgreSQL tracing, full server/web gates, and Playwright
desktop/mobile/accessibility acceptance. No inventory or accounting behavior was added.

## DOM-005: JobCard notes use application-contract append-only semantics

- **Date:** 2026-07-13
- **Status:** Accepted
- **Scope:** Slice 07 JobCard Workspace

### Context

Operational notes must remain visible with historical JobCards and must not have ordinary
edit or delete flows. They are not a regulatory ledger that requires physical database
immutability under every controlled maintenance operation.

### Decision

Notes are append-only through the application contract. The public API and repository
expose no update or delete operation, the service offers append/list behavior only, and
the UI offers no edit or delete control. Note insertion and its `NOTE_ADDED` activity are
atomic. Migration 006 does not add an `UPDATE`/`DELETE` prevention trigger.

### Consequences

- Route, service/repository-surface, transaction, and UI tests protect the application
  contract.
- Documentation must not claim that note rows are physically immutable in PostgreSQL.
- Controlled data correction and maintenance remain possible without hidden trigger
  behavior; any future stronger compliance requirement needs a separate decision.

### Verification

Migration 006, real PostgreSQL note concurrency/replay/rollback, terminal note append,
application-surface mutation absence, Unicode whitespace validation, and web retry/action
ID behavior were verified in Slice 07. Notes do not increment JobCard version.

## DOM-006: Operational reports use approved work and canonical event time

- **Date:** 2026-07-14
- **Status:** Accepted
- **Scope:** Slice 08 Staff Profile and Operational Reports

### Context

Operational delivery and Staff summaries could otherwise mix unapproved field input,
approval time, actual delivery time, nullable units, and current catalog labels. That
would make the same business question produce different answers across profile,
dashboard, and delivery-report screens.

### Decision

Delivery quantities and Staff delivery output use only manager-approved `COMPLETED`
Product Delivery JobCards. Quantity is grouped by persisted `delivered_at`, purpose, and
nullable unit and remains an exact three-decimal-scale string. Persisted unit spelling,
case, and `null` are not normalized during reporting. Product grouping uses delivery-time
snapshots. Returns remain positive under `RETURN` and are not netted against sales. Group
pagination counts canonical grouped rows rather than raw delivery-item rows.

Every Staff operational and delivery report attributes work through
`job_cards.assigned_to`. Submitter, creator, approver, and activity actors describe
lifecycle actions but never replace the assigned Staff owner. The same rule governs Staff
summaries, Staff grouping, and Staff filters.

Dashboard counters and trend, Staff JobCard counters, and approval queue metrics include
every JobCard type. Delivery report quantities and Staff purpose quantities include only
`PRODUCT_DELIVERY`. Activating `GENERAL_TASK` therefore extends operational and approval
metrics without giving a General Task any delivery quantity.

Completed JobCard counts use `manager_approved_at`; cancelled counts use `cancelled_at`;
approval age uses `staff_completed_at`; overdue state compares `due_date` with the
organization-local current date. Reports use paired inclusive local dates, default to the
current local month, and permit at most 366 calendar dates.

A read-only Reports module owns and implements the canonical
`StaffOperationalSummaryPort`. Existing People profile counters remove their second SQL
definition and consume `getOne`/batch `getMany` through composition-root injection.
`listStaff` uses one batch aggregation rather than a query per person. Reports never calls
People service or HTTP, and the dependency direction creates no circular runtime
dependency. The initial UI uses counters, accessible tables, and one daily
completed-JobCard trend without a chart dependency.

Approval elapsed time is non-negative through
`GREATEST(requestTime - staff_completed_at, interval '0 seconds')`. Approval summaries
cover the complete queue before pagination; pending count equals both response `total`
and the sum of the four age buckets. A future submission timestamp contributes zero
minutes to the first bucket.

### Consequences

- Waiting-approval, revision-requested, and cancelled deliveries do not inflate approved
  delivery output.
- A record approved later appears under its actual historical delivery date.
- Unknown, `adet`, `kutu`, and other units remain distinct and are never summed together.
- Delivery totals mean grouped-row counts, quantities always expose three decimal places,
  and frontend code never parses quantities for arithmetic aggregation.
- Dashboard state counters are point-in-time; completion and cancellation counters are
  period-based and labeled accordingly.
- Missing, cross-organization, non-Staff, and malformed Staff report identifiers share
  `404 STAFF_PROFILE_NOT_FOUND`; malformed UUIDs are rejected before PostgreSQL access.
- Stable `/reports`, `/reports/deliveries`, `/reports/approvals`, and
  `/staff/:staffUserId/reports` routes own their defined date, grouping, Staff, and offset
  state in the URL; changes reset pagination and invalid URL values use replace navigation.
- Slice 08 adds no report table, materialized view, cache, or speculative index migration.
- Revenue, margin, commission, stock, invoice, payment, and employee-ranking metrics
  remain outside MVP.

## DOM-007: Structured Sales Meeting uses two-stage planning and actual-result reporting

- **Date:** 2026-07-15
- **Status:** Accepted and verified; planned-time field superseded in part by JOB-006
- **Scope:** Slice 10 Structured Sales Meeting

### Context

A Sales Meeting must be schedulable before it occurs, but outcome reporting must use the
actual event rather than a planned date or free-text note. Requiring the result at create
time would prevent planning; modeling the meeting as General Task plus notes would make
outcomes and follow-up intent unreliable.

### Decision

`SALES_MEETING` is the third canonical JobCard type and uses two stages. Create records a
required planned calendar day and atomically creates one nullable one-to-one detail row.
After the meeting, the assignee records `meetingAt`, meaning the actual instant, one
canonical outcome, and a normalized summary.

**Historical note:** Slice 10 originally used `dueDate` as the planned organization-local
day and explicitly rejected a separate `scheduledAt`. JOB-006 introduces canonical
`scheduledAt` as the planned instant; Sales Meeting create now requires both
`scheduledAt` (planned instant) and `dueDate` (organization-local calendar day derived or
supplied for list/deadline presentation).

The closed outcome vocabulary and Turkish labels are:

```text
POSITIVE           -> Olumlu
FOLLOW_UP_REQUIRED -> Takip gerekli
NO_DECISION        -> Karar verilmedi
NOT_INTERESTED     -> İlgilenmiyor
```

`nextFollowUpAt` is optional for every outcome, including `FOLLOW_UP_REQUIRED`; the UI
strongly recommends it for that outcome without required semantics. When present it must
be strictly later than `meetingAt`. Submit checks Customer, assignee, then structured
readiness and permits actual meeting time up to 15 minutes after authoritative request
time for clock tolerance.

Meeting result mutation uses the parent JobCard version and appends only changed field
names in `MEETING_DETAILS_UPDATED`. Staff outcome reporting attributes ownership through
`job_cards.assigned_to`, includes only manager-approved completed Sales Meetings, and
filters by actual `meeting_at`. Operational counters include the type; delivery quantity
reports remain Product Delivery-only.

### Consequences

- Planning and result capture remain separate mobile tasks under one lifecycle.
- Notes supplement but never replace the structured outcome and summary.
- Adding an outcome requires an explicit migration and API/UI/report vocabulary change.
- No automatic follow-up JobCard, notification, scheduler, calendar event, generic JSON
  details model, report cache/table/view, financial behavior, or inventory behavior is
  created by this decision.

### Verification

Verified at implementation commit `d93441802832f91fe149b603fb55ef2a29b04089` with
migration 007 clean/upgrade/rollback/no-reapply coverage, ordinary and PostgreSQL-enabled
server suites, complete web suite, production builds/audits, and the Staff/Manager
Playwright acceptance flow.

## JOB-004: Approval review is an explicit immutable snapshot

- **Date:** 2026-07-16
- **Status:** Accepted
- **Scope:** Shared JobCard approval lifecycle and Sales Meeting visibility

### Decision

1. `WAITING_APPROVAL` content is read-only. Assigned Staff must call the named,
   idempotent `withdraw-from-approval` command before editing; withdrawal returns the card
   to `IN_PROGRESS` and appends `JOB_APPROVAL_WITHDRAWN` without rewriting submission history.
2. Assigned Staff may cancel only their own `WAITING_APPROVAL` JobCard with a mandatory
   reason. This does not grant Staff cancellation in any other state.
3. Sales Meeting result and Staff-note writes begin at `IN_PROGRESS`, remain correctable in
   `REVISION_REQUESTED`, and use exact `409 JOB_NOT_EDITABLE` elsewhere.
4. `COMPLETED` and `CANCELLED` remain terminal. Reviewers retain approve/request-revision;
   they do not silently edit submitted content.

### Consequences

- Migration 008 additively extends the activity check constraint; applied migration 007 is
  unchanged.
- Approve, revision, withdrawal, and cancellation races serialize through the existing
  versioned row lock and critical-action transaction.
- Product Delivery and General Task note behavior is unchanged.

## JOB-005: Job lifecycle clarity uses backend workflow facts and frontend presentation SSOT

- **Date:** 2026-07-17
- **Status:** Accepted
- **Scope:** JobCard workflow read model, presentation adapter, approval UX language
- **Supersedes in part:** JOB-004 item that implied only assigned Staff may withdraw; the
  2026-07-16 meeting-lifecycle design sentence that excluded Manager/Admin withdrawal

### Context

The JobCard state machine, named commands, and immutable `WAITING_APPROVAL` snapshot already
existed. Detail UI still presented short command buttons without phase, responsibility, or
consequence guidance, and React risked reimplementing permission and readiness rules.

### Decision

1. **Manager/Admin withdrawal is intentional.** Assigned Staff, Manager, and Admin may
   execute `WITHDRAW_FROM_APPROVAL` from `WAITING_APPROVAL`. Another Staff user remains
   forbidden. Management editing of a waiting Sales Meeting first withdraws, then opens
   edit after the canonical `IN_PROGRESS` response.
2. **Submission readiness is backend-owned.** One structured evaluator powers both
   `submissionReadiness` on detail and `SUBMIT_FOR_APPROVAL` validation. Frontend maps
   stable requirement codes to Turkish labels and must not recompute `ready`.
3. **Turkish copy and layout are frontend-owned.** One pure presentation adapter owns phase
   labels, responsibility copy, transition labels/consequences/confirmations, success
   messages, and compact list/board summaries. Backend responses stay label-free.
4. **No migration and no new dependency.** Lifecycle facts reuse existing columns and
   activity; future revision/cancel reasons use existing activity `metadata`. Historical
   rows without reason metadata return `reason: null`.
5. **Permission and expected responsibility remain separate.** Management intervention on
   Staff-owned phases may stay secondary even when the backend allows it.

### Consequences

- Detail responses include actor-scoped `workflowContext`; list/board receive only
  actor-scoped `allowedCommands`.
- User-facing controls use consequence-led labels such as `Kontrole gönder`,
  `Kontrolü tamamla ve işi kapat`, and `Düzeltme için personele geri gönder` rather than
  ambiguous `Onaya gönder` / `Onayla` alone.
- Automated gates cover policy matrices, readiness parity, presentation matrices, and UI
  composition. Live keyboard/focus role acceptance and remote CI remain explicit evidence
  gates when environment access allows.

### References

- Design: `docs/superpowers/specs/2026-07-17-job-lifecycle-clarity-design.md`
- Plan: `docs/superpowers/plans/2026-07-17-job-lifecycle-clarity.md`

## JOB-006: Staff assignment acceptance and planned/actual scheduling separation

- **Date:** 2026-07-17
- **Status:** Accepted
- **Scope:** JobCard lifecycle statuses, acceptance authority, scheduling facts, delivery
  planned vs actual times, assignment-stage notes, list-card navigation
- **Supersedes in part:**
  - Active state machine rows that listed `PLANNED` / `PLAN` as an operational status and
    command (PRODUCT_REQUIREMENTS, architecture, API, schema drafts; AGENTS.md historical
    status list remains product-goal language until this decision is applied in code)
  - DOM-007 sentence “No `scheduledAt` is introduced”
  - JOB-005 presentation that treated optional planning as a skippable `PLANNING` phase
    with direct `NEW -> IN_PROGRESS`
  - Note policies that forbade Sales Meeting notes before `START`

### Context

`PLANNED` did not prove that the assigned Staff member accepted the work: Managers and
Admins could execute `PLAN`, Staff could start from `NEW` without planning, and planned
instants were mixed with actual delivery/meeting times. Assignment-stage communication
was blocked for meetings before start, and list cards required an expand-summary step.

### Decision

1. **Acceptance replaces planning as a lifecycle state.** Active statuses are
   `NEW | ACCEPTED | IN_PROGRESS | WAITING_APPROVAL | REVISION_REQUESTED | COMPLETED |
   CANCELLED`. Canonical command `ACCEPT_ASSIGNMENT` moves `NEW -> ACCEPTED` and appends
   `JOB_ACCEPTED`. Only the currently assigned Staff member may accept. Manager/Admin may
   assign or reassign but never accept on behalf of Staff. Staff-created self-assigned
   jobs are created as `ACCEPTED`.
2. **Start requires acceptance.** `START` is allowed only from `ACCEPTED`. Direct
   `NEW -> IN_PROGRESS` is removed. Historical jobs already past `ACCEPTED` may lack
   acceptance facts; the UI presents absence as “not recorded,” never fabricated.
3. **Migration 009 maps legacy `PLANNED -> NEW`.** Historical `planned_at` and
   `JOB_PLANNED` activity remain readable legacy history. New application code does not
   write `plannedAt` or execute `PLAN`. Active filters, board columns, and status labels
   must not expose `PLANNED`.
4. **`scheduledAt` is the canonical planned instant.** Product Delivery and Sales Meeting
   require it on create (web defaults via one pure local-time helper); General Task is
   optional. `meetingAt` and delivery-item `deliveredAt` remain actual times and must not
   be backfilled from the planned default. Pre-submission delivery lines may omit
   `deliveredAt`; submission still requires a valid actual time on every item.
5. **Acceptance invalidation.** Management may change `assignedTo` or `scheduledAt` only
   while status is `NEW` or `ACCEPTED`. Reassigning `ACCEPTED` or management changing the
   schedule after acceptance returns the job to `NEW` and clears `acceptedAt` /
   `acceptedBy`. Staff schedule edits do not clear their own acceptance. After `START`,
   schedule and assignee are immutable for normal patch.
6. **Assignment-stage notes.** Assigned Staff (and management with reach) may
   `VIEW_NOTES` / `ADD_NOTE` in `NEW` and `ACCEPTED` for all types, including Sales
   Meeting. Meeting result fields remain blocked until `IN_PROGRESS`.
7. **List interaction.** Job list/board cards open detail directly; expand-summary
   disclosure is removed. Commands remain separate controls above the stretched title link.
8. **Readiness refresh.** After a successful Sales Meeting result save, the client reloads
   canonical Job detail so `submissionReadiness` and version facts stay backend-owned.

### Consequences

- Board columns and staff open counters use `ACCEPTED` instead of `PLANNED`.
- API surface: `POST /api/job-cards/:id/accept`; no public `/plan` route.
- Applied migrations 001–008 remain immutable; only migration 009 introduces the new
  columns and status constraint.
- Frontend presentation uses phases without a skippable “Planlama atlandı” planning step;
  scheduling appears as independent planned-time copy or badge, never as a status.

### References

- Design: `docs/superpowers/specs/2026-07-17-job-acceptance-scheduling-design.md`
- Plan: `docs/superpowers/plans/2026-07-17-job-acceptance-scheduling-plan.md`

## OPS-001: Initial pilot topology is macOS + Cloudflare Tunnel

- **Date:** 2026-07-15
- **Status:** Accepted
- **Scope:** Pilot hosting topology for Servora-Med

### Context

Slice 11 delivered Ubuntu VPS-oriented hardening (systemd, public Caddy TLS templates, backup scripts). The immediate pilot needs a path that does not require opening inbound application or database ports on a public VPS.

### Decision

1. **Initial pilot topology** is a single macOS host running loopback Fastify + loopback Caddy, reached via a **named Cloudflare Tunnel** with HTTPS at Cloudflare Edge.
2. **Ubuntu VPS** (Slice 11) remains a **supported reference** topology, not abandoned.
3. **No inbound** application (e.g. 3000) or PostgreSQL ports for pilot; no router port forwarding for the app.
4. Cloudflare Tunnel **does not** replace Servora-Med session authentication and **does not** satisfy offsite backup requirements.
5. **WebSocket** remains evidence-gated and is scheduled as Slice 13 (entry criteria unchanged).

### Consequences

- Pilot operators follow `docs/operations/local-macos-cloudflare-tunnel.md`.
- Canonical cloudflared service model for pilot is **boot-time LaunchDaemon** (`sudo cloudflared service install`) with config under `/etc/cloudflared/`. Login-dependent LaunchAgent is a development alternative only.
- Tunnel Caddy uses explicit `http://<public-fqdn>:8080` with `bind 127.0.0.1` so public `Host` matches the site address; origin is local HTTP while browsers use HTTPS at Cloudflare edge.
- Client IP for login rate limits flows: `CF-Connecting-IP` → Caddy trusted loopback proxy + `client_ip_headers` → `X-Forwarded-For {client_ip}` + `X-Forwarded-Proto: https` → Fastify `TRUSTED_PROXY=loopback`.
- Local header spoof toward loopback Caddy is treated as **host compromise**, not a remote rate-limit bypass claim.
- Ingress validation against non-default config paths must pass explicit `--config` so personal `~/.cloudflared` configs are not silently used.

## OPS-002: Backup & Recovery V1 architecture is R2 + age + worker, with BR0 contracts

- **Date:** 2026-08-22
- **Status:** Accepted
- **Scope:** Backup & Recovery V1 mimarisi ve BR1–BR7 uygulama kontratları (BR0, yalnızca dokümantasyon)

### Context

MVP, betik tabanlı bir yedekleme yığınını (`backup-postgres.sh`, systemd/launchd timer, `restore-rehearsal.sh`) teslim etti ve ürün sınırı olarak "backup_status tablosu yok, uygulama içi yedekleme arayüzü yok" kaydedildi. Felaket kurtarma yeteneği (şifreli dış merkez kopya, doğrulanmış geri yükleme) bu sınırın ötesinde kalıyor. Onaylanmış ürün kararları, BR0 dokümantasyon dilimiyle depoya taşınmaya hazır hale getirildi.

### Decision

1. **BR0 yalnızca dokümantasyondur**: `docs/operations/backup-recovery/` altındaki mimari ve kontrat dosyaları; motor, migration, API, UI ve Cloudflare kaynağı eklenmedi.
2. **Backup/Restore (felaket kurtarma) ile Export/Import (veri taşınabilirliği) ayrı alanlardır**; modelleri, API'leri ve UI kavramları paylaşılmaz.
3. **Yedekleme kurulum seviyesinde (installation-level) altyapı durumudur**, organizasyon kaynağı değildir; backup tabloları `organization_id` taşımaz (gerekçeli istisna, emsal: `schema_migrations`).
4. **V1 uzak hedefi Cloudflare R2'dir** (özel bucket, en az ayrıcalıklı Object Read & Write token); Bucket Lock ve lifecycle operatör yönetiminde kalır ve Bucket Lock, AWS S3 Object Lock API uyumluluğu olarak ele alınmaz.
5. **Şifreleme yüklemeye kadar olur**, özel kripto yasaktır; onaylı yön age/X25519 genel anahtarlı şifrelemedir. Üretim sunucusu yalnızca genel recipient tutar; özel decrypt kimliği kalıcı olarak VPS'te bulunmaz.
6. **Canonical bütünlük, şifreli objenin SHA-256'sıdır** ve uzaktan akış doğrulaması ile kazanılır; ETag kanonik checksum değildir. Yükleme başarısı tek başına yedek başarısı değildir. Expected ciphertext checksum, `backup_runs`'dan bağımsız olarak R2 obje custom metadata'sında (`x-amz-meta-servora-sha256`) da taşınır; böylece metadata tabloları kaybolsa bile decrypt öncesi doğrulama yapılabilir. Metadata bir kriptografik imza değildir: gizlilik ve ciphertext bütünlüğü age'den, bozulma tespiti checksum'lardan, mevcut objelerin silinme/üzerine yazılma koruması Bucket Lock'tan gelir; **üretici otantikliği (provenance) V1'de kriptografik olarak kanıtlanmaz** — age recipient public olduğundan, R2 yazma erişimi ve public recipient'ı elinde tutan ele geçirilmiş bir runtime yeni ve söz dizimsel olarak geçerli bir arşiv enjekte edebilir. İmzalı arşiv tanımlayıcısı (ayrı güven alanından) gelecekte isteğe bağlı bir sağlamlaştırmadır, V1 kapsamı dışındadır.
7. **Yedek oluşturma asenkronudur**: HTTP istek ömrü içinde yürütülmez; ayrı worker süreci + PostgreSQL iş durumu (Redis/BullMQ yok), kurulum başına en fazla 1 etkin yedek, yedek/geri yükleme karşılıklı dışlayıcıdır.
8. **V1 geri yükleme operatör kontrollüdür** (`servora-backup` CLI): önce yeni/ayrı bir hedef veritabanına doğrular, üretim DB'sini asla ilk adımda ezmez, üretim geçişi (cutover) ayrı ve kontrollü bir işlemdir; geçiş öncesi PRE_RESTORE güvenlik yedeği zorunludur. Normal web arayüzünde geri yükleme butonu yoktur.
9. **MVP ürün sınırı ("uygulama içi yedekleme arayüzü/tablosu yok") V1 için OPS-002 ile geçersiz kılınır**; sınır, BR1 (domain) ve BR6 (admin UI) slice'ları gerçekten birleşene kadar yürürlükte kalır. BR5'e kadar mevcut betik yığını işletme sözleşmesi olarak kalır ve operatör uyarı izleyicisi `backup_runs` doğrulanmış yedek kaynağıyla uzlaştırılır (ikinci bir izleme modeli kurulmaz).
10. **Başarı ölçütü geri yükleme kanıtıdır**: temiz hedefe geri yükleme + Servora'nın geri yüklenen veriyle çalışması (16 adımlı kabul testi); yalnızca yedek dosyası oluşması V1'i tamamlamaz.

### Consequences

- `backup_runs` durum modelinde `SUCCESS` satırlarında `failure_code` her zaman NULL'dur; doğrulanmış yedek üzerindeki ölümcül olmayan operasyonel durumlar (ör. `CLEANUP_FAILED`) `warning_code` ile taşınır — BR1 migration'ı bu invariant'ı CHECK kısıtı ile korur.
- Uygulama sırası BR1–BR7 yol haritası ile sabittir (`docs/operations/backup-recovery/architecture.md` §16); slice'lar §2'deki karar kaydını yeniden açamaz, çelişki görürlerse en dar uzlaştırmayı önerirler.
- Backup yönetimi V1'de yalnızca ADMIN'dir ve bilinçli olarak Manager yeteneklerinden dardır; geri yükleme hiçbir uygulama rolüne açık değildir.
- `docs/operations/backup-restore.md` MVP yığını için geçerliliğini korur; BR0 bu sayfada yalnızca yönlendirme notu ekler.
- Backup tabloları, denetim olayları (`BACKUP_*`) ve admin API kontratları BR1'de mevcut şema/API/denetim konvansiyonlarına (CHECK kısıtlı enum'lar, AppError kodları, `audit_events`) uyumla taşınır.

### References

- Mimarî ve karar kaydı: `docs/operations/backup-recovery/architecture.md`
- Arşiv/depolama kontratı: `docs/operations/backup-recovery/archive-and-storage-contract.md`
- Platform kontratları: `docs/operations/backup-recovery/platform-contracts.md`
- MVP yığını: `docs/operations/backup-restore.md`

### Current-state reconciliation addendum — 2026-08-29

The BR0 context and decision text above preserve the state and provenance of
the accepted OPS-002 record. Since then, BR1–BR7 have been merged on canonical
`main`: the installation-scoped backup domain, execution contracts, worker,
operator restore CLI, and the capability-gated ADMIN Backup & Recovery UI/API
are implemented. The MVP product boundary in item 9 is therefore no longer a
claim that the current repository has no backup tables or UI.

The legacy `backup-postgres.sh`/timer/rehearsal stack remains an active
operator contract until a separately authorized production worker and cutover
transition. Production worker enablement, real-R2 DR acceptance, host
configuration, offsite retention, host restore rehearsal, monitoring cutover,
and production restore/cutover remain unproven or unauthorized. Export/Import
remains a separate deferred business-data domain; no `SYSTEM_OPERATOR` role is
introduced by this reconciliation.

## OPS-003: BR3 yedek şifrelemesi native age post-quantum HybridRecipient kullanır (ML-KEM-768 + X25519)

- **Date:** 2026-08-23
- **Status:** Accepted
- **Scope:** Backup & Recovery V1 şifreleme dilimi (BR3): recipient türü, araç sürümü ve anahtar custodysi

### Context

OPS-002, BR0 zamanında henüz somut uygulama seçimi yapılmadan önce şifreleme yönünü "age/X25519 genel anahtarlı şifreleme" olarak kaydetmişti ve BR3'te bu noktanın güncel upstream durumuyla yeniden değerlendirilmesini açıkça şart koşmuştu (kayıtlı reviewer notu: classic X25519 ile güncel post-quantum hibrit yöneliminin BR3'te karşılaştırılması). BR3'te bu kapı çözüldü: age 1.3.0 (Aralık 2025) native post-quantum recipient desteğini getirdi — HPKE temelli, ML-KEM-768 + X25519 hibrit KEM. Yedek arşivleri on yıllar saklanabildiğinden ("harvest now, decrypt later" tehdidi) uzun süreli gizlilik için post-quantum recipient makul maliyetsizdir ve upstream tarafından birinci sınıf desteklenir; ayrı bir eklenti/kriptografi katmanı gerektirmez.

### Decision

1. **Native age HybridRecipient (ML-KEM-768 + X25519) kullanılır.** Karar yalnızca OPS-002'nin "recipient türü" yönünü yerinden alır; OPS-002'nin geri kalanı (şifreleme yükleme öncesi olur, özel kripto yasak, üretim yalnız public recipient tutar, canonical bütünlük uzaktan doğrulanmış ciphertext SHA-256'sıdır) aynen yürürlüktedir.
2. **Encoding aileleri:** public recipient `age1pq1…` (~1.959 karakter), private identity `AGE-SECRET-KEY-PQ-1…` ile başlar. Üretimde kabul edilen tek recipient ailesi `age1pq1` native hibrit biçimidir; classic X25519 (`age1…`), SSH recipient, plugin recipient ve passphrase modu reddedilir — **classic fallback yoktur, classic+hibrit karıştırma yoktur**.
3. **Resmî age uygulaması zorunludur** (FiloSottile/age CLI); JavaScript age yeniden uygulaması, npm sarmalayıcısı veya özel zarf kriptografisi kullanılmaz. Üretim alt sınırı **age >= 1.3.0 (major=1)**; doğrulanmış hedef sürüm **1.3.1** (resmî release artifact'i yayın checksum'ıyla doğrulanarak kurulur). Daha yaşlı/major'ı farklı binary `ENCRYPTION_FAILED` ile fail-closed döner; eski binary nedeniyle classic X25519'a düşülmez.
4. **Anahtar custodisi değişmez:** üretim worker/VPS'i yalnızca PUBLIC recipient'ı (`BACKUP_ENCRYPTION_RECIPIENT`) tutar; PRIVATE identity (`AGE-SECRET-KEY-PQ-1…`) operatör elinde, VPS dışında tutulur ve uygulama için desteklenen hiçbir config yolu onu kabul etmez. Anahtar üretimi operatör eylemidir: `age-keygen -pq -o <identity>` + `age-keygen -y <identity>`; uygulama anahtar üretmez, saklamaz, döndürmez.
5. **V1'de tek hibrit recipient** kullanılır; recipient karıştırma / çoklu-recipient anahtar yönetimi eklenmez. Rotasyon elle yapılır: `BACKUP_ENCRYPTION_RECIPIENT` değişikliği yalnızca YENİ yedekleri etkiler; eski arşivler eski identity'ye şifreli kalır ve operatör, ona şifreli her arşiv retention süresi dolana kadar eski private identity'leri saklamak zorundadır (erken silme o yedekleri kurtarılamaz yapar). Özel anahtar escrow'u yoktur.
6. **Üretici otantikliği (provenance) hâlâ V1 dışındadır** (OPS-002 madde 6 garanti matrisi aynen geçerli): age gizlilik ve ciphertext bütünlüğü sağlar, imza/üretici kanıtı sağlamaz; BR3'te imza yoktur.

### Consequences

- BR3 çıktısı `<backup-id>.sbk.age` binary native age formatındadır (armor yok); plaintext `<backup-id>.sbk.tar` paketi başarılı şifrelemeden sonra da workspace'te kalır (silme yalnız BR4 REMOTE_VERIFY sonrası).
- BR3 motorunun döndürdüğü `localCiphertextSha256` YEREL BEKLENEN değerdir ve BR4 el sıkışma sözleşmesidir; `backup_runs.sha256` (kanonik, uzaktan doğrulanmış) değildir ve BR3 onu asla yazmaz.
- CI ve üretim önkoşulu: resmî age >= 1.3.0 kurulumu (VPS dağıtım dokümanında operatör adımı olarak kayıtlıdır).
- Geriye dönük uyumluluk: 1.3 öncesi age binary'si ile üretilmiş yedek yoktur (BR3'ten önce şifreleme yoktu); compat katmanı gerekmez.

### References

- Yerine aldığı yön (yalnız recipient türü): `DECISIONS.md` OPS-002 madde 5; `docs/operations/backup-recovery/architecture.md` §10 (uzlaştırma notu eklendi)
- Uygulama: `server/src/modules/backup/encryption.ts` (LocalEncryptionEngine, recipient policy)
- age 1.3.0 sürüm notları (native post-quantum recipients, `age1pq1…`, `AGE-SECRET-KEY-PQ-1…`, `age-keygen -pq`, `age-inspect`)

## OPS-004: Production backup gözlemlenebilirliğinin kaynağı atomik host-side durum artifact'idir

- **Date:** 2026-09-07
- **Status:** Accepted design; implementation is not authorized by this decision record
- **Scope:** `OPS-BACKUP-OBS-1` — aktif host-side PostgreSQL backup yolunun health ve gelecekteki operator alerting için gözlemlenebilirlik sınırı

### Context

Production'ın aktif backup yolu `servora-med-backup.timer` →
`servora-med-backup.service` → `ops/scripts/backup-postgres.sh` zinciridir.
Günlük `02:30 UTC` timer `Persistent=true` ile aktiftir. Buna karşılık
`GET /api/health` içindeki mevcut backup alanları yalnızca production'da kapalı
olan BR5 worker'ın PostgreSQL tabanlı `backup_runs` / `backup_worker_state`
durumunu okur. Bu nedenle aktif host-side backup yolu sağlıklı olsa bile public
health projection'ı `status=unavailable`, `latestRunStatus=null` dönebilir.

`backup_runs` genel yaşam döngüsü alanlarıyla BR5/R2'ye özgü remote-object,
upload, verification ve phase alanlarını birlikte taşıdığı için **mixed** bir
modeldir. `backup_worker_state` ise BR5 scheduler/lease state'idir ve
**BR5-specific** kabul edilir. Host-side script bu tablolara yazmayacaktır.

### Decision

1. Aktif host backup gözlemlenebilirliği için SSOT, atomik güncellenen ve sürümlü
   bir machine-readable state artifact olacaktır:
   `/var/lib/servora-med-backup/observation-v1.json`.
2. Writer yalnızca `backup-postgres.sh` olacaktır; yazım dar bir helper üzerinden
   temp-file + aynı filesystem üzerinde atomic rename ile yapılacaktır. Dizin
   `servora-med:servora-med` / `0700`, dosya `servora-med:servora-med` / `0600`
   olacaktır. `/var/backups/servora-med` izinleri gevşetilmeyecektir.
3. Artifact, en son deneme ile en son başarılı ve checksum doğrulanmış local
   restore point'i birbirinden ayıracaktır. Başarısız veya yarım bir deneme,
   önceki başarılı restore-point kanıtını silemez ya da başarı gibi gösteremez.
4. Public health'ın backup anlamı "aktif production provider yeterince yeni,
   checksum-doğrulanmış bir local restore point sağlıyor mu?" olacaktır. Public
   projection yalnızca güvenli status ve timestamp alanlarını taşıyacak; path,
   filename, DB adı, hostname, object key, credential veya raw error içermeyecektir.
5. Freshness kuralı, gelecekteki timestamp'leri geçersiz sayarak son başarılı ve
   checksum-doğrulanmış local artifact'in yaşının **26 saat veya daha az**
   olmasıdır. Bu eşik 24 saatlik RPO'ya günlük timer ve normal çalışma süresi
   için iki saatlik operasyon toleransı ekler. Health ve operator alerting aynı
   helper/kuralı kullanmalıdır; ikinci bir freshness tanımı eklenmeyecektir.
6. Predeploy, postdeploy ve manuel çalıştırmalar geçerli artifact + sidecar atomik
   olarak tamamlanıp checksum doğrulanmışsa local recoverability freshness'ına
   sayılır. Ancak günlük timer'ın çalıştığını kanıtlamaz.
7. Timer liveness ayrı bir schedule heartbeat boyutudur. İlk doğal scheduled slot
   kabul edildikten sonra en son scheduled denemenin başarılı olması ve son
   scheduled checksum-doğrulanmış artifact'in 26 saat içinde bulunması gerekir.
   Deploy/manual backup bu heartbeat'i karşılayamaz. Böylece sık deploy, bozuk
   timer'ı gizleyemez.
8. Gelecekteki operator alerting aynı observation artifact/helper'ı okur;
   alert kurulumu ayrı `OPS-BACKUP-ALERT-1` gate'idir. Local ve offsite durumları
   bağımsız boyutlardır; offsite eksikliği local backup'ı sahte biçimde başarısız
   yapmaz ve ayrı `OPS-BACKUP-OFFSITE-1` gate'inde görünür kılınır.
9. BR5/R2 daha sonra etkinleştirilirse provider'lar zorla tek tabloya
   dönüştürülmez. Stable health adapter `HOST_PGDUMP` ve `BR5_R2` provider
   projection'larını açıkça birleştirir; production'da etkin provider politikası
   ayrıca belirlenir.
10. İlk doğal timer zinciri ayrıca
    `OPS_BACKUP_TIMER_1_FIRST_RUN_ACCEPTANCE` gate'inde kanıtlanacaktır:
    timer trigger → service `SUCCESS` → doğrulanmış artifact + sidecar → bir
    sonraki trigger'ın yeniden planlanması. OBS uygulaması bu kabulü taklit etmek
    için manuel backup çalıştırmayacaktır.

### Consequences

- İlk implementation slice migration veya backend backup tablolarını yeniden
  kullanmayı gerektirmez; backup script writer'ı, scoped state directory/systemd
  erişimi ve health adapter'ı değişir. Public health değişikliği additive kalır.
- Directory taraması health SSOT'u değildir: filename convention, retention ve
  her request'te checksum maliyetine bağlanmaz. Artifact bütünlüğü yine backup
  çalışması sırasında doğrulanır ve state'e sonuç olarak yazılır.
- Operator alerting tek başına truth sahibi değildir; health ve alert aynı
  observation modelinden farklı güvenli projection'lar üretir.
- Ayrı program gate'leri korunur:
  `OPS-BACKUP-ALERT-1`, `OPS-BACKUP-OFFSITE-1`,
  `OPS-BACKUP-RESTORE-1`.

### References

- Ayrıntılı tasarım sözleşmesi:
  `docs/operations/backup-recovery/host-backup-observability.md`
- Aktif MVP host backup işletim sözleşmesi:
  `docs/operations/backup-restore.md`
- BR5/R2 mimarisi:
  `docs/operations/backup-recovery/architecture.md`

## Current-state reconciliation addendum — 2026-08-30

Bu ek, önceki kronolojik kararları değiştirmeden, 041 şema ve yaşam döngüsü
uzlaştırması sonrasındaki güncel durumu kaydeder.

- **Canonical source:** `main`, `origin/main` ile hizalı; exact head
  `6f387f09f8fa1a1f5ae800fbd55b73ae168e55e8`.
- **Source schema:** 41 / `041_user_lifecycle_reconciliation`.
- **Protected local `servora_med`:** schema 41 /
  `041_user_lifecycle_reconciliation`; schema compatibility `COMPATIBLE`.
- **Production schema:** `UNKNOWN`. Production readiness discovery ve
  production işlemleri bu kayıtla gerçekleştirilmiş sayılmaz; deploy-time
  karşılaştırma read-only olarak gerçek installed schema'yı ve ordered pending
  set'i belirlemelidir.
- **Migration authority:** `MigrationCatalog` canonical kaynaktır;
  `HEALTH_SCHEMA_VERSION` yalnızca catalog head için bir configuration
  assertion'dır. Uygulama başlangıcında otomatik migration yoktur. Production
  migration yalnızca açık `allow_migrations` / `--allow-migrations`
  yetkilendirmesiyle çalıştırılabilir.
- **D4 Demo lifecycle:** `create → use → purge completely → recreate`.
  Başarılı purge sonrasında DEMO domain kayıtları ve `demo_datasets` satırı
  yoktur; product-facing `PURGED` geçmişi tutulmaz. İdempotent tekrar için
  minimal teknik `COMPLETED` receipt kalabilir. BUSINESS kayıtları korunur,
  cross-link kontrolü fail-closed ve purge işlemi transaction içindedir.
- **U3 User/Staff lifecycle:** yalnızca Admin, pristine BUSINESS kullanıcıyı
  anlamlı business/operasyon geçmişi ve blocking aktif sorumluluğu yoksa
  kalıcı silebilir. Self-delete, son aktif Admin, Demo kullanıcı ve history-
  bearing kullanıcı korumaları yürürlüktedir. History-bearing Staff
  offboarding ile pasifleştirilir; sorumluluklar açıkça çözülür, oturumlar
  iptal edilir ve tarihsel attribution korunur.
- **Admin data navigation:** Ayarlar → Veri Yönetimi read-only özet/geçiş
  alanıdır; toplu silme konsolu değildir. Yıkıcı işlemler kendi domain
  ekranlarındaki yetkili akışlarda kalır.
- **Local validation artifacts:** local reconciliation için taze pre-backup
  `/private/tmp/servora-med-before-schema-041-20260830T135819Z/servora-med-20260830T135819Z.dump`
  ve post-backup
  `/private/tmp/servora-med-after-schema-041-20260830T150803Z/servora-med-20260830T150803Z.dump`
  kullanılmıştır. Post-backup SHA-256:
  `cf9860bb443d05a4d82f0b504a5f48ff8431448886cc0bb6ae48b8dd0e758bdb`.
  Bu yollar production backup'ı veya production deployment kanıtı değildir.

## 049 lifecycle intent prerequisite — 2026-09-17

Accepted contract for the isolated 049 candidate; this entry does not claim a
production migration or authorize the OVR-3 scanner.

- Lifecycle business time is `reserved_at`: PostgreSQL `clock_timestamp()`
  truncated to milliseconds, sampled after the organization-scoped JobCard
  `FOR UPDATE` lock. It replaces service-entry time for lifecycle facts,
  transition timestamps, episode activation, OVR evaluation/recovery and receipt
  `evaluatedAt`. Other request/query clocks are unchanged.
- A short reservation transaction validates version, actor/command eligibility
  and START planned interval before committing PENDING. START provider work runs
  after this commit, with no JobCard lock held. Finalization revalidates under lock.
- Identity remains `(organization_id, user_id, client_action_id, operation_key)`;
  operation namespaces and semantic request hashes are unchanged. Completed
  receipts remain authoritative in `processed_actions`, including legacy
  NULL-hash fail-closed behavior. Receipt recheck after the reservation lock wait
  precedes the new-attempt version fence.
- Default TTL is 60,000 ms (`JOB_CARD_LIFECYCLE_INTENT_TTL_MS`). The original
  reservation never renews. A live duplicate returns ACTION_IN_PROGRESS;
  expired/FAILED identities cannot execute again. A new deliberate attempt needs
  a new client action key. Expiry is checked against the DB clock before and
  after business work; expiry rolls back all transactional business effects.
- Finalization keeps claim → scheduling User locks → JobCard → intent order.
  Business changes, audit/realtime records, `processed_actions` completion and
  intent completion commit atomically. Definitive failure bookkeeping uses the
  same connection after rollback; secondary bookkeeping failure cannot replace
  the original error. An uncertain COMMIT must not blindly mark the intent FAILED.
- Migration 049 is additive and has no backfill. Demo purge deletes intent rows
  before JobCards. No SCANNER provenance, worker, timer or migration 050 is added.
- PostgreSQL fixtures use the DB arbitration baseline and persisted reservations;
  production has no test-clock bypass. Exact boundary policy tests remain
  deterministic. Historical read-path fixtures are explicitly constructed as
  historical snapshots rather than pretending the injected service clock moves
  PostgreSQL time.

## OVR-3 second activation — 2026-09-21

The OVR-3 clock-only overdue breach scanner is **enabled in production** as of
this entry. This supersedes the scanner's previous operational status
("disabled / rollout paused"). Earlier statements remain accurate as history for
the releases they describe, but they no longer describe the current state.

- Activation was bounded: one environment key
  (`OVERDUE_SCANNER_ENABLED` `UNSET → true`) plus exactly one service restart.
  No deploy, no migration, no source change, no manual scan.
- The scanner is constructed on the next start
  (`config.overdueScanner?.enabled === true`), the first tick runs immediately,
  and the loop held a stable 60 s cadence with `failed = 0` across the mandated
  observation window and well beyond it.
- During this second activation, clock-only discovery produced legitimate
  incidents — all `LATE_SUBMISSION` with `source = SCANNER` — and one was later
  recovered through the ordinary lifecycle path, so the OVR-2 recovery contract
  is now demonstrated against a scanner-produced row in production.
- The scanner remains subject to the same producer contract as the
  request-driven paths: it never writes recovery, never fabricates a user, and
  never dates a breach before its episode activation.
- Rollback was not required. Evidence, per-incident classification and residual
  follow-ups are recorded in
  [2026-09-21-ovr3-scanner-second-activation.md](./docs/operations/2026-09-21-ovr3-scanner-second-activation.md).

## Weekly Report V1 Slice 1 server foundation — 2026-09-23

Accepted persistence foundation for `WEEKLY_REPORT — Haftalık Rapor`. This
entry records domain ownership and deliberately closed scope; it does not ship
a user-facing workflow.

- **Ownership:** `JobCard` keeps assignment, lifecycle, due date, authority,
  audit and overdue. `WeeklyReport` owns report identity (Monday–Sunday
  period), draft content and immutable submission history. No second lifecycle
  engine is introduced.
- **Period:** Monday → Sunday in organization timezone SSOT;
  `period_start DATE` + `period_end DATE` with
  `period_end = period_start + 6` and ISO-Monday start, DB-enforced
  (migration 051). Default due date for future commands: the Monday after
  `period_end`; DATE-only due semantics unchanged.
- **One canonical report:** exactly one `weekly_reports` row per
  `organization_id + staff_user_id + period_start` (ordinary UNIQUE, no
  lifecycle predicate). Cancelled/invalidated replacement semantics are out
  of V1.
- **Authorship:** only the assigned STAFF user edits the draft body and
  submits. MANAGER/ADMIN request, review, request revision, approve and may
  cancel/invalidate per existing policy; they never author or submit on the
  employee's behalf.
- **Manager questions:** at most 5, prompt ≤ 500 chars, frozen at creation;
  every present question requires an answer (≤ 4000 chars) at submission.
  No generic dynamic-form engine.
- **Activity clock:** automatic weekly activity uses `staff_completed_at`
  (the employee's completion act), never `manager_approved_at` (management
  review timing). Sources: same org, assigned to the report staff,
  `type != WEEKLY_REPORT`, completion instant inside the org-local week,
  current status `WAITING_APPROVAL` or `COMPLETED`.
- **Submission lateness:** a `WEEKLY_REPORT` in `WAITING_APPROVAL` is no
  longer employee-submission-overdue; review delay stays on the existing
  24h `APPROVAL_WAIT` episode. No scanner/worker architecture change.
- **Reporting semantics:** weekly reports are administrative artifacts, not
  productive work — excluded from completion/performance/type-bucket
  aggregates; outstanding-assignment status counters still include them.
- **History:** no migration, reinterpretation or backfill of historical
  GENERAL_TASK records. Public `WEEKLY_REPORT` creation stays closed until
  Slice 2; recurrence and PDF are deferred (PDF remains a V1 requirement,
  not redefined as browser-print).

## Weekly Report V1 Slice 2 single-report workflow — 2026-09-24

Public single-report flow enabled (bulk/recurrence/PDF/profile-history still
out). No migration (051 schema proved sufficient).

- **Creation:** `POST /api/job-cards/weekly-reports` (dedicated command).
  STAFF self-creates (assignedTo omitted/self, no questions) → ACCEPTED with
  canonical accepted evidence; MANAGER/ADMIN requests one active STAFF
  (assignedTo required, 0..5 frozen questions) → NEW. Idempotent via
  processed_actions (`WEEKLY_REPORT_CREATE`) with normalized-intent hash;
  replay converges, reused key → CLIENT_ACTION_REUSED, same staff/week →
  WEEKLY_REPORT_ALREADY_EXISTS with report/job navigation metadata.
- **Title:** deterministic neutral `Haftalık Rapor (YYYY-MM-DD – YYYY-MM-DD)`;
  localized period labels render in UI only. Title is not identity.
- **Instructions:** manager request instructions reuse the JobCard
  `description` primitive (bounded 2000). No new note context, no schema.
- **Due date:** default Monday after `period_end` (+1 day); explicit ISO
  override through existing due-date semantics.
- **Customer:** WEEKLY_REPORT is never customer-scoped (`customer_id = NULL`);
  customer schedule/conflict/history logic untouched.
- **Draft:** complete-replacement PUT semantics via PATCH (never sparse
  merge); editable in ACCEPTED/IN_PROGRESS only (REVISION_REQUESTED requires
  RESUME first, matching lifecycle); WAITING_APPROVAL/COMPLETED locked.
  Owner STAFF writes; managers read-only.
- **Submission:** explicit WEEKLY_REPORT policy branch (summary +
  nextWeekPlan required, blockers optional, every frozen question answered,
  empty source-work allowed). Atomic boundary: SUBMIT transition + submit
  activity + immutable submission + source snapshot in ONE transaction; the
  activity id comes from the transition result (no client field; unknown
  submit keys rejected at the route). submittedAt = transition request clock
  (DB clock_timestamp reservation), identical to staff_completed_at evidence.
- **F2/F3/F4 closed:** deterministic 23503 mapping, constraint-specific
  duplicates (ALREADY_EXISTS vs JOB_ATTACHED), server-owned clock.
- **Reporting:** created-volume/status counters stay inclusive of weekly
  reports where they literally mean job counts; productive aggregates stay
  exclusive (unchanged from Slice 1).
- **Web:** exact parsers accept the 4-type union; productive buckets keep a
  dedicated 3-type list (server parity); dedicated create/detail UI reuses
  workflow panels and dialogs.

## Weekly Report V1 Slice 2 remediation (adversarial review F-1..F-8) — 2026-09-24

Closes the independent review findings on the single-report workflow without
touching the approved server architecture and without a migration (051 stays
the head). Server stays authoritative; the changes harden the web workflow
contract and two authority rules.

- **Dirty-draft submission (F-1):** the visible form is compared structurally
  against a persisted baseline (draft sections, manager-question answers,
  report version). While dirty, `SUBMIT_FOR_APPROVAL` is not executable and
  the workflow states `Raporu göndermeden önce değişiklikleri kaydedin.`
  A successful save moves the baseline and clears the dirty state; reverting
  an edit to the persisted value is clean again. Save is never chained
  silently into submit.
- **Realtime/refresh semantics (F-2):** server/status/history refresh is
  separated from editable-form hydration. A clean form hydrates normally; a
  dirty form keeps its local draft and answers, and a concurrent server
  version move is surfaced as a conflict instead of overwriting unsaved text.
  `VERSION_CONFLICT` never discards local edits; recovery is the explicit
  `Sunucudaki sürümü yükle` action, never a silent merge.
- **Organization timezone default week (F-3):** the create screen no longer
  derives the default Monday from device-local calendar arithmetic. The
  canonical current reporting period comes from
  `GET /api/job-cards/weekly-reports/reference` (organization timezone,
  `periodStart`, `periodEnd`, default `dueDate`). Manual Monday selection stays
  allowed; the server keeps validating the canonical ISO date and Monday rule.
- **STAFF deadline authority (F-4):** a STAFF self-create that supplies
  `dueDate` is rejected with a field error (fail-closed, never silently
  ignored) and the server always derives `periodEnd + 1`. The generic
  `EDIT_JOB_FIELDS` path rejects any STAFF change to a WEEKLY_REPORT
  `title`, `description`, `assignedTo` or `dueDate`; unchanged (no-op) values
  stay allowed, and MANAGER/ADMIN override authority is preserved. Other
  JobCard types keep their existing generic edit authority. Employee lateness
  therefore cannot be rescheduled away by the assignee.
- **Manager instructions (F-5):** instructions remain the JobCard
  `description` primitive (no new schema). The weekly report detail exposes
  them read-only as `Yönetici talimatı` to both the assigned STAFF and the
  manager, and the STAFF generic-edit guard prevents a silent rewrite.
  Modification history stays on the existing `JOB_FIELDS_UPDATED` activity
  (`oldValue`/`newValue` include `description`); no new audit subsystem.
- **Ambiguous lifecycle retry (F-6):** `WeeklyReportDetail` retains the exact
  original attempt (`clientActionId`, `expectedVersion`, payload/reason,
  `locationCapture`) and only replays it verbatim; unrelated lifecycle actions
  are disabled while the outcome is uncertain, and the attempt is released
  only on a definitive answer. This mirrors the generic JobDetail contract
  rather than introducing a WeeklyReport-only protocol.
- **Frozen review authority (F-7):** in `WAITING_APPROVAL` and `COMPLETED`
  the latest immutable `weekly_report_submission` is the primary report
  document (frozen body, frozen answers, frozen source-work, `submittedAt`,
  seq). The activity section uses the frozen list wording
  (`Gönderimde dondurulan çalışma listesi`) and never shows the false
  `Bu hafta için uygun iş bulunamadı` state merely because `liveSourceWork` is
  omitted in those statuses. History selection still allows older seq.
- **START geolocation (F-8):** capture follows
  `workflowContext.startLocationCaptureEnabled` exactly; no
  WeeklyReport-specific geolocation policy exists in web code.
- **Adjacent correctness:** the weekly detail lifecycle dispatcher now also
  handles `ACCEPT_ASSIGNMENT`, which the presentation already offered for
  manager-requested (`NEW`) reports — previously a dead control.

## Weekly Report V1 Slice 3 bulk manager request — 2026-09-24

MANAGER/ADMIN can request the same reporting week for many staff in ONE
logical command, producing N INDEPENDENT WeeklyReport JobCards. Recurrence,
PDF, personnel-profile history and production deployment remain out. No
migration (051 schema proved sufficient again).

- **Not a shared report:** one item per normalized target, each with its own
  JobCard id, report id, lifecycle, acceptance, due date, overdue
  accountability, draft, submissions, revision history and approval. No
  shared mutable JSON, no reference table; the tiny frozen question
  definitions are copied per `weekly_reports` row, so a later revision of one
  person's report can never affect another.
- **Command:** `POST /api/job-cards/weekly-reports/bulk-request`
  `{clientActionId, staffUserIds, periodStart, dueDate?, questions?,
  instructions?}` → `{periodStart, periodEnd, dueDate, items[]}` with
  `outcome: 'created' | 'existing'`. Items follow the normalized request order.
- **Authorization:** MANAGER/ADMIN only — there is no STAFF self-create path
  on this endpoint, so the guard is a role check rather than a target filter.
  Targets must be same-organization, active STAFF; inactive and
  MANAGER/ADMIN targets fail closed, unknown/cross-tenant ids stay concealed
  as `ASSIGNEE_NOT_FOUND`. The server never relies on web-side filtering.
- **Size and shape:** 1..50 targets (`MAX_BULK_TARGETS`), unique ids.
  Repeated ids are REJECTED as malformed instead of silently de-duplicated, so
  the caller's intent is never reinterpreted. Ids are lowercased on parse so
  their text order equals PostgreSQL `uuid` byte order.
- **Atomicity:** one receipt and one transaction. Validation, authorization
  and creation all happen inside it, so a real failure on any target rolls
  back every JobCard and report created so far — no partial result can commit
  and no target is written before the last target has been validated.
- **Duplicate convergence is NOT a command failure:** an already canonical
  report for (staff, period) is reported as `existing` with its own ids and
  the remaining targets still commit. Single create keeps its own semantics:
  the same situation raises `WEEKLY_REPORT_ALREADY_EXISTS` with navigation
  metadata. Both behaviours now come from ONE shared transaction-level
  primitive (`createOrResolveWeeklyReportForStaff`), so creation SQL,
  validation and activity/realtime wiring exist once.
- **Idempotency mechanism (chosen minimum):** parent receipt only — a
  `processed_actions` row with `operation_key = 'WEEKLY_REPORT_BULK_REQUEST'`
  and a hash over the sorted target set plus period/derived periodEnd/dueDate/
  questions/instructions. No nested per-item receipt rows: the parent receipt
  plus the `weekly_reports` staff/week unique constraint already prove that a
  retry cannot duplicate a child, that a race cannot create two canonical
  reports and that a replay returns the same report identities. Target order
  is not semantic (the hash sorts), so a reordered retry replays the stored
  result; changed intent → `CLIENT_ACTION_REUSED`.
- **Duplicate identity is the database's decision:** `insertWeeklyReportRow`
  now inserts with `ON CONFLICT (organization_id, staff_user_id, period_start)
  DO NOTHING` and returns `WeeklyReportRow | null`. The losing insert no longer
  aborts the caller's transaction, so the winner row can still be read and no
  raw `23505` can escape. This replaced a pre-check-only path whose 23505
  branch could not have re-read successfully inside an aborted transaction.
- **Target locking:** every selected user is locked through the existing
  `lockUsersInOrder` primitive, which sorts and de-duplicates, so concurrent
  bulks, single creates and staff self-creates all serialize on the same user
  row in the same order. Under that lock the staff/week pre-check is
  authoritative, and a losing create can never leave an orphaned JobCard
  because the JobCard is only created once the identity is free.
- **Realtime/notifications:** each newly created JobCard emits exactly the
  same `JOB_CREATED` activity and realtime event as an equivalent single
  manager request. `existing` items emit nothing — no fake creation, no new
  notification kinds.
- **Web:** one API path for MANAGER/ADMIN — the bulk endpoint is used for 1..N
  rather than branching to the single endpoint for N=1. This keeps duplicate
  and idempotency semantics identical between the single-target and
  multi-target manager flows and avoids two result shapes. STAFF self-create
  is untouched and keeps the single endpoint and its existing error UX.
  Selection uses the owned `ServoraSelect` adapter in `mode="multiple"` with
  client-side search (feature code must not import `antd` directly); no new
  visual system. The ceiling is enforced by prevention and the notice states
  that extra picks were not added. The web mirrors `MAX_BULK_TARGETS = 50`
  only for that pre-request guard; the server remains the enforcing owner.
- **Result UX:** exactly one target navigates straight to the canonical report
  (created or existing), like a single request; many targets show
  `N haftalık rapor isteği işlendi`, `K oluşturuldu`, `M zaten mevcuttu` and
  per-staff rows with `Oluşturuldu` / `Zaten mevcut` plus `Raporu aç`. A
  duplicate is never a red error state.
- **Ambiguous retry:** the hardened Slice 2 attempt-retention contract is
  reused verbatim — the frozen attempt holds `clientActionId`, the exact
  selected ids, period, due date, questions and instructions; selection and
  form are disabled while the outcome is uncertain and only the exact original
  command may be retried, with the same `clientActionId`.
- **Reporting/overdue:** no behaviour change. Productive-metric exclusion,
  the WAITING_APPROVAL employee-overdue exemption, APPROVAL_WAIT management
  accountability, due-date authority and customerless WeeklyReport semantics
  are untouched; bulk creation uses the same due date and type configuration
  as single creation.
- **Historical note:** the brief anticipated an existing "offboarding/bulk
  transaction pattern" to audit. No such pattern exists in this repository
  (`bulk` has zero matches under `server/src`); the reused primitives are
  `lockUsersInOrder` and `executeCriticalAction`.

## Weekly Report V1 Slice 4 profile history and PDF export — 2026-09-25

- **Two surfaces, two different natures.** The profile Weekly Report list is a
  bounded **read model** over canonical data; the PDF is an **on-demand
  projection** of one already-frozen submission. Neither is a new source of
  truth and neither writes anything.
- **Profile history is a read model, not a second reporting system.** One row
  per canonical `weekly_reports` record, enriched with the backing JobCard's
  lifecycle status (the lifecycle authority) and a submission aggregate derived
  from the immutable `weekly_report_submissions` rows. It deliberately carries
  no report content — no draft body, no frozen body, no frozen source work — so
  the profile list cannot become an alternate content surface. Content stays
  behind the report detail and submission endpoints.
- **Read port.** `WeeklyReportHistoryReadPort.listForStaff` is the explicit
  boundary, modelled on `JobHistoryReadPort`, so the profile read path never
  depends on the whole lifecycle implementation. Authorization is enforced in
  the service (STAFF self only; MANAGER/ADMIN same-organization, active STAFF
  target) **and** re-scoped in SQL: a STAFF actor is pinned to its own
  `staff_user_id` even if a caller resolves a different target, and the tenant
  predicate is always applied. Isolation is proven against real PostgreSQL
  (`weekly-report-history-postgres.test.ts`), not only with a port double.
- **Bounded cost.** One count statement plus one page statement, independent of
  the number of reports; the submission aggregate is folded in with a LATERAL
  subquery rather than a query per report. The two statements are intentionally
  not transactional, so `total` and `items` may be momentarily non-snapshot
  consistent under concurrent report creation. Accepted for this informational
  read model; no transaction or repeatable-read wrapper is to be added.
- **PDF is a projection, never a stored artifact.** A PDF is rendered on demand
  from **exactly one** immutable `weekly_report_submissions` row selected by an
  explicit `seq_no`. There is no PDF persistence, no PDF audit trail, no stored
  file and no generated-document table: the immutable submission already is the
  archival record, and the PDF is a view of it. Regenerating a PDF for the same
  seq re-reads the same frozen row.
- **Explicit seq, never "latest".** The download route always carries the seq
  the caller selected, so an older submitted version remains retrievable after a
  revision. The server conceals unknown seqs and foreign jobs as domain
  not-found errors rather than raw failures.
- **Frozen content only.** The document model is built from the submission
  snapshot. It must never read the live draft, the live answers or the live
  source JobCard. In particular each frozen source-work item's recorded
  `statusAtSnapshot` is projected **verbatim** and rendered as a localized
  `Durum` label; it is never re-derived from the JobCard's current status, so a
  later lifecycle transition cannot rewrite what a submitted report recorded.
  The status→label map is exhaustive over the union derived from
  `SourceWorkSnapshotItem['statusAtSnapshot']`, so widening that union fails the
  build instead of silently falling through.
- **Submitter identity vs display name.** `submittedBy` is the immutable
  submitter identity frozen with the submission and is rendered as the stable
  traceability identifier (`Gönderen kimliği`). The staff **display name** is
  resolved live from `users.name` and is presentation metadata only: it may
  legitimately change on rename, and the document is not claimed to be
  byte-for-byte reproducible across a rename. No name snapshot column was added.
- **Profile presentation.** The history row renders the server-provided calendar
  `dueDate` textually as `DD.MM.YYYY` (never re-parsed into a `Date`, so no
  timezone can shift the reported day) and renders `completedAt`, the JobCard
  approval instant, as `Tamamlandı <date>` only once the report actually reached
  that state. A null `dueDate` omits the label rather than inventing a value.
- **Runtime.** PDF rendering is server-side and pure JavaScript via
  `pdfmake`, pinned to an exact version. Fonts (Roboto) come from the package
  itself, so there is no host-font dependency, no font discovery, no network
  access and no Chromium/Puppeteer/wkhtmltopdf/LibreOffice requirement. The web
  bundle does not contain any PDF library; the browser only receives bytes.
- **Recurrence is NOT implemented.** Slice 4 adds no scheduler, no automatic
  Monday report creation and no recurrence engine. Weekly reports are still
  created explicitly by STAFF self-create or a MANAGER/ADMIN request.
- **Out of scope, recorded as follow-up.** The pre-existing generic
  `/staff/:id/jobs` paging helper in `people/handlers.ts` still lacks the
  safe-integer guard its Weekly Report sibling has. That is a separate fix and
  was deliberately not widened into this slice.

## Weekly Report V1 Slice 5 recurring weekly requests — 2026-09-25

Final feature slice of Weekly Report V1. No production deployment in this
slice; no merge performed here.

- **One rule per staff, fixed WEEKLY frequency.** A recurrence is a durable
  manager authorization ("for this STAFF member, request a new Weekly Report
  every week using this template"), keyed `(organization_id, staff_user_id)`.
  No multi-assignee recurrence row exists; bulk creation produces N independent
  rules. No cron expressions, no daily/monthly frequency, no other JobCard
  types, no per-rule due-date override in V1.
- **Organization-local Monday identity.** `next_period_start` is a DATE
  representing an organization-local Monday (CHECK `ISODOW = 1`); it is never a
  "Monday midnight UTC" instant. Due discovery compares the stored Monday
  against the current calendar date **in the organization's timezone** inside
  PostgreSQL (`AT TIME ZONE o.timezone`), reusing the canonical
  `currentWeeklyReportPeriod` semantics for start/resume validation.
- **Canonical next-Monday due date.** Every generated report uses the existing
  default deadline (period Monday→Sunday, due the following Monday). No
  repeating absolute due date is persisted and no weekday/due-offset
  configuration was introduced.
- **Start week is current or future.** `startPeriodStart` must be the current
  organization-local reporting week or a future canonical Monday; a past week
  is rejected so bulk configuration cannot accidentally backfill history.
  Creating the rule never synchronously creates the report; the worker produces
  the current week on its next iteration, and the UI must not also send a
  one-time bulk request for the same week.
- **Enabled downtime catches up; deliberate pause skips.** An ENABLED rule
  processes each missed `next_period_start` sequentially (exactly one period
  per claim, `+7 days` per committed occurrence) until caught up — never a
  silent jump to the current week. A PAUSED rule skips: resume sets
  `next_period_start = max(stored, requested/default current week)`, so paused
  weeks are never backfilled. Both behaviours are proven by dedicated tests.
- **Manual existing report converges.** If a canonical report already exists
  for `(organization, staff, periodStart)` — STAFF self-created, manually
  requested, or won by a racing worker — the occurrence succeeds as `existing`:
  no second JobCard, no rewritten questions, no fake `JOB_CREATED` activity,
  and the schedule still advances one week.
- **Canonical creation primitive is reused, not reimplemented.** The worker
  drives `JobCardService.createOrResolveWeeklyReportForStaff`, a minimal
  exposure of the same core the single create and bulk request use (Slice 3
  extraction: `createOrResolveWeeklyReportForStaffCore`). Slice 2/3 behaviour
  is unchanged — their suites pass unmodified. The standalone
  `runCriticalAction` receipt helper and `lockAssigneesInOrder` were likewise
  extracted verbatim (no behaviour change) so recurrence commands reuse the
  same `processed_actions` idempotency and the same staff-user lock contract.
- **Universal staff-user lock.** Bulk create locks every target in sorted
  order; the worker locks its staff target with `FOR NO KEY UPDATE` before
  touching the recurrence row; resume locks the target before the rule. Lock
  order (users first, then recurrence rows) is deadlock-free by construction.
  Real concurrent-PostgreSQL race tests cover recurrence-vs-recurrence,
  vs-single, vs-bulk, vs-self-create and claim-vs-pause.
- **Worker: claim/lease/SKIP LOCKED, no external cron.** A dedicated
  `weekly-reports/recurrence-worker.ts` (not Calendar, not OVR) polls bounded
  batches (`next_period_start, id` order), claims with `FOR UPDATE SKIP
  LOCKED`, holds a lease token with expiry recovery, retries transient
  failures on the SAME period with capped backoff (never abandons an enabled
  week), contains iteration errors, never overlaps a local run, and stops
  gracefully on `onClose`. It starts on `onReady` only when the schema
  compatibility gate passes; an empty table is a safe no-op and no feature
  flag was added.
- **Occurrence creation + schedule advance is ONE transaction.** Revalidated
  ACTIVE state, staff lock, eligibility, canonical resolve/create, JOB_CREATED
  projection, `last_processed_period_start`/`last_outcome`, `+7` advance and
  lease release commit atomically. Realtime is published only after commit;
  the database remains authoritative on crash.
- **Pause/resume are scheduling epochs; stale claims cannot execute.** A
  committed pause atomically clears the worker lease (`lease_token` and
  `lease_until`), so a claim issued before it is void: no report is created and
  the rule stays paused. A committed resume likewise clears any inherited
  lease — a resumed schedule never inherits a claim issued under an earlier
  scheduling state, including a lease written between pause and resume — so a
  stale pre-pause claim cannot execute after a resume and cannot create a
  future resumed week early. Defense in depth: inside the occurrence
  transaction, after the staff lock and the recurrence row lock and before the
  report resolve/create, the worker re-reads the organization timezone in
  PostgreSQL and verifies the LOCKED rule's `next_period_start` is not later
  than the organization-local calendar date; a locked-but-not-due rule is
  released and skipped with no report, no period advance and no failure count.
  Lease invalidation is therefore not the only protection against stale or
  future claims: the organization-local DATE remains the period authority.
- **Transaction-internal reads use the transaction client.** Recurrence
  configuration commands (bulk create, resume) run inside `runCriticalAction`'s
  `PoolClient`; their organization-timezone lookups execute on that same client
  instead of `pool.query()`, so a `max=1` pool — or a saturated pool where every
  client is busy — cannot self-deadlock. Dedicated `max=1` and saturated-pool
  tests pin the behaviour.
- **Attribution without re-authorization.** The rule retains a real
  `requested_by_user_id` (last manager/admin authorization) used as the
  creator/actor for generated JobCards and activities. The worker never
  re-runs HTTP role checks per tick, so a later role change of the authorizing
  manager cannot corrupt the rule; template/pause/resume record the acting
  manager as the new authorizing identity.
- **Target ineligibility auto-pauses.** A target that is no longer an
  active STAFF member disables the rule with `STAFF_INELIGIBLE` (version
  bumped, surfaced in the management list) instead of retrying forever. No
  report is created and the schedule does not advance. Re-enable requires an
  explicit resume against an active STAFF target. Staff offboarding itself is
  untouched (no cross-module coupling): offboarding a staff member with an
  active rule succeeds, and the worker converges to auto-pause on its next run.
- **Deletion policy integration.** An ENABLED rule targeting the user blocks
  permanent delete as `HAS_ACTIVE_RESPONSIBILITIES` (pause first — same
  precedent as PENDING calendar reminders); the requester identity blocks as
  `HAS_BUSINESS_HISTORY` (same precedent as JobCard creators). Once blockers
  pass, disabled rules of a deleted staff target are removed as technical
  dependencies (their generated reports remain untouched history). No
  `ON DELETE CASCADE` was added to business configuration.
- **No delete in V1.** Pause is the reversible lifecycle; template update is a
  full replacement affecting future reports only. All four commands (bulk
  create, template, pause, resume) are idempotent through `processed_actions`
  with `CLIENT_ACTION_REUSED` on changed intent, and ambiguous UI attempts are
  retried verbatim with the frozen `clientActionId`. A NEW pause command
  carrying a stale `expectedVersion` on an already-paused rule returns
  `VERSION_CONFLICT` (resume parity) instead of silently succeeding; a
  same-version pause no-op still returns the idempotent response. Exact
  lost-response replays are served from `processed_actions` before this
  business validation, so ambiguous retries are unaffected by the stricter
  check.
- **Reporting/overdue/profile/PDF contracts preserved.** Generated reports are
  ordinary manager-requested WEEKLY_REPORT JobCards (`NEW`, customerless), so
  productive-metric exclusion, employee overdue semantics, profile history and
  PDF export apply unchanged with no new event types or PDF fields.
- **Migration 052 only; 051 byte-identical.** `052_weekly_report_recurrence`
  is additive (one table + one partial due index, no backfill, no existing row
  altered). A sha256 tripwire test proves 051 unchanged. Pre-existing suites
  that pinned head 051 now pin 052 (mechanical rollover, no weakened
  assertions); synthetic `052_future` fixtures moved to `053_future`.
- **Mutation discrimination (all reverted, tree verified clean).** M1 fake
  created → 10 red · M2 advance outside the transaction → 10 red · M3 no staff
  row lock → 1 red in the worker-vs-self-create race (3/3 runs) · M4 no
  lease/SKIP LOCKED → 2 red · M5 paused rule claimable → 2 red · M6 UTC date →
  1 red · M7 three-week jump → 7 red · M8 resume LEAST → 2 red · M9 no
  auto-pause → 3 red · M10 template rewrites history → 1 red · M11 fresh action
  id on web retry → 4 red · M12 partial commit → 2 red.
- **Adversarial-review remediation (2026-09-25, same head series).** The review
  reproduced a stale pre-pause claim surviving pause+resume (F-1), a
  critical-action pool self-deadlock on the timezone read (F-2) and a stale
  pause `expectedVersion` accepted as success (F-3). Fixes: pause/resume clear
  the lease, the occurrence re-validates due-ness under the row lock, the
  timezone read uses the transaction `PoolClient`, and pause mirrors resume's
  version check. This entry and the pause/occurrence/transaction bullets above
  were updated with the fixes; the user manual needed no change because no
  user-visible behaviour changed (the fix enforces what the manual already
  documented).
  Original discriminators re-run on the grown suite: M1 → 12 red · M2 → 17 red ·
  M3 → 1 red (×2 runs) · M4 → 2 red (plus a lease-predicate-only submutation →
  1 red) · M5 → 2 red · M6 → 1 red · M7 → 9 red · M8 → 2 red · M9 → 3 red ·
  M10 → 1 red · M11 → 3 red (management surface; the author-recorded fourth
  covers the create screen) · M12 → 2 red. New discriminators: M13 pause does
  not clear the lease → 1 red · M14 resume retains the old lease → 1 red ·
  M15 occurrence due revalidation removed → 1 red · M16 timezone read back to
  `pool.query()` → 3 red (`max=1`/saturated-pool tests) · M17 pause version
  comparison removed → 1 red. All reverted; tree verified clean after each.
- **Field-test remediation (2026-09-26, pre-merge manager/STAFF field test on
  PR #333 head aae1c50).** A real local manager/STAFF walkthrough surfaced one
  blocker and several UX findings; the prior approval was invalidated and PR
  #333 was updated in place (no merge, no deploy). (1) **Detail/submission
  contract closed:** the web exact-object parsers rejected the intentional
  server DTO (`Rapor yüklenemedi / Yanıtta weeklyReport alanı geçersiz`);
  `parseWeeklyReportDetail` now accepts the server's `organizationId`,
  `createdAt`, `updatedAt` and `parseWeeklyReportSubmission` its
  `organizationId`, `createdAt` — added deliberately, no permissive fallback,
  regression-tested against the full server-shaped payloads.
  (2) **Create screen reworked:** `Tümünü seç`/`Seçimi temizle` for active
  STAFF (server per-command cap preserved; over-cap select-all refuses
  visibly instead of pretending or picking a subset); the manual `Termin`
  input was removed from one-time and recurring creation for every role —
  deadline displays use `Teslim son tarihi`. **Weekly Report teslim son
  tarihi oluşturma sırasında veya sonradan kullanıcı tarafından
  değiştirilemez; rapor dönemini izleyen Pazartesi olarak server tarafından
  belirlenir** (authority + immutability fixes, below).
  (3) **Manager questions reworked:** five preset questions (stable semantic
  keys `preset_week_highlights`, `preset_incomplete_work`,
  `preset_field_feedback`, `preset_next_week_priorities`,
  `preset_management_support`) plus free custom questions
  (`custom_<id>`, id minted once per add so ambiguous retries replay identical
  keys); order is presets in canonical order then customs in UI order;
  `MAX_MANAGER_QUESTIONS` raised 5 → 50 as a defensive API/PDF ceiling
  (questions are JSONB — no schema migration, 051/052 untouched);
  prompt ≤ 500 code points, answer-at-submission and frozen per-report copies
  unchanged. A shared `WeeklyReportQuestionEditor` serves both the create
  screen and recurrence template editing (future-only template semantics and
  one-rule-per-staff lifecycle untouched); the recurrence manager stays
  visible for managers in every create mode and one-time requests never
  touch existing rules.
  (4) **Verification:** focused web/server suites, `web` full suite (185
  files / 2326 tests), `web` build + bundle check and `server` build green.
  The full server suite reports 12 pre-existing local-environment failures
  (web-push `DATABASE_URL is required` ×4; production-recovery/deploy-automation
  `HOST_BOOTSTRAP_REQUIRED_psql` ×7; db-auth-contract wrong-password accepted
  under the host's `trust` pg_hba ×1) proven identical on the clean aae1c50
  base by stashing this work — none touch weekly reports and CI runs with the
  canonical environment.
- **Question-key stability fix (2026-09-26, post-remediation review).** The
  review found that recurrence template editing derived custom draft identity
  from array position (`id: index + 1`, counter seeded `custom.length + 1`),
  so a `preset + custom_1` template minted a colliding second `custom_2` on
  the next added row and a bare save could silently rewrite a persisted key.
  Custom drafts now own an explicit stable key: drafts are `{ key, prompt }`,
  `collectManagerQuestions` emits each draft's stored key (never
  `custom_<position>`), template editing preserves every persisted non-preset
  key verbatim (legacy keys such as `q1` included), and a new
  `nextCustomQuestionKey(ownedKeys)` helper mints the first `custom_N` not
  owned by preset keys, persisted custom keys and rows added this session —
  minted once at add-time, never renumbered. Proven by T1–T6 regression tests
  (round-trip, add-without-collision, multi-preset, legacy key, removal
  stability, verbatim ambiguous retry) and mutations A (index mapping → 5
  red), B (minting ignores owned keys → 5 red), C (renumber after delete → 1
  red); all reverted, tree restored.
- **Server-only deadline authority (2026-09-26, final product-authority
  audit).** The removed UI `Termin` capability still existed as an
  undocumented API parameter: the public create/bulk parsers accepted a
  caller `dueDate` and the services used `input.dueDate ?? canonical`, so a
  manager/admin could bypass the field-test product decision with a direct
  request. The public request shape no longer carries `dueDate` at all —
  exact parsing now rejects it with `VALIDATION_ERROR` (never silently
  ignored, so a caller cannot believe a deadline was accepted), the single
  and bulk request identities hash no dueDate dimension, and the services
  derive `dueDate = addCalendarDaysToDateKey(periodEnd, 1)` unconditionally
  for STAFF self-create, MANAGER/ADMIN single create and bulk alike —
  one-time and recurring reports now share the same server-canonical
  next-Monday authority. Response contracts are unchanged (create result,
  bulk result, detail, history, overdue logic still carry the canonical
  dueDate). Proven by S1–S4 (canonical deadlines for omitted dueDate;
  direct `dueDate` on staff and manager single create → 400 with zero
  JobCard/WeeklyReport/processed_actions mutation) and B1/B2 (identical
  canonical deadline on every bulk target; direct `dueDate` → 400 atomic
  zero mutation), plus mutations M1 (create acceptlist re-admits dueDate →
  3 red), M2 (bulk acceptlist re-admits dueDate → 1 red), M3 (derivation
  shifted to periodEnd + 2 → 6 red); all reverted, tree restored.
- **Deadline immutability on patch (2026-09-26, product-authority audit
  follow-up).** The create-time fix left one documented authority gap: the
  generic JobCard patch still accepted `dueDate` for a `WEEKLY_REPORT` when
  the actor was MANAGER/ADMIN (only STAFF was blocked by the ownership
  rule), so the canonical deadline could still be moved after creation —
  contradicting the product rule and the create-path comment. The generic
  patch now enforces a WEEKLY_REPORT-specific invariant on the locked row:
  a `dueDate` field whose value differs from the persisted canonical
  deadline is rejected with `VALIDATION_ERROR`
  (`Haftalık raporun teslim son tarihi değiştirilemez.`) for every role,
  while a same-value patch stays an accepted no-op under the existing
  change-scoped machinery. The guard lives inside the existing
  `job.type === 'WEEKLY_REPORT'` block (customerless/unscheduled + staff
  ownership rules unchanged; STAFF keeps its stricter `FORBIDDEN`), the
  global patch schema is untouched for other types, and no period is
  recomputed from titles. Proven by P1 (manager changed value → rejected,
  dueDate and version untouched), P2 (admin), P3 (staff keeps `FORBIDDEN`),
  P4 (GENERAL_TASK manager dueDate patch still succeeds — type-scoped), P5
  (recurrence-worker-created report rejected identically for manager and
  admin — no alternate authority path) and mutations M1 (guard disabled →
  P1/P2/P5 red), M2 (guard applied globally → P4 red), M3 (NEW-status
  exemption, exactly what a recurrence worker produces → P5 red); all
  reverted, tree restored.
- **Retired 2026-10-23:** automatic recurrence scheduling is retired as a product
  capability; the Slice 5 record above stays traceable and unrewritten. See the
  [recurrence retirement amendment](#weekly-report-recurrence-retirement--2026-10-23).
## Customer phone required for interactive creation — 2026-10-01

A user creating a new customer through the normal product UX must supply a name
and a valid Turkish phone. The rule applies to `/customers/new`, STAFF-created
prospects and the JobCard inline customer drawer; all use the shared
`CustomerCreateFlow` and `CrmService.createCustomer`.

- The server's `normalizeTurkishPhone` validates before any mutation and stores
  accepted values as `+90XXXXXXXXXX`. Missing or malformed values return
  `VALIDATION_ERROR` with `fieldErrors.phone`.
- The create input progressively displays `(0XXX) XXX XX XX`. National,
  formatted national, bare national, `90` and `+90` paste/autofill forms resolve
  to the same presentation. Landline and 0850 numbers remain valid.
- Foreign country claims, unsupported characters, a trunk zero after a country
  code and overlong values remain invalid; formatting never silently repairs
  them. Digit-based caret restoration also runs when deleting punctuation
  produces the same masked text.
- Existing customer edits remain permissive: null and historical free text are
  preserved, while a supplied valid Turkish number is canonicalized. Only
  canonical stored values are formatted for display.
- `customers.phone` remains nullable. This is an interactive product create
  contract, not a global database invariant or a JobCard approval requirement.
  Production onboarding import, demo datasets, auth/bootstrap fixtures, F4 seeds
  and direct test fixtures retain their separate contracts. They do not call
  `CrmService.createCustomer` and this feature does not change them.
- Dependency security maintenance, including the `jsdom → undici` lockfile
  update, belongs in a separate maintenance PR. The audit gate stays enabled.

Verification is covered by the focused server unit and real PostgreSQL phone
suites, web mask/caret and create/edit suites, and the existing delivery,
general-task and sales-meeting inline-create suites. No migration or backfill is
required.
## Customer phone optional for interactive creation — 2026-10-08

- **Status:** Accepted and verified.
- **Supersedes:** Customer phone required for interactive creation — 2026-10-01.
  The 2026-10-01 entry above is preserved verbatim as history; its
  phone-mandatory create rule no longer applies.

A user creating a new customer through the normal product UX must supply a
name; the phone is optional on CREATE for ADMIN, MANAGER and STAFF. All
interactive surfaces share the contract through `CustomerCreateFlow` and
`CrmService.createCustomer` (`/customers/new`, the embedded customer-create
drawer, and the Sales Meeting, General Task and Product Delivery inline
creation flows, including STAFF-created prospects).

- Missing, empty or whitespace-only phone input is stored as `NULL`. The
  create path checks emptiness before normalization because
  `normalizeTurkishPhone` returns `null` for both blank and malformed input.
- A supplied non-empty phone must still pass the existing canonical
  `normalizeTurkishPhone` validator, unchanged. Valid Turkish numbers remain
  stored in canonical `+90XXXXXXXXXX` format. Malformed non-empty values remain
  rejected with `VALIDATION_ERROR` and `fieldErrors.phone` before any write.
- The create form labels the field `Telefon (isteğe bağlı)` and validates a
  non-empty entry with the existing mask-completeness check; a blank entry
  submits normally. The server remains authoritative.
- STAFF-created customers remain self-assigned prospects with forced
  `status='prospect'`; only the phone requirement changes. CRM authorization is
  unchanged.
- Existing Customer EDIT compatibility behavior is unchanged (`editablePhone`
  preserves null and historical free text). Imports, demo/seed/bootstrap
  contracts keep their separate phone-optional paths and are not modified.
- `customers.phone` was already nullable; no migration, default, CHECK, unique
  index or backfill is introduced, and no existing rows are touched.
- No authorization, duplicate-policy (similar-name search, tax-number
  uniqueness, confirmations), lifecycle or Auth change is introduced.

Product reason: customer records must be creatable quickly during field
operations, even before complete contact information is known. Missing contact
details are collected later; contact/customer enrichment is a planned separate
capability and is not implemented here.

Verification is covered by the updated focused server unit phone suite
(blank accepted as null, malformed still rejected, STAFF self-assignment
preserved), the real PostgreSQL create suite (HTTP 201 with stored `NULL` for
missing/blank, 400 with `fieldErrors.phone` for malformed), the updated web
create/phone suites (blank submits with `phone: null`, malformed still
blocked, STAFF same rule, embedded drawer same rule), the full web suite, the
full server suite (only pre-existing environment failures, identical on the
pristine base), disposable-DB browser acceptance (blank create stores `NULL`,
partial input blocked inline), and exact-head CI.
## Local-first CI and production deployment — 2026-10-08

- **Status:** Accepted and verified.
- **Supersedes:** nothing. No prior decision mandates GitHub-Actions-only
  verification or deployment; this entry is additive and narrows operator
  procedure while GitHub-hosted runner capacity is unavailable.

GitHub remains the source repository and PR/review platform, but GitHub
Actions is no longer a mandatory dependency for completing verified
development or production deployment. Each mandatory gate is replaced by an
equivalent verifiable local gate; no gate is disabled to bypass billing.

- Local CI (`ops/local-ci/run.sh`) reproduces the `.github/workflows/ci.yml`
  contract in Colima Docker (Ubuntu `node:22` containers, `postgres:17`
  service, pinned `age` 1.3.1, `postgresql-client-17`, `gh`/`jq`/`zstd`).
  Colima was chosen over a second full VM because every current check runs in
  containers or VM userspace: `systemd-analyze verify` is offline-capable, and
  the docker-gated Caddy/SSE/tunnel/cloudflared validations run against the
  Colima daemon (SSE behavior inside VM userspace where node and docker share
  a net namespace). Full Ubuntu-VM-only checks: none in the current contract.
- Verification evidence is a hash-bound bundle (`manifest.json`, `report.md`,
  per-check logs) stored outside the checkout and re-verified fail-closed by
  `ops/local-ci/verify-evidence.sh` (SHA/tree binding, log hashes, required
  checks, Linux-compat assertion). Unexecuted checks are `ABSENT`/`NOT_RUN`
  and fail; reviewed exceptions need an explicit per-check reason. Local
  validation is never represented as GitHub Actions success.
- Production deploys keep the existing `ops/deploy-production.sh` safety
  chain. `--ci-mode github` (default) preserves prior behavior; `--ci-mode
  local --evidence <bundle>` is explicitly selected per invocation and
  re-verifies local evidence instead of consulting GitHub CI. There is no
  `--skip-ci`/`--force`/`--unsafe` bypass. A machine-wide fixed-path
  `mkdir`-atomic process lock fails closed on every existing lock (live, dead
  or malformed); stale locks are recovered only by supervised manual removal.
- Release artifacts must be Linux-compatible: `linux-compat` evidence asserts
  zero native (`.node`) and zero `os`/`cpu`-restricted production
  dependencies (verified: 136+ packages, all portable JavaScript), so a
  lockfile-built artifact is Linux/amd64-safe regardless of builder OS.
- Credentials move from GitHub environment secrets to a local 0600 file
  (`~/.config/servora-med/prod.env`) loaded by `ops/local-ci/load-prod-env.sh`,
  which refuses missing/unreadable/symlinked files and missing keys. Keys are
  never printed, committed, or logged. Provisioning the file is an explicit
  owner action.
- Negative gates are proven by `server/tests/local-evidence-deploy-gate.test.ts`
  (forged/stale/mismatched/incomplete evidence, wrong SHA, failed checks,
  non-Linux artifact, lock contention, unreachable transfer target) without
  touching production. If GitHub Actions capacity returns, hosted runs are
  preferred again; local evidence stays valid for its exact SHA.

Verification is covered by the new gate test suite (11 tests), an end-to-end
`run.sh` proving run on the implementation SHA (server 3884 passed / 0 failed
incl. the new gate tests, web 2545/2545, benchmark smoke, all ops checks incl.
docker-gated, linux-compat with zero native deps), and the existing
`production-deploy-automation` suite confirming unchanged default
(github) behavior.

## Local-first security review reconciliation — 2026-10-08

Supersedes the exception, lock, credential, and Linux-compat paragraphs of
the local-first entry above (additive; no domain, Auth, migration, or product
behavior changes).

- Trust model is explicit (F1): integrity + source identity are verified;
  execution provenance is NOT cryptographically established — bundles are
  `local-operator-attested` (internal consistency + reproducibility), never
  independently authenticated; forged provenance claims are refused.
  Deployment authorization stays independent of the bundle (SSH key +
  pinned known_hosts). No separate signature mechanism was introduced: with
  the available local environment no trusted identity exists outside the
  operator's machine, and weakening the gate to compensate was refused.
- Deploy lock is race-safe (F2): the lock lives at the fixed machine-wide
  path `/tmp/servora-med-production-deploy.lock` (never under a caller
  `TMPDIR`), is acquired with atomic `mkdir`, and every existing lock — live,
  dead or malformed — fails closed; there is no automatic stale recovery,
  only the supervised manual procedure in
  `docs/operations/production-deployment.md`. Release requires the owner's
  exact claim. Proven by a 12-process contended acquisition test, a
  deterministic stale-window (TOCTOU) interleaving test and a cross-`TMPDIR`
  serialization test.
- Credentials are key-file based (F3): the local credential file carries a
  path to a 0600/0400 OpenSSH key file (validated: no symlink, bounded size,
  key header, pinned known_hosts identity); inline multiline keys are
  refused; root SSH is refused in loader and deploy gate. Tested with
  synthetic `ssh-keygen` fixtures; no real credentials handled.
- Exception policy A (F4): no production exceptions — every mandatory check
  must PASS; the reason-string mechanism was removed from verifier, deploy
  gate, docs, and tests.
- Linux-compat is two signals (F6): the `.node`/`os`/`cpu` scan plus a real
  production install + import of every direct dependency on linux/amd64
  (Rosetta-emulated when the host is ARM); both are required by the
  verifier. Documented limitation: emulated execution, glibc/Ubuntu scope,
  no deploy-time fetches or kernel-specific behavior examined.
- Sweep fixes: portable log enumeration (no `ls --`), manifest log-path
  confinement, VM node probing instead of a hardcoded guest path, rerun log
  reset, fail-closed concurrent-run lock, non-empty compat log.


## CRM-S2-001 — STAFF customer enrichment is an action-scoped capability

- Generic customer PATCH and generic Contact mutation permissions remain unchanged.
  Organization-wide CRM visibility does not grant mutation permission.
- An active/prospect customer may be enriched by its current assigned STAFF user,
  or by a STAFF user currently assigned to one of that customer's canonical
  active JobCards. Both records must belong to the actor's organization.
  Creator identity, historical assignments and terminal jobs grant nothing.
- The customer-scoped enrichment action supports both ownership paths through
  one transactional resolver. It accepts only phone/email/city/district/address
  and expectedVersion; missing fields are preserved, unknown keys are rejected.
  Existing editable-phone and nullable-field normalization remain authoritative.
- Lock the customer first, then an authorizing JobCard FOR SHARE NOWAIT when
  needed. The job witness stays locked through commit. Busy witnesses return
  VERSION_CONFLICT rather than waiting in an inverse order against existing
  JobCard flows. Capabilities are projections; every mutation rechecks ownership.
- Compare normalized enrichment fields after transactional authorization and
  expectedVersion checks. No-op field enrichment returns the current record
  without UPDATE, version consumption, updated_at change or audit insertion.
- Scoped contact creation uses the same resolver and consumes the customer
  version atomically. It always creates an active, non-primary contact, including
  the first contact; it cannot change the aggregate's primary contact. Lost
  response retries with the same version conflict without creating a duplicate.
  Manager/Admin generic contact creation retains its existing primary behavior.
- Contact selection stays in existing JobCard creation/edit surfaces, under their
  existing active-contact, same-customer, ownership, status and version rules.
  Customer detail has no JobCard association context. PRODUCT_DELIVERY continues
  to reject new contact associations; no historical association endpoint is added.
- Audits include actor, subject, changed field names, action and server-selected
  JobCard context without contact/address values. No migration or dependency is
  needed. See docs/superpowers/plans/2026-10-10-crm-staff-enrichment.md.

## SALE-001 — Independent visit-origin product agreement (V1)

- A completed sale agreement is its own SALE JobCard with SALE_FROM_VISIT origin
  in sale_source_visit_id. Meeting POSITIVE, delivery SALE and follow-up origin
  source_job_card_id remain distinct concepts.
- V1 sources are BUSINESS, IN_PROGRESS SALES_MEETING jobs with CUSTOMER_VISIT,
  SALES_MEETING, PRODUCT_DEMO or FOLLOW_UP engagement. Customer and assignee come
  from the locked source; STAFF creates ACCEPTED, management creates NEW.
- PostgreSQL permits at most one active Sale per visit. COMPLETED, CANCELLED and
  INVALIDATED release the slot without removing history. A later independent
  Sale still requires an eligible source. Standalone/retrospective orders are
  future product decisions, not permanently forbidden general workflows.
- Snapshot product name/SKU/brand/model/nullable unit and exact NUMERIC(12,3)
  quantity; distinguish planned, actually-met and optional Sale contacts.
- Sale creation/correction never changes the source visit or creates delivery,
  follow-up, financial, stock or accounting operations. Existing mandatory
  manager approval and action-scoped authorization apply. STAFF CRM/catalog
  write permissions do not expand.
- PR1 implements private transactional create/correction services and additive
  migration 057. Public Sale write routes remain unregistered until complete
  readers/UI in PR3. See docs/features/visit-to-sale/README.md and adjacent
  approved design/lifecycle/implementation documents for the rollout contract.

## MOD-001 — Warehouse, Accounting and Integration Boundaries

- **Date:** 2026-10-14
- **Status:** Accepted
- **Scope:** Future Warehouse/Inventory and Accounting/Commercial-Document
  modules; Core/JobCard integration boundary

### Context

DOM-001 keeps delivery purpose free of financial tracking, DOM-004 keeps the
product catalog informational, DOM-006 keeps operational reports free of
revenue, and SALE-001 keeps the visit-origin sale free of invoice, payment,
stock and accounting operations. No accepted record yet defines where a future
Warehouse/Inventory module, a future Accounting/commercial-documents layer, or
domain integration mechanics would live. External research drafts
(`02-MODULE-AND-DATA-BOUNDARIES.md`,
`03-INTEGRATION-AND-EVENT-BOUNDARY.md`,
`04-CAPABILITY-MATURITY-MATRIX.md`,
`08-MODULE-AND-VERTICAL-OPPORTUNITY-MAP.md`, Servora Core v1.1 baseline) are
not present in this repository and are not binding; their proposals must not be
treated as accepted implementation steps. This record adds the missing boundary
on top of DOM/SALE without rewriting them.

### Decision

1. **Core / JobCard boundary.** Servora is operations-centric; the modular
   monolith direction is kept. Core/JobCard owns job identity, staff
   assignment, lifecycle, manager approval, operational records, audit and
   authorization. Core never produces stock balances, ledger entries, financial
   documents or collections. This decision authorizes no Core extraction or
   repository refactor.
2. **Warehouse / Inventory (future).** A future Warehouse module will own
   depots and vehicle stock, physical quantities, reservations where needed,
   stock in/out movements, transfers, returns and corrections, lot/serial/
   expiry, and the link between stock movements and their source operation.
   The same operational stock quantity must not be managed as independent
   authoritative state in two systems. Servora Warehouse aims to act as the
   stock authority when enabled; in integration mode where an external ERP is
   the stock authority, that ownership is defined separately. **The single
   stock source of truth is set explicitly per deployment/integration mode.**
   No Warehouse tables or stock balances are created now.
3. **Accounting / Commercial Documents (future).** A future Accounting module
   is designed as a light commercial layer for quotes/commercial documents,
   invoice references and lines, basic current-account/receivable state,
   collection records, document tax data and external accounting connections.
   No full general-ledger system is built. In particular Core never gains
   chart of accounts, journals, e-Defter, payroll, full bank reconciliation or
   a general posting engine. The official financial authority may later be
   Logo, Netsis, Mikro or another authorized ERP/accounting system. Concrete
   integration and document ownership are decided in Accounting A0.
4. **Integration boundary.** Current realtime/SSE events are not durable
   domain integration. Without a concrete producer/consumer and
   reliable-delivery requirement, no generic event bus, persistent global
   outbox, integration queue, webhook framework or Kafka/Redis-based general
   architecture is built. When real Warehouse/Accounting integration starts, a
   narrow durable integration/outbox contract under module ownership may be
   designed first. Older research examples such as `ProductConsumed` or
   `JobCard.Completed` are not accepted as finalized event names or migration
   requirements today. The existing notification-scoped durable delivery
   outbox for web-push stays unchanged; it is not domain integration.
5. **SALE compatibility.** The SALE JobCard already carries durable sale
   identity, durable line identity, product/quantity snapshots, customer and
   source-visit relation, and approval/audit history; these may later serve as
   references for Warehouse and Accounting. At this stage no `invoiceNumber`
   field, warehouse/location link, invoice/payment/stock status, price,
   discount, VAT or revenue computation is added, and no delivery/reservation
   is auto-created. Linking one future SALE to several PRODUCT_DELIVERY
   records and partial delivery stays a research topic; schema and rules are
   not finalized now.

### Consequences

- DOM-001, DOM-004, DOM-006 and SALE-001 stay unchanged and remain the binding
  product rules; MOD-001 only adds the module boundary above them.
- `invoiceNumber` on JobCard notes stays recorded domain debt; its resolution
  belongs to Accounting A0.
- Operational agreement counts and approved delivery quantities must not be
  mixed with revenue; see DOM-006.
- W0 (Warehouse) and A0 (Accounting) discovery titles are defined in
  [the reconciliation report](docs/architecture/decision-reconciliation-report.md);
  they carry no implementation authorization.

## SALE-QTY-001 — Integer product counts for Sale agreements

- **Date:** 2026-10-15
- **Status:** Accepted
- SALE quantity is the number of products sold: a JSON number that is a safe
  integer in **1–999999999**. Fractional sales are rejected, never rounded or
  truncated. Catalog units (ml, mg, litre, etc.) do not convert or qualify this count.
- This explicitly supersedes the decimal Sale quantity policy in the original
  SALE-001/PR1 design (0.001–999999999.999 and three-decimal public strings).
  SALE-001's other rules, DOM-001, DOM-004, DOM-006 and MOD-001 remain unchanged.
  Historical design and migration 057 remain traceable and are not rewritten.
- Product identity and name/SKU/brand/model/nullable-unit snapshots remain
  historical metadata. Public Sale quantities are exact integer strings (`"1"`,
  `"15"`); the UI describes them as product counts separately from unit metadata.
- Create, add-item, correction and submission readiness share the Sale validator.
  Its private v1 hash representation remains three-scale (`"1.000"`) so existing
  integer receipts replay without a changed hash or duplicate business effects.
  Durable audit payloads retain that representation; safe projections emit counts.
- Migration 058 validates historical rows under a table lock, removes the
  NUMERIC(12,3) typmod to use unrestricted NUMERIC, and adds an integer/range
  CHECK. This accepted PR #373 review refinement replaces the initial unmerged
  058 approach, whose typmod could round excess-scale SQL input before CHECK.
  Any historical fractional row stops the upgrade without data conversion.
  Data-owner remediation is a separate decision; migrations 001–057 are unchanged.
- PRODUCT_DELIVERY quantities, the catalog and future Warehouse physical
  measurement policies are independent. No delivery, stock or accounting behavior
  changes. PR3 will default Sale quantity to 1 and use integer-only selection,
  addition and correction; adapting ProductSelect for Sale belongs to that slice.
- Contract and rollout notes: [Sale integer quantity policy](docs/features/visit-to-sale/integer-quantity-policy.md).


## CRM-S4A-001 — Duplicate customer review design; PR1 read-only rollout

Status: Accepted Design / PR1 Rollout Pending; independent acceptance pending.

The approved D1–D6 and T1–T5 contract is recorded in the
[CRM duplicate-review owning package](docs/features/crm-duplicate-review/README.md).
Design is the domain/evidence SSOT; API, data model, tests and implementation
plan own their named contracts. Their future PR2/PR3 design does not authorize
implementation or imply shipment. PR #379 implements PR1 candidate/comparison
GETs only, with no decisions or customer mutation. Existing tax normalization,
CHECK/unique, Contact primary rules and STAFF CRM rights remain unchanged.

Production rollout remains disabled by default and requires exact-head evidence,
strict schema compatibility and separately approved secret/migration/deployment
steps. 4B, WR-01 and Issue #369 are not decided by this record.

## Weekly Report recurrence retirement — 2026-10-23

Status: Accepted product decision; code retirement implemented, independent review
pending.

Automatic weekly-report recurrence is retired permanently. Manual weekly reports
remain. This supersedes only the automation parts of the
"Weekly Report V1 Slice 5 recurring weekly requests" record; that record stays
traceable and is not rewritten.

- Removed: recurrence service/routes/worker/repository/input/types, app and
  production wiring, the worker-only creation bridge, the manager recurring create
  mode, the recurrence manager screen, recurrence API client/parsers and
  recurrence-only tests.
- Retained: STAFF manual create, MANAGER/ADMIN one-time bulk request, questions,
  draft, submission, revision, approval, manager-only cancellation, SOF-2A
  ownership and offboarding blockers, SOF-2B atomic draft, staff/week uniqueness,
  idempotency, historical submissions, frozen PDF models, personnel attribution
  and reporting integration.
- Database: migration `052_weekly_report_recurrence`, the
  `weekly_report_recurrences` table and every existing row remain untouched. This
  retirement adds no migration. 052 is applied history and must not be edited,
  renumbered or squashed.
- Staff lifecycle: `server/src/modules/people/repository.ts` retains the
  enabled-rule permanent-delete blocker, the requester business-history identity
  and the paused-rule cleanup on hard delete. These guard dormant historical rows
  and preserve foreign-key and accountability integrity; they are not a
  recurrence management surface.
- Deployment and rollback gate: production deployment is NO-GO until an
  authorized read-only inspection establishes the enabled-rule set; production
  must never be assumed to have zero enabled rules. If enabled rules exist, a
  separately approved rule-quiescence procedure must complete before the retiring
  release is deployed. An older release can restart its recurrence worker and
  process stored enabled rules on its next tick, so rollback to such a release is
  equally gated.
- Residual unknown: an enabled legacy rule that survives deployment stays dormant
  (no writer exists in this release) but keeps permanent delete blocked for that
  staff member until quiescence.
- No generic scheduler, replacement background worker, feature flag or
  compatibility fallback is introduced by this retirement.

## SOF-2 Weekly Report ownership and resolution — 2026-10-22

**Status: Accepted.** Product-owner approval of the SOF-2 RFC and PG17 evidence.
This amends Weekly Report V1 Slice 1/2 assignment policy and clarifies Slice 4
history access; scope and rollout are explicit.

- WeeklyReport is bound to its original reporting Staff. Management PATCH and
  offboarding cannot change that report's root assignee to another Staff.
  Unfinished reports linked through either assignee or report owner block
  offboarding pending explicit authorized resolution. Missing/inconsistent
  ownership fails closed; no historical repair is authorized.
- Draft, immutable submissions/PDF content and personnel attribution stay with
  the original report. A replacement Staff receives only an independent report
  through existing creation; new explicitly entered instructions/questions are
  allowed, former content/history is not copied.
- Same-organization authorized management may read inactive Staff historical
  reports through the existing history paths. This supersedes Slice 4's
  “active STAFF target” wording for historical reads only, not staff-list,
  tenant, messaging or Staff access boundaries.
- SOF-2A implements ownership containment and bounded explanatory blocker
  metadata. SOF-1 terminal-proposal priority and exact receipt replay remain.
- SOF-2B is the separately accepted follow-on policy: remove STAFF CANCEL only
  for WEEKLY_REPORT and serialize draft writes with locked lifecycle/owner
  validation. These changes are **not implemented by SOF-2A**. Current generic
  cancellation and every other JobCard type remain unchanged in this slice.
- SOF-2C owns the full actionable resolution journey. OF-02 is not CLOSED until
  all three slices and their closure gates pass. No migration, CRM4B, generic
  lifecycle framework or follow-up resolution command is authorized here.

Contract: [SOF-2 ownership](docs/features/staff-offboarding-weekly-report-ownership.md).


## SOF-2B Weekly Report atomic draft and manager-only cancellation — 2026-10-23

**Status: Accepted.** Implements the separately accepted SOF-2B policy above;
this explicitly supersedes its deferred implementation status, not SOF-2A's
ownership or SOF-1's terminal-proposal rules.

- Draft replacement uses one existing JobCard repository transaction: User
  `FOR SHARE` -> JobCard `FOR UPDATE` -> WeeklyReport `FOR UPDATE`. Current
  tenant/active STAFF role, root assignee, original report owner, editable
  status and report `expectedVersion` are validated under these locks. The
  draft UPDATE uses the same client; no lifecycle activity or receipt is made.
- `FOR SHARE` fences user role/deactivation writes while remaining compatible
  with lifecycle note-author SHARE locks. Weekly manual reminders acquire the
  same target snapshot before the root and do not upgrade it beneath that lock;
  non-weekly reminder behavior is unchanged.
- Standalone `PostgresWeeklyReportRepository.updateDraft` and pool-level JobCard
  draft UPDATE are removed. Draft SQL belongs only to the request transaction;
  the old Pool-capable shared update helper is no longer exported.
- STAFF has no new WEEKLY_REPORT CANCEL command in any unfinished status.
  Canonical capabilities, reservation preflight and locked finalize share this
  rule. MANAGER/ADMIN reasoned cancellation and other JobCard types retain their
  existing policy. Exact completed historical scoped receipts still replay;
  this does not grant permission for a new Staff cancellation.
- Frozen submission identities/content, PDF models, historical attribution,
  original Staff/week uniqueness and independent replacement creation remain.
  SOF-2C and closure verification are still required; OF-02 remains open.

Contract and verification boundaries: [SOF-2 ownership](docs/features/staff-offboarding-weekly-report-ownership.md).

## Weekly Report PDF missing-glyph metrics — 2026-10-24

Status: Accepted defect correction. Fixes a server-side rendering defect found by
the WR-PDF-1 diagnosis; no business rule, workflow or stored data changes.

Every code point the embedded Roboto font cannot render is drawn as glyph id 0
(`.notdef`, the empty box). PDFKit (0.19.1 and still 0.20.2) seeds the CIDFont
width array with the raw font-unit advance for id 0 while scaling every other
entry into 1000-unit glyph space, so the produced `/W[0]` was `908` where the
true advance is `443.359` — `.notdef` painted 2.048x too wide. pdfmake measures
with fontkit, so the reserved width was correct and the painted width was not;
a table cell holding enough missing glyphs painted across its right border and
over the next column.

- The correction rewrites only entry 0 of each embedded font's `/W` array, at
  render time, before the document is serialised. Advances for supported glyphs
  are never touched; Turkish text and normal typography keep their metrics.
- No dependency, lockfile or `node_modules` change. The release artifact is built
  with `npm ci --omit=dev`, so an install-time dependency patch would not survive;
  the correction is applied to the in-flight document instead.
- Font embedding, offline rendering and the closed URL/local access policies are
  unchanged. No network font loading is introduced.
- **Glyph coverage is not fixed and is not claimed to be.** Scripts Roboto lacks
  (emoji, CJK, Arabic, arrows, check marks) still render as `.notdef` boxes. They
  are now drawn at the width reserved for them instead of nearly twice that
  width. Rendering genuine glyphs for those scripts remains a separate decision.
- Source-work table column widths are unchanged from WR-02
  (`[164.28, 65, 80, 65, 85]`); the pre-WR-02 `auto` overflow is already fixed on
  `main` and this record adds regression protection only.
- Frozen submissions, PDF document-model identity and attribution, submission
  history, manual create/bulk, SOF-2A/SOF-2B ownership and cancellation,
  offboarding, recurrence retirement and reporting integration are unchanged.
- Verification uses painted PDF geometry, not pdfmake's layout boxes: the
  previous tests compared reserved widths only and could not see this defect.

## OPS-TT-001 — Infrastructure-owned synchronized time and boot-bound authority

- **Date:** 2026-10-26
- **Status:** Owner-authorized intent for Issue #369 TT-A; isolated infrastructure and implementation acceptance remain mandatory. Production NO-GO.
- **Scope:** Approval security only. A3 backup producer/reader remediation is deferred.

The operating system owns continuous UTC synchronization. The application reads
bounded synchronization-health evidence and persisted Linux BOOTTIME intervals;
it does not set the clock, run a time daemon, or write periodic clock rows to
PostgreSQL. Approval TTL (maximum 24 hours), the 3,600-second admission window,
consumed-attempt scopes and existing start/backup/migration/rollback budgets stay
unchanged. UTC labels, NTP flags and file timestamps alone cannot authorize work.

Choose **chrony as the sole synchronization service** for the proposed host
contract, with `time.ume.tubitak.gov.tr` (UTC(UME)) and the independently operated
`time.cloudflare.com` using NTS. UME's public NTP is not assumed authenticated.
Require both sources selectable and agreeing; loss/disagreement is UNKNOWN for
new authority, not a reason to accept a single unverified source. The isolated
configuration requires the authenticated source and does not disable NTS
certificate-time checks. No production NTP configuration change is authorized.

Health evidence must bound reference age, root distance and remaining system
correction, identify both configured sources, and verify chrony active with
systemd-timesyncd inactive. A synchronization-health threshold is a denial
threshold, never extra approval lifetime or a wall-clock rollback tolerance.
The proposed bounds are three maximum 256-second polls of reference age,
1-second root distance, and 100ms remaining correction. Their isolated behavior
and availability costs must be reported before release acceptance.

A newly issued grant binds actual host boot/namespace/time evidence. Restart
cannot re-anchor it; an unconsumed grant cannot cross reboot. A provable v2
consumption may continue only the same bounded attempt after expiry/reboot.
Unprovable legacy journals cannot be promoted. Durable initialization must be
bracketed by pre-publication and post-fsync samples, with a separately fsynced
hash-bound admission confirmation before owner publication or business effects.
Missing confirmation can finish only in the original same-boot admission
window after existing zero-progress/OLD EXACT checks; otherwise it stays denied.

Infrastructure availability is not assumed: UME reachability, independent-source
agreement, failure/recovery, process restart and actual amd64 reboot need isolated
evidence. Two disagreeing sources cannot establish which one is correct; fail
closed. This contract does not claim defense against compromised root/kernel,
whole-VM snapshot rollback or arbitrary hardware clock-rate manipulation.

Primary references: [UME](https://www.ume.tubitak.gov.tr/fizik-grubu-laboratuvarlari/zaman-frekans-ve-dalgaboyu-laboratuvari/),
[Cloudflare Time](https://www.cloudflare.com/time/),
[chrony configuration](https://chrony-project.org/doc/4.5/chrony.conf.html),
[chronyc monitoring](https://chrony-project.org/doc/4.5/chronyc.html).


## OPS-TT-002 — Host backup event time and observation v2 (TT-B)

- **Date:** 2026-10-27
- **Status:** Owner-authorized implementation scope for Issue #369 TT-B. Release acceptance and production activation remain separate. Production NO-GO.
- **Scope:** A3 host-observation only; additive extension to OPS-004 and OPS-TT-001. TT-A approval/admission behavior and the disabled BR5 provider are unchanged.

Use the existing TT-A synchronized Linux BOOTTIME primitive at backup start and
after actual artifact/sidecar verification. Persist both original samples,
attempt identity and both SHA-256 digests in strict observation schema 2 at the
existing SSOT pathname. The reader never creates an event anchor. Local and
scheduled verification proofs are independent; manual/predeploy/postdeploy
backups cannot refresh the established scheduled baseline.

The 26-hour inclusive boundary remains unchanged. A conservative upper age of
at most 26 hours plus consistent UTC permits healthy; a proven lower age over
26 hours is stale. Conflicting, missing, unsupported or cross-boot evidence is
UNKNOWN/public unavailable. Latest failure keeps its existing priority.
Consumers use the backend decision and cannot recalculate UTC age to promote it.

V1 remains history only: preserve its exact bytes and established scheduled
baseline when the writer migrates it, never manufacture current-boot evidence.
Reboot requires a new backup event for local freshness, and a new scheduled event
for an established scheduled baseline. Restore integrity and root sealed-backup
adoption do not renew freshness. Old readers cannot consume v2, so a release
rollback requires separate compatibility review; rewriting v2 to v1 is forbidden.

No database migration, new worker/time service/native dependency, BR5 enablement,
production state mutation or long observation is authorized by this scope.
Deterministic 26h transitions and the existing Local CI producers verify code;
synthetic boot/timer evidence must remain distinguished from live host acceptance.


### OPS-TT-002 security follow-up — PR #394 (2026-10-27)

Owner-authorized remediation isolates HTTP trusted-time sampling from Fastify's
event loop in one bounded, request-scoped child with a 3s whole-sample deadline,
16KiB stdout cap and process-group shutdown cleanup. Busy/failed sampling is
unavailable; there is no queued sampling or reused healthy cache. Both public
health routes share a 60/minute per-IP limit under the existing proxy policy.
The TT-A root sampler, time-quality thresholds, event proofs, 26h inclusive rule,
observation v2 migration and R4 seal/runtime contracts are unchanged.

Host alerting must explicitly configure
`SERVORA_ALERT_BACKUP_SOURCE=host-observation`. Failed/missing/malformed health
cannot change this source or recover a backup alarm through a UTC directory scan.
Legacy and verified-runs remain separately declared sources. Production activation,
configuration changes and deployment remain outside this remediation.

## OPS-R4-001 — One adopted installed OLD for the Issue #369 first cutover

- **Date:** 2026-10-28
- **Status:** Owner-authorized implementation; production installation, issuance,
  migration and deployment each remain separately gated. Production NO-GO.
- **Scope:** A narrow exception to the retained original OLD archive prerequisite
  in the R4 runbook; grants, journal formats, trusted time, backup freshness and
  activation/abort budgets are unchanged.

The original upload bytes for OLD `71ae6df6dd0659ed6390a6785d4bab29ddf5b1fa`
were not located. Preserve its original artifact marker and grant digest
`6f9dbb6a211813fd0d6d5e92396b71045d506eb959cd98d883e257663af79672`.
A newly captured installed-release archive has a distinct identity and must never
be labelled the original artifact or treated as restored-system acceptance.

One permanent root-private `installed-old-adoption.json` may bind an independently
verified recovery baseline to one exact grant digest/UUID, root profile, machine,
database, original 055 SQL catalog, installed content manifest and TARGET
SHA/tree/artifact. An administrator-only CLI, absent from deploy sudoers, shares
the stable host kernel lock with deployment. The API requires that same inherited
inode/descriptor, so an unlocked direct call cannot race admission. Exclusive
publication prevents replacement; partial state is denied and never repaired.

The exception applies only when the original retained OLD archive is absent.
Corrupt retained archives cannot fall back. Every baseline payload must hash
correctly; the adopted archive must contain exactly the installed entry set and
pass real byte/type/metadata comparison; its dump must list and contain the exact
OLD ledger. Original grant time, consumption proofs and operation scopes still
apply. Subsequent releases require their own ordinary retained artifacts.

See [the first-cutover design](ISSUE369_FIRST_CUTOVER_R4_DESIGN.md) and
[the administrator contract](docs/operations/r4-forward-recovery.md#issue-369-first-cutover-administrator-attestation).
The explicitly authorized plaintext manual Mac recovery copy does not change
OPS-003 or enable BR5. No production issuance is authorized by this decision.


## OPS-TT-003 — Authenticated two-of-three NTS quorum and versioned time evidence

- **Date:** 2026-10-30
- **Status:** Owner-authorized policy and source implementation scope for Issue #369. Source review, exact-head CI, new artifact and isolated host acceptance remain gates. No production change authorization; Production NO-GO.
- **Supersedes:** OPS-TT-001's fixed UME/Cloudflare pair, requirement that both configured sources be selectable, and the corresponding two-source live evidence contract. OPS-TT-002's nested time evidence uses this version boundary; its observation schema, event identity, 26-hour rule and scheduled/manual separation remain unchanged.

Chrony remains the sole continuous synchronization daemon. Policy `nts-quorum-v1`
is closed in source: Cloudflare `time.cloudflare.com`, BEV Austria
`bevtime1.metrologie.at`, and Canonical `1.ntp.ubuntu.com` are three independent
operators, not three addresses from one operator. UME `time.ume.tubitak.gov.tr`
is unauthenticated **monitor-only**, explicitly `noselect`, and never a quorum
vote. Require at least two authenticated, recently selectable NTS operators,
exactly one selected reference matching tracking, and agreement with the selected
source. A third unavailable source is not a veto when the other two satisfy all
checks. A single vote, foreign/duplicate/ambiguous identity, falseticker (`x`),
trusted-source disagreement (`T`), excessive jitter (`~`), or malformed evidence
denies authority. No reachable-all-three condition may contradict this rule.

The chosen configuration is `authselectmode require`, `minsources 2`,
`maxdistance 1`, `makestep 0.1 3`. **No explicit NTS `trust` or `require` flags.**
Chrony 4.5 `require` authentication mode implicitly excludes unauthenticated
sources; unlike `mix`, it does not inject `trust/require` into NTS selection.
Expected NTS COpts/EOpts are `-----`/`-----`; explicit monitor UME has
`N----`/`N----`. The retained candidate-b experiment had UME configured without
explicit `noselect`, hence `-----`/`N----`: explicit `noselect` is a deliberate
restriction, verified separately rather than called byte-identical evidence.
The previous safe-change draft's explicit NTS `trust require` is not the tested
candidate and is superseded by this decision. NTS certificate and certificate-time
checks remain enabled; no `nocerttimecheck`, custom trust bypass or weaker thresholds.

Source/selection names alone and NTS-KE cookie counts are insufficient. A voting
source must have NTS mode in `authdata`, allowed configured/effective options in
`selectdata`, and a valid authenticated NTP response in `ntpdata`. The numeric
packet address is bound to Chrony's original configured `sourcename`, never
reverse DNS or a fresh hostname lookup. Bounded read failures deny. The exact
reviewed config bytes/hash and closed source policy must match; runtime source
or selection changes during collection deny the sample. Reference age <=768s,
root distance <=1000ms, and absolute correction <=100ms remain unchanged, as do
Linux BOOTTIME, boot-ID, zero-offset time namespace and UTC veto checks.

### Persisted evidence, authority and historical replay

Time evidence **format 2** adds `sourcePolicy`, `configSha256`, configured voting
count 3, actual selectable/authenticated voting count (2 or 3), sorted unique
selectable NTS names and selected name. `sourceCount` is the actual policy-eligible selectable
voting count, excluding UME. A nonselected source with zero reach or a sample
older than 768s cannot vote even if sources temporarily retains a minus/plus
flag; selected-source loss or any x/T/~ state still denies the whole sample. `authenticatedSourceCount` counts those voting
sources, not cached cookies or unavailable operators. Existing approval/journal
format 2 and backup observation schema 2 are separate outer versions and do not
change merely because their nested time evidence version changes.

`validateTimeEvidence()` is a **structural/historical** validator: exact legacy
time format 1 keeps its original fixed `sourceCount=2` semantics. It is not new
NTS quorum proof. `validateCurrentTimeEvidence()` requires time format 2 for
issuance, unconsumed grant admission, current recovery transitions, HTTP sampler
results and new backup event samples. Legacy unconsumed grants, incomplete old
admission markers and mixed-policy admission intervals cannot create authority.
No old record is rewritten, converted, re-signed, re-sealed or given new lifetime.

Only historical replay of a previously sealed, fully confirmed same-attempt
consumption may use the private historical initial-record reconstruction. It
checks the exact original grant, initial hash and post-fsync proof in the original
boot/window. It cannot mint a new confirmation through the public publisher.
Continuation still requires the protected proof/ownership chain, fresh format-2
infrastructure evidence and the original scope/start/abort/migration budgets.
Expiry or reboot never resets budgets. An unconsumed grant still cannot cross
reboot. Existing root profile/module/config hash contracts are not bypassed: a
profile mismatch remains STOP and needs an independently reviewed transition.

Legacy nested backup proofs remain parseable historical records. They cannot
produce healthy freshness against format-2 current time; mixed versions are
UNKNOWN for positive elapsed-time authorization. Same-boot lower BOOTTIME bounds
may still prove staleness only. New backups need new format-2 event samples;
scheduled freshness still requires a real scheduled event. Existing journal,
grant, receipt and observation bytes are preserved, never retroactively upgraded.

### Privilege and acceptance boundary

Chrony 4.5 restricts `authdata`, `selectdata` and `ntpdata` to its privileged Unix
socket. Granting that socket (or a general sudo chronyc command) to app/backup
UIDs would also permit daemon mutations and is **not authorized**. Current source
fails closed if those reads are unavailable. A separately reviewed bounded
read-only access design is required before app/backup sandbox host acceptance;
this decision does not invent a root broker, shared cache, daemon, socket ACL
exception or additional deployment privilege. Root-only parsing success is not
app UID acceptance. The HTTP 3s whole-child deadline and 16KiB cap remain unchanged.

OPS-TT-001's 24h maximum grant TTL, 3600s admission window, reboot denial,
consumed same-attempt rules, fsync proof requirements, all budgets and 1800s
release observation remain unchanged. OPS-TT-002 failure priority, event proofs,
scheduled baseline separation and legacy observation byte retention remain.
Trust boundaries against compromised root/kernel/hypervisor are unchanged.

The old `67afe5a` CI/artifact remains historical evidence for that source only.
This implementation requires its own source SHA/tree, exact-head full CI, new
Linux artifact and source-bound host/reboot/sandbox/failure acceptance. None
licenses production config/service/clock changes, B3 bootstrap, issuance,
migration, restore or deployment. Issue #369 remains OPEN; PRODUCTION_GO=false.

Primary sources: [Chrony 4.5 authselectmode](https://chrony-project.org/doc/4.5/chrony.conf.html#authselectmode),
[selectdata](https://chrony-project.org/doc/4.5/chronyc.html#selectdata),
[ntpdata](https://chrony-project.org/doc/4.5/chronyc.html#ntpdata),
[4.5 command permissions](https://github.com/mlichvar/chrony/blob/4.5/cmdmon.c),
[4.5 original-name and report implementation](https://github.com/mlichvar/chrony/blob/4.5/client.c).

### Issue369 restricted evidence reader implementation amendment

The previously open read-access boundary above is addressed in this owner-authorized
source/test scope by [the restricted evidence reader](docs/operations/restricted-chrony-evidence.md).
A root-owned systemd socket starts a bounded fixed collector as the existing
Chrony UID with empty capabilities. The app/backup UID receives sanitized
request-bound TimeEvidence2, never Chrony control access, general sudo, a command
RPC, cached authority or a new issuer. The read-only transport accepts only an
internally generated nonce. No additional long-lived privileged daemon or timer
snapshot is introduced. Exact installation/effective unit contracts, new-source
CI/artifact and isolated UID/sandbox/reboot/continuation acceptance remain gates.
This amendment does not authorize production connection, config/service/clock
change, root issuance, deployment, migration, restore or backup trigger.

### Issue369 forward-only collector path amendment (2026-11-01)

Owner-authorized **source and targeted-test scope only** extends the restricted
reader to one additional fixed installed path:
`/usr/local/libexec/servora-med-forward/trusted-time.mjs`. It uses the existing
root:root 0644, single-link and protected-ancestor contract. Arbitrary
caller-selected paths/endpoints remain forbidden. The release-path contract
remains root:servora-med 0650 under its existing 0750 directories.

The forward adapter must not overwrite the sealed R4 installed module/profile.
Its manifested collector bytes must equal the exact TARGET module bytes. A
separate, exact template drop-in selects the new path only under a durable
collector intent within `ACTIVATE_INTENT`, with the admitted owner, current DB060
proof and stopped OLD. TARGET start requires that collector result and effective
unit/module/socket verification. Base units, `_chrony` UID, empty capabilities,
sandbox, nonce protocol, source policy, quality, deadlines and evidence formats
remain unchanged. Client/collector module hashes still match exactly.

The collector selection remains after accepted forward handback; old R4 files
remain read-only history. Unknown/foreign selection, interrupted publication and
module/socket drift fail closed; no weaker proof or old-collector fallback is
authorized. Issuance, installation and production changes remain separately
gated. This is not genuine NTS/1800-second acceptance or PRODUCTION_GO.

### Issue369 failed forward observation recovery (2026-11-02)

Owner-authorized source implementation and disposable targeted tests introduce
the [separate failure-recovery contract](docs/operations/forward-only-failure-recovery.md).
The deployment grant never authorizes its own failed-observation unfencing.
An exact snapshot/journal/tool/original-grant-bound, one-use root recovery grant
may restore normal policy for the same healthy TARGET, or close the attempt
fenced without starting/rolling back a release. Explicit `onFailure=CLOSE_FENCED`
may only narrow that separate recovery authority if restoration loses its
healthy process. Unknown processes are not automatically stopped or restarted.
Recovery has its own durable intents, journal, sealed NOT_ACCEPTED outcome and
owner custody/retirement rules; original deployment slots and history stay
unchanged. Any recovery intent revokes even an armed deployment start permit.

Backup503 and Trusted Time UNKNOWN remain failed/unknown. They cannot create
release acceptance or observation time. R4/emergency sealed history, TT-A
thresholds, exact060/migration-free rules and independent release evidence are
unchanged. No production issuer, installation, start, restart, stop, deployment,
clock/config change or release authorization is granted. Production NO-GO.

Before STOP_INTENT only, a separate `RELEASE_UNCHANGED_OLD` recovery grant may
seal failure and retire the failed attempt owner while the exact healthy OLD,
pointer/environment and existing on-failure policy remain unchanged. It cannot
undo a cutover or authorize any service operation. This also covers predeploy
backup failure without stranding the protected OLD behind an active owner.
