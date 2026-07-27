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
  activeKey?: string[];
  onChange?: (keys: string[]) => void;
  accordion?: boolean;
  ariaLabel?: string;
};

export function ContentCollapse({
  items,
  defaultActiveKey,
  activeKey,
  onChange,
  accordion = false,
  ariaLabel,
}: ContentCollapseProps): ReactNode {
  return (
    <Collapse
      className="servora-content-collapse"
      items={items}
      defaultActiveKey={activeKey !== undefined ? undefined : defaultActiveKey}
      activeKey={activeKey}
      onChange={onChange as (keys: string | string[]) => void}
      accordion={accordion}
      aria-label={ariaLabel}
    />
  );
}
