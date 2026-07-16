# Servora-Med kullanıcı kılavuzu

Bu kılavuz **pilot ve günlük kullanım** içindir. Kurulum için [README](../../README.md) ve [macOS Tunnel runbook](../operations/local-macos-cloudflare-tunnel.md) belgelerine bakın.

Uygulamadaki menü adları ve ekranlar gerçek arayüzle uyumludur. Yetki kuralları sunucu tarafından uygulanır.

---

## 1. Servora-Med nedir?

Servora-Med; medikal/dental saha ekiplerinin **iş kartları (JobCard)** üzerinden ürün teslimi, genel görev ve satış görüşmesi kaydettiği, yöneticinin **onay** veya **düzeltme** verdiği tarayıcı tabanlı bir operasyon uygulamasıdır.

Depo, fatura, muhasebe ve stok maliyeti bu kılavuzun kapsamı dışındadır.

---

## 2. Roller

| Rol | Türkçe etiket | Özet |
|-----|----------------|------|
| **ADMIN** | Sistem yöneticisi | Kullanıcı yönetimi + yönetici yetkileri |
| **MANAGER** | Yönetici | Organizasyon geneli işler, onay, CRM, ürün, raporlar |
| **STAFF** | Personel | Kendi işleri, kendi teslim/görüşme kayıtları, kendi profili |

---

## 3. Giriş, ilk parola, çıkış

### Giriş

1. Tarayıcıda pilot adresinizi açın (ör. `https://app.example.com`).
2. E-posta ve parolanızı girin.
3. Başarılı girişte **İşler** (`/jobs`) ekranına yönlendirilirsiniz.

### İlk girişte parola değiştirme

Yönetici sizi geçici bir başlangıç parolasıyla oluşturduysa, girişten sonra **Parolanızı değiştirin** ekranı açılır:

- Mevcut parola
- Yeni parola
- Yeni parolayı doğrulayın
- **Parolayı değiştir**

Parola değiştirilene kadar diğer işlere devam edilemez. Bu zorunluluk **ilk giriş / `mustChangePassword` bayrağı** ile ilgilidir; ayrı bir “geçici parola süre sonu” sayacı bu ürün kapsamında yoktur. **Oturumu kapat** ile çıkabilirsiniz.

### Çıkış

Sağ üstte (masaüstü) veya menüde **Oturumu kapat**.

---

## 4. Ana navigasyon

| Menü | Yol | Kim görür |
|------|-----|-----------|
| **İşler** | `/jobs` | Herkes |
| **Müşteriler** | `/customers` | Herkes (personel kapsamı sınırlı) |
| **Ürünler** | `/products` | Herkes (personel salt okunur) |
| **Raporlar** | `/reports` | Yönetici ve sistem yöneticisi |
| **Kullanıcılar** | `/users` | Yalnız sistem yöneticisi |
| **Personel** / **Profilim** | `/staff` | Yönetici: personel listesi; personel: kendi profili |

Mobilde dar ekranda menü çekmecesi kullanılır; masaüstünde yan/üst navigasyon görünür.

---

## 5. İş kartı yaşam döngüsü (özet)

Tipik akış:

```text
Yeni → Planlandı → Devam ediyor → Onay bekliyor → Tamamlandı
                              ↘ Düzeltme istendi → Devam ediyor
```

İş iptal edilebilir (yetkili kullanıcı + gerekçe).
**Personel, işi doğrudan “Tamamlandı” yapamaz**; onaya gönderir, yönetici onaylar.

### Bir düğme yoksa veya devre dışıysa

Aynı durumun birkaç nedeni olabilir; hepsi “yetkim yok” demek değildir:

