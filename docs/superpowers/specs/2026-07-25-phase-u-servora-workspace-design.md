# Phase U — Servora Workspace, Dashboard, Calendar and Messaging
## Product and Architecture Design Specification

**Status:** Active design — Ant visual-language documentation reconciled 2026-07-26
**Date:** 2026-07-25
**Repository:** `emrahozcelik/servora-med`
**Depends on:** Phase T4 complete and merged
**Must complete before:** Phase T5 final visual/state regression closeout
**Implementation shape:** Three product slices (U1, U2, U3) plus one substantial Workspace Visual Composition corrective checkpoint between U2 and U3

---

## 1. Purpose

Phase U turns Servora-Med from a collection of operational screens into a role-aware daily workspace.

The target is not to copy a third-party SaaS dashboard or replace Servora's design system. The target is to adopt the strongest parts of that information architecture:

1. a useful landing page,
2. immediate operational status,
3. upcoming work,
4. clear next actions,
5. recent activity,
6. direct navigation into the underlying records.

The implementation must use Servora's existing AppShell, navigation model, visual tokens, native form ownership, owned Ant adapters, notification infrastructure, Web Push infrastructure, authorization model and Turkish product language.

Tailwind, shadcn/ui, Base UI and the downloaded demo application's root architecture are reference material only. They are not a dependency migration plan.

---

## 2. Product outcome

After Phase U:

- staff land on a personal operational overview,
- managers/admins land on an organization-level operational overview,
- upcoming work is visible on the dashboard and in a dedicated calendar,
- authorized managers can plan and reschedule staff work,
- staff receive reminders for approaching work,
- managers and staff can exchange scoped one-to-one messages,
- recent notes, recent completed work and unread messages can be surfaced without bypassing authorization,
- documentation, mandatory policy documents, help content and profile/settings are available from the application shell,
- the final Phase T5 regression closeout includes all new Phase U surfaces.

---

## 3. Non-goals

Phase U does not authorize:

- migration to Tailwind,
- migration to shadcn/ui,
- mass migration to Ant Form, Ant Layout or Ant Menu; Ant Card and other reviewed components are allowed through owned adapters,
- copying the third-party demo's theme provider, router, mock API or application shell,
- a general-purpose BI platform,
- a drag-and-drop dashboard builder,
- generative AI or an "Ask AI" feature,
- group chat,
- message attachments,
- voice/video calling,
- calendar sync with Google/Microsoft in the first release,
- user-defined custom dashboard widgets,
- organization-wide global search,
- public documentation,
- production enablement without separate acceptance gates,
- Phase T5's final application-wide state and visual regression closure.

---

## 4. Design principles

### 4.1 Servora remains the owner

All new screens must follow the Servora UI architecture:

- purpose-layered surfaces rather than flatness as an end in itself,
- Card and emphasis when they clarify a subject, urgency, selection, or action group,
- no decorative card-inside-card composition,
- one obvious primary action per local task,
- operational color only when it communicates status or risk,
- Turkish user-facing copy,
- responsive behavior owned by Servora CSS and components,
- no raw `antd` imports from feature code,
- no feature-level import of the visual-token implementation module.

### 4.2 Information before decoration

The dashboard must answer:

```text
Neredeyim?
→ Şu anda durum ne?
→ Benden ne bekleniyor?
→ Sırada ne var?
→ Ayrıntıya nasıl giderim?
```

Charts and KPI values are supporting evidence, not the primary experience.

### 4.3 Role-specific products, not one filtered dashboard

Staff and manager/admin dashboards share primitives but not identical information models.

A staff user should see personal work and personal performance. A manager/admin may see organization or team information only within existing authorization boundaries.

### 4.4 Deep links are mandatory

Every actionable widget must lead to a real filtered destination:

- job list,
- job detail,
- calendar event,
- message thread,
- customer record,
- report view.

A dashboard must not become a dead-end display.

### 4.5 Privacy is enforced at the source

