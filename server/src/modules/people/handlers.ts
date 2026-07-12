import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
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

function userId(request: FastifyRequest) {
  return requiredString((request.params as { userId?: unknown }).userId, 'userId');
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

export function createPeopleHandlers(service: PeopleService) {
  return {
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
