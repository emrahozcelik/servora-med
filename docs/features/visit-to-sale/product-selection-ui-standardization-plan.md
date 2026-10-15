> See [the PR1 contract and handoff](README.md) for implementation status. Approved for PR1 implementation on 2026-10-14. The user confirmed IN_PROGRESS sources, four engagement kinds, BUSINESS records, optional sale contact, NEW/ACCEPTED creation and the terminal-slot policy. Original discovery documents remain untouched. PR2–PR4 behavior is a design target, not shipped behavior. Evidence references below describe the original discovery bundle.

# Product Selection — Shared UX Standardization Plan

Date: 2026-10-14 (Europe/Istanbul)
Baseline: `daf5a59692803f9e5acbbef431d12cc32e1c02e3`
Status: Design ready; UI implementation and acceptance NOT_RUN.

[Inventory](product-selection-surface-inventory.md) tüm production yüzeylerini ve gerçek eksikleri listeler. [Implementation plan](visit-to-sale-implementation-plan.md) dört PR'ın sırasını, yetki/migration/test kapılarını tanımlar. Bu dosya PR3 ve PR4 için ortak UX sözleşmesidir.

## 1. Mevcut SSOT ve korunan davranış

`DESIGN.md` semantic intent/interaction/layout otoritesidir. `web/src/ui/servora-visual-tokens.ts` token değerlerinin canonical implementation kaynağı, `servora-ant-theme.ts` Ant mapping'dir. CSS/feature ekranlarına ikinci renk/font/token sistemi eklenmez. ProductSelect native HTML/CSS bileşeni olarak kalır; raw Ant import veya yeni dependency gerekmiyor. Complex drawer/dialog/result primitives mevcut `web/src/ui/antd` Servora adapter'larından alınır.

PR #362 zaten şu davranışları tamamladı: search results aramanın altında; selected bölüm ayrı; quantity ürünün hemen solunda; ID ile state eşleşmesi; default 1; 0.5/0.001; long metadata wrapping; accessible remove ve focus dönüşü. SALE-QTY-001 sonrasında Sale consumer kesirleri reddeder; Delivery davranışı korunur. Bu çalışma ortak yerleşimi yeni Sale consumer'ına taşır; görsel sistemi yeniden yapmaz.

## 2. Ortak satır ve etkileşim sözleşmesi

```text
Ürünler
[Ad, SKU, marka veya model ile ara] [Ürün ara]
Arama sonucu 1 — Ad / SKU / Marka / Model / Birim — [Eklendi]
Arama sonucu 2 — Ad / SKU / Marka / Model / Birim
[Önceki] 1–8 / toplam [Sonraki]

Seçilen ürünler
[Sale adedi: 5 ürün]  Ürün adı                         [Kaldır]
                 SKU · Marka · Model · Birim
[Sale adedi: 15 ürün]  Başka ürün adı                   [Kaldır]
                 SKU · Marka · Model · Birim
```

Order DOM'da ve görselde aynıdır: **Quantity → Product identity → Remove**. Arama sonuçları selected bölümün üstünde ve arama alanının hemen altında kalır. Selected ürünler yeni arama/pagination sırasında kaybolmaz. Duplicate result `Eklendi` ile işaretlenir, disabled olur; metadata'nın yerine yalnız “Eklendi” koymak yerine ikisi birlikte görünür.

Ad, SKU, marka, model ve birim aynı identity grubu içindedir. Null metadata boş placeholder kalabalığı yaratmaz; özellikle unit için uydurma “adet” yoktur. Name zorunlu canonical ürün kimliği, product ID ilişki anahtarıdır; SKU unique değildir. Long name/metadata wrap eder, ellipsis ile kritik identity gizlenmez.

SALE-QTY-001 ilk Sale decimal tasarımını supersede eder. Sale için PR3 adapter native `type=number`, `min=1`, `step=1`, `inputMode=numeric`; backend pozitif tam sayı 1–999999999 doğrular. Delivery için mevcut `min=0.001`, `step=0.001`, `inputMode=decimal` korunur. Accessible label ürün adını içerir. Empty draft boş kalabilir, 0/negative/infinite invalid'dir. Typing sırasında otomatik tam sayıya yuvarlama veya NaN'i 1'e çevirme yoktur. Yeni seçimin quantity default'u 1; remove/re-add fresh selection olarak 1 ile başlar; kalan ürün miktarı değişmez.

