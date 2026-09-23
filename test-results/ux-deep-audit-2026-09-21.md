> **Historical audit artifact — 2026-09-21**
>
> This document preserves UX observations and measurements recorded on
> 2026-09-21. It is historical evidence, not the current normative design
> contract and not a statement that every finding remains open.
>
> Current normative behavior is defined by `DESIGN.md`. Later accepted shell
> decisions and implementation evidence are documented in:
>
> - `test-results/ux-shell-design-decisions-2026-09-21.md`
> - `test-results/ux-jobs-control-surface-audit-2026-09-21.md`
>
> The audit artifact does not record its exact source commit. Some screenshots
> and temporary evidence were session-local and are not reconstructed here.
> The historical audit body below is intentionally preserved unchanged.

# Servora-Med — UI/UX Deep System Audit (2. Tur)

Tarih: 2026-09-21 · Durum: **araştırma/rapor** — kod değiştirilmedi, migration çalıştırılmadı,
production'a bağlanılmadı, DESIGN.md değiştirilmedi.

Önceki rapor: `test-results/ux-audit-2026-09-21.md` (navigasyon/orientation/shell).
Bu rapor onun yerine geçmez; onu doğrular ve görsel sistem + responsive + data-viz katmanını ekler.

## Yöntem ve ortam

- Yerel: Fastify `:3000` + Vite `:5173`, geçici DB `servora_med_uxaudit`
  (migration head `050`, dev seed). Zorlanan veri: 6 müşteri (biri çok uzun adlı),
  6 ürün, 16 JobCard (7 durum, geciken/iptal/düzeltme dahil), 2 onaylı teslim kalemi.
- Araç: Chromium (playwright MCP), **WebKit 26 + Firefox 141 (playwright MCP dışı, yerel
  `playwright` paketi; storageState Chromium'dan aktarıldı)**, DOM/computed-style ölçüm
  betikleri, ekran görüntüleri.
- Kapsam: 8 viewport (320/360/390/430/768/1024/1280/1440) × 8 rota davranış matrisi;
  18 rota page-header envanteri; marka ölçümleri; kontrast hesapları; klavye focus
  geçişi; reduced-motion; 200% reflow; modal/drawer/form ölçümleri.
- `impeccable` launcher bu repoda mevcut olmadığı için bağlam **doğrudan** okundu:
  DESIGN.md, PRODUCT.md, `servora-visual-tokens.ts`, `servora-ant-theme.ts`, `styles.css`.

### Sınırlamalar (dürüstlük notu)

- Gerçek ekran okuyucu geçişi (VoiceOver) yapılmadı; semantik/landmark/focus düzeyinde kalındı.
- iOS Safari donanım testi yok; WebKit masaüstü motoru kullanıldı (compositing sinyali güçlü
  ama birebir iOS değil).
- İlk WebKit/Firefox denemesinde görünen CORS/401 hataları, oturumsuz (giriş yapılmamış)
  durumun sonucuydu; oturum aktarıldıktan sonra **yeniden üretilemedi** — uygulama hatası
  olarak raporlanmadı.

## Genel yargı

Uygulama, "sayfalar birbirinden kopmuş" değil; **token disiplini ve kontrast tarafı güçlü**,
formlar/modallar tutarlı ve responsive taşma yok. Ancak ürün **tek bir header/dashboard
sistemine sahip değil**: sayfa başlığı sözleşmesi route bazında elle kurulmuş, dashboard'ın
trend grafiği sessizce görünmez durumda, logo standartı yok ve birkaç token/selector
kayması var. Yani "modern dashboard/business application" hissi mimaride var, fakat
**composition katmanı (page header + dashboard + logo) standardize edilmemiş**.

---

## A. RESPONSIVE / VIEWPORT

### RESP-01 — Mobil üst bar başlığı 320px'te "İ..." / "Ge..." olarak kırpılıyor
- **Severity:** P1
- **Routes:** Tüm list/bölüm sayfaları (ölçüm: `/jobs`, `/overview`; başlık bileşeni ortak)
- **Yüzey:** Mobile
- **Tarayıcı:** Chromium (WebKit/Firefox aynı DOM/CSS)
- **Gözlem:** 320×568'de `.mobile-shell-title` genişliği 30px; "İşler" metni `scrollWidth=36`
  → `text-overflow: ellipsis` ile "İ…", "Genel Bakış" → "Ge…" görünüyor. Başlık, logonun,
  (varsa) Geri bağlantısının, bildirim ve Menü butonlarının arasında eziliyor.
- **Beklenen:** Kısalmadan okunabilir bölüm kimliği; DESIGN.md 304 "section title from one
  route-metadata source" — başlık birincil kimlik taşıyıcısıdır, 2 karaktere düşemez.
- **Kanıt:** `deep-320-jobs.png` ("İ..."), `deep-320-overview.png` ("Ge..."); ölçüm:
  `{ text: 'İşler', w: 30, scrollW: 36, overflow: 'ellipsis', clipped: true }`.
- **Muhtemel kaynak:** `styles.css` `.mobile-top-bar-start/.mobile-shell-title` esnek düzen;
  başlığa min genişlik/öncelik verilmemiş (`MobileTopBar.tsx` tek satır kompozisyon).
- **Öneri:** ≤360px'te (a) markayı mobil üst bardan çıkar ya da küçült, (b) başlığa
  `min-width` + `flex: 1` önceliği ver, (c) taşma durumunda satır kırma yerine başlığı
  tam gösterip aksiyonları Menü'ye taşı. Karar DESIGN.md'de "mobil üst bar öncelik sırası"
  olarak yazılmalı.

### RESP-02 — KPI ızgarası 320px'te 2 sütunda sıkışıyor, dokunma hedefleri 24px altında
- **Severity:** P2
- **Routes:** `/overview`
- **Yüzey:** Mobile (320–430)
- **Tarayıcı:** Chromium
- **Gözlem:** `.overview-kpis` 320px'te `grid-template-columns: 128.5px 128.5px` (2 sütun,
  hücre 129px); KPI etiketleri 2 satıra kırılıyor; KPI **değer linkleri** 13×33 / 16×33 /
  17×33 / 26×33 px — 24×24 (WCAG 2.5.8) ve 44×44 (PRODUCT.md) hedeflerinin altında.
- **Beklenen:** Küçük ekranda ya tek sütun ya da genişliği koruyan 2 sütun + tüm kartın
  tıklanabilir olması; değer linki yerine kart hedefi.
- **Kanıt:** Sweep 320/360/390 çıktısı (`smallSamples: "11 26x33", "0 17x33", "2 16x33", "1 13x33"`),
  `deep-320-overview.png`, computed `grid-template-columns`.
- **Muhtemel kaynak:** `styles.css:3421 .overview-kpis` + `styles.css:3769` dar ekran kuralı;
  `MetricStatistic` yalnızca değeri `<a>` yapıyor (`OverviewPage.tsx:97-107`).
- **Öneri:** KPI kartını tek hedef yap (tüm kart link), mobilde 1 sütun veya `auto-fit`
  `minmax(9rem, 1fr)`; `MetricStatistic` adapter'ına dokunma hedefi sözleşmesi ekle.

### RESP-03 — Liste satırı başlık linkleri mobilde 20–21px yüksekliğinde
- **Severity:** P3
- **Routes:** `/jobs`, `/customers`, `/staff`, `/users`, `/products` (liste görünümleri)
- **Yüzey:** Mobile
- **Tarayıcı:** Chromium + WebKit (aynı ölçüm)
- **Gözlem:** Satır başlığı linkleri `102–209 × 20–21px`; kart gövdesi tıklanabilir değil.
- **Beklenen:** PRODUCT.md: "kart aksiyonları ve mobil navigasyon öğeleri mümkün olduğunca
  en az 44×44"; en azından başlık bloğu (başlık + meta) tek hedef olmalı.
