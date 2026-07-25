import type { ReactNode } from 'react';
import { Timeline } from 'antd';

export type ActivityTimelineItem = Readonly<{
  key: string;
  action: string;
  detail: string;
  reason: string | null;
  actor: string;
  occurredAt: string;
  occurredAtLabel: string;
}>;

export function ActivityTimeline({ items }: {
  items: readonly ActivityTimelineItem[];
}): ReactNode {
  return <Timeline
    className="servora-activity-timeline"
    items={items.map((item) => ({
      key: item.key,
      title: <strong className="activity-timeline-action">{item.action}</strong>,
      content: <article data-activity-id={item.key}>
        {item.detail && <p className="activity-timeline-detail">{item.detail}</p>}
        {item.reason && <p className="timeline-reason activity-timeline-reason"><strong>Neden:</strong> {item.reason}</p>}
        <footer className="activity-timeline-meta">
          <span className="activity-timeline-actor">{item.actor}</span>
          <time className="activity-timeline-time" dateTime={item.occurredAt}>{item.occurredAtLabel}</time>
        </footer>
      </article>,
    }))}
  />;
}
