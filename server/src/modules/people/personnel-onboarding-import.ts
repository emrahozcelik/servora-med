import { createHash } from 'node:crypto';
import { lstat, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { Pool, PoolClient } from 'pg';

import { AppError } from '../../errors/index.js';
import { hashPassword, validatePassword } from '../auth/crypto.js';

const IMPORT_SOURCE = 'production-personnel-onboarding';
const IMPORT_VERSION = 1;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERSONNEL_ROLES = ['MANAGER', 'STAFF'] as const;

export type PersonnelRole = (typeof PERSONNEL_ROLES)[number];

export type PersonnelStaffProfile = {
  title: string | null;
  phone: string | null;
  region: string | null;
  sourceManagerUserId: string | null;
};

export type PersonnelManifestEntry = {
  sourceUserId: string;
  name: string;
  email: string;
  role: PersonnelRole;
  staffProfile: PersonnelStaffProfile | null;
};

export type PersonnelManifest = {
  version: 1;
  sourceOrganizationId: string;
  sourceOrganizationName: string;
  personnel: PersonnelManifestEntry[];
};

export type PersonnelCredential = {
  email: string;
  temporaryPassword: string;
};

export type PersonnelMapping = {
  sourceUserId: string;
  productionUserId: string | null;
  role: PersonnelRole;
};

export type PersonnelImportResult = {
  input: number;
  managers: number;
  staff: number;
  create: number;
  existing: number;
  conflict: number;
  invalid: number;
  managerMappingsResolved: number;
  managerMappingsUnresolved: number;
  credentialRequirements: number;
  crossOrganizationEmailConflicts: number;
  dryRun: boolean;
};

export type PersonnelImportOutput = {
  result: PersonnelImportResult;
  mappings: PersonnelMapping[];
};

export type SafePersonnelImportError = {
  category: string;
  code: string;
  message: string;
};

type ExistingStaffProfile = {
  title: string | null;
  phone: string | null;
  region: string | null;
  managerUserId: string | null;
};

type ExistingUser = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  profile: ExistingStaffProfile | null;
};

type ExistingState = {
  usersByEmail: Map<string, ExistingUser[]>;
};

type PlanClassification = 'CREATE' | 'EXISTING' | 'CONFLICT';

type PersonnelPlan = {
  source: PersonnelManifestEntry;
  classification: PlanClassification;
  existing: ExistingUser | null;
  conflictCode: string | null;
  destinationManagerUserId: string | null;
};

type ImportPlan = {
  plans: PersonnelPlan[];
  result: PersonnelImportResult;
};

function invalid(message = 'Personnel manifest validation failed.') {
  return new AppError('PERSONNEL_IMPORT_INVALID', 400, message);
}

function blocked(message = 'Personnel import is blocked by a conflict.') {
  return new AppError('PERSONNEL_IMPORT_BLOCKED', 409, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
}

function uuid(value: unknown) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw invalid();
  return value.toLowerCase();
}

function requiredText(value: unknown, max: number) {
  if (typeof value !== 'string') throw invalid();
  const cleaned = value.trim();
  if (!cleaned || cleaned.length > max || /[\u0000-\u001f\u007f]/.test(cleaned)) throw invalid();
  return cleaned;
}

function optionalText(value: unknown, max: number) {
  if (value === null) return null;
  return requiredText(value, max);
}

function email(value: unknown) {
  const normalized = requiredText(value, 255).toLowerCase();
  if (!EMAIL_PATTERN.test(normalized)) throw invalid();
  return normalized;
}

function normalizeStaffProfile(value: unknown): PersonnelStaffProfile {
  if (!isRecord(value)) throw invalid();
  exactKeys(value, ['title', 'phone', 'region', 'sourceManagerUserId']);
  return {
    title: optionalText(value.title, 255),
    phone: optionalText(value.phone, 50),
    region: optionalText(value.region, 100),
    sourceManagerUserId: value.sourceManagerUserId === null ? null : uuid(value.sourceManagerUserId),
  };
}

