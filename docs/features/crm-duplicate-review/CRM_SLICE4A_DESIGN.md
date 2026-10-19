# CRM Slice 4A — Duplicate Customer Review Design

**Durum:** `CRM_SLICE4A_DESIGN_ACCEPTED_FOR_IMPLEMENTATION` — final teknik uzlaştırma tamamlandı; PR1 tasarım giriş kapısı açık. Bu documentation-only görev implementation başlatmaz.  
**Tarih:** 19 Ekim 2026, Europe/Istanbul  
**Baseline main:** `b761e9933973fa111278692366d92458e3fe8e95`  
**Tree:** `13de72060395c55a5d055e52239e6b331a6baaa4`  
**Discovery:** Orijinal kullanıcı artifact'i (harici kaynak: `CRM_SLICE4_DISCOVERY.md`; repository içinde dağıtılmıyor)

## SD-1 — Authority and document ownership

D1–D6 bu konuşmada kabul edilmiş ürün girdileridir; discovery'deki eski “karar bekleniyor” metni bunları geri almaz. Bu paket discovery'yi tekrarlamaz. Repository belgeleri değiştirilmedi. Tekil “CRM Slice 1” dosyası discovery'de de bulunmamıştı; temel CRM sözleşmesi ve DECISIONS.md'deki 2026-10-08 create kararı esas alındı.

| Belge | Tek sahibi olduğu sözleşme |
| --- | --- |
| Bu belge | D1–D6 eşlemesi; algoritma, evidence, state machine, lock protokolü, UX, tasarım kararları ve bulgular için SSOT |
| [API contract](CRM_SLICE4A_API_CONTRACT.md) | HTTP allowlist/DTO/error/pagination/receipt wire biçimi |
| [Data model](CRM_SLICE4A_DATA_MODEL.md) | Fiziksel tablolar, constraint/index ve SQL taslakları |
| [Test matrix](CRM_SLICE4A_TEST_MATRIX.md) | A01–A16'nın değişmeden korunması, test vakaları, ölçüm ve kabul kapıları |
| [Implementation plan](CRM_SLICE4A_IMPLEMENTATION_PLAN.md) | Sıralı kullanıcı davranışı dilimleri, dosya sahipliği, uygulama ve CI kapanışı |

Diğer belgeler bu belgenin domain kurallarını yeniden tanımlamaz. SQL/DTO karşılıklarının tutarlılığı uygulama testleriyle korunacaktır. Kullanıcının koşullu kabulündeki teknik açıklar bu final uzlaştırmada kapatıldı; T1–T5 kesinleştirildi. PR1 başlangıç koşulları Implementation Plan IP-1/IP-7 içindedir. Tasarım kabulü testlerin veya production işlemlerinin kabulü değildir.

| Kabul edilen karar | Tasarımdaki karşılığı |
| --- | --- |
| D1 | İnsan kararı; şube ayrı; SD-3 gerekçeleri kesin kimlik veya confidence değildir. Mevcut tax CHECK/unique aynen korunur. |
| D2 | İki CRM-owned tablo: review aggregate ve append-only events; audit ve processed-action receipt ayrı. GET hiçbirini oluşturmaz. |
| D3 | Bütün yeni API'ler ADMIN/MANAGER; STAFF reddi lookup öncesi. SD-5 sınırlı gerekçeler, explicit reopen, ertelemede sıfır yazı. |
| D4 | BUSINESS + aynı org + üç Customer durumu; mevcut JS normalizer'ları; bounded deterministic aday üretimi. Contact-only aday yok. |
| D5 | SD-4 semantic evidence; Customer/Contact sürümleri yalnız witness; GET ve POST aynı semantic kanıtı doğrular. |
| D6 | Review/history/audit/receipt dışında business mutation yok. Pasifleştirme ayrı mevcut akış. |

4B, alias, merge, referential rewrite veya message consolidation tasarlanmaz. Discovery'nin 4B riskleri referansta korunur; burada çözümü genişletilmez. WR-01 ve Issue #369 kapsam dışıdır.

## SD-2 — Ownership and architectural choice

CRM modülü içinde odaklı `duplicate-review-service.ts`, `duplicate-review-repository.ts`, `duplicate-evidence.ts`, `duplicate-candidates.ts` ve tip/parser dosyaları önerilir. Mevcut `crm/routes.ts` bunları wire eder. Yeni bağımsız modül, queue, worker, projection-sync sistemi, framework veya dependency gerekmez.

**Seçilen ilk sürüm:** SQL kapsamlı ve sınırlı ham veriyi okur; mevcut JavaScript normalizer'ları eşleştirmenin tek uygulamasıdır. SQL'de ikinci telefon/fold fonksiyonu veya normalized-key projection tablosu oluşturulmaz. Bu, bütün Customer writer'larına senkronizasyon hook'u ekleme ihtiyacını ve JS/PG Unicode ayrışmasını önler.

Bedeli açıktır: candidate isteği kuruluşun BUSINESS kayıtlarını aşağıdaki sert üst sınıra kadar doğrusal okur. Bu sınırsız ölçek iddiası değildir. Uygulama benchmark'ı veya beklenen kuruluş hacmi bu bütçeyi karşılamazsa daha geniş indeksli projection tasarımına geçmek için bu teknik karar yeniden incelenir; sonuçlar gizlice kırpılmaz.

## SD-3 — Candidate algorithm and work bounds

### SD-3.1 — Canonical values and reasons

Customer adında `foldCustomerSearchText(value.trim())`; e-postada mevcut trim/lowercase; adres bileşenlerinde trim + aynı fold kullanılır. İç boşluk, noktalama, şirket eki, aksan veya Unicode composition için ek eşitleme yapılmaz. Boş folded sonuç olumlu kanıt değildir.

Telefon eşitliği yalnız iki dolu `normalizeTurkishPhone` sonucu üzerinden tam eşitliktir. `digitsOnly`, phone search substring'i veya `phoneDigitVariants` identity karşılaştırması değildir. Tax mevcut `normalizeTaxNumber` ile yalnız çelişki uyarısına katılır; duplicate politikası değişmez.

İki kayıt için N=aynı dolu folded isim, P=aynı geçerli canonical telefon, E=aynı dolu lowercase e-posta, A=şehir/ilçe/adresin **üçü de dolu** ve her biri tam eşit olsun:

| Kod | Koşul |
| --- | --- |
| SAME_NAME_AND_PHONE | N ve P |
| SAME_NAME_AND_EMAIL | N ve E |
| SAME_NAME_AND_ADDRESS | N ve A |
| SAME_PHONE | P ve N değil |
| SAME_NAME | N var ve yukarıdaki birleşik gerekçelerin hiçbiri yok |

Birden çok birleşik gerekçe aynı anda dönebilir; bağımsız kanıt sayısı veya confidence üretilmez. Gerekçe sırası tablodaki sıradır. İki dolu farklı canonical tax varsa ayrı `CONFLICTING_TAX_NUMBERS` uyarısı gelir. Contact benzerlikleri sadece karşılaştırmada destek olarak etiketlenir.

Customer ve Contact üzerinde tekrarlanan aynı canonical telefon tek ortak iletişim değeri olarak açıklanır; Contact tekrarından ikinci bağımsız kanıt/kod veya yeni pair üretilmez.

**Aday uzayının tamamı N veya P'dir.** E ve A birleşik kodları N'nin alt kümesidir; dolayısıyla beş kurala rağmen yalnız isim ve telefon bucket'ları aday üretmek için yeterlidir.

### SD-3.2 — Pair enumeration

