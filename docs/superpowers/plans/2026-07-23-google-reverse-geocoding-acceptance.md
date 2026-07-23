# Google Reverse-Geocoding Staging Acceptance

**Date:** 2026-07-23
**Final classification:** PARTIAL (core cases PASS; controlled egress failure and Console metric propagation require operator follow-up)

## Environment

| Field | Value |
| --- | --- |
| Branch under test | `fix/google-reverse-geocode-tolerant-components` (fix on top of merged PR #50 / `main`) |
| Base merge | PR #50 merge commit `89b9a02` |
| Database | Isolated local PostgreSQL `servora_med_geo_staging` (not production) |
| Migration | `001`–`016`; latest `016_google_reverse_geocoding` |
| Google Cloud project alias | operator-managed (not recorded) |
| Application staging limits | user/day `2`, org/day `3`, global/month `5` |
| Google daily quota target | `20` (operator Console setting) |
| API restriction status | operator-managed (Geocoding API only expected) |
| Key restriction status | operator-managed |
| Secret values | **none recorded** |

Notes:

* Staging used synthetic organization/users/jobs only (`GEO Staging Org A/B`, `GEO-STAGING-0x`).
* Coordinates and full address strings were not written to this document.
* Approximate labels are recorded only as class (`Ankara-class`).
* Agent did not open or print `server/.env` or the API key.

## Happy path

| Field | Result |
| --- | --- |
| Result | PASS |
| Job started | yes → `IN_PROGRESS` |
| Geocoding status | `RESOLVED` |
| Provider | `GOOGLE` |
| Approximate label class | Ankara-class |
| Attribution DTO | `geocodingProvider=GOOGLE` with non-null approximate label (UI text: `Adres verisi: Google Maps`) |
| Google request delta | not operator-confirmed in Console (DB proof: provider reserved + RESOLVED) |
| Quota after first success | `GLOBAL_MONTH=1`, `ORGANIZATION_DAY=1`, `USER_DAY=1` |

## Replay

| Field | Result |
| --- | --- |
| Result | PASS |
| Second provider call | no (completed `clientActionId` short-circuit) |
| Quota delta | none |
| Duplicate activity/location | none (`JOB_STARTED` count `1`, location count `1`) |

## Low accuracy

| Field | Result |
| --- | --- |
| Result | PASS (`accuracy > 1000`) |
| Job started | yes |
| Provider call | no |
| Quota delta | none |
| Geocoding status | `NOT_REQUESTED` |
| Provider column | `null` |
| Attribution | absent |

## User limit

| Field | Result |
| --- | --- |
| Result | PASS |
| Config | `GEOCODING_USER_DAILY_LIMIT=2` |
| After two eligible | `USER_DAY=2` with RESOLVED rows |
| Third eligible | job starts; `FAILED`; provider `null`; no address; buckets stay at 2 / no partial org-global increment |

## Organization limit

| Field | Result |
| --- | --- |
| Result | PASS |
| Config | `GEOCODING_ORG_DAILY_LIMIT=3` |
| After staff B eligible | `ORGANIZATION_DAY=3` |
| Next eligible in same org | job starts; provider not called; org remains `3`; no partial increments |

## Global limit

| Field | Result |
| --- | --- |
| Result | PASS |
| Config | `GEOCODING_GLOBAL_MONTHLY_LIMIT=5` |
| After second org success path | `GLOBAL_MONTH=5` |
| Next eligible | job starts; provider not called; global remains `5`; no partial increments |

## Provider failure

| Field | Result |
| --- | --- |
| Result | BLOCKED — controlled egress failure unavailable |
| Method | not executed (no API key invalidation; no host firewall change) |
| Note | Prior buggy mapping path produced safe `FAILED` + retained quota without blocking job start; that is not a substitute for a controlled timeout test |

## Privacy

| Field | Result |
| --- | --- |
| Log review | PASS — no API key, no `X-Goog-Api-Key`, no coordinate literals, no approximate-address fields in server log buffer scan |
| Database review | PASS — location rows store status/provider/label class only in reports; coordinates not exported to acceptance record |
| Bundle review | not re-run as part of this live API pass; covered by focused package validation after fix |

## Mapping defect found and fixed during acceptance

Initial live Google response returned HTTP 200 but the first result included an address component without `types` (common for POI/establishment place names). The adapter treated that as `INVALID_RESPONSE` and forced `FAILED` even though typed neighborhood/district/city components were present.

Fix:

* skip incomplete components instead of rejecting the whole payload;
* walk results until a mappable approximate label is found.

Focused adapter unit test added for the POI-without-types component shape.

## Google Console

| Field | Value |
| --- | --- |
| Request count before/after | operator confirmation pending |
| Daily quota | operator expected `20` |
| Cost | operator confirmation pending |
| Metric propagation | PENDING METRIC PROPAGATION (not guessed) |

## Post-acceptance

| Field | Expected / status |
| --- | --- |
| `ACTION_SCOPED_GEOLOCATION_ENABLED=false` | **operator must restore** in local `.env` after acceptance |
| Limits restored to production defaults (15/250/8000) | **operator must restore** |
| Production enabled | **no** |
| Production policy gates | still closed (attribution/KVKK/retention/billing review) |

## Final classification

```text
Staging acceptance: PARTIAL
Implementation (core happy path after mapping fix): completed
Production enablement: still blocked
ACTION_SCOPED_GEOLOCATION_ENABLED: must remain false outside controlled staging
```

PARTIAL reasons:

1. Controlled network timeout / egress failure not executed.
2. Google Console request delta and cost not operator-confirmed in this record.
