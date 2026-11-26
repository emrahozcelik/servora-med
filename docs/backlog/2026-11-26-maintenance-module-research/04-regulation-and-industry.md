# 04 — Regulation and industry practice: what a Maintenance (Bakım) module must or should record

Status: research note, 2026-11-26. Read-only work against `origin/main` @ `89bf6b1`; nothing was
implemented, installed, migrated or deployed. Access date for every URL: **2026-11-26**.

## Summary (10 lines)

1. Turkey has a **dedicated technical-service regime for medical devices used in health service
   delivery** — RG 26/5/2023-32202 — that is *not* the consumer after-sales regime and that
   prescribes, in law, a per-intervention **technical service report** with eleven minimum fields,
   a **10-year** record duty, a handover document for off-site repair, and a 30-day use-error report.
2. Its compliance deadline was extended from 1/1/2026 to **1/7/2027** (RG 30/12/2025-33123), so the
   module can be designed against a known, dated target rather than an expired one.
3. A medical-device distributor is an *iktisadi işletmeci* under the MDR-aligned Tıbbi Cihaz
   Yönetmeliği: traceability for **10 years** (Art. 25 + 10(8)), complaint/recall records
   (Art. 14(5)), and immediate forwarding of suspected adverse events to the manufacturer.
4. The Sales/Advertising regulation adds a **B2B warranty** for devices sold to health service
   providers (Art. 25/A–25/Ç: minimum 2 years, free repair, repair days added, annual maximum
   repair time on the certificate, refund/replacement within 45 days) and a **20/30 business-day
   spare-part SLA** (Art. 26(9)(b)). This is the part most teams miss: it is not consumer law.
5. ÜTS is real, REST-based, and mandatory: tekil (serial/lot) tracking for all classes since
   01/01/2020, and a **verme bildirimi** when a distributor transfers a device to a clinic, with the
   clinic's **alma bildirimi** completing the transfer. There is **no** movement notification for a
   service event.
6. ÜTS does have a *Klinik Mühendislik* side: the clinic files an **envanter bildirimi** for devices
   subject to maintenance/repair/calibration, and the **calibration request → programme → report →
   clinic approval** flow already runs through ÜTS for the mandatory scopes.
7. Therefore Servora-Med does **not** need a ÜTS integration to be compliant; it needs to *store and
   reproduce* the identifiers an operator types into ÜTS (ÜTS product/barcode no, institution no,
   document no, notification state) and, optionally, automate `verme` later.
8. Calibration is the **clinic's** obligation, executed by **TİTCK-authorised** bodies; a
   distributor cannot be its own calibration body (Art. 11(5) of the calibration regulation).
   X-ray adds NDK licensing plus medical-physicist quality control, and that mandatory outsourcing
   is currently *suspended* (TİTCK, 25.10.2024).
9. Industry practice is strongly **manufacturer-driven and annual**, with a short-cycle layer the
   clinic does itself (autoclave: daily Bowie-Dick, weekly biological indicator and leak test;
   compressor: daily drain; waterline: quarterly culture ≤500 CFU/mL).
10. Bottom line for the module boundary: **JobCard should keep assignment, visit scheduling,
    lifecycle and approval; Maintenance should own the device (installed base) and its immutable
    service history**, because the legal artefact is device-centric and outlives any single job.

---

## 1. Scope, method and evidence rules

**Question set.** Eight questions: MDR operator duties; ÜTS; after-sales regime; calibration and
periodic checks; authorised-service competence; retention; industry practice; a decision table.

**Method.** Official sources first (`mevzuat.gov.tr`, `resmigazete.gov.tr`, `titck.gov.tr`,
`uts.saglik.gov.tr`, `ndk.org.tr`), then manufacturer/industry material for intervals only. Where a
claim rests on a secondary reproduction it is named as such. Search queries used generic terms only;
no customer, company, staff or product name from this repository was ever put into a query.

**Labelling.** *(observed)* = read directly in the cited legal text or official page today;
**INFERENCE** = my translation into product terms, not stated by the source; **UNVERIFIED** = could
not be confirmed from a primary source in this session. All Turkish legal text is paraphrased in
English by me; the Turkish original governs. Article numbers are Turkish; MDR alignment means EU
2017/745 numbers usually match, but not always.

---

## 2. The regulatory stack at a glance

| # | Instrument | RG date / no. | Status today | Why a Maintenance module cares |
| --- | --- | --- | --- | --- |
| R1 | Tıbbi Cihaz Yönetmeliği (MDR-aligned) | 2/6/2021 / 31499 (mük.) | in force; replaced MDD 27957 | operator duties, traceability, UDI, vigilance, FSCA |
| R2 | Tıbbi Cihaz Satış, Reklam ve Tanıtım Yönetmeliği | 7/5/2014, heavily amended (2/9/2020-31232; 26/5/2023-32202) | in force | sales-centre licence, ÜTS tekil bildirim, **B2B warranty**, spare-part SLA, 5/10-year records |
| R3 | Sağlık Hizmet Sunumu Kapsamında Kullanılan Tıbbi Cihazların Teknik Servis Hizmetlerine Dair Yönetmelik | 26/5/2023 / 32202; amended 30/12/2025 / 33123 | in force; full compliance **1/7/2027** | technical service certificate, A/B/C groups, **service report**, 10-year records |
| R4 | TİTCK guide TCS-KLVZ-09 (implementation of R3) | v1 21/8/2024 | in force | report fields (Art. 10(6)), Ek-7 device groups, misuse report form |
| R5 | Tıbbi Cihazların Test, Kontrol ve Kalibrasyonu Hakkında Yönetmelik | 25/6/2015 / 29397; amended 10/12/2021 / 31685 | in force | who may calibrate, annual default, authorised-body monopoly by scope |
| R6 | Diagnostik Radyoloji, Nükleer Tıp ve Radyoterapi Grubu ... Kalite Uygunluk ve Kalite Kontrol Testleri Hakkında Yönetmelik | 23/12/2021 / 31698; amended 20/12/2023 / 32405 | in force; **mandatory outsourcing suspended** 23/12/2024 | X-ray QC by medical physicist, 5-yearly conformity |
| R7 | Radyasyon Güvenliği Yönetmeliği + İyonlaştırıcı Radyasyon ... Sağlık Hizmetleri Yönetmeliği | 24/3/2000 / 23999; 26/4/2022 / 31821 | in force | NDK licence, RKS, QA programme, dental X-ray rooms |
| R8 | Satış Sonrası Hizmetler Yönetmeliği (consumer) | 13/6/2014 / 29029 | in force | **does not** cover clinic-purchased professional equipment (see §5) |
| R9 | SKS quality standards; TTK m.82 / VUK m.253 | Ministry standards; 6102 / 213 | binding | device file, calibration label, fault records; 10-year / 5-year commercial baseline |