Dashboard aggregation, calendar visibility, note previews and message-summary metadata must apply authorization server-side. The client must not receive records outside its authorized JobCard, calendar or conversation scope and then filter them locally.

---

## 5. Information architecture

### 5.1 Primary navigation

Recommended order:

```text
Genel Bakış
İşler
Takvim
Müşteriler
Ürünler
Mesajlar
Raporlar        — authorized manager/admin only
Personel        — authorized manager/admin only
```

Exact visibility continues to use the repository's authoritative role/capability model.

### 5.2 Support navigation

```text
Dokümantasyon
Yardım Merkezi
```

These items should be visually separated from the main operational navigation without creating a second application shell.

### 5.3 Account area

```text
Profil ve Ayarlar
Oturumu Kapat
```

The account area may show:

- avatar or initials fallback,
- display name,
- current role label,
- unread message count when appropriate.

Remove reference-demo actions that do not belong to Servora, such as shopping-cart or country-flag controls.

### 5.4 Routes

Candidate routes, subject to repository preflight:

```text
/overview
/calendar
/messages
/docs
/help
/settings/profile
/settings/security
/settings/notifications
```

The root route and post-login destination should resolve to `/overview` when the overview capability is enabled; otherwise they resolve to the existing safe `/jobs` destination without a redirect loop. Docs, Help Center and supported settings remain authenticated-shell destinations and are not overview-gated.

Existing deep links and authorization redirects must remain valid.

---

## 6. Dashboard composition

### 6.1 Shared page structure

```text
Page heading and contextual greeting
→ optional period/date controls
→ KPI summary
→ primary operational view
→ secondary operational signals
→ recent activity/action list
```

The dashboard should use a responsive CSS grid and Servora-owned Card/Statistic/Badge/Avatar/Segmented adapters. It should preserve Servora domain semantics and avoid decorative nested containers, but it is no longer required to remain visually flat.

### 6.2 Dashboard component contract

The accepted dashboard direction is a Servora translation of the SaaS + AI reference composition:

```text
contextual greeting + period control
→ four primary metrics
→ main trend/operational chart
→ upcoming schedule or attention queue
→ recent completed work
→ recent notes
→ unread messages after U3
```

Approved owned primitives:

```text
MetricStatistic        — Ant Statistic inside Servora card grammar
OperationalCard        — default/new/upcoming/attention/overdue/success/selected
IconSegmented          — period or view selection
UserAvatar             — image/initials plus meaningful Badge
ResultState            — loading failure, forbidden, not found, completed flow
LoadingSkeleton        — dashboard skeleton
EmptyState             — bounded empty widgets
RecordDescriptions     — profile/account facts
```

Dashboard Cards may use semantic slot `classNames` / `styles`, but feature code must not import Ant Card directly. Each actionable widget has a real heading, bounded data, and deep link. A Card grid is allowed because the dashboard is a summary workspace; it must not be copied into every dense operational list.

### 6.3 Staff dashboard

#### Header

Example intent:

```text
Günaydın, Ayşe
Bugünkü programın ve senden aksiyon bekleyen işler.
```

Do not rely on the greeting alone to communicate state.

#### KPI candidates

- today's assigned work,
- in-progress work,
- revision requested,
- completed in current period,
- upcoming within the reminder window.

The exact set should be capped at four primary KPI values at desktop widths.

#### Primary widgets

- today's schedule,
- next assigned work,
- revision/action required,
- recent completed work,
- recent authorized notes,
- unread message summary,
- personal sales or completed-value summary when the role and data model permit it.

#### Staff privacy

Do not expose:

- other staff performance,
- organization-wide customer data beyond current authorization,
- manager-only review queues,
- notes from JobCards outside the user's authorized scope,
- private message threads,
- organization-wide revenue unless the current role already permits it.

### 6.4 Manager/admin dashboard

#### KPI candidates

- awaiting approval,
- overdue work,
- revision requested,
- completed today,
- active staff,
- current-period sales/completed value.

Use no more than four primary KPI cards at once. Secondary values can live in supporting widgets.

#### Primary widgets

