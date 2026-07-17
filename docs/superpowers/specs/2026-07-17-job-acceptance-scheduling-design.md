# Job Acceptance and Scheduling Design

Date: 2026-07-17  
Status: Product-approved design  
Baseline: `main` at `c246022d2376272930b8cd3b77d0864985745798`  
Scope: Job acceptance, scheduling facts, Product Delivery planned/actual time separation, assignment-stage communication, list-card interaction, and submission-readiness refresh

## 1. Objective

Servora-Med currently treats `PLANNED` as a lifecycle state even though it does not establish a meaningful ownership fact. The same work can also be started directly from `NEW`, and `PLAN` may be executed by Staff, Manager, or Admin. Therefore `PLANNED` cannot prove that the assigned Staff member reviewed and accepted the assignment.

This design replaces that ambiguous state with explicit Staff acceptance and moves planning into canonical scheduling data.

The resulting model distinguishes four facts:

1. **Assignment:** management assigns the work to a Staff member.
2. **Acceptance:** the assigned Staff member accepts responsibility.
3. **Scheduling:** the work has an optional or required planned instant.
4. **Execution:** actual work starts and actual outcome/delivery facts are recorded.

## 2. Approved Lifecycle

### 2.1 Canonical active flow

```text
NEW --ACCEPT_ASSIGNMENT-------------> ACCEPTED
ACCEPTED --START--------------------> IN_PROGRESS
IN_PROGRESS --SUBMIT_FOR_APPROVAL---> WAITING_APPROVAL
WAITING_APPROVAL --APPROVE----------> COMPLETED
WAITING_APPROVAL --REQUEST_REVISION-> REVISION_REQUESTED
WAITING_APPROVAL --WITHDRAW_FROM_APPROVAL-> IN_PROGRESS
REVISION_REQUESTED --RESUME---------> IN_PROGRESS
active state --CANCEL---------------> CANCELLED
```

User-facing labels:

| Canonical status | Turkish label | Meaning |
| --- | --- | --- |
| `NEW` | Atandı | Work exists and is waiting for the assigned Staff member |
| `ACCEPTED` | Kabul edildi | Assigned Staff accepted responsibility |
| `IN_PROGRESS` | Uygulanıyor | Actual work is underway |
| `WAITING_APPROVAL` | Yönetici kontrolünde | Staff submitted complete records |
| `REVISION_REQUESTED` | Düzeltme istendi | Management returned the work with a reason |
| `COMPLETED` | Tamamlandı | Management approved the work |
| `CANCELLED` | İptal edildi | Work ended without completion |

`PLANNED` is removed from the active state machine. “Planlandı” may appear only as a scheduling description or badge, never as a lifecycle status.

### 2.2 Acceptance authority

Only the currently assigned Staff member may execute `ACCEPT_ASSIGNMENT`.

Manager and Admin may assign or reassign work but may not accept on behalf of Staff.

A Staff-created job that is self-assigned is created directly as `ACCEPTED`, because creation is an unambiguous expression of acceptance. Manager/Admin-created jobs begin as `NEW`.

### 2.3 Start authority

`START` is allowed only from `ACCEPTED`. Direct `NEW -> IN_PROGRESS` is removed.

Historical jobs already in `IN_PROGRESS` or later remain valid even if they have no acceptance fact.

### 2.4 Reassignment boundaries

Management may change `assignedTo` only while status is `NEW` or `ACCEPTED`.

- Reassigning a `NEW` job keeps it `NEW`.
- Reassigning an `ACCEPTED` job returns it to `NEW` and clears `acceptedAt` / `acceptedBy`.
- Reassignment after actual work starts is rejected with `JOB_NOT_EDITABLE`.

This prevents a new assignee from inheriting another person’s acceptance or partially completed work.

## 3. Migration and Historical Truth

Migration `009_job_acceptance_and_scheduling.sql` introduces:

- `ACCEPTED` in the JobCard status constraint;
- `accepted_at TIMESTAMPTZ NULL`;
- `accepted_by UUID NULL` with organization-scoped user foreign key;
- `scheduled_at TIMESTAMPTZ NULL`;
- `JOB_ACCEPTED` in the activity event constraint.

Existing `PLANNED` rows are migrated to `NEW`, not `ACCEPTED`, because historical `PLAN` could be executed by management and does not prove Staff acceptance.

The existing `planned_at` column and historical `JOB_PLANNED` events are retained as legacy history. New application code does not write or present `plannedAt`.

Existing `IN_PROGRESS`, `WAITING_APPROVAL`, `REVISION_REQUESTED`, `COMPLETED`, and `CANCELLED` rows are not moved backward. Their acceptance fact may be absent and must be displayed as historical information not recorded, never fabricated.

## 4. Canonical Scheduling

### 4.1 `scheduledAt`

`scheduledAt` is the planned instant for the work:

- Product Delivery: planned delivery time;
- Sales Meeting: planned meeting time;
- General Task: optional planned execution time.

It is a UTC instant in the API and database. Inputs use an explicit offset or `Z`; web forms convert from the device-local `datetime-local` value.

### 4.2 Requiredness

