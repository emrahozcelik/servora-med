# Phase T4B — CRM Customer and Contact Visual Evidence

## Branch

```text
feat/phase-t-t4b-crm-customer-contact
```

## Verification method

All CRM screens were verified through live browser sessions (Playwright + Chromium, synthetic fixture, admin@servora.local role). Live screenshots were captured during verification but stored in ephemeral task directories that are not persisted in this repo. The evidence below documents what was verified and the exact CSS/DOM values confirmed.

## Browser verification summary

| Screenshot | Route | Viewport | Role | Result | Notes |
|---|---|---|---|---|---|
| customers-list-390 | /customers | 390 | Admin | ✅ PASS | workspace h1 "Müşteriler", tek "Yeni müşteri" primary, row hiyerarşisi, yatay taşma yok, console clean |
| customers-list-1024 | /customers | 1024 | Admin | ✅ PASS | Aynı kontroller desktop'ta |
| customers-empty-390 | /customers (no results) | 390 | Admin | ✅ PASS | "Henüz müşteri kaydı yok" / "Filtrelere uygun müşteri bulunamadı", "Yeni müşteri" görünür |
| customer-create-390 | /customers/new | 390 | Admin | ✅ PASS | create-heading, form-actions column, Vazgeç→Submit visual+DOM order, full-width, validation error |
| customer-create-1024 | /customers/new | 1024 | Admin | ✅ PASS | create-heading, form-actions row flex-end, content-width buttons |
| customer-detail-390 | /customers/{id} | 390 | Admin | ✅ PASS | h1 müşteri adı, "Müşteri" eyebrow, form-actions column, Vazgeç→Bilgileri kaydet order, full-width, uzun ad wrap |
| customer-detail-1024 | /customers/{id} | 1024 | Admin | ✅ PASS | form-actions row, Vazgeç→Bilgileri kaydet, "İlgili kişiler" section |
| customer-edit-390 | /customers/{id} (edit mode) | 390 | Admin | ✅ PASS | form-actions column, Vazgeç üst, Bilgileri kaydet alt |
| customer-contacts-1024 | /customers/{id} (with contacts) | 1024 | Admin | ✅ PASS | "İlgili kişiler" heading, "İlgili kişi ekle" button, contact rows |
| contact-create-390 | customers/{id} (inline form) | 390 | Admin | ✅ PASS | form-actions column (NOT column-reverse), Vazgeç üst, İlgili kişiyi ekle alt, full-width |
| contact-detail-1024 | /customers/{id}/contacts/{id} | 1024 | Admin | ✅ PASS | h1 kişi adı, "İlgili kişi" eyebrow, form-actions, "Birincil kişi" section |

## Key CSS/DOM contracts verified

### Customer create (T4A form-chrome adoption)
- `class="create-heading"` (not `detail-heading`)
- `<div class="form-actions">` with Cancel (secondary, type="button") first, Submit (primary, type="submit") second
- Exactly one Cancel button in the form
- Desktop: `flex-direction: row`, `justify-content: flex-end`, content-width buttons
- Mobile: `flex-direction: column`, full-width buttons, Vazgeç top, Submit bottom

### Customer edit (new form-actions)
- `<div class="form-actions">` with Vazgeç (secondary, type="button") + Bilgileri kaydet (primary, type="submit")
- Cancel invokes `onBack` (returns to customer list)
- Compact: `flex-direction: column` via `.record-form .form-actions`

### Contact edit (new form-actions)
- `<div class="form-actions">` with Vazgeç + Bilgileri kaydet 
- Cancel invokes `onBack` (returns to customer detail)
- Compact: `flex-direction: column`

### Contact create form (column fix)
- Already had correct DOM order (Cancel→Submit) in form-actions
- Fix: `.inline-record-form .form-actions { flex-direction: column; }` at compact width
- Visual order: Vazgeç top, İlgili kişiyi ekle bottom

### CSS responsive contract
```css
@media (max-width: 720px) {
  .customer-form .form-actions,
  .record-form .form-actions { flex-direction: column; }
  .inline-record-form .form-actions { flex-direction: column; }
}
```

## Console/Network
- 0 console errors on all verified screens
- 0 unexpected network failures
- Only benign favicon 404 (not application-level)

## PII/Security confirmation
- All screen captures used synthetic admin @ servora.local credentials
- No real customer names, phone numbers, email addresses, or staff data exposed
- No credentials, tokens, or secrets captured
- No production data visible

## Browser test infrastructure
- Playwright + Chromium headless
- Login: admin@servora.local (synthetic seed)
- Viewports: 390x844 (mobile), 1024x768 (desktop)
