import { describe, expect, it } from 'vitest';

import { paths } from '../src/paths';
import {
  getRouteIdentity,
  matchRouteIdentity,
  parentChain,
  resolveParentPath,
  routeIdentityIds,
  routePathForIdentity,
} from '../src/shell/route-identity';

describe('route identity registry', () => {
  it('resolves every canonical static path to an identity', () => {
    const staticPaths = [
      paths.overview, paths.calendar, paths.messages, paths.jobs,
      paths.newDelivery, paths.newTask, paths.newMeeting,
      paths.customers, paths.newCustomer,
      paths.products, paths.newProduct,
      paths.reports, paths.staffPerformanceReports, paths.customerReports,
      paths.deliveryReports, paths.approvalReports, paths.salesFollowUpReports,
      paths.users, paths.newUser,
      paths.staff,
      paths.settings, paths.settingsProfile, paths.settingsSecurity,
      paths.settingsNotifications, paths.settingsApplication,
      paths.settingsDataManagement, paths.settingsDemoData, paths.settingsBackupRecovery,
      paths.docs, paths.help,
    ];
    for (const path of staticPaths) {
      expect(matchRouteIdentity(path), path).not.toBeNull();
    }
  });

  it('gives distinct static settings and report routes distinct identities', () => {
    const ids = [
      '/settings/profile', '/settings/security',
      '/settings/notifications', '/settings/application',
      '/reports/staff', '/reports/customers', '/reports/deliveries',
      '/reports/approvals', '/reports/sales-follow-up',
    ].map((path) => matchRouteIdentity(path)?.identity.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('reportDetail');
    expect(ids).not.toContain('settingsSection');
  });

  it('shares one pattern identity across dynamic instances', () => {
    const first = matchRouteIdentity('/jobs/aaa');
    const second = matchRouteIdentity('/jobs/bbb');
    expect(first?.identity.id).toBe('jobDetail');
    expect(second?.identity.id).toBe('jobDetail');
    expect(first?.params).toEqual({ jobCardId: 'aaa' });
    expect(second?.params).toEqual({ jobCardId: 'bbb' });
  });

  it('terminates every parent chain at a root without cycles', () => {
    for (const id of routeIdentityIds()) {
      const chain = parentChain(id);
      const identity = getRouteIdentity(id);
      if (identity.parentId === null) {
        expect(chain).toEqual([id]);
      } else {
        expect(chain.length).toBeGreaterThan(1);
        const root = getRouteIdentity(chain[chain.length - 1]!);
        expect(root.parentId).toBeNull();
      }
      expect(new Set(chain).size).toBe(chain.length);
    }
  });

  it('keeps shell-external routes out of the section model', () => {
    expect(matchRouteIdentity('/login')).toBeNull();
    expect(matchRouteIdentity('/no-such-route')).toBeNull();
  });

  it('derives param-aware parent locations from paths.ts builders', () => {
    const contact = matchRouteIdentity('/customers/c1/contacts/k1');
    expect(contact?.identity.id).toBe('contactDetail');
    expect(resolveParentPath(contact!.identity, contact!.params)).toBe(paths.customer('c1'));

    const staffReport = matchRouteIdentity('/staff/s1/reports');
    expect(staffReport?.identity.id).toBe('staffReport');
    expect(resolveParentPath(staffReport!.identity, staffReport!.params)).toBe(paths.staffProfile('s1'));

    const job = matchRouteIdentity('/jobs/abc');
    expect(resolveParentPath(job!.identity, job!.params)).toBe(paths.jobs);

    const nested = matchRouteIdentity('/settings/data-management/demo-data');
    expect(nested?.identity.id).toBe('settingsDemoData');
    expect(resolveParentPath(nested!.identity, nested!.params)).toBe(paths.settings);
  });

  it('proves parent locations equal canonical builder outputs', () => {
    expect(routePathForIdentity('customerDetail', { customerId: 'c9' })).toBe(paths.customer('c9'));
    expect(routePathForIdentity('staffProfile', { staffUserId: 's9' })).toBe(paths.staffProfile('s9'));
    expect(routePathForIdentity('jobDetail', { jobCardId: 'j9' })).toBe(paths.job('j9'));
    expect(routePathForIdentity('settingsSecurity', {})).toBe(paths.settingsSecurity);
    expect(routePathForIdentity('reportStaff', {})).toBe(paths.staffPerformanceReports);
  });

  it('returns null parent paths on roots and on insufficient params', () => {
    expect(resolveParentPath(getRouteIdentity('jobs'), {})).toBeNull();
    expect(resolveParentPath(getRouteIdentity('contactDetail'), {})).toBeNull();
    expect(routePathForIdentity('jobDetail', {})).toBeNull();
  });
});
