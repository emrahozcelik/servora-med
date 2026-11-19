import { paths } from '../paths';
import type { CurrentUser } from '../services/api';
import type { RouteIdentity } from './route-identity';

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

/** Centered mobile create action; opens the NewJobMenu sheet (DECISIONS.md UI-004). */
export type NavCreateItem = {
  kind: 'create';
  id: 'new-job';
  label: string;
};

export type BottomNavItem = NavLinkItem | NavMenuItem | NavCreateItem;

export type NavGroupLabel = NavLinkItem['section'] | 'Çalışma' | 'Hesap ve destek';

export type NavGroup = {
  label: NavGroupLabel;
  items: NavLinkItem[];
};

export type NavigationModel = {
  /** Full destination list for sidebar + single mobile menu panel. */
  destinations: NavLinkItem[];
  /** Mobile bottom destinations, the centered create action, and one Menü control. */
  bottom: BottomNavItem[];
};

/** Mobile menu panel group for every destination section (UI-004). */
const menuGroupBySection: Record<NavLinkItem['section'], 'Çalışma' | 'Hesap ve destek'> = {
  Operasyon: 'Çalışma',
  Analiz: 'Çalışma',
  Ekip: 'Çalışma',
  Destek: 'Hesap ve destek',
  Hesap: 'Hesap ve destek',
};

/** At most three direct links: with the create action and Menü that is five slots. */
const mobileDirectLimit = 3;

/**
 * Single navigation SSOT for sidebar, menu panel, and bottom nav.
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

  const direct = user.role === 'STAFF'
    ? (user.capabilities?.overviewDashboard
      ? [overview, jobs, ...(user.capabilities?.calendar ? [calendar] : [customers])]
      : [jobs, customers, products])
    : (user.capabilities?.overviewDashboard
      ? [overview, jobs, ...(user.capabilities?.calendar ? [calendar] : [reports])]
      : [jobs, customers, reports]);

  return {
    destinations,
    bottom: buildBottomNavItems(direct.slice(0, mobileDirectLimit)),
  };
}

/**
 * Place the create action in the middle slot so it is centered under the
 * thumb, with Menü last (UI-004: at most five slots).
 */
function buildBottomNavItems(direct: NavLinkItem[]): BottomNavItem[] {
  const leftCount = Math.ceil(direct.length / 2);
  return [
    ...direct.slice(0, leftCount),
    { kind: 'create', id: 'new-job', label: 'Yeni iş' },
    ...direct.slice(leftCount),
    { kind: 'menu', id: 'menu', label: 'Menü' },
  ];
}

/** Sidebar grouping: the five destination sections in model order. */
export function groupNavigationBySection(destinations: NavLinkItem[]): NavGroup[] {
  return groupDestinations(destinations, (item) => item.section);
}

/** Mobile menu panel grouping: operational work first, then account and support (UI-004). */
export function groupNavigationForMenu(destinations: NavLinkItem[]): NavGroup[] {
  return groupDestinations(destinations, (item) => menuGroupBySection[item.section]);
}

function groupDestinations(
  destinations: NavLinkItem[],
  labelOf: (item: NavLinkItem) => NavGroupLabel,
): NavGroup[] {
  return destinations.reduce<NavGroup[]>((groups, destination) => {
    const label = labelOf(destination);
    const current = groups.find((group) => group.label === label);
    if (current) current.items.push(destination);
    else groups.push({ label, items: [destination] });
    return groups;
  }, []);
}

/**
 * Canonical authenticated landing policy shared by routing and shell links.
 * Overview is available only when the server grants its capability; every
 * other authenticated user lands on the Jobs workspace.
 */
export function resolveHomePath(user: CurrentUser): string {
  return user.capabilities?.overviewDashboard === true ? paths.overview : paths.jobs;
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
