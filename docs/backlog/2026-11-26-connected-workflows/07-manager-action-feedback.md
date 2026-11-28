# UI-FEEDBACK — Manager action confirmation and outcome visibility

Date: 2026-11-26. Owner requirement: "yöneticinin karar mekanizmalarında yani bir butona bastığında işlemin onaylandığı net bir şekilde belli olmalı." This is accepted product direction across manager decision surfaces, not only rejection/recovery. Proposed UI implementation standard, to ship with code/test and owning docs. Do not represent a server rejection, pending offer or ambiguous transport outcome as success.

## 1. Baseline and audit target
At main 873c4285cbcf6735a9908fffe80b48d6882a1fa4, DESIGN.md already requires immediate press feedback (lines 18,501), useAppFeedback ownership (178,253), compact ResultState (239), persistent actionable errors (253), 200% text/400% reflow and reduced motion (482–484). Reuse, do not introduce a second toast library or generic global action framework. JobDetail.tsx has detail-feedback, focus requests and successMessage paths (~1210,1928,2392,2424,2730–2756); AssignmentOffer.tsx has local role=status proposal/reoffer success (~508–524); ChangeRequests.tsx has local result status (~390,594). Existing success feedback is not uniformly absent. Audit visibility after refresh, local component unmount when state changes, mobile scroll, modal closing, route change, repeated click, stale read/transport and nested actions; user observed occasional ambiguity, exact affected paths still to reproduce. Confirmed static defect: JobDetail.tsx:2749–2770 calls patchJobCard successfully before refreshTruth (and realtime drain) and setMessage(successMessage); a thrown load error enters the mutation catch despite commit (refreshTruth:1946–1961). Prioritize receipt-vs-refresh separation in UI-FEEDBACK/A, including return-false/session-change and drain branches; reproduce using controlled browser network failure before claiming runtime verification. Inspect existing mutation attempt/error/receipt logic before changing it.

## 2. Shared user-visible result contract
| Phase | Required presentation |
| --- | --- |
| Ready | Verb and consequence: "Önerilen tarihi onayla", "Devret ve atama gönder", not generic OK; summary of actual selected plan. Confirm destructive or irreversible actions with specific consequences; no extra modal for every safe action. |
| Pressed/pending | Immediate button press, visible "Onaylanıyor…"/"Kaydediliyor…", spinner or progress, busy semantics, prevent duplicate and conflicting commands for same record; no optimistic business completion. Keep modal open during pending unless existing safe navigation handles it. |
| Committed | Server receipt proves accepted mutation, not merely click or HTTP transport. Compact clear icon + heading + action-specific text, e.g. "İş yeniden planlandı", with updated authoritative date/staff/status and next action. Announce once via role=status/appropriate live region. Show at accessible location near action and record summary after dialog closes or old panel disappears. Reuse useAppFeedback / ResultState and existing detail feedback; avoid double screen-reader announcements. |
| Committed, refresh failed | Explicit split: "İşlem kaydedildi. Güncel kayıt henüz yüklenemedi." show receipt-safe known facts only, stale marker, "Güncel durumu yenile"; do not retry mutation by a new key, do not render stale status as final. |
| Definitely failed | "İşlem tamamlanmadı" with server reason and next step, inline field errors if relevant, keep form draft and valid inputs, focus appropriate error, do not close as if successful. Distinguish validation/permission/conflict. |
| Unknown / response lost | "İşlemin sonucu henüz doğrulanamadı"; reconcile via existing receipt lookup/retry same clientActionId and identical normalized payload after access check; no success/error claim without proof. Keep nonconflicting navigation, prevent new conflicting attempt while ambiguous per existing protocol; allow safe recovery. |
| Stale/concurrent | Explain current state changed by another action; refresh current record, show known own outcome separately; if another manager resolved, say so rather than claiming current viewer approved. Preserve appropriate draft if safe, revalidate before new attempt. |

A successful decision needs **durable visible evidence**, not only a transient toast or a disappearing button. Keep in-record outcome/status and next step through refresh and panel replacement. A lightweight toast may supplement confirmation but must not be the only proof. Do not require user to dismiss a full-screen success modal for each operation; persistent compact banner until next meaningful interaction/dismissal, durable canonical timeline/record facts remain after reload. Avoid repeated success banners on routine revisit; route-level transition should carry a single result for the initiating action, then render durable server facts. No client-side fabricated timeline row. If the user navigates away during in-flight mutation, avoid leaking outcome to another record; show only relevant authorized context on return. Color is supplementary; text and icon, proper contrast, no flashing; feedback not dependent on audio or notifications. Mobile show within viewport or focus/scroll predictably, restore logical focus after modal closure; no hidden below fold confirmation or unexpected focus theft during unrelated realtime refresh. Keyboard/screen reader, 200% text enlargement, 400% reflow where applicable without horizontal task scrolling or clipped meaning, 44×44 CSS px targets where applicable, visible focus, and prefers-reduced-motion with equivalent non-motion feedback under UI-001/UI-003 and DESIGN.md.

