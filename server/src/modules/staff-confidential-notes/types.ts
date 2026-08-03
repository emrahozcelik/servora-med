import type { UserRole } from '../auth/types.js';
import type { RealtimeEventRecord } from '../realtime/types.js';

export type StaffConfidentialNoteRecord = {
  id: string;
  organizationId: string;
  staffUserId: string;
  authorUserId: string;
  body: string;
  createdAt: Date;
};

export type StaffConfidentialNoteDto = {
  id: string;
  organizationId: string;
  staffUserId: string;
  authorUserId: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type StaffConfidentialNotePage = {
  items: StaffConfidentialNoteDto[];
  total: number;
  limit: number;
  offset: number;
};

export type StaffConfidentialNotePageQuery = {
  limit: number;
  offset: number;
};

export type CreateStaffConfidentialNoteInput = {
  clientActionId: string;
  body: string;
};

export type StaffConfidentialNotesActor = {
  id: string;
  organizationId: string;
  role: UserRole;
  isActive: boolean;
};

export type StaffConfidentialNoteAuditInput = {
  organizationId: string;
  actorUserId: string;
  subjectType: 'STAFF_CONFIDENTIAL_NOTE';
  subjectId: string;
  eventType: 'STAFF_CONFIDENTIAL_NOTE_CREATED';
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
};

export type StaffConfidentialNoteCriticalActionResult<T> =
  | {
      kind: 'completed';
      response: T;
      realtimeEvents: readonly RealtimeEventRecord[];
    }
  | {
      kind: 'replay';
      response: T;
      realtimeEvents: readonly [];
    }
  | { kind: 'processing' };

export type StaffConfidentialNoteCriticalActionWorkResult<T> = {
  response: T;
  realtimeEvents: readonly RealtimeEventRecord[];
};

export type StaffConfidentialNoteCriticalActionClaim = {
  organizationId: string;
  userId: string;
  clientActionId: string;
  operationKey: string;
};
