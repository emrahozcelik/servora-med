import { Result } from 'antd';
import { useLayoutEffect, useRef, type ReactNode } from 'react';

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
  const sectionRef = useRef<HTMLElement>(null);
  // The status icon is decorative: the heading carries the meaning. Ant's
  // 403/404/500 illustrations embed English SVG <title>s ("Unauthorized",
  // "No Found") and status icons carry English aria-labels; Ant ignores the
  // `icon` prop for exception statuses and forwards no attributes to the icon
  // slot, so hide that slot from assistive technology here (UI audit F-18).
  useLayoutEffect(() => {
    sectionRef.current?.querySelectorAll('.servora-result-state__icon')
      .forEach((icon) => icon.setAttribute('aria-hidden', 'true'));
  }, [status]);

  return (
    <section
      ref={sectionRef}
      className="servora-result-state"
      data-servora-result-state="true"
      role={alertStatuses.has(status) ? 'alert' : 'status'}
    >
      <Result
        className="servora-result-state__content"
        classNames={{ icon: 'servora-result-state__icon' }}
        status={status}
        title={<StateHeading level={headingLevel}>{title}</StateHeading>}
        subTitle={description}
        extra={action}
      />
    </section>
  );
}
