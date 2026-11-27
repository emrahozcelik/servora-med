# Çekirdek + modüller mimari araştırması — 2026-11-25

Durum: araştırma raporu (karar değildir). Hiçbir kod değiştirilmedi.

Kapsam: `origin/main` @ `c3b3330`, salt-okunur ayrı checkout. Hedef: uygulamayı
çekirdek + takılabilir modüller yapısına geçirmek; env'deki ürün modülü
bayraklarını yalnızca kurulum operatörünün (sistem admin, müşterinin ADMIN'i
değil) kullandığı bir uygulama içi panele taşımak; yeni müşteri kurulumlarını
boş DB + migration + bootstrap + kurulum profili ile tekrarlanabilir yapmak;
yakında Depo/Stok, Bakım ve Muhasebe modüllerini eklemek.

Yöntem: model-fleet ile dört paralel salt-okunur araştırma hattı, lead
doğrulaması, ardından Sol (GPT-6.2) mimari ikinci görüş.

| Hat | Konu | Worker | Run |
| --- | ---- | ------ | --- |
| T1 | Modül bağımlılık grafiği, çekirdek sınırı | DeepSeek | `20261125-181021-deepseek-2232` |
| T2 | Örtük durum makineleri | Hydrogen | `20261125-181744-hydrogen-75cf` |
| T3 | Ölü kod, AGENTS.md kural uyumu | DeepSeek | `20261125-181021-deepseek-80ec` |
| T4 | Env/capability envanteri, web kabuğu | Hydrogen | `20261125-181439-hydrogen-7546` |
| Sol | Sentez ve dilim sırası eleştirisi | Sol | `20261125-183802-sol-91b7` |

Tam raporlar `~/.claude/model-fleet/runs/<run>/` altındadır (T1 ve T3 için
`evidence/report.md`, diğerleri için `worker-report.md`).

## 1. Ana sonuç

Bugünkü sunucu "büyük bir çekirdek + yarı ayrılmış birkaç modül" görünümünde.
Ölü kod sınırlı; asıl sorun yapısal bağlılık. Bu bağlılık, modül kaydı
(registry) ve operatör panelinin önünde bir engel değil. Ama depo, bakım ve
muhasebe gibi yeni modüller, aşağıdaki çekirdek sözleşmeler olmadan mevcut
karmaşayı büyütür.

## 2. Lead tarafından kodda doğrulanan bulgular

