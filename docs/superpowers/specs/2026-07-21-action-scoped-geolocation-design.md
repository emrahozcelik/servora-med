# Servora-Med Action-Scoped Browser Geolocation Design

**Status:** Proposed — runtime implementation is blocked until technical design
review is complete. Production location capture remains disabled until the
privacy/retention policy and reverse-geocoding provider gates are approved.

**Phase:** Q — action-scoped browser geolocation

## 1. Goal

Capture an optional browser location only when an assigned Staff user invokes
the existing `İşi başlat` JobCard action. Persist the capture outcome with the
committed `JOB_STARTED` activity, show it in authorized JobCard history, and
keep future geographic reporting possible without turning Servora-Med into an
employee-tracking system.

## 2. Approved Product Decisions

- Only a Staff user starting their assigned JobCard triggers location capture.
- The existing action remains `İşi başlat`; there is no separate confirmation,
  consent checkbox, login-screen permission checkbox, or renamed action.
- Capture begins synchronously from that explicit click through
  `navigator.geolocation.getCurrentPosition`.
- The browser's native permission prompt remains browser-owned and cannot be
  suppressed by the application.
- Location failure never blocks the initial pilot's JobCard transition.
- Coordinates and browser-reported accuracy are canonical capture data.
- An approximate address is derived metadata and never replaces coordinates.
- The JobCard history shows capture success or the normalized failure reason.
- Geographic reports are an allowed later consumer, not part of this slice.

The purpose is limited to operational evidence that the assigned Staff user
started a field JobCard near the captured location. Location is not attendance
tracking, payroll evidence, fraud proof, an authorization factor, or proof that
the user was at an exact address.

## 3. Explicit Non-Goals

- continuous or interval tracking;
- `watchPosition`;
- background or service-worker location;
- location collection at login, page load, approval, revision, or cancellation;
- manager/admin location capture;
- mandatory location as a workflow readiness rule;
- spoofing detection or physical-presence enforcement;
- route history, geofencing, mileage, attendance, or visit duration;
- geographic report UI or formulas in the first runtime slice;
- a client-side reverse-geocoding provider call.

## 4. User Notice and Permission UX

The Staff action surface shows an operational notice near `İşi başlat`:

> İşi başlattığınızda cihazınızdan bir kez yaklaşık konum alınmaya çalışılır.
> Konum, iş başlangıcını operasyonel olarak kayıt altına almak amacıyla yetkili
> kullanıcıların görebildiği iş geçmişinde saklanır. Konum alınamazsa iş yine
> başlar.

This is an operational notice, not a consent gate or a substitute for the
legally reviewed employee notice. The button click immediately starts one
browser request. While location and command work are pending, the existing
button is disabled and its accessible pending label explains the current step.
The application does not preflight with the Permissions API because browser
support differs and preflight does not replace the native prompt.

The employee/user manual, location disclosure, privacy notices, retention
policy, provider-transfer details, and other governed documents are deferred to
a dedicated document surface under Settings or the user profile. That surface
must support the approved document text, version, and effective date. It is not
part of Phase Q and Phase Q must not add a broken placeholder link. Before
production capture is enabled, the action notice must link to the approved full
location disclosure in that document surface.

Suggested browser options:

```ts
{
  enableHighAccuracy: true,
  timeout: 10_000,
  maximumAge: 0,
}
```

No automatic permission request occurs before the click. Retry after a denied
permission does not repeatedly prompt; it submits the normalized unavailable
outcome and continues the workflow.

## 5. Capture Contract

The existing start request gains exactly one discriminated field:

```ts
type StartLocationCapture =
  | {
      outcome: 'captured';
      latitude: number;
      longitude: number;
      accuracyMeters: number;
      capturedAt: string;
    }
  | {
      outcome: 'unavailable';
      reason:
        | 'PERMISSION_DENIED'
        | 'POSITION_UNAVAILABLE'
        | 'TIMEOUT'
        | 'UNSUPPORTED'
        | 'UNKNOWN';
    };

type StartJobCardInput = {
  clientActionId: string;
  expectedVersion: number;
  locationCapture: StartLocationCapture;
};
```

The frontend maps browser error codes; it does not invent coordinates. The
backend validates finite numeric values, latitude `[-90, 90]`, longitude
`[-180, 180]`, positive accuracy, a well-formed ISO capture timestamp, exact
fields, and the discriminated outcome. Invalid payloads receive `400`; a
legitimate unavailable outcome remains a valid start command.

