import type { AuthenticatedCapabilities } from '../capabilities/types.js';

export const MODULE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{1,31}$/;

/**
 * Required boolean capability fields on `AuthenticatedCapabilities` that can be
 * backed by an installation module entry (optional flags such as
 * `duplicateCustomerComparison` are excluded).
 */
export type ModuleCapabilityField = {
  [K in keyof AuthenticatedCapabilities]-?: {} extends Pick<AuthenticatedCapabilities, K>
    ? never
    : AuthenticatedCapabilities[K] extends boolean
      ? K
      : never;
}[keyof AuthenticatedCapabilities];

/**
 * Compile-time registry of the modules an installation operator may switch
 * (MOD-002 / R0). Deliberately minimal: no prerequisites, dependency graph,
 * worker hooks, menu metadata or dynamic loading. Each later module needs its
 * own slice and contract.
 */
export type InstallationModuleDescriptor = Readonly<{
  key: string;
  /** Turkish operator-facing label. */
  label: string;
  /** Turkish operator-facing description. */
  description: string;
  /** The `user.capabilities` field this module drives. */
  capability: ModuleCapabilityField;
  /** Legacy env key; read once as the takeover source, or null for fresh-install modules. */
  legacyEnvKey: string | null;
  /** Turkish bullet points describing what turns off when disabled. */
  whenDisabled: readonly string[];
  /** Turkish bullet points describing what data/behavior is preserved when disabled. */
  preserved: readonly string[];
}>;

export const INSTALLATION_MODULES = [
  {
    key: 'OVERVIEW',
    label: 'Genel Bakış',
    description:
      'Dönem özeti, onay kuyruğu, yaklaşan ve tamamlanan işleri tek ekranda gösteren başlangıç sayfası.',
    capability: 'overviewDashboard',
    legacyEnvKey: 'OVERVIEW_DASHBOARD_ENABLED',
    whenDisabled: [
      'Genel Bakış menüsü ve sayfası',
      "Genel Bakış'ın açılış sayfası olarak kullanılması",
    ],
    preserved: [
      'İşler, onaylar ve raporlar',
      'Geçmiş kayıtlar ve audit kayıtları',
    ],
  },
] as const satisfies readonly InstallationModuleDescriptor[];

export type InstallationModuleKey = (typeof INSTALLATION_MODULES)[number]['key'];
export type InstallationModuleEntry = (typeof INSTALLATION_MODULES)[number];

export function findInstallationModule(key: string): InstallationModuleEntry | undefined {
  return INSTALLATION_MODULES.find((module) => module.key === key);
}
