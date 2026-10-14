> See [the PR1 contract and handoff](README.md) for implementation status. Approved for PR1 implementation on 2026-10-14. The user confirmed IN_PROGRESS sources, four engagement kinds, BUSINESS records, optional sale contact, NEW/ACCEPTED creation and the terminal-slot policy. Original discovery documents remain untouched. PR2–PR4 behavior is a design target, not shipped behavior. Evidence references below describe the original discovery bundle.

# Visit-to-Sale — Product and Integration Design

Date: 2026-10-14 (Europe/Istanbul)
Status: `VISIT_SALE_AND_PRODUCT_UX_DESIGN_READY` — discovery/design complete; implementation not started.
Repository: `emrahozcelik/servora-med`
Reviewed main: `daf5a59692803f9e5acbbef431d12cc32e1c02e3`

Bu dosya uygulanmış özellikleri değil, kaynak kanıtına dayalı tasarımı tanımlar. Veri/transaction sözleşmesi [data-lifecycle](visit-to-sale-data-lifecycle.md), PR sırası [implementation-plan](visit-to-sale-implementation-plan.md), mevcut ekranlar [inventory](product-selection-surface-inventory.md) içindedir. Öneriler, aşağıdaki açıkça kabul edilmiş kararlarla aynı statüde değildir.

## 1. Kaynak kimliği ve korunmuş çalışma durumu

GitHub `GET /repos/emrahozcelik/servora-med/git/ref/heads/main` başlangıçta verilen SHA'yı döndürdü; yerel `origin/main` aynı SHA. Drift yok. Kirli canonical checkout'un HEAD'i `a916fea5b17244d27057260c9d01074ef88f39f4`; bu checkout inceleme baseline'ı olarak kullanılmadı. Kaynak, `git archive <reviewed-main>` ile `/private/tmp/servora-visit-sale-design-20261014/source` içine çıkarıldı; checkout, fetch, reset veya stash işlemi yapılmadı.

İnceleme başlangıcında beş stash ve `68d9e4f09775316cd934bddf5376b6416ae6b2d0` clock/parser adayı kayıt altına alındı. Çıktılar yalnız bu yeni, Git'e kayıtlı olmayan ve ignore edilen `.worktrees/visit-sale-product-ux-design-20261014` çalışma klasörüne yazıldı. `../evidence` kimlik ve koruma kontrollerini içerir. Codebase-memory artifact'i `a916fea5…` için indekslenmişti; güncel main kanıtı olarak kullanılmadı.

Production R4, R4 main entegrasyonu, aday commit ve issue #369 kapsam dışıdır. Deployment, Actions, push, PR açma veya merge yapılmadı. Production/live DB migration head'i sorgulanmadı; doğrulanan head repository kataloğudur.

## 2. Kabul edilmiş ürün kararları

| ID | Karar | Yetkili kaynak |
| --- | --- | --- |
| A1 | Gerçekleşen satış, ziyaret notuna gömülmez; ayrı ama ziyaretle ilişkili satış JobCard'ı oluşturulur. | Bu görevde aktarılan 7 Ekim ürün kararı. İncelenen repository dokümanlarında ayrıca tarihli bir 7 Ekim satış ADR'si bulunmadı; kullanıcı beyanı bağlayıcıdır. |
| A2 | `POSITIVE` satış değildir; `PRODUCT_DELIVERY` satırındaki `deliveryPurpose=SALE` fiziksel teslimattır. | Görev + `DECISIONS.md` DOM-001/DOM-007. |
| A3 | `sourceJobCardId` follow-up içindir; satış bağlantısında kullanılmaz. | Görev + migration 022 ve linked-follow-up tasarımı. |
| A4 | Satış kaydetmek ziyaret tamamlamaz, teslimat yapmaz, follow-up veya finansal işlem oluşturmaz. | Görev. Ziyaretin mevcut onay/follow-up kuralları ayrıca aynen çalışır. |
| A5 | Bir ziyarete aynı anda en fazla bir aktif satış bağlanır. | Kullanıcının bu oturumdaki açık yanıtı. |
| A6 | PR #362 ürün seçimi yeniden kullanılır; ProductForm katalog formu olarak kalır. | Görev + [PR #362](https://github.com/emrahozcelik/servora-med/pull/362). |
| A7 | STAFF'a genel CRM/contact/catalog yazma yetkisi verilmez; mevcut action-scoped enrichment ayrı kalır. | AGENTS.md + `DECISIONS.md` CRM-S2-001. |