1. Authenticated org'un BUSINESS Customers kayıtlarını UUID sıralı oku; prospect/active/inactive tamamı dahil.
2. JS'de `nameKey -> sorted customer IDs`, `phoneKey -> sorted customer IDs` map'leri kur. Geçersiz/eksik key bucket'a girmez.
3. Anchor A'ları UUID artan sırada dolaş. A'nın isim ve telefon bucket'larındaki B>A üyelerini iki sorted iterator ile merge et. Aynı B iki bucket'ta varsa bir kez çıkar.
4. Pair kimliği `(organizationId, minUUID, maxUUID)`. Karşılaştırma lowercase canonical UUID byte/text sırasıdır; localeCompare kullanılmaz.
5. Global sıra `(customerAId ASC, customerBId ASC)`; isim veya confidence'a göre bütün çiftleri sıralama yok.
6. Cursor'dan sonraki anchor/partner binary search ile bulunur. Tüm kombinasyonlar üretilip sonra slice edilmez.
7. `anchorCustomerId` varsa yalnız anchor'ın iki bucket'ındaki komşular merge/dedup edilir; küçük UUID partner'lar `(partner,anchor)`, büyükler `(anchor,partner)` olarak iki sıralı bölümden çıkar. Global pair iterator'ı üretip sonra anchor filtresi uygulamak yasaktır. Bu yol O(N) komşu uzayı + sayfa bütçesidir; global source okumasını/cap'ini kaldırmaz. `rawPairCount` seçili anchor kapsamının sayısıdır.
8. Her raw batch için review head, Customer facts ve ilgili Contact setleri toplu okunur; eski kararın freshness'ı kontrol edilmeden ret sonucu gizlenmez.

Ham çift sayısı gerekirse bucket kombinasyonlarından hesaplanır: isim çiftleri + telefon çiftleri − aynı isim/telefon kesişim çiftleri. Sayaç hesaplamak çiftleri materialize etmez. Attention sonrası kesin total sayılmaz.

### SD-3.3 — Budget SSOT

Bunlar T1 kapsamında kesinleşen V1 kaynak ve iş bütçeleridir; ölçülmüş performans sonucu veya kullanıcı ayarı değildir. T5 latency/RSS sayıları başlangıç ölçüm hedefidir.

| Sabit | Değer / davranış |
| --- | --- |
| SOURCE_CUSTOMER_LIMIT | 20.000 BUSINESS Customer; 20.001'inci satır overflow sentinel |
| PAGE_SIZE | default 20, max 20 |
| PAIR_EVALUATION_BUDGET | İstek başına en fazla 32 raw çift |
| CONTACT_LIMIT | Customer başına 200; 201'inci satır overflow sentinel; aktif/pasif birlikte |
| ADDRESS_BYTE_LIMIT | Customer başına 16 KiB; uzun alan truncate edilerek karşılaştırılmaz |
| EVIDENCE_BYTE_LIMIT | Pair canonical evidence UTF-8 için 2 MiB |
| READ_STATEMENT_TIMEOUT | 2 saniye |
| COMMAND_LOCK_TIMEOUT | 250 ms; row lock'larda ayrıca NOWAIT |
| COMMAND_STATEMENT_TIMEOUT | 2 saniye |
| REQUEST_DEADLINE | 5 saniye; iptal sonrası rollback/release |
| CURSOR_TTL | 15 dakika |
| LIST_POLL / DETAIL_POLL | Görünür ekranda 60 saniye; yeni global timer altyapısı yok |
| RATE_LIMIT | Auth + yönetim guard sonrası actor/org: list 6/min, detail/history 20/min, command 10/min; entegrasyon SD-6.1.1 |
| INFLIGHT_SCAN_LIMIT | Process/org başına 2 candidate taraması; kapasite doluysa 429 |

Her data query öncesinde LOCAL statement_timeout, min(2 saniye, kalan request bütçesi) olarak ayarlanır; art arda sorgular 5 saniyelik toplam deadline'ı aşmak için ayrı bütçe kazanmaz. CPU grouping/serialization döngüleri bounded checkpoint'lerde deadline'ı kontrol eder. PoolClient geç alınırsa deadline sonrası hemen release edilir; client'a hata dönüp arkada sahipsiz sorgu bırakılmaz.

Global source sınırı aşılırsa `CANDIDATE_SCAN_LIMIT`: **başarılı eksik liste dönmez**. Optional anchor için DM-6.1 org/BUSINESS eligibility point gate önce uygulanır; geçersiz anchor her hacimde 404, uygun anchor + cap aşımı 422 alır. Bilinen iki ID'nin karşılaştırması ve persistent review listesi global scan gerektirmez. CONTACT/ADDRESS/EVIDENCE sınırı aşan pair listede “kanıt bütünü doğrulanamadı” olarak kalır, eski ret yüzünden gizlenmez; karar devre dışıdır. Tam kaynak okunmadan digest üretilmez.

Cursor son **tüketilen** raw çifti tutar; prefetched fakat ekrana verilmemiş/filtrelenmemiş sonraki çiftler atlanmaz. 32 çift incelenip hepsi güncel eski karar nedeniyle gizlenirse `items:[]`, `exhausted:false`, `nextCursor` döner. UI bunu “mükerrer yok” diye yorumlamaz.

Read complexity: kaynak grouping/sıralama O(N log N); sayfa başına pair değerlendirmesi sabit bütçeli; bellek O(N + bounded evidence). N² pair tablosu/SQL JOIN/sort yok. 20.000 aynı ismin 199.990.000 çift oluşturması yalnız bir sayaç ve lazy iterator maliyetidir. Bütün adayları insanın inceleyebilmesi iddia edilmez; büyük bucket uyarısı ve anchor filtresi sunulur.

### SD-3.4 — Paging consistency

GET içinde READ ONLY REPEATABLE READ: Customer, Contact ve review head aynı snapshot'tandır. Cursor HMAC ile org/filter/rule/source-key revision ve son çift kimliğine bağlanır; raw telefon/isim taşımaz.

Source-key revision, bütün taranan ID/nameKey/phoneKey/status tuple'larının deterministic digest'idir. Pair uzayı/filtre değişirse cursor 409 ile yeniden başlatılır. Sayfalar arasında uzun yaşayan DB snapshot tutulmaz. Contact/review değişikliği aynı pair sırasını koruyup attention üyeliğini değiştirebilir; live pagination'da geçmiş cursor bölgesine yeni giren sonuçlar ilk sayfadan yenilemede görünür. Bu sınırlama UI'de açık olmalıdır. Listede yenileme düğmesi vardır; sonraki sayfalarda otomatik başa atlayıp focus kaybettirilmez.

## SD-4 — Evidence revision

### SD-4.1 — Semantic content

Evidence ile concurrency witness farklıdır.

| Kaynak | Evidence'e dahil |
| --- | --- |
| Kimlik | Org ID, canonical pair ID'leri, evidence schema version, matching rule version |
| Customer | Customer ID, folded name, phone tuple, lowercase email, folded city/district/address, canonical tax, customerType |
| Contact set | **Bütün** aktif/pasif Contact ID'leri; her birinde folded name/title, phone tuple, lowercase email, isPrimary, isActive |
| Witness olarak gösterilir; digest'e girmez | Customer.version, Contact.version |
| Identity evidence değildir | assigned Staff, status (üçü de kapsamda), createdAt/updatedAt, operasyon sayıları, JobCard/mesaj/not içerikleri |

BUSINESS/org uygunluğu her okumada ayrıca doğrulanır. Customer status değişimi aynı operasyonel müşterinin kimliğini değiştirmez; list filter revision değişebilir fakat eski karar sırf bu nedenle stale olmaz. CustomerType karar ekranındaki kimlik sınıflandırmasıdır ve semantic değişikliği stale yapar.

Phone tuple: boş değer `["MISSING",null]`; geçerli değer `["TR",canonical]`; dolu çözümlenemeyen tarihsel metin `["UNUSABLE",trimmedRaw]`. Böylece iki ayrı bilinmeyen telefon metni aynı null digest'e çökmez; fakat positive phone evidence de üretmez.

Contact sürümü değişmiş ama kullanılan semantic alanlar aynıysa karar geçerli kalır. Kişi ekleme/silme, farklı ID, alan, primary veya active değişimi digest'i değiştirir. Version/updatedAt tek başına stale sebebi değildir. Alanın yalnız mevcut normalization'a göre eşdeğer gösterim değişimi de stale değildir. A12'deki “versions” yeniden semantic değerlendirmeyi atlamama yükümlülüğüdür; her version artışını invalidation sayma şartı değildir. A12'nin D5 ile bağlayıcı yorumu Test Matrix TM-1.1'de; EVID-04 bunun no-op karşılığıdır. Version değişmemiş olsa bile semantic değişim tespit edilir; version cache'i digest hesabını atlatamaz.

