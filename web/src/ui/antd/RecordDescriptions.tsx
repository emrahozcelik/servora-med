import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Descriptions } from 'antd';

/** Minimum host content width before two-column Ant Descriptions layout is used. */
export const RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX = 640;

export type RecordDescriptionItem = Readonly<{
  key: string;
  label: string;
  content: ReactNode;
  wide?: boolean;
}>;

function columnsForWidth(width: number): 1 | 2 {
  return width >= RECORD_DESCRIPTIONS_TWO_COLUMN_MIN_WIDTH_PX ? 2 : 1;
}

/**
 * Read-only record facts. Column count follows the adapter host width (not viewport),
 * so AppShell sidebar + padding cannot force a crushed two-column grid.
 */
export function RecordDescriptions({ ariaLabel, items }: {
  ariaLabel: string;
  items: readonly RecordDescriptionItem[];
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<1 | 2>(1);

  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    const update = (width: number) => {
      setColumns(columnsForWidth(width));
    };

    update(element.getBoundingClientRect().width);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      update(entry.contentRect.width);
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div
      ref={hostRef}
      className="servora-record-descriptions-host"
      data-column-count={columns}
    >
      <Descriptions
        className="servora-record-descriptions"
        aria-label={ariaLabel}
        bordered
        colon={false}
        column={columns}
        items={items.map((item) => ({
          key: item.key,
          label: item.label,
          children: item.content,
          span: item.wide && columns === 2 ? 2 : 1,
        }))}
      />
    </div>
  );
}
