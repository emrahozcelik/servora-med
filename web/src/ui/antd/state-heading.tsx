import type { ReactNode } from 'react';

export type StateHeadingLevel = 1 | 2 | 3;

export function StateHeading({
  level,
  className,
  children,
}: {
  level: StateHeadingLevel;
  className?: string;
  children: ReactNode;
}): ReactNode {
  if (level === 1) return <h1 className={className}>{children}</h1>;
  if (level === 3) return <h3 className={className}>{children}</h3>;
  return <h2 className={className}>{children}</h2>;
}
