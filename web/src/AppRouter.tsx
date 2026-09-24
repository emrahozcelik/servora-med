import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { JobWorkspace } from './jobs/JobWorkspace';
import { paths } from './paths';
import { resolveHomePath } from './shell/navigation-model';
import { canAccessRoute } from './shell/route-access';
import { readStaffPerformanceSearch } from './reports/report-search';
import type { CurrentUser } from './services/api';
import { LoadingSkeleton } from './ui/antd/LoadingSkeleton';
import { ResultState } from './ui/antd/ResultState';

export { paths } from './paths';

const DeliveryCreateView = lazy(() =>
  import('./DeliveryCreate').then((module) => ({
    default: module.DeliveryCreateView,
  })),
);

const GeneralTaskCreateScreen = lazy(() =>
  import('./GeneralTaskCreate').then((module) => ({
    default: module.GeneralTaskCreateScreen,
  })),
);

const SalesMeetingCreateScreen = lazy(() =>
  import('./SalesMeetingCreate').then((module) => ({
    default: module.SalesMeetingCreateScreen,
  })),
);

const WeeklyReportCreateScreen = lazy(() =>
  import('./WeeklyReportCreate').then((module) => ({
    default: module.WeeklyReportCreateScreen,
  })),
);

const FollowUpCreatePage = lazy(() =>
  import('./jobs/FollowUpCreatePage').then((module) => ({
    default: module.FollowUpCreatePage,
  })),
);

const CustomerListScreen = lazy(() =>
  import('./CustomerList').then((module) => ({
    default: module.CustomerListScreen,
  })),
);

const CustomerCreateScreen = lazy(() =>
  import('./CustomerList').then((module) => ({
    default: module.CustomerCreateScreen,
  })),
);

const CustomerDetailScreen = lazy(() =>
  import('./CustomerDetail').then((module) => ({
    default: module.CustomerDetailScreen,
  })),
);

const ContactDetailScreen = lazy(() =>
  import('./ContactManagement').then((module) => ({
    default: module.ContactDetailScreen,
  })),
);

const JobDetailScreen = lazy(() =>
  import('./JobDetail').then((module) => ({
    default: module.JobDetailScreen,
  })),
);

const StaffProfilesScreen = lazy(() =>
  import('./StaffProfiles').then((module) => ({
    default: module.StaffProfilesScreen,
  })),
);

const UserListScreen = lazy(() =>
  import('./UserManagement').then((module) => ({
    default: module.UserListScreen,
  })),
);

const UserCreateScreen = lazy(() =>
  import('./UserManagement').then((module) => ({
    default: module.UserCreateScreen,
  })),
);

const UserDetailScreen = lazy(() =>
  import('./UserManagement').then((module) => ({
    default: module.UserDetailScreen,
  })),
);

const ProductCreateScreen = lazy(() =>
  import('./ProductForm').then((module) => ({
    default: module.ProductCreateScreen,
  })),
);

const ProductDetailScreen = lazy(() =>
  import('./ProductDetail').then((module) => ({
    default: module.ProductDetailScreen,
  })),
);

const ProductListScreen = lazy(() =>
  import('./ProductList').then((module) => ({
    default: module.ProductListScreen,
  })),
);

const StaffOperationalReportScreen = lazy(() =>
  import('./reports/StaffOperationalReport').then((module) => ({
    default: module.StaffOperationalReportScreen,
  })),
);

const ReportsDashboard = lazy(() =>
  import('./reports/ReportsDashboard').then((module) => ({
    default: module.ReportsDashboard,
  })),
);

const StaffPerformanceReport = lazy(() =>
  import('./reports/StaffPerformanceReport').then((module) => ({
    default: module.StaffPerformanceReport,
  })),
);

const DeliveryReport = lazy(() =>
  import('./reports/DeliveryReport').then((module) => ({
    default: module.DeliveryReport,
  })),
);

const ApprovalReport = lazy(() =>
  import('./reports/ApprovalReport').then((module) => ({
    default: module.ApprovalReport,
  })),
);

const CustomerReport = lazy(() =>
  import('./reports/CustomerReport').then((module) => ({
    default: module.CustomerReport,
  })),
);

const SalesFollowUpReport = lazy(() =>
  import('./reports/SalesFollowUpReport').then((module) => ({
    default: module.SalesFollowUpReport,
  })),
);

