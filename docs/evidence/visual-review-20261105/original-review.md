# Servora-Med — Görsel iyileştirme öncelikleri

Tarih: 5 Kasım 2026. Kaynak: `197586fd6254a73ed362fa125f489da3ecb9be47`.
Bu belge görsel inceleme ve öneri listesidir; uygulama veya yeni ürün politikası değildir.

## Yöntem ve kapsam

- Önce mevcut Codebase Memory indeksi sorgulandı. `PageHeader`, ilgili ekranlar ve `OperationalTable` kullanım ilişkileri çıkarıldı; bulgular mevcut kaynak dosyalardan doğrulandı. İndeks sıfırlanmadı veya yeniden oluşturulmadı.
- Önceki rapor çalışmasındaki gibi Playwright + Chromium, yerel Vite ve sentetik veriler kullanıldı. Gerçek `App`, `AppShell`, yönlendirme, sayfalar ve mevcut CSS render edildi. Üretim hesabı veya verisi kullanılmadı.
- Müşteri listesi, müşteri detayı, yeni müşteri, ürün listesi, personel dizini, personelin kendi profili ve iş listesi 1440 ve 390 px'de incelendi: 7 ekran, 14 görünüm.
- Son yakalamalarda JavaScript sayfa hatası, tanımsız örnek API isteği, hata bildirimi ve yatay taşma bulunmadı. Bu sonuç tam işlevsel kabul, ekran okuyucu veya fiziksel cihaz testi değildir.
- İnceleme uygulama kodunu değiştirmedi. Yerel sunucu ve Chromium yakalamalar sonunda kapatıldı. Geçici çalışma dosyaları ve kanıtlar bu klasördedir.
- Ekran görüntüleri ürün sahibi tarafından yerel olarak saklanır; depoda izlenmez.
  Bu belgedeki dosya adları yerel yakalamaları gösterir, depo bağlantısı değildir.

## 1. Personelin kendi sayfası — en yüksek öncelik

**Gözlem:** Kişisel bilgiler dört ayrı büyük kutuda gösteriliyor. Üstteki beş operasyon sayacından açık iş, onay, düzeltme ve gecikme alt raporda yeniden gösteriliyor. Örnek mobil görünüm 5075 px uzunluğunda; iş geçmişi yaklaşık 4283 px'de başlıyor. Teknik durum adları ve uzun hesap açıklamaları görsel ağırlığı artırıyor. “Onaylı teslimler” ve “Görüşme sonuçları” bölüm/tablo başlıkları art arda tekrarlanıyor.

**Öneri:** Kısa bir profil başlığı, tek operasyon özeti ve belirgin ayrıntı alanları oluşturmak. Mevcut yükümlülükler ile dönem sonuçlarını farklı bölümlerde tutmak; detaylı analiz ve geçmişi sekme veya açıkça etiketli açılır bölümlerde sunmak. Kişisel kimlik bilgisini küçük bir alanda toplamak. Mevcut sayaçları korumak; yeni performans puanı veya doğrulanmış icracı iddiası eklememek.

**Kaynak:** `web/src/StaffProfiles.tsx:82`, `web/src/reports/StaffOperationalReport.tsx:165`, `web/src/styles.css:351`.

**Kanıt:** Mobil: `staff-profile-390.png` (yerel), Masaüstü: `staff-profile-1440.png` (yerel).

Bu, daha önce ayrı bırakılan personel UI/UX slice'ı için doğrudan başlangıç adayıdır.

## 2. Müşteri detayı — operasyon bilgisini öne almak

**Gözlem:** Yönetim görünümü açık düzenleme formuyla başlıyor. Son temas, sonraki takip ve iş geçmişi; form, kişiler ve “Kalıcı silme” açıklamasından sonra geliyor. Örnek mobil görünümde operasyon özeti yaklaşık 1696 px, iş geçmişi 2269 px'de başlıyor.

**Öneri:** Başlangıç görünümünde müşteri kimliği, sorumlu personel, son temas ve sonraki planı öne almak. Genel bilgilerin düzenlenmesini açık bir “Düzenle” eylemine taşımak. İlgili kişiler ve geçmişi kendi bölümlerinde tutmak; silme bilgisini kayıt yönetimi alanında sunmak. Mevcut izinler, kayıt engelleri ve onay kuralları korunarak yalnız sunum değişmeli.

**Kaynak:** `web/src/CustomerDetail.tsx:208`; operasyon özeti şu anda `:234`'te.

**Kanıt:** Mobil: `customer-detail-390.png` (yerel), Masaüstü: `customer-detail-1440.png` (yerel).

## 3. Ürün ve müşteri listeleri — satır ve eylem hiyerarşisi

**Gözlem:** Ürün listesinde her kayıtta “Düzenle” ve kırmızı “Sil” bulunuyor; mobilde ikisi de tam genişlikte. Örnek ürün satırları yaklaşık 260 px yüksekliğe ulaşıyor. Müşteri satırlarında da her kaydın altında geniş bir düzenleme düğmesi var. Kayıt adları, metaveri etiketleri ve komutlar benzer ağırlıkta tekrarlanıyor.

