import { Segmented } from 'antd';
import { useEffect, useState, type ReactNode } from 'react';

export type IconSegmentedOption = {
  label: string;
  value: string;
  icon?: string;
};

export type IconSegmentedProps = {
  options: IconSegmentedOption[];
  value?: string;
  onChange: (value: string) => void;
  size?: 'small' | 'middle';
  ariaLabel?: string;
  disabled?: boolean;
  block?: boolean;
  responsiveVertical?: boolean;
};

function useNarrowViewport(enabled: boolean) {
  const query = '(max-width: 30rem)';
  const [narrow, setNarrow] = useState(() => (
    enabled
    && typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches
  ));

  useEffect(() => {
    if (!enabled || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [enabled]);

  return narrow;
}

export function IconSegmented({
  options,
  value,
  onChange,
  size,
  ariaLabel,
  disabled = false,
  block = false,
  responsiveVertical = false,
}: IconSegmentedProps): ReactNode {
  const vertical = useNarrowViewport(responsiveVertical);
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
      disabled={disabled}
      block={block}
      vertical={vertical}
    />
  );
}
