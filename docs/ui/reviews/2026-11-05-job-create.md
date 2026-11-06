# İş oluşturma ekranları — görsel değerlendirme

Tarih: 5 Kasım 2026. Kaynak: `197586fd6254a73ed362fa125f489da3ecb9be47`.
Durum: ilk inceleme kaydı; aşağıdaki bulgular uygulama öncesine aittir.
Onaylanan görsel düzenlemelerin uygulaması ve doğrulama sınırları
[uygulama kaydında](2026-11-05-job-create-implementation.md) tutulur.
Kapsam: `/jobs/new-meeting`, `/jobs/new-task`,
`/jobs/new-delivery` ve bu sayfalara açılan “Yeni iş” menüsü.

## Önerilen yön

Üç ekran ortak başlık, alan grupları, aralıklar ve eylem düzeni kullanmalı.
Her işin kendi zorunlu alanları ve iş kuralları korunmalı. Mevcut tek sayfalık
form yaklaşımı yeterli; yeni bir çok adımlı sihirbaz için henüz gerekçe yok.
En acil konu, müşteri seçildikten sonra oluşan mobil yatay taşma.

## Gerçek bileşenlerden doğrulanan bulgular

Playwright + Chromium ile gerçek `App`, `AppShell`, router, `ServoraAntProvider`
ve CSS kullanıldı. Örnek müşteri/ürün/personel verileri API sınırında karşılandı.
İş oluşturma isteği gönderilmedi. [Kanıt ve yöntem ayrıntıları](../../evidence/job-create-review-20261105/README.md).

| Bulgu | Kanıt | Öneri |
| --- | --- | --- |
| Müşteri seçilince üç form da mobilde taşıyor. | 390 px viewport'ta dolu görüşme/görev sayfası 466 px, teslim sayfası 496 px genişliğinde yakalanıyor. Boş halleri taşmıyor. | Ortak müşteri seçiminin daralma/metin davranışı ve form/grid/fieldset sınırları birlikte düzeltilmeli; overflow'u gizleyerek içerik kesilmemeli. |
| Üç ekranın ana başlığı “Yeni iş”. | Mobil üst çubuk ve masaüstü H1/breadcrumb aynı genel adı gösteriyor. Tür alt açıklamada. | Tek route-identity kaynağından “Görüşme / ziyaret planla”, “Yeni genel görev”, “Yeni ürün teslimi” gibi açık başlıklar. Mobilde ikinci H1 eklenmemeli. |
| Formun ilk alanı aşağıda başlıyor. | Manager mobil örneklerinde ilk etiket yaklaşık y=395–398 px. Üstte dönüş, “Yeni kayıt”, tür açıklaması ve uzun giriş metni var. | Başlık ve bir kısa açıklamayla açılışı toparlamak; tekrarları ve üst boşluğu azaltmak. Yazıyı küçülterek sıkıştırmamak. |
| Teslim formunda tarayıcı fieldset çerçevesi var. | `delivery-form-fieldset` için task formundaki border/min-width/padding normalizasyonu yok; masaüstü ve mobilde ham çerçeve görünüyor. | Aynı semantik fieldset'i koruyarak üç oluşturma formunun ortak stilini uygulamak. |
| Görevin planlanan zamanı başlangıçta görünmüyor. | `scheduledLocal` varsayılan dolu; alan kapalı “Ek bilgiler” içinde ve doluysa isteğe dahil ediliyor. | Mevcut seçili planlama zamanını görünür sunmak veya kapalı bölüm özetinde açıkça göstermek. Varsayılan tarih politikasını bu tasarımda değiştirmemek. |
| Teslim ekranının metni planlama ve gerçekleşmeyi karıştırabiliyor. | “Teslim edilen ürünü…” ve “Teslimi kaydet” metinleri, planlanan teslim zamanı ile birlikte gösteriliyor. Oluşturma gerçekleşmiş teslim/onay anlamına gelmiyor. | İşlem sonucunu “Teslimat oluştur” gibi açık anlatmak; gerçekleşme ve yönetici onayının sonraki aşamalar olduğunu kısa biçimde belirtmek. |

Müşteri örneği “Merkez Ağız ve Diş Sağlığı Kliniği”; yapay olarak binlerce
karakterlik bir stres verisi değil. Görsel taşma kaydedilmiş bir hatadır; tam
CSS kök nedenini veya uygulanacak düzeltmeyi bu inceleme doğrulamış sayılmaz.
Varsayılan fieldset farkı ise kaynak ve görüntüyle birlikte görülüyor.

