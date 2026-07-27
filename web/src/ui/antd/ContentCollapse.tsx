import { Collapse } from 'antd';
import type { ReactNode } from 'react';

export type ContentCollapseItem = {
  key: string;
  label: string;
  children: ReactNode;
};

export type ContentCollapseProps = {
  items: ContentCollapseItem[];
  defaultActiveKey?: string[];
  accordion?: boolean;
  ariaLabel?: string;
};

export function ContentCollapse({
  items,
  defaultActiveKey,
  accordion = false,
  ariaLabel,
}: ContentCollapseProps): ReactNode {
  return (
    <Collapse
      className="servora-content-collapse"
      items={items}
      defaultActiveKey={defaultActiveKey}
      accordion={accordion}
      aria-label={ariaLabel}
    />
  );
}
