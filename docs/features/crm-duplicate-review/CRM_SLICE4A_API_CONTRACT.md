# CRM Slice 4A — API Contract

**Wire SSOT.** Domain semantics/state/reasons/limits: [Design SD-3–SD-7](CRM_SLICE4A_DESIGN.md). SQL: [Data Model](CRM_SLICE4A_DATA_MODEL.md). Örneklerin tamamı synthetic ve biçim gösterimidir; hesaplanmış/çalıştırılmış sonuç değildir.

## API-1 — Common protocol

Mevcut CRM route/service sahipliği ve auth/origin/CSRF zinciri korunur. Bütün yeni endpoint'ler ADMIN/MANAGER-only. STAFF 403 lookup öncesi; unauthenticated istek mevcut 401 davranışını kullanır. Org session'dan gelir; body/query/path ile seçilmez. Existing Customer/Contact endpoint'lerinin response shape'i ve STAFF hakları genişletilmez.

GET source pair için mevcut, aynı org, BUSINESS iki Customer gerekir. Foreign/missing/out-of-scope pair aynı `404 DUPLICATE_PAIR_NOT_FOUND` döner. Review history/register kendi org-scoped tarihsel review ID'siyle çalışır; silinmiş source raw verisi getirilmez.

UUID input canonical lowercase'a normalize edilir; A/B ters gönderilse de aynı canonical pair ve hash kullanılır. A=B ve bozuk UUID 400. Query/body exact allowlist: unknown key, array yerine scalar, duplicate query scalar, geçersiz enum veya bound dışı değer 400. `organizationId`, `actor`, status override, evidence body, Contact/JobCard ID listesi, free-text note ve `force` kabul edilmez.

Headers: tüm success/error cevaplarında `Cache-Control: no-store`. Credential cookie mevcut kuralla; yeni token authentication yok. GET hiçbir review/audit/receipt yaratmaz, source row lock almaz. Yeni generic export/download endpoint'i yok.

### API-1.1 — Hook and rate-limit wire contract

Authoritative integration: Design SD-6.1.1. Yeni route'lar `config.rateLimit=false`, preHandler `[authenticateDomain, requireManagement, classLimiter]` kullanır. Management guard lookup'tan önce; cookie/IP fallback ile manager kimliği türetilmez. Fastify parsing/origin hataları kendi lifecycle sırasını korur; 401/403 önceliği well-formed request'ler içindir.

| Limiter class | Shared endpoints | Key / budget |
| --- | --- | --- |
| CRM_DUPLICATE_LIST:v1 | candidate + persistent-review list | authenticated org/actor + class; SD-3.3 list quota |
| CRM_DUPLICATE_DETAIL:v1 | comparison + history | authenticated org/actor + class; SD-3.3 detail quota |
| CRM_DUPLICATE_COMMAND:v1 | decision + reopen | authenticated org/actor + class; SD-3.3 command quota |

Factory'ler bir kez kurulur, aynı class hook'u paylaşılır; path/pair/session değiştirmek yeni kota üretmez. Tek manuel limiter dışında önce otomatik plugin hook'u koşmaz. 429 `Retry-After` taşır; GET retry/poll duraklar, command frozen intent kalır. Inflight scan 429'u aynı code ile en az 1 saniyelik Retry-After verir. Process-local kotalar deployment-geneli distributed garanti değildir. 401/403/429 ve origin/parse error'lar dahil no-store erken response hook'uyla korunur; authentication değiştirilmez.

## API-2 — Endpoint map

