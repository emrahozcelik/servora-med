# 05 — External ERP as stock authority: integration modes M0–M3

Status: **research / design note, not a decision.** No code, migration, table or
configuration was created or changed. Every ERP statement below was read on
**2026-11-26** (Europe/Istanbul) from the source listed in §8; anything I could not open is
marked **UNVERIFIED**.

Authorization gate: `AGENTS.md:398` forbids adding a full warehouse module without explicit
owner approval. This document does not grant that approval and does not authorize an adapter
implementation. It prepares the mode decision that must exist before any Warehouse slice.

Reading key used throughout:

- **(a) code today** — verified with `path:line` against this checkout.
- **(b) accepted decisions** — `DECISIONS.md` / approved contracts, quoted with line numbers.
- **(c) proposal** — my recommendation or option, never presented as accepted.

---

## Özet (TR)

- MOD-001 §2 tek bir stok doğrusu istiyor: **aynı miktar iki sistemde bağımsız otorite olamaz**.
  Bu, "kurulumda tek sistem" değil, "her stok miktarı için tek yazıcı" demektir
  (`DECISIONS.md:2026-2030`).
- Dört mod var: **M0** modül kapalı, **M1** Servora otorite, **M2** ERP otorite (R: salt okuma,
  W: hareket talebi, D: belge üretimi), **M3** lokasyon bazlı hibrit.
- M2'de Servora bakiye hesaplamaz. Yalnızca `asOf` damgalı ERP anlık görüntüsü, ürün/depo
  eşlemesi, ERP belge referansı ve gönderim kuyruğu tutar; UI "ERP kaydı, saat X" der.
- M3, ancak lokasyonlar ayrık ve sınır hareketleri tek belgeyle eşleşiyorsa kuralı ihlal etmez.
  Aynı lokasyona iki yazıcı varsa ihlal eder. Bu yüzden otorite, **lokasyon özelliği** olarak
  modellenmelidir; tek global bayrak M3'ü sonradan imkânsız kılar.
- Doğrulanabilen ERP'lerde **belge kesmek stok hareketi doğurur** (Logo `itemSlips`/`salesDispatches`,
  Mikro `Irsaliye`, Netsis `ItemSlips`, Paraşüt `shipment_documents`). Bu nedenle
  "Servora stok sahibi ama irsaliyeyi ERP kesiyor" çoğu kurulumda **çifte otorite** olur.
- Yalnızca Paraşüt'te resmî webhook var; diğerlerinde belgelenmiş webhook bulunamadı → yoklama
  (polling) + mutabakat gerekir. Hiçbirinde istemci idempotency anahtarı garanti değil.
- Bugünkü operatör durumu yalnızca boolean: `enabled` ve CHECK `IN ('OVERVIEW')`
  (`074_installation_operator_and_module_state.sql:51-65`). Mod alanı yok; tipli, modüle ait
  bir ayar tablosu ve ayrı operatör uç noktası gerekir. JSONB ayar çantası UI-002'ye aykırıdır.
- Mod değişimi bayrak çevirmek değildir: kesim sayımı, açık kuyruğun boşaltılması, fark kararı
  ve denetim kaydı gerekir. M1→M2 ve M2→M1 geri dönüşlü olabilir, ama yalnızca kesim kaydıyla.
- **Öneri:** V1 yalnızca M0 + M1. M2 tasarlanır, yazılmaz. M2'yi bloke etmemek için bakiye
  okuması `{quantity, asOf, source}` döndürmeli, hareket niyeti anahtarlı olmalı, ERP eşlemesi
  ve belge referansı şeması bugünden düşünülmelidir.
- DOM-001:351 "CONSIGNMENT ve RETURN stok hareketi doğurmaz" kuralı Depo modülüyle çelişecek;
  açık bir supersession kararı gerekir.

---

## 1. What "single stock source of truth" actually constrains

Accepted text (`DECISIONS.md:2022-2031`):

> A future Warehouse module will own depots and vehicle stock, physical quantities, reservations
> where needed, stock in/out movements, transfers, returns and corrections, lot/serial/expiry,
> and the link between stock movements and their source operation. The same operational stock
> quantity must not be managed as independent authoritative state in two systems. Servora
> Warehouse aims to act as the stock authority when enabled; in integration mode where an
> external ERP is the stock authority, that ownership is defined separately. **The single stock
> source of truth is set explicitly per deployment/integration mode.**

Three separate authorities are hiding in that paragraph. Keeping them apart makes every mode
decision testable:

| Authority | Question it answers | M1 holder | M2 holder | M3 holder |
|---|---|---|---|---|
| **Balance authority** | "How many are there now?" | Servora | ERP | per location |
| **Movement authority** | "What changed it, and why?" | Servora | ERP | per location / boundary |
| **Document authority** | "Which legally numbered document proves it?" | Servora or ERP (see warning) | ERP | per location / boundary |

The rule is about the **quantity dimension**, not about the installation. A quantity is
identified by at least `(organization, item, location, lot/serial?, instant)`. For every such
tuple exactly one system may be the writer; any number of systems may *read* it if they record
where and when it came from.

Two consequences drive the rest of this document:

1. **A cache is not an authority.** A copied number with `asOf`, `source` and `fetchedAt` is
   allowed in M2; a locally recomputed `opening + movements` is a second authority and is not.
2. **Document authority is not stock-neutral in the ERPs where this was verifiable.** Logo,
   Mikro, Netsis and Paraşüt post stock when a dispatch/invoice document is created; DİA's
   `tsif` family follows the same ERP semantics but its create services were not individually
   verified. "Servora owns stock, ERP prints the dispatch" therefore creates two writers unless
   the ERP's stock module is explicitly out of scope for those items. This is the single most
   important practical finding of this research.

### 1.1 In practice, "explicit per deployment/integration mode" means five artifacts

| # | Artifact | Why the mode is not real without it |
|---|---|---|
| 1 | one persisted authority value (plus one per location in M3) | an env flag or a per-user preference is not a deployment-level truth |
| 2 | a read model that carries `quantity`, `asOf`, `source` | a bare number cannot be labelled or aged, so the UI will overclaim |
| 3 | a writer rule enforced in code and, where possible, SQL | "we agreed Servora owns it" is not a constraint |
| 4 | a cutover record for every mode change | a flag flip leaves two histories with no reconciliation |
| 5 | a UI label on every stock number | users cannot distinguish an ERP cache from a live balance |

---

## 2. Mode definitions

### 2.1 Mode catalogue

`M2` is split into three cumulative capability levels because "read-only stock" and "create a
dispatch document" carry very different risk and need separate acceptance.

| Mode | Operator state | Balance writer | Movement writer | Servora stores | Conflict rule | UI may claim |
|---|---|---|---|---|---|---|
| **M0 — off** | `enabled = false` | nobody | nobody | nothing stock-related; only DOM-001 delivery records (purpose, quantity, lot/serial snapshot) | n/a | "Teslim edildi" only. No "stokta", "stok yetersiz", "rezerve". |
| **M1 — Servora authority** | `enabled = true`, `stockAuthority = SERVORA` | Warehouse module only, in the same transaction as the movement | Warehouse module (commands + core operation ports) | depots/locations, balances, append-only movements, reservations, lots/serials, movement↔source link, own audit, idempotency | external stock data is rejected/logged, never applied; no second writer | exact quantity "Şu an", reservations, optional "stok yetersiz" block; source labelled "Servora". |
| **M2-R — ERP authority, read-only** | `enabled = true`, `stockAuthority = ERP`, level R | ERP only | ERP only (ERP UI or other systems) | **cached balance snapshot** + `asOf`/`fetchedAt`/`sourceCursor`, item/warehouse mapping, sync state | ERP wins; out-of-order snapshots resolved by `asOf`; older never overwrites newer | "ERP kaydı: 12 (14:05 itibarıyla)"; "güncel değil" badge; **no** reservation, no local deduction. |
| **M2-W — + movement requests** | level W | ERP only | ERP only; Servora **requests** | M2-R + durable outbox of movement requests, request hash, attempts, ERP document reference, status | ERP may reject; rejection is a request status, never a local balance edit; retries reuse the same key | "ERP'ye iletildi — İRS-2026-000123", "bekliyor", "reddedildi: <sebep>". Balance still ERP snapshot. |
| **M2-D — + document creation** | level D | ERP only | ERP only; Servora **triggers** the ERP document (ERP numbers it) | M2-W + document type/series/number/date, e-İrsaliye status, cancellation/return references | legal document lifecycle is ERP-owned; corrections create new documents, never mutate | "Sevk irsaliyesi kesildi", "e-İrsaliye gönderildi", "iptal edildi". |
| **M3 — hybrid per location** | `stockAuthority = HYBRID` | the authority named on each location | the authority named on each location; cross-boundary transfers are single commands | M1 stores for Servora locations + M2 stores for ERP locations + location authority map + boundary transfer ledger | only boundary reconciliation; totals are never summed blindly | "Araç stoğu (Servora): 5" / "Merkez depo (ERP): 120"; total only under a stated consolidation rule. |

