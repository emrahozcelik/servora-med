# CRM Slice 4A — Test Matrix

**Kabul/test SSOT.** Semantics: [Design](CRM_SLICE4A_DESIGN.md); wire: [API](CRM_SLICE4A_API_CONTRACT.md); SQL: [Data Model](CRM_SLICE4A_DATA_MODEL.md).  
**Bütün runtime, PostgreSQL, browser ve performance testleri bu görevde NOT_RUN.** Aşağıdaki İngilizce kriterler uygulanacak test planıdır; gerçekleşmiş PASS sayıları değildir.

## TM-1 — Preserved discovery acceptance

Orijinal discovery'deki A01–A16 aşağıya değişmeden alındı. Teknik alt testler kapsamı küçültmeden ayrıştırır. A12'deki ilgili değişim SD-4 semantic kapsamıyla uygulanır; salt version veya normalize-eşdeğer gösterim değişimi D5 gereği gereksiz invalidation üretmez.

| ID | Acceptance criterion |
| --- | --- |
| A01 | Only authorized same-organization ADMIN/MANAGER actors can list candidates and record review decisions; STAFF cannot gain review permission through CRM visibility or enrichment. |
| A02 | Unknown and foreign-organization customer/pair identifiers disclose no foreign identity, candidate count, JobCard detail or message content. |
| A03 | Candidate GET changes no Customer, Contact, JobCard, delivery, Sale, review, audit or processed-action row; stored normalization values and versions remain unchanged. |
| A04 | Each unordered pair appears once with deterministic ordering and bounded pagination. Approving A–B and B–C does not approve A–C or create a merged cluster. |
| A05 | Existing normalized tax uniqueness still rejects concurrent duplicates in one organization, including inactive customers; NULL values remain allowed and another organization remains isolated. |
| A06 | Valid full Turkish phone variants compare equally without rewriting history; blank, partial, malformed and foreign values never become positive phone evidence through digits-only matching. |
| A07 | Existing Turkish name folding is reused. Contains-search results, wildcard matches and unsupported accent/abbreviation equivalence are not represented as exact identity matches. |
| A08 | Shared phone/address/email and conflicting non-empty tax numbers remain visible with their limitations; they never trigger automatic mutation or a fabricated certainty percentage. |
| A09 | Contact-only similarity, the same Staff assignee and missing primary/contact data do not prove Customer equality. Primary flags and completeness/submission rules stay unchanged. |
| A10 | Approved status/data-class scope includes the intended inactive records and excludes cross-class BUSINESS/DEMO matching; the UI states its actual coverage. |
| A11 | Confirming or dismissing a candidate writes only the review result, safe audit and receipt atomically, with actor/time/reason; all customer and operational records remain unchanged. |
| A12 | Changes to either customer or relevant Contact membership, values, primary flags or versions invalidate stale evidence even when Customer.version is unchanged. |
| A13 | Concurrent opposite decisions with the same review version have one winner. Exact-key retries replay one result; changed-intent key reuse conflicts without extra audit. |
| A14 | Audit/receipt failures roll back the entire decision. A lost response retains its original key and payload; refresh/realtime cannot silently rebind the pending attempt. |
| A15 | Dismissed pairs are suppressed only for the approved evidence/rule revision; reopening appends history instead of deleting the previous decision. |
| A16 | Loading, empty, error, retry, stale, forbidden and pending states are distinct. Network failure never displays “no duplicates”. Core flows pass keyboard/focus, 390px, 200% text, 400% reflow and reduced-motion acceptance. |

### TM-1.1 — Binding A12 / D5 interpretation

Üstteki A12 discovery'nin tarihsel metni olarak aynen korunur. Bu bölüm D5'in kabul edilmiş semantic ilkesine göre bağlayıcı test yorumudur; D1–D6 veya A12 güvenlik kapsamını değiştirmez. “Versions invalidate stale evidence” version değişiminden sonra kanıtı yeniden değerlendirmeden eski karara güvenilemeyeceğini anlatır; semantic içerik aynıysa sırf version yüzünden stale üretmek EVID-04'e aykırıdır.

