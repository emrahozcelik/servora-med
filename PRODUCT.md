# Product

Functional product scope is defined in `PRODUCT_REQUIREMENTS.md`. Durable product and UI decisions are recorded in `DECISIONS.md`.

## Register

product

## Users

Servora-Med, medikal ve dental ürün firmalarında çalışan üç temel kullanıcı grubuna hizmet eder:

- Saha ve satış personeli, mobil cihazdan müşteri ziyareti, ürün teslimi ve genel görevlerini hızlıca kaydeder ve yönetici onayına gönderir.
- Yöneticiler, ekibin açık işlerini, gecikmeleri, teslimleri ve onay kuyruğunu izler; işleri onaylar veya düzeltmeye gönderir.
- Sistem yöneticileri, kullanıcıları, rolleri ve temel firma kayıtlarını yönetir.

Personel arayüzü sahada, çoğunlukla tek elle ve değişken bağlantı koşullarında kullanılabilir olmalıdır. Yönetici arayüzü daha yoğun operasyon bilgisini hızlı taramaya ve güvenilir karar vermeye uygun olmalıdır.

## Product Purpose

Servora-Med, medikal ve dental firmaların müşteri ilişkilerini, ürün teslimlerini ve personel işlerini JobCard merkezli bir operasyon akışında yönetmesini sağlar.

Ürünün temel amacı, serbest kart kullanımının hızını yapılandırılmış ticari veri ve denetlenebilir iş kurallarıyla birleştirmektir. Personel bir işi tamamladığını bildirir, ancak yönetici onayı olmadan JobCard `COMPLETED` olmaz. Kritik işlemler activity geçmişinde izlenebilir kalır.

Başarı şu sonuçlarla ölçülür:

- Personel mobil cihazdan bir işi az adımla ve hata yapmadan kaydedebilir.
- Yönetici ekibin durumunu ve onay bekleyen işleri hızlıca anlayabilir.
- Ürün teslim amacı ve miktarı güvenilir biçimde raporlanabilir.
- Yetki, onay ve audit kuralları arayüzden bağımsız olarak korunur.
- Mobil ve masaüstü deneyimleri aynı domain gerçeğini uygun yoğunlukta sunar.

## Brand Personality

**Güvenilir, sade ve düzenli.**

Arayüz kurumsal güven vermeli, ancak ağır veya bürokratik görünmemelidir. Personelin mobil cihazdan hızlı kullanabileceği kadar sade; yöneticinin süreçleri rahatça takip edebileceği kadar düzenli olmalıdır.

Hedef görünüm modern fakat gösterişsiz, kurumsal fakat ağır olmayan, sade fakat boş görünmeyen bir iş uygulamasıdır. Notion'un sadeliği, Linear'ın düzeni ve güvenilir bir B2B operasyon aracının ciddiyeti referans alınabilir; hiçbir ürün doğrudan kopyalanmaz.

## Anti-references

Servora-Med şu yönlere kaymamalıdır:

- Küçük yazılı, tablo ağırlıklı ve yorucu ağır ERP ekranları
- Her kartın farklı renkte olduğu, oyuncak hissi veren Trello benzeri panolar
- Soğuk, eski ve yalnızca form doldurmaya odaklanan steril hastane yazılımları
- Ticari veriyi belirsizleştiren aşırı serbest veya aşırı boş Notion kopyaları
- Büyük boşluk, yoğun blur ve gereksiz animasyon kullanan dekoratif Apple kopyaları
- Koyu lacivert, gri ve küçük fontlarla aşırı resmi banka yazılımı görünümü
- Rozet, canlı renk ve bildirim baskısıyla dikkat dağıtan sosyal medya kalıpları
- Masaüstü arayüzün mobil ekrana küçültülmüş hali gibi duran sıkışık ekranlar
- Sağlık sektörüne otomatik olarak beyaz ve parlak turkuaz uygulayan jenerik tema
- Generic SaaS kart ızgaraları, gradient metin, varsayılan glassmorphism ve dekoratif dashboard metrikleri

## Design Principles

### 1. Domain truth stays visible

