# 04 — Turkish medical-device traceability obligations and depot/vehicle stock practice

- **Date:** 2026-11-26
- **Status:** Research input for the future Warehouse/Stock ("Depo/Stok") module. **Not a decision.** Nothing here authorizes implementation.
- **Scope:** ÜTS (Ürün Takip Sistemi) obligations that touch stock; EU MDR UDI/EUDAMED relevance for Turkey; e-İrsaliye/VUK dispatch documents for vehicle stock; how Turkish distributors and field-sales tools actually run depot + vehicle stock; consequences for Servora-Med.
- **Access date for every external source below: 2026-11-26.** Sources are listed once in §0.2 and cited inline as `[S#]`, so each claim resolves to a URL + publication/update date where the publisher shows one.
- **Not legal advice.** §3 and §8 flag the items that must be confirmed by a mali müşavir / lawyer before any product behaviour depends on them.

---

## Özet (TR)

- **ÜTS stok değil, sahiplik ve tekil ürün hareketi tutar.** Verme bildirimi tek başına stok aktarmaz; karşı taraf alma bildirimi yapmadan ürün el değiştirmiş sayılmaz `[S5 m.9/2]`. Depo, araç, raf, rezervasyon gibi kavramlar ÜTS'de yoktur.
- **Alma bildiriminin iptali yoktur** `[S5 m.10/4]`, `[S6]`. Yanlış alma ancak karşı tarafa yeni bir verme ile düzeltilir. Bu, ÜTS entegrasyonunda idempotency ve "geri alınamaz adım" tasarımını zorunlu kılar.
- **Zorunlu alanlar sabittir:** ürün numarası + lot ve/veya seri + (lot ise) adet + üretim **veya** son kullanma tarihi `[S5 m.6/3, m.7/5]`; verme/alma için ayrıca **belge numarası** (fatura/irsaliye/tutanak) `[S5 m.9/3, m.9/5]`.
- **Konsinye ÜTS'de "verme" ile temsil edilir** ve resmî açıklama bunu açıkça söyler; kullanılmayan konsinye ürün geri verme ile döner `[S6]`. Yani konsinye, ayrı bir bildirim türü değildir.
- **Son kullanma tarihi geçen ürün için yalnızca geri çekme (verme/alma) ve imha/bertaraf bildirimleri yapılabilir** `[S5 m.27]`; imha gerekçeleri arasında "Son kullanma tarihi geçmiş" vardır `[S5 m.21/3]`. SKT'si geçmiş ürün satılamaz — bu bir depo kuralı olarak modellenmelidir.
- **Süreler sınırlı ve dağınık:** üretim bildirimi üretimden itibaren en geç **120 gün** `[S8]`; askıdaki verme için alma bildiriminde süre sınırı yok `[S9]`. Verme/alma için gün sayısı içeren bir hüküm incelenen kaynaklarda **bulunamadı** (UNVERIFIED).
- **Sınıf kuralı yerine ürün bayrağı:** tekil takip 2017–2019'da optik → AIMD → sınıf III → diğer cihazlar sırasıyla açıldı `[S10]`; güncel belirleyici, ürün kaydındaki **takip durumu** (Takip Ediliyor / Takip Edilmiyor) ve takip türüdür (lot/seri) `[S5 m.5]`. Servora sınıf tablosu gömmez, ürün bayrağını saklar.
- **Resmî entegrasyon yolu var:** ÜTS, HBYS'ler için adlandırılmış web servisleri yayımlar (verme, alma, iade alma, imha, ödünç, geri çekme…) `[S7]`; erişim sistem token'ı + izinli IP ile yapılır ve ayrı bir test ortamı vardır `[S11]` (ikincil kaynak). **Öneri:** Servora bunu V1'de yapmasın; ama hareket tablosunu sonradan bağlanacak şekilde tasarlasın.
- **Araç stoku belge ister:** VUK m.230/5 kendi işyerleri/şubeleri arasındaki taşımalarda bile sevk irsaliyesini zorunlu kılar `[S13]`; e-İrsaliye mükellefleri için belge fiili sevkten **önce** düzenlenir `[S15]`, `[S16]`. "Araç bir depodur" kurgusu bu belgeyle birlikte kurulmalıdır; araç/işyeri yorumu **mali müşavir onayı gerektirir** (§8).
- **Sektör pratiği net:** araç = ayrı depo, iki adımlı transfer (sevk → teslim al), FEFO lot önerisi, gün sonu sayım + fark zimmeti, iade ayrı belge, SKT'si geçmiş mal satışa/araca gönderilmez `[S20]`–`[S28]`, `[S32]`. Türk ERP'lerinde araç deposu, seri/lot, konsinye depo ve "yoldaki stok" hazır kavramlar `[S22]`, `[S23]`, `[S25]`, `[S26]`.
- **Servora bugün:** ürün kartı bilgilendirici (barkod/lot/SKT yok) `[C1]`; teslim satırında `lot_no/serial_no/expiry_date` **kolonları zaten var** `[C2]`–`[C4]` ama stok bakiyesi yok; adet kuralı tam sayı (1–999999999) `[C7]`. Depo/Stok modülü bu ikisinin arasına, MOD-001 sınırları içinde girmelidir `[C5]`.

---

## 0. Method and evidence rules

### 0.1 What was done

- Web research only; **no customer, company or personal data was put into any query.** Queries were generic topic queries in Turkish and English.
- Primary texts were preferred: Resmî Gazete / mevzuat.gov.tr texts, TİTCK/ÜTS pages, TİTCK guides, GİB tebliğ, European Commission pages. Vendor pages are used only for *market practice*, never for legal obligation.
- Where only a secondary source (consultancy blog, vendor, reseller) supported a claim, it is marked **UNVERIFIED** or explicitly labelled "secondary".
- Repo facts carry `path:line`; external facts carry a source id that resolves in §0.2.
- The ÜTS movement guide PDF and the GİB tebliğ PDF were downloaded and converted to text for exact quotation; the extracted text is kept with the run evidence (§0.3).

### 0.2 Source register

