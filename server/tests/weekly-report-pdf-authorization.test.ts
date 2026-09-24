import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError, toErrorResponse } from '../src/errors/index.js';
import { JobCardService } from '../src/modules/job-cards/service.js';
import { jobCardRoutes } from '../src/modules/job-cards/routes.js';
import type { JobCard, JobCardActor } from '../src/modules/job-cards/types.js';
import type {
  WeeklyReportRow,
  WeeklyReportSubmissionRow,
} from '../src/modules/weekly-reports/repository.js';

/** Local-time DATE construction matches how node-pg materializes DATE columns. */
const DATE_ROW = { periodStart: new Date(2026, 8, 21), periodEnd: new Date(2026, 8, 27) };

const staffActor: JobCardActor = { id: 'staff-1', organizationId: 'org-1', role: 'STAFF' };
const managerActor: JobCardActor = { id: 'manager-1', organizationId: 'org-1', role: 'MANAGER' };
const adminActor: JobCardActor = { id: 'admin-1', organizationId: 'org-1', role: 'ADMIN' };

function jobCard(overrides: Partial<JobCard> = {}): JobCard {
  return {
    id: 'job-1', organizationId: 'org-1', type: 'WEEKLY_REPORT', status: 'WAITING_APPROVAL',
    version: 4, title: 'Haftalık Rapor (2026-09-21 – 2026-09-27)',
    description: 'Talimat', customerId: null, contactId: null,
    assignedTo: 'staff-1', createdBy: 'manager-1', priority: 'normal',
    dueDate: '2026-09-28', scheduledAt: null, scheduledEndsAt: null, engagementKind: null,
    ...overrides,
  };
}

function reportRow(overrides: Partial<WeeklyReportRow> = {}): WeeklyReportRow {
  return {
    id: 'report-1', organization_id: 'org-1', job_card_id: 'job-1', staff_user_id: 'staff-1',
    period_start: DATE_ROW.periodStart, period_end: DATE_ROW.periodEnd,
    draft_summary: 'Canlı taslak özeti', draft_blockers: null, draft_next_week_plan: 'Canlı plan',
    draft_highlights: null, draft_field_observations: null, draft_support_needed: null,
    manager_questions: [{ key: 'q1', prompt: 'Soru?' }], manager_answers: [{ questionKey: 'q1', answer: 'Canlı yanıt' }],
    version: 7, created_at: new Date('2026-09-20T06:00:00.000Z'),
    updated_at: new Date('2026-09-25T06:00:00.000Z'),
    ...overrides,
  };
}

function submissionRow(overrides: Partial<WeeklyReportSubmissionRow> = {}): WeeklyReportSubmissionRow {
  return {
    id: 'sub-2', organization_id: 'org-1', weekly_report_id: 'report-1', job_card_id: 'job-1',
    seq_no: 2, submitted_by: 'staff-1', submitted_at: new Date('2026-09-25T06:15:00.000Z'),
    period_start: DATE_ROW.periodStart, period_end: DATE_ROW.periodEnd,
    frozen_body: {
      summary: 'Dondurulmuş özet', blockers: null, nextWeekPlan: 'Dondurulmuş plan',
      highlights: null, fieldObservations: null, supportNeeded: null,
    },
    frozen_questions: [{ key: 'q1', prompt: 'Soru?' }],
    frozen_answers: [{ questionKey: 'q1', answer: 'Dondurulmuş yanıt' }],
    frozen_source_work: [],
    job_version: 4, source_activity_id: 'act-1', created_at: new Date('2026-09-25T06:15:00.000Z'),
    ...overrides,
  };
}