JobCard durumu, teslim amacı, ürün miktarı, sorumlu personel ve onay geçmişi belirsizleşmemelidir. Görsel sadelik kritik iş verisini saklama pahasına sağlanamaz.

### 2. Mobile action, desktop oversight

Mobil deneyim personelin birincil eylemlerini tek elle ve az adımla tamamlamasına odaklanır. Masaüstü deneyim yöneticinin daha geniş operasyon görünümünü taramasına izin verir. Mobil, masaüstünün küçültülmüş kopyası değildir.

### 3. Calm hierarchy over decoration

Hiyerarşi renk kalabalığıyla değil; tipografi, boşluk, hizalama, durum etiketi, tarih ve az sayıda anlamlı vurgu ile kurulur. Kırmızı, turuncu ve yeşil yalnızca semantik durumlar için kullanılır.

### 4. Familiar and immediate

Standart form, navigasyon ve eylem kalıpları korunur. Etkileşimler anında geri bildirim verir. Hareket yalnızca durum, yön ve sonuç anlatıyorsa kullanılır.

### 5. Accessibility is a completion criterion

Erişilebilirlik tasarımdan teste kadar her aşamanın parçasıdır. Kritik akış, erişilebilirlik ihlali varken tamamlanmış kabul edilmez.

## Accessibility & Inclusion

Hedef standart `WCAG 2.2 Level AA`dır.

### Touch and interaction

- Butonlar, ikon butonları, form kontrolleri, kart aksiyonları ve mobil navigasyon öğeleri mümkün olduğunca en az `44 × 44 CSS px` etkileşim alanına sahip olur.
- Küçük ikonlar yeterli tıklanabilir alan içinde sunulur.
- Küçük ve birbirine çok yakın etkileşim hedeflerinden kaçınılır.

### Keyboard and focus

- Tüm temel işlevler klavye ile kullanılabilir olur.
- Tab sırası anlamlı okuma ve işlem sırasını izler.
- Focus kaybolmaz, tuzağa düşmez ve her zaman görünürdür.
- Modal, menü ve açılır paneller doğru focus yönetimi uygular.

### Accessible Kanban

- Sürükle ve bırak hiçbir işlevin tek kullanım yolu değildir.
- Kart durumları buton, menü ve klavye ile değiştirilebilir.
- Durum değişiklikleri anlaşılır ve programatik olarak algılanabilir geri bildirim üretir.

### Color and contrast

- Renk tek başına bilgi taşımaz; metin, ikon veya şekille desteklenir.
- Metin, ikon, form sınırı, focus göstergesi ve anlamlı grafik öğeleri yeterli kontrast sağlar.
- Grafik serileri yalnızca renkle ayrıştırılmaz.

### Zoom and reflow

- Arayüz en az yüzde 200 metin büyütme ile test edilir.
- Uygun ekranlarda yüzde 400 tarayıcı yakınlaştırmasında içerik yeniden akar ve temel işlemler yatay kaydırmaya bağımlı kalmaz.
- Sabit yüksekliklerle metin kırpılmaz.

### Motion

- Gereksiz hareket, parallax ve dekoratif geçiş kullanılmaz.
- `prefers-reduced-motion: reduce` desteklenir.
- Hareket kapatıldığında durum ve işlem sonucu anlaşılır kalır.

### Forms and errors

- Her form alanının erişilebilir etiketi bulunur; placeholder etiket yerine kullanılmaz.
- Zorunluluk ve hata yalnızca renkle belirtilmez.
- Hata mesajı sorunu ve düzeltme yolunu açıklar.
- Hatalı alan ile hata mesajı programatik olarak ilişkilendirilir.
- Gönderim hatasında focus gerektiğinde hata özetine veya ilk hatalı alana taşınır.

### Semantics and testing

- Önce doğru HTML öğesi kullanılır; gereksiz ARIA eklenmez.
- Başlık, landmark, buton, bağlantı, tablo ve listeler semantik olarak doğru kurulur.
- Ortak bileşenler klavye, focus, kontrast ve ekran okuyucu semantiği açısından kontrol edilir.
- Otomatik kontroller manuel klavye, zoom, mobil dokunma ve ekran okuyucu testlerinin yerine geçmez.