function normalizePersonnelEntry(value: unknown): PersonnelManifestEntry {
  if (!isRecord(value)) throw invalid();
  exactKeys(value, ['sourceUserId', 'name', 'email', 'role', 'staffProfile']);
  const role = value.role;
  if (!PERSONNEL_ROLES.includes(role as PersonnelRole)) {
    if (role === 'ADMIN') throw new AppError('PERSONNEL_ADMIN_NOT_ALLOWED', 400, 'ADMIN personnel rows are not allowed.');
    throw invalid();
  }
  const profile = role === 'STAFF'
    ? normalizeStaffProfile(value.staffProfile)
    : value.staffProfile === null ? null : (() => { throw invalid(); })();
  return {
    sourceUserId: uuid(value.sourceUserId),
    name: requiredText(value.name, 255),
    email: email(value.email),
    role: role as PersonnelRole,
    staffProfile: profile,
  };
}

export function parsePersonnelManifest(value: unknown): PersonnelManifest {
  if (!isRecord(value)) throw invalid();
  exactKeys(value, ['version', 'sourceOrganizationId', 'sourceOrganizationName', 'personnel']);
  if (value.version !== 1 || !Array.isArray(value.personnel) || value.personnel.length === 0) throw invalid();
  const personnel = value.personnel.map(normalizePersonnelEntry);
  if (new Set(personnel.map((entry) => entry.sourceUserId)).size !== personnel.length) throw invalid();
  if (new Set(personnel.map((entry) => entry.email)).size !== personnel.length) throw invalid();
  const managerIds = new Set(personnel.filter((entry) => entry.role === 'MANAGER').map((entry) => entry.sourceUserId));
  for (const entry of personnel) {
    const managerId = entry.staffProfile?.sourceManagerUserId;
    if (managerId && !managerIds.has(managerId)) {
      throw new AppError('PERSONNEL_GRAPH_CONFLICT', 409, 'A staff manager reference is not an approved manager.');
    }
  }
  return {
    version: 1,
    sourceOrganizationId: uuid(value.sourceOrganizationId),
    sourceOrganizationName: requiredText(value.sourceOrganizationName, 255),
    personnel,
  };
}

