import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import { JOB_CARD_TYPES } from '../job-cards/types.js';
import type {
  OffboardingCustomerAction,
  OffboardingDecisionInput,
  OffboardingReminderAction,
  PostgresStaffOffboardingService,
  StaffOffboardingReasonCode,
} from './offboarding.js';
import type { PeopleService } from './service.js';
import type { CreateUserInput, StaffProfileInput, StaffStatusFilter } from './types.js';

function bodyOf(request: FastifyRequest) {
  if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Geçerli bir istek gövdesi gönderin.');
  }
  return request.body as Record<string, unknown>;
}

function exactFields(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new AppError('VALIDATION_ERROR', 400, `Bilinmeyen alan: ${unknown[0]}.`);
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) throw new AppError('VALIDATION_ERROR', 400, `${field} alanı zorunludur.`);
  return value;
}

function nullableString(value: unknown, field: string) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', 400, `${field} metin veya null olmalıdır.`);
  return value;
}

function optionalNullableString(value: unknown, field: string) {
  return value === undefined ? null : nullableString(value, field);
}

function expectedVersion(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new AppError('VALIDATION_ERROR', 400, 'expectedVersion pozitif bir tam sayı olmalıdır.');
  }
  return value as number;
}

function stringArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new AppError('VALIDATION_ERROR', 400, `${field} dizi olmalıdır.`);
  return value;
}

function decisionObject(value: unknown, field: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', 400, `${field} nesne olmalıdır.`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, field: string) {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function offboardingDecisions(body: Record<string, unknown>): OffboardingDecisionInput {
  exactFields(body, [
    'clientActionId', 'planHash', 'reasonCode', 'jobDecisions', 'calendarDecisions',
    'followUpDecisions', 'customerDecisions', 'reminderDecisions',
  ]);

  const parseSimple = <T extends 'jobCardId' | 'calendarEventId'>(
    value: unknown,
    field: string,
    idField: T,
  ): Array<{ [K in T]: string } & { replacementUserId: string }> => stringArray(value, field).map((raw, index) => {
    const item = decisionObject(raw, `${field}[${index}]`);
    exactFields(item, [idField, 'replacementUserId']);
    return {
      [idField]: requiredString(item[idField], `${field}[${index}].${idField}`),
      replacementUserId: requiredString(item.replacementUserId, `${field}[${index}].replacementUserId`),
    } as { [K in T]: string } & { replacementUserId: string };
  });

  const parseCustomers = stringArray(body.customerDecisions, 'customerDecisions').map((raw, index) => {
    const item = decisionObject(raw, `customerDecisions[${index}]`);
    exactFields(item, ['customerId', 'action', 'replacementUserId']);
    if (item.action !== 'REASSIGN' && item.action !== 'UNASSIGN') {
      throw new AppError('VALIDATION_ERROR', 400, `customerDecisions[${index}].action geçersizdir.`);
    }
    return {
      customerId: requiredString(item.customerId, `customerDecisions[${index}].customerId`),
      action: item.action as OffboardingCustomerAction,
      replacementUserId: optionalString(item.replacementUserId, `customerDecisions[${index}].replacementUserId`),
    };
  });

  const parseReminders = stringArray(body.reminderDecisions, 'reminderDecisions').map((raw, index) => {
    const item = decisionObject(raw, `reminderDecisions[${index}]`);
    exactFields(item, ['reminderId', 'action', 'replacementUserId']);
    if (item.action !== 'TRANSFER' && item.action !== 'CANCEL') {
      throw new AppError('VALIDATION_ERROR', 400, `reminderDecisions[${index}].action geçersizdir.`);
    }
    return {
      reminderId: requiredString(item.reminderId, `reminderDecisions[${index}].reminderId`),
      action: item.action as OffboardingReminderAction,
      replacementUserId: optionalString(item.replacementUserId, `reminderDecisions[${index}].replacementUserId`),
    };
  });

  if (typeof body.reasonCode !== 'string') {
    throw new AppError('VALIDATION_ERROR', 400, 'reasonCode alanı zorunludur.');
  }
  return {
    clientActionId: requiredString(body.clientActionId, 'clientActionId'),
    planHash: requiredString(body.planHash, 'planHash'),
    reasonCode: body.reasonCode as StaffOffboardingReasonCode,
    jobDecisions: parseSimple(body.jobDecisions, 'jobDecisions', 'jobCardId'),
    calendarDecisions: parseSimple(body.calendarDecisions, 'calendarDecisions', 'calendarEventId'),
    followUpDecisions: parseSimple(body.followUpDecisions, 'followUpDecisions', 'jobCardId'),
    customerDecisions: parseCustomers,
    reminderDecisions: parseReminders,
  };
}

