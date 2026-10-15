> See [the PR1 contract and handoff](README.md) for implementation status. Approved for PR1 implementation on 2026-10-14. The user confirmed IN_PROGRESS sources, four engagement kinds, BUSINESS records, optional sale contact, NEW/ACCEPTED creation and the terminal-slot policy. Original discovery documents remain untouched. PR2–PR4 behavior is a design target, not shipped behavior. Evidence references below describe the original discovery bundle.

# Visit-to-Sale — Small-PR Implementation Plan

Date: 2026-10-14 (Europe/Istanbul)
Reviewed main: `daf5a59692803f9e5acbbef431d12cc32e1c02e3`
Discovery status: `VISIT_SALE_AND_PRODUCT_UX_DESIGN_READY`
Implementation status: NOT_STARTED for all PRs below.

Bu planın tamamlanan işi source discovery/design'dır. Uygulama, migration, GitHub write ve deploy bu görevde yapılmadı. [Design](visit-to-sale-design.md) ürün önerilerini; [data-lifecycle](visit-to-sale-data-lifecycle.md) transaction/SQL sözleşmesini; [UI plan](product-selection-ui-standardization-plan.md) ortak seçim sözleşmesini tanımlar.

## SALE-QTY-001 update — accepted 2026-10-15

The original decimal Sale expectation is superseded. Before PR3, additive 058
enforces integer counts 1–999999999; 057 remains byte-identical. Public quantities
are integer strings; private v1 hashes/audits retain three-scale normalization.
PR3 defaults to 1, uses min=1, step=1, inputMode=numeric and rejects fractions for
create, add and correction, without conversion or rounding. A Sale-specific
adapter may configure the existing ProductSelect in PR3; its Delivery fractional
behavior and catalog forms remain unchanged. This task does not open write routes.

## 1. Uygulama öncesi sabitlenecek kararlar

Kabul edilmiş kararlar: ayrı SALE JobCard, dedicated SALE_FROM_VISIT origin, bağımsız approval, en fazla bir aktif satış, ProductSelect reuse, CRM/catalog yetkilerinin korunması. Aktif küme mevcut JobCard constants ile aynıdır.

Yeni önerilerin uygulama brief'inde görünür şekilde kabul edilmesi gerekir: source yalnız IN_PROGRESS; dört eligible engagement kind; BUSINESS-only başlangıç; optional sale contact; NEW/ACCEPTED create semantics; terminal history sonrası source uygunsa yeni sale. Yeni gerekçe yoksa bu paketteki öneri kullanılır; alternatif davranış sessizce uygulanmaz. Tasarımın hazır olması, bütün yeni önerilerin kullanıcı tarafından onaylandığı iddiası değildir.

Her implementation PR'ı güncel GitHub/main drift ve repository migration-catalog kontrolüyle yeni isolated branch/worktree'de başlar. Dirty checkout, beş stash, R4 entegrasyonu, ilgisiz worktree'ler ve `68d9e4f` adayı korunur. Issue #369 ve production R4 ayrı kalır.

## 2. Sıra ve güvenli açılma

```text
PR 1: Sale domain / PostgreSQL / atomic service
  → PR 2: Sale-aware JobCard readers / CRM / meeting origin / consumer contracts
    → PR 3: Public write routes / Sale create and correction UI / ProductSelect reuse
      → PR 4: Existing product surface UI parity
```

PR1/PR2 sonunda production UI üzerinden SALE oluşturma açılmaz. Public write routes PR3'te bütün okuyucular ve create/detail/edit akışı hazırken register edilir. Yeni configuration/feature-flag sistemi gerekmez; route wiring açık bir açılma sınırıdır. Generic JOB_CREATE veya follow-up allowlist'i SALE kabul etmez. Her PR doğru, build edilebilir ve regresyon testli bir dilimdir; read/write exposure sırası bilinçlidir.

## 3. PR 1 — Sale domain/backend and PostgreSQL contract

Suggested title: `feat(job-cards): add transactional sale domain from visits`

**Amaç:** Sale root, ayrı origin, subtype details/items, history snapshots ve one-active invariant tek transactional domain davranışı olarak doğrulanabilir. Public create endpoint henüz register edilmez.

**Scope ve dosya haritası:**