| Case | Normative acceptance criterion |
| --- | --- |
| A12-S1 | A relevant semantic field or Contact membership change invalidates old evidence, even when Customer.version and Contact.version do not change. |
| A12-S2 | A Customer/Contact version increment requires current semantic evidence evaluation; it is neither a sufficient invalidation condition nor a cache bypass for that evaluation. |
| A12-S3 | If membership and all SD-4 canonical semantics remain equal, version/updatedAt-only or normalization-equivalent edits preserve the evidence revision and terminal freshness (EVID-04). |
| A12-S4 | A primary/active/Contact-ID change or matching-rule revision invalidates applicable evidence regardless of displayed source versions. |
| A12-S5 | POST recomputes complete locked evidence; changed semantic revision commits no review/event/audit/receipt mutation. The two source version numbers cannot authorize the decision. |

A12-S1/S4/S5 + EVID-01/02/03/07 ve EVID-04 aynı suite'te birlikte geçmelidir. Yalnız “version changed ⇒ stale” assertion'ı yazılmaz. Customer status/Staff/ops gibi evidence dışı alanlarda EVID-05 geçerlidir.

## TM-2 — Acceptance mapping

| Discovery | Yeni test grupları |
| --- | --- |
| A01–A02 | SEC-01–04, CMD-01, UI-01 |
| A03 | READ-01, TX-08 |
| A04 | PAIR-01–04, PERF-02 |
| A05 | SEC-05 |
| A06–A08 | NORM-01–10, PAIR-05 |
| A09 | EVID-05, UI-02 |
| A10 | SEC-03, READ-02, PERF-04 |
| A11 | CMD-01–04, TX-05–08 |
| A12 | EVID-01–10, TX-02–04 |
| A13 | TX-01, CMD-02–05 |
| A14 | TX-05–07, UI-04–07 |
| A15 | READ-03, EVID-07–10, CMD-04/11 |
| A16 | UI-01–09, READ-04 |

## TM-3 — Security, read and pair tests

Her test mümkün olduğunda gerçek Fastify HTTP + PostgreSQL sonucu ve before/after business kolonlarıyla doğrulanır.

| ID | Acceptance criterion |
| --- | --- |
| SEC-01 | An unauthenticated actor receives the existing 401 behavior; STAFF receives 403 before a pair/review lookup, including guessed IDs, direct routes and replay attempts. |
| SEC-02 | Foreign-organization, missing and out-of-scope pair sources produce indistinguishable 404 shapes; no count, name, Contact or operational data leaks. Invalid anchors retain the same 404 above the source cap; eligible anchors still receive explicit 422 on overflow. |
| SEC-03 | BUSINESS-only scanning includes prospect, active and inactive records, excludes DEMO and never creates cross-class pairs. |
| SEC-04 | Every request rejects unknown fields, actor/org overrides, note/free-text, force flags, invalid UUIDs, invalid reason/outcome combinations and malformed/oversized cursors. |
| SEC-05 | Existing tax normalization/CHECK/unique still rejects same-org normalized duplicates under concurrent creates, including inactive records, while NULL and other-org behavior remains unchanged. |
| READ-01 | Every GET executes with one read-only repeatable snapshot and creates no review, event, audit, receipt or source business-row change; a mid-read source commit cannot mix snapshots. |
| READ-02 | Source, Contact, address and byte limits fail explicitly; no incomplete fingerprint or success-empty overflow response is emitted. |
| READ-03 | Fresh dismissed pairs are hidden only in ATTENTION. Stale, missing-key or over-budget pairs are not silently suppressed; reviews that no longer match remain accessible in the register. |
| READ-04 | Empty non-exhausted pages preserve a continuation cursor; only a successful exhausted scope may show an empty-result message. Query failures remain failures. |
| READ-05 | History cursors freeze upperSeq; newly appended events do not shift prior pages. Missing/foreign review IDs return 404 even when a requested history page is empty. |
| PAIR-01 | Reversed A/B input resolves to one canonical pair and one semantic hash; self-pairs fail validation and the DB CHECK. |
| PAIR-02 | DB pair UNIQUE rejects a second aggregate for the same unordered pair through every lifecycle state; different organizations remain isolated. |
| PAIR-03 | Name/phone iterator union emits each pair once, including pairs found by both buckets, and never materializes the full pair space. |
| PAIR-04 | Keyset continuation returns the same deterministic pair order as a brute-force oracle on small fixtures; prefetched but unconsumed pairs are not skipped. |
| PAIR-05 | Shared phones, shared addresses, different branches, conflicting tax numbers and contact-only similarity never auto-confirm, auto-merge or create independent evidence counts. |
| PAIR-06 | An anchor filter enumerates only its name/phone neighbor union in canonical order, never filters a materialized global pair space, and preserves cursor/count semantics for both lower and higher UUID partners. |