| Neden | Ne anlama gelir |
|-------|------------------|
| **Rol yetkisi** | Bu rol o komutu hiç kullanamaz (ör. personel **Onayla** göremez). |
| **İş kartı durumu** | Komut bu statüde geçersizdir (ör. zaten **Tamamlandı** iken **Onaya gönder** yok). |
| **Doğrulama / eksik alan** | Zorunlu alan veya teslim kalemi eksik; komut sunucu tarafında reddedilir veya UI tamamlanmayı bekler. |
| **Yükleniyor / istek sürüyor** | Önceki kayıt veya komut bitmeden düğme kilitli olabilir; bitmesini bekleyin veya hata mesajını okuyun. |

---

## 6. Ortak ekran davranışları

- **Yükleniyor / boş / hata:** Listeler ve detaylar bu üç durumu gösterir. Hata ekranında **Tekrar dene** varsa kullanın.
- **Hızlı iş görünümleri:** **Aktif işler**, yönetici için **Onay kuyruğu**,
  **Düzeltme istenenler** ve **Biten işler** bağlantıları mevcut filtre bağlamında hızlı geçiş
  sağlar. **Biten işler**, hem **Tamamlandı** hem **İptal edildi** kayıtlarını gösterir.
- **Version conflict:** Başka biri işi değiştirdiyse işlem reddedilebilir; sayfayı yenileyip güncel haliyle tekrar deneyin.
- **Notlar:** İş detayında **Notlar** bölümüne iş notu eklenir (salt metin; zorunlu yapılandırılmış alanların yerini tutmaz).
- **Aktivite:** Aynı detayda zaman çizelgesi; olay etiketleri Türkçe gösterilir.

---

## 7. Personel (Staff) kılavuzu

### 7.1 Product Delivery (ürün teslimi)

1. Menüden **İşler**’e gidin (`/jobs`).
2. Yeni teslim oluşturmayı seçin (`/jobs/new-delivery`).
3. **Müşteri** seçin; ardından **İlgili kişi** listesi dolar.
4. **Sorumlu personel** personel rolünde sizsiniz (değiştirilemez).
5. **Ürün** arayıp seçin; **Teslim amacı**, **Miktar**, **Teslim zamanı** girin.
6. **Teslimi kaydet** — kayıt sonrası iş detayına gidersiniz.
7. Detayda duruma göre **Planla** / **Başlat** komutlarını kullanın.
8. Gerekli ürün kalemleri tamamsa **Onaya gönder**.
9. Yönetici **düzeltme** isterse gerekçeyi okuyun, düzeltin, yeniden onaya gönderin.

### 7.2 General Task (genel görev)

1. `/jobs/new-task` — **Başlık** zorunludur.
2. İsteğe bağlı müşteri / ilgili kişi yalnızca bağlam içindir.
3. Kaydedin; onay akışı teslimle aynıdır.
4. Ürün teslim kalemi **yoktur**.

### 7.3 Sales Meeting (satış görüşmesi)

1. `/jobs/new-meeting` — planlama: başlık, müşteri, planlanan gün, sorumlu.
2. Görüşme **Yeni** veya **Planlandı** durumundayken sonuç ve not bölümleri gösterilmez.
   **İşi başlat** komutundan sonra bu bölümler açılır.
   Görüşmenin başlık, açıklama, müşteri, ilgili kişi, planlanan gün ve öncelik bilgileri tüm
   aktif aşamalarda **Görüşmeyi düzenle** ile değiştirilebilir. Yönetici ayrıca sorumluyu
   değiştirebilir.
3. Detayda **Görüşme sonucu**:
   - Gerçekleşme zamanı
   - Sonuç (Pozitif / Takip gerekli / Karar verilmedi / İlgilenmiyor)
   - Görüşme özeti
   - Takip zamanı (isteğe bağlı)
   Sonuç formu ilk açıldığında gerçekleşme zamanı güncel yerel saatle doldurulur; gerekirse
   değiştirebilirsiniz.
4. **Görüşme sonucunu kaydet**, notlarınızı ekleyin, sonra **Onaya gönder**. Değişmemiş bir
   sonuç yeniden gönderilmez ve bunun yerine kaydedilecek değişiklik olmadığı açıklanır.
