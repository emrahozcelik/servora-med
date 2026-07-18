import type { ReactNode } from 'react';
import { Descriptions } from 'antd';

export type RecordDescriptionItem = Readonly<{
  key: string;
  label: string;
  content: ReactNode;
  wide?: boolean;
}>;

export function RecordDescriptions({ ariaLabel, items }: {
  ariaLabel: string;
  items: readonly RecordDescriptionItem[];
}): ReactNode {
  return <Descriptions
    className="servora-record-descriptions"
    aria-label={ariaLabel}
    bordered
    colon={false}
    column={{ xs: 1, lg: 2 }}
    items={items.map((item) => ({
      key: item.key,
      label: item.label,
      children: item.content,
      span: item.wide ? 2 : 1,
    }))}
  />;
}
