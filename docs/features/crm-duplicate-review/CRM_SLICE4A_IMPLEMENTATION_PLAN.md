# CRM Slice 4A — Implementation Plan

**Durum:** Tasarım `CRM_SLICE4A_DESIGN_ACCEPTED_FOR_IMPLEMENTATION`; plan yürütülmedi. Bu documentation-only görev kod çalışmasını başlatmaz.  
**Önkoşul:** Kullanıcının koşullu kabulü final teknik uzlaştırmayla tamamlandı. PR1 ayrı implementation görevi ve IP-1/IP-7 kapılarıyla başlatılır. D1–D6 yeniden ürün keşfine açılmaz.

Domain SSOT: [Design](CRM_SLICE4A_DESIGN.md). Ayrıntılar [API](CRM_SLICE4A_API_CONTRACT.md), [Data Model](CRM_SLICE4A_DATA_MODEL.md), [Test Matrix](CRM_SLICE4A_TEST_MATRIX.md).

## IP-1 — Entry checks

1. Canonical checkout, beş stash, 49 worktree ve ignored/private dosyalar korunur. Uygulama için izinli ayrı checkout/worktree gerekir; mevcut koruma/initializing kayıtları temizlenmez.
2. Uygulama baseline SHA/tree, güncel main ve migration catalog yeniden doğrulanır. Bu paketin başlangıç catalog'u 058'dir; **gelecek migration numarası rezerve değildir**. İlgisiz worktree içeriklerini taramak veya sıfırlamak gerekmez.
3. T1–T5 final kararları SD-8'de kapalıdır; SD-10 adversarial sonuçları ve zorunlu testler esas alınır. P1 runtime doğrulamaları ilgili PR'a aittir; tasarım kabulü PASS kanıtı değildir. 4B/WR-01/#369 kapsamı açılmaz.
4. D1–D6 ve kabul edilen teknik tasarım owning docs/features ve DECISIONS.md'ye yalnız ayrı implementation görevi kapsamında kaydedilir. Doküman “shipped” değil “accepted design / rollout pending” der.
5. Synthetic PostgreSQL17 ortamı ve açık isolated TEST_DATABASE_URL hazırlanır; build-before-test ve schema head preflight uygulanır.
6. HMAC custody sahibi SD-4.4'te repository/production sahibi, responsible operator onun yetkilendirdiği deployment/backup işletmecisidir; devir yoksa sahibi üstlenir. Uygulama synthetic key ile başlar. Gerçek key/archive provisioning ve production deployment ayrı kapıdır.

## IP-2 — PR 1: Read-only duplicate customer comparison

**Suggested title:** `feat(crm): add read-only duplicate customer comparison`

**Kullanıcı davranışı:** Yönetici Müşteriler'den adayları görür, iki müşteriyi ve gerekçelerini karşılaştırır; hiçbir karar kaydı veya müşteri mutation'ı yoktur.

Kapsam:

- Existing JS normalizer'larını çağıran deterministic bucket/iterator ve semantic evidence fonksiyonu.
- Org/BUSINESS/inactive scope, source/pair/Contact/byte sınırları, source scan/index ve keyset cursor.
- Candidate GET ve comparison GET; scalar/allowlist/role/concealment, no-store/rate/deadline. SD-6.1.1 manual limiter sırası ve shared actor/org bucket; onRequest global ayarı taşınmaz.
- Read-time source index'leri current catalog'a göre ayrı additive migration; yeni review tabloları bu PR'da gerekmiyor.
- Gerçek kullanıcı candidate list + full-page comparison + boş/hata/overflow/forbidden durumları. Contacts ve ops summary lazy read; raw Ant import yok.
- HMAC keyring/config validation ve synthetic key injection bu davranışın ihtiyaç duyduğu kadarıyla.
- Current state bu ara release'te gerçekten aggregate'siz virtual version 0'dır. `allowedActions=[]`; UI karar kaydetme özelliğini varmış gibi göstermez. POST/register/history route'ları henüz yayımlanmaz.

Bu aşama boş infrastructure PR'ı değildir: bağımsız read-only yönetici akışı çalışır. Future module/table/worker stub'ı oluşturulmaz. PR2 stateful repository'yi bağladığında aynı read shape'i gerçek persisted head'lerle zenginleşir. PR1 server'ın PR2 şemasını gizlice okuyup “review yok” demesine izin verilmez; mevcut exact startup schema guard AHEAD durumunu reddeder.

Önerilen dosya sahipliği:

- `server/src/modules/crm/`: duplicate-candidates/evidence/read repository/types/parser; mevcut routes/handlers wiring.
- `server/src/config.ts`, `server/src/app.ts`: sadece somut keyring/rate/read dependency wiring; mevcut genel auth/CRM davranışı değişmez.
- `server/src/db/migrations/`: index migration yalnız numara yeniden doğrulandıktan sonra.
- `web/src/`: duplicate list/comparison sayfaları, `services/crm-api.ts`, route/paths/identity/role kayıtları; mevcut UI adapter tüketimi.
- `server/tests/`, `web/tests/`: NORM/SEC/PAIR/READ/UI ve ilk load profilleri.

