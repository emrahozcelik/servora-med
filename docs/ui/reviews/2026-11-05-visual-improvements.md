# Servora-Med — Görsel iyileştirme değerlendirmesi

Tarih: 5 Kasım 2026. İkinci inceleme; önceki raporun değerlendirmesi ve güncellenmiş öneriler.
Kaynak kodu: `197586fd6254a73ed362fa125f489da3ecb9be47`.
Durum: **ilk inceleme ve öneri kaydı.** Kullanıcının sonraki uygulama talebiyle
A–E dilimleri geliştirilmiştir; güncel uygulama, doğrulama ve kalan kabul sınırları
[uygulama kaydında](2026-11-05-visual-improvements-implementation.md) tutulur.
Bu belgedeki gözlemler uygulama öncesini anlatır; tek başına kabul kanıtı değildir.

Bu sürüm, [ilk raporun](../../evidence/visual-review-20261105/original-review.md)
yerini alır. Önceki ekran görüntüleri yeniden incelendi ve bulgular mevcut kaynakla
karşılaştırıldı. Bu revizyonda yeni ekran yakalaması veya uygulama değişikliği yapılmadı.

Bu belgede adı geçen ekran görüntüleri ürün sahibi tarafından yerel olarak
saklanır; depoda izlenmez ve `.gitignore` ile korunur. Metin kanıtları, koşucu
kaydı ve ölçümler izlenmeye devam eder.

## Değerlendirmem

İlk raporun ana tespitlerine katılıyorum: personelin kendi sayfasında günlük işe
erişim, müşteri detayında takip bilgisinin sırası, liste eylemlerinin ağırlığı ve
form tipografisi iyileştirilebilir. Mevcut görsel kimlik, AppShell ve Servora'nın
Ant adaptörleri bu çalışma için yeterli bir temel sağlıyor.

Ancak rapor, bazı çözümleri gereğinden erken seçiyor ve örnek verinin güvenilirliğini
fazla geniş yorumluyor. Güncel öneriler şu düzeltmeleri içeriyor:

| Önceki yaklaşım | Güncellenmiş değerlendirme |
| --- | --- |
| Uzun sayfayı kısaltmak | Asıl hedef günlük işlere ve gerekli bilgiye erişim. Piksel yüksekliği tek başına kalite ölçütü değil. |
| Analizi ve geçmişi sekme/açılır bölümlere taşımak | Önce içerik sırası ve tekrarlar düzeltilmeli. Günlük iş geçmişini gizlemek ek yük oluşturabilir; sekme seçimi henüz kesinleşmedi. |
| İkincil eylemleri menüde toplamak | Sık kullanılan düzenleme eylemi görünür ve kompakt kalabilir. Menü özellikle seyrek/destructive eylemler için düşünülmeli. |
| Süreç ve durum tekrarını azaltmak | Durum etiketi, süreç aşaması ve sıradaki sorumlu farklı gerçeklerdir. Görsel ağırlıkları azaltılabilir; birbirlerinin yerine geçemezler. |
| Personel dizinine mevcut sayaçları eklemek | DTO'da alan olması ekrana eklemek için yeterli gerekçe değil. Önce dizinin kullanım amacı netleşmeli. |
| Hata/taşma bulunmayan yakalamaları yeterli kanıt görmek | Yerleşim kanıtı geçerli; örnek veri, roller, etkileşimler ve erişilebilirlik kapsamı ayrıca belirtilmeli. |

## Kanıtın kapsamı ve düzeltilen sınırlar

İlk incelemede Codebase Memory ile bulunan ilişkiler kaynak koddan doğrulandı.
Yerel Vite, Playwright ve Chromium ile gerçek `App`, `AppShell`, yönlendirme,
sayfalar ve CSS kullanıldı. Müşteri listesi/detayı/oluşturma, ürün listesi,
personel dizini, personelin kendi profili ve iş listesi için **7 ekran × 2 genişlik**
yakalandı: 1440 ve 390 px, 1000 px viewport yüksekliği.