### 2.2 Artifact matrix — what exists in each mode

| Artifact | M0 | M1 | M2 | M3 |
|---|---|---|---|---|
| Item ↔ ERP item code mapping | — | optional (forward-compat) | required for every tracked item | required on the ERP side |
| Location ↔ ERP warehouse code mapping | — | optional | required | required per location |
| Balance row | — | **owned** | **cache only** (`asOf`, `fetchedAt`, `sourceCursor`) | per location, owner-marked |
| Movement ledger | — | **owned, append-only** | not owned; optional ERP movement feed for explanation only | owned for Servora locations |
| Movement request / outbox | — | not needed (executes locally) | **owned at W/D**; none at R | only for boundary transfers |
| ERP document reference | — | optional | **owned at W/D**; none at R | **owned** for boundary documents |
| Reservations | — | **owned** | forbidden locally | Servora locations only |
| Lot / serial / expiry ledger | — | **owned** | passed through on request lines; no local lot balance | Servora locations only |
| Count / cutover record | — | opening count required | first full snapshot + cutover record | boundary count at cutover |
| Module audit | — | own append-only table (see §7 D3) | own append-only table | own append-only table |

`M2` deliberately does **not** store an independent movement sum. If a read-only ERP movement
feed is stored, it is labelled `ERP_REPORTED`, is used to explain a delta, and is never the
source of a displayed balance. Otherwise the cache silently becomes a second ledger.

### 2.3 Why split M2 into R / W / D

| Level | New failure surface | Reversible by | Useful alone? |
|---|---|---|---|
| R | stale data, mapping errors, wrong `asOf` semantics | yes (turn off) | yes — field staff see ERP stock without any write risk |
| W | duplicate documents, partial acceptance, ERP rejections, period closes | yes, with reconciliation | yes — the first real write integration |
| D | legal numbering, e-İrsaliye/GİB status, cancellation, returns, counter-party codes | only with a cutover/reconciliation | yes, but only after W is stable |

Shipping R first is the cheapest way to validate credentials, mappings and snapshot semantics
before any document can be duplicated. I recommend treating R as its own slice if M2 is ever
approved.

### 2.4 Does M3 (hybrid) violate MOD-001 §2?

**Not automatically — but only under five conditions.** The rule forbids the *same quantity*
having two independent authoritative states. Vehicle stock and central depot stock are different
locations; if their quantity sets are disjoint, they are different quantities.

Conditions for a lawful hybrid:

| # | Condition | Failure if violated |
|---|---|---|
| C1 | Every location has exactly one authority (`SERVORA` or `ERP`), stored, not inferred | a location written by both = direct violation |
| C2 | The two systems do not both count the same physical units. E.g. ERP central stock excludes items already loaded on vehicles | double counting; totals are wrong even when each system is "right" |
| C3 | Every cross-boundary movement is **one** command with **one** `transfer_id`, one outbound document on the source authority and one inbound reference on the destination | goods appear or disappear; no reconciliation key |
| C4 | In-transit stock has exactly one owner (recommend: Servora owns in-transit until ERP receipt is confirmed) | in-transit counted twice or not at all |
| C5 | Totals across authorities are only shown under a stated consolidation rule (same `asOf` window, quiescent boundary); otherwise subtotals only | UI implies a precision the data does not have |

**Verdict:** M3 is compatible with MOD-001 in principle, but it is the hardest mode to operate
and the easiest to get silently wrong. It must not be a V1 mode, and it must not be precluded by
modelling authority as a single global boolean. A per-location `authority` attribute whose
default comes from the installation mode costs almost nothing now and keeps M3 possible.

Two concrete violation examples to test any future design against:

- ERP central depot still contains the 20 units that were loaded onto vehicle A, while Servora
  also shows 20 on vehicle A → the same 20 units are authoritative twice (C2 violated).
- A vehicle-to-customer delivery is posted in Servora, and the same delivery is later re-entered
  in ERP as a dispatch because "ERP must have the document" → two movements for one physical
  event (C3/C2 violated).

### 2.5 What the UI may claim — allowed and forbidden wording

| Mode | Allowed | Forbidden |
|---|---|---|
| M0 | "Teslim edildi", "Teslimata hazır" | "Stokta var", "12 adet kaldı", "Stok yetersiz", "Rezerve edildi" |
| M1 | "Depoda 12 adet", "3 adet rezerve", "Stok yetersiz" (policy) | "ERP ile eşleşti" unless a real sync exists |
| M2-R | "ERP kaydı: 12 adet (14:05 itibarıyla)", "Stok bilgisi güncel değil" | "Depoda 12 adet", "12 adet mevcut", "Rezerve edildi", "Stok düşüldü" |
| M2-W | "ERP'ye iletildi — İRS-2026-000123", "Gönderim bekliyor", "ERP reddetti: <sebep>" | "Stok düşüldü" before the ERP document is confirmed |
| M2-D | "Sevk irsaliyesi kesildi — <seri/no>", "e-İrsaliye gönderildi" | "İptal edildi" unless ERP confirms cancellation |
| M3 | "Araç stoğu (Servora): 5", "Merkez depo (ERP): 120" | a single "Toplam stok" without a stated rule and aligned `asOf` |

The wording is not cosmetic: it is the only thing preventing a field user from treating a 20
minute-old ERP cache as a reservation.

### 2.6 Core operations per mode

| Core event | M0 | M1 | M2 | M3 |
|---|---|---|---|---|
| Delivery approval / completion | no stock effect | Warehouse creates the out movement in the same transaction as the approval | Warehouse creates a movement **request**; ERP decides; status shown on the card | vehicle location: local movement; central: request |
| Sale approval that opens a delivery (SALE-002) | no stock effect | same as delivery approval | same as M2 delivery request | per location |
| Consignment (`CONSIGNMENT`) | no movement (DOM-001:351) | **needs a decision** — physical stock leaves the depot | needs a decision; ERP document semantics decide | per location |
| Return (`RETURN`) | no movement (DOM-001:351) | **needs a decision** — stock re-enters | needs a decision | per location |
| Manual count / correction | — | count command + adjustment movement, audited | count result submitted to ERP (`stock_update`/`Sayım`/`ItemCounting`), local cache refreshed | local count for Servora locations |
| Depot transfer | — | local transfer movement pair | ERP transfer document (where supported); **no webhook on Paraşüt** → poll | boundary transfer + local pair |

The consignment/return row is a real conflict, not a detail: `DECISIONS.md:351` says those
purposes do not create stock movements, while MOD-001 gives the Warehouse module ownership of
"returns and corrections". The accepted rule was written for an MVP with no stock module; a
Warehouse decision must explicitly supersede that sentence (see §7).

---

## 3. Turkish ERP landscape (accessed 2026-11-26)

