import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { AppError } from '../../errors/index.js';
import { runCriticalAction } from '../../db/critical-action.js';
import { createDuplicateEvidenceDetails, duplicateEvidenceMatches, parseDuplicateEvidenceRevision, type DuplicateKeyring } from './duplicate-evidence.js';
import { decodeHistoryCursor, encodeHistoryCursor } from './duplicate-history-cursor.js';
import type { CustomerPair } from './duplicate-candidates.js';
import {
  DUPLICATE_DECISION_OPERATION,
  DUPLICATE_REOPEN_OPERATION,
  type DuplicateDecisionCommand,
  type DuplicateReopenCommand,
} from './duplicate-command.js';
import {
  DUPLICATE_REOPEN_REASON, type DuplicateCommandReceipt,
  type DuplicateHistoryPage, type DuplicateReviewTimelineItem,
} from './duplicate-review.js';
import { DUPLICATE_CONTACTS_SQL, duplicateUnavailable } from './duplicate-repository.js';
import { DUPLICATE_LIMITS, DUPLICATE_RULE_VERSION, type DuplicateContact, type DuplicateCustomerFacts } from './duplicate-types.js';
import type { ContactRow, CrmActor, CustomerRow } from './types.js';

type LockedCustomerRow = CustomerRow & { data_class: string; address_overflow: boolean };
type LockedContactRow = ContactRow & { customer_id: string };
type CurrentEventRow = { id: string; seq: number; event_kind: string; resulting_status: string; reason_code: string };
type HeadRow = { id: string; version: number };
type HistoryRow = {
  id: string; seq: number; event_kind: string; resulting_status: string; reason_code: string;
  actor_user_id: string; occurred_at: Date; matching_rule_version: string;
  matching_codes: string[]; conflicting_tax_numbers: boolean;
};

const USER_LOCK_SQL = `SELECT id,role,is_active FROM users
  WHERE organization_id=$1 AND id=$2 FOR SHARE NOWAIT`;
const CUSTOMER_LOCK_SQL = `SELECT id,name,customer_type,tax_number,phone,email,city,district,
  CASE WHEN octet_length(COALESCE(address,'')) <= $3 THEN address ELSE NULL END AS address,
  octet_length(COALESCE(address,'')) > $3 AS address_overflow,
  assigned_staff_user_id,status,version,data_class
  FROM customers WHERE organization_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE NOWAIT`;
const CONTACT_LOCK_SQL = `SELECT id,customer_id,name,title,phone,email,is_primary,is_active,version
  FROM contacts WHERE organization_id=$1 AND customer_id=ANY($2::uuid[]) AND id=ANY($3::uuid[])
  ORDER BY id FOR SHARE NOWAIT`;
const HEAD_LOCK_SQL = `SELECT id,version FROM customer_duplicate_reviews
  WHERE organization_id=$1 AND customer_a_id=$2 AND customer_b_id=$3 FOR UPDATE NOWAIT`;
const CURRENT_EVENT_SQL = `SELECT id,seq,event_kind,resulting_status,reason_code
  FROM customer_duplicate_review_events
  WHERE organization_id=$1 AND review_id=$2 AND seq=$3`;

const conflict = (code: string, message: string): never => { throw new AppError(code, 409, message); };
const notFound = (): never => { throw new AppError('DUPLICATE_PAIR_NOT_FOUND', 404, 'Karşılaştırılabilir müşteri çifti bulunamadı.'); };
const reviewNotFound = (): never => { throw new AppError('DUPLICATE_REVIEW_NOT_FOUND', 404, 'İnceleme kaydı bulunamadı.'); };

function validation(field: string, message: string): never {
  throw new AppError('VALIDATION_ERROR', 400, message, { fieldErrors: { [field]: message } });
}

