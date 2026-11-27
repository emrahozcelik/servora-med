# Mesajlaşma → kurulum modül kaydı (MOD-002 deseni) — araştırma paketi

- **Tarih:** 2026-11-26
- **Durum:** Tarihsel araştırma. Kararlar sonradan kabul edildi ve uygulandı:
  `DECISIONS.md` MOD-003 (R0, PR #520) ve MOD-004 (MSG-001 PR #521, MSG-002 PR #523).
  Geçerli sözleşme [docs/features/messaging-module-registry.md](../../features/messaging-module-registry.md);
  bu paket ve `05-slice-contract-draft.md` yalnızca bağlam içindir, politika sahibi değildir.
- **Taban:** `origin/main` @ `fca614b`.
- **Kaynak araştırma:** [2026-11-25 çekirdek/modül mimari araştırması](../2026-11-25-core-modules-architecture-research.md)
  §4 madde 4 (kapatma semantiği), §5 adım 2 (Messaging dilimi), bulgular V4, V6, V7.
- **Yöntem:** Beş DeepSeek araştırma çalıştırması (model-fleet), ardından lead tarafından
  aşağıdaki kilit iddiaların kodda yeniden doğrulanması.

## Dosyalar

| Dosya | İçerik | Fleet run |
| ----- | ------ | --------- |
| [01-prior-decisions.md](01-prior-decisions.md) | Mesajlaşma hakkındaki tüm karar, plan, PR ve kanıtlar; kabul/taslak/tarihsel ayrımı; çelişkiler C1–C10; sorular Q1–Q12 | `20261126-154819-deepseek-48ba` |
| [02-runtime-gates.md](02-runtime-gates.md) | Bayrağın okunduğu her yer (S1–S30 sunucu, W1–W12 web), açılışta mı istek başına mı | `20261126-154819-deepseek-1119` |
| [03-disable-semantics.md](03-disable-semantics.md) | Yüzey yüzey kapatma/yeniden açma davranışı (S1–S15), kararlar OD1–OD9 | `20261126-154819-deepseek-5e8b` |
| [04-access-and-read-port.md](04-access-and-read-port.md) | Çekirdek tablolara giden 26 SQL ifadesi, katılımcı erişimi, yeniden atama zaman çizelgesi, okuma portu önerisi | `20261126-154819-deepseek-ef67` |
| [05-slice-contract-draft.md](05-slice-contract-draft.md) | Dilim sözleşmesi taslağı (descriptor, migration, takeover, HTTP tablosu, MS kabul senaryoları, arayüzler), DECISION-1…9 | `20261126-154819-deepseek-cd61` |

Not: 03, 04 ve 05 çalıştırmaları fleet ledger'da `OWNERSHIP_VIOLATION` olarak görünür.
Sebep, beş çalıştırmanın aynı klasörde paralel yazmasıdır (her biri diğerlerinin
dosyalarını "değişmiş" gördü). Her dosyayı yalnızca kendi çalıştırması yazdı; kaynak kodda
değişiklik yok (`git status` yalnızca bu klasörü gösterir).

## Özet

1. **Bayrak bugün süreç başına bir kez okunuyor.** `MESSAGING_ENABLED` yalnızca
   `config.ts:910`'da okunur. Üç açılış kopyası vardır: route kaydı (`app.ts:521`),
   `MessagingService.enabled` (`messaging/service.ts:118`, kapı `:1087`) ve Overview'un
   `messagingEnabled` + okuma portu (`app.ts:362-375`). Kapalıyken `/api/messaging/*` kayıtlı
   değildir ve Fastify'ın kendi 404 gövdesini döner (uygulamanın `{error, code}`
   sözleşmesi dışında).
2. **Kayıt (registry) tek modüle kilitli.** `registry.ts:7-15` literal tipler,
   `takeover.ts` tek boolean, migration 074'te iki CHECK (`IN ('OVERVIEW')`). Mesajlaşma
   yeni bir migration gerektirir. 18 test dosyası migration head'i `074` olarak sabitler;
   OP9 testi `MESSAGING`'i "bilinmeyen anahtar" olarak doğrular
   (`operator-pilot-postgres.test.ts:1119-1137`).
