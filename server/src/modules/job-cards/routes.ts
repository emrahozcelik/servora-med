import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify';

import { createJobCardHandlers } from './handlers.js';
import type { JobCardService } from './service.js';

export type JobCardRoutesOptions = { service: JobCardService; authenticate: preHandlerHookHandler };

export const jobCardRoutes: FastifyPluginAsync<JobCardRoutesOptions> = async (app, options) => {
  const h = createJobCardHandlers(options.service);
  const legacySaleGuard: preHandlerHookHandler = async (request) => {
    const id = (request.params as { id?: string }).id;
    if (!id) return;
    const user = request.currentUser!;
    await options.service.assertSaleCapability(user, id,
      (request.query as Record<string, unknown>).includeSaleCapability === 'true');
  };
  const secured = { preHandler: [options.authenticate, legacySaleGuard] };
  app.get('/', secured, h.list);
  app.post('/', secured, h.create);
  app.post('/product-deliveries', secured, h.createProductDelivery);
  // SALE-002 §6.1: standalone sale creation is a static one-segment path. It is
  // registered with the other collection creates, before the '/:id' readers.
  app.post('/sales', secured, h.createStandaloneSale);
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
  app.post('/customer-schedule/evaluate', secured, h.previewCustomerSchedule);
  app.post('/available-slots', secured, h.availableSlots);
  app.get('/board', secured, h.board);
  // OVR-6 §6.2: static two-segment path, registered before '/:id' so the
  // management unaccepted past-start list can never be shadowed by the
  // one-segment job detail route.
  app.get('/pending-acceptance/past-start', secured, h.listUnacceptedPastStart);
  app.get<{ Params: { id: string } }>('/:id', secured, h.detail);
  app.get<{ Params: { id: string } }>('/:id/sale-create-context', secured, h.saleCreateContext);
  app.get<{ Params: { id: string } }>('/:id/sales', secured, h.relatedSales);
  app.post<{ Params: { id: string } }>('/:id/sales', secured, h.createSale);
  app.get<{ Params: { id: string } }>('/:id/sale-details', secured, h.saleDetails);
  app.patch<{ Params: { id: string } }>('/:id/sale-details', secured, h.patchSaleDetails);
  app.post<{ Params: { id: string } }>('/:id/sale-items', secured, h.addSaleItem);
  app.patch<{ Params: { id: string; itemId: string } }>('/:id/sale-items/:itemId', secured, h.patchSaleItem);
  app.delete<{ Params: { id: string; itemId: string } }>('/:id/sale-items/:itemId', secured, h.removeSaleItem);
  app.get<{ Params: { id: string } }>('/:id/follow-ups', secured, h.listFollowUps);
  app.post<{ Params: { id: string } }>('/:id/follow-ups', secured, h.createFollowUp);
  app.get<{ Params: { id: string } }>('/:id/follow-up-suggestion', secured, h.followUpSuggestion);
  app.patch<{ Params: { id: string } }>('/:id', secured, h.patch);
  app.get<{ Params: { id: string } }>('/:id/meeting-details', secured, h.meetingDetails);
  app.patch<{ Params: { id: string } }>('/:id/meeting-details', secured, h.patchMeetingDetails);
  app.get<{ Params: { id: string } }>('/:id/delivery-items', secured, h.listDeliveryItems);
  app.post<{ Params: { id: string } }>('/:id/delivery-items', secured, h.addDeliveryItem);
  app.patch<{ Params: { id: string; itemId: string } }>('/:id/delivery-items/:itemId', secured, h.patchDeliveryItem);
  app.delete<{ Params: { id: string; itemId: string } }>('/:id/delivery-items/:itemId', secured, h.removeDeliveryItem);
  app.post<{ Params: { id: string } }>('/:id/accept', secured, h.accept);
  // JOB-010 release 2b: Staff answers and the management recovery surface.
  app.post<{ Params: { id: string } }>('/:id/decline', secured, h.decline);
  app.post<{ Params: { id: string } }>('/:id/release', secured, h.release);
  app.post<{ Params: { id: string } }>(
    '/:id/assignment-offers/reoffer',
    secured,
    h.reofferAssignment,
  );
  // JOB-012: management confirms the time a declined/released answer proposed.
  app.post<{ Params: { id: string } }>(
    '/:id/assignment-offers/accept-proposal',
    secured,
    h.acceptAssignmentProposal,
  );
  // Static two-segment path: never collides with '/:id'.
  app.get('/assignment-offers/needs-action', secured, h.listAssignmentOffersNeedingAction);
  app.post<{ Params: { id: string } }>('/:id/start', secured, h.start);
  app.post<{ Params: { id: string } }>('/:id/submit-for-approval', secured, h.submit);
  app.post<{ Params: { id: string } }>('/:id/approve', secured, h.approve);
  app.post<{ Params: { id: string } }>('/:id/request-revision', secured, h.requestRevision);
  app.post<{ Params: { id: string } }>('/:id/withdraw-from-approval', secured, h.withdrawFromApproval);
  app.post<{ Params: { id: string } }>('/:id/resume', secured, h.resume);
  app.post<{ Params: { id: string } }>('/:id/cancel', secured, h.cancel);
  app.post<{ Params: { id: string } }>('/:id/invalidate', secured, h.invalidate);
  app.get<{ Params: { id: string } }>('/:id/activity', secured, h.activity);
  app.get<{ Params: { id: string } }>('/:id/overdue-incidents', secured, h.listOverdueIncidents);
  // OVR-4 operational closure (two-segment paths never collide with '/:id').
  app.get('/submission-late/open', secured, h.listOpenSubmissionLate);
  app.get<{ Params: { id: string } }>('/:id/submission-lateness', secured, h.submissionLateness);
  app.post<{ Params: { id: string } }>('/:id/submission-reminder', secured, h.sendSubmissionReminder);
  // JOB-010 §1a manager-only early-start authorization (release 1).
  app.post<{ Params: { id: string } }>(
    '/:id/early-start-authorization',
    secured,
    h.grantEarlyStartAuthorization,
  );
  // JOB-010 release 2a (D1): Staff change/termination request, the management
  // decision and its open list (two-segment static paths never collide with
  // '/:id').
  app.get('/change-requests/open', secured, h.listOpenChangeRequests);
  app.post<{ Params: { id: string } }>(
    '/:id/change-requests',
    secured,
    h.createChangeRequest,
  );
  app.post<{ Params: { id: string; requestId: string } }>(
    '/:id/change-requests/:requestId/resolve',
    secured,
    h.resolveChangeRequest,
  );
  app.get<{ Params: { id: string } }>('/:id/notes', secured, h.listNotes);
  app.post<{ Params: { id: string } }>('/:id/notes', secured, h.addNote);
};