## Görüşme / ziyaret

Önerilen okuma sırası:

1. **Müşteri ve amaç:** müşteri, görüşme/ziyaret türü, başlık.
2. **Planlama:** sorumlu personel ve planlanan zaman; varsa mevcut planlama uyarıları.
3. **Ek bilgiler:** açıklama ve öncelik.

Masaüstünde sorumlu ve zamanı aynı grupta, mobilde alt alta sunmak daha tutarlı.
Şu an müşteri ile tarih yan yana; sorumlu bunların altında ayrı. Görüşme türünün
altı mevcut değeri korunmalı; iki büyük seçenek uğruna diğer türler kaldırılmamalı.
Normal önceliği ve isteğe bağlı açıklamayı daha sakin göstermek mümkün.

“Yeni müşteri ekle” yararlı bir yan akış; alan etiketiyle bitişik görünmek yerine
ayrı, erişilebilir bir ikincil eylem olmalı. Mevcut taslağın korunması ve kapatınca
odağın dönmesi uygulama kabulünde kontrol edilmeli.

“Yeni iş” menüsündeki “Yeni görüşme” etiketi müşteri ziyaretini de kapsadığını
daha açık anlatabilir. Mevcut mobil sheet ve masaüstü menü korunabilir.

**Sınır:** Sonuç, satışa dönüşüm veya follow-up ilişkisi planlama sırasında
üretilmez. `FOLLOW_UP` türünü seçmek, kaynak işe bağlı bir takip ilişkisinin
kurulduğunu tek başına kanıtlamaz; mevcut bağlantılı takip akışı ayrı kalır.

## Genel görev

Bu formun kısa çekirdeği korunmaya değer. Başlık, sorumlu ve planlama birlikte
okunmalı; açıklama alanı ihtiyaç oldukça büyüyebilir. Beş satırlık boş açıklama,
uzun placeholder ve altındaki uzun yardım metni bugün ilk ekranı büyük ölçüde
dolduruyor. Yardımı tek cümleye indirip ürün bağlamına uygun kısa bir örnek
(“Klinik eğitim materyallerini hazırla”) kullanmak daha yerinde.

Müşteri ve ilgili kişi isteğe bağlı kalmalı. Bunları kapalı ek bilgi bölümünde
tutmak uygun; bölüm adı içeriğini anlatmalı. Seçilmiş müşteri veya planlama varsa
kapalı bölüm özetinde anlaşılmalı. Kullanıcının görmediği dolu alanlar sessizce
formun önemli kısmı haline gelmemeli.

Görev açıklamasını sırf isteğe bağlı diye mutlaka gizlemek veya yeni zorunlu alanlar
eklemek önerilmiyor. Amacımız görevin anlaşılmasını ve hızlı oluşturulmasını sağlamak.

## Ürün teslimi

Önerilen gruplar: **Müşteri ve sorumlu → Ürünler ve miktarlar → Teslimat planı**.
Teslim amacı ve planlanan zaman aynı bölümde; not daha düşük ağırlıkta olmalı.

Mevcut ürün arama/seçme ve her seçilen ürünün kendi miktar alanı iyi bir temel.
İkinci bir sepet/ürün listesi oluşturulmamalı; miktar, ürün kimliği ve kaldırma
eylemi aynı satırda kalmalı. Teslimatta kesirli miktar desteği korunmalı; SALE'in
tam sayı kuralı bu forma taşınmamalı. Ürün kalemi sayısı gösterilebilir, farklı
birimleri toplayan yanıltıcı bir “toplam miktar” üretilmemeli.

STAFF ekranında sorumlu alanı hiç gösterilmiyor; görüşme/görevde kişinin adı sabit
gösteriliyor. Aynı görsel düzen için küçük bir “Sorumlu: Ayşe Örnek” bağlamı
düşünülebilir. Bu, personel seçtiren yeni bir adım olmamalı.

Teslim amacı `SALE`, ayrı onaylı SALE kartı veya satış başarısı anlamına gelmez.
Metin iyileştirmesi bu ayrımı korumalı; mevcut amaç ve planlama varsayılanlarını
değiştirmemeli.

## Ortak eylem ve hata düzeni