3. **075 çakışması gerçek.** Depo (W0, PR #517) ve Muhasebe (PR #515) araştırmaları da
   075'i öneriyor; katalog aynı numarayı reddeder (`migration-catalog.ts:99-105`).
4. **Messaging'in env sırrı veya altyapısı yok.** Web push (VAPID) ayrı
   `WEB_PUSH_ENABLED` kanalıdır. Bu yüzden env tavanı gerekmez (MOD-002 §4). Staging örneği
   `MESSAGING_ENABLED=true` ve CI bunu zorunlu tutuyor (`ops/ci/verify-env-examples.sh:59,68-71`).
   Üretim örneğinde anahtar yok; takeover orada `false` alır (gerçek host değeri bu
   oturumda görülmedi).
5. **Dört yüzey bayrağa hiç bağlı değil:** SSE replay (`realtime/service.ts:131-153`),
   bildirim listesi, web push kuyruğu (`web-push/dispatcher.ts:281`) ve service worker'ın
   sabit derin bağlantı listesi (`web/public/service-worker.js:3`). Bunlar bugünkü
   env-kapalı durumunda da böyledir. Tarihsel Phase U planı "notification projection"ın
   kapanmasını istiyordu; bu hiç uygulanmadı (01 C2).
6. **Offboarding, demo veri ve yedekleme modülden bağımsız** ve öyle kalmalı.
   Offboarding katılımcıları ham SQL ile taşır (`people/offboarding.ts:1011-1042`), bu
   yüzden modül kapalıyken de çalışır.
7. **Erişim kuralı:** ADMIN/MANAGER için aynı organizasyon yeterlidir. STAFF için hem
   kalıcı katılımcı satırı hem de JOB konuşmasında canlı `job_cards.assigned_to = actor`
   gerekir (`messaging/policy.ts:45-63`, lead tarafından okundu).
8. **Yeniden atama boşluğu (kilit bulgu).** A→B atamasında A erişimini PATCH anında
   kaybeder. B yalnızca istemcinin önerdiği, yöneticinin onayladığı M9 senkronundan sonra
   katılımcı olur (`web/src/jobs/useReassignmentConversationSync.ts`; PR #131: "no
   automatic membership synchronization", "skip leaves membership dormant"). Modül
   kapalıyken senkron önerilemez; yeniden açılınca B konuşmaya giremez ve tekrar deneme
   yolu yoktur. Bu, modül açıkken "Şimdi değil" veya hata durumunda da var olan bir
   boşluktur (04 G1).
9. **Okuma portu bu dilimde gerekmiyor.** Kayıt taşıması yetkilendirme SQL'ini
   değiştirmez. V4'teki beş satır gerçekte beş çekirdek tabloya dokunan 26 ifade; bu ayrı
   bir sınır işi (04 §12).
10. **Web zaten capability'ye göre çalışıyor.** Eksik olan tek tetik şu: mesajlaşmadan
    404 gelince `/api/auth/me` zorla yeniden doğrulanmalı. Bugün bu yalnızca Overview'da
    var (`App.tsx:235`). Ayrıca `MessagingPage.tsx:349-357` 404'ü "üyelik kaldırıldı"
    sanıp sessizce temizliyor.

## Lead doğrulaması (bu oturumda koddan okundu)

| İddia | Kanıt | Sonuç |
| ----- | ----- | ----- |
| Route yalnızca env açıkken kayıtlı; servis bayrağı kurulumda yakalanıyor | `app.ts:521-531`, `messaging/service.ts:118,1086-1088` | Doğru |
| Overview okuma portu ve bayrağı açılışta sabit | `app.ts:362-375` | Doğru |
| `/login` ve `/me` yalnızca Overview'u istek başına okuyor | `auth/handlers.ts:28-48` | Doğru |
| Kapı, idempotency çözümünden önce | `messaging/service.ts:545-551` (`requireEnabled()` ilk satır) | Doğru |
| OP9 testi MESSAGING'i bilinmeyen anahtar sayıyor | `operator-pilot-postgres.test.ts:1117-1137` | Doğru |
| Staging CI `MESSAGING_ENABLED=true` istiyor; üretim örneğinde anahtar yok | `verify-env-examples.sh:59,68-71`; `grep MESSAGING ops/examples/*` | Doğru |
| STAFF erişimi = katılımcı + canlı atama | `messaging/policy.ts:45-63` | Doğru |
| M9 bilinçli olarak açık (otomatik olmayan) senkron | PR #131 gövdesi (Closes #130) | Doğru; DECISIONS.md'de kaydı yok |
| Mesaj sayfası 403/404'te seçimi sessizce temizliyor | `MessagingPage.tsx:349-357` | Doğru |
| Web push dispatcher 5 sn'de bir tarar, teslimat TTL 24 saat | `web-push/dispatcher.ts:17,21` | Doğru |
| Açık PR'larda 075 migration'ı yok | `gh pr list --state open`, `origin/main` head = 074 | Doğru (yalnızca araştırma PR'ları 075 öneriyor) |

## Araştırma dosyaları arasındaki çelişkiler

| # | Konu | 03 diyor | 05 diyor | Lead notu |
| - | ---- | -------- | -------- | --------- |
| K1 | Kuyruktaki mesaj push'ları (kapatınca) | Dispatcher modül durumunu okuyup `MODULE_DISABLED` ile bırakır | Yazma yok; kuyruk boşalır | Dispatcher 5 sn'de bir çalıştığı için pratikteki kuyruk birkaç saniyelik; yalnızca başarısız teslimatlar 24 saate kadar yeniden denenir. Dispatcher'a modül okuması eklemek çekirdek push'a yeni bağımlılık getirir. Lead önerisi: **A (yazma yok)**. |
| K2 | Kapalıyken yeniden atama | Katılımcı senkronunu JobCard atama transaction'ına (çekirdeğe) taşı | İstemci yönetimli; sunucuda kapatılacak bir şey yok | 03'ün önerisi PR #131'deki kabul edilmiş M9 tasarımıyla ("otomatik üyelik senkronu yok") çelişiyor. 05 ise kalıcı erişim boşluğunu yazmıyor. Karar ürün sahibinin (Karar 3). |
| K3 | Kapalıyken idempotent tekrar | Kapı önce, tekrar 404 alır; açılınca normal replay | Aynı, "kabul" | 02 F4 bunu AGENTS.md §7 riski olarak işaretliyor. Karar 5'te açıkça soruluyor. |
| K4 | Kapı yeri | Her zaman kayıtlı route + istek başına okuma | Route `preHandler` (11 route, servis bayrağı silinir) | İkisi uyumlu. Lead önerisi: tek bir `preHandler` kapısı; Overview'un servis içi kapısı ise Overview'da kalır. |

## Ürün sahibi incelemesi (2026-11-26)

Sonuç: `RESEARCH_ACCEPTABLE — CONTRACT_REVISION_REQUIRED`. Kabul edilen sözleşme (inceleme kararlarıyla revize edildi):
[docs/features/messaging-module-registry.md](../../features/messaging-module-registry.md).

| Karar | Araştırma önerisi | Ürün sahibi |
| ----- | ----------------- | ----------- |
| 1 Kapatma | Tamamen gizli | Kabul |
| 2 Eski bildirimler | Görünür kalsın | **Değişti:** kapalıyken listeden ve sayaçtan gizlenir, veri korunur |
| 3 Yeniden atama | M9 korunur | **Değişti:** sonradan senkron yapılabilir (otomatik senkron yok) |
| 4 Push kuyruğu | Dokunulmaz | **Değişti:** bekleyen mesaj push'ları sonlandırılır, yeniden açılınca gönderilmez |
| 5 Idempotent tekrar | 404 | Kabul |
| 6 Migration 075 | Bu dilim alır | **Değişti:** ortak registry genişletmesi tek seferde; anahtarlar kodda sabit ve doğrulanabilir |
| 7 Env tavanı | Yok | Kabul |
| 8 Onay metni | "Veriler silinmez." | Kabul; etkiler de listelenir |
| 9 Sözleşme yeri | feature doc + MOD-003 | Kabul |
| SSE replay | Değişmez (varsayılan) | **Değişti:** canlı akış ve replay modül durumuna uyar |

Ek iş (ürün sahibi): offboarding'de okundu işaretçisi, pasif katılımcıya bildirim yok,
senkron yetkisi tutarsızlığı, iptal/geçersiz iş testleri. Teslim sırası R0 → MSG-001 →
MSG-002 → MSG-003 (sözleşme §1).

## İlk karar listesi (tarihsel, yukarıdaki inceleme geçerlidir)

Önerilen seçenek her maddede ilk sıradadır.

1. **Kapatma ne demek?**
   - **A (önerilen):** Tamamen gizli. Tüm `/api/messaging/*` uçları `404 NOT_FOUND`, durum
     okunamazsa `503 MODULE_STATE_UNAVAILABLE` (Overview gibi). Veri, FK, audit ve
     idempotency kayıtları korunur; hiçbir şey silinmez.
   - B: Yöneticiye salt-okunur geçmiş. Ayrı bir yetki yüzeyi gerektirir; bu dilimin
     dışında.
2. **Mevcut mesaj bildirimleri ve derin bağlantılar (kapalıyken)?**
   - **A (önerilen):** Bildirimler listede kalır ve okundu yapılabilir. Tıklama `/jobs`'a
     yönlenir (bugünkü env-kapalı davranışı).
   - B: Kapalıyken `message.received` satırları listeden ve sayaçtan gizlenir. Bildirim
     modülü modül durumunu okumak zorunda kalır.
3. **Kapalıyken yapılan yeniden atamada yeni personelin konuşmaya girmesi?**
   - **A (önerilen bu dilim için):** M9 tasarımı korunur. Kapalı modül, yöneticinin
     "Şimdi değil" demesiyle aynı sonucu verir ve bu belgelenir. Yeniden deneme yolunun
     eksikliği (G1, modül açıkken de var) ayrı bir Messaging takip işine yazılır: atamanın
     senkronlanmadığını gösterip sonradan senkron önermek.
   - B: Bu dilimde ekle. Yeniden açılınca iş detayı, senkronlanmamış son atama için M9
     önerisini tekrar gösterir. Küçük bir sunucu alanı ve web değişikliği gerekir.
   - C: Senkron JobCard atama transaction'ına alınır, yani otomatik olur. PR #131'deki
     "otomatik üyelik senkronu yok" kuralını değiştirir; yeni bir karar kaydı gerekir.
4. **Kuyruktaki mesaj push'ları (kapatma anında)?**
   - **A (önerilen):** Dokunulmaz; kuyruk normal boşalır (pratikte saniyeler).
   - B: Dispatcher kapalı modülün push'larını `MODULE_DISABLED` ile bırakır.
5. **Kapalıyken idempotent tekrar (`clientActionId`) ne alsın?**
   - **A (önerilen):** `404`. Kayıt korunur, modül açılınca tekrar özgün sonucu döner.
     MOD-002'nin "yeni istekler durur" kuralıyla uyumlu.
   - B: Kapıdan önce idempotency kaydına bakılıp saklı sonuç dönülür. Kapalı bir modülün
     verisini döndürür.
6. **075 migration'ının sahibi kim?**
   - **A (önerilen):** Bu dilim, modülden bağımsız bir genişletme olarak 075'i alır:
     CHECK'ler `IN (...)` yerine biçim kontrolüne çevrilir, kelime listesi kodda kalır.
     Böylece Depo, Muhasebe ve Bakım bir daha anahtar migration'ı yazmaz. Diğer
     oturumlara bildirilir.
   - B: Önce ayrı küçük bir "registry genişletme" core PR'ı açılır (Depo W0'ın
     anahtar kısmı); bu dilim onun üstüne kurulur.
   - C: `IN ('OVERVIEW','MESSAGING')`. Her yeni modül yeniden migration ister.
7. **Env tavanı?**
   - **A (önerilen):** Yok. Takeover'dan sonra tek kaynak DB; `MESSAGING_ENABLED` legacy
     olarak belgelenir. Staging CI kontrolü takeover girdisi olarak kalır.
   - B: Tavan (`DB AND env`). MOD-002 §4'teki tavan kuralına uymaz.
8. **Operatör onay metni?**
   - **A (önerilen):** Tüm modüller için tek genel cümle eklenir: "Veriler silinmez."
     (Depo W0 ile ortak.)
   - B: Mesajlaşmaya özel bir sonuç satırı (menü, iş detayı, bildirim bağlantıları
     gizlenir).
9. **Sözleşmenin yeri:** **A (önerilen):** Onaydan sonra
   `docs/features/messaging-module-registry.md` + `DECISIONS.md` MOD-003, uygulayan PR
   ile birlikte.

Ayrıca karara bağlanmış sayılan varsayılanlar (itiraz yoksa böyle kalır): SSE replay
değişmez (03 OD5); kapıdan geçmiş bir istek tamamlanabilir (OD9); offboarding, demo veri
ve yedekleme modülden bağımsız kalır; yeniden açma toplu bir şey canlandırmaz; job-cards
okuma portu bu dilimde yok.

## Paylaşılan dosyalar (koordinasyon)

Uygulama aşaması `server/src/modules/installation-modules/{registry,state,takeover}.ts`,
`server/src/index.ts` takeover çağrısı, yeni migration 075, `OperatorModulesPage.tsx`
onay metni ve migration head'i sabitleyen 18 test dosyasına dokunur. Takvim 2.0'ın
planladığı takvim→registry taşıması ve Depo/Muhasebe/Bakım dilimleri aynı dosyalara
gelecek. Karar 6 bu sırayı belirler.

## Takip (araştırma anındaki liste)

G1, G2, G4, iptal/geçersiz iş testleri ve pasif katılımcı bildirimi MSG-002'de (#523),
pilot durum satırı ve `docs/README.md` satırı R0/MSG-001'de kapandı.


- G1/G2: M9 yeniden deneme yolu ve yetki farkı (04 §7).
- G4: Offboarding'in eklediği katılımcı okundu işaretçisi almıyor (04 §7).
- İptal edilen/geçersiz kılınan JobCard konuşmaları için test eksikliği (04 §8).
- Pasif katılımcıya in-app bildirim gidiyor (04 §9).
- `operator-module-pilot.md:3` hâlâ "draft contract" diyor (01 C6).
- Mesajlaşmanın `docs/README.md` ve şema/API taslaklarında sahibi yok (01 §7).