### 3.1 Capability matrix

"Balance read" means the vendor exposes a quantity query, not merely item cards. "Movement
create" means a stock-affecting document can be created through the API.

| Vendor / product | Item read | Warehouse read | Balance read | Movement/fiş create | Dispatch note | Lot / serial | Change events | Source |
|---|---|---|---|---|---|---|---|---|
| **Logo Tiger 3 / Wings** (Logo Objects REST) | yes (`items`) | partial (`locationCodes`; documents carry `SOURCE_WH`/`DEST_WH`; warehouse master **UNVERIFIED**) | not verified as a dedicated endpoint | yes (`itemSlips`, `salesDispatches`, `purchaseDispatches`) | yes (`salesDispatches`) | yes (`serialAndLotNumbers`) | no webhook documented → poll | S1–S4 |
| **Mikro Fly / Jump** (Mikro API) | yes (`StokListesiV2`) | partial (`Depolar Arası Sipariş` exists; warehouse master **UNVERIFIED**) | quantity in stock list — **UNVERIFIED** | yes (`DahiliStokHareketKaydetV2`, `IrsaliyeKaydetV2`) | yes (`IrsaliyeKaydetV2`, `EIrsaliyeGonderV2`) | product supports lot/serial; API fields **UNVERIFIED** | no webhook documented → poll | S7–S10 |
| **Netsis 3 / Wings** (NetOpenX REST) | yes (`Items`) | partial (`DynamicWarehsSlips`; balance query accepts item/warehouse — schema **UNVERIFIED**) | yes (`Company/BringBalance`) | yes (`ItemSlips`, `ItemCounting`) | yes (`ItemSlips` by `docType`, `NewEWaybillNumber`) | **UNVERIFIED** | no webhook documented → poll | S11 |
| **Paraşüt** (API v4) | yes (`products`) | yes (`warehouses`) | yes (`inventory_levels`) | yes (`stock_updates` create; dispatch/invoice also post) | yes (`shipment_documents` + `e_despatch`) | **UNVERIFIED** (product has `inventory_tracking`) | **yes**, official webhooks | S12–S16 |
| **ETA:V.11** | claimed | claimed; **UNVERIFIED** | claimed | claimed | claimed | **UNVERIFIED** | **UNVERIFIED** | S17–S19 |
| **Nebim V3** (Integrator REST) | claimed by brochure | claimed (store/warehouse); **UNVERIFIED** | claimed | claimed | yes (e-İrsaliye) | product characteristics; API **UNVERIFIED** | **UNVERIFIED** | S20–S21 |
| **Akınsoft Wolvox** | XML export | XML `get_depoenvanter` (warehouse inventory) | same XML export | XML import (stock movement) | XML import (irsaliye) | **UNVERIFIED** | none (file exchange) | S22–S24 |
| **DİA** (Web Servis v3) | yes (`scf_stokkart_listele`) | partial (`scf_b2c_stok_miktar_sorgula`); warehouse dimension **UNVERIFIED** | yes (`scf_b2c_stok_miktar_sorgula`) | claimed via `tsif` family; create service names **UNVERIFIED** | claimed via `tsif` | **UNVERIFIED** | no webhook documented → poll | S25–S28 |

### 3.2 Access, deployment and licence matrix

| Vendor | API style | Auth | Where it runs | Licence / onboarding gate | Document numbering |
|---|---|---|---|---|---|
| Logo | REST over Logo Objects; `POST /api/v1/token`; Bearer | Basic `clientId:clientSecret` + password grant (`username`, `firmno`, `password`) | on-prem Windows; sample `http://<host>:32001/api/v1/...` | **Logo Objects licence required**; REST itself has no separate licence; REST only on 3-series (Tiger 3, Tiger Enterprise 3, Tiger Wings), **not** Go Plus/Go 3/Logo Start/Tiger Plus/Tiger Enterprise | ERP assigns: `NUMBER: "~"`, response `INTERNAL_REFERENCE` (S3) |
| Mikro | REST/JSON local service | per-request `Mikro` block: firma, yıl, kullanıcı, MD5(date+password), `ApiKey` | on-prem Windows service; v17 `:8094`, v16 `:8084`; no active-active | API key licence; application to Mikro | series/sequence in payload; numbering ownership **UNVERIFIED** |
| Netsis | REST (`api/v2`) local service | session/token — exact grant **UNVERIFIED** (third parties report OAuth2 password grant + JWT) | on-prem; help pages point to `localhost:7070` | NetOpenX licence (**UNVERIFIED** against vendor text; reported by partners); REST package installed with default settings | `NewNumber`, `IncrementNumber`, `NewEWaybillNumber` → ERP assigns |
| Paraşüt | REST v4, JSON:API | OAuth2 Authorization Code + PKCE, confidential client, `offline_access`; currently 5-min access token, 30-day refresh | cloud SaaS only | Developer Portal API client + package (webhooks need a package that includes them) | document numbering **UNVERIFIED** (ERP-issued in practice) |
| ETA | REST (claimed) | **UNVERIFIED** | on-prem (typical); cloud **UNVERIFIED** | optional paid "API Entegrasyonu" from 2026-10-01 for V.11/Pro/SB | **UNVERIFIED** |
| Nebim | REST via V3 Integrator | **UNVERIFIED** | V3 on-prem; ERA cloud (per vendor/partner pages) | Integrator + reseller | **UNVERIFIED** |
| Akınsoft | XML file export/import (SDK) | SDK licence activation; no API auth | on-prem Windows | SDK licence; vendor states it does not support SDK development | Wolvox assigns numbers (**UNVERIFIED**) |
| DİA | JSON REST v3 | `session_id` (login) + `api_key` + firma/dönem; optional IP allowlist | cloud | per-call "kontör" (0.0125/call); API key from DİA | **UNVERIFIED** |

### 3.3 Vendor notes

**Logo**
Logo's own REST documentation states the compatibility list and the licence dependency
explicitly: REST works on Tiger 3, Tiger Enterprise 3 and Tiger Wings; it does **not** work on
Go Plus, Go 3, Logo Start, Tiger Plus or Tiger Enterprise; the REST service has no licence of
its own but requires a Logo Objects licence (S1). Auth is a token endpoint with partner-issued
client credentials, then a password grant carrying `firmno` (S2). The endpoint list — `items`,
`itemSlips` (stock movement document), `salesDispatches`/`purchaseDispatches` (dispatch notes),
`serialAndLotNumbers`, `locationCodes` — comes from a community mirror of the official
142-endpoint list (S4), because `docs.logo.com.tr` did not resolve from this environment (S5).
Document numbers are ERP-assigned: `NUMBER: "~"` plus `INTERNAL_REFERENCE` in the response (S3).

Implication: a Logo Go customer (very common in SME) has **no REST path**; the options are Logo
Objects/XML or reading SQL. Logo is therefore an M2 target only for 3-series customers with an
Objects licence.

**Mikro**
Mikro's official API portal documents a REST/JSON interface that runs as a **local Windows
service**, with v17 on 8094 and v16 on 8084, no active-active support, and per-request
authentication using company/period/user plus an MD5 password and an `ApiKey` (S10). The stock
family includes `StokKaydetV2`, `StokListesiV2` and the `DahiliStokHareket*` document endpoints
(S9); dispatch, e-İrsaliye and count endpoints are listed in the official index (S8). The portal
also exposes `SqlVeriOkuV2` and `KayitKaydetV2`, which can read/write tables directly; those are
not acceptable for stock writes because they bypass Mikro's business rules.

**Netsis**
Netsis' official NetOpenX REST help page lists `Items`, `ItemSlips` (by `docType`, with
`NewEWaybillNumber`, `IrsToFat`, `SiparisToIrsFat`), `ItemCounting`, `DynamicWarehsSlips`,
transaction control (`OpenTransaction`/`CommitTransaction`/`RollBackTransaction`) and a raw
`Queries` endpoint (S11). The help pages are only fully usable when the NetOpenX REST service is
installed locally with default settings — the links point at `localhost:7070`. Authentication is
session/token based; the exact grant is not shown on that page, so it is marked **UNVERIFIED**.

