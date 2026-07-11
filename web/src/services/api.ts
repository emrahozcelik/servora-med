export type UserRole = 'ADMIN' | 'MANAGER' | 'STAFF';
export type CurrentUser = { id: string; organizationId: string; name: string; email: string; role: UserRole; mustChangePassword: boolean };
export type JobCardStatus = 'NEW' | 'PLANNED' | 'IN_PROGRESS' | 'WAITING_APPROVAL' | 'REVISION_REQUESTED' | 'COMPLETED' | 'CANCELLED';
export type DeliveryPurpose = 'SALE' | 'SAMPLE' | 'CONSIGNMENT' | 'RETURN' | 'OTHER';
export type JobCard = { id: string; organizationId: string; type: 'PRODUCT_DELIVERY'; status: JobCardStatus; version: number; title: string; description: string | null; customerId: string | null; assignedTo: string; createdBy: string; priority: 'low' | 'normal' | 'high' | 'urgent'; dueDate: string | null };
export type DeliveryItem = { id: string; organizationId: string; jobCardId: string; productId: string; deliveryPurpose: DeliveryPurpose; deliveredAt: string; quantity: number; unit: string; productNameSnapshot: string; productSkuSnapshot: string | null; productModelSnapshot: string | null; lotNo: string | null; serialNo: string | null; expiryDate: string | null; deliveryNote: string | null };
export type Activity = { id: string; jobCardId: string; actorId: string | null; eventType: string; oldValue: unknown; newValue: unknown; metadata: unknown; clientActionId: string | null; createdAt: string };
export type ReferenceCustomer = { id: string; name: string; customerType: string; status: string };
export type ReferenceProduct = { id: string; name: string; sku: string; model: string | null; unit: string };

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly retryable = false) {
    super(message); this.name = 'ApiError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz yanıt alındı.');
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string) {
  if (typeof value !== 'string' || !value) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return value;
}
function nullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return string(value, field);
}
function number(value: unknown, field: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ApiError(0, 'INVALID_RESPONSE', `Yanıtta ${field} alanı geçersiz.`);
  return value;
}
function items(value: unknown) {
  const list = object(value).items;
  if (!Array.isArray(list)) throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz liste yanıtı alındı.');
  return list;
}

function parseJobCard(value: unknown): JobCard {
  const v = object(value);
  return { id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'),
    type: string(v.type, 'type') as JobCard['type'], status: string(v.status, 'status') as JobCardStatus,
    version: number(v.version, 'version'), title: string(v.title, 'title'), description: nullableString(v.description, 'description'),
    customerId: nullableString(v.customerId, 'customerId'), assignedTo: string(v.assignedTo, 'assignedTo'),
    createdBy: string(v.createdBy, 'createdBy'), priority: string(v.priority, 'priority') as JobCard['priority'], dueDate: nullableString(v.dueDate, 'dueDate') };
}
function parseDelivery(value: unknown): DeliveryItem {
  const v = object(value);
  return { id: string(v.id, 'id'), organizationId: string(v.organizationId, 'organizationId'), jobCardId: string(v.jobCardId, 'jobCardId'),
    productId: string(v.productId, 'productId'), deliveryPurpose: string(v.deliveryPurpose, 'deliveryPurpose') as DeliveryPurpose,
    deliveredAt: string(v.deliveredAt, 'deliveredAt'), quantity: number(v.quantity, 'quantity'), unit: string(v.unit, 'unit'),
    productNameSnapshot: string(v.productNameSnapshot, 'productNameSnapshot'), productSkuSnapshot: nullableString(v.productSkuSnapshot, 'productSkuSnapshot'),
    productModelSnapshot: nullableString(v.productModelSnapshot, 'productModelSnapshot'), lotNo: nullableString(v.lotNo, 'lotNo'),
    serialNo: nullableString(v.serialNo, 'serialNo'), expiryDate: nullableString(v.expiryDate, 'expiryDate'), deliveryNote: nullableString(v.deliveryNote, 'deliveryNote') };
}

