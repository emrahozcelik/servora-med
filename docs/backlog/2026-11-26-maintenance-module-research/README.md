# Bakım (Maintenance) modülü araştırması — 2026-11-26

Durum: **araştırma raporu, karar değildir.** Hiçbir kod değiştirilmedi, hiçbir
uygulama yetkisi vermez. Kapsam ve sınır kararı ürün sahibinindir (bkz. §5).

Taban: `origin/main` @ `89bf6b1`. Yöntem: model-fleet ile altı DeepSeek araştırma
koşusu; lead (Claude) önemli iddiaları kaynakta yeniden doğruladı (§3).
Bağlayıcı girdiler: `AGENTS.md`, `DECISIONS.md` MOD-001, MOD-002, SCH-001,
`PRODUCT_REQUIREMENTS.md`,
[çekirdek + modüller araştırması](../2026-11-25-core-modules-architecture-research.md)
(V11, §5 adım 6, §5a).

## 1. Dizin

| Dosya | Konu | Run |
| ----- | ---- | --- |
| [01-jobcard-type-impact.md](01-jobcard-type-impact.md) | `job-cards` içinde yeni bir `MAINTENANCE` türünün çarptığı 49 dağıtım (dispatch) noktası, A/B/C sınıfı, ön koşul PR sırası | `20261126-141130-deepseek-4447` |
| [06-cross-module-and-web-impact.md](06-cross-module-and-web-impact.md) | `job-cards` dışı sunucu modülleri ve web istemcisi | `20261126-141130-deepseek-36b1` |
| [02-scope-options.md](02-scope-options.md) | Bir medikal/dental distribütör için "Bakım" ne demek; üç kapsam kesiti | `20261126-141130-deepseek-39d1` |
| [03-ownership-boundary.md](03-ownership-boundary.md) | JobCard ↔ Bakım ↔ CRM ↔ Depo sahiplik sınırı, aç/kapa, restore, offboarding | `20261126-141130-deepseek-2f4b` |
| [04-regulation-and-industry.md](04-regulation-and-industry.md) | Türk mevzuatı (teknik servis yönetmeliği, ÜTS, garanti, kalibrasyon) ve sektör pratiği | `20261126-141130-deepseek-8c7a` |
| [05-first-slice-proposal.md](05-first-slice-proposal.md) | En küçük uçtan uca ilk dilim, ön koşullar, sözleşmeler, kabul testleri | `20261126-145240-deepseek-3bb2` |

Tam worker raporları `~/.claude/model-fleet/runs/<run>/worker-report.md`
altındadır. 05, diğer beş dosyayı girdi olarak kullandı.

## 2. Özet

1. **Ürün sahibinin hipotezi kodla uyumlu.** Atama, yaşam döngüsü, yönetici onayı,
   doluluk ve audit JobCard'da kalır (MOD-001 §1). Cihaz kimliği (kurulu taban),
   servis geçmişi, garanti ve bakım planları Bakım modülüne aittir. Tek ekleme:
   bir ziyaretin türe özgü verisi (yapılan iş, ölçümler, uygunluk kararı) de
   serbest metin not olarak değil, `job_card_id` ile bağlı modül tablosunda
   tutulmalı. Haftalık Rapor'un `weekly_reports` deseni emsal (01, 03, 06).
2. **Bugün hiç cihaz kavramı yok.** Müşteri tek serbest metin adresli; şube veya
   lokasyon tablosu yok (`crm/types.ts:12-28`). Teslimat kalemlerinde isteğe bağlı
   `serial_no` / `lot_no` kolonu ve API alanı var
   (`002_delivery_tracer.sql:150-151`, `job-cards/handlers.ts:168`). Ama hiçbir web
   ekranı bu alanları yazmıyor veya göstermiyor. Teslimatlardan kurulu taban
   üretilebilir; seri numaraları ise boş başlar.
