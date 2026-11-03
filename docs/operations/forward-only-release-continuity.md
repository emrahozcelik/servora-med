# Forward release continuity (post-recovery and accepted releases)

Status: **implementation, targeted contract/unit tests, and the real
`FHOST-CONT-01` systemd socket-activation handoff on the disposable guest PASS.
Production authorization, tool installation, collector switch, start gate,
observation and deployment remain a separate, explicitly approved operation.**

This document owns the transition after a forward attempt ended without
acceptance (recovery `FORWARD_TARGET_POLICY_RESTORED_NOT_ACCEPTED`) and every
later `060 -> 060` release. It does not rewrite the sealed R4/Emergency history,
the first forward journal, or the recovery journal.

## 1. Why a new authorization kind

The legacy `FORWARD_TRANSITION_AUTHORIZATION` (v2) binds `old` to the sealed R4
release (`f5f87d4…`) through `receipt.host.releaseSha` and
`parent.approval.releaseSha`. After recovery the live release is the first
forward TARGET (`c8efe8a…`), so a v2 grant can never admit it. The legacy checks
stay untouched; a new kind carries the extra lineage.

```text
kind: RELEASE_CONTINUITY_AUTHORIZATION
formatVersion: 1
scope: RELEASE_CONTINUITY_TRANSITION
```

It has the same `parent`, `old`, `target`, `host`, `migration`, `budgets`,
`actions`, `forbidden`, `issuedTime` and one-use window fields as v2, plus
`lineage`.

## 2. Lineage

Common fields:

```text
type                              RECOVERY | ACCEPTED
predecessorAttemptId
predecessorAuthorizationSha256
predecessorToolHash
predecessorJournalHeadSha256
predecessorTerminalPhase
predecessorReleaseSha
predecessorArtifactSha256
predecessorCollectorModuleSha256
predecessorCollectorPath
```

`RECOVERY` additionally binds:

```text
recoveryAuthorizationSha256
recoveryJournalHeadSha256
recoveryReceiptSha256
recoveryOutcome = FORWARD_TARGET_POLICY_RESTORED_NOT_ACCEPTED
```

`ACCEPTED` additionally binds `acceptanceContractSha256` and requires terminal
phase `ACCEPTED`, `HANDOFF_DONE` and `RETIRE_DONE`, with no recovery journal.

The host verifies the predecessor authorization bytes from
`forward/<attemptId>/authorization.json`, the predecessor tool manifest, the
predecessor journal hash chain, the COLLECTOR/START/PRE/POST evidence, the
recovery journal and receipt (or the sealed acceptance), the live release and
artifact, and the installed collector module bytes. A missing, changed,
unfinalized, forked or contradictory predecessor fails closed.

**Authorization preservation:** every continuity attempt writes its exact
authorization bytes to `forward/<attemptId>/authorization.json` at OWNER. The
one-time `preserve-forward-authorization` operator command does the same for the
existing `c8efe8a` attempt before a successor grant replaces the top-level
`forward/authorization.json`; it verifies SHA-256 and never rewrites history.

## 3. Versioned tool directory

The live tool `/usr/local/libexec/servora-med-forward` is never replaced. New
continuity-capable tools are installed at:

```text
/usr/local/libexec/servora-med-forward-tools/<toolManifestHash>/
```

The adapter resolves its own directory from `import.meta.url`, requires the
directory name to equal the manifest hash, and uses that directory for the
start gate, ExecStartPre, probe child, collector drop-in and target file
comparison. The legacy fixed directory and its manifest remain byte-identical.

The Trusted Time module contract accepts only the fixed legacy path, the fixed
forward path, or
`/usr/local/libexec/servora-med-forward-tools/<64-hex>/trusted-time.mjs`.

## 4. Collector handoff

Before `COLLECTOR_DONE` the live collector keeps using the predecessor module
(sealed legacy for v2, or the predecessor versioned tool for continuity). The
adapter samples through that exact module and verifies its hash before and
after.

At `COLLECTOR_INTENT` (inside `ACTIVATE_INTENT`, with OLD stopped and the
admitted owner/barrier/DB proof):

1. Verify the new tool's `trusted-time.mjs` equals the TARGET release module.
2. If the drop-in already contains the new text, reuse it; if it contains the
   predecessor text, write a root-only temp file, `fsync`, `rename` over
   `90-servora-forward-time.conf`, and `flushDirectory`.