function mapError(error: unknown): unknown {
  if (error instanceof AppError && error.code === 'CRITICAL_ACTION_TEMPORARILY_UNAVAILABLE') {
    return new AppError('REVIEW_TEMPORARILY_UNAVAILABLE', 503, 'İnceleme sonucu doğrulanamıyor. Aynı istekle yeniden deneyin.');
  }
  if (error instanceof AppError && error.code !== 'CRITICAL_ACTION_RECEIPT_INCOMPLETE') return error;
  const code = (error as { code?: string } | null)?.code;
  if (code === '55P03' || code === '40P01') return new AppError('REVIEW_BUSY', 409, 'İnceleme şu anda başka bir işlem tarafından kullanılıyor. Aynı istekle yeniden deneyin.');
  if (code === '57014') return new AppError('REVIEW_TEMPORARILY_UNAVAILABLE', 503, 'İnceleme işlemi zaman aşımına uğradı. Sonucu doğrulamak için yeniden deneyin.');
  if (code === '23505') return new AppError('VERSION_CONFLICT', 409, 'İnceleme başka bir işlem tarafından güncellendi. Yeniden yükleyin.');
  return new AppError('INTERNAL_ERROR', 500, 'İnceleme kaydedilemedi.');
}

function customerFacts(row: LockedCustomerRow): Omit<DuplicateCustomerFacts, 'contacts'> {
  return {
    id: row.id, name: row.name, customerType: row.customer_type, taxNumber: row.tax_number,
    phone: row.phone, email: row.email, city: row.city, district: row.district,
    address: row.address, assignedStaffUserId: row.assigned_staff_user_id, status: row.status,
    version: row.version, addressOverflow: row.address_overflow,
  };
}

function contactFacts(row: LockedContactRow): DuplicateContact {
  return {
    id: row.id, name: row.name, title: row.title, phone: row.phone, email: row.email,
    isPrimary: row.is_primary, isActive: row.is_active, version: row.version,
  };
}

export class PostgresDuplicateReviewRepository {
  constructor(private readonly pool: Pool, private readonly keys: DuplicateKeyring) {}

  async decide(actor: CrmActor, pair: CustomerPair, command: DuplicateDecisionCommand, requestHash: string) {
    return this.run(actor, pair, command, requestHash, DUPLICATE_DECISION_OPERATION, {
      eventKind: 'DECISION_RECORDED', resultingStatus: command.decision,
      reasonCode: command.reasonCode, decision: command.decision,
    });
  }

  async reopen(actor: CrmActor, pair: CustomerPair, command: DuplicateReopenCommand, requestHash: string) {
    return this.run(actor, pair, command, requestHash, DUPLICATE_REOPEN_OPERATION, {
      eventKind: 'REVIEW_REOPENED', resultingStatus: 'PENDING_REVIEW',
      reasonCode: DUPLICATE_REOPEN_REASON, decision: null,
    });
  }

  private async run(
    actor: CrmActor,
    pair: CustomerPair,
    command: DuplicateDecisionCommand | DuplicateReopenCommand,
    requestHash: string,
    operationKey: string,
    intent: {
      eventKind: 'DECISION_RECORDED' | 'REVIEW_REOPENED';
      resultingStatus: 'CONFIRMED_DUPLICATE' | 'DISMISSED' | 'PENDING_REVIEW';
      reasonCode: string; decision: 'CONFIRMED_DUPLICATE' | 'DISMISSED' | null;
    },
  ) {
    try {
      const result = await runCriticalAction<DuplicateCommandReceipt>(
        this.pool,
        {
          organizationId: actor.organizationId, userId: actor.id,
          clientActionId: command.clientActionId, operationKey, requestHash,
        },
        async (client) => ({
          response: await this.execute(client, actor, pair, command, intent),
          realtimeEvents: [],
        }),
        { statementTimeoutMs: DUPLICATE_LIMITS.commandStatementMs, lockTimeoutMs: DUPLICATE_LIMITS.commandLockMs, requestTimeoutMs: DUPLICATE_LIMITS.requestMs },
      );
      if (result.kind === 'processing') {
        throw new AppError('ACTION_IN_PROGRESS', 409, 'Aynı inceleme isteği işleniyor. Aynı istekle yeniden deneyin.');
      }
      return { receipt: result.response, replayed: result.kind === 'replay' };
    } catch (error) {
      throw mapError(error);
    }
  }

