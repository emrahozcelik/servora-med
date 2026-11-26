# External accounting/ERP integration and per-mode financial authority

- **Date:** 2026-11-26
- **Status:** Research only. Not a decision, not an implementation authorization.
- **Scope:** Accounting A0 discovery items "Dış muhasebe ve e-belge entegrasyon yaklaşımı" and
  "Fiyat ve KDV veri sahipliği" / "Cari hesap-tahsilat sınırı" as listed in
  `docs/architecture/decision-reconciliation-report.md:95-104`.
- **Binds nothing:** AGENTS.md §13 still forbids the Accounting module and e-Fatura/e-Arşive
  integration until the owner approves it explicitly.

## Summary

- The repo has **no** accounting, invoice, price, current-account or stock-balance state today;
  `SALE` lines deliberately carry product identity + integer quantity only
  (`server/src/db/migrations/057_sale_from_visit.sql:70-90`,
  `server/src/db/migrations/058_sale_integer_quantity.sql:23`; MOD-001 §5,
  `DECISIONS.md:2051-2059`). Any priced push to an ERP therefore needs a **new owner decision**, not
  just an integration.
- Turkish vendor integration splits into three families: **on-prem ERP with a local service**
  (Logo Objects/REST, NetOpenX REST, MikroAPI), **cloud pre-accounting with a public REST API**
  (Paraşüt; Bizim Hesap is cloud but API-poor), and **file/UBL-based channels** (Zirve, e-Fatura via
  an integrator such as Uyumsoft). There is no single national standard API.
- Best-documented, lowest-risk first target is **Paraşüt**: OAuth2 + PKCE, OpenAPI 3.0 spec v4.1.0
  with 152 paths, webhooks with a stable `event_id`, and `sales_invoices/find_by_external_reference_key`
  for idempotent lookups (all retrieved 2026-11-26). Its weaknesses are quotas (60 RPM / 25k
  requests/month on the free "Temel" plan) and that webhooks/staging sit behind "Plus/Pro — Yakında".
- Best second target is **Mikro**: official API covers exactly the SME document set (cari, stok,
  sipariş, fatura, tahsilat/tediye, e-belge status) and is API-key licensed; but it is a local
  Windows service with no active-active and no idempotency key, so it needs a network path and
  local dedupe (`https://apidocs.mikro.com.tr/guides`, 2026-11-26).
- **Logo** REST is real but licence-gated and on-prem: Logo Objects REST Service v1.6 on port 32001,
  token via clientId/clientSecret + ERP user, and official docs scope it to "3 series" products.
  Whether **Logo Go 3** (the small-business product) exposes REST is **UNVERIFIED** and is a
  blocking question for the smallest distributors.
- **Netsis (NetOpenX REST)** is the strongest transactional API of the on-prem group (OAuth2,
  `/api/v2`, explicit `OpenTransaction`/`CommitTransaction`, `EDocument` send/check) but targets
  larger customers than the pilot segment.
- Authority must be declared **per data domain and per mode**, never per vendor brand: a customer
  can invoice in Logo while the accountant keeps the ledger in Mikro. The decisive question is
  "where does the accountant post the ledger?", not "which logo is on the box".
- Recommended model: Mode 0 (today) → Mode 1 (reference-only) → Mode 2a (Servora pushes unpriced
  orders; ERP prices and invoices) → later Mode 3 (light current account for customers with no ERP,
  never both for the same customer). Mode 2b (Servora-owned prices/VAT) requires superseding
  MOD-001 §5 and is **not** recommended for the first integration.
- A narrow module-owned outbox is justified only when a real connector starts; it can reuse the
  existing web-push delivery pattern (unique identity, attempts, lease, `FOR UPDATE ... SKIP LOCKED`,
  dead-letter) — `server/src/db/migrations/014_create_web_push.sql:74-137`,
  `server/src/modules/web-push/repository.ts:698-734`. Credentials should stay **env-only** at first
  (MOD-002 §4, `DECISIONS.md:3770-3773`), with startup validation like VAPID
  (`server/src/config.ts:693-744`) and fail-closed `503` (MOD-002 §5, `DECISIONS.md:3774-3775`).

## 1. Method and evidence rules

- Every repository claim carries `path:line`; every web claim carries a URL and the access date
  (2026-11-26). Sources that are vendor-adjacent but not the vendor's own developer portal are
  labelled **THIRD PARTY**.
- **VOLATILE** marks facts that change without notice (plan quotas, licence terms, GİB monetary
  thresholds, token lifetimes).
- **UNVERIFIED** marks anything not confirmed from an official vendor/GİB source in this session.
  No vendor was contacted; no sandbox account was created; nothing was purchased.
- Deliberately out of scope: Luca, ETA, Nebim (not researched — no claim made); payment providers
  (Kolay Ödeme, iyzico and similar) because they are not accounting systems; e-Defter, payroll,
  bank reconciliation, general ledger.

## 2. What the repository already fixes

These constraints decide most of the design before any vendor is chosen.

