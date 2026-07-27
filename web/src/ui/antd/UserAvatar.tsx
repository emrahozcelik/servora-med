import { Avatar } from 'antd';
import type { ReactNode } from 'react';

export type UserAvatarProps = {
  name: string;
  size?: 'default' | 'large' | 'small';
  src?: string;
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

const sizeMap: Record<string, number> = {
  default: 40,
  large: 56,
  small: 32,
};

export function UserAvatar({
  name,
  size = 'default',
  src,
}: UserAvatarProps): ReactNode {
  return (
    <Avatar
      className="servora-user-avatar"
      src={src}
      alt={name}
      style={{
        backgroundColor: 'var(--accent-soft)',
        color: 'var(--accent)',
      }}
      size={sizeMap[size]}
      gap={4}
    >
      {initials(name)}
    </Avatar>
  );
}
