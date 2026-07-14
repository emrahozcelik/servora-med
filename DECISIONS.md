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
- **Status:** Accepted
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
- **Status:** Accepted
- **Scope:** JobCard activity timeline

### Context

The earlier documents mixed a generic `status_changed` event with specific lifecycle events, leaving duplicate activity behavior ambiguous.

### Decision

Canonical events are:

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