- completion trend,
- work-type distribution,
- staff sales/performance,
- staff workload,
- upcoming team schedule,
- recent completed work,
- recent authorized notes,
- unread messages,
- longest-waiting operational items.

#### Reference-demo mapping

| Reference concept | Servora adaptation |
|---|---|
| Best Performing AI Products | Staff sales/performance |
| Ask AI | Recent completed work or attention-required queue |
| Revenue Distribution | Work-type distribution |
| AI Revenue | Current-period sales/completed value |
| Active AI Users | Active staff |
| AI Automations | Completed work |
| MRR Growth | Period-over-period operational change |

No artificial AI labeling should remain in Servora copy.

### 6.5 Chart rules

- Reuse current Servora report-chart primitives whenever possible.
- Add a chart dependency only through a separate dependency/security gate when current primitives cannot meet an accepted requirement.
- Every chart requires a text summary or accessible equivalent.
- Do not communicate meaning by color alone.
- Use the Servora color palette.
- Avoid decorative animation that delays comprehension.
- Dashboard charts must not replace detailed reports.

### 6.6 Responsive layout

Minimum contract:

- 1440 px: up to four KPI columns and balanced two/three-column widget layout,
- 1024 px: two-column KPI and content layout where safe,
- 768 px: simplified two-column or single-column layout based on content,
- 390 px: single column, safe action stacking, no horizontal overflow.

The source DOM order must remain meaningful when the grid collapses.

---

## 7. Dashboard data contract

### 7.1 Preferred API shape

Prefer one role-authoritative overview endpoint or a small number of coherent endpoints rather than many client-side joins.

Candidate:

```text
GET /api/overview?from=<date>&to=<date>
```

The server returns a role-specific response union.

Example conceptual shape:

```ts
type OverviewResponse =
  | StaffOverview
  | ManagerOverview;
```

The exact endpoint and naming must follow current repository conventions discovered during preflight.

### 7.2 Data requirements

The overview response may contain:

- normalized period,
- KPI values,
- trend points,
- distribution buckets,
- upcoming calendar items,
- recent completed jobs,
- recent authorized note previews,
- unread message summary,
- deep-link filters.

### 7.3 Server-side enforcement

The overview service must:

- use existing authorization services,
- avoid N+1 record loading,
- use bounded result sets,
- return preview-safe fields only,
- never include records outside the user's authorized scope,
- use server-authoritative timestamps,
- define stable ordering,
- define empty-state behavior,
- support deterministic tests.

### 7.4 Refresh behavior

Prefer:

- initial fetch,
- invalidation/reconciliation from existing SSE or notification events,
- bounded explicit refresh.

Avoid high-frequency polling unless a measured requirement proves it necessary.

---

## 8. Documentation

### 8.1 Product documentation

Initial categories:

```text
Başlangıç
İşler nasıl kullanılır?
İş nasıl başlatılır ve tamamlanır?
Düzeltme talebi nasıl ele alınır?
Müşteri ve iletişim kayıtları
Ürünler
Takvim
Bildirimler
Mesajlar
Profil ve ayarlar
Sık kullanılan terimler
```

### 8.2 Mandatory and legal documents

Candidate categories:

```text
KVKK aydınlatma metni
Gizlilik politikası
Kullanım koşulları
Bilgi güvenliği kuralları
Veri saklama ve silme politikası
Şirket içi prosedürler
```

Legal content must be supplied or approved by the organization's authorized legal/administrative owner. Engineering must not invent final legal obligations.

### 8.3 Documentation composition

Documentation uses a searchable, navigable content layout rather than rendering every article fully expanded. Approved composition:

- Content search,
- category navigation,
- owned Anchor for long-document sections,
- owned Collapse for concise guides and FAQs,
- full document layout for legal/policy text,
- visible version and publication metadata,
- ResultState for unavailable/forbidden documents.

Legal documents must not be reduced to FAQ accordions when full reading context is required.

### 8.4 Content delivery

Preferred initial implementation:

- repository-managed, versioned typed content,
- explicit document id,
- title,
- version,
- published date,
- audience/role visibility,
- optional `requiresAcknowledgement`.

