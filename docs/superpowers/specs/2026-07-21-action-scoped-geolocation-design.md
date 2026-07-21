# Servora-Med Action-Scoped Browser Geolocation Design

**Status:** Proposed — runtime implementation is blocked until design review,
retention wording, and reverse-geocoding provider approval are complete.

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

The Staff action surface shows static informational text near `İşi başlat`:

> İşi başlatırken cihazınızdan yaklaşık konum alınmaya çalışılır. Konum
> alınamazsa iş yine başlatılır.

This is a notice, not a consent gate. The button click immediately starts one
browser request. While location and command work are pending, the existing
button is disabled and its accessible pending label explains the current step.
The application does not preflight with the Permissions API because browser
support differs and preflight does not replace the native prompt.

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
`[-180, 180]`, positive accuracy, canonical ISO capture time, exact fields,
and the discriminated outcome. Invalid payloads receive `400`; a legitimate
unavailable outcome remains a valid start command.

Browser coordinates are user-device claims. Backend validation protects data
shape and bounds, not physical truth.

## 6. Accuracy Policy

The UI displays the browser-reported radius, for example:

```text
Konum: Kızılay Mahallesi, Çankaya / Ankara
Doğruluk: yaklaşık 32 metre
```

`accuracyMeters` is the Geolocation API's approximately 95% confidence radius;
it is not a percentage and does not mean the address is 95% correct.

Proposed pilot threshold: coordinates with `accuracyMeters <= 1,000` may be
reverse-geocoded and used in future area aggregation. Less precise captures are
still retained with their radius and shown as `Düşük doğruluk`; no approximate
address is claimed and the JobCard still starts. This threshold requires
explicit design-review approval before runtime work.

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

The same `clientActionId` returns the established completed action result and
does not create a second activity or location row. A transport retry reuses the
same capture envelope and does not call browser geolocation again. The UI also
uses a synchronous pending gate before awaiting geolocation.

## 9. Reverse-Geocoding Boundary

Reverse geocoding is server-owned behind a narrow `ReverseGeocoder` port. The
browser never contacts the provider and never receives provider credentials.
Only latitude, longitude, accuracy, and a request correlation identifier may be
sent; no JobCard, customer, contact, actor, or organization data is included.

The provider, data-processing terms, regional endpoint, timeout, rate limit,
and production credential storage must be approved before runtime
implementation. Provider responses are mapped to Servora-owned nullable
`neighborhood`, `district`, `city`, and `approximateLabel` fields. Raw provider
responses are not persisted.

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

Proposed policy: location evidence has the same lifecycle as its JobCard and
immutable activity history. Phase Q adds no independent TTL, background purge,
or user self-delete endpoint. Any future organization-level retention/deletion
workflow must delete location rows through the same audited JobCard policy and
respect foreign-key order.

This inherited-retention wording requires explicit product/privacy approval in
design review. Production enablement remains blocked until that approval is
recorded; an unspecified indefinite retention period is not silently assumed.

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
idempotent replay, no public list DTO change, and no location in SSE/logs.

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
8. Retention wording and reverse-geocoding provider are approved before runtime.

## 15. Design Review Gates

Runtime implementation must not start until reviewers explicitly approve:

- the 1,000 metre reverse-geocoding/report threshold;
- retention matching JobCard/activity history;
- the employee-facing notice text;
- the reverse-geocoding provider, data-processing terms, regional endpoint,
  timeout, rate limit, and production credential handling.