| # | Bulgu | Kanıt | Önem |
| - | ----- | ----- | ---- |
| V1 | `job-cards` 27.975 satır (modül kodunun ~%40'ı); `service.ts` 9.491, `repository.ts` 7.524 satır | `wc -l` | Yüksek |
| V2 | Haftalık Rapor route'ları `job-cards` içinde kayıtlı | `server/src/modules/job-cards/routes.ts:24-29` | Orta |
| V3 | Karşılıklı modül bağımlılıkları: job-cards↔weekly-reports (4/7 dosya), job-cards↔notifications (6/2). auth↔job-cards yalnızca süre hesabı yardımcısı üzerinden, gerçek yükleme döngüsü değil | `rg` import taraması; `auth/setup.ts:5` | Orta |
| V4 | `job_cards` tablosu 11 başka modülden SQL ile okunuyor; messaging JobCard ve kullanıcı yetkisini satır içi SQL ile kontrol ediyor | `messaging/service.ts:170,308,340,376,1191` | Orta |
| V5 | `people` offboarding/silme sırasında 21 tabloya yazıyor (job_cards, calendar_reminders, conversation_participants, web_push_*, weekly_report_recurrences…) | `people/offboarding.ts:574,599,676,683,798,1016` | Yüksek (her yeni modül bunu kırar) |
| V6 | Çekirdek tablolar modül sözlükleri taşıyor: `realtime_events`'e modül başına nullable FK kolonları eklenmiş; `audit_events` event_type CHECK'i 14, `job_card_activity_logs` CHECK'leri 13 migration'da yeniden yazılmış | `017_calendar.sql:216`, `018_messaging.sql:122`, `023_staff_confidential_notes.sql:38` | Orta |
| V7 | Modül açma/kapama yalnızca başlangıçta: messaging route'u kapalıyken hiç kaydedilmiyor, servisler `enabled` değerini kurulumda yakalıyor, worker'lar açılışta başlıyor (`app.ts`'de 15 capability/enabled kapısı) | `server/src/app.ts:341-372,502` | Yüksek (panel için şart) |
| V8 | Kurulum operatörü kimliği yok; roller yalnızca ADMIN/MANAGER/STAFF | `001_auth_foundation.sql:16` | Yüksek |
| V9 | Yedekleme durumu ile audit ayrışabiliyor. Worker run claim'ini commit ediyor, `BACKUP_STARTED` audit'ini ayrı `pool.query` ile yazıyor. Süresi dolmuş run'ı `FAILED` yaparken de aynı boşluk var: kurtarma yalnızca `RUNNING` satırları seçtiği için arada kesinti olursa eksik audit sonraki taramada tamamlanmıyor | `backup/worker.ts:227-233,236-247`, `backup/repository.ts:556-564,781-813` | Orta (AGENTS.md §3/§6) |
| V10 | **Karar–kod sapması:** JOB-012 ve `docs/features/assignment-time-proposal.md:55,74`, önerilen alternatif saatin personelin doluluğuyla çakışmamasını şart koşuyor (`409 CALENDAR_CONFLICT`). Kod bu kontrolü hem öneri kaydında hem yönetici onayında yalnızca takvim modülü açıkken yapıyor. Atlanan sorgu yalnızca manuel takvim kayıtlarına değil, personele atanmış diğer aktif işlere de bakıyor. Yani atama penceresi açık, takvim kapalıyken çakışan bir iş onaylanabiliyor. İlgili PostgreSQL testi takvimi hep açık kuruyor. Takvim bayrağı ayrıca JobCard kilitlerini ve hatırlatıcı senkronunu da değiştiriyor | `DECISIONS.md` JOB-012 madde 2; `job-cards/service.ts:5739,7331` (öneri/onay), `:3859,4173,4263` (kilit/senkron); `job-cards/repository.ts:5110-5127`; `server/tests/job-card-assignment-time-proposal-postgres.test.ts:428` | Yüksek (bağımsız düzeltme; takvimi panele açmadan önce) |
| V10+ | **V10'un tam kapsamı** (Takvim 2.0 oturumu buldu, lead doğruladı). Çakışma kontrolü takvim kapalıyken şu yollarda da atlanıyor: iş oluşturma `service.ts:1914`, teslimat oluşturma `:2974`, satış onayında oluşan teslimat `:2841`, takip işi oluşturma `:3369`. Atanan kişi kilitleri `:3856,3988` da bayrağa bağlı. `/available-slots` takvim kapalıyken 404 dönüyor (`:9059`). Ters yönde: takip işinin otomatik saat seçicisi (`autoScheduleFollowUpProposal` → `repository.ts:3926 listAssigneeCalendarIntervals`) bayrağa bakmıyor ve takvim kapalıyken bile `calendar_events` kayıtlarını sayıyor. Doluluk sorgusu en az dört yerde tekrarlanıyor: `assertCalendarAvailability`, `listAssigneeCalendarIntervals`, `people/offboarding.ts:545`, `calendar/repository.ts assertNoConflict` | `job-cards/service.ts` (yukarıdaki satırlar), `job-cards/repository.ts:3926,5110` | Yüksek (tek çekirdek doluluk okuyucusu gerekiyor) |
| V11 | Yeni tür/durum sessizce mevcut kuralları devralıyor. Onaya gönderme politikası bilinen türleri ayırdıktan sonra kalan her türü `evaluateMeeting` ile değerlendiriyor. Yaşam döngüsü politikasının son dalı, kalan durumu onay bekleyen iş sayıyor. Bugünkü tür/durum kümesiyle doğru çalışıyor (terminal durumlar önceden eleniyor). Ama `BAKIM` gibi yeni bir tür veya durum eklenirse derleyici eksik kararı göstermiyor | `job-cards/submission-policy.ts:387-392`, `job-cards/policy.ts:92-93,146-148`, `job-cards/types.ts:11,29` | Orta (Bakım modülünden önce exhaustive kontrol) |

Raporların diğer bulguları (ör. 20 kullanılmayan sunucu ve 8 web export'u, ~27
ölü CSS seçicisi, 9 sahipsiz `web/scripts` dosyası, web'de dağınık
`capabilities` kontrolleri, `CommandPalette` hızlı eylemlerinin capability
kontrol etmemesi, CI env-example betiklerinin `*_ENABLED` satırlarını sabit
beklemesi) bu oturumda tek tek doğrulanmadı. İlgili dilimde doğrulanmadan
uygulanmamalı.

## 3. Reddedilen iddialar

- **T2: "CRM `prospect → active` geçişinin reddedilmesi bir hata."** Yanlış.
  `SERVORA_MED_API_DRAFT.md:409-410` aktivasyonun yalnızca `inactive`
  durumundan yapılabileceğini açıkça söylüyor. Davranış kasıtlı.
- **T2 Top 5 #5: "`weekly_report_recurrences` bağlılığını
  `people/repository.ts`'den çıkar."** Kabul edilmiş kararla çelişiyor.
  `DECISIONS.md:2221-2226`, emekli edilen tekrar özelliğinin personel silme
  engellerini tarihsel satırlar ve kullanıcı ilişkileri için bilerek
  koruyor.
- **T3 ölü kod adayları içindeki iki yanlış pozitif** (dış inceleme buldu,
  lead doğruladı):
  - `web/scripts/of01-acceptance-reset-browser.mjs` sahipsiz değil;
    `SERVORA_MED_MVP_SLICES.md:779` doğrudan çağırıyor.
  - `report-trend-bars--density-compact` ölü CSS değil; sınıf adı
    `web/src/reports/report-charts.tsx:171-174` içinde dinamik üretiliyor.

## 3a. Dış inceleme kontrolü (2026-11-25)

Bağımsız bir dış inceleme aynı SHA (`c3b3330`) üzerinde yapıldı. Lead tüm
iddiaları kodda yeniden kontrol etti ve hepsi doğru çıktı. Bu raporun
bulgularını genişletenler:

- V10'u genişletti: onay yolu (`service.ts:5739`) da bayrağa bağlı, atlanan
  sorgu iş çakışmalarını da kapsıyor, test hep takvim açık.
- V11'i (tür/durum devralma) ekledi.
- V9'u kurtarma yoluyla genişletti.
- İki yanlış pozitif ve bir karar çelişkisi buldu (bkz. §3).
- `assertDeliveryReadyForSubmission` (`job-cards/policy.ts:420`) yalnızca
  `server/tests/job-card-policy.test.ts`'den çağrılıyor. Üretim yolu
  `submission-policy.ts` + `service.ts:7387`. Kaldırmadan önce eski testin
  koruduğu senaryolar gerçek komut üzerinde doğrulanmalı.
- Derleyicinin `--noUnusedLocals --noUnusedParameters` probu sunucuda 24,
  web'de 21 kullanılmayan bildirim gösteriyor. Bunlar temizlik adayı,
  mimari engel değil.

Dış incelemenin sıra önerisi: önce JOB-012 sapmasını kapatmak, sonra
Depo/Stok'ta tek bir stok hareketini uçtan uca kurmak. Örnek: teslimata
bağlı stok çıkışında JobCard teslimat ve onayı, Depo ise hareketi ve bakiyeyi
sahiplenir. Kabul ölçütleri: tekrarlanan komut ikinci hareket oluşturmaz;
modül açıldığında eski teslimatlar kendiliğinden stok düşmez. Overview
çalışma zamanı açma/kapamayı, Depo dilimi veri sahipliğini sınar. Bu, §5
sırasıyla uyumlu; JOB-012 düzeltmesi §5'e bağımsız ilk iş olarak eklendi.

## 3b. İki ek değerlendirmenin kontrolü (2026-11-25)

Ürün sahibinin paylaştığı iki ek değerlendirme lead tarafından `c3b3330`
üzerinde satır satır kontrol edildi. Olgusal iddiaların hepsi doğru çıktı.

### A. Haftalık Rapor sahipliği önerisi

Öneri: JobCard yaşam döngüsü (kim gönderebilir, kim revizyon isteyebilir)
`job-cards`'ta kalsın. Hafta, sorular ve taslak hazırlığı `weekly-reports`'a
geçsin. Gönderim, kart durumu + rapor kopyası + geçmişi tek transaction'da
yazsın. İlk adım yalnızca gönderimin ayrılması olsun.

Kontrol sonucu:

- **Atomiklik zaten var.** Gönderim kopyası, durum geçişi ve aktivite ile
  aynı transaction'da yazılıyor (`job-cards/service.ts:7628-7640`). Önerinin
  istediği davranış mevcut. Eksik olan **sahiplik**. Önerilen üç testin
  (eksik rapor kartı ilerletmez, tekrarlanan istek ikinci gönderim
  oluşturmaz, kayıt hatasında ikisi de geri alınır) mevcut testlerle
  karşılaştırılması gerekiyor; eksik olanlar eklenmeli, var olanlar taşınma
  sırasında korunmalı.
- **Yazma yolu ikiye bölünmüş (SSOT ihlali).** Üretimde `weekly_reports` ve
  `weekly_report_submissions` kayıtlarını `job-cards/repository.ts:5332,5369`
  yazıyor. `weekly-reports/repository.ts:265` içindeki
  `PostgresWeeklyReportRepository` aynı tablolara yazan ikinci bir yol, ama
  yalnızca testlerden kullanılıyor
  (`tests/weekly-report-atomic-draft-postgres.test.ts`,
  `tests/weekly-report-repository-postgres.test.ts`). Testler üretim yolunu
  değil, ikinci yolu doğruluyor olabilir; taşıma öncesi bu netleşmeli.
- `job-cards` içinde `'WEEKLY_REPORT'` dalları: `service.ts` 8,
  `repository.ts` 2, `policy.ts` 1, `submission-policy.ts` 1.

Değerlendirme: **katılıyorum.** Yalnızca gönderimle başlayan dar adım, Sol'un
"Haftalık Rapor ayrıştırması geniş bir işlem sınırıdır" uyarısıyla uyumlu.
Ayrıştırma registry'nin ön koşulu olmadan ayrı bir iş olarak kalıyor. Kapsamı
tek olmalı, ama korunması gerekenler: host JobCard ilişkisi, personel/hafta
benzersizliği, idempotency, dondurulmuş PDF modeli, offboarding.

Mekanizma önerisi (lead): gönderim doğrulaması tür başına bir
"gönderim katkısı" olarak tanımlanır ve `Record<JobCardType, …>` ile
tutulur. Bu hem Haftalık Rapor'u `job-cards`'tan çıkarır hem de V11'i kapatır:
yeni bir tür (ör. Bakım) eklendiğinde katkısı yazılmadıkça derleme başarısız
olur. Takvimdeki doluluk katkısıyla (§5a) aynı desen. Genel bir "iş türü
eklenti çatısı" kurulmaz; yalnızca gönderim noktası.

### B. Mühendislik ilkeleri değerlendirmesi

| İddia | Kontrol | Kanıt |
| ----- | ------- | ----- |
| Ürün oluşturmada route → servis → repository ayrımı temiz; ürün ve audit aynı transaction'da | Doğru | `products/service.ts:153-167` |
| Web'de `fetch()` yalnızca tek API dosyasında | Doğru (2 çağrı, ikisi de `api.ts`) | `web/src/services/api.ts:88,142` |
| `MessagingPage` çok sorumluluk taşıyor | Doğru: 1.230 satır, 38 `useState` | `web/src/messaging/MessagingPage.tsx` |
| Ürün oluşturma ve pilot içe aktarma aynı normalizasyonu kullanıyor | Doğru | `products/pilot-import.ts:62`, `products/service.ts:95` |
| Ürün alan sınırları web ve sunucuda elle kopyalanmış, değerler şu an aynı | Doğru (birebir kopya) | `web/src/product-constraints.ts:1-10`, `server/src/modules/products/constraints.ts:1-10` |
| Bildirim okuma/kaldırma sırasında bekleyen push'u sonlandıran SQL dört yerde | Doğru (4 `UPDATE web_push_deliveries`) | `notifications/repository.ts:167,206,245,…` |
| Raporlar tek `REPEATABLE READ READ ONLY` görüntüde okunuyor | Doğru | `reports/read-snapshot.ts:24-31` |
| `getUpcomingWork` arayüzde isteğe bağlı, takvim açıkken `!` ile zorunlu çağrılıyor | Doğru (çalışma zamanı denemesini tekrarlamadım; kod yolu açık) | `overview/repository.ts:25`, `overview/service.ts:36-38` |
| Overview, raporlamadan tek metot için bütün `ReportsReadModel`'e bağlı | Doğru (yalnızca `getWorkTypeDistribution`) | `overview/service.ts:4,23,47` |
| Web push worker'ı göndericiden yalnızca `send()` istiyor | Doğru | `web-push/sender.ts:33-35` |
| `clearCustomerAssignments` adaptörü açılışta kuruluyor ama üretimde çağrılmıyor; STAFF pasifleştirme offboarding'e zorlanıyor | Doğru | `index.ts:121,142`, `people/repository.ts:571-572` (yalnızca testlerden), `people/service.ts:263-265` |
| Demo veri analizi takvim, mesajlaşma, bildirim, push ilişkilerini kendisi biliyor | Doğru (~30 farklı tablodan okuma) | `demo-data/analyzer.ts:792-800` |

Lead notu: `PostgresCustomerAssignmentCleanup` portu, modüller arası yazma
için **doğru desen** (CRM, kendi tablosunu bir port üzerinden temizliyor). Ama
üretimde ölü; offboarding aynı işi `customers` tablosuna doğrudan SQL ile
yapıyor. Bu yüzden önerim portu silmek değil: offboarding'in modül
sözleşmesi (§5 adım 5 ön koşulu) tasarlanırken ya bu port canlandırılmalı
ya da bilinçli olarak kaldırılmalı.

Değerlendirmenin öncelik sırası (veri sahipliğini Depo'da gerçek bir işlemle
kanıtlamak; davranış riski taşıyan tekrarları önce düzeltmek; büyük
dosyaları bir sonraki iş değişikliğinin sınırından bölmek) §5 ile uyumlu.
Küçük bağımsız düzeltme adayları:

- Bildirim–push sonlandırma SQL'inin tek tanıma indirilmesi. Okundu ve
  kaldırıldı nedenleri ve atomik yazım korunur.
- Overview'un takvim bağımlılığının tip tarafından zorunlu kılınması.
- Ürün sınırlarının tek kaynaktan gelmesi. Bu, server/web arasında henüz
  olmayan bir paylaşılan sözleşme mekanizması gerektiriyor; T3'ün "drift
  guard" önerisiyle birlikte ele alınmalı, tek başına değil.

## 4. Sol'un düzeltmeleri (kabul edildi)

1. **İlk yeni dilim Overview ile başlamalı.** Takvim ve mesajlaşma, kendi
   kapatma kuralları doğrulanmadan panele bağlanmamalı. En riskli varsayım
   "enabled yalnızca erişimi kontrol eder" varsayımı (bkz. V10).
2. **Genel altyapılar registry'nin önüne konmamalı.** Genel olay
   namespacing'i, genel kullanıcı yaşam döngüsü kancaları ve Haftalık Rapor
   ayrıştırması ön koşul değil. Depo modülünün gerçekten tükettiği dar
   sözleşmeler, ilk gerçek tüketiciyle birlikte gelir (YAGNI).
3. **Operatör ayrı hesap ve ayrı oturumla çalışmalı.** `users` tablosuna
   bayrak eklemek müşteri hesabının parola ve yaşam döngüsünü operatör
   yetkisine bağlar. Dördüncü bir rol de `role !== 'STAFF'` gibi mevcut
   kontrolleri bozar. Önerilen: `/api/operator` altında ayrı cookie ve ayrı
   sunucu oturumu (süre sonu, iptal, rate limit, CSRF). Yetki verme ve
   kurtarma host kontrollü CLI ile yapılır. Müşteri ADMIN'i hiçbir yoldan
   operatöre erişemez. Audit operatör kimliğiyle ve aynı transaction'da
   yazılır.
4. **Kapatma semantiği.** Veri, FK, audit ve idempotency kayıtları korunur.
   Yeni istek ve claim kabulü durur. Başlamış işin tamamlanma veya bırakılma
   kuralı modüle göre belirlenir. Tick başında bayrak kontrol etmek, toplu
   claim ile gönderim arasındaki yarışı çözmez. Yeniden açarken bekleyen
   hatırlatıcılar topluca canlandırılmaz. Offboarding, modül kapalıyken de
   çalışmalı. SSE/replay, bildirim listesi, derin bağlantılar ve push kuyruğu
   aynı görünürlük kararına bağlanır. Açık SPA oturumu capability'yi yeniden
   çekebilmeli (bugün `auth/me` yalnızca açılışta çağrılıyor).
5. **Yeni kurulum kabulü boş DB'den fazlasını kapsamalı.** Mevcut kurulumun
   env değerlerini tek seferlik devralma, PWA manifestindeki sabit marka,
   restore sonrası modül durumu ve operatör oturumlarının akıbeti, mevcut
   host bootstrap ve release fence ile uyum.
6. **Descriptor minimal olmalı.** Sabit anahtar, operatör etiketi,
   env/altyapı ön koşulu, varsa capability eşlemesi ve korumalı route
   kaydı. İstenen durum ile yürürlükteki durum ayrı gösterilir. Bilinmeyen
   anahtar ve eksik ön koşul reddedilir. Bağımlılık ve worker alanları
   gerçek ihtiyaç doğunca eklenir. Dinamik eklenti yükleme, modül başına
   migration zinciri ve metadata'dan üretilen menü ilk dilimin kapsamı
   dışında.

## 5. Önerilen sıra

| Adım | İçerik | Ön koşul |
| ---- | ------ | -------- |
| −1 | **[Uygulandı: `fix/core-occupancy-reader`, DECISIONS.md SCH-001]** **Çekirdek doluluk okuyucusu + JOB-012 düzeltmesi:** dört doluluk sorgusu tek çekirdek okuyucuya indirilir (işler her zaman, `calendar_events` yalnızca modül açıkken); oluşturma, yeniden planlama, öneri, onay ve offboarding bunu takvim bayrağından bağımsız kullanır; `/available-slots` çekirdeğe alınır (§5b). Öneri ve onay her durumda çakışmayı reddeder. Kabul: çakışan öneri reddedilir; öneriden sonra saat dolarsa onay da reddedilir ve işin eski saati korunur; test takvim kapalı varyantı kapsar | Ürün sahibi kararı. Not: yönetici yeniden planlaması da (`service.ts:4173`) takvim kapalıyken çakışma kontrolü yapmıyor; yani bayrak kapısı "doluluğun sahibi takvim modülüdür" yönünde tutarlı bir tasarım. JOB-012 bayraktan söz etmiyor. Bu yüzden karar şu: doluluk kontrolü takvim modülünden bağımsız bir çekirdek kural mı (öneri, onay ve yeniden planlama her zaman kontrol eder), yoksa takvim modülüne mi ait (JOB-012 metni buna göre netleştirilir)? |
| 0 | Karar kaydı: çekirdek/modül sözleşmesi, operatör kimliği, tipli kurulum modül durumu (UI-002'ye uygun, JSONB torbası değil), kurulum profili, env'den tek seferlik geçiş | Ürün sahibi onayı |
| 1 | **Overview pilotu:** registry, operatör hesabı/oturumu + CLI, modül durumu tablosu + atomik audit, her zaman kayıtlı korumalı route, DB kaynaklı capability, operatör paneli, CI/env-example uyumu | Adım 0 |
| 2 | Messaging: katılımcı erişimi ve yeniden atama davranışı doğrulanır; gerekiyorsa job-cards okuma portu aynı dilimde | Adım 1 |
| 3 | Calendar: önce V10 sapması karara bağlanır (takvim kapalıyken çakışma kuralı ne olacak), sonra hatırlatıcı worker'ının kapatma/yeniden açma kuralları | Karar + Adım 1 |
| 4 | Kurulum profili + yeni müşteri kurulum runbook'u; kalan bayrakların sınıflandırılması (Assignment Window iş politikası, Web Push teslimat kanalı, host alerting işletim kontrolü; hepsi "ürün modülü" değil) | Adım 1 |
| 5 | Depo/Stok: MOD-001 sınırları içinde; ilk ihtiyaç duyduğu dar sözleşmelerle birlikte (veri sahipliği, `organization_id` kapsamlı okuma portları, kendi migration'ı, transaction içinde idempotency + audit, kullanıcı referanslarının offboarding/silme davranışı, restore doğrulaması) | Adım 1 + karar |
| 6 | Bakım: önce kapsam ve sınır kararı (bugün karar kaydı yok) | Karar |
| 7 | Muhasebe: AGENTS.md §13 gereği açık onay + MOD-001 A0 | Açık onay + karar |

Ayrı tutulacak işler (ön koşul değil): Haftalık Rapor'un `job-cards`'tan
ayrıştırılması, genel olay/audit namespacing dönüşümü, büyük dosyaların
bölünmesi, yedekleme audit atomikliği (V9, Backup çalışmasına yazılır). Ölü
kod, ilgili dilim o dosyaya dokunurken temizlenir.

## 5a. Takvim: çekirdek planlama + takvim modülü (ürün sahibi yön onayı, 2026-11-25)

Ürün sahibi aşağıdaki ayrımı yön olarak kabul etti. Bu henüz bir
`DECISIONS.md` kaydı değil. Karar kaydı, uygulayan PR ile birlikte ve
Takvim 2.0 tasarımıyla uyumlu biçimde yazılacak.

| Katman | İçerik | Konum | Pazarlama |
| ------ | ------ | ----- | --------- |
| Planlama (çekirdek) | İş saatleri (`scheduledAt`/`scheduledEndsAt`), personel doluluğu, çakışma kontrolü, atama penceresi | Çekirdek, her kurulumda açık | Her planda var |
| Takvim (modül) | Takvim ekranı ve görünümleri, kişisel kayıtlar (`calendar_events`), hatırlatıcı worker'ı | Modül, operatör panelinden açılır | Bugünkü takvim |
| Takvim 2.0 | Aynı modülün gelişimi; kapsamı Takvim 2.0 tasarımında belirlenir | Takvim modülü | Üst plan veya ek özellik |

Kural önerisi:

- Çekirdek doluluk kontrolü **her zaman** atanmış aktif işlere bakar.
  JOB-012 öneri ve onay, yönetici yeniden planlaması ve atama teklifi bu
  kontrolü takvim bayrağından bağımsız uygular. Bu, V10'u kapatır.
- Takvim modülü açıkken kişisel kayıtlarını doluluğa **katkı** olarak
  ekler. Kapalıyken yalnızca işler sayılır. Kayıtlar silinmez; modül tekrar
  açılınca etkileri geri gelir. Bekleyen hatırlatıcılar toplu olarak
  canlandırılmaz.
- Takvime bağlı JobCard kilitleri ve hatırlatıcı senkronu
  (`job-cards/service.ts:3859,4263`) aynı ayrıma göre sınıflandırılır:
  doluluk bütünlüğü için gereken kilit çekirdekte kalır, hatırlatıcı
  senkronu modülde kalır.
- Gelecek modüller (Bakım randevuları, Depo teslimat tarihleri, dış takvim
  senkronu) doluluğa aynı katkı yoluyla bağlanır. Dış kaynaklı kayıtların
  doluluğa nasıl katılacağı ayrıca karara bağlanmalı.

### 5b. Takvim 2.0 oturumundan gelen netleştirmeler (2026-11-25)

Kaynak: "Takvim 2.0 tasarımı" oturumu. Ürün sahibi orada dört açık noktayı
önerilen seçenekle yanıtladı. Henüz implementasyon yok; karar kaydı uygulayan
PR ile yazılacak.

Ürün sahibi kararları:

1. `/available-slots` çekirdek. Her kurulumda açık; takip işi saat seçicisi
   aynı kaynağı kullanır.
2. Mesai saatleri çekirdek veri: organizasyon geneli, UI-002'ye uygun tipli
   alan. Uygun saat araması bunu kullanır. Kapasite ve ekip görünümü modülde
   kalır.
3. İzin/"müsait değil" bloğu modülde kalır. Temel planda yokluk işleri
   engellemez; ihtiyaç doğarsa yeniden ele alınır.
4. Modül yeniden açıldığında kapalıyken oluşan çakışmalar tolere edilir ve
   takvimde işaretlenir (JOB-007 emsali). Otomatik çözülmez, açmayı
   engellemez.

Sınıflandırma:

- **Çekirdek:** `scheduledAt`/`scheduledEndsAt`; General Task'a isteğe bağlı
  zaman bloğu (ayrı karar gerekir); tek doluluk okuyucusu ve çakışma kontrolü
  (oluşturma, yeniden planlama, öneri, onay, offboarding); doluluk bütünlüğü
  kilitleri; `/available-slots`; çakışma hatasında en erken boş saat bilgisi;
  mesai verisi; son tarih (`due_date`); "Planlanacak" sorgusu (saatsiz
  General Task'lar).
- **Modül:** takvim ekranı (ay, hafta, gün), Bugün ajandası, boşluk
  gösterimi, `calendar_events` ve doluluğa katkısı, hatırlatıcı worker'ı ve
  iş hatırlatma senkronu (`service.ts:4260` ve benzerleri), Overview
  `upcomingWork`, `calendar.*` bildirimleri.
- **Takvim 2.0 / üst plan:** haftalık saatlik görünüm ve form ile taşıma,
  ekip gün/kapasite ekranı, sürükle-bırak, iş başlangıç hatırlatmaları;
  ileride tekrarlayan kayıtlar, katılımcılı toplantı ve özel kayıt gizliliği
  (her biri ayrı karar).
- **Ara durum:** "şimdiye taşı ve başlat" kısayolu ve çakışma açıklaması
  çekirdek işlemdir. Takvim ekranında gösterilmeleri modüle, iş detayında
  gösterilmeleri çekirdeğe aittir.

**Davranış riski (deploy kapısı):** Çekirdek kural, takvimi kapalı
kurulumlarda çakışan yeni iş oluşturmayı reddetmeye başlar. Deploy öncesinde
üretimdeki takvim bayrağı okunmalı ve bu değişiklik sürüm notuna yazılmalı.

## 6. Ürün sahibinin vermesi gereken kararlar

1. ~~JOB-012: doluluk kontrolü takvime mi ait, çekirdek mi?~~ Yön
   belirlendi: çekirdek planlama + takvim modülü katkısı (§5a). Karar kaydı
   Takvim 2.0 tasarımıyla birlikte yazılacak.
2. Operatör kimliği: ayrı hesap + ayrı oturum (önerilen) mi, yalnızca CLI mi?
3. Adım 0 karar kaydının kapsamı ve Overview pilotuyla başlanması.
4. Bakım modülünün kapsamı; Muhasebe için açık onay zamanı.