**Paraşüt**
The only vendor in this set with a fully public, current API description and official webhooks.
OAuth2 Authorization Code + PKCE with a confidential client, `offline_access` required for
server-to-server refresh; the current token lifetimes are 5 minutes for access and 30 days for
refresh, and Paraşüt explicitly says the values are representative and may change (S14).
Resources: products, warehouses, shipment documents (irsaliye, including e-Despatch), stock
movements (GET only), inventory levels (GET) and stock updates (POST create) (S12, S13, S16).
Webhooks are per `model` + `action`, authenticated with a 64-character `X-Client-Key`, delivered
at least once, with **no ordering guarantee** and no delivery guarantee; `stock_movement` events
are not sent for stock updates or warehouse transfers (S15). Rate limits depend on the API
package and return 429 (S14).

**ETA**
ETA:V.11 has a REST API according to a third-party integration summary: public documentation in
"ETA Bilgi Merkezi" with an OpenAPI definition, covering stock, current accounts, invoices,
dispatch notes and orders; it is an optional paid integration sold from 2026-10-01 (S18, S19).
I could not open an official ETA developer page from this environment, so the official URL,
auth and endpoint names are **UNVERIFIED**. Treat ETA as "probably viable, needs a vendor
conversation".

**Nebim**
Nebim's official material states that Nebim V3 Integrator exposes REST API services for
real-time, platform-independent integration, alongside database import/export (S20, S21). No
public endpoint or auth documentation was found; access and licence terms go through a Nebim
reseller. Mark endpoint-level claims **UNVERIFIED**.

**Akınsoft**
No REST stock API was found. The Wolvox SDK is an **XML file import/export** mechanism for stock
cards, stock movements and dispatch notes (S23); it requires SDK licence activation and the
vendor explicitly does not provide technical support for SDK development (S22). "Web
Entegrasyon" is an e-commerce bridge, not a general API (S24). Integration therefore needs a
Windows-side agent that writes/reads files; polling only; document numbers are Wolvox's.

**DİA**
DİA publishes an official developer documentation site: JSON REST v3, `https://<servercode>.ws.dia.com.tr/api/v3/`,
`session_id` from login plus `api_key`, company/period codes, TLS 1.2+, optional IP allowlist,
and a per-call "kontör" charge of 0.0125 (S25–S27). Service families include SCF (stock, current
accounts, invoice), with `scf_stokkart_listele`, `scf_stokkart_detay_listele`,
`scf_b2c_stok_miktar_sorgula`; the `tsif` family covers quote/order/dispatch/invoice and the
documented example names only `scf_siparis_ekle` (S26). The remaining `tsif` create service
names and their stock effects are **UNVERIFIED**. Per-call billing means adapters must batch and
cache rather than poll aggressively.

### 3.4 What the landscape implies for the design

1. **Polling is the baseline, webhooks are an optimisation.** Only Paraşüt has documented
   webhooks. Any M2 design that assumes push will fail on Logo, Mikro, Netsis, DİA, Nebim and
   Akınsoft.
2. **No vendor guarantees client idempotency.** Duplicate suppression must live on our side plus
   a per-adapter "find the document I may have created" query. This is the largest correctness
   risk in M2-W.
3. **On-prem ERPs sit inside the customer LAN.** Servora runs on a VPS. Logo, Mikro, Netsis and
   Akınsoft endpoints are not reachable from the internet unless the customer exposes them or a
   small outbound-only agent runs on site. This is a product decision, not an implementation
   detail; it can invalidate an otherwise good adapter.
4. **Every vendor gates the API commercially** (Logo Objects, Mikro API key, NetOpenX per partner
   documentation, Paraşüt package, DİA kontör, Akınsoft SDK, ETA option). Mode selection must
   record which licence was confirmed, or support will debug a licence problem for weeks.
5. **Document creation is stock-affecting in the products where it was verified.** Logo, Mikro,
   Netsis and Paraşüt create stock movements when a dispatch/invoice is posted; no vendor
   documentation describes a "print only, no stock effect" mode. DİA's `tsif` family follows the
   same pattern but its create services were not individually verified.

---

## 4. Integration mechanics allowed by MOD-001 §4

Accepted boundary (`DECISIONS.md:2041-2050`): current SSE/realtime is not durable domain
integration; without a concrete producer/consumer and a reliable-delivery requirement, no
generic event bus, persistent global outbox, integration queue, webhook framework or Kafka/Redis
architecture is built. A **narrow durable integration/outbox contract under module ownership**
may be designed when real Warehouse/Accounting integration starts. The web-push outbox is not
domain integration.

### 4.1 Minimal adapter contract (proposal)

The contract has exactly two payload families and one optional lookup. Everything else is
adapter-internal.

```ts
// Proposal only — no such file exists today.
type StockAuthorityAdapter = {
  key: 'LOGO_REST' | 'MIKRO_API' | 'NETSIS_NETOPENX' | 'PARASUT_V4' | 'DIA_V3' | string;
  capabilities: {
    balanceRead: boolean;
    movementCreate: boolean;
    dispatchDocument: boolean;
    lotSerial: boolean;
    webhooks: boolean;
    canCarryExternalRef: boolean; // can the ERP print/store our requestId on the document?
  };

  /** Inbound: one page of ERP balances. */
  fetchBalances(input: {
    warehouseCodes: string[];
    cursor?: string;
    changedSince?: string; // ERP clock, never ours
  }): Promise<{
    rows: Array<{
      warehouseCode: string;
      itemCode: string;
      quantity: string;        // decimal string, never float
      unitCode: string;
      lotNo?: string | null;
      serialNo?: string | null;
      asOf: string;            // ERP-reported source time
    }>;
    nextCursor?: string;
    complete: boolean;
  }>;

  /** Outbound: ask the ERP to create a stock-affecting document. */
  submitMovement(input: {
    requestId: string;         // our UUID, printed on the ERP document where possible
    idempotencyKey: string;    // stable across retries
    documentType: 'SALES_DISPATCH' | 'STOCK_ISSUE' | 'STOCK_RECEIPT'
                | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'COUNT_ADJUSTMENT';
    documentDate: string;      // business date, not send time
    warehouseCode: string;
    counterpartyCode?: string;
    lines: Array<{
      itemCode: string;
      quantity: string;
      unitCode: string;
      lotNo?: string | null;
      serialNo?: string | null;
      expiryDate?: string | null;
    }>;
    note?: string;             // carries our reference when the ERP allows it
  }): Promise<{
    status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';
    erpDocument?: {
      type: string;
      series: string;
      number: string;
      externalId?: string;
      issuedAt: string;
    };
    error?: { code: string; message: string; retryable: boolean };
  }>;

  /** Optional per adapter: did a previous UNKNOWN attempt actually create a document? */
  findDocument?(input: {
    requestId: string;
    documentType: string;
    documentDate: string;
    warehouseCode: string;
  }): Promise<{ series: string; number: string; externalId?: string } | null>;
};
```

Design rules that must survive implementation:

- `quantity` is a decimal **string** end to end. SALE-QTY-001 (integer sale counts) does not
  define Warehouse measurement; the schema draft's delivery items use `NUMERIC(12,3)`
  (`server/src/db/migrations/002_delivery_tracer.sql:145`), and SALE-QTY-001 explicitly leaves
  "future Warehouse physical measurement policies" independent (`DECISIONS.md:2097-2098`).
- `asOf` is the ERP's clock; `fetchedAt` is ours. They are stored separately. Never sort
  snapshots by `fetchedAt` when `asOf` exists.
- The adapter never decides business policy (whether a dispatch may be issued, whether negative
  stock is allowed). It only translates.

