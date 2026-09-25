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
| **Takvim** | `/calendar` | Takvim özelliği açıkken herkes; veri kapsamı role göre sınırlı |
| **Müşteriler** | `/customers` | Herkes (personel kapsamı sınırlı) |
| **Ürünler** | `/products` | Herkes (personel salt okunur) |
| **Raporlar** | `/reports` | Yönetici ve sistem yöneticisi |
| **Kullanıcılar** | `/users` | Yalnız sistem yöneticisi |
| **Personel** / **Profilim** | `/staff` | Yönetici: personel listesi; personel: kendi profili |

Mobilde dar ekranda menü çekmecesi kullanılır; masaüstünde yan/üst navigasyon görünür.

---

## 5. İş kartı yaşam döngüsü (özet)

Tipik akış (teknik durum → detaydaki aşama dili):

```text
Atandı → Kabul edildi → Uygulanıyor → Yönetici kontrolü → Tamamlandı
                              ↘ Düzeltme istendi → Uygulanıyor (düzeltme döngüsü)
```

- **Kabul zorunludur:** Yönetici/yönetim tarafından size atanan iş **Atandı** durumundadır.
  Yalnız **atanmış personel** işi **Kabul et** ile **Kabul edildi** yapabilir; yöneticiler
  personel adına kabul edemez. Kendi oluşturduğunuz (kendinize atadığınız) işler doğrudan
  **Kabul edildi** başlar.
- **Başlatma kabulden sonra:** **İşi başlat** yalnızca **Kabul edildi** durumundan
  kullanılabilir. Planlanan zaman (`Planlanan teslim/görüşme zamanı`) durum değildir;
  ayrı bir planlama alanı olarak görünür.
- **Personel işi doğrudan “Tamamlandı” yapamaz.** Personel **Kontrole gönder** ile yönetici
  kontrolüne yollar; yönetici **Kontrolü tamamla ve işi kapat** ile kapatır veya
  **Düzeltme için personele geri gönder** ile döngüyü başlatır.
- **Kontrol kilidi:** Yönetici kontrolündeyken kayıtlar salt okunurdur. Düzenleme için önce
  **Kontrolden geri çek ve düzenle** (personel) veya **Kontrolden çıkar ve kayıtları düzenle**
  (yönetici, görüşme vb.) gerekir; işlem geçmişi silinmez.
- **İptal terminaldir:** Yetkili kullanıcı + zorunlu gerekçe ile **İşi iptal et**. İptal
  başarılı yeşil tamamlanma değildir; iş yeniden açılamaz.

### Bir düğme yoksa veya devre dışıysa

Aynı durumun birkaç nedeni olabilir; hepsi “yetkim yok” demek değildir:

| Neden | Ne anlama gelir |
|-------|------------------|
| **Rol yetkisi** | Bu rol o komutu hiç kullanamaz (ör. personel **Kontrolü tamamla ve işi kapat** göremez). |
| **İş kartı durumu** | Komut bu statüde geçersizdir (ör. zaten **Tamamlandı** iken **Kontrole gönder** yok). |
| **Doğrulama / eksik alan** | Zorunlu alan veya teslim kalemi eksik; detaydaki kontrol listesi ve sunucu aynı kuralları kullanır. |
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

### Takvim ve yaklaşan planlar

- **Takvim** (`/calendar`) haftalık iş ve operasyon planlarını birlikte gösterir.
- **İş** etiketli kayıtlar JobCard’a bağlıdır. Düzenleme mevcut JobCard yetkisini, durum
  kurallarını ve sürüm kontrolünü kullanır; iş durumu Takvim içinde kopyalanmaz.
- **Kişisel plan** etiketli kayıtlar Takvim içinde oluşturulur. Bitiş zamanı başlangıçtan
  sonra olmalıdır; çakışan aralıklar sunucu tarafından reddedilir. Ardışık
  `[başlangıç, bitiş)` aralıkları çakışma sayılmaz.
- Personel yalnız kendi takvimini görür. Yönetici yalnız mevcut ekip kapsamındaki aktif
  personeli, sistem yöneticisi organizasyondaki aktif personeli filtreleyebilir.
- Çakışma veya başka kullanıcı değişikliği uyarısında form taslağı korunur. Güncel kaydı
  yükleyip zamanı yeniden seçin.