export function parsePersonnelCredentials(value: unknown): PersonnelCredential[] {
  if (!isRecord(value)) throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
  if (Object.keys(value).some((key) => !['version', 'credentials'].includes(key))) {
    throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
  }
  if (value.version !== 1 || !Array.isArray(value.credentials)) {
    throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
  }
  const credentials = value.credentials.map((entry) => {
    if (!isRecord(entry)) throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
    if (Object.keys(entry).some((key) => !['email', 'temporaryPassword'].includes(key))) {
      throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
    }
    let normalizedEmail: string;
    try { normalizedEmail = email(entry.email); }
    catch { throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.'); }
    if (typeof entry.temporaryPassword !== 'string' || /^scrypt\$/.test(entry.temporaryPassword)
      || /[\u0000-\u001f\u007f]/.test(entry.temporaryPassword)) {
      throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
    }
    try { validatePassword(entry.temporaryPassword); }
    catch { throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.'); }
    return { email: normalizedEmail, temporaryPassword: entry.temporaryPassword };
  });
  if (new Set(credentials.map((entry) => entry.email)).size !== credentials.length) {
    throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
  }
  return credentials;
}

export async function readSecurePersonnelCredentials(filePath: string): Promise<PersonnelCredential[]> {
  let stats;
  try { stats = await lstat(filePath); }
  catch { throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.'); }
  const mode = stats.mode & 0o777;
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stats.isFile() || stats.isSymbolicLink() || (mode & ~0o600) !== 0 || (mode & 0o400) === 0
    || (uid !== null && stats.uid !== uid && stats.uid !== 0)) {
    throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
  }
  let raw: string;
  try { raw = await readFile(filePath, 'utf8'); }
  catch { throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.'); }
  try { return parsePersonnelCredentials(JSON.parse(raw)); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.');
  }
}

async function readState(client: PoolClient, organizationId: string, actorUserId: string, emails: string[]) {
  const organization = await client.query('SELECT 1 FROM organizations WHERE id = $1', [organizationId]);
  if (organization.rowCount !== 1) throw new AppError('DESTINATION_ORGANIZATION_NOT_FOUND', 404, 'Destination organization was not found.');
  const actor = await client.query(
    `SELECT 1 FROM users WHERE id = $1 AND organization_id = $2 AND role = 'ADMIN' AND is_active = TRUE`,
    [actorUserId, organizationId],
  );
  if (actor.rowCount !== 1) throw new AppError('PERSONNEL_IMPORT_FORBIDDEN', 403, 'Import actor is not an active Admin.');
  if (emails.length === 0) return { usersByEmail: new Map<string, ExistingUser[]>() } satisfies ExistingState;
  const rows = await client.query<{
    id: string; organization_id: string; name: string; email: string; role: string;
    is_active: boolean; must_change_password: boolean; profile_id: string | null;
    title: string | null; phone: string | null; region: string | null; manager_user_id: string | null;
  }>(
    `SELECT u.id, u.organization_id, u.name, lower(u.email) AS email, u.role,
            u.is_active, u.must_change_password, sp.id AS profile_id, sp.title, sp.phone,
            sp.region, sp.manager_user_id
       FROM users u
       LEFT JOIN staff_profiles sp ON sp.user_id = u.id AND sp.organization_id = u.organization_id
      WHERE lower(u.email) = ANY($1::text[])
      ORDER BY lower(u.email), u.id`,
    [emails],
  );
  const usersByEmail = new Map<string, ExistingUser[]>();
  for (const row of rows.rows) {
    const users = usersByEmail.get(row.email) ?? [];
    users.push({
      id: row.id, organizationId: row.organization_id, name: row.name, email: row.email,
      role: row.role, isActive: row.is_active, mustChangePassword: row.must_change_password,
      profile: row.profile_id ? {
        title: row.title, phone: row.phone, region: row.region, managerUserId: row.manager_user_id,
      } : null,
    });
    usersByEmail.set(row.email, users);
  }
  return { usersByEmail } satisfies ExistingState;
}

function sameProfile(left: ExistingStaffProfile, right: PersonnelStaffProfile, managerUserId: string | null) {
  return left.title === right.title && left.phone === right.phone && left.region === right.region
    && left.managerUserId === managerUserId;
}

function buildPlan(
  manifest: PersonnelManifest,
  state: ExistingState,
  organizationId: string,
): ImportPlan {
  const managerEntries = manifest.personnel.filter((entry) => entry.role === 'MANAGER');
  const staffEntries = manifest.personnel.filter((entry) => entry.role === 'STAFF');
  const managerPlans = new Map<string, PersonnelPlan>();
  const plans: PersonnelPlan[] = [];
  let conflict = 0;
  let crossOrganizationEmailConflicts = 0;

  for (const source of managerEntries) {
    const matches = state.usersByEmail.get(source.email) ?? [];
    const existing = matches.length === 1 ? matches[0]! : null;
    let classification: PlanClassification = 'CREATE';
    let conflictCode: string | null = null;
    if (matches.length > 1) {
      classification = 'CONFLICT'; conflictCode = 'EMAIL_CONFLICT';
    } else if (existing) {
      if (existing.organizationId !== organizationId) {
        classification = 'CONFLICT'; conflictCode = 'CROSS_ORGANIZATION_EMAIL_CONFLICT'; crossOrganizationEmailConflicts += 1;
      } else if (existing.name !== source.name || existing.role !== source.role || !existing.isActive || existing.profile !== null) {
        classification = 'CONFLICT'; conflictCode = 'CONFLICT';
      } else {
        classification = 'EXISTING';
      }
    }
    if (classification === 'CONFLICT') conflict += 1;
    const plan = { source, classification, existing, conflictCode, destinationManagerUserId: null };
    managerPlans.set(source.sourceUserId, plan);
    plans.push(plan);
  }

  let managerMappingsResolved = 0;
  let managerMappingsUnresolved = 0;
  for (const source of staffEntries) {
    const managerSourceId = source.staffProfile!.sourceManagerUserId;
    const managerPlan = managerSourceId ? managerPlans.get(managerSourceId) : null;
    let destinationManagerUserId = managerPlan?.existing?.id ?? null;
    let classification: PlanClassification = 'CREATE';
    let conflictCode: string | null = null;
    const matches = state.usersByEmail.get(source.email) ?? [];
    const existing = matches.length === 1 ? matches[0]! : null;
    if (managerSourceId) {
      if (!managerPlan || managerPlan.classification === 'CONFLICT') {
        managerMappingsUnresolved += 1;
        conflictCode = 'UNRESOLVED_MANAGER_MAPPING';
      } else {
        managerMappingsResolved += 1;
      }
    }
    if (matches.length > 1) {
      classification = 'CONFLICT'; conflictCode = 'EMAIL_CONFLICT';
    } else if (existing) {
      if (existing.organizationId !== organizationId) {
        classification = 'CONFLICT'; conflictCode = 'CROSS_ORGANIZATION_EMAIL_CONFLICT'; crossOrganizationEmailConflicts += 1;
      } else if (
        existing.name !== source.name || existing.role !== source.role || !existing.isActive
        || !existing.profile || (managerSourceId && !managerPlan?.existing?.id)
        || !sameProfile(existing.profile, source.staffProfile!, destinationManagerUserId)
      ) {
        classification = 'CONFLICT'; conflictCode ??= 'CONFLICT';
      } else {
        classification = 'EXISTING';
      }
    } else if (conflictCode) {
      classification = 'CONFLICT';
    }
    if (classification === 'CONFLICT') conflict += 1;
    const plan = { source, classification, existing, conflictCode, destinationManagerUserId };
    plans.push(plan);
  }

  const create = plans.filter((plan) => plan.classification === 'CREATE').length;
  const existing = plans.filter((plan) => plan.classification === 'EXISTING').length;
  return {
    plans,
    result: {
      input: plans.length, managers: managerEntries.length, staff: staffEntries.length,
      create, existing, conflict, invalid: 0, managerMappingsResolved, managerMappingsUnresolved,
      credentialRequirements: create, crossOrganizationEmailConflicts, dryRun: true,
    },
  };
}

function credentialMap(credentials: PersonnelCredential[], plans: PersonnelPlan[]) {
  for (const credential of credentials) {
    try {
      if (/^scrypt\$/.test(credential.temporaryPassword)) throw new Error('hash input');
      validatePassword(credential.temporaryPassword);
    }
    catch { throw new AppError('INVALID_CREDENTIAL_FILE', 400, 'Credential file validation failed.'); }
  }
  const required = new Set(plans.filter((plan) => plan.classification === 'CREATE').map((plan) => plan.source.email));
  const provided = new Set(credentials.map((credential) => credential.email));
  if (required.size !== provided.size || [...required].some((value) => !provided.has(value))) {
    throw new AppError('MISSING_CREDENTIAL', 400, 'Credential coverage does not match accounts to create.');
  }
  return new Map(credentials.map((credential) => [credential.email, credential.temporaryPassword]));
}

async function insertUser(
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  plan: PersonnelPlan,
  passwordHash: string,
  managerUserId: string | null,
) {
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (organization_id, name, email, password_hash, role, must_change_password)
     VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
    [organizationId, plan.source.name, plan.source.email, passwordHash, plan.source.role],
  );
  const userId = user.rows[0]!.id;
  if (plan.source.role === 'STAFF') {
    const profile = plan.source.staffProfile!;
    await client.query(
      `INSERT INTO staff_profiles
         (organization_id, user_id, title, phone, region, manager_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [organizationId, userId, profile.title, profile.phone, profile.region, managerUserId],
    );
  }
  await client.query(
    `INSERT INTO audit_events
       (organization_id, actor_user_id, subject_type, subject_id, event_type, old_value, new_value, metadata)
     VALUES ($1, $2, 'USER', $3, 'USER_CREATED', NULL, $4, $5)`,
    [organizationId, actorUserId, userId,
      { name: plan.source.name, email: plan.source.email, role: plan.source.role, isActive: true },
      { source: IMPORT_SOURCE, importVersion: IMPORT_VERSION, sourceUserId: plan.source.sourceUserId }],
  );
  return userId;
}

function mapPlans(plans: PersonnelPlan[], destinations: Map<string, string>) {
  return plans.map((plan) => ({
    sourceUserId: plan.source.sourceUserId,
    productionUserId: plan.classification === 'CREATE' ? destinations.get(plan.source.sourceUserId) ?? null : plan.existing?.id ?? null,
    role: plan.source.role,
  }));
}

async function applyPlan(
  client: PoolClient,
  organizationId: string,
  actorUserId: string,
  plan: ImportPlan,
  passwords: Map<string, string>,
) {
  const destinations = new Map<string, string>();
  for (const entry of plan.plans.filter((item) => item.source.role === 'MANAGER')) {
    if (entry.classification === 'EXISTING') {
      destinations.set(entry.source.sourceUserId, entry.existing!.id);
      continue;
    }
    const password = passwords.get(entry.source.email);
    if (!password) throw new AppError('MISSING_CREDENTIAL', 400, 'Credential coverage does not match accounts to create.');
    const passwordHash = await hashPassword(password);
    const id = await insertUser(client, organizationId, actorUserId, entry, passwordHash, null);
    destinations.set(entry.source.sourceUserId, id);
  }
  for (const entry of plan.plans.filter((item) => item.source.role === 'STAFF')) {
    if (entry.classification === 'EXISTING') {
      destinations.set(entry.source.sourceUserId, entry.existing!.id);
      continue;
    }
    const password = passwords.get(entry.source.email);
    if (!password) throw new AppError('MISSING_CREDENTIAL', 400, 'Credential coverage does not match accounts to create.');
    const managerSourceId = entry.source.staffProfile!.sourceManagerUserId;
    const managerUserId = managerSourceId ? destinations.get(managerSourceId) ?? null : null;
    if (managerSourceId && !managerUserId) throw blocked('A manager mapping could not be resolved.');
    const passwordHash = await hashPassword(password);
    const id = await insertUser(client, organizationId, actorUserId, entry, passwordHash, managerUserId);
    destinations.set(entry.source.sourceUserId, id);
  }
  return mapPlans(plan.plans, destinations);
}

export async function importPersonnel(
  pool: Pool,
  input: {
    organizationId: string;
    actorUserId: string;
    manifest: PersonnelManifest;
    credentials?: PersonnelCredential[] | null;
    apply: boolean;
  },
): Promise<PersonnelImportOutput> {
  const organizationId = uuid(input.organizationId);
  const actorUserId = uuid(input.actorUserId);
  const client = await pool.connect();
  let transaction = false;
  try {
    await client.query(input.apply ? 'BEGIN' : 'BEGIN READ ONLY');
    transaction = true;
    if (input.apply) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${IMPORT_SOURCE}:${organizationId}`]);
    }
    const emails = input.manifest.personnel.map((entry) => entry.email);
    const state = await readState(client, organizationId, actorUserId, emails);
    const plan = buildPlan(input.manifest, state, organizationId);
    if (!input.apply) {
      await client.query('ROLLBACK');
      transaction = false;
      return { result: plan.result, mappings: mapPlans(plan.plans, new Map()) };
    }
    if (!input.credentials) throw new AppError('MISSING_CREDENTIAL', 400, 'Credential file is required for apply.');
    const passwords = credentialMap(input.credentials, plan.plans);
    if (plan.result.conflict > 0 || plan.result.managerMappingsUnresolved > 0) throw blocked();
    const mappings = await applyPlan(client, organizationId, actorUserId, plan, passwords);
    await client.query('COMMIT');
    transaction = false;
    return { result: { ...plan.result, dryRun: false }, mappings };
  } catch (error) {
    if (transaction) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original safe error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function writePersonnelMappingArtifact(filePath: string, organizationId: string, mappings: PersonnelMapping[]) {
  const resolved = path.resolve(filePath);
  const repositoryRoots = [process.cwd(), path.resolve(process.cwd(), '..')];
  if (repositoryRoots.some((root) => {
    const relative = path.relative(root, resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  })) {
    throw new AppError('INVALID_MAPPING_OUTPUT', 400, 'Mapping output must be outside the repository.');
  }
  let handle;
  try { handle = await open(resolved, 'wx', 0o600); }
  catch { throw new AppError('INVALID_MAPPING_OUTPUT', 400, 'Mapping output could not be created safely.'); }
  const document = JSON.stringify({ version: 1, organizationId: uuid(organizationId), mappings }, null, 2) + '\n';
  try {
    await handle.writeFile(document, 'utf8');
    await handle.chmod(0o600);
  } catch {
    try { await handle.close(); } finally { try { await unlink(resolved); } catch { /* best effort cleanup */ } }
    throw new AppError('INVALID_MAPPING_OUTPUT', 400, 'Mapping output could not be written safely.');
  }
  await handle.close();
  return { path: resolved, sha256: createHash('sha256').update(document).digest('hex') };
}

export function formatPersonnelImportError(error: unknown): SafePersonnelImportError {
  if (error instanceof SyntaxError) return { category: 'INPUT_ERROR', code: 'INVALID_JSON', message: 'An input file is not valid JSON.' };
  const code = error instanceof AppError ? error.code : (error as { code?: unknown } | null)?.code;
  if (code === 'PERSONNEL_IMPORT_INVALID' || code === 'PERSONNEL_ADMIN_NOT_ALLOWED') {
    return { category: 'INVALID_PERSONNEL', code: String(code), message: 'Personnel manifest validation failed.' };
  }
  if (code === 'PERSONNEL_GRAPH_CONFLICT' || code === 'UNRESOLVED_MANAGER_MAPPING' || code === 'PERSONNEL_IMPORT_BLOCKED') {
    return { category: 'CONFLICT', code: String(code), message: 'Personnel import is blocked by a conflict.' };
  }
  if (code === 'INVALID_CREDENTIAL_FILE' || code === 'MISSING_CREDENTIAL') {
    return { category: 'INVALID_CREDENTIAL_FILE', code: String(code), message: 'Credential file validation failed.' };
  }
  if (code === 'PERSONNEL_IMPORT_FORBIDDEN') {
    return { category: 'ACTOR_NOT_AUTHORIZED', code: String(code), message: 'Import actor is not authorized.' };
  }
  if (code === 'DESTINATION_ORGANIZATION_NOT_FOUND') {
    return { category: 'DESTINATION_NOT_FOUND', code: String(code), message: 'Destination organization was not found.' };
  }
  if (code === 'CROSS_ORGANIZATION_EMAIL_CONFLICT') {
    return { category: 'CROSS_ORGANIZATION_EMAIL_CONFLICT', code: String(code), message: 'An email belongs to another organization.' };
  }
  if (code === 'INVALID_MAPPING_OUTPUT') {
    return { category: 'OUTPUT_ERROR', code: String(code), message: 'Mapping output could not be created safely.' };
  }
  if (code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ERR_INVALID_ARG_TYPE') {
    return { category: 'INPUT_ERROR', code: String(code), message: 'An input file could not be read.' };
  }
  if (code === '23505' || code === '23503' || code === '23514') {
    return { category: 'DATABASE_CONSTRAINT_FAILURE', code, message: 'A database constraint rejected the import.' };
  }
  return { category: 'INTERNAL_ERROR', code: 'INTERNAL_ERROR', message: 'The import failed safely.' };
}
