import type { FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../errors/index.js';
import type { CreateProductInput, ProductService, UpdateProductInput } from './service.js';
import type { ProductActor } from './types.js';

const CREATE_FIELDS = ['name', 'sku', 'brand', 'category', 'model', 'unit', 'referencePrice'] as const;
const PATCH_FIELDS = ['expectedVersion', ...CREATE_FIELDS] as const;
const LIST_FIELDS = ['q', 'status', 'limit', 'offset'] as const;
const OPTIONAL_TEXT_FIELDS = ['sku', 'brand', 'category', 'model', 'unit'] as const;

function validation(message: string): never {
  throw new AppError('VALIDATION_ERROR', 400, message);
}

function fieldValidation(field: string, message: string): never {
  throw new AppError('VALIDATION_ERROR', 400, message, { fieldErrors: { [field]: message } });
}

function actor(request: FastifyRequest): ProductActor {
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
  if (typeof value !== 'string' || !value.trim()) {
    fieldValidation(field, field === 'name' ? 'Ürün adı zorunludur.' : `${field} alanı zorunludur.`);
  }
  return value as string;
}

function nullableString(value: unknown, field: string) {
  if (value !== null && typeof value !== 'string') {
    fieldValidation(field, `${field} metin veya null olmalıdır.`);
  }
  return value as string | null;
}

function expectedVersion(value: unknown) {
  if (!Number.isInteger(value) || (value as number) < 1) {
    validation('expectedVersion pozitif bir tam sayı olmalıdır.');
  }
  return value as number;
}

function productId(request: FastifyRequest) {
  const value = (request.params as { productId?: unknown }).productId;
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AppError('PRODUCT_NOT_FOUND', 404, 'Ürün bulunamadı.');
  }
  return value;
}

function query(request: FastifyRequest) {
  const value = record(request.query, 'Geçerli sorgu parametreleri gönderin.');
  exact(value, LIST_FIELDS);
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
  if (!Number.isSafeInteger(parsed) || parsed < minimum
    || (maximum !== undefined && parsed > maximum)) validation(`${field} geçersizdir.`);
  return parsed;
}

function supplied(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function referencePrice(value: unknown) {
  if (value !== null && typeof value !== 'number') {
    fieldValidation('referencePrice', 'referencePrice sayı veya null olmalıdır.');
  }
  return value as number | null;
}

function optionalFields(value: Record<string, unknown>) {
  const input: Partial<CreateProductInput> = {};
  for (const field of OPTIONAL_TEXT_FIELDS) {
    if (supplied(value, field)) input[field] = nullableString(value[field], field);
  }
  if (supplied(value, 'referencePrice')) input.referencePrice = referencePrice(value.referencePrice);
  return input;
}

function createInput(value: Record<string, unknown>): CreateProductInput {
  return { name: requiredString(value.name, 'name'), ...optionalFields(value) };
}

function patchInput(value: Record<string, unknown>): UpdateProductInput {
  if (!CREATE_FIELDS.some((field) => supplied(value, field))) {
    validation('En az bir ürün alanı gönderilmelidir.');
  }
  return {
    expectedVersion: expectedVersion(value.expectedVersion),
    ...(supplied(value, 'name') ? { name: requiredString(value.name, 'name') } : {}),
    ...optionalFields(value),
  };
}

export function createProductHandlers(service: ProductService) {
  return {
    listProducts: (request: FastifyRequest) => {
      const value = query(request);
      const status = optionalQueryString(value.status, 'status') ?? 'active';
      if (!['active', 'inactive', 'all'].includes(status)) validation('status geçersizdir.');
      return service.listProducts(actor(request), {
        q: optionalQueryString(value.q, 'q'),
        status: status as 'active' | 'inactive' | 'all',
        limit: integerQuery(value.limit, 'limit', 50, 1, 200),
        offset: integerQuery(value.offset, 'offset', 0, 0),
      });
    },
    createProduct: async (request: FastifyRequest, reply: FastifyReply) =>
      reply.code(201).send(await service.createProduct(
        actor(request),
        createInput(body(request, CREATE_FIELDS)),
      )),
    getProduct: (request: FastifyRequest) =>
      service.getProduct(actor(request), productId(request)),
    updateProduct: (request: FastifyRequest) =>
      service.updateProduct(
        actor(request),
        productId(request),
        patchInput(body(request, PATCH_FIELDS)),
      ),
    activateProduct: (request: FastifyRequest) => {
      const value = body(request, ['expectedVersion']);
      return service.activateProduct(
        actor(request), productId(request), expectedVersion(value.expectedVersion),
      );
    },
    deactivateProduct: (request: FastifyRequest) => {
      const value = body(request, ['expectedVersion']);
      return service.deactivateProduct(
        actor(request), productId(request), expectedVersion(value.expectedVersion),
      );
    },
    deleteProduct: async (request: FastifyRequest, reply: FastifyReply) => {
      await service.deleteProduct(actor(request), productId(request));
      return reply.code(204).send();
    },
  };
}
