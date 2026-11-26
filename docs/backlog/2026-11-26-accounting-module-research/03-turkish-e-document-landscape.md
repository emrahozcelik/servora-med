# Turkish e-Document Landscape for a Medical/Dental Product Distributor

Research note, 2026-11-26. Input for the Accounting ("Muhasebe") A0 decision, not a
decision and not tax advice. Every web claim carries a URL and the access date
(2026-11-26); effective/publication dates are given where the source shows them.
Facts that change often are marked **VOLATILE**. Anything not confirmed against an
official source is marked **UNVERIFIED**.

Scope note used for the final table (the A/B/C cuts are taken from the task's scope
note; that note is not a file in this checkout, so the cuts are restated verbatim
below):

- **Cut A** — invoice references only.
- **Cut B** — priced commercial documents without issuing.
- **Cut C** — B + light current account and collections.

Repo anchors used below: `DECISIONS.md:2032-2040` (MOD-001 §3: light commercial
layer, invoice references and lines, current account/receivable, collections,
document tax data; Core never gains chart of accounts, journals, e-Defter, payroll,
bank reconciliation or a posting engine), `AGENTS.md:399-400` (§13 forbids a full
accounting module and e-invoice/e-archive integration without explicit approval),
`docs/architecture/decision-reconciliation-report.md:95-104` (Accounting A0 titles).

## Summary

- For a medical/dental distributor, e-Fatura is **not primarily a revenue-threshold
  question**. VUK 509 IV.1.4(a)(6) makes e-Fatura mandatory, with no threshold, for
  "all taxpayers supplying medical material and drug/active substance" — the bent
  enumerates the whole SGK-contracted healthcare supply chain (hospitals, pharmacies,
  medical device/material suppliers, opticians, hearing centres, drug warehouses);
  the transition date was 1 July 2021.
- The generic threshold still matters for distributors outside that supply chain
  (e.g. only private practices with no SGK contract): gross sales **3,000,000 TL**
  for 2022 and later periods, with the obligation starting on **1 July of the
  following year** (so 2025 revenue ≥ 3M TL ⇒ mandatory from 1 July 2026).
  **VOLATILE**.
- e-Arşiv is not optional for an e-Fatura taxpayer. Since **1 January 2026** every
  invoice to a non-e-Fatura payer (including consumers) must be e-Arşiv regardless
  of amount; 2025 still had a 3,000 TL floor, and simple-basis/ledger-basis
  taxpayers were pushed to **1 January 2027** by VUK 589 (RG 31.12.2025). Paper
  invoices are effectively gone for balance-sheet companies.
- e-İrsaliye has **no medical-sector rule**. It is mandatory for e-Fatura-registered
  taxpayers whose gross sales are **10,000,000 TL or more** (2021+ periods). But any
  physically shipped delivery still needs a *sevk irsaliyesi*; if the taxpayer is
  e-İrsaliye-obligated, a paper dispatch note is not allowed. This directly touches
  the existing PRODUCT_DELIVERY flow.
- e-Defter became mandatory for **all balance-sheet taxpayers from 1 January 2025**,
  on top of e-Fatura and audited companies. It is bookkeeping (yevmiye + kebir +
  berat), i.e. exactly what MOD-001 excludes; a Servora Accounting module must not
  go there.
- The invoice scenario is not generic. GİB publishes a dedicated
  **`ILAC_TIBBICIHAZ`** e-Fatura scenario (v1.2, June 2025) that requires UNO, lot
  (LNO), serial (SNO) and production date (URT) per device line, and GTIN/lot/serial/
  expiry per drug line; non-tracked lines must carry `schemeID="DIGER"`.
- e-Fatura commercial scenario gives the buyer **8 days** to KABUL/RED/İADE; after
  8 days a response must not be accepted. e-Arşiv/e-SMM cancellation also runs on an
  **8-day** window from delivery to the buyer.
- e-Arşiv has its own reporting duty: daily report by the end of the next day (since
  1.1.2019), with a monthly/15th fallback for legacy periods, plus a signed archive
  that the taxpayer must keep.
- KDV: general rate **20%**, reduced **10%**, **1%** for List (I); the 20/10 split has
  applied since **10 July 2023** (CBK 7346). Medical devices under the Tıbbi Cihaz
  Yönetmeliği / IVD Yönetmeliği are List (II)/22 ⇒ **10%**, with an exclusions clause
  added by CBK 9126 (15.11.2024) for ÖTV-li goods and GTIN 85.17 phones. **VOLATILE**.
- Withholding (KDV tevkifatı) is a **closed list**; plain goods deliveries of medical
  devices to public hospitals are not on it. The relevant hooks are: services to
  public bodies (5/10, KDVGUT 2.1.3.2.13), maintenance/repair (2.1.3.2.3), and
  deliveries to Devlet Malzeme Ofisi (2/10, 2.1.3.3.7).
- ÜTS is a **separate TİTCK system**, not invoice-driven: the "verme bildirimi"
  document-number field is free text (invoice or dispatch note number) and GİB/TİTCK
  do not validate it against the invoice. Only the `ILAC_TIBBICIHAZ` invoice scenario
  couples the two, and only at data-field level.
- Retention is longer than the 5-year tax rule: VUK 253 gives 5 years, TTK 82 gives
  **10 years** for commercial books and documents; e-Belge must be kept as the signed
  XML (not a paper print), inside Turkey, and delegating storage does not transfer
  the liability. A record that only *references* an invoice must therefore be a
  clearly non-authoritative pointer, never a re-issued document image.

## 1. e-Fatura

### 1.1 What it is

e-Fatura is not a new document type; it has the same legal character as a paper
invoice (VUK 509, IV.1.1). It is an XML document in the **UBL-TR** profile, moved
through GİB's central platform between "gönderici birim" and "posta kutusu"
actors. UBL-TR 1.2.1 is the current published package on ebelge.gib.gov.tr
(accessed 2026-11-26). The document must contain the VUK 230 minimum data plus a
GİB QR/barcode once GİB announces the date (509 IV.1.3).

