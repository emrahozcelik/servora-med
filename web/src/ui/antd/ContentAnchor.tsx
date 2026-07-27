import { Anchor } from 'antd';
import type { ReactNode } from 'react';

export type ContentAnchorItem = {
  key: string;
  href: string;
  title: string;
};

export type ContentAnchorProps = {
  items: ContentAnchorItem[];
  offsetTop?: number;
  ariaLabel?: string;
};

export function ContentAnchor({
  items,
  offsetTop,
  ariaLabel,
}: ContentAnchorProps): ReactNode {
  const anchorItems = items.map((item) => ({
    key: item.key,
    href: item.href,
    title: item.title,
  }));

  return (
    <nav aria-label={ariaLabel}>
      <Anchor
        className="servora-content-anchor"
        items={anchorItems}
        offsetTop={offsetTop}
      />
    </nav>
  );
}
