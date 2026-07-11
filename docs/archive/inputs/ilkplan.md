> Archive notice: This file is a historical planning input. It is not an active source of truth. See `PRODUCT_REQUIREMENTS.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`, `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_API_DRAFT.md`, `SERVORA_MED_MVP_SLICES.md`, and `DECISIONS.md` for current decisions.

Evet, kod ajanına plan vermeden önce **bazı şeyleri netleştirmek çok iyi olur**. Çünkü şu anda fikir artık basit bir CRM değil; **JobCard merkezli, Kanban akışlı, çift onaylı, ürün teslim/satış/personel takip sistemi** haline geldi. Eklediğin dokümandaki “Kanban esnekliği + ticari veri zorunluluğu”, `JobCard` ana tablosu, durum geçişleri, çift onay ve DB invariant önerileri bence doğru çekirdek mimariyi tarif ediyor. 

Kod ajanına gitmeden önce şu kararları netleştirelim:

## 1. Ürünün ana kavramı kesinleşmeli

Bence sistemin merkezi kesin olarak şu olmalı:

**İş Kartı / JobCard**

Her şey bunun etrafında dönmeli:

* satış görüşmesi
* ürün teslimi
* numune bırakma
* tahsilat takibi
* müşteri ziyareti
* görev
* yönetici talimatı
* muhasebe onayı
* stoktan ürün çıkışı

Yani kod ajanına “önce müşteri modülü yap, sonra satış yap” demek yerine şunu demeliyiz:

**Önce JobCard domain modelini kur.**

## 2. Kart tipleri netleşmeli

İlk sürüm için kart tipleri fazla geniş olmamalı. Ben şunları öneririm:

* `PRODUCT_DELIVERY` — ürün / numune / kutu teslimi
* `SALES_MEETING` — müşteri/doktor görüşmesi
* `COLLECTION` — tahsilat takibi
* `GENERAL_TASK` — genel görev
* `QUOTE_FOLLOW_UP` — teklif takibi

İlk MVP’de en kritik olan:
**PRODUCT_DELIVERY + GENERAL_TASK + SALES_MEETING**

Tahsilat ve teklif takibi ikinci aşamaya bırakılabilir ama şemada genişlemeye uygun yer bırakılmalı.

## 3. Kanban durumları netleşmeli

Çok fazla kolonla başlamayalım. İlk sürüm için bence ideal akış:

1. `NEW` — Yeni
2. `PLANNED` — Planlandı
3. `IN_PROGRESS` — Devam Ediyor
4. `WAITING_APPROVAL` — Onay Bekliyor
5. `REVISION_REQUESTED` — Düzeltme Bekliyor
6. `COMPLETED` — Tamamlandı
7. `CANCELLED` — İptal Edildi

Kod ajanına özellikle şu söylenmeli:

**Kart durumu serbest text olmayacak. Enum/state machine olacak. Her geçiş kurallı olacak.**

## 4. Çift onay kuralı kesinleşmeli

Bence şu kural değişmez olmalı:

**Personel işi tamamladım diyebilir ama iş, yönetici/muhasebe onayı olmadan tamamlanmış sayılmaz.**

Bu yüzden veritabanında ayrı alanlar olmalı:

* `staff_completed_at`
* `staff_completed_by`
* `manager_approved_at`
* `manager_approved_by`
* `approval_note`
* `revision_reason`

Bu ayrım çok önemli. Çünkü ileride “personel geç mi kaldı, yönetici onayı mı gecikti?” sorusunu raporlayabiliriz.

## 5. Ürün teslim kartında zorunlu alanlar netleşmeli

Özellikle medikal/dental ürün tesliminde veri gevşek bırakılamaz.

`PRODUCT_DELIVERY` kartında şunlar zorunlu olmalı:

* müşteri / klinik
* doktor veya ilgili kişi, opsiyonel olabilir ama tavsiye edilir
* teslim eden personel
* ürün
* adet
* teslim tarihi
* teslim durumu
* ürün tipi / model
* lot / seri no, gerekiyorsa
* not

Kod ajanına şu kural net verilmeli:

**Ürün/adet/müşteri bilgisi olmayan teslim kartı `WAITING_APPROVAL` durumuna geçemez.**

## 6. Stok düşümü ne zaman olacak?

Bu çok kritik bir karar.

Üç seçenek var:

### Seçenek A — Personel teslim ettiğinde stok düşer

Riskli. Personel yanlış bilgi girerse stok bozulur.

### Seçenek B — Yönetici/muhasebe onaylayınca stok düşer

Daha güvenli. İlk sürüm için bunu öneririm.

### Seçenek C — Personel tesliminde “bekleyen stok hareketi”, onayda kesin stok hareketi

En doğru model bu.

Benim önerim:

**Personel teslim kartını onaya gönderdiğinde pending stock movement oluşsun. Yönetici/muhasebe onaylayınca final stock movement oluşsun.**

Bu mimari uzun vadede çok daha sağlam olur.

## 7. Kim kart açabilir?

Bunu da netleştirelim.

Benim önerim:

* Yönetici tüm personele kart açabilir.
* Personel kendi adına kart açabilir.
* Personel başka personele kart atayamaz.
* Yönetici kartı başka personele aktarabilir.
* Muhasebe sadece ilgili onay/tahsilat alanlarında yetkili olur.

Bu yapı hem esnek hem kontrollü olur.