Remove `type=button`, ürün adını içeren erişilebilir isim ve mevcut ≥44×44 CSS px hedef. Selection ve remove sonrası focus search input'a döner. Search Enter form submit etmez; input Enter yalnız arama intent'ini tamamlar. Görünür focus ve mantıklı Tab sırası korunur. Loading/error/no-result/pending announcement'ları role/status/alert/live semantics ile anlamlıdır.

## 3. State ve snapshot sözleşmesi

| Owner | Sorumluluk |
| --- | --- |
| ProductSelect | Bounded active search/page state, stale request gate, selected identity render, duplicate disable, add/remove callback ve focus. |
| DeliveryCreate | ID-keyed product + quantity; existing request builder, existing frozen attempt, pending/ambiguous state ve API submission. |
| SaleCreate | Verified fixed source/customer/assignee, separate contact semantics, actual soldAt, ID-keyed selected product/quantity, strict sale request builder/frozen attempt. |
| Sale detail correction | Persisted item ID + product ID + historical identity + quantity draft; per-action parent expectedVersion and frozen request. |
| Backend | Allowed actions, eligibility, atomic create/edit, snapshots, Sale integer validity / Delivery decimal validity, duplicate/active-sale invariant ve lifecycle. |

ProductSelect bir API mutation, quantity business policy veya idempotency receipt owner'ı olmaz. Quantity callback'in mevcut `renderQuantity` modeli yeterlidir. Yeni QuantityProductPicker, generic cart store veya selector framework'ü önerilmez.

### 3.1 Concrete component extension

Mevcut selectedProducts props full `Product[]`; Sale edit'in persist edilmiş snapshot'ında version/referencePrice/category gibi catalog alanları yoktur. Bu alanları uydurarak Product DTO üretmek yanlış olur.

PR3'te önerilen dar display type: `ProductSelectionIdentity = Pick<Product, 'id' | 'name' | 'sku' | 'brand' | 'model' | 'unit'>`. Multi selectedProducts/renderQuantity bu identity'yi kabul eder. Search `load`, `onAdd` ve legacy single `onChange` hâlâ gerçek catalog Product döndürür. Delivery'nin full Product[] verisi bu dar tipe zaten uyar. Sale edit, `id=productId` ve persist edilmiş product_*_snapshot/unit_snapshot alanlarıyla identity kurar; gizlice live catalog metadata istemez.

Existing sale item'ın quantity update'i snapshot değiştirmez. Yeni catalog seçimi yalnız yeni satır eklerken snapshot üretir. İnaktif historical ürün selected bölümde okunabilir, quantity correction yapılabilir; search sadece backend'e göre eklenebilir aktif ürün sunar. BUSINESS-only önerisi seçilirse canonical product query'nin optional data-class filter'ı ProductSelect load prop'uyla kullanılır; filter henüz mevcut uygulamada varmış gibi kabul edilmez. UI kendi yeniden adlandırma/active business rule'unu icat etmez.

ProductSelect'in hardcoded `delivery-product-label`, `delivery-product-search`, `selected-products-heading` ID'leri `useId` veya owned unique prefix ile instance-safe yapılır. Mevcut tek Delivery mount'u sorun göstermese de yeni reusable create/edit kullanımının güvenilir a11y sözleşmesi gerekir. ID'ler generic olur; testler gerçek label association/focus'a dayanır. Bu yeni component/dependency değil, mevcut bileşenin küçük genişlemesidir.

## 4. Responsive düzen

Mevcut `.product-select-with-quantity` grid kullanılır: quantity sütunu desktop'ta yaklaşık 5.5rem, mobile'da 5rem; identity `minmax(0,1fr)`, remove kendi touch target genişliği. Native control yüksekliği canonical `--control-height`; ad/metadata herhangi yerde wrap eder. Miktar başka bir bölümde veya product listesi sonrasında bağımsız array olarak gösterilmez.

