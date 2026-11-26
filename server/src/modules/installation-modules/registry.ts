/**
 * Compile-time registry of the modules an installation operator may switch
 * (MOD-002). Deliberately minimal: no prerequisites, dependency graph, worker
 * hooks, menu metadata or dynamic loading. Each later module needs its own
 * slice and contract.
 */
export type InstallationModuleDescriptor = Readonly<{
  key: 'OVERVIEW';
  /** Turkish operator-facing label. */
  label: string;
  /** The `user.capabilities` field this module drives. */
  capability: 'overviewDashboard';
  /** Legacy env key; read once as the takeover source. */
  legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED';
}>;

export const INSTALLATION_MODULES = [
  {
    key: 'OVERVIEW',
    label: 'Genel Bakış',
    capability: 'overviewDashboard',
    legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED',
  },
] as const satisfies readonly InstallationModuleDescriptor[];

export type InstallationModuleKey = (typeof INSTALLATION_MODULES)[number]['key'];

export function findInstallationModule(key: string): InstallationModuleDescriptor | undefined {
  return INSTALLATION_MODULES.find((module) => module.key === key);
}