If mandatory acknowledgement is enabled later, store:

- document version,
- user id,
- viewed timestamp,
- accepted timestamp,
- superseded acknowledgement status.

Do not block login on a new legal acceptance workflow without a separate product and legal gate.

---

## 9. Help Center

### 9.1 Purpose

Documentation answers "how does the product work?"

Help Center answers "what should I do when something goes wrong?"

### 9.2 Initial topics

```text
Giriş yapamıyorum
Şifremi unuttum
Bildirim gelmiyor
Konum alınamıyor
İşi başlatamıyorum
Dosya yüklenmiyor
Ekran güncellenmiyor
Yanlış müşteriye iş açıldı
Takvim kaydı görünmüyor
Mesaj gönderilemiyor
```

### 9.3 Article structure

Each article should contain:

- symptom,
- safe steps the user can try,
- information the user must not share,
- when to contact an administrator,
- approved contact channel.

### 9.4 Help Center composition

Help Center uses search, categorized Collapse items, Alert for safety/security guidance, optional Steps for ordered troubleshooting, and a clear support-contact Card. It must distinguish everyday operational messaging from technical support. All content remains Turkish and repository-managed unless an approved support service is introduced.

### 9.5 Contact model

U1 may provide configured support contact information through public-safe authenticated runtime configuration returned alongside the current-user bootstrap contract, or through a small authenticated runtime-config response.

Do not hardcode personal administrator email addresses in the client bundle.

A structured support-ticket system is not required in Phase U. Daily operational messaging and technical support should remain conceptually separate.

---

## 10. Profile and settings

### 10.1 Settings areas

```text
Profil
Güvenlik
Bildirimler
Görünüm — only if supported by current product direction
```

### 10.2 Settings composition

Settings uses owned Tabs or route-aware tab navigation, Avatar with initials fallback, RecordDescriptions for account facts, ResultState for unsupported/forbidden actions, and compact Cards for security/notification groups. An Avatar Badge may show a real verified/active/unread state only when backed by authoritative data; decorative presence dots are prohibited.

### 10.3 Profile

U1 provides read-only current-user/profile presentation with an initials fallback. It must not promise a self-profile mutation that the current repository does not provide.

### 10.4 Avatar safety

Do not introduce an ad-hoc production local-disk store.

Avatar upload is not in U1. It requires a separate storage/security gate if it is proposed later, including:

- MIME validation,
- file-size limit,
- image decoding validation,
- image normalization/resizing,
- safe object key generation,
- replacement/deletion,
- authorization,
- malware/content checks appropriate to the existing platform.

U1 decision: `DISPLAY + INITIALS ONLY; UPLOAD DEFERRED`.

### 10.5 Password change

Must include:

- current-password verification when applicable,
- existing password policy,
- stable error mapping,
- duplicate-submit protection,
- security event/audit record as supported,
- clear decision on other-session invalidation.

Do not redesign authentication inside Phase U unless a blocking security issue requires a separately authorized remediation.

### 10.6 Notifications

U1 exposes existing Web Push device/subscription controls only. It does not add a stored per-category preference model; calendar and message preference decisions belong to their authorized later slices. Critical security or mandatory operational notices must not become suppressible accidentally.

---

## 11. Calendar and planning

### 11.1 Product model

The calendar is a work-planning surface, not a standalone decorative calendar.

It must support:

- work-derived events,
- optional authorized manual planning events,
- staff personal view,
- manager team view,
- job deep links,
- reminders,
- rescheduling,
- audit history.

### 11.2 Ownership model

A calendar entry should not duplicate job lifecycle state.

Recommended conceptual sources:

```text
JOB
MANUAL
```

A `JOB` event is projected from authoritative JobCard scheduling and does not duplicate lifecycle state. Current JobCard truth is `scheduled_at`, with no scheduled end/duration; its version-controlled patch owns scheduling changes. U2 may add `job_cards.scheduled_ends_at` while preserving JobCard lifecycle authority.

