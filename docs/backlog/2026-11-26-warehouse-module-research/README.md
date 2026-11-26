# Depo/Stok modülü araştırması — 2026-11-26

Durum: **araştırma raporu, karar değildir.** Hiçbir kod, migration veya karar kaydı
değiştirilmedi. AGENTS.md §13 gereği tam bir depo modülü ürün sahibinin açık onayını
gerektirir; bu klasör yalnızca o kararın girdisidir.

Kapsam: `main` @ `89bf6b1` (MOD-002 operatör paneli birleşmiş hâli). Bağlayıcı girdiler:
`AGENTS.md`, `DECISIONS.md` MOD-001, MOD-002, DOM-001, DOM-004, SALE-001, SALE-QTY-001, SALE-002,
DELIVERY-QTY-001, SCH-001, ARC-001/002 ve
[çekirdek + modüller araştırması](../2026-11-25-core-modules-architecture-research.md) §1–§6.

Yöntem: model-fleet ile altı DeepSeek araştırma hattı (her biri tek dosyanın sahibi), lead
doğrulaması (aşağıda §3), 06 için lead düzeltmeli bir takip turu.

## 1. İçindekiler

| Dosya | Konu | Run |
| ----- | ---- | --- |
| [01-codebase-touchpoints.md](01-codebase-touchpoints.md) | Depo modülünün dokunduğu/dokunulduğu her kod noktası, sahiplik kararıyla (H1–H11 kancaları) | `20261126-141103-deepseek-a17a` |
| [02-domain-model-options.md](02-domain-model-options.md) | Konum, hareket defteri/bakiye, transfer, iade, sayım, lot/seri/SKT, birim; A/B/C seçenekleri, öneri DDL taslakları | `20261126-141103-deepseek-dd5c` |
| [03-jobcard-integration.md](03-jobcard-integration.md) | Teslimat/satışın Core stok sahibi olmadan hareket üretmesi; açma/kapama; ters kayıt | `20261126-141103-deepseek-77cf` |
| [04-regulation-and-industry.md](04-regulation-and-industry.md) | ÜTS, VUK/e-İrsaliye, EUDAMED; dental/medikal dağıtıcı ve araç stoku pratiği (kaynaklı, tarihli) | `20261126-141103-deepseek-411e` |
| [05-erp-integration-mode.md](05-erp-integration-mode.md) | "ERP stok otoritesi" modu; M0–M3; Logo, Mikro, Netsis, Paraşüt API yüzeyleri | `20261126-141103-deepseek-c1e5` |
| [06-first-slice-proposal.md](06-first-slice-proposal.md) | En küçük uçtan uca dilim (W0 + W1a/W1b), sözleşmeler, 22+ kabul testi, X1–X18 çelişki çözümü, B0–B8 kararları | `20261126-145309-deepseek-74b4` (+ lead takip turu) |

Tam worker raporları ve kanıt dosyaları: `~/.claude/model-fleet/runs/<run>/`.

**Okuma sırası:** önce bu README, sonra 06 (§3 dilim, §4 çelişkiler, §8 kararlar), gerekirse
kaynak belgeler.

## 2. Özet

- **Bugün kodda stok kavramı yok.** `server/src` ve `web/src` içinde depo/stok/araç tablosu veya
  servisi bulunmuyor; tek eşleşme bir JobCard değişiklik nedeni (`MISSING_STOCK_OR_EQUIPMENT`).
- **Teslimat kalemleri zaten izlenebilirlik alanları taşıyor:** `job_card_delivery_items`
  üzerinde `delivery_purpose` (`SALE/SAMPLE/CONSIGNMENT/RETURN/OTHER`), `quantity`, `unit`,
  `lot_no`, `serial_no`, `expiry_date` var (`002_delivery_tracer.sql:137-152`). Bunlar serbest
  metin olay bilgisi; bakiye değil. Depo modülü bu tabloya bakiye eklememeli. Aksi hâlde MOD-001'in
  yasakladığı ikinci otoriter miktar doğar.