| Constraint | Evidence |
| --- | --- |
| Core never produces stock balances, ledger entries, financial documents or collections | MOD-001 §1, `DECISIONS.md:2016-2021` |
| Exactly one stock source of truth, chosen per deployment/integration mode | MOD-001 §2, `DECISIONS.md:2022-2031` |
| Accounting is a light commercial layer; no GL, e-Defter, payroll, full reconciliation, posting engine | MOD-001 §3, `DECISIONS.md:2032-2040` |
| "Official financial authority may later be Logo, Netsis, Mikro or another authorized ERP" | MOD-001 §3, `DECISIONS.md:2038-2040` |
| No generic bus/global outbox/webhook framework; a narrow module-owned durable contract may be designed when real integration starts | MOD-001 §4, `DECISIONS.md:2041-2050` |
| The web-push outbox is notification-scoped and is **not** domain integration | MOD-001 §4, `DECISIONS.md:2049-2050` |
| No `invoiceNumber`, price, discount, VAT, revenue or invoice/payment status on SALE today | MOD-001 §5, `DECISIONS.md:2051-2059` |
| Delivery carries purpose + quantity only; no price/discount/revenue/margin/invoice/payment state | DOM-001, `DECISIONS.md:349-351` |
| Catalog reference price is informational, has no currency, is never copied into delivery items | DOM-004, `DECISIONS.md:549-552`; mapped as `referencePrice` in `server/src/modules/products/types.ts:43` |
| Invoice/accounting behavior requires a later separately approved design | DOM-004, `DECISIONS.md:567-568` |
| Customer tax number is normalized and unique per organization, but is an identification key, not an invoice authority | `server/src/db/migrations/004_crm_contacts.sql:5-15` |
| Invoice number currently lives in JobCard notes for `SALES_MEETING` and `PRODUCT_DELIVERY` only (recorded domain debt) | `server/src/modules/job-cards/notes-service.ts:16-22,56`; `DECISIONS.md:2065-2066` |
| Only one module is operator-switchable today (`OVERVIEW`); a new module needs its own slice | `server/src/modules/installation-modules/registry.ts:10-24`; MOD-002 §7, `DECISIONS.md:3778-3779` |
| Module capability surface is a fixed typed object, not a settings bag | `server/src/modules/capabilities/types.ts:1-8`; `server/src/config.ts:903-916` |
| Env acts as a ceiling only for modules whose secrets/infrastructure live in env | MOD-002 §4, `DECISIONS.md:3770-3773` |
| Unreadable module state ⇒ `503` and capability off; no env fallback | MOD-002 §5, `DECISIONS.md:3774-3775` |
| Secrets pattern today: env value, decoded/validated at startup, hard failure when invalid | `server/src/config.ts:693-744` (VAPID keys) |
| Migration head is 074; no accounting tables exist | `server/src/db/migrations/074_installation_operator_and_module_state.sql` |

Two consequences that shape everything below:

1. **Servora cannot price anything today.** A "Servora-authoritative quote" is not expressible with
   the current schema. Mode 2 must therefore either let the ERP price (2a) or introduce price/VAT
   snapshots under a new decision (2b).
2. **Servora cannot compute a balance today.** Mode 3 is a real new capability, not a display change;
   it needs documents + collection records, which is exactly the A0 list.

## 3. Vendor landscape

### 3.1 Comparison

Legend: **Creatable** = entities an external system can create; **Read** = entities it can read back.
Confidence is per cell, not per vendor.

| Vendor / product | Deployment | API type | Auth | Creatable | Read | Webhooks | Sandbox | Licensing signal | Maturity | Confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Paraşüt** | Cloud SaaS (TR) | REST/JSON:API, OpenAPI 3.0 v4.1.0, 152 paths | OAuth2 Authorization Code + PKCE (S256), token ≈300 s, refresh 30 d | contacts, products, sales_invoices, sales_offers, purchase_bills, accounts, stock_updates, shipment_documents | contacts (+balance), products (+stock_count), invoices (+payment_status), accounts, e_invoices, e_archives, stock_movements | Yes — `sales_invoice`, `contact`, `product`, `stock_update`, `purchase_bill`, `inbound_e_invoice` events; stable `event_id` | Staging (partner/Plus, "Yakında" for self-serve) | Free "Temel": 60 RPM, 25k req/month, 1 company; Plus 120 RPM/50k; Pro 240 RPM/150k; partner plan for multi-company | High (public spec, versioned API) | High |
| **Logo — Tiger 3 / Wings / Edge (3-series)** | On-prem Windows + SQL | Logo Objects (COM, legacy) and **Logo Objects REST Service v1.6** (`/api/v1`, port 32001) | `POST /api/v1/token`: clientId:clientSecret Basic + `grant_type=password&username=&firmno=&password=` → Bearer | All Logo Objects data objects (cari, stok, sipariş, fatura, kasa/banka…) depending on licensed objects | Same, plus arbitrary logo query objects | None official (polling) | None; customer install | REST is not a separate product; requires a valid **Logo Objects** licence | High but legacy-shaped | Medium-high |
| **Logo — Go / Start / İşbaşı** | On-prem or SaaS | REST support **UNVERIFIED**; one integrator post says Go Plus/Go 3/Start are *not* REST-supported | — | — | — | — | — | — | — | **Low** |
| **Netsis (Logo Netsis) — NetOpenX REST** | On-prem Windows + MSSQL/Oracle | REST/JSON `/api/v2` (port 7070), Swagger help | OAuth2 password grant → access token/JWT | ARPs (cari), Items (stok), ItemSlips (sipariş/fatura/irsaliye), EDocument, MixedReceiptsMain (hızlı tahsilat), BankRemittanceTransfer | Same + `ARPs/Risk`, `Company/ExecuteReport`, SQL `Queries` | None official; `EDocument/CheckEDocument` polling | None; customer install | NetOpenX REST ships with Netsis ≥ 8.06 | High (transactional API: `OpenTransaction`/`CommitTransaction`) | High |
| **Mikro — Jump / Fly (MikroAPI)** | On-prem Windows service (desktop) + JumpBulut gateway | REST/JSON `POST /Api/apiMethods/*` (V16 :8084, V17 :8094) | JSON body auth: `ApiKey`, `KullaniciKodu`, `FirmaKodu`, `CalismaYili`, `Sifre` = MD5(date + password); JumpBulut adds Bearer `KeyToken` + fixed `User-Agent` | Cari, Stok, Sipariş, Fatura/Alım-Satım Evrakı, Tahsilat/Tediye, Dahili Stok Hareket, Verilen/Alınan Teklif, raw table insert (`KayitKaydet`) | Cari/stok lists, e-belge status, `SqlVeriOkuV2` (arbitrary SELECT) | None official | Demo setup ≈100 records; test DB for licensed users | API Key licensed (automatic for vertical solutions, manual for in-house) | High coverage, low ceremony | High |
| **Bizim Hesap** | Cloud SaaS (TR) | REST, 4 endpoints only (`addinvoice`, `products`, `warehouses`, `inventory/{warehouse-id}`) | `Key` + `Token` headers; `FirmID` in invoice payload | Sales/purchase order-invoice (`InvoiceType` 3/5); auto-creates missing customer/product | Product list, warehouse list, per-warehouse stock | No | Not documented | Token issued by support; API document unchanged since 2019 per page metadata | Low (no cari balance, no collections, no invoice read) | Medium |
| **Uyumsoft** | Cloud e-belge integrator (+ UyumsoftERP) | **SOAP/WSDL** `Services/Integration` (`IIntegration`) | UsernameToken policy | e-Fatura/e-Arşiv documents (UBL `InvoiceType`), draft save, send | Inbox/outbox lists, invoice status, document responses | No (status polling) | Yes — public test system | Integrator contract + per-document counters (kontör) — **VOLATILE** | High for e-belge, not an ERP | Medium-high |
| **Zirve** | On-prem MSSQL (and Müşavir Bulut) | **No vendor-published REST API found**; documented paths are XML (Express Aktarım) and Excel | — | Invoices/ledger vouchers via file import | Not documented publicly | No | No | — | Low for integration | Low (absence of evidence) |

