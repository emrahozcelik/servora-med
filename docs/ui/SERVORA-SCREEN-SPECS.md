# Servora Screen Specifications

Status: Proposed, awaiting visual approval
Prototype data: Fictional Turkish medical and dental B2B records

## Shared composition

All screens use the Clear Field Ledger direction from DESIGN.md:

- light-first tinted surfaces
- one restrained mineral-blue accent
- semantic color only for operational meaning
- flat hierarchy, thin rules, modest radius
- readable typography and tabular operational data
- no nested cards, side stripes, glass, gradients, or decorative metrics
- 44 by 44 CSS pixel minimum interactive targets
- visible focus and complete keyboard order
- 200 percent text zoom and 400 percent reflow without task-level horizontal scrolling

## 1. App shell and Jobs

### Desktop, 1440 by 1000

Structure:

1. Quiet Canvas
2. Persistent role-aware sidebar
3. Daylight Paper workspace
4. Page heading and one Yeni iş primary action
5. Quick views
6. Filters
7. Five horizontal workflow lanes

Sidebar groups:

- Operasyon: İşler, Müşteriler, Ürünler
- Ekip: Personel, Kullanıcılar
- Analiz: Raporlar
- Sistem: Ayarlar

The production navigation model remains the source of destinations. The prototype demonstrates hierarchy only and does not authorize hardcoded production groups.

Lane header content:

- visible status label
- count
- Tümünü gör link
- optional ordering explanation when role-sensitive

Card content priority:

1. title
2. job type
3. customer
4. responsible staff
5. schedule
6. type-specific summary
7. workflow position
8. lateness or attention signal

The lane uses a responsive card grid. It never introduces page-level horizontal scrolling.

### Mobile, 390 by 844

Structure:

- one sticky top bar
- role-specific ordering note
- quick filters
- vertical workflow sections
- one-column cards
- one primary create action
- existing bottom navigation model

The prototype shows Staff ordering:

1. Düzeltme istendi
2. Uygulanıyor
3. Atandı
4. Hazırlanıyor
5. Yönetici kontrolünde

Alternative to validate with users: keep the same domain order as desktop. The recommended role-priority order is better for field recovery because revision work and current execution need immediate attention. The alternative is more predictable but makes urgent staff actions harder to scan.

For Manager/Admin, prototype follow-up should compare a control queue first ordering against domain order. The recommendation is control queue first.

## 2. Staff IN_PROGRESS detail

Primary user question: What must I complete before this job can be sent to control?

Order:

1. title, customer, status, and schedule
2. lifecycle steps with Uygulanıyor current
3. Şimdi sizden beklenen responsibility panel
4. structured delivery facts
5. requirements checklist
6. one primary Kontrole gönder action
7. activity timeline

The primary action must explain the consequence: records become read-only while manager review is active. Missing or invalid requirements stay beside the action and are not hidden in a toast.

Example delivery:

- DentArt Ağız ve Diş Sağlığı
- assigned staff: Mehmet Yılmaz
- Xenofill Implant Set, 4 kutu
- ProSeal Membran, 2 kutu
- planned time: 18 July 2026, 15:00

Responsive behavior:

- lifecycle becomes vertical on narrow screens
- structured facts become one column
- action region stacks with the primary action reachable without horizontal scrolling
- timeline actor and time reflow without clipping

## 3. Manager WAITING_APPROVAL detail

Primary user question: Is the submitted business record complete and safe to close?

Order:

1. title, customer, status, and submitted time
2. lifecycle with Yönetici kontrolü current
3. responsibility panel naming the manager as next actor
4. submission facts and requirements
5. delivered products and quantities
6. decision region
7. timeline

Actions:

- primary: Kontrolü tamamla ve işi kapat
- secondary: Düzeltme için personele geri gönder

Approval requires a consequence confirmation. Revision requires a reason and therefore must not use Popconfirm. The reason field belongs in an accessible dialog or dedicated panel with a visible label, error association, pending lock, and focus restoration.

No UI-only rule may enable approval. The backend remains authoritative.

## 4. Staff REVISION_REQUESTED detail

Primary user question: Why was this returned, and what must I fix?

Order:

1. prominent Düzeltme gerekiyor panel directly below the heading
2. exact manager reason, actor, and time
3. lifecycle with a visible correction loop
4. responsibility panel
5. preserved structured records
6. requirements showing what remains valid and what is invalid
7. correction action
8. timeline

Revision reason must not be discoverable only by reading the timeline. Existing data remains visible and preserved.

Current production behavior separates Düzeltmeye başla from later resubmission. The prototype shows this separation and does not invent a direct completion path.

## Lifecycle presentation contract

Expected phases:

1. Oluşturuldu
2. Planlandı
3. Uygulanıyor
4. Yönetici kontrolü
5. Tamamlandı

Domain status must not be passed directly as an Ant Steps index. A Servora presentation model maps facts to:

- complete
- current
- upcoming
- skipped
- correction loop
- cancelled terminal

Every state has visible text or icon semantics in addition to color. Current uses aria-current="step" in production semantics. Cancelled is never styled as successful completion.

## Feedback and state coverage

Later implementation must define:

- loading with geometry-matched Skeleton
- empty with next-step guidance
- forbidden with Result and safe navigation
- retryable failure with inline explanation and retry
- stale-version conflict with refreshed server truth
- pending actions with disabled duplicate submission
- success message only after persisted completion

Toast is limited to short completed operations. Critical errors, required decisions, revision reasons, and lifecycle consequences remain in the page or dialog.

## Prototype map

| File | Target | State |
| --- | --- | --- |
| prototypes/app-shell-jobs-desktop.html | 1440 by 1000 | Manager desktop workflow overview |
| prototypes/app-shell-jobs-mobile.html | 390 by 844 | Staff mobile role-priority workflow |
| prototypes/job-detail-in-progress.html | 1440 and 390 responsive | Staff IN_PROGRESS |
| prototypes/job-detail-waiting-approval.html | 1440 and 390 responsive | Manager WAITING_APPROVAL |
| prototypes/job-detail-revision-requested.html | 1440 and 390 responsive | Staff REVISION_REQUESTED |

The HTML is documentation-only, makes no backend request, and is excluded from the production bundle.