### 4.2 Durable outbox — state machine

One module-owned table (name illustrative): `warehouse_movement_requests`.

| State | Meaning | Allowed next |
|---|---|---|
| `PENDING` | committed with the business command, not sent | `CLAIMED`, `CANCELLED` (only before first send) |
| `CLAIMED` | worker holds a lease (`FOR UPDATE SKIP LOCKED`) | `SENT`, `PENDING` (lease expiry) |
| `SENT` | HTTP call in flight or response not yet classified | `ACCEPTED`, `REJECTED`, `UNKNOWN` |
| `ACCEPTED` | ERP returned a document reference | terminal |
| `REJECTED` | definitive ERP refusal (validation, closed period, insufficient stock) | terminal; a corrected retry needs a **new** command/key |
| `UNKNOWN` | timeout, 5xx, connection reset, ambiguous body | `RESOLVED_ACCEPTED`, `RESOLVED_ABSENT`, `DEAD_LETTER` |
| `DEAD_LETTER` | exhausted attempts or unresolvable ambiguity | operator action only |

Rules:

- The row is inserted **in the same transaction** as the business mutation that needs it
  (`AGENTS.md:190-199`: no side effects before idempotency state is claimed).
- Unique `(organization_id, idempotency_key)`; `request_hash` covers the semantic payload.
  Reuse with a different hash is a conflict, mirroring ARC-001 (`DECISIONS.md:391-398`).
- Retries reuse the same key and hash. A new key is only for a new intent.
- Backoff is bounded (e.g. 6–8 attempts over 24 h) and then `DEAD_LETTER`; no infinite retry.
- `UNKNOWN` may **never** be retried blindly. First `findDocument`; if the adapter cannot look
  up, the row waits for reconciliation and operator confirmation.
- Worker claims are per connection, with one rate limiter and one token cache per connection
  (important for Paraşüt's package limits and DİA's per-call billing).

### 4.3 Duplicate suppression against ERPs without idempotency keys

| Strategy | Works when | Vendors |
|---|---|---|
| print our `requestId` in a free-text/reference field and search by it | ERP stores and exposes the field | Logo (`DEFNFLDS`/description — **UNVERIFIED**), Paraşüt (document `description` — **UNVERIFIED**), Mikro (`Aciklama` — **UNVERIFIED**) |
| search by returned document number | the first response was received | all |
| bounded search by (date, warehouse, counterparty, line set) | no reference field | all, but weak; needs human confirmation on ambiguity |
| ERP-native idempotency key | none documented | none in this set |

This table is a per-adapter acceptance requirement, not an implementation footnote. If an
adapter cannot support any lookup, it must not be offered at level W.

### 4.4 Reconciliation

| Level | What is compared | Cadence | Output |
|---|---|---|---|
| R1 — request | outbox row vs ERP document (by number or external ref) | on `UNKNOWN`, on demand, daily sweep | resolved / dead letter |
| R2 — balance | ERP snapshot delta in a window vs accepted requests in the same window | after each full snapshot; daily minimum | exception rows (item, location, expected delta, observed delta) |
| R3 — document | ERP dispatch list vs outbox documents | daily, optional | missing/orphan document list |
| R4 — cutover | Servora balance vs ERP snapshot at the switch instant | once per mode change | signed cutover record with variance |

Rules: reconciliation never writes a balance. A divergence creates an exception; a correction
is a new, explicit, audited command with a reason. Automatic "self-healing" would hide exactly
the double-authority problem MOD-001 forbids.

### 4.5 Document references

ERP document numbers are the only stable cross-system key; internal IDs differ per vendor
(`INTERNAL_REFERENCE`, GUID, `FaturaNo`, JSON:API id). Proposal:

| Column | Purpose |
|---|---|
| `connection_id` | which ERP connection produced it |
| `document_type` | `SALES_DISPATCH`, `STOCK_ISSUE`, `E_DESPATCH`, `INVOICE` … |
| `series`, `number` | the legal number; unique per connection+type |
| `external_id` | vendor internal id/GUID when exposed |
| `issued_at`, `direction` | ERP date; `OUTBOUND` (we requested) or `INBOUND` (ERP-originated) |
| `source_module`, `source_type`, `source_id` | Warehouse or Accounting, and the local object |
| `supersedes_id` | cancellation/correction chain; rows are immutable |

`UNIQUE (connection_id, document_type, series, number)` prevents the same ERP document being
attached to two local objects. Corrections create a new row and link backwards; a document is
never edited in place.

### 4.6 Relationship with the future Accounting module (MOD-001 §3)

MOD-001 §3 says the official financial authority may later be Logo, Netsis, Mikro or another
ERP, and that concrete integration and document ownership are decided in **Accounting A0**
(`DECISIONS.md:2032-2040`). That means:

- Do **not** build Accounting's side now, and do not create an "integration module" with no
  second consumer.
- Do build Warehouse's M2 adapter so that a second consumer can reuse transport without
  inheriting Warehouse's business rules.

Recommended split when Accounting lands:

| Shared (one per installation) | Module-owned (two instances) |
|---|---|
| `erp_connections` row: adapter, base URL, company/period, encrypted credentials, health, adapter version | movement request queue (Warehouse) |
| token cache and rate limiter per connection | invoice/payment request queue (Accounting) |
| item-code and customer-code mapping lookup | stock document references (Warehouse) vs invoice references (Accounting) |
| connectivity test and clock-skew check | retry policy per document class |

Document ownership:

| Document | Owner | Why |
|---|---|---|
| Stock issue / receipt / transfer / count adjustment | Warehouse | it changes physical stock |
| Sales dispatch (sevk irsaliyesi) | Warehouse when it moves stock; Accounting links the invoice to it | one physical event, one stock document |
| Sales invoice / e-Arşiv / e-Fatura | Accounting | commercial/financial document |
| Collection / payment | Accounting | financial |

The dangerous alternative is two connectors with separate token caches and separate retry loops
hitting the same ERP rate limit, each convinced it owns the dispatch. One connection row with two
queues prevents that.

### 4.7 What not to build

- no generic event bus, Kafka, Redis queue, or global outbox;
- no webhook framework before an adapter that actually has webhooks (only Paraşüt today);
- no bidirectional product/stock sync (DOM-004 keeps the catalog informational);
- no direct database writes into any ERP;
- no local balance arithmetic in M2 "to make the UI faster";
- no reservation in M2;
- no adapter-specific business rules leaking into core or into the Warehouse domain service.

---

## 5. How the mode is set, and how it can be switched

### 5.1 What exists today (code)

| Fact | Evidence |
|---|---|
| The module registry has exactly one key, `OVERVIEW`, with a boolean capability and a legacy env key | `server/src/modules/installation-modules/registry.ts:7-24` |
| Module state is one typed row per key: `module_key`, `enabled`, `version`, `source`, `updated_at`, `updated_by_operator_id`; installation-level, no `organization_id` | `server/src/db/migrations/074_installation_operator_and_module_state.sql:51-65` |
| The key CHECK allows only `OVERVIEW` | `074_installation_operator_and_module_state.sql:59` |
| The audit event CHECK allows only the current seven event types, and `module_key` only `OVERVIEW` | `074_installation_operator_and_module_state.sql:80-87` |
| Reads are one primary-key read per call, no cache; missing row or DB failure is fail-closed | `server/src/modules/installation-modules/state.ts:42-63`, `:86-102` |
| First start takes the legacy env value over once, with `INSERT … ON CONFLICT DO NOTHING` and a same-transaction audit event | `server/src/modules/installation-modules/takeover.ts:20-57` |
| The operator API toggles a boolean: `PUT /api/operator/modules/:key { enabled, expectedVersion }` | `docs/features/operator-module-pilot.md:79-80`, `:284-286` |
| Disabled module → `404`; unreadable state → `503`; no env fallback | `docs/features/operator-module-pilot.md:154-161` |
| A module capability is a typed boolean on the authenticated user payload | `server/src/modules/capabilities/types.ts:1-8`; defaults all `false` in `capabilities/service.ts:7-13` |
| No migration creates a stock/warehouse table; the only stock-adjacent columns are `lot_no`, `serial_no`, `expiry_date` on delivery items | `server/src/db/migrations/002_delivery_tracer.sql:137-162` (`:150-152`) |