- Yeni migration: job_cards type CHECK + sale_source_visit_id/FK/check/read indexes/partial unique; sale details/items; sale activity vocabulary. Numara current head yeniden okunarak seçilir; bu pakette varsayılan numara yoktur.
- `server/src/modules/job-cards/types.ts`, focused `sale-input.ts` / `sale-policy.ts` / gerekirse `sale-types.ts`: concrete subtype DTO/input/eligibility/readiness; generic framework oluşturulmaz.
- `service.ts` ve `repository.ts`: existing critical receipt/hash ile atomic create, source/user/reference locks, item/details corrections, quantity integer validation (SALE-QTY-001 supersedes the original decimal policy) ve sale snapshots. Büyük dosyalar unrelated refactor edilmez.
- `critical-action-request-hash.ts`, `submission-policy.ts`, `policy.ts`: explicit sale branches, immutable review, safe generic PATCH restrictions, no sale follow-up payload. Existing migration-049 lifecycle intent korunur.
- `products/repository.ts`/service operation-history ve `crm/repository.ts` contact history projections: new refs korunur; FK error mapping uygun domain conflict verir. BUSINESS-only önerisi kabul edilirse canonical Products read query optional data-class filter alır; default catalog query korunur. Delete/write API izinleri genişlemez.
- Sale başlangıç assignment history mevcut CREATE source'u ile kaydedilir. Yeni history enum veya clock altyapısı gerekmez; sale origin dedicated field/event'te zaten vardır.

**Yetki sınırı:** Assigned STAFF own active source; MANAGER/ADMIN same-org; first assignee server source'tan. Normal CRM/contact/catalog mutation yok. Public generic route direct SALE create reddeder. SoldAt, source version, user active state ve references backend'de doğrulanır.

**Migration:** Evet, additive new migration. Applied history değişmez. Existing types/statuses/check event values eksiksiz korunur. Clean migration + head upgrade + no-reapply + exact schema head + FK/partial index SQL assertions gerekir. Eski data'yı SALE olarak backfill etme. Repository katalog head 056'dır; uygulamadan önce yeniden doğrula. Deploy/rollback script veya production recovery değiştirilmez.

**Test matrix (new tests; names suggested):**

| Layer | Required cases |
| --- | --- |
| Input/policy unit | Source status/type/engagement matrix; ownership/org matrix; unknown overrides; nullable distinct contacts; zero/negative/NaN/Infinity/excess-scale/overflow; 1/2/15 and fractional rejection; 1..25 create items; duplicate product IDs. |
| Service | Atomic inherited customer/assignee; NEW vs ACCEPTED; exact snapshots including brand/unit null; no visit update/delivery/follow-up; empty draft blocks submit; withdraw/revision correction; sale contact changes do not touch met contact. |
| PostgreSQL schema | All same-org composite FKs; self-link rejection; SALE-only mandatory origin; one-active partial index; duplicate products; finite/bounded quantity; historical/terminal children coexist. |
| PostgreSQL races | Two keys same source → one active sale; same key concurrent → replay/in-progress; create vs submit/cancel/source patch/reassign; rename/deactivate refs; approval/cancel vs new create; user offboarding race; deterministic lock order. |
| Idempotency | Same payload/key original receipt; different intent CLIENT_ACTION_REUSED; response lost after commit; receipt survives source status change; rollback leaves no rows/events; edit/remove replay and version conflicts; null hash fails closed. |
| Regression | Existing product-delivery create/submission, meeting met-contact, auth boundaries, lifecycle intents, contact/product delete history, offboarding and demo purge without SALE writes. |

Suggested suites: `sale-from-visit-input.test.ts`, `sale-from-visit-service.test.ts`, `sale-from-visit-schema.test.ts`, `sale-from-visit-postgres.test.ts`, `sale-items-postgres.test.ts`. Bunlar henüz oluşturulmadı/çalıştırılmadı.

**Browser acceptance criteria:**

- Existing visit and Product Delivery creation flows remain operable for STAFF and MANAGER at 390px and 1440px.
- The generic create and follow-up HTTP APIs reject direct SALE payloads; no new sale action is exposed yet.
- Product catalog and generic CRM mutations remain forbidden to STAFF.

Bu PR'da sale UI browser acceptance **N/A — not exposed**; service/SQL doğrulaması UI flow'u geçti diye sunulmaz.

**Regresyon riskleri:** Last-else meeting dispatch, incomplete DB type/event CHECK, wrong staff lock order, wrong active status definition, decimal rounding, missing product/contact history queries. Schema/root create açık API'den önce hazır olmalı.

## 4. PR 2 — Sale JobCard, CRM and meeting-origin integration

