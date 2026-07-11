> Archive notice: This file is a historical planning input. It is not an active source of truth. See `PRODUCT_REQUIREMENTS.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`, `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_API_DRAFT.md`, `SERVORA_MED_MVP_SLICES.md`, and `DECISIONS.md` for current decisions.

Evet, bu aşamada kod ajanına verilecek planı netleştirebiliriz. Mevcut Servora-POS tarafında ajan disiplini, küçük doğrulanabilir değişiklik, SSOT, backend source-of-truth, test ve build zorunluluğu zaten güçlü şekilde tanımlı; ayrıca mevcut POS’un CRM/cloud/mobile/advanced analytics gibi alanları V1 dışında bıraktığı görülüyor. Bu yeni proje tam olarak o dışarıda bırakılan alanları, ama yeni domain olarak, kontrollü biçimde inşa edecek.  

Aşağıdaki metni doğrudan `servora-med/SERVORA_MED_AGENT_PLAN.md` olarak koyabilirsin.

# SERVORA_MED_AGENT_PLAN.md

# Servora-Med — B2B Satış, CRM, Kanban İş Takip ve Personel Yönetim Sistemi

## 0. Proje Konumu

Bu proje, `servora-med` ana klasörü altında geliştirilecektir.

Mevcut durumda `servora-med` klasörü içinde eski teknik kaynak olarak `servora-pos` klasörü bulunmaktadır.

`servora-pos` bir restoran POS ürünüdür. Bu proje restoran POS ürünü değildir. Bu nedenle restoran domain’i yeni ürüne taşınmayacaktır.

Bu projede amaç:

* `servora-pos` içindeki teknik altyapıyı incelemek,
* kullanılabilir altyapı parçalarını tespit etmek,
* restoran domain’inden bağımsız yeni bir B2B satış / CRM / Kanban iş takip sistemi tasarlamak,
* yeni domain’i `Servora-Med` olarak inşa etmektir.

Kod ajanı hiçbir aşamada `servora-pos` domain kavramlarını doğrudan yeni ürüne kopyalamamalıdır.

---

## 1. Ürün Tanımı

Servora-Med; medikal ve dental ürün satışı yapan firmalar için geliştirilecek web tabanlı bir B2B satış, CRM, personel takip ve Kanban iş yönetim platformudur.

Sistem; yöneticilerin personelleri, müşterileri, ürün teslimlerini, satış/takip işlerini ve tamamlanan operasyonları takip edebilmesini sağlar.

Personeller mobil tarayıcı üzerinden sisteme girerek kendilerine atanan işleri görebilir, iş kartları oluşturabilir, müşteri/klinik notları ekleyebilir, ürün teslim kayıtları girebilir ve işleri onaya gönderebilir.

Bir iş, personel tarafından tamamlandı olarak işaretlense bile yönetici onayı olmadan tamamlanmış sayılmaz.

---

## 2. Temel Ürün Felsefesi

Ürünün ana felsefesi:

**Kanban esnekliği + ticari veri zorunluluğu**

Yani sistem kullanıcıya Notion/Trello benzeri iş kartı kolaylığı sunmalıdır. Ancak ticari olarak önemli veriler serbest metne bırakılmamalıdır.

Örneğin bir ürün teslim işi için şu veriler yapılandırılmış olarak tutulmalıdır:

* hangi kliniğe teslim edildi,
* hangi doktora veya ilgili kişiye teslim edildi,
* hangi ürün teslim edildi,
* ürünün cinsi/modeli neydi,
* kaç adet teslim edildi,
* teslim tarihi neydi,
* hangi personel teslim etti,
* işi kim onayladı,
* ne zaman onayladı.

Serbest not alanları olabilir, ancak raporlanması gereken ana bilgiler mutlaka veritabanında ayrı alanlar olarak tutulmalıdır.

---

## 3. Değişmez Mimari Kararlar

### 3.1 Ana Domain Nesnesi: JobCard

Sistemin merkezi nesnesi `JobCard` / `İş Kartı` olacaktır.

Her operasyon bir iş kartı üzerinden takip edilir.

Örnek iş kartı türleri:

* ürün teslimi,
* numune bırakma,
* müşteri/klinik ziyareti,
* doktor görüşmesi,
* genel görev,
* satış takibi,
* teklif takibi,
* tahsilat hatırlatma.

İlk MVP’de tüm türler kodlanmak zorunda değildir. Ancak model genişlemeye uygun olmalıdır.

