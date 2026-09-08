import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { PostgresJobCardRepository } from '../src/modules/job-cards/repository.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import type { JobCardActor } from '../src/modules/job-cards/types.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

const MIGRATIONS = [
  '001_auth_foundation.sql', '002_delivery_tracer.sql', '003_people.sql',
  '004_crm_contacts.sql', '005_product_catalog.sql', '006_jobcard_workspace.sql',
  '007_sales_meeting.sql', '008_meeting_approval_withdrawal.sql',
  '009_job_acceptance_and_scheduling.sql', '010_entity_delete_audit.sql',
  '011_create_realtime_events.sql', '012_create_in_app_notifications.sql',
  '013_create_job_action_locations.sql', '014_create_web_push.sql',
  '015_job_card_engagement_kind.sql', '016_google_reverse_geocoding.sql',
  '017_calendar.sql', '018_messaging.sql',
  '019_job_card_operational_note_context.sql',
  '020_job_card_transition_note_contexts.sql',
  '021_job_card_note_added_notification_kind.sql',
  '022_job_card_follow_up_links.sql', '024_job_card_notes_invoice_number.sql',
  '027_follow_up_proposals.sql', '028_notification_center_dismissal.sql',
  '029_messaging_conversation_archive.sql', '030_backup_domain_foundation.sql',
  '031_backup_engine_failure_taxonomy_and_dump_version.sql',
  '032_backup_r2_failure_taxonomy.sql', '033_backup_worker_runtime.sql',
  '034_demo_data_foundation.sql', '035_demo_data_purge_foundation.sql',
  '036_job_card_invalidated.sql', '042_unsuccessful_visit_reason.sql',
  '043_job_card_schedule_and_assignment_history.sql',
  '044_job_card_accountability_facts.sql',
] as const;

