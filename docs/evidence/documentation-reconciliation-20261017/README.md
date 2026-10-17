# PR #376 — Dokümantasyon geçerlilik denetimi

Denetim tarihi: 2026-10-17. Başlangıç main: dc7d0ae3fb7adac1e17339053cac4505a45b2149.
Başlangıç PR head: 0fbac6d092fdd55c29f6f3b6f943d509d65eb2ec.
Nihai commit/tree ve exact-head doğrulama kaydı PR açıklamasındadır; bu belge
kendi commit kimliğini içine yazarak döngü oluşturmaz.

[Makine okunur envanter](inventory.json) her belge için başlık, Git'te ilk eklenme
ve kapsam tarihleri, baskın rol/yetki alanı, inbound/outbound bağlantılar,
kod/script/CI referansları, kaynak yolu ve migration kataloğu karşılaştırmaları,
komut risk işaretleri, açık supersession kanıtı, koruma kararı ve takip önerisini içerir.
Envanterdeki sınıflandırma bir gözlemdir; yeni ürün kuralı veya silme onayı değildir.

## Kapsam ve yöntem

Başlangıçta **156 tracked Markdown**: kökte 11, docs altında 141, test-results
altında 4 dosya vardı. Kökün dört SERVORA_MED_* belgesi dahildir.
Superpowers sayıları 44 plan / 32 spec; operations 25, features 9, evidence 13,
UI 11 ve diğer docs girdileri 7 olarak başlangıç envanteriyle eşleşti.
Bu PR iki Markdown ekler: docs/README.md ve bu rapor. Sonuç **158 Markdown**,
docs altında **143**; ayrıca makine okunur JSON envanteri eklenir.

Tüm belgelerin tam metninden referans/komut/katalog verileri statik olarak
çıkarıldı; kapsam/durum başlıkları ve referans ilişkileri değerlendirildi.
Öncelikli sahip belgeleri, kurulum akışları, Sale miktar/lifecycle değişiklikleri
ve kullanıcı kılavuzunun navigasyonu güncel karar/kodla ayrıca karşılaştırıldı.
Bu çalışma 3 MB metnin bütün ürün maddelerinin yeniden kabul testi değildir.
Dış URL'lerin tamamı ağdan denetlenmedi; production, DB, restore ve eski plan
komutları çalıştırılmadı. Her satırın assessment_depth ve NOT_RUN kaydı bu sınırı
açıklar. Kaynak dosyasının bulunması, tasarımın tamamının kabul/teslim kanıtı sayılmadı.

## Sınıflandırma

| Kategori | Dosya |
| --- | --- |
| ACTIVE_AUTHORITY | 49 |
| ACTIVE_RUNBOOK | 19 |
| HISTORICAL | 47 |
| ARCHIVED | 4 |
| EVIDENCE | 32 |
| BACKLOG | 2 |
| SUPERSEDED | 0 |
| OBSOLETE_REMOVABLE | 0 |
| UNKNOWN | 5 |

HISTORICAL, eski çalışma sırasını bugünkü komut haline getirmeyen teslim
kayıtlarını tanımlar; içindeki özgün test sonuçları bugünkü head'e taşınmaz.
ACTIVE_AUTHORITY belgelerinde de tarihsel checkpoint parçaları bulunabilir.
Beş UNKNOWN kaydı, özgün onay/durum metniyle güncel implementasyonun ayrı
değerlendirilmesi gereken girdilerdir; korunur. Hiçbir belge yalnız yaşı nedeniyle
SUPERSEDED veya OBSOLETE_REMOVABLE ilan edilmedi.

## İki P2 düzeltmesi

1. README'nin Five-minute development start ve Server Setup yolları, migration
   öncesinde ortak yerel DB hazırlığına yönlenir. PostgreSQL rolü, özel psql parola
   istemi, DB owner ve ignored .env içindeki DB_PASSWORD değişimi açıklandı.
   Mevcut DB/rolü silme veya aynı creation komutlarını tekrar çalıştırma önerilmez.