### SD-4.2 — Serialization and digest

UTF-8 JSON, sabit konumlu array'ler:

```text
[
  "CRM_DUPLICATE_EVIDENCE", 1, matchingRuleVersion, organizationId,
  customerAId, customerBId,
  customerTupleA, customerTupleB
]
customerTuple = [
  id, foldedName, phoneTuple, emailKey, cityKey, districtKey,
  addressKey, canonicalTax, customerType, contacts
]
contactTuple = [
  id, foldedName, foldedTitle, phoneTuple, emailKey, isPrimary, isActive
]
```

Customer sırası canonical A/B; Contact sırası global lowercase UUID. Null açık null; undefined yok; tarih, float, locale sort veya property-order varsayımı yok. contact version veya kaynak updatedAt serialization'a gizlice eklenmez. Aynı fonksiyon GET, POST ve stale hesaplamasında kullanılır.

`evidenceRevision = ev1.<keyId>.<base64url(HMAC-SHA256(key, canonicalBytes))>`. Düşük entropili telefon/adres için düz SHA256 kullanılmaz. HMAC anahtarı DB'den ayrı deployment secret'ıdır; token bir authorization capability değildir. Karşılaştırma constant-time yapılır. Log/audit'te raw payload veya evidence token yazılmaz.

Cursor ve source-key revision aynı keyring'i kullanabilir, fakat canonical mesajları ayrı `CRM_DUPLICATE_CURSOR:v1` ve `CRM_DUPLICATE_SOURCE_KEYS:v1` discriminator'larıyla başlar. Evidence, cursor ve semantic request hash domain'leri birbirinin yerine doğrulanmaz.

Keyring somut config sözleşmesi: tek `CRM_DUPLICATE_EVIDENCE_KEYRING` secret değeri; `activeKeyId` ve en fazla iki `keys` girdisi, her biri base64 32-byte key. Üretimde fallback/default/random yeniden üretme yok. Testler synthetic key'i dependency olarak verir; repository veya evidence bundle gerçek key içermez. Route'lar register edildiğinde config validation fail-closed olur. Key provision/deploy bu görevde yapılmaz.

Yeni GET token'ı active key ile üretir. Mevcut kararın freshness'ı **o kararın keyId'siyle** yeniden hesaplanır; key rotasyonu tek başına veri değişimi sayılmaz. Online önceki key rutin rotasyonda current-head bağımlılıkları ve SD-4.4 preflight'ı ile korunur; daha eski key'ler ayrı şifreli arşivde tutulur. Client'taki bütün unresolved attempt'lerin sunucudan sayılabileceği varsayılmaz. Eksik eski key `UNVERIFIABLE` durumudur, “fresh” veya “veri kesin değişti” denmez; ret gizlenmez. Completed receipt replay'i yeniden evidence hesaplamaz, bu nedenle eski key kaybı daha önce committed sonucu ikinci kez çalıştırmaz.

Yalnız geçmiş kararın key'i eksikse, güncel active key ve tam kaynak mevcut olduğu sürece comparison 200 dönebilir: eski kararın freshness'ı UNVERIFIABLE/KEY_UNAVAILABLE kalır. Yönetici güncel kanıta bağlanan explicit REOPEN ile yeni pending cycle açabilir; eski karara CURRENT etiketi verilmez. Güncel formun expectedEvidenceRevision key'i online keyring'de yoksa fresh command, receipt replay kontrolünden ve başarılı rollback'ten sonra 409 EVIDENCE_KEY_UNAVAILABLE ile sıfır committed mutation bırakır. Bu ayrım key kaybını sessiz kabul veya kalıcı kurtarılamayan review'e dönüştürmez.

Matching-rule version ilk sürümde `crm-duplicate-v1`; normalize çıktısını değiştiren helper/runtime değişimi parity matrisi ve rule-version değerlendirmesi gerektirir. Aynı version altında yeni semantics deploy edilmez.

### SD-4.3 — Freshness

Persisted decision'ın rule version'ı güncelden farklıysa REVIEW_REQUIRED/RULE_CHANGED. Aynı rule + stored key ile current digest farklıysa REVIEW_REQUIRED/SOURCE_CHANGED. Aynıysa CURRENT. Key/bütçe/kaynak sorunu BLOCKED/UNVERIFIABLE; stale kararı taklit edilmez.

Eski kanıtın raw kişisel veri snapshot'ı tutulmaz. History yalnız ID, opaque digest/key/rule, gerekçe kodları, warning kodu, aktör ve zamanı saklar. Geçmişteki raw telefon/adresi audit'ten yeniden üretme hedefi yoktur; bu privacy tercihinin denetlenebilirlik sınırı review'da kabul edilmelidir.

### SD-4.4 — HMAC custody, rotation and recovery (T3 final)

**Accountable owner:** Servora-Med repository/production sahibi, bu görevin kullanıcı sahibi. **Responsible operator:** bu sahibin yetkilendirdiği deployment/backup işletmecisi; ayrı görev devri yoksa aynı sahip bu sorumluluğu üstlenir. CRM implementation sorumlusu config/redaction/synthetic test sözleşmesini uygular. Uygulamadaki ADMIN/MANAGER rolü secret erişimi veya rotasyon yetkisi vermez. Bu rol ataması production secret oluşturma/değiştirme onayı değildir.

- Runtime'da en fazla **active + previous = iki** key; bu sayı şifreli offline arşivin toplam key sayısını sınırlamaz. KeyId başka key bytes için tekrar kullanılmaz; yeni key 32 random byte'tır. Secret sadece işletmeci kontrollü app environment/secret kaynağındadır; source/release/DB/CI evidence/log/browser storage'a girmez. Config yüklenirken strict base64/32-byte/unique-ID/active-key üyeliği doğrulanır.
- Her ilk provision/rotasyon **öncesi** işletmeci keyId, lifecycle zamanı, active/previous durumu, encrypted bundle sürümü ve custody kaydıyla iki bağımsız şifreli kurtarma kopyası oluşturur; en az biri production host ve DB backup'ından ayrı failure domain'dedir. Decryption identity aynı arşiv/host içinde bulunmaz. Var olan age/operatör secret-custody usulü kullanılabilir; yeni backup servisi veya entegrasyon kurulmaz.
- Key arşivi, ilgili review history ve onu içeren DB backup'ları tutulduğu sürece korunur; otomatik süre sonu yoktur. Silme ancak repository/production sahibinin ayrıca kayıtlı retention kararıyla mümkündür. Key arşivi **DB yedeğinin içinde varsayılmaz**; mevcut backup manifest'ine secret eklenmez. Ham tarihsel müşteri kanıtı saklama politikası değişmez.
- **Rutin rotasyon:** operator önce current-head keyId sayımlarını ve restore edilebilir encrypted bundle'ı kontrol eder; keyId/count dışında müşteri verisi çıkarmadan sonucu kaydeder. Online'dan çıkarılacak key'e current head bağlıysa üçüncü key aktivasyonu; yönetici yeniden incelemeleriyle bağımlılıklar kapanana veya owner sayım/etkiyi görüp planlı UNVERIFIABLE etkisini kayıtla kabul edene kadar bekler. Silinmiş/over-budget source yüzünden yeniden açılamayan head rutin rotasyonu sonsuza dek kilitlemez; owner bu etkiyi ayrıca kabul edebilir. Yönetici mevcut REOPEN/DECIDE ile kanıtı inceler; operator toplu re-sign/history UPDATE yapmaz. Preflight kapanınca yeni active + önceki active atomik config/release değişimiyle yüklenir; eski key arşive geçer. Bu operator runbook kapısıdır; yeni uygulama API'si veya otomatik head migration'ı değildir. Rollout'ta farklı keyring'lerle eşzamanlı writer bırakılmaz.
- Client unresolved attempt sayısı bilinemez. Arşive alınmış key'e bağlı gecikmiş fresh POST için completed receipt önce replay edilir; receipt yoksa 409 EVIDENCE_KEY_UNAVAILABLE açık no-commit cevabıdır. UI taslağı koruyarak yeni GET ve insan incelemesinden sonra yeni intent oluşturabilir. Key emekliliği sonsuz 503/frozen retry üretmez; generic network/5xx aynı intent ile unresolved kalır.
- **Kayıp/restore:** operator doğru bundle/keyId'yi ayrı custody kopyasından geri alır, bytes/keyId doğrulamasını isolated synthetic fixture'da yapar ve iki online slot kuralına göre config'i yükler. Current head'leri etkileyen slot değişikliği rutin preflight'a tabidir. DB restore'dan önce snapshot'ın current-head keyId bağımlılıkları ve secret bundle birlikte doğrulanır; DB dump'ın tek başına freshness kurtardığı iddia edilmez.
- **Geri getirilemeyen veya compromised key:** owner incident kararını kaydeder; o key kullanılmaz. Yetkili emergency retirement current-head bağımlılığı olsa da yapılabilir; etkisi UNVERIFIABLE + ATTENTION'dır. Active key + tam kaynakla yönetici explicit REOPEN yapabilir; eski event/audit silinmez veya CURRENT yapılmaz. Completed receipt aynı request için yine replay edilir. Gerçek secret recovery/rotation ve production restore bu doküman göreviyle yürütülmez.
- PR1: synthetic two-key/rotation/cursor testleri. PR2: current-head preflight, missing expected-key no-commit, historical-key UNVERIFIABLE, receipt replay ve synthetic backup/restore testleri. Gerçek custody kopyası ve restore kanıtı production enablement kapısıdır; uygulama CI PASS'inden türetilmez.