function userId(request: FastifyRequest) {
  return requiredString((request.params as { userId?: unknown }).userId, 'userId');
}

function historyQuery(request: FastifyRequest) {
  const value = request.query;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'Geçerli sorgu parametreleri gönderin.');
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !['status', 'type', 'limit', 'offset'].includes(key));
  if (unknown) throw new AppError('VALIDATION_ERROR', 400, `Bilinmeyen alan: ${unknown}.`);
  const status = record.status === undefined ? 'all' : record.status;
  if (typeof status !== 'string' || !['open', 'completed', 'all'].includes(status)) {
    throw new AppError('VALIDATION_ERROR', 400, 'status geçersizdir.');
  }
  const type = record.type === undefined ? undefined : record.type;
  if (type !== undefined && (typeof type !== 'string' || !JOB_CARD_TYPES.includes(type as never))) {
    throw new AppError('VALIDATION_ERROR', 400, 'type geçersizdir.');
  }
  const integer = (raw: unknown, field: string, fallback: number, max?: number) => {
    if (raw === undefined) return fallback;
    if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
      throw new AppError('VALIDATION_ERROR', 400, `${field} geçersizdir.`);
    }
    const parsed = Number(raw);
    if (parsed < 0 || (max !== undefined && parsed > max)) {
      throw new AppError('VALIDATION_ERROR', 400, `${field} geçersizdir.`);
    }
    return parsed;
  };
  const limit = integer(record.limit, 'limit', 20, 100);
  if (limit === 0) throw new AppError('VALIDATION_ERROR', 400, 'limit geçersizdir.');
  return {
    status: status as 'open' | 'completed' | 'all',
    type: type as never,
    limit,
    offset: integer(record.offset, 'offset', 0),
  };
}

function staffProfile(value: unknown): StaffProfileInput | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('VALIDATION_ERROR', 400, 'staffProfile nesne olmalıdır.');
  }
  const input = value as Record<string, unknown>;
  exactFields(input, ['title', 'phone', 'region', 'managerUserId']);
  return {
    title: optionalNullableString(input.title, 'title'),
    phone: optionalNullableString(input.phone, 'phone'),
    region: optionalNullableString(input.region, 'region'),
    managerUserId: optionalNullableString(input.managerUserId, 'managerUserId'),
  };
}

