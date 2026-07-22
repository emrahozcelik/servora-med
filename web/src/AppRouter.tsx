import { lazy, Suspense } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { JobWorkspace } from './jobs/JobWorkspace';
import { paths } from './paths';
import type { CurrentUser } from './services/api';
import { LoadingSkeleton } from './ui/antd/LoadingSkeleton';

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

type AppRouterProps = {
  user: CurrentUser;
  notice: string;
  onClearNotice: () => void;
  onDeliveryCreated: () => void;
};

function ForbiddenView() {
  return <main className="workspace"><div className="workspace-message" role="alert">
    <h1>Bu alana erişim yetkiniz yok</h1>
    <p>Bu sayfayı görüntülemek için gerekli role sahip değilsiniz.</p>
    <Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>
  </div></main>;
}

function NotFoundView() {
  return <main className="workspace"><div className="workspace-message">
    <h1>Sayfa bulunamadı</h1>
    <p>Bağlantı değişmiş veya sayfa kaldırılmış olabilir.</p>
    <Link className="secondary-button" to={paths.jobs}>İşlere dön</Link>
  </div></main>;
}

function JobDetailRoute({ user }: Pick<AppRouterProps, 'user'>) {
  const { jobCardId } = useParams();
  const navigate = useNavigate();
  if (!jobCardId) return <NotFoundView />;
  return <JobDetailScreen jobId={jobCardId} user={user} onBack={() => navigate(paths.jobs)} onChanged={() => {}} />;
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
  if (user.role === 'STAFF') return <ForbiddenView />;
  if (!staffUserId) return <NotFoundView />;
  return <StaffOperationalReportScreen staffUserId={staffUserId}
    onBack={() => navigate(paths.staffProfile(staffUserId))} />;
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

export function AppRouter({ user, notice, onClearNotice, onDeliveryCreated }: AppRouterProps) {
  const navigate = useNavigate();
  return (
    <Suspense fallback={<RouteLoading />}>
      <Routes>
        <Route path="/" element={<Navigate to={paths.jobs} replace />} />
        <Route path="/login" element={<Navigate to={paths.jobs} replace />} />
        <Route path={paths.jobs} element={<JobWorkspace user={user} notice={notice}
          onCreateDelivery={() => { onClearNotice(); navigate(paths.newDelivery); }}
          onCreateTask={() => { onClearNotice(); navigate(paths.newTask); }}
          onCreateMeeting={() => { onClearNotice(); navigate(paths.newMeeting); }}
          onCommand={(intent) => navigate(paths.job(intent.jobId))} />} />
        <Route path={paths.newDelivery} element={<DeliveryCreateView user={user} onCancel={() => navigate(paths.jobs)}
          onCreated={() => { onDeliveryCreated(); navigate(paths.jobs); }} />} />
        <Route path={paths.newTask} element={<GeneralTaskCreateRoute user={user}
          navigate={navigate} />} />
        <Route path={paths.newMeeting} element={<SalesMeetingCreateRoute user={user}
          navigate={navigate} />} />
        <Route path="/jobs/:jobCardId" element={<JobDetailRoute user={user} />} />
        <Route path={paths.users} element={user.role === 'ADMIN' ? <UserListScreen /> : <ForbiddenView />} />
        <Route path={paths.newUser} element={user.role === 'ADMIN' ? <UserCreateScreen /> : <ForbiddenView />} />
        <Route path="/users/:userId" element={user.role === 'ADMIN' ? <UserDetailScreen /> : <ForbiddenView />} />
        <Route path={paths.staff} element={<StaffRoute user={user} />} />
        <Route path="/staff/:staffUserId" element={<StaffRoute user={user} />} />
        <Route path="/staff/:staffUserId/reports" element={<StaffReportRoute user={user} />} />
        <Route path={paths.reports} element={user.role === 'STAFF' ? <ForbiddenView /> : <ReportsDashboard />} />
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