- Yaklaşan plan bildirimini açmak ilgili JobCard’a veya yetkili Takvim seçimine götürür.
  Bildirim ve cihaz bildirimi serbest metin plan açıklamasını taşımaz.

---

## 7. Personel (Staff) kılavuzu

### 7.1 Product Delivery (ürün teslimi)

1. Menüden **İşler**’e gidin (`/jobs`).
2. Yeni teslim oluşturmayı seçin (`/jobs/new-delivery`).
3. **Müşteri** seçin; ardından **İlgili kişi** listesi dolar.
4. **Sorumlu personel** personel rolünde sizsiniz (değiştirilemez).
5. **Planlanan teslim zamanı** formu varsayılan bir değerle gelir; gerekirse değiştirin.
6. **Ürün** arayıp seçin; **Teslim amacı**, **Miktar** girin. **Gerçekleşen teslim zamanı**
   sahada/uygulama sırasında kaydedilir; planlanan zamandan kopyalanmaz.
7. **Teslimi kaydet** — kayıt sonrası iş detayına gidersiniz (kendi işiniz **Kabul edildi**
   başlar).
8. Detayda adım çubuğu ve “şimdi sizden beklenen” paneli görünür. Atanan işlerde önce
   **Kabul et**, sonra **İşi başlat** kullanın. Gerekirse planlanan zamanı düzenleyin veya
   atama aşamasında **Notlar** ile iletişim kurun.
9. **Uygulanıyor** iken her kalemde gerçekleşen teslim zamanı ve diğer zorunlu kalemler
   tamamsa **Kontrole gönder**. Gönderim sonrası kayıtlar kilitlenir; iş **Yönetici
   kontrolü** aşamasına geçer.
10. Yönetici düzeltme isterse gerekçeyi okuyun → **Düzeltmeye başla** → kayıtları düzeltin →
    **Yeniden kontrole gönder**.
11. Kontroldeyken kendiniz düzeltmek isterseniz **Kontrolden geri çek ve düzenle** ile işi
    yeniden **Uygulanıyor** yapın, sonra tekrar gönderin.

### 7.2 General Task (genel görev)

1. `/jobs/new-task` — **Başlık** zorunludur.
2. İsteğe bağlı müşteri / ilgili kişi ve isteğe bağlı **Planlanan zaman** yalnızca bağlam içindir.
3. Kaydedin; yaşam döngüsü ve kontrol akışı ürün teslimi ile aynıdır (**Kabul et** →
   **İşi başlat** → **Kontrole gönder**).
4. Ürün teslim kalemi **yoktur**.

### 7.3 Sales Meeting (satış görüşmesi)

1. `/jobs/new-meeting` — planlama: başlık, müşteri, **planlanan görüşme zamanı**, planlanan
   gün, sorumlu.
2. Görüşme **Atandı** veya **Kabul edildi** durumundayken **görüşme sonucu** bölümü
   gösterilmez. **Notlar** bu aşamada açıktır (saat çakışması, müşteri teyidi vb.).
   **İşi başlat** komutundan sonra sonuç bölümü açılır.
   Görüşmenin başlık, açıklama, müşteri, ilgili kişi, planlanan zaman/gün ve öncelik
   bilgileri uygun aşamalarda (kontrol kilidi dışında) düzenlenebilir. Yönetici ayrıca
   sorumluyu değiştirebilir; kabul edilmiş bir işte yönetici plan/atama değiştirirse iş
   yeniden **Atandı** olur ve personelin kabulü temizlenir.
3. Detayda **Görüşme sonucu**:
   - Gerçekleşme zamanı
   - Sonuç (Pozitif / Takip gerekli / Karar verilmedi / İlgilenmiyor)
   - Görüşme özeti
   - Takip zamanı (isteğe bağlı)
   Sonuç formu ilk açıldığında gerçekleşme zamanı güncel yerel saatle doldurulur; gerekirse
   değiştirebilirsiniz.
4. **Görüşme sonucunu kaydet**, notlarınızı ekleyin, kontrol listesi tamamsa **Kontrole gönder**.
   Sonuç kaydından sonra kontrol listesi sunucudan yenilenir. Değişmemiş bir sonuç yeniden
   gönderilmez ve bunun yerine kaydedilecek değişiklik olmadığı açıklanır.