PR2 implementation checkpoint: see [read-integration.md](read-integration.md)
for the implemented read contract and the evidence-backed realtime storage
refinement. The original discovery observations below remain historical.

Suggested title: `feat(job-cards): expose sale context and scoped visit links`

**Amaç:** Sale her operasyonel okuyucuda normal, ayrı bir karttır; iki taraflı linkler ve snapshot privacy doğru projekte edilir. Create/correction UI henüz açılmaz; write registration PR3'e kalır.

**Scope ve dosya haritası:**

- `routes.ts`/`handlers.ts`: context/list/detail read endpoints; type-safe projection ve query parsing. Creation/edit service'leri PR1'den reuse.
- `repository.ts`/`history-port.ts`: sale context/details/items snapshot-consistent reads, relatedSales pagination, CRM/staff history ve concealed inaccessible links. Source child joins N+1'e dönüşmez.
- `activity-presenter.ts`: sale details/items/relation typed details. `notifications/policy.ts` existing kinds; `realtime/event-mapper.ts` distinct sale origin invalidation + item update coverage; source follow-up parametresi yeniden kullanılmaz.
- `reports/repository.ts`/types: SALE productive bucket. Existing approved work/cancelled/invalidated filter/time semantics ve WEEKLY_REPORT exemptions aynen kalır. Delivery ve meeting aggregates kendi türleriyle sınırlı kalır.
- Weekly source-work TypeScript validator/row map + frontend label/reader parity; geçmiş snapshot backfill yok. Generic messaging/note rules; SALE invoice-capable type listesine eklenmez.
- `web/src/jobs/jobs-api.ts`, `job-labels.ts`, `JobDetail.tsx`, `job-workflow-presentation.ts`, filters/search/board/list, CRM/staff/report clients ve exhaustive maps: SALE açık branch ve label. Minimal complete read-only sale detail + existing lifecycle controls; meeting fallback yok. Creation/editor controls PR3'te wire edilir.
- Frontend `follow-up-presentation.ts` ve server `follow-up-policy.ts` exhaustive maps güvenli type coverage alır; SALE için public follow-up source/target kapalı kalır. Sadece map'i total yapmak izin vermez.

**Yetki sınırı:** Parent route + every linked record same-org/current-assignee kontrolü. Sale assignee farklıysa source owner'a child ürün/ID/kişi/staff detayları verilmez. Sale sahibinin inaccessible source origin'i RESTRICTED, no source path/identity/contact snapshots. Context projection capability'dir; mutation için kalıcı izin sayılmaz.

**Migration:** Normalde hayır; PR1 şeması yeterli. Existing schema/history enum değişikliği gerektirirse PR1 contract eksikliği olarak dur ve planı güncelle; migration 056 veya başka applied SQL'e müdahale etme.

**Test matrix:**

| Layer | Required cases |
| --- | --- |
| Read repository/routes | Same-org/full/restricted/404 projections; child pagination/counts scoped; source reassigned after capture; customer changed after capture; separate planned/met/sale contacts; current source terminal does not mutate child. |
| Timeline | Exactly one source link event; safe relation projection for inaccessible child; sale item quantities/labels; no raw internal payload leak; no duplicate lifecycle event. |
| Notifications/realtime | Existing assigned/review/approve/revision/cancel kinds; no notification on replay; separate source/child invalidation audiences and no restricted IDs in resource keys; no follow-up misclassification; reassignment privacy; SSE disconnect + normal refetch. |
| Reports/Staff/CRM | Sale type visible/countable; two independent jobs counted; delivery quantities/meeting outcomes unchanged; INVALIDATED excluded; WEEKLY_REPORT exemptions retained; history uses existing ownership scope; no speculative conversion/revenue metrics. |
| Weekly snapshots | SALE accepted as productive source; immutable existing snapshots unchanged; strict server type guard + tolerant historical web label safe. |
| Frontend | Sale detail never requests meeting-details/delivery-items; explicit parse branch; correct labels/filter/board/card/approval/CRM/staff/report contracts; no general edit/follow-up button offered for Sale. |

**Browser acceptance criteria:**

- A test-fixture sale appears as “Satış kaydı” in manager jobs/board/customer history/approval queue and in its assigned staff's own history.
- Sale detail displays snapshot products, soldAt and the independent lifecycle; opening it never enters a meeting-result screen.
- Source and child links work only for reachable records; reassignment yields the documented restricted view without other-staff details.
- Submitting and reviewing a fixture sale use existing role-gated controls while the source visit status remains unchanged.
- Delivery, meeting, weekly report and follow-up pages retain their existing behavior at mobile/desktop widths.