async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try { response = await fetch(path, { ...init, credentials: 'include' }); }
  catch { throw new ApiError(0, 'NETWORK_ERROR', 'Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.', true); }
  if (!response.ok) {
    let error = 'İşlem tamamlanamadı. Lütfen tekrar deneyin.'; let code = 'REQUEST_FAILED';
    try { const body = object(await response.json()); if (typeof body.error === 'string') error = body.error; if (typeof body.code === 'string') code = body.code; } catch { /* use safe fallback */ }
    throw new ApiError(response.status, code, error, response.status >= 500);
  }
  if (response.status === 204) return null;
  try { return await response.json() as unknown; }
  catch { throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz yanıt alındı.'); }
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export async function login(credentials: { email: string; password: string }) {
  const body = object(await request('/api/auth/login', json('POST', credentials)));
  return body.user as CurrentUser;
}
export async function getCurrentUser(): Promise<CurrentUser | null> {
  try { return object(await request('/api/auth/me')).user as CurrentUser; }
  catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}
export async function logout() { await request('/api/auth/logout', { method: 'POST' }); }

export async function listReferenceCustomers() {
  return items(await request('/api/reference/customers')).map((entry) => { const v = object(entry); return { id: string(v.id, 'id'), name: string(v.name, 'name'), customerType: string(v.customerType, 'customerType'), status: string(v.status, 'status') }; });
}
export async function listReferenceProducts() {
  return items(await request('/api/reference/products')).map((entry) => { const v = object(entry); return { id: string(v.id, 'id'), name: string(v.name, 'name'), sku: string(v.sku, 'sku'), model: nullableString(v.model, 'model'), unit: string(v.unit, 'unit') }; });
}

export async function createJobCard(input: { clientActionId: string; type: 'PRODUCT_DELIVERY'; title: string; customerId: string; assignedTo: string; description?: string; priority?: JobCard['priority']; dueDate?: string }) { return parseJobCard(await request('/api/job-cards', json('POST', input))); }
export async function listJobCards() { return items(await request('/api/job-cards')).map(parseJobCard); }
export async function getJobCard(id: string) { return parseJobCard(await request(`/api/job-cards/${id}`)); }
export async function patchJobCard(id: string, input: { expectedVersion: number; title?: string; priority?: JobCard['priority']; dueDate?: string | null }) { return parseJobCard(await request(`/api/job-cards/${id}`, json('PATCH', input))); }

type DeliveryInput = { expectedVersion: number; productId: string; deliveryPurpose: DeliveryPurpose; deliveredAt: string; quantity: number; lotNo?: string | null; serialNo?: string | null; expiryDate?: string | null; deliveryNote?: string | null };
function parseDeliveryMutation(value: unknown) { const v = object(value); return { item: parseDelivery(v.item), jobCardVersion: number(v.jobCardVersion, 'jobCardVersion') }; }
export async function addDeliveryItem(jobId: string, input: DeliveryInput & { clientActionId: string }) { return parseDeliveryMutation(await request(`/api/job-cards/${jobId}/delivery-items`, json('POST', input))); }
export async function patchDeliveryItem(jobId: string, itemId: string, input: { expectedVersion: number } & Partial<Omit<DeliveryInput, 'expectedVersion'>>) { return parseDeliveryMutation(await request(`/api/job-cards/${jobId}/delivery-items/${itemId}`, json('PATCH', input))); }
export async function removeDeliveryItem(jobId: string, itemId: string, expectedVersion: number) { const v = object(await request(`/api/job-cards/${jobId}/delivery-items/${itemId}`, json('DELETE', { expectedVersion }))); return { id: string(v.id, 'id'), jobCardVersion: number(v.jobCardVersion, 'jobCardVersion') }; }

type LifecycleInput = { clientActionId: string; expectedVersion: number; note?: string };
const lifecycle = async (id: string, command: string, input: object) => parseJobCard(await request(`/api/job-cards/${id}/${command}`, json('POST', input)));
export const startJobCard = (id: string, input: LifecycleInput) => lifecycle(id, 'start', input);
export const submitJobCardForApproval = (id: string, input: LifecycleInput) => lifecycle(id, 'submit-for-approval', input);
export const approveJobCard = (id: string, input: LifecycleInput) => lifecycle(id, 'approve', input);
export const requestJobCardRevision = (id: string, input: LifecycleInput & { revisionReason: string }) => lifecycle(id, 'request-revision', input);

export async function listActivity(jobId: string): Promise<Activity[]> {
  return items(await request(`/api/job-cards/${jobId}/activity`)).map((entry) => { const v = object(entry); return {
    id: string(v.id, 'id'), jobCardId: string(v.jobCardId, 'jobCardId'), actorId: nullableString(v.actorId, 'actorId'),
    eventType: string(v.eventType, 'eventType'), oldValue: v.oldValue, newValue: v.newValue, metadata: v.metadata,
    clientActionId: nullableString(v.clientActionId, 'clientActionId'), createdAt: string(v.createdAt, 'createdAt') }; });
}