Brute-force oracle yalnız küçük synthetic fixture'da doğruluk referansıdır; production implementation değildir. Büyük testte oracle yerine bilinen kombinasyon sayıları ve bounded iterator tüketimi kullanılır.

## TM-4 — JavaScript / PostgreSQL roundtrip parity

SQL'de ikinci normalizer **yoktur**. PostgreSQL karşılığı; aynı raw source değerinin scope/roundtrip ile değişmeden gelmesi ve aynı JS helper'a verilmesidir. Test, SQL LOWER/regexp çıktısını beklenen canonical oracle olarak kullanmamalı.

| ID / input group | Expected assertion |
| --- | --- |
| NORM-01 — null, empty, whitespace-only | Missing values do not create positive phone/email/address/name evidence. Null and nonblank unusable text remain distinguishable in evidence. |
| NORM-02 — 05321234567, (0532) 123 45 67, 5321234567, 905321234567, +905321234567 | All normalize to +905321234567 through the existing helper before grouping; PG fetch preserves the original stored text. |
| NORM-03 — landline and 0850 | Accepted complete national forms preserve existing landline/non-carrier semantics; no mobile-only restriction is introduced. |
| NORM-04 — +3572212345, foreign + prefix, trunk 0 after +90, overlong/partial body | No valid phone evidence is produced; no prefix stripping, truncation or repair invents a Turkish number. |
| NORM-05 — letters, slash, %, underscore, extension text, Unicode digits | Unusable values do not become matches through digits-only or SQL LIKE behavior. Two different unusable texts produce different evidence revisions. |
| NORM-06 — ECMAScript whitespace set, NBSP, narrow NBSP, FEFF; excluded NEL/180E | Existing helper output is the exact oracle. JS/PG raw roundtrip agrees byte-for-byte; no POSIX-space substitution changes semantics. |
| NORM-07 — İSTANBUL/Istanbul/istanbul, Yılmaz/YILMAZ/yilmaz | Existing Turkish fold output drives equality consistently before and after PG storage. |
| NORM-08 — Şube/Sube, composed/decomposed accents, Greek/context case and supplementary Unicode | No unapproved accent/NFC/locale equivalence is added; the same pinned Node helper applied to fetched values is authoritative. |
| NORM-09 — ab 12.3-4/, separator-only tax, Unicode uppercase cases | Existing normalizeTaxNumber output and DB CHECK/unique remain compatible; no new legal/checksum validation is inferred. |
| NORM-10 — email case/outer whitespace, internal address whitespace/punctuation, all address components | Trim/lower/fold follows SD-3 exactly; provider aliases, missing city/district and similar addresses are not treated as complete address equality. |

Gerekli test katmanları: helper unit fixtures; real PG17 raw roundtrip; candidate API result parity; evidence GET/POST parity; Linux Node22 local-CI ve host Node22 normalization fixture karşılaştırması. Mevcut server SQL search-fold implementasyonu değiştirilmez. Unsupported collation'ı taklit etmek için query-key normalization SQL'e taşınmaz.

## TM-5 — Evidence revision tests