### 3.2 Logo

- The supported integration surface is **Logo Objects**, exposed twice: the old COM object model and
  **Logo Objects REST Service v1.6**, which serves `/api/v1` on port `32001` and ships its own
  Swagger help pages (`https://polaris.logo.cloud/product/tiger-uyarlama-araci/a53ad11d-f54a-4af7-bb23-7a221835f167`, accessed 2026-11-26).
- Token flow, as documented by an integrator guide and an older Logo Objects deck rather than by the
  reachable official pages: `POST /api/v1/token` with Basic `clientId:clientSecret` plus
  `grant_type=password&username=…&firmno=…&password=…`; the returned bearer token is used on every
  call (THIRD PARTY, `https://www.datasource.com.tr/blog-logo-rest-servis-kurulumu.html`). The REST
  layer is explicitly "Logo Objects'in yeteneklerinin kullanılabildiği REST temel prensiplerine sahip
  Logo ERP arayüzü" and is scoped to **3-series** products
  (`https://polaris.logo.cloud/product/logo-edge-tseries-uyarlama-araci/28f9a9c6-5af7-4ac9-bcd8-9a471c789000`).
- A May-2025 integrator guide (THIRD PARTY, `https://www.datasource.com.tr/blog-logo-rest-servis-kurulumu.html`)
  states REST works on Tiger 3 / Tiger Wings / their Enterprise editions and **not** on Start,
  Go Plus, Go 3, Tiger Plus, Tiger Enterprise, and that no separate "REST licence" exists — a valid
  Logo Objects licence is the gate. This **conflicts** with the official "3 series" wording for
  Go 3; treat "Logo Go 3 exposes REST" as **UNVERIFIED** until Logo or a live installation confirms it.
- There is no official webhook/push channel in the retrieved documentation: integration is
  poll-and-push. That is acceptable for Mode 2 but rules out event-driven balance updates.
- `docs.logo.com.tr` was not reachable from this host (curl exit 000), so the official developer
  guide could not be read directly; the polaris.logo.cloud pages are Logo-operated product docs and
  are the strongest available official evidence.

### 3.3 Netsis (Logo Netsis, NetOpenX)

- NetOpenX REST is a real, versioned REST API (`/api/v2`, help page on port `7070`), supported from
  **Netsis 8.06** (`https://polaris.logo.cloud/product/netsis-uyarlama-araclari/5dcfec07-7aa7-4c10-bf39-b476f60383c9`).
- The endpoint catalogue is unusually complete for accounting work: `ARPs` (cari with risk/balance
  fields), `Items` (stok), `ItemSlips` (order/waybill/invoice, with `IrsToFat`, `SiparisToIrsFat`,
  `Calculate`, `NewEItemSlipsNumber`), `EDocument` (`SendEDocument`, `CheckEDocument`,
  `EDocumentResponse`), `MixedReceiptsMain` (hızlı tahsilat), `BankRemittanceTransfer`, plus
  `Queries`/`Queries/NetRS` for raw SQL
  (`https://polaris.logo.cloud/product/logo-edge-nseries-uyarlama-araci/66d17fd6-5953-44c5-ab23-df56f9111338`).
- It exposes **explicit transaction control** (`OpenTransaction`, `CommitTransaction`,
  `RollBackTransaction`) — the only vendor in this set that does. That matters for multi-document
  writes (order → invoice) that must not half-apply.
- Auth is OAuth2 password grant → access token ("oAuth2 (accessToken)", NetOpenX REST deck).
  A 2026-04-26 integrator post (THIRD PARTY, `https://parangelsin.com/blog/netopenx-rest-api/`)
  says REST is included natively from Netsis 9.0.55 — consistent with the 8.06 claim, not conflicting.
- Fit: too heavy for a 3–10 person dental distributor, plausible for a 50+ person distributor with
  an in-house IT function.

### 3.4 Paraşüt

- Publishes a downloadable machine-readable spec: `openapi.json`, OpenAPI 3.0.0,
  `info.version 4.1.0`, **152 paths** (retrieved 2026-11-26; extracted list in the
  evidence bundle). Resource roots include `contacts`, `products`, `sales_offers`, `sales_invoices`,
  `purchase_bills`, `accounts`, `stock_movements`, `stock_updates`, `warehouses`, `e_invoices`,
  `e_archives`, `webhooks`, `price_lists`, `taxes`, `checks`.
- Entity shape matches Mode 2 almost one-to-one: `ContactAttributes` carries `tax_number`,
  `tax_office`, `account_type`, `balance`; `ProductAttributes` carries `code`, `vat_rate`,
  `stock_count`, `barcode`; `SalesInvoiceAttributes` carries `invoice_no`, `issue_date`,
  `payment_status`, `total_vat`, `remaining`.
- Idempotency primitive exists in the spec: `GET /{company_id}/sales_invoices/find_by_external_reference_key`
  plus an `ExternalReferenceKey` schema. Webhook envelope carries a stable `event_id` explicitly
  documented as unchanged on redelivery ("Tekrar gelen istekleri ayıklamak için kullanın").
- Auth is the most standard of the set: OAuth2 Authorization Code + PKCE (S256 only), offline
  refresh token valid 30 days, access token ~300 s
  (`https://devhub.parasut.com/oauth-rehberi`, 2026-11-26). **VOLATILE** token lifetimes.
- Commercial limits are the weak point: free "Temel" = 60 RPM / 25.000 requests per month / 1
  company; Plus and Pro (which add staging and webhooks) are marked **"Yakında"** — i.e. not
  self-serve today; multi-company access requires the partner plan
  (`https://devhub.parasut.com/ucretlendirme`, 2026-11-26). **VOLATILE**.
- Positioning caution: Paraşüt is **ön muhasebe**. If the accountant posts the legal ledger
  elsewhere, Paraşüt is the commercial-document bridge, not the financial authority.

### 3.5 Bizim Hesap

