import {
  STAFF_OFFBOARDING_REASON_CODES,
  type StaffOffboardingExecuteInput,
  type StaffOffboardingPlan,
  type StaffOffboardingReasonCode,
} from '../services/people-api';

export type StaffOffboardingDraft = {
  reasonCode: StaffOffboardingReasonCode | '';
  jobs: Record<string, string>;
  customers: Record<string, { action: 'REASSIGN' | 'UNASSIGN'; replacementUserId?: string }>;
  calendar: Record<string, string>;
  followUps: Record<string, string>;
  reminders: Record<string, { action: 'TRANSFER' | 'CANCEL'; replacementUserId?: string }>;
};

export function createOffboardingDraft(_plan: StaffOffboardingPlan): StaffOffboardingDraft {
  return { reasonCode: '', jobs: {}, customers: {}, calendar: {}, followUps: {}, reminders: {} };
}

function exactKeys(actual: Record<string, unknown>, expected: readonly string[]) {
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

export function missingOffboardingDecisions(plan: StaffOffboardingPlan, draft: StaffOffboardingDraft) {
  const missing: string[] = [];
  if (!STAFF_OFFBOARDING_REASON_CODES.includes(draft.reasonCode as StaffOffboardingReasonCode)) missing.push('reason');
  for (const item of plan.jobs) if (!draft.jobs[item.id]?.trim()) missing.push(`job:${item.id}`);
  for (const item of plan.customers) {
    const decision = draft.customers[item.id];
    if (!decision || (decision.action === 'REASSIGN' && !decision.replacementUserId?.trim())) missing.push(`customer:${item.id}`);
  }
  for (const item of plan.calendar) if (!draft.calendar[item.id]?.trim()) missing.push(`calendar:${item.id}`);
  for (const item of plan.followUps) if (!draft.followUps[item.jobCardId]?.trim()) missing.push(`follow-up:${item.jobCardId}`);
  for (const item of plan.reminders) {
    const decision = draft.reminders[item.id];
    if (!decision || (decision.action === 'TRANSFER' && !decision.replacementUserId?.trim())) missing.push(`reminder:${item.id}`);
  }
  return missing;
}

export function buildOffboardingRequest(
  plan: StaffOffboardingPlan,
  draft: StaffOffboardingDraft,
  clientActionId: string,
): StaffOffboardingExecuteInput {
  const exact = exactKeys(draft.jobs, plan.jobs.map((item) => item.id))
    && exactKeys(draft.customers, plan.customers.map((item) => item.id))
    && exactKeys(draft.calendar, plan.calendar.map((item) => item.id))
    && exactKeys(draft.followUps, plan.followUps.map((item) => item.jobCardId))
    && exactKeys(draft.reminders, plan.reminders.map((item) => item.id));
  if (!exact || missingOffboardingDecisions(plan, draft).length > 0 || !clientActionId.trim()) {
    throw new Error('Offboarding kararları güncel önizlemeyle eşleşmiyor.');
  }
  return {
    clientActionId,
    planHash: plan.planHash,
    reasonCode: draft.reasonCode as StaffOffboardingReasonCode,
    jobDecisions: plan.jobs.map((item) => ({ jobCardId: item.id, replacementUserId: draft.jobs[item.id]! })),
    customerDecisions: plan.customers.map((item) => {
      const decision = draft.customers[item.id]!;
      return decision.action === 'REASSIGN'
        ? { customerId: item.id, action: 'REASSIGN', replacementUserId: decision.replacementUserId! }
        : { customerId: item.id, action: 'UNASSIGN' };
    }),
    calendarDecisions: plan.calendar.map((item) => ({ calendarEventId: item.id, replacementUserId: draft.calendar[item.id]! })),
    followUpDecisions: plan.followUps.map((item) => ({ jobCardId: item.jobCardId, replacementUserId: draft.followUps[item.jobCardId]! })),
    reminderDecisions: plan.reminders.map((item) => {
      const decision = draft.reminders[item.id]!;
      return decision.action === 'TRANSFER'
        ? { reminderId: item.id, action: 'TRANSFER', replacementUserId: decision.replacementUserId! }
        : { reminderId: item.id, action: 'CANCEL' };
    }),
  };
}