| # | Source | Publisher | Publication / update | URL |
| --- | --- | --- | --- | --- |
| S1 | Tıbbi Cihaz Yönetmeliği (MDR-aligned), RG 2.6.2021/31499 (Mükerrer), in force 26.5.2021 | mevzuat.gov.tr (TİTCK) | RG 2021-06-02; consolidated text last change shown as 2024-08-17 on the mirror used | https://www.mevzuat.gov.tr/MevzuatMetin/yonetmelik/7.5.38657.pdf |
| S2 | Same regulation, consolidated reading copy (Art. 33 EUDAMED, Art. 34 ÜTS) | Lexpera (legal database mirror) | "Son Değişiklik Tarihi: 17.08.2024" | https://www.lexpera.com.tr/mevzuat/yonetmelik/yr801y2021n31499r1p1 |
| S3 | Tıbbi Cihaz Mevzuatı index page (confirms RG date and IVD regulation in-force date 26.5.2022) | TİTCK | page undated | https://titck.gov.tr/faaliyetalanlari/tibbicihaz/tibbi-cihaz-mevzuati |
| S4 | Tıbbi Cihaz Satış, Reklam ve Tanıtım Yönetmeliği, RG 15.5.2014/29001 (consolidated) | mevzuat.gov.tr | original 2014-05-15; amendments 2015-07-25 … 2023-08-17, latest listed 2026-07-03/33299 | https://www.mevzuat.gov.tr/MevzuatMetin/yonetmelik/7.5.19666.pdf |
| S4a | Same regulation, amendment table (lists 8 amending regulations incl. 3/7/2026-33299) | Hukuk Eğitim (secondary mirror) | "Son değişiklik 03.07.2026" | https://hukukegitim.com/mevzuat/yonetmelik/tibbi-cihaz-satis-reklam-ve-tanitim-yonetmeligi |
| S5 | Tıbbi Cihazların Ürün Takip Sistemi Tekil Hareket Bildirimlerine İlişkin Kılavuz (PDF, 34 articles) | TİTCK / ÜTS | PDF created 2022-01-31, modified 2022-02-01 | https://uts.saglik.gov.tr/files/utsTekilHareketKlavuzu.pdf |
| S6 | "Bildirim Açıklamaları" — authoritative per-notification explanations (konsinye, iptal, stok bildirimi) | ÜTS (uts.saglik.gov.tr) | page undated | https://uts.saglik.gov.tr/bildirim-aciklamalari.html |
| S7 | "HBYS'lerin Kullanacakları Takip ve İzleme Web Servisleri" — named integration services | ÜTS (uts.saglik.gov.tr) | page undated | https://uts.saglik.gov.tr/takip-ve-izleme-web-servisleri.html |
| S8 | ÜTS landing page + FAQ (actor list, integrations, 120-day production notification) | TİTCK | page undated; 120-day rule stated as effective 2023-03-31 | https://www.titck.gov.tr/faaliyetalanlari/tibbicihaz/urun-takip-sistemi-uts |
| S9 | ÜTS Kullanıcı Kılavuzu v5.2.0 (Rev. 31) — business rules incl. "askıdaki ürünlerin alma bildirimi için süre sınırı yoktur" | ÜTS (uts.saglik.gov.tr) | Rev. 31, dated 13.01.2016 | https://uts.saglik.gov.tr/files/2016/11/UTS-PRJ-KullaniciKilavuzu-Uygulama_v5.2.0.pdf |
| S10 | 2019-ÜTSG-02 sayılı duyuru — tekil takip roll-out dates and "cannot be used in service delivery" cut-offs | TİTCK | 2019-01-15 | https://www.titck.gov.tr/duyuru/3464 |
| S11 | ÜTS integration vendor pages (system token, allowed-IP, separate test environment `utstest.saglik.gov.tr`, "sonucu belirsiz" handling) | PazarOMatik (secondary) and UBBMED (secondary, 2018-03-26) | PazarOMatik undated; UBBMED 2018-03-26 | https://pazaromatik.com.tr/site/entegrasyonlar/uts-urun-takip-sistemi/ · https://ubbmed.com/uts-entegrasyonu-icin-ornek-c-ve-java-kodlari-yayimlandi/ |
| S12 | Tıbbi Cihazların ÜTS'ye Kayıt Süreçlerine İlişkin Kılavuz TCKKD-KLVZ-03 (registration, not movement) | TİTCK (copy hosted by a third party) | in force 2026-05-13, Rev.00 | https://ubbmed.com/wp-content/uploads/2026/05/Kilavuz-Metni-V.4.0.pdf |
| S13 | Vergi Usul Kanunu m.230 (invoice content; sevk irsaliyesi duty; multi-workplace/branch transfers; goods sent to a commission agent) | mevzuat mirror quoting official text | law text (m.230 as amended 1985) | https://mufettis.ai/mevzuat/vuk/230/ |
| S14 | VUK Genel Tebliğ No. 509 (consolidated), section IV.3 e-İrsaliye | GİB (cdn.gib.gov.tr) | consolidated 2025 text (with 515/526/535/550/573 amendments) | https://cdn.gib.gov.tr/api/gibportal-file/file/getFile?objectKey=MEVZUAT_TEBLIGLER%2F2025%2FVukTeb509_Guncel.pdf |
| S15 | TÜRMOB e-İrsaliye SSS ("e-İrsaliye malın fiili sevkinden önce düzenlenir ve iletilir") | TÜRMOB | page undated | https://www.turmob.org.tr/e-donusum/eirsaliye/sss |
| S16 | e-İrsaliye practice guide: paper copy or electronic display in vehicle; taşıma irsaliyesi remains separate | yukyol.com (secondary practitioner) | 2026-10-06 | https://yukyol.com/rehber/e-irsaliye-nakliye |
| S17 | Sevk irsaliyesi vs taşıma irsaliyesi (VUK 230/5 vs 240) | Cimen Sürer Hukuk (secondary) | 2026-11-08 | https://cimensurerhukuk.com/sevk-irsaliyesi-e-irsaliye-vuk-230/ |
| S18 | EUDAMED: first four modules mandatory from 28 May 2026; UDI/Device content | European Commission (DG SANTE) | news 2025-11-27; overview updated after 2026-05-28 | https://health.ec.europa.eu/latest-updates/eudamed-four-first-modules-will-be-mandatory-use-28-may-2026-2025-11-27_en · https://health.ec.europa.eu/medical-devices-eudamed/overview_en |
| S19 | EUDAMED obligations from 28 May 2026, legacy-device transition to 27 Nov 2026, custom-made excluded from UDI/Device module | FAMHP (Belgian competent authority) | 2026-05-28 | https://www.famhp.be/en/news/eudamed_clarifications_regarding_obligations_from_28_may_2026 |
| S20 | Mobilteg Saha — araçtan satış / van sales (vehicle = depot, FEFO, evening count → zimmet, load/unload screens, ERP owns stock option) | Mobilteg (vendor) | "Son güncelleme: 01.11.2026" | https://saha.mobilteg.com/cozumler/aractan-satis-sicak-satis-programi/ |
| S21 | NetEsnaf saha satış (depot→vehicle real transfer, end-of-day reconciliation, no document without depot) | NetEsnaf (vendor) | page undated | https://netesnaf.tr/saha-satis |
| S22 | Logo Netsis 3 Entegre brochure (Plasiyer Takibi, Seri/Lot Takibi, şube support, Logo Mobile Sales) | Logo Yazılım (vendor PDF) | undated brochure | https://cdn.logo.com.tr/files/logocomtr/Uploads/Documents/logo-netsis-3-entegre-tan%C4%B1t%C4%B1m-bro%C5%9F%C3%BCr%C3%BC-tr.pdf |
| S23 | Mikro ERP depo/barkod module description: "Merkez, şube ve araç depoları", seri/lot, transfer fişleri | Nokbil (Mikro solution partner — secondary) | page undated | https://nokbilyazilim.com/mikro/modul/depo-barkod |
| S24 | Paraşüt stok ve depo takibi: multi-warehouse, warehouse transfer, transfer fişi/irsaliye | Paraşüt (vendor) | page undated | https://www.parasut.com/stok-ve-depo-takip-programi |
| S25 | Nebim V3 çoklu depo: transfer approval chain, "yoldaki stoklar" (in-transit) | Nebim (vendor) | page undated | https://www.nebim.com.tr/tr/depo-yonetimi/coklu-depo-envanter-yonetimi |
| S26 | ETA çözüm sitesi: çoklu depo, transfer irsaliyesi, **fason/konsinye depo** as separate depot type | Etasoft (ETA solution site — vendor/partner, domain ownership UNVERIFIED) | page undated | https://etasoft.com.tr/cozumler/coklu-depo-yonetimi |
| S27 | AKINSOFT Wolvox stok/depo: seri no, lot/SKT, bloke+termin (reservation), lokasyon | Akınsoft İzmir (dealer — secondary) | page undated | https://www.akinsoftizmir.com.tr/wolvox-erp/stok-depo-yonetimi/ |
| S28 | Etibas plasiyer/araç satış: depo→araç sevkiyat + araçta "Teslim Al" (two-step), vehicle stock screen | Etibas (vendor) | page undated | https://www.etibas.com/plasiyer-arac-satis |
| S29 | Aks Yazılım "ÜTS Dental" module: dental clinics/depots handling ÜTS registration + GTIN/HIBC barcode formats | Aks Yazılım (vendor, secondary for regulation) | page undated | https://aksyazilim.com/uts-kayit-ve-takip-entegrasyonu/ |
| S30 | 2026 ÜTS changes for dental clinics: implant/bone-graft/SUT-matched consumables in scope; custom-made prostheses outside standard unit notification | DentFlow (dental-sector vendor blog — secondary) | 2026-05-22 | https://dentflow.com.tr/blog/2026-uts-mevzuat-degisiklikleri |
| S31 | Logo store: Tiger 3 DEYS depot-management module (sayım, fire, seri takip, el terminali); pricing shown | Logo Yazılım marketplace (vendor) | page undated | https://store2.logo.com.tr/product/tiger-plus-deys-depo-yonetim-sistemi |
| S32 | sipnik Sahada: araç = depo, iki adımlı transfer, kör sayım, FEFO, "SKT'si geçmiş mal satışa, araca ve şubeye gönderilmez" | sipnik (vendor) | page undated | https://sipnik.com/sahada |
| S33 | Paraşüt blog: "Malın fiziksel olarak taşınması, işletmenin kendi depoları arasında olsa bile sevk irsaliyesi gerektirir" | Paraşüt (vendor blog, secondary for law) | page undated | https://www.parasut.com/blog/depo-takip-programi |