- **Doğal kanca tek bir an: yönetici onayı (`APPROVE` → `COMPLETED`).** İki onay yolu
  (tekil satış `service.ts:7741`, ziyaret+satış çifti `:7147`) ve düz teslimat onayı aynı
  `runLifecycle` transaction'ında bitiyor. Öneri: Depo'nun dar portu onay transaction'ı içinde
  senkron çağrılır ve teslimat kalemi başına bir `ISSUE` hareketi yazar. ADMIN geçersizleştirmesi
  (`service.ts:1623`) aynı transaction'da telafi (`REVERSAL`) yazar. Revizyon, geri çekme ve iptal
  hiçbir şey yazmaz, çünkü onaydan önce hareket yoktur.
- **Model önerisi (02, Seçenek B):** append-only `stock_movements` tek doğru kaynaktır.
  `stock_balances` aynı transaction'da satır kilidiyle güncellenir. Yalnızca transfer ve sayım için
  ince değiştirilemez başlıklar vardır, genel fiş motoru yoktur. Miktar tam sayı ürün adedidir
  (DELIVERY-QTY-001, SALE-QTY-001). Katalog `unit` bilgisi bilgilendiricidir.
- **İlk dilim (06):** **W0** modül kaydı genelleştirmesidir. Registry, 074 CHECK'leri ve takeover
  bugün yalnızca `OVERVIEW` kabul ediyor (`074:59,86-87`, `takeover.ts:20-24`). Bu ayrı ve küçük bir
  Core dilimidir; Bakım, Muhasebe, Takvim ve Mesajlaşma da aynı genişlemeyi bekliyor.
  **W1a**: konumlar, açılış sayımı, depo→araç transferi, bakiye ve hareket listesi; Core davranışı
  değişmez. **W1b**: onayda stok çıkışı, geçersizleştirmede telafi, "gönderilmemiş" listesi, kalıcı
  kullanıcı silme engelleri.
- **Açma/kapama:** modül kapalıyken modül API'si `404` döner, Core onayları ise normal çalışır ve
  hareket yazılmaz. Açılışta geriye dönük
  doldurma yapılmaz. Modül durumu okunamazsa onay `503` alır (MOD-002 fail-closed). "Eski teslimatlar
  kendiliğinden düşmez" kuralı yapısal olarak sağlanır.
- **Mevzuat (04):** ÜTS bir sahiplik ve tekil ürün takip sistemidir, depo bakiyesi tutmaz. Depo→araç
  transferi büyük olasılıkla ÜTS bildirimi gerektirmez (çıkarım; ÜTS danışmanıyla doğrulanmalı). VUK
  m.230/5, kendi işyerleri arasındaki taşımada bile sevk irsaliyesi ister. Aracın "işyeri" sayılıp
  sayılmadığı **mali müşavire sorulmalı.** Son kullanma tarihi geçmiş ürün satılamaz; bu, W4'te SKT
  bloğu olarak gelir.
- **ERP modu (05):** "Servora stok sahibi, irsaliyeyi ERP kesiyor" kurgusu çoğu Türk ERP'sinde çifte
  otorite doğurur, çünkü irsaliye kesmek ERP'de stok hareketi yaratır. Öneri: V1 yalnızca M0 (kapalı)
  + M1 (Servora otorite). ERP otorite modu (M2) tasarlanır ama yazılmaz. Bunun için bakiye okuması
  `{quantity, asOf, source}` döner.

## 3. Lead doğrulaması

### 3.1 Kodda kontrol edilen iddialar (doğru çıktı)

| İddia | Kanıt |
| ----- | ----- |
| Teslimat kalemlerinde lot/seri/SKT ve `CONSIGNMENT`/`RETURN` amacı var | `002_delivery_tracer.sql:137-152`, `job-cards/types.ts:302,809-811` |
| `approve` hedefi `COMPLETED`; çift ve tekil satış onayı aynı teslimat yardımcısını çağırıyor | `job-cards/service.ts:6230-6258,7147-7152,7741-7745,2814` |
| Modül anahtarı CHECK'leri yalnızca `OVERVIEW` | `074_installation_operator_and_module_state.sql:59,86-87` |
| Takeover tek boolean alıyor | `installation-modules/takeover.ts:20-24` |
| Restore doğrulaması sabit `CORE_RELATIONS` listesi | `backup/restore/postgres.ts:11-25` |
| DOM-001: "`CONSIGNMENT` ve `RETURN` stok hareketi doğurmaz" (MVP) | `DECISIONS.md:351`, `PRODUCT_REQUIREMENTS.md:283` |
| Teslimat miktarı tam sayı (1–999999999), eski kesirli satırlar korunuyor | `DECISIONS.md:3458-3476`, `job-cards/delivery-input.ts:22-38` |
| `delivered_at` için üst/alt sınır yok (gelecek tarih kabul ediliyor) | `job-cards/service.ts:522-532` |
| Genel SQLSTATE eşlemesi yok; kayıtsız bir FK ihlali `500 INTERNAL_ERROR` olur | `server/src/errors/index.ts:48-54` |
| `getSubmissionDeliveryItems` kalemleri çağıranın transaction'ında `FOR UPDATE` okuyor | `job-cards/repository.ts:5224-5230` |
| Kalıcı silme engeli elle yazılmış `EXISTS` listesi | `people/repository.ts:252-262` |

