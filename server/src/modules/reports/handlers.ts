import type { FastifyRequest } from 'fastify';

import {
  parseApprovalReportQuery,
  parseDashboardReportQuery,
  parseDeliveryReportQuery,
  parseStaffReportPathId,
  parseStaffReportQuery,
} from './query.js';
import type { ReportsService } from './service.js';

function staffUserId(request: FastifyRequest) {
  return parseStaffReportPathId(
    (request.params as { userId?: unknown }).userId,
  );
}

export function createReportsHandlers(service: ReportsService) {
  return {
    dashboard: (request: FastifyRequest) => service.dashboard(
      request.currentUser!,
      parseDashboardReportQuery(request.query),
    ),
    getOwnStaffReport: (request: FastifyRequest) => service.getOwnStaffReport(
      request.currentUser!,
      parseStaffReportQuery(request.query),
    ),
    getStaffReport: (request: FastifyRequest) => service.getStaffReport(
      request.currentUser!,
      staffUserId(request),
      parseStaffReportQuery(request.query),
    ),
    getDeliveries: (request: FastifyRequest) => service.getDeliveries(
      request.currentUser!,
      parseDeliveryReportQuery(request.query),
    ),
    getApprovals: (request: FastifyRequest) => service.getApprovals(
      request.currentUser!,
      parseApprovalReportQuery(request.query),
    ),
  };
}