320/390px mobile'da miktar ürünün solunda kalır. Search input/button dar ekranda mevcut stacked davranışı kullanabilir; selected satır anlamı değişmez. 768/1024 bandında mevcut mobile shell ve usable content width dikkate alınır; ikinci toolbar/nav yaratılmaz. 1440px'de aynı satır daha geniş metadata alanı kullanır. 200% text ve 400% reflow testinde input/remove hedefi veya identity kaybolmaz, yatay task scroll yoktur.

New Sale page route title/hierarchy/return registries'e eklenir; PageHeader H1/context-region kullanılır. Fixed source panel kontrollü yoğunlukta; card-inside-card yapısı ve yeni palette yoktur. Source **Satış oluştur** ikincil action'dır; devam eden ziyaretin primary workflow komutunu gölgede bırakmaz.

## 5. Pending ve ambiguous retry

Request builder, key üretiminden sonra normalized complete payload'u frozen attempt olarak tutar. Selected IDs/quantities, soldAt, saleContactId, title ve expectedSourceVersion dahil. Send double-click'e kapalıdır. Pending veya ambiguous sırasında fieldset, quantity/search/remove/add, context değişikliği ve Vazgeç kapalıdır. UI özgün request'i sakladığını ve **Özgün isteği tekrar dene** aksiyonunu açıkça gösterir.

Network error, timeout, 5xx veya ACTION_IN_PROGRESS definitive failure sayılmaz. Yeni key/payload ile otomatik retry yapılmaz. Realtime refresh frozen version/source/contact/product payload'unu rebind etmez; canonical truth daha sonra reconcile edilir. Definitive validation/version/active-sale conflict sonrası attempt açıkça çözülür ve refreshed context'te kullanıcı yeni intent başlatabilir. CLIENT_ACTION_REUSED hatası aynı key ile edited payload göndermeyi meşrulaştırmaz.

Sale detail mutation'larında existing JobDetail session/mutation-owner disiplinine uyulur: başka route/session response'u yeni ekrana yazamaz; pending canonical update draft'a sessizce basılmaz. Backend success sonrası sale/source list/detail ve gerektiğinde report truth yüklenir. SSE bağlı olmasa da tamamlanabilir.

Existing Delivery attempt ref'i component-memory'dir; bu plan bütün legacy create formlarının reload-persistent hale geldiğini iddia etmez. Sale full-page reload sonrası source context'te mevcut aktif satış güvenli şekilde bulunur/engellenir; mevcut relation + unique index duplicate yaratılmasını engeller. Yeni kalıcı draft store/retry recovery sistemi bu slice'a eklenmez.

## 6. Surface-specific uygulama

| Surface | Uygulama |
| --- | --- |
| DeliveryCreate | Mevcut shared selector/quantity mapping aynen korunur. Ortak props/IDs değişirse regresyon testleri. |
| SaleCreate | Aynı shared selector, ayrı source/sale form builder ve backend contract. Delivery-purpose/scheduledAt/price alanları taşınmaz. |
| Sale correction | Snapshot identities + ProductSelect, original attempts ve type-specific API operations. |
| Sale review/terminal | Read-only quantity solda + historical metadata; remove input'u yok. Canonical approval controls ayrı bölgede. |
| Delivery JobDetail | Read-only quantity/unit identity'nin solunda; available name/SKU/model/unit bir grupta. Purpose ve actual deliveredAt/time form korunur. |
| ProductForm create/edit | Katalog alanları; operasyonel quantity yok. Reference price hâlâ informational. |
| Follow-up delivery/proposal | Product selection UI'si mevcut değil. Functional gap ayrı deferred; Sale form reuse için follow-up ilişkisinden yararlanılmaz. |
| Report/profile/Timeline | Read-only semantic data; operational cart görünümüne çevrilmez. Sale label/parser scope ayrı integration PR'ı. |

Delivery historical brand field yoktur. “Bütün historical satırlarda brand var” kabul kriteri konmaz; live catalog ile geriye dönük yanlış bilgi üretilmez. Mevcut delivery model snapshot'ı render edilebilir. Gerçek brand history standardı gerekirse yeni producer/schema kararı ayrı PR'dır.

## 7. PR scope ve test matrisi