A `MANUAL` event is stored in `calendar_events`, is organization-scoped, and is restricted to authorized operational planning purposes; it must not masquerade as a job.

### 11.3 Candidate data model

Final names must follow repository conventions.

```text
calendar_events (MANUAL only)
- id
- organization_id
- source_type
- source_job_id nullable
- assigned_user_id
- title
- description nullable
- starts_at
- ends_at nullable
- timezone
- status
- created_by
- updated_by
- created_at
- updated_at
- version
```

```text
calendar_event_audit
- id
- calendar_event_id
- actor_user_id
- action
- before_json
- after_json
- reason nullable
- created_at
```

```text
calendar_reminders
- id
- calendar_event_id
- recipient_user_id
- remind_at
- channel
- state
- attempt_count
- dedupe_key
- created_at
- updated_at
```

Calendar audit uses field-level records where possible; it must not introduce needless full description snapshots. Job-backed changes remain in the existing JobCard activity convention. Job-backed and manual records are both organization-scoped; interval conflict semantics are `[start, end)`.

### 11.4 Permissions

Staff may:

- view their authorized events,
- open related jobs,
- create personal/manual events only if explicitly authorized,
- edit only permitted personal events,
- not edit manager-owned job scheduling unless authorized.

Managers/admins may:

- view authorized staff calendars,
- create/assign/reschedule authorized events,
- filter by person/team,
- see conflicts within authorized scope.

All manager modifications must be audited.

### 11.5 Conflict behavior

The first release should at minimum detect:

- overlapping events for the same staff member,
- invalid end-before-start,
- events outside permitted date limits,
- stale concurrent edits.

A conflict warning must not silently overwrite a newer server version.

### 11.6 Reminders

Canonical notification kinds:

```text
calendar.assigned
calendar.rescheduled
calendar.cancelled
calendar.reminder
```

Use existing in-app notification and Web Push infrastructure.

Push content must be privacy-safe and should avoid sensitive customer details.

Reminder dispatch must be:

- server-authoritative,
- idempotent,
- retryable,
- bounded,
- observable,
- safe during worker shutdown/restart.

Provider I/O remains outside open database transactions.

### 11.7 Accepted calendar visual composition

The U2 page must be a real monthly planning surface, not only a weekly record list.

Desktop/tablet:

- Servora-owned Ant Notice Calendar monthly grid,
- custom Servora header with today/navigation and optional icon-supported view control,
- manager/admin staff filter,
- bounded event summaries per date and explicit `+N plan`,
- selected-day agenda beside or below the grid,
- create/edit in an owned Ant Drawer,
- ResultState, LoadingSkeleton and EmptyState for page/agenda states.

Mobile:

- compact monthly calendar,
- event count or minimal markers in cells,
- selected-day agenda below,
- full-width responsive Drawer for create/edit,
- no horizontally compressed desktop event text.

Calendar intervals use the server's `[start, end)` semantics everywhere, including multi-day cell projection. Preserve and reuse the existing shared `[start, end)` date helper contract. Add/retain regression coverage for midnight end boundaries and multi-day rendering. Do not rewrite server date semantics in a visual corrective PR. Browser-native `window.prompt` and `window.confirm` are prohibited. A reason-required cancellation uses ReasonDialog/ConfirmationAction; a short confirmation with no input may use CompactConfirmationAction/Popconfirm.

### 11.8 Dashboard calendar widget

The dashboard widget shows:

- today,
- tomorrow,
- a small bounded number of upcoming entries,
- time,
- safe title,
- status,
- related-record link.

Full creation, filtering and editing remain on `/calendar`.

---

## 12. Messaging

### 12.1 First-release scope

Phase U messaging includes:

- one-to-one manager/admin ↔ staff conversations,
- text messages,
- unread/read state,
- timestamps,
- unread count,
- in-app notification,
- optional Web Push notification,
- optional link to a job or operational record.

### 12.2 Explicitly excluded

```text
attachments
voice messages
group chat
reactions
message editing
message deletion
external recipients
video/audio calling
end-to-end encryption claims
```