| ID | Acceptance criterion |
| --- | --- |
| EVID-01 | Changing Customer name/phone/email/city/district/address/tax/customerType semantically changes the revision; posting the previous GET revision commits no review mutation. |
| EVID-02 | Adding/removing a Contact or changing a Contact ID changes the membership signature, even when Customer.version stays unchanged. |
| EVID-03 | Contact name/title/phone/email/active/primary changes invalidate prior evidence; inactive Contacts are included in the identity-review signature. |
| EVID-04 | Pure source version/updatedAt increments and normalization-equivalent display changes preserve the semantic revision and do not force unnecessary review. |
| EVID-05 | Assigned Staff, customer status within the supported set, JobCard counts/status, notes and operational summaries do not enter the identity signature or change primary/completeness rules. |
| EVID-06 | Canonical A/B and Contact ordering, null representation, JSON escaping and UTF-8 serialization produce stable digests independent of SQL row order. |
| EVID-07 | A matching-rule version change makes terminal review effective REVIEW_REQUIRED without a GET write; an old form cannot submit under a silently rebound version. |
| EVID-08 | Key rotation with the previous key retained preserves freshness of equivalent old decisions; the old key is used for old digest comparison. |
| EVID-09 | An unavailable old key or oversized evidence never yields CURRENT or suppresses an old dismissal; a completed receipt can still replay without recomputing evidence. |
| EVID-10 | A terminal review with an unavailable historical key can be explicitly reopened using complete current evidence signed by the active key; the old event remains UNVERIFIABLE. A missing expected-token key returns definitive 409 EVIDENCE_KEY_UNAVAILABLE after receipt replay check and confirmed rollback, with zero committed writes. |

HMAC testleri gerçek secret kullanmaz. Düşük entropili PII örneklerinin plaintext'i DB history/audit/receipt/log dump'ında bulunmamalı. Raw source satırlarında bulunması fixture'ın doğasıdır; privacy testinin tarama kapsamı açıkça sadece yeni artifact tabloları/log payload'larıdır.

## TM-6 — PostgreSQL 17 concurrency and atomicity

Deterministic barriers kullanılır: ayrı named PoolClient'lar, kontrollü transaction başlangıcı ve `pg_locks/pg_stat_activity` gözlemi. Kör sleep ile sıra varsayılmaz. Her bekleme bounded, her client try/finally rollback/release. Sadece bu testin application_name/PID'leri gözlenir veya iptal edilir.

| ID | Acceptance criterion |
| --- | --- |
| TX-01 | Two managers with different action keys and expectedReviewVersion=0 yield one aggregate/event/audit/completed receipt; the loser gets bounded REVIEW_BUSY or VERSION_CONFLICT and leaves no committed claim. |
| TX-02 | A Customer update committed after GET and before POST causes EVIDENCE_CHANGED; a writer starting after review locks waits or conflicts and cannot slip between validation and commit. |
| TX-03 | Generic/scoped Contact creation, including importer-style FK insertion, cannot create a phantom after the parent FOR UPDATE lock; insert-before-review conflicts, insert-after-review serializes. |
| TX-04 | Contact update/delete/move before final Contact locking uses current locked facts or removed membership, never stale pre-read values. After final locks, source writes cannot commit before the review. |
| TX-05 | Failure at head insert/update, event append, audit insert, deferred FK verification and receipt completion (including zero returned completion rows) rolls back every review-side change; source business fields/versions remain unchanged. |
| TX-06 | A commit followed by a dropped HTTP response replays the exact original command result and creates no extra event/audit; later source or review changes do not rerun the original callback. |
| TX-07 | Same-key concurrent requests return replay or bounded ACTION_IN_PROGRESS; changed intent eventually receives CLIENT_ACTION_REUSED and never adds a business event. |
| TX-08 | Review success, conflict and rollback produce no Customer/Contact/JobCard business-column or version updates; lock metadata is not mistaken for a logical mutation. |
| TX-09 | A busy meeting-result Contact lock, Sale source→Customer path, CRM enrichment witness and Staff-offboarding path cannot cause review to wait in a reverse-order cycle or acquire JobCard locks. |
| TX-10 | Existing pristine Customer deletion before review causes failure without a new aggregate; deletion after review preserves immutable review history and returns unavailable source facts without a new delete blocker. |
| TX-11 | Current-event FK rejects a head without its same-org/version event at commit; pair/sequence uniqueness and outcome/reason CHECKs reject invalid rows. |
| TX-12 | Pool exhaustion, lock timeout, query timeout and request deadline release owned resources and fail closed; opt-in timeout changes do not affect legacy critical-action callsites. |

TX-04 mevcut parent-lock almayan deleteContact yolunu da kullanır: deletion pre-read öncesi, pre-read/final lock arasında ve final share sonrası yarıştırılır. TX-09 mevcut JobCard/Sale/met-contact servislerinin synthetic fixture'larıyla çalışır. Global statü/approval/enrichment politikası test geçsin diye değiştirilmez. Contact membership testinde özellikle **FOR SHARE parent** ve **FOR KEY SHARE Contact** ile yetersiz kalan alternatiflerin negatif kontrollü reproducer'ları hazırlanır; seçilen lock protokolü bunları geçmelidir.