### 0.3 Repo sources (verified at the cited lines)

| Id | File:line | What it proves |
| --- | --- | --- |
| C1 | `server/src/modules/products/types.ts:3-17` | Product has name/sku/brand/category/model/unit/referencePrice only — no barcode, no lot, no expiry, no stock fields |
| C2 | `server/src/db/migrations/002_delivery_tracer.sql:137` | `CREATE TABLE job_card_delivery_items` |
| C3 | `server/src/db/migrations/002_delivery_tracer.sql:142-143` | `delivery_purpose` CHECK includes `CONSIGNMENT`, `RETURN` |
| C4 | `server/src/db/migrations/002_delivery_tracer.sql:150-152` | `lot_no`, `serial_no`, `expiry_date` already exist on the delivery line |
| C5 | `DECISIONS.md:1991-2031` | MOD-001: Core never owns stock; Warehouse owns depots, vehicle stock, quantities, movements, lot/serial/expiry; single source of truth set explicitly per deployment |
| C6 | `DECISIONS.md:534-568` (esp. 567-568) | DOM-004 keeps the catalog informational; "Inventory, warehouse, barcode, costing … require a later separately approved design" |
| C7 | `DECISIONS.md:3458-3489` | DELIVERY-QTY-001: delivery quantity is a whole integer 1–999999999; measured goods (ml/mg/litre) need a **new** accepted decision |
| C8 | `server/src/modules/job-cards/types.ts:797-811` | `DeliveryItem` exposes `lotNo`, `serialNo`, `expiryDate` in the API contract |
| C9 | `server/src/modules/job-cards/repository.ts:2305`, `:2435`, `:5189`, `:5206` | the columns are read and written (insert/update paths) |
| C10 | `web/src/jobs/jobs-api.ts:548`, `:603` | the web client type carries `lotNo/serialNo/expiryDate` |
| C11 | `docs/backlog/2026-11-25-core-modules-architecture-research.md:230` | Depo/Stok is step 5: registry-managed from day one, own migration, in-transaction idempotency+audit, offboarding/restore contracts |

---

## 1. ÜTS — what it is, and what it is not

ÜTS is TİTCK's national register and unit-level tracking system for medical devices (plus cosmetics and certain biocides). It follows a device from production/import to the point of use `[S8]`. Legal basis: Tıbbi Cihaz Yönetmeliği Art. 34 obliges domestic economic operators, notified bodies, health institutions and health professionals to fulfil ÜTS obligations, and delegates the detail to TİTCK regulations `[S1]`, `[S2]`. IVD devices have the mirror article (Art. 32) in the IVD regulation, in force since 26.5.2022 `[S3]`, `[S12]`.

**The single most important design fact:** ÜTS models **ownership transfer between organisations**, not **physical location**. Four independent statements establish this:

1. Verme exists for giving units "to another institution/firm/hospital" `[S5 m.9/1]`.
2. Until the recipient performs alma, "stock transfer does not occur" for that unit `[S5 m.9/2]`.
3. Ownership passes with alma ("bu bildirimle beraber tekil ürünün sahipliği alıcı tarafa geçmiş olur") `[S9]`.
4. Only the owning institution may file a movement for a unit `[S9]`.

Consequences: an internal depot→depot or depot→vehicle move has **no ÜTS counterpart**; a rep's car stock remains company-owned and therefore invisible to ÜTS; and ÜTS "stock" is a by-product of accepted transfers, not a warehouse balance. This is a reasoned inference from (1)–(4), not a quoted rule — see §8 Q5 for the confirmation step.

### 1.1 Actors

| Actor | ÜTS treatment | Can it file? |
| --- | --- | --- |
| Üretici (manufacturer) | firm record; production notification | üretim, verme, ihracat, imha, HEK, recall… `[S5]` |
| İthalatçı (importer) | firm record | ithalat, mahrecine iade, verme… `[S5 m.7, m.24]` |
| **Bayi** (distributor/dealer) | defined as "a real or legal person in the supply chain other than the manufacturer or importer who keeps a device on the market up to the point of service delivery" `[S5 m.4]` | verme/alma, iade-alma, imha, HEK, recall; import notification **only if the importer authorised it** `[S5 m.7/3]` |
| Satış merkezi (sales centre, licensed) | must register devices and perform tekil hareket bildirim `[S4 m.8/4]`; may not sell devices absent from the register `[S4 m.26/2]` | verme, tüketiciye verme, imha… |
| Sağlık hizmet sunucusu (hospital/clinic) | must be registered; consumes or implants | alma, kullanım, tüketim, envanter, imha, iade-alma |
| **Diş protez laboratuvarı** (dental prosthesis laboratory) | explicitly listed as an ÜTS user type `[S8]` | as a firm in the chain |
| Tıbbi hizmet sağlayıcı | must hold a firm record when supplying services on a consumable/kit basis `[S5 m.32]` | per EK-3 of the guide `[S5 m.32/2]` |
| Optisyenlik müessesesi, eczane, işitme/protez-ortez merkezi | listed user types `[S8]` | per their own flows |
| TİTCK | recall decisions, tracking decisions, definitions | — |

