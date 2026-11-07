# SERVORA-MED — Sayfalama v1 Faz B / liste benimseme

**Durum:** DRAFT / NO-GO. Bu PR, `#414` üstüne yığılmıştır (stacked). Üretim ya da main değişikliği yoktur.

## Kapsam

- Müşteriler: 5 → **6** server-side, eski offset normalizasyonu ve son sayfa kurtarma, Ant `ServoraListPagination`; arama/filtre/rol izinleri korunur.
- Ürünler: 25 → **6** server-side, URL'deki 25 gibi eski konumların 24'e getirilmesi, silme sonrası son sayfa kurtarma; Ant `ServoraListPagination`.
- Ürün seçici: 8 → **6** server-side. Seçilmiş ürünler sayfa dışında ayrı kalır, request generation gate korunur; Ant `ServoraListPagination`.
- `customer-pagination-smoke.mjs` altılı test fikstürüne uyarlanır. Komutun **çalıştığı** iddia edilmez.

## İstenen kabul

1. PR #414 exact-head CI PASS **ön koşul**. #414 main'e merge edilmedikçe bu stacked PR main'e merge edilmez.
2. Node 22 TypeScript/web build, Vitest customer-list/product-list/product-select, tüm web suite ve bundle PASS.
3. 320, 390 ve 1440 px Chromium gerçek etkileşimleri: arama, eski URL offset, ileri/geri, filtre sıfırlama, 0/1/5/6/7/12/13 kayıt; yükleme/hata/boş ve silme sonrası son sayfa kurtarma.
4. Erişilebilirlik: Ant simple pager düğmeleri klavye ile çalışmalı; Türkçe locale ve odak, 200%/400% zoom, azaltılmış hareket, sayfa değişiminde focus ve canlı bölge metni doğrulanmalı.
5. Ürün seçicide seçim sonrası liste kapanışı, çoklu ürün/quantity, duplicate-disabled, aramada eski yanıtların yeni seçimi bozmaması, sayfa geçişinde seçili ürün kaybı olmaması.
6. Sunucu istekleri gerçek `limit=6`; hiçbir yerde tüm kataloğu indirip yalnız altısını gizleme yok.
7. Yetkiler, organization izolasyonu, backend/API sözleşmeleri, rapor toplamları, migration ve production değişmez.
8. Tarayıcı testindeki sentetik örnekleri üretim müşteri verisi sayma; log ve screenshot arşivini sır içermeden doğrula.

## Sınırlamalar

- `jobs/CustomerSearchSelect.tsx` cursor benzeri append/select davranışı ayrı UX konusudur; bu PR onu değiştirmez.
- Personel raporu, iş panosu liste görünümü, personel haftalık geçmişi ve diğer raporlar sonraki fazlardadır.
- Bu GitHub üzerinden hazırlanmıştır; yerel/Chromium testleri **NOT_RUN**. CI sonuçları yalnız başlatılan exact head için geçerlidir.

## Sıra

Önce #414 bağımsız test/erişilebilirlik/ci PASS → kendi onayıyla merge; sonra bu stacked PR güncel main'e uyumlandırılarak yeni exact-head test → onaylı merge/deploy.
