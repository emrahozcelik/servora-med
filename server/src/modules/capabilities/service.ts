import type { SafeUser } from '../auth/types.js';
import type { ModuleCapabilityField } from '../installation-modules/registry.js';
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
 * Applies runtime installation-module capability overrides (MOD-002 / R0) on
 * top of the static env-derived capabilities.
 */
export function withModuleCapabilities(
  capabilities: AuthenticatedCapabilities | undefined,
  moduleValues: Partial<Record<ModuleCapabilityField, boolean>>,
): AuthenticatedCapabilities {
  const base = capabilities ?? DEFAULT_CAPABILITIES;
  const definedValues = Object.fromEntries(
    Object.entries(moduleValues).filter(([, value]) => value !== undefined),
  ) as Partial<Record<ModuleCapabilityField, boolean>>;
  return { ...base, ...definedValues };
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
