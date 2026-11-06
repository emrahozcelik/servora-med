# Documentation navigation and authority

This index helps readers find the owning document. It does not create another
source of product policy. [AGENTS.md §15](../AGENTS.md#15-document-authority-and-reading-map)
defines authority, accepted amendments, and how to report policy/code drift.

## Current owners

| Need | Read |
| --- | --- |
| Engineering discipline and repository discovery | [AGENTS.md](../AGENTS.md) |
| Accepted product and architecture decisions | [DECISIONS.md](../DECISIONS.md) |
| Product scope and workflows | [PRODUCT_REQUIREMENTS.md](../PRODUCT_REQUIREMENTS.md) |
| UI, UX, and accessibility | [DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md), and DECISIONS.md UI-001 |
| Default visual inspection method for all agents | [Rendered UI evidence workflow](ui/visual-review-workflow.md), DECISIONS.md UI-003 |
| Architecture and module boundaries | [Architecture baseline](../SERVORA_MED_ARCHITECTURE_PLAN.md), with accepted decision amendments |
| Data model and API contracts | [Schema baseline](../SERVORA_MED_SCHEMA_DRAFT.md), [API baseline](../SERVORA_MED_API_DRAFT.md), with accepted decision/feature amendments |
| Delivery order and recorded acceptance | [MVP slice ledger](../SERVORA_MED_MVP_SLICES.md); completed checkpoints are historical |
| Visit-origin Sale, lifecycle, and quantity amendments | [Visit-to-Sale](features/visit-to-sale/README.md), [integer quantity policy](features/visit-to-sale/integer-quantity-policy.md), and [write/UI contract](features/visit-to-sale/write-ui-integration.md) |
| Verified activity performer, visit-to-sale reporting and optional lateness explanations | [Reporting contract](features/reporting/README.md), REPORT-001; accepted product contract, implementation pending |
| Duplicate customer detection/review, persistent decisions and the PR3 register workbench | [CRM Slice 4A owning package](features/crm-duplicate-review/README.md) |
| Local setup | [README](../README.md#configure-the-development-database) and [isolated test environment](operations/local-test-environment.md) |
| Deploy and CI recovery | [Production deployment](operations/production-deployment.md), [local CI recovery](operations/local-ci-resource-recovery.md), [local CI caches](operations/local-ci-caches.md), and [local CI source](../ops/local-ci/) |
| Restore, offsite DR, and forward recovery | [Backup/recovery](operations/backup-recovery/README.md), [backup/restore](operations/backup-restore.md), [R4](operations/r4-forward-recovery.md), [forward-only releases](operations/forward-only-release.md), [separate failure recovery](operations/forward-only-failure-recovery.md), and [post-recovery release continuity](operations/forward-only-release-continuity.md) |
| Pilot and staging | [macOS pilot](operations/local-macos-cloudflare-tunnel.md) and [staging contract](operations/staging-contract.md) |
| End-user guidance | [Turkish user manual](user-manual/servora-med-user-manual.md) |

Baseline documents can retain valid contracts alongside old coverage/status
statements. A filename containing `DRAFT`, `PLAN`, or a date does not by itself
establish approval, obsolescence, or supersession. Read explicit accepted
amendments; do not rewrite business policy to match an observed implementation.
The executable schema comes from the exact release's migration catalog and SQL,
not from a copied table or migration count in a design document.

## Historical records and archives

These records stay at their existing paths so references remain stable:

- [August 2026 infrastructure research](operations/2026-08-10-servora-med-local-cloudflare-tunnel-vps-research.md)
  is archived in place. Its VPS deferral and provider observations describe that date.
- [Phase U package](../PHASE-U-README.md) and the [Ant/Phase T implementation plan](ui/SERVORA-IMPLEMENTATION-PLAN.md)
  preserve completed checkpoints, original commands, and deferred proposals.
- [Dated production records](operations/) are evidence of their named releases,
  not proof of the current live host state or permission to repeat a cutover.
- [Archived inputs](archive/inputs/) preserve pre-consolidation material.

The 44 original [Superpowers plans](superpowers/plans/) preserve implementation-era
task lists. Their command blocks, tool suggestions, sub-agent instructions, and
old test results do not authorize a new task. The 32 [Superpowers specs](superpowers/specs/)
include accepted contract references and documents with unresolved approval/status
metadata. They must not be deleted or all declared obsolete as one group.

## Evidence and unresolved work

Preserve [acceptance evidence](evidence/), [UI screenshots](ui/screenshots/),
[restore records](operations/restore-rehearsals/), and the recovery contracts above.
[Backlog](backlog/) entries require their own accepted scope before implementation.
An old successful CI result belongs to its recorded SHA/tree.

The [2026-11-05 visual improvement review](ui/reviews/2026-11-05-visual-improvements.md)
prioritizes proposed UI slices and records corrections to the initial review.
Its [preserved captures](evidence/visual-review-20261105/README.md) are synthetic
layout evidence with documented fixture limitations, not implementation approval
or complete application acceptance.

The approved A–E work from that review is tracked in the
[visual implementation record](ui/reviews/2026-11-05-visual-improvements-implementation.md)
with [new before/after evidence](evidence/visual-improvements-implementation-20261105/README.md).

The [job creation visual review](ui/reviews/2026-11-05-job-create.md) extends that
review to the three new-job forms and their menu. Its
[browser evidence](evidence/job-create-review-20261105/README.md) includes populated
mobile overflow findings. The approved presentation changes and their current
verification status are recorded in the
[implementation follow-up](ui/reviews/2026-11-05-job-create-implementation.md),
with [final evidence](evidence/job-create-implementation-20261105/README.md).

The [2026-10-17 reconciliation report](evidence/documentation-reconciliation-20261017/README.md)
and its [machine-readable inventory](evidence/documentation-reconciliation-20261017/inventory.json)
record classifications, references, static findings, review limits, and follow-up
candidates. They are audit observations, not another authority register or deletion
approval. No existing Markdown path was moved or deleted in that reconciliation.