5. Onay beklerken gönderilen içerik salt okunurdur. Düzeltme gerekiyorsa **Onaydan geri çek
   ve düzenle** ile işi `Devam ediyor` durumuna alın, değiştirin ve yeniden gönderin.
6. Kendi görüşmenizi **Yeni**, **Planlandı**, **Devam ediyor**, **Onay bekliyor** veya
   **Düzeltme istendi** aşamasında **İşi iptal et** ile ve zorunlu bir gerekçe yazarak iptal
   edebilirsiniz. Yönetici de erişebildiği aktif işleri aynı şekilde iptal edebilir. İptal
   terminaldir; iş yeniden açılamaz.

### 7.4 Profil

- **Profilim** (`/staff`): kendi açık / onay bekleyen / tamamlanan iş özetiniz.
- Yöneticiniz `/staff/:id/reports` raporunu sizin için açabilir.

---

## 8. Yönetici (Manager) kılavuzu — ilk pilot günü

Bu bölüm, uygulamayı ilk kez kullanan bir yönetici için adım adım yazılmıştır.

### 8.1 Giriş ve menüyü tanıma

1. Size verilen e-posta/parola ile giriş yapın; istenirse ilk parolayı değiştirin.
2. Üst/yan menüde şunları görün: **İşler**, **Müşteriler**, **Ürünler**, **Raporlar**, **Personel**.
3. **Kullanıcılar** menüsü yalnız sistem yöneticisinde vardır; sizde yoksa bu normaldir (rol yetkisi).

### 8.2 İş listesi ve pano

1. **İşler** (`/jobs`) açın.
2. Üstteki durum sekmeleri ve arama ile süzün.
3. Masaüstünde sütunlu **Kanban** görünümü salt okunurdur; kartı sürükleyerek durum değiştirmezsiniz — durum **detay komutları** ile değişir.
4. Telefonda / dar ekranda yalnız liste gösterilir (sıkışık pano yoktur).
5. Bir satıra tıklayarak veya **detayı aç** ile iş kartına girin.

### 8.3 Onay kuyruğu (en sık iş)

1. **Raporlar → Onaylar** (`/reports/approvals`) veya listede **Onay bekliyor** filtresini açın.
2. En eski bekleyen işi seçin.
3. Detayda teslim kalemlerini / görüşme sonucunu / notları okuyun.
4. Uygunsa **Onayla** — iş **Tamamlandı** olur.
5. Eksik/hatalıysa **Düzeltme iste** ve **gerekçe** yazın — personel düzeltip yeniden gönderir.
6. Personel işi onaydan geri çekerse kart kuyruktan çıkar; yeniden gönderildiğinde güncel
   içerikle tekrar görünür. İptal edilen kart onaylanamaz.
7. **Onayla** düğmesi yoksa: rolünüz Manager/Admin mi, iş gerçekten **Onay bekliyor** mu, sayfa hâlâ yükleniyor mu kontrol edin.

### 8.4 Müşteri ve ilgili kişi (CRM)

1. **Müşteriler** (`/customers`) → listede arayın.
2. Yeni klinik/hastane için **yeni müşteri** (`/customers/new`): ad ve zorunlu alanları doldurup kaydedin.
3. Müşteri detayında **ilgili kişiler** ekleyin (hekim, sekreter vb.).
4. Bir aktif **birincil kişi** kuralı vardır; birincili değiştirirken ekrandaki yönergeyi izleyin.
5. Personel, kendisine atanmış kapsam dışındaki müşterileri sınırlı görebilir — bu bir hata değil, rol kapsamıdır.

### 8.5 Ürün kataloğu

1. **Ürünler** (`/products`) → **yeni ürün** veya mevcut kaydı açın.
2. SKU, marka, kategori, model, birim, referans fiyat bilgilendirme amaçlıdır; stok düşümü yoktur.
3. Yanlış ürünü silmek yerine genelde **pasifleştirin** ki eski teslim kayıtları bozulmasın.

