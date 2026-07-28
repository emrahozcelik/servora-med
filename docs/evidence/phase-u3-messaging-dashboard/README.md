# Phase U3 Messaging — Visual Evidence

**Capture code SHA:** 2762798c2b4728ed621d785e52562fdff726d224
**Evidence commit SHA:** (see git log for docs/evidence commits)
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
| messages-admin-recipients.png | ADMIN | 1440px | Recipient picker | Only STAFF | PASS |
| messages-thread.png | MANAGER | 1024px | Thread: `test <b>bold</b> 1 < 2` | Escaped text, no HTML render | PASS |
| messages-unicode.png | MANAGER | 1024px | Turkish + emoji | Correct display | PASS |
| messages-composer.png | MANAGER | 1024px | Composer disabled when empty | Send button greyed | PASS |
| messages-200-percent.png | MANAGER | 1024px | `html { font-size: 200% !important; }` | scrollWidth=clientWidth, no overflow | PASS (1009=1009) |
| messages-pagination.png | ADMIN | 1440px | Older-page load complete (after) | Messages #001-#055 visible | PASS |
| messages-pagination-before.png | ADMIN | 1440px | Initial page + "Daha eski" button | #006-#055 + button visible | PASS |
| messages-pagination-after.png | ADMIN | 1440px | After older-page load | #001-#005 visible at top | PASS |
| messages-send-error.png | MANAGER | 1024px | Network error on send | Error message + retry + preserved text | PASS |
| notification-message-before.png | STAFF | 1024px | Notification panel with message items | "Yeni operasyon mesajı", bodyless | PASS |
| notification-message-after.png | STAFF | 1024px | Deep-link result: thread open | /messages?conversation=<id>, correct thread | PASS |
| overview-admin-1440.png | ADMIN | 1440px | Dashboard unread summary + work-type | Bodyless number + chart | PASS |

**Total PNG count:** 17

---

## 200% Text Resize Method

```css
html { font-size: 200% !important; }
```

Injected via Playwright `page.addStyleTag()`. Applied at 1024px viewport.
**Measured:** scrollWidth=1009, clientWidth=1009, horizontal overflow=0.

---

## Verification Results

### Notification Center Deep-Link
- notification-message-before.png: real "Yeni operasyon mesajı" items in panel ✅
- notification-message-after.png: click navigates to `/messages?conversation=<id>`, correct thread opens ✅
- Notification label is generic/bodyless — no message body or preview ✅

### Pagination Scroll Preservation
- Older-page prepend saves scrollHeight before load, restores scrollTop after ✅
- "Daha eski mesajlar" button visible before click ✅
- Messages #001-#005 visible at top after older-page load ✅
- No duplicate messages ✅
- Chronological order preserved ✅
- Own send/new message still scrolls to bottom ✅

### 200% Reflow
- scrollWidth = clientWidth (1009px) — zero horizontal overflow ✅
- Composer accessible, send button visible ✅
- Conversation list items use text-overflow: ellipsis ✅
- Thread header participant name handles overflow ✅
- No content clipping or overlap ✅

### Send Error
- Error message visible: "Sunucuya ulaşılamadı" ✅
- Retry button visible: "Tekrar gönder" ✅
- Draft text preserved in composer ✅

### HTML/XSS
- `dangerouslySetInnerHTML`: NOT USED ✅
- HTML tags render as escaped text: `&lt;b&gt;bold&lt;/b&gt;` ✅

### Console
- Errors: 0 ✅
- Warnings: 0 ✅

### Network
- 500 errors: 0 ✅

### Bodyless Privacy
- Notification content: "Yeni operasyon mesajı" (generic, no body preview) ✅
- Overview unread: only number, no message content ✅

---

## Privacy / Secret Scan
- No passwords, tokens, cookies, or API keys in evidence files ✅
- No connection strings or .env content ✅
- No real person data — all synthetic "Demo" accounts ✅
- Screenshots are viewport captures only ✅
