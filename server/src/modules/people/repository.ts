import type { Pool, PoolClient } from 'pg';

import type {
  CredentialAdministrationPort,
  SessionRevocationPort,
} from '../auth/admin-ports.js';
import type { UserRole } from '../auth/types.js';
import type {
  AppendAuditInput,
  CreateStaffProfileRecord,
  CreateUserRecord,
  ManagedUserRecord,
  UserDataClass,
  UserDeletionFacts,
  UserDeletionTarget,
  SafeManagedUser,
  StaffProfileDetails,
  StaffProfileRecord,
  StaffStatusFilter,
  UpdateStaffProfileRecord,
} from './types.js';
import type { ClearCustomerAssignmentsInput, CustomerAssignmentCleanupPort } from './customer-assignment-port.js';

type UserRow = {
  id: string; organization_id: string; name: string; email: string; password_hash: string;
  role: UserRole; must_change_password: boolean; is_active: boolean; version: number;
  last_login_at: Date | null; created_at: Date; updated_at: Date;
};

type UserDeletionRow = UserRow & { data_class: UserDataClass };

type UserDeletionFactsRow = {
  data_class: UserDataClass;
  has_business_history: boolean;
  has_active_responsibilities: boolean;
};

type StaffProfileRow = {
  id: string; organization_id: string; user_id: string; title: string | null;
  phone: string | null; region: string | null; manager_user_id: string | null;
  version: number; created_at: Date; updated_at: Date;
};

type StaffProfileDetailsRow = UserRow & StaffProfileRow & {
  profile_id: string; profile_version: number; profile_created_at: Date; profile_updated_at: Date;
  manager_name: string | null;
};

const USER_COLUMNS = `id, organization_id, name, email, password_hash, role,
  must_change_password, is_active, version, last_login_at, created_at, updated_at`;