3. **Asıl risk zamanlama tarafında, yaşam döngüsünde değil.** Beş ayrı
   `SALES_MEETING | PRODUCT_DELIVERY` yüklemi (doluluk SQL'i `occupancy.ts:70`, planlı
   aralık `job-card-duration.ts:42-44`, kanonik süre `:5-8`, atama teklifi
   `assignment-offer-policy.ts:35-37`, sahada iş `customer-schedule.ts:16-18`) yeni
   türü sessizce "açık uçlu genel görev" yapar. Sonuçta doluluk yok,
   `409 CALENDAR_CONFLICT` yok ve süre yok. Bu SCH-001'e aykırı. Oluşturma ise
   fail-closed: `create-input.ts:53-56` ve DB `job_cards_type_check` (`057:5-7`) yeni
   türü reddeder.
4. **PR #513 yalnızca iki noktayı kapatıyor** (yaşam döngüsü durum zinciri ve
   gönderim türü zinciri). Yaklaşık 40 nokta daha var. Bakım türünden önce birkaç
   küçük refactor PR gerekiyor (§4).
5. **Web, tür listesinin kendi kopyasını tutuyor** (`web/src/jobs/jobs-api.ts:38-53`)
   ve sıkı parser kullanıyor (`oneOf(..., JOB_CARD_TYPES)`, `:977,1012,1034`).
   Sunucu yeni türü web'den önce döndürürse liste veya detay yanıtının tamamı
   `INVALID_RESPONSE` ile düşer.
6. **Mevzuat en güçlü dış etken.** "Sağlık Hizmet Sunumu Kapsamında Kullanılan
   Tıbbi Cihazların Teknik Servis Hizmetlerine Dair Yönetmelik"
   (RG 26/5/2023-32202) her müdahale için asgari alanlı bir teknik servis raporu
   ve 10 yıl kayıt saklama istiyor. Uyum tarihi 1/7/2027'ye ertelenmiş
   (RG 30/12/2025-33123). ÜTS'de servis olayı için hareket bildirimi yok; bu
   yüzden ÜTS entegrasyonu şart değil, ama ÜTS kimlikleri saklanmalı. Kalibrasyon
   kliniğin yükümlülüğü ve TİTCK yetkili kuruluşlarca yapılıyor (04).
7. **Önerilen ilk dilim (05):** kurulu taban + tek bir `MAINTENANCE` ziyaret türü.
   Planlı aralıklı (60 dk) ve doluluğa katılan bir ziyaret, zorunlu yönetici onayı,
   modül panelinden açılan bir kurulum modülü (varsayılan kapalı). Plan, PDF,
   imza, fotoğraf, yedek parça stoğu ve sözleşme yok. 02'nin daha dar alternatifi
   yalnızca cihaz kaydı (tür yok). İki öneri birbirini dışlamıyor; fark sıralamada
   (§4.3).

## 3. Lead doğrulaması (bu oturumda, `89bf6b1` üzerinde)