  private async execute(
    client: PoolClient,
    actor: CrmActor,
    pair: CustomerPair,
    command: DuplicateDecisionCommand | DuplicateReopenCommand,
    intent: {
      eventKind: 'DECISION_RECORDED' | 'REVIEW_REOPENED';
      resultingStatus: 'CONFIRMED_DUPLICATE' | 'DISMISSED' | 'PENDING_REVIEW';
      reasonCode: string; decision: 'CONFIRMED_DUPLICATE' | 'DISMISSED' | null;
    },
  ): Promise<DuplicateCommandReceipt> {
    if (command.matchingRuleVersion !== DUPLICATE_RULE_VERSION) conflict('MATCHING_RULE_CHANGED', 'Karşılaştırma kuralı değişti. Güncel bilgileri yeniden inceleyin.');
    const expected = parseDuplicateEvidenceRevision(command.expectedEvidenceRevision);
    if (!expected) validation('expectedEvidenceRevision', 'Geçerli bir kanıt revizyonu bekleniyor.');
    if (!this.keys.keys.has(expected.keyId)) {
      throw new AppError('EVIDENCE_KEY_UNAVAILABLE', 409, 'Karşılaştırma kanıtı anahtarı artık kullanılamıyor. Güncel bilgileri yeniden inceleyin.');
    }

    const user = await client.query<{ id: string; role: string; is_active: boolean }>(
      USER_LOCK_SQL, [actor.organizationId, actor.id],
    );
    const lockedUser = user.rows[0];
    if (!lockedUser || !lockedUser.is_active || !['ADMIN', 'MANAGER'].includes(lockedUser.role)) {
      throw new AppError('FORBIDDEN', 403, 'Bu işlem için yönetici yetkisi gerekiyor.');
    }

    const customerRows = await client.query<LockedCustomerRow>(
      CUSTOMER_LOCK_SQL, [actor.organizationId, [pair.customerAId, pair.customerBId], DUPLICATE_LIMITS.addressBytes],
    );
    if (customerRows.rows.length !== 2
      || customerRows.rows.some((row) => row.data_class !== 'BUSINESS'
        || !['prospect', 'active', 'inactive'].includes(row.status))) return notFound();
    const facts = new Map(customerRows.rows.map((row) => {
      const customer = customerFacts(row);
      return [row.id, { ...customer, contacts: [] as DuplicateContact[] }];
    }));

    const contactProbe = await client.query<LockedContactRow & QueryResultRow>(
      DUPLICATE_CONTACTS_SQL, [actor.organizationId, [pair.customerAId, pair.customerBId], DUPLICATE_LIMITS.contacts + 1],
    );
    const counts = new Map<string, number>();
    for (const row of contactProbe.rows) counts.set(row.customer_id, (counts.get(row.customer_id) ?? 0) + 1);
    if ([...counts.values()].some((count) => count > DUPLICATE_LIMITS.contacts)) {
      throw new AppError('EVIDENCE_LIMIT_EXCEEDED', 422, 'Karşılaştırma kanıtının bütünü okunamadı.');
    }
    const contactIds = [...new Set(contactProbe.rows.map((row) => row.id))];
    const lockedContacts = contactIds.length
      ? (await client.query<LockedContactRow>(CONTACT_LOCK_SQL, [
        actor.organizationId, [pair.customerAId, pair.customerBId], contactIds,
      ])).rows
      : [];
    for (const row of lockedContacts) facts.get(row.customer_id)!.contacts.push(contactFacts(row));

    const a = facts.get(pair.customerAId)!;
    const b = facts.get(pair.customerBId)!;
    const evidence = createEvidence(actor.organizationId, a, b, this.keys, expected.keyId);
    if (!duplicateEvidenceMatches(expected.digest, evidence.digest)) {
      conflict('EVIDENCE_CHANGED', 'Karşılaştırma bilgileri değişti. Güncel bilgileri inceleyip yeniden deneyin.');
    }

    const headResult = await client.query<HeadRow>(HEAD_LOCK_SQL, [actor.organizationId, pair.customerAId, pair.customerBId]);
    const head = headResult.rows[0] ?? null;
    let reviewId: string; let version: number; let oldStatus: string | null = null; let currentEvent: CurrentEventRow | null = null;
    if (!head) {
      if (intent.eventKind === 'REVIEW_REOPENED') return notFound();
      if (command.expectedReviewVersion !== 0) conflict('VERSION_CONFLICT', 'İnceleme başka bir işlem tarafından güncellendi. Yeniden yükleyin.');
      reviewId = randomUUID(); version = 1;
      await client.query(
        `INSERT INTO customer_duplicate_reviews(id,organization_id,customer_a_id,customer_b_id,version)
         VALUES($1,$2,$3,$4,1)`, [reviewId, actor.organizationId, pair.customerAId, pair.customerBId],
      );
    } else {
      reviewId = head.id; version = head.version;
      if (command.expectedReviewVersion !== head.version) conflict('VERSION_CONFLICT', 'İnceleme başka bir işlem tarafından güncellendi. Yeniden yükleyin.');
      if (head.version >= 2_147_483_647) conflict('REVIEW_VERSION_LIMIT', 'İnceleme sürüm sınırına ulaştı.');
      currentEvent = (await client.query<CurrentEventRow>(CURRENT_EVENT_SQL, [actor.organizationId, reviewId, head.version])).rows[0] ?? null;
      if (!currentEvent) throw duplicateUnavailable();
      oldStatus = currentEvent.resulting_status;
      if (intent.eventKind === 'REVIEW_REOPENED') {
        if (currentEvent.resulting_status === 'PENDING_REVIEW') conflict('REVIEW_ALREADY_PENDING', 'İnceleme zaten yeniden inceleme bekliyor.');
        if (currentEvent.event_kind !== 'DECISION_RECORDED'
          || !['CONFIRMED_DUPLICATE', 'DISMISSED'].includes(currentEvent.resulting_status)) throw duplicateUnavailable();
      } else {
        if (currentEvent.resulting_status !== 'PENDING_REVIEW') {
          conflict('REVIEW_REOPEN_REQUIRED', 'Önce mevcut kararı açıkça yeniden incelemeye açın.');
        }
        if (currentEvent.event_kind !== 'REVIEW_REOPENED') throw duplicateUnavailable();
      }
      version += 1;
    }

    const eventId = randomUUID();
    const event = await client.query<{ occurred_at: Date }>(
      `INSERT INTO customer_duplicate_review_events
        (id,organization_id,review_id,seq,event_kind,resulting_status,reason_code,actor_user_id,
         evidence_schema_version,matching_rule_version,evidence_key_id,evidence_digest,
         matching_codes,conflicting_tax_numbers)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING occurred_at`,
      [eventId, actor.organizationId, reviewId, version, intent.eventKind, intent.resultingStatus,
        intent.reasonCode, actor.id, evidence.schemaVersion, evidence.matchingRuleVersion,
        expected.keyId, evidence.digest, evidence.matchingCodes, evidence.warnings.length > 0],
    );
    if (head) {
      const updated = await client.query<{ version: number }>(
        `UPDATE customer_duplicate_reviews SET version=version+1
         WHERE organization_id=$1 AND id=$2 AND version=$3 RETURNING version`,
        [actor.organizationId, reviewId, head.version],
      );
      if (updated.rowCount !== 1) conflict('VERSION_CONFLICT', 'İnceleme başka bir işlem tarafından güncellendi. Yeniden yükleyin.');
    }
    await client.query(
      `INSERT INTO audit_events
        (organization_id,actor_user_id,subject_type,subject_id,event_type,old_value,new_value,metadata)
       VALUES($1,$2,'CUSTOMER_DUPLICATE_REVIEW',$3,$4,$5,$6,$7)`,
      [actor.organizationId, actor.id, reviewId,
        intent.eventKind === 'DECISION_RECORDED'
          ? 'CUSTOMER_DUPLICATE_REVIEW_DECIDED' : 'CUSTOMER_DUPLICATE_REVIEW_REOPENED',
        oldStatus ? { reviewStatus: oldStatus } : null,
        { reviewStatus: intent.resultingStatus },
        { historyEventId: eventId, reviewVersion: version, customerAId: pair.customerAId,
          customerBId: pair.customerBId, matchingRuleVersion: DUPLICATE_RULE_VERSION, reasonCode: intent.reasonCode }],
    );
    await client.query('SET CONSTRAINTS customer_duplicate_reviews_current_event_fk IMMEDIATE');
    return {
      reviewId, pair, reviewVersion: version, eventId, eventKind: intent.eventKind,
      resultingStatus: intent.resultingStatus, reasonCode: intent.reasonCode,
      actorUserId: actor.id, occurredAt: event.rows[0]!.occurred_at.toISOString(),
    };
  }

