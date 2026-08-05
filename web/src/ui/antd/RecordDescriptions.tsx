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
 * Ant-compatible row spans. A wide item always owns its full row: when it would
 * otherwise land on a partially filled row, the previous item is extended to
 * close that row first. Without this, Ant clamps the wide item to the remaining
 * cell and emits a "Sum of column span" warning.
 */
export function resolveItemSpans(
  items: readonly RecordDescriptionItem[],
  columns: 1 | 2,
): number[] {
  if (columns === 1) return items.map(() => 1);
  const spans: number[] = [];
  let count = 0;
  items.forEach((item, index) => {
    if (item.wide && count > 0) {
      spans[index - 1] = 2;
      spans.push(2);
      count = 0;
      return;
    }
    const span = item.wide ? 2 : 1;
    spans.push(span);
    count += span;
    if (count >= columns) count = 0;
  });
  return spans;
}

/**
 * Read-only record facts. Column count follows the adapter host width (not viewport),
 * so AppShell sidebar + padding cannot force a crushed two-column grid. `maxColumns`
 * lets consumers pin a safer column count when the surrounding layout already
 * reserves horizontal space (e.g. the Job Detail work rail).
 */
export function RecordDescriptions({ ariaLabel, items, maxColumns = 2 }: {
  ariaLabel: string;
  items: readonly RecordDescriptionItem[];
  maxColumns?: 1 | 2;
}): ReactNode {
  const hostRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState<1 | 2>(1);

  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }

    const update = (width: number) => {
      const available = columnsForWidth(width);
      setColumns(available > maxColumns ? maxColumns : available);
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
  }, [maxColumns]);

  const spans = resolveItemSpans(items, columns);

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
        items={items.map((item, index) => ({
          key: item.key,
          label: item.label,
          children: item.content,
          span: spans[index],
        }))}
      />
    </div>
  );
}