| İddia | Sonuç | Kanıt |
| ----- | ----- | ----- |
| Doluluk yalnızca SM/PD sayıyor | Doğru | `job-cards/occupancy.ts:70` |
| Kanonik süre ve planlı aralık yalnızca SM/PD | Doğru | `job-card-duration.ts:5-8,42-44` |
| Atama teklifi ve sahada iş yüklemi SM/PD | Doğru | `assignment-offer-policy.ts:35-37`, `customer-schedule.ts:16-18` |
| Teslim süresi kuralı yalnızca SM'yi ayırıyor | Doğru | `overdue-incidents.ts:139-140` |
| Oluşturma yalnızca üç türü kabul ediyor | Doğru | `create-input.ts:53-56` |
| DB tür CHECK'leri | Doğru | `057_sale_from_visit.sql:5-7`, `027_follow_up_proposals.sql:37` |
| Web'in tür listesi kopya ve sıkı parser'da | Doğru | `web/src/jobs/jobs-api.ts:38-53,977,1012,1034` |
| `serialNo` web'de hiçbir `.tsx` dosyasında yok | Doğru | `git grep serialNo -- 'web/src/**/*.tsx'` boş |
| Müşteride şube/adres varlığı yok | Doğru | `crm/types.ts:12-28` |
| Restore ilişki listesi elle tutuluyor | Doğru | `backup/restore/postgres.ts:11-25` |
| Registry yalnızca `OVERVIEW`; `legacyEnvKey` zorunlu; test okuyucusu tek boolean | Doğru | `installation-modules/registry.ts:7-24`, `state.ts:69-80`, `074_*.sql:59-62` |
| **06 §3.5 ve 05 §2.3:** "Haftalık rapor dalı #513'ten sonra birleşirse `never` koruması sessizce silinir, V11 yeniden açılır" | **Yanlış** | `git merge-tree --write-tree origin/refactor/job-card-exhaustive-dispatch origin/refactor/weekly-report-submission` çakışmasız. Birleşik `submission-policy.ts` hem `evaluateWeeklyReport` içe aktarımını hem `const unhandledType: never` korumasını içeriyor. Haftalık rapor dalı o satırlara dokunmuyor, yalnızca taban kodunda eski üçlü ifadeyi taşıyor. #513 PR açıklaması da aynı `merge-tree` kontrolünü belirtiyor |
| **01 §1 madde 7:** "`submission-policy` hunk'ı metinsel çakışır, rebase gerekir" | **Yanlış** (aynı kanıt) | Yukarıdaki satır |
| **03 özet madde 3:** "#513 ile tür eklemek artık derleme kontrollü" | **Abartılı** | #513 yalnızca iki noktayı kapsıyor ve henüz birleşmedi (açık). Doğru tablo 01'de |
| Teknik servis yönetmeliği RG 26/5/2023-32202 | Doğru (resmî kaynak) | [TİTCK PDF](https://titck.gov.tr/storage/Archive/2023/contentFile/Sa%C4%9Fl%C4%B1k%20Hizmet%20Sunumu%20Kapsam%C4%B1nda%20Kullan%C4%B1lan%20T%C4%B1bbi%20Cihazlar%C4%B1n%20Teknik%20Servis%20Hizmetlerine%20Dair%20Y%C3%B6netmelik_1740ea01-3632-455e-ab19-dbfe7b180d28.pdf), arama 2026-11-26 |
| Uyum tarihinin 1/7/2027'ye ertelenmesi (RG 30/12/2025-33123) | Yalnızca ikincil kaynakla doğrulandı | [hukukcularevi.com](https://hukukcularevi.com/tibbi-cihaz-teknik-servis-yonetmeligi-1-temmuz-2027-uyum-suresi-yetkili-teknik-servis-calisma-belgesi-garanti-yonetmelik-5-9-10-13-16-gecici-1/), 2026-11-26. Resmî Gazete metni bu oturumda açılmadı |

04'ün öteki mevzuat iddiaları (ÜTS verme/alma bildirimi, B2B garanti maddeleri 25/A–25/Ç,
yedek parça süreleri, kalibrasyon yetki rejimi, sektör bakım aralıkları) lead
tarafından tek tek doğrulanmadı. Dosyadaki UNVERIFIED işaretleri geçerli. Ürün
kararına dayanak yapılmadan önce resmî metinle karşılaştırılmalı; gerekiyorsa
bir hukukçuya sorulmalı.

## 4. Koşular arasındaki çelişkiler ve lead değerlendirmesi

1. **İlk dilim: yalnızca cihaz kaydı mı, cihaz + ziyaret türü mü?**
   02 Cut A'yı öneriyor: tür yok, doluluk değişikliği yok, küçük. 05 ise cihaz
   kaydı + `MAINTENANCE` türünü öneriyor. 05'e göre ziyaret olmadan hipotez test
   edilemez ve `GENERAL_TASK` taşıyıcısı doluluk ile onaya gönderme hazırlığını
   sessizce kaybettirir (03 §3).
   *Lead:* İkisi sıralı birleştirilebilir. Cut A tek başına çekirdeğe dokunmaz ve
   ön koşul refactor'larıyla (§4.3) paralel ilerleyebilir. Ziyaret türü ise
   ancak o refactor'lar bitince eklenmeli. Karar sahibin (§5 soru 1).