- Cloud, but the published integration API is minimal. The `addinvoice` page was retrieved directly
  (`https://apidocs.bizimhesap.com/addinvoice`, 2026-11-26); a 2026-10-13 integration review reports
  the whole API as four services — `addinvoice`, `products`, `warehouses`, `inventory/{warehouse-id}`
  — with no cari-balance, collections or invoice-read endpoint (THIRD PARTY,
  `https://yox.com.tr/entegrasyon/bizim-hesap/`).
- `addinvoice` accepts a full invoice payload (customer VKN/TCKN, tax office, lines with `TaxRate`,
  `Quantity`, `UnitPrice`, `Discount`, totals, currency TRY/USD/EUR/CHF/GBP) and **auto-creates**
  missing customers/products. That makes it a one-way document sink, not a two-way integration:
  there is no cari balance, no collections, no invoice list/read endpoint.
- Auth is `Key` + `Token` headers plus a `FirmID`; the docs do not say where the token is issued.
  The GitBook page metadata still shows 2019, so **maturity is low** — treat field behavior as
  needing live confirmation.
- Suitable only for a narrow "issue an invoice from Servora" use case, which is precisely what
  AGENTS.md §13 forbids without approval.

### 3.6 Uyumsoft (e-belge channel, not ERP)

- Uyumsoft is an e-Fatura/e-Arşiv **özel entegratör** with a SOAP integration service
  (`https://efatura.uyumsoft.com.tr/services/Integration`, `IIntegration`), a public test system,
  and methods that map cleanly onto a document pipeline: `SendInvoice`, `SaveAsDraft`,
  `SendDraft`, `ValidateInvoice` (schema + schematron), `GetInboxInvoices`, `QueryInvoiceStatus`,
  `SendDocumentResponse` (`https://efatura.uyumsoft.com.tr/`, vendor manual v2.0.2 mirrored at
  `https://docplayer.biz.tr/11388710-E-fatura-musteri-web-servisi-dokumani.html`, 2026-11-26).
- It solves the duplicate-send problem explicitly via `LocalDocumentId`: "Gönderici e-faturada
  kullandığı bir LocalDocumentId'yi bir önceki hata almadığı sürece tekrar sisteme gönderemez."
  That is the closest thing to an idempotency contract among the e-belge channels.
- It is **not** an ERP: no cari balance, no stock, no collections. In this design it is a possible
  e-belge transport for Mode 3 or for a customer whose ERP lacks e-Fatura.
- Commercial terms are contract- and counter-based; **VOLATILE** and not verified here.

### 3.7 Zirve (file-based fallback)

- Zirve's own documentation uses "entegrasyon" to mean **posting trade documents to the general
  ledger inside Zirve**, not connecting an external system
  (`https://blog.zirveyazilim.net/entegrasyon-islemleri`, 2025-09-09).
- Its documented data paths are file-based: "Kayıt Aktar" for one-time migration from 61 programs
  (`https://blog.zirveyazilim.net/diger-programlardan-veri-aktarimi`, 2023-09-25), and XML/Excel
  invoice import. A 2026 integrator assessment states no vendor-published REST API exists and that
  "Zirve API" products in the market are third-party
  (THIRD PARTY, `https://dcloudsoftware.com/tr/cozumler/zirve-entegrasyon`).
- **UNVERIFIED (absence of evidence):** no official Zirve developer portal was found. Zirve is
  therefore a **CSV/XML fallback only**, never a first programmatic target.

### 3.8 Deliberately excluded

- Payment providers (Kolay Ödeme, iyzico, PayTR…): they settle money, they do not hold cari,
  invoice or ledger authority. They belong to a future payment slice, not to A0.
- Luca, ETA, Nebim: common in the segment, but not researched in this pass. No claim is made; if the
  pilot names one, it needs its own evidence row before design.

## 4. Export and file-based fallback

File exchange is not a lesser option here — it is the only option for Zirve and a realistic
fallback for every on-prem ERP whose REST licence is missing.

| Channel | What it can carry | Constraints | Evidence |
| --- | --- | --- | --- |
| CSV / Excel | orders, invoice headers+lines, collections, cari/stok master data | No acknowledgement, no idempotency; column mapping is per-vendor and often per-installation; operator must import | Zirve documents Excel invoice import with mandatory columns Tarih, Cari Adı/Açıklama, Matrah, KDV and optional VKN/TCKN (THIRD PARTY summary: `https://dcloudsoftware.com/tr/cozumler/zirve-entegrasyon`) |
| UBL-TR 1.2.1 XML | a complete e-Fatura/e-Arşiv document | XML alone is **not** a submission channel: signing (mali mühür), envelope and GİB transport are missing; needs an integrator or the GİB portal | `https://ebelge.gib.gov.tr/efaturamevzuat.html` (UBL-TR1.2.1 guides/package, integration guide v1.10), 2026-11-26 |
| e-Fatura via integrator (e.g. Uyumsoft SOAP) | signed e-Fatura/e-Arşiv, status, inbox responses | Contract + counters; SOAP/WSDL, not REST; integrator onboarding is per-taxpayer | `https://efatura.uyumsoft.com.tr/services/Integration`; vendor manual v2.0.2 |
| GİB portal (manual) | e-Fatura/e-Arşiv for low volume | Human upload only; no automation; still requires mali mühür | `https://ebelge.gib.gov.tr/efaturamevzuat.html` |

Two rules for the fallback:

1. A file export must be a **derived artifact**, never the system of record. Servora keeps its own
   immutable export snapshot (who exported, when, which document versions) so a later dispute can be
   reconstructed.
2. An import of an ERP-produced file (e.g. cari balances) is **read-only evidence**: it can be shown
   with an "as of" timestamp but must never be written back as if Servora owned it.

**GİB obligations that constrain any invoice path.** e-Fatura-registered taxpayers must issue
e-Arşiv to non-registered taxpayers and consumers
(`https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv%2Fyardim-kaynaklar%2Finfografikler%2Fpdfs%2F2025_e_fatura.pdf`, 2026-11-26); the
monetary thresholds that force e-Fatura/e-Arşiv enrolment change periodically, and the GİB page that
states the current figure (`ebelge.gib.gov.tr/earsivfatura.html`) did not load from this host — so
**the amount is VOLATILE and UNVERIFIED here** and must be read at design time. A GİB announcement
dated 2026-03-16 adds NACE/KDV-rate consistency checks from 2026-04-01 (THIRD PARTY summary:
`https://www.pwc.com.tr/tr/hizmetlerimiz/vergi/dolayli-vergi/bultenler/e-donusum-bultenleri/2026/e-fatura-paketi-ubltr-1-2-1-paketi-ve-ubltr-kod-listeleri-kilavugu-guncellenmistir.html`).
Implication: Servora must never *originate* a tax document without an integrator contract; a locally
generated UBL file with a wrong KDV rate is a compliance incident, not a bug.