| Method / path | Allowlist | Sonuç / pagination | Write effects |
| --- | --- | --- | --- |
| GET /api/customers/duplicate-candidates | query: view, anchorCustomerId, cursor, limit | CandidatePage; SD-3 bounded cursor | none |
| GET /api/customers/duplicate-reviews | query: view, cursor, limit | PersistentReviewPage; canonical pair cursor | none |
| GET /api/customers/duplicate-review-pairs/:aId/:bId | query yok | PairComparison | none |
| POST /api/customers/duplicate-review-pairs/:aId/:bId/decisions | body API-5 | CommandReceipt, HTTP 200 | review + event + audit + processed receipt |
| POST /api/customers/duplicate-review-pairs/:aId/:bId/reopen | body API-6 | CommandReceipt, HTTP 200 | aynı tür atomik yazılar |
| GET /api/customers/duplicate-reviews/:reviewId/history | query: cursor, limit | ReviewHistoryPage | none |

Static duplicate yolları mevcut `/customers/:customerId` ile karıştırılmamalı; route/role testleri zorunlu. Ayrı primitive Contact koleksiyonu veya yeni JobCard command'i yok.

## API-3 — Candidate and persistent-review lists

`view=ATTENTION|ALL`, default ATTENTION. ATTENTION; virtual pending, reopened pending, REVIEW_REQUIRED ve doğrulanamayan/blocked sonuçları içerir. Güncel confirmed/dismissed kararlar bu görünümde gizlenebilir; freshness hesaplanmadan SQL status filtresiyle atılmaz. ALL bütün raw aday çiftlerini gösterir.

Candidate `anchorCustomerId` optional UUID; current same-org BUSINESS olmayan anchor 404. DM-6.1 eligibility gate'i bu 404'ü cap aşımından önce korur; uygun anchor + 20.001 source açık 422 alır. Bu filtre global scan cap'ini kaldırmaz. `limit` ve diğer bütçeler Design SD-3.3'ten gelir. İstemci PAIR_EVALUATION_BUDGET veya source limit gönderemez.

CandidatePage alanları:

| Alan | Tip / anlam |
| --- | --- |
| scope | {dataClass:BUSINESS, includesInactive:true, anchorCustomerId:string|null} |
| asOf | UTC ISO request snapshot zamanı |
| matchingRuleVersion | Active version |
| items | CandidateListItem[] |
| page | {nextCursor:string|null, exhausted:boolean, evaluatedPairs:number, returnedItems:number} |
| coverage | COMPLETE_SOURCE veya hata; başarılı response source kapsamını sessizce kırpmaz |
| rawPairCount | Attention filtresi öncesi decimal string |
| largestNameGroupSize / largestPhoneGroupSize | Büyük grubu açıklayan gerçek kaynak sayıları |

CandidateListItem: `pair`, A/B için `{id,name,status,city,district}`, `matchingCodes`, `warnings`, `comparisonStatus=READY|OVER_BUDGET|UNVERIFIABLE` ve ReviewSummary. Listede raw phone/email/tax/address, Contacts, JobCard notes, mesaj veya confidential Staff verisi yok. Matching codes SD-3.1 sırasındadır. Blocked item'de gerekçe değerlendirmesinin eksik olduğu açıkça belirtilir; absent code kesin eşleşmeme diye yorumlanmaz.

```json
{
  "scope": {
    "dataClass": "BUSINESS",
    "includesInactive": true,
    "anchorCustomerId": null
  },
  "asOf": "2026-10-19T10:00:00.000Z",
  "matchingRuleVersion": "crm-duplicate-v1",
  "coverage": "COMPLETE_SOURCE",
  "rawPairCount": "1",
  "largestNameGroupSize": 2,
  "largestPhoneGroupSize": 2,
  "items": [
    {
      "pair": {
        "customerAId": "10000000-0000-4000-8000-000000000001",
        "customerBId": "10000000-0000-4000-8000-000000000002"
      },
      "customerA": {
        "id": "10000000-0000-4000-8000-000000000001",
        "name": "Sentetik Klinik",
        "status": "active",
        "city": null,
        "district": null
      },
      "customerB": {
        "id": "10000000-0000-4000-8000-000000000002",
        "name": "SENTETİK KLİNİK",
        "status": "inactive",
        "city": null,
        "district": null
      },
      "matchingCodes": ["SAME_NAME_AND_PHONE"],
      "warnings": [],
      "comparisonStatus": "READY",
      "review": {
        "id": null,
        "version": 0,
        "reviewStatus": "PENDING_REVIEW",
        "effectiveStatus": "PENDING_REVIEW",
        "freshness": "NOT_APPLICABLE",
        "freshnessReason": null,
        "currentDecision": null,
        "lastDecision": null
      }
    }
  ],
  "page": {
    "nextCursor": null,
    "exhausted": true,
    "evaluatedPairs": 1,
    "returnedItems": 1
  }
}
```