2. **Modül varsayılanı ve env anahtarı.** 02, Cut A'yı önce bir legacy env
   anahtarının arkasına koyuyor (MOD-002 madde 7'ye dayanarak). 03 ve 05 env
   anahtarı icat etmiyor; registry'de `defaultEnabled:false` ve yeni bir
   `INSTALL_DEFAULT` kaynağı öneriyor.
   *Lead:* MOD-002 madde 7 mevcut modüllerin geçişi için. Yeni bir modüle env
   anahtarı açmak, panele taşıma hedefiyle çelişir. 03/05 yaklaşımı tutarlı.
   Bu da registry sözleşmesinde küçük bir değişiklik demek: `legacyEnvKey`
   isteğe bağlı olur, `074` CHECK'leri genişler.
3. **Ön koşul sırası ve haftalık rapor dalı.** 01 ve 06 doğru tespit ediyor:
   asıl iş beş yüklemi tek bir tür-davranış tablosunda toplamak, sonra süre,
   iş aksiyonları ve teslim süresi kuralını exhaustive yapmak. Haftalık rapor
   dalıyla ilgili "çakışma" ve "koruma silinir" uyarıları yanlış (§3). Bu
   refactor'lar haftalık rapor dalını beklemek zorunda değil. Yine de
   `service.ts` ve `repository.ts` içindeki noktalar o dal birleşince ele
   alınmalı, çünkü dal bu dosyaları yeniden yazıyor. 05'in önerdiği "`never`
   korumasının varlığını test eden kaynak düzeyi koruma" gereksiz değil ama
   acil de değil.
4. **Ziyaret saati ve atama penceresi.** 01 bunu açık soru olarak bırakıyor. 03
   ve 05 ilk dilimde ziyareti 60 dk planlı aralık olarak tanımlıyor; atama
   teklifi (JOB-010) ve erken başlama yok.
   *Lead:* Makul bir varsayılan, ama ürün kararı (§5 soru 2).
5. **Lokasyon/şube.** 02 ve 05 cihazda serbest metin `location_label` diyor. 03
   Bakım'a ait bir `maintenance_sites` tablosu öneriyor (ileride CRM adres
   defterine geçiş yolu yazılarak).
   *Lead:* İlk dilim için serbest metin yeterli. Çok binalı hastane müşterisi
   varsa erken karar gerekir.
6. **Modül kapalıyken okuma.** Overview kapalıyken 404 dönüyor
   (`overview/service.ts:14-18`). 03 ve 05, kapalı modülde geçmiş kartların ve
   cihaz geçmişinin okunabilir kalmasını öneriyor (yazma kapalı, okuma açık).
   *Lead:* Bu MOD-002'den farklı bir anlam. Geçmiş JobCard'lar zaten çekirdekte
   görünür kalır. Kapalı modülde cihaz ekranının da açık kalması ayrı bir karar
   (MNT-001).
7. **Raporlar.** 06'ya göre dört kapalı SQL kovası yeni türü dışarıda bırakıyor,
   ama toplamlar onu sayıyor; sonuçta toplam, parçaların toplamına eşit olmaz.
   05 her iki tarafa kova eklemeyi öneriyor.
   *Lead:* DOM-006'ya uygun (ciro yok). Bakım ziyaretinin "üretken iş" sayılıp
   sayılmayacağı ürün kararı.

## 5. Ürün sahibinin vermesi gereken kararlar

Önem sırasına göre. Çoğu cevap ilk dilimin boyutunu doğrudan değiştirir.

