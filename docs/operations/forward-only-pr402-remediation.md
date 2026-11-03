# PR #402: trusted grant admission and CI remediation

Scope: remediate the HIGH and CI failures reported against `edb6b302` / tree
`b99fd644`, with targeted tests. This is not release authorization or an
independent approval of the new tree. The owner prohibited subagents; final
independent source review remains open.

## Grant version 2 and time boundaries

Forward grants now require `formatVersion: 2` and the actual TT-A v2
`issuedTime` sample. Its UTC timestamp, floored to seconds, must equal
`issuedAtUTC`; the complete sample retains its milliseconds. The existing
maximum 24-hour UTC window is unchanged. Wall-only forward grants are refused,
including if their wall clock appears inside the old window.

Both issuance and current samples must satisfy the existing authenticated
quorum, source/config identity and time-quality thresholds. `elapsedTime()`
must establish consistent UTC and conservative elapsed bounds in the same
boot and time namespace. With `E` as expiry UTC and `I` as the sample's actual
issuance UTC, the conservative boottime deadline is:

```text
deadline = issuedTime.bootLowerMs + (E - I)
```

The current sample's upper bound must be strictly below that deadline. The real
root reader additionally checks the live kernel boot, namespace, uptime upper
bound and UTC at publication. Kernel boottime only vetoes authority; it never
substitutes for a KNOWN TT-A sample. UTC also remains a veto.

Fresh evidence is required for new admission, immediately after the
pre-publication checks, before START_INTENT, before arming the root start
permit, and in the actual systemd ExecStartPre consumer. ExecStartPre checks
the live deadline again after durable slot publication. If publication crosses
expiry, the receipt remains spent and candidate code is denied. No timeout,
unknown outcome, crash or reboot can reset that slot.

`admissionTime` and START_INTENT's `authorizationTime` are part of the journal
hash chain. The permanent gate receipt contains `authorizedTime`, bound by its
existing intent/grant/invocation identity and START_DONE receipt digest. Known
activation reconciliation validates that historical time sample; it does not
request new START authority. Status, consumed replay, separate failure recovery
and accepted terminal handback retain their existing boundaries when the
original grant expires or time becomes UNKNOWN.

## Collector phase and sealed history

Before COLLECTOR_DONE, the adapter verifies the old profile's exact installed
time-module hash and reads through that sealed module's existing sampler. The
sampler supplies time evidence only. New deployment policy is evaluated solely
by the forward contract and root adapter. No legacy deployment entrypoint gains
new authority.

After handoff, the adapter and ExecStartPre use the manifested forward sampler.
The existing effective ExecStart/UID/sandbox/socket checks remain mandatory;
the root reader checks collector binding around sampling. There is no clock
override, cached UNKNOWN fallback or fixture sampler in the production CLI.

No change was made to `trusted-time.mjs`, its quality thresholds, sealed R4
modules/profile/history, the original emergency handoff or the migration-free
060→060 constraint. Synthetic grant files and prepared journals exist only in
the positively identified disposable test guest.

## CI failures

The temporary deployment fixture is a local main repository. It now supplies
`GITHUB_REF=refs/heads/main` explicitly, so the enclosing PR's
`refs/pull/.../merge` cannot preempt its evidence/transfer assertions. A separate
negative test explicitly supplies a PR ref and proves that the production
NON_MAIN_WORKFLOW_REF gate still denies it. Production deployment code was not
weakened.

The CRM index-plan fixture formerly inserted 50,000 committed contacts on the
same customer used by later tests. A timed-out asynchronous callback can remain
in flight while those tests start. A deterministic regression holds that
oversized fixture before cleanup and reproduces the unexpected 422. The fixture
now uses a dedicated customer and connection inside a rollback-only transaction;
its rows remain invisible even during delayed cleanup. Setup is inside the
try/finally, the client is always released, and each fixture statement has a
10-second limit. The heavy index test has a bounded 30-second harness budget;
product query/request limits and evidence caps are unchanged. The index-plan
assertion is retained. This reproduces and closes the contamination mechanism;
the original hosted run had no DB timing trace proving exactly when it occurred.