## 3. Turkish copy and outcome precision
| Actual committed operation | Example heading / message |
| --- | --- |
| Approve visit alone | "İş onaylandı" — iş tamamlandı. |
| Approve visit+sale with follow-up/delivery | "Görüşme ve satış onaylandı" — list actually created follow-up / delivery only if receipt proves it, show authorized link and pending assignment state. |
| Approve staff proposed time | "Önerilen zaman onaylandı" — new interval; same staff accepted, no second acceptance. |
| Manager reschedules | "İş yeniden planlandı" — date/time; new offer sent / staff response pending if actually opened. |
| Transfer to other staff | "İş devredildi" — new staff; assignment awaiting acceptance; do not say task completed. |
| Transfer + date change | "Personel ve tarih güncellendi" — both values, one result. |
| Re-offer | "Yeni atama teklifi açıldı" — staff response pending. |
| Resolve change request by actual correction | "Talep sonuçlandırıldı" — actual mutation detail and decision. Record-only closure explicitly "Talep kapatıldı; iş bilgileri değişmedi." |
| Cancel follow-up with replacement | "İş iptal edildi, yeni takip oluşturuldu" — new planned date if created and visible. |
| End cycle | "Takip döngüsü sonlandırıldı" — reason, no follow-up created. |
| Revision requested | "Revizyon istendi" — correction deadline, staff response pending. |
| Invalidate | "İş geçersiz kılındı" — history retained; not physical/financial reversal. |
| Approve linked delivery / late delivery | "Teslim işi oluşturuldu" — assignment state and link, not "ürün teslim edildi". |

If a compound operation fails and rolls back, no partial success text. If a supported batch deliberately commits partial results (existing per-item delivery save path), report exact succeeded/failed counts and next retry targets, not generic full success. Never imply external message delivered merely because event queued; distinguish system offer created from notification transport.

## 4. Coverage and architecture
First audit and fix manager-facing lifecycle and decision surfaces: approve, paired approve, revision, cancel/continuity, invalidate, proposal confirmation, re-offer, reschedule, reassignment, change-request resolution, early-start authorization, assignment time proposal and future linked actions. Inventory every entry point (job detail, board/list, Overview, Intervention Center, CRM and optional module actions); same server outcome produces same meaning across surfaces. Apply standard to other existing manager approval/decision screens as verified vertical slices, not a repo-wide unrelated redesign. Existing UI labels and canonical status mappings stay source of truth; no duplicate status constants. Shared presentational adapter only if concrete common behavior identified; maintain existing Ant/Servora components, useAppFeedback and ResultState. Reuse critical mutation identity, version, receipt and stale refresh policies. Success feedback should follow confirmed mutation independently of refresh success; preserve receipt fields and authoritative reads without leaking IDs/PII. No extra API calls solely for cosmetic acknowledgement unless receipt recovery requires them. Do not add auto approvals or change approval rights.

## 5. Acceptance (UI-F01–F12)
| ID | Scenario | Expected result |
| --- | --- | --- |
| UI-F01 | Click manager approve with delayed response | immediate pending, duplicate/conflicting action disabled; no success until receipt. |
| UI-F02 | Successful approve changes status and unmounts old panel | clear in-viewport success and final status, accessible once; timeline persists. |
| UI-F03 | Paired approve + follow-up + delivery | exact committed subresults, links scoped; no claim of physical delivery. |
| UI-F04 | Alternative time accepted | actual new interval and accepted staff displayed; no second acceptance. |
| UI-F05 | Reassign/reschedule/new offer | new staff/time and "kabul bekliyor" visible; not completed. |
| UI-F06 | 400 field validation/403 permission | specific error and retained draft, no false success, correct focus. |
| UI-F07 | 409 stale or second manager wins | updated truth and explicit conflict; no false own approval. |
| UI-F08 | Mutation committed but refresh/read fails | receipt-based committed message + stale warning + safe refresh, no duplicate mutation. |
| UI-F09 | Response lost or timeout after commit, retry same key | ambiguous message until reconciliation, exactly one mutation, definitive result once. |
| UI-F10 | Cancel/revision/invalidation/change request closure | precise action-specific outcome and next step; record-only distinction. |
| UI-F11 | 390px, desktop, keyboard, screen reader, 200% text, 400% reflow, prefers-reduced-motion, modal close/navigation | result visible, logical focus, one announcement, no clipping/flash-only toast, no unrelated result leakage. |
| UI-F12 | Realtime update, repeated click, module off, intentional partial batch | accurate current truth vs own receipt, no duplicate notification, exact partial counts where applicable. |

Test component and Playwright with delayed/failing network, committed mutation followed by read failure, response-loss/idempotency and concurrent manager fixture. UI-003 screenshots at applicable widths with no fabricated production data; report exact head and evidence. Backend tests only where receipt/command changes. No code, tests or production changes in this draft. Proposed UI-FEEDBACK identifier must be reconciled with UI decision vocabulary; update DESIGN.md and DECISIONS.md only with accepted implementation, UI-001/003 still authoritative.
