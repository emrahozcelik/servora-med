import type { FastifyReply, FastifyRequest } from 'fastify';

import { jobCardActor as actor, saleCapability } from '../job-cards/http-access.js';
import type { JobCardService } from '../job-cards/service.js';
import { uuidString, validation } from '../job-cards/validation.js';
import {
  parseWeeklyReportBulkRequestInput,
  parseWeeklyReportCreateInput,
  parseWeeklyReportDraftPatch,
} from './create-input.js';
import { readWeeklyReportReference, type WeeklyReportTimezoneReader } from './reference.js';
import { parseWeeklyReportRemovalInput } from './removal-input.js';
import type { WeeklyReportDetail } from './types.js';

type Params = { id: string };

export type WeeklyReportHttpService = Pick<JobCardService,
  | 'assertSaleCapability'
  | 'createWeeklyReport'
  | 'bulkRequestWeeklyReports'
  | 'getWeeklyReport'
  | 'updateWeeklyReportDraft'
  | 'weeklyReportRemovalPreview'
  | 'removeWeeklyReport'
  | 'listWeeklyReportSubmissions'
  | 'weeklyReportSubmissionPdf'
>;

function removalCapability(raw: unknown) {
  return !!raw && typeof raw === 'object'
    && (raw as Record<string, unknown>).includeWeeklyReportRemovalCapability === 'true';
}

function weeklyReportResponse(report: WeeklyReportDetail, query: unknown) {
  if (removalCapability(query)) return report;
  const { removal: _removal, canRemove: _canRemove, ...legacy } = report;
  return legacy;
}

function submissionSequence(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) throw validation('seq');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw validation('seq');
  return parsed;
}

export function createWeeklyReportHandlers(
  service: WeeklyReportHttpService,
  timezones: WeeklyReportTimezoneReader,
  now?: () => Date,
) {
  return {
    createWeeklyReport: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(await service.createWeeklyReport(
        actor(request),
        parseWeeklyReportCreateInput(request.body),
      )),
    bulkRequestWeeklyReports: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(await service.bulkRequestWeeklyReports(
        actor(request),
        parseWeeklyReportBulkRequestInput(request.body),
      )),
    getWeeklyReport: async (request: FastifyRequest<{ Params: Params }>) =>
      weeklyReportResponse(await service.getWeeklyReport(
        actor(request), request.params.id, saleCapability(request.query),
      ), request.query),
    weeklyReportRemovalPreview: (request: FastifyRequest<{ Params: Params }>) =>
      service.weeklyReportRemovalPreview(actor(request), uuidString(request.params.id, 'id')),
    removeWeeklyReport: (request: FastifyRequest<{ Params: Params }>) =>
      service.removeWeeklyReport(
        actor(request), uuidString(request.params.id, 'id'), parseWeeklyReportRemovalInput(request.body),
      ),
    getWeeklyReportReference: (request: FastifyRequest) =>
      readWeeklyReportReference(timezones, actor(request).organizationId, now),
    updateWeeklyReportDraft: async (request: FastifyRequest<{ Params: Params }>) =>
      weeklyReportResponse(await service.updateWeeklyReportDraft(
        actor(request),
        request.params.id,
        parseWeeklyReportDraftPatch(request.body),
        saleCapability(request.query),
      ), request.query),
    listWeeklyReportSubmissions: (request: FastifyRequest<{ Params: Params }>) =>
      service.listWeeklyReportSubmissions(actor(request), request.params.id, saleCapability(request.query)),
    downloadWeeklyReportSubmissionPdf: async (
      request: FastifyRequest<{ Params: { id: string; seq: string } }>,
      reply: FastifyReply,
    ) => {
      const pdf = await service.weeklyReportSubmissionPdf(
        actor(request),
        request.params.id,
        submissionSequence(request.params.seq),
      );
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${pdf.fileName}"`)
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .send(pdf.buffer);
    },
  };
}