## TM-7 — Command and history semantics

| ID | Acceptance criterion |
| --- | --- |
| CMD-01 | First decision persists exactly one immutable event, current version and matching audit/receipt with an allowed reason, leaving all operational records unchanged. |
| CMD-02 | A completed exact replay returns its original event/version result even after reopen or source deletion; the UI subsequently fetches current state. |
| CMD-03 | Namespace/hash binds pair, actor/org, expected review/evidence versions, rule, outcome and reason; changing any bound field conflicts for a reused key. |
| CMD-04 | Explicit reopen appends a pending event and retains the previous decision. Direct terminal-to-new-decision and already-pending reopen reject without a new event. |
| CMD-05 | Both same and opposite fresh decisions from stale review versions cannot silently overwrite another manager; only one decision per expected version commits. |
| CMD-06 | Leave-for-later is navigation only; no aggregate, event, audit or receipt is created. |
| CMD-07 | A persisted pair with no current match remains reachable through register/history and may be explicitly reconsidered if both current source records are eligible. |
| CMD-08 | Changing source helpers/rule version cannot reuse an old semantic version without failing the pinned parity/rule contract tests. |
| CMD-09 | SQL audit vocabulary contains every baseline allowed value plus the two new events/subject; no event is mislabeled as CUSTOMER_FIELDS_UPDATED or JobCard activity. |
| CMD-10 | Existing JobCard and recurrence critical-action tests pass after the neutral helper extract/re-export; old receipts and operation namespaces remain unchanged. |
| CMD-11 | Reopened heads return the immediately preceding decision as lastDecision in candidate, comparison and register reads without N+1 queries; fresh decisions return themselves, and a broken event chain fails explicitly. |

## TM-8 — UI and browser acceptance

Gerçek Chrome + synthetic PG17/API/Vite üzerinde desktop ve 390px birlikte; son bounded QA pass'te 200% text, 400% reflow, keyboard/focus ve reduced motion uygulanır. Automated a11y yardımcıdır, manuel akışın yerine geçmez.

| ID | Acceptance criterion |
| --- | --- |
| UI-01 | Role-aware links and direct URLs enforce the new management-only flow while existing STAFF CRM create/read/enrichment flows remain usable. |
| UI-02 | A/B identities remain unambiguous on desktop and mobile; matching/conflicting fields and active/primary Contact labels do not rely on color. No hidden second comparison DOM is mounted. |
| UI-03 | Required reason selection, explicit effects text and “Mükerrer olarak doğrula” prevent confusion with JobCard approval; no merge/deactivate/delete control appears. |
| UI-04 | Pending command freezes semantic inputs and cancel/close; browser reload restores the original actor-bound minimal sessionStorage attempt and exact retry payload. |
| UI-05 | Background refresh with equivalent evidence preserves draft/focus. Changed evidence/version blocks saving without rebinding the draft's original expectations. |
| UI-06 | Network/invalid response/5xx keeps one frozen attempt; a success receipt triggers GET reconciliation and is not rendered as current aggregate truth. |
| UI-07 | Explicit conflict reload preserves a useful reason draft but requires renewed inspection before a fresh intent; capability loss fails closed without making the underlying Customer unreadable. |
| UI-08 | Source overflow, intermediate empty pages, query failures, source removal, missing key and forbidden states have distinct explanatory/retry behavior. |
| UI-09 | Keyboard, focus restoration, long Turkish names, 44×44 targets, 390px, 200% text, 400% reflow, reduced motion and screen-reader labels pass the full decision/reopen/history flow. |

 sessionStorage testleri: write failure POST'u engeller; başka actor/org'ya attempt gösterilmez; unresolved key otomatik expire edilmez; tab close sonrası key yoksa automatic replay yapılmaz. Raw evidence/auth token storage yok. History ve operational links normal backend yetkilerini genişletmez.

## TM-9 — Query-plan and load protocol

