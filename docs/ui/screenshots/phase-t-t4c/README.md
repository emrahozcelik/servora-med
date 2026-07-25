# Phase T4C — Product, Staff/User Visual Evidence

## Capture source

Branch: `feat/phase-t-t4c-product-people-closeout`

Exact capture (visual code) head: `7fdf70bb7836f4d42f478d8e7b918b0f78c386c0`

## Verification method

All T4C surfaces were verified through live browser sessions (Playwright + Chromium, synthetic fixtures, admin + staff roles). Every PNG was captured from the final visual code head after the ProductSelect min-width overflow fix.

## Committed evidence

| File | Route/State | Viewport | Role | Contract demonstrated |
|---|---|---|---|---|
| `products-list-390.png` | /products | 390 | Admin | Workspace h1 "Ürünler", single primary "Yeni ürün", flat row hierarchy, search |
| `product-create-390.png` | /products/new | 390 | Admin | `create-heading` class, "Yeni ürün" h1, form-actions İptal→Ürün oluştur |
| `product-detail-1024.png` | /products/:id | 1024 | Admin | `detail-heading`, product info section, version metadata, edit action |
| `product-edit-390.png` | /products/:id (edit mode) | 390 | Admin | `detail-heading`, "Ürünü düzenle" h1, form-actions İptal→Değişiklikleri kaydet |
| `product-select-390.png` | /jobs/new-delivery | 390 | Admin | `product-select` grid, search controls, selected product state, min-width:0 overflow prevention |
| `staff-list-390.png` | /staff | 390 | Admin | "Personel" h1, flat people list, name/title/manager row hierarchy |
| `staff-profile-390.png` | /staff/:id | 390 | Admin | Staff h1, Operasyon raporunu aç heading action, form-actions Listeye dön→Profili kaydet |
| `staff-profile-1024.png` | /staff/:id | 1024 | Admin | Desktop form layout, content-width actions, Listeye dön→Profili kaydet order |
| `own-profile-390.png` | /staff (own) | 390 | Staff | 5 counters (Açık işler, Onay bekliyor, Düzeltme istendi, Bu ay tamamlandı, Geciken), "Profilim" label, no edit |
| `users-list-390.png` | /users | 390 | Admin | "Kullanıcılar" h1, "Kullanıcı oluştur" primary action, name/email/role rows |
| `user-create-390.png` | /users/new | 390 | Admin | `create-heading` class, "Kullanıcı oluştur" h1, form-actions Vazgeç→Kullanıcıyı oluştur, Vazgeç NOT in heading |
| `user-detail-1024.png` | /users/:id | 1024 | Admin | User h1, Temel bilgiler section, Rol ve erişim section, Geçici parola section |

## Per-screenshot verification

| File | Overflow | Console | Network | PII-free |
|---|---|---|---|---|
| products-list-390.png | none (375=375) | 0 errors | 0 failures | ✓ synthetic |
| product-create-390.png | none (390=390) | 0 errors | 0 failures | ✓ synthetic |
| product-detail-1024.png | none (1024=1024) | 0 errors | 0 failures | ✓ synthetic |
| product-edit-390.png | none (375=375) | 0 errors | 0 failures | ✓ synthetic |
| product-select-390.png | none (375=375) | 0 errors | 0 failures | ✓ synthetic |
| staff-list-390.png | none | 0 errors | 0 failures | ✓ synthetic |
| staff-profile-390.png | none | 0 errors | 0 failures | ✓ synthetic |
| staff-profile-1024.png | none | 0 errors | 0 failures | ✓ synthetic |
| own-profile-390.png | none | 0 errors | 0 failures | ✓ synthetic |
| users-list-390.png | none | 0 errors | 0 failures | ✓ synthetic |
| user-create-390.png | none | 0 errors | 0 failures | ✓ synthetic |
| user-detail-1024.png | none (1009≤1024) | 0 errors | 0 failures | ✓ synthetic |

## Key CSS contracts verified

### ProductSelect overflow fix (on this final head)
Root cause: CSS Grid `min-width: auto` prevented `.product-select-list`, `.product-select-list li`, `.product-select-list button`, and `.product-select-current` from shrinking below content width with 97-character product names.

Fix: Added `min-width: 0` to `.product-select`, `.product-select-list`, `.product-select-list li`, `.product-select-list button`, `.product-select-current`. Added `overflow-wrap: anywhere` to `.product-select-current strong` and `span`/`small`.

Verified: `scrollWidth == clientWidth == 375px` vs viewport 390px.

### T4 form contract
- Product create: `create-heading` ✓, form-actions İptal→Ürün oluştur ✓
- Product edit: `detail-heading` ✓, form-actions İptal→Değişiklikleri kaydet ✓
- User create: `create-heading` ✓, Vazgeç single occurrence ✓
- Staff managed: form-actions Listeye dön→Profili kaydet ✓

## PII/secret confirmation

All verification used clearly synthetic data. No real names, emails, phone numbers, product IDs, passwords, tokens, or credentials appear in any capture. Password inputs are empty in all screenshots.