So the mechanism is a good **on/off switch** and a poor **mode switch**.

### 5.2 Gaps a mode decision must close

1. `enabled BOOLEAN` cannot express M0/M1/M2/M3; a second boolean would encode a state machine
   in two flags (invalid combinations).
2. The operator contract is a generic `{enabled, expectedVersion}` body; module-specific typed
   settings need their own endpoint, or the generic endpoint becomes a settings bag (UI-002).
3. The operator audit shape stores `{enabled: boolean}` only
   (`074...sql:108-119`); a mode change needs old/new mode (and optionally a cutover id).
4. The CHECK constraints block a new module key and new event types; a new migration extends
   them. Migration 074 is already applied and is never edited (`AGENTS.md` §6).
5. There is no cutover/reconciliation record anywhere.
6. Restore semantics return module state to the backup instant
   (`docs/features/operator-module-pilot.md:186-189`). A restored older mode can disagree with
   the ERP's current state; restore validation must check the mode and the last cutover.
7. A `WAREHOUSE` capability must default to `false` everywhere, like the existing capabilities.
8. The takeover input is typed to Overview only (`takeover.ts:20-24`); a new module key needs a
   defined first-start default (off) or a legacy env input, and it must keep the same fail-closed
   recovery rule when the row is missing but a takeover event exists.

### 5.3 Representation options

| Option | Shape | Pros | Cons | Verdict |
|---|---|---|---|---|
| **A. Module-owned typed settings** | keep `installation_module_state.enabled`; add `warehouse_settings` (single row: `stock_authority` enum, `dispatch_policy`, `snapshot_stale_after_seconds`, `version`, `updated_by_operator_id`) + `warehouse_mode_cutovers`; new `PUT /api/operator/warehouse/settings` | typed, auditable, keeps generic module API boolean-only; module can evolve without touching core | one more table and endpoint; operator UI needs a second control | **recommended** |
| B. Extra nullable columns on `installation_module_state` | `stock_authority`, `dispatch_policy`, … | one table | turns the shared state table into a per-module settings bag; every future module adds columns | rejected |
| C. Env key | `WAREHOUSE_STOCK_AUTHORITY=...` | trivial | MOD-002 §4: after takeover the database is the only source; env ceiling only for secrets/infra | rejected |
| D. Mode replaces `enabled` | `mode: OFF / M1 / M2 / M3` only | single source | operator panel and existing contract are built around `enabled`; `M2` needs sub-levels; capability projection becomes ambiguous | rejected for now |

Option A also answers the "who may change it" question: the operator holds `MODULE_MANAGEMENT`
today; a separate `WAREHOUSE_INTEGRATION` capability would need its own MOD-002 decision, so I
would not invent it in the first Warehouse slice.

Consistency rule for Option A: `enabled = false` is always M0 regardless of the stored
`stock_authority`; the settings endpoint refuses a mode change while the module is disabled, and
the operator UI must never show both a disabled module and a live mode. Otherwise the pair
`enabled` + `stock_authority` becomes a second, implicit state machine.

### 5.4 Transition table (proposal)

| From → to | Preconditions | Artifact | Forbidden when |
|---|---|---|---|
| OFF → M1 | opening count per depot/item confirmed; items marked tracked; no historical delivery is auto-deducted | opening-balance movement(s) + audit | any opening balance missing |
| OFF → M2-R | connection verified (auth + clock skew); first **complete** snapshot; mappings for all active items; stale threshold set | first snapshot batch + audit | mapping gaps for items in use |
| M2-R → M2-W | adapter `movementCreate`; document policy chosen; duplicate-lookup strategy proven | policy row + audit | adapter cannot look up an ambiguous document |
| M2-W → M2-D | legal document test in a non-production company; e-İrsaliye configuration confirmed; cancellation path defined | test evidence + audit | no test company / no cancellation path |
| M1 → M2 (any level) | freeze new movements; drain local movement intents; resolve/cancel reservations; **cutover count**; variance decision; mark M1 balances historical | signed cutover record + audit | open reservations, open intents, or unexplained variance |
| M2 → M1 | final snapshot; opening count (or snapshot accepted as opening); pending requests resolved or cancelled; cache marked historical | cutover record + audit | `UNKNOWN`/`DEAD_LETTER` rows remain |
| any → OFF | no open requests; operator confirms data retention | audit | open requests |
| any → any while the ERP period is closed | — | — | ERP rejects documents; switch would create unpostable requests |

Two rules make the table safe:

- A mode change is **not** a field edit. It creates an append-only cutover record with actor,
  time, counts, variance and resolution.
- The switch is blocked while the outbox has non-terminal rows. Otherwise the new authority
  inherits requests the old one never answered.

### 5.5 Cutover record (proposal)

`warehouse_mode_cutovers` (header) + `warehouse_mode_cutover_lines`:

| Field | Why |
|---|---|
| `from_mode`, `to_mode`, `effective_at` | what changed and when |
| `counted_at`, `count_reference` | evidence that a physical count or a complete snapshot exists |
| `variance_policy`: `ACCEPT_ERP` / `ACCEPT_SERVORA` / `MANUAL` | who wins for the difference; must be explicit |
| line: `item`, `location`, `qty_servora`, `qty_erp`, `variance`, `resolution` | auditable reconciliation, not a single total |
| `operator_id`, `note` | accountability |
| `created_at` | append-only |

### 5.6 What happens to balances and history after a switch

- **Nothing is deleted.** M1 movements remain as operational history; M2 snapshots remain as
  read history.
- Every movement/snapshot row carries an `authority` (and a `cutover_id`/epoch) so reports can
  segment by authority. A report spanning a cutover must not sum quantities from two
  authorities as if they were one series.
- After M1→M2, Servora balances are `HISTORICAL`: readable for audit, never used for a current
  claim and never adjusted to match ERP.
- After M2→M1, ERP snapshots are `HISTORICAL`; the opening count/snapshot becomes the M1
  opening balance.
- Reservations do not survive a switch: they are cancelled explicitly (with reason) at cutover.
- A reversal is a **new** cutover, not an edit of the old one.

### 5.7 Is the switch one-way?

I recommend **not** one-way, but **always gated**:

- One-way (M1→M2 irreversible) is commercially unrealistic: customers change ERP, stop paying
  for an ERP module, or discover that the ERP stock is unusable.
- Free reversal is worse: flipping back without a count leaves two irreconcilable histories.
- Therefore: reversible in both directions, but only through the cutover procedure in §5.4–5.5,
  with the outbox empty and a variance decision recorded.

---

## 6. Recommendation

### 6.1 V1 scope

**V1 supports M0 and M1 only.** M2 is designed for but not built; M3 is explicitly out of scope.

Reasons:

1. MOD-001's default intent is "Servora Warehouse aims to act as the stock authority when
   enabled" (`DECISIONS.md:2027-2028`); M1 is the aligned first mode.
2. The core-modules research already sequences Warehouse as the first new module with narrow
   contracts, and its acceptance ideas are M1-shaped (repeated command creates no second
   movement; enabling does not auto-deduct old deliveries)
   (`docs/backlog/2026-11-25-core-modules-architecture-research.md:230`, `:95-99`).
3. M2 needs a vendor licence, a network path, a duplicate-suppression strategy, a support
   process and a cutover runbook. None of that exists yet; shipping it half-done would create
   the double authority MOD-001 forbids.
4. **Customers who already run stock in an ERP must stay M0 in V1, not run a fake M1.** This is
   the honest product position: a local stock ledger that disagrees with the ERP from day one is
   worse than no stock screen.

