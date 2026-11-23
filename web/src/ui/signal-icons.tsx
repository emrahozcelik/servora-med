import type { ReactNode } from 'react';

import type {
  JobCardEngagementKind,
  JobCardPriority,
  JobCardStatus,
  JobCardType,
  LifecycleCommand,
} from '../jobs/jobs-api';

/**
 * Decorative inline SVG signal and workflow icons (DECISIONS.md UI-004).
 *
 * All icons are purely geometric paths (`aria-hidden`, `focusable="false"`) so
 * the visible Turkish text always remains the accessible label and test DOM
 * `textContent` queries stay unaffected.
 */

type BaseIconProps = {
  className?: string;
  size?: number;
};

function SvgIcon({
  children,
  className,
  size = 16,
}: BaseIconProps & { children: ReactNode }): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const STATUS_PATHS: Record<JobCardStatus, ReactNode> = {
  NEW: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </>
  ),
  ACCEPTED: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.5l2.3 2.3 4.7-4.8" />
    </>
  ),
  IN_PROGRESS: (
    <>
      <polygon points="8 6 19 12 8 18 8 6" />
    </>
  ),
  WAITING_APPROVAL: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5l3 2" />
    </>
  ),
  REVISION_REQUESTED: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3.5v4.5h4.5" />
    </>
  ),
  COMPLETED: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.5l2.5 2.5 5-5" />
    </>
  ),
  CANCELLED: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </>
  ),
  INVALIDATED: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M7.5 16.5l9-9" />
    </>
  ),
};

export function StatusSignalIcon({
  status,
  className = 'signal-icon',
  size = 14,
}: BaseIconProps & { status: JobCardStatus }): ReactNode {
  return (
    <SvgIcon className={className} size={size}>
      {STATUS_PATHS[status]}
    </SvgIcon>
  );
}

const PRIORITY_PATHS: Record<JobCardPriority, ReactNode> = {
  low: <path d="M6 9l6 6 6-6" />,
  normal: <path d="M5 12h14" />,
  high: <path d="M6 15l6-6 6 6" />,
  urgent: (
    <>
      <path d="M6 17l6-5 6 5" />
      <path d="M6 11l6-5 6 5" />
    </>
  ),
};

export function PrioritySignalIcon({
  priority,
  className = 'signal-icon',
  size = 14,
}: BaseIconProps & { priority: JobCardPriority }): ReactNode {
  return (
    <SvgIcon className={className} size={size}>
      {PRIORITY_PATHS[priority]}
    </SvgIcon>
  );
}

export function JobTypeIcon({
  type,
  engagementKind,
  className = 'job-type-icon',
  size = 15,
}: BaseIconProps & {
  type: JobCardType;
  engagementKind?: JobCardEngagementKind | null;
}): ReactNode {
  let paths: ReactNode;
  switch (type) {
    case 'PRODUCT_DELIVERY':
      paths = (
        <>
          <path d="M12 3L4 7.2v9.6L12 21l8-4.2V7.2z" />
          <path d="M4 7.2L12 11.5l8-4.3M12 11.5V21" />
        </>
      );
      break;
    case 'SALES_MEETING':
      paths = engagementKind === 'FOLLOW_UP' ? (
        <>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4" />
        </>
      ) : (
        <>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </>
      );
      break;
    case 'SALE':
      paths = (
        <>
          <path d="M5 4h14v17l-3-2-4 2-4-2-3 2z" />
          <path d="M9 9h6M9 13h6" />
        </>
      );
      break;
    case 'WEEKLY_REPORT':
      paths = (
        <>
          <path d="M6 3h8l4 4v14H6z" />
          <path d="M9 16v-3M12 16v-5M15 16v-2" />
        </>
      );
      break;
    case 'GENERAL_TASK':
    default:
      paths = (
        <>
          <rect x="5" y="4" width="14" height="17" rx="2" />
          <path d="M9 4.5h6M9 12l2 2 4-4" />
        </>
      );
      break;
  }

  return (
    <SvgIcon className={className} size={size}>
      {paths}
    </SvgIcon>
  );
}

const COMMAND_PATHS: Record<LifecycleCommand, ReactNode> = {
  ACCEPT_ASSIGNMENT: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.5l2.3 2.3 4.7-4.8" />
    </>
  ),
  DECLINE_ASSIGNMENT: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </>
  ),
  RELEASE_ASSIGNMENT: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v1.5" />
    </>
  ),
  START: <polygon points="7 5 19 12 7 19 7 5" />,
  SUBMIT_FOR_APPROVAL: (
    <>
      <path d="M21 3L10 14" />
      <path d="M21 3L14.5 21l-3.5-7.5L3.5 10 21 3z" />
    </>
  ),
  APPROVE: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.5l2.3 2.3 4.7-4.8" />
    </>
  ),
  REQUEST_REVISION: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3.5v4.5h4.5" />
    </>
  ),
  WITHDRAW_FROM_APPROVAL: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v1.5" />
    </>
  ),
  RESUME: <polygon points="7 5 19 12 7 19 7 5" />,
  CANCEL: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
    </>
  ),
};

export function WorkflowCommandIcon({
  command,
  className = 'button-leading-icon',
  size = 15,
}: BaseIconProps & { command: LifecycleCommand }): ReactNode {
  return (
    <SvgIcon className={className} size={size}>
      {COMMAND_PATHS[command]}
    </SvgIcon>
  );
}

export type SignalGlyphName =
  | 'clock'
  | 'follow-up'
  | 'check'
  | 'circle'
  | 'exclamation'
  | 'edit'
  | 'location'
  | 'timeline-success'
  | 'timeline-info'
  | 'timeline-warning'
  | 'timeline-danger'
  | 'timeline-neutral';

const SIGNAL_GLYPHS: Record<SignalGlyphName, ReactNode> = {
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5v5l3 2" />
    </>
  ),
  'follow-up': (
    <>
      <path d="M17 3l4 4-4 4" />
      <path d="M3 11V9a2 2 0 0 1 2-2h16" />
      <path d="M7 21l-4-4 4-4" />
      <path d="M21 13v2a2 2 0 0 1-2 2H3" />
    </>
  ),
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  circle: <circle cx="12" cy="12" r="7" strokeDasharray="3.5 3.5" />,
  exclamation: (
    <>
      <path d="M12 7.5v5.5" />
      <circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </>
  ),
  location: (
    <>
      <path d="M12 21s6-5.7 6-11a6 6 0 1 0-12 0c0 5.3 6 11 6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </>
  ),
  'timeline-success': <path d="M5 12.5l4.2 4.2L19 7" />,
  'timeline-info': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
    </>
  ),
  'timeline-warning': (
    <>
      <path d="M12 7.5v5.5" />
      <circle cx="12" cy="16.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  'timeline-danger': <path d="M7 7l10 10M17 7L7 17" />,
  'timeline-neutral': <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />,
};

export function SignalGlyph({
  name,
  className = 'signal-icon',
  size = 14,
}: BaseIconProps & { name: SignalGlyphName }): ReactNode {
  return (
    <SvgIcon className={className} size={size}>
      {SIGNAL_GLYPHS[name]}
    </SvgIcon>
  );
}