---

## 3. Q1 — MDR-aligned duties of importers and distributors relevant to after-sales service

### 3.1 Who is who

*(observed, R1 Art. 3)* `Dağıtıcı` = anyone in the supply chain other than the manufacturer or
importer who makes a device available up to the point of service delivery. `İthalatçı` = the
Turkey-established person who places a device from a third country on the Turkish market.
`İktisadi işletmeci` covers manufacturer, authorised representative, importer and distributor.

**INFERENCE — important for this company.** A firm that buys dental equipment from a German
manufacturer and sells it in Turkey is the **importer** for those lines and carries R1 Art. 13 duties;
for products bought from a Turkish importer it is a **distributor** under Art. 14. The same legal
person can hold both roles for different SKUs, so the module must not hard-code one role.

### 3.2 Importer duties that touch service (R1 Art. 13)

| Duty | Article | Service relevance |
| --- | --- | --- |
| Place only compliant devices; verify CE, DoC, labelling, IFU, UDI allocated | 13(2)(a) | the IFU is the source of maintenance intervals and the declared usage life |
| Add own name, registered trade name, address on device/packaging/document | 13(3) | the clinic's service contact is the importer |
| Verify registration in the electronic system and add own details | 13(4) | ÜTS company record |
| Ensure storage/transport conditions do not compromise compliance | 13(5) | relevant for field replacement parts |
| Keep records of complaints, non-conforming devices, recalls, withdrawals; give information to manufacturer/AR/distributors | 13(6) | this is a **record-keeping obligation on the importer**, i.e. a Maintenance/complaint log |
| Cooperate on corrective action; inform authority if serious risk | 13(7) | recall handling |
| Forward suspected adverse events from professionals/patients/users immediately | 13(8) | see §3.4 |
| Hold copies of DoC and certificates for the Art. 10(8) period | 13(9) | 10 years (15 for implantable) |

### 3.3 Distributor duties (R1 Art. 14)

- Verify CE/DoC, that manufacturer information accompanies the device, that the importer marked
  itself, and that UDI is allocated (Art. 14(2)(a)); a sampling method is allowed (14(2)(b)).
- Do not make available a non-conforming device; inform manufacturer/AR/importer; inform the
  Authority if serious risk or falsified device (14(2)(c), 14(4)).
- Preserve storage/transport conditions (14(3)).
- **Keep records of complaints, non-conforming devices, recalls and withdrawals, and inform the
  manufacturer/AR/importer** (14(5)). *(observed)* This is the legal hook for a complaint/incident
  register in the module.
- Supply all information needed to prove conformity on request (14(6)).

### 3.4 Traceability (the strongest data requirement)

*(observed, R1 Art. 25(2))* For the Art. 10(8) period — **10 years, 15 for implantable** —
economic operators must be able to present, to the Authority:

1. every economic operator to whom they **directly supplied** a device;
2. every economic operator who **directly supplied** them;
3. **every health institution or health professional they directly supplied**.

**INFERENCE.** This is exactly an "installed base + delivery ledger" requirement: device identity
(UDI/serial/lot), recipient identity (clinic), date, and the commercial document. A module that
stores device → clinic → delivery date → serial, and can export it, satisfies Art. 25 without any
authority integration.

R2 Art. 31(3) reinforces this for sales centres: keep the previous and next economic operator's
name/title/brand and contact details plus lot/serial/brand/model parameters, **at least 10 years**,
and produce them to the Authority on request. *(observed)*

### 3.5 Vigilance and field safety

| Obligation | Article | Timing |
| --- | --- | --- |
| Manufacturer reports serious adverse events | R1 Art. 85(3) | ≤15 days from awareness |
| Serious public-health threat | 85(4) | ≤2 days |
| Death or unexpected serious deterioration | 85(5) | ≤10 days |
| Trend reporting of expected undesirable side-effects | 86 | periodic |
| Field safety corrective action (FSCA) reported by manufacturer | 85(1)(b), 88 | per decision |
| Distributor/importer forwards suspected events and complaints | 14(5), 13(8) | "immediately" |

*(observed)* The distributor has **no reporting deadline of its own** in R1: its duty is immediate
forwarding to the manufacturer/AR/importer plus keeping the record; the deadlines are the
manufacturer's. **INFERENCE:** the module needs two clocks — an internal "forwarded to manufacturer
at" timestamp (auditable) and the manufacturer's regulatory clock, displayed but not owned.

**Field safety notice (FSN).** R1 Art. 3 defines `saha güvenliği bildirimi` as the message the
manufacturer sends to users/customers about an FSCA. **INFERENCE:** record per device that an FSN was
received, which serials are affected, what was done, and when the clinic acknowledged — the
"effectiveness check" evidence a manufacturer will ask the importer for.

---

## 4. Q2 — ÜTS: what must be recorded, and is a service event notifiable?

### 4.1 What ÜTS is (observed)

ÜTS is the Ministry's product-tracking system; registration and movements have run through it since
12/06/2017 (TİTCK/ÜTS announcements). All functions are **REST services**; integration needs a
**system token** produced with an **e-signature** by a signature-authorised user, sent in the
`utsToken` header, with a test environment at `utstest.saglik.gov.tr` *(ÜTS web-service document
v1.99)*. The interface is per movement: `uretim/ekle`, `ithalat/ekle`, `verme/ekle`, `alma/ekle`, …

### 4.2 The notification set (observed, ÜTS tekil hareket kılavuzu)

