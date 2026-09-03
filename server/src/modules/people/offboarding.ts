import { createHash } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import { AppError } from '../../errors/index.js';
import type { SafeUser } from '../auth/types.js';
import type { RealtimeService } from '../realtime/service.js';

export const STAFF_OFFBOARDING_REASON_CODES = [
  'ACCESS_ENDED',
  'ROLE_CHANGED',
  'ACCOUNT_CORRECTION',
  'OTHER_ADMINISTRATIVE',
] as const;

export type StaffOffboardingReasonCode = (typeof STAFF_OFFBOARDING_REASON_CODES)[number];
export type OffboardingCustomerAction = 'REASSIGN' | 'UNASSIGN';
export type OffboardingReminderAction = 'TRANSFER' | 'CANCEL';

const ACTIVE_JOB_STATUSES = [
  'NEW',
  'ACCEPTED',
  'IN_PROGRESS',
  'WAITING_APPROVAL',
  'REVISION_REQUESTED',
] as const;

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

type UserSnapshot = Readonly<{
  id: string;
  organizationId: string;
  role: string;
  isActive: boolean;
  version: number;
}>;

export type StaffOffboardingPlan = Readonly<{
  target: UserSnapshot;
  jobs: readonly Readonly<{
    id: string;
    status: string;
    version: number;
    assignedTo: string;
  }>[];
  customers: readonly Readonly<{
    id: string;
    assignedStaffUserId: string;
    version: number;
  }>[];
  calendar: readonly Readonly<{
    id: string;
    assignedUserId: string;
    status: string;
    version: number;
    startsAt: string;
    endsAt: string;
  }>[];
  followUps: readonly Readonly<{
    jobCardId: string;
    proposedAssignee: string;
    proposedAt: string;
    version: number;
  }>[];
  reminders: readonly Readonly<{
    id: string;
    recipientUserId: string;
    state: string;
    remindAt: string;
    nextAttemptAt: string;
  }>[];
  jobConversations: readonly Readonly<{
    jobCardId: string;
    conversationId: string;
  }>[];
  sessions: Readonly<{ activeCount: number }>;
  planHash: string;
}>;

export type OffboardingDecisionInput = Readonly<{
  clientActionId: string;
  planHash: string;
  reasonCode: StaffOffboardingReasonCode;
  jobDecisions: readonly Readonly<{ jobCardId: string; replacementUserId: string }>[];
  calendarDecisions: readonly Readonly<{ calendarEventId: string; replacementUserId: string }>[];
  followUpDecisions: readonly Readonly<{ jobCardId: string; replacementUserId: string }>[];
  customerDecisions: readonly Readonly<{
    customerId: string;
    action: OffboardingCustomerAction;
    replacementUserId?: string;
  }>[];
  reminderDecisions: readonly Readonly<{
    reminderId: string;
    action: OffboardingReminderAction;
    replacementUserId?: string;
  }>[];
}>;

type OffboardingDecisionWithTarget = OffboardingDecisionInput & Readonly<{
  targetUserId: string;
}>;

export type OffboardingSummary = Readonly<{
  jobCardsTransferred: number;
  customersReassigned: number;
  customersUnassigned: number;
  calendarAssignmentsTransferred: number;
  followUpAssignmentsTransferred: number;
  remindersHandled: number;
}>;

export type OffboardingResponse = Readonly<{
  status: 'OFFBOARDED';
  targetUserId: string;
  planHash: string;
  summary: OffboardingSummary;
}>;

function forbidden() {
  return new AppError('FORBIDDEN', 403, 'Bu işlem için yetkiniz yok.');
}

function notFound() {
  return new AppError('USER_NOT_FOUND', 404, 'Kullanıcı bulunamadı.');
}

