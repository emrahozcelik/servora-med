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
  SafeManagedUser,
  StaffProfileRecord,
  StaffProfileSummary,
  StaffStatusFilter,
  UpdateStaffProfileRecord,
} from './types.js';
import type { ClearCustomerAssignmentsInput, CustomerAssignmentCleanupPort } from './customer-assignment-port.js';

type UserRow = {
  id: string; organization_id: string; name: string; email: string; password_hash: string;
  role: UserRole; must_change_password: boolean; is_active: boolean; version: number;
  last_login_at: Date | null; created_at: Date; updated_at: Date;
};

type StaffProfileRow = {
  id: string; organization_id: string; user_id: string; title: string | null;
  phone: string | null; region: string | null; manager_user_id: string | null;
  version: number; created_at: Date; updated_at: Date;
};

type StaffSummaryRow = UserRow & StaffProfileRow & {
  profile_id: string; profile_version: number; profile_created_at: Date; profile_updated_at: Date;
  manager_name: string | null; open_count: string | number; waiting_approval_count: string | number;
  revision_requested_count: string | number; completed_this_month_count: string | number;
  overdue_count: string | number;
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

function mapSummary(row: StaffSummaryRow): StaffProfileSummary {
  return {
    id: row.profile_id,
    user: safeUser(row),
    title: row.title,
    phone: row.phone,
    region: row.region,
    managerUserId: row.manager_user_id,
    managerName: row.manager_name,
    version: row.profile_version,
    counters: {
      open: Number(row.open_count),
      waitingApproval: Number(row.waiting_approval_count),
      revisionRequested: Number(row.revision_requested_count),
      completedThisMonth: Number(row.completed_this_month_count),
      overdue: Number(row.overdue_count),
    },
  };
}

export interface PeopleTransaction {
  lockUser(organizationId: string, userId: string): Promise<ManagedUserRecord | null>;
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
  appendAudit(input: AppendAuditInput): Promise<void>;
}

export interface PeopleRepository {
  execute<T>(work: (tx: PeopleTransaction) => Promise<T>): Promise<T>;
  listUsers(organizationId: string): Promise<SafeManagedUser[]>;
  getUser(organizationId: string, userId: string): Promise<SafeManagedUser | null>;
  getStaffSummary(organizationId: string, userId: string, now: Date): Promise<StaffProfileSummary | null>;
  listStaff(organizationId: string, status: StaffStatusFilter, now: Date): Promise<StaffProfileSummary[]>;
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
       AND status IN ('NEW', 'PLANNED', 'IN_PROGRESS', 'WAITING_APPROVAL', 'REVISION_REQUESTED') LIMIT 1`,
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

const STAFF_SUMMARY_SELECT = `
  SELECT u.id, u.organization_id, u.name, u.email, u.password_hash, u.role,
    u.must_change_password, u.is_active, u.version, u.last_login_at, u.created_at, u.updated_at,
    sp.id AS profile_id, sp.title, sp.phone, sp.region, sp.manager_user_id,
    sp.version AS profile_version, sp.created_at AS profile_created_at,
    sp.updated_at AS profile_updated_at, manager.name AS manager_name,
    COUNT(jc.id) FILTER (WHERE jc.status IN ('NEW', 'PLANNED', 'IN_PROGRESS')) AS open_count,
    COUNT(jc.id) FILTER (WHERE jc.status = 'WAITING_APPROVAL') AS waiting_approval_count,
    COUNT(jc.id) FILTER (WHERE jc.status = 'REVISION_REQUESTED') AS revision_requested_count,
    COUNT(jc.id) FILTER (WHERE jc.status = 'COMPLETED' AND manager_approved_at >=
      (date_trunc('month', $2::timestamptz AT TIME ZONE o.timezone) AT TIME ZONE o.timezone)
      AND manager_approved_at <
      ((date_trunc('month', $2::timestamptz AT TIME ZONE o.timezone) + interval '1 month') AT TIME ZONE o.timezone)
    ) AS completed_this_month_count,
    COUNT(jc.id) FILTER (WHERE due_date < ($2::timestamptz AT TIME ZONE o.timezone)::date
      AND jc.status NOT IN ('COMPLETED', 'CANCELLED')) AS overdue_count
  FROM staff_profiles sp
  JOIN users u ON u.id = sp.user_id AND u.organization_id = sp.organization_id
  JOIN organizations o ON o.id = sp.organization_id
  LEFT JOIN users manager ON manager.id = sp.manager_user_id
  LEFT JOIN job_cards jc ON jc.organization_id = sp.organization_id AND jc.assigned_to = sp.user_id`;

const STAFF_SUMMARY_GROUP = `GROUP BY u.id, sp.id, manager.name, o.timezone`;

export class PostgresPeopleRepository implements PeopleRepository {
  constructor(
    private readonly pool: Pool,
    private readonly credentials: CredentialAdministrationPort,
    private readonly sessions: SessionRevocationPort,
    private readonly customerAssignments: CustomerAssignmentCleanupPort = {
      clearAssignmentsForDeactivatedStaff: async () => [],
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

  async getStaffSummary(organizationId: string, userId: string, now: Date) {
    const result = await this.pool.query<StaffSummaryRow>(
      `${STAFF_SUMMARY_SELECT}
       WHERE sp.organization_id = $1 AND sp.user_id = $3
       ${STAFF_SUMMARY_GROUP}`,
      [organizationId, now, userId],
    );
    return result.rows[0] ? mapSummary(result.rows[0]) : null;
  }

  async listStaff(organizationId: string, status: StaffStatusFilter, now: Date) {
    const activeFilter = status === 'all' ? '' : ` AND u.is_active = ${status === 'active' ? 'TRUE' : 'FALSE'}`;
    const result = await this.pool.query<StaffSummaryRow>(
      `${STAFF_SUMMARY_SELECT}
       WHERE sp.organization_id = $1${activeFilter}
       ${STAFF_SUMMARY_GROUP}
       ORDER BY u.name, u.id`,
      [organizationId, now],
    );
    return result.rows.map(mapSummary);
  }
}