## 5. Deployment modes and authority

Four modes, cumulative and switchable per installation. "Authority" means: the only place a
correction is legally/operationally valid.

### Mode 0 — no accounting module (today)

Nothing changes. Servora holds operations, customers (with an identification-only tax number),
catalog (with a non-financial `referencePrice`) and SALE lines (product + integer quantity). No
invoice, no price, no balance, no stock. `invoiceNumber` remains a JobCard-note field and recorded
domain debt. No integration surface, no credentials, no outbox.

### Mode 1 — Servora reference-only

The external system issues invoices; Servora stores a **reference** to them and nothing else.

| Domain | Authority | Direction | Notes |
| --- | --- | --- | --- |
| Customer tax identity | External ERP | read-only copy in Servora | Servora's `tax_number` stays a matching key (unique index `004_crm_contacts.sql:13-15`); divergence is an exception, not a sync |
| Price / VAT | External ERP | not stored (except `referencePrice`, informational) | no change to DOM-004 |
| Quote / order | External ERP (Servora may keep an operational SALE) | none | SALE remains non-financial |
| Invoice | External ERP | **manual reference entry** into Servora | moves the `invoiceNumber` debt toward a structured `accounting_document_reference` later |
| Current account / collections | External ERP | not stored | Servora never shows a balance in Mode 1 |
| Stock | External ERP (MOD-001 §2) | not stored | — |

- **Manual vs automatic:** manual only. This is the mode to ship first because it needs no
  credentials and no network path.
- **Conflict handling:** an invoice reference is unique per organization + external document id;
  re-entering the same number is rejected, editing a reference after the fact is an audited
  correction, never a silent overwrite. If the referenced customer's tax number later diverges from
  the ERP record, the reference stays but is flagged `IDENTITY_MISMATCH`.
- **Why it is worth shipping:** it removes free-text invoice numbers from notes
  (`notes-service.ts:19`) and creates the link table that Modes 2/3 reuse.

### Mode 2 — Servora pushes commercial documents; external owns money

Servora is authoritative for the *operational commitment* (what was agreed, with whom, in which
quantity); the external system is authoritative for *money* (price, invoice, cari, collections) and,
per MOD-001 §2, for stock.

Two sub-modes, and the choice is a **product decision**, not an integration detail:

- **Mode 2a (recommended): ERP prices.** Servora pushes customer identity + product code + quantity
  (+ requested date, note). The ERP applies its price list, VAT and currency, and returns the priced
  document. Servora may store the **returned** amounts read-only for display, marked
  `source=ERP`, with the ERP timestamp. This keeps MOD-001 §5 intact: Servora still owns no price.
- **Mode 2b: Servora prices.** Servora stores unit price, discount and VAT per line and pushes them.
  This is the only way to have a meaningful Servora quote, but it **contradicts**
  `DECISIONS.md:2051-2059` and DOM-004's "no financial meaning" boundary. It requires a new accepted
  decision (superseding MOD-001 §5) before a single line of code.

| Domain | Mode 2a | Mode 2b (needs new decision) |
| --- | --- | --- |
| Customer tax identity | ERP is legal master; Servora creates/links the cari on first push and keeps `erp_customer_ref` | same |
| Price / VAT | ERP; Servora displays returned values read-only | Servora owns a snapshot; ERP must accept it |
| Quote | Servora owns the commercial intent; priced by ERP on push | Servora owns priced quote |
| Order | Servora owns; pushed as an ERP order | same, with prices |
| Invoice | ERP only; Servora stores reference + status | same |
| Current account balance | ERP only; optional read-only mirror with `as_of` | same |
| Collections | ERP only; Servora may store a "reported" reference, never a derived balance | same |
| Stock | ERP (MOD-001 §2); Servora never decrements | same |

- **Manual vs automatic:** order push is automatic (queued, retried, operator-visible). **Invoice
  issuance stays manual in the ERP** for the first integration — auto-issuing a legal document from
  a queue is a compliance risk with no compensating benefit. Balance/status refresh is a scheduled
  read, not a webhook dependency (only Paraşüt offers webhooks at all).
- **Conflict handling (Mode 2):**
  1. *Tax identity mismatch* between the Servora customer and the mapped cari ⇒ **block the push**
     and raise an operator task. Never auto-merge, never overwrite either side. Servora already
     treats conflicting tax numbers as duplicate evidence
     (`server/src/modules/crm/duplicate-types.ts:15`), so this is consistent.
  2. *Duplicate document* ⇒ idempotency key lookup before send, and an external-reference lookup
     where the vendor supports it (Paraşüt `find_by_external_reference_key`).
  3. *Status divergence* (invoice cancelled/returned in ERP) ⇒ inbound reconciliation marks the
     Servora reference `STALE` and requires an explicit acknowledgement; it never deletes.
  4. *Stock divergence* ⇒ impossible by construction, because Servora holds no stock quantity in
     Mode 2.
- **What must not happen:** two-way field sync, automatic price writes into the catalog, or a
  Servora-computed balance shown next to an ERP balance.

### Mode 3 — Servora light current account (customers with no ERP only)

For a customer who has no ERP at all, Servora may hold a minimal commercial ledger. Explicitly
**not** a GL: no chart of accounts, no journal, no e-Defter, no payroll, no bank reconciliation
(MOD-001 §3).

| Domain | Authority | Notes |
| --- | --- | --- |
| Customer tax identity | Servora | must be complete (VKN/TCKN, tax office, invoice address) before any document |
| Price / VAT | Servora | manual per line; needs the 2b decision anyway |
| Quote / order | Servora | — |
| Invoice | Servora stores the document **reference and amounts**; it does not issue e-Fatura unless an integrator is contracted | issued via GİB portal or an integrator by a human |
| Current account balance | Servora, **derived**: Σ invoices − Σ collections (+ opening balance) | never a stored mutable "balance" column; always a projection with an audit trail |
| Collections | Servora | cash/bank/cheque records with date, amount, method, reference |
| Stock | none, unless the Warehouse module is enabled separately (MOD-001 §2) | — |

