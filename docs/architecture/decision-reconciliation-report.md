# Module Boundary Decision Reconciliation Report

Date: 2026-10-14 (Europe/Istanbul)
Baseline main: `daf5a59692803f9e5acbbef431d12cc32e1c02e3`
Stack base (PR #370): `f8bde20534cedb9fb3f20f95ce4a765cdf3057e3` / tree `e306446aa2175d983f5a10b161a561290097a9a4`
Scope: documentation + architecture decision reconciliation only. No application
code, migration, dependency or runtime change.

## 1. Karar envanteri ve sınıflandırma

`DECISIONS.md` tamamı incelendi (Context/Decision/Consequences/Status ve
kararlar arası ilişkiler). İlgili kayıtların sınıfları:

- **Accepted + Implemented, aynen korundu:** DOM-001 (delivery purpose,
  finansal izleme yok), DOM-004 (informational katalog), DOM-006
  (operasyonel raporlar, ciro yok), SALE-001 (PR #370 üzerinde bağımsız
  ziyaret-kaynaklı satış anlaşması).
- **Accepted, ilgili, değişiklik yok:** ARC-001 (idempotency), ARC-002
  (single-org), ARC-003 (Customer/Contact), DOM-003 (activity vocabulary),
  DOM-005 (notes), DOM-007 (sales meeting), JOB-004/005/006 (lifecycle),
  SEC-001, OPS-001..004, reconciliation addenda, Weekly Report S1–S5, CRM-S2-001,
  customer-phone kayıtları, local-first CI kayıtları.
- **Historical research, işlem yok:** `docs/archive/inputs/` girdileri
  (`SERVORA_MED_AGENT_PLAN.md`, `ilkplan.md`, `gem-doc.txt`, `teknoloji.md`)
  `DECISIONS.md` Documentation Index'te zaten “Historical inputs” olarak
  etiketlidir. İçerikleri (depo/muhasebe/e-fatura MVP dışı; ileride bağlanabilir
  notları) MOD-001 ile çelişmez; üzerine bant eklenmedi, silinmedi.
- **Repository'de bulunamadı (raporlandı, uydurulmadı):**
  `02-MODULE-AND-DATA-BOUNDARIES.md`,
  `03-INTEGRATION-AND-EVENT-BOUNDARY.md`,
  `04-CAPABILITY-MATURITY-MATRIX.md`,
  `08-MODULE-AND-VERTICAL-OPPORTUNITY-MAP.md`, “Servora Core v1.1 architecture
  baseline” ve bağımsız Warehouse/Accounting modül araştırma dokümanları.
  Repository içi ve dışı arama ile doğrulanmıştır. Bu dosyalar varmış gibi
  uzlaştırma yapılmadı; iddiaları bağlayıcı sayılmaz, MOD-001 geçerlidir.
- **New acceptance (bu görev):** MOD-001.

## 2. Uzlaştırma tablosu

| Eski karar | Önceki durum | Yeni durum | Yapılan işlem | Gerekçe |
| --- | --- | --- | --- | --- |
| DOM-001 — Delivery purpose without financial tracking | Accepted | Accepted (değişmedi) | İşlem yok | `PRODUCT_DELIVERY` SALE amacı ile SALE JobCard ayrımı SALE-001 + design A2/A4 ile korunuyor; MOD-001 §E ile pekişiyor |
| DOM-004 — Informational Product catalog boundary | Accepted | Accepted (değişmedi) | İşlem yok | Katalog referans fiyatı DOM-004'te finansal anlamsız tanımlı (`PRODUCT_REQUIREMENTS.md:337`, `SERVORA_MED_SCHEMA_DRAFT.md:263`); hizalama sorunu yok |
| DOM-006 — Operational reports | Accepted | Accepted (değişmedi) | İşlem yok | Raporlarda ciro yok kuralı + README “Reports count product agreements, not revenue” çizgisi korunuyor; anlaşma sayısı/ciro karışımı yok |
| SALE-001 — Independent visit-origin product agreement | Accepted (PR #370 dalında) | Accepted (değişmedi) | İşlem yok | Onay/fiyat/stok/muhasebe üretmeme kuralları MOD-001 §E ile birebir uyumlu |
| 02/03/04/08 modül araştırmaları + Core v1.1 baseline + Warehouse/Accounting araştırmaları | Harici araştırma (öneri statüsü bilinmiyor) | Repository'de yok; bağlayıcı değil | Dosya yokluğu raporlandı; uydurma uzlaştırma yapılmadı | MOD-001 Context bu dosyaların repo-dışı ve bağlayıcı olmadığını kaydeder; eski öneriler kesin implementasyon adımı sayılmaz |
| `ProductConsumed` / `JobCard.Completed` entegrasyon örnekleri | Eski araştırmalarda örnek event ismi iddiası (görev metni) | Kabul edilmiş event ismi veya migration gereksinimi değil | MOD-001 §D4'te açıkça reddedildi; repo-içi kod/docs değişikliği yok | Repo içinde bu isimlerde entegrasyon sözleşmesi bulunamadı; sessiz kabul engellendi |
| Global outbox / event-first mimari | Olası eski araştırma yönü (görev metni) | Gelecekteki aday; bugünden mimari yok | MOD-001 §D4'te sınırlandı | Mevcut SSE/realtime durable domain integration sayılmaz; web-push bildirim outbox'ı kapsam dışı bırakıldı (domain integration değildir) |
| `invoiceNumber` (JobCard not alanı) | Kodda mevcut domain debt (migration `024_job_card_notes_invoice_number`, `JobNotes.tsx` “Fatura:” alanı) | Domain debt olarak kalır; çözüm Accounting A0'a referanslı | Kod/docs değişikliği yok; A0 backlog'a kaydedildi (bkz. §5) | Fatura referansı ticari belge katmanına aittir; not alanına gömülü kalması geçici borçtur |
| Teslimat purpose=SALE ↔ SALE JobCard otomatikliği | Hiçbir repo-içi belgede otomatik ilişki iddiası yok | Değişmedi | İşlem yok | Design A2/A4 + README kuralları ayrımı açıkça yazar |
| DOM-003 activity vocabulary listesi | `DECISIONS.md` listesi PR1 öncesi event'leri sayar (SALE + önceki slice event'leri listede yok) | Değişmedi | İşlem yok; açık soru olarak kaydedildi (bkz. §6) | Liste kayması SALE öncesi slice'lardan kalmadır; bu görevin sınır/genişletme kapsamı değildir, sessiz tamamlama yapılmadı |

## 3. Yeni kabul: MOD-001

`DECISIONS.md` sonuna `MOD-001 — Warehouse, Accounting and Integration
Boundaries` (Status: Accepted, 2026-10-14) eklendi. DOM/SALE kayıtlarını
yeniden yazmaz; üzerlerine beş başlıkta sınır koyar: (A) Core/JobCard sınırı ve
modular-monolith yönü, (B) gelecek Warehouse sahipliği + deployment moduna göre
tek stok doğruluk kaynağı, (C) hafif ticari Accounting katmanı + Core'a
asla girmeyecekler (hesap planı, yevmiye, e-Defter, bordro, tam mutabakat,
posting engine) + olası dış otorite (Logo/Netsis/Mikro), (D) integration
sınırı (generic bus/outbox yok; modül sahipliğinde dar sözleşme adayı),
(E) SALE uyumluluğu (mevcut kimlik/snapshot'lar gelecekte referans olabilir;
bugün invoiceNumber/warehouse link/fiyat/KDV/gelir yok; SALE→çoklu teslimat
araştırma konusu).

## 4. Visit-to-sale belgelerindeki kısa referanslar

- `visit-to-sale-design.md` §8 sonu: MOD-001'e tek satır authoritative link.
- `docs/features/visit-to-sale/README.md` ürün kuralları sonu: MOD-001'e tek
  satır link. PR1 sözleşme metni değişmedi.
- `visit-to-sale-implementation-plan.md` §5 (PR3): gelecek Warehouse/Accounting
  bilgilendirici salt-okunur alanları için UX sözleşmesi notu eklendi —
  kesin kaynak ve W0/A0 sözleşmesi olmadan gösterim yok; sahte buton, uydurma
  stok, finansal toplam ve yanıltıcı durum yasak; kararlaştırılmamış öğeler
  mevcut özellik gibi sunulmaz. PR2/PR3/PR4 kapsamı değişmedi.
- `visit-to-sale-data-lifecycle.md` (§2.3 satır 91: sale item'da fiyat/stok/
  fatura alanı yoktur), `product-selection-surface-inventory.md` ve
  `product-selection-ui-standardization-plan.md` incelendi; çelişki
  bulunamadığı için değişiklik yapılmadı.

## 5. Gelecek backlog başlıkları (W0 / A0 — discovery, implementasyon yetkisi yok)

**Warehouse W0**

- Stok otoritesi (deployment/entegrasyon moduna göre tek kaynak kuralı)
- Depo/araç lokasyonu
- Satış–teslimat bağlantısı (bir SALE → çoklu PRODUCT_DELIVERY araştırması dahil)
- Rezervasyon ve fiilî çıkış farkı
- Kısmi teslimat ve iade
- Lot/seri/SKT
- Medikal mevzuat doğrulaması

**Accounting A0**

- Ticari belge ve kaynak satış ilişkisi
- Fiyat ve KDV veri sahipliği
- Cari hesap/tahsilat sınırı
- `invoiceNumber` domain debt (JobCard not alanındaki fatura referansının
  ticari belge katmanına taşınması)
- Dış muhasebe ve e-belge entegrasyon yaklaşımı
- İptal/iade/düzeltme davranışı
- Yetki, KVKK ve audit

## 6. Açık mimari sorular

1. DOM-003'teki canonical activity listesi, PR1 öncesi slice event'lerini
   (örn. `MEETING_DETAILS_UPDATED`, `JOB_APPROVAL_WITHDRAWN`,
   `JOB_INVALIDATED`, reminder/escalation) ve PR1 SALE event'lerini
   içermiyor. Bu, bu görevden önce oluşmuş bir liste kaymasıdır; sınır
   çelişkisi değildir ve bu slice'ta sessizce tamamlanmadı. Ayrı karar
   gerekir.
2. Dış ERP'nin stok otoritesi olduğu entegrasyon modunda sahiplik tanımı,
   Warehouse W0'a bırakıldı (MOD-001 §B2).
3. Somut entegrasyon ve belge sahipliği Accounting A0'a bırakıldı (MOD-001 §C).
4. Bir SALE'in çoklu PRODUCT_DELIVERY'ye bağlanma şeması araştırma konusudur
   (MOD-001 §E); PR2–PR4 bu bağlantıyı varsaymaz.

## 7. Link ve tutarlılık kontrolü

- Yeni/degisen markdown linkleri: `DECISIONS.md → docs/architecture/
  decision-reconciliation-report.md`; `visit-to-sale-design.md §8 →
  ../../../DECISIONS.md`; `visit-to-sale/README.md → ../../../DECISIONS.md`.
  Üçü de dosya-seviyesi relative linktir; anchor kullanılmadı.
- Tutarlılık: MOD-001 ifadeleri `057_sale_from_visit.sql` (fiyat/stok/fatura
  alanı yok; `NUMERIC(12,3)` miktar), `sale-policy.ts` (IN_PROGRESS BUSINESS
  kaynaklar, dört engagement kind), `visit-to-sale-design.md` §8 ve
  `visit-to-sale-data-lifecycle.md` §2.3 satır 91 ile çelişmez.
- `PRODUCT_REQUIREMENTS.md:225,227,294,334-348`,
  `SERVORA_MED_ARCHITECTURE_PLAN.md:153,236,453-454`,
  `SERVORA_MED_SCHEMA_DRAFT.md:263,382,561-564`,
  `SERVORA_MED_MVP_SLICES.md:47,325,331,410` ve kullanıcı kılavuzu sınır
  cümlesi MOD-001 ile aynı yöndedir; değişiklik yapılmadı.
- Dokümantasyon dışı değişiklik yoktur: bu daldaki `git status` yalnız
  aşağıdaki beş markdown dosyasını gösterir.

## 8. Değişen dosyalar ve PR bağımlılığı

- `DECISIONS.md` (MOD-001 eklendi)
- `docs/features/visit-to-sale/visit-to-sale-design.md` (1 satır MOD-001 linki)
- `docs/features/visit-to-sale/README.md` (1 satır MOD-001 linki)
- `docs/features/visit-to-sale/visit-to-sale-implementation-plan.md` (PR3
  salt-okunur UX notu)
- `docs/architecture/decision-reconciliation-report.md` (bu rapor; yeni dosya)

Bu dal `feat/sale-domain-from-visits` (PR #370) head'inden açıldı ve o dala
stack edilecek ayrı PR olarak açılacaktır. PR #370 merge edilmeden bu dal
bağımsız biçimde main'e merge edilmeyecektir. PR #370 merge edildikten sonra
yeni main üzerinde tree/diff kontrolü ve retargeting ayrı yetkilendirme
gerektirir. Her iki PR için de merge yetkisi yoktur.
