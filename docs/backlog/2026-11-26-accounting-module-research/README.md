# Ön Muhasebe (Accounting) — genişletilmiş araştırma paketi (2026-11-26)

**Durum:** Ürün sahibi kapsamın genişletilmesini ve belge düzenlemesini onayladı. Bu PR hâlâ araştırma ve karar girdisidir; uygulama, migration, deploy, resmî e-belge kesimi veya dış entegrasyon izni vermez. `DECISIONS.md` değişmez. MOD-001, MOD-002 ve AGENTS.md §13 bağlayıcıdır.

## Ürün yönü

Ön Muhasebe, küçük işletmelere günlük finansal takip sağlayan, kurumsal ERP müşterilerinde kapalı tutulabilen ya da ileride kontrollü entegrasyonla çalışabilen, operatörün açıp kapattığı bağımsız bir modüldür. Tam muhasebe/ERP, resmî defter veya e-belge kesim sistemi değildir. Muhasebe modülü depo, bakım, takvim ve mesajlaşma modüllerine bağımlı olmaz.

| Aşama | Hedef |
| --- | --- |
| ACC-0 | Ürün kapsamı ve kararların uzlaştırılması (bu PR) |
| ACC-1/2 (A) | Varsayılan kapalı modül, finansal yetki, dış fatura referansları, çoklu satış/teslimat ilişkisi ve uzlaştırma |
| ACC-3 (B) | Fiyatlı teklif/sipariş, ticari belgeler |
| ACC-4 (C) | Müşteri açık hesap, alacak, açılış bakiyesi, tahsilat |
| ACC-5a/5b (D) | Tedarikçi, alış, borç, ödeme, gider, manuel kasa/banka ve transferler |
| ACC-6 (E) | Finansal genel bakış, ekstre, vade, gelir/gider ve nakit hareketi raporları |
| ACC-7 (F) | Pilot müşteri ihtiyacına göre harici aktarım/entegrasyon |

A ilk teknik dilimdir, satışa hazır ön muhasebe değildir. Geniş ürün hedefi ACC-5/6 ile tamamlanır. Her dilim için ayrı kapsam ve uygulama onayı gerekir.

## Okuma sırası ve belge önceliği

| Dosya | İçerik |
| --- | --- |
| [07-expanded-product-scope.md](07-expanded-product-scope.md) | **Güncel ana öneri:** ürün kapsamı, yetki, veri sahipliği, aç/kapat sözleşmesi, finansal bütünlük, aşamalar, 18 kabul senaryosu |
| [06-decision-brief.md](06-decision-brief.md) | **Güncel karar taslağı:** D1–D17, eski taslakla çelişkilerin çözümü ve ilk dilim kapıları |
| [01-codebase-touchpoints.md](01-codebase-touchpoints.md) | Orijinal kaynak araştırması: Core temas noktaları, mevcut kod ve borçlar |
| [02-scope-options.md](02-scope-options.md) | Orijinal A/B/C araştırması; satış odaklı kapsam 07 ile genişletildi |
| [03-turkish-e-document-landscape.md](03-turkish-e-document-landscape.md) | Tarihli mevzuat araştırması, uygulamadan önce güncel resmî doğrulama gerekli |
| [04-external-accounting-integration.md](04-external-accounting-integration.md) | Tarihli entegrasyon araştırması, pilot seçimi yapılmadı |
| [05-ownership-and-data-model.md](05-ownership-and-data-model.md) | Orijinal veri modeli araştırması; 07 ile çelişen öneriler geçersiz |

Kabul edilmiş DECISIONS.md ve AGENTS.md her zaman öncelikli. Bu paket içinde 07 ve 06 güncel öneridir; 01–05 tarihli keşif notlarıdır, bağlayıcı şema veya uygulama talimatı değildir. [Orijinal README ve kaynak doğrulama kaydı](https://github.com/emrahozcelik/servora-med/blob/00be58d0ad5848f3a8f7083cfa155541d236327e/docs/backlog/2026-11-26-accounting-module-research/README.md) ve [orijinal karar taslağı](https://github.com/emrahozcelik/servora-med/blob/00be58d0ad5848f3a8f7083cfa155541d236327e/docs/backlog/2026-11-26-accounting-module-research/06-decision-brief.md) korunmuştur.

## Düzeltilen ana konular

- Varsayılan kapalı `ACCOUNTING`, DB tek kaynak; yeni env bayrağı yok. Kapalı 404, durum okunamıyorsa 503; operatör sadece modül yönetir.
- Finansal işlemler için ayrı tipli yetkiler; tüm MANAGER kullanıcılarına finansal erişim verilmez. Dördüncü rol yok.
- Finansal yazma ve modül kapatma yarışı gerçek transaction kilidiyle çözülecek; sadece yeniden okuma yeterli değil.
- Fatura referansı A'da kimlik bilgisiyle sınırlı; tutar/KDV/vade yok. Çoklu kaynak ilişkisi, düzenleyen tarafın kimliği ve normalleştirilmiş tekillik.
- Eski invoiceNumber notları ve Core davranışı korunur; otomatik taşıma, sabit 7 günlük gecikme, otomatik stok/finans hareketi yok.
- Muhasebe modülü kapalıyken de iş kartları, satış, müşteriler ve offboarding çalışır. Veri ve audit silinmez. Restore ve demo purge testleri gerekir.
- Migration numarası rezerve edilmez. Yasal e-belge kesimi, tam genel muhasebe ve banka entegrasyonu kapsam dışı.

## Sonraki adım

ACC-1/2 dikey dilimi için 06'daki açık kararları ve 07'deki sözleşmeyi incele; gerçek pilot verisini ve güncel main'i doğrula. Kabul edilen kararlar, ürün gereksinimi, şema, kod ve testler uygulayan PR'da birlikte güncellenir. Bu PR'ın merge edilmesi uygulama izni sayılmaz. Mevzuat doğrulaması ve çalışma zamanı testleri bu belge revizyonunda yapılmadı.
