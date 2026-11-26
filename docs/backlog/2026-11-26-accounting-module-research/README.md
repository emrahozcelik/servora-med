# Muhasebe (Accounting) modülü — araştırma paketi (2026-11-26)

**Durum:** Yalnız araştırma. Bu klasör hiçbir uygulama yetkisi vermez. `AGENTS.md` §13
(`AGENTS.md:399-400`) tam muhasebe modülü ve e-fatura/e-arşiv entegrasyonunu açık sahip onayı
olmadan yasaklar; bu paket o onay kararının girdisidir. `DECISIONS.md` değişmedi.

Bağlayıcı girdiler: MOD-001 (özellikle §3 ve §5, `DECISIONS.md:1991-2071`), MOD-002
(`DECISIONS.md:3735-3788`), DOM-001, DOM-004, DOM-006, SALE-001, SALE-002, AGENTS.md §6/§7/§13.
Önceki araştırma: [çekirdek + modüller raporu](../2026-11-25-core-modules-architecture-research.md).

## Dizin

| Dosya | İçerik |
| ----- | ------ |
| [01-codebase-touchpoints.md](01-codebase-touchpoints.md) | Muhasebe katmanının okuyacağı/bağlanacağı yerler (SALE, teslimat, müşteri, ürün, `invoiceNumber`, raporlar, audit, idempotency, offboarding, restore, modül registry), Core'da finansal veriyi yasaklayan kurallar |
| [02-scope-options.md](02-scope-options.md) | MOD-001 §3 içinde üç kapsam kesiti (A/B/C), bilinçli dışlamalar, fiyatın nerede yaşayacağı |
| [03-turkish-e-document-landscape.md](03-turkish-e-document-landscape.md) | e-Fatura, e-Arşiv, e-İrsaliye, e-Defter, özel entegratör, tıbbi cihaz KDV'si, ÜTS ilişkisi, saklama (web, tarihli kaynaklar) |
| [04-external-accounting-integration.md](04-external-accounting-integration.md) | Logo, Mikro, Netsis, Paraşüt, Bizim Hesap, Uyumsoft, Zirve; dosya ile aktarım; kurulum modlarına göre yetkili sistem; dar outbox |
| [05-ownership-and-data-model.md](05-ownership-and-data-model.md) | Sahiplik matrisi, veri modeli taslağı (ÖNERİ), değişmezlik ve numaralama, audit, idempotency, aç/kapat, restore, offboarding, yetkiler, KVKK |
| [06-decision-brief.md](06-decision-brief.md) | Sahip kararları D1–D10, notlar arası çelişkiler C1–C9, en küçük güvenli ilk dilim ve kabul testleri, yasak kalanlar, riskler |

Notlar İngilizce yazıldı (kimlikler ve kaynaklar aynen kalsın diye); bu README'nin özeti ve karar
listesi Türkçedir.

## "MOD-001 A0" nedir?

Belirsiz değil. MOD-001 Consequences bölümü A0'ı keşif başlığı olarak tanımlar ve
`invoiceNumber` borcunu ona bağlar (`DECISIONS.md:2065-2070`). Başlık listesi
[uzlaştırma raporu §5](../../architecture/decision-reconciliation-report.md)'te "Accounting A0"
altındadır: ticari belge ve kaynak satış ilişkisi, fiyat ve KDV veri sahipliği, cari
hesap/tahsilat sınırı, `invoiceNumber` borcu, dış muhasebe ve e-belge entegrasyon yaklaşımı,
iptal/iade/düzeltme davranışı, yetki/KVKK/audit. A0 bir **karar değil, bir soru listesidir** ve
implementasyon yetkisi taşımaz. Bu paketin D1–D10 kararları A0 başlıklarının her birini karşılar.

## Türkçe özet

1. **Bugün Servora fiyat, fatura veya tahsilat tutmuyor ve bu bilinçli.** Satış kalemleri yalnız
   ürün snapshot'ı ve tam sayı adet taşır (`server/src/db/migrations/057_sale_from_visit.sql:70-90`,
   `058_sale_integer_quantity.sql:19-24`); teslimat amaç + miktar tutar (DOM-001); katalog fiyatı
   finansal anlam taşımaz (DOM-004, `server/src/modules/products/types.ts:43`); raporlarda ciro yok
   (DOM-006).
