import { hashRequestIdentity } from '../job-cards/critical-action-request-hash.js';
import { requireActionId, validation } from '../job-cards/validation.js';

export type WeeklyReportRemovalInput = {
  clientActionId: string;
  expectedVersion: number;
  expectedReportVersion: number;
  reason: string;
};

export function parseWeeklyReportRemovalInput(value: unknown): WeeklyReportRemovalInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validation('body');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => ![
    'clientActionId', 'expectedVersion', 'expectedReportVersion', 'reason',
  ].includes(key))) throw validation('body');
  for (const key of ['expectedVersion', 'expectedReportVersion']) {
    if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 1) throw validation(key);
  }
  if (typeof input.reason !== 'string') throw validation('reason');
  const reason = input.reason.trim();
  if (Array.from(reason).length < 1 || Array.from(reason).length > 2000) throw validation('reason');
  return { clientActionId: requireActionId(input.clientActionId),
    expectedVersion: input.expectedVersion as number,
    expectedReportVersion: input.expectedReportVersion as number, reason };
}

export function weeklyReportRemovalRequestHash(jobCardId: string, input: WeeklyReportRemovalInput) {
  return hashRequestIdentity({ operation: 'WEEKLY_REPORT_REMOVE:v1', jobCardId,
    expectedVersion: input.expectedVersion, expectedReportVersion: input.expectedReportVersion,
    reason: input.reason });
}