Historical cut-off warning (2019): firms were told not to sell or distribute to counterparties lacking ÜTS registration, and products whose unit-level movement had not started could not be used in service delivery `[S10]`. That rule still explains why a distributor's customer master needs the counterparty's ÜTS firm number.

### 1.2 Notification catalogue (the part that touches stock)

Field requirements are quoted from the guide `[S5]`; "stock effect" is my reading of the same articles and `[S6]`.

| Notification | Who files | Mandatory fields | Stock / ownership effect | Cancellable |
| --- | --- | --- | --- | --- |
| Üretim | manufacturer (origin TR) | lot and/or serial; qty if lot-only; production **or** expiry date `[S5 m.6/3]` | creates units in the firm's ÜTS stock | yes, if no downstream movement (serial) / full qty still in stock (lot) `[S5 m.6/6]` |
| İthalat | importer or authorised bayi | + importing country, country of origin `[S5 m.7/5]`; customs declaration quota opened first `[S6]` | creates units | yes, same conditions `[S5 m.7/8]` |
| **Verme** | the giver | qty, recipient institution, **belge numarası** (invoice/dispatch/record) `[S5 m.9/3]`; free-sample flag `[S5 m.9/4]` | **none until alma** `[S5 m.9/2]`; unit becomes "pending" and blocks further notifications `[S9]` | yes, before alma `[S5 m.9/6]` |
| **Alma** | the receiver | accept, or accept **less** (lot-tracked only) `[S5 m.10/2]`; or "almak istemiyorum" `[S5 m.10/5]` | ownership + ÜTS stock move to receiver | **no** `[S5 m.10/4]`, `[S6]` |
| Kullanım | health provider (implantable / reimbursed / patient-linked) | qty, date, patient identity fields `[S5 m.12/3]` | unit leaves stock, patient-linked | yes, unless MEDULA finalised `[S5 m.12/6]` |
| Tüketim | health provider (non-usage-report devices) | qty, date `[S5 m.13/3]` | unit leaves stock | yes |
| Tüketiciye verme | sales centre → citizen | qty, date; identity fields when announced `[S5 m.14]` | leaves stock | yes |
| Tüketiciden iade alma | sales centre | (mirror of the above) `[S5 m.14/7]` | returns to stock | yes |
| **HEK / Zayiat** | any firm | qty + **reason code**: HEK, doğal afet, yangın, çalınma, **stok düzeltme**, diğer(+note) `[S5 m.15/3]` | writes units off | yes |
| **İmha / Bertaraf** | any firm | qty + reason + document no; reasons include **"Son kullanma tarihi geçmiş"** `[S5 m.21/3]` | writes units off | yes |
| İhracat | exporter | customs declaration no + qty `[S5 m.17/2]` | leaves stock | yes |
| Mahrecine iade | importer returning abroad | qty + customs declaration no `[S5 m.24/2]` | leaves stock | yes |
| Tanımsız yere verme / ondan iade alma | any firm, when the counterparty cannot be registered | tax id, document no, qty `[S5 m.16/2]` | transfer out / back | yes |
| Geri çekme verme / alma | recall chain | qty, institution, document no `[S5 m.18/3]` | restricted transfer | only verme side `[S5 m.18/4]` |
| Geçici kullanıma verme / kullanımdan alma | loan of a device to a patient | qty, date, patient fields `[S5 m.20/2]` | temporary out | yes |
| **Stok bildirimi** | any firm **except** health providers `[S6]` | existing stock declaration when TİTCK starts tracking a product | **creates opening units** | yes |
| Envanter | health providers, calibration-subject durable equipment | product no + **serial** + acquisition date; no lot `[S5 m.8/2]` | asset register, not consumable stock | yes |
| Yeniden işleme, Islah/düzeltici faaliyet | manufacturer/firm | qty / corrective action `[S5 m.22-23]` | process records | yes |

Two market-relevant gaps in the catalogue:

- **There is no generic business-to-business "iade" notification.** Returns between firms are executed as a fresh verme by the returning party (the older user guide states verme is used for "satış, hibe, iade vb." `[S9]`, and `[S6]` describes consignment return as verme). Importer→abroad and consumer→seller returns have their own types. A warehouse "return" is therefore **not** a ÜTS return; it is a reverse shipment.
- **"Stok düzeltme" is a first-class ÜTS reason** (`[S5 m.15/3]`), which means a stock correction is a reportable event, not a silent edit.

### 1.3 Identifiers

| Concept | ÜTS term | Notes |
| --- | --- | --- |
| Unit identity | **Eşsiz Kimlik** = product number + serial/lot number + production/expiry dates `[S5 m.4]` | Turkish analogue of UDI-PI + dates; the guide never uses "UDI" |
| Product identity | **birincil ürün numarası** `[S5 m.5/6]` | the registered product number |
| Pack barcode | **piyasaya arz barkodu** with an "iç miktarı / içindeki ürün adedi" multiplier `[S5 m.5/7, m.28/2]` | one scan can move N units; only üretim/ithalat/ihracat + verme/alma may use it `[S5 m.28/4]` |
| Tracking mode | **lot** (many units per number) vs **serial** (one unit per number) `[S5 m.5/2-3]`; if both, serial wins `[S5 m.5/4]` | mixed modes per product are normal in a catalogue |
| Dates | production **or** expiry required; if shelf life is registered, the missing one is derived; an expiry beyond shelf life is rejected `[S5 m.6/4-5]` | one product number + one lot cannot carry two different date pairs `[S5 m.5/5]` |
| GTIN / HIBC | barcode formats a vendor says it handles during product registration `[S29]` | **UNVERIFIED** at regulation level; the guide only speaks of "ürün karekodu" `[S5]` |

Design consequence: Servora must not assume "one barcode = one unit". The market-release barcode carries an integer multiplier, and the same physical carton can represent N tracked units.

### 1.4 Deadlines — what is actually written

| Event | Rule | Source |
| --- | --- | --- |
| Production notification | within **120 days** of production (from 31.3.2023) | `[S8]` (FAQ + ÜTSG-2023/2 announcement) |
| Accepting a pending verme (alma) | **no time limit** — "askıdaki tekil ürünlerin alma bildirimi için süre sınırı yoktur" | `[S9]` |
| Verme / ihracat / imha / iade | no day-count found in the guide's articles or in the sales regulation | `[S5]`, `[S4]` — **UNVERIFIED absence** |
| Fixing an inspection finding (incl. missing tekil bildirim) | **15 days**, then 15-day suspension | `[S4]` Ek-2 item 4 |
| Traceability records (lot/serial, previous+next operator) | kept **at least 10 years** from placing on the market | `[S4 m.31/3]` |
| Other documents | **5 years** | `[S4 m.8/6]` |
| Personnel change notification to the provincial directorate | **5 business days** | `[S4 m.8/7]` |
| Query freshness | "Ayrıntılı Sorgula" results **exclude the last hour** | `[S5 m.30/4]` |

The last row matters more than it looks: any reconciliation that reads ÜTS as a balance is up to one hour stale, so a "compare Servora vs ÜTS" feature must tolerate an in-flight window rather than flag every recent movement as a discrepancy.

### 1.5 Scope: are dental consumables and dental devices in?

