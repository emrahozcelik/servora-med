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
      title: <strong>{item.action}</strong>,
      content: <article data-activity-id={item.key}>
        {item.detail && <p>{item.detail}</p>}
        {item.reason && <p className="timeline-reason"><strong>Neden:</strong> {item.reason}</p>}
        <footer>
          <span>{item.actor}</span>
          <time dateTime={item.occurredAt}>{item.occurredAtLabel}</time>
        </footer>
      </article>,
    }))}
  />;
}
