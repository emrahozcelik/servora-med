# Connected Workflows — görüşme, satış, teslimat ve müşteri yaşam döngüsü

Date: 2026-11-26 (Europe/Istanbul)
Status: OWNER_APPROVED_PRODUCT_DIRECTION / DRAFT_IMPLEMENTATION_CONTRACTS
Baseline: `873c4285cbcf6735a9908fffe80b48d6882a1fa4` (main; migration catalog 075). Production schema and feature activation not verified.
Owner input: 26 Kasım 2026 görüşme/ziyaretlerin satışa dönüşmesi, birbirine bağlı işlerin esnekleştirilmesi, sonuçların raporlara taşınması; inceleme önerilerine onay ve başlangıç PR'ı talebi.
This package is a planning handoff, not shipped behavior, a merge authorization, or a production enablement authorization.

## Amaç
Personel mevcut müşteri bağlamından kopmadan gerçek bir ihtiyacı sonraki işe dönüştürebilsin; yönetici aynı ticari ve operasyonel zinciri görebilsin. Görüşmenin gerçekleşmesi, ticari sonucu, takip niyeti, satış anlaşması, fiziksel teslimat, stok ve finans ayrı gerçeklerdir. Mevcut JobCard ve modül sahipliği korunur. Genel amaçlı workflow engine, generic JSON form builder, yeni state machine veya SaaS geçişi yok.

## Okuma sırası
1. [01 — baseline, bulgular ve karar defteri](01-baseline-decisions.md)
2. [02 — ENG-001 görüşme sonuçları ve takip sözleşmesi](02-engagement-contract.md)
3. [03 — FLOW-002 bağlantılı aksiyonlar / SALE-003 teslimat devamlılığı](03-linked-actions-contract.md)
4. [04 — CRM / REPORT / modül entegrasyon sözleşmeleri](04-crm-report-module-contract.md)
5. [05 — uygulama dilimleri, sahip dokümanlar, kabul matrisi ve handoff](05-implementation-acceptance.md)

FLOW-001, ENG-001, FLOW-002, SALE-003, CRM-FLOW, REPORT-FLOW, MOD-FLOW are provisional identifiers; confirm uniqueness and ownership at slice start. Product direction is approved; detailed defaults in these drafts are recommendations, not retrospective approval of every field or policy. Explicit choices in 01 §4 gate the affected implementation; independently verified defects may be fixed in their own vertical slice. AGENTS.md §§3–4, 9, 11, 13, 15 govern. Existing DECISIONS.md remains authoritative until explicitly amended with code and tests. No canonical decision/schema/API/MVP rewrite in this docs-only PR.

## Çapraz PR sınırı
- #515 accounting (open, head 7b20ff7): ACC-A contract proposed; no financial write from core.
- #516 maintenance (open, head 74347fc): asset → service case → multiple JobCards; no new competing maintenance entity in core.
- #517 warehouse (open, head ddf26e3): WH-A proposed, standalone stock movements first; later JobCard posting/reservation separately authorized.
- #518 messaging (open, head de9ae28): runtime gate/continuity research; do not make messaging a core dependency.
- MOD-003 already in main, migration 075; no duplicate registry widening, no reserved future migration numbers. Recheck PR heads and contracts before integration; draft PRs are not runtime truth.
- SCH-001 core occupancy survives Calendar off; no calendar rewrite in this program.

## Başarı ölçütü
A genuine visit can have multiple different next actions without duplicate commitments; a failed visit attempt is not a failed sale or a held visit; links survive replacement/cancellation/invalidation; users see only authorized data; core paths work when optional modules are disabled. Management can distinguish visit type, outcome, source, actual dates, follow-up health and fulfillment. Preserve existing sale/visit joint commands, approval, JOB-010 assignment, REPORT-002 attribution, audit and existing records.

No application code, migration, tests, deploy, feature flags or production data changed by this package.