describe.skipIf(!databaseUrl)('JobCard critical-action request identity (AUDIT-0 remediation)', () => {
  it('rejects same-key different-payload replays with CLIENT_ACTION_REUSED and preserves exact replay', async () => {
    const adminPool = new Pool({ connectionString: databaseUrl });
    const schema = `reqident_${randomUUID().replaceAll('-', '')}`;
    let pool: Pool | null = null;
    try {
      await adminPool.query(`CREATE SCHEMA ${schema}`);
      pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
      for (const migration of MIGRATIONS) {
        const path = fileURLToPath(new URL(`../src/db/migrations/${migration}`, import.meta.url));
        await pool.query(await readFile(path, 'utf8'));
      }

      const organizationId = (await pool.query<{ id: string }>(
        `INSERT INTO organizations (name) VALUES ('Request identity') RETURNING id`,
      )).rows[0]!.id;
      async function user(name: string, role: 'MANAGER' | 'STAFF') {
        return (await pool!.query<{ id: string }>(
          `INSERT INTO users (organization_id, name, email, password_hash, role)
           VALUES ($1, $2, $3, 'unused-test-hash', $4) RETURNING id`,
          [organizationId, name, `${randomUUID()}@test.local`, role],
        )).rows[0]!.id;
      }
      const managerId = await user('Yönetici', 'MANAGER');
      const staffId = await user('Personel', 'STAFF');
      await pool.query(
        `INSERT INTO staff_profiles (organization_id, user_id, manager_user_id)
         VALUES ($1, $2, $3)`,
        [organizationId, staffId, managerId],
      );
      const customerId = (await pool.query<{ id: string }>(
        `INSERT INTO customers (organization_id, name, customer_type, status)
         VALUES ($1, 'ABC Klinik', 'clinic', 'active') RETURNING id`, [organizationId],
      )).rows[0]!.id;
      const productId = (await pool.query<{ id: string }>(
        `INSERT INTO products (organization_id, name, unit) VALUES ($1, 'İmplant Seti', 'adet') RETURNING id`, [organizationId],
      )).rows[0]!.id;
      async function legacyJob(
        title: string, type = 'PRODUCT_DELIVERY', scheduledAt: string | null = null,
        status = 'NEW',
      ) {
        // Canonical interval: SM +60m (PD fixtures use service-level creation).
        const scheduledEndsAt = scheduledAt === null
          ? null
          : new Date(Date.parse(scheduledAt) + (type === 'SALES_MEETING' ? 60 : 30) * 60_000);
        const completedColumns = status === 'COMPLETED'
          ? `, started_at, staff_completed_at, staff_completed_by, manager_approved_at, manager_approved_by`
          : '';
        const completedValues = status === 'COMPLETED'
          ? `, NOW(), NOW(), $5::uuid, NOW(), $5::uuid`
          : '';
        const jobCardId = (await pool!.query<{ id: string }>(
          `INSERT INTO job_cards
             (organization_id, type, title, customer_id, assigned_to, created_by,
              scheduled_at, scheduled_ends_at, status, accepted_at, accepted_by, engagement_kind${completedColumns})
           VALUES ($1, $2::varchar, $3, $4, $5::uuid, $5::uuid, $6, $8, $7::varchar,
             CASE WHEN $7::varchar = 'ACCEPTED' THEN NOW() END,
             CASE WHEN $7::varchar = 'ACCEPTED' THEN $5::uuid END,
             CASE WHEN $2::varchar = 'SALES_MEETING' THEN 'CUSTOMER_VISIT' END${completedValues})
           RETURNING id`,
          [organizationId, type, title, customerId, staffId, scheduledAt, status, scheduledEndsAt],
        )).rows[0]!.id;
        await pool!.query(
          `INSERT INTO job_card_schedule_revisions
             (organization_id, job_card_id, revision_no, organization_timezone, source, created_by)
           VALUES ($1, $2, 1, 'Europe/Istanbul', 'CREATE', $3)`,
          [organizationId, jobCardId, staffId],
        );
        return jobCardId;
      }

      const repository = new PostgresJobCardRepository(pool);
      const service = new JobCardService(repository, () => new Date('2026-07-20T08:00:00.000Z'));
      const staff: JobCardActor = { id: staffId, organizationId, role: 'STAFF' };
      const manager: JobCardActor = { id: managerId, organizationId, role: 'MANAGER' };

      const claimRow = async (clientActionId: string, operationKey: string) => (
        await pool!.query<{ request_hash: string | null; status: string; status_code: number }>(
          `SELECT request_hash, status, status_code FROM processed_actions
            WHERE client_action_id = $1 AND operation_key = $2`,
          [clientActionId, operationKey],
        )
      ).rows;
      const snapshot = async () => ({
        jobs: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_cards`)).rows[0]!.n,
        activities: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_card_activity_logs`)).rows[0]!.n,
        notes: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_card_notes`)).rows[0]!.n,
        revisions: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_card_schedule_revisions`)).rows[0]!.n,
        facts: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_card_accountability_facts`)).rows[0]!.n,
        locations: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_action_locations`)).rows[0]!.n,
        children: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_cards WHERE source_job_card_id IS NOT NULL`)).rows[0]!.n,
        items: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM job_card_delivery_items`)).rows[0]!.n,
        processed: (await pool!.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM processed_actions`)).rows[0]!.n,
      });

      // ---- JOB_CREATE: exact retry + payload mismatch ----
      const createInput = {
        clientActionId: 'create-key-1', type: 'GENERAL_TASK' as const,
        title: 'Rapor hazırlama', description: null, customerId: null,
        contactId: null, assignedTo: staffId, priority: 'normal' as const,
        dueDate: null, scheduledAt: null,
      };
      const created = await service.create(staff, createInput);
      expect((await claimRow('create-key-1', 'JOB_CREATE'))[0]!.request_hash).not.toBeNull();
      const beforeReplay = await snapshot();
      const replayed = await service.create(staff, createInput);
      expect(replayed).toMatchObject({ id: created.id });
      expect(await snapshot()).toEqual(beforeReplay);
      await expect(service.create(staff, { ...createInput, title: 'Farklı iş' }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      await expect(service.create(staff, { ...createInput, priority: 'high' }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(beforeReplay);

      // ---- CANCEL: exact retry + reason/version mismatch ----
      const cancelJobId = await legacyJob('İptal edilecek iş');
      await service.cancel(manager, cancelJobId, {
        clientActionId: 'cancel-key-1', expectedVersion: 1, cancelReason: 'Zamanlama değişti',
      });
      expect((await claimRow('cancel-key-1', `JOB_CANCEL:${cancelJobId}`))[0]!.request_hash).not.toBeNull();
      const afterCancel = await snapshot();
      const cancelReplay = await service.cancel(manager, cancelJobId, {
        clientActionId: 'cancel-key-1', expectedVersion: 1, cancelReason: 'Zamanlama değişti',
      });
      expect(cancelReplay).toMatchObject({ status: 'CANCELLED' });
      expect(await snapshot()).toEqual(afterCancel);
      await expect(service.cancel(manager, cancelJobId, {
        clientActionId: 'cancel-key-1', expectedVersion: 1, cancelReason: 'Ürün tedarik edilemedi',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      await expect(service.cancel(manager, cancelJobId, {
        clientActionId: 'cancel-key-1', expectedVersion: 2, cancelReason: 'Zamanlama değişti',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterCancel);

      // ---- ACCEPT_ASSIGNMENT: expectedVersion mismatch ----
      const acceptJobId = await legacyJob('Kabul edilecek iş');
      await service.acceptAssignment(staff, acceptJobId, {
        clientActionId: 'accept-key-1', expectedVersion: 1,
      });
      const afterAccept = await snapshot();
      await expect(service.acceptAssignment(staff, acceptJobId, {
        clientActionId: 'accept-key-1', expectedVersion: 2,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterAccept);

      // ---- START: expectedVersion mismatch (geolocation disabled) ----
      const startJobId = await legacyJob('Başlanacak görev', 'GENERAL_TASK', null, 'ACCEPTED');
      await service.start(staff, startJobId, {
        clientActionId: 'start-key-1', expectedVersion: 1,
      });
      expect((await claimRow('start-key-1', `JOB_START:${startJobId}`))[0]!.request_hash).not.toBeNull();
      const afterStart = await snapshot();
      await expect(service.start(staff, startJobId, {
        clientActionId: 'start-key-1', expectedVersion: 2,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterStart);

      // ---- SUBMIT_FOR_APPROVAL: note mismatch (IN_PROGRESS required) ----
      const submitJobId = await legacyJob('Onaya gidecek görev', 'GENERAL_TASK', null, 'ACCEPTED');
      await service.start(staff, submitJobId, { clientActionId: 'submit-start-1', expectedVersion: 1 });
      await service.submitForApproval(staff, submitJobId, {
        clientActionId: 'submit-key-1', expectedVersion: 2, note: 'Teslimat tamamlandı, onay bekliyor',
      });
      expect((await claimRow('submit-key-1', `JOB_SUBMIT_FOR_APPROVAL:${submitJobId}`))[0]!.request_hash).not.toBeNull();
      const afterSubmit = await snapshot();
      await expect(service.submitForApproval(staff, submitJobId, {
        clientActionId: 'submit-key-1', expectedVersion: 2, note: 'Ürünün yarısı teslim edildi',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterSubmit);

      // ---- REQUEST_REVISION: reason mismatch ----
      const revisionJobId = await legacyJob('Revize edilecek görev', 'GENERAL_TASK', null, 'ACCEPTED');
      await service.start(staff, revisionJobId, { clientActionId: 'revision-start-1', expectedVersion: 1 });
      await service.submitForApproval(staff, revisionJobId, {
        clientActionId: 'revision-submit-1', expectedVersion: 2, note: 'Teslimat tamamlandı',
      });
      await service.requestRevision(manager, revisionJobId, {
        clientActionId: 'revision-key-1', expectedVersion: 3, revisionReason: 'Fotoğraflar eksik',
      });
      const afterRevision = await snapshot();
      await expect(service.requestRevision(manager, revisionJobId, {
        clientActionId: 'revision-key-1', expectedVersion: 3, revisionReason: 'Yanlış müşteri ziyaret edildi',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterRevision);

      // ---- APPROVE: note mismatch ----
      const approveJobId = await legacyJob('Onaylanacak görev', 'GENERAL_TASK', null, 'ACCEPTED');
      await service.start(staff, approveJobId, { clientActionId: 'approve-start-1', expectedVersion: 1 });
      await service.submitForApproval(staff, approveJobId, {
        clientActionId: 'approve-submit-1', expectedVersion: 2, note: 'Hazır',
      });
      await service.approve(manager, approveJobId, {
        clientActionId: 'approve-key-1', expectedVersion: 3, note: 'Onaylandı, iyi çalışma',
      });
      const afterApprove = await snapshot();
      await expect(service.approve(manager, approveJobId, {
        clientActionId: 'approve-key-1', expectedVersion: 3, note: 'Onaylandı, fatura kesilecek',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterApprove);

      // ---- WITHDRAW_FROM_APPROVAL + RESUME: expectedVersion mismatch ----
      const withdrawJobId = await legacyJob('Geri çekilecek görev', 'GENERAL_TASK', null, 'ACCEPTED');
      await service.start(staff, withdrawJobId, { clientActionId: 'withdraw-start-1', expectedVersion: 1 });
      await service.submitForApproval(staff, withdrawJobId, {
        clientActionId: 'withdraw-submit-1', expectedVersion: 2, note: 'Hazır',
      });
      await service.withdrawFromApproval(staff, withdrawJobId, {
        clientActionId: 'withdraw-key-1', expectedVersion: 3,
      });
      const afterWithdraw = await snapshot();
      await expect(service.withdrawFromApproval(staff, withdrawJobId, {
        clientActionId: 'withdraw-key-1', expectedVersion: 4,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterWithdraw);

      const resumeJobId = await legacyJob('Devam edecek görev', 'GENERAL_TASK', null, 'ACCEPTED');
      await service.start(staff, resumeJobId, { clientActionId: 'resume-start-1', expectedVersion: 1 });
      await service.submitForApproval(staff, resumeJobId, {
        clientActionId: 'resume-submit-1', expectedVersion: 2, note: 'Hazır',
      });
      await service.requestRevision(manager, resumeJobId, {
        clientActionId: 'resume-revision-1', expectedVersion: 3, revisionReason: 'Eksik görsel',
      });
      await service.resume(staff, resumeJobId, {
        clientActionId: 'resume-key-1', expectedVersion: 4,
      });
      const afterResume = await snapshot();
      await expect(service.resume(staff, resumeJobId, {
        clientActionId: 'resume-key-1', expectedVersion: 5,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterResume);

      // ---- SUBMIT follow-up proposal: proposal mismatch (SALES_MEETING visit) ----
      const proposalJobId = await legacyJob('Ziyaret görevi', 'SALES_MEETING', '2026-07-13T09:00:00.000Z', 'ACCEPTED');
      // CUSTOMER_VISIT engagement is required for the mandatory follow-up path.
      await pool!.query(
        `INSERT INTO job_card_meeting_details
           (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
         VALUES ($1, $2, '2026-07-13T09:30:00.000Z', 'FOLLOW_UP_REQUIRED', 'İlk görüşme')`,
        [organizationId, proposalJobId],
      );
      await service.start(staff, proposalJobId, { clientActionId: 'proposal-start-1', expectedVersion: 1 });
      await service.patchMeetingDetails(manager, proposalJobId, {
        clientActionId: 'proposal-details-1', expectedVersion: 2,
        outcome: 'FOLLOW_UP_REQUIRED', unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
        meetingSummary: 'Görüşüldü',
      });
      await service.submitForApproval(staff, proposalJobId, {
        clientActionId: 'proposal-key-1', expectedVersion: 3, note: 'Ziyaret tamamlandı',
        followUpProposal: {
          scheduledAt: '2026-07-25T10:00:00.000Z', type: 'SALES_MEETING',
          assignedTo: staffId, followUpInstructions: 'Tekrar arayın',
        },
      });
      expect((await claimRow('proposal-key-1', `JOB_SUBMIT_FOR_APPROVAL:${proposalJobId}`))[0]!.request_hash).not.toBeNull();
      const afterProposal = await snapshot();
      await expect(service.submitForApproval(staff, proposalJobId, {
        clientActionId: 'proposal-key-1', expectedVersion: 3, note: 'Ziyaret tamamlandı',
        followUpProposal: {
          scheduledAt: '2026-07-30T14:00:00.000Z', type: 'SALES_MEETING',
          assignedTo: staffId, followUpInstructions: 'Numune bırakın',
        },
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterProposal);

      // ---- PRODUCT_DELIVERY_CREATE: item mismatch ----
      const pdInput = {
        clientActionId: 'pd-create-1', type: 'PRODUCT_DELIVERY' as const,
        title: 'Numune teslimi', description: null, customerId,
        contactId: null, assignedTo: staffId, priority: 'normal' as const,
        dueDate: null, scheduledAt: '2026-07-10T10:00:00.000Z',
        scheduledEndsAt: '2026-07-10T10:30:00.000Z',
        deliveryPurpose: 'SALE' as const, deliveryNote: null,
        items: [{ productId, quantity: 2 }],
      };
      const pdCreated = await service.createProductDelivery(staff, pdInput);
      // createProductDelivery resolves to { jobCardId, version }.
      expect(pdCreated).toMatchObject({ jobCardId: expect.any(String) });
      const pdJobId = (pdCreated as { jobCardId: string }).jobCardId;
      expect((await claimRow('pd-create-1', 'PRODUCT_DELIVERY_CREATE'))[0]!.request_hash).not.toBeNull();
      const afterPd = await snapshot();
      const pdReplay = await service.createProductDelivery(staff, pdInput);
      expect(pdReplay).toMatchObject({ jobCardId: pdJobId });
      await expect(service.createProductDelivery(staff, {
        ...pdInput, items: [{ productId, quantity: 5 }],
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterPd);

      // ---- JOB_FOLLOW_UP_CREATE: intent mismatch ----
      const sourceJobId = await legacyJob('Takip kaynağı', 'GENERAL_TASK', null, 'COMPLETED');
      const followUpInput = {
        clientActionId: 'followup-key-1', type: 'GENERAL_TASK' as const,
        title: 'Takip: arama', followUpInstructions: 'Öğleden sonra arayın',
        scheduledAt: null, assignedTo: staffId, priority: 'normal' as const,
        dueDate: null, contactId: null, engagementKind: null,
      };
      await service.createFollowUp(manager, sourceJobId, followUpInput);
      expect((await claimRow('followup-key-1', `JOB_FOLLOW_UP_CREATE:${sourceJobId}`))[0]!.request_hash).not.toBeNull();
      const afterFollowUp = await snapshot();
      await expect(service.createFollowUp(manager, sourceJobId, {
        ...followUpInput, followUpInstructions: 'Ertesi gün arayın',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterFollowUp);

      // ---- MEETING_DETAILS_UPDATE: patch + expectedVersion mismatch ----
      const meetingJobId = await legacyJob('Görüşme sonucu', 'SALES_MEETING', '2026-07-13T09:00:00.000Z', 'ACCEPTED');
      await pool!.query(
        `INSERT INTO job_card_meeting_details
           (organization_id, job_card_id, meeting_at, outcome, meeting_summary)
         VALUES ($1, $2, '2026-07-13T09:30:00.000Z', 'POSITIVE', 'İlk görüşme')`,
        [organizationId, meetingJobId],
      );
      await service.start(staff, meetingJobId, { clientActionId: 'meeting-start-1', expectedVersion: 1 });
      await service.patchMeetingDetails(manager, meetingJobId, {
        clientActionId: 'meeting-key-1', expectedVersion: 2,
        outcome: 'FOLLOW_UP_REQUIRED', unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
        meetingSummary: 'Görüşüldü',
      });
      expect((await claimRow('meeting-key-1', `MEETING_DETAILS_UPDATE:${meetingJobId}`))[0]!.request_hash).not.toBeNull();
      const afterMeeting = await snapshot();
      await expect(service.patchMeetingDetails(manager, meetingJobId, {
        clientActionId: 'meeting-key-1', expectedVersion: 2,
        outcome: 'FOLLOW_UP_REQUIRED', unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
        meetingSummary: 'Farklı özet',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      await expect(service.patchMeetingDetails(manager, meetingJobId, {
        clientActionId: 'meeting-key-1', expectedVersion: 3,
        outcome: 'FOLLOW_UP_REQUIRED', unsuccessfulReason: 'CONTACT_NOT_AVAILABLE',
        meetingSummary: 'Görüşüldü',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterMeeting);

      // ---- DELIVERY_ITEM_CREATE: canonical expiry, exact equivalent replay, and validation ----
      const itemJobId = pdJobId;
      const expiryInput = {
        clientActionId: 'expiry-key-1', expectedVersion: pdReplay.version,
        productId, deliveryPurpose: 'SALE' as const, deliveredAt: null, quantity: 1,
        expiryDate: '2026-09-01',
      };
      const expiryCreated = await service.addDeliveryItem(staff, itemJobId, expiryInput);
      const expiryReplay = await service.addDeliveryItem(staff, itemJobId, {
        ...expiryInput, expiryDate: '2026-9-1',
      });
      expect(expiryReplay.item.id).toBe(expiryCreated.item.id);
      expect(expiryReplay.jobCardVersion).toBe(expiryCreated.jobCardVersion);
      const persistedExpiry = (await pool!.query<{ expiry_date: string }>(
        `SELECT expiry_date::text FROM job_card_delivery_items WHERE id = $1`,
        [expiryCreated.item.id],
      )).rows[0]!.expiry_date;
      expect(persistedExpiry).toBe('2026-09-01');
      await expect(service.addDeliveryItem(staff, itemJobId, {
        ...expiryInput, expiryDate: '2026-09-02',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      const beforeInvalidExpiry = await snapshot();
      await expect(service.addDeliveryItem(staff, itemJobId, {
        ...expiryInput, clientActionId: 'expiry-invalid-1',
        expectedVersion: expiryCreated.jobCardVersion, expiryDate: '2026-02-29',
      })).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 400 });
      expect(await snapshot()).toEqual(beforeInvalidExpiry);

      // PATCH uses the same date-only contract and accepts the unpadded form.
      const patchedExpiry = await service.patchDeliveryItem(staff, itemJobId, expiryCreated.item.id, {
        expectedVersion: expiryCreated.jobCardVersion, expiryDate: '2028-2-29',
      });
      expect(patchedExpiry.item.expiryDate).toBe('2028-02-29');
      const persistedPatchedExpiry = (await pool!.query<{ expiry_date: string }>(
        `SELECT expiry_date::text FROM job_card_delivery_items WHERE id = $1`,
        [expiryCreated.item.id],
      )).rows[0]!.expiry_date;
      expect(persistedPatchedExpiry).toBe('2028-02-29');

      // ---- DELIVERY_ITEM_CREATE: quantity + expectedVersion independently mismatch ----
      const itemExpectedVersion = expiryCreated.jobCardVersion + 1;
      await service.addDeliveryItem(staff, itemJobId, {
        clientActionId: 'item-key-1', expectedVersion: itemExpectedVersion,
        productId, deliveryPurpose: 'SALE', deliveredAt: null, quantity: 3,
      });
      expect((await claimRow('item-key-1', 'DELIVERY_ITEM_CREATE'))[0]!.request_hash).not.toBeNull();
      const afterItem = await snapshot();
      await expect(service.addDeliveryItem(staff, itemJobId, {
        clientActionId: 'item-key-1', expectedVersion: itemExpectedVersion,
        productId, deliveryPurpose: 'SALE', deliveredAt: null, quantity: 4,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      await expect(service.addDeliveryItem(staff, itemJobId, {
        clientActionId: 'item-key-1', expectedVersion: itemExpectedVersion + 1,
        productId, deliveryPurpose: 'SALE', deliveredAt: null, quantity: 3,
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterItem);

      // ---- JOB_NOTE_ADD: note/invoice mismatch ----
      await service.addNote(staff, itemJobId, {
        clientActionId: 'note-key-1', note: 'Lot bilgisi eklendi',
      });
      expect((await claimRow('note-key-1', `JOB_NOTE_ADD:${itemJobId}`))[0]!.request_hash).not.toBeNull();
      const afterNote = await snapshot();
      await expect(service.addNote(staff, itemJobId, {
        clientActionId: 'note-key-1', note: 'Farklı not',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      await expect(service.addNote(staff, itemJobId, {
        clientActionId: 'note-key-1', note: 'Lot bilgisi eklendi', invoiceNumber: 'FT-2026-001',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterNote);

      // ---- Legacy NULL request_hash fail-closed (CREATE + lifecycle) ----
      await pool!.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, request_hash, status, status_code, response_body, completed_at)
         VALUES ($1, $2, 'legacy-create-key', 'JOB_CREATE', NULL, 'completed', 200,
           '{"jobCardId":"legacy-job","evaluatedAt":"2026-07-14T09:00:00.000Z"}'::jsonb, NOW())`,
        [organizationId, staffId],
      );
      await pool!.query(
        `INSERT INTO processed_actions
           (organization_id, user_id, client_action_id, operation_key, request_hash, status, status_code, response_body, completed_at)
         VALUES ($1, $2, 'legacy-cancel-key', $3, NULL, 'completed', 200,
           '{"jobCardId":"legacy-cancel-job","evaluatedAt":"2026-07-14T09:00:00.000Z"}'::jsonb, NOW())`,
        [organizationId, managerId, `JOB_CANCEL:${cancelJobId}`],
      );
      // The two legacy rows themselves are the only delta (28 → 30).
      const afterLegacyInsert = await snapshot();
      expect(afterLegacyInsert.processed).toBe(afterNote.processed + 2);
      await expect(service.create(staff, { ...createInput, clientActionId: 'legacy-create-key' }))
        .rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      await expect(service.cancel(manager, cancelJobId, {
        clientActionId: 'legacy-cancel-key', expectedVersion: 1, cancelReason: 'Zamanlama değişti',
      })).rejects.toMatchObject({ code: 'CLIENT_ACTION_REUSED', statusCode: 409 });
      expect(await snapshot()).toEqual(afterLegacyInsert);

      // All new completed processed_actions rows carry a request hash.
      const nullHashes = (await pool!.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM processed_actions
          WHERE status='completed' AND request_hash IS NULL AND client_action_id NOT LIKE 'legacy-%'`,
      )).rows[0]!.n;
      expect(nullHashes).toBe(0);
    } finally {
      await pool?.end();
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await adminPool.end();
    }
  });
});
