# Servora-Med kullanıcı kılavuzu

Bu kılavuz **pilot ve günlük kullanım** içindir. Kurulum için [README](../../README.md) ve [macOS Tunnel runbook](../operations/local-macos-cloudflare-tunnel.md) belgelerine bakın.

Uygulamadaki menü adları ve ekranlar gerçek arayüzle uyumludur. Yetki kuralları sunucu tarafından uygulanır; bir düğmeyi görmemek veya gri görmek yetkinin olmadığını gösterir.

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

Yönetici sizi geçici parolayla oluşturduysa, girişten sonra **Parolanızı değiştirin** ekranı açılır:

- Mevcut parola  
- Yeni parola  
- Yeni parolayı doğrulayın  
- **Parolayı değiştir**

Parola değiştirilene kadar diğer işlere devam edilemez. **Oturumu kapat** ile çıkabilirsiniz.

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

Liste satırında veya detayda görünen komutlar duruma göre değişir (ör. planla, başlat, onaya gönder, onayla, düzeltme iste, iptal).

---

## 6. Ortak ekran davranışları

- **Yükleniyor / boş / hata:** Listeler ve detaylar bu üç durumu gösterir. Hata ekranında **Tekrar dene** varsa kullanın.
- **Version conflict:** Başka biri işi değiştirdiyse işlem reddedilebilir; sayfayı yenileyip güncel haliyle tekrar deneyin.
- **Notlar:** İş detayında **Notlar** bölümüne iş notu eklenir (salt metin; zorunlu yapılandırılmış alanların yerini tutmaz).
- **Aktivite:** Aynı detayda zaman çizelgesi; olay etiketleri Türkçe gösterilir.

---

## 7. Personel (Staff) kılavuzu

### 7.1 Product Delivery (ürün teslimi)

1. **İşler** → teslim oluşturma (**Yeni teslim** / `/jobs/new-delivery`).
2. **Müşteri** seçin; **İlgili kişi** listesi dolar.
3. **Sorumlu personel** personelde sabittir (siz); yöneticide seçilebilir.
4. **Ürün** arayıp seçin; **Teslim amacı**, **Miktar**, **Teslim zamanı** girin.
5. **Teslimi kaydet**.
6. İş detayında durum komutlarıyla planlayın / başlatın.
7. Gerekli ürün kalemleri ve alanlar tamamsa **Onaya gönder**.
8. Yönetici **düzeltme** isterse gerekçeyi okuyun, düzeltin, yeniden onaya gönderin.

### 7.2 General Task (genel görev)

1. `/jobs/new-task` — **Başlık** zorunlu.
2. İsteğe bağlı müşteri / ilgili kişi (bağlam).
3. Oluşturun; yaşam döngüsü teslimle aynı onay motorunu kullanır.
4. Ürün teslim kalemi **yoktur**.

### 7.3 Sales Meeting (satış görüşmesi)

1. `/jobs/new-meeting` — planlama: başlık, müşteri, planlanan gün, sorumlu.
2. Detayda **Görüşme sonucu**:
   - Gerçekleşme zamanı  
   - Sonuç (Pozitif / Takip gerekli / Karar verilmedi / İlgilenmiyor)  
   - Görüşme özeti  
   - Takip zamanı (isteğe bağlı)  
3. **Görüşme sonucunu kaydet**, sonra **Onaya gönder**.

### 7.4 Profil ve raporlar

- **Profilim** (`/staff`): kendi özet sayaçlarınız.
- Yönetici sizin için `/staff/:id/reports` raporunu açabilir; personel kendi operasyon özetini profil üzerinden görür.

---

## 8. Yönetici (Manager) kılavuzu

### 8.1 İş listesi ve pano

- `/jobs` — filtreler, arama, durum sekmeleri.
- Masaüstünde salt okunur **Kanban** sütunları; mobilde liste zorunludur (sıkışık pano yok).
- **Tüm iş detaylarını aç** ile detaya gidin.

### 8.2 Onay kuyruğu

- Onay bekleyen işleri listeden veya **Raporlar → Onaylar** (`/reports/approvals`) üzerinden izleyin.
- Detayda **Onayla** veya **Düzeltme iste** (gerekçe zorunlu).

### 8.3 CRM

- **Müşteriler** — liste, oluşturma (`/customers/new`), detay, pasifleştirme (yetkiye göre).
- İlgili kişiler müşteri detayında yönetilir; bir aktif birincil kişi kuralı vardır.

### 8.4 Ürünler

- **Ürünler** — oluştur / düzenle / aktif-pasif (Staff salt okur).
- SKU, marka, kategori, model, birim, referans fiyat bilgilendirme amaçlıdır; stok değildir.

### 8.5 Personel

- **Personel** — profiller, yöneticiler arası görünürlük.
- Personel raporları: `/staff/:id/reports`.

### 8.6 Raporlar

- `/reports` özet pano  
- `/reports/deliveries` teslim grupları  
- `/reports/approvals` onay yaşları  

Tarih ve filtreler URL’de tutulur; sayfayı yenilemek filtreyi bozmaz.

---

## 9. Sistem yöneticisi (Admin)

- **Kullanıcılar** (`/users`): kullanıcı oluşturma, rol, aktif/pasif, geçici parola.
- Yönetici menüsündeki tüm operasyonlar Admin için de açıktır.
- İlk organizasyon kullanıcısı genelde bootstrap ile oluşturulur (operatör işi).

---

## 10. Sorun giderme

| Durum | Ne yapmalı |
|-------|------------|
| Giriş olmuyor | E-posta/parola; Caps Lock; geçici parola süresi; destek’e parola göndermeyin |
| Sürekli parola değiştir | İlk giriş zorunluluğu; yeni parolayı kaydedin |
| Düğme yok | Rol yetkisi; iş durumu komutu sunmuyor olabilir |
| Müşteri/ürün seçilemiyor | Kayıt pasif mi; arama terimi; ağ hatası → Tekrar dene |
| “İş değişmiş” / conflict | Yenileyin; güncel version ile tekrar |
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