const OverviewPage = lazy(() =>
  import('./overview/OverviewPage').then((module) => ({ default: module.OverviewPage })),
);
const CalendarPage = lazy(() =>
  import('./calendar/CalendarPage').then((module) => ({ default: module.CalendarPage })),
);
const DocumentationPage = lazy(() =>
  import('./content/DocumentationPage').then((module) => ({ default: module.DocumentationPage })),
);
const HelpCenterPage = lazy(() =>
  import('./content/HelpCenterPage').then((module) => ({ default: module.HelpCenterPage })),
);
const SettingsLandingPage = lazy(() =>
  import('./settings/SettingsPages').then((module) => ({ default: module.SettingsLandingPage })),
);
const ProfileSettingsPage = lazy(() =>
  import('./settings/SettingsPages').then((module) => ({ default: module.ProfileSettingsPage })),
);
const SecuritySettingsPage = lazy(() =>
  import('./settings/SettingsPages').then((module) => ({ default: module.SecuritySettingsPage })),
);
const NotificationSettingsPage = lazy(() =>
  import('./settings/SettingsPages').then((module) => ({ default: module.NotificationSettingsPage })),
);
const ApplicationSettingsPage = lazy(() =>
  import('./settings/SettingsPages').then((module) => ({ default: module.ApplicationSettingsPage })),
);
const DataManagementPage = lazy(() =>
  import('./settings/DataManagementPage').then((module) => ({ default: module.DataManagementPage })),
);
const DemoDataPage = lazy(() =>
  import('./settings/DemoDataPage').then((module) => ({ default: module.DemoDataPage })),
);
const BackupRecoveryPage = lazy(() =>
  import('./settings/BackupRecoveryPage').then((module) => ({ default: module.BackupRecoveryPage })),
);

const MessagingPage = lazy(() =>
  import('./messaging/MessagingPage').then((module) => ({ default: module.MessagingPage })),
);

type AppRouterProps = {
  user: CurrentUser;
  notice: string;
  onClearNotice: () => void;
  onDeliveryCreated: () => void;
  onSessionEnded: () => void;
};

function ForbiddenView() {
  return (
    <main className="workspace">
      <ResultState
        status="403"
        title="Erişim yetkiniz yok"
        description="Bu alana erişim yetkiniz bulunmuyor. Yetkili olduğunuz alanlara dönebilirsiniz."
        action={<Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>}
      />
    </main>
  );
}

function NotFoundView() {
  return (
    <main className="workspace">
      <ResultState
        status="404"
        title="Sayfa bulunamadı"
        description="Bağlantı değişmiş veya sayfa kaldırılmış olabilir."
        action={<Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>}
      />
    </main>
  );
}

function JobDetailRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { jobCardId } = useParams();
  const navigate = useNavigate();
  if (!jobCardId) return <NotFoundView />;
  return <JobDetailScreen jobId={jobCardId} user={user}
    onCreateFollowUp={() => navigate(paths.followUpCreate(jobCardId))} onChanged={() => {}}
    onOpenMessaging={(conversationId) => navigate(`${paths.messages}?conversation=${encodeURIComponent(conversationId)}`)} />;
}

function StaffRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { staffUserId } = useParams();
  const navigate = useNavigate();
  if (staffUserId && !canAccessRoute('staffProfile', user, { staffUserId })) return <ForbiddenView />;
  return <StaffProfilesScreen user={user} initialStaffUserId={staffUserId}
    onOpenProfile={(id) => navigate(paths.staffProfile(id))} onProfileBack={() => navigate(paths.staff)}
    onOpenReport={(id) => navigate(paths.staffReport(id))} />;
}

function StaffReportRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { staffUserId } = useParams();
  const [search] = useSearchParams();
  const rangeState = readStaffPerformanceSearch(search);
  if (!canAccessRoute('staffReport', user)) return <ForbiddenView />;
  if (!staffUserId) return <NotFoundView />;
  const requestedRange = rangeState.from && rangeState.to
    ? { from: rangeState.from, to: rangeState.to }
    : null;
  return <StaffOperationalReportScreen staffUserId={staffUserId}
    requestedRange={requestedRange} />;
}

export function CustomerRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { customerId } = useParams();
  if (!customerId) return <NotFoundView />;
  return <CustomerDetailScreen key={customerId} customerId={customerId} user={user} />;
}

export function ContactRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { customerId, contactId } = useParams();
  if (!customerId || !contactId) return <NotFoundView />;
  return <ContactDetailScreen key={`${customerId}:${contactId}`} customerId={customerId} contactId={contactId} user={user} canManage={user.role !== 'STAFF'} />;
}

function ProductRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { productId } = useParams();
  if (!productId) return <NotFoundView />;
  return <ProductDetailScreen key={productId} productId={productId} user={user} />;
}

function RouteLoading() {
  return (
    <main className="workspace" data-route-loading="true">
      <LoadingSkeleton
        title="Sayfa yükleniyor"
        headingLevel={1}
        rows={4}
      />
    </main>
  );
}

function GeneralTaskCreateRoute({ user, navigate }: { user: CurrentUser; navigate: (path: string) => void }) {
  const [sp] = useSearchParams();
  return <GeneralTaskCreateScreen user={user}
    initialCustomerId={sp.get('customerId') ?? undefined}
    onCancel={() => navigate(paths.jobs)} onCreated={(id) => navigate(paths.job(id))} />;
}

function SalesMeetingCreateRoute({ user, navigate }: { user: CurrentUser; navigate: (path: string) => void }) {
  const [sp] = useSearchParams();
  return <SalesMeetingCreateScreen user={user}
    initialCustomerId={sp.get('customerId') ?? undefined}
    onCancel={() => navigate(paths.jobs)} onCreated={(id) => navigate(paths.job(id))} />;
}

function WeeklyReportCreateRoute({ user, navigate }: { user: CurrentUser; navigate: (path: string) => void }) {
  return <WeeklyReportCreateScreen user={user}
    onCancel={() => navigate(paths.jobs)} onCreated={(id) => navigate(paths.job(id))} />;
}

function DeliveryCreateRoute({ user, navigate, onDeliveryCreated }: {
  user: CurrentUser;
  navigate: (path: string) => void;
  onDeliveryCreated: () => void;
}) {
  const [sp] = useSearchParams();
  return <DeliveryCreateView user={user}
    initialCustomerId={sp.get('customerId') ?? undefined}
    onCancel={() => navigate(paths.jobs)}
    onCreated={() => { onDeliveryCreated(); navigate(paths.jobs); }} />;
}

export function FollowUpCreateRoute({ user, navigate }: {
  user: CurrentUser;
  navigate: (path: string) => void;
}) {
  const [sp] = useSearchParams();
  const sourceId = sp.get('source');
  if (!canAccessRoute('followUpCreate', user)) return <ForbiddenView />;
  if (!sourceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceId)) {
    return <main className="workspace"><ResultState status="error" title="Geçersiz takip bağlantısı"
      description="Takip işi oluşturmak için geçerli bir kaynak iş bağlantısı gerekir."
      action={<button className="secondary-button" type="button" onClick={() => navigate(paths.jobs)}>İşlere dön</button>}
    /></main>;
  }
  return <FollowUpCreatePage key={sourceId} sourceId={sourceId} user={user}
    onCancel={() => navigate(paths.job(sourceId))}
    onCreated={(jobCardId) => navigate(paths.job(jobCardId))} />;
}