## 3. Mevcut kod gerçekleri

Kaynak bağlantılarının tamamı incelenen SHA'ya sabitlenmiştir. Eski spec'lerdeki `PLANNED`, eski yetki sınırları ve “implementation not started” başlıkları güncel uygulama kanıtı sayılmaz.

| Gerçek | Kanıt ve tasarıma etkisi |
| --- | --- |
| Dört JobCard türü var: `PRODUCT_DELIVERY`, `GENERAL_TASK`, `SALES_MEETING`, `WEEKLY_REPORT`; `SALE` yok. | [types.ts:28](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/types.ts#L28). DB türü native enum değil VARCHAR + CHECK; son genişletme migration 051. |
| Sekiz güncel durum var; `INVALIDATED` terminal ve operasyonel raporlardan dışlanıyor. | [types.ts:10](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/types.ts#L10). Yeni durum gerekmiyor. |
| `NEW → ACCEPTED → IN_PROGRESS → WAITING_APPROVAL → COMPLETED` backend komutlarıdır. STAFF kendi atamasını kabul/başlatır; yönetim onaylar. | [policy.ts:43](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/policy.ts#L43). Satış bu zinciri devralır. |
| STAFF kendi oluşturduğu karta `ACCEPTED`, yönetim oluşturduğuna `NEW` verir. | [service.ts:974](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/service.ts#L974). Satış kayıt zamanı işin onay durumu değildir. |
| Planlanan kişi `job_cards.contact_id`; gerçekten görüşülen kişi `job_card_meeting_details.met_contact_id`. | [migration 056](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/db/migrations/056_meeting_met_contact.sql), [service.ts:2190](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/service.ts#L2190). Birbirine fallback yapılmaz. |
| Met-contact alanlarının okuyucu capability/opt-in sözleşmesi var. | [handlers.ts:79](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/handlers.ts#L79). Satış başlangıç bağlamını backend doğrudan üretmeli; legacy HTTP response'undan kişi tahmin edilmemeli. |
| Submission evaluator'in son branch'i delivery dışındaki türü meeting sayıyor. | [submission-policy.ts:330](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/submission-policy.ts#L330). `SALE` için açık dispatch zorunlu. |
| JobDetail loader da tanıdığı üç diğer türden sonra meeting branch'ine düşüyor. | [JobDetail.tsx:825](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/web/src/JobDetail.tsx#L825). Tür eklemek tek başına yeterli değildir. |
| Critical action receipt, normalized request hash ve transaction mevcut; lifecycle ayrıca migration 049 intent rezervasyonu kullanıyor. | [runCriticalAction:980](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/repository.ts#L980), [service.ts:3575](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/service.ts#L3575). Yeni retry altyapısı kurulmaz. |
| ProductSelect'in tek production tüketicisi DeliveryCreate; miktar üst bileşende product ID'ye bağlı tutuluyor. | [ProductSelect.tsx](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/web/src/ProductSelect.tsx), [DeliveryCreate.tsx:310](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/web/src/DeliveryCreate.tsx#L310). |
| Ürün referans sorgusu brand getirmiyor; delivery snapshot'ında brand yok. | [repository.ts:3382](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/job-cards/repository.ts#L3382). Sale snapshot producer'ı brand'i açıkça okumalı. |
| Raporlar productive type bucket'larını üç türle sınırlar; WEEKLY_REPORT yalnız bazı operasyon sayaçlarında yer alır. | [reports/repository.ts:276](https://github.com/emrahozcelik/servora-med/blob/daf5a59692803f9e5acbbef431d12cc32e1c02e3/server/src/modules/reports/repository.ts#L276). Yeni türün bucket/parser/weekly snapshot etkisi incelenmeli. |

## 4. Önerilen domain kararı

Yeni canonical tür `SALE`, kullanıcı etiketi **Satış kaydı**. Bu kart, müşteriyle gerçekleşen ürün/miktar anlaşmasının personel tarafından kaydı ve yönetici doğrulamasıdır. `COMPLETED`, satış kaydının yönetici onayının bittiğini anlatır; teslim, tahsilat veya fatura durumunu anlatmaz.

İlişki adı `SALE_FROM_VISIT`. En küçük model: SALE satırında yeni `job_cards.sale_source_visit_id`. DTO'da `{ kind: 'SALE_FROM_VISIT', ... }` olarak projekte edilir. Yeni generic ilişki tablosu ve yeni ilişki state'i önerilmiyor. Kaynak alanı sadece bu ilişkiyi taşır; `source_job_card_id` ve follow-up alanları SALE'de null kalır. Partial unique index, mevcut parent `status` üzerinde bir aktif satış kuralını doğrudan korur. Ayrıntılar data-lifecycle §2'de.

Alternatif generic `job_card_relations` tablosunda child status'una bakarak partial unique index kurulamaz; PostgreSQL partial index başka tabloya join yapamaz. Bir “aktif slot” tablosu veya kopya status + trigger gerektirmek bu slice için gereksizdir. Ayrı ilişki sütunu bunu mevcut durum SSOT'u ile çözer.

### 4.1 Kaynak uygunluğu — öneri

İlk uygulama için kaynak `type=SALES_MEETING`, `status=IN_PROGRESS`, aktif/prospect müşteri ve aktif STAFF assignee olmalı. Başlatılmamış, onayda, revision'da veya terminal ziyaretlerden yeni satış oluşturulmaz. Revision'daki ziyaret için önce mevcut `RESUME` kullanılır; sonra yeniden bağlam yüklenir.

Ziyaret/görüşme kapsamı önerisi: `CUSTOMER_VISIT`, `SALES_MEETING`, `PRODUCT_DEMO`, `FOLLOW_UP`. `TRAINING` ve `OTHER` otomatik satış kaynağı sayılmaz. Bu liste satış kuralıdır; müşteri ziyaret sıklığı helper'ının yan etkisi olarak alınmaz. Kullanıcı bu alt tür listesini ayrıca onaylamadı; uygulama brief'inde sabitlenecek ürün önerisidir.

`POSITIVE`, meeting summary veya meeting result save'i satış oluşturmanın ön koşulu değildir. Taslakta kaydedilmemiş görüşme kişisi null olarak görünür. Ziyaret formunda henüz kaydedilmemiş kullanıcı değişiklikleri satışa gizlice kopyalanmaz; “Ziyaret değişikliklerini kaydet, ardından satış oluştur” yönlendirmesi verilir. Satış oluşturmak ziyaret sonucunu `POSITIVE` yapmaz. Mevcut müşteri ziyareti submission/follow-up kuralı ayrıca uygulanır.

İlk slice için BUSINESS kaynakları önerilir. DEMO ziyaretlerinden satış capability'si kapalı kalır; mixed BUSINESS/DEMO referansları reddedilir. Demo sale/purge kapsamı ayrıca tasarlanmadıkça yeni tablo referansları demo purge'u kırmamalıdır. Bu da yeni ürün kararı önerisidir, mevcut uygulama özelliği değildir.

### 4.2 Oluşturan, sorumlu ve yetki

| Kullanıcı | Oluşturma | Satışın ilk durumu / sorumlusu |
| --- | --- | --- |
| Atanmış STAFF | Aynı organizasyondaki kendi uygun ziyaretinden | `ACCEPTED`; ziyaretin mevcut assignee'si, dolayısıyla kendisi |
| Başka STAFF | Reddedilir; kayıt görünmez (`404`) | Yok |
| MANAGER / ADMIN | Kendi organizasyonundaki uygun ziyaretten | `NEW`; ziyaretin mevcut STAFF assignee'si |
| Başka organizasyon / oturumsuz | `404` / `401` | Yok |

Müşteri ve ilk assignee backend tarafından kilitli ziyaretten türetilir. Formda değiştirilemez; body'de customer/assignee/source override alanları kabul edilmez. Oluşturan yönetici olabilir; kaydın operasyonel sahibi `assigned_to` olmaya devam eder. NEW/ACCEPTED satışın yeniden atanması mevcut yönetim kuralıyla mümkündür; kaynak ziyaret yeniden atanmaz.

`CREATE_SALE_FROM_VISIT` yeni backend action/capability'dir. UI yalnız sunucunun sunduğu action'ı gösterir; mutation her şeyi tekrar doğrular. Action listesi aktif satış varlığını dikkate alır; unique index son korumadır. CRM-S2 enrichment, kaynak/aktif JobCard'ın mevcut scope resolver'ıyla çalışır. Genel CRM PATCH, generic contact mutation ve product catalog yazma hakları genişlemez. Satış formu yeni katalog ürünü veya kişi oluşturma side-flow'u açmaz; mevcut aktif kişi seçimi kullanılır.

### 4.3 Bir aktif satışın kesin anlamı

Aktif küme mevcut `ACTIVE_JOB_CARD_STATUSES`: `NEW`, `ACCEPTED`, `IN_PROGRESS`, `WAITING_APPROVAL`, `REVISION_REQUESTED`. `COMPLETED`, `CANCELLED`, `INVALIDATED` tarihçedir ve aktif slotu kullanmaz. Böylece bir ziyarette birden fazla tarihsel satış olabilir, fakat aynı anda bir aktif satış bulunabilir. Terminal satışın yerine yeni satış ancak kaynak ziyaret hâlâ uygun `IN_PROGRESS` ise oluşturulur. Bu, kullanıcının “bir aktif satış” tercihinin canonical status kümesiyle önerilen yorumudur; “ömür boyu bir satış” kuralı değildir.

Eski anahtarla retry, terminal olan eski satışın receipt'ini döndürür. Yeni bağımsız satış için kullanıcı açıkça yeni aksiyon başlatır. İçeriği benzer iki farklı istek bir ürün/anlaşma kimliği yokken ömür boyu semantik duplicate olarak ilan edilmez.

## 5. Bağımsız yaşam döngüsü ve değişiklik

Kaydetme yalnız yeni kart ve bağlı veriyi oluşturur. STAFF için sonraki adımlar `START → SUBMIT_FOR_APPROVAL`; yönetimin oluşturduğu kartta ayrıca assignee `ACCEPT_ASSIGNMENT` yapar. Otomatik START/SUBMIT/APPROVE yoktur. Kaydın “sale happened” zamanı `soldAt`; kabul, başlatma, submission ve approval zamanları farklıdır.

Satış detayındaki type-specific editor, aktif düzenlenebilir durumlarda ürün ekleme, miktar değiştirme, kaldırma, actual sale time ve sale contact düzeltme sunar. Her mutation ayrı idempotent intent ve parent expectedVersion taşır. WAITING_APPROVAL içerik kilitlidir; önce mevcut withdrawal. REVISION_REQUESTED durumunda veri düzeltmesi mümkündür; resubmit için mevcut RESUME gerekir. Tamamlanan/iptal/geçersiz satış satırları ve snapshot'ları düzenlenmez. Aktif satış reason'lı CANCEL kullanır. ADMIN'in mevcut INVALIDATE yetkisi korunur; terminal reversal veya financial credit-note eklenmez.

Ziyaretin sonradan iptali, geçersiz kılınması, onaylanması veya düzeltilmesi satışı otomatik değiştirmez. Satış incelemesinde erişilebilir kaynağın güncel durumu bilgi olarak gösterilir; kaynak kapanmış diye satış approval'a yeni bir lifecycle bağımlılığı eklenmez. Ziyaretin müşteri/kişi değişiklikleri kaynak snapshot'ını ve satış müşteri kimliğini değiştirmez. İlişki “oluşturulduğu sıradaki ziyaretten doğdu” anlamına gelir; canlı customer eşitliği dayatılarak ziyaret edit kuralı değiştirilmez.

## 6. UI akışı — Operate

Mevcut görsel otorite `DESIGN.md`; uygulama değerleri `web/src/ui/servora-visual-tokens.ts`, Ant eşlemesi `servora-ant-theme.ts`. Sale, mevcut JobDetail'ın yerel genişlemesi ve mevcut operasyonel create form düzeninin yeni tüketicisidir. Yeni palette, dependency veya selector tasarımı yoktur.

1. Uygun kaynak JobDetail'da ikincil **Satış oluştur** aksiyonu. Ana ziyaret lifecycle komutu yerini korur. Aktif satış varsa erişilebilir kartı açma aksiyonu; erişim yoksa yalnız güvenli “Bu ziyaret için aktif satış kaydı var” bilgisi.
2. Dedicated route önerisi `/jobs/:visitId/new-sale`; route-identity, paths ve route-access kayıtları üzerinden. Body'de customer/source override yok. Deep link'te backend bağlamı tekrar yüklenir.
3. Form sırası: kaynak ziyaret ve müşteri özeti → farklı etiketlerle planlanan kişi / ziyaret sonucunda görüşülen kişi → satışta görüşülen kişi (isteğe bağlı) → gerçekleşen satış zamanı → ProductSelect → isteğe bağlı açıklama → **Satış kaydını oluştur** / **Vazgeç**.
4. ProductSelect: arama → sonuçlar → **Seçilen ürünler**; her selected row **Miktar → Ürün kimliği/metadata → Kaldır**. 0.5 ve 0.001 desteklenir. Satış kendi form state'ini product ID ile tutar.
5. Başarıda yeni sale detail açılır; kaynak ziyarete güvenli dönüş ve bağımsız lifecycle görünür. Kaynak ziyarette bounded/paginated **Bağlı satışlar** bölümü; yeni kart linki ve durumu. Ziyaretin sonucu/durumu değişmemiştir.
6. Sale list/board/customer history/staff own history ve yönetici approval kuyruğunda `Satış kaydı` etiketi. Sale detail ürün satırlarını ve origin bağlamını gösterir. Approval review'da ürün/miktar ve gerçekleşme zamanı doğrulanır.

Form loading, context error, no active contacts/products, invalid quantity, pending, ambiguous retry, active-sale conflict, version conflict ve success durumlarını açıkça sunar. Kaynak/kişi/ürün erişim hatası başka kayıttan fallback ile giderilmez. Pending/ambiguous durumda semantik alanlar ve cancel kilitlenir; özgün istek retry edilir. Realtime yoksa GET/refetch ile truth yenilenir.

Dedicated page tercihinin nedeni uzun ürün metadata'sı, mobil miktar girişi ve retry bağlamıdır. Lifecycle reason/confirmation işlemleri mevcut Servora-owned dialog adapter'larında kalır. ProductSelect'e raw Ant import eklenmez. Native number input korunur; miktar biçimi sessizce tam sayıya çevrilmez.

## 7. Entegrasyon ve raporlama sınırı

| Alan | Planlanan entegrasyon |
| --- | --- |
| JobCard repository/DTO | Yeni sale origin sütunu + subtype details/items; açık SALE mapper/branch. Normal generic create/follow-up type allowlist'lerine SALE eklenmez. |
| Authorization/readiness | Mevcut role/organization/assignee scoping; explicit sale requirements. Source uygunluğu yalnız create için; sale approval source completion beklemez. |
| Timeline/audit | `JOB_CREATED`, ürün satırı ve detay event'leri; kaynakta tek `SALE_FROM_VISIT_CREATED`. Mevcut lifecycle event'leri tekrar kullanılır; approval için ikinci completion event'i yok. |
| Notification | Mevcut create→`job.assigned`, submit→yönetim `job.awaiting_approval`, approve/revision/cancel→assignee. Yönetimin ilk görünürlüğü list/realtime ile; her create'e yeni bildirim kind'i eklenmez. |
| Realtime | Bodyless mevcut job events; sale/source/customer/workspace/report invalidation. Sale ilişkisi follow-up source parametresine sokulmaz. Privacy audience değişmez. |
| CRM/contact/product lifecycle | Customer history'de SALE; sale contact/provenance refs hard-delete history guards'a eklenir. Product `hasOperationHistory` sale items'ı da kapsar. Pasifleştirme tarihsel snapshot'ları yeniden yazmaz. |
| Raporlar/Staff | Productive type listesine SALE; açık iş/onay/revision ve type bucket parity. WEEKLY_REPORT exemption'ları korunur. Yeni sale monetary/quantity report bu slice'da yapılmaz. |
| Delivery / meeting reports | Delivery quantity/purpose yalnız PRODUCT_DELIVERY; meeting outcome yalnız SALES_MEETING. Satış satırları teslimat sayılarına eklenmez. |
| Weekly source-work | SALE productive source olarak mevcut WAITING_APPROVAL/COMPLETED snapshot kapsamına eklenir; geçmiş weekly snapshot'ları yeniden hesaplanmaz. |
| Calendar/reminders | Sale bir ikinci saha ziyareti değildir. scheduledAt/EndsAt/dueDate null; takvim interval/frequency kontrolü yok. Mevcut approval-wait takibi varsa SALE de operasyonel iş olarak ele alınır; ayrı scheduler eklenmez. |
| Messaging / notes | Generic job conversation scoping korunur. Sale notes mevcut append-only yapıdadır; invoice-capable type listesine SALE eklenmez. |

Bir source ve sale iki ayrı iş sayılır; bu açıkça operational workload'dur, ziyaret veya satış dönüşüm oranı değildir. Kaynakta POSITIVE görmek rapora satış sayısı eklemek için yeterli olmaz.

Kaynak/doküman farkı: DOM-006 assigned-to attribution der; mevcut `reports/repository.ts:323` içindeki bir completed counter `staff_completed_by` kullanır. Bu görev bu mevcut farkı düzeltmez veya bütün sayaçların assigned-to kullandığını iddia etmez. SALE bucket entegrasyonu mevcut metrik anlamını değiştirmeden yapılmalı; gelecekteki sale-specific istatistik assigned-to üzerinden ayrıca tanımlanmalıdır. Issue #369 açılmadı/incelenmedi.

## 8. Açık ürün önerileri ve kapsam dışı alanlar

Kabul edilmiş A1–A7 dışındaki şu seçimler öneridir: kaynak alt türleri; yalnız IN_PROGRESS create; BUSINESS-only ilk slice; SALE'in mevcut NEW/ACCEPTED başlangıcını izlemesi; optional sale contact; terminal satıştan sonra uygun ziyaret için yeni bağımsız kayıt. Tasarım bunların önerilen davranışını kesin olarak yazar; implementasyon sırasında sessiz alternatif seçilmez. Tasarım hazırlığı için bunlar blocker değildir.

Fiyat, para birimi, iskonto, gelir, tahsilat, ödeme, fatura/e-invoice, stok, lot/serial/expiry ile fiziksel teslim izleme, muhasebe ve sale→delivery otomasyonu kapsam dışıdır. Catalog referencePrice sale snapshot/request'ine alınmaz. Aynı ürün farklı ticari koşullarla ayrı satırlar gerektirirse ileride ayrıca line identity/price sözleşmesi tasarlanır; ilk slice product ID başına tek satırdır.

## 9. Design acceptance criteria

- A sale is a separate JobCard with an explicit SALE_FROM_VISIT origin and its own manager approval lifecycle.
- A visit has at most one sale in the canonical active-status set, enforced under concurrent distinct requests.
- Planned contact, source met contact and sale contact remain distinguishable and never overwrite the visit.
- Sale creation does not complete the visit, create a follow-up, deliver products or create financial entries.
- Staff access remains assignment-scoped and generic CRM/catalog mutation permissions remain unchanged.
- The five design documents identify source evidence, proposals, migrations, test matrices and browser acceptance gates.

Bu kabul ölçütleri tasarım içindir. Bu turda sale davranışı için build, runtime test veya browser acceptance çalıştırılmadı.
