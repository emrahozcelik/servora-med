import {
  boolean,
  items,
  json,
  nullableString,
  number,
  object,
  request,
  string,
} from './api';

export type CalendarAssignee = { id: string; name: string };
export type CalendarFollowUpContext = {
  sourceAccess: 'FULL' | 'RESTRICTED';
  sourceJobPath: string | null;
  sourcePlannedAt: string | null;
  sourceOccurredAt: string | null;
  sourceCompletedAt: string;
};
type CalendarCommon = {
  id: string;
  source: 'JOB' | 'MANUAL';
  title: string;
  startsAt: string;
  endsAt: string | null;
  timezone: string;
  assignedUser: CalendarAssignee;
  version: number;
  canEdit: boolean;
  canCancel: boolean;
};
export type JobCalendarEvent = CalendarCommon & {
  source: 'JOB';
  jobCardId: string;
  jobType: string;
  jobStatus: string;
  priority: string;
  customer: CalendarAssignee | null;
  relatedJobPath: string;
  followUpContext: CalendarFollowUpContext | null;
};
export type ManualCalendarEvent = CalendarCommon & {
  source: 'MANUAL';
  description: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  createdBy: CalendarAssignee;
  updatedBy: CalendarAssignee;
};
export type CalendarEvent = JobCalendarEvent | ManualCalendarEvent;
export type ManualEventInput = {
  clientActionId: string;
  assignedUserId: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  timezone: string;
};
export type ManualEventPatch = Partial<Omit<ManualEventInput, 'clientActionId'>>
  & { clientActionId: string; expectedVersion: number };

function identity(value: unknown, field: string): CalendarAssignee {
  const entry = object(value);
  return { id: string(entry.id, `${field}.id`), name: string(entry.name, `${field}.name`) };
}

function parseFollowUpContext(value: unknown): CalendarFollowUpContext | null {
  if (value === undefined || value === null) return null;
  const entry = object(value);
  const sourceAccess = string(entry.sourceAccess, 'followUpContext.sourceAccess');
  if (sourceAccess !== 'FULL' && sourceAccess !== 'RESTRICTED') {
    throw new Error('Takip kaynak erişim durumu geçersiz.');
  }
  const sourceJobPath = nullableString(entry.sourceJobPath, 'followUpContext.sourceJobPath');
  if ((sourceAccess === 'FULL' && sourceJobPath === null)
    || (sourceAccess === 'RESTRICTED' && sourceJobPath !== null)) {
    throw new Error('Takip kaynak bağlantısı erişim durumuyla uyuşmuyor.');
  }
  return {
    sourceAccess,
    sourceJobPath,
    sourcePlannedAt: nullableString(entry.sourcePlannedAt, 'followUpContext.sourcePlannedAt'),
    sourceOccurredAt: nullableString(entry.sourceOccurredAt, 'followUpContext.sourceOccurredAt'),
    sourceCompletedAt: string(entry.sourceCompletedAt, 'followUpContext.sourceCompletedAt'),
  };
}

export function parseCalendarEvent(value: unknown): CalendarEvent {
  const entry = object(value);
  const source = string(entry.source, 'source');
  const common = {
    id: string(entry.id, 'id'),
    title: string(entry.title, 'title'),
    startsAt: string(entry.startsAt, 'startsAt'),
    endsAt: nullableString(entry.endsAt, 'endsAt'),
    timezone: string(entry.timezone, 'timezone'),
    assignedUser: identity(entry.assignedUser, 'assignedUser'),
    version: number(entry.version, 'version'),
    canEdit: boolean(entry.canEdit, 'canEdit'),
    canCancel: boolean(entry.canCancel, 'canCancel'),
  };
  if (source === 'JOB') {
    const customer = entry.customer === null ? null : identity(entry.customer, 'customer');
    return {
      ...common,
      source,
      jobCardId: string(entry.jobCardId, 'jobCardId'),
      jobType: string(entry.jobType, 'jobType'),
      jobStatus: string(entry.jobStatus, 'jobStatus'),
      priority: string(entry.priority, 'priority'),
      customer,
      relatedJobPath: string(entry.relatedJobPath, 'relatedJobPath'),
      followUpContext: parseFollowUpContext(entry.followUpContext),
    };
  }
  if (source === 'MANUAL') {
    const status = string(entry.status, 'status');
    if (status !== 'ACTIVE' && status !== 'CANCELLED') throw new Error('Takvim durumu geçersiz.');
    return {
      ...common,
      source,
      description: nullableString(entry.description, 'description'),
      status,
      createdBy: identity(entry.createdBy, 'createdBy'),
      updatedBy: identity(entry.updatedBy, 'updatedBy'),
    };
  }
  throw new Error('Takvim kaynağı geçersiz.');
}

export async function listCalendar(input: { from: string; to: string; assignedTo?: string }) {
  const params = new URLSearchParams({ from: input.from, to: input.to });
  if (input.assignedTo) params.set('assignedTo', input.assignedTo);
  return items(await request(`/api/calendar?${params}`)).map(parseCalendarEvent);
}

export async function listCalendarAssignees() {
  return items(await request('/api/calendar/assignees'))
    .map((entry) => identity(entry, 'assignee'));
}

export async function getCalendarEvent(eventId: string) {
  return parseCalendarEvent(await request(
    `/api/calendar/events/${encodeURIComponent(eventId)}`,
  ));
}

export async function createManualEvent(input: ManualEventInput) {
  return parseCalendarEvent(await request('/api/calendar/events', json('POST', input)));
}

export async function patchManualEvent(eventId: string, input: ManualEventPatch) {
  return parseCalendarEvent(await request(
    `/api/calendar/events/${encodeURIComponent(eventId)}`,
    json('PATCH', input),
  ));
}

export async function cancelManualEvent(
  eventId: string,
  input: { clientActionId: string; expectedVersion: number; cancelReason: string },
) {
  return parseCalendarEvent(await request(
    `/api/calendar/events/${encodeURIComponent(eventId)}/cancel`,
    json('POST', input),
  ));
}
