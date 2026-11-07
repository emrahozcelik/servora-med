# SERVORA-MED — Sayfalama v1 Faz B / liste benimseme

**Durum:** DRAFT / NO-GO. Bu PR, `#414` üstüne yığılmıştır (stacked). Üretim ya da main değişikliği yoktur.

## Kapsam

- Müşteriler: 5 → **6** server-side, eski offset normalizasyonu ve son sayfa kurtarma, Ant `ServoraListPagination`; arama/filtre/rol izinleri korunur. `offset=7` gibi eski URL konumları `replace` navigasyonuyla altılı sınıra (`6`) taşınır; negatif, kesirli ve unsafe offset ilk sayfaya düşer; diğer arama/filtre parametreleri korunur.
- Ürünler: 25 → **6** server-side, URL'deki 25 gibi eski konumların 24'e getirilmesi, silme sonrası son sayfa kurtarma; Ant `ServoraListPagination`.
- Ürün seçici: 8 → **6** server-side. Seçilmiş ürünler sayfa dışında ayrı kalır, request generation gate korunur; Ant `ServoraListPagination`.
- `customer-pagination-smoke.mjs` altılı test fikstürüne uyarlanır; eski URL kanonikleştirmesi ve klavye ile ileri/geri etkileşimini de doğrular.

## İstenen kabul

1. PR #414 exact-head CI PASS **ön koşul**. #414 main'e merge edilmedikçe bu stacked PR main'e merge edilmez.
2. Node 22 TypeScript/web build, Vitest customer-list/product-list/product-select, tüm web suite ve bundle PASS.
3. 320, 390 ve 1440 px Chromium gerçek etkileşimleri: arama, eski URL offset, ileri/geri, filtre sıfırlama, 0/1/5/6/7/12/13 kayıt; yükleme/hata/boş ve silme sonrası son sayfa kurtarma.
4. Erişilebilirlik: Ant simple pager düğmeleri klavye ile çalışmalı; Türkçe locale ve odak, 200%/400% zoom, azaltılmış hareket, sayfa değişiminde focus ve canlı bölge metni doğrulanmalı.
5. Ürün seçicide seçim sonrası liste kapanışı, çoklu ürün/quantity, duplicate-disabled, aramada eski yanıtların yeni seçimi bozmaması, sayfa geçişinde seçili ürün kaybı olmaması.
6. Sunucu istekleri gerçek `limit=6`; hiçbir yerde tüm kataloğu indirip yalnız altısını gizleme yok.
7. Yetkiler, organization izolasyonu, backend/API sözleşmeleri, rapor toplamları, migration ve production değişmez.
8. Tarayıcı testindeki sentetik örnekleri üretim müşteri verisi sayma; log ve screenshot arşivini sır içermeden doğrula.

## Doğrulama

Önceki bağımsız inceleme kanıtları `fb2622ccc6e94f625cdbafb4468624a7ce7d5872` head'ine aittir; yeni commit'ler için otomatik geçerli sayılmaz:

- Odaklı testler: 102 PASS.
- Tam web suite: 2759 PASS (218 dosya).
- Web build ve bundle: PASS.
- Customer Chromium smoke: 33 capture PASS.
- Exact-head CI: run `42355498176`, 3/3 PASS (yalnızca `fb2622c`).

Bu belge güncellemesinin kod head'i `7320bde4356a84d5299cf15d660ddb4c0ff3a42b` için yeniden alınan sonuçlar:

- Odaklı customer/pagination/report/product testleri: **105 PASS** (6 dosya).
- Tam web suite: **2761 PASS** (218 dosya).
- Web build: PASS. Bundle: PASS (84 chunk, her biri < 500.000 byte).
- Server TypeScript build: PASS.
- Customer Chromium smoke: **36 capture PASS**; Chromium `140.0.7339.186`; 320/390/1440 px; gerçek ileri/geri, `offset=7 → 6` tek istek, `offset=13 → 12 → 6` sınırlı kurtarma, geçersiz offsetlerde offset kaldırma, arama/filtre offset sıfırlama, Enter/Space klavye ve odak dönüşü; `0` sayfa hatası, `0` beklenmeyen API isteği, yatay taşma yok. Tüm müşteri istekleri `limit=6`.
- `git diff --check`: PASS.
- Exact-head CI: bu belge commit'i push edildikten sonra PR #415 kontrolünde çalıştırılır; önceki `42355498176` run'ı yalnızca `fb2622c` head'ine aittir.

## Sınırlamalar

- `jobs/CustomerSearchSelect.tsx` cursor benzeri append/select davranışı ayrı UX konusudur; bu PR onu değiştirmez.
- Personel raporu, iş panosu liste görünümü, personel haftalık geçmişi ve diğer raporlar sonraki fazlardadır.
- Gerçek ekran okuyucu ve fiziksel cihaz testi yapılmadı; Chromium emülasyonu ve klavye/odak doğrulaması kullanıldı.
- 200%/400% zoom, 720/320 CSS px reflow eşdeğeriyle doğrulandı; gerçek tarayıcı zoom'u değil.

## Sıra

Önce #414 bağımsız test/erişilebilirlik/ci PASS → kendi onayıyla merge; sonra bu stacked PR güncel main'e uyumlandırılarak yeni exact-head test → onaylı merge/deploy.
