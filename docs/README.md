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
| Architecture and module boundaries | [Architecture baseline](../SERVORA_MED_ARCHITECTURE_PLAN.md), with accepted decision amendments |
| Data model and API contracts | [Schema baseline](../SERVORA_MED_SCHEMA_DRAFT.md), [API baseline](../SERVORA_MED_API_DRAFT.md), with accepted decision/feature amendments |
| Delivery order and recorded acceptance | [MVP slice ledger](../SERVORA_MED_MVP_SLICES.md); completed checkpoints are historical |
| Visit-origin Sale, lifecycle, and quantity amendments | [Visit-to-Sale](features/visit-to-sale/README.md), [integer quantity policy](features/visit-to-sale/integer-quantity-policy.md), and [write/UI contract](features/visit-to-sale/write-ui-integration.md) |
| Duplicate customer detection/review, persistent decisions and the PR3 register workbench | [CRM Slice 4A owning package](features/crm-duplicate-review/README.md) |
| Local setup | [README](../README.md#configure-the-development-database) and [isolated test environment](operations/local-test-environment.md) |
| Deploy and CI recovery | [Production deployment](operations/production-deployment.md), [local CI recovery](operations/local-ci-resource-recovery.md), [local CI caches](operations/local-ci-caches.md), and [local CI source](../ops/local-ci/) |
| Restore, offsite DR, and forward recovery | [Backup/recovery](operations/backup-recovery/README.md), [backup/restore](operations/backup-restore.md), and [R4](operations/r4-forward-recovery.md) |
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

The [2026-10-17 reconciliation report](evidence/documentation-reconciliation-20261017/README.md)
and its [machine-readable inventory](evidence/documentation-reconciliation-20261017/inventory.json)
record classifications, references, static findings, review limits, and follow-up
candidates. They are audit observations, not another authority register or deletion
approval. No existing Markdown path was moved or deleted in that reconciliation.
