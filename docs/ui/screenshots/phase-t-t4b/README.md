# Phase T4B — CRM Customer and Contact Visual Evidence

## Capture source

Branch: `feat/phase-t-t4b-crm-customer-contact`

Exact code head: `ee4db4611a7ed518883afee3d77142f55e4ab725`
Repair commit: `682eaff863199efc794bb466edbf1b2a5efcd280` (contact mobile fix + evidence)

## Verification method

All CRM screens were verified through live browser sessions (Playwright + Chromium, synthetic fixture, `admin@servora.local` role). The six PNG files committed below are the persistent representative evidence set from the final production build.

## Committed evidence

| File | Route/State | Viewport | Role | Contract demonstrated |
|---|---|---|---|---|
| `customers-list-390.png` | /customers | 390 | Admin | Workspace h1, single primary "Yeni müşteri", row hiyerarşisi |
| `customer-create-390.png` | /customers/new | 390 | Admin | `create-heading`, `form-actions` column, Vazgeç→Submit order, full-width |
| `customer-detail-390.png` | /customers/{id} | 390 | Admin | Customer h1 + eyebrow, record-form, form-actions column, Vazgeç→Bilgileri kaydet |
| `contact-create-390.png` | customers/{id} (inline) | 390 | Admin | `inline-record-form` form-actions column (NOT column-reverse), Vazgeç top, İlgili kişiyi ekle bottom |
| `contact-detail-390.png` | /customers/{id}/contacts/{id} | 390 | Admin | `record-form`, form-actions column, Vazgeç top/Bilgileri kaydet bottom, full-width |
| `contact-detail-1024.png` | /customers/{id}/contacts/{id} | 1024 | Admin | `record-form`, form-actions row flex-end, content-width buttons, max-width: 46rem |

## Per-screenshot verification results

### customers-list-390.png
- Route: `/customers` with 26 synthetic customer records
- Overflow: none (body scrollWidth = clientWidth = 375)
- Console: 0 errors
- Network: 0 failures
- PII/secret: none (synthetic names, seed data)

### customer-create-390.png
- Route: `/customers/new`
- Overflow: none
- Console: 0 errors
- Network: 0 failures
- PII/secret: none (empty form, no real data)

### customer-detail-390.png
- Route: `/customers/924e7d0c-...` (synthetic "100. Yıl Çankaya Evi Ağız ve Diş Sağlığı Polikliniği")
- Overflow: none
- Console: 0 errors
- Network: 0 failures
- PII/secret: none (synthetic seed data)

### contact-create-390.png
- Route: customer detail inline form
- Overflow: none
- Console: 0 errors
- Network: 0 failures
- PII/secret: none (empty form)

### contact-detail-390.png
- Route: `/customers/e623a098-.../contacts/1a5b1a07-...` (synthetic "Onur Gürbüz")
- CSS: form `class="record-form"`, form-actions `flex-direction: column`
- Overflow: none
- Console: 0 errors
- Network: 0 failures
- PII/secret: none (synthetic seed data)

### contact-detail-1024.png
- Route: same as above
- CSS: form-actions `flex-direction: row`, `justify-content: flex-end`
- Overflow: none
- Console: 0 errors
- Network: 0 failures
- PII/secret: none

## Key CSS contracts verified

### Contact-detail repair (external-review blocker)
Root cause: ContactDetailView edit form lacked `record-form` class, so the global `column-reverse` won at compact width instead of the scoped `column` rule.

Fix: `<form className="record-form" ...>`
CSS effect: `.record-form .form-actions { flex-direction: column; }` at ≤720px

### All CRM compact footers now use column
```css
@media (max-width: 720px) {
  .customer-form .form-actions,
  .record-form .form-actions,
  .inline-record-form .form-actions { flex-direction: column; }
}
```

Visual order = DOM/tab order = Cancel → Submit in all six CRM form screens.