## SD-5 — Authoritative review state machine

**Stored state'in tek kaynağı aggregate'in (organizationId, reviewId, version) ile işaretlediği current event'idir.** Ayrı bir status cache güncellenmez. DTO current event'ten reviewStatus, currentDecision, actor/time/reason/evidence/rule üretir.

| Durum | İzinli işlem | Sonuç |
| --- | --- | --- |
| Aggregate yok; güncel pair aday | Leave for later | Sıfır yazı; virtual PENDING_REVIEW, version 0 |
| Aynı durum | DECIDE | Aggregate + seq/version 1 + DECISION_RECORDED; CONFIRMED_DUPLICATE veya DISMISSED |
| Stored PENDING_REVIEW | DECIDE | version +1; terminal review kararı |
| Stored CONFIRMED_DUPLICATE / DISMISSED, CURRENT | REOPEN | version +1; REVIEW_REOPENED ve PENDING_REVIEW |
| Aynı stored karar, SOURCE_CHANGED / RULE_CHANGED | REOPEN | Yeni GET kanıtına açıkça bağlanan version +1; PENDING_REVIEW |
| Her stored terminal review | Doğrudan farklı yeni DECIDE | 409 REVIEW_REOPEN_REQUIRED |
| Stored PENDING_REVIEW | REOPEN | 409 REVIEW_ALREADY_PENDING; aynı key replay hariç |
| Her durum | Leave for later | Sıfır yazı |
| Source unavailable/out-of-scope/over-budget | DECIDE veya REOPEN | Blok; source'a dokunma, geçmişi silme |

Terminal burada yalnız review kararıdır; Customer/JobCard lifecycle anlamı taşımaz. Stored terminal kararın semantic evidence'i değişince `effectiveStatus=REVIEW_REQUIRED` hesaplanır; GET stored state/version/history'yi güncellemez. Reopen açık insan komutudur. Pending cycle sırasında kaynak değişirse yeni GET'teki kanıt incelenmeden karar kaydedilemez.

Projection önceliği: source uygun/mevcut değilse UNAVAILABLE; tam current evidence üretilemiyorsa BLOCKED; terminal kararın eski key'i doğrulanamıyorsa BLOCKED + UNVERIFIABLE (SD-4.2'deki explicit REOPEN kurtarma yolu açık); doğrulanabilir terminal karar stale ise REVIEW_REQUIRED; diğer hallerde stored status. Pending current event'in evidence'i eskimişse currentDecision yoktur, freshness STALE gösterilir fakat effectiveStatus PENDING_REVIEW kalır; DECIDE güncel GET revision'ını gerektirir. İlk event DECISION_RECORDED, devamı terminal→REVIEW_REOPENED→DECISION_RECORDED olarak strict alternation'dır; reopened head'in lastDecision'ı seq=version−1 event'idir.

Bir zamanlar aday olup artık N/P eşleşmesi olmayan persistent pair kaybolmaz: ayrı review register'da görünür, compare “güncel eşleşme gerekçesi yok” der. İki mevcut BUSINESS Customer için explicit reopen ve yeni insan kararı mümkündür. Aggregate'siz yeni pair'de ilk karar için güncel aday koşulu gerekir.

| Decision / command | Allowed reason codes |
| --- | --- |
| CONFIRMED_DUPLICATE | SAME_OPERATIONAL_CUSTOMER_VERIFIED |
| DISMISSED | DISTINCT_BRANCH, DISTINCT_CUSTOMER, SHARED_CONTACT_DETAILS, INSUFFICIENT_EVIDENCE |
| REOPEN | RECHECK_REQUESTED — sunucu tarafından sabitlenir |

CONFIRM/DISMISS reason seçimi açık zorunludur; önseçim/serbest metin yok. Tek confirm reason kasıtlıdır; manager'ın insan doğrulamasını temsil eder, bir otomatik eşleşme kanıtı değildir.

## SD-6 — Authorization, transaction and lock protocol

### SD-6.1 — Boundaries

Session/CSRF/origin kontrolleri mevcut sisteme aittir. Yeni bütün endpoints ADMIN/MANAGER-only; STAFF reddi pair/review sorgusundan önce 403. Org client'tan alınmaz. Bilinmeyen/yabancı/out-of-scope Customer pair aynı 404 şekline sahiptir. Aynı org'daki eski review history, source silinse bile sadece güvenli tarihsel ID/event verisiyle okunabilir.

Kararlar Customer, Contact, JobCard veya bunların business version'larını değiştirmez. Source row lock'ları logical field UPDATE değildir; fiziksel lock metadata'sının hiç yazılmadığı iddia edilmez.

### SD-6.1.1 — Authenticated rate-limit integration

Exact-main'de app.ts plugin'i `global:false` ile kaydeder; auth/routes.ts ve middleware.ts kimliği preHandler'da çözer. Pinned rate-limit 11.2.0 varsayılanı onRequest; mevcut session-cookie hash anahtarı aktör kotası değildir. Manuel hook desteği pinned [plugin source](https://raw.githubusercontent.com/fastify/fastify-rate-limit/v11.2.0/index.js) ve [types](https://raw.githubusercontent.com/fastify/fastify-rate-limit/v11.2.0/types/index.d.ts) ile doğrulandı.

**Seçim:** mevcut `app.rateLimit(...)` hook factory'si; yeni limiter/dependency/Redis yok. Yeni route'larda `config.rateLimit=false`; preHandler sırası **authenticateDomain → shared CRM management guard → tek class limiter**. Handler/service parser, org-scoped source query ve scan semaphore sonra gelir. Service aynı saf `requireDuplicateReviewAccess(actor)` politikasını da uygular; route guard bunun request wrapper'ıdır. STAFF yönetim guard'ında reddedilir, manager bucket'ı veya source lookup çalışmaz. Origin/password-change/session kontrolleri korunur.

```ts
// Contract sketch only; not a repository implementation.
const listLimiter = app.rateLimit({
  max: DUPLICATE_LIMITS.listPerMinute,
  timeWindow: 60_000,
  skipOnError: false,
  keyGenerator: (request) => JSON.stringify([
    'CRM_DUPLICATE_LIST:v1',
    request.currentUser!.organizationId,
    request.currentUser!.id,
  ]),
});
app.get('/customers/duplicate-candidates', {
  config: { rateLimit: false },
  preHandler: [options.authenticate, requireManagement, listLimiter],
}, handlers.listCandidates);
```

