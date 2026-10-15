> See [the PR1 contract and handoff](README.md) for implementation status. Approved for PR1 implementation on 2026-10-14. The user confirmed IN_PROGRESS sources, four engagement kinds, BUSINESS records, optional sale contact, NEW/ACCEPTED creation and the terminal-slot policy. Original discovery documents remain untouched. PR2–PR4 behavior is a design target, not shipped behavior. Evidence references below describe the original discovery bundle.

# Product Selection — Complete Frontend Surface Inventory

Date: 2026-10-14 (Europe/Istanbul)
Baseline: `daf5a59692803f9e5acbbef431d12cc32e1c02e3`
Status: Source inventory complete; no UI implementation changed.

## 1. Tarama kapsamı ve kanıt

`web/src` içindeki bütün `.ts/.tsx` dosyaları ProductSelect/imports, selectedProducts, productId, quantity, listProducts, delivery-items API calls ve native number inputs için tarandı. AppRouter/paths, bütün JobCard create/detail/edit/follow-up/weekly ekranları, Product catalog, CRM, Staff ve Reports tüketicileri doğrudan incelendi. Test ve browser fixture dosyaları çalışan ekran diye sayılmadı; kullanılmayan API export'ları ayrıca işaretlendi.

Tek production `<ProductSelect>` mount'u **`DeliveryCreate.tsx:310`**. Çoklu seçim + quantity callback var. Single-selection modu component ve test sözleşmesi olarak mevcut, fakat current frontend'de production tüketicisi yok. `addDeliveryItem` ve `removeDeliveryItem` client export'larının production call site'ı yok; `patchDeliveryItem` yalnız JobDetail actual-time mutation'ında çağrılıyor.