2. Development şablonu ve README parolanın URL-safe veya yalnız parola bileşeninde
   bir kez percent-encoded olmasını açıklar. #, / ve ? için kodlar verilir;
   tüm URL'yi veya önceden kodlanmış parolayı tekrar kodlama talimatı yoktur.
   Üretim şablonunun mevcut yaklaşımı korunur.

İlk odaklı kontrol iki P2 test grubunda RED verdi; düzeltme sonrası iki grup GREEN.
Gerçek pg-connection-string ayrıştırıcısıyla beş sentetik reserved-character
parolası doğru parola/host/user/DB bileşenleriyle round-trip yaptı; DB bağlantısı 0.
Parola oluşturulmadı ve özel değerler kayda veya Git'e kopyalanmadı.

## Dar kapsamlı belge değişiklikleri

- AGENTS.md §2.5: Codebase Memory isteğe bağlı keşif indeksidir. Sonuçlar güncel
  checkout/kod/test ile doğrulanır; cache güncellemeleri tek başına kaynak drift'i
  sayılmaz. rg/git grep fallback'i ve reset/reindex için ihtiyaç + kullanıcı yetkisi
  korunur. §15 tarihsel tool/sub-agent metninin güncel görev yetkisini aşamadığını açıklar.
- docs/README.md yalnız mevcut yetki sahiplerine yönlendirir; ikinci SSOT değildir.
- Ağustos VPS araştırması **yerinde arşiv** olarak etiketlendi. Eski aktif karar
  etiketi kaldırıldı; gövde ve yol korundu, güncel runbook'lar bağlandı.
- PHASE-U-README ve Ant/Phase T uygulama planı tarihsel kayıt olarak etiketlendi.
  UI composition/adapter belgelerinde menü ve program etiketlerinin checkpoint
  kapsamı açıklandı. DESIGN'daki tarihli Phase U task listesi tarihsel olarak belirtildi.
- Dört kök SERVORA_MED_* dosyasının yetki alanları ve kabul edilmiş ek kararlarla
  birlikte okuma sorumluluğu açıklandı; bu sahip belgeleri arşive taşınmadı.
  Schema'nın genel miktar cümlesi Delivery ile sınırlandı ve Sale için mevcut
  SALE-QTY-001 kabulüne yönlendirildi; yeni iş kuralı üretilmedi.
- PR2 read-integration başlığına 057/closed-write ifadelerinin checkpoint kapsamı,
  güncel PR3 write ve 058 miktar sahipleri eklendi. Eski discovery/hash/057 geçmişi korunur.
- Kılavuzda özellik açıkken overview'e, kapalıyken jobs'a giriş düzeltildi;
  eksik menü satırları source modelinden doğrulandı. Altı rol/özellik senaryosunda
  58 navigation hedefi kontrol edildi; browser/a11y smoke NOT_RUN.
- Backup/recovery indeksindeki Git ağacında olmayan eski export/import planı
  referansı mevcut MOD-001 yetki sınırına bağlandı. Recovery komut blokları değişmedi.
- README'nin canlı host aktivasyonu hakkında kanıtsız mutlak ifadeleri,
  tarihli host kanıtı gerektiren sorumluluk açıklamalarına dönüştürüldü.

## Drift ve ayrı takip işleri

| Kayıt | Kapsam | Gereken takip |
| --- | --- | --- |
| DOC-FU-01 | 43 tarihsel Superpowers planı | Ayrı archive/navigation PR'ı; her yolun inbound ve kabul geçmişini incele, otomatik silme yapma |
| DOC-FU-02 | Beş UNKNOWN onay/durum kaydı | Özgün kabul/closeout kaydını bul; kod varlığından onay çıkarma |
| DOC-FU-03 | API/schema/product requirements baseline kapsamı | Eski üç-MVP-type örneklerini kabul edilmiş Weekly Report/Sale ekleriyle madde bazında uzlaştır; ana sahip yollarını koru |
| DOC-FU-04 | Visit-to-Sale PR4 parity hedefleri | Ayrı açık kapsam/izin; bu PR'da runtime çalışması yok |
| DOC-FU-05 | Detaylı Sale kılavuzu ve bir Ant adapter tasarım yolu | Ayrı doküman güncellemesi; spekülatif component oluşturma |