**Önerilen ölçüm ortamı:** Linux Node22 + PostgreSQL17, 2 vCPU / 4 GiB RAM; isolated DB, synthetic veri, production bağlantısı yok. Ortam/version/CPU/memory/seed/count ve warm/cold durum evidence'e kaydedilir. Bunlar gerçekleşmiş benchmark sonuçları değildir.

| Profile | Synthetic hacim / adversarial yapı | Beklenen ispat |
| --- | --- | --- |
| PERF-01 | 0, 1, 1k, 5k, 20k BUSINESS; farklı durum/isim/telefon oranları | Source sınırı, lineer okuma, sabit query sayısı, doğru sıra |
| PERF-02 | 20k aynı isim; ayrıca ortak telefon ve overlap grupları | 199.990.000 pair'i materialize etmeden ilk/ileri sayfa; bilinen total ve dedup |
| PERF-03 | 32 pair batch, her ilgili Customer'da 200 Contact; uzun UTF-8 alanlar; 201'inci sentinel | Bounded memory/serialization, hiçbir silent truncate yok |
| PERF-04 | 20k BUSINESS + 1m DEMO | Partial index ile BUSINESS scope; DEMO eşleşme ve payload yok |
| PERF-05 | Bir Customer'da 1m Contact | Ordered index + 201 sentinel; bütün grubu sort/transport etmeden açık overflow |
| PERF-06 | 20.001 BUSINESS | Açık CANDIDATE_SCAN_LIMIT; kısmi success ve “no duplicates” yok |
| PERF-07 | Tüm incelenen pair'ler current dismissed; attention çok sparse | Work budget, continuation, boş ara sayfa ve query sayısı korunur |
| PERF-08 | 2 concurrent scan + third request, 10 manager clients, own command contention | Inflight/rate limits, bounded conflict, connection/memory leakage yok |

Query count hedefleri Data Model DM-8'dir: candidate <=4, compare <=3, register <=3 data SELECT; auth/transaction SET ve optional operations paneli ayrı ölçülür. Query-logging N+1 testi gerçek call sayısını ölçer. Bir SQL içindeki LATERAL loops da EXPLAIN'de ayrıca kontrol edilir.

EXPLAIN `ANALYZE, BUFFERS, FORMAT JSON`: actual/estimated rows, loops, shared read/hit blocks, sort method, temp read/write, execution time ve index erişimi. JSON plan'da Customer self-JOIN/N² candidate node'u veya tüm raw pair sort'u bulunmamalı. Contact probe'larının rows/loops sınırı doğrulanmalı. Warm repeated request source scan maliyeti de raporlanmalı; “LIMIT 20 var” performans kanıtı değildir.

T5 olarak kabul edilen başlangıç ölçüm hedefleri (henüz production SLO veya ölçülmüş PASS değildir):

- 5k kaynakta p95 <=750 ms; 20k'da p95 <=1500 ms, p99 <=3000 ms; request deadline 5 s.
- Single worst-case scan peak RSS artışı <=256 MiB; iki scan için process RSS/heap bütçesi ortam raporunda gösterilir, OOM/connection leak yok.
- 200 warm ölçüm + ayrı cold plan kaydı; 1/20/32 pair'de data query sayısı sabit.
- Büyük pair uzayında ilk sayfa süresi toplam combination sayısıyla orantılı büyümez.
- Her query öncesi statement_timeout kalan request bütçesinin min(2s, remaining) değerine ayarlanır; geç alınan PoolClient deadline sonrası geri bırakılır.

Ölçüm hedefi sağlanmazsa o hedef NOT_MET raporlanır, PASS yapılmaz; ölçümler ve kapasite değerlendirmesi kullanıcı/reviewer'a sunulur. 20k cap, bounded pair/evidence, doğru scope, no-N², deadline/resource cleanup ve atomicity zorunlu kabul şartlarıdır; latency/RSS başlangıç hedefleri bunları gevşetmez. Limit artırma, eksik kanıtı hash'leme veya yeni normalizer yazma çözüm değildir.

## TM-10 — Execution and evidence discipline

Şimdi hiçbiri çalıştırılmadı. Implementation aşamasında:

1. PostgreSQL17 ve client araçları; açık password-bearing loopback `TEST_DATABASE_URL`; benzersiz isolated test DB/schema. DATABASE_URL fallback yok.
2. Build-before-test ve exact migration head preflight. Migrations yalnız bu uygulama görevi için yetkili synthetic ortamda.
3. Focused unit/HTTP/PG/race, full server/web checks, browser ve ek load profilleri.
4. Her uygulama PR'ının final SHA/tree'sinde `ops/local-ci/run.sh --sha <sha>`; mevcut required-checks SSOT'undaki **27/27 PASS**.
5. `ops/local-ci/verify-evidence.sh` ile exact-head bundle; verifier gerçek CLI allowlist'ine göre çağrılır. NOT_RUN/ABSENT başarısız manifesttir; opt-in R2/DR durumları dürüstçe SKIPPED kalır.
6. Owned container/schema/process cleanup ve ayrı cleanup diagnostics; broad prune/delete/stash yok. Başka worktree/volume/private dosyaya dokunma.
7. Performance/browser evidence CI 27/27'nin yerine geçmez; exact-head CI de çalıştırılmamış synthetic race/load testinin PASS'i sayılmaz.

Kaynak normalizer testleri ve bu paket için statik link/enum kontrolleri ayrı sınıflandırılır. Uygulanmamış feature'ın migration count/test sonucu artırılıp “shipped” denmez.


## TM-11 — Reconciliation-specific gates

Bütün bu testler **NOT_RUN**; statik source incelemesi bunları PASS yapmaz.

| ID | Acceptance criterion |
| --- | --- |
| RATE-01 | In pinned versions, auth/password checks precede the management guard, then exactly one manual class limiter, then handler/query; denied actors never invoke the manager limiter or source repository. |
| RATE-02 | Two sessions for one actor/org share a budget; actors/orgs are isolated, and forged headers/body org or IP/session changes cannot buy a fresh actor budget. |
| RATE-03 | Candidate/register share LIST, comparison/history share DETAIL and decision/reopen share COMMAND; IDs, filters and cursors never reset counters. Factories run once per registration. |
| RATE-04 | config.rateLimit=false prevents an earlier automatic hook from setting the request marker; exactly one manual hook executes. A double-hook negative control exposes the skip and is never used in implementation. |
| RATE-05 | Exceeded/store-error paths fail closed; 429 carries Retry-After/no-store, performs no source scan and preserves frozen intent. Polling resumes through the coalesced visible/focus gate. |
| KEY-01 | Config rejects duplicate key IDs, invalid base64/length, absent active membership and more than two online keys; historical archives are not extra runtime keys. |
| KEY-02 | A synthetic operator-runbook rehearsal blocks planned retirement with dependent heads until renewed reviews or recorded owner acceptance of UNVERIFIABLE impact; unavailable-source heads remain immutable. No re-sign/history UPDATE occurs. Emergency retirement preserves history and surfaces attention. |
| KEY-03 | Synthetic encrypted custody backup/restore preserves exact key bytes/IDs independently of a synthetic DB snapshot; DB-only restore cannot claim recovered freshness. No real secret is generated/copied. |
| KEY-04 | Completed receipt replays before retired-key validation; without receipt, missing expected key yields confirmed no-commit 409. Fresh GET/human inspection resolves the draft without automatic key replacement. Commit/rollback ambiguity remains unresolved 5xx. |
| GATE-01 | PR1 exposes only candidate/comparison GET, virtual version 0 and allowedActions=[]; POST/register/history and all review/audit/receipt writes are absent. Tax/primary/enrichment behavior is unchanged. |

Pinned evidence prerequisites: Linux/local-CI Node22, lockfile-matching Fastify 5.12.5/rate-limit 11.2.0, PG17 for DB suites. This review observed installed Fastify 5.12.3/rate-limit 11.1.0 and host Node v26.11.0. Node26 satisfies engines >=22.12.0 but is not the Node22 parity profile. No install/probe/build was run against this drift; ignored node_modules were preserved. PR1 prepares its own authorized isolated environment before runtime evidence.

Production custody gate (operator-owned): accountable/responsible identity recorded, two independently encrypted recovery copies, exact-key synthetic recovery evidence, rotation/head-count preflight, snapshot/key-bundle compatibility and emergency-retirement record. This does not authorize production access in PR1 or this task.
