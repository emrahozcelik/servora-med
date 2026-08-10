# Servora-Med — Lokal Cloudflare Tunnel Test Fazı ve VPS Sağlayıcı Araştırması

**Tarih:** 2026-08-10  
**Durum:** AKTİF KARAR NOTU  
**Accepted main:** `859b5a33ddd6e6385f782af03aec8e252a3e64ee`  
**P4-B durumu:** Altyapı kararı yeniden açıldı; VPS satın alma/provisioning şu anda ertelendi.

---

## 1. Güncel karar

Servora-Med'in bir sonraki test aşaması **VPS üzerinde değil, mevcut lokal macOS geliştirme makinesi üzerinden Cloudflare hesabında oluşturulacak named Tunnel ile** yürütülecek.

Bu aşamanın amacı:

- Cloudflare üzerinden gerçek HTTPS/public-hostname yolunu test etmek,
- Caddy + Fastify + PostgreSQL lokal topolojisini staging'e benzer biçimde doğrulamak,
- SSE/realtime, auth, CORS, responsive, PWA hazırlığı ve ilerideki fiziksel cihaz testleri için dış erişim yolunu kurmak,
- VPS satın almadan önce deployment sözleşmesinin canlı ağ davranışını görmek,
- sağlayıcı seçimini testler bittikten sonra güncel fiyat/performans verisiyle yeniden yapmak.

**Bu aşamada VPS satın alınmayacak ve production/staging VPS provisioning yapılmayacak.**

---

## 2. Neden account-based named Cloudflare Tunnel?

Cloudflare'ın güncel Tunnel dokümantasyonuna göre `cloudflared`, origin ile Cloudflare arasında **outbound-only** bağlantılar kurar; origin için public IP veya inbound port açılması gerekmez.

Önerilen lokal test akışı:

```text
Browser / test device
→ Cloudflare Edge TLS
→ account-based named Cloudflare Tunnel
→ cloudflared (lokal Mac)
→ Caddy 127.0.0.1:8080
→ Fastify 127.0.0.1:3000
→ PostgreSQL localhost
```

Caddy aynı zamanda staging-benzeri statik web artefact'ını (`web/dist`) sunar ve `/api` trafiğini Fastify'a yönlendirir.

### Quick Tunnel kullanılmaması

`trycloudflare.com` Quick Tunnel geliştirme için kullanışlı olsa da Cloudflare'ın güncel dokümantasyonunda:

- test amaçlı olduğu,
- 200 concurrent request sınırı bulunduğu,
- **Server-Sent Events (SSE) desteklemediği**

belirtiliyor.

Servora-Med realtime/messaging tarafı SSE kullandığı için **Quick Tunnel acceptance yolu olarak uygun değil**. Bu nedenle Cloudflare hesabından oluşturulan named Tunnel doğru seçimdir.

### Yönetim modeli

Cloudflare, çoğu kullanım için **remotely-managed tunnel** öneriyor. Bu projede de Cloudflare Dashboard üzerinden oluşturulan named Tunnel tercih edilmeli; token/credential hiçbir zaman Git'e eklenmemeli.

---

## 3. Lokal Tunnel test sözleşmesi

### Public hostname

Tercih:

```text
staging.<mevcut-domain>
```

veya test aşamasını daha açık ifade eden:

```text
servora-test.<mevcut-domain>
```

Published application route:

```text
https://<test-hostname>
→ http://localhost:8080
```

### Lokal bind sınırları

```text
Fastify:
127.0.0.1:3000

Caddy:
127.0.0.1:8080

PostgreSQL:
localhost / 127.0.0.1:5432

cloudflared:
outbound-only
```

Lokal origin portları router/modem üzerinden internete açılmamalı.

### Environment notları

Test hostname'i belirlendiğinde runtime environment'ta:

- `CORS_ORIGIN` public test hostname'iyle uyumlu olmalı,
- `TRUSTED_PROXY` mevcut loopback/proxy sözleşmesine göre korunmalı,
- `WEB_PUSH_ENABLED=false`,
- `ACTION_SCOPED_GEOLOCATION_ENABLED=false`,
- `CALENDAR_ENABLED=true`,
- `OVERVIEW_DASHBOARD_ENABLED=true`,
- `MESSAGING_ENABLED=true` veya repodaki güncel karşılığı kullanılmalı.

Environment değişiklikleri secret-safe olmalı ve `.env`/Tunnel token'ı commit edilmemeli.

### Cloudflare Access

İlk uzak testlerde Cloudflare Access kullanımı **opsiyonel ve önerilebilir**. Ancak ileride PWA/physical-device/Web Push acceptance yapılacağı zaman Access katmanının cihaz ve service-worker davranışına etkisi ayrıca değerlendirilmelidir.

