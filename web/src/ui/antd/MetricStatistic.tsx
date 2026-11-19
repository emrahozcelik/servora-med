import { Statistic } from 'antd';
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { LoadingSkeleton } from './LoadingSkeleton';
import { StateHeading } from './state-heading';

export type MetricStatisticProps = {
  title: string;
  value: string | number;
  prefix?: string;
  suffix?: string;
  loading?: boolean;
  linkTo?: string;
  tone?: 'default' | 'attention' | 'success' | 'warning' | 'overdue';
  /** Readable second channel for a colored operational KPI. */
  statusPhrase?: string;
};

const toneModifier: Record<string, string> = {
  attention: 'servora-metric-statistic--attention',
  success: 'servora-metric-statistic--success',
  warning: 'servora-metric-statistic--warning',
  overdue: 'servora-metric-statistic--overdue',
};

export function MetricStatistic({
  title,
  value,
  prefix,
  suffix,
  loading = false,
  linkTo,
  tone = 'default',
  statusPhrase,
}: MetricStatisticProps): ReactNode {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const valueId = `${baseId}-value`;
  const statusId = `${baseId}-status`;
  const toneClass = tone !== 'default' && toneModifier[tone] ? ` ${toneModifier[tone]}` : '';
  const fallbackPhrase = tone === 'attention' || tone === 'overdue'
    ? 'İnceleme veya müdahale bekliyor'
    : tone === 'warning'
      ? 'Düzeltme gerekiyor'
      : tone === 'success'
        ? 'Tamamlanan kayıtlar'
        : '';
  const resolvedStatus = statusPhrase ?? fallbackPhrase;
  const hasStatus = Boolean((tone !== 'default' || statusPhrase) && resolvedStatus);

  if (loading) {
    return (
      <div className={`servora-metric-statistic${toneClass}`}>
        <LoadingSkeleton title={title} headingLevel={3} rows={1} />
      </div>
    );
  }

  return (
    <div className={`servora-metric-statistic${toneClass}`}>
      <Statistic
        title={<StateHeading level={3}><span id={titleId}>{title}</span></StateHeading>}
        value={value as string | number}
        prefix={prefix}
        suffix={suffix}
        formatter={
          linkTo
            ? (displayValue) => (
                <Link
                  to={linkTo}
                  id={valueId}
                  className="servora-metric-statistic__link"
                  aria-labelledby={`${titleId} ${valueId}`}
                  aria-describedby={hasStatus ? statusId : undefined}
                >
                  {displayValue}
                </Link>
              )
            : undefined
        }
      />
      {hasStatus && (
        <p id={statusId} className="servora-metric-statistic__status">{resolvedStatus}</p>
      )}
    </div>
  );
}