### 3.2 Yönetici Onayı Sabit Kuraldır

Bir iş kartı personel tarafından tamamlanmış olarak işaretlenebilir, fakat yönetici onayı olmadan tamamlanmış sayılmaz.

Muhasebe veya depo onayı MVP kapsamında zorunlu değildir.

Şimdilik onay akışı:

1. Personel işi tamamlar.
2. Personel işi onaya gönderir.
3. Yönetici işi inceler.
4. Yönetici onaylarsa iş tamamlanır.
5. Yönetici uygun görmezse işi düzeltme bekliyor durumuna geri gönderir.

### 3.3 Depo ve Muhasebe Şimdilik Ayrı Modül Olarak Kodlanmayacak

Depo ve muhasebe süreçleri ileride ayrı modüller olarak eklenebilir.

MVP’de:

* depo modülü yapılmayacak,
* muhasebe modülü yapılmayacak,
* e-fatura/e-arşiv entegrasyonu yapılmayacak,
* tam muhasebe/cari hesap sistemi yapılmayacak,
* karmaşık stok muhasebesi yapılmayacak.

Ancak mimaride bu modüller için açık kapı bırakılmalıdır.

Örneğin:

* ürün teslim kayıtları ileride stok hareketlerine bağlanabilir,
* müşteri kayıtları ileride cari hesap modülüne bağlanabilir,
* tamamlanan işler ileride fatura/tahsilat sürecine bağlanabilir,
* ürün modeli ileride depo/lot/seri/son kullanma tarihi yönetimine genişleyebilir.

Ama bu bağlantılar MVP’de zorunlu değildir.

### 3.4 Restoran POS Domain’i Yeni Ürüne Taşınmayacak

Aşağıdaki kavramlar Servora-Med domain’ine doğrudan taşınmamalıdır:

* masa,
* adisyon,
* garson,
* kasa vardiyası,
* mutfak yazdırma,
* restoran menüsü,
* masa siparişi,
* restoran ödeme akışı,
* fiş/yazıcı odaklı POS mantığı.

Bu parçalar sadece teknik örnek olarak incelenebilir.

Korunabilecek teknik yaklaşımlar:

* Fastify backend yapısı,
* TypeScript modüler yapı,
* PostgreSQL migration yapısı,
* role guard / permission yaklaşımı,
* auth yaklaşımı,
* idempotency yaklaşımı,
* test disiplini,
* raporlama servis yaklaşımı,
* WebSocket altyapısı,
* backup/yedekleme yaklaşımı,
* error handling yaklaşımı,
* service/handler/route ayrımı.

---

## 4. Hedef Kullanıcı Rolleri

İlk MVP için önerilen roller:

### Admin

Sistemin tamamına erişebilir.

Yetkiler:

* kullanıcı yönetimi,
* rol yönetimi,
* tüm müşteriler,
* tüm ürünler,
* tüm iş kartları,
* tüm raporlar,
* sistem ayarları.

### Manager / Yönetici

Operasyonel yönetici rolüdür.

Yetkiler:

* personele iş kartı açma,
* iş kartı atama,
* iş kartı onaylama,
* düzeltme isteme,
* iptal etme,
* personel performansını görme,
* müşteri ve ürün kayıtlarını görme/düzenleme,
* raporları görme.

### Staff / Personel

Saha veya satış personelidir.

Yetkiler:

* kendi paneline giriş,
* kendisine atanmış işleri görme,
* kendi iş kartlarını oluşturma,
* müşteri notu ekleme,
* ürün teslim bilgisi girme,
* işi onaya gönderme,
* kendi geçmiş işlerini görme,
* kendi performans özetini görme.

Personel başka personele iş atayamaz.

### Future Roles

Aşağıdaki roller ileride eklenebilir, ancak MVP’de zorunlu değildir:

* Warehouse / Depo,
* Accounting / Muhasebe,
* Finance,
* Readonly auditor.

Bu roller için kodda aşırı soyutlama yapılmamalı, ancak domain sınırları kapatılmamalıdır.

---

## 5. JobCard Türleri

İlk aşamada şu kart türleri desteklenmelidir veya şema buna hazır olmalıdır:

### PRODUCT_DELIVERY

Ürün, numune veya kutu teslimi için kullanılır.

Zorunlu bilgiler:

* müşteri/klinik,
* sorumlu personel,
* ürün,
* adet,
* teslim tarihi,
* teslim açıklaması veya notu.