function validation(message: string) {
  return new AppError('VALIDATION_ERROR', 400, message);
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function sortById<T extends { id: string }>(items: readonly T[]) {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function canonicalPlan(plan: Omit<StaffOffboardingPlan, 'planHash'>) {
  return {
    target: plan.target,
    jobs: sortById(plan.jobs),
    customers: sortById(plan.customers),
    calendar: sortById(plan.calendar),
    followUps: [...plan.followUps].sort((a, b) => a.jobCardId.localeCompare(b.jobCardId)),
    reminders: sortById(plan.reminders),
    jobConversations: [...plan.jobConversations].sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
  };
}

export function computeStaffOffboardingPlanHash(plan: Omit<StaffOffboardingPlan, 'planHash'>) {
  return sha256(JSON.stringify(canonicalPlan(plan)));
}

function canonicalDecisions(input: OffboardingDecisionWithTarget) {
  return {
    targetUserId: input.targetUserId,
    planHash: input.planHash,
    reasonCode: input.reasonCode,
    jobDecisions: sortById(input.jobDecisions.map((item) => ({ id: item.jobCardId, replacementUserId: item.replacementUserId }))),
    calendarDecisions: sortById(input.calendarDecisions.map((item) => ({ id: item.calendarEventId, replacementUserId: item.replacementUserId }))),
    followUpDecisions: sortById(input.followUpDecisions.map((item) => ({ id: item.jobCardId, replacementUserId: item.replacementUserId }))),
    customerDecisions: sortById(input.customerDecisions.map((item) => ({ id: item.customerId, action: item.action, replacementUserId: item.replacementUserId ?? null }))),
    reminderDecisions: sortById(input.reminderDecisions.map((item) => ({ id: item.reminderId, action: item.action, replacementUserId: item.replacementUserId ?? null }))),
  };
}

export function computeStaffOffboardingRequestHash(input: OffboardingDecisionWithTarget) {
  return sha256(JSON.stringify(canonicalDecisions(input)));
}

function assertAdmin(actor: SafeUser) {
  if (actor.role !== 'ADMIN') throw forbidden();
}

function assertReasonCode(value: unknown): asserts value is StaffOffboardingReasonCode {
  if (!STAFF_OFFBOARDING_REASON_CODES.includes(value as StaffOffboardingReasonCode)) {
    throw validation('reasonCode geçersizdir.');
  }
}

function assertActionId(value: string) {
  if (!value.trim() || value.length > 255) throw validation('clientActionId geçersizdir.');
}

function asUser(row: {
  id: string; organization_id: string; role: string; is_active: boolean; version: number;
}): UserSnapshot {
  return {
    id: row.id,
    organizationId: row.organization_id,
    role: row.role,
    isActive: row.is_active,
    version: row.version,
  };
}

export class PostgresStaffOffboardingService {
  constructor(
    private readonly pool: Pool,
    private readonly realtime?: Pick<RealtimeService, 'disconnectUser'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async preview(actor: SafeUser, targetUserId: string): Promise<StaffOffboardingPlan> {
    assertAdmin(actor);
    const actorRow = await this.pool.query<{ role: string; is_active: boolean }>(
      `SELECT role, is_active FROM users WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, actor.id],
    );
    if (actorRow.rows[0]?.role !== 'ADMIN' || actorRow.rows[0]?.is_active !== true) throw forbidden();
    const target = await this.pool.query<{
      id: string; organization_id: string; role: string; is_active: boolean; version: number;
    }>(
      `SELECT id, organization_id, role, is_active, version
         FROM users WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, targetUserId],
    );
    const row = target.rows[0];
    if (!row) throw notFound();
    if (row.role !== 'STAFF') throw new AppError('OFFBOARDING_TARGET_NOT_STAFF', 409, 'Offboarding hedefi Staff olmalıdır.');
    return this.readPlan(this.pool, asUser(row), false);
  }

  async execute(actor: SafeUser, targetUserId: string, input: OffboardingDecisionInput): Promise<OffboardingResponse> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.executeOnce(actor, targetUserId, input);
      } catch (error) {
        if ((error as { code?: string }).code !== '40001' || attempt >= 2) throw error;
      }
    }
  }

  private async executeOnce(actor: SafeUser, targetUserId: string, input: OffboardingDecisionInput): Promise<OffboardingResponse> {
    assertAdmin(actor);
    assertActionId(input.clientActionId);
    assertReasonCode(input.reasonCode);
    if (!/^[0-9a-f]{64}$/.test(input.planHash)) throw validation('planHash geçersizdir.');

    const client = await this.pool.connect();
    let committed = false;
    try {
      // Lock all User rows before any mutable responsibility row. READ
      // COMMITTED is intentional: the conflict statements issued after a
      // replacement lock must observe commits that won while this transaction
      // was waiting for that lock.
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      const actorRow = await client.query<{ role: string; is_active: boolean }>(
        `SELECT role, is_active FROM users WHERE organization_id = $1 AND id = $2 FOR SHARE`,
        [actor.organizationId, actor.id],
      );
      if (actorRow.rows[0]?.role !== 'ADMIN' || actorRow.rows[0]?.is_active !== true) throw forbidden();

      const targetRow = await client.query<{
        id: string; organization_id: string; role: string; is_active: boolean; version: number;
      }>(
        `SELECT id, organization_id, role, is_active, version
           FROM users WHERE organization_id = $1 AND id = $2`,
        [actor.organizationId, targetUserId],
      );
      const target = targetRow.rows[0];
      if (!target) throw notFound();
      const operationKey = `USER_OFFBOARDING:${targetUserId}`;
      const requestHash = computeStaffOffboardingRequestHash({ ...input, targetUserId });
      const receipt = await client.query<{
        status: string; request_hash: string | null; status_code: number | null; response_body: OffboardingResponse | null;
      }>(
        `SELECT status, request_hash, status_code, response_body
           FROM processed_actions
          WHERE organization_id = $1 AND user_id = $2
            AND client_action_id = $3 AND operation_key = $4`,
        [actor.organizationId, actor.id, input.clientActionId, operationKey],
      );
      const existing = receipt.rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw new AppError('CLIENT_ACTION_REUSED', 409, 'clientActionId farklı bir işlem için kullanılamaz.');
        if (existing.status === 'completed' && existing.response_body) {
          await client.query('COMMIT');
          committed = true;
          return existing.response_body;
        }
        throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');
      }

      await client.query(
        `INSERT INTO processed_actions
          (organization_id, user_id, client_action_id, operation_key, status, request_hash)
         VALUES ($1, $2, $3, $4, 'processing', $5)
         ON CONFLICT (organization_id, user_id, client_action_id, operation_key) DO NOTHING`,
        [actor.organizationId, actor.id, input.clientActionId, operationKey, requestHash],
      );
      const claimed = await client.query<{ status: string; request_hash: string | null; response_body: OffboardingResponse | null }>(
        `SELECT status, request_hash, response_body FROM processed_actions
          WHERE organization_id = $1 AND user_id = $2 AND client_action_id = $3 AND operation_key = $4
          FOR UPDATE`,
        [actor.organizationId, actor.id, input.clientActionId, operationKey],
      );
      const claim = claimed.rows[0];
      if (!claim || claim.request_hash !== requestHash) throw new AppError('CLIENT_ACTION_REUSED', 409, 'clientActionId farklı bir işlem için kullanılamaz.');
      if (claim.status === 'completed' && claim.response_body) {
        await client.query('COMMIT');
        committed = true;
        return claim.response_body;
      }
      if (claim.status !== 'processing') throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı işlem halen devam ediyor.');

      const replacementIds = this.replacementIds(input);
      const userIds = [...new Set([targetUserId, ...replacementIds])].sort();
      const lockedUsers = await client.query<{
        id: string; organization_id: string; role: string; is_active: boolean; version: number;
      }>(
        `SELECT id, organization_id, role, is_active, version FROM users
          WHERE organization_id = $1 AND id = ANY($2::uuid[])
          ORDER BY id FOR UPDATE`,
        [actor.organizationId, userIds],
      );
      const lockedTarget = lockedUsers.rows.find((item) => item.id === targetUserId);
      if (!lockedTarget) throw notFound();
      if (lockedTarget.role !== 'STAFF') throw new AppError('OFFBOARDING_TARGET_NOT_STAFF', 409, 'Offboarding hedefi Staff olmalıdır.');
      if (!lockedTarget.is_active) throw new AppError('USER_ALREADY_INACTIVE', 409, 'Staff zaten pasiftir.');

      const currentPlan = await this.readPlan(client, asUser(lockedTarget), true);
      if (currentPlan.planHash !== input.planHash) throw new AppError('STALE_PLAN', 409, 'Offboarding planı güncel değil.');
      this.validateDecisions(currentPlan, input);

      const replacements = lockedUsers.rows.filter((item) => item.id !== targetUserId);
      if (replacements.length !== replacementIds.length
        || replacements.some((item) => item.role !== 'STAFF' || !item.is_active)) {
        throw new AppError('INVALID_REPLACEMENT_STAFF', 409, 'Replacement Staff geçersiz veya aktif değil.');
      }

      const summary = await this.applyMutations(client, actor, targetUserId, input, currentPlan);
      await client.query(
        `UPDATE sessions SET revoked_at = COALESCE(revoked_at, $2) WHERE user_id = $1`,
        [targetUserId, this.now()],
      );
      const inactive = await client.query(
        `UPDATE users SET is_active = FALSE, version = version + 1, updated_at = $3
          WHERE organization_id = $1 AND id = $2 AND is_active = TRUE`,
        [actor.organizationId, targetUserId, this.now()],
      );
      if ((inactive.rowCount ?? 0) !== 1) throw new AppError('VERSION_CONFLICT', 409, 'Staff başka bir işlem tarafından güncellendi.');

      await client.query(
        `INSERT INTO audit_events
          (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
         VALUES ($1, $2, 'USER', $3, 'USER_OFFBOARDED', $4::jsonb, $5::jsonb, $6::jsonb)`,
        [
          actor.organizationId,
          actor.id,
          targetUserId,
          JSON.stringify({ role: 'STAFF', isActive: true }),
          JSON.stringify({ role: 'STAFF', isActive: false }),
          JSON.stringify({ targetUserId, reasonCode: input.reasonCode, previousRole: 'STAFF', responsibilitySummary: summary }),
        ],
      );

      const response: OffboardingResponse = {
        status: 'OFFBOARDED', targetUserId, planHash: input.planHash, summary,
      };
      await client.query(
        `UPDATE processed_actions SET status = 'completed', status_code = 200,
            response_body = $2::jsonb, completed_at = $3
          WHERE organization_id = $1 AND user_id = $4
            AND client_action_id = $5 AND operation_key = $6`,
        [actor.organizationId, JSON.stringify(response), this.now(), actor.id, input.clientActionId, operationKey],
      );
      await client.query('COMMIT');
      committed = true;
      try { this.realtime?.disconnectUser(actor.organizationId, targetUserId); } catch { /* durable state is authoritative */ }
      return response;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private replacementIds(input: OffboardingDecisionInput) {
    return [...new Set([
      ...input.jobDecisions.map((item) => item.replacementUserId),
      ...input.calendarDecisions.map((item) => item.replacementUserId),
      ...input.followUpDecisions.map((item) => item.replacementUserId),
      ...input.customerDecisions.flatMap((item) => item.replacementUserId ? [item.replacementUserId] : []),
      ...input.reminderDecisions.flatMap((item) => item.replacementUserId ? [item.replacementUserId] : []),
    ])].sort();
  }

  private validateDecisions(plan: StaffOffboardingPlan, input: OffboardingDecisionInput) {
    const exact = (actual: readonly string[], expected: readonly string[], label: string) => {
      const a = [...actual].sort();
      const e = [...expected].sort();
      if (a.length !== e.length || a.some((value, index) => value !== e[index])) throw validation(`${label} kararları eksik veya fazladır.`);
    };
    exact(input.jobDecisions.map((item) => item.jobCardId), plan.jobs.map((item) => item.id), 'JobCard');
    exact(input.calendarDecisions.map((item) => item.calendarEventId), plan.calendar.map((item) => item.id), 'Calendar');
    exact(input.followUpDecisions.map((item) => item.jobCardId), plan.followUps.map((item) => item.jobCardId), 'Follow-up');
    exact(input.customerDecisions.map((item) => item.customerId), plan.customers.map((item) => item.id), 'Customer');
    exact(input.reminderDecisions.map((item) => item.reminderId), plan.reminders.map((item) => item.id), 'Reminder');
    for (const item of [...input.jobDecisions, ...input.calendarDecisions, ...input.followUpDecisions]) {
      if (!item.replacementUserId?.trim()) throw validation('Her transfer kararı için replacementUserId zorunludur.');
    }
    if (new Set(input.jobDecisions.map((item) => item.jobCardId)).size !== input.jobDecisions.length) throw validation('JobCard kararı tekrarlanamaz.');
    if (new Set(input.calendarDecisions.map((item) => item.calendarEventId)).size !== input.calendarDecisions.length) throw validation('Calendar kararı tekrarlanamaz.');
    if (new Set(input.followUpDecisions.map((item) => item.jobCardId)).size !== input.followUpDecisions.length) throw validation('Follow-up kararı tekrarlanamaz.');
    if (new Set(input.customerDecisions.map((item) => item.customerId)).size !== input.customerDecisions.length) throw validation('Customer kararı tekrarlanamaz.');
    if (new Set(input.reminderDecisions.map((item) => item.reminderId)).size !== input.reminderDecisions.length) throw validation('Reminder kararı tekrarlanamaz.');
    for (const item of input.customerDecisions) {
      if (item.action !== 'REASSIGN' && item.action !== 'UNASSIGN') throw validation('Customer kararı geçersizdir.');
      if (item.action === 'REASSIGN' && !item.replacementUserId) throw validation('REASSIGN için replacementUserId zorunludur.');
      if (item.action === 'UNASSIGN' && item.replacementUserId) throw validation('UNASSIGN replacementUserId içeremez.');
    }
    for (const item of input.reminderDecisions) {
      if (item.action !== 'TRANSFER' && item.action !== 'CANCEL') throw validation('Reminder kararı geçersizdir.');
      if (item.action === 'TRANSFER' && !item.replacementUserId) throw validation('TRANSFER için replacementUserId zorunludur.');
      if (item.action === 'CANCEL' && item.replacementUserId) throw validation('CANCEL replacementUserId içeremez.');
    }
  }

  private async applyMutations(
    client: PoolClient,
    actor: SafeUser,
    targetUserId: string,
    input: OffboardingDecisionInput,
    plan: StaffOffboardingPlan,
  ): Promise<OffboardingSummary> {
    const jobDecision = new Map(input.jobDecisions.map((item) => [item.jobCardId, item.replacementUserId]));
    const followUpDecision = new Map(input.followUpDecisions.map((item) => [item.jobCardId, item.replacementUserId]));
    const currentJobs = new Map(plan.jobs.map((item) => [item.id, item]));
    const currentFollowUps = new Map(plan.followUps.map((item) => [item.jobCardId, item]));
    for (const jobId of [...new Set([...jobDecision.keys(), ...followUpDecision.keys()])].sort()) {
      const replacementForJob = jobDecision.get(jobId);
      if (replacementForJob) {
        const jobInterval = await client.query<{ scheduled_at: Date | null; scheduled_ends_at: Date | null }>(
          `SELECT scheduled_at, scheduled_ends_at FROM job_cards WHERE organization_id = $1 AND id = $2`,
          [actor.organizationId, jobId],
        );
        const row = jobInterval.rows[0];
        const scheduledAt = row?.scheduled_at ? row.scheduled_at.toISOString() : null;
        const scheduledEndsAt = row?.scheduled_ends_at ? row.scheduled_ends_at.toISOString() : null;
        await this.assertJobCardAssignmentAvailable(client, actor.organizationId, replacementForJob, jobId, scheduledAt, scheduledEndsAt);
      }
      const updated = await client.query(
        `UPDATE job_cards SET
            assigned_to = CASE WHEN $2::uuid IS NULL THEN assigned_to ELSE $2::uuid END,
            follow_up_proposed_assignee = CASE WHEN $3::uuid IS NULL THEN follow_up_proposed_assignee ELSE $3::uuid END,
            version = version + 1, updated_at = $4
          WHERE organization_id = $1 AND id = $5 AND (assigned_to = $6 OR follow_up_proposed_assignee = $6)`,
        [actor.organizationId, jobDecision.get(jobId) ?? null, followUpDecision.get(jobId) ?? null, this.now(), jobId, targetUserId],
      );
      if (updated.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 409, 'JobCard başka bir işlem tarafından güncellendi.');
      const previousJob = currentJobs.get(jobId);
      const previousFollowUp = currentFollowUps.get(jobId);
      if (jobDecision.has(jobId) && previousJob) {
        await this.appendJobAssignmentEffect(client, actor, input, jobId, previousJob.assignedTo, jobDecision.get(jobId)!);
      }
      if (followUpDecision.has(jobId) && previousFollowUp) {
        await this.appendJobFieldsEffect(
          client,
          actor,
          input,
          jobId,
          { followUpProposedAssignee: previousFollowUp.proposedAssignee },
          { followUpProposedAssignee: followUpDecision.get(jobId)! },
          followUpDecision.get(jobId)!,
        );
      }
    }

    for (const decision of [...input.customerDecisions].sort((a, b) => a.customerId.localeCompare(b.customerId))) {
      const updated = await client.query(
        `UPDATE customers SET assigned_staff_user_id = $3, version = version + 1, updated_at = $4
          WHERE organization_id = $1 AND id = $2 AND assigned_staff_user_id = $5`,
        [actor.organizationId, decision.customerId, decision.action === 'REASSIGN' ? decision.replacementUserId : null, this.now(), targetUserId],
      );
      if (updated.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 409, 'Customer başka bir işlem tarafından güncellendi.');
      await client.query(
        `INSERT INTO audit_events
          (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
         VALUES ($1, $2, 'CUSTOMER', $3, 'CUSTOMER_ASSIGNEE_CHANGED', $4::jsonb, $5::jsonb, $6::jsonb)`,
        [actor.organizationId, actor.id, decision.customerId,
          JSON.stringify({ assignedStaffUserId: targetUserId }),
          JSON.stringify({ assignedStaffUserId: decision.action === 'REASSIGN' ? decision.replacementUserId : null }),
          JSON.stringify({ reason: 'STAFF_OFFBOARDED' })],
      );
    }
    for (const decision of [...input.calendarDecisions].sort((a, b) => a.calendarEventId.localeCompare(b.calendarEventId))) {
      const current = plan.calendar.find((item) => item.id === decision.calendarEventId);
      if (!current) throw new AppError('VERSION_CONFLICT', 409, 'Calendar kaydı başka bir işlem tarafından güncellendi.');
      await this.assertCalendarAssignmentAvailable(client, actor.organizationId, decision.replacementUserId, current);
      const updated = await client.query(
        `UPDATE calendar_events SET assigned_user_id = $3, updated_by = $4, version = version + 1, updated_at = $5
          WHERE organization_id = $1 AND id = $2 AND assigned_user_id = $6 AND status = 'ACTIVE'`,
        [actor.organizationId, decision.calendarEventId, decision.replacementUserId, actor.id, this.now(), targetUserId],
      );
      if (updated.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 409, 'Calendar kaydı başka bir işlem tarafından güncellendi.');
      await this.appendCalendarAssignmentEffect(client, actor, input, decision.calendarEventId, decision.replacementUserId);
    }
    for (const decision of [...input.reminderDecisions].sort((a, b) => a.reminderId.localeCompare(b.reminderId))) {
      if (decision.action === 'TRANSFER') {
        const updated = await client.query(
          `UPDATE calendar_reminders SET recipient_user_id = $3, updated_at = $4
            WHERE organization_id = $1 AND id = $2 AND recipient_user_id = $5 AND state IN ('PENDING', 'CLAIMED')`,
          [actor.organizationId, decision.reminderId, decision.replacementUserId, this.now(), targetUserId],
        );
        if (updated.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 409, 'Reminder başka bir işlem tarafından güncellendi.');
      } else {
        const updated = await client.query(
          `UPDATE calendar_reminders SET state = 'CANCELLED', cancelled_at = $3,
              lease_token = NULL, lease_until = NULL, updated_at = $3
            WHERE organization_id = $1 AND id = $2 AND recipient_user_id = $4 AND state IN ('PENDING', 'CLAIMED')`,
          [actor.organizationId, decision.reminderId, this.now(), targetUserId],
        );
        if (updated.rowCount !== 1) throw new AppError('VERSION_CONFLICT', 409, 'Reminder başka bir işlem tarafından güncellendi.');
      }
    }
    await this.syncJobConversations(client, actor, targetUserId, input, plan);
    return {
      jobCardsTransferred: input.jobDecisions.length,
      customersReassigned: input.customerDecisions.filter((item) => item.action === 'REASSIGN').length,
      customersUnassigned: input.customerDecisions.filter((item) => item.action === 'UNASSIGN').length,
      calendarAssignmentsTransferred: input.calendarDecisions.length,
      followUpAssignmentsTransferred: input.followUpDecisions.length,
      remindersHandled: input.reminderDecisions.length,
    };
  }

  private async appendJobAssignmentEffect(
    client: PoolClient,
    actor: SafeUser,
    input: OffboardingDecisionInput,
    jobCardId: string,
    previousAssignee: string,
    nextAssignee: string,
  ) {
    const activity = await client.query<{ id: string }>(
      `INSERT INTO job_card_activity_logs
        (organization_id, job_card_id, actor_id, event_type, old_value, new_value, metadata, client_action_id)
       VALUES ($1, $2, $3, 'JOB_ASSIGNED', $4::jsonb, $5::jsonb, $6::jsonb, $7)
       RETURNING id`,
      [actor.organizationId, jobCardId, actor.id,
        JSON.stringify({ assignedTo: previousAssignee }), JSON.stringify({ assignedTo: nextAssignee }),
        JSON.stringify({ reason: 'STAFF_OFFBOARDED' }), `${input.clientActionId}:job:${jobCardId}`],
    );
    await client.query(
      `INSERT INTO realtime_events
        (organization_id, source_activity_id, event_type, entity_type, entity_id, actor_user_id,
         audience_roles, audience_user_ids, resource_keys, created_at)
       VALUES ($1, $2, 'job.assignment_changed', 'job-card', $3::uuid, $4,
         ARRAY['ADMIN','MANAGER']::varchar(20)[], ARRAY[$5]::uuid[],
         ARRAY['jobs','job:' || $3::text,'overview'], $6)`,
      [actor.organizationId, activity.rows[0]!.id, jobCardId, actor.id, nextAssignee, this.now()],
    );
  }

  private async appendJobFieldsEffect(
    client: PoolClient,
    actor: SafeUser,
    input: OffboardingDecisionInput,
    jobCardId: string,
    oldValue: Record<string, unknown>,
    newValue: Record<string, unknown>,
    audienceUserId: string,
  ) {
    const activity = await client.query<{ id: string }>(
      `INSERT INTO job_card_activity_logs
        (organization_id, job_card_id, actor_id, event_type, old_value, new_value, metadata, client_action_id)
       VALUES ($1, $2, $3, 'JOB_FIELDS_UPDATED', $4::jsonb, $5::jsonb, $6::jsonb, $7)
       RETURNING id`,
      [actor.organizationId, jobCardId, actor.id, JSON.stringify(oldValue), JSON.stringify(newValue),
        JSON.stringify({ reason: 'STAFF_OFFBOARDED' }), `${input.clientActionId}:follow-up:${jobCardId}`],
    );
    await client.query(
      `INSERT INTO realtime_events
        (organization_id, source_activity_id, event_type, entity_type, entity_id, actor_user_id,
         audience_roles, audience_user_ids, resource_keys, created_at)
       VALUES ($1, $2, 'job.updated', 'job-card', $3::uuid, $4,
         ARRAY['ADMIN','MANAGER']::varchar(20)[], ARRAY[$5]::uuid[],
         ARRAY['jobs','job:' || $3::text,'overview'], $6)`,
      [actor.organizationId, activity.rows[0]!.id, jobCardId, actor.id, audienceUserId, this.now()],
    );
  }

  private async appendCalendarAssignmentEffect(
    client: PoolClient,
    actor: SafeUser,
    input: OffboardingDecisionInput,
    calendarEventId: string,
    audienceUserId: string,
  ) {
    const activity = await client.query<{ id: string }>(
      `INSERT INTO calendar_event_activity_logs
        (organization_id, calendar_event_id, actor_user_id, action, changed_fields, reason, client_action_id)
       VALUES ($1, $2, $3, 'UPDATED', ARRAY['assignedUserId'], 'STAFF_OFFBOARDED', $4)
       RETURNING id`,
      [actor.organizationId, calendarEventId, actor.id, `${input.clientActionId}:calendar:${calendarEventId}`],
    );
    await client.query(
      `INSERT INTO realtime_events
        (organization_id, source_activity_id, calendar_activity_id, event_type, entity_type, entity_id,
         actor_user_id, audience_roles, audience_user_ids, resource_keys, created_at)
       VALUES ($1, NULL, $2, 'calendar.updated', 'calendar-event', $3::uuid, $4,
         ARRAY['ADMIN','MANAGER']::varchar(20)[], ARRAY[$5]::uuid[],
         ARRAY['calendar','calendar:' || $3::text,'overview'], $6)`,
      [actor.organizationId, activity.rows[0]!.id, calendarEventId, actor.id, audienceUserId, this.now()],
    );
  }

  private async assertCalendarAssignmentAvailable(
    client: PoolClient,
    organizationId: string,
    replacementUserId: string,
    event: StaffOffboardingPlan['calendar'][number],
  ) {
    const conflict = await client.query(
      `SELECT 1
          FROM calendar_events e
         WHERE e.organization_id = $1 AND e.assigned_user_id = $2 AND e.status = 'ACTIVE'
           AND e.id <> $3 AND e.starts_at < $5 AND $4 < e.ends_at
        UNION ALL
        SELECT 1
          FROM job_cards j
         WHERE j.organization_id = $1 AND j.assigned_to = $2
           AND j.status IN ('NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED')
           AND j.scheduled_at IS NOT NULL AND j.scheduled_ends_at IS NOT NULL
           AND j.scheduled_at < $5 AND $4 < j.scheduled_ends_at
        LIMIT 1`,
      [organizationId, replacementUserId, event.id, event.startsAt, event.endsAt],
    );
    if (conflict.rows.length > 0) {
      throw new AppError('CALENDAR_CONFLICT', 409, 'Seçilen replacement Staff için çakışan bir takvim sorumluluğu bulunuyor.');
    }
  }

  private async assertJobCardAssignmentAvailable(
    client: PoolClient,
    organizationId: string,
    replacementUserId: string,
    jobCardId: string,
    scheduledAt: string | null,
    scheduledEndsAt: string | null,
  ) {
    if (!scheduledAt || !scheduledEndsAt) return;
    const conflict = await client.query(
      `SELECT 1
          FROM calendar_events e
         WHERE e.organization_id = $1 AND e.assigned_user_id = $2 AND e.status = 'ACTIVE'
           AND e.starts_at < $4 AND $3 < e.ends_at
        UNION ALL
        SELECT 1
          FROM job_cards j
         WHERE j.organization_id = $1 AND j.assigned_to = $2
           AND j.status IN ('NEW','ACCEPTED','IN_PROGRESS','WAITING_APPROVAL','REVISION_REQUESTED')
           AND j.scheduled_at IS NOT NULL AND j.scheduled_ends_at IS NOT NULL
           AND j.id <> $5 AND j.scheduled_at < $4 AND $3 < j.scheduled_ends_at
        LIMIT 1`,
      [organizationId, replacementUserId, scheduledAt, scheduledEndsAt, jobCardId],
    );
    if (conflict.rows.length > 0) {
      throw new AppError('CALENDAR_CONFLICT', 409, 'Seçilen replacement Staff için çakışan bir takvim sorumluluğu bulunuyor.');
    }
  }

  private async syncJobConversations(
    client: PoolClient,
    actor: SafeUser,
    targetUserId: string,
    input: OffboardingDecisionInput,
    plan: StaffOffboardingPlan,
  ) {
    const transfers = input.jobDecisions.filter((item) => item.replacementUserId);
    for (const transfer of transfers.sort((a, b) => a.jobCardId.localeCompare(b.jobCardId))) {
      const conversations = plan.jobConversations.filter((item) => item.jobCardId === transfer.jobCardId);
      for (const conversation of conversations) {
        await client.query(
          `DELETE FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2`,
          [conversation.conversationId, targetUserId],
        );
        await client.query(
          `INSERT INTO conversation_participants (conversation_id, user_id, organization_id)
           VALUES ($1, $2, $3) ON CONFLICT (conversation_id, user_id) DO NOTHING`,
          [conversation.conversationId, transfer.replacementUserId, actor.organizationId],
        );
        const actionId = `${input.clientActionId}:${conversation.conversationId}`;
        const activity = await client.query<{ id: string }>(
          `INSERT INTO messaging_activity_logs
             (organization_id, conversation_id, actor_user_id, action, client_action_id, details)
           VALUES ($1, $2, $3, 'PARTICIPANTS_CHANGED', $4, $5::jsonb)
           ON CONFLICT (organization_id, actor_user_id, client_action_id, action) DO NOTHING
           RETURNING id`,
          [actor.organizationId, conversation.conversationId, actor.id, actionId,
            JSON.stringify({ removedUserIds: [targetUserId], addedUserIds: [transfer.replacementUserId] })],
        );
        if (activity.rows[0]) {
          await client.query(
            `INSERT INTO realtime_events
              (organization_id, source_activity_id, messaging_activity_id, event_type,
               entity_type, entity_id, actor_user_id, audience_roles, audience_user_ids,
               resource_keys, created_at)
             VALUES ($1, NULL, $2, 'conversation.participants_changed', 'conversation', $3::uuid,
               $4, ARRAY['ADMIN','MANAGER']::VARCHAR(20)[], ARRAY[$5]::UUID[],
               ARRAY['messaging','conversation:' || $3::text], $6)`,
            [actor.organizationId, activity.rows[0].id, conversation.conversationId, actor.id,
              transfer.replacementUserId, this.now()],
          );
        }
      }
    }
  }

  private async readPlan(queryable: Queryable, target: UserSnapshot, lock: boolean): Promise<StaffOffboardingPlan> {
    const suffix = lock ? ' FOR UPDATE' : '';
    const at = this.now();
    const jobs = await queryable.query<{ id: string; status: string; version: number; assigned_to: string }>(
      `SELECT id, status, version, assigned_to FROM job_cards
        WHERE organization_id = $1 AND assigned_to = $2 AND status = ANY($3::varchar[])
        ORDER BY id${suffix}`,
      [target.organizationId, target.id, ACTIVE_JOB_STATUSES],
    );
    const followUps = await queryable.query<{ job_card_id: string; follow_up_proposed_assignee: string; follow_up_proposed_at: Date; version: number }>(
      `SELECT id AS job_card_id, follow_up_proposed_assignee, follow_up_proposed_at, version FROM job_cards
        WHERE organization_id = $1 AND follow_up_proposed_assignee = $2 AND follow_up_proposed_at > $3
        ORDER BY id${suffix}`,
      [target.organizationId, target.id, at],
    );
    const customers = await queryable.query<{ id: string; assigned_staff_user_id: string; version: number }>(
      `SELECT id, assigned_staff_user_id, version FROM customers
        WHERE organization_id = $1 AND assigned_staff_user_id = $2 ORDER BY id${suffix}`,
      [target.organizationId, target.id],
    );
    const calendar = await queryable.query<{ id: string; assigned_user_id: string; status: string; version: number; starts_at: Date; ends_at: Date }>(
      `SELECT id, assigned_user_id, status, version, starts_at, ends_at FROM calendar_events
        WHERE organization_id = $1 AND assigned_user_id = $2 AND status = 'ACTIVE' AND starts_at > $3
        ORDER BY id${suffix}`,
      [target.organizationId, target.id, at],
    );
    const reminders = await queryable.query<{ id: string; recipient_user_id: string; state: string; remind_at: Date; next_attempt_at: Date }>(
      `SELECT id, recipient_user_id, state, remind_at, next_attempt_at FROM calendar_reminders
        WHERE organization_id = $1 AND recipient_user_id = $2 AND state IN ('PENDING', 'CLAIMED')
          AND (remind_at > $3 OR next_attempt_at > $3)
        ORDER BY id${suffix}`,
      [target.organizationId, target.id, at],
    );
    const conversations = await queryable.query<{ job_id: string; id: string }>(
      `SELECT id, job_id FROM conversations
        WHERE organization_id = $1 AND context_type = 'JOB'
          AND job_id = ANY($2::uuid[]) ORDER BY id${suffix}`,
      [target.organizationId, jobs.rows.map((item) => item.id)],
    );
    const sessions = await queryable.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [target.id, at],
    );
    const base = {
      target,
      jobs: jobs.rows.map((row) => ({ id: row.id, status: row.status, version: row.version, assignedTo: row.assigned_to })),
      customers: customers.rows.map((row) => ({ id: row.id, assignedStaffUserId: row.assigned_staff_user_id, version: row.version })),
      calendar: calendar.rows.map((row) => ({ id: row.id, assignedUserId: row.assigned_user_id, status: row.status, version: row.version, startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString() })),
      followUps: followUps.rows.map((row) => ({ jobCardId: row.job_card_id, proposedAssignee: row.follow_up_proposed_assignee, proposedAt: row.follow_up_proposed_at.toISOString(), version: row.version })),
      reminders: reminders.rows.map((row) => ({ id: row.id, recipientUserId: row.recipient_user_id, state: row.state, remindAt: row.remind_at.toISOString(), nextAttemptAt: row.next_attempt_at.toISOString() })),
      jobConversations: conversations.rows.map((row) => ({ jobCardId: row.job_id, conversationId: row.id })),
      sessions: { activeCount: Number(sessions.rows[0]?.count ?? 0) },
    };
    return { ...base, planHash: computeStaffOffboardingPlanHash(base) };
  }
}