[Yakalama kayıtları](../../evidence/visual-review-20261105/capture-results.json)
14 görünümde sayfa hatası, beklenmeyen örnek API çağrısı, hata bildirimi ve belge
yatay taşması kaydetmiyor. Bu sonuç özgün koşunun kaydıdır; bu revizyonda yeniden
çalıştırılmış doğrulama değildir. Görseller ve özgün yakalama kodu artık
[kalıcı kanıt klasöründe](../../evidence/visual-review-20261105/README.md).

İkinci incelemede şu sınırlamalar doğrulandı:

- **Bazı örnek toplamlar tutarsız.** Personel raporundaki 8 açık + 3 onay + 1
  düzeltme işi, tür dağılımında toplam 8 gösteriliyor. Sunucu servisi bu dağılımın
  12 olmasını bekliyor. Müşteride “Açık (3) / Tamamlanan (12) / Tümü (4)” görülüyor;
  fixture aynı örnek iş listesini farklı müşteriler için döndürüyor. Bunlar üretim
  hatası bulgusu değil, örnek veri kusurlarıdır.
- **Normal veri ile stres verisi karışmış.** Personel raporu eski responsive
  fixture'dan uzun birim adı/büyük teslim miktarı ve Temmuz dönemi alırken diğer
  ekranlar Kasım tarihleri kullanıyor. Bu veri olağan içerik yoğunluğunu veya
  dönemler arası uyumu kanıtlamıyor. Uzun metin stresi ayrı senaryo olmalı.
- **Rol kapsamı sınırlı.** Kendi profilinde STAFF, kalan altı ekranda ADMIN var.
  MANAGER ve STAFF müşteri/iş akışları ayrıca görüntülenmedi. İş örneklerinin
  `allowedCommands` dizisi boş; satırdaki gerçek eylemlerin yerleşimi doğrulanmadı.
- **Sonraki form incelemesinde ek sınır bulundu:** Özgün fixture, `main.tsx` içindeki
  dış `ServoraAntProvider` katmanını kurmadan App'i render ediyor. Ant bileşenleri
  için bu eski görüntüler üretim tema/yerleşim kanıtı sayılmamalı. [Yeni iş formu
  incelemesi](2026-11-05-job-create.md) gerçek provider ile yapılmıştır.
- **Etkileşim ve bekleme kapsamı sınırlı.** Yalnızca dolu başlangıç görünümleri
  yakalandı. Hazır olma beklemesindeki zaman aşımı kodda yutulabiliyor; veri
  kimliğinin yerleştiği açıkça beklenmeli. Boş, yükleniyor, hata, menü, klavye,
  metin büyütme ve ara genişlikler bu 14 görüntünün kapsamı değil.

Bu sınırlar, aşağıdaki kaynakta görülen sıralama ve stil sorunlarını ortadan
kaldırmıyor. Sayısal sonuçların doğruluğu, tam iş akışı kabulü veya bütün uygulamanın
erişilebilir olduğu iddiasını engelliyor. Tam sayfa görüntüsündeki sabit alt menünün
ortada görünmesi de tek başına kalıcı örtüşme hatası kanıtı değildir.

## 1. Personelin kendi sayfası — ilk kapsamlı UI/UX dilimi

**Kanıtlı gözlem:** Dört profil bilgisi ayrı büyük kutularda. Üstteki operasyon
özeti ile gömülü rapor, aynı dört güncel iş yükü ölçümünü yeniden gösteriyor.
Bu eşleşme yalnız etiket benzerliği değil: PeopleService ve ReportsService aynı
`StaffOperationalSummary` alanlarını kullanıyor. “Bu ay tamamlandı” ile seçilen
dönem toplamı ise dönem eşitliği doğrulanmadan tek ölçüme indirgenmemeli.