The web job is pinned to Ubuntu 24.04, which the locked Playwright 1.55.1 supports
for Chromium/WebKit and OS dependencies. No dependency/lockfile upgrade or
application change was needed. The unsupported 26.04 dry-run has no download
URLs; the 24.04 dry-run resolves all requested browser artifacts. A dry-run is
not a browser installation or smoke test. Forward contract/adapter regression
tests are now explicitly included in GitHub CI, as they already are in Local CI.

## Targeted verification

Final targeted results on the remediated source:

| Check | Result |
| --- | --- |
| Forward contract/adapter/recovery, TT-A, restricted reader, trusted approval and emergency regressions (8 files) | **195/195 PASS** |
| Both affected server test files, canonical Node22/PG17 preflight and inherited PR context | **32/32 PASS** |
| New disposable Linux/amd64, systemd255/PG17 time-boundary scenarios | **3/3 PASS**, incremental selection then final source run |
| Server build / web build | **PASS / PASS** |
| Playwright1.55.1 Ubuntu24.04 artifact resolution | **PASS**, dry-run only |
| Full host acceptance / 27-check Local CI / genuine NTS-browser-1800s observation | **NOT_RUN** |

RED→GREEN was observed for UNKNOWN admission, elapsed expiry despite wall
rollback, crash-before-START expiry, pre-publication time loss, expiry between
sampling and publication, malformed UTC windows, PR-ref fixture failures and
the in-flight CRM contamination regression. The first expanded server run used
an incorrect PATH separator in the temporary helper, selecting Node26 for its
child shell. That environment error was corrected; the isolated Node22 transfer
control and then all 32 tests passed. It was not treated as a product failure.

The server command uses the same canonical entrypoint as `npm test`:

```sh
node --env-file-if-exists=.env scripts/run-tests.mjs --run \
  tests/crm-duplicate-postgres.test.ts tests/local-evidence-deploy-gate.test.ts
```

It ran with an explicit password-bearing loopback TEST_DATABASE_URL in a newly
created `servora_med_test_pr402_review_<suffix>` PG17 cluster, matching client
tools, fresh build and migration060. The cluster, data, socket and fixture
password were removed after the tests; no existing database was reused.

Host tests are
selected by `--test-name-pattern=FWTIME-...`; they are not the existing full host
suite. The FWTIME-03 journal is explicitly generated with synthetic ports to
prepare a real systemd ExecStartPre denial test. It is not evidence that backup,
OLD stop, pointer alignment or a positive KNOWN activation passed on this tree.
The actual consumer uses its real restricted sampler; stopping Chrony in the
disposable guest produces UNKNOWN and denies two start attempts without a slot
receipt or a second START_INTENT. Chrony and the healthy fixture OLD release are
restored afterwards, and sealed parent/emergency bytes are checked unchanged.

```text
FORWARD_GRANT_TIME_REMEDIATION=TARGETED_TESTED
TT_A_FINAL_REVIEW=PENDING_INDEPENDENT_REVIEW_OF_NEW_HEAD
FULL_HOST_ACCEPTANCE=NOT_RUN
FULL_LOCAL_CI=NOT_RUN
GENUINE_NTS_BROWSER_1800S_OBSERVATION=NOT_RUN
PRODUCTION_DEPLOYMENT=NOT_AUTHORIZED
PRODUCTION_GO=false
```

Full host acceptance remains **STOP** until the new source is independently
reviewed. Positive host activation with genuine KNOWN TT-A, the full interruption
matrix on this new tree, genuine browser/1800-second observation and exact-main
Local CI remain separate acceptance work. Earlier 18/18 host and two-reboot
results are historical; they were not rerun or automatically approved here.
GitHub's actual checks for the published SHA must be read separately; local
targeted PASS does not convert the failed baseline run into CI success.
