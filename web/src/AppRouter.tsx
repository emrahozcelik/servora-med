import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { JobWorkspace } from './jobs/JobWorkspace';
import { paths } from './paths';
import { reportSectionHref } from './reports/report-navigation';
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
  return <JobDetailScreen jobId={jobCardId} user={user} onBack={() => navigate(paths.jobs)}
    onCreateFollowUp={() => navigate(paths.followUpCreate(jobCardId))} onChanged={() => {}}
    onOpenMessaging={(conversationId) => navigate(`${paths.messages}?conversation=${encodeURIComponent(conversationId)}`)} />;
}

function StaffRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { staffUserId } = useParams();
  const navigate = useNavigate();
  if (user.role === 'STAFF' && staffUserId && staffUserId !== user.id) return <ForbiddenView />;
  return <StaffProfilesScreen user={user} initialStaffUserId={staffUserId} onBack={() => navigate(paths.jobs)}
    onOpenProfile={(id) => navigate(paths.staffProfile(id))} onProfileBack={() => navigate(paths.staff)}
    onOpenReport={(id) => navigate(paths.staffReport(id))} />;
}

function StaffReportRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { staffUserId } = useParams();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const rangeState = readStaffPerformanceSearch(search);
  if (user.role === 'STAFF') return <ForbiddenView />;
  if (!staffUserId) return <NotFoundView />;
  const requestedRange = rangeState.from && rangeState.to
    ? { from: rangeState.from, to: rangeState.to }
    : null;
  return <StaffOperationalReportScreen staffUserId={staffUserId}
    requestedRange={requestedRange}
    backLabel={requestedRange ? 'Personel operasyon analizine dön' : 'Personel profiline dön'}
    onBack={() => navigate(requestedRange
      ? reportSectionHref('staff', rangeState)
      : paths.staffProfile(staffUserId))} />;
}

export function CustomerRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { customerId } = useParams();
  if (!customerId) return <NotFoundView />;
  return <CustomerDetailScreen key={customerId} customerId={customerId} user={user} />;
}

export function ContactRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { customerId, contactId } = useParams();
  if (!customerId || !contactId) return <NotFoundView />;
  return <ContactDetailScreen key={`${customerId}:${contactId}`} customerId={customerId} contactId={contactId} canManage={user.role !== 'STAFF'} />;
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
  if (user.role === 'STAFF') return <ForbiddenView />;
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
  const overviewEnabled = user.capabilities?.overviewDashboard === true;
  const calendarEnabled = user.capabilities?.calendar === true;
  const messagingEnabled = user.capabilities?.messaging === true;
  const landingPath = overviewEnabled ? paths.overview : paths.jobs;
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to={landingPath} replace />} />
        <Route path="/login" element={<Navigate to={landingPath} replace />} />
        <Route path={paths.overview} element={overviewEnabled
          ? <OverviewPage user={user} /> : <Navigate to={paths.jobs} replace />} />
        <Route path={paths.calendar} element={calendarEnabled
          ? <CalendarPage user={user} /> : <Navigate to={paths.jobs} replace />} />
        <Route path={paths.messages} element={messagingEnabled
          ? <MessagingPage user={user} /> : <Navigate to={paths.jobs} replace />} />
        <Route path={paths.docs} element={<DocumentationPage user={user} />} />
        <Route path={paths.help} element={<HelpCenterPage user={user} />} />
        <Route path={paths.settings} element={<SettingsLandingPage />} />
        <Route path={paths.settingsProfile} element={<ProfileSettingsPage user={user} />} />
        <Route path={paths.settingsSecurity} element={<SecuritySettingsPage onSessionEnded={onSessionEnded} />} />
        <Route path={paths.settingsNotifications} element={<NotificationSettingsPage />} />
        <Route path={paths.settingsApplication} element={<ApplicationSettingsPage />} />
        <Route path={paths.jobs} element={<JobWorkspace user={user} notice={notice}
          onCreateDelivery={() => { onClearNotice(); navigate(paths.newDelivery); }}
          onCreateTask={() => { onClearNotice(); navigate(paths.newTask); }}
          onCreateMeeting={() => { onClearNotice(); navigate(paths.newMeeting); }}
          onCommand={(intent) => navigate(paths.job(intent.jobId))} />} />
        <Route path={paths.newDelivery} element={<DeliveryCreateRoute user={user}
          navigate={navigate} onDeliveryCreated={onDeliveryCreated} />} />
        <Route path={paths.newTask} element={<GeneralTaskCreateRoute user={user}
          navigate={navigate} />} />
        <Route path={paths.newMeeting} element={<SalesMeetingCreateRoute user={user}
          navigate={navigate} />} />
        <Route path="/jobs/new-follow-up" element={<FollowUpCreateRoute user={user}
          navigate={navigate} />} />
        <Route path="/jobs/:jobCardId" element={<JobDetailRoute user={user} />} />
        <Route path={paths.users} element={user.role === 'ADMIN' ? <UserListScreen /> : <ForbiddenView />} />
        <Route path={paths.newUser} element={user.role === 'ADMIN' ? <UserCreateScreen /> : <ForbiddenView />} />
        <Route path="/users/:userId" element={user.role === 'ADMIN' ? <UserDetailScreen /> : <ForbiddenView />} />
        <Route path={paths.staff} element={<StaffRoute user={user} />} />
        <Route path="/staff/:staffUserId" element={<StaffRoute user={user} />} />
        <Route path="/staff/:staffUserId/reports" element={<StaffReportRoute user={user} />} />
        <Route path={paths.reports} element={user.role === 'STAFF' ? <ForbiddenView /> : <ReportsDashboard />} />
        <Route path={paths.staffPerformanceReports} element={user.role === 'STAFF'
          ? <ForbiddenView />
          : <StaffPerformanceReport />} />
        <Route path={paths.deliveryReports} element={user.role === 'STAFF' ? <ForbiddenView /> : <DeliveryReport user={user} />} />
        <Route path={paths.approvalReports} element={user.role === 'STAFF' ? <ForbiddenView /> : <ApprovalReport />} />
        <Route path={paths.customers} element={<CustomerListScreen user={user} />} />
        <Route path={paths.newCustomer} element={<CustomerCreateScreen user={user} />} />
        <Route path="/customers/:customerId" element={<CustomerRoute user={user} />} />
        <Route path="/customers/:customerId/contacts/:contactId" element={<ContactRoute user={user} />} />
        <Route path={paths.products} element={<ProductListScreen user={user} />} />
        <Route path={paths.newProduct} element={user.role === 'STAFF' ? <ForbiddenView />
          : <ProductCreateScreen onCancel={() => navigate(paths.products)} onCreated={(product) => navigate(paths.product(product.id))} />} />
        <Route path="/products/:productId" element={<ProductRoute user={user} />} />
        <Route path="*" element={<NotFoundView />} />
      </Routes>
    </Suspense>
  );
}