  async history(actor: CrmActor, reviewId: string, cursor: string | null, limit: number): Promise<DuplicateHistoryPage> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
      const head = await client.query<HeadRow>(
        'SELECT id,version FROM customer_duplicate_reviews WHERE organization_id=$1 AND id=$2',
        [actor.organizationId, reviewId],
      );
      if (!head.rows[0]) reviewNotFound();
      const decoded = cursor
        ? decodeHistoryCursor(cursor, this.keys, actor.organizationId, reviewId)
        : { upperSeq: head.rows[0].version, beforeSeq: null };
      if (decoded.upperSeq > head.rows[0].version) {
        throw new AppError('CURSOR_RESTART_REQUIRED', 409, 'Geçmiş imleci kullanılamıyor. İlk sayfadan başlayın.');
      }
      const rows = await client.query<HistoryRow>(
        `SELECT id,seq,event_kind,resulting_status,reason_code,actor_user_id,occurred_at,
                matching_rule_version,matching_codes,conflicting_tax_numbers
         FROM customer_duplicate_review_events
         WHERE organization_id=$1 AND review_id=$2 AND seq <= $3
           AND ($4::integer IS NULL OR seq < $4)
         ORDER BY seq DESC LIMIT $5`,
        [actor.organizationId, reviewId, decoded.upperSeq, decoded.beforeSeq, normalizedLimit + 1],
      );
      await client.query('COMMIT');
      const hasMore = rows.rows.length > normalizedLimit;
      const pageRows = hasMore ? rows.rows.slice(0, normalizedLimit) : rows.rows;
      const items: DuplicateReviewTimelineItem[] = pageRows.map((row) => ({
        eventId: row.id, seq: row.seq, eventKind: row.event_kind as DuplicateReviewTimelineItem['eventKind'],
        resultingStatus: row.resulting_status as DuplicateReviewTimelineItem['resultingStatus'],
        reasonCode: row.reason_code, actorUserId: row.actor_user_id, occurredAt: row.occurred_at.toISOString(),
        matchingRuleVersion: row.matching_rule_version, matchingCodes: row.matching_codes,
        warnings: row.conflicting_tax_numbers ? ['CONFLICTING_TAX_NUMBERS'] : [],
      }));
      return {
        reviewId, upperSeq: decoded.upperSeq, items,
        nextCursor: hasMore && pageRows.length
          ? encodeHistoryCursor(this.keys, actor.organizationId, reviewId, decoded.upperSeq, pageRows.at(-1)!.seq)
          : null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw mapError(error);
    } finally {
      client.release();
    }
  }
}

function createEvidence(
  org: string,
  a: DuplicateCustomerFacts,
  b: DuplicateCustomerFacts,
  keys: DuplicateKeyring,
  keyId: string,
) {
  return createDuplicateEvidenceDetails(org, a, b, keys, keyId);
}