| Notification | Who files | Key fields |
| --- | --- | --- |
| Üretim / İthalat | manufacturer / importer (or its authorised dealer) | UNO, lot and/or serial, production/expiry date, country |
| **Verme** (transfer out) | the holder giving the device | UNO, LNO/SNO, quantity, **KUN** (recipient's ÜTS institution no.), **BNO** (invoice/dispatch no.) |
| **Alma** (acceptance) | the recipient | completes ownership transfer; **no cancellation** — reverse only by a new verme |
| **Envanter** | **health service provider / medical service provider** | product no., acquisition date, **serial no.**; for devices **subject to maintenance, repair and calibration** |
| Tüketiciye verme | sales centre, direct sale to a citizen | consumer identity fields |
| HEK / zayiat | holder | end-of-economic-life, loss, fire, theft, stock correction |
| Geri çekme verme/alma | per recall decision | recall handling |

### 4.3 Does a distributor have to notify ÜTS when a device is delivered to a clinic?

**Yes** — for tekil-tracked devices, which since 01.01.2020 means all device classes
(2019/ÜTSG-04 timeline: optics 2017, AIMD 2018, class III 2018, all groups mandatory 31.10.2019;
2019/ÜTSG-10 set 01.01.2020). *(observed, secondary for the last date)*

Sequence and consequences: the distributor files **verme** with the clinic's ÜTS institution number
and the invoice/dispatch number; ownership does **not** move until the clinic files **alma**, and
unaccepted transfers sit in "Verme Yaptığım Askıdaki Tekil Ürünlerim"; if the recipient is not defined
in ÜTS, "Tanımsız Yere Verme Bildirimi" with the tax number is used; `alma` cannot be cancelled, only
reversed by a new `verme`. *(observed)*

**INFERENCE — design consequence.** The delivery record needs a state machine mirroring ÜTS, not a
boolean: `NOT_REQUIRED | PENDING | SENT | ACCEPTED | REJECTED | CANCELLED`. Without it the operator
cannot answer "which delivered devices are still not accepted by the clinic?", which is also the
question that protects the 10-year traceability duty.

### 4.4 Is there a ÜTS obligation tied to service/maintenance events?

Three distinct answers:

1. **No movement notification for a service event.** The notification set in §4.2 has no
   "bakım/onarım" movement; repair does not change ownership, so it is not a `verme`. *(observed by
   absence, plus the closed-list structure of the guide)*
2. **The clinic has an inventory duty defined by maintainability.** ÜTS guide Art. 8(1): health
   service providers file an **envanter bildirimi** for fixed-asset devices **subject to maintenance,
   repair and calibration**, with acquisition date and serial number. *(observed)* **INFERENCE:** the
   distributor's service record is the natural evidence of when the device was installed.
3. **ÜTS carries the maintenance/calibration lifecycle on the clinic side.** Under "Klinik
   Mühendislik" the modules page lists *Bakım ve Onarım Yönetimi*, *Kalibrasyon Yönetimi*, *Teknik
   Personel Sertifikasyon*, *Teknik Servis Yönetimi*, *Kalibrasyon Kuruluşu Yönetimi* and a citizen
   *Bakım ve Kalibrasyon Sorgulama*. The official calibration guide shows the live flow: clinic
   creates `Kalibrasyon Talebi` → body enters a `Kalibrasyon Programı` → performs the test → uploads
   the report and selects reference equipment → e-signs → **submits for clinic approval**.
   *(observed)*

   **UNVERIFIED:** whether the *bakım/onarım* half is live for technical services today or still
   roadmap (the modules page is written in future tense). The calibration half is demonstrably live.

### 4.5 Would Servora-Med need a ÜTS integration?

**Recommendation (not a legal requirement).**

| Option | When it is right | Cost/risk |
| --- | --- | --- |
| **Store-only (recommended start)** | always | none beyond data modelling; operator keeps using ÜTS UI |
| **`verme` automation** | high delivery volume, or serial numbers already captured at delivery | e-signature token custody, idempotency against a stateful external system, "result unknown" handling |
| **Clinic-side automation (envanter, kalibrasyon)** | never for this product | those are the clinic's or the calibration body's legal acts |

Data that must exist regardless: ÜTS product number (UNO/barcode), serial and lot, clinic ÜTS
institution number (KUN), invoice/dispatch number used in the notification, notification state, and
the ÜTS reference of any calibration report.

**Security note.** A ÜTS system token is an e-signature-derived credential; per `AGENTS.md` §5 it must
never be stored in plaintext, logged or exported. Any future integration needs a per-organisation
secret with explicit operator consent — a separate decision, not a side effect of this module.

---

## 5. Q3 — After-sales service regime: which rules actually apply to B2B medical equipment

### 5.1 The consumer regime does **not** cover clinic purchases

*(observed, R8)* Satış Sonrası Hizmetler Yönetmeliği: scope is the goods in its **annexed list** plus
independent service stations serving them; `tüketici` means a person acting **for non-commercial,
non-professional purposes** (Art. 4(1)(k)); the annexed health section is **"KİŞİSEL KULLANIM
CİHAZLARI"** (blood-pressure monitors, glucose meters, hearing aids, thermometers, massage devices,
3–5 year lives); duties cover authorised stations for the declared life (Art. 5), maximum repair time
(Art. 10(4)), **service fişi** contents (Art. 11(2)), spare parts and price list (Art. 12), replaced
part return (Art. 13) and **3-year document retention** (Art. 16).

A dental unit, autoclave, panoramic X-ray or compressor bought by a clinic is a **professional**
purchase: not in the list, and the buyer is not a `tüketici`. **INFERENCE:** R8 imposes no `servis
fişi`, usage-life or repair-time duty on this business for those sales.

R3 confirms the separation from the other side: Art. 2(2) excludes "technical service activities
within the scope of after-sales services under 6502" from the medical-device regime. The two are
mutually exclusive by product/customer. *(observed)*

### 5.2 But there **is** a B2B warranty regime for medical devices

R2 Art. 25/A–25/Ç (added 26/5/2023) creates a warranty owed **to the health service provider**:

| Element | Rule | Article |
| --- | --- | --- |
| Who must issue | sales centre that is manufacturer/importer, for devices requiring technical service | 25/A(1) |
| Form | clear language, paper or durable medium; paper on request; proof of delivery on the seller | 25/A(2) |
| Start | invoice date, after the provider's acceptance | 25/B(1) |
| Minimum duration | **2 years**, or the manufacturer's declared unit if the device can measure it | 25/B(2)–(3) |
| Repair time | added to the warranty period; start depends on on-site/off-site/cargo route | 25/B(4) |
| Use error | warranty stays valid if the **authorised** technical service does the work; it may charge | 25/B(5) |
| Third-party service | device **may be excluded** from warranty | 25/B(6) |
| Replacement device | its warranty ≥ remaining warranty of the original | 25/B(7) |
| Mandatory certificate fields | including **annual maximum total repair time**, warranty period, authorised service contact, invoice date/no, ÜTS product name/brand/version/barcode/lot-serial, delivery date/place, statement that all parts except PM kits and consumables are covered | 25/C |
| Free repair | no charge for labour, parts or cargo by any sales centre in the chain | 25/Ç(1) |
| Refund/replacement trigger | repair not possible (reported by manufacturer/importer or authorised service) **or** annual maximum repair time exceeded | 25/Ç(2) |
| Refund/replacement deadline | **45 days** | 25/Ç(3) |
| "Not repairable" report | within **30 days** of the fault notification, copy to the provider | 25/Ç(4) |
| Substitute device | extends the annual maximum by up to 60 days total | 25/Ç(5) |
| Extra rights | contract may add, not subtract | 25/Ç(6) |

*(observed)* **INFERENCE — this is the single biggest functional surprise for a JobCard-only design.**
The module needs, per device: warranty start/end, annual maximum repair time (a configured number
from the certificate), an accumulator of repair days per warranty year, and an event when the
accumulator crosses the threshold — because crossing it converts a repair into a refund/replacement
obligation with a 45-day clock.

### 5.3 Usage life and spare parts

- `kullanım ömrü` is **manufacturer-declared** at placing on the market (R2 Art. 4(cc)); there is no
  official table of usage lives for professional dental equipment. *(observed)*
- R2 Art. 26(9) — for the whole declared usage life, a manufacturer/importer sales centre must:
  submit a technical-service commitment to the Authority; meet spare-part requests **within 20
  business days domestic / 30 abroad** (the Authority may double these); provide service passwords
  and keys **free of charge**; and supply whatever equipment is needed to install, use and
  decommission the device. *(observed)*
- R3 Art. 13: no spare part that harms safety/performance or changes intended purpose; a
  non-manufacturer part needs a **manufacturer compatibility declaration** (guide Ek-2/Ek-4).
  Art. 10(11): replaced parts are shown to the provider under warranty and handed over outside it.
  *(observed)*

**INFERENCE:** "20/30 business days" is a scheduling constraint, not a target: record the part
request date and the statutory due date per line, because a missed part deadline is indistinguishable
from a missed repair deadline in a dispute.

---

## 6. Q4 — Calibration and periodic checks: who owes what, and what is handed over

### 6.1 The obligation holder is the health service provider

*(observed, R5 Art. 24)* The provider must have its devices tested/controlled/calibrated; if no
national/international protocol or manufacturer criterion states a period, **at least once a year**
(Art. 10(2) mirrors this for the bodies). The provider must also re-test after a failed result, decide
limited use, and keep/record reports into the Authority's electronic environment on request (Art. 24).

Crucially, R5 Art. 2(2) excludes "manufacturers', importers', **technical services'** and users'
test/control/calibration activities" from that regulation. *(observed)* **INFERENCE:** a distributor's
own workshop checks are *not* "calibration" under R5; R5 governs **authorised calibration bodies**.
That is why a service company cannot simply declare itself a calibration provider.

### 6.2 Authorised-body monopoly is partial and moves

*(observed)* R5 Art. 11(2): providers must use the **announced authorised bodies**; where none exists
for a scope, national/international protocols and manufacturer criteria apply. Art. 11(3) allows the
Authority to suspend the obligation temporarily. Art. 11(5): an authorised body **may not** also
manufacture, import, export, sell, maintain or repair medical devices (in-house provider maintenance
is exempted). Rollout has been phased: Tekirdağ pilot 01/07/2023, then İstanbul/Ankara/İzmir/Tekirdağ
from 01/01/2024 for ultrasound; further device types announced for 01/01/2025, postponed to 01/07/2025.

Device scope that matters here (TİTCK authorised-body list, 12.05.2026): **Diş Üniti** sits inside
"Akış, Ağırlık, Uzunluk, Hacim, Sıcaklık, Basınç, Devir"; **Otoklav/Sterilizatör** inside
"Sterilizasyon ve İnkübasyon Sistemleri"; **dental radiography** is handled by R6 instead (§6.3).

**UNVERIFIED / caution:** being *listed* in a yetki grubu is not the same as being inside the
*current mandatory-outsourcing* scope, which is limited by province and announced device type and
changes by announcement. **INFERENCE:** store the *basis* of each period ("manufacturer IFU" vs
"authorised-body mandatory") and its validity as data, not as code branches.

### 6.3 Dental X-ray: three overlapping regimes

1. **NDK licence:** periapical, panoramic and volumetric dental units each need a licence; a Radiation
   Protection Officer (`RKS`) is required (dentist, radiology specialist, or a radiology/medical-imaging
   associate degree); licences are 5-yearly and must be re-licensed on relocation. *(observed, ndk.org.tr)*
2. **Radiation safety / QA programme:** R7 requires a quality-assurance programme; the 2022 regulation
   specifically covers `ağız, diş ve çene radyolojisi` and requires a radiation measurement device
   calibrated at the TENMAK secondary standard dosimetry laboratory; the NDK dental licence form says
   **at least every 2 years**. *(observed)*
3. **Diagnostic-radiology QC** (R6): quality-conformity and quality-control tests by a **medical
   physicist** with a TİTCK work certificate; conformity is **5-yearly** for diagnostic radiology;
   control periods follow the TİTCK guide. **However**, TİTCK announced on 25.10.2024 that the duty to
   outsource these to authorised persons/bodies is **lifted as of 23.12.2024 until a further
   announcement**. *(observed)*

**INFERENCE:** the service provider's realistic role for dental X-ray is to coordinate the medical
physicist's QC visit, keep the QC report on the device file, keep the NDK licence and RKS references,
and ensure A-group technical competence for any intervention. Store **four different documents per
X-ray device**, not one "calibration date".