Örnek mobil sayfa 5075 px; iş geçmişi yaklaşık 4283 px'de başlıyor. Bu değerler
yalnız ilgili fixture'a aittir. Daha güçlü bulgu, iş geçmişinin bütün analiz ve
dağılım tablolarından sonra gelmesidir. “Onaylı teslimler” ve “Görüşme sonuçları”
başlıkları da tablo başlığıyla görünür biçimde tekrarlanıyor.

**Öneri:** Kısa kimlik özeti → güncel operasyon yükü → mevcut işlere erişim →
dönem analizi sırası prototiplenmeli. Telefon/bölge/yönetici küçük, okunabilir bir
bilgi grubunda kalabilir. Aynı kapsamlı güncel ölçümler gömülü görünümde bir kez
sunulmalı; bağımsız rapor kendi bağlamını korumalı. Dönem, güncel iş yükü ve haftalık
rapor geçmişi birbirine karışmamalı.

İlk tasarım seçimi bütün ayrıntıları kapatmak olmamalı. Uzun hesap açıklamaları
“Nasıl hesaplanır?” gibi etiketli bir açıklamada sunulabilir; ölçümün temel kapsamı
yanında kalmalı. Tekrarlanan görünür tablo başlığı azaltılırken erişilebilir tablo
adı korunmalı. Açık işler ve geçmişe erişim sayfanın sonuna veya belirsiz bir menüye
taşınmamalı.

**Kaynak:** [OwnStaffProfileView](../../../web/src/StaffProfiles.tsx),
[StaffOperationalReport](../../../web/src/reports/StaffOperationalReport.tsx),
[PeopleService.withCounters](../../../server/src/modules/people/service.ts),
[ReportsService.currentWorkload](../../../server/src/modules/reports/service.ts).
Mobil kanıt: `staff-profile-390.png` (yerel),
masaüstü kanıt: `staff-profile-1440.png` (yerel).

Bu, Raporlar/Özet çalışmasından ayrı tutulmuş personel UI/UX dilimidir. Yeni
performans puanı, icracı atfı veya personel satış dönüşüm metriği bu tasarıma eklenmez.

## 2. Müşteri detayı — takip bilgisini ilk okumaya taşımak

**Kanıtlı gözlem:** ADMIN yakalaması uzun bir düzenleme formuyla başlıyor.
Operasyonel özet; genel bilgiler, kişiler ve silinememe açıklamasından sonra.
Mobil örnekte özet 1696 px, geçmiş 2269 px'de başlıyor. Kod MANAGER için de genel
bilgi formunu seçiyor; bu rolün bütün görünümü ayrıca doğrulanmış değil.

**Öneri:** Müşteri kimliği ve durumu, mevcut sorumlusu, son etkileşim, sonraki
planlı iş ve varsa takip bağlantısı ilk bilgi grubunda sunulmalı. Böylece kullanıcı
“En son ne oldu, sırada ne var?” sorusuna formu geçmeden yanıt bulabilir.
Mevcut `OperationalSummarySection` verileri bunun için yeterli başlangıçtır.
İletişim bilgileri ve ilgili kişilere erişim de günlük kullanımda görünür kalmalı.

Genel bilgilerin düzenlemesini açık bir “Düzenle” eylemiyle açmak uygun adaydır;
ancak bu yalnız CSS değişikliği değildir. Kaydedilmemiş taslak, kaydetme/vazgeçme,
sürüm çakışması, hata odağı, realtime yenileme ve STAFF'ın sınırlı bilgi tamamlama
akışı aynı dilimde korunmalıdır. “Silinemiyor” açıklaması günlük takibin önünde
büyük bir bölüm olmamalı; ilgili kayıt yönetimi bağlamında erişilebilir kalmalı.

“Sonraki iş yok” durumu “personel takip etmiyor” sonucuna çevrilmez. Olumlu görüşme,
takip işi ve onaylı SALE farklı kayıtlardır. Yeni dönüşüm iddiası veya müşteri/tarih
benzerliğinden üretilmiş ilişki eklenmez.