- **Kanıt:** Viewport sweep `smallSamples` ("Depo sayımı 102x21", "Ege Dental Klinik 137x20" …).
- **Muhtemel kaynak:** Liste kartlarında yalnızca `<Link>` başlık sarması (ör. `JobWorkspace`
  satır başlığı, `CustomerList` kart başlığı).
- **Öneri:** Satır/kart seviyesinde tek tıklama hedefi ("stretched link" deseni) veya
  başlık linkine dikey padding; dokunma hedefi minimumu DESIGN.md'ye yazılsın.

### RESP-04 — İkincil kontroller 44px altında: mesaj sekmeleri, takvim okları
- **Severity:** P3
- **Routes:** `/messages` (Aktif/Arşiv: 51×36), `/calendar` (‹/› ay okları: 23×44)
- **Yüzey:** Mobile
- **Tarayıcı:** Chromium (WebKit'te aynı yapı)
- **Gözlem:** Segment ve ikon butonları yükseklik/genişlik olarak 44px eşiğinin altında.
- **Beklenen:** Touch target ≥44×44 (PRODUCT.md) veya en az 24×24 + yeterli boşluk.
- **Kanıt:** Sweep çıktısı (`Aktif 51x36`, `‹ 23x44`), `aria-label="Önceki ay/Sonraki ay"` mevcut.
- **Muhtemel kaynak:** Sınıf bazlı min-height kuralları (`.conversation-view-tab`, antd `Button`).
- **Öneri:** Bu iki bileşene min 44px; ikon butonlarda `min-width: var(--control-height)`.

### RESP-05 — 768px tablet, telefon chrome'u alıyor (karar maddesi)
- **Severity:** P3 (karar gerektiren)
- **Routes:** Tümü (768–1023 arası)
- **Yüzey:** Both
- **Tarayıcı:** Chromium
- **Gözlem:** Kırılım noktası `min-width: 64rem` (1024px). 768×1024'te masaüstü sidebar
  yok; alt navigasyon + sticky "Yeni iş" + mobil üst bar var. Layout bozulmuyor, ancak
  tablet genişliğinde yönetim ekranları telefon düzeninde kalıyor.
- **Beklenen:** DESIGN.md shell kuralı bunu böyle tanımlıyor ("At `{layout.shell-sidebar-min}`
  and above, navigation uses a persistent sidebar"). Yani hata değil; **karar** gerekir:
  saha personeli tablet kullanıyorsa 768–1023 için ara düzen (2 sütun kart + sidebar'sız
  ama bottom-nav'sız) değerlendirilmeli.
- **Kanıt:** `webkit-overview-768.png`, `firefox-overview-768.png`; ölçüm: 768'de
  `bottomNavVisible: true`, `sidebar: false`.
- **Muhtemel kaynak:** `AppShell.tsx` `desktopQuery = '(min-width: 64rem)'`.
- **Öneri:** DESIGN.md'de tablet sınıfı tanımlansın (ör. 768–1023: geniş içerik + üst bar,
  alt navigasyon korunur) veya mevcut davranış "kabul edilmiş" olarak belgelensin.

### RESP-06 — 320px'te jobs hızlı görünüm şeridi düzensiz sarıyor (polish)
- **Severity:** Polish
- **Routes:** `/jobs`
- **Yüzey:** Mobile
- **Gözlem:** "Aktif işler / Takip işleri / Onay kuyruğu / Düzeltme istenenler / Biten işler /
  Geciken" çipleri 2 sütunlu, sağ kenarı düzensiz (ragged) bir örüntüyle sarıyor.
- **Beklenen:** Aynı seviye filtrelerin hizası görsel ritmi korumalı.
- **Kanıt:** `deep-320-jobs.png`.
- **Muhtemel kaynak:** `flex-wrap` + değişken etiket uzunlukları.
- **Öneri:** Yatay kaydırmalı tek şerit (`overflow-x: auto; scroll-snap`) ya da 2 sütun grid.

## B. BRANDING / LOGO

### BRAND-01 — Logo hiçbir shell bölgesinde tıklanabilir değil (audit-1 A1 doğrulandı)
- **Severity:** P2
- **Routes:** Tümü (sidebar, desktop topbar, mobil topbar, çekmece başlığı)
- **Yüzey:** Both · **Tarayıcı:** Chromium + WebKit
- **Gözlem:** `DunyaDentalBrand` `<span class="dunya-dental-brand">` + `<img>` render ediyor;
  üç bölgede de `inLink: false`, `cursor: auto`.
- **Beklenen:** Marka → rolün ana rotası (Genel Bakış / STAFF için ilk uygun rota).
- **Kanıt:** `web/src/shell/DunyaDentalBrand.tsx:14-17`; ölçüm: sidebar/topbar/mobile `inLink:false`.
- **Muhtemel kaynak:** Bileşen her zaman dekoratif üretiliyor; tüketici sarmalama yapmıyor.
- **Öneri:** `DunyaDentalBrand`'e `to?` prop'u ekleyip tek bir `HomeLink` davranışı tanımla;
  hedef rota `navigation-model`'den çözülsün (SSOT).

### BRAND-02 — Aynı marka üç bölgede üç farklı ölçekte ve iki farklı kaynak dosyadan
- **Severity:** P2
- **Routes:** Tümü
- **Yüzey:** Both
- **Gözlem (render ölçümü):**
  | Bölge | Render | Doğal kaynak | Kaynak dosya |
  |---|---|---|---|
  | Desktop sidebar | **235×128 px** (sidebar genişliğini doldurur) | 4538×3210 | `dunya-dental-sidebar.png` |
  | Desktop topbar | 74×52 px | 5673×4012 | `dunya-dental.png` |
  | Mobil topbar | 51×36 px | 5673×4012 | `dunya-dental.png` |
  Aynı ekranda sidebar 128px yüksekliğinde marka varken topbar'da 52px'lik ikinci bir marka var.
- **Beklenen:** Tek marka standardı: tek kaynak varlık, tanımlı min/maks yükseklik ve
  tutarlı yerleşim; aynı ekranda iki farklı marka ölçeği olmaması.
- **Kanıt:** `brandDesktop` / `brandMobile` ölçümleri; `deep-overview-desktop.png`,
  `deep-reports-desktop.png` (sağ üstte küçük topbar markası), `webkit-job-detail.png`.
- **Muhtemel kaynak:** `styles.css:61-75` varyant sınıfları (`--login`, `--sidebar`, `--topbar`)
  ve `DunyaDentalBrand.tsx` kaynak haritası.
- **Öneri:** DESIGN.md'de logo tablosu: `sidebar: h=96px (max-w 12rem)`, `topbar: h=32px`,
  `mobile: h=28px` gibi tek ölçek seti + tek kaynak görsel (kırpılmış tek dosya).

### BRAND-03 — Mobil topbar markası okunamaz ölçekte (51×36)
- **Severity:** P3
- **Routes:** Tümü (mobil)
- **Yüzey:** Mobile
- **Gözlem:** 51×36 px render'da wordmark ("dünya dental" + slogan) okunmuyor; sadece
  bir leke gibi görünüyor (özellikle 320–390px'te başlıkla yarışıyor — bkz. RESP-01).
- **Beklenen:** Ya okunabilir minimum boyut (≥32px yükseklik + yeterli yatay alan) ya da
  mobilde marka yerine kısaltma/monogram stratejisi.
- **Kanıt:** `webkit-job-detail.png`, `deep-320-jobs.png` (sol üst).
- **Öneri:** Mobilde `min-height` + `flex: none` ile korunan alan; gerekirse yalnız marka
  işareti (ikon) kullanımı DESIGN.md'ye yazılsın.

## C. PAGE HEADER / HERO SİSTEMİ

### HDR-01 — Paylaşılan page-header sözleşmesi yok; her rota header'ı elle kuruyor
- **Severity:** P1 (sistemik kök neden)
- **Routes:** 18 rota envanteri (aşağıda)
- **Yüzey:** Both
- **Gözlem:** Aynı seviyedeki sayfalar farklı parçalar kullanıyor:

  | Route | eyebrow | subtitle | görünür H1 | header aksiyonu | tabs | filtre | içerik geri |
  |---|---|---|---|---|---|---|---|
  | /overview | ✓ "Operasyon görünümü" | ✓ dönem | ✗ (desktop'ta gizli) | ✗ | ✗ | ✗ | ✗ |
  | /jobs | ✓ "Çalışma alanı" | ✗ | ✗ | "Yeni iş" (sayfa içi) | ✗ | ✓ | ✗ |
  | /jobs/:id | ✓ tip | ✗ | ✓ kayıt adı | ✗ | ✗ | ✗ | "Listeye dön" |
  | /jobs/new-task | ✓ "Yeni kayıt" | ✓ açıklama | ✓ | ✗ | ✗ | ✗ | ✗ |
  | /customers | ✗ | ✗ | ✗ | "Yeni müşteri" | ✗ | ✓ | ✗ |
  | /customers/:id | ✓ "Müşteri" | ✗ | ✓ | ✗ | ✓ | ✗ | "Müşterilere dön" |
  | /products | ✗ | ✗ | ✗ | sayfa içi | ✗ | ✓ | ✗ |
  | /products/:id | ✓ "Ürün kataloğu" | ✗ | ✓ | ✗ | ✗ | ✗ | **yok** |
  | /reports | ✗ | ✓ | ✓ "Raporlar" | ✗ | ✗ | ✓ | ✗ |
  | /reports/* | ✗ | ✓ "Son yenileme" | ✓ rapor adı | ✗ | ✓ (rapor nav) | ✓ | ✗ |
  | /calendar | ✓ "Aylık planlama" | ✓ | ✗ | "Manuel plan ekle" | ✗ | ✓ | ✗ |
  | /messages | ✗ | ✓ | ✗ | "Yeni konuşma" | ✓ | ✗ | ✗ |
  | /users, /staff | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | **"İşlere dön"** |
  | /settings | ✗ | ✗ | ✗ | kartlar | ✗ | ✗ | ✗ |
  | /settings/* | ✗ | ✗ | ✓ bölüm adı | ✗ | ✓ | ✗ | ✗ |
  | /docs, /help | ✗/✗ | ✓/✗ | ✓ | ✗ | ✗ | ✓/✗ | ✗ |

- **Beklenen:** Tek `PageHeader` bileşeni: `eyebrow | title | description | primaryAction |
  secondaryAction | tabs | filters` slotları; her rota yalnızca hangi slotu dolduracağını seçer.
  Bugün aynı seviye iki liste sayfası (/jobs vs /customers) farklı hiyerarşi üretiyor.
- **Kanıt:** Scripted envanter (`headers` matrisi); `deep-customers-desktop.png` (başlıksız
  içerik) vs `deep-jobs-board.png` (eyebrow + sağda aksiyon) vs `deep-reports-desktop.png`.
- **Muhtemel kaynak:** Her ekran kendi `workspace-heading`/`route-identity-heading`
  kompozisyonunu kuruyor (`ProductList.tsx:84`, `CustomerList.tsx:254`, `JobWorkspace.tsx:179`, …).
- **Öneri:** `ui/PageHeader` ortak bileşeni + route metadata; DESIGN.md'ye "page header
  slot sözleşmesi" bölümü. Bu tek iş, aşağıdaki HDR-02/HDR-03'ü de kapsar.

### HDR-02 — Aynı bölüm adı mobilde iki kez görünüyor, masaüstünde hiç görünmüyor
- **Severity:** P2
- **Routes:** /overview, /jobs, /customers, /products, /users, /staff, /calendar, /messages, /settings
- **Yüzey:** Both (mekanizma farklı)
- **Tarayıcı:** Chromium (+WebKit doğrulandı)
- **Gözlem:** `.route-identity-heading` (h1) **≥64rem'de sr-only** (styles.css:3292-3304);
  <64rem'de görünür. Sonuç: masaüstünde içerikte görünür sayfa başlığı yok (kimlik yalnızca
  üst bardaki küçük metin), mobilde ise üst bar başlığı + görünür h1 **aynı metni** yazıyor
  (ölçüm: `/jobs`: h1Visible=true, topbarText='İşler', dup=true — 4 rotada doğrulandı).
- **Beklenen:** Tek kaynaklı başlık: ya içerik H1 (üst bar yalnızca navigasyon bağlamı),
  ya üst bar başlığı (içerik H1 sr-only). İkisi aynı anda görünür olmamalı (DESIGN.md 304:
  "Avoid a large duplicate visual title in content for the same section name").
- **Kanıt:** h1Map ölçümleri (10 rota, desktop `visible:false`), mobil ölçüm (`dup:true` ×4),
  `deep-customers-desktop.png` (masaüstünde başlık yok), `webkit-messages.png` (mobilde
  üst bar "Mesajlar" + içerikte "Mesajlar" + liste kolonu "Mesajlar" = 3 kez).
- **Muhtemel kaynak:** `styles.css:3292` medya kuralı + `AppShell` topbar başlığı.
- **Öneri:** PageHeader kararının parçası olarak: masaüstünde görünür H1 + breadcrumb,
  mobilde üst bar başlığı ve içerik H1'in **tek tanım** üzerinden üretilmesi (bir kez render).

### HDR-03 — Tarayıcı sekme başlığı rota değişimini yansıtmıyor
- **Severity:** P2
- **Routes:** Tümü (browser mode)
- **Yüzey:** Both
- **Gözlem:** `document.title` her rotada sabit ("Dünya Dental | İş ve Operasyon Yönetimi").
  `resolveDocumentTitle` rota başlığını **yalnız standalone/PWA** modunda kullanıyor.
- **Beklenen:** Sekme kimliği "İşler — Dünya Dental" gibi ayrışmalı; 10 sekme açan yönetici
  hangi sekmenin ne olduğunu görebilmeli (WCAG 2.4.2 ruhu).
- **Kanıt:** `document-title.ts:10-20`; 18 rota taramasında başlık değişmiyor.
- **Öneri:** Tarayıcı modunda da `"{routeTitle} · Dünya Dental"` deseni (ürün kararı);
  PWA davranışı korunur.

### HDR-04 — Overview dönemi kontrol edilemiyor ama ekranda yazıyor
- **Severity:** P3
- **Routes:** `/overview`
- **Gözlem:** Başlık altı "Demo Admin, 2026-09-01 – 2026-09-30 dönemi." sabit cari ay;
  dönem seçici yok. Raporlarda `Bugün/Son 7 gün/Son 30 gün/Bu ay` + tarih aralığı var.
- **Beklenen:** Aynı ürün içinde dönem kavramı tutarlı; dashboard'da en azından hazır aralık
  çipleri (reports ile aynı bileşen) veya "dönemi raporlarda değiştir" bağlantısı.
- **Kanıt:** `overview` snapshot + `deep-reports-desktop.png` (hızlı aralık çipleri).
- **Öneri:** `Segmented`/çip setini `reports`'tan yeniden kullan; tek `range` sözleşmesi.

## D. VISUAL DESIGN SYSTEM / TOKEN DRIFT

### VIS-01 — Overview "Tamamlanma eğilimi" grafiği hiç render edilmiyor (0px)
- **Severity:** P1
- **Routes:** `/overview`
- **Yüzey:** Both · **Tarayıcı:** Üç motorda aynı (DOM/CSS sorunu)
- **Gözlem:** DOM'da 30 günlük `span` çubukları var (`data-report-trend-bars`, `--ratio`
  değerleri doğru) ama **konteyner yüksekliği 0px, çubuklar 0×0 ve şeffaf**. Panel boş görünüyor;
  kullanıcı yalnızca "4 iş tamamlandı; 2 iş iptal edildi." metnini okuyor.
- **Beklenen:** Trend grafiği görünür (raporlarda çalışan aynı `TrendBars` bileşeni).
- **Kanıt:** Ölçüm: `{ h: 0, spans: 30, firstSpanH: 0, firstSpanW: 0, firstSpanBg: 'rgba(0,0,0,0)' }`;
  `deep-overview-desktop.png` (boş panel). Kaynak: `OverviewPage.tsx:114`
  `className="overview-trend"`; `report-charts.tsx:175` varsayılanı `report-trend-bars`;
  `styles.css:465` yalnızca `.report-trend-bars, .completed-trend` için geometri tanımlıyor;
  `styles.css:3458` `.overview-trend` için sadece `margin-block` var.
- **Muhtemel kaynak:** CSS selector drift'i — bileşen `className` override'ı varsayılan sınıfı
  **değiştiriyor**, birleştirmiyor.
- **Öneri:** (a) `TrendBars`'ta `className`'i temel sınıfla birleştir
  (`report-trend-bars ${className}`) — tek satır; (b) regresyon testi: Overview'da trend
  konteynerinin yüksekliği > 0 ve en az bir çubuk yüksekliği ≥ 3px.

### VIS-02 — KPI kartlarında kırık "(" kenarlık artefaktı (border-left + radius)
- **Severity:** P2
- **Routes:** `/overview` (mobil 320/360'ta çok belirgin, masaüstünde de görünür)
- **Yüzey:** Both
- **Gözlem:** `MetricStatistic` varyantları (`--attention|--success|--warning`) yalnızca
  `border-left: 3px solid` alıyor; kart `border-radius: 12px` ve `overflow: visible`.
  Sonuç: komşu KPI hücreleri arasında köşesi kıvrılmış, kopuk "(" şeklinde çizgiler.
- **Beklenen:** Uyarı/başarı vurgusu kart yüzeyiyle uyumlu (ör. tam kenarlık, sol dolgu
  şeridi veya ikon) olmalı; kırık çizgi görünmemeli.
- **Kanıt:** `deep-overview-kpi-zoom.png` (yakın plan); computed:
  `--attention: border-left: 3px solid oklch(0.38 0.09 70); border-radius: 12px`.
- **Muhtemel kaynak:** `styles.css:4507-4524`.
- **Öneri:** Ya `border-left` yerine `box-shadow: inset 3px 0 0` (radius'u takip eder) ya da
  varyantlarda tüm kenarlık + soft arka plan (`--warning-soft`) kullan.

### VIS-03 — Link focus halkası token dışı (OS vurgu rengi) — audit-1 C5 doğrulandı ve kökü netleşti
- **Severity:** P2
- **Routes:** Tümü (`<a>` içeren her yüzey: sidebar, liste başlıkları, metin linkleri)
- **Yüzey:** Both · **Tarayıcı:** Chromium (WebKit'te sistem rengi farklı görünür)
- **Gözlem:** Klavye ile Tab gezinirken **tüm linkler** `rgb(87, 158, 181)` (işletim sistemi
  vurgu rengi) 3px / offset 1px halka alıyor; input, select ve primary butonlar ise token
  rengi `oklch(0.53 0.15 242)` / offset 3px. Aynı ekranda iki farklı focus dili.
- **Beklenen:** Tek focus token'ı (`--focus` + `--focus-width`, offset 3px) tüm etkileşim
  hedeflerinde.
- **Kanıt:** 12 ardışık Tab ölçümü (hepsi `rgb(87,158,181)`, `:focus-visible` eşleşiyor);
  enjekte edilen `!important` probe kuralı (`5px solid red / offset 7px`) uygulandı →
  author kuralları çalışıyor, dolayısıyla token kuralı **bir başka kural tarafından
  eziliyor**; global kural `styles.css:51`.
- **Muhtemel kaynak:** :where()` düşük özgüllüklü bir reset kuralının (`a:focus-visible`
  outline-color/offset) uygulama CSS'inden sonra enjekte edilmesi (Ant reset katmanı adayı;
  bu oturumda kesinleştirilmedi).
- **Öneri:** `styles.css`'e açık kural ekle:
  `a:focus-visible { outline: var(--focus-width) solid var(--focus); outline-offset: 3px; }`
  ve token regresyonuna "tüm etkileşimli öğelerde focus rengi = --focus" kontrolü ekle.

### VIS-04 — Kullanılan ama tanımlanmayan token: `--radius-card`
- **Severity:** P3
- **Routes:** `/overview` (`.overview-section`)
- **Yüzey:** Both
- **Gözlem:** `styles.css:3436` `border-radius: var(--radius-card)` kullanıyor;
  bu değişken repoda **hiç tanımlanmamış** → hesaplanan değer `0px`. Overview panelleri
  köşesiz kalırken uygulamanın geri kalanındaki kartlar 10–12px radius kullanıyor.
- **Beklenen:** Kart yüzeyleri aynı radius ailesinden.
- **Kanıt:** `getComputedStyle('.overview-section').borderRadius === '0px'`;
  `getPropertyValue('--radius-card') === ''`; grep: sadece 1 kullanım, tanım yok.
  `deep-overview-desktop.png` (keskin köşeli paneller) vs `deep-customers-desktop.png` (yuvarlak kartlar).
- **Öneri:** `--radius-card: 0.75rem` (veya mevcut `--radius-raised`) ekle; "tanımsız CSS
  değişkeni" için lint/test ekle (`SERVORA_REQUIRED_CSS_VARIABLES` listesini genişlet).

### VIS-05 — DESIGN.md paleti ile uygulanan token'lar birebir örtüşmüyor (doküman kayması)
- **Severity:** P3
- **Routes:** Dokümantasyon (kod değil)
- **Gözlem:** DESIGN.md "Mineral Blue `oklch(47% 0.105 238deg)`", "Daylight Paper
  `oklch(98.5% 0.004 235deg)`", "Soft Rule `oklch(86% 0.012 238deg)`" yazıyor; uygulama:
  `--accent: oklch(41% 0.13 242deg)`, `--paper: oklch(99% 0.002 245deg)`,
  `--rule: oklch(83% 0.014 238deg)`. DESIGN.md aynı bölümde "bu değerler mevcut uygulanan
  palettir" diyor.
- **Beklenen:** DESIGN.md değerleri `servora-visual-tokens.ts` ile tek kaynaktan hizalanmalı.
- **Kanıt:** DESIGN.md 31-50 vs `servora-visual-tokens.ts` 27-114; karşılaştırmalı liste.
- **Öneri:** DESIGN.md'yi token dosyasına referansla bağla (değerleri kopyalamak yerine
  "kanonik kaynak: servora-visual-tokens.ts") — doküman drift'ini kalıcı kapatır.

### VIS-06 — Disabled butonlar "wait" (kum saati) imleci gösteriyor
- **Severity:** P3
- **Routes:** Tümü (ör. rapor sayfalama "Sonraki", demo veri "Demo verisi oluştur", iptal diyalogu onayı)
- **Yüzey:** Both
- **Gözlem:** `button:disabled { cursor: wait; opacity: .65 }` (styles.css:49) — yüklenmiyor
  olsa bile devre dışı buton "işlem sürüyor" izlenimi veriyor.
- **Beklenen:** `cursor: not-allowed` (veya `default`); yükleme durumu ayrı `aria-busy` + spinner
  ile anlatılmalı.
- **Kanıt:** `styles.css:49`; `deep-reports-desktop.png` (pasif "Önceki/Sonraki").
- **Öneri:** İmleci `not-allowed` yap; yükleme durumunu ayrı sınıfla (`.is-loading`) ayır.

## E. DASHBOARD / OVERVIEW

### DASH-01 — Dashboard "metin kartları" gibi okunuyor; karşılaştırma ve değişim yok
- **Severity:** P2
- **Routes:** `/overview`
- **Yüzey:** Desktop ağırlıklı (mobilde tek sütuna iniyor)
- **Gözlem:**
  - KPI satırı (4 metrik) iyi konumlanmış ve tıklanabilir; ancak **önemli fark yok**:
    "11 aktif", geçen döneme göre iyi/kötü mü belli değil (delta/ok yok).
  - "Tamamlanma eğilimi" paneli boş (VIS-01) ve altında tek cümle var.
  - "İş dağılımı" üç ayrı kartta metin olarak listeleniyor ("Ürün Teslimi 9 iş" …) —
    karşılaştırma için sayıları okumak gerekiyor, oran görselleşmiyor.
  - Paneller arası yükseklik dengesiz: sol kolonda ~500px boş alan, sağda dolu kart yığını.
- **Beklenen:** Modern operasyon dashboard'ı: KPI'da değer + değişim, trendin görünür grafiği,
  dağılımın tek bakışta karşılaştırılabilir (yatay bar) sunumu, dengeli grid.
- **Kanıt:** `deep-overview-desktop.png`; `overview-kpis` ölçümü (4×144px kart, radius 12).
- **Muhtemel kaynak:** `OverviewPage.tsx:97-198` kompozisyonu; veri zaten mevcut
  (`completionTrend`, `completedInPeriod`, `cancelledInPeriod`, `workTypeDistribution`).
- **Öneri (veri zaten var, uydurma gerektirmez):**
  1. `workTypeDistribution` → yatay bar (3–5 satır, pay = count/total; etiket + sayı + %).
     Kullanıcı sorusu: "Hangi iş türü operasyonu domine ediyor?"
  2. KPI'lara **önceki dönem deltası** — reports API `priorRange/priorPerformance` deseni
     Overview için yok; ya overview yanıtına `prior` eklenmeli (backend iş) ya da delta
     yalnızca rapor ekranında kalmalı (karar).
  3. Grid dengesi: trend paneli 2 satır, "Yaklaşan işler" 2 satır olacak şekilde eşleştirme.

### DASH-02 — Overview dönem seçici yok (HDR-04 ile aynı kök; burada etkisi)
- **Severity:** P3
- **Routes:** `/overview`
- **Gözlem:** Yönetici "bu ay" dışında bir dönem görmek isterse raporlara geçmek zorunda.
- **Öneri:** `reports` aralık çipleriyle aynı bileşeni kullan; tek `requestedRange` sözleşmesi.

## F. REPORTS / DATA VISUALIZATION

Mevcut görselleştirme durumu (kaynak doğrulaması):

| Ekran | Grafik var mı | Kaynak |
|---|---|---|
| `/reports` (özet) | ✓ `WorkflowTrend` (oluşturulan vs tamamlanan ikili seri) | `ReportsDashboard.tsx:138` |
| `/reports/staff/:id` | ✓ `TrendBars` + `SegmentedDistributionBar` | `StaffOperationalReport.tsx:125,222` |
| `/reports/approvals` | ✓ SLA `SegmentedDistributionBar` (2s/2-8s/8-24s/>24s) | `ApprovalReport.tsx:83` |
| `/reports/sales-follow-up` | ✓ dağılım + `IndependentMeterBars` | `SalesFollowUpReport.tsx:216` |
| `/reports/deliveries` | ✗ yalnız tablo (Tarih/Birim/Miktar) | — |
| `/reports/customers` | ✗ yalnız metrik tabloları | — |
| `/overview` | (bozuk) `TrendBars` | VIS-01 |

### RPT-01 — Teslim raporu: gruplu tablo var, zaman serisi yok
- **Severity:** P2
- **Routes:** `/reports/deliveries`
- **Yüzey:** Both
- **Gözlem:** "Teslim miktarları (birim kırılımları birleştirmez)" tablosu Tarih/Birim/Miktar
  satırları gösteriyor; `Gruplama: Gün/Hafta/Ay` seçici ve `groupBy: day|purpose|product|staff`
  zaten var (`report-types.ts:106-110`).
- **Kullanıcı sorusu:** "Son 30 günde teslim hacmi nasıl değişti? Hangi gün/ürün/hafta zirve?"
  → tablo bunu okutuyor, göstermiyor.
- **Öneri (mevcut veriyle):** `groupBy=day` iken çift seri **bar/çizgi**: miktar (birim kırılımı
  renk değil, ayrı seri/lejant) + teslim sayısı; `groupBy=product|purpose` iken **yatay bar**
  (ilk 5 ürün). Donut **önermiyorum** (çok kategorili, karşılaştırma zayıf).
  Tabloyu koru (erişilebilir özet + hassas değer).

### RPT-02 — Müşteri raporu: risk/yoğunluk karşılaştırması görselleşmiyor
- **Severity:** P2
- **Routes:** `/reports/customers`
- **Gözlem:** API `snapshot` (active, actionable, waitingApproval, revisionRequested, overdue)
  + `period` (created, managerApproved, followUpChildren) döner; ekran yalnız sayı tabloları.
- **Kullanıcı sorusu:** "Hangi müşteriler riskli (overdue/waiting) ve hangileri yoğun?" →
  sıralama/karşılaştırma gerektirir.
- **Öneri:** (a) Üstte 2–3 KPI (toplam overdue, waitingApproval, aktif müşteri);
  (b) satır içinde tek satırlık **mini bar** (overdue / waiting / active oranı, renk değil
  etiket + genişlik); (c) isteğe bağlı "risk skoru" sıralaması. Donut önermiyorum.

### RPT-03 — Zaten iyi olan grafik yaklaşımı örnek alınmalı (korumaya alınacak)
- **Severity:** Pol (positive)
- **Kanıt:** `ApprovalReport` SLA kovaları tam doğru desen: histogram benzeri tek bar +
  sayısal özet; `WorkflowTrend` iki seriyi tek eksende gösteriyor ve `aria-hidden`+metin özeti
  ile erişilebilir (report-charts.tsx:168-206). Yeni grafikler bu desenin kopyası olmalı.

## G. BUTTON / CONTROL SİSTEMİ

### CTRL-01 — Temel kontrol ölçüleri token'a uyuyor (korumaya alınacak)
- **Severity:** Pol (positive)
- **Kanıt (computed):** primary buton `h=44px, radius 9.6px, font 700/16px, padding 8.8/13.6px`;
  arama input `h=49px, radius 9.6px`; select `h=45px`; chip `h=28px, radius 999px, font 700/13px`.
  `--control-height: 2.75rem (44px)`, `--radius-control: 0.6rem` ile uyumlu. WebKit ve
  Firefox'ta aynı ölçüler.
- **Not:** `.btn-full` mobil satır komutları ("Yönetici kontrolünü aç" 16px/700, tam genişlik)
  tutarlı; 320px'te metin kırılmıyor.

### CTRL-02 — Üç farklı 44px-dışı durum: segment (36), ay oku (23 genişlik), KPI linki (13–26)
- **Severity:** P2 (RESP-02/RESP-04 ile aynı kök; burada kontrol envanteri olarak)
- **Kanıt:** Sweep `smallSamples`; ayrıntı RESP-02/RESP-04.

### CTRL-03 — Yıkıcı aksiyon dili tutarlı (korumaya alınacak)
- **Severity:** Pol (positive)
- **Kanıt:** İptal diyalogu: başlık "İşi iptal et", terminalite uyarısı, zorunlu gerekçe
  alanı, `Vazgeç` (secondary) + `İşi iptal et` (danger/outline kırmızı), Esc ile kapanıyor,
  focus içeride başlıyor (`deep-cancel-dialog.png`, `deep-mobile-cancel-dialog.png` 343×461/390).

## H. TABLE / CARD / FORM TUTARLILIĞI

### FORM-01 — Form sözleşmesi tutarlı (korumaya alınacak)
- **Severity:** Pol (positive)
- **Kanıt:** `/jobs/new-task`: 7 etiketin tamamı kontrole bağlı (`linked:true`), zorunluluk
  görünür biçimde "(isteğe bağlı)" ile ters işaretleniyor (renk tek başına taşıyıcı değil),
  alt aksiyonlar `Vazgeç` + `Görevi oluştur` (primary, sağda). 2 alan `required/aria-required`.

### FORM-02 — Liste sayfaları kart, raporlar tablo; pagination dili tutarlı ama boş durumda "0 grup"
- **Severity:** Polish
- **Routes:** `/reports/*` ("2 grup" / "0 grup" + Önceki/Sonraki)
- **Gözlem:** Boş sonuçta empty-state ile birlikte "0 grup" satırı görünüyor; pasif
  butonlar "wait" imleci (VIS-06).
- **Öneri:** Boş sonuçta pagination footer'ı gizle; imleç düzeltmesi VIS-06 ile.

### FORM-03 — Mesajlar master-detail boş durum metinleri farklı (audit-1 C2 doğrulandı)
- **Severity:** P3
- **Routes:** `/messages`
- **Gözlem:** Sol kolon "Konuşma bulunmuyor" + "Yeni konuşma butonu ile başlatabilirsiniz.";
  sağ panel "Henüz konuşma yok" + aynı açıklama. Mobilde yalnız sol kolon görünür
  (`webkit-messages.png`, `desktop-messages.png`).
- **Öneri:** Tek boş-durum metni ve tek `EmptyState` varyantı; detay paneli mobilde
  gereksizse `hidden`.

### FORM-04 — Liste satırı komut yoğunluğu (320px'te 222px yüksek satır)
- **Severity:** Polish
- **Routes:** `/jobs` liste görünümü
- **Gözlem:** Tam genişlik ikincil komut butonları satır yüksekliğini 222px'e çıkarıyor;
  320px ekranda ekranda ~2,5 iş görünüyor.
- **Öneri:** Mobilde satır komutlarını tek "İşlemler" açılırına taşı (drawer/sheet),
  masaüstünde mevcut butonlar kalsın. Bu bir bilgi yoğunluğu kararı; DESIGN.md'ye yazılmalı.

## I. MOBILE / PWA / TARAYICI

### WEB-01 — WebKit geçişi: kritik mobil yüzeylerde compositing/layout hatası bulunmadı
- **Severity:** Pol (positive) — doğrulama sonucu
- **Kanıt:** WebKit 26, 390×844: `/overview`, `/messages`, `/jobs`, `/jobs/:id`, çekmece ve
  768×1024 — `overflowX:false`, üst bar + alt navigasyon görünür, sabit öğeler
  (`mobile-bottom-nav:fixed`, `sticky-new-job:fixed`, `shell-drawer-backdrop:fixed`) doğru
  konumda; `webkit-drawer.png`, `webkit-job-detail.png`, `webkit-messages.png`,
  `webkit-overview-768.png`. Sticky "Yeni iş" ile alt navigasyon arasında çakışma yok
  (ölçüm: create 731–774, nav 784–844 @390; scroll sonunda içerik örtülmüyor).
- **Not:** 320px'te boş alan/örtüşme de yok ancak başlık kırpılması var (RESP-01).

### WEB-02 — Firefox: SSE bağlantısı sayfa geçişinde konsola hata yazıyor
- **Severity:** P3
- **Routes:** Tümü (navigasyon anında)
- **Yüzey:** Desktop/Mobile (Firefox)
- **Gözlem:** `The connection to /api/realtime/events was interrupted while the page was
  loading` (her rota geçişinde). İşlevsel bozulma gözlenmedi (realtime yeniden bağlanıyor).
- **Beklenen:** Bilinçli kapatmada konsol gürültüsü olmaması (`EventSource.close()` +
  sayfa gizliyken kapatma) veya hatanın beklenen olduğu durumun ayrıştırılması.
- **Öneri:** Unmount'ta kapatma sırasını doğrula; `visibilitychange` ile duraklatma
  davranışını (varsa) belgele. Düşük öncelik.

### WEB-03 — favicon.ico 404 (audit-1 C3 doğrulandı; üç motorda)
- **Severity:** P3
- **Kanıt:** Chromium, WebKit konsol kayıtları; kökte yalnız `apple-touch-icon.png` var.
- **Öneri:** `index.html`'e `<link rel="icon" href="/favicon.ico">` + dosya (veya SVG favicon).

### WEB-04 — PWA metadata ile tarayıcı davranışı çelişkisi
- **Severity:** P3
- **Gözlem:** `document.title` yalnız standalone modda rota başlığı kullanıyor (HDR-03);
  PWA kurulum rehberi mevcut (AppleInstallGuidance). PWA'da kimlik iyi, tarayıcıda zayıf.
- **Öneri:** HDR-03 kararıyla birlikte ele al; iki mod aynı bilgi mimarisini paylaşmalı.

## J. ACCESSIBILITY (WCAG 2.2 AA hedefi)

### A11Y-01 — Dokunma hedefleri: KPI linkleri 24×24 altında (WCAG 2.5.8 sınırı)
- **Severity:** P2 · **Kanıt:** RESP-02 (13×33 / 16×33 / 17×33 / 26×33).
- **Not:** Liste başlığı linkleri için WCAG "inline" istisnası tartışmalı; PRODUCT.md 44px
  hedefi yine karşılanmıyor (RESP-03).

### A11Y-02 — Focus görünürlüğü token dışı (link vs kontrol) — VIS-03
- **Severity:** P2 · Halka her zaman görünür (kaybolmuyor), ancak renk/kalınlık tutarsız.

### A11Y-03 — Skip-to-content bağlantısı yok
- **Severity:** P3
- **Kanıt:** Landmark'lar doğru (`ASIDE`, `NAV:Ana navigasyon`, `HEADER`, `MAIN`);
  `skipLink:false` (12 Tab sonrası doğrudan sidebar linklerine giriliyor).
- **Öneri:** Görsel olarak gizli, focus'ta görünen "İçeriğe geç" bağlantısı; sidebar 12
  hedefli olduğu için klavye kullanıcısı her sayfada 12 Tab harcıyor.

### A11Y-04 — İkon butonların erişilebilir adları mevcut (korumaya alınacak)
- **Kanıt:** `Bildirimler`, `Önceki ay`/`Sonraki ay`, `Menüyü kapat`, takvim günleri
  `aria-label="2026-09-01"`; `aria-current="page"` sidebar aktif öğede.

### A11Y-05 — Kontrast: tüm ölçülen çiftler AA üstü (korumaya alınacak)
- **Kanıt (hesaplanan, sRGB'ye dönüştürülmüş):** gövde metni 16.08:1; muted/link 6.49:1;
  chip'ler 6.49–9.06:1 (new 6.49, in-progress 8.58, waiting 8.51, revision 9.06, high 8.51,
  urgent 8.61); primary buton 8.23:1; aktif sidebar 8.58:1. Durum renkleri metin etiketiyle
  birlikte (renk tek taşıyıcı değil).

### A11Y-06 — `prefers-reduced-motion` saygı görüyor (korumaya alınacak)
- **Kanıt:** `emulateMedia({reducedMotion:'reduce'})` altında shell/kart/link geçişleri
  `1e-05s` (etkisiz); `ServoraAntProvider` `motion:false` yolunu destekliyor.

### A11Y-07 — 200% reflow: yatay kaydırma yok (korumaya alınacak)
- **Kanıt:** 720×450 (≈1440'ın %200'ü) eşdeğerinde `/jobs`, müşteri detayı, `/reports/staff`,
  `/settings/profile`: `overflowX:false`, mobil chrome'a düşüyor, sabit yükseklikte kırpma yok.

---

## 1. Cross-app systemic problems (kök neden bazında)

| # | Kök neden | Etkilenen bulgular | Tek doğru düzeltme yeri |
|---|---|---|---|
| S1 | **Page header sözleşmesi yok** — her ekran kendi başlık/aksiyon kompozisyonunu kuruyor | HDR-01, HDR-02, (dolaylı) DASH-02 | `ui/PageHeader` + route metadata SSOT |
| S2 | **Marka tek standardı yok** — 3 varyant, 2 kaynak dosya, 3 ölçek, link değil | BRAND-01, BRAND-02, BRAND-03 | `DunyaDentalBrand` + DESIGN.md logo tablosu |
| S3 | **Trend/dashboard birincil öğesi sessizce bozuk** — CSS selector override | VIS-01, DASH-01 | `TrendBars` className birleştirme + regresyon testi |
| S4 | **Focus dili token dışı (yalnız `<a>`)** | VIS-03, A11Y-02 | `a:focus-visible` açık kuralı + token testi |
| S5 | **Dokunma hedefi sözleşmesi eksik** — link/segment/ikon varyantları | RESP-02, RESP-03, RESP-04, A11Y-01, CTRL-02 | DESIGN.md touch-target kuralı + ortak bileşen ölçüleri |
| S6 | **Tanımsız/yinelenen token ve stil override'ları** | VIS-04, (S3 ile aynı aile), FORM-02 | Token dosyası + "tanımsız var" testi |
| S7 | **Başlık/kimlik kaynağı iki yerde** (topbar + h1 + document.title) | HDR-02, HDR-03, WEB-04 | Route metadata → tek tüketici zinciri |

Bu yedi kök neden, rapordaki ~20 gözlemin çoğunu açıklıyor; tek tek ekran yamaları yerine bu
katmanlarda düzeltme yapılması öneriliyor.

## 2. Route-specific problems (kök neden dışı, yerel)

- `/jobs`: mobilde satır komut yoğunluğu (FORM-04), 320px'te ragged hızlı görünüm şeridi (RESP-06),
  masaüstünde "Listeye dön" + mobil üst bar "Geri" çifti (audit-1 A5).
- `/reports/*`: boş sonuçta "0 grup" footer (FORM-02); deliveries ve customers görselleştirme
  boşluğu (RPT-01, RPT-02).
- `/overview`: trend bozuk (VIS-01), KPI artefaktı (VIS-02), dönem seçici yok (DASH-02),
  panel radius 0px (VIS-04).
- `/messages`: üç kez "Mesajlar" (HDR-02), iki farklı boş durum metni (FORM-03), 36px segmentler (RESP-04).
- `/calendar`: 23px genişlikte ay okları (RESP-04).
- `/staff`, `/users`: anlamsız "İşlere dön" bağlantısı (audit-1 A4; bu turda yalnız `/staff`
  canlı örnekte görüldü).
- `/products/:id`: içerik geri bağlantısı yok (audit-1 A5).
- `/settings/*`: 2. seviyede üst bar geri yok (audit-1 A3) + sekme şeridi ile başlık ilişkisi
  tanımsız (HDR-01 satırı).

## 3. Mobile-only problems

1. RESP-01 başlık kırpılması (P1) — yalnız ≤360px.
2. RESP-02 KPI 2 sütun sıkışması + minik KPI linkleri.
3. RESP-03/RESP-04 dokunma hedefleri.
4. HDR-02 mobil çift başlık (üst bar + görünür h1).
5. FORM-04 satır komutlarının ekranı kaplaması.
6. 768 tablette masaüstü düzeni yok (RESP-05, karar).
7. Sabit "Yeni iş" + alt navigasyon + içerik üçlüsü doğru çalışıyor (korumaya alınacak);
   320px'te içerik örtülmüyor (ölçüm: scroll sonunda son satır 333 < sticky 455).

## 4. Design-token / component drift envanteri

| Alan | Token/kural | Gerçekleşen | Durum |
|---|---|---|---|
| Focus (link) | `--focus` oklch(0.53 .15 242) / 3px / offset 3px | OS vurgu teali rgb(87,158,181) / offset 1px | **Drift (VIS-03)** |
| Focus (input/button) | aynı | token ile aynı | Uyumlu |
| Kart radiusu | `--radius-card` (styles.css:3436) | var tanımsız → 0px | **Drift (VIS-04)** |
| Diğer radiuslar | control 0.6rem / raised 0.75rem / chip 999px | ölçülen 9.6px / 12px / 999px | Uyumlu |
| Kontrol yüksekliği | 44px | primary 44, input 49, select 45, chip 28, segment 36, ay oku 23×44 | Kısmen (S5) |
| Elevation | `--shadow-raised` 0 8px 24px | kartlarda shadow yok (düz), antd modal/drawer'da | Karar: kasıtlı görünüyor |
| Renk paleti (DESIGN.md) | Mineral Blue 47%/.105/238 vb. | `--accent` 41%/.13/242 vb. | **Doküman drift (VIS-05)** |
| Kontrast | AA hedefi | 6.49–16.08:1 | Uyumlu (A11Y-05) |
| Motion | reduced-motion desteği | 1e-05s | Uyumlu (A11Y-06) |
| Yazı tipi | Inter + sistem fallback, 16px gövde | aynı | Uyumlu |

## 5. Dashboard / report visualization fırsatları (dekoratif değil, soru bazlı)

| Öncelik | Ekran | Kullanıcı sorusu | Önerilen görselleştirme | Kullanılacak mevcut veri |
|---|---|---|---|---|
| 1 (hata) | /overview | "Dönem içinde tamamlama ritmi nasıl?" | **Mevcut ama bozuk** günlük trend çubukları (VIS-01 düzeltmesi + tooltip) | `completionTrend[{date,count}]` |
| 2 | /overview | "Hangi iş türü operasyonu domine ediyor?" | Yatay bar (etiket + sayı + %) | `workTypeDistribution[{type,count}]` |
| 3 | /reports/deliveries | "Teslim hacmi zaman içinde nasıl değişti?" | Gün/hafta/ay bar serisi (+ miktar & teslim sayısı ikili eksen) | `DeliveryReportResponse` (groupBy day + quantity) |
| 4 | /reports/deliveries | "Hangi ürün/amaç en çok sevk edildi?" | İlk 5 için yatay bar | `groupBy=product|purpose` satırları |
| 5 | /reports/customers | "Hangi müşteriler riskli/yoğun?" | Satır içi mini ölçek (overdue/waiting) + üstte 3 KPI | `CustomerReportSnapshot` + `CustomerReportPeriod` |
| 6 | /reports (özet) | "Onay kuyruğu yaşlanıyor mu?" | Mevcut SLA `SegmentedDistributionBar` korunur; yanına ortalama bekleme KPI | `ApprovalSummary` (zaten var) |
| 7 (yorumsuz) | /reports/staff | "Personel birbirine göre nasıl?" | Karşılaştırma tablosu + mevcut `TrendBars`; yeni grafik gerekmez | `StaffPerformanceResponse.items` |

**Uyarı:** Donut/pie yalnız 2–3 kategorili pay göstermek için düşünülebilir; bu üründe asıl
sorular zaman serisi ve sıralama olduğu için **bar/line tercih edilmeli**. Her grafik
`report-charts.tsx` desenini izlemeli: `aria-hidden` görsel + erişilebilir metin/tablo özeti.

## 6. DESIGN.md için önerilen kararlar (tasarım kararı gerektirir, uygulanmadı)

1. **Page header sözleşmesi:** slotlar (eyebrow, title, description, primary/secondary action,
   tabs, filters) ve hangi rota sınıfında hangi slotun zorunlu olduğu.
2. **Breadcrumb vs geri politikası:** masaüstünde statik hiyerarşi breadcrumb'ı; mobilde tek
   "‹ ebeveyn" + içerik geri butonlarının kaldırılması; `location.state.from` ile
   context-aware dönüş ve URL'e doğrudan girişte deterministik ebeveyn (audit-1 önerisiyle uyumlu).
3. **Logo standardı:** tek kaynak varlık, bölge bazlı ölçek tablosu, tıklama hedefi (home),
   minimum okunabilir boyut; aynı ekranda iki marka gösterimi kuralı.
4. **Mobil üst bar öncelik sırası:** marka < başlık; ≤360px davranışı; başlık min genişliği.
5. **Touch target kuralı:** 44×44 zorunlu sınıflar (liste başlığı linki, KPI, segment, ikon buton).
6. **Dönem (range) tek sözleşmesi:** overview + reports aynı aralık bileşeni ve varsayılanı.
7. **Sekme başlığı (document.title) politikası:** browser ve PWA modunda tek desen.
8. **Tablet sınıfı (768–1023):** chrome kararı.
9. **Token kaynağı:** DESIGN.md'de renk değerleri kopyalanmaz; `servora-visual-tokens.ts`
   kanonik kaynak olarak bağlanır.

## 7. Quick wins (düşük risk, yüksek görünür değer)

1. `TrendBars` className birleştirme → Overview grafiği geri gelir (VIS-01) — **tek satır + test**.
2. `a:focus-visible` token kuralı (VIS-03) — **3 satır CSS**.
3. `--radius-card` tanımı (VIS-04) — **1 satır**.
4. KPI `border-left` artefaktı düzeltmesi (VIS-02) — tek kural.
5. Logo → home bağlantısı (BRAND-01) — bileşene opsiyonel `to`.
6. favicon.ico (WEB-03), disabled imleci (VIS-06), mesajlar boş durum metni (FORM-03),
   boş raporda "0 grup" gizleme (FORM-02).
7. Takvim okları + mesaj sekmeleri min 44px (RESP-04).

## 8. Architectural fixes (sistemik)

1. **Route metadata SSOT'u:** `{title, parent, breadcrumb, primaryAction?, tabs?}` tek kayıt;
   topbar başlığı, içerik H1, breadcrumb, geri ve `document.title` bu kaynaktan türetilir (S1+S7).
2. **`ui/PageHeader` bileşeni:** mevcut `workspace-heading`/`route-identity-heading`
   kullanımlarının tek çatı altında toplanması; mobil/masaüstü davranışı tek yerde.
3. **Marka bileşeni sözleşmesi:** `DunyaDentalBrand({variant, to?, size})` + DESIGN.md tablosu (S2).
4. **Grafik primitifleri:** `report-charts.tsx` genişletmesi (hbar, mini-bar, KPI delta);
   tüm grafiklerde `aria-hidden` + metin özeti zorunlu.
5. **Token koruma testleri:** (a) tanımsız CSS değişkeni yok, (b) focus rengi --focus,
   (c) touch target minimumu (sınıf bazlı), (d) DESIGN.md ↔ token senkron testi.
6. **Dokunma hedefi deseni:** liste kartlarında "stretched link".

## 9. Zaten iyi olan ve yeniden tasarlanmaması gerekenler

- Navigasyon SSOT'u (sidebar/çekmece/alt bar tek model) ve rol filtrelemesi.
- Çekmece focus tuzağı/geri verme; `aria-current` aktif durumu.
- Form sözleşmesi (bağlı etiketler, "(isteğe bağlı)" işaretleme, Vazgeç + primary footer).
- Yıkıcı onay deseni (gerekçe + danger + Esc + focus içeride).
- Kontrast skorları ve durum renklerinin metinle desteklenmesi.
- `prefers-reduced-motion` desteği ve 200% reflow.
- Sabit mobil yığın (üst bar + alt nav + sticky create) ve scroll sonunda örtüşmeme.
- Raporların mevcut grafik yaklaşımı (SLA dağılımı, ikili trend) — yeni grafikler bunu taklit etmeli.
- `sr-only` h1 + erişilebilir başlık sırası (H1→H2→H3) ve landmark yapısı.

---

## Önerilen remediation slice'ları (hiçbiri uygulanmadı; yetki bekliyor)

**Slice 1 — "Görünmez grafik ve kırık KPI" (bug fix, en küçük):**
VIS-01 + VIS-02 + VIS-04. Kapsam: `report-charts.tsx` className birleştirme, KPI kenarlık
kuralı, `--radius-card` token'ı, Overview trend regresyon testi (konteyner yüksekliği > 0).
Etki: yüksek görünürlük, düşük risk.

**Slice 2 — "Focus ve kontrast/token hijyeni":**
VIS-03 (`a:focus-visible`), VIS-06, token koruma testleri (tanımsız değişken + focus rengi).
Etki: a11y + sistem tutarlılığı.

**Slice 3 — "Marka ve başlık kimliği":**
BRAND-01/02/03 + RESP-01 + HDR-02 + HDR-03. Ön koşul: DESIGN.md kararları (logo tablosu,
üst bar önceliği, document.title deseni). Etki: tüm ekranlarda algılanan tutarlılık.

**Slice 4 — "Page header + breadcrumb sözleşmesi":**
HDR-01 + audit-1 A2/A3/A5/A6. Ön koşul: DESIGN.md breadcrumb/geri politikası.
Kapsam: route metadata SSOT, `ui/PageHeader`, içerik geri butonlarının standardizasyonu.
Etki: yönelim sorununun tamamını kapatır; en yüksek mimari etki.

**Slice 5 — "Dokunma hedefleri ve mobil yoğunluk":**
RESP-02/03/04 + FORM-04 + A11Y-01/03. Etki: saha kullanımı (tek elle kullanım).

**Slice 6 — "Dashboard ve rapor görselleştirme":**
DASH-01/02 + RPT-01/02 + HDR-04. Ön koşul: slice 1 (grafik primitifleri sağlam olsun).
Etki: yönetici karar hızı.

**Slice 7 — Küçük temizlikler:** WEB-02, WEB-03, FORM-02, FORM-03, RESP-06.

## Doğrulama ve kanıt indeksi

| Kanıt | Konum |
|---|---|
| Viewport matrisi (8×8), touch target örnekleri | Bu oturumun scripted ölçüm çıktıları |
| Marka ölçümleri (235×128 / 74×52 / 51×36) | `brandDesktop` / `brandMobile` ölçümü |
| Page-header envanteri (18 rota) | `headers` matrisi |
| Konsol/kontrast/focus ölçümleri | scripted evaluate çıktıları |
| Ekran görüntüleri | `deep-*.png` (Chromium, playwright MCP çıktı dizini) |
| WebKit/Firefox | `/tmp/servora-wk/{webkit,firefox}-*.png` + JSON ölçümleri |
| Kaynak kanıtları | `styles.css` (49, 51, 465, 3292, 3436, 3458, 4507-4524), `report-charts.tsx:173-206`, `OverviewPage.tsx:97-198`, `document-title.ts:10-20`, `servora-visual-tokens.ts`, `servora-ant-theme.ts` |

## Ortam notu

Geçici DB (`servora_med_uxaudit`), dev seed kullanıcıları ve zorlanmış test verisi bu denetim
için oluşturuldu; sunucular (Fastify :3000, Vite :5173) arka planda çalışır durumda bırakıldı.
WebKit/Firefox geçici betiği ve Chromium storageState dosyası /tmp altındadır (repo dışı).
Temizlik istendiğinde: süreçler durdurulur, DB ve `servora_audit` rolü düşürülür.