### 6.4 Hospital quality standards (SKS)

*(observed, reproduced SKS text)* Device-management standards require:

- **DMC10** traceability: department-level inventory with device name, asset/biomedical number,
  serial, brand, location; device card/label; inventory visible in the Ministry system.
- **DMC11.02**: maintenance and calibration performed regularly.
- **DMC13 (core)**: a monitored plan for maintenance/repair/adjustment/test/control/calibration.
  **DMC13.02** fixes the calibration report content: body and certificate info; hospital and device
  identity (location, name, brand, model, asset and serial no.); operations performed; **measured
  values, results and measurement uncertainty**; the standards used; reference equipment with its
  own calibration date/certificate/location; performing and approving persons with signature;
  place, date and validity; **environmental conditions** (temperature, pressure, humidity); report
  number; personnel certification; the hospital observer's signature for outsourced work.
- **DMC13.03**: calibration label with body, asset no., date, validity, certificate no., and
  **different colours for pass / partial pass / fail**. **DMC14**: quarantine/limited use.
  **DMC15**: fault notification and repair recorded; device taken out of use and marked.

Sterilisation standards add a precise rhythm (see §9.2) and a record list (SDS13.01) that includes
**maintenance, repair and calibration records of the steriliser** next to cycle and test records.

**UNVERIFIED:** whether SKS-Hastane applies verbatim to a private dental clinic, or whether the
oral-and-dental-health SKS set applies. **INFERENCE:** either way these are the fields a Turkish
inspector will look for, so they are the right checklist for the module's report template.

---

## 7. Q5 — Authorised service and technician competence

### 7.1 Two credentials, both from TİTCK

*(observed, R3)*

| Credential | Issued to | Content |
| --- | --- | --- |
| **Teknik servis faaliyet belgesi** | the service organisation | which A/B/C device groups and which devices it may service (Art. 6(8)) |
| **Çalışma belgesi** | technical manager (`teknik müdür`) and each technician | scope of activity; printed on a photo ID badge worn on site (Art. 8(3)) |

Structural requirements: a **full-time technical manager** who may not manage more than one technical
service (Art. 8(1), (4)); at least one bachelor-level technician for A group, bachelor or associate for
B, and bachelor/associate/high-school for C (Art. 10(3)–(5)); **technical service training per
brand+model for A, brand+device type for B, device type for C** (Art. 14(3)), with untrained persons
barred from intervening at all (Art. 14(1)); and **warranty work plus software/hardware modification,
update and upgrade only by the authorised technical service**, an independent service needing the
manufacturer's/importer's written approval (Art. 9(2)). *(observed)*

### 7.2 TSE service-competence certificate

*(observed)* R3 Art. 5(2)(e) lets TİTCK require a **hizmet yeterlilik belgesi** in the application
file, and the 2019/1 Genelge required certification to **TS 12426** (authorised services – medical
devices) or **TS 13703** (special services – medical devices). *(secondary summary; the Genelge text
itself was not fetched — UNVERIFIED as to current wording)* **INFERENCE:** TSE HYB is real and expected
in public procurement, but the **operative** credential here is the TİTCK activity certificate; TSE is
supporting evidence the Authority may ask for.

### 7.3 ÜTS registration of the service provider and its technicians

*(observed, TİTCK Klinik Mühendislik page)* Health service providers must require, when procuring
service, that the provider is registered in ÜTS as **"Tıbbi Cihaz Servis İstasyonu"** and its
technicians as **"Teknik Personel"** (Genelge 2020/6). That is a *procurement* gate on the clinic, so
an unregistered service company is commercially excluded before any inspection.

**INFERENCE:** store per technician the ÜTS registration reference and TİTCK work-certificate number,
and per organisation the activity-certificate number and A/B/C scope — the report must carry the
certificate number, and the printed report carries a distinctive mark containing it (guide 10(2)–(5)).

---

## 8. Q6 — Record retention

| Record | Minimum period | Basis |
| --- | --- | --- |
| Technical service records (provider side) | **10 years** from the intervention | R3 Art. 10(10) *(observed)* |
| Technical service records (health provider side) | **10 years** | R3 Art. 11(5) *(observed)* |
| Device manual, warranty certificate, technical documents (health provider side) | **until the device is taken out of use** | R3 Art. 11(2) *(observed)* |
| Supply-chain traceability (who supplied whom, incl. health institutions) | **10 years** (15 implantable) | R1 Art. 25(2) + 10(8) *(observed)* |
| Previous/next operator + lot/serial/brand/model records (sales centre) | **at least 10 years** | R2 Art. 31(3) *(observed)* |
| Other sales-centre documents | **5 years** | R2 Art. 8(6) *(observed)* |
| Free-sample distribution data | 5 years | R2 Art. 24(2) |
| Scientific/educational event documents | 2 years | R2 Art. 21(7) |
| Radiology maintenance/repair reports | **10 years**; radiation sources 20 years; dose records ≥30 years | R7 Radyoloji Hizmetleri Art. 16(7) *(observed)* |
| Consumer after-sales documents (if a consumer sale ever occurs) | 3 years | R8 Art. 16(1) |
| Commercial books and underlying documents | **10 years** (TTK) vs 5 years (VUK); the longer binds | TTK m.82(5), VUK m.253 *(observed)* |

**INFERENCE — retention policy for the module.** (1) The floor is **10 years from the last event on
the device**, because each service record is separately 10-year and the device file must survive to
decommissioning. (2) Do **not** delete a device record because its JobCard was archived — the legal
unit is the device, not the job. (3) Personal data inside those records (technician name, clinic
contact, signature) is subject to KVKK storage limitation: keep the operational record for the legal
period but separate "who signed" from "what was done", so identity can be minimised or pseudonymised
later without destroying the service history. (4) A hard-delete path for devices never delivered is
safe and desirable; for delivered devices it is not.

**UNVERIFIED:** any sector-specific rule requiring longer than 10 years for dental equipment service
records; none found. Customer contracts may require more — that is a commercial, not legal, floor.

---

## 9. Q7 — Industry practice

