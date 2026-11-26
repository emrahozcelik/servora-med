import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { securedJobCardRoutes } from '../job-cards/http-access.js';
import { createWeeklyReportHandlers, type WeeklyReportHttpService } from './handlers.js';
import type { WeeklyReportTimezoneReader } from './reference.js';

type WeeklyReportRoutesOptions = {
  service: WeeklyReportHttpService;
  authenticate: preHandlerHookHandler;
  timezones: WeeklyReportTimezoneReader;
  now?: () => Date;
};

export const weeklyReportRoutes: FastifyPluginAsync<WeeklyReportRoutesOptions> = async (app, options) => {
  const h = createWeeklyReportHandlers(options.service, options.timezones, options.now);
  const secured = securedJobCardRoutes(options.authenticate, options.service);
  app.post('/weekly-reports', secured, h.createWeeklyReport);
  app.post('/weekly-reports/bulk-request', secured, h.bulkRequestWeeklyReports);
  app.get('/weekly-reports/reference', secured, h.getWeeklyReportReference);
  app.get<{ Params: { id: string } }>('/:id/weekly-report', secured, h.getWeeklyReport);
  app.patch<{ Params: { id: string } }>('/:id/weekly-report', secured, h.updateWeeklyReportDraft);
  app.get<{ Params: { id: string } }>('/:id/weekly-report/removal-preview', secured, h.weeklyReportRemovalPreview);
  app.post<{ Params: { id: string } }>('/:id/weekly-report/remove', secured, h.removeWeeklyReport);
  app.get<{ Params: { id: string } }>('/:id/weekly-report/submissions', secured, h.listWeeklyReportSubmissions);
  app.get<{ Params: { id: string; seq: string } }>(
    '/:id/weekly-report/submissions/:seq/pdf',
    secured,
    h.downloadWeeklyReportSubmissionPdf,
  );
};