### 12.3 Candidate data model

```text
conversations
- id
- organization_id
- type
- direct_key
- related_job_id nullable
- created_by
- created_at
- updated_at
```

```text
conversation_participants
- conversation_id
- user_id
- joined_at
- last_read_message_id nullable
- muted_at nullable
```

```text
messages
- id
- conversation_id
- sender_user_id
- body
- client_action_id
- created_at
```

Database constraints are proposed as:

```text
UNIQUE (organization_id, direct_key)
UNIQUE (conversation_id, user_id)
UNIQUE (conversation_id, sender_user_id, client_action_id)
```

The server generates `direct_key` from the sorted participant pair plus either `GENERAL` or `JOB:<jobId>`. Unread state uses `last_read_message_id`, with a deterministic cursor that includes `created_at` and `id`. Message ordering is `created_at ASC, id ASC`; pagination cursor is the same pair.

### 12.4 Messaging invariants

- participants are authorized server-side,
- a user cannot add arbitrary organization members,
- message body is 1..4000 code points,
- message body is plain text; HTML is not trusted,
- links are rendered safely,
- duplicate send is prevented with `client_action_id` or equivalent,
- ordering is stable,
- pagination is bounded,
- unread reconciliation is deterministic,
- notification delivery is idempotent,
- deleted/disabled users are handled explicitly,
- message-summary metadata is privacy-safe and Push/dashboard notifications never contain the message body.

### 12.5 Dashboard message widget

The dashboard should show only a bounded summary:

- unread total,
- sender display name,
- generic privacy-safe unread status, never a message-body preview,
- time,
- link to thread.

Do not embed a full chat client in the dashboard.

---

## 13. Recent notes and recent completed work

### 13.1 Recent notes

A recent-note widget may include:

- related job title/reference,
- bounded note preview,
- author display,
- timestamp,
- deep link.

The query must derive note visibility from the related JobCard authorization scope. There is no separate hidden-note model; overview aggregation must not expose notes from inaccessible JobCards.

### 13.2 Recent completed work

A recent-completed widget may include:

- job reference/title,
- customer-safe display,
- assigned staff,
- completion time,
- work type,
- deep link.

Staff receive only their authorized scope. Managers receive only their authorized organization/team scope.

---

## 14. Notifications and real-time behavior

Reuse the existing notification center, SSE invalidation and Web Push foundations.

Candidate new notification kinds:

```text
calendar.assigned
calendar.rescheduled
calendar.cancelled
calendar.reminder
message.received
```

Each kind must define:

- recipient selection,
- route/deep link,
- in-app copy,
- Web Push copy,
- privacy-safe payload,
- projection/idempotency key,
- retry behavior,
- disabled-feature behavior.

No notification provider I/O should occur inside an open database transaction.

---

### 14.1 Notification and progress presentation

In-app feedback is obtained only through `useAppFeedback`. Auto-closing informational notifications may use Ant Notification `showProgress` and `pauseOnHover`; that bar communicates time remaining before auto-close, not the progress of the underlying operation. Persistent errors and decisions must not rely on auto-close. Actual upload/export/import progress uses a measured Progress value; indeterminate server work uses loading/skeleton/status language rather than a fabricated percentage.

---

## 15. Authorization matrix

Exact role names must be mapped during repository preflight.

| Capability | Staff | Manager | Admin |
|---|---:|---:|---:|
| Personal overview | Yes | Yes | Yes |
| Organization overview | No | Authorized scope | Authorized scope |
| Own calendar | Yes | Yes | Yes |
| Other staff calendars | No | Authorized scope | Authorized scope |
| Reschedule staff work | No by default | Authorized scope | Authorized scope |
| One-to-one operational messaging | Authorized threads | Authorized threads | Authorized threads |
| Reports | Existing authorization | Existing authorization | Existing authorization |
| Personnel administration | No | Existing authorization | Existing authorization |
| Product docs/help | Yes | Yes | Yes |
| Legal docs | Audience-based | Audience-based | Audience-based |
| Profile settings | Own profile | Own profile | Own profile |