### 8.6 Personel profilleri

1. **Personel** (`/staff`) listesinden bir kişiyi açın.
2. Açık işler ve özet sayaçları görün.
3. `/staff/:id/reports` ile personelin dönemsel özetine gidin.

### 8.7 Raporlar

1. `/reports` — özet pano.
2. `/reports/deliveries` — onaylı teslim grupları (miktarlar metin olarak, yuvarlama sürprizi olmadan).
3. `/reports/approvals` — onay yaşları (kaç gündür bekliyor).
4. Tarih filtreleri adres çubuğunda (URL) tutulur; sayfayı yenilemek filtreyi bozmaz.

---

## 9. Sistem yöneticisi (Admin) kılavuzu — ilk pilot günü

Admin, Manager’ın tüm operasyonlarını yapabilir; ek olarak kullanıcı yönetir.

### 9.1 Kullanıcı oluşturma

1. **Kullanıcılar** (`/users`) menüsüne girin.
2. Yeni kullanıcı: ad, e-posta, rol (**ADMIN** / **MANAGER** / **STAFF**).
3. Başlangıç parolasını güvenli kanaldan iletin; kullanıcı ilk girişte **kendi parolasını değiştirmek zorundadır**.
4. Artık ihtiyaç yoksa kullanıcıyı **pasif** yapın (silmek yerine).

### 9.2 İlk organizasyon notu

Canlı pilotta ilk Admin genelde operatörün `bootstrap:admin` komutu ile oluşturulur. Siz uygulamadan “ilk Admin’i sihirbazla” oluşturmazsınız; bu bir kurulum adımıdır.

### 9.3 Operasyonel kontrol listesi (Admin)

1. En az bir Manager ve gerekli Staff hesapları var mı?
2. Temel müşteri ve ürün kayıtları girildi mi?
3. Bir test **Product Delivery** uçtan uca onaylandı mı?
4. **Raporlar** ekranı Manager ile aynı veriyi gösteriyor mu?

---

## 10. Sorun giderme

| Durum | Ne yapmalı |
|-------|------------|
| Giriş olmuyor | E-posta/parola; Caps Lock; hesap pasif mi; destek’e parola göndermeyin |
| Sürekli parola değiştir ekranı | İlk giriş zorunluluğu; yeni parolayı kaydedin (`mustChangePassword`) |
| Düğme yok / soluk | Rol mü, iş durumu mu, eksik alan mı, yoksa yükleme mi? (bölüm 5 tablosu) |
| Müşteri/ürün seçilemiyor | Kayıt pasif mi; arama terimi; ağ hatası → **Tekrar dene** |
| “İş değişmiş” / conflict | Yenileyin; güncel haliyle tekrar deneyin |
| Onaya gidemiyor | Zorunlu alanlar (teslim kalemi, görüşme sonucu vb.) eksik |
| Uygulama açılmıyor | Operatöre iletin: saat, tarayıcı, ekran yolu — **parola/cookie/URL sızdırmayın** |

### Destek için güvenli bilgi

Paylaşılabilir: tarih/saat, rolünüz, ekran yolu (ör. `/jobs/...`), görünen hata metni.
**Paylaşılmamalı:** parola, oturum çerezi, Authorization, veritabanı bağlantı cümlesi, hasta/kişisel sağlık detayı.

---

## 11. Erişilebilirlik notları

- Ana gezinme klavye ile odaklanabilir.
- Hata mesajları form alanlarıyla ilişkilendirilir (`aria-invalid` / açıklama).
- Renk tek başına durum göstergesi değildir; metin etiketleri vardır.

---

## 12. Sürüm notu

Bu kılavuz Servora-Med arayüz yolları `web/src/paths.ts` ve kabuk menüsü `AppShell` ile hizalıdır. Ekran metni değişirse kılavuz da güncellenmelidir.
