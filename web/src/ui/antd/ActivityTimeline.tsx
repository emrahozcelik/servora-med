import type { ReactNode } from 'react';
import { Timeline } from 'antd';

import { SignalGlyph, type SignalGlyphName } from '../signal-icons';

export type ActivityTimelineTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

export type ActivityTimelineItem = Readonly<{
  key: string;
  action: string;
  detail: string;
  reason: string | null;
  actor: string;
  occurredAt: string;
  occurredAtLabel: string;
  tone?: ActivityTimelineTone;
  icon?: SignalGlyphName;
  badge?: {
    label: string;
    tone: 'warning';
    testId?: string;
  } | null;
}>;

export function ActivityTimeline({ items }: {
  items: readonly ActivityTimelineItem[];
}): ReactNode {
  return <Timeline
    className="servora-activity-timeline"
    items={items.map((item) => {
      const tone = item.tone ?? 'neutral';
      const iconName = item.icon ?? 'timeline-neutral';
      return {
        key: item.key,
        className: `activity-timeline-item activity-timeline-item--${tone}`,
        icon: (
          <span
            className={`activity-timeline-marker activity-timeline-marker--${tone}`}
            aria-hidden="true"
          >
            <SignalGlyph name={iconName} className="activity-timeline-marker-icon" size={12} />
          </span>
        ),
        title: <strong className="activity-timeline-action">{item.action}</strong>,
        content: <article data-activity-id={item.key}>
          {item.detail && <p className="activity-timeline-detail">{item.detail}</p>}
          {item.badge && (
            <p
              className={`activity-timeline-badge activity-timeline-badge--${item.badge.tone}`}
              data-location-comparison={item.badge.testId}
            >
              <SignalGlyph name="location" className="activity-timeline-badge-icon" size={14} />
              <span>{item.badge.label}</span>
            </p>
          )}
          {item.reason && <p className="timeline-reason activity-timeline-reason"><strong>Neden:</strong> {item.reason}</p>}
          <footer className="activity-timeline-meta">
            <span className="activity-timeline-actor">{item.actor}</span>
            <time className="activity-timeline-time" dateTime={item.occurredAt}>{item.occurredAtLabel}</time>
          </footer>
        </article>,
      };
    })}
  />;
}