3. `systemctl daemon-reload` when the text changed or the unit still needs it.
4. Wait the full `COLLECTOR_DRAIN_MS = 4500 ms` (socket instances are bounded by
   `RuntimeMaxSec=3` + `TimeoutStopSec=1` = 4000 ms), including on a resumed
   `COLLECTOR_INTENT`.
5. Re-verify the module hash and the collector binding; only then append
   `COLLECTOR_DONE` with `{moduleSha256, dropinSha256, collectorUid}`.

An interrupted handoff is reconciled by re-running the idempotent COLLECTOR
effect: the drop-in is either predecessor or target (never partial), the drain
is repeated, and the receipt is sealed only after the binding and target module
hash match. There is no rollback and no second handoff.

### 4.1 FHOST-CONT-01 evidence (disposable guest)

`FHOST-CONT-01` ran on the existing disposable `servora-eh-20261101` guest
(hostname `lima-servora-r4-20261012`, systemd 255, Node 22.23.4, PostgreSQL 17),
not on production. It installs the versioned tool under
`/usr/local/libexec/servora-med-forward-tools/<hash>/` and uses the real
`servora-med-time-evidence.socket`/`@.service` template with
`RuntimeMaxSec=3` and `TimeoutStopSec=1`.

| Scenario | Result |
| --- | --- |
| `FHOST-CONT-01A` predecessor in flight, atomic drop-in, daemon-reload, 4500 ms drain | PASS |
| `FHOST-CONT-01B` foreign drop-in, altered/missing target module | PASS (fail-closed) |
| `FHOST-CONT-01C` interrupted during drain, resume/reconcile | PASS |
| `FHOST-CONT-01D` interrupted after rename, before daemon-reload | PASS |

Key A-run values:

```text
predecessor module path   /usr/local/libexec/servora-med-forward/trusted-time.mjs
predecessor module SHA-256 a0c41b8035e29b671e33eb818b465fccb612809ce433e00f4cfc5fc67e22e40f
target module path        /usr/local/libexec/servora-med-forward-tools/56ca585f…/trusted-time.mjs
target module SHA-256     d28fb396527bf91a25ab73fd8dd4f5f3138e2279efc1c6414cdf0d44d93717ab
old unit lifetime         3128.869 ms (inside 3000 + 1000 ms)
seal after daemon-reload  4504.322 ms
effective ExecStart       --no-addons .../servora-med-forward-tools/56ca585f…/trusted-time.mjs --collect-chrony
```

The predecessor process stayed alive with its original argv across the
`daemon-reload`; a new connection started on the target path; the predecessor
was gone before the drain ended. The resumed C/D runs produced exactly one
`COLLECTOR_INTENT` and one `COLLECTOR_DONE`, no observation, no new start slot,
and unchanged grant bytes. C resumed to `COLLECTOR_DONE` in 16.3 s; D in 15.9 s.
The raw JSON is retained at `parent-backup-bound-release/fhost-cont-01/`.

The real `ExecStartPre` start gate and the 1,800-second observation were **not**
part of this collector test. The start gate's NTS sample depends on the guest's
live chrony source set and is a separate production activation condition. This
result closes the collector-handoff gate only; it does **not** authorize a
production transition.

## 5. First continuity preparation (c8efe8a)

Production is not authorized in this change. When separately approved, the
operator (under the canonical host lock) runs:

```text
node /path/to/preserve-forward-authorization.mjs \
  --attempt-id 4df13264-7a36-4b7b-aad9-cec9f290fa31 \
  --expected-sha256 086f359d818aac74521d11822e50e4bc3b17602ba2514d63b5692cfd2d1ca905
```

The command copies the exact top-level grant to
`forward/4df13264-…/authorization.json`, refuses a changed hash or an existing
different copy, and does not touch the deployment/recovery journals. After
that, the continuity grant can bind the predecessor authorization SHA.

## 6. Future releases

An accepted continuity attempt has a terminal `ACCEPTED` journal with HANDOFF
and RETIRE done. The next grant uses `lineage.type: ACCEPTED` and
`acceptanceContractSha256`; every subsequent `060 -> 060` release uses the same
code path and one new single-use grant. No per-release bespoke mechanism.

## 7. Boundaries

- No migration; catalogs must be identical 060.
- No R4/Emergency/forward/recovery record is edited, resealed or re-used.
- No rollback, observation retry, start-budget reset or release-authority
  inheritance from the recovery receipt.
- No production SSH, tool install, collector drop-in change, grant issuance,
  service restart or observation is performed by this change.
