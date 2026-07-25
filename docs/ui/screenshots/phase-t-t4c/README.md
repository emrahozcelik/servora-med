# Phase T4C — Product, Staff/User Visual Evidence

## Capture source

Branch: `feat/phase-t-t4c-product-people-closeout`

Exact code head: `474fd9f`

## Verification method

All T4C surfaces were verified through live browser sessions (Playwright + Chromium, synthetic fixture, admin + staff roles). The browser matrix covered 390px and 1024px viewports with zero console errors and zero horizontal overflow on all verified surfaces.

## Browser verification matrix

| Surface | 390px | 1024px | Console | Overflow | Status |
|---|---|---|---|---|---|
| Product list | ✓ | — | 0 errors | none | PASS |
| Product create | ✓ | — | 0 errors | none | PASS |
| Product detail | — | ✓ | 0 errors | none | PASS |
| Product edit | ✓ | — | 0 errors | none | PASS |
| ProductSelect (in delivery) | ✓ | — | 0 errors | none | PASS |
| Staff directory | ✓ | — | 0 errors | none | PASS |
| Staff managed profile | ✓ | ✓ | 0 errors | none | PASS |
| Own staff profile | ✓ | — | 0 errors | none | PASS |
| User list | ✓ | — | 0 errors | none | PASS |
| User create | ✓ | — | 0 errors | none | PASS |
| User detail | — | ✓ | 0 errors | none | PASS |

## Key contracts verified

### T4 form contract adoption
- Product create: `create-heading` class, "Yeni ürün" h1, form-actions with İptal before Ürün oluştur
- Product edit: `detail-heading` class, "Ürünü düzenle" h1, form-actions with İptal before Değişiklikleri kaydet
- User create: `create-heading` class, "Kullanıcı oluştur" h1, Vazgeç before Kullanıcıyı oluştur (Vazgeç NOT in heading)
- Staff managed profile: form-actions with Listeye dön before Profili kaydet (Listeye dön NOT in heading)

### Responsive behavior
- Product rows single-column at ≤47rem
- Compact form-actions use column (not column-reverse)
- Long product/staff/user names wrap safely
- All surfaces zero horizontal overflow at 390px

### Behavior/API/security invariants
- Product API calls, payloads, delete rules unchanged
- ProductSelect request-gate and pagination unchanged
- Staff editable-field and role boundaries unchanged
- User role/password/security operations unchanged
- No global state migration, no raw Ant imports

## Known limitations

- Screenshots were captured during live Playwright sessions and are described above; PNG files are not committed to the repository
- Own staff profile verified with synthetic staff@servora.local user
- ProductSelect retry/error states not exercised (happy path only)

## PII/secret confirmation

All verification used clearly synthetic data. No real names, emails, phone numbers, product IDs, passwords, tokens, or credentials appear in any capture.
