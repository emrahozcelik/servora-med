# Activity attribution and visit-to-sale reporting

- **Decision:** REPORT-001 in [DECISIONS.md](../../../DECISIONS.md).
- **Accepted:** 2026-11-04, following the product owner's reporting review and
  simplified visit/sales-meeting scenarios.
- **Status:** Accepted product contract. Verified-performer attribution and
  optional lateness context are not implemented. Organization-level trends and
  the manager Reports UI are a separately authorized implementation slice; see
  [overview UI/read contract](reports-overview-ui.md) for its exact scope and evidence.
- **Inspected source:** `c8efe8a7999f879683a62454ff74b2b649c4dee3`.

This contract owns the new performer attribution, the visit-to-sale reporting
meaning, and optional explanations of recorded lateness. It is not evidence that
the application already implements them. Existing lifecycle, security,
idempotency, SALE-001 and MOD-001 boundaries remain binding.

## 1. The product model

The report explains three ordinary business scenarios:

| Scenario | Activity | Commercial result |
| --- | --- | --- |
| Müşteri ziyareti planlandı ve yapıldı | A customer visit took place. | No linked approved Sale yet. |
| Müşteri ziyareti planlandı, yapıldı ve satışa dönüştü | A customer visit took place. | A linked Sale was approved. |
| Satış görüşmesi planlandı ve satışa dönüştü | A meeting was planned directly for a sales conversation. | A linked Sale was approved. |

A sales meeting can start independently; it does not require an earlier customer
visit or follow-up parent. It may also end without a sale or require another
meeting. A completed visit without a sale is not automatically an unsuccessful
activity. These are reporting descriptions, not new JobCard lifecycle states.

Customer visits and sales meetings retain the canonical SALES_MEETING JobCard
type and their existing engagement kinds. Follow-up is an explicit relationship,
not a mandatory stage between every visit and sale. A repeat visit can be shown
in the customer's chronology even when it has no recorded follow-up relationship.

Meeting outcome, approved Sale agreement and physical product delivery remain
different facts. POSITIVE alone is not a sale. Only a valid, manager-approved
SALE establishes the confirmed commercial result. Pending activity/sale approvals
remain visible as pending; approval of one does not approve the other.

Existing PRODUCT_DELIVERY reports, including delivery purpose SALE, remain
separate and unchanged by this reporting redesign. Delivery is not part of the
visit-to-sale conversion calculation. Warehouse, stock reservation, shipment,
partial delivery, invoicing and financial reporting remain outside this contract.
Future Warehouse ownership stays with MOD-001; no new module or integration is
introduced here.

## 2. Who owns each fact

| Meaning | Authority |
| --- | --- |
| Current work and next operational action | Current assigned Staff; existing permission rules. |
| A button press or recorded command | Authenticated actor in the audit record. |
| An approved personal activity or Sale result | Explicitly recorded performer, verified within the existing work approval. |
| Manager verification | Manager/Admin who approved that particular submission. |
| Historical lateness | Proven accountable person or management role at the breach instant. |

An assignee, submitter, creator or approver is not automatically the performer.
Customer ownership and source-visit ownership do not create personal sale credit.
The new personal-result rule does not change current workload ownership or the
existing delivery report's operational grouping/filter contract.

The accepted attribution principle is:

> Personel başarı atfı, işin atanmış sorumlusuna veya onaya gönderme düğmesine
> basan kullanıcıya değil, onaylanan çalışmayı gerçekleştirdiği kaydedilen ve
> yönetici tarafından mevcut iş onayı kapsamında doğrulanan personele yapılır.
> Gerçekleştiren kimliği ilgili gönderim sürümüne bağlanır. Kimlik
> kanıtlanamıyorsa iş akışı devam eder ancak kişisel başarı atfı yapılmaz.

## 3. Performer capture and existing approval

`performedByStaffUserId` denotes the new, explicit performer declaration; it is
not a rename or reinterpretation of `staff_completed_by`. An unknown performer
is represented explicitly, without an inferred replacement person.

- Normal Staff submission automatically records the authenticated Staff user as
  performer. The UI shows this identity without asking the person to select
  themselves on every submission. The server owns this default; a Staff caller
  cannot use the field to impersonate another performer.
- When management submits on behalf of someone, management explicitly records
  the actual Staff performer or an unknown identity. The approver never becomes
  performer just because they approve. Cross-organization or invalid references
  are rejected, not silently converted to unknown.