- **Hard boundary:** a customer is in exactly one of `EXTERNAL_REF` (Mode 1), `EXTERNAL_PUSH`
  (Mode 2), `SERVORA_LEDGER` (Mode 3) or `NONE` (Mode 0). Switching modes is allowed only when the
  customer has no open documents, and it is an audited, operator-approved action. Two authorities
  for one customer is the failure this whole design exists to prevent.
- **Conflict handling:** there is no external party to conflict with; the risk moves to internal
  consistency — an invoice without a customer tax identity, a collection exceeding the open balance,
  or a document edited after a collection was allocated. Each must be a rejected transaction, not a
  warning.
- **Manual vs automatic:** all manual (or human-triggered by the accountant); there is no sync job in
  Mode 3. The only scheduled work is a consistency check that surfaces orphaned documents and
  over-allocated collections.

### 5.1 Cross-mode rules

1. **One authority per domain per customer.** The matrix above is per customer, not per installation:
   a single Servora installation can run Mode 2 for ERP customers and Mode 3 for the rest.
2. **Money never flows back into operations.** No mode writes price, balance, invoice status or
   collection state into JobCard, delivery, SALE or reports (DOM-001, DOM-006, MOD-001 §1/§5).
3. **Deletion is never propagated.** Cancelling in Servora does not cancel an ERP invoice; cancelling
   in the ERP does not cancel a Servora job. Each side records its own terminal state and the link
   is marked inconsistent.
4. **Every cross-system write is idempotent and auditable.** See §6.

## 6. Integration mechanics inside MOD-001 §4

MOD-001 §4 forbids a generic bus/outbox but explicitly allows "a narrow durable integration/outbox
contract under module ownership" once a real integration starts. That is the only mechanism proposed
here.

### 6.1 What the narrow outbox needs

Minimum viable shape (design sketch, **not** a migration; column names deliberately mirror the
existing web-push delivery so reviewers can compare):

```
accounting_outbox
  id                uuid pk
  organization_id   uuid not null
  connector_key     text not null        -- 'PARASUT' | 'MIKRO' | 'LOGO' | 'NETSIS'
  operation         text not null        -- 'SALES_ORDER_PUSH' | 'CUSTOMER_UPSERT' | ...
  aggregate_type    text not null
  aggregate_id      uuid not null
  idempotency_key   text not null        -- sha256(org|connector|operation|aggregate|request_hash)
  payload           jsonb not null       -- immutable snapshot at enqueue time
  state             text check in ('PENDING','CLAIMED','SENT','DEAD')
  attempt_count     smallint not null default 0
  next_attempt_at   timestamptz not null default now()
  lease_token       uuid
  lease_until       timestamptz
  last_error_code   varchar(80)
  external_ref      text
  created_at, updated_at timestamptz
  unique (organization_id, idempotency_key)
  index on (state, next_attempt_at, lease_until, id) where state in ('PENDING','CLAIMED')
```

Required behaviors, each traceable to an existing pattern:

| Requirement | Why | Existing precedent |
| --- | --- | --- |
| Enqueue in the **same transaction** as the domain command | no side effect before durable intent | `web_push_deliveries` FK to `in_app_notifications`; MOD-001 §4 "durable contract" |
| Unique identity per business effect | duplicate requests must not create duplicate documents | `web_push_deliveries_identity_unique`, `014_create_web_push.sql:90-91` |
| Lease-based claim, not check-then-act | multiple app instances / restarts | `FOR UPDATE OF delivery SKIP LOCKED`, `web-push/repository.ts:727` |
| Bounded retries with backoff | vendor outages must not spin | `WEB_PUSH_MAX_ATTEMPTS = 6`, `dispatcher.ts:22`; delays `dispatcher.ts:24-30`; lease 30 s `dispatcher.ts:19` |
| Terminal dead-letter state | an operator must see what will never send | `state in ('PENDING','CLAIMED','DELIVERED','ABANDONED')`, `014_create_web_push.sql:99-133` |
| Immutable payload snapshot | retries must send what was approved, not today's data | web-push stores a rendered payload per delivery |
| Operator visibility | "why is this invoice missing?" | read-only operator list + explicit single retry; `DEAD` never auto-requeues |

Vendor-specific idempotency limits are real and must be handled explicitly, not assumed:

- **Paraşüt:** external reference key lookup exists → cheapest true idempotency.
- **Netsis:** `OpenTransaction`/`CommitTransaction` allows a multi-document write to be atomic on the
  ERP side, but no documented client idempotency key → local key + read-back by document number.
- **Mikro / Logo:** no documented idempotency key → send, then read back by document number/series;
  a timeout is `UNKNOWN`, never `FAILED`, and must be reconciled before retry. This is the single
  biggest correctness risk in the on-prem connectors.

### 6.2 Inbound (ERP → Servora)

Defer until a real consumer exists. When it does:

- No generic webhook framework, no global event bus (MOD-001 §4).
- One endpoint per connector, signature-verified, with the vendor's own dedupe id (Paraşüt
  `event_id`) persisted; unknown events are stored, not dropped.
- Inbound scope for the first slice should be **status and reference only** (invoice issued /
  cancelled, payment state) — never customer or price master data.

### 6.3 Credentials

- **Env-only for the first connector.** This is the only policy consistent with MOD-002 §4
  (`DECISIONS.md:3770-3773`): env is the ceiling for modules whose secrets live in env. Suggested
  keys (names illustrative): `ACCOUNTING_ENABLED`, `ACCOUNTING_CONNECTOR`, `ACCOUNTING_BASE_URL`,
  `ACCOUNTING_COMPANY_ID`, `ACCOUNTING_CLIENT_ID`, `ACCOUNTING_CLIENT_SECRET` **or**
  `ACCOUNTING_API_KEY`, `ACCOUNTING_ERP_USER`, `ACCOUNTING_ERP_PASSWORD`.
- Validate at startup and **fail hard on malformed values**, exactly like the VAPID keys
  (`server/src/config.ts:693-744`); never log the value, only the key name.
- When the module is enabled but credentials are absent/unreadable, the module answers `503` and its
  capability is off (MOD-002 §5, `DECISIONS.md:3774-3775`) — no partial operation.