Client navigation visibility is not a substitute for server authorization.

---

## 16. Feature gating and rollout

Recommended capabilities:

```text
OVERVIEW_DASHBOARD_ENABLED
CALENDAR_ENABLED
MESSAGING_ENABLED
```

No generic capability system exists on the approved baseline; U1 introduces the smallest server-configured model. All three capabilities are default off, server authoritative, and client-visible only through a safe authenticated bootstrap contract:

```ts
capabilities: {
  overviewDashboard: boolean;
  calendar: boolean;
  messaging: boolean;
}
```

Both `POST /api/auth/login` and `GET /api/auth/me` return that same contract. No separate `/api/capabilities` endpoint is planned. Client visibility is never authorization; every route and service gates its own capability independently.

Requirements:

- default off until acceptance,
- disabled mode hides navigation and blocks server paths,
- no partial browser-only enablement,
- staging acceptance before production,
- production enablement requires a separate gate,
- rollback must not require destructive data changes.

Documentation/help/settings ship independently from the overview capability and remain authenticated-shell routes.

---

### 16.1 Migration and dependency decisions

The approved baseline's last migration is `016_google_reverse_geocoding.sql`. Current candidates are `017_calendar.sql` for U2 and `018_messaging.sql` for U3. They are provisional candidates, not irrevocable reservations: at the beginning of U2 and again at the beginning of U3, fetch the exact authorized `main`, inspect every migration, fail closed if the candidate is occupied, and select the next available sequential number.

```text
Charts: NO NEW DEPENDENCY REQUIRED
Calendar first release: NO NEW DEPENDENCY REQUIRED
Docs/help: NO MARKDOWN RENDERER REQUIRED; typed repository-managed content
Avatar processing: DEFERRED / separate storage-security gate
Messaging sanitization: plain-text rendering; no sanitizer dependency required
Timezone/date: existing platform/date conventions unless U2 proves a gap
```

---

## 17. Accessibility

All Phase U screens must preserve:

- one page-level `h1`,
- logical heading hierarchy,
- keyboard navigation,
- visible focus,
- label/helper/error association,
- no color-only meaning,
- accessible chart summaries,
- meaningful empty states,
- safe live-region usage,
- touch target contract,
- 200% text zoom usability,
- 400% reflow requirements in final T5 closeout.

Message and calendar updates must not cause disruptive focus loss.

---

## 18. Testing strategy

### 18.1 Server

- authorization tests,
- role-scope tests,
- aggregation correctness,
- stable ordering,
- boundary dates/time zones,
- calendar overlap and stale-write tests,
- audit-history tests,
- reminder idempotency/retry tests,
- messaging participant authorization,
- message duplicate-submit protection,
- unread reconciliation,
- notification projection tests,
- disabled-feature tests.

### 18.2 Web

- route and post-login redirect tests,
- role-specific navigation,
- overview rendering,
- KPI deep links,
- chart summaries,
- empty/error/retry states,
- calendar filters and editing,
- permission-disabled controls,
- messaging pagination and unread behavior,
- settings validation,
- docs/help navigation,
- accessibility contracts,
- responsive CSS contracts.

### 18.3 Browser verification

Minimum viewports:

```text
390
768
1024
1440
```

Minimum role/state coverage:

```text
staff overview
manager overview
empty overview
error/retry
staff calendar
manager team calendar
calendar conflict
messages unread/read
docs/help
profile/settings
```

Check:

- console errors,
- failed requests,
- overflow,
- focus,
- text zoom,
- role leakage,
- privacy-safe fixtures.

Use synthetic, PII-free evidence only.

---

## 19. Observability

Add operational visibility appropriate to the existing stack:

- overview endpoint latency/error count,
- calendar mutation outcomes,
- reminder claimed/delivered/retried/abandoned counts,
- message send outcomes,
- unread reconciliation failures,
- notification projection failures,
- feature-flag state in diagnostics without secrets.

Do not log message bodies, sensitive customer details, precise coordinates or push endpoints.