**Kaynak:** [CustomerDetailView ve CustomerDetailScreen](../../../web/src/CustomerDetail.tsx).
Mobil kanıt: `customer-detail-390.png` (yerel),
masaüstü kanıt: `customer-detail-1440.png` (yerel).

## 3. Ürün ve müşteri listeleri — eylemleri kullanım sıklığına göre düzenlemek

**Kanıtlı gözlem:** Mobil ürün satırlarında tam genişlikte “Düzenle” ve kırmızı
“Sil” eylemleri tekrarlanıyor; örnek satır aralıkları yaklaşık 260 px. Müşterilerde
de tam genişlikte düzenleme düğmesi var. Bu, DESIGN.md'nin içerik genişliğinde
düğme kuralıyla incelenmesi gereken bir uyumsuzluk; satır eylemleri form altlığı değil.

**Öneri:** Ad ve ayırt edici alanlar önce okunmalı. Üründe SKU/birim, müşteride
konum/sorumlu/ilgili kişi gibi mevcut bilgiler hizalanmalı. Kompakt, yazılı
“Düzenle” eylemi görünür kalabilir. Seyrek kullanılan “Sil” mevcut onayı korunarak
ikincil bir işlem alanına alınabilir. Sırf tek düzenleme eylemi için her müşteriye
yeni bir menü eklemek gerekli değil.

Metinleri küçültmek, 44 px dokunma hedefini daraltmak, yalnız hover'da görünen
komutlar veya isimsiz üç nokta eklemek uygun çözüm değil. Satır adı gerçek bağlantı
olarak kalmalı; menü açma/tıklama yanlışlıkla satır navigasyonunu tetiklememeli.
Ürün ve müşterinin ayırt edici alanları farklı; ortak görsel kurallar yeterli,
tek bir genel liste bileşeni bu raporun gereği değil.

**Kaynak:** [ProductResults](../../../web/src/ProductList.tsx),
[CustomerListView](../../../web/src/CustomerList.tsx), [styles.css](../../../web/src/styles.css).
Ürünler mobil: `products-390.png` (yerel),
müşteriler mobil: `customers-390.png` (yerel).

## 4. İş listesi — gerekli bilgiyi koruyarak hiyerarşiyi güçlendirmek

**Kanıtlı gözlem:** Başlık, tür, ilişkiler, süreç aşaması, işlem beklenen kişi,
durum/öncelik ve sağdaki metaveri benzer ağırlıkta. Örnek satırlar masaüstünde
yaklaşık 215 px, mobilde 300 px üzeri. Satır yüksekliği veri ve eylemlere bağlıdır;
bu ölçüleri sabit bir küçültme hedefi yapmamak gerekir.

**Öneri:** İş adı ve müşteri ilk okuma katmanında; mevcut durum, beklenen eylem
ve gerçek uyarılar sonraki katmanda olmalı. Sorumlu/tarih/tür daha sakin ve hizalı
gösterilebilir. DESIGN.md süreç özetini durum etiketinden ikincil tutar; mevcut
süreç bilgisini yalnız “tekrar” diyerek kaldırmak bu kurala aykırı olur.

Bu dilimin tasarımı gerçek `allowedCommands` bulunan STAFF/MANAGER örnekleriyle
tamamlanmalı. Gecikme, düzeltme, onay bekleme ve uzun isimler ayrıca görülmeli.
“Bitiş saati eksik” ilk fixture'ın eksik alanlarından doğan örnektir; normal
planlanmış işlerin tümünde görünüyormuş gibi tasarım kararı alınmamalı.