1. **İlk dilim:** yalnızca cihaz kaydı (02 Cut A, çekirdeğe dokunmaz) mı, cihaz
   kaydı + bakım ziyareti türü (05) mü? Lead önerisi: Cut A ile başla; ön koşul
   refactor'larını paralel yürüt; ziyaret türünü ikinci dilimde ekle.
2. **Bakım ziyareti planlı ve doluluğa katılan bir iş mi?** Yani satış görüşmesi
   gibi başlangıç ve bitiş saati olan, teknisyenin takvimini kilitleyen bir iş mi?
   Varsayılan süresi ne (60 dk mı)? Atama teklifi penceresi ve erken başlama
   olacak mı?
3. **Şirketin hukuki rolü ve servis modeli:** ithalatçı/üretici mi, yoksa başka
   bir firmanın garantisiyle çalışan bayi mi? Teknik servisi kendisi mi yapıyor
   (teknik servis belgesi, teknik müdür), yoksa yetkili servise mi veriyor? Bu
   cevap, garanti ve servis raporunun zorunlu mu, yalnızca faydalı mı olduğunu
   belirler (02, 04).
4. **Teknisyenler kim?** Mevcut STAFF kullanıcıları mı, yoksa yeni bir rol ya da
   grup mu? Bugün rol kümesi `ADMIN|MANAGER|STAFF` ile sabit. Teknisyen sahada
   arıza ziyareti açabilecek mi, yoksa ziyareti yalnızca yönetici mi oluşturacak?
5. **Bakım ziyareti yönetici onayı gerektirsin mi?** 05 onayı zorunlu
   varsayıyor. Klinik karşı imzası ayrı ve sonraki bir alan.
6. **Cihazlar bugün seri numarasıyla izleniyor mu, nerede?** (Excel, ERP,
   üretici portalı.) Cevap, kaydın teslimatlardan mı tohumlanacağını yoksa elle mi
   girileceğini belirler.
7. **Bakım ücretli mi?** Yıllık sözleşme ya da çağrı başına fatura varsa
   Muhasebe kapsamı öne gelir (MOD-001 madde 3).
8. **Servis raporu, imza ve 10 yıl saklama:** veritabanı kaydı yeterli mi,
   imzalı PDF ya da tarama arşivlenmeli mi? Elle imza mı, dijital imza mı?
   Dijital imza ve fotoğraf, bugün olmayan bir dosya depolama altyapısı
   gerektirir (03 Q-D).
9. **Modül kapalıyken** cihaz ve servis geçmişi okunabilir kalsın mı, yoksa
   Overview gibi tamamen kapansın mı? Yeni kurulumda varsayılan açık mı kapalı mı?
10. **Yedek parça:** ilk dilimde serbest metin not mu olsun, yoksa Depo modülüne
    kadar hiç alan olmasın mı? Cihazın seri kimliği Bakım'a ait bir alan mı
    (lead ve 03 önerisi), yoksa Depo açıkken Depo seri kaydından mı türemeli?
    (Depo/Stok araştırma oturumuyla birlikte karar verilmeli.)

## 6. Önerilen sonraki adımlar (karar sonrasına bağlı)

1. Ürün sahibi §5'i yanıtlar → `DECISIONS.md` MNT-001 karar kaydı (uygulayan PR
   ile birlikte yazılır).
2. Bakım türünden bağımsız ön koşul refactor'ları (01 §5, 05 §2). Önce beş
   SM/PD yüklemini tek bir tür-davranış tablosunda toplama; sonra #513'ün
   birleşmesi; sonra süre, iş aksiyonları ve teslim süresi kuralını exhaustive
   yapma; web tür listesi parite kontrolü. `service.ts` ve `repository.ts`
   içindeki adımlar haftalık rapor dalı birleştikten sonra yapılır.
3. Registry sözleşmesi: env anahtarı olmayan modül için `defaultEnabled` /
   `INSTALL_DEFAULT` (05 §2.7).
4. İlk dilim (§5 soru 1'in cevabına göre) ve 05 §5'teki kabul testleri.
