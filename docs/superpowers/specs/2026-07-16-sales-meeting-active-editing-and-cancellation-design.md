# Sales Meeting Active Editing, Cancellation, and Default Time Design

Date: 2026-07-16
Status: Product-approved design
Scope: Sales Meeting editing and cancellation before terminal completion, plus meeting-result
time and validation usability

## 1. Objective

An assigned Staff user must be able to correct or cancel a Sales Meeting throughout its
active lifecycle. Manager and Admin users must retain operational control over every active
Sales Meeting they can access. Completed and cancelled records remain immutable so approval
history and audit evidence cannot be rewritten.

This design also removes two result-form usability failures: a new result form starts with the
current local date and time, and an unchanged save no longer surfaces the implementation-level
message `body geçersizdir.`

## 2. Considered Approaches

### A. In-place active editing with controlled approval withdrawal — selected

The detail screen exposes one `Görüşmeyi düzenle` action in directly editable states. In
`WAITING_APPROVAL`, the existing withdrawal command first returns the card to `IN_PROGRESS`
and then opens the same editor. This reuses the existing version, locking, activity, and
idempotency model while keeping the review snapshot stable.

### B. A separate edit page

This provides more layout room but duplicates detail loading, conflict handling, references,
and lifecycle capability logic. It adds routing complexity without improving the current
workflow.

### C. Edit the review snapshot in place

This would be visually simple but would allow the content under review to change silently.
It conflicts with manager approval, concurrency safety, and auditability, so it is rejected.

## 3. Authorization and Lifecycle Matrix

| Status | Assigned Staff edit | Manager/Admin edit | Assigned Staff cancel | Manager/Admin cancel |
| --- | --- | --- | --- | --- |
| `NEW` | Direct | Direct | Yes | Yes |
| `PLANNED` | Direct | Direct | Yes | Yes |
| `IN_PROGRESS` | Direct | Direct | Yes | Yes |
| `WAITING_APPROVAL` | Withdraw, then edit | Withdraw, then edit | Yes | Yes |
| `REVISION_REQUESTED` | Direct | Direct | Yes | Yes |
| `COMPLETED` | No | No | No | No |
| `CANCELLED` | No | No | No | No |

Staff access remains limited to the assigned Staff user. Manager/Admin access remains
organization-scoped. Cancellation always requires a non-empty reason and produces the
existing `JOB_CANCELLED` activity. Cancellation does not reopen or delete a card.

`WITHDRAW_FROM_APPROVAL` is expanded from assigned-Staff-only to the assigned Staff user and
authorized Manager/Admin users. It keeps the same named route, version check, row lock,
idempotency operation scope, `WAITING_APPROVAL -> IN_PROGRESS` transition, and
`JOB_APPROVAL_WITHDRAWN` activity. The actor in the activity identifies who withdrew it.

## 4. Editing Model

The Sales Meeting detail screen receives an explicit edit mode. The editor covers the existing
JobCard fields relevant to a meeting:

- title
- description
- planned meeting day (`dueDate`), required
- customer, required
- contact, optional and constrained to the selected customer
- priority
- assignee, editable only by Manager/Admin; Staff remains assigned to self

The existing `PATCH /api/job-cards/:id` contract remains the single write path. No generic
status endpoint or parallel edit model is added. The request uses `expectedVersion`; a conflict
reloads canonical truth and preserves a clear retry path. Existing `JOB_FIELDS_UPDATED` and
`JOB_ASSIGNED` activities remain the audit source.

The edit action is separate from the Sales Meeting result form. `NEW` and `PLANNED` continue
to hide and reject meeting-result and Sales Meeting note writes. `IN_PROGRESS` and
`REVISION_REQUESTED` allow result editing. This preserves the previously approved rule that
a planned meeting cannot contain a result before it starts.

## 5. User Interface Behavior

