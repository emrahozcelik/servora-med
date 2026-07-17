import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { CrmService } from './service.js';
import { CUSTOMER_STATUSES, CUSTOMER_TYPES, type CrmActor } from './types.js';

const CUSTOMER_CREATE_FIELDS = ['name', 'customerType', 'status', 'taxNumber', 'phone', 'email',
  'city', 'district', 'address', 'assignedStaffUserId'] as const;
const CUSTOMER_PATCH_FIELDS = ['expectedVersion', 'name', 'customerType', 'taxNumber', 'phone',
  'email', 'city', 'district', 'address', 'assignedStaffUserId'] as const;
const CONTACT_CREATE_FIELDS = ['name', 'title', 'phone', 'email'] as const;
const CONTACT_PATCH_FIELDS = ['expectedVersion', 'name', 'title', 'phone', 'email'] as const;

function validation(message: string): never {
  throw new AppError('VALIDATION_ERROR', 400, message);
}

function actor(request: FastifyRequest): CrmActor {
  const user = request.currentUser!;
  return { id: user.id, organizationId: user.organizationId, role: user.role };
}

function record(value: unknown, message: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) validation(message);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) validation(`Bilinmeyen alan: ${unknown}.`);
}

function body(request: FastifyRequest, allowed: readonly string[]) {
  const value = record(request.body, 'Geçerli bir istek gövdesi gönderin.');
  exact(value, allowed);
  return value;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || !value.trim()) validation(`${field} alanı zorunludur.`);
  return value as string;
}

function nullableString(value: unknown, field: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') validation(`${field} metin veya null olmalıdır.`);
  return value as string;
}

function nullableNonEmptyString(value: unknown, field: string) {
  const result = nullableString(value, field);
  if (result !== null && !result.trim()) validation(`${field} boş olamaz.`);
  return result;
}

function version(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 1) {
    validation('expectedVersion pozitif bir tam sayı olmalıdır.');
  }
  return value as number;
}

function params(request: FastifyRequest) {
  const value = request.params as { customerId?: unknown; contactId?: unknown };
  return {
    customerId: requiredString(value.customerId, 'customerId'),
    contactId: value.contactId === undefined ? null : requiredString(value.contactId, 'contactId'),
  };
}

function query(request: FastifyRequest, allowed: readonly string[]) {
  const value = record(request.query, 'Geçerli sorgu parametreleri gönderin.');
  exact(value, allowed);
  return value;
}

function optionalQueryString(value: unknown, field: string) {
  if (value === undefined) return null;
  if (typeof value !== 'string') validation(`${field} tek bir metin değeri olmalıdır.`);
  return value as string;
}

function integerQuery(value: unknown, field: string, fallback: number, minimum: number, maximum?: number) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) validation(`${field} geçersizdir.`);
  const parsed = Number(value);
  if (parsed < minimum || (maximum !== undefined && parsed > maximum)) validation(`${field} geçersizdir.`);
  return parsed;
}

function customerInput(value: Record<string, unknown>) {
  if (!CUSTOMER_TYPES.includes(value.customerType as never)) validation('customerType geçersizdir.');
  if (value.status !== undefined && !CUSTOMER_STATUSES.includes(value.status as never)) validation('status geçersizdir.');
  return {
    name: requiredString(value.name, 'name'),
    customerType: value.customerType as (typeof CUSTOMER_TYPES)[number],
    ...(value.status === undefined ? {} : { status: value.status as (typeof CUSTOMER_STATUSES)[number] }),
    taxNumber: nullableString(value.taxNumber, 'taxNumber'), phone: nullableString(value.phone, 'phone'),
    email: nullableString(value.email, 'email'), city: nullableString(value.city, 'city'),
    district: nullableString(value.district, 'district'), address: nullableString(value.address, 'address'),
    assignedStaffUserId: nullableNonEmptyString(value.assignedStaffUserId, 'assignedStaffUserId'),
  };
}

function contactInput(value: Record<string, unknown>) {
  return { name: requiredString(value.name, 'name'), title: nullableString(value.title, 'title'),
    phone: nullableString(value.phone, 'phone'), email: nullableString(value.email, 'email') };
}