Opsiyonel bilgiler:

* doktor/ilgili kişi,
* ürün modeli,
* lot/seri no,
* teslim fotoğrafı veya belge,
* özel açıklama.

### SALES_MEETING

Müşteri, klinik veya doktor görüşmesi için kullanılır.

Bilgiler:

* müşteri/klinik,
* doktor/ilgili kişi,
* görüşme tarihi,
* görüşme notu,
* sonraki takip tarihi,
* sorumlu personel.

### GENERAL_TASK

Genel görevler için kullanılır.

Bilgiler:

* başlık,
* açıklama,
* atanan personel,
* öncelik,
* son tarih,
* durum.

### QUOTE_FOLLOW_UP

Teklif takibi için kullanılabilir.

MVP’de tam teklif modülü yapılmayabilir, ama ileride bağlanabilecek şekilde kart türü olarak düşünülebilir.

### COLLECTION_FOLLOW_UP

Tahsilat takibi için kullanılabilir.

MVP’de muhasebe modülü yapılmayacak. Bu nedenle bu kart türü ilk aşamada opsiyonel veya pasif bırakılabilir.

---

## 6. JobCard Durumları

Kart durumları serbest metin olmayacaktır. Enum/state machine kullanılacaktır.

Önerilen MVP durumları:

1. `NEW` — Yeni
2. `PLANNED` — Planlandı
3. `IN_PROGRESS` — Devam Ediyor
4. `WAITING_APPROVAL` — Onay Bekliyor
5. `REVISION_REQUESTED` — Düzeltme Bekliyor
6. `COMPLETED` — Tamamlandı
7. `CANCELLED` — İptal Edildi

### Durum Geçiş Kuralları

Genel geçişler:

* `NEW` → `PLANNED`
* `NEW` → `IN_PROGRESS`
* `PLANNED` → `IN_PROGRESS`
* `IN_PROGRESS` → `WAITING_APPROVAL`
* `WAITING_APPROVAL` → `COMPLETED`
* `WAITING_APPROVAL` → `REVISION_REQUESTED`
* `REVISION_REQUESTED` → `IN_PROGRESS`
* `NEW` / `PLANNED` / `IN_PROGRESS` / `REVISION_REQUESTED` → `CANCELLED`

Yasak geçiş örnekleri:

* Personel doğrudan `COMPLETED` yapamaz.
* `COMPLETED` kart normal kullanıcı tarafından düzenlenemez.
* `CANCELLED` kart normal kullanıcı tarafından tekrar aktifleştirilemez.
* `WAITING_APPROVAL` durumundaki kartta personel ana ticari alanları değiştiremez.

---

## 7. Çift Aşamalı Tamamlama Modeli

İşin tamamlanması iki aşamadan oluşur.

### Aşama 1 — Personel Tamamlama Beyanı

Personel işi tamamladığını belirtir.

Bu sırada tutulacak alanlar:

* `staff_completed_at`
* `staff_completed_by`
* `staff_completion_note`

Kart durumu:

* `WAITING_APPROVAL`

### Aşama 2 — Yönetici Onayı

Yönetici işi inceler ve onaylar.

Bu sırada tutulacak alanlar:

* `manager_approved_at`
* `manager_approved_by`
* `manager_approval_note`

Kart durumu:

* `COMPLETED`

### Düzeltme İsteme

Yönetici eksik veya yanlış bilgi görürse kartı düzeltmeye gönderebilir.

Bu sırada tutulacak alanlar:

* `revision_requested_at`
* `revision_requested_by`
* `revision_reason`

Kart durumu:

* `REVISION_REQUESTED`

---

## 8. Veri Kayıt ve Audit Mantığı

Sistem sadece son durumu saklamamalıdır.

Her kritik işlem activity log olarak saklanmalıdır.

Loglanacak işlemler:

* kart oluşturuldu,
* kart personele atandı,
* kart durumu değişti,
* ürün eklendi,
* ürün adedi değişti,
* müşteri değişti,
* not eklendi,
* personel işi onaya gönderdi,
* yönetici onayladı,
* yönetici düzeltme istedi,
* kart iptal edildi,
* kart tamamlandı.

Her log kaydında en az şu bilgiler olmalıdır:

* işlem tipi,
* ilgili kart,
* işlemi yapan kullanıcı,
* eski değer,
* yeni değer,
* zaman,
* açıklama/not,
* request/client action id, mümkünse.

Bu yapı ileride raporlama, performans analizi, denetim ve hata inceleme için kullanılacaktır.