- `NEW`, `PLANNED`, `IN_PROGRESS`, `REVISION_REQUESTED`: show
  `Görüşmeyi düzenle` and `İşi iptal et` for an authorized viewer.
- `WAITING_APPROVAL`: show `Onaydan geri çek ve düzenle` and `İşi iptal et` for assigned Staff;
  Manager/Admin retain approve/revision actions and also receive controlled edit and cancel
  actions.
- Selecting direct edit replaces the read-only meeting facts with a form. `Vazgeç` discards
  local edits. A successful save returns to read-only detail with canonical server data.
- Selecting edit while waiting invokes withdrawal first. Only after the canonical response is
  `IN_PROGRESS` does the editor open.
- `COMPLETED` and `CANCELLED` show no editing or cancellation actions.
- Cancellation continues to use the reason dialog and its terminal-action warning.

Reference lists use the existing customer/contact/staff services. Changing customer clears an
incompatible contact. Staff never receives an assignee control. Loading, validation, conflict,
success, keyboard focus, and mobile behavior follow the existing product edit/form patterns.

## 6. Meeting Result Time and Validation

When an editable result form opens and persisted `meetingAt` is null, `Gerçekleşme zamanı` is
pre-filled once with the device's current local date and minute. The value is editable. A
persisted value always wins, and rerenders do not keep advancing or overwrite the user's input.
The API continues to receive an ISO instant with an explicit timezone representation.

The client detects a completely unchanged result submission and does not issue a request. It
shows `Görüşme sonucunda kaydedilecek bir değişiklik yok.` The backend also replaces its
generic no-change `body` validation with the exact safe error:

- HTTP `400`
- code `MEETING_DETAILS_UNCHANGED`
- message `Görüşme sonucunda kaydedilecek bir değişiklik yok.`

Field validation remains associated with `meetingAt`, `outcome`, `meetingSummary`, or
`nextFollowUpAt`. Unknown request fields may still use request-body validation because that is
a malformed contract rather than a user correction case.

## 7. Backend Changes

- Expand the Staff cancellation source matrix to all active statuses while preserving assigned
  ownership.
- Permit authorized Manager/Admin approval withdrawal for controlled editing.
- Keep terminal guards and organization boundaries unchanged.
- Reuse `PATCH /:id`, but expose and validate the full existing meeting-relevant patch contract
  in the frontend API type.
- Return `MEETING_DETAILS_UNCHANGED` for a valid but no-op result patch.
- Do not add a migration; existing lifecycle and field-update events already represent every
  new mutation.

## 8. Testing and Acceptance

TDD coverage must include:

- policy matrix for Staff and Manager/Admin edit, withdrawal, and cancellation in every status
- terminal-state rejection and cross-assignee/cross-organization denial
- Manager/Admin withdrawal idempotency, version conflict, transition, and audit actor
- full Sales Meeting patch field contract and field activities
- UI capability matrix and action visibility in every status
- direct edit save/cancel, Staff-hidden assignee, Manager/Admin assignment, reference changes,
  and stale-version reload
- waiting edit sequencing: withdrawal succeeds before edit form opens
- default local meeting time, persisted-time precedence, stable rerenders, and user override
- unchanged result detection on client and exact backend error fallback
- regression coverage for hidden `NEW`/`PLANNED` result/notes and immutable terminal records
- PostgreSQL concurrency for edit/withdraw/cancel versus approval where relevant

After automated tests, acceptance uses the active Sezer Dener Staff account and its assigned
Sales Meetings. Testing must not change the password. Any temporary session created directly
through the existing auth contract must be deleted, and test records must either use a clearly
identified disposable card or restore/clean their state without rewriting audit history.

## 9. Out of Scope

- Editing or reopening `COMPLETED` or `CANCELLED` cards
- Deleting audit history
- Silent mutation while a card remains `WAITING_APPROVAL`
- Changing Product Delivery item or General Task-specific editors in this slice
- New notification, WebSocket, or generic workflow infrastructure
