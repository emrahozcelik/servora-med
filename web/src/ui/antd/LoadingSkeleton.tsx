import { Skeleton } from 'antd';
import type { ReactNode } from 'react';

import { StateHeading, type StateHeadingLevel } from './state-heading';

export type LoadingSkeletonProps = Readonly<{
  title: string;
  headingLevel?: StateHeadingLevel;
  rows?: number;
}>;

/** Stable, non-interactive loading geometry with an accessible status label. */
export function LoadingSkeleton({
  title,
  headingLevel = 2,
  rows = 3,
}: LoadingSkeletonProps): ReactNode {
  return (
    <section
      className="servora-loading-skeleton"
      data-servora-loading-skeleton="true"
    >
      <StateHeading level={headingLevel} className="servora-loading-skeleton__title">
        <span role="status">{title}</span>
      </StateHeading>
      <div className="servora-loading-skeleton__geometry" aria-busy="true">
        <div aria-hidden="true">
          <Skeleton
            className="servora-loading-skeleton__content"
            active
            title={{ width: '42%' }}
            paragraph={{ rows }}
          />
        </div>
      </div>
    </section>
  );
}
