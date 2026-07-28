# Phase U3 Messaging — Visual Evidence

**Capture code SHA:** a58cda912526229405bfbb0f23f648d5d55d2198
**Evidence commit SHA:** (docs commit after capture, see git log)
**Backend:** Real Fastify + PostgreSQL (localhost:3000)
**Frontend:** Real Vite dev server (localhost:5173)
**Database:** servora_med (PostgreSQL 17)
**Visual verifier:** Playwright (OpenCode visual-verifier agent), verdict: PASS
**Data:** Synthetic test accounts (admin@servora.local, manager@servora.local, staff@servora.local)

---

## Role / Viewport / Scenario Matrix

| File | Role | Viewport | Scenario | Expected | Actual |
|------|------|----------|----------|----------|--------|
| messages-staff-390.png | STAFF | 390px | Messages page, empty recipients | "Alıcı bulunamadı" | PASS |
| messages-staff-1024.png | STAFF | 1024px | Thread with HTML-escaped text | `&lt;b&gt;` rendering | PASS |
| messages-manager-1024.png | MANAGER | 1024px | Messages with conversation list | Sidebar + thread | PASS |
| messages-manager-recipients.png | MANAGER | 1024px | Recipient picker | Only Staff visible | PASS |
| messages-admin-1440.png | ADMIN | 1440px | Messages page | Full desktop layout | PASS |
| messages-admin-recipients.png | ADMIN | 1440px | Recipient picker | Only STAFF (no Admin/Manager) | PASS |
| messages-thread.png | MANAGER | 1024px | Thread: `test <b>bold</b> 1 < 2` | Escaped text, no HTML render | PASS |
| messages-unicode.png | MANAGER | 1024px | Turkish + emoji: `İş teslimatı tamamlandı ✅` | Correct display | PASS |
| messages-composer.png | MANAGER | 1024px | Composer disabled when empty | Send button greyed | PASS |
| messages-200-percent.png | MANAGER | 1024px | `html { font-size: 200% !important; }` | Readable, no critical overflow | PASS (minor 53px sidebar overflow) |
| messages-pagination.png | ADMIN | 1440px | Older-page load complete (after) | Messages #001-#055 visible | PASS |
| messages-pagination-before.png | ADMIN | 1440px | Initial page (before older load) | Messages #006-#055 only | PASS |
| messages-pagination-after.png | ADMIN | 1440px | After clicking "Daha eski mesajlar" | Messages #001-#055 all visible | PASS |
| messages-send-error.png | MANAGER | 1024px | Network error on send | Error message + retry + preserved text | PASS |
| notification-message-deep-link.png | STAFF | 1024px | Notification panel with real "Yeni operasyon mesajı" items | Generic bodyless label, click navigates to /messages | PASS |
| overview-admin-1440.png | ADMIN | 1440px | Dashboard with unread summary + work-type distribution | Bodyless number + chart | PASS |

**Total PNG count:** 16

---

## 200% Text Resize Method

```css
html { font-size: 200% !important; }
```

Injected via Playwright `page.addStyleTag()`. Applied at 1024px viewport.
Result: Conversation list readable, composer accessible, touch targets usable.
Minor horizontal overflow (53px) from sidebar width — does not affect core messaging interaction.

---

## Verification Results

### Notification Center Deep-Link
- Real `message.received` notification visible in panel: "Yeni operasyon mesajı" ✅
- Notification label is generic/bodyless — no message body or preview ✅
- Click navigates to `/messages?conversation=<id>` — correct thread opens ✅
- Notification count badge shows accurate unread count ✅

### Pagination
- 55 test messages seeded (Pagination test message #001–#055) ✅
- Initial page: 50 newest messages (ASC order) ✅
- "Daha eski mesajlar" button visible ✅
- Click loads older messages (#001–#005 prepended) ✅
- No duplicate messages ✅
- Chronological order preserved ✅
- Network: cursor-based second request returns 200 ✅

### Send Error
- API server stopped → send fails with network error ✅
- Error message visible: "Sunucuya ulaşılamadı" ✅
- Retry button visible: "Tekrar gönder" ✅
- Draft text preserved in composer (not cleared) ✅

### HTML/XSS
- `dangerouslySetInnerHTML`: NOT USED ✅
- HTML tags render as escaped text: `&lt;b&gt;bold&lt;/b&gt;` ✅
- No script injection possible through message content ✅

### Console
- Errors: 0 ✅
- Warnings: 0 ✅

### Network
- Failed requests: 0 (except intentional send-error test) ✅
- 500 errors: 0 ✅

### Bodyless Privacy
- Notification content: "Yeni operasyon mesajı" (generic, no body preview) ✅
- Overview unread: only number, no message content ✅
- Web Push: PENDING delivery rows in DB, bodyless payload ✅

### Web Push Delivery (DB verification)
- PENDING `web_push_deliveries` rows created in same transaction as message ✅
- Active subscriptions: 1 notification → N deliveries (one per subscription) ✅
- Disabled/expired subscriptions: no deliveries ✅
- Duplicate send: no duplicate delivery ✅

### Authorization
- Admin recipients: only active STAFF ✅
- Manager recipients: only team STAFF ✅
- Staff recipients: empty (cannot create conversations) ✅
- Send authorization: 2-participant enforcement, role/team/JOB re-verification ✅

---

## Privacy / Secret Scan
- No passwords, tokens, cookies, or API keys in evidence files ✅
- No connection strings or .env content ✅
- No real person data — all synthetic "Demo" accounts ✅
- Screenshots are viewport captures only ✅