## 8. Personel kartı değiştirme yetkisi ne zaman kilitlenir?

Bence kural şu olmalı:

* Kart `NEW`, `PLANNED`, `IN_PROGRESS` durumundayken personel düzenleyebilir.
* Kart `WAITING_APPROVAL` durumuna geçince personel ana alanları değiştiremez.
* Sadece not ekleyebilir.
* Yönetici `REVISION_REQUESTED` yaparsa personel tekrar düzenleyebilir.
* Kart `COMPLETED` olduktan sonra sadece admin düzeltme yapabilir veya audit log ile revizyon açılır.

Bu, sahadaki veri güvenliği için şart.

## 9. Activity log kesin olmalı

Bu sistemde her önemli hareket kayıt altına alınmalı:

* kart oluşturuldu
* personele atandı
* ürün eklendi
* adet değişti
* durum değişti
* not eklendi
* onaya gönderildi
* düzeltme istendi
* onaylandı
* iptal edildi

Kod ajanına net yazılmalı:

**Sadece son durumu saklama. Her kartın geçmişini zaman çizelgesi olarak sakla.**

## 10. Personel profil sayfası MVP’ye dahil edilmeli

Personel profil sayfası sonraya bırakılmamalı. Çünkü ürünün ana faydalarından biri bu.

İlk sürüm profil sayfasında şunlar yeterli:

* açık işler
* onay bekleyen işler
* tamamlanan işler
* geciken işler
* yaptığı ürün teslimleri
* müşteri notları
* aylık özet performans
* satış/teslimat toplamları

Daha gelişmiş grafikler ikinci aşamaya bırakılabilir.

## 11. Müşteri modeli netleşmeli

Müşteri sadece “firma adı” olmamalı.

Medikal/dental için şöyle olmalı:

* `Customer` — klinik, hastane, bayi, firma
* `Contact` — doktor, satın alma sorumlusu, sekreter, yetkili kişi
* `Address` — teslimat/fatura adresi
* `AssignedStaff` — sorumlu personel

Yani “doktor” ayrı bir kişi olarak tutulmalı. Çünkü aynı klinikte birden fazla doktor olabilir.

## 12. Ürün modeli netleşmeli

Ürün tarafı da restoran POS’taki `menu item` mantığından ayrılmalı.

Yeni model:

* ürün adı
* ürün kodu / SKU
* marka
* kategori
* model
* birim
* satış fiyatı
* stok miktarı
* kritik stok seviyesi
* lot/seri takibi var mı?
* son kullanma tarihi gerekiyor mu?

İlk sürümde lot/seri ve son kullanma tarihi opsiyonel bırakılabilir ama mimaride desteklenmeli.

## 13. Mobil öncelik netleşmeli

Personel sahada kullanacağı için ilk günden itibaren:

* responsive web
* telefonda rahat kart görüntüleme
* hızlı not ekleme
* ürün teslim girişi
* fotoğraf/dosya ekleme altyapısına hazır yapı
* düşük bağlantıda duplicate işlem engelleme

olmalı.

Ayrı mobil uygulama yok.
Ama **PWA uyumlu mobil web** hedeflenebilir.

## 14. Servora-POS dönüşüm stratejisi netleşmeli

Kod ajanına şunu açık söylemek gerekir:

**Bu bir restoran POS dönüşümü değil. Mevcut teknik altyapı kullanılacak, restoran domain’i yeni ürüne taşınmayacak.**

Yani:

* `tables`, `menu`, `kitchen`, `restaurant order` kavramları yeni domain’e karıştırılmamalı.
* Mevcut auth, role guard, db, test, reporting, websocket, backup gibi altyapılar korunabilir.
* Yeni domain modülleri ayrı açılmalı.

Önerilen yeni backend modülleri:

* `users`
* `staff`
* `customers`
* `contacts`
* `products`
* `inventory`
* `job-cards`
* `approvals`
* `activity`
* `reports`

## 15. Kod ajanına verilecek ilk görev çok geniş olmamalı

İlk görev şöyle olmalı:

**Servora-POS altyapısını incele, restoran domain’inden bağımsız yeni B2B Kanban CRM ürün mimarisi için refactor/extension planı çıkar. Henüz kod yazma.**

İlk çıktısı şunlar olsun:

* mevcut altyapıdan korunacak parçalar
* kaldırılacak/pasifleştirilecek restoran modülleri
* yeni domain modül listesi
* önerilen veritabanı şeması
* API endpoint taslağı
* role/permission matrisi
* MVP ekran listesi
* migration planı
* riskler

Bence kod ajanına doğrudan “uygula” demeyelim. Önce plan çıkarsın.

## Net cevap

Evet, netleştirmemiz gereken şeyler var ama çoğu artık karar seviyesine geldi.

Bence kod ajanına gitmeden önce en kritik 5 karar şunlar:

1. Sistemin ana nesnesi **JobCard / İş Kartı** olacak.
2. İş akışı **Kanban + state machine** olacak.
3. İşin bitmesi için **personel tamamladı + yönetici/muhasebe onayı** gerekecek.
4. Ürün teslimi yapılandırılmış veriyle tutulacak: müşteri, doktor, ürün, adet, model, tarih, teslim eden personel.
5. Stok hareketi personel beyanında değil, **onay sürecine bağlı kontrollü şekilde** oluşacak.

Bunları net yazarsak kod ajanı çok daha doğru bir mimari plan çıkarır.
