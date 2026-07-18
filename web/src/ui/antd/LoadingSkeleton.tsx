import { Skeleton } from 'antd';
import type { ReactNode } from 'react';

import { StateHeading, type StateHeadingLevel } from './state-heading';

export type LoadingSkeletonProps = Readonly<{
  title: string;
  headingLevel?: StateHeadingLevel;
  rows?: number;
}>;

/** Stable, non-interactive loading geometry with an accessible live label. */
export function LoadingSkeleton({
  title,
  headingLevel = 2,
  rows = 3,
}: LoadingSkeletonProps): ReactNode {
  return (
    <section
      className="servora-loading-skeleton"
      data-servora-loading-skeleton="true"
      aria-busy="true"
      aria-live="polite"
    >
      <StateHeading level={headingLevel} className="sr-only">{title}</StateHeading>
      <Skeleton
        className="servora-loading-skeleton__content"
        active
        title={{ width: '42%' }}
        paragraph={{ rows }}
      />
    </section>
  );
}
