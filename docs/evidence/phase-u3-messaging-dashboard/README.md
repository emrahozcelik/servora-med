# Phase U3 Messaging — Visual Evidence

**Capture code SHA:** c830ecf9a20632f95b26889c7c6e131c11f41684
**Evidence commit SHA:** b34aa7ae3bb3421c653a2ce04deb76fd924a00a5
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

**Layout model:** ResizeObserver detects when sidebar + thread don't fit side-by-side and adds
`.messaging-stacked` class, switching to drill-down (mobile) layout: sidebar full-width, thread as
fixed overlay when a conversation is selected.

**Measured:** document scrollWidth=1009, clientWidth=1009, horizontal overflow=0.
"Mesajlar" heading fully visible (DOM text: "Mesajlar", 8 chars). "Yeni" button fully visible.
No content hidden or clipped. All essential controls accessible.

---

## Verification Results

### Notification Center Deep-Link
- notification-message-before.png: real "Yeni operasyon mesajı" items in panel ✅
- notification-message-after.png: click navigates to `/messages?conversation=<id>`, correct thread opens ✅
- Notification label is generic/bodyless — no message body or preview ✅

### Pagination Scroll Preservation
- `scrollModeRef`: 'bottom' | 'preserve' | 'none' state machine
- `useLayoutEffect` restores scroll synchronously before paint
- Older-page prepend saves prevScrollHeight + prevScrollTop before load
- Restores via `scrollTop = prevTop + (newHeight - prevHeight)`
- Anchor message #049: 2px before, 2px after — 0px drift
- scrollIntoView NOT called during older-page prepend
- No bottom-jump on prepend
- No duplicate messages
- Chronological order preserved
- Own send/new message scrolls to bottom (scrollModeRef='bottom')

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