- Each submission binds its performer declaration to an immutable submission
  identity/version and the work submitted for review. The existing work approval
  records which submission and performer declaration it verifies, atomically
  with completion and audit. There is no separate performance approval stage.
- Management may approve an otherwise valid operational record with an unknown
  performer. It contributes to the organization result, but to no individual's
  result. A missing performer cannot bypass other existing submission rules.
- Revision and withdrawal preserve earlier submissions. A revised submission
  is a new claim. If X's submission is returned and Y's later work is approved,
  the approved result belongs to Y once; the returned claim is not another
  completed result. The prior activity evidence remains available.
- Management can correct a performer declaration with a reason. An attribution
  correction preserves the original declaration, actor, approval/submission
  reference and correction history. A correction after approval changes the
  effective attribution through an appended correction; it does not reopen the
  job, alter its approved contents or rewrite the original approval.
- Corrections are visible to affected Staff through appropriately limited
  attribution history. Later reassignment or deactivation does not silently move
  or remove proven historical activity attribution.

Performer identity is not an access grant or a reassignment command. The example
of Y performing a revision does not authorize Y to submit a job they cannot
access. Existing authorized lifecycle paths still apply; management can record
Y's performed work on their behalf. Changing started-work transfer rules is not
part of this contract. WEEKLY_REPORT original-owner and frozen-content rules
remain unchanged; it is not converted into productive sales activity.

## 4. Sale attribution and customer contribution

SALE-001's creation rule still derives the Sale's operational assignee from the
source visit. That rule is not a declaration of who achieved the sale. The Sale
has its own submission-bound performer declaration and existing manager approval.
Its verified performer can therefore differ from the source visit's performer.

If X conducts a meeting and Y later conducts a follow-up and achieves the sale:

- X receives the approved meeting activity.
- Y receives the approved follow-up activity and the independently approved Sale
  result, when those records verify Y as performer.
- The customer chronology shows the recorded relationship between the work.
- The company counts the Sale once. Earlier contributors do not each receive
  another copy of that personal Sale result.

One approved result has one verified performer or an unknown performer in V1.
Contribution is shown through the separate activities, not fractional sale credit
or a new shared-credit system. Follow-up and sale origins retain their distinct
existing relation fields. Same customer or nearby dates alone do not prove that
an earlier activity produced a sale.

The report separates activity, meeting outcome and conversion. A visit linked to
several valid approved Sales is one converted visit with several distinct Sales;
visits and Sale JobCards must not be mixed into a single conversion denominator.
The organization Sale total reconciles with uniquely attributed Sales plus
unattributed Sales. INVALIDATED records do not contribute to current result
totals; their historical evidence and corrections remain preserved.

No 30/90-day success threshold is introduced. Recorded conversion durations may
be observed only where the relationship and timestamps support them; ongoing
processes and missing evidence remain distinguishable from a zero or failure.

## 5. Optional lateness context

The purpose is to understand causes and support operational improvement, not to
create discipline, penalties or another approval process.

- Preserve LATE_START and LATE_SUBMISSION incidents and their proven historical
  accountability. APPROVAL_WAIT stays a management delay, not a Staff submission
  delay. Schedule/assignment changes and comments do not erase incident evidence.
- Staff can voluntarily add a short explanation or supplementary information to
  their own proven incident. Management can add a visible note or request more
  information. Neither party must respond, review or close every incident.
- There is no excuse acceptance/rejection state machine, mandatory explanation,
  unanswered-request obligation, response deadline or explanation-reminder loop.
  Missing text or an unanswered request creates no negative performance result.
- Explanation and manager-note absence never blocks start, progress, submission,
  approval, cancellation or an otherwise authorized transfer. Completed/cancelled
  jobs are not retained in an obligation queue because a note is missing.
- Explanations, manager notes and corrections are separate, append-only entries.
  Management cannot overwrite Staff text. A correction identifies the earlier
  entry it corrects; the original remains auditable.
- Management notes about the incident are visible to its affected Staff member.
  After reassignment, the former responsible person retains only the limited
  incident/context access necessary for their own explanation; this does not
  expose the transferred job or another person's records.
- An authorized person may voluntarily explain a proven pre-rollout incident.
  There is no retroactive request, notification or expectation. Unprovable
  historical accountability remains unknown; no fabricated incident/backfill is
  created to support the new screen.

This amendment adds no repeated notifications for explanations. It does not
silently remove existing operational late-submission reminders, whose purpose
and owning policy are separate.

