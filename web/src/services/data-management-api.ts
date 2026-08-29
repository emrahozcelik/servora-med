import { ApiError, number, object, request } from './api';

export type DataManagementCount = {
  total: number;
  active: number;
  inactive: number;
};

export type CustomerDataManagementCount = DataManagementCount & {
  prospect: number;
};

export type DemoDatasetDataManagementCount = {
  total: number;
  active: number;
  purged: number;
};

export type DataManagementSummary = {
  customers: CustomerDataManagementCount;
  contacts: DataManagementCount;
  products: DataManagementCount;
  staff: DataManagementCount;
  demoDataset: DemoDatasetDataManagementCount;
};

function count(value: unknown, field: string) {
  const parsed = number(value, field);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  }
  return parsed;
}

function parseCount(value: unknown, field: string): DataManagementCount {
  const source = object(value);
  return {
    total: count(source.total, `${field}.total`),
    active: count(source.active, `${field}.active`),
    inactive: count(source.inactive, `${field}.inactive`),
  };
}

export function parseDataManagementSummary(input: unknown): DataManagementSummary {
  const value = object(input);
  const customers = object(value.customers);
  const demoDataset = object(value.demoDataset);
  return {
    customers: {
      ...parseCount(customers, 'customers'),
      prospect: count(customers.prospect, 'customers.prospect'),
    },
    contacts: parseCount(value.contacts, 'contacts'),
    products: parseCount(value.products, 'products'),
    staff: parseCount(value.staff, 'staff'),
    demoDataset: {
      total: count(demoDataset.total, 'demoDataset.total'),
      active: count(demoDataset.active, 'demoDataset.active'),
      purged: count(demoDataset.purged, 'demoDataset.purged'),
    },
  };
}

export async function getDataManagementSummary(): Promise<DataManagementSummary> {
  return parseDataManagementSummary(await request('/api/admin/data-management/summary'));
}