- **Do not** build a DB secret store, per-organization credential table or key-rotation UI in this
  slice. That is a SEC decision with its own threat model (encryption at rest, backup exposure,
  operator visibility) and it is not needed for a single-ERP installation.
- Passwords are held by the customer's ERP; Servora must never mirror or reset them. The Mikro
  credential format (MD5 of date + password, `https://apidocs.mikro.com.tr/guides`) is a
  vendor-specific quirk that must be computed in-process and never persisted in plaintext.

### 6.4 Operator and customer visibility

- Operator (`/api/operator`, MOD-002) sees: connector configured/not, last successful send, queue
  depth, dead-letter count, last error code. No payload bodies, no credentials, no customer data
  beyond counts — operator visibility is operational, not a data export.
- Customer ADMIN sees only domain outcomes ("3 orders waiting to sync", "invoice reference missing"),
  never a connector configuration screen.
- A `SENT` row is not proof of business success: the connector must store the ERP's returned document
  number/status and surface `SENT_UNCONFIRMED` distinctly from `SENT`.

### 6.5 What to defer

- Generic event bus, global outbox, Kafka/Redis, cross-module event catalogue (MOD-001 §4).
- Bidirectional master-data sync (customer, product, price).
- Automatic invoice issuance, e-Fatura/e-Arşiv generation, e-Defter, GL, payroll, bank reconciliation
  (MOD-001 §3, AGENTS.md §13).
- Multi-vendor plugin framework: implement **one** connector; extract a shared interface when the
  second one actually lands. A `connector_key` column plus one module boundary is enough for now.
- Per-organization credentials, credential rotation UI, connector marketplace.

## 7. Recommended first targets

### 7.1 First: Paraşüt

Why, on evidence:

1. **Lowest integration cost per unit of value.** It is the only vendor here that pairs a
   machine-readable OpenAPI spec (3.0.0, v4.1.0, 152 paths) with a standards-based OAuth2 + PKCE
   flow; Mikro also publishes an OpenAPI description but authenticates with in-body credentials.
2. **Real idempotency primitives** — `find_by_external_reference_key` and a webhook `event_id`
   documented as stable across redelivery. That removes the two hardest failure modes
   (double invoice, duplicate event) before code is written.
3. **Cloud reachability** — no VPN, no customer Windows server, works from the VPS deployment that
   AGENTS.md §0 targets.
4. **Entity coverage matches Mode 2a exactly** — contacts with `tax_number`/`tax_office`, products
   with `code`/`vat_rate`, sales invoices with `invoice_no`/`payment_status`, accounts and stock
   movements for read-back.

Why it may still fail, stated plainly:

- Free tier is 60 RPM / 25k requests per month; a nightly full reconciliation can eat that.
- Webhooks and staging are listed under Plus/Pro, both marked **"Yakında"** — a self-serve customer
  may not have them at all, so the design must work with polling first. **VOLATILE**.
- Multi-company (i.e. the operator running many installations) needs the partner plan.
- Paraşüt is pre-accounting; if the accountant's ledger is elsewhere, Paraşüt is a bridge, not the
  authority — the mode table still applies, but "current account authority = Paraşüt" would be wrong.

### 7.2 Second: Mikro

Why:

1. **Coverage matches the actual SME document set** — cari, stok, sipariş, fatura, tahsilat/tediye and
   e-belge status all exist as documented endpoints, and the docs ship an OpenAPI description
   (`https://apidocs.mikro.com.tr/apis`).
2. **Low ceremony** — API key licensing, demo DB with ~100 records, no Logo Objects-style licence
   gate.
3. **Installed base**: Mikro is widely used by small distributors and is explicitly named by MOD-001
   §3 as a possible financial authority (`DECISIONS.md:2038-2040`).

Why it is second:

- It is a **local Windows service**; Servora on a VPS cannot reach it without a customer-side network
  path (VPN / reverse tunnel / on-prem agent). That is an operational project per customer.
- No active-active and no documented idempotency key ⇒ the `UNKNOWN`-after-timeout reconciliation in
  §6.1 is mandatory, which is real engineering.
- The JumpBulut gateway exists (`https://apidocs.mikro.com.tr/jbapi`) and may remove the network
  problem for cloud customers, but its scope and limits are **UNVERIFIED**.

### 7.3 Conditional third: Logo (Tiger 3 / Wings) — only if the pilot already runs it

Logo is the safest *brand* answer and the riskiest *engineering* answer: the REST layer requires a
Logo Objects licence, is on-prem, and its product coverage (Go 3, Start) is **UNVERIFIED**. If the
first pilot customer runs Logo Go, this whole plan needs re-evaluation before commitment.

### 7.4 Not recommended as a first target

Netsis (too heavy for the segment), Bizim Hesap (one-way sink, no balance/collections),
Uyumsoft (e-belge channel, not an ERP), Zirve (no official API found).

### 7.5 How strong is this evidence?

Weak in one specific way, and it must be said: **no measured Turkish SME ERP market-share data was
collected in this pass.** The ranking is based on (a) documented API capability, (b) segment fit
(3–30 person distributors), and (c) deployment reachability — not on measured prevalence. Before
committing, the owner should name the first 1–3 pilot customers and their actual systems; that
single fact outweighs everything in §7.

## 8. What this document does not authorize

- No Accounting module, no migration, no `invoiceNumber` removal, no price/VAT field, no e-Fatura
  code, no credential, no connector, no outbox table.
- No change to MOD-001, MOD-002, DOM-001/004/006, SALE-001/002.
- Mode 2b and Mode 3 both require a new accepted decision before implementation; Mode 3 additionally
  requires the A0 items "cari hesap/tahsilat sınırı" and "iptal/iade/düzeltme davranışı" to be
  resolved.

## Open questions

1. **Where does the accountant post the ledger?** For each pilot customer: ERP brand + edition
   (Logo Go vs Tiger 3 matters), or "no ERP". This decides the mode, not the vendor marketing.
2. **Mode 2a or 2b?** Accept ERP-priced orders (respects MOD-001 §5) or authorize Servora-owned
   price/VAT snapshots (supersedes it)? Without an answer, "Servora-authoritative quote" is not
   implementable.
3. **Logo Go 3 REST support** — official docs say "3 series"; a third-party guide says Go 3 is not
   supported. Needs a live installation or Logo confirmation.