Üç class limiter, CRM route registration sırasında **birer kez** kurulur ve ilgili endpoint'lerce paylaşılır; request başına yeniden kurulmaz. Identity `(class, authenticated organizationId, authenticated actorId)`'dir; session/cookie/IP/path/query/pair key değildir. List= candidate+register; detail=compare+history; command=decide+reopen. Kotalar SD-3.3'ten gelir. Aynı actor'ın iki session'ı aynı quota'yı paylaşır; başka actor/org bağımsızdır. Bu composite actor/org kimliğidir, ayrı org-geneli dakika kotası iddiası yoktur; ağır scan'lerde ayrıca process/org iki inflight sınırı vardır.

Plugin'in request işaretçisi ikinci hook'u atlayabildiğinden bu route'larda otomatik onRequest limiter + manuel limiter birleştirilmez, iki manuel rateLimit hook'u zincirlenmez. Global login/web-push limit ayarları taşınmaz. Tek process local store kullanılır; restart reset'i ve çok process için ayrı kotalar açık sınırdır. Deployment topolojisi çoğaltılırsa bu varsayım tekrar incelenir.

429 mevcut serializer'dan RATE_LIMIT_EXCEEDED ve Retry-After ile döner. Yeni route'ların paylaştığı route-owned onSend hook'u Cache-Control:no-store ekler; authentication/limiter/origin/parse error response'larında da çalıştığı RATE-01/05 testinde doğrulanır. Global error handler veya mevcut auth route'larının cache politikası değiştirilmez. UI Retry-After süresince poll/retry'ı duraklatır; 429 command key/payload değiştirmez. Store error fail-closed'dur. Identity key/cookie loglanmaz. Limiter/inflight counter'ları geçici bellektir, GET'in business/review/audit/receipt salt okunurluğunu bozmaz.

### SD-6.2 — Critical action reuse

Mevcut `runCriticalAction`, `job-cards/repository.ts` içinde raw PoolClient callback'i ile zaten çalışıyor; başka tüketicisi weekly recurrence. CRM'in JobCard transaction/repository ailesini import etmesi yerine helper ve ilgili claim/result tipleri dar bir `server/src/db/critical-action.ts` dosyasına davranış korunarak taşınsın. Eski export re-export ile korunsun. Yeni generic command framework yapılmasın.

CRM için gereken küçük uyarlama: BEGIN sonrası **claim INSERT'ten önce** transaction-local lock/statement timeout seçeneği. Default timeout davranışı diğer çağrılarda değişmez. Zaman aşımı claim'in unique index beklemesini de kapsar; callback içinde timeout çok geçtir. Dar extract'te receipt-completion UPDATE'i RETURNING id ve tam bir rowCount kontrolüyle doğrulanır; sıfır/başka sonuç throw + rollback'tir. Başarılı legacy response/hash/namespace semantiği korunur; bu invariant kontrolü legacy regression testleriyle de doğrulanır.

Operation namespaces DECISION için `CRM_DUPLICATE_DECISION`, REOPEN için `CRM_DUPLICATE_REOPEN`. Hash, sabit array ile command discriminator/version, org, actor, canonical pair, expectedReviewVersion, expectedEvidenceRevision, matchingRuleVersion ve decision/reason'u kapsar. SHA256 burada semantic request kimliğini hash'ler; raw evidence hash'i değildir.

### SD-6.3 — Fresh POST sequence

READ COMMITTED; tek PoolClient; helper'ın tek transaction'ı:

1. Request exact-allowlist/UUID/key/version/reason biçimini doğrula; session/management guard. BEGIN, LOCAL timeouts, receipt claim.
2. Completed same-key/same-hash receipt varsa callback çalışmadan immutable command sonucu dön. Current evidence veya review sürümü bu replay'i engellemez. Changed hash/null historical hash fail-closed.
3. Fresh callback'te actor User satırını FOR SHARE NOWAIT kilitle; active/role/org yeniden doğrula. Receipt FK'si nedeniyle oluşan önceki User key-share kilidi de aynı ilk row type içindedir.
4. İki Customer'ı canonical UUID sırasıyla **FOR UPDATE NOWAIT** kilitle; org/BUSINESS/mevcudiyeti doğrula. İkisinden biri yoksa rollback + 404.
5. Parent kilitleri altında Contact membership'i bounded oku. Her parent için sentinel kontrol et; fazla ise rollback. Sonra bilinen bütün Contact ID'lerini **global Contact UUID sırasıyla FOR SHARE NOWAIT** kilitle; current alanları bu locked row'ların kendisinden al. Silinmiş/taşınmış üyeyi eski ön-okuma sonucundan kopyalama.
6. Canonical evidence'i current locked facts'tan yeniden hesapla. Expected matching rule/key ve evidence ile karşılaştır. Uyuşmazlıkta review/event/audit/receipt dahil **committed mutation yok**.
7. Review head'i pair unique key ile FOR UPDATE NOWAIT oku. Yoksa yalnız expectedReviewVersion=0 kabul et; insert'i evidence doğrulandıktan sonra yap. Varsa tam version eşitliği ve SD-5 geçişini doğrula.
8. UUID event ID'si üret; event'i append et; head'i expected version predicate ile version+1'e atomik güncelle; yeni version yeni event seq'sini işaretler. İlk insert de aynı pair UNIQUE ile korunur.
9. Aynı transaction'da yeni doğru management audit'ini yaz, helper receipt response'unu complete et ve tam bir receipt satırının tamamlandığını doğrula. `SET CONSTRAINTS customer_duplicate_reviews_current_event_fk IMMEDIATE` ile current-event bağını doğrula; sonra COMMIT. Audit, receipt veya constraint hatası tüm fresh claim/event/head yazılarını rollback eder.
10. HTTP 200 immutable receipt sonucu; UI canonical GET yapar. Commit öncesi network/realtime yan etkisi yok.

Current source facts, kilitli User/Customer/Contact satırlarıyla commit'e kadar korunur; snapshot dışı canlı alanlar digest'e sonradan karıştırılmaz. Source'a update veya version bump yapılmaz. Review row'larından sonra User/Customer/Contact kilidi istenmez.

### SD-6.4 — Race and phantom analysis

Customer FOR SHARE yerine FOR UPDATE seçilmesi bilinçlidir: mevcut immediate Contact→Customer FK insert'inin parent key-share kilidiyle çatışır; yalnız mevcut Contact satırlarını kilitlemek yeni Contact phantom'unu engellemez. Contact FOR KEY SHARE non-key kişi alanı editlerini engellemez. Generic create/update/lifecycle/primary ve scoped create parent kilidi kullanır; **deleteContact parent kilidi almaz**, doğrudan Contact FOR UPDATE ile çalışır. Bu yolun güvenliği final Contact FOR SHARE NOWAIT ve current membership hesabından gelir. Importer/raw FK insert de parent kilidiyle serialize olmalıdır. Bunlar gerçek PostgreSQL 17 testleriyle kanıtlanacak tasarım çıkarımlarıdır.

Ön membership okumasından sonra raw update/delete commit etmişse final lock sorgusu current row'ları veya azalmış seti verir; eski Contact verisi digest'e dahil edilmez. Parent kilidi yeni girişleri engeller, final Contact share lock'ları sonraki update/delete'ları engeller. Kaynak GET'ten değişmişse digest conflict olur; yalnız semantic eşdeğer değişiklikse kabul edilebilir.

Sale kaynak JobCard'ı önce kilitleyebilir; meeting edit JobCard→Contact yolu kullanabilir; enrichment Customer→witness NOWAIT kullanır. Review **hiç JobCard/Sale/product/message kilidi almaz** ve tüm source row lock'ları NOWAIT'tir. Meeting Contact kilidi meşgulse review hemen rollback yapar; ters sırada beklemez. Parent kilidi alan review başka JobCard'ı beklemediği için mevcut job→customer yolu ile cycle tamamlamaz.

Aynı pair'i iki yönetici değerlendirirse parent lock veya review version tek kazanan sağlar. Çakışan farklı pair'ler ortak Customer nedeniyle kısa süreli REVIEW_BUSY alabilir; daha zayıf yanlış karar yerine bounded conflict tercihidir. Concurrent same action claim bounded wait sonrası replay veya ACTION_IN_PROGRESS olabilir. Yeni action ID üretilerek otomatik retry yapılmaz.

