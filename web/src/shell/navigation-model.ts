import { paths } from '../paths';
import type { CurrentUser } from '../services/api';

export type NavLinkItem = {
  kind: 'link';
  id: string;
  label: string;
  to: string;
  section: 'Operasyon' | 'Analiz' | 'Ekip' | 'Destek' | 'Hesap';
};

export type NavMenuItem = {
  kind: 'menu';
  id: 'menu';
  label: string;
};

export type BottomNavItem = NavLinkItem | NavMenuItem;

export type NavigationModel = {
  /** Full destination list for sidebar + full drawer body. */
  destinations: NavLinkItem[];
  /** High-frequency mobile bottom destinations. */
  bottom: BottomNavItem[];
  /** Lower-frequency items for bottom-nav Menü overflow drawer. */
  overflow: NavLinkItem[];
};

/**
 * Single navigation SSOT for sidebar, drawer, bottom nav, and overflow.
 * Do not duplicate role lists in shell components.
 */
export function buildNavigationModel(user: CurrentUser): NavigationModel {
  const overview: NavLinkItem = { kind: 'link', id: 'overview', label: 'Genel Bakış', to: paths.overview, section: 'Operasyon' };
  const jobs: NavLinkItem = { kind: 'link', id: 'jobs', label: 'İşler', to: paths.jobs, section: 'Operasyon' };
  const calendar: NavLinkItem = { kind: 'link', id: 'calendar', label: 'Takvim', to: paths.calendar, section: 'Operasyon' };
  const customers: NavLinkItem = { kind: 'link', id: 'customers', label: 'Müşteriler', to: paths.customers, section: 'Operasyon' };
  const products: NavLinkItem = { kind: 'link', id: 'products', label: 'Ürünler', to: paths.products, section: 'Operasyon' };
  const reports: NavLinkItem = { kind: 'link', id: 'reports', label: 'Raporlar', to: paths.reports, section: 'Analiz' };
  const users: NavLinkItem = { kind: 'link', id: 'users', label: 'Kullanıcılar', to: paths.users, section: 'Ekip' };
  const staff: NavLinkItem = {
    kind: 'link',
    id: 'staff',
    label: user.role === 'STAFF' ? 'Profilim' : 'Personel',
    to: paths.staff,
    section: 'Ekip',
  };
  const docs: NavLinkItem = { kind: 'link', id: 'docs', label: 'Dokümantasyon', to: paths.docs, section: 'Destek' };
  const help: NavLinkItem = { kind: 'link', id: 'help', label: 'Yardım Merkezi', to: paths.help, section: 'Destek' };
  const settings: NavLinkItem = { kind: 'link', id: 'settings', label: 'Ayarlar', to: paths.settings, section: 'Hesap' };

  const destinations: NavLinkItem[] = [
    ...(user.capabilities?.overviewDashboard ? [overview] : []),
    jobs,
    ...(user.capabilities?.calendar ? [calendar] : []),
    customers,
    products,
    ...(user.role !== 'STAFF' ? [reports] : []),
    ...(user.role === 'ADMIN' ? [users] : []),
    staff,
    docs,
    help,
    settings,
  ];

  if (user.role === 'STAFF') {
    const direct = user.capabilities?.overviewDashboard
      ? [overview, jobs, ...(user.capabilities?.calendar ? [calendar] : [customers])]
      : [jobs, customers, products];
    const directIds = new Set(direct.map((item) => item.id));
    return {
      destinations,
      bottom: [...direct, { kind: 'menu', id: 'menu', label: 'Menü' }],
      overflow: destinations.filter((item) => !directIds.has(item.id)),
    };
  }

  const direct = user.capabilities?.overviewDashboard
    ? [overview, jobs, ...(user.capabilities?.calendar ? [calendar] : [reports])]
    : [jobs, customers, reports];
  const directIds = new Set(direct.map((item) => item.id));
  const overflow = destinations.filter((item) => !directIds.has(item.id));

  return {
    destinations,
    bottom: [
      ...direct,
      { kind: 'menu', id: 'menu', label: 'Menü' },
    ],
    overflow,
  };
}

/** Section title for the single mobile top bar (not a second page h1). */
export function resolveShellTitle(pathname: string, role: CurrentUser['role']): string {
  if (pathname.startsWith('/overview')) return 'Genel Bakış';
  if (pathname.startsWith('/calendar')) return 'Takvim';
  if (pathname.startsWith('/docs')) return 'Dokümantasyon';
  if (pathname.startsWith('/help')) return 'Yardım Merkezi';
  if (pathname.startsWith('/settings')) return 'Ayarlar';
  if (pathname.startsWith('/jobs/new-')) return 'Yeni iş';
  if (/^\/jobs\/[^/]+/.test(pathname)) return 'İş detayı';
  if (pathname.startsWith('/jobs')) return role === 'STAFF' ? 'İşlerim' : 'İşler';
  if (pathname.startsWith('/customers/new')) return 'Yeni müşteri';
  if (/^\/customers\/[^/]+\/contacts\//.test(pathname)) return 'İlgili kişi';
  if (/^\/customers\/[^/]+/.test(pathname)) return 'Müşteri';
  if (pathname.startsWith('/customers')) return 'Müşteriler';
  if (pathname.startsWith('/products/new')) return 'Yeni ürün';
  if (/^\/products\/[^/]+/.test(pathname)) return 'Ürün';
  if (pathname.startsWith('/products')) return 'Ürünler';
  if (pathname.startsWith('/reports')) return 'Raporlar';
  if (pathname.startsWith('/users/new')) return 'Yeni kullanıcı';
  if (/^\/users\/[^/]+/.test(pathname)) return 'Kullanıcı';
  if (pathname.startsWith('/users')) return 'Kullanıcılar';
  if (/^\/staff\/[^/]+\/reports/.test(pathname)) return 'Personel raporu';
  if (/^\/staff\/[^/]+/.test(pathname)) return role === 'STAFF' ? 'Profilim' : 'Personel profili';
  if (pathname.startsWith('/staff') && role === 'STAFF') return 'Profilim';
  if (pathname.startsWith('/staff')) return 'Personel';
  return 'Dünya Dental';
}

/** Parent path for nested routes; null on top-level sections. */
export function resolveShellBackTo(pathname: string): string | null {
  if (pathname.startsWith('/jobs/new-') || /^\/jobs\/[^/]+/.test(pathname)) return paths.jobs;

  const contactMatch = pathname.match(/^\/customers\/([^/]+)\/contacts\//);
  if (contactMatch) return paths.customer(contactMatch[1]!);

  if (pathname === paths.newCustomer) return paths.customers;
  if (/^\/customers\/[^/]+/.test(pathname)) return paths.customers;

  if (pathname === paths.newProduct || /^\/products\/[^/]+/.test(pathname)) return paths.products;

  if (pathname === paths.newUser || /^\/users\/[^/]+/.test(pathname)) return paths.users;

  const staffReportMatch = pathname.match(/^\/staff\/([^/]+)\/reports/);
  if (staffReportMatch) return paths.staffProfile(staffReportMatch[1]!);

  if (/^\/staff\/[^/]+/.test(pathname)) return paths.staff;

  return null;
}

export function isJobsListPath(pathname: string): boolean {
  return pathname === paths.jobs || pathname === '/jobs/';
}