[PR #362](https://github.com/emrahozcelik/servora-med/pull/362) merged; merge commit `f2de980db4db46db5650f07938f3a729e577c2bd`. Bu commit ile reviewed main arasında ProductSelect, DeliveryCreate, styles.css ve iki referans test dosyasında `git diff --stat` boş çıktı: iyileştirme aynen korunuyor. PR'ın eski test sonuçları bu turda yeniden çalıştırılmış sayılmadı.

Retained `after-mobile.png` (390px) ve `after-desktop.png` (1440px) görselleri incelendi: miktar solda, adı/metadata ortada ve kaldırma sağda; uzun metin kırılıyor, 0.001/0.5 input'ları görünüyor. Bunlar PR #362'nin tarihsel browser kanıtlarıdır, yeni sale akışının browser acceptance'ı değildir. Kaynak değişmediği ayrıca Git ile kontrol edildi. `Original discovery bundle evidence: verification.json` görsel kanıt yollarını ve doğrulama sınırlarını kaydeder.

## 2. İşlemsel ürün yüzeyleri

| ID | Ekran / route | Mevcut UI ve bileşen | Eksik / sınır | Gerekli değişiklik |
| --- | --- | --- | --- | --- |
| P01 | Yeni teslimat `/jobs/new-delivery` | DeliveryCreate → ProductSelect multi + renderQuantity. Selected rows quantity → identity → remove; search results altında separate selected section. Parent ID-keyed `{product, quantity}` state. | İstenen seçme standardı zaten var. Sale iş alanı bulunmuyor; selector catalog Product shape'i istiyor. | Delivery akışını koru. Ortak selector type/a11y extension yapılırsa targeted regression. İkinci selector veya ayrı quantity listesi ekleme. |
| P02 | ProductSelect arama/sonuç/pagination alt yüzeyi | Native search + button; active product API, page size 8; requestGate stale-response kontrolü. Metadata name/SKU/brand/model/unit. | Already-selected result branch'i metadata yerine yalnız `Eklendi` gösteriyor. Hardcoded label/search/selected-heading ID'leri çoklu mount'ta çakışabilir. | Küçük parity slice: metadata ile Eklendi durumunu birlikte tut; instance-safe IDs/focus ilişkisi. Quantity ownership parent'ta kalır. |
| P03 | ProductSelect selected rows alt yüzeyi | Multi: onAdd/onRemove/renderQuantity; single: hidden productId + onChange. Duplicate ürün aynı ID'de tekrar eklenmiyor. | Single mode production mount değil. Sale edit'in historical snapshot identity'si full Product DTO değildir. | Mevcut single API'yi koru; seçili identity shape'ini name/SKU/brand/model/unit/id ile daraltarak snapshot mapping'i destekle. Search/onAdd gerçek catalog Product getirmeye devam eder. |
| P04 | Teslimat JobDetail `/jobs/:id`, `type=PRODUCT_DELIVERY` | `.delivery-lines`: product name + SKU, purpose, read-only quantity/unit; DeliveryItemActualTimeForm gerçek zamanı değiştirir. | Miktar product identity'nin solunda değil; stored model render edilmiyor. Brand delivery snapshot'ında yok. ProductSelect mount'u, add/remove/quantity edit UI'si yok. | Read-only row parity: quantity/unit solda, stored name/SKU/model/unit aynı identity grubunda; purpose/actual-time ayrı. ProductSelect editor gibi mount edilmez. Missing brand current catalog'dan doldurulmaz. |
| P05 | Teslimat actual-time edit, IN_PROGRESS/REVISION_REQUESTED | JobDetail `saveDeliveredAt` → patchDeliveryItem `{expectedVersion, deliveredAt}`. Parent mutation ownership/pending, truth refresh ve conflict handling. | Bu quantity mutation değildir; API'nin daha geniş PATCH sözleşmesi UI'nin daha geniş yetkisi değildir. | Time input/edit davranışını koru. UI parity satır düzeni bu formu bozmaz; version/conflict regresyonu test edilir. Yeni quantity/remove butonu ekleme. |
| P06 | Follow-up create `/jobs/new-follow-up?source=…`, PRODUCT_DELIVERY branch | FollowUpCreatePage: fixed customer, task type, assignee, schedule/instructions. | Product selection veya initial delivery items yok. Boş delivery card oluşturabilir; JobDetail'da da satır ekleme UI'si yok. Bu kaynakta gerçek bir UI capability boşluğu. | Envanterde explicit deferred functional gap. SALE_FROM_VISIT bu formu kullanmaz. Ürün ekleme desteği yalnız ayrı functional slice + atomic follow-up create/idempotency planıyla; parity PR'ında sessizce çözülmez. |
| P07 | Source approval follow-up proposal/decision | FollowUpProposalSection / JobApprovalReviewPanel teslimat türünü seçenek olarak sunabilir; ürünleri seçmez. | Type selection ürün selection değildir; mevcut management follow-up create'i items taşımaz. | Mevcut proposal/lifecycle kurallarını koru. P06 ile aynı future functional scope; Sale option buraya eklenmez. |
| P08 | Yeni satış formu `/jobs/:visitId/new-sale` | **Henüz yok.** | Yeni domain/API ve verified source context gerekiyor. | P01'deki ProductSelect multi+quantity yeniden kullan; fixed customer/assignee, independent actual soldAt ve sale contact. |
| P09 | Sale detail correction `/jobs/:saleId`, SALE | **Henüz yok.** | Historical item metadata ile current catalog selection farklı shape'ler. | Aktif edit'te aynı ProductSelect; existing selection historical snapshots'tan narrow identity, new additions catalog'dan. Add/quantity/remove her biri frozen request + receipt/version taşır. |
| P10 | Sale waiting approval / terminal detail | **Henüz yok.** | Editing ile immutable read presentation ayrı sözleşme. | Read-only quantity → historical identity; editor ve remove control yok. Same sale lines manager review'da görünür; broad ProductSelect read component'i yaratılmaz. |

P06/P07'ye yeni ürün seçimi eklemek, “mevcut ürün seçme UI'sini standardize etmek” ile aynı iş değildir. Backend endpoints bulunması, kullanıcı akışının tamamlandığı anlamına gelmez. Mevcut boşluk task çıktısında saklanmadı; küçük UI parity PR'ı bu işlevi genişletmez.

## 3. Katalog, rapor ve diğer ekranlar — dışlanan veya read-only yüzeyler

| ID | Yüzey / kullanılan bileşen | Davranış / gerekli değişiklik |
| --- | --- | --- |
| C01 | ProductCreateScreen `/products/new` → ProductForm | Katalog name/SKU/brand/category/model/unit/referencePrice tanımlama. Operasyonel seçme değil. Quantity eklenmez; form/yetki korunur. |
| C02 | ProductDetail `/products/:productId` → ProductForm edit | Aynı katalog düzenleme sözleşmesi, management mutation + version/conflict. Sale quantity veya selection callback eklenmez. |
| C03 | ProductList `/products` | Catalog list/search/filter; row navigation product detail açar. JobCard'a ürün eklemez. ProductSelect yerine geçirilmez. |
| C04 | ProductDetail read/activate/deactivate/delete | Catalog facts ve `hasOperationHistory`. UI parity gerekmiyor; Sale backend integration history projection'ına sale items ekler. |
| R01 | DeliveryReport `/reports/deliveries` | OperationalTable: day/purpose/product/staff grouped quantity strings. Read-only; selected cart değil. Sale lines bu report'a eklenmez. |
| R02 | StaffOperationalReport / staff report tab | Delivery-purpose/unit quantity ve workload/type/outcome özetleri. Read-only; number input/ürün seçimi yok. Sale type bucket parser/label backend integration ile eşlenir. |
| R03 | StaffProfiles | Staff operational summary + job/history; ProductSelect mount'u veya quantity editor yok. Sale own/history visibility entegrasyonu gerekir; selection tasarımı gerekmiyor. |
| R04 | JobTimeline | DELIVERY_ITEM event'leri miktar gösterir; read-only audit. Sale event presenter/label eklenir; geçmiş miktarlar editable yapılmaz. |
| O01 | SalesMeetingCreate / SalesMeetingEditForm / MeetingDetails | Customer/planned contact/met contact selection; product selection yok. Yeni sale action JobDetail context'inde; meeting outcome seçenekleri değişmez. |
| O02 | GeneralTaskCreate / GeneralTaskEditForm | Customer/contact ve genel görev; ürün/miktar yok. Sale ile birleştirilmez. |
| O03 | WeeklyReport create/detail/recurrences/question editor | Rapor content/source-work snapshot; ürün cart'ı yok. Sale source-work type için parser/label entegrasyonu gerekir. |
| O04 | JobWorkspace/List/Board/Filters/JobRow | JobCard type/status/filter/navigasyon; satır ürün seçimi yok. SALE type visibility dışında seçim standardı değişikliği gerekmez. |
| O05 | CRM customer list/detail/enrichment/contact management | Product selector yok. Sale history/link ve contact operation-history guards dışında UI selection işi yok. |
| O06 | Calendar, Overview, CustomerReport, ApprovalReport, SalesFollowUpReport, StaffPerformanceReport | Operasyonel read/navigation/chart; product/quantity mutation bulunmadı. SALE mapping/bucket etkileri planlanır; ikinci ziyaret veya delivery sayımı eklenmez. |
| O07 | Messaging, Notes, Auth, User management, Settings/DataManagement | Product/quantity mutation yok. Notes invoice-capable type alanına SALE eklenmez. DemoData quantity-looking alanları record counts; BackupRecovery number alanları retention days, ürün miktarı değildir. |

## 4. Source anchor list

Tüm anchor'lar [reviewed main](https://github.com/emrahozcelik/servora-med/tree/daf5a59692803f9e5acbbef431d12cc32e1c02e3) üstündedir.

| Kanıt | Source path / line |
| --- | --- |
| Tek operational multi consumer / miktar native contract | `web/src/DeliveryCreate.tsx:96`, `:175`, `:242`, `:310` |
| Shared selector props/search/selected layout | `web/src/ProductSelect.tsx:14`, `:39`, `:76`, `:110`, `:123`, `:160` |
| CSS quantity grid/remove target / mobile | `web/src/styles.css:3264`, `:3280`, `:3283`, `:3542` |
| Delivery details read/time editor | `web/src/JobDetail.tsx:724`, `:825`, `:1829` |
| Wider client calls, unused add/remove | `web/src/jobs/jobs-api.ts:1297`; `web/src/services/api.ts:2` re-export |
| Follow-up type branch, products absent | `web/src/jobs/FollowUpCreatePage.tsx:380`, `:408`; `web/src/jobs/FollowUpProposalSection.tsx:79` |
| Catalog create/edit | `web/src/ProductForm.tsx:34`, `:68`; `web/src/ProductDetail.tsx:195` |
| Routes and loader mounts | `web/src/paths.ts:20`, `web/src/AppRouter.tsx:15`, `:320`, `:411` |
| Delivery API actual snapshot fields / no brand | `server/src/modules/job-cards/types.ts:366`, `repository.ts:3382`, `:3402` |

## 5. Mevcut test kanıtı ve eksikleri

`web/tests/product-select.test.tsx`: search placement, idle guidance, full long metadata, reorder→ID quantity binding, page size 8, pagination, select/remove focus, stale results, single mode, duplicates, keyboard Enter ve error/retry. `web/tests/delivery-create-screen.test.tsx`: default 1, distinct fractions, remove/re-add, 0.5/0.001, invalid quantities, pending disable, ambiguous frozen retry. Bunlar okunmuş test tanımlarıdır; bu tur PASS iddiası yoktur.

`d5-product-delivery-detail.test.tsx` ve `d5-product-delivery-parity.test.tsx` actual-delivery/submission ayrımını korur. Full JobDetail tests time patch/version ve terminal immutability'ye dayanak sağlar. Yeni Sale lifecycle, snapshot-backed edit, shared instance IDs ve one-active concurrent create testleri henüz yoktur; [plan](product-selection-ui-standardization-plan.md) eklenmelerini tanımlar.

## 6. Inventory acceptance criteria

- Every production product selector, item-add surface and quantity-write call site is identified at the reviewed commit.
- The single-selection component API and unused delivery client exports are not misreported as live product-selection screens.
- Catalog/reference-price fields and read-only report quantities are separated from operational selection.
- Missing delivery follow-up item entry is recorded as a functional gap with an explicit deferral.
- Sale creation/correction reuse ProductSelect; read-only historical records preserve snapshot truth.

## SALE-QTY-001 handoff (2026-10-15)

The fractional examples above remain historical ProductSelect/Delivery evidence.
Sale quantity now means integer product count (1–999999999); PR3 defaults to 1
and must adapt selection/add/correction consistently without changing Delivery
fractional input or ProductForm. No shared selector change is part of SALE-QTY-001.
