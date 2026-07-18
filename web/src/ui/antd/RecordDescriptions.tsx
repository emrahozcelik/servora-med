import { useEffect, useState, type ReactNode } from 'react';
import { Descriptions } from 'antd';

export type RecordDescriptionItem = Readonly<{
  key: string;
  label: string;
  content: ReactNode;
  wide?: boolean;
}>;

function useDesktopShell() {
  const query = '(min-width: 64rem)';
  const [desktop, setDesktop] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const onChange = (event: MediaQueryListEvent) => setDesktop(event.matches);
    setDesktop(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return desktop;
}

export function RecordDescriptions({ ariaLabel, items }: {
  ariaLabel: string;
  items: readonly RecordDescriptionItem[];
}): ReactNode {
  const desktop = useDesktopShell();
  return <Descriptions
    className="servora-record-descriptions"
    aria-label={ariaLabel}
    bordered
    colon={false}
    column={desktop ? 2 : 1}
    items={items.map((item) => ({
      key: item.key,
      label: item.label,
      children: item.content,
      span: item.wide && desktop ? 2 : 1,
    }))}
  />;
}