function mapUser(row: UserRow): ManagedUserRecord {
  return {
    id: row.id, organizationId: row.organization_id, name: row.name, email: row.email,
    passwordHash: row.password_hash, role: row.role, mustChangePassword: row.must_change_password,
    isActive: row.is_active, version: row.version, lastLoginAt: row.last_login_at,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function safeUser(row: UserRow): SafeManagedUser {
  const { passwordHash: _passwordHash, ...safe } = mapUser(row);
  return safe;
}

function mapProfile(row: StaffProfileRow): StaffProfileRecord {
  return {
    id: row.id, organizationId: row.organization_id, userId: row.user_id,
    title: row.title, phone: row.phone, region: row.region, managerUserId: row.manager_user_id,
    version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function mapProfileDetails(row: StaffProfileDetailsRow): StaffProfileDetails {
  return {
    id: row.profile_id,
    user: safeUser(row),
    title: row.title,
    phone: row.phone,
    region: row.region,
    managerUserId: row.manager_user_id,
    managerName: row.manager_name,
    version: row.profile_version,
  };
}

export interface PeopleTransaction {
  lockUser(organizationId: string, userId: string): Promise<ManagedUserRecord | null>;
  lockActiveAdmins(organizationId: string): Promise<void>;
  lockUserForDeletion(organizationId: string, userId: string): Promise<UserDeletionTarget | null>;
  inspectUserDeletion(organizationId: string, userId: string): Promise<Omit<UserDeletionFacts, 'activeAdminCount'> | null>;
  findUserByEmail(normalizedEmail: string): Promise<ManagedUserRecord | null>;
  lockStaffProfile(organizationId: string, userId: string): Promise<StaffProfileRecord | null>;
  createUser(input: CreateUserRecord): Promise<ManagedUserRecord>;
  createStaffProfile(input: CreateStaffProfileRecord): Promise<StaffProfileRecord>;
  updateUserName(userId: string, expectedVersion: number, name: string): Promise<ManagedUserRecord | null>;
  changeRole(userId: string, expectedVersion: number, role: 'ADMIN' | 'MANAGER'): Promise<ManagedUserRecord | null>;
  setActive(userId: string, expectedVersion: number, active: boolean): Promise<ManagedUserRecord | null>;
  updateStaffProfile(input: UpdateStaffProfileRecord): Promise<StaffProfileRecord | null>;
  countActiveAdmins(organizationId: string): Promise<number>;
  hasActiveJobCards(userId: string): Promise<boolean>;
  hasAssignedActiveStaff(managerUserId: string): Promise<boolean>;
  resetTemporaryPassword(userId: string, expectedVersion: number, temporaryPassword: string, revokedAt: Date): Promise<ManagedUserRecord | null>;
  revokeAllSessions(userId: string, revokedAt: Date): Promise<void>;
  clearCustomerAssignments(input: ClearCustomerAssignmentsInput): Promise<Array<{ customerId: string; nextVersion: number }>>;
  detachTechnicalAuditActors(organizationId: string, userId: string): Promise<void>;
  deleteTechnicalUserDependencies(organizationId: string, userId: string): Promise<void>;
  deleteStaffProfile(organizationId: string, userId: string): Promise<void>;
  deleteUser(organizationId: string, userId: string): Promise<boolean>;
  appendAudit(input: AppendAuditInput): Promise<void>;
}

export interface PeopleRepository {
  execute<T>(work: (tx: PeopleTransaction) => Promise<T>): Promise<T>;
  listUsers(organizationId: string): Promise<SafeManagedUser[]>;
  getUser(organizationId: string, userId: string): Promise<SafeManagedUser | null>;
  getUserDeletionFacts(organizationId: string, userId: string): Promise<UserDeletionFacts | null>;
  getStaffProfile(organizationId: string, userId: string): Promise<StaffProfileDetails | null>;
  listStaffProfiles(organizationId: string, status: StaffStatusFilter): Promise<StaffProfileDetails[]>;
}

class PostgresPeopleTransaction implements PeopleTransaction {
  constructor(
    private readonly client: PoolClient,
    private readonly credentials: CredentialAdministrationPort,
    private readonly sessions: SessionRevocationPort,
    private readonly customerAssignments: CustomerAssignmentCleanupPort,
  ) {}

  async lockUser(organizationId: string, userId: string) {
    const result = await this.client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, userId],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async lockActiveAdmins(organizationId: string) {
    await this.client.query(
      `SELECT id FROM users
       WHERE organization_id = $1 AND role = 'ADMIN' AND is_active = TRUE
       ORDER BY id FOR UPDATE`,
      [organizationId],
    );
  }

  async lockUserForDeletion(organizationId: string, userId: string) {
    const result = await this.client.query<UserDeletionRow>(
      `SELECT ${USER_COLUMNS}, data_class
       FROM users WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, userId],
    );
    const row = result.rows[0];
    return row ? { ...mapUser(row), dataClass: row.data_class } : null;
  }

  async inspectUserDeletion(organizationId: string, userId: string) {
    const result = await this.client.query<UserDeletionFactsRow>(
      `SELECT u.data_class,
        (
          EXISTS (
            SELECT 1 FROM job_cards j
            WHERE j.organization_id = u.organization_id
              AND (
                j.assigned_to = u.id OR j.created_by = u.id OR j.accepted_by = u.id
                OR j.staff_completed_by = u.id OR j.manager_approved_by = u.id
                OR j.revision_requested_by = u.id OR j.cancelled_by = u.id
                OR j.follow_up_proposed_assignee = u.id OR j.follow_up_proposed_by = u.id
                OR j.invalidated_by = u.id
              )
          )
          OR EXISTS (
            SELECT 1 FROM job_card_schedule_revisions revision
            WHERE revision.organization_id = u.organization_id
              AND revision.created_by = u.id
          )
          OR EXISTS (
            SELECT 1 FROM job_card_assignment_history assignment
            WHERE assignment.organization_id = u.organization_id
              AND (
                assignment.from_user_id = u.id OR assignment.to_user_id = u.id
                OR assignment.changed_by = u.id
              )
          )
          OR EXISTS (
            SELECT 1 FROM job_card_activity_logs activity
            WHERE activity.organization_id = u.organization_id AND activity.actor_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM job_action_locations location
            WHERE location.organization_id = u.organization_id AND location.actor_user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM job_card_notes note
            WHERE note.organization_id = u.organization_id AND note.author_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM staff_confidential_notes confidential_note
            WHERE confidential_note.organization_id = u.organization_id
              AND (confidential_note.staff_user_id = u.id OR confidential_note.author_user_id = u.id)
          )
          OR EXISTS (
            SELECT 1 FROM calendar_events calendar_event
            WHERE calendar_event.organization_id = u.organization_id
              AND (
                calendar_event.assigned_user_id = u.id OR calendar_event.created_by = u.id
                OR calendar_event.updated_by = u.id OR calendar_event.cancelled_by = u.id
              )
          )
          OR EXISTS (
            SELECT 1 FROM calendar_event_activity_logs calendar_activity
            WHERE calendar_activity.organization_id = u.organization_id
              AND calendar_activity.actor_user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM messages message
            WHERE message.organization_id = u.organization_id AND message.sender_user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM conversation_participants participant
            WHERE participant.organization_id = u.organization_id AND participant.user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM conversation_user_states user_state
            WHERE user_state.organization_id = u.organization_id AND user_state.user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM messaging_activity_logs messaging_activity
            WHERE messaging_activity.organization_id = u.organization_id
              AND messaging_activity.actor_user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM realtime_events realtime_event
            WHERE realtime_event.organization_id = u.organization_id
              AND realtime_event.actor_user_id = u.id
          )
          OR EXISTS (SELECT 1 FROM backup_runs backup_run WHERE backup_run.created_by = u.id)
          OR EXISTS (SELECT 1 FROM backup_policy backup_policy WHERE backup_policy.updated_by = u.id)
          OR EXISTS (
            SELECT 1 FROM audit_events audit_event
            WHERE audit_event.organization_id = u.organization_id
              AND audit_event.actor_user_id = u.id
              AND audit_event.event_type NOT IN (
                'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
                'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
                'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED'
              )
          )
        ) AS has_business_history,
        (
          EXISTS (
            SELECT 1 FROM customers customer
            WHERE customer.organization_id = u.organization_id
              AND customer.assigned_staff_user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM job_cards active_job
            WHERE active_job.organization_id = u.organization_id
              AND active_job.assigned_to = u.id
              AND active_job.status IN (
                'NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED'
              )
          )
          OR EXISTS (
            SELECT 1 FROM staff_profiles report
            WHERE report.organization_id = u.organization_id AND report.manager_user_id = u.id
          )
          OR EXISTS (
            SELECT 1 FROM calendar_events active_calendar
            WHERE active_calendar.organization_id = u.organization_id
              AND active_calendar.assigned_user_id = u.id AND active_calendar.status = 'ACTIVE'
          )
          OR EXISTS (
            SELECT 1 FROM calendar_reminders reminder
            WHERE reminder.organization_id = u.organization_id
              AND reminder.recipient_user_id = u.id
              AND reminder.state IN ('PENDING', 'CLAIMED')
          )
          OR EXISTS (
            SELECT 1 FROM demo_datasets dataset
            WHERE dataset.organization_id = u.organization_id AND dataset.created_by = u.id
          )
        ) AS has_active_responsibilities
       FROM users u
       WHERE u.organization_id = $1 AND u.id = $2`,
      [organizationId, userId],
    );
    const row = result.rows[0];
    return row ? {
      dataClass: row.data_class,
      hasBusinessHistory: row.has_business_history,
      hasActiveResponsibilities: row.has_active_responsibilities,
    } : null;
  }

  async findUserByEmail(normalizedEmail: string) {
    const result = await this.client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = $1 LIMIT 1`,
      [normalizedEmail],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async lockStaffProfile(organizationId: string, userId: string) {
    const result = await this.client.query<StaffProfileRow>(
      `SELECT id, organization_id, user_id, title, phone, region, manager_user_id,
              version, created_at, updated_at
       FROM staff_profiles WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
      [organizationId, userId],
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async createUser(input: CreateUserRecord) {
    const result = await this.client.query<UserRow>(
      `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${USER_COLUMNS}`,
      [input.organizationId, input.name, input.email, input.passwordHash, input.role, input.mustChangePassword],
    );
    return mapUser(result.rows[0]!);
  }

  async createStaffProfile(input: CreateStaffProfileRecord) {
    const result = await this.client.query<StaffProfileRow>(
      `INSERT INTO staff_profiles (organization_id, user_id, title, phone, region, manager_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, organization_id, user_id, title, phone, region, manager_user_id,
                 version, created_at, updated_at`,
      [input.organizationId, input.userId, input.title, input.phone, input.region, input.managerUserId],
    );
    return mapProfile(result.rows[0]!);
  }

  async updateUserName(userId: string, expectedVersion: number, name: string) {
    return this.updateUser(
      `UPDATE users SET name = $3, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2 RETURNING ${USER_COLUMNS}`,
      [userId, expectedVersion, name],
    );
  }

  async changeRole(userId: string, expectedVersion: number, role: 'ADMIN' | 'MANAGER') {
    return this.updateUser(
      `UPDATE users SET role = $3, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2 RETURNING ${USER_COLUMNS}`,
      [userId, expectedVersion, role],
    );
  }

  async setActive(userId: string, expectedVersion: number, active: boolean) {
    return this.updateUser(
      `UPDATE users SET is_active = $3, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND version = $2 RETURNING ${USER_COLUMNS}`,
      [userId, expectedVersion, active],
    );
  }

  private async updateUser(text: string, values: unknown[]) {
    const result = await this.client.query<UserRow>(text, values);
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async updateStaffProfile(input: UpdateStaffProfileRecord) {
    const result = await this.client.query<StaffProfileRow>(
      `UPDATE staff_profiles
       SET title = $4, phone = $5, region = $6, manager_user_id = $7,
           version = version + 1, updated_at = NOW()
       WHERE organization_id = $1 AND user_id = $2 AND version = $3
       RETURNING id, organization_id, user_id, title, phone, region, manager_user_id,
                 version, created_at, updated_at`,
      [input.organizationId, input.userId, input.expectedVersion, input.title, input.phone, input.region, input.managerUserId],
    );
    return result.rows[0] ? mapProfile(result.rows[0]) : null;
  }

  async countActiveAdmins(organizationId: string) {
    const result = await this.client.query<{ id: string }>(
      `SELECT id FROM users
       WHERE organization_id = $1 AND role = 'ADMIN' AND is_active = TRUE FOR SHARE`,
      [organizationId],
    );
    return result.rows.length;
  }

  async hasActiveJobCards(userId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM job_cards WHERE assigned_to = $1
       AND status IN ('NEW', 'ACCEPTED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED') LIMIT 1`,
      [userId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async hasAssignedActiveStaff(managerUserId: string) {
    const result = await this.client.query(
      `SELECT 1 FROM staff_profiles sp JOIN users u ON u.id = sp.user_id
       WHERE sp.manager_user_id = $1 AND u.is_active = TRUE LIMIT 1`,
      [managerUserId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async detachTechnicalAuditActors(organizationId: string, userId: string) {
    await this.client.query(
      `UPDATE audit_events
       SET actor_user_id = NULL, actor_user_id_snapshot = $2
       WHERE organization_id = $1 AND actor_user_id = $2
         AND event_type IN (
           'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED',
           'USER_DEACTIVATED', 'USER_PASSWORD_RESET',
           'STAFF_PROFILE_UPDATED', 'STAFF_MANAGER_CHANGED'
         )`,
      [organizationId, userId],
    );
  }

  async deleteTechnicalUserDependencies(organizationId: string, userId: string) {
    await this.client.query(
      `DELETE FROM web_push_deliveries delivery
       WHERE delivery.organization_id = $1
         AND (
           EXISTS (
             SELECT 1 FROM in_app_notifications notification
             WHERE notification.organization_id = delivery.organization_id
               AND notification.id = delivery.notification_id
               AND notification.recipient_user_id = $2
           )
           OR EXISTS (
             SELECT 1 FROM web_push_subscriptions subscription
             WHERE subscription.organization_id = delivery.organization_id
               AND subscription.id = delivery.subscription_id
               AND subscription.recipient_user_id = $2
           )
         )`,
      [organizationId, userId],
    );
    await this.client.query(
      `DELETE FROM in_app_notifications
       WHERE organization_id = $1 AND recipient_user_id = $2`,
      [organizationId, userId],
    );
    await this.client.query(
      `DELETE FROM web_push_subscriptions
       WHERE organization_id = $1 AND recipient_user_id = $2`,
      [organizationId, userId],
    );
    await this.client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await this.client.query(
      `DELETE FROM processed_actions WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
    // Reminder rows are derived delivery state. Active reminders would have
    // blocked eligibility above; retained terminal rows can be removed without
    // touching their JobCard or calendar source.
    await this.client.query(
      `DELETE FROM calendar_reminders
       WHERE organization_id = $1 AND recipient_user_id = $2`,
      [organizationId, userId],
    );

    await this.client.query(
      `DELETE FROM web_push_deliveries delivery
       WHERE delivery.organization_id = $1
         AND delivery.notification_id IN (
           SELECT notification.id
           FROM in_app_notifications notification
           JOIN realtime_events realtime_event
             ON realtime_event.organization_id = notification.organization_id
            AND realtime_event.id = notification.source_realtime_event_id
           WHERE notification.organization_id = $1
             AND cardinality(realtime_event.audience_roles) = 0
             AND realtime_event.audience_user_ids @> ARRAY[$2::uuid]
             AND cardinality(array_remove(realtime_event.audience_user_ids, $2::uuid)) = 0
         )`,
      [organizationId, userId],
    );
    await this.client.query(
      `DELETE FROM in_app_notifications notification
       USING realtime_events realtime_event
       WHERE notification.organization_id = $1
         AND realtime_event.organization_id = notification.organization_id
         AND realtime_event.id = notification.source_realtime_event_id
         AND cardinality(realtime_event.audience_roles) = 0
         AND realtime_event.audience_user_ids @> ARRAY[$2::uuid]
         AND cardinality(array_remove(realtime_event.audience_user_ids, $2::uuid)) = 0`,
      [organizationId, userId],
    );
    await this.client.query(
      `DELETE FROM realtime_events realtime_event
       WHERE realtime_event.organization_id = $1
         AND cardinality(realtime_event.audience_roles) = 0
         AND realtime_event.audience_user_ids @> ARRAY[$2::uuid]
         AND cardinality(array_remove(realtime_event.audience_user_ids, $2::uuid)) = 0`,
      [organizationId, userId],
    );
    await this.client.query(
      `UPDATE realtime_events
       SET audience_user_ids = array_remove(audience_user_ids, $2::uuid)
       WHERE organization_id = $1 AND audience_user_ids @> ARRAY[$2::uuid]
         AND (
           cardinality(audience_roles) > 0
           OR cardinality(array_remove(audience_user_ids, $2::uuid)) > 0
         )`,
      [organizationId, userId],
    );
  }

  async deleteStaffProfile(organizationId: string, userId: string) {
    await this.client.query(
      `DELETE FROM staff_profiles WHERE organization_id = $1 AND user_id = $2`,
      [organizationId, userId],
    );
  }

  async deleteUser(organizationId: string, userId: string) {
    const result = await this.client.query(
      `DELETE FROM users WHERE organization_id = $1 AND id = $2 RETURNING id`,
      [organizationId, userId],
    );
    return result.rows.length === 1;
  }

  async resetTemporaryPassword(userId: string, expectedVersion: number, temporaryPassword: string, revokedAt: Date) {
    const nextVersion = await this.credentials.resetTemporaryPassword(
      this.client, userId, expectedVersion, temporaryPassword,
    );
    if (nextVersion === null) return null;
    await this.sessions.revokeAllSessions(this.client, userId, revokedAt);
    const result = await this.client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND version = $2`,
      [userId, nextVersion],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : null;
  }

  async revokeAllSessions(userId: string, revokedAt: Date) {
    await this.sessions.revokeAllSessions(this.client, userId, revokedAt);
  }

  clearCustomerAssignments(input: ClearCustomerAssignmentsInput) {
    return this.customerAssignments.clearAssignmentsForDeactivatedStaff(this.client, input);
  }

  async appendAudit(input: AppendAuditInput) {
    await this.client.query(
      `INSERT INTO audit_events
         (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.organizationId, input.actorUserId, input.subjectType, input.subjectId,
        input.eventType, input.oldValue, input.newValue, input.metadata],
    );
  }
}

const STAFF_PROFILE_SELECT = `
  SELECT u.id, u.organization_id, u.name, u.email, u.password_hash, u.role,
    u.must_change_password, u.is_active, u.version, u.last_login_at, u.created_at, u.updated_at,
    sp.id AS profile_id, sp.title, sp.phone, sp.region, sp.manager_user_id,
    sp.version AS profile_version, sp.created_at AS profile_created_at,
    sp.updated_at AS profile_updated_at, manager.name AS manager_name
  FROM staff_profiles sp
  JOIN users u ON u.id = sp.user_id AND u.organization_id = sp.organization_id
  LEFT JOIN users manager ON manager.id = sp.manager_user_id`;

export class PostgresPeopleRepository implements PeopleRepository {
  constructor(
    private readonly pool: Pool,
    private readonly credentials: CredentialAdministrationPort,
    private readonly sessions: SessionRevocationPort,
    private readonly customerAssignments: CustomerAssignmentCleanupPort = {
      clearAssignmentsForDeactivatedStaff: async () => {
        throw new Error('Customer assignment cleanup port is required');
      },
    },
  ) {}

  async execute<T>(work: (tx: PeopleTransaction) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PostgresPeopleTransaction(
        client, this.credentials, this.sessions, this.customerAssignments,
      ));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listUsers(organizationId: string) {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE organization_id = $1 ORDER BY name, id`,
      [organizationId],
    );
    return result.rows.map(safeUser);
  }

  async getUser(organizationId: string, userId: string) {
    const result = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE organization_id = $1 AND id = $2 LIMIT 1`,
      [organizationId, userId],
    );
    return result.rows[0] ? safeUser(result.rows[0]) : null;
  }

  async getUserDeletionFacts(organizationId: string, userId: string) {
    return this.execute(async (tx) => {
      await tx.lockActiveAdmins(organizationId);
      const target = await tx.lockUserForDeletion(organizationId, userId);
      if (!target) return null;
      const inspected = await tx.inspectUserDeletion(organizationId, userId);
      if (!inspected) return null;
      return { ...inspected, activeAdminCount: await tx.countActiveAdmins(organizationId) };
    });
  }

  async getStaffProfile(organizationId: string, userId: string) {
    const result = await this.pool.query<StaffProfileDetailsRow>(
      `${STAFF_PROFILE_SELECT}
       WHERE sp.organization_id = $1 AND sp.user_id = $2 AND u.role = 'STAFF'`,
      [organizationId, userId],
    );
    return result.rows[0] ? mapProfileDetails(result.rows[0]) : null;
  }

  async listStaffProfiles(organizationId: string, status: StaffStatusFilter) {
    const activeFilter = status === 'all' ? '' : ` AND u.is_active = ${status === 'active' ? 'TRUE' : 'FALSE'}`;
    const result = await this.pool.query<StaffProfileDetailsRow>(
      `${STAFF_PROFILE_SELECT}
       WHERE sp.organization_id = $1 AND u.role = 'STAFF'${activeFilter}
       ORDER BY u.name, u.id`,
      [organizationId],
    );
    return result.rows.map(mapProfileDetails);
  }
}
