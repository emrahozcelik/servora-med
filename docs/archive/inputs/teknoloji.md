> Archive notice: This file is a historical planning input. It is not an active source of truth. See `PRODUCT_REQUIREMENTS.md`, `SERVORA_MED_ARCHITECTURE_PLAN.md`, `SERVORA_MED_SCHEMA_DRAFT.md`, `SERVORA_MED_API_DRAFT.md`, `SERVORA_MED_MVP_SLICES.md`, and `DECISIONS.md` for current decisions.

Neden kendimiz yazmalıyız?

Çünkü bizim sistemde “kart sürüklendi” basit bir UI hareketi değil. Örneğin personel bir ürün teslim kartını WAITING_APPROVAL durumuna geçirirse sistem şunları garanti etmeli:

müşteri seçilmiş mi?
ürün girilmiş mi?
adet sıfırdan büyük mü?
kartı atanmış personel mi güncelliyor?
activity log oluştu mu?
duplicate request geldiğinde ikinci kez kayıt oluşuyor mu?
yönetici onayı olmadan COMPLETED olabilir mi?

Bu kurallar Notion benzeri bir uygulamada “konfigürasyon” olarak kalırsa uzun vadede kırılır. Bizde ise bunlar backend service + database constraint + test seviyesinde korunmalı.

Bu yüzden Servora-POS’tan gelen KISS/YAGNI, küçük doğrulanabilir değişiklik, backend source-of-truth, migration, idempotency ve doğrulama disiplini aynen korunmalı; ama POS domain kuralları çıkarılıp Servora-Med’in JobCard/onay/CRM domain kuralları konmalı.

Benim önerdiğim teknoloji yaklaşımı

Çekirdek ürünü kendimiz yazalım. Mevcut Servora altyapısının omurgasını kullanalım:

Backend: Fastify + TypeScript
Database: PostgreSQL
Frontend: React/Vite
Deployment: VPS
Reverse proxy: Caddy veya Nginx
HTTPS/SSL
Backup: otomatik PostgreSQL yedekleri
Responsive web/PWA uyumlu frontend
Role-based access
Activity log
Idempotency
Test-first kritik backend kuralları

Açık kaynak Notion alternatifleri ise şu amaçlarla kullanılabilir:

ürün hissiyatı inceleme
Kanban UX referansı
doküman/wiki mantığı referansı
belki dahili proje dokümantasyonu
ileride opsiyonel “not/wiki” modülü için fikir

Ama Servora-Med’in kod tabanı onların üstüne kurulmasın.

Kullanılabilecek yardımcı araçlar

Ben şu ayrımı yapardım:

Ana uygulama: kendimiz yazıyoruz.

Admin/veri prototipi için opsiyonel: NocoDB veya Baserow denenebilir. Özellikle müşteri/ürün gibi tabloları hızlı görmek için faydalı olabilir. Ama bunu müşteriye sunulacak ana panel yerine “iç araç/prototip” gibi düşünmek lazım.

Not/wiki için opsiyonel: AppFlowy/AFFiNE incelenebilir. Ama JobCard, onay, ürün teslim, personel performansı gibi ana domain oraya bağlanmamalı.

MVP’de teknoloji kararları

İlk sürümde fazla teknoloji eklemeyelim:

Drag/drop Kanban şart değil; önce butonlu durum geçişi.
Advanced chart library şart değil; önce sade rapor tabloları.
Native mobil uygulama yok; responsive web.
Depo/muhasebe modülü yok; sadece ileride bağlanabilecek veri modeli.
Custom Notion-style field builder yok; raporlanacak alanlar sabit ve yapılandırılmış.

Kanban için ileride gerekirse dnd-kit gibi bir React drag/drop kütüphanesi eklenebilir. Ama MVP’de şart değil. Önce state machine doğru çalışmalı.

Grafikler için ileride Recharts, ECharts veya benzeri bir kütüphane seçilebilir. Ama ilk fazda raporların doğruluğu, grafikten daha önemli.

Son karar

Benim net önerim:

Açık kaynak Notion alternatifi üzerine kurmayalım. Servora-Med’i kendi domain uygulamamız olarak yazalım.

Ama ürün hissiyatı için şunlardan ilham alalım:

Notion/AppFlowy/AFFiNE: sayfa, kart, not, sade UX hissiyatı
Trello/Linear: Kanban ve iş akışı hissiyatı
Airtable/NocoDB/Baserow: yapılandırılmış veri + farklı görünüm mantığı

Ürün mimarisi ise bize ait olsun:

PostgreSQL + Fastify + React/Vite + JobCard domain + manager approval + audit log.

Bu, ilk başta biraz daha fazla geliştirme gerektirir ama uzun vadede doğru yol bu. Çünkü biz genel amaçlı Notion klonu değil, medikal/dental firmaların saha operasyonunu takip eden dikey bir iş uygulaması yapıyoruz.