5. Yönetici kontrolündeyken içerik salt okunurdur. Düzeltme gerekiyorsa **Kontrolden geri çek
   ve düzenle** ile işi **Uygulanıyor** durumuna alın, değiştirin ve yeniden gönderin.
6. Kendi görüşmenizi **Atandı**, **Kabul edildi**, **Uygulanıyor**, **Yönetici kontrolü** veya
   **Düzeltme istendi** aşamasında **İşi iptal et** ile ve zorunlu bir gerekçe yazarak iptal
   edebilirsiniz. Yönetici de erişebildiği aktif işleri aynı şekilde iptal edebilir. İptal
   terminaldir; iş yeniden açılamaz.

### 7.4 Haftalık Rapor

1. `/jobs/new-weekly-report` — rapor haftası (Pazartesi) ve termin (varsayılan: dönemi
   izleyen Pazartesi). Müşteri seçilmez; haftalık rapor müşteriye bağlı değildir.
2. Rapor **Kabul edildi** veya **Uygulanıyor** durumundayken **İşi başlat** ile
   **Uygulanıyor** durumuna alın, bölümleri doldurun (**Haftanın özeti** ve
   **Gelecek hafta planı** zorunludur) ve varsa yönetici sorularını yanıtlayın.
   **Taslağı kaydet** tüm bölümleri birlikte değiştirir.
3. **Otomatik çalışma listesi** o hafta tamamladığınız işleri gösterir; düzenlenemez.
4. **Kontrole gönder** ile rapor dondurulur (değiştirilemez kayıt oluşur). Yönetici
   düzeltme isterse **Düzeltmeye başla** ile **Uygulanıyor** durumuna dönün, düzeltin ve
   yeniden gönderin (yeni kayıt oluşur, eski kayıt değişmez).
5. Yönetici raporu **Onayla** ile tamamlar. Onaylanan rapor içeriği değişmez.

### 7.5 Profil

- **Profilim** (`/staff`): kendi açık / onay bekleyen / tamamlanan iş özetiniz.
- Yöneticiniz `/staff/:id/reports` raporunu sizin için açabilir.

### 7.6 Haftalık Rapor geçmişi ve PDF indirme

**Nerede görürüm?**

- **Personel (STAFF):** **Profilim** (`/staff`) sayfasındaki **Haftalık Raporlar** bölümü
  yalnız kendi haftalık raporlarınızı listeler. Bu bölüm kendi raporlarınıza kilitlidir;
  başka bir personelin raporları burada görünmez.
- **Yönetici / Sistem yöneticisi (MANAGER / ADMIN):** **Personel** menüsünden bir personelin
  profilini açtığınızda aynı **Haftalık Raporlar** bölümünü o personel için görürsünüz.
  Bölüm her zaman seçili personelle sınırlıdır ve başka organizasyonun kayıtlarını içermez.

**Satır ne gösterir?**

Her satır bir haftalık rapor (hafta) demektir: dönem (`başlangıç – bitiş`), raporun iş durumu,
gönderim sayısı, son gönderim zamanı, **Termin** (raporun son tarihi) ve rapor tamamlandıysa
**Tamamlandı** tarihi. Hiç gönderilmemiş bir hafta da geçerli bir satırdır: `Gönderim yok`
yazar ve indirilecek bir sürüm olmadığı için PDF düğmesi yerine `PDF yok` görünür.

**PDF nasıl indirilir?**

1. İlgili satırdaki **PDF indir** düğmesine basın. Bu düğme her zaman o raporun **en son
   gönderilmiş sürümünü** indirir.
2. İndirme sırasında düğme `PDF hazırlanıyor…` olur ve kilitlenir; aynı anda ikinci bir
   indirme başlatılamaz. İndirme başarısız olursa hata mesajı görünür ve düğme eski hâline döner.

**Eski (önceki) gönderim sürümlerini indirme**

Raporun detay sayfasında **Gönderim geçmişi** bölümü vardır. Burada gönderim sürümlerini
(`#1`, `#2`, …) seçebilir ve **PDF indir** ile seçtiğiniz sürümün PDF'ini indirebilirsiniz.
Böylece bir düzeltme sonrası eski sürüm kaybolmaz; her sürüm ayrı ayrı indirilebilir.

**PDF hangi içeriği taşır?**

