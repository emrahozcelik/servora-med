# Phase U3 Messaging — Visual Evidence

**Capture code SHA:** 40af974e107c3396cf68fb21cb16c12bc2f69380
**PR:** #76 (Draft)
**Backend:** Real Fastify + PostgreSQL (localhost:3000)
**Frontend:** Real Vite dev server (localhost:5173)
**Database:** servora_med (PostgreSQL 17)
**Visual verifier:** Playwright (OpenCode visual-verifier agent)
**Data:** Synthetic test accounts (admin@servora.local, manager@servora.local, staff@servora.local)

---

## Role / Viewport Matrix

| File | Role | Viewport | Scenario |
|------|------|----------|----------|
| messages-staff-390.png | STAFF | 390px (mobile) | Messages page, empty recipients on "Yeni" |
| messages-staff-1024.png | STAFF | 1024px | Thread view with HTML-escaped text |
| messages-manager-1024.png | MANAGER | 1024px | Messages page with conversation list |
| messages-manager-recipients.png | MANAGER | 1024px | Recipient picker — only Staff visible |
| messages-admin-1440.png | ADMIN | 1440px | Messages page |
| messages-admin-recipients.png | ADMIN | 1440px | Recipient picker — only STAFF (no Admin/Manager) |
| messages-thread.png | MANAGER | 1024px | Thread with HTML-escaped text: `test <b>bold</b> 1 < 2` |
| messages-unicode.png | MANAGER | 1024px | Turkish + emoji: `İş teslimatı tamamlandı ✅` |
| messages-composer.png | MANAGER | 1024px | Composer with disabled send button (empty) |
| messages-200-percent.png | MANAGER | 512px (sim. 200%) | 200% text resize — responsive, no horizontal scroll |
| overview-admin-1440.png | ADMIN | 1440px | Overview: bodyless unread summary + work-type distribution |

---

## Verification Results

### HTML/XSS
- `dangerouslySetInnerHTML`: NOT USED
- HTML tags render as escaped text: `&lt;b&gt;bold&lt;/b&gt;`
- No script injection possible through message content

### Console
- Errors: 0
- Warnings: 0

### Network
- Failed requests: 0
- 500 errors: 0

### Bodyless Privacy
- Notification content: "Yeni operasyon mesajı" (generic, no body preview)
- Overview unread: only number, no message content
- Web Push: PENDING delivery rows created in DB transaction, bodyless payload

### Web Push Delivery (DB verification)
- PENDING `web_push_deliveries` rows created in same transaction as message
- Active subscriptions: 1 notification → N deliveries (one per subscription)
- Disabled/expired subscriptions: no deliveries
- Duplicate send: no duplicate delivery

### Authorization
- Admin recipients: only active STAFF
- Manager recipients: only team STAFF
- Staff recipients: empty (cannot create conversations)
- Staff compose: disabled when no recipients
- Send authorization: 2-participant enforcement, role/team/JOB re-verification

### Pagination
- Messages returned ASC (oldest first)
- Cursor-based pagination with `(created_at, id)` tuple
- No duplicate messages across pages

---

## Privacy / Secret Scan
- No passwords, tokens, cookies, or API keys in evidence files
- No connection strings or .env content
- No real person data — all synthetic test accounts
- Screenshots are viewport captures only (no file system paths visible)