PR3: Sale create/correction + shared narrow identity/instance IDs; new backend write route registration. PR4: selected-result metadata/Eklendi parity ve existing Delivery detail read-only row alignment. PR3'te biten ortak değişiklik PR4'te tekrar yapılmaz. Yeni dependency/component ancak bu concrete gap'lerden daha büyük gerçek tekrar ortaya çıkarsa değerlendirilir.

| Case | Component/form test | Browser + persisted evidence |
| --- | --- | --- |
| Product/quantity association | IDs after removal/re-add/reordering; Sale distinct products 1/15; Delivery 0.5/0.001 | Rendered matching labels/rows + committed sale/delivery item SQL quantities |
| Quantity correctness | Sale positive integer 1–999999999, fractional rejection; Delivery fractions retained | No rounding/conversion; exact ID pairing and private v1 hash replay |
| Duplicate | Same product cannot be added twice; Eklendi retains metadata | Repeated search/click; distinct SQL product rows; concurrent Sale index test in backend |
| Search | Below input, bounded page 8, pagination, stale results, Enter | Real keyboard search, select closes results and restores focus |
| Metadata | Long name/SKU/brand/model/unit and nulls | 320/390/768/1024/1440, 200% text, 400% reflow |
| Accessibility | Product-specific quantity label; type=button remove; independent selector IDs | Manual Tab/Enter/Escape where relevant, visible focus, 44px targets |
| Pending | Disabled fields/search/quantity/remove/cancel; double-click one call | Slow real request, safe feedback, no payload mutation |
| Ambiguous | Original key/version/full body retried after dropped response | Real committed-response loss; one receipt/card; source unchanged |
| Historical edit | Snapshot identity unchanged on quantity edit; inactive existing refs readable | Catalog rename/deactivate then Sale edit/read; original metadata persists |
| Review/terminal | No edit controls; withdrawal/resume required | STAFF denied direct complete; manager approve/revision; separate source status |
| Delivery regression | Existing current create/time edit/readonly behavior | Both roles, product count/purpose/actual-time untouched |
| Catalog boundary | No quantity injected into ProductForm; permissions unchanged | STAFF catalog/CRM generic mutation denial; Manager catalog create remains operational |

Mevcut test dosyaları: `product-select.test.tsx`, `delivery-create-screen.test.tsx`, `delivery-create.test.tsx`, `d5-product-delivery-detail.test.tsx`, `d5-product-delivery-parity.test.tsx`, `job-detail.test.tsx`, `product-form.test.tsx`, `product-detail.test.tsx`. Yeni Sale create/detail/edit/browser testleri implementation PR'larında eklenir; bu pakette test pass sayısı icat edilmez.

Önerilen focused frontend check:

```bash
cd web && npm test -- --run tests/product-select.test.tsx tests/delivery-create-screen.test.tsx tests/d5-product-delivery-detail.test.tsx tests/d5-product-delivery-parity.test.tsx
```

İlgili değişiklikler sonrası full web tests/build ve required server gates implementation plan §7'ye göre. Browser'da gerçek session'lar, Vite/Fastify/disposable PostgreSQL 17, Chromium/WebKit ve synthetic records. PR #362 screenshots yalnız incumbent referanstır. Yeni browser kanıtları run SHA ile saklanmalıdır.

## 8. UI acceptance criteria

- Editable quantities remain directly left of the matching product identity in every operational selection consumer.
- Search results remain directly below search; selected products remain visibly separate and stable across paging.
- Name, SKU, brand, model and unit are rendered together when the source contains them; missing historical values are not invented.
- Remove and keyboard/focus behavior remain accessible, instance-safe and operable at mobile and desktop widths.
- Sale quantities 1 and 15 (Delivery 0.5 and 0.001) persist with the correct product IDs; duplicate products and index-based pairing are rejected.
- Pending and unresolved attempts freeze complete semantic requests and retry the original key/version/body.
- Catalog forms remain catalog forms and backend permissions/lifecycle remain authoritative.

## 9. Discovery verification and limit

Source inventory, PR/main identity, retained visuals ve migration catalog kontrol edildi. Bu tur uygulama kodu/migration değişmedi; yeni UI/SALE browser acceptance, npm builds ve test suites **NOT_RUN — documentation-only task**. `Original discovery bundle evidence: verification.json` yalnız gerçekten yapılan kontrolleri kaydeder.