`items=[]` ancak `exhausted=true` ile bu taramada attention sonucu kalmadığını ifade eder. Ara boş sayfa + nextCursor “taramayı sürdür”dür. Source overflow/query error 422/503'tür; asla 200 boş liste değildir. RawPairCount=0 yalnız complete source üzerinde gerçekten hesaplandıysa verilir.

PersistentReviewPage aynı paging/ReviewSummary alanlarını kullanır; `rawPairCount` yoktur. items her review için stable review ID, pair, sourceAvailability ve erişilebilir source'un sınırlı başlık verisini taşır. Source bulunamıyorsa `sourceAvailability=UNAVAILABLE`, `customerA/customerB=null` olabilir; safe pair/event ID'leri kalır. Böyle kayıt current candidate listesinde bulunmasa da register'da kaybolmaz. ATTENTION unavailable/unverifiable durumları da kapsar.

PersistentReviewPage tam alanları: `{asOf,matchingRuleVersion,items,page}`. Her item `{reviewId,pair,sourceAvailability,customerA,customerB,matchingCodes,warnings,comparisonStatus,review}`; customer başlık biçimi CandidateListItem ile aynıdır. Herhangi bir source uygun değilse iki başlık da null, matchingCodes/warnings boş ve comparisonStatus=UNAVAILABLE olur; eski kararın güvenli alanları review içinde kalır. Registry ALL bütün persistent aggregate'leri, ATTENTION ise SD-5 projection'ına göre ilgilenilmesi gerekenleri kapsar. Page en fazla 32 head değerlendirir, 20 item döndürür; cursor son tüketilen head'dir, LIMIT ile prefetched fakat tüketilmemiş head atlanmaz.

Cursor: HMAC-authenticated opaque base64url, en fazla 2048 karakter; org, normalized filters, ruleVersion, source scan revision (candidate için), son tüketilen canonical pair ve issuedAt içerir. Raw match key/PII yok. Filter tamper 400; expired/rule/source değişimi 409 CURSOR_RESTART_REQUIRED. Registry cursor uzun DB snapshot veya eski status garantisi taşımaz; live page sınırlaması Design SD-3.4'te açıklanır.

## API-4 — Comparison and ReviewSummary

Comparison, güncel aday **veya** var olan persistent pair için sunulur. Aggregate'siz ve güncel N/P eşleşmesi olmayan pair 404. Persistent pair artık eşleşmiyorsa aynı iki BUSINESS Customer için 200 ve boş matchingCodes mümkündür; geçmiş inceleme yolu korunur.

PairComparison alanları:

- `pair`, `asOf`.
- `customerA`, `customerB`: Customer ID/name/customerType/taxNumber/phone/email/city/district/address/status/version/assignedStaffUserId; org ID client seçimi için tekrar kullanılmaz.
- Her Customer altında `contacts`: ID, name/title/phone/email/isPrimary/isActive/version; full bounded set. Source version'lar witness'tır.
- `evidence`: revision, schemaVersion, matchingRuleVersion, matchingCodes, warnings.
- `review`: ReviewSummary.
- `allowedActions`: DECIDE veya REOPEN; mevcut state/eligibility'den server hesaplar. Leave-for-later navigation'dır.
- Operasyonel özet payload'a full JobCard olarak gömülmez; UI mevcut iki `/:customerId/operational-summary` endpoint'ini lazy açabilir. Bu bilgiler identity evidence değildir ve snapshot zamanı ayrı gösterilir.