Browser fixture seed'i disposable PostgreSQL'de private tested service üzerinden hazırlanabilir; application auth bypass edilmez. Production/test data karıştırılmaz.

**Regresyon riskleri:** Strict DTO parsers/maps, type bucket mismatch, stale linked panels, realtime lost invalidation, leaked source/child IDs, weekly snapshot compatibility ve yanlış follow-up labels. DOM-006/current SQL attribution farkı bu PR'da drive-by düzeltme değildir; mevcut metrik anlamı korunur.

## 5. PR 3 — Sale UI and ProductSelect reuse

Suggested title: `feat(web): record visit sales with the shared product selector`

**Amaç:** Kaynak ziyaretten doğrulanmış form → ayrı sale kartı → correction/submission/management approval kullanıcı akışı çalışır. Public create/edit routes, reader uyumluluğu tamamlandıktan sonra bu PR'da register edilir.

**Scope ve dosya haritası:**

- `sale-create-context` API client ve dedicated `SaleCreate` page; `paths.ts`, `AppRouter.tsx`, route-identity/route-access/context-return registries. Server-approved CREATE_SALE_FROM_VISIT action JobDetail'da wire edilir.
- Customer/source/assignee fixed; source planned/met ayrı labels; sale-contact selector active same-customer; soldAt actual local datetime; 1–25 ProductSelect entries. BUSINESS-only seçilirse ProductSelect load prop'u canonical product read query'nin BUSINESS filter'ını kullanır; uygun olmayan demo ürünler kullanıcıya eklenebilir gibi sunulmaz.
- `ProductSelect.tsx` dar selected-identity contract ve instance-safe IDs; existing catalog result load/onAdd/single-selection davranışı korunur. Concrete reason: sale edit snapshots full catalog Product değildir. Fake Product fields/referencePrice ile DTO doldurulmaz.
- Sale type-specific correction component; same ProductSelect renderQuantity. Existing rows snapshot identity; additions current catalog. New create/details/item mutations application service/client functions üzerinden; raw backend fetch component'te yok.
- Frozen create/edit attempts, scoped mutation-owner/pending ve canonical refresh/realtime reconciliation. Product/miktar state ID-keyed; 1/15; fractional input rejected. Read-only WAITING_APPROVAL/terminal branch, existing lifecycle dialogs/requirements/review adapters.

**Gelecek modül UX notu (MOD-001):** Yönetici SALE detayında “Ön Muhasebe” ve “Stok/Depo” için iki küçük, salt-okunur bilgilendirme bölümü bulunabilir; ikisi de açıkça “Gelecek sürümde” şeklinde işaretlenir. Gerçek muhasebe/stok verisi, belge durumu, finansal toplam veya miktar gösterilmez. Sahte buton, devre dışı bırakılmış işlem simülasyonu veya veri kaynağı olmayan durum göstergesi bulunmaz. Gerçek veriye dayalı alanların etkinleşmesi ilgili W0/A0 modül tasarımına bağlıdır.

**Yetki sınırı:** STAFF only assigned source/sale; source/customer/assignee overrides backend tarafından reddedilir. Catalog create veya generic contact CRUD UI action'ı yok. Optional sale contact seçimi mevcut active read endpoint'lerinden; scoped enrichment UI'si genişletilmez. Erişim değişirse safe error/restricted detail.

**Migration:** Hayır. PR1 schema kullanılır. Yeni dependency yok. ProductSelect ve existing Servora-owned adapter'lar yeterlidir; direct Ant imports/token changes yok.

**Test matrix:**

| Layer | Required cases |
| --- | --- |
| Routes/API contract | Dedicated write route exact allowlist/hash/error mapping; generic SALE create rejection; parent version snapshot parity; no customer/assignee overrides; STAFF catalog/CRM mutation denial. |
| Create form | Verified fixed context; distinct contact semantics; actual soldAt; quantity→identity→remove; bounded active search/pages; default 1; positive integers only; fractional rejection; removal/re-add/reordered selections; duplicate ID; long/null metadata. |
| Shared selector | Existing ProductSelect + DeliveryCreate suites; snapshot identity; legacy single mode; two instances unique IDs/focus; no stale search response; accessible remove/search keyboard. |
| Pending/retry | Double click → one request; all semantic controls/cancel disabled; committed response loss → identical key/version/body; contact/product/context realtime reload does not rebind frozen attempt; ACTION_IN_PROGRESS/5xx/network remain unresolved. |
| Sale edit | Parent version for each item/details operation; new item active, existing deactivated snapshot retained; quantity edit does not refresh metadata; idempotent remove; empty draft readiness; withdraw/revision/retry; terminal no controls. |
| Existing flows | DeliveryCreate pending/ambiguous retry; met-contact meeting edit; lifecycle/review dialogs; follow-up create no Sale option; route access/identity/context return; no raw Ant boundary violation. |