## 6. Lateness reporting

Show distinct delayed-job count separately from incident count. Display Staff
accountability only where proven; management delay and unknown accountability
remain separate. Explanation-present, explanation-absent and manager-note-present
counts describe available context, not engagement or performance grades.

Repeated incidents must expose their type, episode and underlying evidence rather
than imply personal fault. Replays or scanner runs are not new incidents. Multiple
schedule-revision records for an obligation must not be presented as multiple
independent late jobs. Compare only explicitly stated periods and distinguish
ongoing elapsed time from ended-incident duration. Median and maximum duration
are meaningful within those comparable groups; missing duration remains unknown.
**Total/summed lateness duration is excluded from V1.**

No combined score, ranking, note-count reward, automatic penalty or adjusted KPI
based on a manager's opinion is introduced. Staff workload and task type remain
context when interpreting repeated delays.

## 7. Data, ownership and compatibility

The observed implementation has `staff_completed_by` as the submission actor and
immutable STARTED/SUBMITTED facts with distinct responsible/actor identities.
These remain their existing evidence; none is renamed into a performer claim.
Missing legacy performer declarations are not inferred from current assignment,
the last submitter or old free-text notes. Reasoned management corrections may
establish attribution against an identifiable historical approved record without
fabricating an old submission or erasing evidence.

The future write contract must carry the performer declaration, immutable
submission reference, approval binding and append-only correction provenance.
Reuse existing submission evidence where it can provide the required binding;
do not introduce a second generic lifecycle/event system. Exact migrations,
endpoint payloads and compatibility rollout belong to the implementation design,
not a claim that new fields or routes already exist.

Reports remains read-only. Performer and incident-context writes belong to the
JobCard-owned domain, with backend authorization, tenant-safe references,
transactional audit, existing idempotency and concurrency discipline. A retry
must not duplicate a submission, explanation, approval or correction. Self-only
historical reads must not broaden the existing management-only incident endpoint
into unrestricted Staff access.

REPORT-001 explicitly supersedes DOM-006's universal current-assignee ownership
rule for the new approved personal-activity/commercial-result metrics and their
meeting-outcome breakdowns. Existing operational workload, delivery report,
quantity, timezone and financial exclusions remain intact. The corresponding
older universal-attribution wording in the architecture/API baseline and Slice
08 spec is subject to that amendment, not authority to relabel the new metrics.
Historical acceptance checkboxes remain historical; current runtime drift is not
resolved by this documentation change.

## 8. Acceptance criteria for future implementation

| ID | Required scenario |
| --- | --- |
| ATR-01 | Normal Staff submission derives the performer without a selector; a forged foreign performer is rejected. |
| ATR-02 | Management submitting X's work and another manager approving it preserves X, submitter and approver as distinct identities. |
| ATR-03 | Approval with an explicitly unknown performer succeeds when other readiness rules pass; no personal attribution is fabricated. |
| ATR-04 | A returned X submission and an approved Y submission produce one approved result for Y, with both submissions preserved. |
| ATR-05 | A reasoned correction is visible and append-only; retries and concurrent corrections cannot duplicate or silently overwrite history. |
| ATR-06 | Reassignment and deactivation preserve proven historical attribution; performer identity grants no extra JobCard access. |
| SALE-REPORT-01 | Each of the three product scenarios is reportable; an independent sales meeting needs no prior visit. |
| SALE-REPORT-02 | A Sale's performer can differ from the source visit's performer without changing source assignment or lifecycle. |
| SALE-REPORT-03 | POSITIVE outcomes and SALE-purpose deliveries do not create conversions; a Sale is counted once and INVALIDATED results are excluded. |
| DATA-01 | Organization totals reconcile with attributed and unknown results; missing legacy evidence is not zero or inferred success. |
| LATE-01 | Missing explanations, notes and responses never block lifecycle or produce an obligation, score or penalty. |
| LATE-02 | Proven legacy incidents accept voluntary explanations without retroactive notifications; management notes are visible to affected Staff. |
| LATE-03 | Distinct jobs and incidents are separate, duration groups distinguish open/ended incidents, and no summed-duration metric is shipped. |
| ACCESS-01 | Cross-organization, unrelated Staff and transferred-job details remain protected on every new read/write path. |

No acceptance case above has been executed by creating this document. Later
implementation requires the existing PG17, build/test, exact-head CI and UI
accessibility gates. Production changes remain outside this documentation task.