ReviewSummary:

| Alan | Anlam |
| --- | --- |
| id/version | null/0 yalnız virtual pair; persisted version pozitif |
| reviewStatus | Current event'in stored resulting status'u |
| effectiveStatus | Stored status veya REVIEW_REQUIRED/BLOCKED/UNAVAILABLE projection |
| freshness | NOT_APPLICABLE, CURRENT, STALE veya UNVERIFIABLE |
| freshnessReason | null, SOURCE_CHANGED, RULE_CHANGED, KEY_UNAVAILABLE, OVER_BUDGET veya SOURCE_UNAVAILABLE |
| currentDecision | Current event DECISION_RECORDED ise DecisionInfo; pending'de null |
| lastDecision | Son DECISION_RECORDED; reopen sırasında geçmişte kalır |

DecisionInfo yalnız `eventId, seq, status, reasonCode, actorUserId, decidedAt` içerir. Aktörün güncel same-org display adı varsa ayrı optional read projection kullanılabilir; silinmiş kullanıcı için e-posta veya confidential profile fallback yok.

```json
{
  "pair": {
    "customerAId": "10000000-0000-4000-8000-000000000001",
    "customerBId": "10000000-0000-4000-8000-000000000002"
  },
  "asOf": "2026-10-19T10:00:00.000Z",
  "customerA": {
    "id": "10000000-0000-4000-8000-000000000001",
    "name": "Sentetik Klinik",
    "customerType": "clinic",
    "taxNumber": null,
    "phone": "+902125550101",
    "email": null,
    "city": null,
    "district": null,
    "address": null,
    "status": "active",
    "version": 2,
    "assignedStaffUserId": null,
    "contacts": []
  },
  "customerB": {
    "id": "10000000-0000-4000-8000-000000000002",
    "name": "SENTETİK KLİNİK",
    "customerType": "clinic",
    "taxNumber": null,
    "phone": "+902125550101",
    "email": null,
    "city": null,
    "district": null,
    "address": null,
    "status": "inactive",
    "version": 3,
    "assignedStaffUserId": null,
    "contacts": []
  },
  "evidence": {
    "revision": "ev1.testkey.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "schemaVersion": 1,
    "matchingRuleVersion": "crm-duplicate-v1",
    "matchingCodes": ["SAME_NAME_AND_PHONE"],
    "warnings": []
  },
  "review": {
    "id": null,
    "version": 0,
    "reviewStatus": "PENDING_REVIEW",
    "effectiveStatus": "PENDING_REVIEW",
    "freshness": "NOT_APPLICABLE",
    "freshnessReason": null,
    "currentDecision": null,
    "lastDecision": null
  },
  "allowedActions": ["DECIDE"]
}
```

Üst sınırı aşan comparison 422 EVIDENCE_LIMIT_EXCEEDED; truncation ile usable revision dönmez. Varsa list/register başlıkları korunur ve karar kapalı kalır. Evidence key yoksa 503 EVIDENCE_UNAVAILABLE; eski karar CURRENT sayılmaz.

Geçmiş kararın stored key'i eksik fakat güncel evidence active key ile üretilebiliyorsa comparison 200, review.freshness=UNVERIFIABLE, freshnessReason=KEY_UNAVAILABLE ve effectiveStatus=BLOCKED döner. Terminal review için allowedActions=[REOPEN] olabilir; eski freshness doğrulanmış sayılmadan güncel kanıtla açık yeni cycle başlatılır. Current evidence üretilemiyorsa 503 EVIDENCE_UNAVAILABLE kullanılır. Fresh POST expected token key'i online değilse receipt kontrolü ve başarılı rollback sonrası 409 EVIDENCE_KEY_UNAVAILABLE döner; completed receipt önce replay edilir. Projection önceliği ve pending evidence değişimi Design SD-5'tedir.

