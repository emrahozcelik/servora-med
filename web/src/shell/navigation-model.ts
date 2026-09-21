import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import { matchRouteIdentity, resolveParentPath, type RouteIdentity } from './route-identity';

export type NavLinkItem = {
  kind: 'link';
  id: string;
  label: string;
  /** Optional shorter label for tight mobile bottom-nav slots. Falls back to label. */
  shortLabel?: string;
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
  const overview: NavLinkItem = { kind: 'link', id: 'overview', label: 'Genel Bakış', shortLabel: 'Bakış', to: paths.overview, section: 'Operasyon' };
  const jobs: NavLinkItem = { kind: 'link', id: 'jobs', label: 'İşler', to: paths.jobs, section: 'Operasyon' };
  const calendar: NavLinkItem = { kind: 'link', id: 'calendar', label: 'Takvim', to: paths.calendar, section: 'Operasyon' };
  const messages: NavLinkItem = { kind: 'link', id: 'messages', label: 'Mesajlar', shortLabel: 'Mesaj', to: paths.messages, section: 'Operasyon' };
  const customers: NavLinkItem = { kind: 'link', id: 'customers', label: 'Müşteriler', shortLabel: 'Müşt.', to: paths.customers, section: 'Operasyon' };
  const products: NavLinkItem = { kind: 'link', id: 'products', label: 'Ürünler', shortLabel: 'Ürün.', to: paths.products, section: 'Operasyon' };
  const reports: NavLinkItem = { kind: 'link', id: 'reports', label: 'Raporlar', shortLabel: 'Rapor', to: paths.reports, section: 'Analiz' };
  const users: NavLinkItem = { kind: 'link', id: 'users', label: 'Kullanıcılar', shortLabel: 'Kull.', to: paths.users, section: 'Ekip' };
  const staff: NavLinkItem = {
    kind: 'link',
    id: 'staff',
    label: user.role === 'STAFF' ? 'Profilim' : 'Personel',
    shortLabel: user.role === 'STAFF' ? 'Profil' : 'Pers.',
    to: paths.staff,
    section: 'Ekip',
  };
  const docs: NavLinkItem = { kind: 'link', id: 'docs', label: 'Dokümantasyon', to: paths.docs, section: 'Destek' };
  const help: NavLinkItem = { kind: 'link', id: 'help', label: 'Yardım Merkezi', to: paths.help, section: 'Destek' };
  const settings: NavLinkItem = { kind: 'link', id: 'settings', label: 'Ayarlar', to: paths.settings, section: 'Hesap' };
  const backupRecovery: NavLinkItem = {
    kind: 'link',
    id: 'backup-recovery',
    label: 'Yedekleme ve Kurtarma',
    to: paths.settingsBackupRecovery,
    section: 'Hesap',
  };

  const destinations: NavLinkItem[] = [
    ...(user.capabilities?.overviewDashboard ? [overview] : []),
    jobs,
    ...(user.capabilities?.calendar ? [calendar] : []),
    ...(user.capabilities?.messaging ? [messages] : []),
    customers,
    products,
    ...(user.role !== 'STAFF' ? [reports] : []),
    ...(user.role === 'ADMIN' ? [users] : []),
    staff,
    docs,
    help,
    settings,
    ...(user.role === 'ADMIN' && user.capabilities?.backup === true ? [backupRecovery] : []),
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

/**
 * Role-aware display title for a static identity. Role presentation lives
 * here in the navigation layer — never in the identity registry. Covers
 * exactly the two pre-existing role variants (jobs list, staff area).
 */
export function resolveIdentityTitle(identity: RouteIdentity, role: CurrentUser['role']): string {
  if (identity.id === 'jobs' && role === 'STAFF') return 'İşlerim';
  if ((identity.id === 'staff' || identity.id === 'staffProfile') && role === 'STAFF') return 'Profilim';
  return identity.title;
}

/**
 * Section title for the single mobile top bar (not a second page h1).
 *
 * TRANSITIONAL (Slice 3A): thin compatibility adapter over the canonical
 * route-identity registry. There is no independent title if-chain anymore;
 * full ReturnLink/breadcrumb migration happens in Slice 3B.
 */
export function resolveShellTitle(pathname: string, role: CurrentUser['role']): string {
  const match = matchRouteIdentity(pathname);
  if (!match) return 'Dünya Dental';
  return resolveIdentityTitle(match.identity, role);
}

/**
 * Parent path for nested routes; null on top-level sections.
 *
 * TRANSITIONAL (Slice 3A): derives from the canonical identity hierarchy
 * instead of a duplicate if-chain. Visible behavior is unchanged: routes
 * that historically exposed no shell back target keep null until Slice 3B
 * migrates them to breadcrumb/ReturnLink coverage (see BACK_TO_SUPPRESSED).
 */
export function resolveShellBackTo(pathname: string): string | null {
  const match = matchRouteIdentity(pathname);
  if (!match) return null;
  if (BACK_TO_SUPPRESSED.has(match.identity.id)) return null;
  return resolveParentPath(match.identity, match.params);
}

/**
 * Nested identities whose hierarchy parent is modeled (for breadcrumbs in
 * 3B) but whose legacy shell surface exposed no back target. Slice 3B
 * deletes this set when breadcrumb/ReturnLink coverage lands; do not extend.
 */
const BACK_TO_SUPPRESSED: ReadonlySet<RouteIdentity['id']> = new Set([
  'settingsProfile',
  'settingsSecurity',
  'settingsNotifications',
  'settingsApplication',
  'reportStaff',
  'reportCustomers',
  'reportDeliveries',
  'reportApprovals',
  'reportSalesFollowUp',
]);

export function isJobsListPath(pathname: string): boolean {
  return pathname === paths.jobs || pathname === '/jobs/';
}