Lock/isolation dayanağı [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) ve [transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) belgeleridir. Buradaki protokol bunlardan ve mevcut source lock yollarından yapılan tasarım çıkarımıdır; çalıştırılmış race sonucu değildir.

## SD-7 — Manager UI contract

UI-001, PRODUCT.md, DESIGN.md ve impeccable'in Operate yaklaşımı kullanılır; mevcut Servora Ant adapter'ları, route identity ve PageHeader korunur. Yeni görsel sistem veya raw feature-level Ant import'u yok.

| Görünüm | Desktop | 390px / erişilebilirlik |
| --- | --- | --- |
| Candidate list | Müşteriler'den “Olası mükerrerler”; attention/all, anchor filtresi, gerekçe ve çelişki; sabit pair sırası | Tek sütun çift özeti; her A/B adı ve durumu ayrı başlık; büyük tablo küçültülmez |
| Comparison | Alan satırları için iki müşteri sütunu; A/B başlıklarında ad, ID ayrımı, CRM link'i | Her alan için A ve B değerleri ardışık; iki bütün müşteri kartı arasında hafızadan kıyas zorunluluğu yok |
| Contacts | Aktif/pasif/primary etiketleri; destekleyici benzerlik, eşleştirme iddiası yok | Tek semantik liste; gizli ikinci DOM kopyası yok |
| Operations | İsteğe bağlı mevcut iki operational-summary çağrısı; güncellik zamanı ayrı | Not/mesaj/gizli Staff verisi yok; hata kimlik karşılaştırmasını bozmaz |
| Decision | “Mükerrer olarak doğrula” / “Eşleşmeyi reddet”; zorunlu reason seçimi; “Daha sonra” | Her sonuç için etkisi açıklanır: yalnız review kararı; tek primary action, 44×44 hedefler |
| History/register | Eski karar, reopen ve source/rule değişimi; kaynak kaybolsa bile güvenli event görünümü | Ordered list, aktör/zaman/gerekçe; ham audit JSON veya geçmiş raw müşteri verisi yok |

Karşılaştırma tam sayfadır; içine nested modal/card zinciri kurulmaz. Karar seçimi inline radio/select ile, son gönderim mevcut ConfirmationAction üzerinden sonuç özetiyle yapılır. Cancel/Escape güvenli idle durumda focus'u başlatan elemana döndürür. Pending sırasında semantic alanlar ve modal close kilitlidir; browser navigation receipt'i yok saymaz.

Akış sırası: Müşteriler → aday listesi → canonical A/B karşılaştırma → alan/Contact ve isteğe bağlı operasyon özeti → outcome + reason → etkileri gösteren confirmation → frozen POST → receipt ve canonical GET → history. Eski terminal review'de ayrı “Yeniden incele” komutu pending cycle açar; sonraki yeni karar bu cycle'ın yeni sürümüne bağlanır. Başarı metni “İnceleme kararı kaydedildi” der; “müşteriler birleştirildi” demez.

| Durum | Sözleşme |
| --- | --- |
| Loading | Alanlar tahmini değer göstermeden Skeleton/aria-busy; submit kapalı |
| Empty | Yalnız exhausted=true ve başarılı kapsam için “Aday bulunamadı”; ara boş batch için “Taramayı sürdür” |
| Error / retry | ResultState/inline hata; GET-only retry; eski başarılı veriler eski zaman etiketiyle tutulabilir |
| Forbidden / missing | 403/404 mevcut ResultState; başka kayıt kimliğine fallback yok |
| Stale evidence | Fark/yeniden yükleme çağrısı; beklenen revision otomatik yeni veriye bağlanmaz |
| Concurrent review | VERSION_CONFLICT; gerekçe taslağı korunur, karar yeniden incelenmeden submit açılmaz |
| Pending / lost response | Frozen command; “Özgün isteği tekrar dene”; yeni key/payload yok |
| Background/realtime | Reconcile sonucu draft'ı remount etmez; aynı semantic evidence ise focus/reason korunur; değişmişse deferred truth + blok |
| Reopen | Açık “Yeniden incele”; eski kararı silmeden pending cycle açılır |
| Overflow/unverifiable | “Kanıt bütünü doğrulanamadı”; eski ret saklanıp candidate gizlenmez; karar kapalı |
| Source removed | Register/history kalır; current comparison ve mutation kapalı |

Klavye tüm akışı tamamlar; Enter/Space standart davranış, focus trap/restoration, live region ve hata ilişkileri test edilir. 200% metin, 400% reflow, uzun Türkçe adlar ve reduced motion kabul şartıdır. Renk tek taşıyıcı değildir. Comparison link'leri mevcut CRM/JobCard izinlerini genişletmez.

### SD-7.1 — Refresh and unresolved attempts

Yeni review-specific SSE event'i yok; mevcut sözlük JobCard olaylarıyla taklit edilmez. Command sonrası GET, focus/online/visibility, mevcut provider reconciliation ve görünür ekranda feature-scoped 60s poll kullanılır. Provider'ın fallback timer'ı sadece disconnected iken çalıştığından, connected modda otomatik tazelik sağladığı varsayılmaz. Inflight/request gate birleştirir; gizli sekmede poll yok.

Liste sonraki sayfadaysa refresh başa atlatmaz, “Baştan yenile” affordance'ı sunar. Source/review değişimi POST güvenliğini polling hızına bağımlı kılamaz. 429'da Retry-After ve inflight coalescing uygulanır; gizli ekranda timer durur, görünürlük/focus/online dönüşünde aynı reconciliation gate kullanılır. PR1'de command yoktur; command-sonrası yenileme PR2'de devreye girer.

POST'tan önce yalnız allowlisted command (ID'ler, action key, expected review/evidence, rule, decision/reason) actor/org bağlı sessionStorage'da tutulur; raw Customer/Contact alanları veya auth token tutulmaz. Yazma başarısızsa POST başlatılmaz. Reload aynı actor/pair için frozen attempt'i açar; explicit aynı istek retry edilir. Başka kullanıcıya taslak gösterilmez. Tab kapandığında original key kaybolursa otomatik command retry yok; güncel review/history üzerinden manuel reconciliation gerekir.

Completed receipt body güncel aggregate diye gösterilmez; tekrar GET yapılır. SERVER_5xx/network/invalid response unresolved kalır. VERSION_CONFLICT/EVIDENCE_CHANGED/EVIDENCE_KEY_UNAVAILABLE gibi kesin no-commit cevapta draft korunur, yeni GET ve insan incelemesi sonrası yeni intent oluşturulabilir. REVIEW_BUSY/ACTION_IN_PROGRESS aynı frozen intent ile retry edilir. Log-out veya süre aşımı unresolved isteğe yeni key üretmez.

## SD-8 — Findings, risks and last technical decisions

Bunlar yeni discovery iddiaları değil, tasarıma etki eden doğrulanmış kaynak sınırlamaları ve tasarım riskleridir. Bu oturumda çalıştırılmış runtime defect veya production incident bulunmuş gibi raporlanmaz.

| ID / önem | Tür ve bulgu | Tasarım karşılığı |
| --- | --- | --- |
| F01 / P1 | Customer.version, generic Contact alan/primary/membership değişikliklerini temsil etmiyor. | Semantic Contact seti + locks; version-only digest yok. |
| F02 / P1 | İki eşitlik grubunu self-JOIN edip LIMIT koymak büyük grupta N² maliyeti saklayabilir. | İki bucket lazy union; source/pair/evidence bütçeleri; EXPLAIN/load kapısı. |
| F03 / P1 | Contact row lock tek başına insert phantom'unu; KEY SHARE non-key update'i engellemez. | Parent FOR UPDATE + final Contact FOR SHARE NOWAIT. |
| F04 / P1 | Yeni Customer FK RESTRICT mevcut pristine delete politikasına gizli blocker; CASCADE history kaybı ekler. | Review pair ID'leri tarihsel soft reference; creation/write anında org ve existence lock altında doğrulanır. Deletion sonrası history tombstone davranışı Data Model'de. |
| F05 / P2 | Critical helper JobCard repository içinde ve claim öncesi local timeout sunmuyor. | Dar extract/re-export + opt-in timeout; diğer callsite davranışı regression ile korunur. |
| F06 / P2 | Current realtime sözlüğünde CRM review yok; mevcut provider connected modda 60s fallback çalıştırmıyor. | Explicit refresh/local poll; yeni SSE vocabulary değişikliği yok. |
| F07 / P2 | SQL lower/regexp ile JS normalizer'ını kopyalamak Unicode farkı üretebilir. | JS tek normalize sahibi; PG roundtrip/parity matrisi. |
| F08 / P2 | Adres TEXT ve Contact sayısı sınırsız olabilir; digest için sessiz truncate yanlış freshness üretir. | Overflow sentinel, karar bloklama; ölçülmemiş kapasite vaadi yok. |
| F09 / P2 | Raw evidence history tutulmaz; HMAC key kaybında eski kararın freshness'ı doğrulanamaz. | Keyring retention, UNVERIFIABLE, receipt replay ayrımı. |