PDF, seçtiğiniz gönderim anında dondurulmuş içeriktir: rapor bölümleri, yönetici sorularının
yanıtları ve **gönderim anında dondurulan çalışma listesi**. Bu liste, her işin gönderim
anındaki durumunu (**Durum** sütunu) ve gönderim anındaki müşteri/başlık bilgisini taşır.
Sonradan yapılan iş güncellemeleri, yeniden adlandırmalar veya durum değişiklikleri geçmiş bir
gönderimin PDF'ini değiştirmez. PDF üzerindeki **Gönderen kimliği** alanı, gönderimi yapan
kişinin değişmeyen kimliğidir; **Personel** alanındaki görünen ad ise sunum bilgisidir ve kişi
adını değiştirirse güncellenebilir.

**Önemli ayrım: gönderilmiş sürüm ≠ onaylanmış sürüm**

- **Düzeltme istendi** durumundaki bir raporun PDF'i, **gönderilmiş** bir sürümdür; onaylanmış
  olduğu anlamına gelmez. Yönetici düzeltme istemiş olabilir.
- Bir rapor **Tamamlandı** olduğunda, en son gönderilen sürüm **nihai onaylanmış sürüm**dür.
- Bu nedenle bir PDF'i arşiv amaçlı kullanacaksanız, indirdiğiniz sürümün numarasını ve raporun
  o anki durumunu birlikte değerlendirin.

**Otomatik oluşturma yoktur**

Haftalık raporlar **otomatik oluşturulmaz**. Her hafta için rapor, personelin kendisi
(`/jobs/new-weekly-report`) veya bir yöneticinin isteğiyle açılır. Tekrarlayan (recurring)
otomatik rapor üretimi bu sürümde yoktur.

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
5. Kartın başlığına veya kart alanına tıklayarak doğrudan iş detayına girin (özet
   aç/kapat adımı yoktur). Durum komutları kart üzerindeki ayrı düğmelerdir.
6. **Yeni → Haftalık Rapor** ile bir personele haftalık rapor isteyin (tek personel,
   rapor haftası, en fazla 5 yönetici sorusu). Personel kabul edip doldurur; içeriği
   siz düzenleyemez veya onun adına gönderemezsiniz.

### 8.3 Yönetici kontrol kuyruğu (en sık iş)

1. **Raporlar → Onaylar** (`/reports/approvals`) veya listede **Onay bekliyor** /
   yönetici kontrolü filtresini açın.
2. En eski bekleyen işi seçin.
3. Detayda onay özeti, teslim kalemleri / görüşme sonucu / notlar ve hazırlık özetini okuyun.
4. Uygunsa **Kontrolü tamamla ve işi kapat** — onay diyaloğunda **İşi tamamla** ile
   onaylayın; iş **Tamamlandı** olur ve aktif listeden çıkar.
5. Eksik/hatalıysa **Düzeltme için personele geri gönder** ve **gerekçe** yazın; onay
   etiketinde **Düzeltme için geri gönder** kullanın. Personel **Düzeltmeye başla** ile
   devam eder, düzeltir ve **Yeniden kontrole gönder** ile yollar.
6. Kayıtları siz düzenlemeniz gerekiyorsa (ör. görüşme) **Kontrolden çıkar ve kayıtları
   düzenle** — kontrol biter, iş **Uygulanıyor** olur; bu işlem onaylamaz veya kapatmaz,
   yeniden kontrole gönderilmesi gerekir.
7. Personel veya yönetici işi kontrolden geri çekerse kart kuyruktan çıkar; yeniden
   gönderildiğinde güncel içerikle tekrar görünür. İptal edilen kart onaylanamaz.
8. **Kontrolü tamamla ve işi kapat** yoksa: rolünüz Manager/Admin mi, iş gerçekten yönetici
   kontrolünde mi, sayfa hâlâ yükleniyor mu kontrol edin.

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
4. Profildeki **Haftalık Raporlar** bölümü o personelin haftalık raporlarını gösterir
   (dönem, durum, gönderim sayısı, termin, tamamlanma). Bir satırdaki **PDF indir** o raporun
   en son gönderilmiş sürümünü indirir; eski sürümler için raporun detayındaki **Gönderim
   geçmişi** bölümünü kullanın. Ayrıntılar için bkz. §7.6.

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
4. Kullanıcı artık gerekmiyorsa, uygun yaşam döngüsü işlemini kullanın:
   anlamlı iş/operasyon geçmişi ve engelleyici aktif sorumluluğu olmayan
   `BUSINESS` kullanıcılar onay sonrası kalıcı silinebilir; geçmişi olan
   Staff kullanıcılar için **offboarding** gerekir.