---

## 4. VPS araştırması — doğrulama sonucu

Bu bölüm **satın alma kararı değildir**. 2026-08-10 tarihinde resmi sağlayıcı sayfalarından doğrulanmış bir araştırma snapshot'ıdır. Fiyatlar kampanya, taahhüt süresi, KDV, lokasyon ve IPv4 seçeneklerine göre değişebilir.

### 4.1 Hetzner

**CX23**

- 2 vCPU
- 4 GB RAM
- 40 GB SSD
- EU lokasyonlarında 20 TB dahil trafik
- 2026-06-15 sonrası yeni fiyat: **€5.49/ay, KDV hariç, IPv4 hariç**
- Cost-optimized/test-development sınıfı

**Değerlendirme:** Servora-Med için hâlâ güçlü bir Avrupa staging adayı. Kaynak profili ihtiyaçla doğrudan örtüşüyor.

---

### 4.2 netcup

**VPS 500 G12**

- 2 vCore x86
- 4 GB DDR5 ECC RAM
- 128 GB NVMe
- trafik dahil
- snapshot + remote console
- **€5.91/ay (Almanya %19 KDV dahil)**

Ayrıca **VPS Lite 1 G12s**:

- 2 vCore
- 4 GB RAM
- 80 GB SSD
- **€4.88/ay (KDV dahil)**

**Değerlendirme:** Disk alanı ve snapshot/recovery özellikleri açısından çok iyi fiyat/performans alternatifi.

---

### 4.3 OVHcloud

**VPS-1 (2027 range)**

- 2 vCore
- 4 GB RAM
- 40 GB NVMe
- daily backup (önceki 24 saat)
- unlimited traffic
- 500 Mbps public bandwidth
- **$4.54/ay'dan başlayan**

OVHcloud resmi Türkiye sayfası, **Türkiye içinde OVHcloud veri merkezi olmadığını**, yakın veri merkezleriyle hizmet verildiğini belirtiyor.

**Değerlendirme:** Dahili günlük backup ve anti-DDoS avantajlı; Türkiye DC isteyen senaryoda uygun değil.

---

### 4.4 Contabo — araştırmadaki düzeltmeler

Araştırmadaki şu ifade güncel değil:

```text
4 vCPU / 8 GB / 75 GB NVMe
```

Güncel **Cloud VPS 10**:

- **3 vCPU**
- 8 GB RAM
- 75 GB NVMe veya 150 GB SSD
- 32 TB outgoing traffic
- unlimited incoming
- 1 snapshot
- **€4.50/ay**
- DDoS protection varsayılan ve ücretsiz

Bu nedenle “sınırsız trafik” yerine **32 TB outgoing + unlimited incoming** yazılmalı.

**Değerlendirme:** Listelenen kaynak/€ oranı çok yüksek. Ancak yalnız spec tablosuna bakılarak “performans kralı” ilan edilmemeli; gerçek CPU contention, IO ve Türkiye rotası daha sonra ölçülmeli.

---

### 4.5 UltaHost — kısmen doğrulandı

Güncel genel managed VPS promosyonları:

**VPS Basic**

- 1 CPU
- 1 GB RAM
- 30 GB NVMe
- **$4.80/ay**
- 24 aylık dönem fiyatı
- dedicated IPv4
- 30 gün para iade

**VPS Business**

- 2 CPU
- 2 GB RAM
- 50 GB NVMe
- **$8.50/ay**
- 24 aylık dönem fiyatı
- unlimited bandwidth
- DDoS protection

UltaHost'un resmi lokasyon listelerinde **Istanbul, Turkey** bulunuyor.

Ancak araştırmadaki:

```text
İstanbul + Bursa + Ankara DC
```

iddiasında **Bursa ve Ankara resmi kaynaklardan doğrulanamadı**. Dokümanda yalnız İstanbul güvenli biçimde tutulmalı ve sipariş anında seçilen VPS planında Istanbul kapasitesi ayrıca doğrulanmalı.

“Türkçe destek” iddiası da resmi ürün sayfasında açık şekilde doğrulanmadığı için satın alma kriteri olarak kullanılmamalı.

---

### 4.6 LightNode — doğrulandı

**Istanbul VPS Start**

- Istanbul Data Center
- 1 vCPU
- 2 GB RAM
- 50 GB NVMe
- 1 TB bandwidth
- Turkish static IP
- **$7.71/ay**
- yaklaşık **$0.012/saat**
- hourly/pay-as-you-go

2 vCPU sınıfı:

**Agency**

- 2 vCPU
- 4 GB RAM
- 50 GB NVMe
- 2 TB bandwidth
- **$14.70/ay**

