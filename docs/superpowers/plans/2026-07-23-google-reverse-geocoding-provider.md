# Google Reverse Geocoding Provider Plan

**Status:** Implementation plan for a default-off, budget-guarded Google
Geocoding API v4 reverse-geocoding adapter.

**Date:** 2026-07-23

**Related:** `docs/superpowers/specs/2026-07-21-action-scoped-geolocation-design.md`

## Provider decisions

| Decision | Value |
| --- | --- |
| Provider | Google Geocoding API v4 |
| Direction | reverse geocoding only |
| Execution | server-side only |
| Endpoint | fixed Google v4 endpoint (`https://geocode.googleapis.com/v4/geocode/location`) |
| Authentication | `X-Goog-Api-Key` header (never query string) |
| Language | `tr` |
| Region | `TR` |
| Timeout | 2_000 ms (AbortController; no automatic retries) |
| Automatic retries | 0 |
| Maximum browser accuracy for provider call | 1_000 m |
| User daily budget | 15 |
| Organization daily budget | 250 |
| Global monthly budget | 8_000 |
| Production flag | `ACTION_SCOPED_GEOLOCATION_ENABLED=false` |

## Runtime safety

* Provider runs only on the server. Browser never sees the API key.
* Endpoint is fixed in code; it is not configurable via environment.
* Quota reservation is atomic in PostgreSQL and happens before any Google call.
* Quota is never refunded after a successful reservation (conservative cost accounting).
* Provider failure, quota denial, low accuracy, and unavailable capture never
  block JobCard start.
* External HTTP is never performed while a JobCard domain transaction is open.
* Completed `clientActionId` replay and organization-scoped START preflight
  short-circuit before quota or provider I/O.

## Open risks (must remain visible)

* Google billing accounts that host other projects may consume the same free
  tier pool outside Servora-Med application counters.
* Two truly concurrent first requests with the same `clientActionId` may each
  reserve quota under the current critical-action design before one claim wins.
* Quota counters are conservative: if the process crashes after reservation and
  before or during the Google call, the used count is not refunded.
* Google structured-address storage and cross-role visibility conditions need
  explicit production approval before enablement.
* Attribution wording/visual treatment needs policy review before production.
* Geolocation retention / KVKK employee disclosure remains a production gate.

## Production enablement gates

Do not set `ACTION_SCOPED_GEOLOCATION_ENABLED=true` in production until all of
the following are approved:

* API key restricted to Geocoding API only
* Production static outbound IP restriction
* Google Cloud daily quota = 300
* Application global monthly limit = 8000
* Billing budget alerts
* Google attribution review
* Google structured-address storage/caching review
* Staff / Manager / Admin visibility review for provider-derived addresses
* KVKK employee location disclosure
* Exact retention period
* Deletion/export consequences
* Settings/profile full disclosure surface
* Production log review
* Real staging acceptance
* Explicit owner enablement approval

## Staging notes

Staging acceptance uses deliberately low application limits and a Google Cloud
daily quota of 20. After acceptance, restore the staging flag to false.

This document must not contain API keys, real coordinates of customers, or
real customer identifiers.
