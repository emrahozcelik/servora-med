# Issue #369 — corrected multi-NTS source change plan

Status: source implementation only; PRODUCTION_GO=false; Issue #369 OPEN.

This source-controlled revision supersedes the proposal (not the immutable raw
lab evidence) in the retained `issue369-b2-multisource-20261029T193915Z-823af7f8`
bundle. The original reports and 111-file evidence manifest remain unchanged.

OPS-TT-003 and `ops/chrony/servora-med.conf.example` own the final policy/config.
Use authselectmode require with three independently operated NTS sources and
explicit UME noselect. Do NOT add NTS trust/require flags. Candidate-b used NTS
COpts/EOpts -----/----- and implicit UME -----/N----; the new explicit UME
restriction expects N----/N---- and needs separate effective-options evidence.

Reachability is required for EACH VOTING SELECTABLE source, not every configured
source. A third source with reach=0 may remain unavailable and contribute no vote;
sourceCount counts actual policy-eligible reachable/recent authenticated votes,
not cached plus/minus flags from a lost source. A lost selected reference still
denies the sample; x/T/~ are never ignored. There must still be >=2 independently NTS-authenticated selectable operators and
exactly one selected reference. x/T/~, foreign/duplicate identities, missing auth,
invalid health, option/config mismatch or a single remaining vote => UNKNOWN.
NTS mode/cookies alone are insufficient; inspect actual authenticated NTP packet
reports, bound to original daemon source names and numeric addresses.

Use nested time format 2 for new authority/event proofs. Keep exact historical
format-1 validation and protected confirmed same-attempt consumption only, with
fresh new-policy time for mutations. Never promote an old sourceCount=2 record,
renew TTL, reset budgets, rewrite/reseal old records or create cross-policy
backup freshness. See DECISIONS.md OPS-TT-003 for the precise boundary.

Execution order after source review: targeted regressions -> exact-head 27-gate
Local CI and verifier -> separately prepared new Linux artifact -> isolated real
host/source-failure/reboot and app/backup sandbox acceptance -> independent root
review -> separate explicit production B2 change authorization. No production
step is authorized here. Existing TARGET artifact 56d3b4f5... is preserved and
cannot represent this source. No artifact is built or relabelled in this task.

BLOCKER: Chrony 4.5 authdata/selectdata/ntpdata need its privileged Unix socket.
Do not expose that socket or general sudo chronyc to service UIDs. Design/review
a bounded read-only access boundary separately; current sampler denies when
access is missing. Root-only/config checks are not production readiness.