export function createPeopleHandlers(service: PeopleService, offboardingService?: PostgresStaffOffboardingService) {
  return {
    listOwnStaffJobHistory: (request: FastifyRequest) => service.listOwnStaffJobHistory(
      request.currentUser!, historyQuery(request),
    ),
    listStaffJobHistory: (request: FastifyRequest) => service.listStaffJobHistory(
      request.currentUser!, userId(request), historyQuery(request),
    ),
    listUsers: (request: FastifyRequest) => service.listUsers(request.currentUser!),
    getUser: (request: FastifyRequest) => service.getUser(request.currentUser!, userId(request)),
    createUser: async (request: FastifyRequest, reply: FastifyReply) => {
      const body = bodyOf(request);
      exactFields(body, ['name', 'email', 'role', 'temporaryPassword', 'staffProfile']);
      if (!['ADMIN', 'MANAGER', 'STAFF'].includes(String(body.role))) {
        throw new AppError('VALIDATION_ERROR', 400, 'role geçersizdir.');
      }
      const input: CreateUserInput = {
        name: requiredString(body.name, 'name'), email: requiredString(body.email, 'email'),
        role: body.role as CreateUserInput['role'], temporaryPassword: requiredString(body.temporaryPassword, 'temporaryPassword'),
        staffProfile: staffProfile(body.staffProfile),
      };
      return reply.code(201).send(await service.createUser(request.currentUser!, input));
    },
    updateUser: (request: FastifyRequest) => {
      const body = bodyOf(request); exactFields(body, ['expectedVersion', 'name']);
      return service.updateUser(request.currentUser!, userId(request), {
        expectedVersion: expectedVersion(body.expectedVersion), name: requiredString(body.name, 'name'),
      });
    },
    changeRole: (request: FastifyRequest) => {
      const body = bodyOf(request); exactFields(body, ['expectedVersion', 'role']);
      if (body.role !== 'ADMIN' && body.role !== 'MANAGER') throw new AppError('VALIDATION_ERROR', 400, 'role ADMIN veya MANAGER olmalıdır.');
      return service.changeRole(request.currentUser!, userId(request), { expectedVersion: expectedVersion(body.expectedVersion), role: body.role });
    },
    activate: (request: FastifyRequest) => {
      const body = bodyOf(request); exactFields(body, ['expectedVersion']);
      return service.activate(request.currentUser!, userId(request), expectedVersion(body.expectedVersion));
    },
    deactivate: (request: FastifyRequest) => {
      const body = bodyOf(request); exactFields(body, ['expectedVersion']);
      return service.deactivate(request.currentUser!, userId(request), expectedVersion(body.expectedVersion));
    },
    resetPassword: (request: FastifyRequest) => {
      const body = bodyOf(request); exactFields(body, ['expectedVersion', 'temporaryPassword']);
      return service.resetPassword(request.currentUser!, userId(request), {
        expectedVersion: expectedVersion(body.expectedVersion),
        temporaryPassword: requiredString(body.temporaryPassword, 'temporaryPassword'),
      });
    },
    offboardingPreview: (request: FastifyRequest) => {
      if (!offboardingService) throw new AppError('OFFBOARDING_UNAVAILABLE', 404, 'Offboarding akışı kullanılamıyor.');
      const body = bodyOf(request);
      exactFields(body, []);
      return offboardingService.preview(request.currentUser!, userId(request));
    },
    offboardingExecute: (request: FastifyRequest) => {
      if (!offboardingService) throw new AppError('OFFBOARDING_UNAVAILABLE', 404, 'Offboarding akışı kullanılamıyor.');
      return offboardingService.execute(request.currentUser!, userId(request), offboardingDecisions(bodyOf(request)));
    },
    listStaff: (request: FastifyRequest) => {
      const value = (request.query as { status?: unknown }).status ?? 'active';
      if (!['active', 'inactive', 'all'].includes(String(value))) throw new AppError('VALIDATION_ERROR', 400, 'status geçersizdir.');
      return service.listStaff(request.currentUser!, value as StaffStatusFilter);
    },
    getOwnStaffProfile: (request: FastifyRequest) => service.getOwnStaffProfile(request.currentUser!),
    getStaffProfile: (request: FastifyRequest) => service.getStaffProfile(request.currentUser!, userId(request)),
    updateStaffProfile: (request: FastifyRequest) => {
      const body = bodyOf(request); exactFields(body, ['expectedVersion', 'title', 'phone', 'region', 'managerUserId']);
      return service.updateStaffProfile(request.currentUser!, userId(request), {
        expectedVersion: expectedVersion(body.expectedVersion),
        title: optionalNullableString(body.title, 'title'), phone: optionalNullableString(body.phone, 'phone'),
        region: optionalNullableString(body.region, 'region'), managerUserId: optionalNullableString(body.managerUserId, 'managerUserId'),
      });
    },
  };
}
