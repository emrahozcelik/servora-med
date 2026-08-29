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
      demoDatasetCreation,
    },
    support: support ?? DEFAULT_SUPPORT,
  };
}