Browser coordinates and `capturedAt` are user-device claims. Backend validation
protects data shape and bounds, not physical truth. `capturedAt` is retained as
client-claimed metadata; the location row `createdAt` and activity `createdAt`
are authoritative server times. Audit ordering and Timeline ordering always use
server time. The pilot does not reject an otherwise valid capture solely for
device clock skew.

## 6. Accuracy Policy

The UI displays the browser-reported radius, for example:

```text
Konum: Kızılay Mahallesi, Çankaya / Ankara
Doğruluk: yaklaşık 32 metre
```

`accuracyMeters` is the Geolocation API's approximately 95% confidence radius;
it is not a percentage and does not mean the address is 95% correct.

Proposed pilot address threshold: coordinates with
`accuracyMeters <= 1,000` may be reverse-geocoded. Less precise captures are
still retained with their radius and shown as `Düşük doğruluk`; no approximate
address is claimed and the JobCard still starts. This threshold controls only
whether Phase Q requests an approximate address. Eligibility and accuracy
rules for future geographic reports are a separate report-design decision and
are not established by Phase Q.

## 7. Persistence Model

Add an append-only JobCard child record associated with exactly one persisted
`JOB_STARTED` activity:

```text
job_action_locations
  id
  organization_id
  job_card_id
  activity_id
  actor_user_id
  action = JOB_STARTED
  capture_outcome = CAPTURED | UNAVAILABLE
  failure_reason nullable
  latitude nullable
  longitude nullable
  accuracy_meters nullable
  captured_at nullable
  geocoding_status = NOT_REQUESTED | RESOLVED | FAILED
  neighborhood nullable
  district nullable
  city nullable
  approximate_label nullable
  created_at
```

Database checks enforce the captured/unavailable field sets. Tenant-safe
composite foreign keys bind organization, JobCard, activity, and actor.
`activity_id` is unique so one start activity cannot acquire duplicate location
rows. Coordinates use fixed precision and never appear in logs or SSE payloads.

The location row is not a mutable column on `job_cards`; it is evidence tied to
the action that produced it. Public JobCard summary/list DTOs remain unchanged.

## 8. Transaction and Idempotency Boundary

```text
Staff click
  -> one browser getCurrentPosition attempt
  -> normalized captured/unavailable envelope
  -> existing start command and existing clientActionId
  -> completed-action lookup; return stored result if already committed
  -> optional bounded reverse-geocoding lookup before DB transaction
  -> one DB transaction:
       lock/idempotency claim
       validate transition/version/actor
       transition to IN_PROGRESS
       append JOB_STARTED activity
       append one location outcome linked to that activity
       append existing realtime ledger event
     commit
  -> publish existing invalidation after commit
  -> canonical REST refresh
```

No external HTTP request runs while the database transaction is open. If
reverse geocoding times out or fails, coordinates are persisted with
`geocoding_status=FAILED`; the start command continues. An unavailable capture
skips geocoding.

Before calling the reverse geocoder, the service performs a cheap lookup for an
already completed critical action with the same actor, action kind, and
`clientActionId`. A completed retry returns its stored result without sending
coordinates to the provider again. The transaction's existing critical-action
claim and row locking remain the final concurrency defense; simultaneous first
requests may both reach the provider, but only one may commit the transition,
activity, and location row.

The same `clientActionId` therefore does not create a second activity or
location row. A transport retry reuses the same capture envelope and does not
call browser geolocation again. The UI also uses a synchronous pending gate
before awaiting geolocation.

## 9. Reverse-Geocoding Boundary

Reverse geocoding is server-owned behind a narrow `ReverseGeocoder` port. The
browser never contacts the provider and never receives provider credentials.
Only latitude, longitude, accuracy, and a request correlation identifier may be
sent; no JobCard, customer, contact, actor, or organization data is included.

Provider integration and production enablement require approval of the
provider, regional endpoint, data-processing terms, timeout, rate limit,
production credential storage, request-log retention, subprocessors,
cross-border transfer status and mechanism, response storage/licensing and
cache terms, and deletion/data-subject-request obligations. Provider responses
are mapped to Servora-owned nullable `neighborhood`, `district`, `city`, and
`approximateLabel` fields. Raw provider responses are not persisted.

## 10. Authorization and Presentation

- Write: only the existing backend-authorized Staff `START` command path.
- Read: only users already authorized to read that JobCard's activity history.
- Staff see location only on JobCards they may already read.
- Admin/Manager see it only within their organization and existing JobCard
  access boundary.