2. **Tek yapılandırılmış fatura izi, not alanındaki en fazla 100 karakterlik serbest metin.** Yalnız
   satış görüşmesi ve ürün teslimi notlarında kabul ediliyor, SALE kartında değil
   (`server/src/modules/job-cards/notes-service.ts:22,56-61`,
   `server/src/db/migrations/024_job_card_notes_invoice_number.sql:1-4`).
3. **Müşteri kaydında vergi numarası var, vergi dairesi ve ayrı ticari unvan yok**
   (`server/src/db/migrations/002_delivery_tracer.sql:4-25`, `004_crm_contacts.sql:5-15`).
4. **Sektör kuralı ciro eşiğinden önce gelir.** SGK ile sözleşmeli sağlık tedarik zincirine tıbbi
   malzeme veren mükellefler için e-Fatura, ciroya bakılmaksızın 1.7.2021'den beri zorunlu
   (VUK 526, RG 9.2.2021). Bilanço esasındaki mükellefler 1.1.2026'dan beri tutar sınırı olmadan
   e-Arşiv kesiyor; basit usul ve işletme hesabı 1.1.2027'ye ertelendi (VUK 589, RG 31.12.2025).
   Yani Servora'nın ürettiği "Fatura" başlıklı bir PDF yasal fatura olamaz. **DEĞİŞKEN** (`03`).
5. **GİB'in tıbbi cihaz ve ilaç faturaları için ayrı bir senaryosu var (`ILAC_TIBBICIHAZ`).** Cihaz
   satırında UNO/lot/seri/üretim tarihi istiyor. Bu, gelecekteki Depo/Stok modülünün lot/seri
   verisiyle doğrudan ilgili. Sürüm ve tarihler **DEĞİŞKEN** (`03` §1.5).
6. **Üç kapsam kesiti var:** A = fatura referans defteri (fiyat yok), B = fiyatlı teklif/sipariş
   belgesi (yasal fatura değil), C = B + hafif cari hesap, alacak ve sahada tahsilat. Hiçbir kesitte
   Servora e-Fatura/e-Arşiv/e-İrsaliye **kesmez**. Hiçbir kesit Depo modülüne muhtaç değil (`02`).
7. **Dış sistem tarafında en iyi belgelenmiş ilk hedef Paraşüt** (OAuth2, OpenAPI, webhook, dış
   referans anahtarıyla idempotent arama), ikinci Mikro. Logo Go'nun REST desteği **DOĞRULANMADI**.
   Pazar payı verisi toplanmadı; ilk pilot müşterinin gerçekte hangi sistemi kullandığı her şeyden
   belirleyicidir (`04` §7).
8. **Yön tek taraflı:** Accounting Core'a FK ile bağlanır, Core'a hiçbir belge kolonu, bayrak veya
   geri çağrı eklenmez. Para uçtan uca `NUMERIC` ve string; numaralama sequence değil, transaction
   içindeki sayaç satırı; her komut mevcut `runCriticalAction` (`server/src/db/critical-action.ts:142`)
   ile idempotent ve aynı transaction'da audit (`05`).
9. **Önerilen ilk dilim: Kesit A**, MOD-002 registry'sinde `ACCOUNTING` anahtarıyla, varsayılan
   kapalı. Kapalıyken `404`, durum okunamazsa `503`, env'e geri düşme yok
   (`docs/features/operator-module-pilot.md` §7). 14 kabul testi `06` "Acceptance tests"
   bölümünde.

## Notlar arası çelişkiler

`06` "Conflicts between the notes" bölümü C1–C9'u çözüyor (kapalı modül durum kodu, eski
`invoiceNumber` taşıması, referansın teslimata bağlanması, toplam tutarın zorunluluğu, mükerrer
numara anahtarı, düzeltme yöntemi, manuel fiyat ile ERP fiyatı, VUK 509 bent numarası, entegratör
durumunun saklanması). Lead olarak bu çözümleri kabul ediyorum; aşağıdaki dört noktada `06`'yı
düzeltiyor veya tamamlıyorum:

- **L1 — MOD-001 §5'in kapsamı fazla geniş okunmuş.** `04` (Summary, §5 Mode 2b) ve `06` D2,
  Servora'nın fiyat/KDV tutmasının MOD-001 §5'i değiştirmeyi gerektirdiğini söylüyor. §5 başlığı
  "SALE compatibility"dir ve yalnızca SALE JobCard'a fiyat, KDV, `invoiceNumber` vb. eklenmesini
  "bu aşamada" yasaklar (`DECISIONS.md:2051-2059`). §3 ise teklif/ticari belge, belge satırları ve
  belge vergi verisini açıkça Accounting'e verir (`DECISIONS.md:2032-2035`). Doğru okuma: fiyatın
  **Accounting belgesinde** yaşaması MOD-001'i değiştirmez, ama fiyat sahipliği için yeni bir kabul
  kaydı (A0 / "ACC-B") gerekir. SALE'e fiyat yazmak ise §5'i değiştirir.
- **L2 — `06` kendi içinde tutarsız: D2 "Mode 2b onaylanmasın" derken D3 önerisi (belge satırında
  elle girilen, Accounting'e ait fiyat) fiilen Mode 2b'dir.** İkisi de yalnız Kesit B için geçerli;
  Kesit A'yı etkilemez. Karar Kesit B gündeme geldiğinde muhasebeci/ERP bilgisiyle birlikte
  verilmeli.
- **L3 — Kabul testi 13 bir Core komutunu modül durumuna bağlıyor.** Modül açıkken not komutunun
  `invoiceNumber`'ı `400` ile reddetmesi, `06`'nın D6'da kendisinin reddettiği desendir: bir Core
  komutu modüle bağımlı olur (SCH-001 dersi, `DECISIONS.md:3671-3704`). Daha güvenli seçenek: not
  komutu hiç değişmez, modül açıkken yalnızca arayüz alanı gizlenir (sunum, capability'ye bağlı).
  Bu, D5'in bir alt kararı olarak sahibe soruluyor.
- **L4 — Migration numarası.** `06` ilk dilim için "migration 075" yazıyor. `origin/main`'de son
  migration 074 (`074_installation_operator_and_module_state.sql`); paralel oturumlar (Takvim 2.0,
  Müşteriler 2.0, Depo/Stok) da 075'i alabilir. Numara uygulama PR'ı açılırken verilir; bu paket
  hiçbir numarayı rezerve etmez.

## Sahibin vermesi gereken kararlar

Ayrıntılı seçenekler ve gerekçeler `06` "Decisions the owner must make" bölümünde. Lead önerileri:

| # | Karar | Önerilen | Neyi açar |
| - | ----- | -------- | --------- |
| D1 | AGENTS §13 onayı neyi kapsar: hiç / yalnız A / A+B / A+B+C | **Yalnız Kesit A**; e-Fatura/e-Arşiv/e-İrsaliye kesmek her durumda kapsam dışı, onay metninde açıkça yazılır. Onay `DECISIONS.md`'ye yeni bir kayıt (ör. "ACC-A") olarak uygulayan PR'la birlikte yazılır | İlk dilim |
| D2 | Kurulum moduna göre finansal otorite | Şimdi **Mode 1** (fatura dış sistemde kesilir, Servora yalnız referans tutar); ileride fiyatsız sipariş gönderen Mode 2a; Mode 2b/3 ayrı karar (L1, L2) | D8, gelecekteki outbox |
| D3 | Fiyat ve KDV nerede | Katalog `referencePrice` bilgi amaçlı kalır, DOM-004 değişmez; Kesit B'de belge satırında Accounting'e ait fiyat ya da ERP fiyatı. Kesit A'yı etkilemez | Yalnız Kesit B |
| D4 | Vergi kimliği alanları | VKN/TCKN `customers.tax_number`'da kalır; vergi dairesi, ticari unvan ve fatura adresi Accounting'e ait 1:1 "fatura profili"nde; her belge alıcı snapshot'ı dondurur | Kesit B (A'da isteğe bağlı) |
| D5 | `invoiceNumber` not borcu | Eski notlar olduğu gibi kalır, kopyalanmaz; yeni kayıtlar referans tablosuna; modül açıkken yalnız arayüz alanı gizlenir (L3). Tarihî kopyalama ayrıca onaylanan ayrı bir adım | İlk dilim |
| D6 | Bağlı belgesi olan SALE düzeltilir/iptal edilir/geçersiz kılınırsa | **Engelleme yok**; referans snapshot'ını korur, uzlaştırma listesinde işaretlenir. Core komutu modüle bağımlı olmaz | İlk dilim |
| D7 | Tutarlar operasyonel raporlara girebilir mi | **Hayır**; tutar yalnız Muhasebe ekranlarında. Alacak yaşlandırması ileride kendi kararıyla | DOM-006 korunur |
| D8 | İlk dış entegrasyon | Şimdi **yok** (Kesit A elle giriş); sonra pilot müşterinin gerçek sistemine göre, belgeye göre Paraşüt > Mikro | Sonraki dilimler |
| D9 | KVKK, TCKN | Mevcut yetki sınırlarında kalır, yeni rol yok; saklama süresi muhasebeciyle doğrulanır (TTK 82: 10 yıl, VUK 253: 5 yıl, **DOĞRULANMADI**) | İlk dilim |
| D10 | Depo/Stok ilişkisi | e-İrsaliye ve ÜTS Muhasebe'nin işi değil; `PRODUCT_DELIVERY` sevk irsaliyesi değildir; `ILAC_TIBBICIHAZ` lot/seri ihtiyacı Depo/Stok araştırmasına not edildi | Depo/Stok oturumu |

Ek olarak sahipten beklenen bilgiler (`06` "Open questions"): ilk pilot müşterinin kullandığı
muhasebe/ERP sistemi ve sürümü; fatura numarasının bugün pratikte teslimatta mı satışta mı
yazıldığı; tutarın kayıt anında bilinip bilinmediği; hatalı referansı kimin iptal edeceği
(Yönetici+Admin mi, yalnız Admin mi).

## Doğrulama kaydı

Lead aşağıdakileri bu oturumda kendisi kontrol etti:

- Repo: `notes-service.ts:22,56-61` (`invoiceNumber` yalnız SALES_MEETING/PRODUCT_DELIVERY);
  `002_delivery_tracer.sql:4-25` (vergi dairesi/unvan yok); `critical-action.ts:142`;
  `products/types.ts:43` (`Number(default_price)`); `operator-module-pilot.md` §7 (kapalı `404`,
  okunamaz `503`); `DECISIONS.md:2032-2035`, `:2051-2059`, `:2065-2070`; `AGENTS.md:399-400`;
  uzlaştırma raporu §5 A0 listesi; `origin/main` son migration 074.
- Web (2026-11-26): VUK 526 ile tıbbi malzeme tedarikçilerine e-Fatura zorunluluğu ve 1.7.2021
  geçişi; VUK 550'nin IV.1.4(a)'yı yeniden düzenlediği (bent numarası bu yüzden doğrulanmadı);
  VUK 589 ile basit usul/işletme hesabı için e-Arşiv tarihinin 1.1.2027'ye ertelenmesi ve bilanço
  esası için 1.1.2026'dan itibaren tutar sınırı olmaması; GİB "İlaç ve Tıbbi Cihaz Teslimlerine
  İlişkin Fatura Teknik Kılavuzu"nun varlığı. Kaynaklar `03` ve `06` "Sources" bölümlerinde.
- Doğrulanmayanlar notlarda **UNVERIFIED**, sık değişen eşik/oran/tarihler **VOLATILE** olarak
  işaretli; KDV oranları ve e-İrsaliye eşiği lead tarafından ayrıca kontrol edilmedi.

Üretim: altı DeepSeek araştırma koşusu (model-fleet), aynı klasörde paralel. Dört koşu
`OWNERSHIP_VIOLATION` ile işaretlendi; nedeni aynı klasöre yazan kardeş koşuların dosyaları
(yanlış alarm). Klasör dışında hiçbir dosya değişmedi. Koşu kimlikleri:
`20261126-141138-deepseek-aeaa` (01), `-00e1` (02), `-df4f` (03), `-2e3d` (04), `-3677` (05),
`20261126-145315-deepseek-5626` (06).