### 3.2 Düzeltilen veya yeniden çerçevelenen iddialar

1. **Açılış sayımı öncesi teslim edilenlerin çift düşülmesi (lead bulgusu).** 03 §5.2 ve 06'nın ilk
   hâli "kesim tarihi gerekmez" diyordu. Ama bir teslimat sayımdan **önce** fiziksel olarak
   verilmiş (`delivered_at`) ve sayımdan **sonra** onaylanmış olabilir. Ürün sayımda zaten yoktu;
   onay bir kez daha düşerdi. Lead takip turunda 06'ya G3b eklendi (06 §3.3; özet §6.1).
2. **Gönderilmemiş liste sınırsızdı.** 06 A3, modül açılmadan önce onaylanmış tüm teslimatları
   listeliyordu; yıllık geçmişte bu binlerce satır demek. Takip turunda liste, modülün ilk
   açılışından sonra onaylanan satırlarla sınırlandı.
3. **Product `DELETE` "sapması" (01).** Kod `DELETE /api/products/:productId` kaydediyor
   (`products/routes.ts:19`), API taslağı ise "yok" diyor (`SERVORA_MED_API_DRAFT.md:489-490`).
   Endpoint kasıtlı olarak eklenmiş: CRM 4A veri modeli `PRODUCT_DELETED` ekliyor, ayrıca
   geçmiş koruması (`PRODUCT_HAS_OPERATION_HISTORY`, `products/service.ts:215-249`) var. Yani
   bayat olan taslak, kod değil. Depo için önemli kısım: stok hareketleri de ürün silmeyi
   engellemeli. FK zaten engelliyor; mesaj "stok hareketi" içerecek şekilde güncellenmeli (06 X15).
4. **05'in "`audit_events` personel kapsamlı" iddiası yanlış**; 06 X9 düzeltti (060 migration'ı
   `CUSTOMER`, `PRODUCT`, `JOB_CARD`, `DEMO_DATASET` içeriyor).
