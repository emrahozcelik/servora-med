import type { SafeUser, UserRole } from '../auth/types.js';

export type CalendarActor = Pick<SafeUser, 'id' | 'organizationId' | 'role'>;
export type CalendarSource = 'JOB' | 'MANUAL';
export type CalendarEventStatus = 'ACTIVE' | 'CANCELLED';
export type CalendarAssignee = Readonly<{
  id: string;
  name: string;
}>;

export type CalendarFollowUpContext = Readonly<{
  sourceAccess: 'FULL' | 'RESTRICTED';
  sourceJobPath: string | null;
  sourcePlannedAt: string | null;
  sourceOccurredAt: string | null;
  sourceCompletedAt: string;
}>;

type CalendarEventCommon = Readonly<{
  id: string;
  source: CalendarSource;
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  assignedUser: CalendarAssignee;
  version: number;
  canEdit: boolean;
  canCancel: boolean;
}>;

export type JobCalendarEvent = CalendarEventCommon & Readonly<{
  source: 'JOB';
  jobCardId: string;
  jobType: string;
  jobStatus: string;
  priority: string;
  customer: CalendarAssignee | null;
  relatedJobPath: string;
  /**
   * RESCUE-004/A (SCH-001 addendum): the authoritative Staff reservation is
   * released while the job, its customer plan and its assignee remain
   * projected. Server-computed from the newest assignment offer; a legacy
   * payload without the field means `false`.
   */
  staffReservationReleased: boolean;
  followUpContext: CalendarFollowUpContext | null;
}>;

export type ManualCalendarEvent = CalendarEventCommon & Readonly<{
  source: 'MANUAL';
  description: string | null;
  status: CalendarEventStatus;
  createdBy: CalendarAssignee;
  updatedBy: CalendarAssignee;
}>;

export type CalendarEvent = JobCalendarEvent | ManualCalendarEvent;
export type CalendarQuery = Readonly<{
  from: string;
  to: string;
  assignedTo: string | null;
}>;

export type ManualEventCreateInput = Readonly<{
  clientActionId: string;
  assignedUserId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
}>;

export type ManualEventPatchInput = Readonly<{
  clientActionId: string;
  expectedVersion: number;
  assignedUserId?: string;
  title?: string;
  description?: string | null;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
}>;

export type ManualEventCancelInput = Readonly<{
  clientActionId: string;
  expectedVersion: number;
  cancelReason: string;
}>;

export type CalendarUser = Readonly<{
  id: string;
  organizationId: string;
  name: string;
  role: UserRole;
  isActive: boolean;
}>;

export type CalendarConflict = Readonly<{
  source: CalendarSource;
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  assignedUser: CalendarAssignee;
  relatedJobPath: string | null;
}>;
