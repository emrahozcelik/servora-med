import type { SafeUser } from '../auth/types.js';
import type {
  AuthenticatedCapabilities,
  AuthenticatedSupport,
} from './types.js';

const DEFAULT_CAPABILITIES: AuthenticatedCapabilities = {
  overviewDashboard: false,
  calendar: false,
  messaging: false,
  backup: false,
  demoDatasetCreation: false,
};
const DEFAULT_SUPPORT: AuthenticatedSupport = {
  displayLabel: 'Sistem yöneticiniz',
  email: null,
  helpUrl: null,
};

/**
 * Applies the runtime Overview module state (MOD-002) on top of the static
 * env-derived capabilities.
 */
export function withOverviewDashboard(
  capabilities: AuthenticatedCapabilities | undefined,
  overviewDashboard: boolean,
): AuthenticatedCapabilities {
  return { ...(capabilities ?? DEFAULT_CAPABILITIES), overviewDashboard };
}

export function authenticatedUser(
  user: SafeUser,
  capabilities: AuthenticatedCapabilities | undefined,
  support: AuthenticatedSupport | undefined,
) {
  const effectiveCapabilities = capabilities ?? DEFAULT_CAPABILITIES;
  const demoDatasetCreation = effectiveCapabilities.demoDatasetCreation === true && user.role === 'ADMIN';
  return {
    ...user,
    capabilities: {
      ...effectiveCapabilities,
      duplicateCustomerComparison: effectiveCapabilities.duplicateCustomerComparison === true && (user.role === 'ADMIN' || user.role === 'MANAGER'),
      demoDatasetCreation,
    },
    support: support ?? DEFAULT_SUPPORT,
  };
}
