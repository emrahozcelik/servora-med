export const USER_ROLES = ['ADMIN', 'MANAGER', 'STAFF'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Positive management-role check: never assumes that a non-STAFF role manages. */
export function isManagementRole(role: UserRole): boolean {
  return role === 'ADMIN' || role === 'MANAGER';
}

export type AuthUserRecord = {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  mustChangePassword: boolean;
  isActive: boolean;
  version: number;
};

export type SafeUser = Omit<AuthUserRecord, 'passwordHash'>;

export type SessionRecord = {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
};