export function createCrmHandlers(service: CrmService) {
  return {
    listCustomers: (request: FastifyRequest) => {
      const value = query(request, ['q', 'status', 'customerType', 'assignedStaffUserId', 'city',
        'unassigned', 'limit', 'offset']);
      const status = optionalQueryString(value.status, 'status');
      const customerType = optionalQueryString(value.customerType, 'customerType');
      if (status !== null && !CUSTOMER_STATUSES.includes(status as never)) validation('status geçersizdir.');
      if (customerType !== null && !CUSTOMER_TYPES.includes(customerType as never)) validation('customerType geçersizdir.');
      if (value.unassigned !== undefined && value.unassigned !== 'true' && value.unassigned !== 'false') validation('unassigned geçersizdir.');
      return service.listCustomers(actor(request), {
        q: optionalQueryString(value.q, 'q'), status: status as never,
        customerType: customerType as never,
        assignedStaffUserId: optionalQueryString(value.assignedStaffUserId, 'assignedStaffUserId'),
        city: optionalQueryString(value.city, 'city'), unassigned: value.unassigned === 'true',
        limit: integerQuery(value.limit, 'limit', 50, 1, 200),
        offset: integerQuery(value.offset, 'offset', 0, 0),
      });
    },
    createCustomer: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(await service.createCustomer(actor(request),
        customerInput(body(request, CUSTOMER_CREATE_FIELDS)))),
    getCustomer: (request: FastifyRequest) => service.getCustomer(actor(request), params(request).customerId),
    updateCustomer: (request: FastifyRequest) => {
      const value = body(request, CUSTOMER_PATCH_FIELDS);
      return service.updateCustomer(actor(request), params(request).customerId,
        { ...customerInput(value), expectedVersion: version(value.expectedVersion) });
    },
    activateCustomer: (request: FastifyRequest) => {
      const value = body(request, ['expectedVersion']);
      return service.activateCustomer(actor(request), params(request).customerId, version(value.expectedVersion));
    },
    deactivateCustomer: (request: FastifyRequest) => {
      const value = body(request, ['expectedVersion']);
      return service.deactivateCustomer(actor(request), params(request).customerId, version(value.expectedVersion));
    },
    deleteCustomer: async (request: FastifyRequest, reply: FastifyReply) => {
      const value = body(request, ['expectedVersion']);
      await service.deleteCustomer(
        actor(request),
        params(request).customerId,
        version(value.expectedVersion),
      );
      return reply.code(204).send();
    },
    listContacts: (request: FastifyRequest) => {
      const value = query(request, ['q', 'status', 'limit', 'offset']);
      const status = optionalQueryString(value.status, 'status') ?? 'active';
      if (!['active', 'inactive', 'all'].includes(status)) validation('status geçersizdir.');
      return service.listContacts(actor(request), params(request).customerId, {
        q: optionalQueryString(value.q, 'q'), status: status as 'active' | 'inactive' | 'all',
        limit: integerQuery(value.limit, 'limit', 50, 1, 200),
        offset: integerQuery(value.offset, 'offset', 0, 0),
      });
    },
    createContact: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(await service.createContact(actor(request), params(request).customerId,
        contactInput(body(request, CONTACT_CREATE_FIELDS)))),
    getContact: (request: FastifyRequest) => {
      const value = params(request);
      return service.getContact(actor(request), value.customerId, value.contactId!);
    },
    updateContact: (request: FastifyRequest) => {
      const ids = params(request); const value = body(request, CONTACT_PATCH_FIELDS);
      return service.updateContact(actor(request), ids.customerId, ids.contactId!,
        { ...contactInput(value), expectedVersion: version(value.expectedVersion) });
    },
    activateContact: (request: FastifyRequest) => {
      const ids = params(request); const value = body(request, ['expectedVersion']);
      return service.activateContact(actor(request), ids.customerId, ids.contactId!, version(value.expectedVersion));
    },
    deactivateContact: (request: FastifyRequest) => {
      const ids = params(request); const value = body(request, ['expectedVersion']);
      return service.deactivateContact(actor(request), ids.customerId, ids.contactId!, version(value.expectedVersion));
    },
    makePrimary: (request: FastifyRequest) => {
      const ids = params(request); const value = body(request, ['expectedVersion']);
      return service.makePrimary(actor(request), ids.customerId, ids.contactId!, version(value.expectedVersion));
    },
  };
}
