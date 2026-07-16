import { paths } from '../paths';
import type { CurrentUser } from '../services/api';

export type NavLinkItem = {
  kind: 'link';
  id: string;
  label: string;
  to: string;
};

export type NavMenuItem = {
  kind: 'menu';
  id: 'menu';
  label: string;
};

export type BottomNavItem = NavLinkItem | NavMenuItem;

export type NavigationModel = {
  /** Full destination list for sidebar + drawer body. */
  destinations: NavLinkItem[];
  /** High-frequency mobile bottom destinations. */
  bottom: BottomNavItem[];
  /** Lower-frequency items intended for drawer overflow (beyond bottom). */
  overflow: NavLinkItem[];
};

/**
 * Single navigation SSOT for sidebar, drawer, bottom nav, and overflow.
 * Do not duplicate role lists in shell components.
 */
export function buildNavigationModel(user: CurrentUser): NavigationModel {
  const jobs: NavLinkItem = { kind: 'link', id: 'jobs', label: 'İşler', to: paths.jobs };
  const customers: NavLinkItem = { kind: 'link', id: 'customers', label: 'Müşteriler', to: paths.customers };
  const products: NavLinkItem = { kind: 'link', id: 'products', label: 'Ürünler', to: paths.products };
  const reports: NavLinkItem = { kind: 'link', id: 'reports', label: 'Raporlar', to: paths.reports };
  const users: NavLinkItem = { kind: 'link', id: 'users', label: 'Kullanıcılar', to: paths.users };
  const staff: NavLinkItem = {
    kind: 'link',
    id: 'staff',
    label: user.role === 'STAFF' ? 'Profilim' : 'Personel',
    to: paths.staff,
  };

  const destinations: NavLinkItem[] = [
    jobs,
    customers,
    products,
    ...(user.role !== 'STAFF' ? [reports] : []),
    ...(user.role === 'ADMIN' ? [users] : []),
    staff,
  ];

  if (user.role === 'STAFF') {
    return {
      destinations,
      bottom: [jobs, customers, products, staff],
      overflow: [],
    };
  }

  const overflow: NavLinkItem[] = [
    products,
    staff,
    ...(user.role === 'ADMIN' ? [users] : []),
  ];

  return {
    destinations,
    bottom: [
      jobs,
      customers,
      reports,
      { kind: 'menu', id: 'menu', label: 'Menü' },
    ],
    overflow,
  };
}

/** Section title for the single mobile top bar (not a second page h1). */
export function resolveShellTitle(pathname: string, role: CurrentUser['role']): string {
  if (pathname.startsWith('/jobs/new-')) return 'Yeni iş';
  if (/^\/jobs\/[^/]+/.test(pathname)) return 'İş detayı';
  if (pathname.startsWith('/jobs')) return role === 'STAFF' ? 'İşlerim' : 'İşler';
  if (pathname.startsWith('/customers/new')) return 'Yeni müşteri';
  if (/^\/customers\/[^/]+/.test(pathname)) return 'Müşteri';
  if (pathname.startsWith('/customers')) return 'Müşteriler';
  if (pathname.startsWith('/products/new')) return 'Yeni ürün';
  if (/^\/products\/[^/]+/.test(pathname)) return 'Ürün';
  if (pathname.startsWith('/products')) return 'Ürünler';
  if (pathname.startsWith('/reports')) return 'Raporlar';
  if (pathname.startsWith('/users')) return 'Kullanıcılar';
  if (pathname.startsWith('/staff') && role === 'STAFF') return 'Profilim';
  if (pathname.startsWith('/staff')) return 'Personel';
  return 'Servora-Med';
}

/** Parent list path for nested routes; null on top-level sections. */
export function resolveShellBackTo(pathname: string): string | null {
  if (pathname.startsWith('/jobs/new-') || /^\/jobs\/[^/]+/.test(pathname)) return paths.jobs;
  if (pathname === paths.newCustomer || /^\/customers\/[^/]+/.test(pathname)) return paths.customers;
  if (pathname === paths.newProduct || /^\/products\/[^/]+/.test(pathname)) return paths.products;
  if (/^\/staff\/[^/]+/.test(pathname)) return paths.staff;
  return null;
}

export function isJobsListPath(pathname: string): boolean {
  return pathname === paths.jobs || pathname === '/jobs/';
}