### 9.2 Kullanıcı ve personel yaşam döngüsü

- Kullanıcı kalıcı silme ve Staff offboarding işlemleri yalnızca Admin'e
  açıktır. Kullanıcı kendi hesabını silemez; son aktif Admin de silinemez veya
  pasifleştirilemez.
- Sunucu, kullanıcı detayında `canPermanentlyDelete` ve
  `permanentDeleteBlockers` ile uygunluğu hesaplar. Arayüz bu kararı kendi
  kurallarıyla yeniden üretmez.
- Anlamlı iş/operasyon geçmişi olmayan ve aktif sorumluluğu bulunmayan
  `BUSINESS` kullanıcı, onay kutusu tamamlandıktan sonra kalıcı silinebilir.
  İş geçmişi olan kullanıcılar kalıcı silinmez; eski Staff için offboarding
  planı açılır.
- Staff offboarding sırasında aktif iş, müşteri, takvim, takip ve hatırlatıcı
  sorumlulukları açıkça çözülür; oturumlar iptal edilir, yeni atama
  yapılamaz, iş/mesaj/rapor/audit geçmişindeki personel ilişkisi korunur.
  Manager sorumlulukları da kalıcı silmeyi engelleyebilir.
- Yalnızca teknik giriş veya oturum geçmişinin bulunması, başka anlamlı
  iş/operasyon geçmişi yoksa, tek başına kalıcı silme engeli değildir.
- Demo kullanıcıları normal Kullanıcılar ekranından silinmez; yalnızca Demo
  veri kümesi tamamen temizlendiğinde kaldırılır.

**Ayarlar → Veri Yönetimi** ana ekranı yalnızca veri durumu ve ilgili alanlara
geçiş özeti sunar; toplu silme konsolu değildir. Varsa ayrı **Backup &
Recovery** alanı yalnızca kendi Admin backup sözleşmesi içindir; deploy
pre/post backup'ları, restore/recovery ve offsite DR bunun dışındadır. Yıkıcı
işlemler ilgili Demo, Kullanıcı/Personel, müşteri veya ürün detay ekranındaki
yetkili akışlardan başlatılır.

### 9.3 İlk organizasyon notu

Canlı pilotta ilk Admin genelde operatörün `bootstrap:admin` komutu ile oluşturulur. Siz uygulamadan “ilk Admin’i sihirbazla” oluşturmazsınız; bu bir kurulum adımıdır.

### 9.4 Operasyonel kontrol listesi (Admin)

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
| Kontrole gidemiyor | Detaydaki kontrol listesi: zorunlu alanlar (teslim kalemi, görüşme sonucu vb.) eksik veya geçersiz |
| Uygulama açılmıyor | Operatöre iletin: saat, tarayıcı, ekran yolu — **parola/cookie/URL sızdırmayın** |

### Destek için güvenli bilgi

Paylaşılabilir: tarih/saat, rolünüz, ekran yolu (ör. `/jobs/...`), görünen hata metni.
**Paylaşılmamalı:** parola, oturum çerezi, Authorization, veritabanı bağlantı cümlesi, hasta/kişisel sağlık detayı.

---

## 11. Erişilebilirlik notları

- Ana gezinme klavye ile odaklanabilir.
- Hata mesajları form alanlarıyla ilişkilendirilir (`aria-invalid` / açıklama).
- Renk tek başına durum göstergesi değildir; metin etiketleri vardır.
- Yaşam döngüsü adım çubuğu sıralı listedir; mevcut adım `aria-current="step"` ile işaretlenir.
- Onay / geri çekme / iptal diyalogları odağı tutar; Escape (güvenliyse) ve açan kontrole dönüş desteklenir.

---

## 12. Sürüm notu

Bu kılavuz Servora-Med arayüz yolları `web/src/paths.ts`, kabuk menüsü `AppShell` ve iş
akışı etiketleri `web/src/jobs/job-workflow-presentation.ts` ile hizalıdır. Ekran metni
değişirse kılavuz da güncellenmelidir.