Mandatory fields that matter for a data model (509 IV.1.3): document date and
number, seller identity/tax office/VKN, buyer identity/VKN, goods or service
description, quantity, price, amount, **tax type, rate and amount**, delivery date
and **dispatch-note number**, QR/barcode.

### 1.2 Who must use it (thresholds and sector rules)

VUK 509 IV.1.4(a) lists the obligatory groups. The revenue test is on **gross sales
revenue (brüt satış hasılatı) of a past accounting period**, not the current year:

| Period whose revenue is tested | Threshold | Obligation starts |
| --- | --- | --- |
| 2018–2020 | 5,000,000 TL | 1 July 2020 (2018/2019) or 1 July of the following year |
| 2021 | 4,000,000 TL | 1 July of the following year |
| **2022 and later** | **3,000,000 TL** | **1 July of the following year** |

Source: VUK 509 IV.1.4(a)(1) and IV.1.5(a), current consolidated text
(accessed 2026-11-26). **VOLATILE** — this is the value in force for the 2025
revenue year, i.e. the cohort that had to switch by **1 July 2026**.

Sector groups that are obligatory **without** a revenue test (509 IV.1.4(a)):

- EPDK-licensed fuel/energy distributors (List I);
- List (III) manufacturers/importers (vehicles, etc.);
- e-commerce intermediaries and online sellers ≥ 500,000 TL (2022+);
- fruit/vegetable commission agents and traders;
- **SGK-contracted health service providers and all taxpayers supplying medical
  material and drug/active substance** — explicitly including hospitals, medical
  centres, dialysis centres, laboratories, pharmacies, **medical device and material
  suppliers**, opticians, hearing centres, and drug warehouses (bent 6, added by VUK
  526, RG 09.02.2021; transition 1 July 2021 per IV.1.5(d));
- real-estate/vehicle/construction traders and intermediaries ≥ 500,000 TL;
- hotels with Ministry of Culture and Tourism / municipality licences;
- EV charging network operators.

**Reading for this product:** the bent covers the SGK-contracted healthcare supply
chain. A distributor that invoices SGK-contracted hospitals, pharmacies or other
device suppliers is inside it and therefore an e-Fatura taxpayer regardless of size.
Whether a sale to a purely private clinic with no SGK contract is covered by the
same bent is **UNVERIFIED** (the wording is "medikal malzeme ve ilaç/etken madde
temin eden tüm mükellefler" without an explicit recipient qualifier; the
parenthetical list suggests the healthcare supply chain). If it is not covered, the
3M TL threshold applies. Either way the trigger is a **customer attribute**, not the
distributor's revenue, and that attribute does not exist in Servora today.

Once registered, an e-Fatura taxpayer must issue and receive e-Fatura **with other
registered users**, and may not paper-invoice them (509 IV.1.4(b), IV.1.1). GİB
publishes the registered-user list and a UserList guide; the sender is expected to
know whether the counterparty is registered, which is why every real integration
does a registered-user lookup before choosing e-Fatura vs e-Arşiv.

### 1.3 TEMEL vs TİCARİ scenario

From the official e-Fatura Entegrasyon Kılavuzu v1.10 (Haziran 2018), §4.4.1 and
§4.4.2 (accessed 2026-11-26):

- **TEMEL (basic)**: one-way. The sender builds the UBL-TR invoice, wraps it in a
  SENDERENVELOPE, GİB validates XSD/schematron/signature presence/addresses and
  delivers to the posta kutusu. No business response document is produced.
- **TİCARİ (commercial)**: TEMEL plus a **UYGULAMA YANITI** (application response)
  in which the buyer's posta kutusu returns KABUL (accept), RED (reject) or İADE
  (return).

TİCARİ is the scenario that carries legal acceptance evidence and is the normal
choice for B2B. Other GİB scenarios exist for special cases (SGK, export/customs,
investment incentive, electric charging, and the medical one below); they are
scenario values in `ProfileID`, not separate document types.

### 1.4 Acceptance / rejection window

The posta kutusu must send the application response **within 8 days** of receiving
the invoice, and the sender must not accept a response that arrives after 8 days;
for multiple responses the first one wins (Entegrasyon Kılavuzu v1.10, pp. 18–20 and
the response-handling rules at §4.4.2; accessed 2026-11-26). VUK 231 gives the
buyer 8 days to object to a paper invoice; the electronic response mirrors that.
After the window the invoice is treated as accepted. This is a **state machine the
issuer must model** (SENT → ACCEPTED / REJECTED / RETURNED / EXPIRED-ACCEPTED) if
Servora ever issues; in Cut A it is only a read-only status copied from the
integrator.

### 1.5 The medical-device scenario: `ILAC_TIBBICIHAZ`

GİB's *İlaç ve Tıbbi Cihaz Teslimlerine İlişkin Fatura Teknik Kılavuzu*, v1.2,
Haziran 2025 (accessed 2026-11-26) requires e-Fatura taxpayers trading drugs and
medical devices to use `ProfileID = ILAC_TIBBICIHAZ`, with invoice types SATIS,
ISTISNA, TEVKIFAT, TEVKIFATIADE, IADE and IHRACKAYITLI. Per invoice line:

- **Drug**: GTIN, batch (BN), serial (SN), expiry (XD), `schemeID="ILAC"`.
- **Medical device**: UNO (ÜTS product number), LNO (lot), SNO (serial; omitted when
  only lot exists), URT (production date), `schemeID="TIBBICIHAZ"`.
- **Non-tracked goods/services on the same invoice**: `schemeID="DIGER"` and
  `ID=1111111111`.

This is the single most consequential finding for scope B/C: a "priced commercial
document" for this sector is not a generic line/quantity/price table. If Servora
ever emits the invoice, it needs per-line device identity (UNO/GTIN, lot, serial,
production/expiry) that today exists only partially — `job_card_delivery_items`
already stores `lot_no`, `serial_no`, `expiry_date`
(`server/src/db/migrations/002_delivery_tracer.sql:144-152`), but the catalog has no
GTIN/UNO field (`server/src/modules/products/types.ts:7-11`).

