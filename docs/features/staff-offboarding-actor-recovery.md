# OF-09 — Actor-scoped offboarding recovery

Scope: the explicitly authorized OF-09 browser recovery defect. This changes no
backend command, receipt, authorization, schema migration, terminal boundary,
WeeklyReport rule or OF-01 assignment behavior. Production remains NO-GO.

## Identity and lifecycle

Authenticated `CurrentUser.id` and `organizationId` flow from AppRouter through
the user detail screen/view to the workflow. No actor identity is inferred from
the target Staff, role or persisted data. Identity must exist before hydration.

The former global sessionStorage key `servora:r4b:staff-offboarding-attempt:v1`
is retained only as an untrusted legacy sentinel. New keys append the encoded
organization id and actor id, in that order. Target is deliberately not part of
the key: an unresolved attempt for another target of the same actor still blocks
new work in that tab. Different actors cannot hydrate, replay, overwrite, retire
or clear each other's application recovery intent.

Schema 3 adds `actorId` and `organizationId` to the existing exact record:
`schemaVersion`, `status`, `targetUserId`, `request`, `createdAt`. Request parsing
remains strict. Hydration verifies both identity fields against the authenticated
viewer, then verifies target identity. Before each execute, the persisted ACTIVE
record must still match the target and complete request, including clientActionId.
Retirement/clear recheck ownership and exact intent; only RETIRED can be cleared.
The ACTIVE → RETIRED → CLEAR lifecycle and deterministic/ambiguous HTTP handling
remain unchanged. Storage read/write/remove failures never authorize an execute
or discard. An authoritative success remains final even when local cleanup fails;
the retained owned intent/marker can be safely revisited by the same actor.

Workflow state is keyed by organization/actor/target. Layout-effect cleanup
invalidates the old instance before late execute/preview results can retry,
update UI, invoke completion or touch storage. Returning to the same actor reads
the preserved exact intent. Backend still independently authenticates and scopes
every request; browser namespacing is not a confidentiality or security boundary
against arbitrary same-origin JavaScript/storage manipulation.

## Legacy and corrupt records

Any value at the old global key, including schema 2 ACTIVE/RETIRED or malformed
JSON, blocks new offboarding and shows a safe integrity/identity warning. The
value is not migrated, attached to the current actor, retried or removed. Invalid
records at the current scoped key behave the same way; another scope is untouched.

This deliberately can leave that tab's offboarding blocked. The UI cannot prove
who initiated a legacy request or whether it committed. Authorized read-only
receipt/audit investigation must first establish the outcome and original actor.
A separate reviewed recovery/cleanup procedure is needed before discarding or
reattributing an unresolved record; this slice adds neither that procedure nor a
bypass button. Closing the tab, clearing browser data or inventing a new action id
must not be recommended as recovery while the outcome is unknown.

## Verification

Focused workflow tests cover same-actor recovery, A/B/A preservation, organization
and target isolation, legacy/corrupt records, exact-intent revalidation, storage
failures and late success/error results after identity changes. Existing conflict,
WeeklyReport and terminal tests remain binding.

`web/scripts/of09-actor-recovery-browser.mjs` uses disposable PG17 and the real
compiled Fastify server. Each profile owns a fresh schema/API so real auth rate
limits remain unchanged. Chromium or headed Chrome, Vite or built frontend,
desktop/mobile and both motion preferences exercise pre-dispatch loss,
post-commit response loss and delayed post-commit response during logout/login.
SQL asserts one completed actor-scoped receipt and one offboarding audit; actual
cross-organization and manager requests are refused. Keyboard, legacy warning,
200% text and 320px reflow captures accompany synthesized mobile touch. Physical
mobile devices and assistive screen-reader output are not claimed.

Execution results, failed attempts, SHA/tree binding, full builds/tests, Local CI
27/27, verifier and preservation evidence belong to the external OF09 reports.
This contract does not label unexecuted release gates PASS or authorize deployment.
