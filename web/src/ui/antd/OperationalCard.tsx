import { Card } from 'antd';
import type { ReactNode } from 'react';

export type OperationalCardTone =
  | 'default'
  | 'new'
  | 'upcoming'
  | 'attention'
  | 'overdue'
  | 'success'
  | 'selected';

export type OperationalCardProps = {
  tone?: OperationalCardTone;
  title?: ReactNode;
  extra?: ReactNode;
  /** Visible status phrase; a role-neutral default is supplied for non-default tones. */
  statusLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
  loading?: boolean;
  className?: string;
};

const toneClassMap: Record<OperationalCardTone, string> = {
  default: '',
  new: 'servora-operational-card--new',
  upcoming: 'servora-operational-card--upcoming',
  attention: 'servora-operational-card--attention',
  overdue: 'servora-operational-card--overdue',
  success: 'servora-operational-card--success',
  selected: 'servora-operational-card--selected',
};

/**
 * Owned Card adapter for one subject, record summary, or action group.
 * Feature owns outer semantics (article, li, section, link) and accessible names.
 * Every non-default tone uses at least two channels (color/tone + visible label/text).
 */
const toneLabels: Record<Exclude<OperationalCardTone, 'default'>, string> = {
  new: 'Yeni kayıt',
  upcoming: 'Yaklaşan plan',
  attention: 'İşlem bekliyor',
  overdue: 'Gecikmiş kayıt',
  success: 'Tamamlandı',
  selected: 'Seçili kayıt',
};

export function OperationalCard({
  tone = 'default',
  title,
  extra,
  statusLabel,
  actions,
  children,
  loading = false,
  className,
}: OperationalCardProps): ReactNode {
  const toneClass = tone !== 'default' ? ` ${toneClassMap[tone]}` : '';
  const mergedClass = `servora-operational-card${toneClass}${className ? ` ${className}` : ''}`;
  const statusCue = tone !== 'default'
    ? <span className={`servora-tone-chip servora-tone-chip--${tone}`}>{statusLabel ?? toneLabels[tone]}</span>
    : null;
  const displayExtra = statusCue
    ? <span className="servora-operational-card__status-group">{statusCue}{extra}</span>
    : extra;

  return (
    <Card
      className={mergedClass}
      classNames={{
        root: mergedClass,
        header: 'servora-operational-card__header',
        title: 'servora-operational-card__title',
        extra: 'servora-operational-card__extra',
        body: 'servora-operational-card__body',
        actions: 'servora-operational-card__actions',
      }}
      title={title}
      extra={displayExtra}
      actions={actions ? [actions] : undefined}
      loading={loading}
      size="small"
    >
      {children}
    </Card>
  );
}