Kesinleşen teknik kararlar (kullanıcının 19 Ekim 2026 değerlendirmesi + bu uzlaştırma):

| Karar | Final sözleşme |
| --- | --- |
| T1 — ACCEPTED | V1 20.000 BUSINESS kaynak; 20.001 sentinel → açık 422, kısmi success yok. Gerçek PG17 query-plan/load testi implementation'da zorunlu. |
| T2 — ACCEPTED | Historical soft references; source deletion history'yi silmez/yeni blocker olmaz. ID yeni source erişim yetkisi vermez; canlı erişim her seferinde org/BUSINESS/existence check'inden geçer. |
| T3 — ACCEPTED | İki online key + ayrı şifreli tarihsel arşiv; custody/rotation/restore sahibi SD-4.4'te kesin. Raw snapshot yok; kayıp key için UNVERIFIABLE + explicit recovery/reopen. |
| T4 — ACCEPTED | Görünür ekranda 60s, focus/visibility/online ve komut sonrası refresh; yeni SSE yok. POST doğruluğu polling'e bağlı değil. |
| T5 — ACCEPTED AS INITIAL TARGETS | 2 vCPU/4 GiB Linux Node22/PG17 profili; p95/p99/RSS başlangıç hedefleri Test Matrix'te. Gerçek ölçüm olmadan PASS yok; hard scope/deadline/atomicity şartları ayrıca zorunlu. |

D1–D6 yeniden açılmadı. Yeni bir P1 kod hatası kanıtlanmadı; P1 race/atomicity/performance senaryolarının runtime kapanışı ilgili PR testlerine aittir. Final uzlaştırmanın kapatılan/açık bulguları SD-10'dadır.

## SD-9 — Sources and verification

Birincil source çapaları:

- [AGENTS.md](../../../AGENTS.md), [DECISIONS.md](../../../DECISIONS.md), [PRODUCT.md](../../../PRODUCT.md), [DESIGN.md](../../../DESIGN.md).
- [CRM temel sözleşmesi](../../../docs/superpowers/specs/2026-07-12-customers-contacts-design.md), [Slice 2](../../../docs/superpowers/plans/2026-10-10-crm-staff-enrichment.md), [Slice 3](../../../docs/superpowers/specs/2026-10-10-crm-slice3-visit-contact-completeness-design.md).
- [Normalizer'lar](../../../server/src/modules/crm/types.ts#L189), [CRM locks/queries](../../../server/src/modules/crm/repository.ts#L95), [Contact writers](../../../server/src/modules/crm/service.ts#L440).
- [Critical helper](../../../server/src/modules/job-cards/repository.ts#L985), [Sale lock yolu](../../../server/src/modules/job-cards/sale-service.ts#L151), [Realtime sözlüğü](../../../server/src/modules/realtime/types.ts#L3), [web reconciliation](../../../web/src/realtime/RealtimeProvider.tsx#L192).
- [Local CI gate SSOT](../../../ops/local-ci/required-checks.txt), [catalog loader](../../../server/src/db/migration-catalog.ts#L75).

Kaynak discovery erişilebilir ve orijinal konumunda korundu. Yerel main SHA/tree başlangıçta eşleşti; GitHub remote yeniden fetch edilmedi. Beş stash ve 49 worktree metadata kaydı koruma karşılaştırmasına alındı. Ignored/private dosyalar taranmadı/değiştirilmedi; Codebase Memory reset/reindex yapılmadı.

Bu aşamada yalnız beş Markdown artifact üretildi. Server/web build, test, PostgreSQL migration/race/EXPLAIN/load, Local CI, browser ve production doğrulamaları **NOT_RUN**. Belge/link/şema-sözleşme statik kontrolleri uygulama testi değildir. Son koruma sonuçları final raporda verilir.

### SD-9.1 — Initial documentation checks (historical)

| Kontrol | Sonuç / kapsam |
| --- | --- |
| Requested artifacts | PASS — repository dışında tam beş istenen Markdown dosyası |
| Original acceptance | PASS — discovery'deki A01–A16, TM-1'de metin olarak birebir korundu |
| Original discovery | PASS — SHA256 `2d27f2094e6f2db8bd52cbf0b91a67f761fe774bac00332fa81651f43636eed5` değişmedi |
| Static document checks | PASS — balanced fences, 7 JSON örneği, 31 mevcut yerel link/hedef satırı, unique yeni test ID'leri |
| Audit vocabulary | PASS — mevcut 10 subject + 1 yeni subject; mevcut 36 event + 2 yeni event; baseline değer kaybı yok |
| Canonical checkout | PASS — başlangıç ve son HEAD/tree/status aynı; unstaged/staged diff boş |
| Stashes / worktrees | PASS — 5 stash kimliği ve 49 worktree'nin tam porcelain metadata çıktısı başlangıçla aynı |
| Runtime verification | NOT_RUN — build/test, migration, PG17 race/plan/load, browser, Local CI ve production |

İlk kabul-karşılaştırma betiği TM-2 eşleme satırlarını da topladığı için yanlış FAIL üretmişti; kapsam yalnız TM-1 orijinal kabul tablosuna daraltıldı, yeniden çalıştırılan kontrol PASS verdi. Bu kontrol feature runtime test sonucu değildir. Ignored/private dosyaların içeriği taranmadı; bu dosyalara işlem yapılmadı. Diğer worktree'lerin içerik durumu ayrıca denetlenmiş gibi raporlanmaz.


## SD-10 — Final reconciliation findings and consistency

**Review:** 19 Ekim 2026; exact baseline SHA/tree tekrar eşleşti. Source + SQL/state/lock adversarial inceleme sonucudur; çalıştırılmış PG17 veya uygulama acceptance sonucu değildir.

| ID / önem | Bulgu ve kapanış | Durum |
| --- | --- | --- |
| RC-01 / P2 | Plugin onRequest, auth preHandler; actor key erken kullanılamaz. Manual class limiter, auth→management→limiter, false auto-hook, singleton bucket ve marker koruması SD-6.1.1/API-1.1'de. | CLOSED_IN_DESIGN; RATE runtime NOT_RUN |
| RC-02 / P2 | A12 “versions” ile EVID-04 no-op anlamı belirsizdi. Orijinal A12 aynen; TM-1.1 normatif D5 yorumu/A12-S1–S5 ile kapandı. | CLOSED_IN_DESIGN |
| RC-03 / P2 | İki-key kuralında custody/rotation/recovery sahibi ve archive ayrımı eksikti. SD-4.4 sahiplik, rutin/emergency retirement, backup/restore ve production kapısını tanımlar. | CLOSED_IN_DESIGN; real custody enablement ayrı |
| RC-04 / P2 | Eski expected key için generic 503/frozen retry kalıcı çıkmaz oluşturabilirdi. Receipt-first + confirmed rollback sonrası 409 EVIDENCE_KEY_UNAVAILABLE eklendi. | CLOSED_IN_DESIGN; KEY-04 NOT_RUN |
| RC-05 / P2 | “Bütün Contact writer'ları parent lock alır” genellemesi deleteContact için yanlıştı. Final share lock ve gerçek deletion race testi şart. | CLOSED_IN_DESIGN; TX-04 NOT_RUN |
| RC-06 / P2 | Anchor filtresinin global N² iterator sonrasına konması mümkündü; anchor-neighbor union/PAIR-06 ve geçersiz anchor için cap öncesi org/BUSINESS point gate şartı eklendi. Receipt completion zero-row başarısının reddi de kesinleştirildi. | CLOSED_IN_DESIGN; PAIR-06/TX-05 NOT_RUN |
| RC-07 / P2 | Host Node26.11.0, installed Fastify5.12.3/rate-limit11.1.0; source pin5.12.5/11.2.0 ve Node22 evidence profiliyle aynı değil. | OPEN_ENVIRONMENT_GATE; canonical installation korunur; PR1 izole ortamında çözülür |
| RC-08 / P2 | Mevcut toErrorResponse yalnız AppError ve statusCode=429 framework error için status taşır; diğer non-AppError statusCode değerleri 500 olur. API semantic validation ile parser/lifecycle hataları ayrıldı; global serializer bu görevde değiştirilmedi. | OPEN_BASELINE_FOLLOWUP; source gözlemi, HTTP reproducer NOT_RUN; PR1 GET tasarım engeli değil |

Yeni P1 kod hatası **kanıtlanmadı**. F01–F04 için tasarım karşılığı mevcut; doğrulanmamış garanti PASS değildir:

| Adversarial durum | Tasarım sonucu / kalan ispat |
| --- | --- |
| FK Contact insert parent kilidinden önce/sonra | Önce alınmış key-share review'ü NOWAIT busy yapar; sonradan insert parent FK'de bekler, review'den sonra serialize olur. Immediate composite FK korunmalı; TX-03 gerçek PG17 gerekli. |
| Parent kilitsiz delete / non-key update | Final lock öncesi committed deletion/güncel tuple kanıta girer; final share sonrası update/delete commit edemez. Meşgul row busy + rollback; ön-okuma fallback yok. TX-04 gerekli. |
| İki manager / ortak Customer | Parent NOWAIT ve review expected-version CAS tek kazanan sağlar; loser claim/event/audit commit etmez. TX-01/09 gerekli. |
| Circular current-event FK | İlk head(v1)→owner-FK event(seq1)→deferred check; sonraki event→CAS head→constraint check uygulanabilir. FK history max/alternation garantisi değildir. TX-11 gerekli. |
| Audit/receipt failure / lost response | Tek PoolClient; receipt completion tam bir satır; constraint/audit/receipt hatası rollback. COMMIT sonrası yanıt kaybı receipt-first replay ile çözülür; 5xx yeni key yaratmaz. TX-05/06/07 gerekli. |

Consistency: 20k+sentinel/422 SD-3.3 ↔ API-3/8 ↔ DM-6.1 ↔ READ/PERF/GATE; historical soft reference SD-5/8 ↔ API register/history ↔ DM-4.1; 60s visible/focus/command SD-7.1 ↔ API-9 ↔ UI/RATE/IP-7. Uyumsuz domain kararı kalmadı. Runtime/evidence ve production custody kapıları kendi aşamasında açıktır; PR1 tasarım girişini engelleyen açık P1/P2 tasarım sorusu yoktur.

Ek source çapaları: [Plugin registration](../../../server/src/app.ts#L210), [auth hook/cookie key notu](../../../server/src/modules/auth/routes.ts#L14), [auth middleware](../../../server/src/modules/auth/middleware.ts#L8), [CRM routes](../../../server/src/modules/crm/routes.ts#L16), [Contact deletion](../../../server/src/modules/crm/service.ts#L484), [Contact FK](../../../server/src/db/migrations/004_crm_contacts.sql#L17), [receipt helper](../../../server/src/modules/job-cards/repository.ts#L985), [error serializer](../../../server/src/errors/index.ts#L22), [operator environment](../../../docs/operations/production-deployment.md#L24).

## SD-11 — Reconciliation change ledger and SHA256

Yalnız mevcut beş repository-dışı belge değişti. Repository/migration/DECISIONS.md/git/worktree/ignored-private içerik değiştirilmedi. Before hash'leri bu reconciliation başlangıcındaki bytes'a aittir. Yalnız installed dependency package manifest sürümleri hedefli okundu; private/environment/secret dosyaları okunmadı, ignored kurulum değiştirilmedi.

| Artifact | Before SHA256 | Change reason |
| --- | --- | --- |
| CRM_SLICE4A_API_CONTRACT.md | `650cf711a2e91968889a5d9a5e3ad321a1c19a9851e999cef75abe7ef1eaf2e1` | Auth-first class limiter; retired-token conflict; scope/refresh/PR1 boundary. |
| CRM_SLICE4A_DATA_MODEL.md | `9204a59cc504eb5bf3b7ead4a9ca58e7fb380074c670654a28fe83a0acab5db1` | Accepted soft refs; FK proof limits; parentless delete/receipt invariant; key metadata preflight. |
| CRM_SLICE4A_DESIGN.md | `f3239054dd7173817eb6507e5d7845e868045390e3e8574c30c094f9a4b407ab` | Final status/T1–T5; hook integration/A12; key custody/recovery; adversarial findings/ledger. |
| CRM_SLICE4A_IMPLEMENTATION_PLAN.md | `fffe6e85d023d50e7bcc610a587b1f0119c43dd0852e0560b1222b9266c60ed3` | Final entry gate, isolated pinned environment, scoped PR1 behavior/tests; production boundary. |
| CRM_SLICE4A_TEST_MATRIX.md | `103c14024603c5740476b4e81c21dc0f0f41c14f1c1c2346a5701d75bc72cdcb` | Original acceptance preserved; A12-S/RATE/KEY/GATE, anchor/deletion/receipt tests; T5 targets. |

Final hashes of the other four artifacts (after their last edit):

| Artifact | After SHA256 |
| --- | --- |
| CRM_SLICE4A_API_CONTRACT.md | `ed0c7cf61d596d2c28580cf9b24bf63bccbee26959d78cb2fcc4c84a31562502` |
| CRM_SLICE4A_DATA_MODEL.md | `9bf4a113d8bb922c156cadcc82fd55469f500fc274a4b8c580aff0c6659a79f8` |
| CRM_SLICE4A_IMPLEMENTATION_PLAN.md | `7d3208d84068d1df657619d26b43fb903226aa8edd7c858fc2544c29f44236c9` |
| CRM_SLICE4A_TEST_MATRIX.md | `42550a0b0a261a7a05163e8593112cd450ecd01d37b6d693b58bd35873cafc5c` |

Bu SSOT ledger kendi dosyasının final hash'ini içeremez; CRM_SLICE4A_DESIGN.md after SHA256'i final kullanıcı raporunda verilir. Diğer dört after hash yukarıda tamdır.

### SD-11.1 — Reconciliation verification

- Static document/contract check PASS: tam beş artifact; original A01–A16 birebir; discovery SHA256 aynı; yedi JSON örneği ve 40 yerel link/satır hedefi geçerli; unique test ID'leri; audit allowed-set baseline kaybı yok; T1–T5/rate/A12/key/soft-reference/receipt/PR1 sözleşmeleri tutarlı.
- Git protection PASS: exact main SHA/tree başlangıçla aynı, canonical status ve staged/unstaged diff boş; beş stash kimliği ve 49 worktree'nin tam metadata çıktısı aynı. Başka worktree içeriği taranmadı/değiştirilmedi.
- Runtime/build/PG17/race/EXPLAIN/load/browser/CI ve synthetic hook probe NOT_RUN. Host/package sürümleri yalnız manifest okumalarıyla gözlendi; mismatch üzerinde probe çalıştırılmadı ve kurulum değiştirilmedi.
- Kaynak okuma sırasında bulunmayan tahmini yollar rg ile mevcut kaynaklara düzeltildi; ilk toplu düzenleme çağrısı JS syntax nedeniyle başlamadı. Bu denemeler dosya değişimi veya runtime test sonucu üretmedi; sonraki düzenleme ve statik kontroller başarılıdır.
- Production müşteri/secret/DB erişimi, gerçek key üretimi, migration dosyası/SQL execution, commit/push/PR/merge/deploy/Actions ve graph reset/reindex yok. PR1 bu görev içinde başlatılmadı.