### 1.6 Portal vs özel entegratör vs doğrudan entegrasyon

VUK 509 V.1 defines exactly three channels (accessed 2026-11-26):

1. **GİB Portal (e-Belge portalleri)** — free, browser-based, intended for taxpayers
   without integration capacity. GİB may restrict which document types may be issued
   through the portal (V.1.1).
2. **Özel entegratör** — a GİB-authorised private integrator whose systems create,
   sign (mali mühür), timestamp, transmit to the buyer and report to GİB on behalf of
   the taxpayer (V.1.2). The taxpayer remains responsible for retention and
   production (V.1.2 explicitly: using an integrator "does not remove the muhafaza
   ve ibraz duty").
3. **Doğrudan entegrasyon** — the taxpayer's own systems connect to GİB. Since VUK
   573 (RG 12.11.2024) this requires meeting GİB criteria (activity, company type,
   capital, revenue, sector, document volume, IT infrastructure) and GİB approval;
   accounts can be closed if the criteria later fail. Integration must be completed
   within one year of application (V.1.3).

For a distributor, channel 2 is the normal route; channel 3 is an ERP-scale project;
channel 1 is a stopgap.

## 2. e-Arşiv Fatura

### 2.1 When it is used

e-Arşiv is the electronic invoice for recipients who are **not** e-Fatura registered
users — other taxpayers below the threshold, non-taxpayers, and consumers. The same
509 text is explicit: registered users invoice each other with e-Fatura, and
everyone else with e-Arşiv (IV.2.1, IV.2.4.1). An e-Fatura taxpayer must also be an
e-Arşiv taxpayer, within the same transition period (IV.2.4.1). It is legally the
same document as a paper invoice; the seller keeps the electronic copy as the
"second copy" and delivers per the buyer's request, paper or electronic (IV.2.1,
V.5.2).

### 2.2 Thresholds and the 2026 paper cut-off

| Period | Rule |
| --- | --- |
| Until 31.12.2024 | e-Arşiv required above 5,000 TL (taxpayer buyers: VUK 232 threshold) |
| 01.01.2025 – 31.12.2025 | required above **3,000 TL** (VUK 573) |
| **From 01.01.2026** | **required regardless of amount** (VUK 573) |
| Simple-basis / ledger-basis taxpayers | pushed to **01.01.2027** (VUK 589, RG 31.12.2025/33124) |

Sources: VUK 509 IV.2.4.3 with footnotes 24–26 (consolidated text), VUK 573
(RG 12.11.2024/32720), VUK 589 (RG 31.12.2025/33124), all accessed 2026-11-26.
**VOLATILE** — and note that GİB's own e-Arşiv "Hakkında" page still displays the
2020 thresholds (30,000/5,000 TL), so the tebliğ text, not the landing page, is the
authority.

Consequence: since 1 January 2026 a balance-sheet distributor has **no lawful paper
invoice path** for ordinary sales. The paper-vs-electronic decision no longer
exists; the only question is which electronic channel.

### 2.3 Delivery and reporting duty

- Delivery: paper print or electronic transmission, at the buyer's request; for
  e-commerce sales electronic delivery is mandatory and the invoice must carry the
  web address, payment method/date, carrier, delivery date and a return section
  (509 IV.2.4.5, V.5.2).
- **Reporting**: taxpayers that use e-Arşiv through anything other than the portal,
  and their integrators, must send the **e-Arşiv Raporu** to GİB. Since 1.1.2019 the
  report is **daily, by the end of the following day**; the earlier rule was monthly
  by the 15th of the next month (e-Arşiv Teknik Kılavuzu v1.19, Ekim 2026, §5,
  accessed 2026-11-26). Charging-station ("SARJANLIK") invoices must be reported
  immediately.
- The report does not replace retention: "raporların Başkanlık sistemine aktarımı
  muhafaza ve ibraz ödevlerini ortadan kaldırmamaktadır" (same guide, §1).

This is a hard operational constraint: an e-Arşiv issuer has a **T+1 daily
obligation**, not a monthly one. Any Servora feature that "just produces a PDF" and
calls it an e-Arşiv invoice would break this.

### 2.4 Cancellation

