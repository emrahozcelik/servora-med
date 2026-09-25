import type { FastifyPluginAsync, FastifyRequest, preHandlerHookHandler } from 'fastify';

import {
  parseWeeklyReportRecurrenceBulkCreateInput,
  parseWeeklyReportRecurrencePauseInput,
  parseWeeklyReportRecurrenceResumeInput,
  parseWeeklyReportRecurrenceTemplateUpdateInput,
} from './recurrence-input.js';
import type { WeeklyReportRecurrenceService } from './recurrence-service.js';
import type { JobCardActor } from '../job-cards/types.js';

export type WeeklyReportRecurrenceRoutesOptions = {
  service: WeeklyReportRecurrenceService;
  authenticate: preHandlerHookHandler;
};

function actor(request: FastifyRequest): JobCardActor {
  const user = request.currentUser!;
  return { id: user.id, organizationId: user.organizationId, role: user.role };
}

/**
 * Weekly Report recurrence configuration surface (V1 Slice 5).
 *
 * Registered under the same `/api/job-cards` prefix as the WeeklyReport
 * create/read routes so the recurrence endpoints sit next to the reports they
 * generate. Authorization is enforced in the service (MANAGER/ADMIN only);
 * STAFF has no route that succeeds, and cross-tenant ids are concealed as
 * not-found.
 */
export const weeklyReportRecurrenceRoutes: FastifyPluginAsync<
  WeeklyReportRecurrenceRoutesOptions
> = async (app, options) => {
  const secured = { preHandler: options.authenticate };
  app.post('/weekly-reports/recurrences/bulk', secured, async (request, reply) =>
    reply.code(201).send(await options.service.bulkCreate(
      actor(request),
      parseWeeklyReportRecurrenceBulkCreateInput(request.body),
    )));
  app.get('/weekly-reports/recurrences', secured, async (request) =>
    options.service.list(actor(request)));
  app.put<{ Params: { id: string } }>(
    '/weekly-reports/recurrences/:id/template',
    secured,
    async (request) => options.service.updateTemplate(
      actor(request),
      request.params.id,
      parseWeeklyReportRecurrenceTemplateUpdateInput(request.body),
    ),
  );
  app.post<{ Params: { id: string } }>(
    '/weekly-reports/recurrences/:id/pause',
    secured,
    async (request) => options.service.pause(
      actor(request),
      request.params.id,
      parseWeeklyReportRecurrencePauseInput(request.body),
    ),
  );
  app.post<{ Params: { id: string } }>(
    '/weekly-reports/recurrences/:id/resume',
    secured,
    async (request) => options.service.resume(
      actor(request),
      request.params.id,
      parseWeeklyReportRecurrenceResumeInput(request.body),
    ),
  );
};
