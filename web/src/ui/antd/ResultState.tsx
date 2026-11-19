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

/**
 * Statuses that must not print Ant's decorative exception artwork (UI audit
 * F-12). Ant 6.7 always paints its own multi-colour illustration for the
 * `403`/`404`/`500` result statuses and ignores the `icon` prop for them, so
 * these are rendered through the calm, icon-free informational variant while
 * the real status stays on `data-result-status` for tests and tooling.
 */
const calmStatuses: ReadonlySet<ResultStateStatus> = new Set(['403', '404']);

/** Feature owns state and actions; this adapter owns accessible result presentation. */
export function ResultState({
  status,
  title,
  description,
  action,
  headingLevel = 2,
}: ResultStateProps): ReactNode {
  const sectionRef = useRef<HTMLElement>(null);
  const calm = calmStatuses.has(status);
  // A remaining exception illustration (500) embeds English SVG <title>s
  // ("Sorry, something went wrong.") and Ant forwards no attributes to the
  // icon slot, so hide that slot from assistive technology here (F-18).
  useLayoutEffect(() => {
    sectionRef.current?.querySelectorAll('.servora-result-state__icon')
      .forEach((icon) => icon.setAttribute('aria-hidden', 'true'));
  }, [status]);

  return (
    <section
      ref={sectionRef}
      className="servora-result-state"
      data-servora-result-state="true"
      data-result-status={status}
      role={alertStatuses.has(status) ? 'alert' : 'status'}
    >
      <Result
        className="servora-result-state__content"
        classNames={{ icon: 'servora-result-state__icon' }}
        status={calm ? 'info' : status}
        icon={calm ? null : undefined}
        title={<StateHeading level={headingLevel}>{title}</StateHeading>}
        subTitle={description}
        extra={action}
      />
    </section>
  );
}