Bu nedenle araştırmadaki “2 vCPU / 2 GB ≈ $9–10” satırı LightNode için geçerli değil.

**Değerlendirme:** Kısa süreli İstanbul testleri ve saatlik kullanım için anlamlı; sürekli staging'de Avrupa sağlayıcılarına göre pahalı kalabilir.

---

## 5. Yerli sağlayıcılar — düzeltilmiş snapshot

### 5.1 Natro

Araştırmadaki:

```text
₺5–7/ay
```

ifadesi yanlış; sayfa formatındaki dolar/TL değerlerinin karışmasından kaynaklanıyor.

Güncel örnek:

**XCloud Mini**

- 1 vCPU
- 1 GB RAM
- 20 GB SSD
- 100 Mbit
- **$4.99/ay**
- sayfada yaklaşık **₺236/ay** karşılığı gösteriliyor

**XCloud Medium**

- 2 vCPU
- 4 GB RAM
- 60 GB SSD
- **$9.99/ay** kampanya

**Değerlendirme:** Yerel alternatif olarak tutulabilir; fiyat avantajı ilk bakıştaki “₺5–7” kadar ekstrem değil.

---

### 5.2 Turhost

**VPS TR 1**

- Türkiye lokasyon
- 1 vCPU
- 1 GB RAM
- 20 GB SSD
- 100 Mbit / 1000 GB aylık AKK
- uzun dönem kampanyasında **$4.99/ay**

**VPS TR 2**

- 2 vCPU
- 4 GB RAM
- 40 GB SSD
- 100 Mbit / 1000 GB aylık AKK
- yıllık kampanyada **$9.99/ay**
- kısa dönem fiyatı daha yüksek

Araştırmadaki:

```text
2 vCPU / 2 GB / 30 GB → ₺359/ay
```

satırı güncel ürün yapısıyla eşleşmiyor.

**Değerlendirme:** Türkiye lokasyonu ve yerel operasyon avantajı var; uzun dönem kampanya fiyatıyla normal aylık fiyat mutlaka ayrı değerlendirilmelidir.

---

### 5.3 Alastyr

Alastyr, **Hosting.com.tr ile aynı şirket değildir**.

Alastyr:

- Alastyr Telekomünikasyon A.Ş.
- İzmir'de kendi veri merkezini işletiyor
- %100 Türk sermayeli olduğunu beyan ediyor

Örnek Cloud-4G:

- 2 Core
- 4 GB RAM
- 60 GB SSD
- İzmir
- yaklaşık **₺649/ay** uzun dönem indirimli fiyat
- normal/diğer periyot fiyatları daha yüksek

Örnek VDS Standart:

- 2 Core
- 4 GB RAM
- 50 GB SSD
- yaklaşık **₺632/ay** kampanyalı gösterim

---

### 5.4 Hosting.com.tr

Hosting.com.tr ayrı bir sağlayıcıdır.

**VPS Small**

- 2 Core
- 2 GB RAM
- 50 GB
- 24 aylık efektif fiyat **$3.49/ay**
- aylık yenileme/1 aylık fiyat **$7.99**

**VPS Medium**

- 4 Core
- 4 GB RAM
- 100 GB
- 24 aylık efektif fiyat **$7.99/ay**
- 1 aylık fiyat **$11.99**

TR, DE, UK, FR ve ABD lokasyon seçenekleri listeleniyor.

**Değerlendirme:** Kampanyalı uzun dönem fiyatı güçlü; satın alma karşılaştırmasında 1 aylık ve uzun dönem efektif fiyatlar ayrı sütunlarda tutulmalı.

---

## 6. Fiyat karşılaştırmalarında dikkat edilmesi gerekenler

Aşağıdaki ifadeler tek başına doğru karar kriteri değildir:

```text
en ucuz
en fazla vCPU
en düşük ping
sınırsız trafik
```

Karşılaştırmada birlikte bakılmalı:

1. **Aylık gerçek maliyet**
   - KDV dahil/hariç
   - IPv4
   - kurulum
   - minimum kontrat
   - promosyon sonrası yenileme

2. **CPU niteliği**
   - shared vs dedicated
   - contention / fair-use
   - gerçek benchmark

3. **Disk**
   - NVMe / SSD
   - IOPS
   - snapshot dahil mi

4. **Network**
   - Türkiye'den gerçek RTT
   - packet loss
   - trafik kotası / AKK
   - port hızı

5. **Operasyon**
   - console/recovery
   - snapshot
   - API
   - yedekleme
   - destek kalitesi

6. **Veri merkezi ve mevzuat**
   - Türkiye / AB
   - veri yerleşimi
   - KVKK/GDPR ihtiyacı

### Latency notu