## API-5 — Decision command

Body allowlist tam olarak:

| Alan | Validation |
| --- | --- |
| clientActionId | Trimmed non-empty 1–255 string; browser UUID üretir, server mevcut action-ID semantiğini zorla UUID'ye daraltmaz |
| expectedReviewVersion | Integer 0..2147483647; absent review için 0; current max değerde artış 409 REVIEW_VERSION_LIMIT ile engellenir |
| expectedEvidenceRevision | `ev1.<keyId>.<43-char base64url digest>`; <=128 chars; canonical base64url doğrulanır |
| matchingRuleVersion | Version-format string; active version ile transaction içinde eşitlik gerekir |
| decision | CONFIRMED_DUPLICATE veya DISMISSED |
| reasonCode | Design SD-5 outcome/reason eşleşmesi; free text yok |

```json
{
  "clientActionId": "40000000-0000-4000-8000-000000000001",
  "expectedReviewVersion": 0,
  "expectedEvidenceRevision": "ev1.testkey.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "matchingRuleVersion": "crm-duplicate-v1",
  "decision": "CONFIRMED_DUPLICATE",
  "reasonCode": "SAME_OPERATIONAL_CUSTOMER_VERIFIED"
}
```

Fresh başarı ve exact replay aynı immutable body ile 200:

```json
{
  "reviewId": "20000000-0000-4000-8000-000000000001",
  "pair": {
    "customerAId": "10000000-0000-4000-8000-000000000001",
    "customerBId": "10000000-0000-4000-8000-000000000002"
  },
  "reviewVersion": 1,
  "eventId": "30000000-0000-4000-8000-000000000001",
  "eventKind": "DECISION_RECORDED",
  "resultingStatus": "CONFIRMED_DUPLICATE",
  "reasonCode": "SAME_OPERATIONAL_CUSTOMER_VERIFIED",
  "actorUserId": "50000000-0000-4000-8000-000000000001",
  "occurredAt": "2026-10-19T10:00:01.000Z"
}
```

Body current aggregate değildir; daha sonra reopen olmuşsa replay yine version 1 olayının sonucunu döndürür. UI GET ile güncel durumu okur. Replay bilgisi body'yi değiştirerek verilmez; gerekirse HTTP `Idempotency-Replayed: true` header'ı kullanılır.

Command hash discriminator `CRM_DUPLICATE_DECISION:v1`; namespace Design SD-6.2. Role guard her replay request'inde yeniden uygulanır. Already-completed replay, yeni source stale/missing olsa da raw kişisel veri taşımayan kendi command sonucunu döndürebilir. Fresh request'te source/evidence/version/state tekrar doğrulanır. Receipt lookup'u customerCurrent DTO'sunu saklama/geri döndürme yolu değildir.

## API-6 — Reopen command

Aynı pair path'inde body: `clientActionId,expectedReviewVersion,expectedEvidenceRevision,matchingRuleVersion`. Decision/reason/free text alanı kabul edilmez. Server event reason'unu SD-5'e göre verir.

```json
{
  "clientActionId": "40000000-0000-4000-8000-000000000002",
  "expectedReviewVersion": 1,
  "expectedEvidenceRevision": "ev1.testkey.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "matchingRuleVersion": "crm-duplicate-v1"
}
```

CommandReceipt aynı alanlarla, `eventKind=REVIEW_REOPENED`, `resultingStatus=PENDING_REVIEW`, `reasonCode=RECHECK_REQUESTED` ve yeni version döner. Eski event değişmez. Fresh veya stale terminal review yeniden açılabilir; pending review'e yeni key ile reopen 409. Aynı key replay ikinci event yazmaz.

Matching rule değişmişse manager önce active version/evidence'i GET ile görür, sonra reopen eder. Eski formun rule version'ı otomatik değişmez.

## API-7 — History

