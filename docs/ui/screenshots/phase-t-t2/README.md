# Phase T — T2 visual evidence

Synthetic, PII-free fixtures. No production user data.

| File | Viewport | Fixture | Role | Proves | Non-work preserved |
| --- | --- | --- | --- | --- | --- |
| desktop-shell-1024.png | 1024×768 | shell fixture | STAFF | T2A desktop hierarchy | nav model, routes |
| desktop-shell-1440.png | 1440×900 | shell fixture | STAFF | T2A wide desktop frame | board gates untouched |
| mobile-shell-390.png | 390×844 | shell fixture | STAFF | T2B top/bottom chrome | sticky jobs-only semantics |
| mobile-drawer-390.png | 390×844 | drawer open fixture | STAFF | T2B drawer visual hierarchy | focus trap behavior (still image) |
| notification-center-desktop-1024.png | 1024×768 | notification fixture | STAFF | T2C raised panel + rows | API/SSE/Web Push behavior |
| notification-center-mobile-390.png | 390×844 | notification fixture | STAFF | T2C mobile panel safe-area | outside-click/escape contracts |

## Synthetic content

- User: Ayşe Personel
- Notifications: fictitious job titles/bodies/ids
- Badge count: fixture (2 / 123)
- No real phone, email, clinic PII, or secrets

## Capture

Playwright + local synthetic HTML fixtures using production `styles.css` and `responsive-notification-center-fixture.tsx`.
