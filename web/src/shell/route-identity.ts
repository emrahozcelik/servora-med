import { paths } from '../paths';

/**
 * Canonical static route identity (Slice 3A foundation, DESIGN.md normative).
 *
 * The registry owns ONLY identity facts: stable id, generic fallback title,
 * deterministic hierarchy parent, and param-aware parent location. It owns
 * no authorization, no role logic, no home policy, no actions, no tabs, no
 * filters, and no loading/business state. URL templates live in paths.ts;
 * parentLocation builders call those builders instead of duplicating them.
 */
export type RouteId =
  | 'overview' | 'calendar' | 'messages' | 'jobs'
  | 'jobCreateDelivery' | 'jobCreateTask' | 'jobCreateMeeting' | 'jobCreateWeeklyReport' | 'followUpCreate' | 'jobDetail'
  | 'customers' | 'customerCreate' | 'customerDetail' | 'contactDetail'
  | 'products' | 'productCreate' | 'productDetail'
  | 'reports' | 'reportStaff' | 'reportCustomers' | 'reportDeliveries' | 'reportApprovals' | 'reportSalesFollowUp'
  | 'users' | 'userCreate' | 'userDetail'
  | 'staff' | 'staffProfile' | 'staffReport'
  | 'settings' | 'settingsProfile' | 'settingsSecurity' | 'settingsNotifications' | 'settingsApplication'
  | 'settingsDataManagement' | 'settingsDemoData' | 'settingsBackupRecovery'
  | 'docs' | 'help';

export type ShellSection = 'Operasyon' | 'Analiz' | 'Ekip' | 'Destek' | 'Hesap';

/** Matched route params captured during identity resolution (plain strings only). */
export type RouteParams = Record<string, string>;

export type RouteIdentity = {
  id: RouteId;
  /** Generic fallback title; also the document-title fallback before any runtime label. */
  title: string;
  /** Deterministic hierarchy parent; null only at roots. */
  parentId: RouteId | null;
  /** Authenticated-shell section; omitted on shell-external/fallback routes. */
  section?: ShellSection;
  /**
   * Builds the concrete parent URL from current matched params by calling
   * canonical paths.ts builders. Omitted when the parent URL needs no params.
   * Returns null when params are insufficient (caller falls back up the chain).
   */
  parentLocation?: (params: RouteParams) => string | null;
};

type IdentityRecord = Omit<RouteIdentity, 'id'>;

const IDENTITIES: Record<RouteId, IdentityRecord> = {
  overview: { title: 'Genel Bakış', parentId: null, section: 'Operasyon' },
  calendar: { title: 'Takvim', parentId: null, section: 'Operasyon' },
  messages: { title: 'Mesajlar', parentId: null, section: 'Operasyon' },
  jobs: { title: 'İşler', parentId: null, section: 'Operasyon' },
  jobCreateDelivery: { title: 'Yeni iş', parentId: 'jobs', section: 'Operasyon' },
  jobCreateTask: { title: 'Yeni iş', parentId: 'jobs', section: 'Operasyon' },
  jobCreateMeeting: { title: 'Yeni iş', parentId: 'jobs', section: 'Operasyon' },
  jobCreateWeeklyReport: { title: 'Yeni iş', parentId: 'jobs', section: 'Operasyon' },
  followUpCreate: { title: 'Yeni iş', parentId: 'jobs', section: 'Operasyon' },
  jobDetail: { title: 'İş detayı', parentId: 'jobs', section: 'Operasyon' },
  customers: { title: 'Müşteriler', parentId: null, section: 'Operasyon' },
  customerCreate: { title: 'Yeni müşteri', parentId: 'customers', section: 'Operasyon' },
  customerDetail: { title: 'Müşteri', parentId: 'customers', section: 'Operasyon' },
  contactDetail: {
    title: 'İlgili kişi', parentId: 'customerDetail', section: 'Operasyon',
    parentLocation: (params) => (params.customerId ? paths.customer(params.customerId) : null),
  },
  products: { title: 'Ürünler', parentId: null, section: 'Operasyon' },
  productCreate: { title: 'Yeni ürün', parentId: 'products', section: 'Operasyon' },
  productDetail: { title: 'Ürün', parentId: 'products', section: 'Operasyon' },
  reports: { title: 'Raporlar', parentId: null, section: 'Analiz' },
  reportStaff: { title: 'Personel Operasyon Analizi', parentId: 'reports', section: 'Analiz' },
  reportCustomers: { title: 'Müşteri operasyon aktivitesi', parentId: 'reports', section: 'Analiz' },
  reportDeliveries: { title: 'Teslim raporu', parentId: 'reports', section: 'Analiz' },
  reportApprovals: { title: 'Onay kuyruğu', parentId: 'reports', section: 'Analiz' },
  reportSalesFollowUp: { title: 'Satış ve Takip Operasyon Analizi', parentId: 'reports', section: 'Analiz' },
  users: { title: 'Kullanıcılar', parentId: null, section: 'Ekip' },
  userCreate: { title: 'Yeni kullanıcı', parentId: 'users', section: 'Ekip' },
  userDetail: { title: 'Kullanıcı', parentId: 'users', section: 'Ekip' },
  staff: { title: 'Personel', parentId: null, section: 'Ekip' },
  staffProfile: { title: 'Personel profili', parentId: 'staff', section: 'Ekip' },
  staffReport: {
    title: 'Personel raporu', parentId: 'staffProfile', section: 'Ekip',
    parentLocation: (params) => (params.staffUserId ? paths.staffProfile(params.staffUserId) : null),
  },
  settings: { title: 'Ayarlar', parentId: null, section: 'Hesap' },
  settingsProfile: { title: 'Profil', parentId: 'settings', section: 'Hesap' },
  settingsSecurity: { title: 'Güvenlik', parentId: 'settings', section: 'Hesap' },
  settingsNotifications: { title: 'Bildirimler', parentId: 'settings', section: 'Hesap' },
  settingsApplication: { title: 'Uygulama', parentId: 'settings', section: 'Hesap' },
  settingsDataManagement: { title: 'Veri Yönetimi', parentId: 'settings', section: 'Hesap' },
  settingsDemoData: { title: 'Demo verileri', parentId: 'settingsDataManagement', section: 'Hesap' },
  settingsBackupRecovery: { title: 'Yedekleme ve Kurtarma', parentId: 'settingsDataManagement', section: 'Hesap' },
  docs: { title: 'Dokümantasyon', parentId: null, section: 'Destek' },
  help: { title: 'Yardım Merkezi', parentId: null, section: 'Destek' },
};