### 6.2 What to design now so M2 is not blocked later

| # | Design decision now | Why it is cheap now and expensive later |
|---|---|---|
| 1 | Balance read port returns `{ quantity, asOf, source, freshness }`, never a bare number | UI can render provenance in M1 and reuse the same contract for M2 cache |
| 2 | Movement **intent** object with `idempotencyKey` + `requestHash`, separate from execution | M1 executes locally; M2 routes the same intent to an outbox; acceptance tests are shared |
| 3 | `location.authority` attribute, default from the installation mode, one authority per location | keeps M3 possible without a later data migration; makes C1 enforceable |
| 4 | ERP item/warehouse/unit mapping tables (nullable, unique per connection) | mapping is the long pole in every real integration; the schema shape is cheap |
| 5 | `erp_document_refs` shape (type, series, number, external id, issued_at, source, supersedes) | Warehouse needs it in M2, Accounting needs it later; one shape, two consumers |
| 6 | Typed operator settings endpoint + audit event for mode changes | avoids the boolean dead end and the JSONB bag |
| 7 | Cutover record table from day one, even if no UI uses it yet | switching later without it is a data-integrity incident |
| 8 | No generic bus/outbox; create the outbox table only with the first adapter | MOD-001 §4 and YAGNI |

### 6.3 Sequenced path (proposal, not an approved plan)

| Step | Content | Gate |
|---|---|---|
| W0 | Mode decision (this document's open questions) + Warehouse contract | owner approval; AGENTS §13 |
| W1 | M1 vertical slice: one delivery-linked movement end to end | W0 decision + Warehouse module key registered and enabled (boolean) |
| W2 | Operator typed settings + cutover record + audit | W1 schema stable |
| W3 | M2-R for **one** adapter, read-only, one pilot customer | licence, network path, mappings, snapshot semantics |
| W4 | M2-W movement requests + outbox + reconciliation | W3 stable for one billing cycle |
| W5 | M2-D dispatch/e-İrsaliye creation | legal test company + cancellation path |
| W6 | Accounting A0 reuses the connection/transport | MOD-001 §3 decision |

### 6.4 Triggers that would justify starting M2

Do not start M2 because "customers ask for ERP". Start when all of these are true:

1. a named pilot customer, a named ERP **and edition**, and a confirmed API licence;
2. a network path (public endpoint or on-site agent) that the customer's IT has approved;
3. a written document policy (who issues the dispatch, whether goods may leave before ERP
   acceptance);
4. a duplicate-suppression strategy that the adapter can actually execute;
5. a cutover/reconciliation owner on the customer side.

If any is missing, the correct answer is M0.

---

## 7. Drift and conflicts to resolve explicitly

| # | Conflict | Evidence | Consequence |
|---|---|---|---|
| D1 | "CONSIGNMENT and RETURN do not create stock movements" vs Warehouse owning returns/corrections | `DECISIONS.md:351` vs `DECISIONS.md:2023-2025` | a Warehouse decision must explicitly supersede the sentence; otherwise the module cannot model consignment stock |
| D2 | Boolean-only module state vs a typed 4-mode authority | `074...sql:51-65`, `operator-module-pilot.md:79-80` vs `DECISIONS.md:2029-2030` | needs the typed settings table and a new operator endpoint |
| D3 | `audit_events` is people-scoped (`subject_type IN ('USER','STAFF_PROFILE')`) | `server/src/db/migrations/003_people.sql:32-51` | Warehouse cannot reuse the people audit table; it needs its own append-only audit (or an approved extension) |
| D4 | `processed_actions` is user-command idempotency (`organization_id, user_id, client_action_id, operation_key`) | `002_delivery_tracer.sql:196-216` | an ERP outbox is not a user command; use a module-owned table with the same hash/replay discipline, not `processed_actions` |
| D5 | AGENTS §13 forbids a full warehouse module without explicit approval | `AGENTS.md:398` | this document is research only; W0/W1 need explicit owner authorization |
| D6 | Document authority ≠ balance authority assumption | vendor docs S1–S15 (Logo, Mikro, Netsis, Paraşüt): document creation posts stock | "M1 + ERP dispatch" is usually double authority; must be a decision, not an implementation detail |
| D7 | No stock tables exist today | grep of `server/src/db/migrations` for stock/warehouse/depot table creation returns nothing; only delivery lot/serial columns at `002_delivery_tracer.sql:150-152` | consistent with MOD-001 "no tables now"; no migration debt to unwind |

---

## 8. Sources (all accessed 2026-11-26)

Full URLs, fetch status and publication dates are recorded in the evidence bundle
(`erp-source-log.md`). The table below is the citation map used in this document.

| ID | Source | URL |
|---|---|---|
| S1 | Logo — "Logo REST - Temelleri" (compatible products, Logo Objects licence) | https://polaris.logo.cloud/docs/tiger-uyarlama-araci/detail/external?cid=ee7d0f8d-6890-4218-a94c-fb64325a1c53&link=ee7d0f8d-6890-4218-a94c-fb64325a1c53&tenantId=cdd87e13-3009-4dd1-a5b8-2a005c0e58da&hideName=True |
| S2 | Logo — "REST Service - 1 - Projeye başlarken" (token endpoint, Bearer) | https://polaris.logo.cloud/docs/tiger-uyarlama-araci/detail/external?cid=1864f1e8-9a0a-4833-b8aa-821bb6562d5a&link=1864f1e8-9a0a-4833-b8aa-821bb6562d5a&tenantId=cdd87e13-3009-4dd1-a5b8-2a005c0e58da&hideName=True |
| S3 | Logo — "REST Service - 3 - Verileri yazmak için POST" (`NUMBER: "~"`, `INTERNAL_REFERENCE`) | https://polaris.logo.cloud/docs/tiger-uyarlama-araci/detail/external?cid=da5792ab-4646-44bc-8643-4a75276acc2a&link=7fe6d6b0-73cd-4d25-8e24-60af8de8a966&tenantId=cdd87e13-3009-4dd1-a5b8-2a005c0e58da&hideName=True |
| S4 | Logo REST 142-endpoint list (community mirror; links official docs) | https://logo.canberkdoger.com/rest-api |
| S5 | Logo official REST documentation target — **did not resolve** (DNS) | https://docs.logo.com.tr/public/wua/logo-objects-rest-servis |
| S6 | Logo j-Platform product page | https://www.logo.com.tr/urun/logo-j-platform |
| S7 | Mikro API portal | https://apidocs.mikro.com.tr/ |
| S8 | Mikro API endpoint index | https://apidocs.mikro.com.tr/apis |
| S9 | Mikro stock endpoints | https://apidocs.mikro.com.tr/apis/stok |
| S10 | Mikro API FAQ/guides (ports, auth block, licensing) | https://apidocs.mikro.com.tr/guides |
| S11 | Netsis — NetOpenX Rest library (official help page) | https://polaris.logo.cloud/docs/netsis-uyarlama-araclari/detail/external?cid=803cd896-76fe-4472-9cc8-88f3ad12e44b&link=61756e25-5103-4633-9636-a876f9b901ad&tenantId=cdd87e13-3009-4dd1-a5b8-2a005c0e58da&hideName=True |
| S12 | Paraşüt API v4 documentation | https://apidocs.parasut.com/ |
| S13 | Paraşüt OpenAPI 4.1.0 (change log 2026-11-12) | https://devhub.parasut.com/openapi.json |
| S14 | Paraşüt OAuth 2.0 guide | https://devhub.parasut.com/oauth-rehberi |
| S15 | Paraşüt webhook guide | https://devhub.parasut.com/webhook-rehberi |
| S16 | Paraşüt invoice/dispatch guide | https://devhub.parasut.com/fatura-irsaliye-rehberi |
| S17 | ETA V.11 product page | https://www.eta.com.tr/urunler/v11/tanitim |
| S18 | ETA API third-party summary (official docs claim — **UNVERIFIED**) | https://dcloudsoftware.com/tr/cozumler/eta-entegrasyon |
| S19 | ETA API sale announcement (2026-10-15) | https://elkon.com.tr/eta-api-entegrasyonu-satisa-sunuldu.html |
| S20 | Nebim — external systems integration | https://www.nebim.com.tr/tr/harici-sistemlerle-entegrasyon |
| S21 | Nebim V3 brochure (2020-09-24) | https://www.nebim.com.tr/i/assets/images/v3_brosur/Nebim_V3_BR20.pdf |
| S22 | Akınsoft — Wolvox SDK operations (updated 2026-09-03) | https://bilgibankasi.akinsoft.net/tr/home/makale/3994-wolvox-sdk-islemleri |
| S23 | Akınsoft — Wolvox SDK document v1.02.01 (2025-12-01) | https://akinsoft.net/bilgibankasi/data/upload/3994/wolvox_sdk_dokuman1764921190.pdf |
| S24 | Akınsoft — Wolvox Web Entegrasyon product page | https://www.akinsoft.com.tr/programlar/detay/wolvox-web-entegrasyon--wwb9 |
| S25 | DİA — Web Servis API home | https://doc.dia.com.tr/doku.php?id=gelistirici%3Awsapi%3Aanasayfa |
| S26 | DİA — Web service FAQ (server URL, api key, company/period) | https://doc.dia.com.tr/doku.php?id=gelistirici%3Awsapi%3Asss_ws_0 |
| S27 | DİA — Web service overview (kontör, TLS 1.2, session) | https://doc.dia.com.tr/doku.php?id=gelistirici%3Awsapi%3Agenel |
| S28 | DİA — API information page | https://www.dia.com.tr/dia-api-bilgileri |

---

## 9. Open questions for the owner

Each question has options and my recommendation. None is decided.

**Q1. Which modes does V1 ship?**
A) M0 + M1 only. B) M1 + M2-R. C) M1 + M2-R/W. D) all.
**Recommendation: A.** It matches MOD-001's default, the existing slice order and the current
support capacity. M2-R is the first extension if a pilot appears.