**Öneri:** Kayıt adı ve ayırt edici iki-üç alanı öne çıkaran tutarlı satırlar. İkincil komutları erişilebilir bir “İşlemler” menüsünde veya detay sayfasında toplamak; silme onayını korumak. Masaüstünde kolon hizası, mobilde daha kısa kayıt özeti kullanmak. Her listeyi zorla aynı tabloya dönüştürmek yerine ortak başlık, metaveri ve komut kuralları belirlemek.

**Kaynak:** `web/src/ProductList.tsx:114`, `web/src/CustomerList.tsx:269`, `web/src/styles.css:3095`, `web/src/styles.css:3217`.

**Kanıt:** Ürünler mobil: `products-390.png` (yerel), Müşteriler mobil: `customers-390.png` (yerel), Ürünler masaüstü: `products-1440.png` (yerel).

## 4. İş listesi — aynı bilginin görsel tekrarını azaltmak

**Gözlem:** Bir satırda başlık, iş türü, müşteri/kişi, süreç sıra bilgisi, işlem beklenen kişi, durum etiketi, öncelik, sorumlu ve planlama bilgisi gösteriliyor. Süreç durumu hem metinde hem etikette tekrar ediyor; birçok metin kalın. Örnek masaüstü satırları yaklaşık 215 px, mobil satırlar 300 px üzeri.

**Öneri:** İş adı ve müşteriyi ilk okuma katmanına; durum ile beklenen aksiyonu ikinci katmana almak. Sorumlu, tarih ve diğer metaveriyi hizalı ve daha sakin göstermek. Süreç ve durum bilgisini kaybetmeden tekrarların görsel baskısını azaltmak. Gecikme ve eksik planlama gibi gerçek uyarıları belirgin tutmak.

**Kaynak:** `web/src/jobs/JobRow.tsx:114`, `web/src/jobs/CompactWorkflowSummary.tsx:18`, `web/src/styles.css:1648`.

**Kanıt:** Mobil: `jobs-390.png` (yerel), Masaüstü: `jobs-1440.png` (yerel).

Yakalamadaki “Bitiş saati eksik” uyarısı örnek verinin durumudur; üretim verisinde hata bulunduğu iddiası değildir.

## 5. Ortak form etiketleri — küçük ve yaygın bir iyileştirme

**Gözlem:** `.field-group label` etiketi 0.9rem/680 kullanırken doğrudan `label.field-group` aynı kuralı almıyor. Yeni müşteri formunda ilk iki etiket ile sonraki etiketlerin boyut ve kalınlığı bu yüzden farklı. Yardım metinlerinin alanla ilişkisi ve dikey aralıklar da tutarsız görünüyor.

**Öneri:** Mevcut görsel token'larla ortak etiket, açıklama, hata ve alan grubu kuralları oluşturmak. Zorunlu/isteğe bağlı bilgisini tipografik tesadüfe bağlamamak. Önce müşteri formunda doğrulayıp aynı işaretlemeyi kullanan formlara kontrollü taşımak; tüm form altyapısını bir kerede değiştirmemek.

**Kaynak:** `web/src/styles.css:172`, `web/src/CustomerList.tsx:325` ve `:336`.

**Kanıt:** Mobil: `customer-create-390.png` (yerel), Masaüstü: `customer-create-1440.png` (yerel).

## İkincil fırsat: personel dizini

Personel dizini yalnız ad, unvan ve yönetici gösteriyor. Mevcut DTO'da bulunan bölge ve güncel operasyon sayaçları, sonraki bir yönetim görünümünde yardımcı olabilir. Bu bir hata değil, mevcut veriyi daha yararlı sunma fırsatıdır; karşılaştırmalı başarı puanı önerilmez.

**Kaynak:** `web/src/StaffProfiles.tsx:191`. Masaüstü: `staff-directory-1440.png` (yerel).

## Korunacak güçlü yönler

- Mevcut renk, Inter/system yazı ailesi, sayfa başlığı ve uygulama kabuğu yeni bir görsel kimlik gerektirmiyor.
- Müşteri filtreleri mobilde zaten açılır bir panelde. İsteğe bağlı ilgili kişi formu zaten açılır bölümde; bunların yeniden yapılmasına ihtiyaç yok.
- Mevcut ortak Ant bileşenleri, durum görünümleri ve erişilebilir komutlar yeni tasarım için kullanılabilir. Yeni UI kütüphanesi gerekmiyor.

## Uygulama sırası önerisi

1. Personelin kendi sayfası: tek özet ve daha kısa bilgi akışı.
2. Müşteri detayı: özet ve takibin ilk görünümde olması.
3. Ürün/müşteri listeleri: tutarlı kayıt satırı ve ikincil eylemler.
4. İş listesi: tipografi ve metaveri hiyerarşisi.
5. Ortak form etiketleri: ayrı küçük, kontrollü görsel düzeltme.

Takvim, mesajlaşma, yedekleme/ayarlar ve tüm modal durumları bu turda yeniden görüntülenmedi. Bu belge bütün uygulama için tamamlanmış WCAG veya iş akışı kabulü değildir.
