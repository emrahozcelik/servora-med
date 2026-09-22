import { describe, expect, it } from 'vitest';

import {
  buildContextState,
  contextReturnHref,
  validateContextReturn,
} from '../src/shell/context-return';
import type { CurrentUser } from '../src/services/api';

const staff: CurrentUser = {
  id: 's1', organizationId: 'o1', name: 'A', email: 'a@b.c', role: 'STAFF',
  mustChangePassword: false, isActive: true, version: 1,
  capabilities: { overviewDashboard: false, calendar: true, messaging: false },
  support: { displayLabel: 'Destek', email: null, helpUrl: null },
};

const manager: CurrentUser = { ...staff, role: 'MANAGER', id: 'm1' };

describe('validateContextReturn', () => {
  it('accepts valid calendar context with query', () => {
    const valid = validateContextReturn(
      { from: { pathname: '/calendar', search: '?month=2026-09&view=agenda', hash: '' } },
      manager,
    );
    expect(valid?.pathname).toBe('/calendar');
    expect(valid?.search).toBe('?month=2026-09&view=agenda');
    expect(contextReturnHref(valid!)).toBe('/calendar?month=2026-09&view=agenda');
  });

  it('rejects external and protocol-relative targets', () => {
    expect(validateContextReturn({ from: { pathname: 'https://evil.example/x', search: '', hash: '' } }, manager)).toBeNull();
    expect(validateContextReturn({ from: { pathname: '//evil.example/x', search: '', hash: '' } }, manager)).toBeNull();
    expect(validateContextReturn({ from: { pathname: 'javascript:alert(1)', search: '', hash: '' } }, manager)).toBeNull();
  });

  it('rejects unknown internal paths', () => {
    expect(validateContextReturn({ from: { pathname: '/no-such-route', search: '', hash: '' } }, manager)).toBeNull();
    expect(validateContextReturn({ from: { pathname: '/jobs/a/b', search: '', hash: '' } }, manager)).toBeNull();
  });

  it('rejects malformed shapes without throwing', () => {
    expect(validateContextReturn(null, manager)).toBeNull();
    expect(validateContextReturn({ from: null }, manager)).toBeNull();
    expect(validateContextReturn({ from: { pathname: 123, search: '', hash: '' } }, manager)).toBeNull();
    expect(validateContextReturn({ from: { pathname: '/jobs', search: 123, hash: '' } }, manager)).toBeNull();
    expect(validateContextReturn({ from: { pathname: '/jobs', search: 'not-a-search', hash: '' } }, manager)).toBeNull();
  });

  it('rejects inaccessible known routes', () => {
    // STAFF cannot access reports; MANAGER can access calendar only with capability.
    expect(validateContextReturn({ from: { pathname: '/reports/staff', search: '', hash: '' } }, staff)).toBeNull();
    expect(validateContextReturn(
      { from: { pathname: '/calendar', search: '', hash: '' } },
      { ...staff, capabilities: { ...staff.capabilities, calendar: false } },
    )).toBeNull();
  });

  it('builds producer state only for internal locations', () => {
    expect(buildContextState({ pathname: '/calendar', search: '?month=2026-09', hash: '' })?.from.pathname).toBe('/calendar');
    expect(buildContextState({ pathname: 'https://evil.example', search: '', hash: '' })).toBeNull();
  });
});
