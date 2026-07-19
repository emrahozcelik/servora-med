import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const appRouterSource = readFileSync(
  new URL('../src/AppRouter.tsx', import.meta.url),
  'utf8',
);

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  scripts: Record<string, string>;
};

const ciWorkflow = readFileSync(
  new URL('../../.github/workflows/ci.yml', import.meta.url),
  'utf8',
);

const lazyModules = [
  './DeliveryCreate',
  './GeneralTaskCreate',
  './SalesMeetingCreate',
  './CustomerList',
  './CustomerDetail',
  './ContactManagement',
  './JobDetail',
  './StaffProfiles',
  './UserManagement',
  './ProductForm',
  './ProductDetail',
  './ProductList',
  './reports/StaffOperationalReport',
  './reports/ReportsDashboard',
  './reports/DeliveryReport',
  './reports/ApprovalReport',
] as const;

describe('route code-splitting contract', () => {
  it('keeps the primary jobs workspace eager', () => {
    expect(appRouterSource).toContain(
      "import { JobWorkspace } from './jobs/JobWorkspace';",
    );
  });

  it('lazy loads every non-primary route module', () => {
    for (const modulePath of lazyModules) {
      expect(appRouterSource).toContain(`import('${modulePath}')`);

      const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(appRouterSource).not.toMatch(
        new RegExp(`from\\s+['"]${escaped}['"]`),
      );
    }
  });

  it('uses one accessible Suspense fallback around the route tree', () => {
    expect(appRouterSource).toContain(
      '<Suspense fallback={<RouteLoading />}>',
    );
    expect(appRouterSource).toContain(
      'title="Sayfa yükleniyor"',
    );
    expect(appRouterSource).toContain(
      'headingLevel={1}',
    );
  });

  it('defines and runs the bundle budget in CI', () => {
    expect(packageJson.scripts['bundle:report']).toBe(
      'node scripts/report-bundle-sizes.mjs',
    );
    expect(packageJson.scripts['bundle:check']).toBe(
      'BUNDLE_ENFORCE=1 node scripts/report-bundle-sizes.mjs',
    );
    expect(ciWorkflow).toContain('- run: npm run bundle:check');
  });
});