- Dental devices that are medical devices under the Tıbbi Cihaz Yönetmeliği are in scope of both registration and (where TİTCK has started tracking that product) unit-level movement. There is no dental carve-out in the regulation; the ÜTS user list explicitly includes **diş protez laboratuvarları** `[S8]`.
- Unit-level tracking is **per product**, switched on by TİTCK's tracking decision, not by risk class alone. The roll-out history — optical 11.9.2017, AIMD 2.7.2018, class III 1.10.2018, test strips/pen needles 1.2.2019, remaining devices 1.3.2019 — is in `[S10]`; the per-product flag is `takipDurumu` (Takip Ediliyor / Takip Edilmiyor) and the mode is lot/serial `[S5 m.5]`.
- **Custom-made devices** (ısmarlama protez: crowns, dentures) are the practical exception: EUDAMED excludes custom-made from the UDI/Device module `[S19]`, and a dental-sector secondary source states that custom-made prostheses carry no standard ÜTS unit-level notification `[S30]`. **UNVERIFIED for Turkey** — see §9.
- **Dental medicines are not ÜTS items.** Local anaesthetic cartridges, for example, are medicinal products tracked through the pharmaceutical system (İTS), not ÜTS. I did not verify the İTS article set; treat as **UNVERIFIED** and confirm before building any "one identifier for everything" assumption.
- **Non-device consumables** (gloves that are not marketed as medical devices, sundries, lab consumables that are not devices) have no ÜTS obligation. A dental distributor's catalogue is therefore a **mix** of ÜTS-tracked devices, untracked devices, and non-device goods. The warehouse must support stock items that have no ÜTS identity at all.

### 1.6 Integration surface

| Channel | What exists | Evidence |
| --- | --- | --- |
| Named web services for hospital systems (HBYS) | Verme, verme iptal, alma, kullanım (+iptal), geçici kullanıma verme (+iptal), kullanımdan alma (+iptal), HEK/Zayiat (+iptal), geri çekme verme/alma, imha/bertaraf (+iptal), hastanın vücudundan çıkarma, **ödünç verme/alma/geri verme/geri alma** | `[S7]` |
| Authentication | system user token issued by the firm's e-signature holder under "Kullanıcı › Sistem Kullanıcısı Tanımlama İşlemleri"; test vs production tokens are separate; allowed-IP restriction; test host `utstest.saglik.gov.tr` | `[S11]` (secondary) |
| Bulk channel | Excel template upload with unchanged columns | `[S5 m.29]` |
| Query channel | "Bildirim Sorgula" / "Tekil Ürün Sorgula"; full unit export emailed within the day | `[S5 m.30]` |
| Third-party integrators | a market of vendors selling ÜTS integration (e.g. product-data push, verme/alma automation, expiry warnings) | `[S11]` |

So: **an official machine interface for software vendors exists**, but it is documented for hospital systems and its public technical contract (WSDL/OpenAPI, rate limits, error codes) was not obtained in this research. Treat "we can integrate in a sprint" as **UNVERIFIED**.

One vendor description worth stealing conceptually: on timeout the integration must **not** resend automatically, because a duplicate verme is a real business event; it marks the row "sonucu belirsiz", re-reads pending items, and only then decides `[S11]`. That is exactly the idempotency shape ARC-001 already asks for.

### 1.7 Penalties and enforcement