### 9.1 Typical workflow (observed across manufacturer guidance + R3/guide)

1. **Installation / commissioning** — installation report, safety test, handover; device identity
   recorded (serial, ÜTS barcode, asset no.); warranty starts at invoice.
2. **Coverage definition** — warranty vs maintenance contract vs pay-per-call, with response and
   repair-time commitments and the annual maximum repair time printed on the certificate.
3. **Fault intake and dispatch** — triage to remote/on-site/workshop; clinic takes the device out of
   use and marks it (SKS DMC15.04); technician must hold the right brand/model training and
   certificate scope; parts checked against the 20/30 business-day SLA.
4. **Intervention** — off-site work needs a handover document (cargo receipt counts as one).
5. **Post-work safety decision** — if the work could affect safety/performance, test/control/
   calibration (or manufacturer tests) must pass **before** use, and the pass document is attached.
6. **Report and closure** — report with the eleven fields, technician signature and clinic
   counter-signature; replaced parts shown or returned; next due date set. Any suspected adverse
   event is forwarded immediately to the manufacturer/importer and recorded.

### 9.2 Typical intervals (all manufacturer-driven; treat as defaults, not law)

| Device class | Clinic-side (short cycle) | Service-provider cycle | Source |
| --- | --- | --- | --- |
| **Dental unit / chair** | daily flush and disinfection, weekly valve/O-ring checks, monthly upholstery and light shield | **annual** PM kit + function/safety test | A-dec checklist; DD Group; KaVo |
| **Dental unit waterlines** | continuous/periodic treatment; monitor per manufacturer | **quarterly** culture, target **≤500 CFU/mL** | CDC; ADA |
| **Compressor** | **daily** tank drain; weekly moisture indicator; monthly pressurisation-time check | **annual** intake filters, ultra-air filter, oil (if lubricated), belt/valve check; exhaust muffler semi-annual | Midmark; Burkhart; MedEquip |
| **Autoclave / steriliser** | **daily** Bowie-Dick before first load; **weekly** vacuum-leak test and **weekly** biological indicator (every implant load); semi-annual door/cassette seals | **annual** PM, validation at least yearly, and re-validation after major repair/sensor change | SKS SDS10/SDS11; DAS guide; Burkhart |
| **Dental X-ray (periapical/panoramic)** | monthly tube-head/arm drift check | **annual** performance test (output, HVL, kVp/mA, timer accuracy, collimation/beam alignment) by qualified service; medical-physicist QC per R6 | CDA guide; R6 |
| **Handpieces** | clean/lubricate/sterilise after each patient | inspection **every 6–12 months**, bearing/turbine service | A-dec; MedEquip |
| **Intraoral scanner** | cleaning per IFU, tip/barrier | **no PM interval found**; software/firmware updates and manufacturer service | — (UNVERIFIED) |

**Note on legal vs practice.** The legal default when nothing else is specified is **at least annual**
(R5 Art. 10(2)/(24(2)); R3 compliance is "per manufacturer"). So a module that defaults to 12 months
and lets the manufacturer's IFU override it matches both.

### 9.3 Technical service report — the eleven mandatory fields

*(observed, guide TCS-KLVZ-09 Art. 10(6))*

| # | Field | Module implication |
| --- | --- | --- |
| a | service name and contact details | organisation master data |
| b | health provider name, unit, address | customer + site/location |
| c | device name, brand, model, **serial no., ÜTS barcode no., asset (`künye`) no.** | installed-base record |
| ç | work performed: fault found, maintenance operation, part replacement | structured operation lines + free text |
| d | performing technician name, surname, **signature** | technician identity + signature evidence |
| e | accompanying provider staff name, surname, **signature** | second signature, per intervention |
| f | date of the intervention | event timestamp |
| g | report number | sequential, organisation-scoped |
| ğ | spare parts used | part lines |
| h | measuring instruments used | reference-equipment lines (each with its own calibration) |
| ı | decision on **fitness for use** | tri-state: fit / fit-with-restriction / not fit |
| i | decision on whether the work **could affect safety or performance** | boolean that triggers a mandatory post-test |

Plus, from Art. 8(9), the **pass document for the post-work test** is attached to the report; and from
Art. 10(2)–(5), the printed report carries a defined **distinctive mark with the activity certificate
number**.

### 9.4 How visits get scheduled (practice)

- **Contract-driven calendar**: PM dates derive from the installation date, not the last visit, so a
  late visit does not silently shift the whole programme.
- **Two clocks**: warranty/contract expiry and PM due date, plus statutory clocks (repair-day
  accumulator, part-delivery due date, 30-day use-error report).
- **Batch by site**: multi-chair clinics are served in one visit; the visit is a planning unit while
  each device needs its own report.
- **Capacity coupling**: an on-site visit occupies staff time, so it interacts with SCH-001 and the
  assignment window (JOB-010/JOB-012) if it is modelled as a JobCard.

---

## 10. Q8 — Requirement → who → record → priority → source

Priority: **MUST** = legally required and this business is the duty holder; **SHOULD** = legally
required of the clinic but the service provider is the practical source of the evidence, or strongly
expected industry practice; **OUT** = belongs to another module or to the customer.