**Kaynak:** [JobRow](../../../web/src/jobs/JobRow.tsx),
[CompactWorkflowSummary](../../../web/src/jobs/CompactWorkflowSummary.tsx),
[DESIGN.md yaşam döngüsü rehberi](../../../DESIGN.md#job-lifecycle-guidance-detail-first).
Masaüstü kanıt: `jobs-1440.png` (yerel),
mobil kanıt: `jobs-390.png` (yerel).

## 5. Form etiketleri — küçük ve doğrulanabilir ilk iyileştirme

**Kanıtlı gözlem:** `.field-group label` 0.9rem/680 alırken `label.field-group`
aynı kuralı almıyor. Yeni müşteri formunda ilk iki etiket ile sonraki alanlar farklı
boyut/kalınlıkta. Yardım metni aralıkları da formun ritmini bölüyor.

**Öneri:** Önce müşteri formunda etiket, yardım, hata ve alan aralıklarını mevcut
token'larla tutarlı yapmak. Global bir CSS seçicisi değiştirilirse aynı işaretlemeyi
kullanan ürün/personel formları da kontrol edilmeli; yalnız müşteri görüntüsü yeterli
olmaz. Alanların zorunluluğu, sırası, doğrulaması ve etiket ilişkisi korunmalı.

Bu maddeyi ilk rapordaki son sıradan **ilk küçük görsel dilim** konumuna alıyorum:
kanıtı net, kapsamı sınırlanabilir ve sonraki ekranlara dil oluşturur. Kullanıcı
etkisi açısından personel/müşteri detayı hâlâ daha büyük fırsattır.

**Kaynak:** [CustomerCreateForm](../../../web/src/CustomerList.tsx),
[styles.css](../../../web/src/styles.css).
Mobil kanıt: `customer-create-390.png` (yerel),
masaüstü kanıt: `customer-create-1440.png` (yerel).

## 6. Ek bulgu — personel raporunun açıklaması hesapla uyuşmuyor

**Kaynakla doğrulanan uyumsuzluk:** `StaffOperationalReport` tamamlananları
“hâlen bu personele atanmış” diye açıklıyor; tür dağılımında da “mevcut atama”
diyor. `STAFF_SUMMARY_SQL` ve tamamlanma sorguları ise `staff_completed_by` kullanıyor.
Bu, yalnız uzun metin veya tipografi sorunu değil; kullanıcı sayıyı yanlış yorumlayabilir.

**Öneri:** Personel sayfası diliminde açıklama, mevcut tarihsel gönderim atfını ve
yönetici onaylı tamamlanmayı doğru anlatmalı. `staff_completed_by`, çalışmayı fiilen
yapanın yönetici tarafından doğrulanmış kimliği diye sunulmamalı.
[REPORT-001](../../features/reporting/README.md) bu yeni icracı sözleşmesini kabul
ediyor, ancak uygulaması hâlâ ayrı ve bekleyen kapsamdır. Çözüm SQL'i güncel atamaya
çevirmek veya eksik icracıyı tahmin etmek değildir.

**Kaynak:** [StaffOperationalReport](../../../web/src/reports/StaffOperationalReport.tsx),
[Reports repository](../../../server/src/modules/reports/repository.ts),
[REPORT-001](../../features/reporting/README.md#7-data-ownership-and-compatibility).
Bu raporda uyumsuzluk kaydedildi; metin veya hesap değiştirilmedi.

## Öncelik ve önerilen kabul ölçütleri

Sıra, yalnız görsel etkiye göre değil, kapsamın güvenle doğrulanabilmesine göre
öneriliyor. Aşağıdaki ölçütler **öneridir; çalıştırılmış veya kabul edilmiş değildir.**

| Sıra / dilim | Proposed acceptance criteria | Doğrulama odağı |
| --- | --- | --- |
| Hazırlık: tutarlı örnek veri | Baseline fixtures reconcile related counts, dates, roles and permissions; stress cases are separate. | Sonraki tasarım yakalamalarından önce |
| A — Form tutarlılığı | Equivalent labels share typography; hints/errors remain associated; affected forms remain operable at text enlargement. | Müşteri formu ve etkilenen ortak stil kullanıcıları |
| B — Personelin kendi sayfası | Current workload is shown once per scope; work/history access precedes detailed analytics; period and attribution remain explicit. | STAFF, dönem farkı, dolu/boş/hata, geçmiş ve PDF erişimi |
| B içinde — Açıklama doğruluğu | Completion copy matches existing historical submission attribution and makes no verified-performer claim. | Kaynak sorgu/sözleşme ve görünür açıklama |
| C — Müşteri detayı | Latest interaction and next planned work precede editing; drafts, conflicts, enrichment rights and focus behavior are preserved. | ADMIN/MANAGER/STAFF; takip var/yok; form durumları |
| D — Liste satırları | Names and identifying metadata are scannable; frequent actions stay discoverable; destructive confirmation and keyboard access remain intact. | Ürün ve müşteri; uzun adlar; eylem menüsü varsa açık hali |
| E — İş listesi | Status, phase, expected actor, schedule and warnings remain distinct; real permitted commands fit all affected layouts. | STAFF/MANAGER; aktif/geciken/düzeltme/onay; ara genişlikler |

Her dilim [varsayılan görsel inceleme yöntemi](../visual-review-workflow.md) ile,
aynı senaryonun önce/sonra görüntüleri ve göreve uygun etkileşim kontrolleri üzerinden
değerlendirilmeli. Sayfa boyunu azaltmak veya “daha modern” görünmek tek başına kabul
ölçütü değildir. Bütün uygulamaya tek seferde ortak CSS/komponent dönüşümü önerilmiyor.

## Korunacaklar ve henüz karar verilmeyenler

- Mevcut sakin renk sistemi, yazı ailesi, PageHeader/AppShell, mobil filtre paneli,
  isteğe bağlı kişi bölümü ve Servora Ant adaptörleri korunmaya değer.
- Personel dizininin sade olması hata değildir. Bölge, ekip yükü veya yeni sayaç
  eklemek için kullanıcının dizinde hangi kararı verdiği ayrıca belirlenmeli.
- Personel için sekme mi, yeniden sıralanmış tek sayfa mı daha iyi; iki yaklaşımın
  gerçek bileşenlerle örneklenmesiyle kararlaştırılmalı. Şimdiden evrensel bir
  sekme/açılır bölüm standardı konmuyor.
- Yeni satış dönüşüm grafikleri, icracı doğrulaması, gecikme açıklaması, performans
  puanlaması ve depo/finans bu görsel önerilerin uygulanmış parçası değildir.
- Takvim, mesajlaşma, ayarlar/yedekleme, bütün modal durumları ve raporlar ana
  ekranı bu incelemede yeniden yakalanmadı. Önceki rapor PR'ının testleri bu
  uygulama geneli incelemenin kanıtı olarak yeniden kullanılmıyor.

## Bu revizyonda yapılan doğrulama

Mevcut kaynak dosyaları, ilk yakalama kodu, JSON sonuçları ve seçilmiş mobil/masaüstü
görseller incelendi. İlk 14 görüntü, özgün rapor/runner ve dosya hash'leri saklandı.
Yeni Playwright koşusu, build, uygulama testleri, canlı sistem veya fiziksel cihaz
kontrolü yapılmadı. Bu çalışma rapor ve yöntem dokümantasyonudur; uygulama bulguları
düzeltilmiş veya tasarım dilimleri tamamlanmış sayılmamalıdır.

- **[passed]** `git diff --check`.
- **[passed]** Yerel Python belge kontrolü: 123 yerel bağlantı/başlık hedefi,
  17 özgün dosyanın SHA-256 değeri ve 14 yakalama kaydı doğrulandı.
- **[passed]** Düzenleme öncesi kopyalarla karşılaştırma: AGENTS.md'nin mevcut
  içeriği ve başka oturumlara ait iki operasyon belgesindeki değişiklikler korundu.
- **[not run]** Yeni Playwright yakalaması, web/server build ve uygulama testleri;
  bu revizyon yalnız dokümantasyon ve mevcut kanıtların arşivlenmesidir.