---

## 9. Veri Modeli Taslağı

Kod ajanı kesin şemayı mevcut PostgreSQL migration yapısını inceleyerek önermelidir.

Başlangıç için önerilen tablolar:

### users

Mevcut auth yapısı korunabilir veya yeni domain’e uyarlanabilir.

Alanlar:

* id
* name
* username/email
* password/pin hash
* role
* is_active
* created_at
* updated_at

### staff_profiles

Personel profili.

Alanlar:

* id
* user_id
* title
* phone
* region
* manager_id
* monthly_target
* notes
* created_at
* updated_at

### customers

Klinik, hastane, bayi veya firma.

Alanlar:

* id
* name
* customer_type
* tax_number, opsiyonel
* phone
* email
* city
* district
* address
* assigned_staff_id
* status
* created_at
* updated_at

### contacts

Doktor, satın alma sorumlusu, sekreter veya ilgili kişi.

Alanlar:

* id
* customer_id
* name
* title
* phone
* email
* notes
* created_at
* updated_at

### products

Ürün kataloğu.

Alanlar:

* id
* sku
* name
* brand
* category
* model
* unit
* default_price
* track_lot
* track_serial
* track_expiry
* is_active
* created_at
* updated_at

### job_cards

Ana iş kartı tablosu.

Alanlar:

* id
* type
* status
* title
* description
* customer_id
* contact_id
* assigned_to
* created_by
* priority
* due_date
* planned_at
* started_at
* staff_completed_at
* staff_completed_by
* staff_completion_note
* manager_approved_at
* manager_approved_by
* manager_approval_note
* revision_requested_at
* revision_requested_by
* revision_reason
* cancelled_at
* cancelled_by
* cancel_reason
* created_at
* updated_at

### job_card_delivery_items

Ürün teslim kartları için detay tablo.

Alanlar:

* id
* job_card_id
* product_id
* quantity
* unit
* product_model
* lot_no
* serial_no
* expiry_date
* delivery_note
* created_at
* updated_at

### job_card_notes

Kart notları.

Alanlar:

* id
* job_card_id
* author_id
* note
* created_at

### job_card_activity_logs

Kart hareket geçmişi.

Alanlar:

* id
* job_card_id
* actor_id
* event_type
* old_value
* new_value
* metadata
* created_at

### attachments

İleride fotoğraf/belge yükleme için.

MVP’de dosya yükleme yapılmayacaksa bile tablo planı hazırlanabilir.

Alanlar:

* id
* owner_type
* owner_id
* uploaded_by
* file_name
* mime_type
* file_size
* storage_path
* created_at

---

## 10. Kritik Business Invariant’lar

Aşağıdaki kurallar backend ve mümkün olan yerlerde veritabanı seviyesinde korunmalıdır.

### Genel Kurallar

* Silme işlemleri hard delete olmamalı; mümkünse soft delete/status kullanılmalıdır.
* Tamamlanan kart normal personel tarafından değiştirilememelidir.
* İptal edilen kart normal personel tarafından değiştirilememelidir.
* Her durum değişikliği activity log üretmelidir.
* Yetkisiz kullanıcı kart görememeli veya değiştirememelidir.
* Personel sadece kendi kartlarını görebilmeli; yönetici tüm kartları görebilmelidir.

### PRODUCT_DELIVERY Kuralları

`PRODUCT_DELIVERY` kartı `WAITING_APPROVAL` durumuna geçmeden önce şu bilgiler mevcut olmalıdır:

* customer_id
* assigned_to
* en az bir delivery item
* her item için product_id
* quantity > 0
* teslim notu veya açıklaması, gerekiyorsa

### Yönetici Onayı Kuralları

* Sadece `admin` veya `manager` kart onaylayabilir.
* Personel kendi kartını doğrudan `COMPLETED` yapamaz.
* Onaylanan kartta `manager_approved_at` ve `manager_approved_by` dolu olmalıdır.
* Düzeltme istenen kartta `revision_reason` zorunlu olmalıdır.

### Idempotency Kuralları

Aşağıdaki işlemler duplicate request’e karşı korunmalıdır:

* kart oluşturma,
* kart durum değiştirme,
* ürünü teslim detayına ekleme,
* işi onaya gönderme,
* yönetici onayı,
* düzeltme isteme,
* iptal etme.

Mobil kullanımda aynı butona iki kez basma, bağlantı kopması veya tekrar deneme duplicate kayıt üretmemelidir.