| Mechanism | Detail | Source |
| --- | --- | --- |
| Inspection finding "are tekil bildirimler done?" | warn + **15 days** to fix; if not fixed, **15-day temporary suspension of sales activity** (form item 4; the PDF's 4-column form extracts out of order — see §9) | `[S4]` Ek-2, item 4 |
| Selling devices not in the register | prohibited | `[S4 m.26/2]` |
| Unsafe/non-compliant device on the market | stop sale immediately, return to manufacturer/importer, share records with TİTCK | `[S4 m.31/2]` |
| False information / repeated improper use of TİTCK systems | access to the register can be restricted; training certificates revoked | `[S4 m.28/A]` |
| General technical-regulation fines (7223) | the framework law exists, but I did not verify a specific ÜTS fine article | **UNVERIFIED** |

The realistic commercial risk for a dental distributor is therefore not a fine line item — it is **suspension of sales activity**, which is why "did the ÜTS notification happen?" belongs in the operational checklist, not in a compliance appendix.

---

## 2. EU MDR UDI and EUDAMED — brief relevance for Turkey

| Fact | Detail | Source |
| --- | --- | --- |
| Turkish regulation is MDR-aligned | Tıbbi Cihaz Yönetmeliği is the national transposition of (EU) 2017/745, RG 2.6.2021/31499 Mükerrer | `[S1]`, `[S3]` |
| EUDAMED is not optional in the text | Art. 33 requires data entry into EUDAMED without prejudice to ÜTS duties in Art. 34 | `[S1]`, `[S2]` |
| EUDAMED went mandatory | four modules (Actor, UDI/Device, Notified Bodies & Certificates, Market Surveillance) mandatory from **28 May 2026**, six months after the 27.11.2025 OJEU notice | `[S18]` |
| Legacy devices | devices placed on the market before 28.5.2026 have until **27 November 2026** to be registered; devices placed after must be registered **before** placing | `[S19]` |
| Custom-made | excluded from the UDI/Device module | `[S19]` |
| UDI structure | UDI-DI (device identifier) + UDI-PI (production identifiers: lot/batch, serial, expiry, manufacturing date) | `[S1]`, `[S18]` |

**Relevance for Servora-Med:** Turkey's own unit identity (`[S5 m.4]`) already carries the same four production identifiers as UDI-PI. A warehouse lot/serial model that stores *product number, lot, serial, production date, expiry date* satisfies both regimes and needs no second schema. Conversely, a design that stores only "lot + expiry" would be insufficient for the EU side of a manufacturer's business. No EUDAMED integration is proposed; the point is schema-compatibility.

---

## 3. Dispatch documents — e-İrsaliye, sevk irsaliyesi, taşıma irsaliyesi

### 3.1 The four documents people confuse

| Document | Issued by | Legal basis | Purpose |
| --- | --- | --- | --- |
| **Sevk irsaliyesi** | the seller/dispatcher — or the buyer when the buyer transports goods already delivered | VUK m.230/5 `[S13]` | accompanies the physical movement of goods; must be carried in the vehicle `[S13]` |
| **e-İrsaliye** | same as above, electronically | VUK GT 509 §IV.3 `[S14]` | the same document, not a new type; identical legal nature `[S14 §IV.3.1]` |
| **Taşıma irsaliyesi** | the paid carrier | VUK m.240 `[S17]`, `[S16]` | documents the carrier's transport service; does **not** replace sevk irsaliyesi `[S16]`, `[S17]` |
| **Fatura** | the seller | VUK m.229-231 `[S13]` | the sale; carries the dispatch-note number and delivery date `[S13]` |

### 3.2 What the law actually says for vehicle stock

VUK m.230/5 (quoted): the seller must issue a sevk irsaliyesi and **carry it in the vehicle** when the seller transports the goods to the buyer; when the buyer transports goods already delivered, the **buyer** issues it. It then adds two clauses that matter far more for depot/vehicle work:

> "Malın, bir mükellefin **birden çok iş yerleri ile şubeleri arasında** taşındığı veya **satılmak üzere bir komisyoncu veya diğer bir aracıya gönderildiği** hallerde de, malın gönderen tarafından sevk irsaliyesine bağlanması gereklidir." `[S13]`

Read together with e-İrsaliye mechanics:

- **Internal transfers are not document-free.** Moving goods from the central depot to a branch/other workplace requires a dispatch note. A vendor practitioner source states the same for warehouse-to-warehouse moves and adds that e-İrsaliye users must issue it as e-İrsaliye `[S33]`.
- **Stock sent out for someone else to sell is covered** by the "komisyoncu veya diğer bir aracıya" clause `[S13]` — the closest statutory analogue to consignment stock placed at a clinic.
- **Timing is strict:** the e-İrsaliye is issued and transmitted **before** the actual dispatch `[S15]`, `[S16]`; the document must carry the actual dispatch date and time to the minute `[S14 §IV.3.3(d)]`. The seven-day invoice window does not apply to it `[S15]`.
- **In the vehicle:** a paper copy or an electronic display must be available during transport `[S16]` (secondary); no wet signature or stamp is required.
- **Mandatory e-İrsaliye population:** e-Fatura taxpayers whose gross sales exceed the turnover thresholds in GT 509 §IV.3.5 (currently the 10 million TL band for 2021+ periods, transition from the 7th month of the following year), plus sector-specific groups; GİB may also impose it by written notice `[S14]`. A dental distributor of any size is effectively inside this once it is an e-Fatura user above the threshold.

### 3.3 "Araçtan satış" — what is documented, what is not

What can be said factually:

1. Goods leaving the depot in a company vehicle are a physical movement of the taxpayer's goods; the statutory document set is sevk irsaliyesi (or e-İrsaliye) `[S13]`, `[S14]`.
2. If the goods are loaded for **sale from the vehicle**, the sale itself is invoiced at the customer, and the invoice must reference the dispatch note and delivery date `[S13]`. The dispatch note is what makes the goods legitimate while they are still unsold in the vehicle.
3. The regulation has **no concept of "vehicle stock"**. It regulates documents that accompany goods, not inventories. Nothing in VUK says a vehicle is a "workplace" (işyeri); whether a specific loading pattern counts as a transfer between workplaces, as a consignment to an agent, or as goods held for sale at the customer's premises is an interpretation question.

**Therefore:** the statement "loading a rep's car always requires a sevk irsaliyesi naming the vehicle" is a **practical convention supported by the internal-transfer and agent clauses, not an explicit statutory sentence**. It must be confirmed by a mali müşavir for the actual operating model (§8 Q4). Do not encode it as an unquestionable rule in product copy.

Equally important: **a dispatch note is not a stock record.** It proves movement; it does not create a balance. Servora may store the dispatch-note number as a reference on a stock transfer, but must not treat "irsaliye issued" as "stock moved" or vice versa.

### 3.4 Penalty exposure (flagged, not asserted)

Failure to issue or carry the required dispatch document falls under the VUK special-irregularity penalty regime (VUK m.353). The exact clause was **not** read for this document → **UNVERIFIED**; confirm with the accountant.

---

## 4. Industry practice: depot + vehicle stock in Turkish medical/dental distribution

### 4.1 The operating pattern (consistent across independent vendors)

| Practice | How it is described | Source |
| --- | --- | --- |
| **Vehicle = a depot** | "Her araç ayrı bir depo"; vehicle mapped to an ERP warehouse code | `[S20]`, `[S23]`, `[S27]` |
| **Two-step transfer** | depot issues a shipment; the vehicle/recipient presses "Teslim Al"; stock only then belongs to the vehicle. In-transit stock is visible | `[S28]`, `[S25]` ("yoldaki stoklar"), `[S21]` |
| **Morning load with barcode check** | loading screen separate from unloading screen; scanned quantities | `[S20]`, `[S28]` |
| **Sell from vehicle, document at the customer** | invoice/dispatch issued on the phone; Bluetooth receipt printer; e-Arşiv immediately or at day end; works offline | `[S20]`, `[S28]` |
| **FEFO** | nearest-expiry lot proposed at issue; expired stock cannot be sold, loaded to a vehicle, or sent to a branch | `[S20]`, `[S32]` |
| **End-of-day count + variance → personal liability (zimmet)** | counted vs expected compared per vehicle; difference posted to the employee's account and approved by a manager | `[S20]`, `[S21]` |
| **Returns** | customer returns re-enter vehicle stock; sound vs damaged separated; end-of-day unload back to depot | `[S20]`, `[S28]` |
| **Consignment** | a distinct depot type that preserves ownership ("fason/konsinye depo … mülkiyet farkını koruyarak") | `[S26]` |
| **Reservation / blocking** | "bloke + termin": reserved quantities excluded from free stock | `[S27]` |
| **Blind count** | counter does not see the expected quantity; variance approved before correction | `[S32]` |
| **Single source of truth is an explicit choice** | "Stokta söz sahibini seçin: ERP söz sahibiyse araç stoğu düzenli okunan rakamla karşılaştırılır" | `[S20]` |

That last row is worth highlighting: a Turkish field-sales vendor already ships the exact governance choice MOD-001 requires ("the single stock source of truth is set explicitly per deployment") `[C5]`. It is not an invented architecture; it is how this market already talks.

### 4.2 Coverage in the ERP / field-sales tools named in the brief

| Product | Vehicle depot | Lot/serial/expiry | Transfer two-step | Consignment | Reservation | Evidence quality |
| --- | --- | --- | --- | --- | --- | --- |
| **Logo** (GO/Tiger/Netsis 3) | Plasiyer Takibi + Logo Mobile Sales; vehicle stock via warehouse mapping | Seri/Lot Takibi, şube support | via DEYS / WMS modules | not advertised on these pages | — | vendor brochure `[S22]`, vendor marketplace `[S31]` |
| **Mikro** | "merkez, şube ve **araç depoları**" in the depot/barcode module | seri + parti (lot) | transfer fişleri | — | — | solution-partner page (secondary) `[S23]` |
| **Netsis / Logo Netsis** | same as Logo family (Plasiyer Takibi; Mobile Sales; branch support) | Seri/Lot Takibi | shipment + receipt | — | — | vendor brochure `[S22]` |
| **Paraşüt** | multi-warehouse + warehouse transfer + "depolar arası transfer (yeni)" | **not advertised** on the stock page (no lot/expiry) | transfer fişi/irsaliye | — | critical-stock warnings only | vendor page `[S24]` |
| **Nebim V3** | multi-warehouse with min/max per depot, transfer request→approve→ship→receive | not on this page | **yes**, incl. in-transit stock | — | — | vendor page `[S25]` |
| **ETA (V.11)** | multi-warehouse, per-depot access rights | not on this page | transfer irsaliyesi + approval | **yes — dedicated konsinye depot type** | — | vendor/partner site `[S26]` (domain ownership UNVERIFIED) |
| **AKINSOFT Wolvox** | multi-warehouse, location/rack | seri no, lot + SKT | transfer | — | **bloke + termin** | dealer page (secondary) `[S27]` |
| **Field-sales apps** (Mobilteg, Etibas, Datkor, NetEsnaf, sipnik, Giza) | vehicle = depot, load/unload, day-end count | FEFO in the stronger ones | yes | no | partial | vendor pages `[S20]`, `[S21]`, `[S28]`, `[S32]` |

Reading of the table: **general ERPs cover warehouse mechanics well but rarely advertise the vehicle/consignment/expiry combination that medical distribution needs**; field-sales apps cover the vehicle day but are thin on lot/expiry and weak on consignment; ÜTS integration is sold as a separate niche product `[S11]`. A dental distributor therefore typically runs **2–4 systems** (ERP + field sales + ÜTS integration + spreadsheets for consignment reconciliation). That system count is the real market gap Servora can address — not "another ERP".

---

## 5. What the code does today (verified)

| Fact | Evidence |
| --- | --- |
| Product is informational: name, sku, brand, category, model, unit, referencePrice. No barcode, no lot, no expiry, no stock. | `[C1]`, `[C6]` |
| The delivery line **already** has `lot_no`, `serial_no`, `expiry_date` and a `delivery_purpose` enum containing `CONSIGNMENT` and `RETURN`. | `[C2]`, `[C3]`, `[C4]` |
| Those columns are read and written by the repository and exposed on `DeliveryItem` in both server and web types. | `[C8]`, `[C9]`, `[C10]` |
| There is no web form that collects lot/serial/expiry: only the API type carries them (one file references `lotNo` under `web/src`). | `grep -rln lotNo web/src` → 1 file (`web/src/jobs/jobs-api.ts`) |
| There are **no** stock, depot, warehouse, balance or movement tables in any migration. | `grep -rln "stock\|depot\|warehouse" server/src/db/migrations/*.sql` → no match |
| Delivery quantity is a **whole integer** 1–999999999; "a future measured-goods sector (ml, mg, litre) needs a new accepted decision". | `[C7]` |

So the current state is precisely "**delivery lines record traceability attributes, but nothing owns a quantity**". A `CONSIGNMENT` delivery today records that a consignment happened; it does not say how much is still sitting at that clinic. That gap is what the Warehouse module fills — and it is also the argument for not extending `job_card_delivery_items` into a pseudo-balance table.

---

## 6. What accepted decisions say (not proposals)

| Decision | Relevant content | Evidence |
| --- | --- | --- |
| **MOD-001** | Core never produces stock balances. A future Warehouse owns "depots and vehicle stock, physical quantities, reservations where needed, stock in/out movements, transfers, returns and corrections, lot/serial/expiry, and the link between stock movements and their source operation". The same quantity must not be authoritative in two systems; **the single source of truth is set explicitly per deployment/integration mode**. No tables now. | `[C5]` |
| **DOM-004** | Catalog stays informational; "inventory, warehouse, barcode, costing, currency, price-history, invoice, and accounting behaviour require a later separately approved design" | `[C6]` |
| **DELIVERY-QTY-001** | whole-integer delivery quantities; measured goods need a new decision | `[C7]` |
| **Architecture research §5 step 5** | Warehouse is the first new module: registry-managed from day one, narrow contracts (data ownership, organization-scoped read ports, own migration, in-transaction idempotency + audit, offboarding/deletion of user references, restore validation) | `[C11]` |

Nothing above has been extended by this document. The tables in §7 are **proposals**.

---

## 7. Implications for Servora-Med (proposal)

Legend for "Owner": **WH** = Servora Warehouse module; **CORE** = core (JobCard/catalog/customer); **EXT** = external ERP / e-integrator / ÜTS; **OUT** = deliberately out of scope.

| # | Requirement | Source | Mandatory / optional | Owner | V1 or later |
| --- | --- | --- | --- | --- | --- |
| 1 | Depot master with types: central, branch, **vehicle**, **consignment location**, quarantine | MOD-001 `[C5]`; practice `[S20]`, `[S26]` | Mandatory | WH | **V1** |
| 2 | Vehicle depot bound to a custodian (staff) and a plate/label | practice `[S20]`, `[S21]` | Mandatory if vehicle stock used | WH | **V1** |
| 3 | Stock item per (product, depot, lot, serial, expiry) with quantity | ÜTS `[S5 m.5]`; MOD-001 `[C5]` | Mandatory for device stock | WH | **V1** |
| 4 | Transfer with explicit **dispatch** and **receive** steps (in-transit visible) | `[S25]`, `[S28]`, `[S21]` | Recommended (V1 may collapse to one step with an optional receive) | WH | **V1** (receive step can be V1.1) |
| 5 | Expiry policy: block issue/sale/transfer at expiry; warn ahead | `[S5 m.27]`, `[S5 m.21/3]`; practice `[S32]` | Mandatory | WH | **V1** |
| 6 | FEFO ordering on issue | practice `[S20]`, `[S32]` | Optional (default suggestion) | WH | **V1** |
| 7 | Consignment stock at a clinic stays owned by the organization until consumed | `[S6]`; `[S26]`; `[C3]` | Mandatory if consignment is used | WH | **V1** |
| 8 | Consignment return as a reverse movement, not a negative issue | ÜTS has no B2B "iade" type `[S6]`, `[S9]` | Mandatory | WH | **V1** |
| 9 | Return reasons: customer return, rep return, supplier return, damaged, expired, recall | `[S5 m.15/3, m.21/3]`; practice `[S28]` | Mandatory | WH | **V1** |
| 10 | Correction command with a reason set aligned to ÜTS (HEK/Zayiat codes, imha reasons) | `[S5 m.15/3, m.21/3]` | Mandatory | WH | **V1** |
| 11 | Movement rows link to their source operation (delivery, later sale/invoice) | MOD-001 `[C5]` | Mandatory | WH | **V1** |
| 12 | Idempotent command + audit in the same transaction; repeated command creates no second movement | AGENTS §7, ARC-001; `[C11]` | Mandatory | WH | **V1** |
| 13 | Organization-scoped read port (no cross-module table reads) | `[C11]` | Mandatory | WH | **V1** |
| 14 | Vehicle end-of-day count with variance and an approval step | practice `[S20]`, `[S21]` | Recommended | WH | **V1** (count) / later (zimmet accounting) |
| 15 | ÜTS identity fields on the stock item: product number, tracking mode, pack multiplier, lot/serial, dates | `[S5 m.4-5, m.28]` | Mandatory when the installation handles ÜTS-tracked devices | WH (fields) | **V1** |
| 16 | ÜTS notification status per outbound movement (not sent / sent / accepted / rejected / uncertain) | `[S5 m.9-10]`, `[S11]` | Optional | WH (state) + EXT (transport) | later |
| 17 | ÜTS API client with no automatic retry on timeout ("sonucu belirsiz") | `[S11]` | Optional | EXT | later |
| 18 | 10-year retention of lot/serial + previous/next operator records | `[S4 m.31/3]` | Mandatory (retention), satisfied by keeping movements append-only | WH | **V1** (append-only) |
| 19 | Opening balance at go-live, with an optional ÜTS "stok bildirimi" step | `[S6]` | Mandatory (opening balance); the ÜTS step is manual | WH + EXT | **V1** (manual) |
| 20 | Dispatch-note number stored on outward transfers; e-İrsaliye **not** generated | VUK `[S13]`, `[S14]`; MOD-001 accounting boundary `[C5]` | Mandatory (reference); generation OUT | WH (field) / EXT (document) | **V1** (field) |
| 21 | Invoice, price, VAT, cost, margin | MOD-001 `[C5]`, DOM-004 `[C6]` | Out of scope | EXT / Accounting module | never in WH |
| 22 | Reservation for a JobCard/sale | MOD-001 "reservations where needed" `[C5]` | Optional | WH | later |
| 23 | Multi-unit-of-measure (koli ↔ iç adet) driven by pack multiplier | `[S5 m.28]`; practice `[S27]` | Optional | WH | later |
| 24 | Fractional quantities (ml/mg) | `[C7]` requires a new decision | Decision needed | CORE + WH | open (§8 Q1) |
| 25 | Blind count | practice `[S32]` | Optional | WH | later |
| 26 | Vehicle replenishment suggestion | practice `[S20]` explicitly does not do it | Optional | WH | later |

Two design consequences that follow from the table and deserve to be written down before any schema work:

- **Do not put balances on `job_card_delivery_items`.** Those rows are delivery *events* with traceability attributes `[C2-C4]`; giving them a "remaining quantity" column would create the second authoritative quantity MOD-001 forbids `[C5]`.
- **The movement table is the product.** ÜTS's own semantics (pending transfer, irreversible accept, no B2B return type, stock correction as a reasoned event) map one-to-one onto a movement ledger with states. Every requirement above is a projection of that ledger.

---

## 8. Open questions for the owner

Each question lists the real options and my recommendation. None of these is decided by this document.

1. **Quantity domain for stock.** Whole integers only (consistent with DELIVERY-QTY-001 `[C7]`), or measured quantities from day one?
   - (a) integers only; (b) integers + per-item decimal for measured goods; (c) decimal everywhere.
   - **Recommend (a).** It matches the accepted decision, keeps the ledger auditable and avoids a unit-conversion layer. Revisit only with a measured-goods decision record.

2. **Where do lot/serial/expiry live once Warehouse exists?** They already exist on the delivery line `[C4]`.
   - (a) Warehouse owns lots; the delivery line keeps its historical snapshot, written from the warehouse movement; (b) keep both writable; (c) move them out of the delivery line.
   - **Recommend (a).** Historical snapshots stay immutable, but only one component *computes* available quantity — the same rule MOD-001 already states for quantities `[C5]`.

3. **Vehicle stock: depot type or separate entity?**
   - (a) depot row with `type = VEHICLE` + custodian; (b) separate `vehicles` table with its own stock; (c) no vehicle concept in V1.
   - **Recommend (a).** It gives one balance model, one movement table, one report; the market already treats a vehicle as a warehouse `[S20]`, `[S23]`.

4. **Is a dispatch note mandatory for every vehicle load?** *(requires accountant)*
   - (a) always require a document reference on depot→vehicle transfer; (b) make it optional with a warning; (c) not modelled.
   - **Recommend (a) as a *field*, (b) as *enforcement*.** VUK m.230/5 clearly covers branch transfers and goods sent to an agent `[S13]`, but it does not name a vehicle. Store the reference, warn when empty, and let the accountant's written position decide whether it becomes blocking.

5. **Does ÜTS require any notification for depot→vehicle or depot→branch moves?**
   - (a) No, because ownership does not change; (b) yes, via verme/alma.
   - **Recommend (a)**, based on `[S5 m.9/1-2]` and `[S9]`, but treat it as an inference to be confirmed with a ÜTS consultant before it appears in customer-facing documentation. If wrong, the entire vehicle model needs a ÜTS step and that is a large difference.

6. **ÜTS integration in V1?**
   - (a) fields + manual status only; (b) full verme/alma automation; (c) nothing.
   - **Recommend (a).** The public technical contract was not obtainable in this research, the alma step is irreversible `[S5 m.10/4]`, and errors are operationally expensive. V1 stores identity and status; automation comes after a real integration spike.

7. **Consignment ownership model.**
   - (a) consignment *location* (customer-linked depot) with organization-owned quantity; (b) ownership flag on the lot; (c) treat consignment as a sale.
   - **Recommend (a).** It matches ÜTS's konsinye description `[S6]` and the market's "konsinye depo" `[S26]`, and (c) would contradict the delivery-purpose semantics in `[C3]`.

8. **Do we model in-transit stock in V1?**
   - (a) yes, two-step transfer; (b) single-step transfer, add receipt later.
   - **Recommend (b) for V1**, with the state column present from the start so (a) is a UI change, not a migration. Two-step is the market norm `[S25]`, `[S28]`, but it doubles the command surface on day one.

9. **Returns: reuse `delivery_purpose = RETURN` as the source operation?**
   - (a) yes, link the return movement to that delivery record; (b) separate return document.
   - **Recommend (a).** It is already an accepted enum value `[C3]` and keeps one history.

10. **Who may correct stock?**
    - (a) Manager/Admin only, with reason + audit; (b) any staff with a reason; (c) staff, plus a four-eyes approval over a threshold.
    - **Recommend (a) for V1, (c) later.** ÜTS treats a stock correction as a reportable event `[S5 m.15/3]`; it should never be a casual action.

---

## 9. Unverified / gaps

1. **No statutory day-count for verme/alma** was found. Absence of evidence, not evidence of absence: a TİTCK announcement may impose one outside the guide `[S5]`.
2. **ÜTS web-service technical contract** (endpoints, WSDL/OpenAPI, auth details, rate limits, error taxonomy) — only the service *names* `[S7]` and vendor descriptions `[S11]` were obtained.
3. **7223 sayılı Kanun** administrative-fine article for ÜTS breaches — not read; the enforcement path documented here is the sales-centre inspection sanction `[S4]` Ek-2.
4. **Ek-2 sanction mapping is OCR-ambiguous.** The inspection-form PDF is a 4-column table whose text extracts out of order, so which penalty attaches to which row is read from layout, not from a clean sentence. The "15-day cure → 15-day suspension" pair for missing tekil bildirim is also asserted by a secondary source, which is why it is stated with that caveat.
5. **2026 amendments to the sales regulation** (latest listed: 3.7.2026/33299 `[S4a]`) — the consolidated PDF `[S4]` was retrieved but the 2026 amendment text was not diffed; any new stock/record obligation introduced in 2026 may be missing here.
6. **TCKKD-KLVZ-03 (13.05.2026)** replaces the *registration* guide `[S12]`; it was not fully read, and it does not appear to replace the movement guide `[S5]`, but that should be confirmed.
7. **Custom-made dental prostheses** (crowns/dentures) and unit-level notification: EUDAMED excludes custom-made `[S19]`; the Turkish "no tekil bildirim" claim rests on a dental-sector secondary source only. **UNVERIFIED.**
8. **Dental medicines** (anaesthetics, etc.) and their İTS obligations — out of scope here, not verified.
9. **Whether a vehicle counts as an "işyeri"** under VUK m.230/5, and therefore whether the internal-transfer clause applies to a rep's car. Interpretation question for a mali müşavir.
10. **VUK m.353** special-irregularity clause for dispatch documents — not read.
11. **Barcode formats in ÜTS product registration** (GTIN/HIBC) — vendor claim only; not found in a primary text.
12. **`[S32]` and `[S33]` are vendor pages, not standards.** They describe market practice ("expired cannot be sold/loaded", "internal transfers need a dispatch note"); they are cited as practice evidence, not as law.
13. **No interview evidence.** Everything about daily practice comes from vendor documentation, not from observed distributor operations. A single site visit would change the priority order in §7 more than any additional web source.
