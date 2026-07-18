import { Result } from 'antd';
import type { ReactNode } from 'react';

import { StateHeading, type StateHeadingLevel } from './state-heading';

export type ResultStateStatus = 'success' | 'error' | 'info' | 'warning' | '403' | '404' | '500';

export type ResultStateProps = Readonly<{
  status: ResultStateStatus;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: StateHeadingLevel;
}>;

const alertStatuses: ReadonlySet<ResultStateStatus> = new Set([
  'error',
  'warning',
  '403',
  '404',
  '500',
]);

/** Feature owns state and actions; this adapter owns accessible result presentation. */
export function ResultState({
  status,
  title,
  description,
  action,
  headingLevel = 2,
}: ResultStateProps): ReactNode {
  return (
    <section
      className="servora-result-state"
      data-servora-result-state="true"
      role={alertStatuses.has(status) ? 'alert' : 'status'}
    >
      <Result
        className="servora-result-state__content"
        status={status}
        title={<StateHeading level={headingLevel}>{title}</StateHeading>}
        subTitle={description}
        extra={action}
      />
    </section>
  );
}