function repositoryDouble(input: {
  job?: JobCard | null;
  report?: WeeklyReportRow | null;
  submission?: WeeklyReportSubmissionRow | null;
  staffName?: string | null;
} = {}) {
  const job = input.job === undefined ? jobCard() : input.job;
  const report = input.report === undefined ? reportRow() : input.report;
  const submission = input.submission === undefined ? submissionRow() : input.submission;
  return {
    findJobCard: vi.fn().mockResolvedValue(job),
    getWeeklyReportByJobId: vi.fn().mockResolvedValue(report),
    getWeeklyReportSubmissionBySeq: vi.fn().mockResolvedValue(submission),
    getUserDisplayName: vi.fn().mockResolvedValue(input.staffName ?? 'Ayşe Personel'),
    // Every write surface the download must never touch.
    appendActivity: vi.fn(),
    executeCriticalAction: vi.fn(),
    updateWeeklyReportDraftRow: vi.fn(),
    findCompletedCriticalAction: vi.fn(),
    getNextWeeklyReportSubmissionSeqNo: vi.fn(),
    insertWeeklyReportSubmissionRow: vi.fn(),
    reserveLifecycleIntent: vi.fn(),
  };
}

function serviceWith(repository: ReturnType<typeof repositoryDouble>) {
  return new JobCardService(repository as never);
}