There is no free edit. e-Arşiv (and e-SMM) cancellation is possible only within
**8 days from delivery of the document to the buyer**, via the electronic
cancellation/objection flow; after that the correction path is a return/credit
invoice (e-Arşiv Uygulamaları İptal, İhtar/İtiraz Bildirim Kılavuzu v1.1, accessed
2026-11-26, citing VUK 231's 8-day objection right). Cancellations must also be
reported to GİB electronically (509 V.10). For e-Fatura the equivalent is the
TİCARİ response plus the iptal/itiraz notification flow, not a deletion.

## 3. e-İrsaliye (dispatch note)

### 3.1 Who must use it

VUK 509 IV.3.5 lists the obligatory groups. There is **no medical/pharma-specific
bent**. The one that normally catches a distributor is bent 7:

- e-Fatura registered **and** gross sales **10,000,000 TL or more** for 2021 and
  later periods (25M TL for 2018–2020);
- plus sector groups: fuel/energy licence holders, List (III) manufacturers and
  **main dealer/distributor marketers**, mining licence holders, sugar producers,
  iron/steel (GTİP 72/73) traders, fertiliser tracking system users, fruit/vegetable
  traders, construction-rebar tracking system users ≥ 1M TL.

Transition: 1 July 2020 for the original groups; for the revenue test, from the
beginning of the seventh month of the following period (IV.3.6). **VOLATILE**.

A distributor below 10M TL that is not in a sector group is not e-İrsaliye
obligated, but still needs a *sevk irsaliyesi* on paper for shipped goods (VUK 230).
Crossing 10M TL flips the dispatch note from paper to electronic; that is a
compliance cliff, not a gradual change.

### 3.2 Relation to physical delivery — the PRODUCT_DELIVERY problem

- The dispatch note must be issued **before the actual dispatch**, and a copy (paper
  or on-screen) must be in the vehicle; for a registered buyer the e-İrsaliye is sent
  through GİB, for a non-registered buyer it may be delivered electronically or on
  paper on request (509 V.5.3).
- If the invoice was issued **before** the dispatch note, the dispatch note must
  carry the invoice's date and number (V.5.3). This is the legal form of the
  invoice↔delivery link.
- The buyer may answer with an **e-İrsaliye Yanıtı** (partial acceptance, rejection
  with reason). A rejection after physical dispatch is void and requires a new
  e-İrsaliye (IV.3.4).
- An e-Fatura whose print shows date **and time** and the phrase "İrsaliye yerine
  geçer.", signed, may replace a dispatch note **only if issued at the moment of
  delivery** (V.5.1). The same option exists for e-Arşiv with a wet/pre-signed print
  (V.5.2).

Implication: Servora's PRODUCT_DELIVERY is an operational record of a physical
hand-over. If the installation operator is e-İrsaliye-obligated, that hand-over
legally needs an e-İrsaliye (or a compliant irsaliyeli fatura) — a printed Servora
"delivery note" is not a substitute. A Cut B "priced delivery document" is therefore
the riskiest artefact in the whole scope: it looks like a *sevk irsaliyesi* without
being one.

### 3.3 Medical devices / pharma

No special e-İrsaliye rule was found. The medical coupling is at the **invoice**
scenario (`ILAC_TIBBICIHAZ`, §1.5) and at **ÜTS** (§8), not at the dispatch note.
`İDİS` in VUK 573 is the **İnşaat Demiri İzleme Sistemi** (construction rebar), not
a medical system — an easy false positive; the GİB "İDİS ... Fatura ve İrsaliye
Teknik Kılavuzu" is about rebar, not devices (accessed 2026-11-26).

## 4. e-Defter

Mandatory for (Elektronik Defter Genel Tebliği Sıra No: 1, §3.2.1, consolidated,
accessed 2026-11-26):

1. taxpayers obliged to use e-Fatura;
2. companies subject to independent audit under TTK 397/4;
3. **all taxpayers keeping books on the balance-sheet basis, from 1 January 2025**
   (added by 6 No.lu tebliğ, RG 31.12.2024/32769).

So a balance-sheet distributor is in scope twice over (e-Fatura and balance sheet).
The output is XBRL-GL yevmiye + kebir, signed with mali mühür/NES, with a **berat**
uploaded to GİB; the berat and the signed defter file must be kept together
(edefter.gov.tr "Mevzuat ve Teknik Mimari", accessed 2026-11-26). Upload cadence is
monthly or per geçici-vergi period, with frequent süre uzatım sirküleri (2026
examples: 198, 201, 202 No.lu VUK sirküleri) — i.e. operationally heavy and
calendar-driven.

This is **accounting-system territory** and MOD-001 excludes it by name
(`DECISIONS.md:2036-2038`: Core never gains "chart of accounts, journals, e-Defter,
payroll, full bank reconciliation or a general posting engine"). Any Accounting
module that started producing journal entries would drag e-Defter in with it.

## 5. Other e-documents — one line each

| Document | Who uses it | Relevance to a medical/dental distributor |
| --- | --- | --- |
| **e-SMM** (e-Serbest Meslek Makbuzu) | Self-employed professionals (doctors, dentists, consultants) | **None as issuer.** Relevant only as an inbound document from self-employed dentists/consultants; no Servora obligation. (509 IV.4) |
| **e-Müstahsil Makbuzu** | Agricultural producers / buyers of agricultural produce | **None.** (509 IV.5) |
| **e-Adisyon** | Cafés, restaurants, bars | **None.** (509 IV.12) |
| **e-Döviz Alım-Satım** | Licensed foreign-exchange and precious-metal dealers | **None.** (509 IV.10) |
| **e-Gider Pusulası** | Purchases from non-taxpayers | Marginal: possible for purchases from individuals, not for device sales. (509 IV.6) |
| **e-Bilet** | Transport, events, cinemas | **None.** (509 IV.7) |
| **e-Sigorta Poliçesi / Komisyon** | Insurers, agencies | **None** unless the distributor also sells insurance. (509 IV.8–IV.9) |
| **e-Dekont** | Banks and listed institutions | **None.** (509 IV.11) |

## 6. The özel entegratör model

**What an authorised integrator does** (VUK 509 V.1.2, accessed 2026-11-26): it
creates the e-Belge and the e-Belge report, signs with mali mühür, applies a
timestamp, transmits to the buyer and to GİB, keeps the technical infrastructure
inside Turkey, notifies GİB of the taxpayers it serves, and is subject to GİB
inspection and to permit revocation for violations. It may not use taxpayer data
for anything else and may not share it with third parties without written consent.
The taxpayer's own retention/production duty survives.

**Who is authorised**: GİB publishes the list
(https://ebelge.gib.gov.tr/efaturaozelentegratorlerlistesi.html, accessed
2026-11-26). It currently includes, among ~90 entries, Uyumsoft, Logo, İzibiz,
Mikro Yazımevi, QNB eSolutions, FIT Bilgi İşlem (Sovos/Foriba), Türk Telekom,
Türkcell e-Şirket (ePlatform/Superonline), Digital Planet-adjacent brands, Nilvera,
Birfatura, and **TOLASOFT (Süper Entegratör)**, i.e. a super-integrator layer that
other software vendors ride on. Paraşüt is not itself on the list; it is part of
Mikro Group and Mikro Yazımevi is listed — so the plausible reading is that
Paraşüt's built-in e-Fatura runs on Mikro's integrator authorisation. **UNVERIFIED**
as a contractual fact; it is not stated on the GİB page.

**Must a software product itself be authorised to send invoices?** No, not if it
sends *on behalf of a taxpayer through an authorised integrator*. The obligation
belongs to the **mükellef**; the integrator holds the GİB permit; the software vendor
is a technical client of the integrator's API. Two exceptions:

- if the vendor wants to talk to GİB **directly** with its own sender unit / posta
  kutusu, it needs either the taxpayer-side **doğrudan entegrasyon** approval
  (V.1.3) or an **özel entegratör** permit;
- if the vendor wants to serve many taxpayers under its own brand and sign on their
  behalf, it is functionally an integrator and needs the permit.

So the realistic architecture for Servora is: **Servora is not an integrator**; it
calls an integrator API with the installation's credentials, and the integrator
signs, transmits and reports. That keeps MOD-001's "external accounting connection"
idea intact and avoids GİB authorisation. It does **not** avoid: mali mühür
ownership by the taxpayer, KVKK/data-residency review of the integrator, contract
terms on who is the "data controller", and the 8-day response / T+1 reporting
timelines that the integrator enforces on its API.

Public vendor documentation was not fetched for this note; the integrator lists and
portal descriptions are public, the API contracts are commercial. **UNVERIFIED**:
pricing, SLA, per-document fees, sandbox availability.

## 7. KDV basics for medical/dental devices and consumables

Not tax advice. This section describes **what a software data model must be able to
hold**, because MOD-001 §3 puts "document tax data" inside the future Accounting
layer.

### 7.1 Rates

Rates are set by the annexes to the 2007/13033 sayılı BKK, as amended; the current
split is (GİB "KDV Oranları" consolidated text, accessed 2026-11-26):

| Rate | Scope |
| --- | --- |
| **1%** | List (I) — basic food, some agricultural inputs, certain dwellings |
| **10%** | List (II) — incl. **beşeri tıbbi ürünler** (item 18) and **medical devices under the Tıbbi Cihaz Yönetmeliği / İn Vitro Tanı Amaçlı Tıbbi Cihaz Yönetmeliği** (item 22), clothing, books, restaurants, hotels |
| **20%** | Everything not in the lists |

Effective dates: 20%/10% apply from **10 July 2023** (Cumhurbaşkanı Kararı 7346).
List (II)/22 was amended by **CBK 9126 (14.11.2024, effective 15.11.2024)** to
exclude goods subject to ÖTV and GTİP 85.17 telephones — i.e. some products that
look "medical" are pushed back to 20%. **VOLATILE**.

Practical model consequence: the rate is a property of the **product/GTİP**, not of
the customer or the job type. Dental implants, instruments and consumables that fall
under the Tıbbi Cihaz Yönetmeliği are 10%; a dental chair, clinic furniture, a
non-medical device or an ÖTV-li item is 20%. A single "medical ⇒ 10%" rule is wrong.
The tax rate must be a dated, per-line attribute with an effective-from date, not a
constant.

### 7.2 Withholding (KDV tevkifatı)

KDV Genel Uygulama Tebliği (mevzuat.gov.tr No. 19631, accessed 2026-11-26) states
that partial withholding applies **only to the listed transactions** ("kısmi tevkifat
uygulanacak işlemler ... söz konusu bölümlerde belirtilenlerle sınırlı olup, bunlar
dışındaki işlemlerde ... tevkifat yapılmayacaktır", I/C-2.1.3.1).

- **Plain goods deliveries of medical devices to public hospitals are not on the
  list.** The list is services plus a few specific goods (scrap, copper, cotton,
  iron/steel, etc.).
- **Services to public bodies** not otherwise listed: **5/10** (I/C-2.1.3.2.13),
  which is where maintenance/installation/consultancy lines land. Machine and
  equipment maintenance/repair is its own item (I/C-2.1.3.2.3). PPP health-facility
  operation services have their own item (2.1.3.2.14).
- **Deliveries to Devlet Malzeme Ofisi**: **2/10** on all deliveries not otherwise
  specified (I/C-2.1.3.3.7). This is the most likely source of the common belief
  that "hospital device sales are withheld at 2/10" — through DMO they are.
- Withholding is declared by the buyer in a **2 No.lu KDV Beyannamesi**; the seller
  declares only the un-withheld part and claims the withheld part as an iade
  (I/C-2.1.4–2.1.6).

Model consequence: an invoice line needs `kdvRate`, `withholdingRate` (0, 2/10, 5/10,
9/10…), `withholdingAmount`, `payableAmount`, and a flag for "tevkifatlı" so the
printed/UBL document and the receivable match. The rate set is **VOLATILE** and must
be configuration, not code.

### 7.3 What the model must hold (independent of Cut)

`product.taxRate` + `effectiveFrom`; `invoiceLine.taxableAmount`, `taxRate`,
`taxAmount`, `withholdingRate`, `withholdingAmount`; `invoice.taxExclusiveTotal`,
`taxTotal`, `payableTotal`, `currency`, `exchangeRate` (for FX sales); and a
`taxScheme` code (e.g. 0015 "GERÇEK USULDE KATMA DEĞER VERGİSİ" as used in GİB's
medical examples). MOD-001 already allows "document tax data" and forbids a
posting engine, so these fields belong to the commercial layer, not to a ledger.

## 8. ÜTS (Ürün Takip Sistemi, TİTCK) — short

ÜTS is TİTCK's product-tracking system for medical devices, cosmetics and certain
biocides. It tracks **tekil ürün** movement: production/import, inventory,
give/receive ("verme/alma bildirimi"), use/consumption, loss/destruction (TİTCK ÜTS
page, accessed 2026-11-26).

Relationship to invoices/dispatch notes:

- The **verme bildirimi** has a free-text "belge numarası" field; TİTCK's FAQ says
  firms may enter any reference number they use (invoice, dispatch note, etc.) and
  that **the number is not validated** by ÜTS. So ÜTS is **not** triggered by
  e-Fatura/e-İrsaliye and does not consume them.
- The coupling is at **data-field level**: the `ILAC_TIBBICIHAZ` e-Fatura scenario
  requires UNO/LNO/SNO/URT, which are the same identifiers ÜTS tracks. A device
  sold without lot/serial cannot be invoiced correctly under that scenario.
- ÜTS also requires "verme bildirimi" for free samples, and an alım iptali is done
  by a return verme + alma, not by deleting (TİTCK FAQ).

Servora's delivery items already carry `lot_no`, `serial_no`, `expiry_date`
(`server/src/db/migrations/002_delivery_tracer.sql:150-152`), so the operational
data is closer to ÜTS than to invoicing. Deep ÜTS work belongs to the
Warehouse/Stock research session; this note only records that **invoice lines and
ÜTS notifications share identifiers but are not the same event**.

## 9. Retention and immutability

- **VUK 253**: books and documents must be kept for **5 years** counted from the
  end of the calendar year in which they were recorded.
- **TTK 82**: commercial books and documents must be kept for **10 years**. In
  practice invoices are kept 10 years because the longer period governs.
- **e-Belge specifics** (509 VI, accessed 2026-11-26): the taxpayer must keep the
  e-Belge **including the mali mühür / electronic signature**, in electronic,
  magnetic or optical media, for the legal period, and be able to produce it
  electronically. Printing to paper is **not** a valid retention method for the
  signed XML. Storage must be inside Turkey (or where Turkish law applies);
  secondary archiving abroad is allowed. Third-party storage (including GİB-licensed
  saklama firms) does **not** remove the taxpayer's responsibility. Integrity and
  non-repudiation are provided by mali mühür + qualified certificate, i.e. the
  document is **immutable by construction**; corrections are new documents, not
  edits.
- Cancellation is time-boxed (§2.4), which is the operational expression of the same
  immutability principle.

**Implication for a record that only references an invoice issued elsewhere**
(Cut A): Servora must store a *pointer*, not a document:

- integrator/GİB document id (ETTN/UUID), invoice number, issue date/time, seller
  VKN, buyer VKN, currency, totals, KDV totals, status (SENT/ACCEPTED/REJECTED/
  RETURNED/CANCELLED), and a hash of the received UBL XML if it is stored;
- never a re-rendered PDF presented as the invoice, never an editable copy, never a
  "duplicate" with a new number;
- a clear UI label that the legal document lives in the integrator/ERP and that
  Servora's copy is a reference;
- an audit trail of who attached/changed the reference (the existing
  `invoiceNumber` note debt shows the failure mode: a free-text invoice number in a
  JobCard note, `server/src/modules/job-cards/notes-service.ts:19-56`).

For Cut B/C the bar rises: if Servora produces a priced document that a user could
mistake for an invoice or a dispatch note, it inherits part of the retention and
immutability expectation even if it is legally "just" a quote.

## 10. Upcoming / recent changes (2026–2027) — VOLATILE

| Date | Change | Source |
| --- | --- | --- |
| 01.01.2025 | e-Defter extended to all balance-sheet taxpayers (6 No.lu e-Defter tebliğ) | RG 31.12.2024/32769; e-Defter tebliğ §3.2.1 |
| 01.01.2025 | e-Arşiv floor cut to 3,000 TL (VUK 573) | RG 12.11.2024/32720 |
| 2025 | `ILAC_TIBBICIHAZ` e-Fatura scenario introduced (v1.0 06.01.2025, v1.2 30.06.2025) | GİB medical invoice guide |
| 01.01.2026 | e-Arşiv required for **all** invoices regardless of amount (VUK 573) | 509 IV.2.4.3 |
| 01.07.2026 | 2025 revenue ≥ 3M TL cohort must be e-Fatura/e-Arşiv/e-Defter | 509 IV.1.5(a) |
| 01.01.2027 | Simple-basis / ledger-basis taxpayers lose the paper option (VUK 589) | RG 31.12.2025/33124 |
| 01.01.2027 | VUK 598: e-Arşiv can be issued through GMÖEBS, Taksi Mali Cihaz or permitted YN ÖKC; "bilgi fişi" removed; cinema e-Bilet direct; doctors' separate POS duty removed | VUK 598, published 24.11.2026 per press (RG number/date **UNVERIFIED**; GİB tebliğ page 11920) |

The 598 change is two days old at the date of this note. It does **not** create a
new obligation for a distributor; it opens payment-device channels for small
taxpayers and removes the paper "bilgi fişi". It should be watched because it shows
GİB is moving retail invoicing onto the payment terminal, which may later affect
field sales / collection flows (Cut C).

No official announcement of a further e-Fatura threshold increase for 2027 was
found. **UNVERIFIED**: any 2027 threshold change; any new medical-device-specific
e-İrsaliye rule.

## 11. Obligation table

"Servora must issue?" is judged against the three cuts. "No" means Servora must not
emit the document at all; the legal issuer remains the taxpayer (via integrator/ERP).

| Obligation | Who is subject | Servora must issue? (A / B / C) | Source |
| --- | --- | --- | --- |
| **e-Fatura** (B2B, registered counterparties) | e-Fatura-registered taxpayers; **mandatory without threshold for taxpayers supplying medical material/drugs (SGK-contracted healthcare supply chain)**; otherwise ≥ 3M TL gross sales (2022+) from 1 July of the next year | **A: No** (store reference: ETTN, no., date, totals, status). **B: No.** **C: No.** Issuing is an integrator/ERP function and needs mali mühür + GİB registration | 509 IV.1.4(a)(1),(6), IV.1.5(a),(d); ILAC_TIBBICIHAZ guide |
| **e-Arşiv Fatura** (B2C / non-registered buyers) | every e-Fatura taxpayer (automatically); since 01.01.2026 regardless of amount | **A: No.** **B: No** — but any priced document shown to a consumer must be explicitly non-invoice. **C: No** | 509 IV.2.1, IV.2.4.1, IV.2.4.3; VUK 573/589 |
| **e-Arşiv Raporu** (daily, T+1) | e-Arşiv issuers using non-portal channels and their integrators | **A/B/C: No** (integrator duty) | e-Arşiv Teknik Kılavuzu v1.19 §5 |
| **e-Fatura application response** (8-day KABUL/RED/İADE) | buyer side of a TİCARİ invoice | **A: read-only status**; **B/C: No** | Entegrasyon Kılavuzu v1.10 §4.4.2 |
| **e-İrsaliye** | e-Fatura registered **and** ≥ 10M TL gross sales (2021+), plus sector groups; no medical rule | **A/B: No — and must not print a "sevk irsaliyesi"-looking document.** **C: No.** If the operator is obligated, the physical hand-over needs e-İrsaliye from the integrator/ERP | 509 IV.3.5(7), IV.3.6, V.5.3 |
| **e-Defter + berat** | e-Fatura taxpayers; audited companies; **all balance-sheet taxpayers from 01.01.2025** | **A/B/C: No.** Explicitly excluded by MOD-001 (`DECISIONS.md:2036-2038`) | e-Defter Tebliğ (Sıra No: 1) §3.2.1; RG 31.12.2024/32769 |
| **e-SMM / e-Müstahsil / e-Adisyon / e-Döviz / e-Bilet** | own professional/sector groups | **A/B/C: No** (out of scope; one-line relevance in §5) | 509 IV.4–IV.12 |
| **KDV rate per line** (1/10/20) | every taxpayer | **A: reference only** (copy from invoice). **B: yes, must hold** a dated rate per line, but not as a tax return. **C: yes** | 2007/13033 BKK; CBK 7346; CBK 9126 |
| **KDV tevkifatı per line** (0 / 2/10 / 5/10 …) | buyers in the closed list; DMO deliveries; public-body services | **A: reference only.** **B: must hold** rate + amount + payable split. **C: yes** | KDVGUT I/C-2.1.3.1, 2.1.3.2.3, 2.1.3.2.13, 2.1.3.3.7 |
| **ÜTS verme/alma bildirimi** | device manufacturers/importers/dealers registered in ÜTS | **A/B/C: No** (separate TİTCK system; free-text doc ref). But lot/serial/UNO are **shared** with invoice lines | TİTCK ÜTS page + FAQ |
| **Invoice retention / immutability** | the taxpayer that issued or received the e-Belge | **A: store pointer + hash + status, 10 years.** **B: same, plus not present as legal document.** **C: same** | VUK 253; TTK 82; 509 VI |

### Reading of the table

- **Cut A** is the only cut with essentially no e-document exposure, provided the
  reference is presented as a pointer and never as an invoice.
- **Cut B** carries the real hidden risk: the moment Servora prints a priced
  delivery note, users will treat it as a *sevk irsaliyesi*; and the moment it prints
  a priced document with a number series, users will treat it as an invoice. The
  legal exposure is not "Servora is not authorised" — it is "Servora produced a
  document that looks official and is not". Guardrails (naming, watermark, no
  number series, no "fatura/irsaliye" wording) are a product requirement, not a
  detail.
- **Cut C** adds receivables and collections, which are *not* e-document obligations
  at all; the exposure stays the same as B plus KVKK/audit obligations on financial
  data. It does not pull in e-Defter.
- The medical-specific burden (`ILAC_TIBBICIHAZ`, UNO/lot/serial, ÜTS identifiers)
  only becomes a *software* burden if Servora issues. In A/B/C it stays a **data
  quality** burden: the identifiers must be captured at delivery time so that a
  future issuing integration (or the operator's ERP) can use them.

## Open questions

1. **Which customers does a given installation actually invoice?** The SGK-contract
   attribute decides whether e-Fatura is mandatory by sector or by threshold. It is
   not modelled anywhere in Servora today. Is it acceptable to ask the operator to
   declare "e-Fatura taxpayer: yes/no" per installation rather than derive it?
2. **Does the owner want a "printable delivery note" at all?** If PRODUCT_DELIVERY
   prints anything that resembles a dispatch note, the e-İrsaliye question cannot be
   avoided at ≥10M TL. Is a non-legal "teslim tutanağı" (hand-over receipt) an
   acceptable compromise?
3. **Integrator choice is an installation-level decision, not a product decision.**
   Should the module define a provider-neutral invoice-reference contract (ETTN,
   status, totals) and let the operator plug an integrator later, rather than
   naming one?
4. **Who owns the mali mühür and the integrator contract** in the target
   deployments — the distributor itself, or its accounting firm/ERP? This decides
   whether Servora is ever allowed to hold credentials.
5. **`ILAC_TIBBICIHAZ` scope**: does the operator's product mix actually require the
   scenario (i.e. are the products ÜTS/İTS-registered)? If not, the UNO/lot/serial
   requirement is moot for that installation.
6. **How long must Servora keep a reference** when the legal document is kept
   elsewhere for 10 years? Matching 10 years is the safe default, but it conflicts
   with any data-minimisation/KVKK retention policy for customer data.
7. **KDV rate source**: hard-coded table, operator-maintained table, or fetched from
   the integrator/ERP? A wrong rate on a commercial document is a real financial
   error, not a display bug.
8. **Does the operator actually sell through DMO?** That is the only common path
   where device deliveries are withheld at 2/10; otherwise withholding is a
   service-line concern.

## Sources

All accessed 2026-11-26 unless stated.

Official — GİB / ebelge:

1. VUK Genel Tebliği (Sıra No: 509), consolidated ("dipnotlu güncel") text —
   https://ebelge.gib.gov.tr/dosyalar/tebligler/Dipnotlu_Guncel_Sekli_ile_509_Sira_No'lu_VUK_Genel_Tebligi.pdf
   (sections IV.1.1–IV.1.5, IV.2.1–IV.2.5, IV.3.1–IV.3.7, V.1.1–V.1.3, V.5.1–V.5.3,
   V.10, VI).
2. VUK Genel Tebliği (Sıra No: 573), RG 12.11.2024/32720 —
   https://ebelge.gib.gov.tr/dosyalar/tebligler/Vergi_Usul_Kanunu_Genel_Tebligi_(Sira_No_509)'nde_Degisiklik_Yapilmasina_Dair_Teblig_(Sira_No_573).pdf
3. VUK Genel Tebliği (Sıra No: 589), RG 31.12.2025/33124 (5. Mükerrer) —
   https://ebelge.gib.gov.tr/dosyalar/tebligler/Vergi_Usul_Kanunu_Genel_Tebligi_(Sira_No_509)'nde_Degisiklik_Yapilmasina_Dair_Teblig_(Sira_No_589).pdf
4. 509 kapsamındaki uygulamalara geçiş takvimi —
   https://ebelge.gib.gov.tr/dosyalar/509_s.VUK_GT_Kapsaminda_Uygulamalara_Gecis_Takvimi_Tablosu_(3).pdf
5. e-Fatura Hakkında / Mevzuat ve Teknik Mimari —
   https://ebelge.gib.gov.tr/efaturahakkinda.html ,
   https://ebelge.gib.gov.tr/efaturamevzuat.html
6. e-Fatura Uygulaması Entegrasyon Kılavuzu v1.10 (Haziran 2018) — TEMEL/TİCARİ
   scenarios and the 8-day response rule —
   https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-FaturaUygulamasiEntegrasyonKilavuzu-v1.10.pdf
7. e-Arşiv Hakkında — https://ebelge.gib.gov.tr/earsivhakkinda.html (note: page text
   is stale, still shows 2020 thresholds; tebliğ prevails)
8. e-Arşiv Teknik Kılavuzu v1.19 (Ekim 2026) — reporting cadence —
   https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Arsiv_Teknik_Kilavuzu_V.1.19.pdf
9. e-Arşiv Uygulamaları İptal, İhtar/İtiraz Bildirim Kılavuzu v1.1 — 8-day
   cancellation —
   https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-Arsiv_Uygulamalari_Iptal_Ihtar_Itiraz_Bildirim_Kilavuzu_V.1.1.pdf
10. İlaç ve Tıbbi Cihaz Teslimlerine İlişkin Fatura Teknik Kılavuzu v1.2 (Haziran
    2025) — `ILAC_TIBBICIHAZ`, UNO/LNO/SNO/URT —
    https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/Ilac_ve_Tibbi_Cihaz_Teslimlerine_Iliskin_Fatura_Teknik_Kilavuzu_V.1.2.pdf
11. e-İrsaliye Hakkında — https://ebelge.gib.gov.tr/eirsaliyehakkinda.html
12. e-Fatura özel entegratörler listesi —
    https://ebelge.gib.gov.tr/efaturaozelentegratorlerlistesi.html
13. e-Belge özel entegratörleri bilgi sistemleri denetimi kılavuzu (list entry) —
    https://ebelge.gib.gov.tr/dosyalar/kilavuzlar/e-BELGE_OZEL_ENTEGRATORLERI_BILGI_SISTEMLERI_DENETIMI_KILAVUZU.pdf

Official — e-Defter:

14. Elektronik Defter Genel Tebliği (Sıra No: 1), consolidated —
    https://www.edefter.gov.tr/dosyalar/tebligler/ELEKTRONIK_DEFTER_GENEL_TEBLIGI_(SIRA%20NO_1)_GUNCEL_HAL%C4%B0%20.pdf
    (§3.2.1 who is obliged; §3.2.6 transition).
15. e-Defter Mevzuat ve Teknik Mimari (XBRL-GL, berat) —
    https://www.edefter.gov.tr/edeftermevzuat.html
16. e-Defter home (2026 süre uzatım sirküleri 198/201/202) —
    https://www.edefter.gov.tr/anasayfa.html

Official — tax rates and withholding:

17. KDV Oranları, 2007/13033 sayılı Karar consolidated (incl. List II/18 and II/22,
    CBK 7346 and CBK 9126 amendments) —
    https://cdn.gib.gov.tr/api/gibportal-file/file/getFileResources?objectKey=arsiv/yardim-kaynaklar/yararli-bilgiler/kdv-oranlari.pdf
18. KDV Genel Uygulama Tebliği (mevzuat No. 19631), full text — withholding is a
    closed list (I/C-2.1.3.1), 2.1.3.2.3, 2.1.3.2.13, 2.1.3.2.14, 2.1.3.3.7 —
    https://www.mevzuat.gov.tr/MevzuatMetin/yonetmelik/9.5.19631.pdf

Official — TİTCK / ÜTS:

19. Ürün Takip Sistemi (ÜTS) —
    https://www.titck.gov.tr/faaliyetalanlari/tibbicihaz/urun-takip-sistemi-uts
    (FAQ: verme bildirimi "belge numarası" is free text and not validated;
    bedelsiz numune also needs verme bildirimi).

Official — 2027 change:

20. VUK Genel Tebliği (Sıra No: 598), GİB tebliğ page (page body requires JS; text
    quoted in search results) — https://gib.gov.tr/mevzuat/kanun/434/teblig/11920

Press / secondary (used only where primary text was not retrievable):

21. Cumhuriyet, "Resmi Gazete'de yayımlandı: Kağıt fiş uygulaması kaldırıldı",
    24.11.2026 — https://www.cumhuriyet.com.tr/ekonomi/resmi-gazete-de-yayimlandi-kagit-fis-uygulamasi-kaldirildi-2558979
    (598 sayılı tebliğ, 1.1.2027 effects; RG date/number **UNVERIFIED** beyond the
    article).
22. Paraşüt blog, "2026 Yılında e-Arşiv ve e-Fatura Zorunluluğu" —
    https://www.parasut.com/blog/e-fatura-ve-e-arsiv-zorunlulugu (corroboration only;
    the 2026 rules above are taken from VUK 573/589, not from this page).

Repo evidence (read-only, this checkout):

23. `DECISIONS.md:2032-2040` — MOD-001 §3, Accounting scope and exclusions.
24. `AGENTS.md:399-400` — §13 forbidden changes (full accounting module,
    e-invoice/e-archive integration).
25. `docs/architecture/decision-reconciliation-report.md:95-104` — Accounting A0
    discovery titles.
26. `server/src/db/migrations/002_delivery_tracer.sql:144-152` —
    `job_card_delivery_items` with lot/serial/expiry.
27. `server/src/modules/products/types.ts:7-11` — product catalog fields (no
    GTIN/UNO).
28. `server/src/modules/job-cards/notes-service.ts:19-56` — `invoiceNumber` free-text
    note field (the domain debt MOD-001 refers to).
