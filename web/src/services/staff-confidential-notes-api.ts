import { ApiError, json, number, object, request, string } from './api';
import type { Paginated } from './crm-api';

export type StaffConfidentialNote = {
  id: string;
  organizationId: string;
  staffUserId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type StaffConfidentialNotePage = Paginated<StaffConfidentialNote>;

function parseNote(value: unknown): StaffConfidentialNote {
  const v = object(value);
  return {
    id: string(v.id, 'id'),
    organizationId: string(v.organizationId, 'organizationId'),
    staffUserId: string(v.staffUserId, 'staffUserId'),
    authorUserId: string(v.authorUserId, 'authorUserId'),
    authorName: string(v.authorName, 'authorName'),
    body: string(v.body, 'body'),
    createdAt: string(v.createdAt, 'createdAt'),
  };
}

function parsePage(value: unknown): StaffConfidentialNotePage {
  const raw = object(value);
  if (!Array.isArray(raw.items)) {
    throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz gizli not listesi alındı.');
  }
  return {
    items: raw.items.map(parseNote),
    total: number(raw.total, 'total'),
    limit: number(raw.limit, 'limit'),
    offset: number(raw.offset, 'offset'),
  };
}

export async function listStaffConfidentialNotes(
  staffUserId: string,
  page: { limit: number; offset: number },
) {
  const params = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
  return parsePage(await request(
    `/api/staff/${encodeURIComponent(staffUserId)}/confidential-notes?${params.toString()}`,
  ));
}

export async function createStaffConfidentialNote(
  staffUserId: string,
  input: { clientActionId: string; body: string },
) {
  return parseNote(await request(
    `/api/staff/${encodeURIComponent(staffUserId)}/confidential-notes`,
    json('POST', input),
  ));
}