History `limit` default 20/max 50. Cursor review ID, org, upperSeq, beforeSeq, issuedAt ile imzalanır. İlk sayfadaki upperSeq subsequent history sayfalarında sabit kalır. `seq DESC` ve <beforeSeq; offset kullanılmaz.

```json
{
  "reviewId": "20000000-0000-4000-8000-000000000001",
  "upperSeq": 1,
  "items": [
    {
      "eventId": "30000000-0000-4000-8000-000000000001",
      "seq": 1,
      "eventKind": "DECISION_RECORDED",
      "resultingStatus": "CONFIRMED_DUPLICATE",
      "reasonCode": "SAME_OPERATIONAL_CUSTOMER_VERIFIED",
      "actorUserId": "50000000-0000-4000-8000-000000000001",
      "occurredAt": "2026-10-19T10:00:01.000Z",
      "matchingRuleVersion": "crm-duplicate-v1",
      "matchingCodes": ["SAME_NAME_AND_PHONE"],
      "warnings": []
    }
  ],
  "nextCursor": null
}
```

Yeni event'ler sonraki fresh ilk sayfa GET'inde görünür. Missing/cross-org review 404 DUPLICATE_REVIEW_NOT_FOUND. Aktör/subject ID'leri başka User/Customer kaydına erişim hakkı vermez. No raw audit JSON, HMAC bytes, raw historical evidence veya full profile data.

## API-8 — Error contract

Mevcut serializer korunur: `{error:string,code:string,details?:object}`; yeni nested error framework yok.

400 VALIDATION_ERROR bu feature'ın explicit AppError semantic parser hatalarıdır. Fastify parsing/origin lifecycle kendi önceki sırasını korur: current serializer non-AppError/non-429 framework error'larını 500'e map eder (Design RC-08 source gözlemi; HTTP reproducer NOT_RUN). Bu paket malformed JSON için yeni 400 davranışı vaat etmez veya global serializer'ı genişletmez. Bu erken hatalarda da source query/mutation yok, yeni route no-store hook'u test edilir.

| HTTP / code | Anlam / client action |
| --- | --- |
| 400 VALIDATION_ERROR | Alan formatı/allowlist/reason uyumsuz; fieldErrors ile güvenli açıklama |
| 401 / 403 FORBIDDEN | Mevcut auth veya management deny; başka kayda fallback yok |
| 404 DUPLICATE_PAIR_NOT_FOUND | Bilinmeyen/foreign/out-of-scope source veya yeni non-candidate pair |
| 404 DUPLICATE_REVIEW_NOT_FOUND | Tarihsel review ID bilinmiyor/foreign |
| 409 VERSION_CONFLICT | Expected review version uyuşmuyor; conflict reload gerekir |
| 409 EVIDENCE_CHANGED | GET kanıtı fresh POST ile aynı değil; sıfır committed review/event/audit/receipt |
| 409 MATCHING_RULE_CHANGED | Form eski rule version'a bağlı |
| 409 EVIDENCE_KEY_UNAVAILABLE | Fresh expected token key'i online değil; receipt bulunmadı ve rollback doğrulandı. Draft korunur; yeni GET/insan incelemesi sonrası yeni intent gerekir |
| 409 REVIEW_REOPEN_REQUIRED | Terminal current/stale review'e doğrudan yeni decision |
| 409 REVIEW_ALREADY_PENDING | Fresh reopen geçersiz |
| 409 CLIENT_ACTION_REUSED | Aynı namespace/key farklı normalized intent; otomatik yeni key yok |
| 409 ACTION_IN_PROGRESS | Claim unique wait budget bitti veya existing processing receipt |
| 409 REVIEW_BUSY | Source/review row NOWAIT/lock conflict; aynı frozen intent ile retry |
| 409 CURSOR_RESTART_REQUIRED | Expired/capsamı/rule/source revizyonu değişmiş cursor; ilk sayfadan başlat |
| 409 REVIEW_VERSION_LIMIT | Integer version sınırı; fail-closed |
| 422 CANDIDATE_SCAN_LIMIT | Source cap aşıldı; başarılı kısmi/boş liste yok |
| 422 EVIDENCE_LIMIT_EXCEEDED | Contacts/address/bytes sınırı; usable revision yok |
| 429 RATE_LIMIT_EXCEEDED | Actor/org rate veya scan concurrency bütçesi; Retry-After |
| 503 EVIDENCE_UNAVAILABLE | Current evidence üretilemiyor; yalnız eski history key kaybı 200 UNVERIFIABLE projection, retired expected token ise fresh POST'ta 409'dur |
| 503 REVIEW_TEMPORARILY_UNAVAILABLE | Query/connection/deadline; client command sonucu belirsiz kalabilir |
| 500 INTERNAL_ERROR | Beklenmeyen/constraint/audit/receipt hatası; raw SQL yok |