| # | Requirement | Distributor / importer? | Clinic? | Record the module should keep | Priority | Source |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Device identity incl. UDI/ÜTS barcode and serial | yes | yes | device record: brand, model, serial, ÜTS product no., asset no. | MUST | R1 27; guide 10(6)(c) |
| 2 | Delivery/transfer to a health institution traceable 10 y | yes | — | delivery line → clinic, date, invoice/dispatch no., serial | MUST | R1 25(2); R2 31(3) |
| 3 | ÜTS `verme` notification + acceptance state | yes | acceptance is clinic's | notification state machine + KUN + BNO + timestamps | MUST (state) / SHOULD (automation) | ÜTS guide 9–10 |
| 4 | ÜTS inventory reference of the device at the clinic | no | yes | store the clinic's inventory/acquisition date + serial as reference | SHOULD | ÜTS guide 8 |
| 5 | Technical service activity certificate + A/B/C scope | yes | — | organisation certificate no., scope, validity | MUST | R3 6(8), guide 10(2) |
| 6 | Technician work certificate + brand/model training | yes | — | per technician: certificate no., trained brand/model, validity | MUST | R3 8, 14 |
| 7 | ÜTS registration of service station + technicians | yes | gate on procurement | registration reference per org and per technician | SHOULD | Genelge 2020/6 (TİTCK page) |
| 8 | Technical service report, 11 fields, numbered, signed | yes | counter-signs | full report entity + PDF snapshot | MUST | R3 10(8); guide 10(6) |
| 9 | Handover document for off-site repair | yes | — | handover record with date, parties, signature; cargo no. | MUST | R3 10(9) |
| 10 | Post-work safety/performance test pass document | yes | — | test result + attachment + pass/fail | MUST | R3 13(3); guide 8(8)–(9) |
| 11 | Use-error report within 30 days | yes (authorised service) | receives copy | report + fault notice date + 30-day due date | MUST | R3 10(13); R2 25/Ç(4); guide Ek-6 |
| 12 | Spare part identity + compatibility declaration | yes | — | part lines; declaration attachment when non-OEM | MUST | R3 13; guide 11 |
| 13 | Replaced part return/show | yes | receives | part disposition: shown / returned / disposed | SHOULD | R3 10(11) |
| 14 | Warranty certificate data (2 y min, annual max repair time) | yes | holds | warranty start/end, max repair days, certificate no. | MUST | R2 25/A–25/C |
| 15 | Repair-day accumulator vs annual maximum | yes | — | per intervention duration + running total per warranty year | MUST | R2 25/Ç(2) |
| 16 | Refund/replacement clock (45 days) | yes | requests | decision event + 45-day due date | SHOULD (rare path) | R2 25/Ç(3) |
| 17 | Declared usage life + spare-part SLA 20/30 business days | yes | requests | usage life per model; part request date + statutory due date | MUST (SLA) | R2 4(cc), 26(9)(b) |
| 18 | Maintenance plan per device with a stated basis | yes | yes | interval, basis (IFU / contract / authorised-body), next due, last done | MUST (as evidence) / SHOULD (as plan) | R3 6, 11(1); R5 10(2) |
| 19 | Calibration/test record + certificate + label | no (body does it) | yes | certificate no., body, dates, validity, result, label state | SHOULD | R5 11–12; SKS DMC13.02/.03 |
| 20 | X-ray: NDK licence, RKS, QC report, measurement-device calibration | no | yes | four documents per X-ray device with validity dates | SHOULD | R7; R6; ndk.org.tr |
| 21 | Complaint / adverse-event intake and forwarding | yes | reports | complaint entity, device link, forwarded-to-manufacturer timestamp | MUST | R1 14(5), 13(8) |
| 22 | FSN / recall handling per device | yes | acts | FSN reference, affected serials, action, acknowledgement | SHOULD | R1 3, 85, 88 |
| 23 | Device decommission / HEK-zayiat | yes (if holder) | yes | decommission date, reason, ÜTS HEK notification reference | SHOULD | ÜTS guide 15 |
| 24 | Immutable audit of every service event | — | — | append-only history; report versioning, no silent edits | MUST (project rule) | `AGENTS.md` §3 |
| 25 | Invoice, payment, stock balance, e-invoice | no | — | **nothing** | OUT | MOD-001; SALE-001; DOM-001 |
| 26 | Patient/clinical data | no | — | **nothing** | OUT | scope |

---

## 11. Testing the owner's hypothesis against the evidence

**Hypothesis:** assignment, lifecycle and approval stay in JobCard; device service history lives in
the Maintenance module.

**Supported.**

1. The legal artefact is **per device and per intervention**, must survive 10 years, and follows the
   device across owners and jobs — so a JobCard, a work unit with a lifecycle, is the wrong retention
   unit. *(R3 Art. 10(10), 11(5); guide Art. 10(6))*
2. The report needs a **device identity block** (serial, ÜTS barcode, asset no.) and a
   **measuring-instrument block**; neither exists today. The delivery item carries `serial_no` and
   `lot_no` only (`server/src/db/migrations/002_delivery_tracer.sql:137-166`) and the product is
   catalogue-level, with `brand`/`model` but no device instance
   (`server/src/modules/products/types.ts:3-18`). An installed-base entity is required regardless.
3. The **warranty clock** (2-year minimum, repair-day accumulator, annual maximum, 45-day refund
   clock) is a property of the device/contract, not of one job. *(R2 25/A–25/Ç)*
4. **Complaint and FSN records** are operator duties keyed to device and model; a JobCard is not a
   plausible home for a model-level safety notice. *(R1 14(5), 85, 88)*

**Needs refinement.**

1. **A visit still consumes staff time.** If it is not a JobCard, the Maintenance module must feed the
   core occupancy rule, or SCH-001's "one definition of occupancy" (`DECISIONS.md` SCH-001 item 3,
   `server/src/modules/job-cards/occupancy.ts`) breaks.
2. **Approval semantics differ.** JobCard approval is manager approval of staff work
   (`PRODUCT_REQUIREMENTS.md`). A service report is *counter-signed by the customer* and, when a
   post-work test is needed, *released by the test result*; mapping that onto manager approval
   corrupts the audit meaning.
3. **A new JobCard type is not free.** Adding `MAINTENANCE`/`BAKIM` to `JOB_CARD_TYPES`
   (`server/src/modules/job-cards/types.ts:11-30`) hits **V11**
   (`docs/backlog/2026-11-25-core-modules-architecture-research.md:49`): policies silently inherit an
   existing branch instead of failing compilation. PR #513
   (`origin/refactor/job-card-exhaustive-dispatch`) makes those dispatches exhaustive, so it is a
   precondition rather than a nice-to-have.

**Recommendation (INFERENCE):** `device` (installed base) and `service_record` (immutable, 10-year)
live in Maintenance; the visit/job lives in JobCard (new type or a thin "maintenance visit" job) and
links to one or more `service_record`s; occupancy is read from whichever entity holds the scheduled
interval, through the single core reader SCH-001 requires.

---

## 12. Minimum data the module cannot avoid

Listed so the owner can price the slice; all are traceable to §10.

1. **Device**: brand, model, serial, ÜTS product/barcode no., optional asset/`künye` no., installation
   date, clinic + site/unit, warranty start/end, declared usage life, status (`ACTIVE |
   OUT_OF_SERVICE | DECOMMISSIONED`).
