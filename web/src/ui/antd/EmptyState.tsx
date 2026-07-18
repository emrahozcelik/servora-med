import { Empty } from 'antd';
import type { ReactNode } from 'react';

import { StateHeading, type StateHeadingLevel } from './state-heading';

export type EmptyStateProps = Readonly<{
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: StateHeadingLevel;
}>;

/** Explanatory empty collection state. Feature supplies meaning and the valid next action. */
export function EmptyState({
  title,
  description,
  action,
  headingLevel = 2,
}: EmptyStateProps): ReactNode {
  return (
    <section className="servora-empty-state" data-servora-empty-state="true">
      <Empty
        className="servora-empty-state__content"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={(
          <div className="servora-empty-state__description">
            <StateHeading level={headingLevel}>{title}</StateHeading>
            {description ? <p>{description}</p> : null}
          </div>
        )}
      >
        {action}
      </Empty>
    </section>
  );
}