- Tek belirgin oluşturma/planlama eylemi; tutarlı vazgeçme yerleşimi ve en az
  mevcut dokunma hedefleri. DOM/klavye sırası görsel sırayla aynı kalmalı.
- Mobilde sabit bir alt eylem çubuğu ilk tercih olmamalı: mevcut alt navigasyon
  ve ekran klavyesiyle çakışma riski ayrıca incelenmeden eklenmemeli.
- Alan hataları alanın yanında, form özeti anlaşılır ve odaklanabilir kalmalı.
  Boş görüşme gönderiminde mevcut alan/özet hataları görüntülendi.
- Pending ve sonucu belirsiz istek durumlarında form kilidi ve özgün isteği
  tekrar deneme davranışı korunmalı. Görsel düzen adına yeni key ile retry,
  ikinci kayıt veya kaybolan taslak üretilmemeli.

## Önerilen uygulama sırası ve kabul ölçütleri

İlk dilim üç oluşturma ekranının mobil taşma, başlık, form kabı ve üst boşluk
tutarlılığı olabilir. İkinci dilim alan gruplarını ve açıklamaları düzenler.
Paylaşılan bileşenlere dokunulursa müşteri seçicinin diğer kullanıcıları ve
ProductSelect'in Sale/Delivery tüketicileri de etkilenme açısından kontrol edilmeli.

| ID | Proposed acceptance criterion — not implemented |
| --- | --- |
| CREATE-VIS-01 | Populated customer selections and product quantities remain readable and operable at 320/390 px, affected mid-widths and 200% text; no document overflow or hidden control content. |
| CREATE-VIS-02 | Header, breadcrumb, mobile title and document title identify the selected job type through the existing route registry. |
| CREATE-VIS-03 | Forms share field/section/action spacing; semantic fieldsets and keyboard order are preserved. |
| CREATE-VIS-04 | Selected scheduling values remain discoverable when optional sections are closed; existing required/default policies are unchanged. |
| CREATE-VIS-05 | Staff and management retain their existing assignment rights, validation, customer side-flow, pending and original-request retry behavior. |
| CREATE-VIS-06 | Product identity, quantity and remove controls remain together; no delivery/sale/result conflation is introduced. |

## Doğrulama ve sınırlar

- **[passed]** Son `node /tmp/servora-job-create-review-20261105/capture.mjs`
  koşusu 21 görünümü tamamladı; 42 PNG ve JSON ölçümleri üretildi. Sayfa hatası
  ve beklenmeyen API isteği yok; hata senaryosundaki beklenen form uyarısı ayrı.
- **[failed]** Yatay taşma gözlemi: dolu Manager görüşme/görev/teslim formlarının
  üçü de 390 px'de taşıyor. Toplayıcı bu bulguları sakladığı için exit 0, bütün
  görsel kontrollerin geçtiği anlamına gelmiyor.
- **[not run]** Gerçek kayıt oluşturma, backend doğrulaması, calendar açık durumlar,
  eksiksiz klavye/zoom/ekran okuyucu kabulü, fiziksel cihazlar, build ve test suite.
- Codebase Memory sorgusu bu oturumda cache dizini izin hatası verdi; keşif
  mevcut kaynak dosyaları üzerinden sürdürüldü, indeks değiştirilmedi.
- Yeni Playwright fixture'ı hazırlanırken yerel sunucu/Ant provider/seçici bekleme
  sorunları düzeltildi. Bunlar uygulama kusuru olarak raporlanmadı. Son kanıtlar
  gerçek Ant provider'ı içeriyor; sunucu ve Chromium koşu sonunda kapatıldı.

Kaynaklar: [SalesMeetingCreate](../../../web/src/SalesMeetingCreate.tsx),
[GeneralTaskCreate](../../../web/src/GeneralTaskCreate.tsx),
[DeliveryCreate](../../../web/src/DeliveryCreate.tsx),
[CustomerSearchSelect](../../../web/src/jobs/CustomerSearchSelect.tsx),
[ProductSelect](../../../web/src/ProductSelect.tsx),
[NewJobMenu](../../../web/src/jobs/NewJobMenu.tsx),
[styles.css](../../../web/src/styles.css),
[Product requirements](../../../PRODUCT_REQUIREMENTS.md),
[product selection contract](../../features/visit-to-sale/product-selection-ui-standardization-plan.md).