---

## 11. UI / Frontend MVP Ekranları

İlk MVP için ekranlar:

### Login

* Kullanıcı girişi.
* Mobil uyumlu.

### Dashboard

Yönetici için:

* açık işler,
* onay bekleyen işler,
* tamamlanan işler,
* geciken işler,
* personel bazlı özet.

Personel için:

* bana atanan işler,
* onay bekleyen işlerim,
* düzeltme bekleyen işlerim,
* bugün yapılacaklar,
* son tamamlanan işler.

### Kanban Board

Kolonlar:

* Yeni
* Planlandı
* Devam Ediyor
* Onay Bekliyor
* Düzeltme Bekliyor
* Tamamlandı
* İptal

Öncelik:

* mobilde kullanılabilir olmalı,
* kartlar okunaklı olmalı,
* durum geçişleri backend kurallarına bağlı olmalı,
* frontend business rule uydurmamalı.

### Job Card Detail

Kart detay sayfası:

* başlık,
* tür,
* durum,
* müşteri,
* doktor/ilgili kişi,
* atanan personel,
* ürün teslim detayları,
* notlar,
* activity timeline,
* onaya gönder butonu,
* yönetici onay/düzeltme/iptal butonları.

### Customers

* müşteri listesi,
* müşteri detay,
* müşteriye bağlı kişiler,
* müşteriye bağlı iş kartları.

### Products

* ürün listesi,
* ürün detay,
* temel ürün bilgileri.

### Staff Profile

Personel profil sayfası:

* açık işler,
* tamamlanan işler,
* onay bekleyen işler,
* geciken işler,
* ürün teslim geçmişi,
* aylık özet performans,
* müşteri aktiviteleri.

### Reports

İlk aşamada sade raporlar:

* personel bazlı tamamlanan iş sayısı,
* personel bazlı bekleyen iş sayısı,
* müşteri bazlı ürün teslimleri,
* ürün bazlı teslim adetleri,
* tarih aralığına göre tamamlanan işler,
* geciken işler.

Gelişmiş grafikler sonraki aşamada detaylandırılabilir.

---

## 12. Mobil Web / VPS Kararı

Bu proje local-only LAN ürünü değildir.

Personeller sahadan erişeceği için sistem web tabanlı ve VPS üzerinde çalışacak şekilde planlanmalıdır.

MVP hedefi:

* responsive web,
* mobil tarayıcıdan kullanım,
* HTTPS/SSL uyumlu deployment,
* güvenli auth,
* rate limit,
* merkezi PostgreSQL veritabanı,
* otomatik yedekleme,
* ileride PWA desteğine uygun yapı.

Native mobil uygulama yapılmayacaktır.

Ancak frontend mobil öncelikli tasarlanmalıdır.

---

## 13. Servora-POS’tan Okunacak ve Değerlendirilecek Kaynaklar

Kod ajanı işe başlamadan önce `servora-pos` klasöründe aşağıdaki dosyaları okumalıdır:

1. `AGENTS.md`
2. `SERVORA_POS_NIHAI_V1_PLAN.md`
3. `docs/ARCHITECTURE_CONTRACT.md`
4. `docs/CODEBASE_MAP.md`
5. `docs/AGENT_CONTINUATION_PLAN.md`
6. `CONTEXT.md`
7. `HANDOFF.md`
8. `server/src/app.ts`
9. `server/src/db`
10. `server/src/middleware`
11. `server/src/modules/auth`
12. `server/src/modules/admin`
13. `server/src/modules/reporting`
14. `server/src/ws`
15. `server/tests`
16. `web/src/App.tsx`
17. `web/src/pages`
18. `web/src/services`
19. `web/src/hooks`

Amaç restoran POS davranışını taşımak değil, teknik mimariyi ve tekrar kullanılabilir altyapı yaklaşımını çıkarmaktır.

---

## 14. Korunabilecek Teknik Altyapılar

Kod ajanı aşağıdaki parçaları koruma veya uyarlama adayı olarak değerlendirmelidir:

* Fastify app bootstrap,
* TypeScript build yapısı,
* PostgreSQL bağlantı ve migration runner,
* error handling,
* auth middleware,
* role guard middleware,
* idempotency middleware,
* rate limit / security yaklaşımı,
* WebSocket altyapısı,
* reporting service pattern,
* test harness,
* backup script yaklaşımı,
* frontend API service yapısı,
* frontend auth hook yapısı,
* responsive React/Vite yapısı.