describe('Weekly Report submission PDF — authorization matrix', () => {
  it('serves the owning STAFF user for the explicit immutable seq', async () => {
    const repository = repositoryDouble();
    const result = await serviceWith(repository).weeklyReportSubmissionPdf(staffActor, 'job-1', 2);
    expect(repository.getWeeklyReportSubmissionBySeq).toHaveBeenCalledWith('org-1', 'report-1', 2);
    expect(result.fileName).toBe('haftalik-rapor-2026-09-21-seq-2.pdf');
    expect(result.buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('conceals a WEEKLY_REPORT job assigned to another staff member', async () => {
    const repository = repositoryDouble({ job: jobCard({ assignedTo: 'staff-9' }) });
    await expect(serviceWith(repository).weeklyReportSubmissionPdf(staffActor, 'job-1', 1))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND', statusCode: 404 });
    expect(repository.getWeeklyReportSubmissionBySeq).not.toHaveBeenCalled();
  });

  it('conceals a job that is not a WEEKLY_REPORT', async () => {
    const repository = repositoryDouble({ job: jobCard({ type: 'GENERAL_TASK' }) });
    await expect(serviceWith(repository).weeklyReportSubmissionPdf(staffActor, 'job-1', 1))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND', statusCode: 404 });
  });

  it('conceals a cross-tenant job (repository returns nothing)', async () => {
    const repository = repositoryDouble({ job: null });
    await expect(serviceWith(repository).weeklyReportSubmissionPdf(staffActor, 'job-1', 1))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND', statusCode: 404 });
  });

  it('serves a MANAGER in the same organization', async () => {
    const repository = repositoryDouble();
    const result = await serviceWith(repository).weeklyReportSubmissionPdf(managerActor, 'job-1', 2);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('serves an ADMIN in the same organization', async () => {
    const repository = repositoryDouble();
    const result = await serviceWith(repository).weeklyReportSubmissionPdf(adminActor, 'job-1', 2);
    expect(result.buffer.length).toBeGreaterThan(0);
  });

  it('rejects an unknown seq with a domain not-found, never a raw failure', async () => {
    const repository = repositoryDouble({ submission: null });
    await expect(serviceWith(repository).weeklyReportSubmissionPdf(staffActor, 'job-1', 99))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_SUBMISSION_NOT_FOUND', statusCode: 404 });
  });

  it('conceals a job that has no report row yet', async () => {
    const repository = repositoryDouble({ report: null });
    await expect(serviceWith(repository).weeklyReportSubmissionPdf(managerActor, 'job-1', 1))
      .rejects.toMatchObject({ code: 'WEEKLY_REPORT_NOT_FOUND', statusCode: 404 });
  });

  it('is read-only: no activity, version bump, submission insert or idempotency receipt', async () => {
    const repository = repositoryDouble();
    await serviceWith(repository).weeklyReportSubmissionPdf(managerActor, 'job-1', 2);
    expect(repository.appendActivity).not.toHaveBeenCalled();
    expect(repository.executeCriticalAction).not.toHaveBeenCalled();
    expect(repository.updateWeeklyReportDraftRow).not.toHaveBeenCalled();
    expect(repository.findCompletedCriticalAction).not.toHaveBeenCalled();
    expect(repository.getNextWeeklyReportSubmissionSeqNo).not.toHaveBeenCalled();
    expect(repository.insertWeeklyReportSubmissionRow).not.toHaveBeenCalled();
    expect(repository.reserveLifecycleIntent).not.toHaveBeenCalled();
  });

  it('falls back to the submitter id when the display name is unavailable', async () => {
    const repository = repositoryDouble({ staffName: null });
    const result = await serviceWith(repository).weeklyReportSubmissionPdf(managerActor, 'job-1', 2);
    expect(result.buffer.length).toBeGreaterThan(0);
  });
});

const apps: FastifyInstance[] = [];

function routesServiceDouble() {
  return {
    listWeeklyReportSubmissions: vi.fn().mockResolvedValue([]),
    weeklyReportSubmissionPdf: vi.fn().mockResolvedValue({
      fileName: 'haftalik-rapor-2026-09-21-seq-2.pdf',
      buffer: Buffer.from('%PDF-1.3 stub', 'latin1'),
    }),
  };
}

async function createApp(service: ReturnType<typeof routesServiceDouble>) {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    const result = toErrorResponse(error);
    reply.code(result.statusCode).send(result.body);
  });
  const authenticate = async (request: FastifyRequest, _reply: FastifyReply) => {
    request.currentUser = {
      id: 'manager-1', organizationId: 'org-1', name: 'Manager', email: 'm@example.test',
      role: 'MANAGER', mustChangePassword: false, isActive: true, version: 1,
    };
  };
  await app.register(jobCardRoutes, { prefix: '/api/job-cards', service: service as never, authenticate });
  apps.push(app);
  return app;
}

afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe('Weekly Report submission PDF — HTTP route', () => {
  it('sends an attachment PDF with the deterministic ASCII filename', async () => {
    const service = routesServiceDouble();
    const app = await createApp(service);
    const response = await app.inject({ method: 'GET', url: '/api/job-cards/job-1/weekly-report/submissions/2/pdf' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toBe('attachment; filename="haftalik-rapor-2026-09-21-seq-2.pdf"');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(service.weeklyReportSubmissionPdf).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'manager-1' }), 'job-1', 2,
    );
  });

  it('rejects a non-positive or non-numeric seq before service dispatch', async () => {
    const service = routesServiceDouble();
    const app = await createApp(service);
    for (const seq of ['0', '-1', 'abc', '1.5', '1e3']) {
      const response = await app.inject({
        method: 'GET', url: `/api/job-cards/job-1/weekly-report/submissions/${seq}/pdf`,
      });
      expect(response.statusCode, seq).toBe(400);
    }
    expect(service.weeklyReportSubmissionPdf).not.toHaveBeenCalled();
  });

  it('keeps the immutable-version route distinct from the submissions list route', async () => {
    const service = routesServiceDouble();
    const app = await createApp(service);
    const list = await app.inject({ method: 'GET', url: '/api/job-cards/job-1/weekly-report/submissions' });
    expect(list.statusCode).toBe(200);
    expect(service.listWeeklyReportSubmissions).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'manager-1' }), 'job-1',
    );
    expect(service.weeklyReportSubmissionPdf).not.toHaveBeenCalled();
    expect((await app.inject({
      method: 'GET', url: '/api/job-cards/job-1/weekly-report/submissions/2/pdf',
    })).statusCode).toBe(200);
    expect(service.weeklyReportSubmissionPdf).toHaveBeenCalledTimes(1);
    expect(service.listWeeklyReportSubmissions).toHaveBeenCalledTimes(1);
  });

  it('returns domain authorization failures unchanged', async () => {
    const service = routesServiceDouble();
    service.weeklyReportSubmissionPdf.mockRejectedValueOnce(
      new AppError('WEEKLY_REPORT_NOT_FOUND', 404, 'Haftalık rapor bulunamadı.'),
    );
    const app = await createApp(service);
    const response = await app.inject({ method: 'GET', url: '/api/job-cards/job-9/weekly-report/submissions/1/pdf' });
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).code).toBe('WEEKLY_REPORT_NOT_FOUND');
  });
});