Detaylı aday yolları ve gerekçeleri inventory.json içindedir.
SALE-QTY-001 yalnız eski Sale decimal input/public presentation kuralını açıkça
supersede eder. Delivery'nin kesirli miktarları, özel üç-scale hash/audit geçmişi,
diğer SALE-001/MOD-001 kuralları ve migration 001–057 bu sınıflandırmayla değiştirilmez.
Tamamlanmış/iptal edilmiş tarihsel kartta ayrı yetkili ADMIN invalidasyonu
normal lifecycle terminal kısıtından bağımsızdır; AGENTS §3 sözleşmesi aynen korunur.

Eski kaynak-yolu adayları arasında tarihsel checkpoint-c artifact adı,
generated server/dist/index.js ve planlanan ServoraProgress.tsx bulunur.
Bunlar geçerli Markdown linki diye PASS yapılmaz; envanterde ayrı kaynak-yolu
gözlemleri olarak saklanır. Mevcut npm run lint atıfları yasak/eksik komut veya
tarihsel evidence bağlamında okunur; güncel test zorunluluğuna dönüştürülmez.

## Koruma ve silme kararı

**Silinen veya taşınan mevcut Markdown: 0.** Altı silme koşulunun tamamını
kanıtlayan bir dosya saptanmadı. Bu nedenle silme/inbound-güncelleme kanıt tablosu
boştur; removals ve moves dizileri de boştur.

Orijinal docs/evidence, docs/archive/inputs, UI screenshot kayıtları ve test-results
korundu. DECISIONS.md, PRODUCT.md ve PRODUCT_REQUIREMENTS.md değişmedi. Mevcut
backup/recovery ve R4 kaynakları silinmedi; backup indeksindeki yalnız referans
düzeltmesi dışında bu runbook'lara müdahale edilmedi. Eski spesifikasyonların
geçerli iş kuralları sırf etiket/tarih değişti diye iptal edilmedi.

## Doğrulama ve NOT_RUN

- Odaklı kurulum/encoding regression grupları: GREEN (2/2).
- Sentetik PostgreSQL URL ayrıştırma: PASS (5/5; Node 22.23.3, DB bağlantısı 0).
- Pure navigation/kılavuz karşılaştırması: PASS (6 senaryo / 58 hedef).
- Ignore sözleşmesi: PASS (34/34; kişisel excludes kapalı izole fixture).
- Yerel env anahtar kapsama: PASS (29/29); gerçek .env/host.md değişmedi.
- Env-example deployment sözleşmesi: PASS, canonical head 058_sale_integer_quantity.
- Markdown yerel link/path/anchor kontrolü: PASS, 202 bağlantı; MISSING_PATH ve
  MISSING_ANCHOR 0. Tarihsel kaynak-yolu adayları ayrı raporlanır.
- Envanter kapsamı ve 158 Markdown byte hash'i doğrulandı.
- Yeni diff, altı env şablonu ve 158 Markdown için bilinen credential desenleri /
  mevcut yerel hassas değer eşleşmesi tarandı; bulgu 0. git diff --check PASS.
- Mevcut 27-gate tanımı değişmedi. Full Local CI, application build/server/web
  suites, browser/a11y smoke, production/staging/development DB ve restore testleri:
  **NOT_RUN**. Eski main veya head'in CI kanıtı yeni head'e atfedilmez.
- Canonical main/index, beş stash, 46 worktree kaydı ve 100 yerel private dosyanın
  hash/mode/flags bilgileri korundu. Proje ref'leri PR branch'i dışında değişmedi;
  araç içi refs/codex/turn-diffs yenilenmeleri bu branch korumasından ayrıdır.
  Canlı graph dosyaları yerinde. Orijinal 28 history/evidence Markdown byte-identical.
- GitHub Actions çalıştırılmaz; commit skip işaretleri taşır. Merge yapılmaz.

Bu rapor yeni ürün politikası, deploy/migration onayı veya eski görevlerin
yeniden çalıştırılma emri değildir. Review thread'leri ancak yayımlanan düzeltme
ve doğrulama kanıtı sonrasında kapatılır.