---

## 20. Delivery slices

### U1 — Workspace foundation, role-aware overview, docs/help/settings

Delivers:

- overview route and redirect,
- navigation changes,
- shared dashboard primitives,
- staff overview using currently available data,
- manager overview using currently available reporting data,
- recent completed work,
- recent authorized notes when supported safely,
- docs,
- help center,
- profile/settings shell,
- avatar display and initials fallback only; upload is deferred,
- capability gating,
- responsive and accessibility baseline.

U1 must not wait for calendar or messaging. Calendar/message widgets may use honest disabled/coming-later omission, not fake data.

### U2 — Calendar, scheduling and reminders

Delivers:

- calendar data model,
- job/manual event ownership,
- staff and manager views,
- authorized editing/rescheduling,
- conflict detection,
- audit history,
- reminder scheduler,
- in-app and Web Push notifications,
- dashboard upcoming-work widget,
- role/privacy acceptance.

### Workspace Visual Composition checkpoint — after U2, before U3

This is one substantial corrective PR, not a collection of micro-PRs. It updates the canonical visual contract and applies it to:

- Overview/dashboard composition,
- Documentation,
- Help Center,
- Profile and Settings,
- 403/404/500 and completed-operation Result states,
- shared OperationalCard, MetricStatistic, UserAvatar, IconSegmented, Progress and content adapters,
- palette/token revision when accepted by contrast and browser evidence.

It does not add messaging persistence, calendar domain changes, new reports, or T5 application-wide state migration. U3 starts only after this checkpoint merges and resulting-main CI succeeds.

### U3 — Messaging and advanced dashboard analytics

Delivers:

- one-to-one operational messaging,
- unread/read behavior,
- job-linked conversations,
- message notifications,
- dashboard unread-message widget,
- staff sales/completion widget,
- manager staff-performance widget,
- work-type distribution,
- workload/recent-completed enhancements,
- final Phase U evidence and acceptance.

Phase T5 follows U3 and performs final application-wide state, responsive and visual regression closeout.

---

## 21. Global acceptance

Phase U is complete only when:

- all three slices are merged,
- exact-head and resulting-main CI are successful for each merge,
- authorization tests prove no role leakage,
- calendar modifications are audited,
- reminders are idempotent,
- message sends are idempotent,
- unread counts reconcile,
- dashboard deep links work,
- documentation/help/settings are available,
- 390–1440 browser verification passes,
- synthetic evidence contains no PII or secrets,
- worktrees are clean,
- production remains disabled until separately authorized.

---

## 22. Gate summary

```text
Phase T4:
COMPLETE / INTEGRATED

Phase U Ant visual documentation reconciliation:
AUTHORIZED — current checkpoint

U1:
COMPLETE / INTEGRATED — merged via PR #70 at 5d5ee5dc15638b94ed3c3267971839b4c6fa36dd

U2:
COMPLETE / INTEGRATED — merged at 8cbb8b5a7c65e391f1b007919db40e1b098bc2ae via PR #72

U2 Calendar post-merge visual correction:
NOT AUTHORIZED until reconciliation approval

Workspace Visual Composition:
NOT AUTHORIZED until Calendar corrective merge and resulting-main CI

U3:
NOT AUTHORIZED until Workspace Visual Composition merge, resulting-main CI and external visual approval

T5:
NOT AUTHORIZED

Staging/production:
NOT AUTHORIZED — separate authorization required
```


## 23. Visual-language authority — 2026-07-26

The following files are binding amendments to this design:

```text
DESIGN.md
docs/superpowers/specs/2026-07-26-servora-ant-visual-language.md
docs/superpowers/plans/2026-07-26-phase-u2-calendar-visual-closeout.md
docs/superpowers/plans/2026-07-26-phase-u-workspace-visual-composition.md
```

Where older Phase U wording says "flat" or excludes Ant Card, the newer purpose-layered and owned-adapter rules control. The raw feature-import boundary, authorization, privacy, responsive, accessibility, bundle, and production gates remain unchanged.