export function getRouteIdentity(id: RouteId): RouteIdentity {
  return { id, ...IDENTITIES[id] };
}

export function routeIdentityIds(): RouteId[] {
  return Object.keys(IDENTITIES) as RouteId[];
}

export type RouteMatch = {
  identity: RouteIdentity;
  params: RouteParams;
};

type RoutePattern = {
  id: RouteId;
  test: (pathname: string) => RouteParams | null;
};

const matchExact = (path: string) => (pathname: string): RouteParams | null =>
  (pathname === path || pathname === `${path}/` ? {} : null);

const matchParam = (pattern: RegExp, names: string[]) => (pathname: string): RouteParams | null => {
  const match = pathname.match(pattern);
  if (!match) return null;
  const params: RouteParams = {};
  names.forEach((name, index) => {
    const value = match[index + 1];
    if (value) {
      try {
        params[name] = decodeURIComponent(value);
      } catch {
        params[name] = value;
      }
    }
  });
  return params;
};

/**
 * Ordered route patterns; first match wins. Order mirrors the previous
 * resolver precedence (specific nested routes before their parents).
 */
const PATTERNS: RoutePattern[] = [
  { id: 'overview', test: matchExact(paths.overview) },
  { id: 'calendar', test: matchExact(paths.calendar) },
  { id: 'messages', test: matchExact(paths.messages) },
  { id: 'docs', test: matchExact(paths.docs) },
  { id: 'help', test: matchExact(paths.help) },
  { id: 'settingsDemoData', test: matchExact(paths.settingsDemoData) },
  { id: 'settingsBackupRecovery', test: matchExact(paths.settingsBackupRecovery) },
  { id: 'settingsDataManagement', test: matchExact(paths.settingsDataManagement) },
  { id: 'settingsProfile', test: matchExact(paths.settingsProfile) },
  { id: 'settingsSecurity', test: matchExact(paths.settingsSecurity) },
  { id: 'settingsNotifications', test: matchExact(paths.settingsNotifications) },
  { id: 'settingsApplication', test: matchExact(paths.settingsApplication) },
  { id: 'settings', test: matchExact(paths.settings) },
  { id: 'jobCreateDelivery', test: matchExact(paths.newDelivery) },
  { id: 'jobCreateTask', test: matchExact(paths.newTask) },
  { id: 'jobCreateMeeting', test: matchExact(paths.newMeeting) },
  { id: 'jobCreateWeeklyReport', test: matchExact(paths.newWeeklyReport) },
  { id: 'followUpCreate', test: matchExact('/jobs/new-follow-up') },
  { id: 'jobDetail', test: matchParam(/^\/jobs\/([^/]+)\/?$/, ['jobCardId']) },
  { id: 'jobs', test: matchExact(paths.jobs) },
  { id: 'customerCreate', test: matchExact(paths.newCustomer) },
  { id: 'contactDetail', test: matchParam(/^\/customers\/([^/]+)\/contacts\/([^/]+)\/?$/, ['customerId', 'contactId']) },
  { id: 'customerDetail', test: matchParam(/^\/customers\/([^/]+)\/?$/, ['customerId']) },
  { id: 'customers', test: matchExact(paths.customers) },
  { id: 'productCreate', test: matchExact(paths.newProduct) },
  { id: 'productDetail', test: matchParam(/^\/products\/([^/]+)\/?$/, ['productId']) },
  { id: 'products', test: matchExact(paths.products) },
  { id: 'reportStaff', test: matchExact(paths.staffPerformanceReports) },
  { id: 'reportCustomers', test: matchExact(paths.customerReports) },
  { id: 'reportDeliveries', test: matchExact(paths.deliveryReports) },
  { id: 'reportApprovals', test: matchExact(paths.approvalReports) },
  { id: 'reportSalesFollowUp', test: matchExact(paths.salesFollowUpReports) },
  { id: 'reports', test: matchExact(paths.reports) },
  { id: 'userCreate', test: matchExact(paths.newUser) },
  { id: 'userDetail', test: matchParam(/^\/users\/([^/]+)\/?$/, ['userId']) },
  { id: 'users', test: matchExact(paths.users) },
  { id: 'staffReport', test: matchParam(/^\/staff\/([^/]+)\/reports\/?$/, ['staffUserId']) },
  { id: 'staffProfile', test: matchParam(/^\/staff\/([^/]+)\/?$/, ['staffUserId']) },
  { id: 'staff', test: matchExact(paths.staff) },
];

