import type { ModuleStateRow } from '../installation-modules/state.js';

/** Fixed in code; the migration CHECK carries the same list. */
export const OPERATOR_CAPABILITIES = ['MODULE_MANAGEMENT'] as const;
export type OperatorCapability = (typeof OPERATOR_CAPABILITIES)[number];

export const OPERATOR_SESSION_COOKIE_NAME = 'servora_operator_session';
/** Two hours, absolute: sessions are never renewed. */
export const OPERATOR_SESSION_TTL_SECONDS = 7_200;
export const OPERATOR_COOKIE_PATH = '/api/operator';

export type OperatorAccountRecord = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isActive: boolean;
  version: number;
  capabilities: OperatorCapability[];
};

export type OperatorPublic = {
  id: string;
  name: string;
  email: string;
  capabilities: OperatorCapability[];
};

export type OperatorSessionContext = {
  operator: OperatorPublic;
  tokenHash: string;
  sessionId: string;
};

export type OperatorListEntry = {
  email: string;
  name: string;
  isActive: boolean;
  capabilities: OperatorCapability[];
  lastLoginAt: Date | null;
};

export type OperatorModuleView = {
  key: ModuleStateRow['key'];
  label: string;
  description: string;
  whenDisabled: string[];
  preserved: string[];
  enabled: boolean;
  version: number;
  source: ModuleStateRow['source'];
  updatedAt: string;
};

export function toOperatorPublic(account: OperatorAccountRecord): OperatorPublic {
  return {
    id: account.id,
    name: account.name,
    email: account.email,
    capabilities: account.capabilities,
  };
}
