import { Segmented } from 'antd';
import type { ReactNode } from 'react';

export type IconSegmentedOption = {
  label: string;
  value: string;
  icon?: string;
};

export type IconSegmentedProps = {
  options: IconSegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  size?: 'small' | 'middle';
  ariaLabel?: string;
};

export function IconSegmented({
  options,
  value,
  onChange,
  size,
  ariaLabel,
}: IconSegmentedProps): ReactNode {
  const items = options.map((opt) => ({
    label: opt.icon ? `${opt.icon} ${opt.label}` : opt.label,
    value: opt.value,
  }));

  return (
    <Segmented
      className="servora-icon-segmented"
      options={items}
      value={value}
      onChange={(v) => onChange(v as string)}
      size={size}
      aria-label={ariaLabel}
    />
  );
}