/** Resolves a pathname to its static route identity plus captured params. Null when unknown. */
export function matchRouteIdentity(pathname: string): RouteMatch | null {
  for (const pattern of PATTERNS) {
    const params = pattern.test(pathname);
    if (params) return { identity: getRouteIdentity(pattern.id), params };
  }
  return null;
}

/**
 * Canonical URL for an identity, reusing paths.ts builders (never duplicated
 * templates). Dynamic patterns require their params; null when unresolvable.
 */
export function routePathForIdentity(id: RouteId, params: RouteParams): string | null {
  switch (id) {
    case 'overview': return paths.overview;
    case 'calendar': return paths.calendar;
    case 'messages': return paths.messages;
    case 'jobs': return paths.jobs;
    case 'jobCreateDelivery': return paths.newDelivery;
    case 'jobCreateTask': return paths.newTask;
    case 'jobCreateMeeting': return paths.newMeeting;
    case 'followUpCreate': return params.sourceJobCardId ? paths.followUpCreate(params.sourceJobCardId) : null;
    case 'jobDetail': return params.jobCardId ? paths.job(params.jobCardId) : null;
    case 'customers': return paths.customers;
    case 'customerCreate': return paths.newCustomer;
    case 'customerDetail': return params.customerId ? paths.customer(params.customerId) : null;
    case 'contactDetail':
      return params.customerId && params.contactId
        ? paths.contact(params.customerId, params.contactId) : null;
    case 'products': return paths.products;
    case 'productCreate': return paths.newProduct;
    case 'productDetail': return params.productId ? paths.product(params.productId) : null;
    case 'reports': return paths.reports;
    case 'reportStaff': return paths.staffPerformanceReports;
    case 'reportCustomers': return paths.customerReports;
    case 'reportDeliveries': return paths.deliveryReports;
    case 'reportApprovals': return paths.approvalReports;
    case 'reportSalesFollowUp': return paths.salesFollowUpReports;
    case 'users': return paths.users;
    case 'userCreate': return paths.newUser;
    case 'userDetail': return params.userId ? paths.user(params.userId) : null;
    case 'staff': return paths.staff;
    case 'staffProfile': return params.staffUserId ? paths.staffProfile(params.staffUserId) : null;
    case 'staffReport': return params.staffUserId ? paths.staffReport(params.staffUserId) : null;
    case 'settings': return paths.settings;
    case 'settingsProfile': return paths.settingsProfile;
    case 'settingsSecurity': return paths.settingsSecurity;
    case 'settingsNotifications': return paths.settingsNotifications;
    case 'settingsApplication': return paths.settingsApplication;
    case 'settingsDataManagement': return paths.settingsDataManagement;
    case 'settingsDemoData': return paths.settingsDemoData;
    case 'settingsBackupRecovery': return paths.settingsBackupRecovery;
    case 'docs': return paths.docs;
    case 'help': return paths.help;
    default: return null;
  }
}

/**
 * Deterministic hierarchy-parent URL for a matched route. Param-aware parents
 * use the identity's parentLocation builder; static parents resolve through
 * paths.ts builders. Null on roots and when params are insufficient.
 */
export function resolveParentPath(identity: RouteIdentity, params: RouteParams): string | null {
  if (!identity.parentId) return null;
  if (identity.parentLocation) return identity.parentLocation(params);
  return routePathForIdentity(identity.parentId, params);
}

/** Follows parent links to the root; used to prove chains terminate without cycles. */
export function parentChain(id: RouteId): RouteId[] {
  const chain: RouteId[] = [];
  const seen = new Set<RouteId>();
  let current: RouteId | null = id;
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    chain.push(current);
    current = IDENTITIES[current].parentId;
  }
  return chain;
}
