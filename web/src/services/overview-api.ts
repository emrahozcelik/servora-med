import {
  ApiError,
  number,
  object,
  request,
  string,
} from './api';

export type OverviewRecentWork = {
  id: string;
  title: string;
  customerName: string | null;
  assigneeName: string | null;
  completedAt: string;
};

export type OverviewRecentNote = {
  id: string;
  jobCardId: string;
  jobTitle: string;
  authorName: string;
  createdAt: string;
};

type OverviewCommon = {
  range: { from: string; to: string; timezone: string };
  generatedAt: string;
  recentCompletedWork: OverviewRecentWork[];
  recentNotes: OverviewRecentNote[];
  upcomingWork?: {
    items: Array<{
      id: string;
      source: 'JOB' | 'MANUAL';
      title: string;
      startsAt: string;
      endsAt: string | null;
      assignedUserName: string;
      path: string;
    }>;
    window: { from: string; to: string };
  } | null;
};

export type StaffOverview = OverviewCommon & {
  scope: 'staff';
  openJobCards: number;
  waitingApproval: number;
  revisionRequested: number;
  completedInPeriod: number;
  messageUnreadSummary?: { unreadTotal: number };
};

export type ManagementOverview = OverviewCommon & {
  scope: 'management';
  active: number;
  overdue: number;
  waitingApproval: number;
  revisionRequested: number;
  completedInPeriod: number;
  cancelledInPeriod: number;
  completionTrend: Array<{ date: string; count: number }>;
  approvalQueueSummary: {
    pendingCount: number;
    oldestWaitingMinutes: number | null;
  };
  workTypeDistribution?: Array<{ type: string; count: number }>;
  messageUnreadSummary?: { unreadTotal: number };
};

export type OverviewResponse = StaffOverview | ManagementOverview;

function nullable(value: unknown, field: string): string | null {
  return value === null ? null : string(value, field);
}

function parseCommon(value: Record<string, unknown>): OverviewCommon {
  const range = object(value.range);
  const work = Array.isArray(value.recentCompletedWork) ? value.recentCompletedWork : [];
  const notes = Array.isArray(value.recentNotes) ? value.recentNotes : [];
  const upcoming = value.upcomingWork === null || value.upcomingWork === undefined
    ? null
    : object(value.upcomingWork);
  const upcomingItems = upcoming && Array.isArray(upcoming.items) ? upcoming.items : [];
  return {
    range: {
      from: string(range.from, 'range.from'),
      to: string(range.to, 'range.to'),
      timezone: string(range.timezone, 'range.timezone'),
    },
    generatedAt: string(value.generatedAt, 'generatedAt'),
    recentCompletedWork: work.map((entry) => {
      const item = object(entry);
      return {
        id: string(item.id, 'recentCompletedWork.id'),
        title: string(item.title, 'recentCompletedWork.title'),
        customerName: nullable(item.customerName, 'recentCompletedWork.customerName'),
        assigneeName: nullable(item.assigneeName, 'recentCompletedWork.assigneeName'),
        completedAt: string(item.completedAt, 'recentCompletedWork.completedAt'),
      };
    }),
    recentNotes: notes.map((entry) => {
      const item = object(entry);
      return {
        id: string(item.id, 'recentNotes.id'),
        jobCardId: string(item.jobCardId, 'recentNotes.jobCardId'),
        jobTitle: string(item.jobTitle, 'recentNotes.jobTitle'),
        authorName: string(item.authorName, 'recentNotes.authorName'),
        createdAt: string(item.createdAt, 'recentNotes.createdAt'),
      };
    }),
    ...(value.upcomingWork === undefined ? {} : { upcomingWork: upcoming ? {
      items: upcomingItems.map((entry) => {
        const item = object(entry);
        const source = string(item.source, 'upcomingWork.source');
        if (source !== 'JOB' && source !== 'MANUAL') {
          throw new ApiError(0, 'INVALID_RESPONSE', 'Takvim kaynağı geçersiz.');
        }
        return {
          id: string(item.id, 'upcomingWork.id'),
          source,
          title: string(item.title, 'upcomingWork.title'),
          startsAt: string(item.startsAt, 'upcomingWork.startsAt'),
          endsAt: nullable(item.endsAt, 'upcomingWork.endsAt'),
          assignedUserName: string(item.assignedUserName, 'upcomingWork.assignedUserName'),
          path: string(item.path, 'upcomingWork.path'),
        };
      }),
      window: {
        from: string(object(upcoming.window).from, 'upcomingWork.window.from'),
        to: string(object(upcoming.window).to, 'upcomingWork.window.to'),
      },
    } : null }),
  };
}

export function parseOverviewResponse(input: unknown): OverviewResponse {
  const value = object(input);
  const common = parseCommon(value);
  if (value.scope === 'staff') {
    const msgUnread = value.messageUnreadSummary
      ? object(value.messageUnreadSummary)
      : undefined;
    return {
      scope: 'staff',
      ...common,
      openJobCards: number(value.openJobCards, 'openJobCards'),
      waitingApproval: number(value.waitingApproval, 'waitingApproval'),
      revisionRequested: number(value.revisionRequested, 'revisionRequested'),
      completedInPeriod: number(value.completedInPeriod, 'completedInPeriod'),
      ...(msgUnread ? {
        messageUnreadSummary: { unreadTotal: number(msgUnread.unreadTotal, 'unreadTotal') },
      } : {}),
    };
  }
  if (value.scope === 'management') {
    const trend = Array.isArray(value.completionTrend) ? value.completionTrend : [];
    const approval = object(value.approvalQueueSummary);
    const typeDist = value.workTypeDistribution && Array.isArray(value.workTypeDistribution)
      ? value.workTypeDistribution
      : undefined;
    const msgUnread = value.messageUnreadSummary
      ? object(value.messageUnreadSummary)
      : undefined;
    return {
      scope: 'management',
      ...common,
      active: number(value.active, 'active'),
      overdue: number(value.overdue, 'overdue'),
      waitingApproval: number(value.waitingApproval, 'waitingApproval'),
      revisionRequested: number(value.revisionRequested, 'revisionRequested'),
      completedInPeriod: number(value.completedInPeriod, 'completedInPeriod'),
      cancelledInPeriod: number(value.cancelledInPeriod, 'cancelledInPeriod'),
      completionTrend: trend.map((entry) => {
        const point = object(entry);
        return { date: string(point.date, 'date'), count: number(point.count, 'count') };
      }),
      approvalQueueSummary: {
        pendingCount: number(approval.pendingCount, 'pendingCount'),
        oldestWaitingMinutes: approval.oldestWaitingMinutes === null
          ? null
          : number(approval.oldestWaitingMinutes, 'oldestWaitingMinutes'),
      },
      ...(typeDist ? {
        workTypeDistribution: typeDist.map((entry) => {
          const item = object(entry);
          return {
            type: string(item.type, 'type'),
            count: number(item.count, 'count'),
          };
        }),
      } : {}),
      ...(msgUnread ? {
        messageUnreadSummary: { unreadTotal: number(msgUnread.unreadTotal, 'unreadTotal') },
      } : {}),
    };
  }
  throw new ApiError(0, 'INVALID_RESPONSE', 'Sunucudan geçersiz genel bakış yanıtı alındı.');
}

export async function getOverview(): Promise<OverviewResponse> {
  return parseOverviewResponse(await request('/api/overview'));
}
