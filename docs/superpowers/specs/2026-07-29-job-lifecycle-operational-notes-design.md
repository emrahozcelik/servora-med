# Job Lifecycle Operational Notes Design

**Status:** Approved for Checkpoint A  
**Authority:** External product/spec review on 2026-07-29  
**Implementation base:** `fc0f93b3f5ca4157161552fef3a30e00d34baa4c`

## Problem statement

Servora-Med already persists append-only JobCard notes, but a note does not preserve
the author's display identity and role at creation time, the workflow stage at
creation time, or an explicit relationship to its activity record. The current
Overview also exposes a body-derived note preview.

Operational notes must make a JobCard's history understandable without becoming a
second notes domain, a personnel-note system, or a new authorization model.

## Product goals

- Extend the existing `job_card_notes`, `JobCardNotesService`,
  `PostgresJobCardRepository`, and `JobNotes` owners.
- Preserve immutable creation context for every new standalone note.
- Keep legacy records readable without inventing historical facts.
- Derive note visibility and mutation permission from canonical JobCard policy.
- Keep note bodies inside authorized notes endpoints and the related JobCard UI.
- Provide stable, chronological, cursor-based history browsing.
- Preserve append-only, idempotent, plain-text behavior.

## Terminology

- **Operational note:** an existing `job_card_notes` record.
- **Standalone note:** a note added without changing JobCard status.
- **Legacy note:** an existing record represented as `recordVersion = 0`.
- **Version 1 note:** a new record with complete immutable snapshots.
- **Context:** `GENERAL` in Checkpoint A. Later transition notes will reuse canonical
  lifecycle command names rather than introducing a second vocabulary.
- **Workflow stage:** the persisted JobCard status while the row is locked for note
  creation.
- **Related activity:** the exact `NOTE_ADDED` activity created atomically with a
  standalone note.

## Existing-system reconciliation

The existing JobNotes implementation is persisted, append-only, organization-owned,
JobCard-scoped, idempotent through `processed_actions`, and audited with
`NOTE_ADDED`. There is no update or delete route.

Checkpoint A extends this implementation. It does not create a parallel table,
service, route family, capability flag, notification path, or realtime path.

The canonical lifecycle remains:

```text
NEW → ACCEPTED → IN_PROGRESS → WAITING_APPROVAL → COMPLETED
                                  ↓
                         REVISION_REQUESTED → IN_PROGRESS
```

`CANCELLED` remains terminal. Mandatory lifecycle notes are Checkpoint B and are not
implemented by Checkpoint A.

## Domain model

Every version 1 standalone note contains:

```text
id
organizationId
jobCardId
authorId
authorNameSnapshot
authorRoleSnapshot
workflowStage
context = GENERAL
relatedActivityId
plain-text body
createdAt
recordVersion = 1
```

All snapshot and creation fields are immutable. Normal application behavior exposes
no note update or delete operation.

Legacy records remain `recordVersion = 0`. Their creation-time name, role, and stage
are not inferred. A current user identity may be returned only as an explicitly
legacy fallback.

## Workflow-stage snapshot

Standalone creation locks the JobCard and records its current persisted status.
Later JobCard transitions never modify the note snapshot.

Legacy stages are not reconstructed from the current JobCard or nearest activity.
The UI displays an honest “Aşama kaydı mevcut değil” state.

## Authorization

Read authorization continues to use canonical JobCard visibility:

- Admin and Manager: current same-organization JobCard scope.
- Staff: assigned JobCard only.
- Unassigned Staff: hidden with `404`.
- Disabled users cannot authenticate and therefore cannot create notes.
- Disabled authors remain visible through frozen version 1 snapshots.

Standalone `GENERAL` mutation authorization is:

| Actor | Allowed stages |
| --- | --- |
| Admin | All stages |
| Manager | All stages |
| Assigned Staff | `ACCEPTED`, `IN_PROGRESS`, `REVISION_REQUESTED` |
| Unassigned Staff | None (`404`) |

Staff cannot add a standalone note in `NEW`, `WAITING_APPROVAL`, `COMPLETED`, or
`CANCELLED`. A future optional acceptance note belongs to the
`ACCEPT_ASSIGNMENT` transition and is outside Checkpoint A. Only Admin/Manager may
add a post-closeout annotation.

Manager team scoping is not introduced here.

## Persistence

Migration `019_job_card_operational_note_context.sql` additively extends
`job_card_notes` with:

```text
author_name_snapshot
author_role_snapshot
workflow_stage
context
related_activity_id
record_version
```

`record_version = 0` represents an unchanged legacy row. `record_version = 1`
requires all snapshot, context, and activity fields to be valid.

Where the existing activity schema permits it, a composite relationship enforces
that the related activity belongs to the same organization and JobCard. Existing
lifecycle columns remain unchanged. No legacy transition text is backfilled into
operational notes.

## Standalone transaction and idempotency

The existing processed-action transaction becomes:

```text
claim JOB_NOTE_ADD:<jobCardId>
→ lock JobCard
→ canonical visibility and ADD_NOTE authorization
→ capture author identity from persisted user truth
→ generate note ID
→ append NOTE_ADDED activity with metadata {noteId}
→ insert the note linked to that activity
→ complete processed action
→ commit
```

Note body is never written to activity metadata. Note, activity, and processed
action commit together or all roll back. Replaying the same actor/action/operation
returns the stored response without creating duplicate records.

## Pagination and ordering

Offset pagination is replaced for operational notes.

Canonical transport:

```text
initial query:
  latest 25 using created_at DESC, id DESC

older query:
  WHERE (created_at, id) < (beforeCreatedAt, beforeId)
  ORDER BY created_at DESC, id DESC

response:
  items reordered to created_at ASC, id ASC
```

The cursor contains both timestamp and ID. UUID alone is never treated as a
chronological cursor.

Older records are prepended. A concurrent new insert cannot shift or duplicate an
older page. A newly created note is appended only while the viewer remains on the
live tail; browsing older pages is not forcibly reset.

## Plain-text security

- Body is trimmed and must contain 1–4,000 Unicode code points.
- The existing approved whitespace policy remains.
- HTML-like input is rendered through React text nodes.
- `dangerouslySetInnerHTML` is prohibited.
- Long uninterrupted content must wrap on narrow screens.

## Overview and secondary-surface privacy

Note body and body-derived previews are prohibited from:

```text
Overview
JobCard lists and board
reports
Notification Center
Web Push
SSE
generic activity summaries
logs
processed-action diagnostics
```

Overview may retain a bodyless recent-note activity row containing JobCard
identity/link, frozen or safe author identity, and timestamp. The `preview` contract
is removed from server and web.

Checkpoint A does not add standalone-note notifications or realtime events.

## Audit/activity

Every new standalone note has one `NOTE_ADDED` activity whose metadata contains only
the note ID. Note reads do not create high-volume audit entries. Administrative
redaction is deferred.

## UI/UX

The existing `JobNotes` component remains the only notes UI. Version 1 rows show:

```text
authorNameSnapshot
authorRoleSnapshot
workflowStage
createdAt
plain-text body
```

Legacy rows show an explicit legacy identity/stage state.

The initial page is the latest page displayed oldest-to-newest. “Older notes”
prepends records without duplicates. Existing label, code-point counter,
whitespace validation, pending state, double-submit protection, and ambiguous retry
action-ID retention remain.

Loading, empty, and error states use the canonical UI adapters.

## Accessibility and responsive behavior

- Persistent programmatic labels and described validation errors.
- Keyboard-operable controls and visible focus.
- Pending controls disabled without losing the draft.
- Long body and metadata wrapping at 390 px.
- Usable at 200% text resize and 400% reflow.

## Capability and rollout decision

No new capability flag is added. JobNotes is already a production contract; a flag
would create two note behaviors without replacing backend authorization.

The migration is additive and the web parser accepts both legacy and version 1
records during rollout.

## Testing

Checkpoint A tests cover:

- legacy and version 1 schema constraints;
- organization/JobCard/activity integrity;
- the complete authorization matrix;
- transaction rollback and processed-action replay;
- latest-page and stable compound-cursor pagination;
- same-timestamp tie breaking and concurrent inserts;
- Overview body-preview removal;
- version 1 and legacy UI rendering;
- plain-text rendering, retry behavior, prepend, live-tail append, and wrapping.

PostgreSQL integration tests use a disposable database.

## Runtime acceptance

Acceptance uses all migrations, a real Fastify API, real Vite, synthetic
Admin/Manager/Staff identities, and Playwright or Chrome DevTools. API assertions
prove authorization, pagination, and privacy behaviors that screenshots cannot.

## Explicit non-goals

- Mandatory lifecycle notes or lifecycle handler changes.
- Notifications or realtime `NOTE_ADDED` projection.
- Follow-up JobCards.
- A `REJECT` command or status.
- Administrative redaction.
- Note editing or deletion.
- Rich text, attachments, mentions, reactions, or AI generation.
- Manager team-scope redesign.
- New dependency or capability flag.
- Staging or production enablement.

## Risks

- Legacy rows lack trustworthy creation snapshots; they remain explicitly legacy.
- Cursor ordering must use timestamp and ID together.
- Policy normalization changes existing terminal behavior for Staff and review-stage
  behavior for Sales Meetings; focused policy tests are binding.
- Overview contract removal must cover repository, DTO, parser, UI, and tests.
- Activity/note insertion order must satisfy FK integrity without weakening
  atomicity.

## Deferred checkpoints

Checkpoint B will project a single lifecycle user input into both the existing
legacy lifecycle field and its operational transition note in one transaction. It
must not introduce separate note/reason inputs.

Checkpoint C may add bodyless realtime invalidation and an explicitly approved
generic notification policy.

Optional linked follow-up JobCards require a separate product gate and PR.