```json
{
  "error": "Karşılaştırma bilgileri değişti. Güncel bilgileri inceleyip yeniden deneyin.",
  "code": "EVIDENCE_CHANGED",
  "details": {
    "reloadRequired": true
  }
}
```

Error detaylarında current raw alanlar, hash payload veya foreign kayıt bilgisi yok. Current reviewVersion yalnız güvenli scope kontrolü tamamlanmışsa opsiyonel hint olabilir; conflict çözümü yeni GET'tir.

Helper claim aşamasındaki 55P03 opt-in path'te ACTION_IN_PROGRESS'e, callback row lock 55P03 REVIEW_BUSY'ye çevrilir; her durumda rollback/release. 57014/connection problemleri 503; beklenmeyen integrity hatası 500. Replay için keyring varlığı callback'e kadar kontrol edilmez; completed receipt eski key olmadan da own safe sonucu verebilir.

Feature client sınıflandırması: REVIEW_BUSY/ACTION_IN_PROGRESS/429 geçici aynı intent; NETWORK_ERROR/INVALID_RESPONSE/5xx unresolved frozen intent; VERSION/EVIDENCE/RULE conflict ve EVIDENCE_KEY_UNAVAILABLE kesin no-commit + explicit reload. Generic ApiError serializer'ına “her 409 retryable” kuralı eklenmez.

## API-9 — Realtime, audit and compatibility

GET: realtime/audit/idempotency effects yok. Fresh POST: SD-6 transaction'ında DM-5 audit + receipt. Replay: yeni event/audit/realtime yok.

İlk 4A sürümünde yeni SSE event type/entity eklenmez. CRM review JobCard.updated olarak yayınlanmaz. Existing typed realtime parser'ları ve eski web bundle'ları değişmeden kalır. UI tazelik davranışı SD-7.1'dir; POST doğruluğu bildirim gelmesine bağlı değildir.

Request logger yeni body veya query value loglamaz; evidence/action token'ları ve secret config redacted/omitted olmalı. Mevcut origin/CSRF, auth cookie ve rate-limit altyapısı kullanılır; rate key actor/org bilgisini auth sonrasında okur. Candidate payload'ına Staff-confidential, full JobCard notes veya message bodies hiçbir endpoint'ten taşınmaz.

60 saniyelik refresh ve key-custody/rotation kararı Design SD-7.1/SD-4.4 SSOT'udur. PR1 yalnız candidate/comparison GET yayımlar; virtual version=0, allowedActions=[] ve review/history/audit/receipt yazısı yoktur. 20k cap sadece global candidate source scan'indedir; bilinen uygun pair comparison'ı ve ilerideki register bu cap'e bağlanmaz.

Yeni yollar mevcut response'lara additive alan dayatmadığı için eski CRM/JobCard API'lerinin enum parse sözleşmesi genişletilmez. Rollout yeni schema ile release startup guard'ına uyar; detaylı sıralama Implementation Plan'dadır.