4. **Credential scope** — one ERP connection per installation (env, MOD-002-compatible) or one per
   organization (DB secrets, new SEC decision)? MOD-002 §4 currently points to env.
5. **Does Servora ever issue an e-Fatura/e-Arşiv?** If yes: which integrator, who holds the mali
   mühür, who owns the kontör cost, and what is the fallback when the integrator is down?
6. **Cancellation/return/credit-note semantics** across the boundary (A0 item, unresolved here):
   does an ERP cancellation invalidate a Servora order, or only mark it?
7. **KVKK / data processor** — pushing customer tax identity and contact data to a cloud
   pre-accounting provider (Paraşüt/Bizim Hesap) needs a processor agreement and a retention rule;
   on-prem connectors avoid this but shift the burden to the customer's network.
8. **Polling budget** — Paraşüt's 25k requests/month is small enough that reconciliation cadence must
   be designed, not left to "every 5 minutes".
9. **Operator visibility depth** — is "queue depth + last error" enough, or does the operator need
   per-document replay? The latter needs an audit trail and a permission decision.

## Sources

Repository (all paths relative to this worktree, HEAD `89bf6b1`):

- `DECISIONS.md:337-357` DOM-001; `:534-568` DOM-004; `:1991-2071` MOD-001; `:3735-3788` MOD-002.
- `docs/architecture/decision-reconciliation-report.md:95-104` Accounting A0 discovery titles;
  `:106-118` open architecture questions.
- `server/src/db/migrations/014_create_web_push.sql:74-137` web-push delivery table, unique
  identity, state machine, due index.
- `server/src/modules/web-push/repository.ts:698-734` claim query (`FOR UPDATE … SKIP LOCKED`,
  lease, attempt increment).
- `server/src/modules/web-push/dispatcher.ts:17-33` poll interval, lease, max attempts, backoff.
- `server/src/modules/installation-modules/registry.ts:10-24` single `OVERVIEW` module entry.
- `server/src/modules/capabilities/types.ts:1-8`; `server/src/config.ts:903-916` capability wiring;
  `server/src/config.ts:693-744` VAPID env validation precedent.
- `server/src/db/migrations/004_crm_contacts.sql:5-15` tax-number normalization + unique index.
- `server/src/db/migrations/057_sale_from_visit.sql:70-90` sale items (no price/VAT);
  `server/src/db/migrations/058_sale_integer_quantity.sql:23` integer quantity check.
- `server/src/modules/job-cards/notes-service.ts:17-22,56` invoice number in notes, capability gate.
- `server/src/modules/crm/duplicate-types.ts:15` `CONFLICTING_TAX_NUMBERS` evidence.
- `server/src/modules/products/types.ts:43` `referencePrice` mapping.

Web (all accessed 2026-11-26; legend and retrieval status in the evidence bundle `sources.md`):

- Paraşüt pricing/plans — https://devhub.parasut.com/ucretlendirme
- Paraşüt OAuth guide — https://devhub.parasut.com/oauth-rehberi
- Paraşüt OpenAPI (v4.1.0, 152 paths) — https://devhub.parasut.com/openapi.json
- Logo Objects REST Service (v1.6, port 32001) —
  https://polaris.logo.cloud/product/tiger-uyarlama-araci/a53ad11d-f54a-4af7-bb23-7a221835f167
- Logo REST on 3-series —
  https://polaris.logo.cloud/product/logo-edge-tseries-uyarlama-araci/28f9a9c6-5af7-4ac9-bcd8-9a471c789000
- Logo REST setup/support matrix (THIRD PARTY, May 2025) —
  https://www.datasource.com.tr/blog-logo-rest-servis-kurulumu.html
- NetOpenX REST from Netsis 8.06 —
  https://polaris.logo.cloud/product/netsis-uyarlama-araclari/5dcfec07-7aa7-4c10-bf39-b476f60383c9
- NetOpenX REST usage (port 7070, `/api/v2`) —
  https://polaris.logo.cloud/product/netsis-uyarlama-araclari/dac0c01c-e9a7-4c80-9e83-b7146631f904
- NetOpenX endpoint catalogue —
  https://polaris.logo.cloud/product/logo-edge-nseries-uyarlama-araci/66d17fd6-5953-44c5-ab23-df56f9111338
- NetOpenX REST availability note (THIRD PARTY, 2026-04-26) —
  https://parangelsin.com/blog/netopenx-rest-api/
- MikroAPI endpoint catalogue — https://apidocs.mikro.com.tr/apis
- MikroAPI FAQ (local service, licences, ports, demo) — https://apidocs.mikro.com.tr/guides
- Mikro JumpBulut gateway — https://apidocs.mikro.com.tr/jbapi
- Bizim Hesap `addinvoice` — https://apidocs.bizimhesap.com/addinvoice
- Bizim Hesap four-service API scope (THIRD PARTY, 2026-10-13) — https://yox.com.tr/entegrasyon/bizim-hesap/
- Uyumsoft integration service — https://efatura.uyumsoft.com.tr/services/Integration
- Uyumsoft e-belge portal — https://efatura.uyumsoft.com.tr/
- Uyumsoft customer web service manual v2.0.2 (mirror) —
  https://docplayer.biz.tr/11388710-E-fatura-musteri-web-servisi-dokumani.html
- Zirve "entegrasyon" meaning — https://blog.zirveyazilim.net/entegrasyon-islemleri
- Zirve "Kayıt Aktar" migration tool — https://blog.zirveyazilim.net/diger-programlardan-veri-aktarimi
- Zirve integration assessment (THIRD PARTY) — https://dcloudsoftware.com/tr/cozumler/zirve-entegrasyon
- GİB e-Fatura mevzuat / UBL-TR 1.2.1 / integration guides —
  https://ebelge.gib.gov.tr/efaturamevzuat.html
- GİB e-Fatura infographic (e-Arşiv obligation) —
  https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv%2Fyardim-kaynaklar%2Finfografikler%2Fpdfs%2F2025_e_fatura.pdf
- GİB 2026-03-16 UBL-TR update summary (THIRD PARTY) —
  https://www.pwc.com.tr/tr/hizmetlerimiz/vergi/dolayli-vergi/bultenler/e-donusum-bultenleri/2026/e-fatura-paketi-ubltr-1-2-1-paketi-ve-ubltr-kod-listeleri-kilavugu-guncellenmistir.html