**Browser acceptance criteria:**

- STAFF creates a sale from their IN_PROGRESS visit with two distinct products at 1 and 15; fractional requests are rejected; the visit remains IN_PROGRESS and no delivery/follow-up row is created.
- A second independent create is blocked while any sale for the visit is active; the existing reachable sale can be opened.
- A committed create response is dropped; original retry produces exactly one sale, two correctly paired lines and one completed receipt in SQL.
- Sale follows its own START/SUBMIT/manager revision or approval path; STAFF cannot directly complete it.
- Planned contact and met contact differ in the fixture; choosing a sale contact leaves both visit fields unchanged.
- After withdrawal, quantity correction preserves original snapshot metadata; a deactivated historical product remains readable.
- A cancelled/completed sale releases the active slot; a fresh explicit sale is possible only while the visit is still eligible. Old-key retry returns the old sale.
- 320/390px, 768/1024px and 1440px layouts show quantity directly left of the matching product, full wrapping metadata and accessible remove controls without horizontal task scroll.
- Keyboard Enter searches without submitting the sale; Tab order and remove focus restore work; 200% text and 400% reflow preserve meaning.
- MANAGER/ADMIN see and review the sale; another STAFF/cross-org user cannot read or mutate it, including through links/realtime/notifications.

**Regresyon riskleri:** New key after ambiguous commit, array-index quantity pairing, shared selector DTO/ID drift, inactive product overwritten by live catalog, form source/context race, manager-created NEW acceptance flow and source action hierarchy. UI selection success tek başına PostgreSQL atomicity kanıtı değildir; SQL counts required.

## 6. PR 4 — Existing product surfaces UI parity

Suggested title: `fix(web): align operational product identity and quantity presentation`

**Amaç:** Mevcut uygun yüzeylerde shared standard'ı tamamla; yeni ürün yazma akışları ekleme. Ayrıntılı scope [UI standardization plan](product-selection-ui-standardization-plan.md) içindedir.

**Scope:** ProductSelect search duplicate result metadata + selected state birlikte görünür. Delivery JobDetail read-only quantity/unit identity'nin hemen solunda; name/SKU/model/unit stored snapshots'tan aynı grupta görünür. Purpose ve actual-time controls kalır. Sale common selectors/read-only rows regression. ProductForm/catalog list ve Reports tabloları quantity editor'a dönüştürülmez. Instance-ID değişikliği PR3'te tamamlandıysa tekrar iş yapılmaz.

**Yetki sınırı:** Aynı existing allowed actions. Delivery quantity/product add/remove endpoint'leri UI'ye açılmaz. JobDetail actual-time edit policy/version akışı aynı kalır; STAFF katalog/CRM yetkisi değişmez.

**Migration:** Hayır. Eski delivery snapshot'ında brand yok; canlı catalog brand'i gösterme veya historical brand backfill yok. Strict brand-history ihtiyacı ayrı producer/schema kararı gerektirir, bu UI PR'ına gizlice eklenmez.

**Test matrix:**

| Layer | Required cases |
| --- | --- |
| Shared UI | Duplicate search result retains full metadata + Eklendi; ID/focus; quantity pairing; Delivery fractions and Sale integer counts; long/null metadata; search error/pagination; single mode unchanged. |
| Delivery detail | Multiple siblings retain correct snapshot/model/unit/purpose; read-only quantity left of identity; nullable unit/no invented fallback; actual-time editor only allowed statuses; terminal immutable. |
| Mutation regression | Actual-time expectedVersion conflict + truth refresh; DeliveryCreate exact frozen retries; SaleCreate/edit frozen retries; no new delivery add/remove/quantity calls. |
| Accessibility/layout | Semantic labels/44px targets; 320/390/768/1024/1440; 200%/400% reflow; no clipping; keyboard/focus. |