“Almanya → Türkiye 30–40 ms” gibi tek bir sayı sağlayıcı garantisi olarak kullanılmamalı. Son karar öncesinde:

- İstanbul'daki gerçek kullanıcı bağlantısından,
- seçilen sağlayıcının test IP'sine,
- ping + traceroute/MTR

ölçümü yapılmalı.

---

## 7. Şimdilik sağlayıcı sıralaması yapılmıyor

VPS satın alma ertelendiği için bugün “kazanan sağlayıcı” kilitlenmeyecek.

Araştırma shortlist'i:

### Avrupa / uzun süreli staging adayları

- Hetzner
- netcup
- OVHcloud
- Contabo

### Türkiye düşük-latency adayları

- LightNode Istanbul
- UltaHost Istanbul (plan availability checkout'ta doğrulanacak)
- Turhost VPS TR
- Natro
- Alastyr İzmir
- Hosting.com.tr Türkiye lokasyonlu ürünler

Sağlayıcı seçimi **lokal Cloudflare Tunnel testleri tamamlandıktan sonra**, o tarihteki fiyatlar ve gerçek RTT/performans ölçümleriyle yeniden yapılacak.

---

## 8. Lokal test fazının çıkış kriterleri

VPS provisioning'e geçmeden önce lokal named Tunnel üzerinde en az şunlar doğrulanmalı:

- public HTTPS hostname çalışıyor,
- Caddy → Fastify proxy doğru,
- `/api/health` doğru,
- schema `026` doğrulanıyor,
- login/session/CORS doğru,
- Admin/Manager/Staff dış ağ akışları çalışıyor,
- SSE realtime bağlantısı stabil,
- Messaging çalışıyor,
- Calendar çalışıyor,
- mobile fiziksel tarayıcı erişimi mümkün,
- console/network hata döngüsü yok,
- Tunnel credential/token Git'e girmemiş,
- origin portları public internete açılmamış.

Web Push ve geolocation bu aşamada kapalı kalır; ayrı gate'lerde ele alınır.

---

## 9. Son karar kaydı

```text
CURRENT_PHASE:
LOCAL_CLOUDFLARE_TUNNEL_VALIDATION

VPS_PURCHASE:
DEFERRED

REMOTE_VPS_PROVISIONING:
NOT_AUTHORIZED

TUNNEL_TYPE:
ACCOUNT-BASED NAMED TUNNEL

TUNNEL_MANAGEMENT:
REMOTELY MANAGED / CLOUDFLARE DASHBOARD

QUICK_TUNNEL:
NOT ACCEPTED FOR SERVORA-MED
REASON: SSE NOT SUPPORTED

LOCAL ORIGIN:
Caddy 127.0.0.1:8080
→ Fastify 127.0.0.1:3000
→ PostgreSQL localhost

PUBLIC ORIGIN PORTS:
NONE

WEB_PUSH:
DISABLED

GEOLOCATION:
DISABLED

NEXT:
CREATE NAMED CLOUDFLARE TUNNEL
→ RUN LOCAL STAGING-LIKE TESTS
→ RECORD NETWORK/DEVICE RESULTS
→ REVISIT VPS PROVIDER DECISION
```

---

## 10. Resmi kaynaklar — 2026-08-10 kontrolü

### Cloudflare
- https://developers.cloudflare.com/tunnel/
- https://developers.cloudflare.com/tunnel/setup/
- https://developers.cloudflare.com/tunnel/routing/
- https://developers.cloudflare.com/tunnel/advanced/local-management/

### Hetzner
- https://www.hetzner.com/cloud/cost-optimized
- https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/

### netcup
- https://www.netcup.com/en/server/vps
- https://www.netcup.com/en/server/vps-lite

### OVHcloud
- https://www.ovhcloud.com/en/vps/
- https://www.ovhcloud.com/en-gb/vps/vps-turkey/

### Contabo
- https://contabo.com/en/pricing/
- https://contabo.com/en/vps-server/
- https://help.contabo.com/en/support/solutions/articles/103000269957-does-my-server-come-with-ddos-protection-

### UltaHost
- https://ultahost.com/vps-hosting/free-vps
- UltaHost location selector — Istanbul, Turkey (official product pages)

### LightNode
- https://go.lightnode.com/istanbul-vps
- https://go.lightnode.com/turkey-vps

### Natro
- https://www.natro.com/sunucu-kiralama/vps-cloud-server

### Turhost
- https://www.turhost.com/sunucu/vps-tr-sunucu/
- https://www.turhost.com/sunucu/sanal-sunucu/

### Alastyr
- https://www.alastyr.com/hakkimizda
- https://www.alastyr.com/bulut-sunucu
- https://www.alastyr.com/vds

### Hosting.com.tr
- https://www.hosting.com.tr/server/vps-server/