**Acceptance:** TM SEC-01–05, READ-01/02/04, PAIR-01/03/04/05/06, NORM, EVID serialization/no-op, RATE-01–05, KEY-01/03 ve GATE-01; read-only UI. Gerçek PG roundtrip ve N² oracle/adversarial ilk sayfa testi zorunlu. “Full 4A complete” iddiası yok.

## IP-3 — PR 2: Persistent decisions, explicit reopen and history

**Suggested title:** `feat(crm): persist duplicate review decisions and history`

**Kullanıcı davranışı:** Yönetici pair comparison üzerinden gerekçeyle mükerrerliği doğrular/reddeder, kayıp yanıtı aynı istekle çözer, önceki kararı açıkça yeniden incelemeye açar ve inline history'yi görür.

Kapsam:

- Data Model'deki iki tablo, current-event deferred FK, canonical pair/sequence/state-reason constraint'leri ve additive audit vocabulary.
- Candidate/compare okumaları artık actual review head, freshness ve ATTENTION suppression uygular; eski ret source/Contact değişince gizlenmez.
- DECIDE, REOPEN, history endpoint'leri ve güvenli immutable receipt DTO'su.
- SD-6 source User/Customer/Contact/review lock sırası; exact evidence ve expected version kontrolü; raw parent membership phantom koruması.
- `runCriticalAction` nötr DB helper'a dar extract/re-export; default callsites aynı kalır. CRM opt-in claim öncesi timeout. Existing processed_actions schema/namespace değiştirilmez.
- Atomic event/audit/receipt, completion rowCount=1 assertion, explicit current-event constraint check, fresh/replay hash, source unavailable/old key davranışı. Missing expected key definitive 409; historical-key UNVERIFIABLE ve completed receipt replay ayrı.
- UI reason/confirmation, version/evidence conflict, frozen minimal sessionStorage attempt, reload/lost-response retry, draft/focus reconciliation ve inline history.
- Feature-specific refresh/poll; yeni SSE type, generic queue/outbox veya JobCard event taklidi yok.

Önerilen dosyalar:

- `server/src/modules/crm/`: duplicate-review service/repository/command parser ve typed safe audit.
- `server/src/db/critical-action.ts` (yeni somut tüketiciyle); `job-cards/repository.ts` eski export'ları koruyan dar değişiklik.
- `server/src/db/migrations/`: review/audit migration, current head tekrar doğrulanarak.
- `web/src/`: comparison decision/history bölümleri ve feature-scoped attempt hook/client parse.
- Existing JobCard/recurrence regression ve TM TX/CMD/EVID/UI testleri.

**Acceptance:** SD-5 geçişlerinin tamamı; A12-S1–S5, TX-01–12, CMD-01–11, EVID-01–10, KEY-01–04 ve RATE command coverage; fresh/replayed outcomes, audit/receipt failure, direct raw FK insert race ve Customer deletion sonrası history davranışı. Gerçek browser'da manager decision → source change → reopen → new decision ve network response drop akışı.

Bu PR'da register ekranı henüz yayınlanmadıysa eski/current pair history comparison üzerinden erişilir; ürün notu bu rollout sınırını açık söyler. Stale kontrolü, rollback ve replay güvenliği PR3'e ertelenmez.

## IP-4 — PR 3: Review register and stale-decision workbench

**Suggested title:** `feat(crm): add duplicate review register and stale decision workbench`

**Kullanıcı davranışı:** Yönetici artık current candidate olmayan eski review'leri de bulur; source değişmiş, key doğrulanamayan veya source silinmiş kayıtları ayrı değerlendirir ve izinli pair'i yeniden incelemeye açar.

Kapsam:

- Persistent register endpoint ve cursor; current candidate uzayından bağımsız history erişimi.
- ALL/ATTENTION görünümleri, unresolved/UNAVAILABLE/over-budget/freshness açıklaması.
- Dedicated registry/history görünümü; A/B kimliği, güvenli actor/time/reason, no raw audit/PII snapshot.
- Son 390px/desktop, keyboard/focus, 200%/400%/reduced-motion kapanışı.
- Full PERF-01–08 ve bütün A01–A16 mapping'inin exact-head evidence ile kapanışı.
- Kabul edilen tasarım/rollout belgeleri ve MVP/status owning kayıtlarının gerçekten shipped/verified davranışa göre güncellenmesi.

**Acceptance:** READ-03/05, register pagination/stale resurfacing, source removed review retention, UI-01–09 ve bütün security/atomicity regresyonu. Başka birinin audit/JobCard/mesaj detayına erişim genişlemez.