5. **01'in "oluşturmada rezervasyon" önerisi** 02, 03 ve 06 ile çelişiyor. Üçü de V1'de
   rezervasyon olmamasını öneriyor (W5'e ertelendi). Lead 02, 03 ve 06'nın gerekçesini kabul
   ediyor: konum, onaydan önce kesin değil ve rezervasyon ikinci bir miktar durumu yaratır.
6. **03 "DOM-001 değişikliği gerekmez", 01/05 "supersession gerekir" diyor.** İkisi de kısmen
   doğru. W1, `CONSIGNMENT` ve `RETURN` kalemlerini hiç düşmezse (06 G6) DOM-001 olduğu gibi
   kalır. İade (W3) ve konsinye (W4) dilimleri ise açık bir DOM-001 değişiklik cümlesi
   gerektirir.

### 3.3 Kontrol edilmeyenler / sınırlar

- Dış kaynaklar (04, 05) worker'ın getirdiği URL ve alıntılardır. Lead, mevzuat metinlerini tek tek
  açmadı. Hukuki çıkarımlar (araç = işyeri, depo→araç ÜTS gerektirmez) belgelerde **UNVERIFIED**
  işaretli; danışman doğrulaması gerekir.
- Boyut tahminleri (06 §9) ölçülmedi ve düşük güvenlidir.
- Üretimde kesirli teslimat miktarı olup olmadığı sorgulanmadı (06 G8 bu satırları düşmeden
  listeye alıyor).
- Fleet notu: beş paralel run aynı klasöre yazdığı için bridge'in mtime tabanlı sahiplik
  kontrolü hepsini `OWNERSHIP_VIOLATION` olarak işaretledi. Bu yanlış pozitif. Transkriptler her
  worker'ın yalnızca kendi dosyasını yazdığını gösteriyor; `git status` da yalnızca bu klasörü
  gösteriyor.

## 4. Belgeler arası çelişkiler (özet)

Ayrıntılı tablo: 06 §4 (X1–X18). Ürün sahibini ilgilendirenler:

| # | Konu | Taraflar | Öneri |
| - | ---- | -------- | ----- |
| X1 | Stok miktar tipi | 02/04: tam sayı; 05: `NUMERIC(12,3)` | Tam sayı |
| X2 | `RETURN` teslimat amacı | 02/03: dışarı çıkış; 04/05: içeri giriş | W1'de hiç düşülmez; anlamı W3'ten önce karara bağlanır |
| X3 | Konsinye | DOM-001: hareket yok; 04/05: konsinye konumu | W1 dışı; W4'te DOM-001 değişikliğiyle |
| X4 | Lot/seri/SKT | 02: yalnızca nitelik; 04: SKT bloğu zorunlu | W1 hareket üstünde nitelik olarak saklar, zorlama W4 |
| X5 | Offboarding'de araçta stok | 02: offboarding'i engelle; 03: hiçbir şey yapma | Engelleme yok; modül pasif sahibin aracını istisna olarak gösterir; kalıcı silme engellenir |
| X6 | Geçersizleştirmede ters kayıt | 03: otomatik; 02: istisna listesi | Otomatik, aynı transaction'da |
| X7 | Yetersiz stok | 03: koşulsuz 409; 06: sayılmış konumda 409 | Sayılmış-konum merdiveni (modülü açmak saha onaylarını kırmasın) |
| X10 | Otorite modu kolonu ilk migration'da mı | 02: evet; 05: konum bazlı; 06: hayır | W1'de yok; M2 gelince eklenir |

## 5. Ürün sahibinin vermesi gereken kararlar

Başlamadan önce (W0/W1'i bloke edenler):

1. **Yetki (AGENTS.md §13):** Depo modülü için yalnızca W0 + W1 (W1a, W1b) yetkilendirilsin mi?
   Sonraki her dilim ayrıca onaylanır. *Öneri: evet, yalnızca W0 + W1.*
2. **W0 sahipliği:** Modül kaydı genelleştirmesi (registry, 074 CHECK'leri, takeover,
   capability tipi) Depo, Bakım, Muhasebe, Takvim ve Mesajlaşma için ortak ön koşul. Kim
   yapacak? *Öneri: tek, ayrı bir Core PR'ı; diğer modül oturumları bunu bekler. İki oturumun
   aynı anda 075 migration'ı yazması çakışır.*
3. **Depolama şekli:** A (yalnızca defter), **B (defter + aynı transaction'da bakiye)**, C (fiş
   motoru). *Öneri: B.*
4. **Hangi teslimat amaçları stok düşer:** yalnızca SALE / **SALE + SAMPLE + OTHER** / beşi.
   *Öneri: SALE + SAMPLE + OTHER. `CONSIGNMENT` ve `RETURN` düşmez, böylece DOM-001 değişmez.*
5. **Yetersiz stok kapısı:** koşulsuz 409 ya da **yalnızca sayılmış konumda 409** (merdiven).
   *Öneri: merdiven.*
6. **Geçersizleştirmede ters kayıt:** **otomatik** ya da istisna listesi. *Öneri: otomatik.*
7. **Offboarding:** offboarding engellenir / hiçbir şey yapılmaz / **türetilir + kalıcı silme
   engellenir**. *Öneri: üçüncüsü.*
8. **Denetim kaydı yeri:** Core `audit_events` ya da **modülün kendi tablosu**. *Öneri: modül
   tablosu.*
9. **Yeni kurulumda modül durumu:** satır yok / `ENV_TAKEOVER` / **`FRESH_INSTALL`, varsayılan
   kapalı**. *Öneri: `FRESH_INSTALL`.*
10. **Stok otoritesi modları:** V1'de yalnızca M0 + M1 mi? *Öneri: evet. ERP modu (M2) ilk gerçek
    ERP müşterisiyle ayrı dilim olur.*

Sonraki dilimlerden önce (bekleyebilir):

11. `RETURN` amacının stok anlamı ve müşteri iadesi akışı (W3 öncesi; DOM-001 cümlesi).
12. Konsinye stokun izlenip izlenmeyeceği (W4 öncesi; DOM-001 değişikliği).
13. Lot/seri/SKT zorlaması ve ürün takip politikası; SKT'si geçmiş ürünün bloklanması (W4).
14. ÜTS entegrasyonu: Servora mı bildirir, ERP mi, kimse mi? (V1 dışı.)
15. Dış doğrulama: mali müşavire "araç stoku ve sevk irsaliyesi" sorusu, ÜTS danışmanına
    "depo→araç transferi bildirim gerektirir mi" sorusu.

## 6. Önerilen ilk dilim

1. **W0 (Core, küçük):** Registry ikinci bir modülü kabul eder. Migration 075, iki CHECK'i
   genişletir ve `WAREHOUSE` için `FRESH_INSTALL` kapalı satırı yazar. Takeover yalnızca env
   anahtarı olan modüller için çalışır; capability tipi ve web navigasyon kapısı eklenir.
   Kabul: operatör Depo'yu açıp kapatabilir. Kapalıyken modül API'si `404` döner (Overview
   pilotundaki desen, `overview/service.ts:14-18,100`). Durum okunamazsa `503` döner
   (`:20-24,97-99`). İki durumda da capability `false` olur ve Overview davranışı değişmez.
2. **W1a (modül verisi, Core davranışı değişmez):** depo ve araç konumları, açılış sayımı,
   depo→araç transferi, bakiye ve hareket listesi. Her komutta `clientActionId` olur; denetim
   aynı transaction'da yazılır.
3. **W1b (sınırın kanıtı):** Onay transaction'ında kalem başına bir `ISSUE` yazılır. Tekrarlanan
   onay ikinci hareket üretmez (kaynak kalem üzerinde unique anahtar). ADMIN geçersizleştirmesi
   bir kez `REVERSAL` yazar. Gönderilmemiş listesi ve kalıcı kullanıcı silme engelleri eklenir.

Zorunlu kabul testleri: tekrarlanan komut ikinci hareket oluşturmaz; modülü açmak eski
teslimatları düşmez; offboarding hareket geçmişini korur; son birim için yarışan iki onaydan
yalnızca biri geçer; tutarsız bakiyeli restore yakalanır. Tam liste 06 §7'de.

### 6.1 06 için lead takip turu (`20261126-151914-deepseek-ffbc`)

- **G3b `DELIVERED_BEFORE_COUNT` ve G3a `PRODUCT_NOT_COUNTED` eklendi.** Bir satır, o konum ve
  ürünün son sayımı `delivered_at`'ten sonraysa stok düşmez ve gönderilmemiş listesinde görünür.
  `delivered_at` yalnızca karşılaştırma anahtarıdır; hareket zamanı onay anı olarak kalır (X11
  değişmedi). Gelecek tarihli `delivered_at` için koruma, sayım ekranının bekleyen teslimatları
  göstermesidir (06 §3.3).
- **Gönderilmemiş listesi sınırlandı.** Liste yalnızca modülün ilk açılışından (ilk `WAREHOUSE`
  enable kaydı, `operator_audit_events`) sonra onaylanan satırları sayfalı olarak gösterir.
  Restore iki tabloyu birlikte geri sardığı için ayrı bir "açılış tarihi" alanı tutulmaz
  (06 §5.9). W0'a buna uygun bir indeks eklendi; ayrıca beşinci CHECK
  (`operator_audit_events_module_value_check`, `074:107-119`) kapsama alındı.
- **Worker lead'in bir hatasını yakaladı.** README'nin ilk taslağı "kapalıyken 503" diyordu. Pilot
  sözleşmesi kapalı için `404`, okunamayan durum için `503` diyor
  (`docs/features/operator-module-pilot.md:156-158`). Düzeltildi. Aynı nedenle `MODULE_OFF`
  gönderilmemiş liste nedeni hiçbir zaman gözlenemiyordu (kapalıyken route `404` döner); 06'dan
  kaldırıldı.
- Tahmin güncellendi: W0 ~470 satır, W1 toplam ~4.650 satır (ölçülmedi).
