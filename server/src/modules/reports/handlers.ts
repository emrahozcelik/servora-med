import type { FastifyRequest } from 'fastify';

import {
  parseApprovalReportQuery,
  parseCustomerReportQuery,
  parseDashboardReportQuery,
  parseDeliveryReportQuery,
  parseSalesFollowUpReportQuery,
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
    getBusinessTrend: (request: FastifyRequest) => service.getBusinessTrend(
      request.currentUser!,
      { ...parseDashboardReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    dashboard: (request: FastifyRequest) => service.dashboard(
      request.currentUser!,
      { ...parseDashboardReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    getOwnStaffReport: (request: FastifyRequest) => service.getOwnStaffReport(
      request.currentUser!,
      { ...parseStaffReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    getStaffPerformance: (request: FastifyRequest) => service.getStaffPerformance(
      request.currentUser!,
      { ...parseStaffReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    getStaffReport: (request: FastifyRequest) => service.getStaffReport(
      request.currentUser!,
      staffUserId(request),
      { ...parseStaffReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    getDeliveries: (request: FastifyRequest) => service.getDeliveries(
      request.currentUser!,
      { ...parseDeliveryReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    getApprovals: (request: FastifyRequest) => service.getApprovals(
      request.currentUser!,
      { ...parseApprovalReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    getCustomers: (request: FastifyRequest) => service.getCustomers(
      request.currentUser!,
      { ...parseCustomerReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
    getSalesFollowUp: (request: FastifyRequest) => service.getSalesFollowUp(
      request.currentUser!,
      { ...parseSalesFollowUpReportQuery(request.query), includeSaleCapability: (request.query as Record<string, unknown>).includeSaleCapability === 'true' },
    ),
  };
}