Full Slice 4A ancak bu son kullanıcı akışı ve bütün test kapıları kapanınca tamamlanabilir. 4B hâlâ yoktur.

## IP-5 — Verification per PR

Anlamlı behavioral test önce yazılır; surgical implementation ve gerekli regression takip eder. Öngörülmeyen P1 veya accepted policy drift bulunursa etkilenen kısım durdurulup raporlanır; unrelated cleanup yapılmaz.

Minimum command contract, ayrı implementation sırasında:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
cd web && npm test -- --run
```

Burada bu komutlar **çalıştırılmadı**. Repository'de olmayan lint komutu önerilmez. Focused suites gerçek dosyalar eklendikten sonra kendi isimleriyle çalıştırılır; henüz var olmayan test dosyası geçmiş PASS gibi yazılmaz.

Her final PR SHA'sı için existing local-CI runner:

```bash
ops/local-ci/run.sh --sha <reviewed-commit-sha>
```

Bu komut bu görevde çalıştırılmayacak. Implementation aşamasında required-checks.txt **27/27** zorunlu; exact SHA/tree bundle ve verifier kullanılır. Verifier argümanları o anki script'in CLI sözleşmesinden okunur. `--skip-docker-gated` ile eksik kontrolü PASS saymak, stale evidence kullanmak veya başka SHA'ya ait bundle'ı yeniden adlandırmak yasaktır.

Buna ek olarak Test Matrix'teki synthetic lock/lost-response/query-plan/load ve gerçek browser acceptance sonuçları saklanır. Host/platform/fixture/seed, SQL plan, latencies, query count, RSS ve kaynak temizliği açıkça raporlanır. NOT_RUN/SKIPPED ayrımı korunur.

Cleanup yalnız owned resources; Colima daemon pinning, owned PG anonymous volume cleanup ve separate cleanup diagnostics existing runbook'a uyar. `docker prune`, `git stash`, worktree prune/remove veya ignored/private dosya silme yoktur. CI çalıştırmak production DB/deploy/migration yetkisi vermez.

## IP-6 — Compatibility and stopping conditions

- PR sırası değişirse startup schema guard, optional read-stage state ve migration bağımlılıkları yeniden değerlendirilir; eski server'ın yeni şemayla devam edeceği varsayılmaz.
- Mevcut applied migration'lar değişmez. Her yeni migration clean/upgrade/exact-head/no-reapply testinden geçer.
- HMAC keyring kaybı, hard cap veya performance gate aşımı “no duplicates” ya da fresh review olarak gizlenmez.
- P1 race/atomicity testi geçmiyorsa UI polish veya yeşil build readiness sağlamaz.
- Final exact-main adversarial teknik inceleme SD-10'da kayıtlıdır. Bu statik inceleme gerçek PG17/browser/CI sonucu değildir; yeni uygulamanın reviewer ve test kabulü ayrıca zorunludur.
- Production secret provisioning, production migration, deployment/cutover, commit/push/PR/merge ancak kendi ayrıca yetkili görevleri içinde yapılabilir; bu documentation-only plan hiçbirini başlatmaz.


## IP-7 — PR1 implementation entry gate

**Design gate: OPEN.** D1–D6 değişmeden; T1/T2/T4 kabul, T3 custody/recovery sözleşmesi tamam, T5 başlangıç ölçüm hedefleri kesin. Açık ürün veya teknik tasarım kararı yoktur.

Implementation başlamadan:

1. Ayrı PR1 implementation görevi; izinli izole checkout/worktree, baseline/schema-catalog yeniden kontrolü. Mevcut beş stash/49 kayıt/private içerik korunur; migration numarası atanmaz.
2. Kendi isolated ortamında Node22 + lockfile exact dependency install; Fastify 5.12.5/rate-limit 11.2.0 doğrulanır. Canonical ignored node_modules drift'i burada temizlenmez/upgrade edilmez.
3. Synthetic TEST_DATABASE_URL/PG17/head preflight; gerçek Customer/production erişimi yok. HMAC synthetic config yalnız bu ortamda; gerçek custody provisioning'i gerekmez.
4. İlk behavioral testler RATE/SEC/GATE + normalized pair oracle/A12-S3 + read-only snapshot/source-cap; sonra salt okunur aday/karşılaştırma. PR1'de review/event tabloları, command helper extract'i ve decision/reopen/history/register yok.
5. PR1 çıkışında gerçek PG17 plan/load ölçümü, 390px/keyboard/200%/400%/reduced-motion evidence ve gerekli testler. Local CI 27/27 exact final SHA/tree + verifier + owned cleanup zorunlu. T5 ölçülmeden performance PASS yazılmaz.

PR1'in kabulü PR2 karar yazma yeteneğinin veya production migration/deployment/merge'in onayı değildir. Bu final reconciliation görevi PR1 koduna başlamadan biter.