- No organization-wide raw-coordinate endpoint is introduced.
- SSE carries only existing entity/resource invalidation metadata; it never
  includes coordinates, address, accuracy, or failure reason.

The activity presenter gains a typed location presentation attached to
`JOB_STARTED`. Captured locations show approximate address when available,
accuracy radius, capture time, and actor. Unavailable locations show
`Konum alınamadı` plus a Turkish presentation of the normalized reason.

## 11. Retention and Deletion

No retention period is approved in Phase Q. A concrete maximum period or an
exact reference to an approved organizational retention policy is deferred to
the privacy/documentation work under Settings or the user profile. Phase Q may
build and test the storage contract with non-production data, but production
location capture remains disabled until that policy is recorded and its
deletion consequences are implemented or explicitly covered by an existing
audited JobCard deletion process.

The schema remains append-only and tied to JobCard activity; Phase Q does not
invent a self-delete endpoint or silently treat an unspecified period as
indefinite retention.

## 12. Failure Semantics

| Condition | Stored outcome | Job starts? |
| --- | --- | --- |
| Permission denied | `UNAVAILABLE / PERMISSION_DENIED` | Yes |
| Browser unsupported | `UNAVAILABLE / UNSUPPORTED` | Yes |
| Timeout | `UNAVAILABLE / TIMEOUT` | Yes |
| Device/provider unavailable | `UNAVAILABLE / POSITION_UNAVAILABLE` | Yes |
| Unknown browser error | `UNAVAILABLE / UNKNOWN` | Yes |
| Low accuracy | coordinates + radius, no address claim | Yes |
| Reverse-geocoder failure | coordinates + `FAILED` | Yes |
| Invalid/tampered payload | `400 VALIDATION_ERROR` | No |
| Version/transition conflict | existing canonical error/refresh | No |

## 13. Test Contract

Server tests prove validation, tenant-safe constraints, one-to-one activity
linkage, Staff-only start authorization, captured/unavailable persistence,
low-accuracy behavior, geocoder failure fallback, transaction rollback,
idempotent replay, no provider call for a completed `clientActionId`, no public
list DTO change, and no location in SSE/logs.

Web tests prove capture occurs only after the click; allow, deny, timeout,
unavailable browser, double click, request retry, stale-version refresh,
pending labels, notice text, and history presentation. Browser/manual testing
covers current Chrome and real Safari for allow/deny/timeout and verifies that
no request occurs at login or page load.

## 14. Acceptance Criteria

1. Only an assigned Staff user's explicit `İşi başlat` click attempts capture.
2. Location failure cannot deadlock a valid start transition.
3. One committed start activity has exactly one captured or unavailable outcome.
4. Retry and duplicate clicks create no duplicate transition, activity, or row.
5. Location is visible only through existing authorized JobCard history.
6. Coordinates remain canonical and address metadata is explicitly approximate.
7. No sensitive location data enters SSE payloads, application logs, list DTOs,
   or browser-to-provider calls.
8. Completed-action retries do not call the reverse-geocoding provider again.
9. Production capture cannot be enabled before the privacy/retention policy and
   provider/data-transfer review are approved.

## 15. Design Review and Enablement Gates

Runtime implementation may start only after reviewers approve the technical
design, including:

- the 1,000 metre threshold solely for requesting an approximate address;
- authoritative server time versus client-claimed `capturedAt`;
- the completed-action lookup before reverse geocoding and the transactional
  claim as the final concurrency defense;
- non-blocking capture and reverse-geocoder failure behavior.

Production location capture must remain disabled until all of these are
approved and recorded:

- the full employee/user location disclosure and its link from the action;
- a concrete maximum retention period or an exact approved policy reference;
- the reverse-geocoding provider checklist in section 9;
- any required deletion/export process for the approved policy.

Servora-Med not being publicly accessible does not remove these enablement
gates: the captured data still concerns identifiable Staff users. Legal basis
and final wording require review by the organization's authorized privacy/KVKK
owner; this design does not make that legal determination.

## 16. Deferred Product and Policy Work

A later, separate slice may add a governed documents area under Settings or the
user profile for:

- the user manual;
- employee/user notices and location disclosure;
- privacy and retention texts;
- other organization-specific policy documents.

That surface is not a generic file store in Phase Q. Its ownership, authorized
editor, version/effective-date rules, publication workflow, and acknowledgement
requirements require a separate product design.