**Q2. Should authority be modelled per location from day one?**
A) Yes: `location.authority` with a default from the installation mode. B) No: a single global
mode now, refactor later.
**Recommendation: A.** It costs one typed column/table now and is the difference between M3
being possible and requiring a data migration under load. It also makes the "one writer per
quantity" test enforceable in code.

**Q3. Must a mode switch require a physical count/cutover record?**
A) Always, both directions. B) Only M1→M2. C) Only when the variance exceeds a threshold.
**Recommendation: A.** Without a count, the first week after a switch is spent explaining
differences that no one can attribute. A complete ERP snapshot may substitute for a physical
count in M2→M1 only if the owner accepts it explicitly.

**Q4. In M2, may a delivery be completed before the ERP accepts the dispatch document?**
A) Block completion until `ACCEPTED`. B) Queue and allow, show "belge bekliyor". C) Per
installation policy field.
**Recommendation: C with default A** when the deployment declares a legal dispatch obligation;
B is acceptable only for non-document stock issues. This is a legal/operational policy, not a
technical preference.

**Q5. Where does the adapter live?**
A) Inside the Warehouse module, extracted to a shared connection/transport when Accounting
lands. B) A standalone integration module now. C) Inside core.
**Recommendation: A.** MOD-001 §4 forbids generic integration infrastructure before a second
consumer. Accounting A0 is the second consumer; extract then, not now.

**Q6. If one adapter is built first, which ERP?**
A) Paraşüt (public API, OAuth, webhooks, cloud reachable). B) Logo (large installed base in
the segment, but licence/product/network gates). C) Mikro. D) Netsis. E) DİA.
**Recommendation: A for a first M2-R pilot**, because it is the only vendor whose auth,
endpoints and webhooks I could verify end to end from public documentation; Logo is the better
long-term commercial target but has the most onboarding gates (Objects licence, 3-series only,
LAN exposure).

**Q7. Warehouse quantity precision and units?**
A) Integer counts like SALE-QTY-001. B) `NUMERIC(12,3)` like delivery items. C) Per-item decimal
with a unit conversion table.
**Recommendation: B for V1**, because delivery items already use it and SALE-QTY-001 explicitly
leaves Warehouse measurement independent (`DECISIONS.md:2097-2098`); C only when a real
customer needs multi-unit conversion. Decide in W0, not in the adapter.

**Q8. Item/warehouse mapping ownership and unmatched items?**
A) Operator maintains mappings. B) Customer ADMIN maintains them. C) Auto-create ERP items.
**Recommendation: B for day-to-day mapping, operator only for the connection; never auto-create
items in the ERP (duplicate item cards are unrecoverable).** Unmapped items must block M2
writes for that item and show a clear error.

**Q9. How stale may an M2 balance be before the UI refuses to use it?**
A) Fixed 15 min. B) Configurable per installation/warehouse. C) No threshold, always show
`asOf`.
**Recommendation: B with a conservative default (15 min)**, and always show `asOf` regardless.
Stale data may still be displayed, but it must not be used for a decision that implies
availability.

**Q10. Does M2 include ERP item catalog mirroring?**
A) Yes, copy items into `products`. B) No, mapping only. C) One-way manual import tool.
**Recommendation: B.** DOM-004 keeps the catalog informational; copying ERP items creates a
second master and a sync problem with no owner.

**Q11. How is DOM-001's consignment/return sentence superseded?**
A) New decision record that replaces it for Warehouse-enabled installs. B) Keep it and exclude
consignment/return from stock. C) Treat consignment as a transfer, not a sale.
**Recommendation: A + C**: consignment becomes a transfer to a consignment location (still
owned stock), return becomes an inbound movement; both require an explicit supersession so the
product rule and the module do not contradict each other.

---

## 10. Unverified / gaps

External documentation gaps:

- `docs.logo.com.tr` did not resolve from this environment; Logo REST details come from Logo's
  `polaris.logo.cloud` support pages (S1–S3) and a community mirror of the endpoint list (S4).
  The 142 endpoints were not individually verified against an official Swagger page.
- Logo j-Platform's "RESTful API" claim comes from a product brochure (S6); no endpoint, auth or
  schema documentation was found.
- Netsis per-endpoint schemas are gated behind a locally installed NetOpenX REST service; only
  endpoint names and descriptions were readable (S11). The auth grant is **UNVERIFIED**.
- ETA:V.11's official developer documentation URL, auth and endpoint names are **UNVERIFIED**;
  the only concrete source is a third-party summary plus a reseller announcement (S18, S19).
- Nebim V3 Integrator has no public endpoint/auth documentation; all endpoint-level claims are
  **UNVERIFIED** (S20, S21).
- Mikro lot/serial API fields and the cloud "JumpBulut API" scope are **UNVERIFIED**; the
  absence of webhooks is inferred from the official documentation, not stated by Mikro.
- Akınsoft has no REST stock API in the material found; the SDK is XML-file based (S22–S24).
- Paraşüt's exact `stock_updates` payload and whether a dispatch document can carry a free-text
  external reference were not inspected field by field; the resource and webhook behaviour were
  (S13, S15).

Research limits:

- No ERP sandbox, credential or live instance was available. Nothing was executed against a
  real ERP; no adapter code was written.
- Network reachability from a Servora VPS to on-prem Logo/Mikro/Netsis/Akınsoft installations
  was not tested. This is a first-order risk, not a detail.
- Turkish e-İrsaliye/GİB legal rules, cancellation windows and period-close rules were not
  researched; they constrain M2-D and must be part of that slice's contract.
- ERP version matrices and licence terms change; the licence statements above are as of
  2026-11-26 and must be re-confirmed per customer.
- Warehouse quantity precision, lot/serial policy and reservation semantics are sibling research
  topics; this document only states where they interact with the mode.
