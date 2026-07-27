import { Statistic } from 'antd';
import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

import { LoadingSkeleton } from './LoadingSkeleton';
import { StateHeading } from './state-heading';

export type MetricStatisticProps = {
  title: string;
  value: string | number;
  prefix?: string;
  suffix?: string;
  loading?: boolean;
  linkTo?: string;
  tone?: 'default' | 'attention' | 'success' | 'warning';
};

const toneModifier: Record<string, string> = {
  attention: 'servora-metric-statistic--attention',
  success: 'servora-metric-statistic--success',
  warning: 'servora-metric-statistic--warning',
};

export function MetricStatistic({
  title,
  value,
  prefix,
  suffix,
  loading = false,
  linkTo,
  tone = 'default',
}: MetricStatisticProps): ReactNode {
  const toneClass = tone !== 'default' ? ` ${toneModifier[tone]}` : '';

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
        title={<StateHeading level={3}>{title}</StateHeading>}
        value={value as string | number}
        prefix={prefix}
        suffix={suffix}
        formatter={
          linkTo
            ? (displayValue) => <Link to={linkTo}>{displayValue}</Link>
            : undefined
        }
      />
    </div>
  );
}