2. **Delivery link**: source delivery item (product, date, invoice/dispatch no.), ÜTS notification
   state, recipient ÜTS institution no.
3. **Coverage**: warranty | contract | chargeable, with annual maximum repair days and accumulator.
4. **Plan**: interval, basis, next due, last done, and the rule that produced the next due date.
5. **Service record**: report number, date, type (install / PM / repair / calibration coordination /
   decommission), technician + certificate no., customer counter-signature, operations, parts (with
   compatibility-declaration flag), measuring instruments, fitness decision, safety-impact decision,
   post-test result, attachments.
6. **External references**: ÜTS calibration request/report no., NDK licence no., QC report no.,
   certificate numbers and validity dates. **Safety**: complaints, adverse events, FSN/recall with
   affected serials and acknowledgement. **Audit**: append-only events; a signed report is superseded,
   never edited.

---

## 13. Open questions for the owner

1. **Legal role per product line.** For which brands is this company the *importer* (R1 Art. 13) and
   for which only a *distributor* (Art. 14)? Duties, ÜTS behaviour and warranty issuer differ.
2. **Service status.** *Authorised technical service* for its brands, independent (*özel*) technical
   service, or both? Only the authorised one may do warranty work and software/hardware modification
   (R3 Art. 9(2)).
3. **ÜTS ambition.** Record-only (operator keeps using the ÜTS UI), or automate `verme`? If automate,
   who holds the e-signature token, and where?
4. **Clinic identifiers.** Will the team maintain the clinic's ÜTS institution number (KUN) and the
   inventory/acquisition date as customer master data?
5. **JobCard or not.** New JobCard type (`BAKIM`), a distinct visit entity inside Maintenance, or an
   existing type carrying a service-record link? This decides whether V11/#513 is a blocker.
6. **Launch device scope.** Dental unit, autoclave, compressor, X-ray, intraoral scanner, handpieces —
   which are in the first slice? Compressor and scanner may need explicit exclusion (§14).
7. **Contracts.** Are maintenance contracts sold (SLA, response time, included parts)? That decides
   whether "coverage" is a module concept or an Accounting concept.
8. **Retention.** Is 10 years from the last event acceptable as the deletion floor, and do any
   customer contracts demand longer?
9. **Signature evidence.** Is a typed name + role + timestamp enough for the customer
   counter-signature in V1, or is a captured signature image / e-signature required?
10. **Turkish output.** Must the module produce a PDF matching the TCS-KLVZ-09 layout (including the
    distinctive mark and certificate number), or is an internal record plus the existing manufacturer
    form enough for V1?

---

## 14. Unverified items

1. **ÜTS report-entry deadline** for calibration reports (guide v2 mentions a period; the number of
   days was not extracted).
2. **Live status of the ÜTS "Bakım ve Onarım Yönetimi Modülü"** for technical services. The
   calibration half is demonstrably live; the maintenance half is described in future tense on the
   ÜTS modules page.
3. **Whether dental units and autoclaves are currently inside the mandatory authorised-body
   calibration scope** (province + announced device type). They sit inside the yetki groups, but the
   mandatory-outsourcing list is narrower and changes by announcement.
4. **SKS applicability** to a private dental clinic versus an oral-and-dental-health centre.
5. **Compressor as a medical device.** A dental air compressor is probably *not* a medical device for
   R3 (it is not in Ek-7), but it may be an accessory, and it is a pressure vessel with its own
   periodic-inspection regime. Neither point was confirmed.
6. **Intraoral scanners** — no PM or calibration obligation found in R3/R5/R6; manufacturer-driven only.
7. **Current revision of TS 12426 / TS 13703**, and whether the 2019/1 Genelge is unchanged after 2023.
8. **Typical declared usage lives** for professional dental equipment — no official table exists.
9. **Whether an FSN acknowledgement from the clinic is legally required**, or only manufacturer practice.
10. **KVKK-specific retention** for service records with personal data — no sector guidance found.

---

## 15. Source list

Full URLs, access dates and per-source notes: `$FLEET_EVIDENCE_DIR/sources-and-access-log.md`;
the short quotes used: `$FLEET_EVIDENCE_DIR/key-excerpts.md`.

Primary instruments (RG date / number): Tıbbi Cihaz Yönetmeliği 2/6/2021-31499 (mük.);
Tıbbi Cihaz Satış, Reklam ve Tanıtım Yönetmeliği 7/5/2014, am. 2/9/2020-31232 and 26/5/2023-32202;
Teknik Servis Yönetmeliği 26/5/2023-32202, am. 30/12/2025-33123, TİTCK guide TCS-KLVZ-09 v1
21/8/2024; Test, Kontrol ve Kalibrasyon Yönetmeliği 25/6/2015-29397, am. 10/12/2021-31685;
Diagnostik Radyoloji Kalite Kontrol Yönetmeliği 23/12/2021-31698, am. 20/12/2023-32405;
Radyoloji Hizmetleri Yönetmeliği; Radyasyon Güvenliği Yönetmeliği and 26/4/2022-31821;
Satış Sonrası Hizmetler Yönetmeliği 13/6/2014-29029; ÜTS tekil hareket kılavuzu, web-service document
v1.99, modules page and calibration guide v1; TİTCK announcements 25.10.2024 and 20.02.2024.

Industry (intervals only): A-dec checklist (Rev H, 2022-11-07), Burkhart, Midmark, KaVo, DD Group,
MedEquip (2026-03-28), CDC water quality (2024-05-15) and HAN-00478 (2022-10-31), CDA radiation safety
guide, SKS DMC/SDS reproductions, DAS 2025, Selçuk University steriliser instruction, TSE HYB pages.

Repository anchors: `server/src/modules/job-cards/types.ts:11-30`,
`server/src/modules/products/types.ts:3-18`, `server/src/db/migrations/002_delivery_tracer.sql:4,31,51,137-166`
and `server/src/modules/job-cards/handlers.ts:168`; plus
`docs/backlog/2026-11-25-core-modules-architecture-research.md:49` and `DECISIONS.md` SCH-001 item 3,
MOD-001 items 1–2.
