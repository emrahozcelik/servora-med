# RESCUE-003/B — Manager recovery form UI specification

Status: OWNER_APPROVED_PRODUCT_DIRECTION / IMPLEMENTATION_HANDOFF. Source-only design
reference; not a claim of implemented behavior or an accepted change to existing
backend policy. Parent implementation: PR #541 (RESCUE-003/A), merged at
`cfa39c608e471c1482e9e98fe7d50aea284cdba1`. Original recovery and feedback contracts: [PR #522, section 06](https://github.com/emrahozcelik/servora-med/blob/e882e0ba6fca0d3f900fd7ca9707786ddaa89e1a/docs/backlog/2026-11-26-connected-workflows/06-assignment-recovery-contract.md)
and [section 07](https://github.com/emrahozcelik/servora-med/blob/e882e0ba6fca0d3f900fd7ca9707786ddaa89e1a/docs/backlog/2026-11-26-connected-workflows/07-manager-action-feedback.md).
Follow [DESIGN.md](../../../DESIGN.md), [Connected Workflows UI acceptance](../../features/connected-workflows-ui-acceptance.md),
[JOB-010/012/013](../../features/assignment-acceptance-sla.md), JOB-009, SCH-001,
[OVR-7](../../features/reporting/lateness-reports.md) and accepted amendments in
DECISIONS.md. Detailed new runtime policy, enum and migration changes must be
accepted with their implementing code/tests; no production activation is authorized.

## 1. What A delivered, what B must deliver

A (#541) already groups recovery in Job Detail, adds a version-checked atomic
assignee + time PATCH, retains planned duration, exposes shared slot search,
locks after ambiguous writes, and shows confirmed child receipts. Its real
AppShell evidence is preserved in [RESCUE-003/A evidence](../../evidence/rescue-003-connected-workflows/README.md).
Do not revert these gains. Existing action buttons under a disclosure are
**not** the target decision form. B must replace the scattered decision entry
points for the same case with one coherent decision surface; do not merely add
another accordion or button to A. Keep existing implementation services and
command/permission rules. One mutation per decision, not a generic workflow
engine. Do not remove legitimate record-edit/lifecycle entry points outside the
recovery case.

## 2. Exact presentation and hierarchy

Entry: one visible primary recovery action, **Görevi çözüme ulaştır**, in the
existing job detail recovery region, for authorized MANAGER/ADMIN only. No
duplicate transfer/recovery CTA in sibling panels. RESCUE-005 will reuse the
same form from the core intervention queue (do not implement that route here).
If an offer and a change request coexist, show the two distinct source facts
in one context, not two competing forms. Select/identify the affected offer
or request explicitly; one decision does not silently close the other.

Use the owned ResponsiveFormDrawer for the main decision surface, and
ReasonDialog / existing confirmation or past-start overlays when needed.
One title, shared close control, one main form, one explicit primary submit
with action-specific text, secondary Vazgeç. No nested permanent cards.
An independently necessary confirmation may replace the form temporarily,
preserving its draft and returning focus; do not stack duplicate decision
forms. A destructive action uses the existing destructive confirmation.

### Mobile wireframe (390 × 844, single vertical flow)

```text
┌──────────────────────────────────────────┐
│ Görevi çözüme ulaştır                 × │
├──────────────────────────────────────────┤
│ Müşteri takip ziyareti                   │
│ Müşteri: Örnek Klinik       Öncelik: ... │
│ Plan: 30 Kas · 14:00–14:30               │
│ Sorumlu: Personel A                      │
│ Görev reddedildi · [reason / risk]       │
│                                          │
│ Personelin açıklaması                    │
│ Şehir dışında olduğum için ...           │
│ Çözüm önerisi                            │
│ Başka bir zamanda kendim yapabilirim.    │
│ Önerilen zaman: 1 Ara · 10:00–10:30      │
├──────────────────────────────────────────┤
│ Kararınız                                │
│ ◉ Önerilen zamanı onayla                 │
│   Personelin önerisi · 1 Ara 10:00       │
│ ○ Farklı bir zaman belirle               │
│ ○ Başka personele devret                 │
│ ○ Personeli ve zamanı değiştir           │
│ ○ Yeniden teklif gönder                  │
│ ○ İş bilgilerini düzelt                  │
│ ○ [other permitted decisions]            │
│                                          │
│ [Only selected decision's input fields]  │
│                                          │
│ İşlem sonucu                             │
│ İş önerilen zamana taşınacak ve          │
│ Personel A için kabul edilmiş olacak.    │
│                                          │
│ [ Önerilen zamanı onayla ]               │
│ [ Vazgeç ]                               │
└──────────────────────────────────────────┘
```

This is the required reading order, not an assertion that the whole form
fits one screen. Scroll inside the owned drawer; the footer must remain
reachable with mobile navigation, safe areas, keyboard and wheel open.
Use compact labels and wrapping, not smaller text or clipped controls.

### Desktop / wide content wireframe (1440 × 900)

```text
┌───────────────────────────────────────────────────────────────┐
│ Görevi çözüme ulaştır                                      × │
├───────────────────────────────┬───────────────────────────────┤
│ İş / müşteri / öncelik        │ Kararınız                     │
│ Planlanan aralık ve sorumlu    │ ( ) eligible decision A       │
│ Ret / talep / teklif durumu    │ ( ) eligible decision B       │
│ Risk, açıklama ve öneri        │ ( ) eligible decision C       │
│ Önerilen tarih / ilgili bağlar │ [selected fields only]        │
│                               │ İşlem sonucu                  │
│                               │ [authoritative preview]       │
├───────────────────────────────┴───────────────────────────────┤
│                                  [Vazgeç] [Seçilen karar]    │
└───────────────────────────────────────────────────────────────┘
```

Use two columns only when the drawer's usable width permits. If the
owned drawer remains narrow, use the same single-column mobile flow.
DOM/keyboard order is context → selection → fields → consequence → footer.
Do not enlarge a generic drawer globally just for this form. All facts
are illustrative; no invented risk, staff skill, customer readiness, or
availability. Use the authorized canonical detail, statusLabel/tone and
shared signal glyphs. Missing data reads unknown, not safe/available.
Show priority, planned interval, latest offer/request, author, reason,
explanation, typed suggestion, relevant proposed interval and permitted
links. Use actual server time/risk when available; do not infer urgency
from browser time or invent a fixed-appointment flag. Staff private
explanations remain role-scoped. Avoid reprinting the job header in every
decision section.

## 3. Decision list, conditional fields and command mapping

One single-select fieldset with visible legend Kararınız. Native radios with
associated full-row labels, accessible names, selected state and 44px targets.
Render eligible decisions from current server-derived permissions, job/offer/
request state and module-independent core rules. Explain unavailable relevant
actions (for example passed proposal or START already occurred); never expose a
forbidden action as executable. Clear only incompatible conditional fields on
selection changes; keep the case context and applicable draft, and do not
silently send hidden fields. The following names are UI decision IDs, not a
new universal API enum.

| Decision / Turkish label | Conditional input and preview | Existing write path and committed receipt |
| --- | --- | --- |
| ACCEPT_PROPOSED_TIME — Önerilen zamanı onayla | Show immutable actual latest proposal, duration and proposer; no new time input. Confirm the exact interval; show expiry/conflict and alternatives. | JOB-012 proposal confirmation; same card accepted for proposer, no second offer. Receipt: Önerilen zaman onaylandı; iş [personel] için kabul edildi. |
| RESCHEDULE — Farklı bir zaman belirle | WheelDateTimeField + shared shortcuts and available slots for current assignee; duration; deadline reason / past-start acknowledgement when server requires; explicit eligible request-closure choice. | Existing versioned schedule PATCH, existing offer producer; report actual new offer state, never assume acceptance. |
| REASSIGN_KEEP_TIME — Başka personele devret | Active eligible same-org Staff selector; read-only existing interval; available-slot/conflict context if available; past-start confirmation as required. | Existing versioned reassignment PATCH, preserve interval, history, messaging transition; receipt reflects actual assignee/offer. |
| REASSIGN_AND_RESCHEDULE — Personeli ve zamanı değiştir | Both fields; reuse AssignmentTransferAction's tested logic, duration, canonical slots, deadline reason, past-start ack, optional atomic RESCHEDULED closure. | A's one version-checked PATCH; preserve duration; one offer. Receipt: Personel ve plan güncellendi, actual pending acceptance and actual closure if present. |
| REOFFER — Yeniden teklif gönder | Read-only same person/time; explicit confirmation, existing urgent/past-start guard. | Existing reoffer command and receipt; new offer pending, not work completed. |
| CORRECT — İş bilgilerini düzelt | Existing authorized fields for this job kind, relevant field validation; no arbitrary field edits. | Existing edit mutation; if claiming request resolved as CORRECTED, bind verified correction and resolution atomically or leave open until implemented. |
| CANCEL / REPLACEMENT — İptal et / ilgili devam işlemi | Reason; JOB-009 mandatory continuity choice and fields for linked follow-up; explicit destructive confirmation. | Existing CANCEL lifecycle with JOB-009; SALE-003 owns delivery replacement, no new physical delivery/reversal bypass; preserve history. |
| REJECT_CHANGE_REQUEST — Talebi reddet | Required explanation, request context; no assignment mutation. | Existing REJECTED request resolution; receipt: Öneri reddedildi. İş bilgileri değişmedi. |
| ACKNOWLEDGED_ONLY — Talebi kayda al ve kapat | Required trimmed 1–2000 character note; preview states no job, deadline, offer, or lateness change. Only render after approved backend contract is implemented. | Future neutral resolution per JOB-010/OVR-7 amendment. Exclude from OVR-7 qualifying resolutions; do not fake it using CORRECTED/RESCHEDULED/REJECTED. |
| STARTED_CASE — started-job context | Explain why pre-start decisions unavailable; expose only existing authorized correction, rejection, cancellation/linked successor paths. | Preserve START, actual times and execution facts; no pre-start transfer or implicit staff release. |

Use existing named services, types, request identity and error paths. Reuse
AssignmentTransferForm, AssignmentOffer, ChangeRequests, JobDetail edit and
schedule logic; factor shared fields/submit hooks instead of copying them.
No duplicate date/time picker, availability service, status vocabulary or
business rules in UI. A native select is suitable for a short list; use the
existing ServoraSelect for large/searchable datasets per DESIGN.md. No unbounded
new preload or ranking API in B. Full candidate search/ranking and occupancy
policy remain RESCUE-004. Keep Calendar/Overview/Messaging optional; messaging
sync remains best-effort existing transition behavior, never a write prerequisite.

## 4. Recommendation, not automation

Order only eligible actions. Default is a recommendation, not a mutation:
- Valid exact Staff proposal: recommend ACCEPT_PROPOSED_TIME when compatible
  with the current suggestion, permissions and known risk; keep the proposal
  visible and distinguish it from a manager-selected different time.
- Typed RESCHEDULE_SELF without confirmable proposal → RESCHEDULE;
  REASSIGN → REASSIGN_KEEP_TIME when existing interval is eligible, otherwise
  REASSIGN_AND_RESCHEDULE if eligible; CORRECT_DETAILS → CORRECT;
  CANCEL_REQUEST → show cancellation as a suggested option, never pre-authorize
  or auto-submit a destructive action. MANAGEMENT_DECIDES or legacy null →
  fall back to existing reason-based guidance; no forced destructive default.
- Current server-known appointment risk, priority, state and availability may
  rule out or change recommendations; unknown stays unknown. Revalidate on
  submit and show reason when the recommendation changes. Do not fabricate
  ranking facts. Rich risk/candidate prioritization belongs to RESCUE-004/005.
- A recommendation must never trigger a write, accept a proposal implicitly,
  reassign automatically, or mark an obligation resolved.

Record the chosen deterministic ordering in tests. On a stale offer or request,
show authoritative conflict and require renewed review, not a silent retarget.

## 5. Shared layout and feedback rules

Follow the acceptance gate and canonical tokens. Use Source Sans 3, existing
surface-flat/section hierarchy, shared statusLabel/tone and semantic glyphs,
--control-height, --radius-control, --rule, --focus and semantic colors.
No new font, color palette, picker, local spacing scale or repeated nested
frames. Baseline shared .field-group gap 0.5rem, margin-top 1.25rem; existing
.schedule-quick-chips gap 0.5rem; .review-buttons gap 0.65rem; existing recovery
panel separation. Prefer shared layout rules over stacking margins + grid gaps.
Section separation must be visibly consistent and not read as touching boxes;
reuse a rule/divider only where hierarchy warrants it. Measure actual geometry
rather than declaring numeric CSS by itself sufficient. Any new reusable
spacing token is a coordinated design-system change, not a local workaround.
All interactive targets ≥44 × 44 CSS px, including tablet and desktop recovery
actions, drawer close, radio rows, slots, wheel controls and footer.

Preview explicitly states what changes, what does not, expected offer/acceptance,
request disposition and relevant history. It is conditional before submit,
never a claim of success. Disable conflicting writes while pending; show
Kaydediliyor… + existing semantic icon, retain typed input on definitive errors.
After confirmed commit use page-owned receipt, semantic green + icon and text,
then canonical detail/timeline. If read fails after commit, retain success
receipt and stale warning with read-only reload; 403/404 removes inaccessible
data with committed access-loss wording. Unknown mutation outcome never becomes
success on a mere GET; lock conflicting actions until canonical review, no
automatic resend. Use existing exact request identity only where supported;
versioned PATCH conflict is not same-key replay. On ambiguous PATCH show
canonical observed state without attributing it to this request unless proven.
On conflict keep draft for review, do not automatically retarget to latest
version. No cross-session receipt leakage. Confirm and restore focus per
existing overlay helpers, including open wheel / Escape and reduced motion.

## 6. Neutral acknowledgement and evidence-bound closure

A documents neutral closure but does not implement it. B must either implement
it in an explicitly accepted JOB-010/OVR-7 amendment with code and tests, or
leave the neutral action hidden and RESCUE-003/B incomplete with a named
follow-up. Do not extend record-only uses of qualifying CORRECTED,
RESCHEDULED, LINKED_JOB_CREATED. New recovery form may only offer these when
backed by an actual atomic mutation or verified authorized evidence as required
by the owning contract. Existing legacy routes/history are not silently
reclassified. Audit legacy entry points; if retiring or tightening them,
document explicit scope and compatibility in the implementing PR. No false
"iş düzeltildi" receipt. Preserve actual incidents and existing attribution
on neutral acknowledgement; reopen automatic eligible reminders through
normal OVR-4/6 workers, preserve delivery keys and quiet hours. See
[neutral acknowledgement contract](../../features/assignment-acceptance-sla.md#neutral-acknowledgement-for-rescue-003).
If no neutral code is accepted, keep the request open or offer authorized
explicit rejection; do not map acknowledgement to rejection. Migration number
must be assigned from the then-current catalog, not pre-reserved here.

## 7. Acceptance and implementation handoff

Use current main after A and re-read AGENTS.md, DECISIONS.md, API/schema and
owning feature contracts. Suggested delivery: B1 shared form + eligible
decision paths and suggestion-driven ordering; B2 neutral/evidence-bound
closure policy and tests if it needs a separate reviewed migration. Either
sequence is acceptable; do not mark B complete until both are accepted.
Use code, tests and owning docs together in implementation PRs with normal CI.

| ID | Required proof |
| --- | --- |
| MF-01 | One recovery entry and one decision surface; both source cases and coexisting sources; no duplicate competing CTA. |
| MF-02 | All five JOB-013 suggestions and legacy null; eligible recommendation, no automatic action; expired/conflicted proposal and unknown risk. |
| MF-03 | Each eligible decision renders only its required fields, correct action-specific preview, no hidden payload; keyboard selects/focuses controls. |
| MF-04 | Exact proposal acceptance vs changed time/assignee; one committed receipt, actual offer state, preserve existing permission and lifecycle semantics. |
| MF-05 | Atomic transfer and interval: both job types, duration, calendar conflict rollback, invalid request rollback, one offer, schedule/assignment history, messaging optional. |
| MF-06 | Two managers/stale version/repeated submissions; no duplicate offer or request closure; exact replay where existing command supports identity. |
| MF-07 | Actual evidence-bound reschedule/correction/linked resolution; neutral/rejected distinct; OVR-7 no false attribution change, legacy reports unchanged. |
| MF-08 | Neutral close role, note, concurrency/replay, activity/notification once; OVR-4/6 eligible undelivered vs already delivered and quiet hours. |
| MF-09 | Started/terminal job, JOB-009 follow-up continuity and SALE-002/003 constraints; no rewrite of execution evidence, staff cannot cancel. |
| MF-10 | Pending, definitive errors, conflict, lost response, post-commit GET failure/403/404; no false receipt, no duplicate write; canonical recovery and focus. |
| MF-11 | Real AppShell with production styles: 320×800, 390×844, 768×1024, 1440×900, 200% text, 400% reflow equivalent, reduced motion. Both entry cases, coexisting sources, wheel open, every conditional field group, error/pending/success/unknown. |
| MF-12 | Actual geometry: ≥44×44 targets, no horizontal document/form overflow, footer reachable, section gaps, no repeated wrappers, lifecycle order and nav preserved; compare A and final screenshots at same viewport. |
| MF-13 | Overview/Calendar/Messaging off, role/tenant isolation, unauthorized actions absent or safely denied; no optional-module dependency. |
| MF-14 | Existing characterization expectations changed only with explicit policy amendment, normal hosted CI, exact source/evidence hashes, reviewer sign-off and limitations. |

Capture runner: extend web/scripts/connected-workflows-recovery-acceptance.mjs
and preserve A's evidence. Use real AppShell with deterministic synthetic API
boundary for rendered tests, actual PostgreSQL service tests for writes.
Retain screenshots/measurements for each matrix case and relevant decisions,
not just transfer. Include keyboard/focus return, wheel Confirm/Cancel,
horizontal clipping checks inside drawer, form and safe-area navigation,
button hit-test, per-section gap measurement and contrast/status semantics.
Chromium emulation is not physical iOS/Android validation; disclose that limit.

Acceptance is not satisfied by "all tests pass" alone. Report per MF ID
PASS / FAIL / DEFERRED with exact head and evidence links; include R-A05–11
and applicable UI-F01–12 from #522. Clearly mark any unimplemented action,
unknown risk data, or policy amendment. No deployment without separate owner
authorization.

## 8. Server scope notes — PR #543 request changes (2026-11-28)

These notes record the reviewed server/owning-contract scope; they do not
authorize production activation and do not widen the design above.

- **MF-07: the ordinary `CORRECT` edit stays general; only the opt-in
  `CORRECTED` closure is evidence-bound.** The `CORRECT — İş bilgilerini düzelt`
  decision edits the existing authorized fields for every request reason and
  does not by itself close the request. The separate opt-in `PATCH`
  `changeRequestResolution` `CORRECTED` closure is accepted only for an `OPEN`
  request with reason `OTHER`, only with a trimmed 1–2000 character management
  note attesting how the correction addressed the request, and only when the
  same patch persists a real `description` change or a permitted `SALES_MEETING`
  `customerId`/`engagementKind` change. Title/priority/schedule/assignee/contact
  edits are not evidence. `WRONG_PRODUCT` and every other reason keep the
  ordinary edit available but have no `CORRECTED` closure: the request stays
  open or closes through `ACKNOWLEDGED_ONLY`/`REJECTED`, and it must not be
  presented as a successful `CORRECTED` closure. A rejected closure attempt
  rolls back the field edit, request closure, activity and notification
  together.
- **Relationship/replacement decision is deferred.** The existing contract does
  not prove an explicit authorized replacement relation for this command. Same
  tenant/customer, a generic follow-up (`source_job_card_id`) or an
  operator-selected job is not replacement evidence. The drawer must not render
  a linked/replacement/relationship decision in this slice; Hydrogen owns its
  removal from the new UI. Legacy `POST` `LINKED_JOB_CREATED`, historical
  resolution rows, JOB-009 cancellation replacement and SALE-002/003 delivery
  replacement remain intact and outside this decision surface.
- **MF-08 neutral acknowledgement is unchanged.** `ACKNOWLEDGED_ONLY` keeps its
  mandatory note, zero JobCard mutation, OVR-7 exclusion and OVR-4/6 alert
  behavior; it is not a replacement for the evidence-bound `CORRECTED` path.
- No schema or migration change is introduced by these notes; migration `077`
  remains the additive neutral-acknowledgement migration.