export function AppRouter({ user, notice, onClearNotice, onDeliveryCreated, onSessionEnded }: AppRouterProps) {
  const navigate = useNavigate();
  const overviewAllowed = canAccessRoute('overview', user);
  const calendarAllowed = canAccessRoute('calendar', user);
  const messagingAllowed = canAccessRoute('messages', user);
  const landingPath = resolveHomePath(user);
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to={landingPath} replace />} />
        <Route path="/login" element={<Navigate to={landingPath} replace />} />
        <Route path={paths.overview} element={overviewAllowed
          ? <OverviewPage user={user} /> : <Navigate to={paths.jobs} replace />} />
        <Route path={paths.calendar} element={calendarAllowed
          ? <CalendarPage user={user} /> : <Navigate to={paths.jobs} replace />} />
        <Route path={paths.messages} element={messagingAllowed
          ? <MessagingPage user={user} /> : <Navigate to={paths.jobs} replace />} />
        <Route path={paths.docs} element={<DocumentationPage user={user} />} />
        <Route path={paths.help} element={<HelpCenterPage user={user} />} />
        <Route path={paths.settings} element={<SettingsLandingPage user={user} />} />
        <Route path={paths.settingsProfile} element={<ProfileSettingsPage user={user} />} />
        <Route path={paths.settingsSecurity} element={<SecuritySettingsPage onSessionEnded={onSessionEnded} />} />
        <Route path={paths.settingsNotifications} element={<NotificationSettingsPage />} />
        <Route path={paths.settingsApplication} element={<ApplicationSettingsPage />} />
        <Route path={paths.settingsDataManagement} element={canAccessRoute('settingsDataManagement', user)
          ? <DataManagementPage user={user} /> : <ForbiddenView />} />
        <Route path={paths.settingsDemoData} element={canAccessRoute('settingsDemoData', user)
          ? <DemoDataPage user={user} /> : <ForbiddenView />} />
        <Route path={paths.settingsBackupRecovery} element={canAccessRoute('settingsBackupRecovery', user)
          ? <BackupRecoveryPage /> : <ForbiddenView />} />
        <Route path={paths.jobs} element={<JobWorkspace user={user} notice={notice}
          onCreateDelivery={() => { onClearNotice(); navigate(paths.newDelivery); }}
          onCreateTask={() => { onClearNotice(); navigate(paths.newTask); }}
          onCreateMeeting={() => { onClearNotice(); navigate(paths.newMeeting); }}
          onCreateWeeklyReport={() => { onClearNotice(); navigate(paths.newWeeklyReport); }}
          onCommand={(intent) => navigate(paths.job(intent.jobId))} />} />
        <Route path={paths.newDelivery} element={<DeliveryCreateRoute user={user}
          navigate={navigate} onDeliveryCreated={onDeliveryCreated} />} />
        <Route path={paths.newTask} element={<GeneralTaskCreateRoute user={user}
          navigate={navigate} />} />
        <Route path={paths.newMeeting} element={<SalesMeetingCreateRoute user={user}
          navigate={navigate} />} />
        <Route path={paths.newWeeklyReport} element={<WeeklyReportCreateRoute user={user}
          navigate={navigate} />} />
        <Route path="/jobs/new-follow-up" element={<FollowUpCreateRoute user={user}
          navigate={navigate} />} />
        <Route path="/jobs/:jobCardId" element={<JobDetailRoute user={user} />} />
        <Route path={paths.users} element={canAccessRoute('users', user) ? <UserListScreen /> : <ForbiddenView />} />
        <Route path={paths.newUser} element={canAccessRoute('userCreate', user) ? <UserCreateScreen /> : <ForbiddenView />} />
        <Route path="/users/:userId" element={canAccessRoute('userDetail', user) ? <UserDetailScreen viewerRole={user.role} /> : <ForbiddenView />} />
        <Route path={paths.staff} element={<StaffRoute user={user} />} />
        <Route path="/staff/:staffUserId" element={<StaffRoute user={user} />} />
        <Route path="/staff/:staffUserId/reports" element={<StaffReportRoute user={user} />} />
        <Route path={paths.reports} element={canAccessRoute('reports', user) ? <ReportsDashboard /> : <ForbiddenView />} />
        <Route path={paths.staffPerformanceReports} element={canAccessRoute('reportStaff', user)
          ? <StaffPerformanceReport />
          : <ForbiddenView />} />
        <Route path={paths.deliveryReports} element={canAccessRoute('reportDeliveries', user) ? <DeliveryReport user={user} /> : <ForbiddenView />} />
        <Route path={paths.customerReports} element={canAccessRoute('reportCustomers', user) ? <CustomerReport /> : <ForbiddenView />} />
        <Route path={paths.approvalReports} element={canAccessRoute('reportApprovals', user) ? <ApprovalReport /> : <ForbiddenView />} />
        <Route path={paths.salesFollowUpReports} element={canAccessRoute('reportSalesFollowUp', user) ? <SalesFollowUpReport /> : <ForbiddenView />} />
        <Route path={paths.customers} element={<CustomerListScreen user={user} />} />
        <Route path={paths.newCustomer} element={<CustomerCreateScreen user={user} />} />
        <Route path="/customers/:customerId" element={<CustomerRoute user={user} />} />
        <Route path="/customers/:customerId/contacts/:contactId" element={<ContactRoute user={user} />} />
        <Route path={paths.products} element={<ProductListScreen user={user} />} />
        <Route path={paths.newProduct} element={canAccessRoute('productCreate', user)
          ? <ProductCreateScreen onCancel={() => navigate(paths.products)} onCreated={(product) => navigate(paths.product(product.id))} />
          : <ForbiddenView />} />
        <Route path="/products/:productId" element={<ProductRoute user={user} />} />
        <Route path="*" element={<NotFoundView />} />
      </Routes>
    </Suspense>
  );
}