**Browser acceptance criteria:**

- DeliveryCreate and SaleCreate present the same selection order and quantity/product pairing at mobile and desktop widths.
- Existing delivery detail uses historical metadata, shows quantity immediately before the matching product and preserves actual-time editing.
- Searching an already selected product still exposes SKU/brand/model/unit with its selected state.
- Catalog create/edit remains a catalog form without a quantity field; report tables remain read-only.
- Pending and ambiguous attempts preserve exact requests, disabled controls and accessible status/error feedback.

**Regresyon riskleri:** CSS selectors affecting actual-time form, long-name reflow, old unit semantics, unnecessary new component extraction. “Brand missing” gerçek history limitation'dır; CSS ile çözülemez.

## 7. Ortak verification gate

Implementation PR'larında AGENTS.md minimumları:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
cd web && npm test -- --run
```

Server suite öncesi explicit password-bearing loopback `TEST_DATABASE_URL`, branch'e özel `servora_med_test_<suffix>` database ve PostgreSQL 17 server + psql/pg_dump/pg_restore gerekir. Build öncesi dist yoksa preflight contract çalışmaz. Read-only preflight exact repository migration head ister; migration suite öncesi disposable DB'de açıkça uygulanır, test preflight'ın migrate ettiği varsayılmaz. Secret URL loglanmaz. Başka worktree'nin persistent test DB'si kullanılmaz.

Targeted suites → required full suites/builds; UI PR'larında existing bundle:check / Ant-boundary / responsive smoke ilgili kapsamla çalıştırılır. `server` ve `web` package scripts'te lint komutu yok; `npm run lint` hayali mandatory PASS olarak listelenmez. Exact-head local CI gerekiyorsa mevcut local-first contract uygulanır; GitHub Actions tetiklenmez. Environment-dependent checks çalışamazsa SKIPPED/NOT_RUN açıkça yazılır.

Browser acceptance disposable local Vite + Fastify + PostgreSQL 17'de gerçek STAFF/MANAGER/ADMIN session'ları ve synthetic BUSINESS records ile yapılır. Chromium ve WebKit, mobile/desktop ve manual keyboard/reflow test edilir. Production smoke/deploy/recovery bu feature planının parçası değildir. Her implementation PR sonuçları, source SHA ve migration head'i kendi evidence paketinde kaydeder.

## 8. Açıkça deferred işler

| İş | Neden / açılma koşulu |
| --- | --- |
| Follow-up PRODUCT_DELIVERY initial items + JobDetail product/quantity CRUD UI | P06/P07 inventory functional gap; UI parity değildir. Ayrı atomic/idempotent functional slice gerekir. |
| Historical delivery brand snapshot standardı | Mevcut producer/DB field yok; canlı katalog ile uydurulmaz. Yeni schema kararı olmadan strict parity iddiası yok. |
| DEMO Sale generator/purge | İlk BUSINESS-only önerisi; destek istenirse ownership/purge integrity birlikte tasarlanmalı. |
| Sale financial/stock/invoice/payment flow ve sale→delivery automation | Kullanıcı tarafından onaylanmış scope değil. |
| Sale conversion/revenue/quantity reporting | İlk slice operational type/history/approval görünürlüğünü tamamlar; ticari metric sözleşmesi ayrı. |
| Completed sale edit/reopen/financial adjustment | Terminal immutable + mevcut ADMIN invalidation; yeni reversal yok. |

## 9. Önerilen ilk implementation slice

**PR1 ile başla:** dedicated sale origin + one-active partial unique + details/items snapshot + `createSaleFromVisit` private atomic service ve PostgreSQL race/retry testleri. Mevcut lifecycle için explicit Sale readiness'i aynı PR'da güvenceye al. Generic create/follow-up hiçbir SALE yazma yolu açmasın.

First-slice acceptance criteria:

- Two concurrent distinct create intents for one eligible visit commit exactly one active sale.
- A response-loss retry returns the original sale with correct 1/15 line associations and no duplicate audit events.
- A sale carries immutable origin and product snapshots while the visit, delivery and follow-up state stay unchanged.
- Staff cannot create for another staff member or bypass manager approval.
- Fresh and upgraded disposable PostgreSQL schemas reach the verified new catalog head without editing applied migrations.

Bu slice sonraki UI'nin güvenilir temelini oluşturur; ProductSelect'in tamamlanmış görsel davranışı PR3'te yeniden geliştirilmeden kullanılır.