Her parça incelenmeli; doğrudan kopyalanacaksa domain bağımlılığı temizlenmelidir.

---

## 15. Taşınmaması Gereken POS Parçaları

Aşağıdaki parçalar yeni ürüne domain olarak taşınmayacaktır:

* tables,
* restaurant orders,
* menu items,
* kitchen printing,
* receipt printing,
* waiter/cashier restaurant roles,
* POS payment flow,
* restaurant shift/day close flow.

Bu modüller teknik örnek olarak okunabilir, ancak Servora-Med domain’ine çevrilerek kullanılması yasaktır.

Örneğin `menu_items` tablosu `products` diye rename edilmemelidir. Yeni ürün modeli kendi domain ihtiyaçlarına göre tasarlanmalıdır.

---

## 16. Geliştirme Aşamaları

### Phase 0 — Keşif ve Plan

Kod yazmadan önce yapılacaklar:

1. `servora-pos` yapısını oku.
2. Korunacak teknik parçaları listele.
3. Taşınmayacak restoran domain parçalarını listele.
4. Yeni Servora-Med domain modelini öner.
5. Migration planı çıkar.
6. API taslağı çıkar.
7. UI ekran taslağı çıkar.
8. Riskleri yaz.
9. Test stratejisi öner.

Bu fazın çıktısı:

* `SERVORA_MED_ARCHITECTURE_PLAN.md`
* `SERVORA_MED_SCHEMA_DRAFT.md`
* `SERVORA_MED_API_DRAFT.md`
* `SERVORA_MED_MVP_SLICES.md`

Kod ajanı Phase 0 tamamlanmadan uygulama koduna başlamamalıdır.

### Phase 1 — Proje İskeleti

Amaç:

* Servora-Med için yeni proje iskeleti oluşturmak.
* Servora-POS restoran domain’inden bağımsız yeni backend/frontend yapısını hazırlamak.

İşler:

* package/build/test yapısını netleştir,
* server/web klasörlerini Servora-Med için oluştur veya uyarlama planı çıkar,
* env örneklerini güncelle,
* app bootstrap oluştur,
* health endpoint oluştur,
* db bağlantısı ve migration altyapısını hazırla,
* temel test harness çalıştır.

Kabul kriterleri:

* backend build geçer,
* frontend build geçer,
* test komutu çalışır,
* health endpoint DB bağlantısını gösterebilir.

### Phase 2 — Auth ve Role Foundation

Amaç:

* kullanıcı girişi,
* rol bazlı yetki,
* manager/admin/staff ayrımı.

İşler:

* user model,
* auth endpointleri,
* role guard,
* current user endpoint,
* frontend login,
* route protection.

Kabul kriterleri:

* admin giriş yapabilir,
* manager giriş yapabilir,
* staff giriş yapabilir,
* staff yönetici ekranlarını göremez,
* manager staff işlemlerini görebilir/onaylayabilir.

### Phase 3 — Core Domain Foundation

Amaç:

* customers,
* contacts,
* products,
* staff profiles.

İşler:

* migration,
* service,
* route,
* handler,
* tests,
* frontend list/detail sayfaları.

Kabul kriterleri:

* müşteri oluştur/listelenir,
* kişileri müşteriye bağlayabilir,
* ürün oluştur/listelenir,
* personel profili görüntülenebilir.

### Phase 4 — JobCard Foundation

Amaç:

* ana iş kartı modelini kurmak.

İşler:

* job_cards migration,
* job_card_delivery_items migration,
* notes migration,
* activity_logs migration,
* JobCard service,
* state machine,
* validation,
* activity logging,
* idempotency.

Kabul kriterleri:

* kart oluşturulur,
* kart personele atanır,
* kart türü belirlenir,
* kart durumu kurallı şekilde değişir,
* activity log oluşur,
* invalid state transition reddedilir.

### Phase 5 — Product Delivery Flow

Amaç:

* ürün teslim kartının gerçek MVP akışını çalıştırmak.

Akış:

1. Yönetici veya personel `PRODUCT_DELIVERY` kartı açar.
2. Müşteri seçilir.
3. Ürün ve adet girilir.
4. Personel işi yürütür.
5. Personel onaya gönderir.
6. Yönetici onaylar veya düzeltme ister.
7. Onaylanan iş tamamlanır.

Kabul kriterleri:

* ürün/adet olmayan teslim kartı onaya gönderilemez,
* personel doğrudan tamamlayamaz,
* yönetici onayı olmadan kart completed olamaz,
* düzeltme istenirse personel tekrar düzenleyebilir,
* tamamlanan kart kilitlenir,
* her aşama loglanır.

### Phase 6 — Kanban UI

Amaç:

* iş kartlarını Kanban görünümünde göstermek.

İşler:

* kolon bazlı listeleme,
* kart detayına geçiş,
* durum değiştirme butonları,
* mobil uyumlu layout,
* manager ve staff görünüm farkları.

İlk aşamada drag/drop şart değildir. Butonlu durum geçişi yeterlidir. Drag/drop daha sonra eklenebilir.

Kabul kriterleri:

* staff kendi kartlarını görür,
* manager tüm kartları görür,
* onay bekleyen kartlar ayrı görünür,
* mobilde kullanılabilir.

### Phase 7 — Staff Profile

Amaç:

* personel profil sayfası.

İçerik:

* açık işler,
* onay bekleyen işler,
* düzeltme bekleyen işler,
* tamamlanan işler,
* ürün teslim geçmişi,
* aylık özet.

Kabul kriterleri:

* manager tüm personel profillerini görebilir,
* staff sadece kendi profilini görebilir,
* sayılar persisted data ile uyumludur.

### Phase 8 — Basic Reports

Amaç:

* sade yönetici raporları.

Raporlar:

* personel bazlı açık iş sayısı,
* personel bazlı tamamlanan iş sayısı,
* müşteri bazlı ürün teslimleri,
* ürün bazlı teslim adetleri,
* tarih aralığına göre tamamlanan işler,
* geciken işler.

Kabul kriterleri:

* raporlar veritabanındaki gerçek kayıtlardan hesaplanır,
* frontend business logic ile hesap uydurulmaz,
* tarih filtresi çalışır.

---

## 17. Test Stratejisi

Backend davranışı test edilmeden tamamlandı sayılmayacaktır.

Minimum test konuları:

* auth login,
* role guard,
* staff erişim sınırı,
* manager onayı,
* invalid state transition,
* product delivery required fields,
* activity log creation,
* idempotent job card creation,
* idempotent approval,
* completed card lock.

Frontend build en azından her fazda çalışmalıdır.

Beklenen doğrulama komutları mevcut proje yapısına göre ajan tarafından netleştirilmelidir.

Örnek:

```bash
cd server && npm run build
cd server && npm test -- --run
cd web && npm run build
```

Komutlar çalıştırılamazsa ajan nedenini açıkça raporlamalıdır. Çalıştırmadığı komutu çalışmış gibi göstermemelidir.

---

## 18. Güvenlik ve VPS Notları

Servora-Med internetten erişilecek bir sistem olarak tasarlanacaktır.

Bu nedenle:

* HTTPS/SSL zorunlu kabul edilmeli,
* rate limit olmalı,
* auth token/session güvenliği gözden geçirilmeli,
* şifre/PIN politikası güvenli olmalı,
* production secret’lar repoya yazılmamalı,
* database backup planı olmalı,
* error mesajları hassas bilgi sızdırmamalı,
* activity log ve audit kaydı tutulmalı,
* WebSocket varsa auth ve rate limit ile korunmalı.

İlk MVP’de çok kiracılı SaaS şart değildir. Tek firma/tek tenant yapısı yeterli olabilir.

Ancak kod, ileride multi-tenant olasılığını tamamen imkansız hale getirmemelidir.

---

## 19. MVP Dışı Bırakılanlar

Aşağıdakiler ilk MVP’ye dahil değildir:

* ayrı native mobil uygulama,
* tam depo yönetimi,
* tam muhasebe yönetimi,
* e-fatura/e-arşiv entegrasyonu,
* gelişmiş ERP entegrasyonu,
* karmaşık stok maliyetlendirme,
* tam teklif/sipariş/fatura zinciri,
* WhatsApp/SMS entegrasyonu,
* yapay zeka özellikleri,
* kullanıcıların kendi özel alanlarını oluşturduğu tam Notion benzeri esnek tablo sistemi,
* drag/drop Kanban zorunluluğu,
* gelişmiş BI dashboard.

Bu kapsamlar ileride eklenebilir.

---

## 20. Kod Ajanı Çalışma Kuralları

Kod ajanı şu kurallara uymalıdır:

1. Önce oku, sonra planla, sonra uygula.
2. `servora-pos` domain’ini yeni ürüne taşımadan teknik altyapıyı değerlendir.
3. Geniş refactor yapmadan önce faz/slice bazlı plan çıkar.
4. Her faz için acceptance criteria yaz.
5. Backend domain kuralları frontend’e bırakılmamalı.
6. Kritik kurallar service/database katmanında korunmalı.
7. Her kritik işlem activity log üretmeli.
8. Her durum geçişi state machine üzerinden yapılmalı.
9. Kullanıcı rolleri hardcoded karmaşa yaratmadan merkezi tanımlanmalı.
10. Test yazılmadan kritik backend davranışı tamamlandı sayılmamalı.
11. Doğrulama komutları çalıştırılmalı.
12. Çalıştırılamayan komutlar açıkça raporlanmalı.
13. Türkçe rapor verilmeli.
14. Belirsizlik varsa varsayım olarak yazılmalı; sessiz karar verilmemeli.
15. Gereksiz dependency eklenmemeli.
16. Restoran POS terminolojisi yeni domain’e sızdırılmamalı.

---

## 21. İlk Kod Ajanı Görevi

Kod ajanına verilecek ilk görev:

```text
Servora-Med projesi için Phase 0 keşif ve mimari plan çalışmasını yap.

Proje klasörü: servora-med
Kaynak teknik altyapı klasörü: servora-med/servora-pos

Önce servora-pos içindeki AGENTS.md, SERVORA_POS_NIHAI_V1_PLAN.md, docs/ARCHITECTURE_CONTRACT.md, docs/CODEBASE_MAP.md, docs/AGENT_CONTINUATION_PLAN.md, CONTEXT.md ve HANDOFF.md dosyalarını oku.

Bu proje restoran POS değildir. Restoran domain’ini taşımayacağız. Sadece teknik altyapıyı inceleyip Servora-Med için yeni B2B satış, CRM, Kanban iş takip ve personel yönetim sistemi mimari planını çıkaracağız.

Ürün kararları:
- Ana nesne JobCard / İş Kartı olacak.
- Kanban + state machine kullanılacak.
- Yönetici onayı sabit olacak.
- Personel işi onaya gönderecek, yönetici onaylamadan iş tamamlanmayacak.
- Depo ve muhasebe modülleri MVP’de kodlanmayacak, sadece ileride bağlanabilecek açık kapı bırakılacak.
- İlk domainler: users, staff_profiles, customers, contacts, products, job_cards, job_card_delivery_items, job_card_notes, job_card_activity_logs.
- Mobil web / VPS hedeflenecek.
- Native mobil uygulama yapılmayacak.
- Restoran POS kavramları yeni domain’e taşınmayacak.

Phase 0 çıktısı olarak şu dokümanları oluştur:
1. SERVORA_MED_ARCHITECTURE_PLAN.md
2. SERVORA_MED_SCHEMA_DRAFT.md
3. SERVORA_MED_API_DRAFT.md
4. SERVORA_MED_MVP_SLICES.md

Henüz uygulama kodu yazma. Önce mimari plan, şema taslağı, API taslağı, MVP slice planı ve riskleri çıkar.
```

---

## 22. Başarı Kriteri

Phase 0 başarılı sayılmak için kod ajanı şu sorulara net cevap vermelidir:

1. Servora-POS’tan hangi teknik parçalar korunabilir?
2. Hangi restoran domain parçaları taşınmamalıdır?
3. Servora-Med’in ana domain modeli nedir?
4. JobCard state machine nasıl çalışacaktır?
5. Yönetici onayı nasıl garanti edilecektir?
6. Product delivery kartı hangi zorunlu alanlara sahip olacaktır?
7. Depo ve muhasebe modülleri şimdilik nasıl dışarıda bırakılacaktır?
8. İleride bu modüllere nasıl açık kapı bırakılacaktır?
9. Hangi migration’lar gereklidir?
10. Hangi API endpoint’leri gereklidir?
11. Hangi frontend ekranları MVP’ye dahildir?
12. Hangi testler yazılmalıdır?
13. Hangi riskler vardır?
14. İlk uygulanacak vertical slice ne olmalıdır?

Bu cevaplar netleşmeden uygulama koduna başlanmamalıdır.

Kod ajanına ilk mesaj olarak sadece son bölümdeki **“İlk Kod Ajanı Görevi”** kısmını verebilirsin. Tam dokümanı da proje köküne koyarsan ajan hem kararları hem sınırları aynı yerden okur.