| Job type | Create contract |
| --- | --- |
| `PRODUCT_DELIVERY` | required by the web flow; backend accepts a non-null canonical instant |
| `SALES_MEETING` | required |
| `GENERAL_TASK` | optional; the web form pre-fills it but the user may clear it |

Existing `dueDate` remains an optional deadline/calendar-date concept for General Task and Product Delivery. It is no longer the planned Sales Meeting time. New Sales Meetings use `scheduledAt`.

### 4.3 Editing

The assigned Staff member and management may edit `scheduledAt` while status is `NEW` or `ACCEPTED`.

- A schedule change made by the assigned Staff member does not invalidate their acceptance.
- A schedule change made by management after acceptance returns the job to `NEW` and clears acceptance, because Staff accepted a different schedule.
- `scheduledAt` is immutable after `START`.

### 4.4 Presentation

Scheduling information is displayed independently from status:

- Sales Meeting always shows “Planlanan görüşme”.
- A future-day Product Delivery or General Task may show a “Planlandı” scheduling badge.
- Same-day jobs show “Bugün HH:mm” or a type-specific time label, not a `PLANNED` status.
- No scheduling badge is shown when `scheduledAt` is null.

## 5. Default Planned Time

Create forms use one shared pure helper:

```ts
export function defaultScheduledLocalValue(now: Date): string
```

Algorithm:

1. add 60 minutes to `now`;
2. round upward to the next 30-minute boundary;
3. return a device-local `YYYY-MM-DDTHH:mm` value.

Examples:

```text
13:04 -> 14:30
13:24 -> 14:30
13:48 -> 15:00
```

The default is set only during initial form state creation. Renders, reference-data refreshes, validation errors, and retries must not overwrite a user-edited value.

## 6. Product Delivery Planned vs Actual Time

`scheduledAt` is the planned delivery instant on the JobCard.

`deliveryItems[].deliveredAt` remains the actual delivery instant and must never be populated from the planned default.

To support assignment before execution:

- delivery item `deliveredAt` becomes nullable before submission;
- manager or Staff may create planned item lines without an actual time;
- assigned Staff records the actual delivery time during `IN_PROGRESS`;
- submission readiness continues to require every item to have a valid actual `deliveredAt`.

The UI labels are explicit:

```text
Planlanan teslim zamanı
Gerçekleşen teslim zamanı
```

No screen may label `scheduledAt` as an actual delivery.

## 7. Assignment-Stage Communication

For assigned Staff, `VIEW_NOTES` and `ADD_NOTE` are allowed in `NEW` and `ACCEPTED`.

This permits messages such as:

- “Bu saatte başka görevim var.”
- “Müşteriyle tarih teyidi gerekiyor.”
- “Başka personele yönlendirilmesini rica ediyorum.”

Structured reassignment requests are a follow-up capability after the acceptance/scheduling core is stable. This implementation does not introduce a new lifecycle status for reassignment.

## 8. List and Board Interaction

The `Özeti aç / Özeti kapat` disclosure is removed.

Each list card presents its useful summary facts directly. The title remains a semantic `<Link>` and receives a stretched-card hit area. Command buttons remain separate interactive controls above the stretched link, so clicking a command does not navigate.

Card click or title activation opens the Job detail. The separate “Tüm iş detaylarını aç” link is removed.

The always-visible card summary contains:

- status;
- priority;
- type;
- title;
- Customer and optional Contact;
- assignee;
- scheduled time or deadline fallback;
- type-specific concise fact, such as delivery item count.

## 9. Submission Readiness Refresh

The backend remains the sole owner of readiness evaluation.

After a Sales Meeting result save succeeds, the frontend reloads canonical Job detail before presenting success. This refresh updates:

- `workflowContext.submissionReadiness`;
- JobCard version;
- MeetingDetails version parity;
- allowed actions/commands.

React must not calculate meeting readiness from local form fields.

## 10. Compatibility and Scope Limits

This work does not add:

- calendar integration;
- notifications;
- recurring jobs;
- route optimization;
- automatic staff availability checks;
- automatic reassignment;
- a generic scheduler;
- a new financial or inventory side effect.

Historical `JOB_PLANNED` events remain readable. New code writes `JOB_ACCEPTED`.

## 11. Acceptance Criteria

1. A Manager-created assigned job begins as “Atandı”.
2. Only the assigned Staff member can accept it.
3. Work cannot start before acceptance.
4. A Staff-created self-assigned job begins accepted.
5. `PLANNED` is absent from active filters, board columns, status labels, and commands.
6. Existing `PLANNED` data migrates to `NEW`, not accepted.
7. Planned time is separate from actual meeting/delivery time.
8. Product Delivery create defaults `scheduledAt` but does not fabricate `deliveredAt`.
9. Assigned Staff can edit schedule and add notes before starting.
10. Management schedule/reassignment changes invalidate prior acceptance.
11. Clicking a card opens detail without an expand-summary step.
12. Saving meeting results refreshes the readiness checklist before submission.
13. Server/web builds, ordinary tests, PostgreSQL tests, responsive smoke, accessibility contracts, and audits pass.
